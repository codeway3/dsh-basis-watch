/**
 * 抓取编排：把数据源的结果落到本地存储。
 *
 * 两种运行方式：
 * - `bootstrap`：首次安装时回填历史（日线全量、基差回溯、仓单、新闻）；
 * - `update*`：日常增量（盘中行情、收盘后日线/基差/仓单、常驻新闻）。
 *
 * 失败策略：单个数据源失败只记缺口，不中断整体；只有存储写失败才抛错。
 *
 * @module dsh-basis-watch/lib/collect
 */

import { activeVarieties, contractCodes, indexCodes, marketCloseMinutes, resolveCatalog } from './catalog.js'
import {
  averageSpot,
  BOARD_NEWS_TAGS,
  BOARD_KEYWORDS,
  brentDaily,
  cffexNotices,
  eastmoneyFuturesNews,
  energyRef,
  fxDaily,
  chinagrainNews,
  indexDaily,
  indexQuotes,
  jin10FlashNews,
  mysteelSunflowerSpot,
  newsBoardsForMulti,
  scfisLatest,
  sinaDaily,
  sinaLiveNews,
  sinaForeign,
  sinaQuotes,
  spotFutureTable,
  warrantSeries,
} from './sources.js'
import { sleep } from './http.js'
import { buildAdjusted } from './continuous.js'
import { addDays, isTradingDay as isCalendarTradingDay, shanghaiMinutes, tradingDaysBetween } from './calendar.js'

/** 把任意时刻换算成北京时间的一天内分钟数（宿主时区不影响）。 */
/**
 * 跑一个子任务并把它归一成 {name, ok, value, failed, error}。
 *
 * 为什么需要：采集函数有两条失败通道——抛错，和"返回 failed 数组"。
 * 早先只把抛错记进 out.errors，日线/仓单/合约三项全挂时 out.ok 仍然是 true，
 * 状态机于是写 ok 并把 watermark 推进到当天，坏数据被当成成功。
 *
 * @template T
 * @param {string} name 子任务名（daily/stock/contracts/basis/...）
 * @param {() => Promise<T>} fn
 * @param {(value: T) => Array<{code?: string, error?: string}>} [failedOf] 从返回值里取失败列表
 * @returns {Promise<{name: string, ok: boolean, value?: T, failed: Array<any>, error?: string}>}
 */
export async function runPart(name, fn, failedOf = () => []) {
  try {
    const value = await fn()
    const failed = failedOf(value) ?? []
    return { name, ok: failed.length === 0, value, failed }
  } catch (error) {
    return { name, ok: false, failed: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 把若干子任务结果聚合成 {ok, errors}。
 *
 * ok 三态：全部成功 true；全部失败 false；部分失败 'partial'。
 *
 * @param {Array<{name: string, ok: boolean, failed?: any[], error?: string}>} parts
 * @returns {{ok: boolean|string, errors: string[]}}
 */
export function mergeOutcome(parts) {
  const errors = []
  let succeeded = 0
  for (const part of parts) {
    if (part.ok) {
      succeeded += 1
      continue
    }
    const detail = part.error
      ?? (Array.isArray(part.failed) && part.failed.length > 0
        ? part.failed.map((f) => `${f.code ?? '?'} ${f.error ?? ''}`.trim()).join(', ')
        : '失败')
    errors.push(`${part.name}: ${detail}`)
  }
  const ok = errors.length === 0 ? true : succeeded === 0 ? false : 'partial'
  return { ok, errors }
}

/** 新闻关键词：只保留与油脂油料板块相关的内容。 */
export const NEWS_KEYWORDS = [
  '豆粕', '大豆', '豆油', '棕榈', '菜油', '菜籽', '菜粕', '葵花', '葵油', '油脂', '油料',
  '压榨', '榨利', '开机', '到港', '升贴水', 'USDA', 'MPOB', '生柴', '生物柴油', '豆系', '粕类',
]

/**
 * 判断一段文本是否与板块相关。
 * @param {string} text
 * @returns {boolean}
 */
export function newsRelevant(text) {
  return NEWS_KEYWORDS.some((k) => text.includes(k))
}

/**
 * 把中文品名映射到目录里的品种。
 * @param {string} commodity 生意社品名，如 '菜籽油OI'
 * @returns {{code: string, name: string}|null}
 */
export function varietyOfSpotName(commodity) {
  for (const v of resolveCatalog()) {
    if (v.spotKeys.some((k) => commodity === k || commodity.startsWith(k))) {
      // 返回完整品种：基差映射需要 spotScale / spotUnit（如玻璃元/㎡、鸡蛋元/公斤）
      return v
    }
  }
  return null
}

/* ── 交易日 / 交易时段 ── */

/** 商品期货日盘时段（分钟数，从 00:00 起算）。 */
const DAY_SESSIONS = [
  [9 * 60, 10 * 60 + 15],
  [10 * 60 + 30, 11 * 60 + 30],
  [13 * 60 + 30, 15 * 60],
]
/** 夜盘：大多 21:00–23:00（葵油/菜油同此；铜金等更长，本插件不涉及）。 */
const NIGHT_SESSIONS = [[21 * 60, 23 * 60]]

/**
 * 是否交易日（走 lib/calendar.js 的节假日日历）。
 * @param {Date|string} [date]
 * @returns {boolean}
 */
export function isTradingDay(date = new Date()) {
  return isCalendarTradingDay(date)
}

/**
 * 当前是否处于交易时段（日盘或夜盘）。
 * 时间一律按北京时间换算，宿主机器时区不是 Asia/Shanghai 时也不会算错。
 * @param {Date} [date]
 * @returns {boolean}
 */
export function isTradingSession(date = new Date()) {
  if (!isCalendarTradingDay(date)) return false
  const minutes = shanghaiMinutes(date)
  return [...DAY_SESSIONS, ...NIGHT_SESSIONS].some(([from, to]) => minutes >= from && minutes < to)
}

/**
 * 本地日期字符串（北京时间口径）。
 * @param {Date} [date]
 * @returns {string} YYYY-MM-DD
 */
export function localDate(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
  return fmt.format(date)
}

/* ── 增量更新 ── */

/**
 * 抓一轮实时行情并落盘。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {Date} [now]
 * @returns {Promise<{rows: number, at: string}>}
 */
export async function updateQuotes(store, now = new Date()) {
  const varieties = activeVarieties(now)
  const rows = await sinaQuotes(varieties.map((v) => v.code))
  // 附属源失败时沿用上一轮快照的字段，不能把已有的外盘/指数/折算参考覆盖成空
  const prev = store.readQuotes()
  let foreign = prev?.foreign ?? []
  let indices = prev?.indices ?? []
  let energy = prev?.energy ?? null
  const failed = []
  const fail = (dataset, key, error) => {
    const message = error instanceof Error ? error.message : String(error)
    failed.push({ code: key, error: message })
    store.recordGap('quotes', `${dataset}:${key}`, message)
  }
  try {
    foreign = await sinaForeign()
    store.clearGap('quotes', 'quotes:foreign')
  } catch (error) {
    // 外盘只是参考，失败不影响主流程
    fail('quotes', 'foreign', error)
  }
  // 股指的现货基准（指数快照）；失败只影响中金所板块，不算整批失败
  try {
    indices = await indexQuotes(indexCodes(now))
    store.clearGap('quotes', 'quotes:indices')
  } catch (error) {
    fail('quotes', 'indices', error)
  }
  // 能源板块的折算参考（Brent + 汇率）；失败只影响能源板块
  try {
    energy = await energyRef()
    store.clearGap('quotes', 'quotes:energy')
  } catch (error) {
    fail('quotes', 'energy', error)
  }
  if (rows.length > 0) store.writeQuotes(rows, foreign, indices, energy)
  // rows 为空 = 整批行情没抓到，必须算失败，否则重试会被"成功"掩盖
  if (rows.length === 0) failed.push({ code: '*', error: '行情接口返回空' })
  return { rows: rows.length, foreign: foreign.length, indices: indices.length, at: new Date().toISOString(), failed }
}

/**
 * 丢掉"今天还没收盘"的那根日线。
 *
 * 新浪日线在盘中会把当天未完成的 bar 一起返回；如果收盘任务被提前（手动）触发，
 * 这根盘中价会被当成当天收盘价写进日线，而且当天的 watermark 已推进，调度器当天不会再跑，
 * 错误价格会一直留到下一次写盘。统一在写盘前过滤：15:05 之前不要当天的 bar。
 *
 * @param {Array<{d: string}>} bars
 * @param {Date} [now]
 * @param {number} [closedAt] 该品种的收盘时刻（分钟数），默认 15:05
 * @returns {Array<any>}
 */
export function dropInProgressBar(bars, now = new Date(), closedAt = 15 * 60 + 5) {
  const today = localDate(now)
  const closed = shanghaiMinutes(now) >= closedAt
  return bars.filter((b) => closed || b.d < today)
}

/**
 * 更新日线（逐品种整表覆盖）。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {Date} [now]
 * @returns {Promise<{updated: string[], failed: Array<{code: string, error: string}>}>}
 */
export async function updateDaily(store, now = new Date()) {
  const updated = []
  const failed = []
  for (const v of activeVarieties(now)) {
    try {
      // 收盘时刻按板块定：商品 15:00、股指 15:00、国债 15:15；
      // 再加 5 分钟缓冲，避免把"还在交易的最后一分钟"当成收盘价
      const bars = dropInProgressBar(await sinaDaily(v.code), now, marketCloseMinutes(v) + 5)
      if (bars.length === 0) {
        store.recordGap(`daily:${v.code}`, localDate(now), '日线为空')
        failed.push({ code: v.code, error: '日线为空' })
        continue
      }
      store.writeDaily(v.code, bars)
      store.clearGap(`daily:${v.code}`, localDate(now))
      updated.push(v.code)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      store.recordGap(`daily:${v.code}`, localDate(now), message)
      failed.push({ code: v.code, error: message })
    }
    await sleep(200)
  }
  return { updated, failed }
}

/**
 * 抓某一天的基差表并落盘（只保留目录内品种）。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<{date: string, rows: number, matched: number}>}
 */
/**
 * 抓取某一天的现货/基差。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {string} date YYYY-MM-DD
 * @param {{ force?: boolean }} [options] force=true 时用新结果整体替换该日行（源站事后修订）
 * @returns {Promise<{date: string, rows: number, matched: number, replaced?: {removed: number, added: number}}>}
 */
export async function updateBasis(store, date, options = {}) {
  const rows = await spotFutureTable(date)
  // 现期表可能晚发布或当天停更；能源/其他（集运）的现货不依赖它，仍要继续算。
  // 空表仍然是"没抓到"，最后返回 ok:false，避免任务状态机推进 watermark。
  const emptyTable = rows.length === 0
  if (emptyTable && options.quiet !== true) store.recordGap('basis', date, '当日现期表为空')
  const savedAt = new Date().toISOString()
  const mapped = []
  for (const row of rows) {
    const v = varietyOfSpotName(row.commodity)
    if (v === null) continue
    // 单位换算：现货报价 × spotScale 折算到期货单位后再算基差
    const scale = Number(v.spotScale ?? 1)
    const spot = Number((Number(row.spot) * scale).toFixed(2))
    const basis = Number((spot - Number(row.future)).toFixed(2))
    mapped.push({
      ...row,
      spot,
      spotRaw: row.spot,
      spotScale: scale,
      spotUnit: v.spotUnit ?? null,
      basis,
      basisRate: spot > 0 ? Number(((basis / spot) * 100).toFixed(2)) : null,
      date,
      // sourceDate 记录"这条数据取自哪一天的现期表"，与抓取日分开；
      // savedAt 是抓取时刻（UTC ISO），便于判断数据新鲜度与事后修订
      sourceDate: date,
      source: '100ppi',
      code: v.code,
      name: v.name,
      savedAt,
    })
  }
  // 其他（集运）：现货不是生意社表，而是 SCFIS 欧线结算指数（周度，本期日期为周一）
  const scfisTarget = activeVarieties().find((v) => v.spotSource === 'scfis')
  if (scfisTarget !== undefined) {
    try {
      const latest = await scfisLatest()
      if (latest.date === date) {
        const bars = store.readDaily(scfisTarget.code)?.bars ?? []
        const bar = bars.find((b) => b.d === date)
        if (bar !== undefined && bar.c > 0) {
          const basis = latest.value - bar.c
          mapped.push({
            date,
            commodity: 'SCFIS欧线',
            spot: latest.value,
            contract: '主力',
            future: bar.c,
            basis: Number(basis.toFixed(1)),
            basisRate: Number(((basis / latest.value) * 100).toFixed(2)),
            source: 'scfis',
            sourceDate: date,
            code: scfisTarget.code,
            name: scfisTarget.name,
            savedAt,
          })
        }
      }
    } catch {
      /* SCFIS 抓取失败不阻塞当日 100ppi 基差 */
    }
  }

  // 能源：国内没有可比现货，用 Brent × 汇率 × 系数折算（元/桶 / 元/吨）
  const energyVarieties = activeVarieties().filter((v) => v.spotSource === 'brent')
  if (energyVarieties.length > 0) {
    const brentBars = store.readIndex('brent')?.bars ?? []
    const fxBars = store.readIndex('usdcny')?.bars ?? []
    for (const v of energyVarieties) {
      const bar = (store.readDaily(v.code)?.bars ?? []).find((b) => b.d === date)
      if (bar === undefined || !(bar.c > 0)) continue
      const brent = refAt(brentBars, date)
      const fx = refAt(fxBars, date)
      if (brent === null || fx === null) continue
      const spot = brent * fx * (v.brentFactor ?? 1)
      const basis = spot - bar.c
      mapped.push({
        date,
        commodity: `${v.name}折算`,
        spot: Number(spot.toFixed(2)),
        contract: '主力',
        future: Number(bar.c.toFixed(2)),
        basis: Number(basis.toFixed(2)),
        basisRate: Number(((basis / spot) * 100).toFixed(2)),
        source: 'brent',
        sourceDate: date,
        code: v.code,
        name: v.name,
        savedAt,
      })
    }
  }

  const replaced = !emptyTable && options.force === true ? store.replaceBasisDate(date, mapped) : null
  if (replaced === null) store.appendBasis(mapped)
  if (!emptyTable) store.clearGap('basis', date)
  if (emptyTable) return { ok: false, errors: ['当日现期表为空（可能尚未发布）'], date, rows: 0, matched: mapped.length, empty: true }
  return { ok: true, date, rows: rows.length, matched: mapped.length, ...(replaced === null ? {} : { replaced }) }
}

/**
 * 补充现货源（生意社现期表覆盖不到的品种，如葵油走 Mysteel 多地均价）。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {string} date YYYY-MM-DD
 * @param {Date} [now]
 * @returns {Promise<{code: string, spot: number, future: number, basis: number, basisRate: number, markets: number}|null>}
 */
export async function updateExtraSpot(store, date, now = new Date()) {
  const target = activeVarieties(now).find((v) => v.spotSource === 'mysteel-sunflower')
  if (target === undefined) return null
  const [rows, quotes] = await Promise.all([mysteelSunflowerSpot(), sinaQuotes([target.code])])
  const spot = averageSpot(rows)
  const future = quotes[0]?.last
  if (!Number.isFinite(spot) || !Number.isFinite(future) || future <= 0) {
    // 与成功时 clearGap('extra-spot') 同键，否则"额外现货源"那行永远显示正常
    store.recordGap('extra-spot', date, '葵油现货/期货数据不全')
    return null
  }
  const basis = Number((spot - future).toFixed(1))
  const basisRate = Number(((basis / spot) * 100).toFixed(2))
  store.appendBasis([
    {
      date,
      commodity: '葵花籽油(市场均价)',
      spot,
      contract: '主力',
      future,
      basis,
      basisRate,
      code: target.code,
      name: target.name,
      source: 'mysteel',
      markets: rows.map((r) => `${r.market}:${r.price}`).join(' '),
      savedAt: new Date().toISOString(),
    },
  ])
  return { code: target.code, spot, future, basis, basisRate, markets: rows.length }
}

/**
 * 更新分级合约日线（跨期结构用）。
 * 每个品种取 contractCodes 默认的前 6 个合约：跨期页要覆盖两个季度，
 * 只取 4 个会让 2705-2709 这类月差没有本地数据。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {Date} [now]
 * @returns {Promise<{updated: string[], failed: string[]}>}
 */
export async function updateContracts(store, now = new Date()) {
  const updated = []
  const failed = []
  for (const v of activeVarieties(now)) {
    for (const code of contractCodes(v, now)) {
      try {
        const bars = dropInProgressBar(await sinaDaily(code), now, marketCloseMinutes(v) + 5)
        if (bars.length === 0) {
          failed.push({ code, error: '日线为空' })
          continue
        }
        store.writeDaily(code, bars)
        updated.push(code)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 未挂牌的合约月（新浪返回 NULL）不算失败：这类月份本来就没有数据
        if (!/不是数组|无法解析|为空/u.test(message)) failed.push({ code, error: message })
      }
      await sleep(180)
    }
  }
  return { updated, failed }
}

/**
 * 列出覆盖最近 N 年的全部合约代码（用于复权回填）。
 *
 * @param {{code: string, months: number[]}} variety
 * @param {number} years
 * @param {Date} [now]
 * @returns {string[]}
 */
export function contractHistoryCodes(variety, years = 3, now = new Date()) {
  const prefix = String(variety.code).replace(/0$/, '')
  const endYear = now.getFullYear()
  const startYear = endYear - Math.max(1, Math.min(15, years))
  // 中金所股指每个月都当过"当月合约"，历史每月都有挂牌；国债只有季月
  const months = variety.exchange === 'CFFEX'
    ? (variety.kind === 'bond' ? [3, 6, 9, 12] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    : (variety.months ?? [])
  const out = []
  for (let y = startYear; y <= endYear; y += 1) {
    for (const m of months) {
      out.push(`${prefix}${String(y).slice(2)}${String(m).padStart(2, '0')}`)
    }
  }
  return out
}

/**
 * 回填历史合约日线（复权用）。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {{ years?: number, now?: Date, varieties?: Array<{code: string, months?: number[]}>, onProgress?: (p: {done: number, total: number, code: string}) => void }} [opts]
 * @returns {Promise<{fetched: string[], skipped: string[], failed: string[]}>}
 */
export async function updateContractHistory(store, opts = {}) {
  const years = opts.years ?? 3
  const now = opts.now ?? new Date()
  const targets = []
  for (const v of opts.varieties ?? activeVarieties(now)) {
    for (const code of contractHistoryCodes(v, years, now)) targets.push(code)
  }
  const fetched = []
  const skipped = []
  const failed = []
  const seen = new Set(store.listDailyCodes())
  let done = 0
  for (const code of targets) {
    done += 1
    if (seen.has(code)) {
      skipped.push(code)
      opts.onProgress?.({ done, total: targets.length, code })
      continue
    }
    try {
      const bars = await sinaDaily(code)
      if (bars.length === 0) failed.push(code)
      else {
        store.writeDaily(code, bars)
        fetched.push(code)
      }
    } catch {
      failed.push(code)
    }
    opts.onProgress?.({ done, total: targets.length, code })
    await sleep(150)
  }
  return { fetched, skipped, failed }
}

/**
 * 用已存的合约日线重建各品种的复权连续序列。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @returns {Promise<{built: Array<{code: string, rolls: number, from: string|null}>, skipped: string[]}>}
 */
export async function rebuildContinuous(store) {
  const built = []
  const skipped = []
  for (const v of activeVarieties()) {
    const main = store.readDaily(v.code)?.bars ?? []
    if (main.length < 2) {
      skipped.push(v.code)
      continue
    }
    const prefix = String(v.code).replace(/0$/, '')
    const legRe = new RegExp(`^${prefix}\\d{4}$`)
    const legs = []
    for (const code of store.listDailyCodes()) {
      if (code === v.code || !legRe.test(code)) continue
      const bars = store.readDaily(code)?.bars ?? []
      if (bars.length > 0) legs.push({ code, bars })
    }
    const adjusted = buildAdjusted(main, legs)
    store.writeContinuous(v.code, {
      method: 'ratio-backadjust',
      source: 'sina-daily + 具体合约反推',
      bars: adjusted.bars,
      rolls: adjusted.rolls,
      coverage: adjusted.coverage,
      legCount: legs.length,
    })
    built.push({ code: v.code, rolls: adjusted.rolls.length, from: adjusted.coverage.from })
  }
  return { built, skipped }
}

/**
 * 更新指数日线（中金所股指的现货基准，用于算升贴水与历史分位）。
 * 不抓指数就做不了股指标的的分位，所以要和日线一起进收盘任务。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {Date} [now]
 * @returns {Promise<{updated: string[], failed: Array<{code: string, error: string}>}>}
 */
/**
 * 取某日期当时可用的参考值（前向填充：ECB 汇率/外盘日线不一定每个交易日都有）。
 * @param {Array<{d: string, c: number}>} bars
 * @param {string} date
 * @returns {number|null}
 */
function refAt(bars, date) {
  let value = null
  for (const bar of bars) {
    if (bar.d > date) break
    value = bar.c
  }
  return value
}

/**
 * 更新能源板块的折算参考：Brent 日线 + USD/CNY 日线。
 * 两者都存本地，基差按「Brent × 汇率 × 系数 − 期货」逐日计算，可回填历史。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {Date} [now]
 * @returns {Promise<{brent: number, fx: number}>}
 */
export async function updateEnergyRef(store, now = new Date()) {
  const yearsAgo = new Date(now.getTime() - 6 * 365 * 86400000).toISOString().slice(0, 10)
  const [brent, fx] = await Promise.all([brentDaily(), fxDaily(yearsAgo, localDate(now))])
  if (brent.length === 0 || fx.length === 0) throw new Error('Brent/汇率历史为空')
  store.writeIndex('brent', brent)
  store.writeIndex('usdcny', fx)
  return { brent: brent.length, fx: fx.length }
}

/**
 * 用本地 Brent/汇率/日线回填能源基差（不联网，秒级）。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {number} [years]
 * @returns {{rows: number, from: string|null, to: string|null}}
 */
export function backfillEnergyBasis(store, years = 3) {
  const brentBars = store.readIndex('brent')?.bars ?? []
  const fxBars = store.readIndex('usdcny')?.bars ?? []
  if (brentBars.length === 0 || fxBars.length === 0) return { rows: 0, from: null, to: null }
  const cutoff = new Date(Date.now() - years * 365 * 86400000).toISOString().slice(0, 10)
  const rows = []
  for (const v of activeVarieties().filter((x) => x.spotSource === 'brent')) {
    const bars = store.readDaily(v.code)?.bars ?? []
    const factor = v.brentFactor ?? 1
    for (const bar of bars) {
      if (bar.d < cutoff) continue
      const brent = refAt(brentBars, bar.d)
      const fx = refAt(fxBars, bar.d)
      if (brent === null || fx === null || !(bar.c > 0)) continue
      const spot = brent * fx * factor
      const basis = spot - bar.c
      rows.push({
        date: bar.d,
        commodity: `${v.name}折算`,
        spot: Number(spot.toFixed(2)),
        contract: '主力',
        future: Number(bar.c.toFixed(2)),
        basis: Number(basis.toFixed(2)),
        basisRate: Number(((basis / spot) * 100).toFixed(2)),
        source: 'brent',
        sourceDate: bar.d,
        code: v.code,
        name: v.name,
        savedAt: new Date().toISOString(),
      })
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date))
  if (rows.length > 0) store.appendBasis(rows)
  return { rows: rows.length, from: rows[0]?.date ?? null, to: rows[rows.length - 1]?.date ?? null }
}

export async function updateIndexHistory(store, now = new Date()) {
  const updated = []
  const failed = []
  for (const symbol of indexCodes(now)) {
    try {
      const bars = dropInProgressBar(await indexDaily(symbol), now, 15 * 60 + 1)
      if (bars.length === 0) {
        failed.push({ code: symbol, error: '指数日线为空' })
        continue
      }
      store.writeIndex(symbol, bars)
      updated.push(symbol)
    } catch (error) {
      failed.push({ code: symbol, error: error instanceof Error ? error.message : String(error) })
    }
    await sleep(200)
  }
  return { updated, failed }
}

/**
 * 更新仓单（东财，逐品种追加）。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {Date} [now]
 * @returns {Promise<{updated: Record<string, number>, failed: Array<{code: string, error: string}>}>}
 */
export async function updateStock(store, now = new Date()) {
  const updated = {}
  const failed = []
  for (const v of activeVarieties(now)) {
    // 中金所没有注册仓单（股指无实物，国债用可交割券）
    if (v.exchange === 'CFFEX') continue
    // 广期所仓单接口用小写代码（si/lc/ps），上期所/大商所/郑商所大写
    const productCode = v.exchange === 'GFEX' ? v.code.replace(/0$/, '').toLowerCase() : v.code.replace(/0$/, '')
    try {
      const rows = await warrantSeries(productCode)
      if (rows.length === 0) {
        // 新品种（如葵油上市初期）可能暂时没有仓单数据，不算失败
        continue
      }
      const res = store.appendStock(v.code, rows)
      updated[v.code] = res.added
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      store.recordGap(`stock:${v.code}`, localDate(now), message)
      failed.push({ code: v.code, error: message })
    }
    await sleep(200)
  }
  return { updated, failed }
}

/**
 * 更新新闻。
 *
 * 各板块的源：
 * - 油脂油料：中国粮油信息网 6 个栏目；
 * - 中金所：交易所通知（官方公告）+ 金十快讯（按股指/国债关键词筛）；
 * - 黑色 / 能化：金十快讯（按各自品种关键词筛，一条可同时属于多个板块）。
 *
 * 单个源失败不拖垮整批：只有所有源都返回空才算失败。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @returns {Promise<{fetched: number, kept: number, oil: number, black: number, chem: number, cffex: number, failed: Array<{code: string, error: string}>}>}
 */
export async function updateNews(store) {
  const failed = []
  let oilItems = []
  try {
    oilItems = await chinagrainNews()
  } catch (error) {
    failed.push({ code: 'chinagrain', error: error instanceof Error ? error.message : String(error) })
  }
  let notices = []
  let flash = []
  let emNews = []
  let sinaNews = []
  try {
    notices = await cffexNotices()
  } catch (error) {
    failed.push({ code: 'cffex', error: error instanceof Error ? error.message : String(error) })
  }
  try {
    flash = await jin10FlashNews()
  } catch (error) {
    failed.push({ code: 'jin10', error: error instanceof Error ? error.message : String(error) })
  }
  try {
    emNews = await eastmoneyFuturesNews()
  } catch (error) {
    failed.push({ code: 'eastmoney', error: error instanceof Error ? error.message : String(error) })
  }
  try {
    sinaNews = await sinaLiveNews()
  } catch (error) {
    failed.push({ code: 'sina', error: error instanceof Error ? error.message : String(error) })
  }

  const keptOil = oilItems.filter((item) => newsRelevant(`${item.title} ${(item.tags ?? []).join(' ')}`))
  // 多源合并：一条资讯可命中多个板块，分别落一条，标签不同，各自板块都能看到
  const stream = [
    ...flash.map((item) => ({ item, kind: '快讯' })),
    ...emNews.map((item) => ({ item, kind: '资讯' })),
    ...sinaNews.map((item) => ({ item, kind: '快讯' })),
  ]
  // 盘面综述类（午盘/收盘/期货热点）几乎命中所有板块，只当噪声丢掉
  const ROUNDUP = /午盘收盘|早盘收盘|商品期货收盘|期货热点追踪|收盘播报/u
  // 跨源同名（【】、空格、标点不同）只保留第一条，避免同一件事出现两遍
  const normalizeTitle = (t) => String(t).replace(/[【】\[\]【】\s，。！？：；、,.:;!?]/gu, '')
  const seenTitles = new Set()
  const keptFlash = []
  for (const { item, kind } of stream) {
    const title = String(item.title ?? '')
    if (ROUNDUP.test(title)) continue
    const key = normalizeTitle(title)
    if (seenTitles.has(key)) continue
    const boards = newsBoardsForMulti(`${title} ${item.summary ?? ''}`)
    if (boards.length === 0) continue
    seenTitles.add(key)
    for (const board of boards) {
      keptFlash.push({ ...item, id: `${item.id}-${board}`, tags: [BOARD_NEWS_TAGS[board], kind] })
    }
  }
  const res = store.appendNews([...keptOil, ...notices, ...keptFlash])
  const count = (board) => keptFlash.filter((n) => n.tags[0] === BOARD_NEWS_TAGS[board]).length
  const kept = {
    oil: keptOil.length,
    black: count('black'),
    chem: count('chem'),
    nonferrous: count('nonferrous'),
    agri: count('agri'),
    precious: count('precious'),
    newenergy: count('newenergy'),
    energy: count('energy'),
    other: count('other'),
    cffex: notices.length + count('cffex'),
  }
  // 所有源都空（结构变了/被封）= 失败；抓到了只是没有新条目 = 正常
  const allSources = oilItems.length + notices.length + flash.length + emNews.length + sinaNews.length
  if (allSources === 0) failed.push({ code: '*', error: '资讯源返回空' })
  return { fetched: allSources, kept: res.added, ...kept, failed }
}

/**
 * 只更新新闻（非交易时段的兜底）。
 * 单独拆出来，避免顺手刷新行情后让 quotes 的 asOf 变"新"而实际价格没动。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @returns {Promise<{ok: boolean, news?: any, errors: string[]}>}
 */
export async function updateNewsOnly(store) {
  try {
    const news = await updateNews(store)
    const failed = news.failed ?? []
    return { ok: failed.length === 0 ? true : false, news, errors: failed.map((f) => `news: ${f.error}`) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, errors: [`news: ${message}`], newsError: message }
  }
}

/**
 * 日常一轮：行情 + 新闻，盘中调用。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @returns {Promise<Record<string, any>>}
 */
export async function updateIntraday(store, deps = {}) {
  const impl = { updateQuotes, updateNews, ...deps }
  const out = {}
  const quotes = await runPart('quotes', () => impl.updateQuotes(store), (v) => v?.failed)
  const news = await runPart('news', () => impl.updateNews(store), (v) => v?.failed)
  if (quotes.value !== undefined) out.quotes = quotes.value
  if (quotes.error !== undefined) out.quotesError = quotes.error
  if (news.value !== undefined) out.news = news.value
  if (news.error !== undefined) out.newsError = news.error
  const merged = mergeOutcome([quotes, news])
  out.errors = merged.errors
  out.ok = merged.ok
  return out
}

/**
 * 收盘后一轮：日线 + 仓单 + 分级合约（默认也抓基差，供 CLI 一次性使用）。
 *
 * **调度器调用收盘任务时必须传 `withBasis: false`**：生意社当日现期表 16:30 之后才发布，
 * 收盘任务抓必然为空；早期把它算作失败后，收盘任务每天从 15:10 到 16:40 每分钟重试一次，
 * 一次重试约 57 个请求，对数据源是实打实的压力。基差由 16:40 的独立任务负责。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {Date} [now]
 * @param {Record<string, any>} [deps] 仅测试注入
 * @param {{withBasis?: boolean}} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function updateAfterClose(store, now = new Date(), deps = {}, options = {}) {
  // deps 只为测试注入（默认就是真实实现），生产调用不传
  const impl = { updateDaily, updateBasis, updateExtraSpot, updateStock, updateContracts, updateIndexHistory, updateEnergyRef, ...deps }
  const out = {}
  const date = localDate(now)
  const trading = isTradingDay(now)
  const withBasis = options.withBasis !== false
  const parts = []

  const daily = await runPart('daily', () => impl.updateDaily(store, now), (v) => v.failed)
  parts.push(daily)
  if (daily.value !== undefined) out.daily = daily.value
  if (daily.error !== undefined) out.dailyError = daily.error

  // 非交易日不抓基差：生意社当天不出表，抓了只会污染缺口记录
  if (trading && withBasis) {
    const basis = await runPart('basis', async () => {
      const res = await impl.updateBasis(store, date)
      // 现期表为空 = 没抓到，按失败计入（否则"当天跑过"会掩盖漏抓）
      if (res.ok === false || res.rows === 0) throw new Error('当日现期表为空')
      return res
    })
    parts.push(basis)
    if (basis.value !== undefined) out.basis = basis.value
    if (basis.error !== undefined) {
      out.basisError = basis.error
      store.recordGap('basis', date, basis.error)
    }

    // 葵油等生意社覆盖不到的品种，单独补现货
    const extra = await runPart('extra-spot', () => impl.updateExtraSpot(store, date, now))
    if (extra.ok && extra.value !== null && extra.value !== undefined) out.extraSpot = extra.value
    // 葵油补现货失败不算收盘任务失败（源站覆盖不稳定），但要留痕：
    // 写进 gaps 并单独带出，避免唯一一个非生意社现货源静默缺数
    if (!extra.ok) {
      out.extraSpotError = extra.error ?? '失败'
      store.recordGap?.('extra-spot', date, out.extraSpotError)
    } else {
      store.clearGap?.('extra-spot', date)
    }
  } else if (!trading) {
    out.basisSkipped = '非交易日'
  } else {
    out.basisSkipped = '交给 16:40 的基差任务'
  }

  const stock = await runPart('stock', () => impl.updateStock(store, now), (v) => v.failed)
  parts.push(stock)
  if (stock.value !== undefined) out.stock = stock.value
  if (stock.error !== undefined) out.stockError = stock.error

  const contracts = await runPart('contracts', () => impl.updateContracts(store, now), (v) => v.failed)
  parts.push(contracts)
  if (contracts.value !== undefined) out.contracts = contracts.value
  if (contracts.error !== undefined) out.contractsError = contracts.error

  // 指数日线（中金所股指的现货基准）
  const index = await runPart('index', () => impl.updateIndexHistory(store, now), (v) => v.failed)
  parts.push(index)
  if (index.value !== undefined) out.index = index.value
  if (index.error !== undefined) out.indexError = index.error

  // 能源折算参考（Brent + USD/CNY 日线）
  const energy = await runPart('energy', () => impl.updateEnergyRef(store, now), () => [])
  parts.push(energy)
  if (energy.value !== undefined) out.energy = energy.value
  if (energy.error !== undefined) out.energyError = energy.error


  const merged = mergeOutcome(parts)
  out.errors = merged.errors
  out.ok = merged.ok
  return out
}

/* ── 首次回填 ── */

/**
 * 清理历史遗留的"非交易日"缺口记录。
 *
 * 旧回填链路按周末过滤日期，把国庆/春节也抓了一遍并记成缺口；
 * 新链路用交易日历根本不会请求这些日期，这些缺口会永久躺在 meta 里冒充数据问题。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @returns {number} 清理条数
 */
export function pruneHolidayGaps(store) {
  const gaps = store.meta().gaps ?? []
  const kept = gaps.filter((g) => {
    if (g.dataset !== 'basis') return true
    if (typeof g.key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(g.key)) return true
    return isTradingDay(g.key)
  })
  const removed = gaps.length - kept.length
  if (removed > 0) store.patchMeta({ gaps: kept })
  return removed
}

/**
 * 本地已有完整基差数据的交易日集合（≥ minRows 个品种算完整）。
 *
 * 抽成纯函数是为了可测：`--skip-basis` 会跳过 99% 的历史日期，
 * n 的阈值直接决定复跑时会不会漏抓数据。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {number} [minRows]
 * @returns {Set<string>}
 */
export function basisCoveredDates(store, minRows = 5) {
  const counts = new Map()
  for (const row of store.readBasis()) counts.set(row.date, (counts.get(row.date) ?? 0) + 1)
  const out = new Set()
  for (const [day, n] of counts.entries()) if (n >= minRows) out.add(day)
  return out
}

/**
 * 给定区间，算出需要实际抓取的交易日与可跳过的交易日。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {string} from
 * @param {string} to
 * @param {{minRows?: number, skip?: boolean}} [options]
 * @returns {{all: string[], covered: Set<string>, fetch: string[]}}
 */
export function basisDatesToFetch(store, from, to, options = {}) {
  const all = tradingDaysBetween(from, to)
  const covered = options.skip === true ? basisCoveredDates(store, options.minRows ?? 5) : new Set()
  const fetch = covered.size === 0 ? all : all.filter((d) => !covered.has(d))
  return { all, covered, fetch }
}

/**
 * 回填历史数据。耗时与 basisYears 成正比（约 200ms/天）。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {object} [opts]
 * @param {number} [opts.basisYears] 基差回溯年数（默认 2）
 * @param {(msg: string) => void} [opts.log] 进度回调
 * @returns {Promise<Record<string, any>>}
 */
export async function bootstrap(store, opts = {}) {
  const basisYears = opts.basisYears ?? 2
  const skipExistingBasis = opts.skipExistingBasis === true
  const log = opts.log ?? (() => {})
  const now = new Date()
  const startedAt = new Date().toISOString()
  const summary = { startedAt, daily: {}, basis: null, stock: {}, news: null, errors: [] }

  const pruned = pruneHolidayGaps(store)
  if (pruned > 0) log(`清理旧链路遗留的非交易日缺口 ${pruned} 条`)
  store.patchMeta({ jobs: { ...store.meta().jobs, bootstrap: { state: 'running', startedAt } } })

  /* 1. 日线全量 */
  for (const v of activeVarieties(now)) {
    try {
      const bars = await sinaDaily(v.code)
      store.writeDaily(v.code, bars)
      summary.daily[v.code] = bars.length
      log(`日线 ${v.code} ${bars.length} 根`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      store.recordGap(`daily:${v.code}`, 'bootstrap', message)
      summary.errors.push(`daily:${v.code} ${message}`)
      log(`日线 ${v.code} 失败: ${message}`)
    }
    await sleep(250)
  }

  /* 2. 基差回溯：日期一律走交易日历 + 纯字符串运算，不经过 Date/UTC 转换 */
  const anchor = localDate(now)
  const fromDate = addDays(anchor, -Math.round(basisYears * 365))
  const dates = tradingDaysBetween(fromDate, anchor)
  // 已存在完整数据的交易日（至少 5 个品种有当日基差）可直接跳过，
  // 复跑验收时不必对源站重复发 400+ 次请求
  const coveredDates = skipExistingBasis ? basisCoveredDates(store) : new Set()
  if (skipExistingBasis) log(`基差回填：本地已有完整数据的 ${coveredDates.size} 个交易日将跳过`)
  let ok = 0
  let empty = 0
  let skipped = 0
  for (let i = 0; i < dates.length; i += 1) {
    const date = dates[i]
    if (coveredDates.has(date)) {
      skipped += 1
      continue
    }
    try {
      const res = await updateBasis(store, date)
      if (res.rows === 0) {
        empty += 1
        // 循环的日期来自 tradingDaysBetween，必然都是交易日，不必再分支
        store.recordGap('basis', date, '当日现期表为空（可能尚未发布）')
      } else {
        ok += 1
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      store.recordGap('basis', date, message)
      summary.errors.push(`basis:${date} ${message}`)
    }
    if (i % 30 === 0) log(`基差回填 ${i + 1}/${dates.length}（成功 ${ok}，空 ${empty}）`)
    await sleep(180)
  }
  summary.basis = { days: dates.length, ok, empty, skipped, from: dates[0], to: dates[dates.length - 1] }

  /* 3. 仓单 */
  for (const v of activeVarieties(now)) {
    const productCode = v.code.replace(/0$/, '')
    try {
      const rows = await warrantSeries(productCode)
      if (rows.length > 0) {
        store.appendStock(v.code, rows)
        summary.stock[v.code] = rows.length
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      store.recordGap(`stock:${v.code}`, 'bootstrap', message)
      summary.errors.push(`stock:${v.code} ${message}`)
    }
    await sleep(200)
  }

  /* 4. 新闻 */
  try {
    summary.news = await updateNews(store)
  } catch (error) {
    summary.errors.push(`news ${error instanceof Error ? error.message : String(error)}`)
  }

  /* 5. 分级合约（跨期结构） */
  try {
    summary.contracts = await updateContracts(store, now)
    log(`分级合约 ${summary.contracts.updated.length} 个`)
  } catch (error) {
    summary.errors.push(`contracts ${error instanceof Error ? error.message : String(error)}`)
  }

  /* 6. 指数日线（中金所股指的现货基准） */
  try {
    summary.index = await updateIndexHistory(store, now)
    log(`指数日线 ${summary.index.updated.length} 个`)
  } catch (error) {
    summary.errors.push(`index ${error instanceof Error ? error.message : String(error)}`)
  }

  /* 7. 能源折算参考（Brent + 汇率） */
  try {
    summary.energy = await updateEnergyRef(store, now)
    log(`能源参考 Brent ${summary.energy.brent} 根 / 汇率 ${summary.energy.fx} 天`)
  } catch (error) {
    summary.errors.push(`energy ${error instanceof Error ? error.message : String(error)}`)
  }

  const finishedAt = new Date().toISOString()
  summary.finishedAt = finishedAt
  // 有错误就写 partial，别把带错误码的回填标成 done
  const state = summary.errors.length === 0 ? 'done' : 'partial'
  store.patchMeta({
    jobs: {
      ...store.meta().jobs,
      bootstrap: { state, startedAt, finishedAt, errorCount: summary.errors.length, summary: { basis: summary.basis } },
    },
  })
  log(state === 'done' ? '回填完成' : `回填完成（${summary.errors.length} 项失败）`)
  return { ...summary, ok: summary.errors.length === 0 ? true : 'partial' }
}
