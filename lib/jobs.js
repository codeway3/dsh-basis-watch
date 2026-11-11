/**
 * 任务执行器：跨进程锁 + 数据集状态机 + 崩溃恢复。
 *
 * 统一了三条入口（HTTP 路由、宿主调度器、CLI 脚本）的抢锁与状态记录方式。
 * 之前各自维护一个进程内 Set，CLI 与宿主可以同时跑同一批抓取，写坏数据文件也无人知晓。
 *
 * @module dsh-basis-watch/lib/jobs
 */

import { acquireLock, lockStatus } from './lock.js'

/** 抓取任务的默认锁名：同一时刻只允许一个抓取任务（不分入口）。 */
export const LOCK_NAME = 'job'

/**
 * 读取锁状态（给 /status 用）。
 * @param {string} root
 * @returns {{held: boolean, stale: boolean, pid?: number, at?: number}}
 */
export function jobLockStatus(root, name = LOCK_NAME, ttlMs) {
  return lockStatus(root, name, ttlMs)
}

/**
 * 当前是否应跳过该数据集（正在跑 / 失败后还在等重试时间）。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {string} name
 * @param {number} [now]
 * @returns {'running'|'retry-wait'|null}
 */
export function shouldSkip(store, name, now = Date.now()) {
  const st = store.dataset(name)
  if (st === null) return null
  if (st.status === 'running') return 'running'
  if (typeof st.retryAt === 'string' && Date.parse(st.retryAt) > now) return 'retry-wait'
  return null
}

/**
 * 在锁保护下执行一个任务，并把结果写进数据集状态机。
 *
 * @template T
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {string} name 数据集名（如 'quotes'、'daily'、'basis'、'bootstrap'）
 * @param {() => Promise<T>} fn
 * @param {{ ttlMs?: number, retryMs?: number, watermarkOf?: (result: T) => string|null }} [options]
 * @returns {Promise<{ok: boolean, started: boolean, result?: T, error?: string, reason?: string, retryAt?: string}>}
 */
export async function runJob(store, name, fn, options = {}) {
  // 锁名可分开：短任务（行情/基差/新闻）用 'job'，长任务（回填/合约回填）用 'backfill'，
  // 这样 5–10 分钟的回填不会把 15 分钟一轮的盘中更新全部拒绝。
  const lockName = options.lockName ?? LOCK_NAME
  const lock = acquireLock(store.root, lockName, { ttlMs: options.ttlMs })
  if (lock === null) {
    return {
      ok: false,
      started: false,
      reason: options.reasonBusy ?? '已有同类抓取任务在运行（可能是另一个进程）',
      holder: jobLockStatus(store.root, lockName),
    }
  }
  store.updateDataset(name, { status: 'running', startedAt: new Date().toISOString() })
  try {
    const result = await fn()
    const at = new Date().toISOString()
    const watermark = options.watermarkOf === undefined ? (result?.watermark ?? null) : options.watermarkOf(result)

    // 子任务失败必须在这里被"看见"：collect 层把 errors 收进返回值而不是抛错，
    // 早先于是一律写 ok，当天不再重试，坏数据被当成成功。
    const failure = result?.ok === false
    const partial = result?.ok === 'partial' || (Array.isArray(result?.errors) && result.errors.length > 0)
    if (failure) {
      const message = Array.isArray(result?.errors) && result.errors.length > 0
        ? result.errors.join('; ')
        : '任务返回失败'
      const retryAt = new Date(Date.now() + (options.retryMs ?? 5 * 60 * 1000)).toISOString()
      store.updateDataset(name, { status: 'error', lastError: { at, message }, retryAt })
      return { ok: false, started: true, error: message, retryAt, result }
    }
    if (partial) {
      // 部分失败：记录错误、不推进 watermark（下一轮会重试），但保留上次成功时间。
      // retryAt 必须给冷却：早期写 null，调度器每 60 秒重跑一次全量抓取，
      // 某个子任务持续失败（例如 15:10 抓当天尚未发布的基差）会变成每分钟 50+ 个请求。
      const message = (result.errors ?? []).join('; ') || '部分子任务失败'
      const retryAt = new Date(Date.now() + (options.retryMs ?? 10 * 60 * 1000)).toISOString()
      store.updateDataset(name, {
        status: 'partial',
        lastError: { at, message },
        retryAt,
        watermark: store.dataset(name)?.watermark ?? null,
      })
      return { ok: false, started: true, partial: true, error: message, retryAt, result }
    }
    store.updateDataset(name, {
      status: 'ok',
      lastSuccess: at,
      lastError: null,
      retryAt: null,
      watermark: watermark ?? null,
    })
    return { ok: true, started: true, result }
  } catch (error) {
    const at = new Date().toISOString()
    const retryAt = new Date(Date.now() + (options.retryMs ?? 5 * 60 * 1000)).toISOString()
    store.updateDataset(name, {
      status: 'error',
      lastError: { at, message: error instanceof Error ? error.message : String(error) },
      retryAt,
    })
    return { ok: false, started: true, error: error instanceof Error ? error.message : String(error), retryAt }
  } finally {
    lock.release()
  }
}
