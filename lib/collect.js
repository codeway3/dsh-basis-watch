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

import { activeVarieties, contractCodes, resolveCatalog } from './catalog.js'
import {
  averageSpot,
  chinagrainNews,
  mysteelSunflowerSpot,
  sinaDaily,
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
      return { code: v.code, name: v.name }
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
  let foreign = []
  try {
    foreign = await sinaForeign()
  } catch {
    /* 外盘只是参考，失败不影响主流程 */
  }
  if (rows.length > 0) store.writeQuotes(rows, foreign)
  // rows 为空 = 整批行情没抓到，必须算失败，否则重试会被"成功"掩盖
  const failed = rows.length === 0 ? [{ code: '*', error: '行情接口返回空' }] : []
  return { rows: rows.length, foreign: foreign.length, at: new Date().toISOString(), failed }
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
      const bars = await sinaDaily(v.code)
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
  if (rows.length === 0) {
    // quiet：批量修订历史时，老页面可能已下线，不该把 daily 缺口列表刷满
    if (options.quiet !== true) store.recordGap('basis', date, '当日现期表为空')
    return { date, rows: 0, matched: 0 }
  }
  const savedAt = new Date().toISOString()
  const mapped = []
  for (const row of rows) {
    const v = varietyOfSpotName(row.commodity)
    if (v === null) continue
    mapped.push({
      ...row,
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
  const replaced = options.force === true ? store.replaceBasisDate(date, mapped) : null
  if (replaced === null) store.appendBasis(mapped)
  store.clearGap('basis', date)
  return { date, rows: rows.length, matched: mapped.length, ...(replaced === null ? {} : { replaced }) }
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
 * 每个品种只取前 4 个合约，避免请求过多。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {Date} [now]
 * @returns {Promise<{updated: string[], failed: string[]}>}
 */
export async function updateContracts(store, now = new Date()) {
  const updated = []
  const failed = []
  for (const v of activeVarieties(now)) {
    for (const code of contractCodes(v, now, 4)) {
      try {
        const bars = await sinaDaily(code)
        if (bars.length === 0) {
          failed.push(code)
          continue
        }
        store.writeDaily(code, bars)
        updated.push(code)
      } catch {
        failed.push(code)
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
  const out = []
  for (let y = startYear; y <= endYear; y += 1) {
    for (const m of variety.months ?? []) {
      out.push(`${prefix}${String(y).slice(2)}${String(m).padStart(2, '0')}`)
    }
  }
  return out
}

/**
 * 回填历史合约日线（复权用）。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {{ years?: number, now?: Date, concurrency?: number, onProgress?: (p: {done: number, total: number, code: string}) => void }} [opts]
 * @returns {Promise<{fetched: string[], skipped: string[], failed: string[]}>}
 */
export async function updateContractHistory(store, opts = {}) {
  const years = opts.years ?? 3
  const now = opts.now ?? new Date()
  const targets = []
  for (const v of activeVarieties(now)) {
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
 * 更新仓单（东财，逐品种追加）。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {Date} [now]
 * @returns {Promise<{updated: Record<string, number>, failed: Array<{code: string, error: string}>}>}
 */
export async function updateStock(store, now = new Date()) {
  const updated = {}
  const failed = []
  for (const v of activeVarieties(now)) {
    const productCode = v.code.replace(/0$/, '')
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
 * 更新新闻（中国粮油信息网，按品种栏目抓取）。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @returns {Promise<{fetched: number, kept: number}>}
 */
export async function updateNews(store) {
  const items = await chinagrainNews()
  const kept = items.filter((item) => newsRelevant(`${item.title} ${(item.tags ?? []).join(' ')}`))
  const res = store.appendNews(kept)
  // 一条都没抓到（栏目结构变了/被封）= 失败；抓到但全是旧闻 = 正常
  const failed = items.length === 0 ? [{ code: '*', error: '资讯源返回空' }] : []
  return { fetched: items.length, kept: res.added, failed }
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
 * 收盘后一轮：日线 + 基差 + 仓单。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {Date} [now]
 * @returns {Promise<Record<string, any>>}
 */
export async function updateAfterClose(store, now = new Date(), deps = {}) {
  // deps 只为测试注入（默认就是真实实现），生产调用不传
  const impl = { updateDaily, updateBasis, updateExtraSpot, updateStock, updateContracts, ...deps }
  const out = {}
  const date = localDate(now)
  const trading = isTradingDay(now)
  const parts = []

  const daily = await runPart('daily', () => impl.updateDaily(store, now), (v) => v.failed)
  parts.push(daily)
  if (daily.value !== undefined) out.daily = daily.value
  if (daily.error !== undefined) out.dailyError = daily.error

  // 非交易日不抓基差：生意社当天不出表，抓了只会污染缺口记录
  if (trading) {
    const basis = await runPart('basis', async () => {
      const res = await impl.updateBasis(store, date)
      // 现期表为空 = 没抓到，按失败计入（否则"当天跑过"会掩盖漏抓）
      if (res.rows === 0) throw new Error('当日现期表为空')
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
  } else {
    out.basisSkipped = '非交易日'
  }

  const stock = await runPart('stock', () => impl.updateStock(store, now), (v) => v.failed)
  parts.push(stock)
  if (stock.value !== undefined) out.stock = stock.value
  if (stock.error !== undefined) out.stockError = stock.error

  const contracts = await runPart('contracts', () => impl.updateContracts(store, now), (v) => v.failed)
  parts.push(contracts)
  if (contracts.value !== undefined) out.contracts = contracts.value
  if (contracts.error !== undefined) out.contractsError = contracts.error

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
