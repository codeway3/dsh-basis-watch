/**
 * 宿主入口：期现瞭望（dsh-basis-watch）
 *
 * 职责边界：
 * - 本地存储初始化（<DSH_HOME>/dsh-basis-watch/data）
 * - 只读路由 /basis-watch/api（status / overview / update / bootstrap / basis）
 * - 抓取调度：盘中 15 分钟一轮行情+新闻，收盘后日线/仓单/基差各一次
 *
 * 并发与状态：调度器、HTTP 路由、CLI 共用 lib/jobs.js 的跨进程锁 + 数据集状态机，
 * 崩溃后靠 recoverDatasets() 把"卡在 running"的任务标为中断并允许重试。
 *
 * 不做的事：不写任何业务数据到 DSH 自己的存储；不给 agent 写工具（只读）。
 *
 * @module dsh-basis-watch
 */

import { createStore } from './lib/store.js'
import { registerRoutes } from './lib/routes.js'
import { registerTools } from './lib/tools.js'
import { runJob, shouldSkip } from './lib/jobs.js'
import { calendarInfo, shanghaiMinutes } from './lib/calendar.js'
import {
  bootstrap,
  isTradingSession,
  localDate,
  updateAfterClose,
  updateBasis,
  updateIntraday,
  updateNewsOnly,
} from './lib/collect.js'

/** Cordis 插件名。 */
export const name = 'dsh-basis-watch'

/** 需要宿主提供 webServer（路由）与 tools（agent 只读工具）能力。 */
export const inject = ['webServer', 'tools']

/** 盘中行情刷新间隔：15 分钟（低频，够用且不打挂数据源）。 */
const INTRADAY_MS = 15 * 60 * 1000
/** 新闻刷新间隔：20 分钟。 */
const NEWS_MS = 20 * 60 * 1000
/** 收盘后日线抓取时刻（分钟数，从 00:00 起算）：15:10。 */
const DAILY_AT = 15 * 60 + 10
/** 基差抓取时刻：16:40（生意社 16:30 后才出当日表）。 */
const BASIS_AT = 16 * 60 + 40
/** 参与崩溃恢复的数据集。 */
const DATASETS = ['bootstrap', 'update-intraday', 'update-close', 'basis', 'news']

/**
 * 挂载宿主半。
 * @param {any} ctx cordis 插件上下文（inject webServer）
 */
export function apply(ctx) {
  const store = createStore()
  try {
    store.ensure()
  } catch (error) {
    ctx.logger?.warn?.(`basis-watch: 数据目录不可写 ${store.root} :: ${String(error)}`)
  }

  const disposeRoutes = registerRoutes(ctx, store)
  const disposeTools = registerTools(ctx, store)

  /* ── 抓取调度 ── */
  let lastIntradayAt = 0
  let lastNewsAt = 0
  let stopped = false
  /** 已经告警过的、日历未覆盖的年份（避免每分钟刷日志） */
  let warnedUncovered = null

  /** 该数据集今天的 watermark 是否已经是今天（避免同一天重复跑）。 */
  const ranToday = (name) => store.dataset(name)?.watermark === localDate()

  const tick = async () => {
    if (stopped) return
    const now = new Date()
    try {
      // 崩溃恢复：上次运行中途退出（进程被杀/重启）时，把 running 状态释放掉
      store.recoverDatasets(DATASETS)

      const today = localDate(now)
      const cal = calendarInfo(now)
      // 日历未覆盖的年份只按周末判断，必须显式告警一次，避免"以为有节假日保护"
      if (!cal.covered && warnedUncovered !== cal.date.slice(0, 4)) {
        warnedUncovered = cal.date.slice(0, 4)
        ctx.logger?.warn?.(`basis-watch: 交易日历未覆盖 ${warnedUncovered} 年，节假日按周末规则近似，请补充 lib/calendar.js`)
      }
      // 必须按北京时间判断 15:10 / 16:40，宿主时区不是 Asia/Shanghai 时也不能偏
      const minutes = shanghaiMinutes(now)

      // 首次启动且从未回填过 → 后台回填一次（只做 1 年，避免一上来跑太久）
      const meta = store.meta()
      const neverBootstrapped = store.dataset('bootstrap') === null && meta.lastUpdate?.basis === undefined
      if (neverBootstrapped) {
        // 不 await：首次回填要跑几分钟，await 会把整个调度循环卡住，
        // 回填期间连盘中行情都不会刷新。放到后台，靠 datasets.bootstrap 看进度。
        void runJob(store, 'bootstrap', () => bootstrap(store, { basisYears: 1 }), {
          ttlMs: 2 * 3600 * 1000,
          lockName: 'backfill',
        }).then((out) => {
          ctx.logger?.info?.(`basis-watch: 首次回填 ${out.ok ? '完成' : (out.reason ?? out.error ?? '失败')}`)
        })
        return
      }

      // 1) 盘中：行情 + 新闻（15 分钟一轮）
      if (isTradingSession(now) && now.getTime() - lastIntradayAt >= INTRADAY_MS && shouldSkip(store, 'update-intraday') === null) {
        lastIntradayAt = now.getTime()
        const out = await runJob(store, 'update-intraday', () => updateIntraday(store), {
          watermarkOf: () => new Date().toISOString(),
        })
        if (out.ok) ctx.logger?.info?.(`basis-watch: 盘中更新 ${JSON.stringify(out.result).slice(0, 200)}`)
      }

      // 2) 新闻兜底：非交易时段也每 20 分钟拉一次
      if (now.getTime() - lastNewsAt >= NEWS_MS && !isTradingSession(now) && shouldSkip(store, 'news') === null) {
        lastNewsAt = now.getTime()
        // 只抓新闻：之前复用 updateIntraday 会顺手刷行情，导致非交易时段行情看起来"很新"
        await runJob(store, 'news', () => updateNewsOnly(store), { watermarkOf: () => new Date().toISOString() })
      }

      // 3) 收盘后日线 + 仓单（15:10 之后一次）
      if (cal.trading && minutes >= DAILY_AT && !ranToday('update-close') && shouldSkip(store, 'update-close') === null) {
        const out = await runJob(store, 'update-close', () => updateAfterClose(store, now), { watermarkOf: () => today })
        if (out.ok) ctx.logger?.info?.(`basis-watch: 收盘更新 ${JSON.stringify(out.result?.daily ?? {}).slice(0, 200)}`)
      }

      // 4) 基差（16:40 之后一次，非交易日不跑）
      if (cal.trading && minutes >= BASIS_AT && !ranToday('basis') && shouldSkip(store, 'basis') === null) {
        const out = await runJob(store, 'basis', () => updateBasis(store, today), { watermarkOf: () => today })
        if (out.ok) ctx.logger?.info?.(`basis-watch: 基差 ${JSON.stringify(out.result ?? {})}`)
      }
    } catch (error) {
      ctx.logger?.warn?.(`basis-watch: 调度失败 ${String(error)}`)
    }
  }

  // 启动 20 秒后跑第一轮，避免和宿主启动争资源
  // DSH_BASIS_WATCH_SCHED=0 可关闭调度（自测用：避免测试进程发起网络回填）
  const schedEnabled = process.env.DSH_BASIS_WATCH_SCHED !== '0'
  let kickoff = null
  let timer = null
  if (schedEnabled) {
    kickoff = setTimeout(() => {
      void tick()
      timer = setInterval(() => void tick(), 60 * 1000)
      // 定时器不该单独撑住进程（测试/进程退出时不被拖住）
      kickoff?.unref?.()
      timer?.unref?.()
    }, 20 * 1000)
  }

  ctx.effect?.(() => () => {
    stopped = true
    if (kickoff !== null) clearTimeout(kickoff)
    if (timer !== null) clearInterval(timer)
    disposeRoutes()
    disposeTools()
  }, 'dsh-basis-watch: scheduler + routes')
}
