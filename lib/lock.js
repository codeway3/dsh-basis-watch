/**
 * 跨进程任务锁。
 *
 * 为什么需要：调度器（宿主进程）、HTTP 路由（同一进程不同请求）、CLI（另一个进程）
 * 都可能同时触发抓取。之前只在路由里用了一个进程内 Set，CLI 完全不受约束，
 * 两个进程同时写同一个 jsonl 会互相覆盖/重复。
 *
 * 实现：数据目录下 `locks/<name>.lock`，用 `open(..., 'wx')` 的原子性抢占；
 * 记录 pid + 时间，超时或进程已死视为陈旧锁并强制回收（避免崩溃后永久卡死）。
 *
 * @module dsh-basis-watch/lib/lock
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 默认锁有效期：30 分钟。抓取任务不会跑这么久，超时说明进程已异常。 */
export const DEFAULT_TTL_MS = 30 * 60 * 1000

/**
 * @param {string} root 数据根目录
 * @param {string} name 锁名（如 'job'）
 * @returns {string}
 */
function lockFile(root, name) {
  return path.join(root, 'locks', `${name}.lock`)
}

/**
 * 读锁内容（损坏返回 null）。
 * @param {string} file
 * @returns {{pid: number, at: number, host: string}|null}
 */
function readLock(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.pid !== 'number' || typeof parsed?.at !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 判断锁是否已失效。
 * @param {{pid: number, at: number, host: string}|null} info
 * @param {number} ttlMs
 * @returns {boolean}
 */
function isStale(info, ttlMs) {
  if (info === null) return true
  if (Date.now() - info.at > ttlMs) return true
  // 同一台机器上才检查 pid 存活；跨机器（共享盘）只靠 TTL
  if (info.host !== undefined && info.host !== os.hostname()) return false
  try {
    process.kill(info.pid, 0)
    return false
  } catch (error) {
    // EPERM 说明进程存在但无权限，视为存活
    return error?.code === 'ESRCH'
  }
}

/**
 * 尝试获取锁。
 *
 * @param {string} root 数据根目录
 * @param {string} name 锁名
 * @param {{ttlMs?: number}} [options]
 * @returns {{release: () => void, file: string}|null} 拿不到返回 null
 */
export function acquireLock(root, name = 'job', options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const file = lockFile(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx')
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), host: os.hostname() }))
      fs.closeSync(fd)
      return {
        file,
        release: () => {
          try {
            const info = readLock(file)
            // 只删自己持有的锁，避免误删别人刚抢到的
            if (info !== null && info.pid !== process.pid) return
            fs.unlinkSync(file)
          } catch {
            /* 已被清理 */
          }
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const info = readLock(file)
      if (!isStale(info, ttlMs)) return null
      try {
        fs.unlinkSync(file)
      } catch {
        /* 竞争中被别人删了 */
      }
    }
  }
  return null
}

/**
 * 查询锁的持有者（只读，用于状态展示）。
 * @param {string} root
 * @param {string} name
 * @returns {{held: boolean, stale: boolean, pid?: number, at?: number}}
 */
export function lockStatus(root, name = 'job', ttlMs = DEFAULT_TTL_MS) {
  const file = lockFile(root, name)
  const info = readLock(file)
  if (info === null) return { held: fs.existsSync(file), stale: fs.existsSync(file) }
  return { held: true, stale: isStale(info, ttlMs), pid: info.pid, at: info.at }
}
