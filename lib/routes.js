/**
 * 宿主的 HTTP 路由：浏览器与 agent 都只通过这里读本地数据。
 *
 * 约定：
 * - `op=status`   数据覆盖情况（页面"数据完整度"面板）
 * - `op=overview` 板块快照（行情 + 基差 + 仓单，全部读本地文件）
 * - `op=update`   手动触发一次增量更新（盘中行情/新闻 或 收盘后日线）
 * - `op=bootstrap` 手动触发历史回填（后台跑，避免请求超时）
 *
 * 所有 op 都是只读本地文件；只有 update/bootstrap 会发起网络请求。
 *
 * @module dsh-basis-watch/lib/routes
 */

import { BOARDS, activeVarieties, contractCodes, resolveCatalog, sortByBoard, varietyOf } from './catalog.js'
import { bootstrap, localDate, updateAfterClose, updateBasis, updateIntraday } from './collect.js'
import { jobLockStatus, runJob } from './jobs.js'
import { calendarInfo, COVERAGE as CALENDAR_COVERAGE, expiryOfContract, shanghaiMinutes, tradingDaysBetween } from './calendar.js'
import { sleep } from './http.js'
import { BOARD_NEWS_TAGS } from './sources.js'
import { termStructure, termStructures } from './term.js'
import {
  basisSeries,
  basisStats,
  percentileOf,
  closesOf,
  computeSpreads,
  percentileWindows,
  seasonCurve,
  seasonWinRate,
  statsOf,
} from './calc.js'

/** 路由前缀（与 cordis.patch.yml 中的插件 id 对应）。 */
export const ROUTE_PATH = '/basis-watch/api'

/**
 * 各类数据的"新鲜度"阈值（小时）。超过就标记 stale，界面据此显示"数据截至某时点"。
 * 盘中行情 30 分钟，日线/基差/仓单跨周末，新闻 1 天。
 */
const STALE_HOURS = { quotes: 0.5, 'update-intraday': 0.5, 'update-close': 30, daily: 30, basis: 30, stock: 30, news: 24, bootstrap: 24 * 30 }

/**
 * 汇总各数据集的 asOf / 年龄 / 是否 stale。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @returns {Record<string, {asOf: string|null, ageHours: number|null, stale: boolean, status: string|null, lastError: any}>}
 */
export function freshness(store, now = Date.now()) {
  const out = {}
  const datasets = store.listDatasets()
  const lastUpdate = store.meta().lastUpdate ?? {}
  // 数据集状态机之外，历史上只有 meta.lastUpdate（按 dataset:code 记录），
  // 这里取同名前缀里最新的一个作为兜底，老数据也能给出时点。
  const fallbackOf = (name) => {
    const prefix = `${name}:`
    let newest = null
    for (const [key, at] of Object.entries(lastUpdate)) {
      if (key === name || key.startsWith(prefix)) {
        if (newest === null || String(at) > newest) newest = String(at)
      }
    }
    return newest
  }
  const names = new Set([...Object.keys(datasets), 'quotes', 'daily', 'basis', 'stock', 'news'])
  // 行情的"新鲜度"要看**源站时间**（quote.at），而不是我们抓取成功的时刻：
  // 非交易时段反复抓同一份快照时，抓取时刻很新但价格是几小时前的。
  const quotesSnapshot = store.readQuotes()
  // writeQuotes 里存的 at 是**落盘时刻**；真正的行情时间在 rows[i].at。
  // 非交易时段反复抓同一份快照时，落盘时刻永远是"刚刚"，会把过期价格伪装成新鲜数据。
  const sourceAts = (quotesSnapshot?.rows ?? [])
    .map((row) => row?.at)
    .filter((at) => typeof at === 'string' && at !== '')
    .sort()
  const quotesSourceAt = sourceAts.length > 0 ? sourceAts[sourceAts.length - 1] : null
  const quotesFetchedAt = quotesSnapshot?.at ?? null
  for (const name of names) {
    const st = datasets[name] ?? {}
    const fetchedAt = st.lastSuccess ?? fallbackOf(name) ?? null
    const asOf = name === 'quotes' ? (quotesSourceAt ?? quotesFetchedAt ?? fetchedAt) : fetchedAt
    const ageHours = asOf === null ? null : (now - Date.parse(asOf)) / 3600000
    const limit = STALE_HOURS[name] ?? 48
    out[name] = {
      asOf,
      /** 我们抓取成功的时刻（asOf 是源站数据时间，两者可能差很久） */
      fetchedAt: name === 'quotes' ? quotesFetchedAt : fetchedAt,
      ageHours: ageHours === null ? null : Number(ageHours.toFixed(1)),
      stale: ageHours === null ? true : ageHours > limit,
      status: st.status ?? null,
      lastError: st.lastError ?? null,
    }
  }
  return out
}

/**
 * 组装板块快照。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {Date} [now]
 * @returns {Record<string, any>}
 */
/**
 * 股指的"期指 vs 现货指数"日序列。
 *
 * 口径与商品相反：**基差 = 期货 − 现货指数**（贴水为负），符合中金所/行业习惯。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {{code: string, indexCode: string}} variety
 * @returns {Array<{date: string, spot: number, future: number, basis: number, basisRate: number}>}
 */
export function indexBasisSeries(store, variety) {
  const bars = store.readDaily(variety.code)?.bars ?? []
  const index = store.readIndex(variety.indexCode)?.bars ?? []
  const idxMap = new Map(index.map((b) => [b.d, b.c]))
  const out = []
  for (const b of bars) {
    const c = idxMap.get(b.d)
    if (!Number.isFinite(c) || c <= 0 || !Number.isFinite(b.c)) continue
    const basis = b.c - c
    out.push({
      date: b.d,
      spot: Number(c.toFixed(2)),
      future: Number(b.c.toFixed(2)),
      basis: Number(basis.toFixed(2)),
      basisRate: Number(((basis / c) * 100).toFixed(3)),
    })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 组装总览（行情 + 基差 + 仓单，全部读本地文件）。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {Date} [now]
 * @returns {Record<string, any>}
 */
/**
 * 目录按「板块顺序 + 板块内产业分组」排序（只影响展示）。
 * @param {Date} [now]
 * @returns {any[]}
 */
function catalogForDisplay(now = new Date()) {
  const byBoard = new Map()
  for (const v of resolveCatalog(now)) {
    if (!byBoard.has(v.board)) byBoard.set(v.board, [])
    byBoard.get(v.board).push(v)
  }
  const out = []
  for (const b of BOARDS) out.push(...sortByBoard(b.id, byBoard.get(b.id) ?? []))
  return out
}

/** 3 年窗口分位（series: [{date, value}]）。 */
function percentile3y(series, value) {
  if (!Number.isFinite(value) || series.length < 20) return null
  const anchor = series[series.length - 1].date
  const anchorTs = new Date(`${anchor}T00:00:00+08:00`).getTime()
  const values = series
    .filter((p) => new Date(`${p.date}T00:00:00+08:00`).getTime() >= anchorTs - 3 * 365 * 86400000)
    .map((p) => p.value)
    .filter((x) => Number.isFinite(x))
  if (values.length < 20) return null
  return Number(percentileOf(values, value).toFixed(1))
}

/** 最近 n 个交易日的变化（百分比）。 */
function changeOf(series, span = 20) {
  if (series.length <= span) return null
  const last = series[series.length - 1].value
  const prev = series[series.length - 1 - span].value
  if (!Number.isFinite(prev) || prev <= 0 || !Number.isFinite(last)) return null
  return Number((((last - prev) / prev) * 100).toFixed(2))
}

let overviewCache = null
let termCache = null

/** 把基差行按 code 分组一次，供 buildOverview 复用。 */
function groupBasisByCode(rows) {
  const map = new Map()
  for (const row of rows) {
    if (!Number.isFinite(row.basisRate)) continue
    const list = map.get(row.code)
    if (list === undefined) map.set(row.code, [row])
    else list.push(row)
  }
  return map
}

export function buildOverview(store, now = new Date()) {
  const quotes = store.readQuotes()
  // 结果缓存：key 含各数据集最后更新时间，盘中行情/收盘落盘/CLI 回填都会失效。
  // 注意 meta.lastUpdate 是**按品种**存的（daily:M0 / stock:M0 等），要按前缀聚合取最大值；
  // 同时把 store.root 纳入 key，避免多个 store 共用模块级缓存串数据。
  const lastUpdate = store.meta().lastUpdate ?? {}
  const stampOf = (prefix) => {
    let max = ''
    for (const [key, at] of Object.entries(lastUpdate)) {
      if (key !== prefix && !key.startsWith(`${prefix}:`)) continue
      const text = String(at ?? '')
      if (text > max) max = text
    }
    return max
  }
  // 注：`contracts:` 目前没有写入方（合约日线走 daily:CODE），保留是为了以后真加合约数据集时不用改 key
  const cacheKey = `${store.root}|${quotes?.at ?? ''}|${stampOf('daily')}|${stampOf('basis')}|${stampOf('stock')}|${stampOf('contracts')}|${localDate(now)}`
  if (overviewCache !== null && overviewCache.key === cacheKey && Date.now() - overviewCache.at < 15000) return overviewCache.data
  const catalog = catalogForDisplay(now)
  const basisAll = store.readBasis()
  const basisByCode = groupBasisByCode(basisAll)
  const quoteByCode = new Map((quotes?.rows ?? []).map((r) => [r.code, r]))
  const indexBySymbol = new Map((quotes?.indices ?? []).map((r) => [r.symbol, r]))
  const rows = catalog.map((v) => {
    const quote = quoteByCode.get(v.code) ?? null
    const daily = store.readDaily(v.code)
    // 主图用主连**真实报价**（与详情页分位同口径）；换月跳空只影响收益率类统计，
    // 已经在详情页用复权序列单独处理。
    const closes = closesOf(daily?.bars ?? [])
    const isIndexBasis = v.basisMode === 'future-index'
    const bSeries = isIndexBasis ? indexBasisSeries(store, v) : basisSeries(basisByCode.get(v.code) ?? [], v.code)
    const b = bSeries.length > 0 ? bSeries[bSeries.length - 1] : null
    const bStats = basisStats(bSeries)
    // 价格 3 年分位：国债/无现货品种没有基差分位，用价格分位补位
    const pricePercentile = (() => {
      if (closes.length < 20) return null
      const anchor = closes[closes.length - 1]
      const anchorTs = new Date(`${anchor.date}T00:00:00+08:00`).getTime()
      const values = closes
        .filter((p) => new Date(`${p.date}T00:00:00+08:00`).getTime() >= anchorTs - 3 * 365 * 86400000)
        .map((p) => p.close)
        .filter((x) => Number.isFinite(x))
      return values.length >= 20 ? Number(percentileOf(values, anchor.close).toFixed(1)) : null
    })()
    const stockRows = v.exchange === 'CFFEX' ? [] : store.readStock(v.code)
    const lastStock = stockRows.length > 0 ? stockRows[stockRows.length - 1] : null
    // 盘中用实时价 + 指数快照算一个"当下"的基差，收盘后自然等于日线口径
    const indexQuote = isIndexBasis ? (indexBySymbol.get(v.indexCode) ?? null) : null
    const liveFuture = quote?.last ?? (closes.length > 0 ? closes[closes.length - 1].close : null)
    const liveBasis =
      isIndexBasis && indexQuote !== null && Number.isFinite(liveFuture) && Number.isFinite(indexQuote.last)
        ? {
            date: localDate(now),
            spot: indexQuote.last,
            future: liveFuture,
            basis: Number((liveFuture - indexQuote.last).toFixed(2)),
            basisRate: Number((((liveFuture - indexQuote.last) / indexQuote.last) * 100).toFixed(3)),
            contract: null,
            mode: 'future-index',
          }
        : null
    // 能源：现货 = Brent × 汇率 × 系数（无国内现货报价，口径要标注）
    const isEnergy = v.spotSource === 'brent'
    const energyRefNow = isEnergy ? (quotes?.energy ?? null) : null
    const energyBasis =
      energyRefNow !== null && Number.isFinite(liveFuture)
        ? (() => {
            const spot = energyRefNow.brent * energyRefNow.usdcny * (v.brentFactor ?? 1)
            const basis = spot - liveFuture
            return {
              date: localDate(now),
              spot: Number(spot.toFixed(2)),
              future: liveFuture,
              basis: Number(basis.toFixed(2)),
              basisRate: Number(((basis / spot) * 100).toFixed(2)),
              contract: null,
              mode: 'energy',
            }
          })()
        : null
    return {
      code: v.code,
      name: v.name,
      exchange: v.exchange,
      board: v.board,
      kind: v.kind,
      status: v.effectiveStatus,
      listDate: v.listDate,
      note: v.note,
      basisMode: v.spotSource === 'brent' ? 'energy' : (v.basisMode ?? 'spot-future'),
      price: quote?.last ?? (closes.length > 0 ? closes[closes.length - 1].close : null),
      priceAt: quote?.at ?? null,
      prevSettle: quote?.prevSettle ?? null,
      changePct:
        quote !== null && Number.isFinite(quote.prevSettle) && quote.prevSettle > 0
          ? ((quote.last - quote.prevSettle) / quote.prevSettle) * 100
          : null,
      hold: quote?.hold ?? null,
      /** 表格里的迷你走势（近 60 个收盘） */
      spark: closes.slice(-60).map((p) => Number(p.close.toFixed(2))),
      /** 主图用的收盘序列（近 180 个，带日期；盘中会把实时价接在末尾） */
      priceSeries: (() => {
        const series = closes.slice(-180).map((p) => ({ date: p.date, close: Number(p.close.toFixed(2)) }))
        const lastBar = series[series.length - 1]
        const quoteDate = quote?.at ? localDate(new Date(quote.at)) : null
        if (quoteDate !== null && Number.isFinite(quote?.last) && (lastBar === undefined || quoteDate > lastBar.date)) {
          series.push({ date: quoteDate, close: Number(quote.last), intraday: true })
        }
        return series
      })(),
      /** 主图用的基差率序列（带日期与合约，客户端按日期 join） */
      basisSeries: bSeries.slice(-180).map((p) => ({
        date: p.date,
        basisRate: Number(p.basisRate.toFixed(2)),
        contract: p.contract ?? null,
      })),
      basis:
        liveBasis ??
        energyBasis ??
        (b === null ? null : { date: b.date, spot: b.spot, future: b.future, basis: b.basis, basisRate: b.basisRate, contract: b.contract ?? null, mode: isIndexBasis ? 'future-index' : isEnergy ? 'energy' : 'spot-future' }),
      basisPercentile: bStats.p3y?.percentile ?? null,
      pricePercentile,
      basisSample: bStats.sample ?? 0,
      stock: lastStock === null ? null : { date: lastStock.date, warrant: lastStock.warrant, delta: lastStock.delta, days: stockRows.length },
    }
  })
  const result = {
    ok: true,
    at: new Date().toISOString(),
    asOf: freshness(store),
    quoteAt: quotes?.at ?? null,
    foreign: quotes?.foreign ?? [],
    /** 板块定义给前端做切换器 */
    boards: BOARDS,
    rows,
    coverage: {
      basisDays: basisAll.length,
      gaps: store.meta().gaps.slice(-10),
    },
  }
  overviewCache = { key: cacheKey, at: Date.now(), data: result }
  return result
}

/**
 * 组装某品种的详情（价格/季节/基差/仓单/跨期/统计）。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {string} code
 * @param {Date} [now]
 * @returns {Record<string, any>}
 */
export function buildDetail(store, code, now = new Date()) {
  const variety = varietyOf(code)
  if (variety === undefined) return { ok: false, error: `未知品种: ${code}` }
  const catalogItem = resolveCatalog(now).find((v) => v.code === variety.code) ?? variety
  const daily = store.readDaily(variety.code)
  const rawBars = daily?.bars ?? []

  /**
   * 两套口径，各用各的：
   * - **回撤/波动率**用比例复权序列（消除换月跳空），只取复权覆盖区间；
   * - **价格分位 / K 线 / 走势图**用主连真实报价（未复权），
   *   因为比例复权会按跨期价差缩放历史价格水平，"当前价在历史价格里的位置"会被系统性改写。
   */
  const continuous = store.readContinuous(variety.code)
  const bars = continuous?.bars?.length > 0
    ? continuous.bars
        .filter((b) => Number.isFinite(b.adj))
        .map((b) => ({ d: b.d, o: b.o, h: b.h, l: b.l, c: b.adj, v: b.v ?? 0, p: 0 }))
    : rawBars
  /** 复权覆盖信息：区间外没有合约数据，不做平移 */
  const continuousMeta = continuous === null ? null : {
    method: 'ratio-backadjust',
    from: continuous.coverage?.from ?? null,
    to: continuous.coverage?.to ?? null,
    rolls: continuous.rolls?.length ?? 0,
  }

  /**
   * 统计只使用"复权覆盖区间"内的数据：
   * 覆盖区间之前没有合约数据、无法消除换月跳空，混进来会污染分位/回撤/波动。
   */
  const analysisBars =
    continuousMeta === null || continuousMeta.from === null
      ? bars
      : bars.filter((b) => b.d >= continuousMeta.from)

  // 分级合约（跨期）：只取有数据的，按月份排序
  const contracts = []
  for (const contractCode of contractCodes(variety, now)) {
    const cDaily = store.readDaily(contractCode)
    const cBars = cDaily?.bars ?? []
    if (cBars.length === 0) continue
    const last = cBars[cBars.length - 1]
    contracts.push({
      code: contractCode,
      month: `${contractCode.slice(-4, -2)}/${contractCode.slice(-2)}`,
      close: Number(last.c),
      date: last.d,
      hold: Number(last.p) || 0,
      bars: cBars.length,
    })
  }
  // 用最晚一天标记"陈旧"：临近交割的合约在源站会提前停更，
  // 界面上如果和最新合约并排显示而不标日期，很容易被当成同一天的价格。
  const contractsAsOf = contracts.reduce((acc, c) => (c.date > acc ? c.date : acc), '')
  for (const c of contracts) c.stale = c.date !== contractsAsOf

  // 基差：商品 = 现货 − 期货；股指 = 期货 − 指数；国债无现货基准（需要 CTD/IRR）
  const isIndexBasis = variety.basisMode === 'future-index'
  const hasBasis = variety.basisMode !== 'none'
  const basisAll = hasBasis ? (isIndexBasis ? indexBasisSeries(store, variety) : basisSeries(store.readBasis(), variety.code)) : []
  const basisLast = basisAll[basisAll.length - 1]
  // 股指的年化贴水：用持仓量最大的合约推算到期日（当月/次月谁当主力由持仓决定）
  const mainContract = contracts.reduce((acc, c) => (c.hold > (acc?.hold ?? -1) ? c : acc), null)
  const mainExpiry = mainContract === null ? null : expiryOfContract(variety.kind === 'bond' ? 'bond' : 'stock', mainContract.code)
  const basisDays = mainExpiry === null ? null : daysBetween(localDate(now), mainExpiry)
  const annualized =
    basisLast !== undefined && basisDays !== null && basisDays > 0
      ? Number(((basisLast.basisRate * 365) / basisDays).toFixed(2))
      : null
  const basis = hasBasis
    ? {
        ...basisStats(basisAll),
        /** 最新一条基差对应的期货合约与来源，界面要标注口径 */
        contract: basisLast?.contract ?? mainContract?.code ?? null,
        source: isIndexBasis ? 'index' : (basisLast?.source ?? null),
        sourceDate: basisLast?.sourceDate ?? basisLast?.date ?? null,
        mode: isIndexBasis ? 'future-index' : variety.spotSource === 'brent' ? 'energy' : 'spot-future',
        mainContract: mainContract?.code ?? null,
        expiry: mainExpiry,
        daysToExpiry: basisDays,
        annualized,
      }
    : {
        sample: 0,
        mode: 'none',
        reason: variety.noBasisReason ?? '国债期货没有免费的可交割券/IRR 数据，只做期限结构与跨期',
      }

  // 仓单（中金所没有）
  const stockAll = variety.exchange === 'CFFEX' ? [] : store.readStock(variety.code)
  const stock = stockAll.length === 0 ? null : {
    sample: stockAll.length,
    from: stockAll[0].date,
    to: stockAll[stockAll.length - 1].date,
    last: stockAll[stockAll.length - 1],
    series: stockAll.slice(-120),
  }

  // 相关价差（含本品种的组合）
  const dailyByCode = new Map()
  for (const v of activeVarieties(now)) {
    const d = store.readDaily(v.code)
    if (d?.bars) dailyByCode.set(v.code, d.bars)
  }
  const spreads = computeSpreads(dailyByCode).filter((s) => s.a === variety.code || s.b === variety.code)

  // 相关新闻：油料按品种名/标签匹配；其余板块按板块标签取（中金所公告 + 快讯）
  const news = (() => {
    const all = store.readNews(400)
    const boardTag = BOARD_NEWS_TAGS[variety.board]
    const matched =
      boardTag !== undefined
        ? all.filter((n) => (n.tags ?? []).includes(boardTag))
        : all.filter((n) => {
            const tags = n.tags ?? []
            if (tags.some((t) => variety.name.includes(t) || t.includes(variety.name.slice(0, 1)))) return true
            return String(n.title ?? '').includes(variety.name)
          })
    return matched
      .slice()
      .sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')))
      .slice(0, 40)
  })()

  const quotes = store.readQuotes()
  const indexQuote = variety.indexCode === undefined ? null : (quotes?.indices ?? []).find((i) => i.symbol === variety.indexCode) ?? null

  return {
    ok: true,
    at: new Date().toISOString(),
    asOf: freshness(store),
    variety: catalogItem,
    quote: (quotes?.rows ?? []).find((r) => r.code === variety.code) ?? null,
    indexQuote,
    // 外盘参考只对油料有意义（S/SM/BO/FCPO），其它板块不展示
    foreign: catalogItem.board === 'oil' ? (quotes?.foreign ?? []) : [],
    price: {
      last: rawBars.length > 0 ? Number(rawBars[rawBars.length - 1].c) : null,
      date: rawBars.length > 0 ? rawBars[rawBars.length - 1].d : null,
      /** 详情页 K 线用的 OHLC（最近 180 根，主连真实报价，未复权） */
      bars: rawBars.slice(-180).map((b) => ({ d: b.d, o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c), v: Number(b.v) })),
      spark: closesOf(rawBars).slice(-180).map((p) => Number(p.close.toFixed(2))),
      dates: closesOf(rawBars).slice(-180).map((p) => p.date),
      /** 回撤/波动率：比例复权（覆盖区间内），不受换月跳空影响 */
      stats: statsOf(analysisBars),
      /** 价格分位：主连真实报价（未复权），否则"当前价在历史分布中的位置"会被缩放扭曲 */
      percentile: percentileWindows(rawBars),
      /** 明确告诉前端每块数字用的哪套口径 */
      caliber: {
        stats: continuous === null ? 'raw' : 'adjusted',
        percentile: 'raw',
        chart: 'raw',
        coverage: continuousMeta?.from ?? null,
      },
    },
    continuous: continuousMeta,
    // 季节曲线是"年内相对首日收盘的百分比"，复权序列按常数因子缩放后**百分比不变**，
    // 且能去掉年内的换月跳空——所以这里用复权序列比用原始报价更干净。
    season: seasonCurve(analysisBars, 10),
    seasonWin: seasonWinRate(analysisBars, 10),
    basis,
    basisSeries: basisAll.slice(-500),
    stock,
    contracts,
    contractsAsOf,
    spreads,
    news,
    gaps: store.meta().gaps.filter((g) => String(g.dataset).includes(variety.code)).slice(-20),
    /** 葵油等额外现货源的状态：失败时界面要能看见，而不是静默缺数 */
    extraSpot:
      variety.board === 'cffex'
        ? { ok: true, error: null, date: null }
        : (() => {
            const gap = store.meta().gaps.filter((g) => g.dataset === 'extra-spot').slice(-1)[0] ?? null
            return gap === null ? { ok: true, error: null, date: null } : { ok: false, error: gap.reason, date: gap.key }
          })(),
  }
}

/**
 * 组装全部价差组合。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {Date} [now]
 * @returns {Record<string, any>}
 */
export function buildSpreads(store, now = new Date()) {
  const dailyByCode = new Map()
  for (const v of activeVarieties(now)) {
    const d = store.readDaily(v.code)
    if (d?.bars) dailyByCode.set(v.code, d.bars)
  }
  const spreads = computeSpreads(dailyByCode)
  // 画图不需要整条序列，去掉以减少响应体积
  return {
    ok: true,
    at: new Date().toISOString(),
    asOf: freshness(store),
    spreads: spreads.map((s) => {
      const { series, ...rest } = s
      return rest
    }),
  }
}

/**
 * 批量修订历史基差（后台任务）。
 *
 * 抽成导出函数便于测试"抢锁失败时补写 idle 状态"这一分支。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {{days: string[], force: boolean}} options
 * @returns {Promise<{started: boolean, reason?: string}>}
 */
export async function startBasisBatch(store, options) {
  const out = await runJob(
    store,
    'basis-batch',
    async () => {
      let rows = 0
      let matched = 0
      const errors = []
      for (const day of options.days) {
        try {
          const res = await updateBasis(store, day, { force: options.force, quiet: true })
          rows += res.rows
          matched += res.matched
        } catch (error) {
          errors.push(`${day}: ${error instanceof Error ? error.message : String(error)}`)
        }
        await sleep(200)
      }
      return { ok: errors.length === 0 ? true : 'partial', errors, dates: options.days.length, rows, matched }
    },
    { ttlMs: 2 * 3600 * 1000 },
  )
  if (out.started === false) {
    store.updateDataset('basis-batch', {
      status: 'idle',
      lastError: { at: new Date().toISOString(), message: out.reason ?? '未启动' },
    })
  }
  return { started: out.started !== false, reason: out.reason }
}

/**
 * 读取 URL 上的查询参数。
 * @param {string} url
 * @returns {URLSearchParams}
 */
function qsOf(url) {
  const idx = String(url).indexOf('?')
  return new URLSearchParams(idx >= 0 ? String(url).slice(idx + 1) : '')
}

/* ── 参数校验 ── */

/** 合法日期形状（不做闰年等语义校验：URL 拼接只接受定长数字，避免路径注入）。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u
/** 历史修订最多一次跑多少天：防止 `from=1900&to=2100` 把进程挂死。 */
const MAX_BASIS_RANGE_DAYS = 1200
/** 回填年数上限：2 年已经要跑 400+ 个日期，再多只是给源站添堵。 */
const MAX_BOOTSTRAP_YEARS = 5
/** 手动触发写操作的冷却时间：防止本地页面/脚本连点把源站打挂。 */
const UPDATE_COOLDOWN_MS = 30 * 1000

/**
 * 夹取整数。
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 两个 YYYY-MM-DD 之间的自然日天数（UTC 计算，不受宿主时区影响）。
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)
}

/**
 * 写操作冷却检查。
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {string} name 数据集名
 * @returns {{cooling: boolean, since?: string}}
 */
function coolingDown(store, name) {
  const last = store.dataset(name)?.lastSuccess
  if (typeof last !== 'string') return { cooling: false }
  const at = Date.parse(last)
  if (!Number.isFinite(at)) return { cooling: false }
  return { cooling: Date.now() - at < UPDATE_COOLDOWN_MS, since: last }
}

/**
 * 注册路由。
 * @param {object} ctx cordis 插件上下文
 * @param {ReturnType<import('./store.js').createStore>} store
 * @returns {() => void} 注销函数
 */
export function registerRoutes(ctx, store) {

  const json = (res, code, body) => {
    const text = JSON.stringify(body)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  }

  const handle = async (req, res) => {
    const qs = qsOf(req.url ?? '')
    const op = qs.get('op') ?? 'status'

    if (op === 'status') {
      return json(res, 200, {
        ok: true,
        catalog: catalogForDisplay(),
        /** 板块定义（前端切换器用；放 status 里首屏即可用，不必等总览接口） */
        boards: BOARDS,
        coverage: store.coverage(),
        meta: store.meta(),
        /** 各数据集的 watermark / lastSuccess / lastError / retryAt */
        datasets: store.listDatasets(),
        // 与 backfillLock 用同一 TTL：长批量会占 job 锁，30 分钟的默认值会误判为陈旧
        lock: jobLockStatus(store.root, 'job', 2 * 3600 * 1000),
        backfillLock: jobLockStatus(store.root, 'backfill', 2 * 3600 * 1000),
        calendar: (() => {
          const info = calendarInfo()
          return { date: info.date, trading: info.trading, reason: info.reason, holiday: info.holiday, covered: info.covered, coverage: CALENDAR_COVERAGE }
        })(),
        asOf: freshness(store),
      })
    }

    if (op === 'overview') {
      return json(res, 200, buildOverview(store))
    }

    if (op === 'detail') {
      const code = qs.get('code') ?? 'M0'
      const detail = buildDetail(store, code)
      return json(res, detail.ok === false ? 400 : 200, detail)
    }

    if (op === 'term') {
      // 跨期结构（月差）：按当日持仓量选合约，默认返回全部在用品种
      const code = qs.get('code')
      if (code !== null) {
        const one = termStructure(store, code)
        if (one === null) return json(res, 404, { ok: false, error: `未知品种: ${code}` })
        return json(res, 200, { ok: true, rows: [one] })
      }
      // 全品种要读上百个合约文件，进程重启/收盘落盘后缓存失效，避免每次点开都重算
      const lastUpdateTerm = store.meta().lastUpdate ?? {}
      let termStamp = ''
      for (const [key, at] of Object.entries(lastUpdateTerm)) {
        // contracts: 同上，目前无写入方；daily: 覆盖合约日线
        if (!key.startsWith('daily:') && !key.startsWith('contracts:')) continue
        const text = String(at ?? '')
        if (text > termStamp) termStamp = text
      }
      const termKey = `${store.root}|${termStamp}|${localDate(new Date())}`
      if (termCache !== null && termCache.key === termKey && Date.now() - termCache.at < 120000) {
        return json(res, 200, { ok: true, rows: termCache.rows })
      }
      const termRows = termStructures(store, activeVarieties())
      termCache = { key: termKey, at: Date.now(), rows: termRows }
      return json(res, 200, { ok: true, rows: termRows })
    }

    if (op === 'spreads') {
      return json(res, 200, buildSpreads(store))
    }

    if (op === 'news') {
      const limit = clampInt(qs.get('limit'), 60, 1, 300)
      const tag = qs.get('tag')
      const board = qs.get('board')
      // 按板块筛时先多读一些，否则"最近 N 条"可能全被另一个板块占满
      let rows = store.readNews(board === null || board === '' ? limit : Math.max(limit, 260))
      // 板块标签与 catalog.BOARDS 一一对应；oil 没有独立标签，用排除法
      if (board !== null && BOARD_NEWS_TAGS[board] !== undefined) {
        rows = rows.filter((n) => (n.tags ?? []).includes(BOARD_NEWS_TAGS[board]))
      } else if (board === 'oil') {
        const tags = Object.values(BOARD_NEWS_TAGS)
        rows = rows.filter((n) => !tags.some((t) => (n.tags ?? []).includes(t)))
      }
      if (tag !== null && tag !== '') rows = rows.filter((n) => (n.tags ?? []).includes(tag))
      rows = rows.slice().sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? ''))).slice(0, limit)
      return json(res, 200, { ok: true, board: board ?? null, rows })
    }

    if (op === 'update') {
      const mode = qs.get('mode') === 'close' ? 'close' : 'intraday'
      const name = mode === 'close' ? 'update-close' : 'update-intraday'
      // 手动触发加冷却：连点会让外网抓取变成扇源站
      const cool = coolingDown(store, name)
      if (cool.cooling) return json(res, 200, { ok: true, started: false, mode, reason: '刚刚更新过，稍后再试', since: cool.since })
      // 跨进程锁 + 状态机：与调度器、CLI 共用同一把锁，避免两个进程同时写数据。
      // 手动「收盘更新」在 16:40 之前不抓基差：当天现期表还没发布，抓了只会把任务判成 partial。
      const withBasis = mode === 'close' ? shanghaiMinutes(new Date()) >= 16 * 60 + 40 : false
      const out = await runJob(store, name, async () =>
        mode === 'close' ? await updateAfterClose(store, new Date(), {}, { withBasis }) : await updateIntraday(store),
      )
      return json(res, 200, { ...out, mode, withBasis })
    }

    if (op === 'bootstrap') {
      const years = clampInt(qs.get('years'), 2, 1, MAX_BOOTSTRAP_YEARS)
      // 后台跑，立刻返回；进度看 op=status 的 datasets.bootstrap
      // 先看长任务锁是否已被占用，避免明明没启动却回 started:true
      if (jobLockStatus(store.root, 'backfill', 2 * 3600 * 1000).held) {
        // 与 startBasisBatch 一致：没启动也要在状态机里留痕，别让前端轮询看到旧状态
        store.updateDataset('bootstrap', {
          status: 'idle',
          lastError: { at: new Date().toISOString(), message: '已有回填任务在运行' },
        })
        return json(res, 200, { ok: true, started: false, reason: '已有回填任务在运行' })
      }
      const task = runJob(store, 'bootstrap', () => bootstrap(store, { basisYears: years }), {
        // 回填可能跑十几分钟，锁的 TTL 必须放宽，否则会被别的进程当陈旧锁回收
        ttlMs: 2 * 3600 * 1000,
        lockName: 'backfill',
        retryMs: 30 * 60 * 1000,
      })
      task.catch(() => {
        /* runJob 已把错误写进状态机 */
      })
      return json(res, 200, { ok: true, started: true, years, note: '后台回填中，轮询 op=status 查看 datasets.bootstrap' })
    }

    if (op === 'basis') {
      const force = qs.get('force') === '1' || qs.get('force') === 'true'
      const from = qs.get('from')
      const to = qs.get('to')
      // 单日：同步返回（一次请求很快）；区间：后台跑 + backfill 锁，
      // 不能让几百天的循环 await 在 HTTP 请求里，也不能用 30 分钟 TTL 的长任务锁。
      if (from === null || to === null) {
        const date = qs.get('date') ?? localDate()
        if (!DATE_RE.test(date)) return json(res, 400, { ok: false, error: `日期格式应为 YYYY-MM-DD: ${date}` })
        const out = await runJob(store, 'basis', () => updateBasis(store, date, { force }), { watermarkOf: () => date })
        return json(res, 200, { ...out, date, force })
      }
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
        return json(res, 400, { ok: false, error: `日期格式应为 YYYY-MM-DD: ${from} ~ ${to}` })
      }
      const span = daysBetween(from, to)
      if (!Number.isFinite(span) || span < 0) return json(res, 400, { ok: false, error: `区间不合法: ${from} ~ ${to}` })
      if (span > MAX_BASIS_RANGE_DAYS) {
        return json(res, 400, { ok: false, error: `区间过大（${span} 天），一次最多 ${MAX_BASIS_RANGE_DAYS} 天` })
      }
      // 前置检查与 runJob 用同一套 TTL（2 小时），否则长批量 30 分钟后会被误判为"没在跑"
      if (jobLockStatus(store.root, 'job', 2 * 3600 * 1000).held) {
        store.updateDataset('basis-batch', {
          status: 'idle',
          lastError: { at: new Date().toISOString(), message: '已有抓取任务在运行' },
        })
        return json(res, 200, { ok: true, started: false, reason: '已有抓取任务在运行' })
      }
      const days = tradingDaysBetween(from, to)
      // startBasisBatch 内部已处理抢锁失败（写 idle）与异常（写 error），这里只兜住 rejection
      void startBasisBatch(store, { days, force }).catch(() => {
        /* 状态机已记录 */
      })
      return json(res, 200, { ok: true, started: true, from, to, dates: days.length, note: '后台修订中，轮询 op=status 查看 datasets["basis-batch"]' })
    }

    return json(res, 400, { ok: false, error: `未知操作: ${op}` })
  }

  return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PATH,
    handler: (req, res) => {
      handle(req, res).catch((error) => {
        try {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        } catch {
          /* 响应已结束 */
        }
      })
    },
  })
}
