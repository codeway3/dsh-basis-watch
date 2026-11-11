/**
 * 跨期结构（月差）：按**持仓量动态选合约**，而不是固定"近月/次月"。
 *
 * 为什么不用固定规则：临近交割的合约持仓量会迅速掉到 0，固定取"最近的 4 个合约"经常
 * 取到没人交易的远月，价差噪音大；按当日持仓量排序再按交割月排列，选出来的才是当天
 * 真正活跃的合约。
 *
 * 指标口径（跟随交易所套利指令惯例）：
 * - 价差 = **近月收盘 − 远月收盘**（元/吨）。郑商所组合指令即 `价差 = 近期合约价格 − 远期合约价格`，
 *   正价差 = 近强远弱（backwardation），负价差 = 近弱远强（contango）
 * - 价差率 = 价差 ÷ 近月收盘（不同合约对之间唯一可比的量；正 = 近强）
 * - 年化 = 价差率 × 365 ÷ 交割月间隔天数（按 30.44 天/月折算，不含仓储/资金/税费，不是真实收益）
 * - 分位只在**同一合约对**内部计算：不同合约对的价差量级不同，跨对比较没有意义
 *
 * @module lib/term
 */

import { contractCodes, varietyOf } from './catalog.js'
import { percentileOf } from './calc.js'

/** 默认取持仓量最高的前 N 个合约参与对比（5 个足以覆盖两个季度的月差）。 */
export const DEFAULT_TOP = 5
/** 单腿成交量低于该值时提示流动性不足（不剔除，只标注）。 */
export const THIN_VOLUME = 5000
/** 计算分位所需的最少重叠样本。 */
const MIN_SAMPLE = 20

/**
 * 把 store 里的日线统一成数组（兼容 `[]` 与 `{bars: []}` 两种落盘形态）。
 * @param {any} raw
 * @returns {Array<{d: string, c: number, v?: number, p?: number}>}
 */
function barsOf(raw) {
  const list = Array.isArray(raw) ? raw : (raw?.bars ?? [])
  return list.filter((b) => typeof b?.d === 'string' && Number.isFinite(b?.c))
}

/**
 * 解析合约代码里的年月：`M2701` → { prefix: 'M', year: 2027, month: 1 }。
 * @param {string} code
 * @returns {{prefix: string, year: number, month: number}|null}
 */
export function contractMonth(code) {
  const m = /^([A-Za-z]+)(\d{2})(\d{2})$/u.exec(String(code))
  if (m === null) return null
  return { prefix: m[1].toUpperCase(), year: 2000 + Number(m[2]), month: Number(m[3]) }
}

/**
 * 某品种的跨期结构快照。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {string} code 品种代码（M0 / M）
 * @param {{top?: number, now?: Date}} [options]
 * @returns {Record<string, any>|null} 品种不存在时返回 null
 */
export function termStructure(store, code, options = {}) {
  const variety = varietyOf(code)
  if (variety === undefined) return null
  const top = Math.max(2, Math.min(6, options.top ?? DEFAULT_TOP))
  const now = options.now ?? new Date()
  const base = variety.code.replace(/0$/u, '')
  const pattern = new RegExp(`^${base}\\d{4}$`, 'u')

  /** 同一次请求内重复读取同一合约时走缓存：配对时每条腿会被读多次。 */
  const barCache = new Map()
  const barsFor = (contractCode) => {
    if (!barCache.has(contractCode)) barCache.set(contractCode, barsOf(store.readDaily(contractCode)))
    return barCache.get(contractCode)
  }

  /* 1. 收集候选合约的最后一根日线 */
  const known = new Set(store.listDailyCodes())
  // 先只看最近 8 个合约（跨期页最多用 6 个），避免每次请求把 27×7 个历史文件全读一遍；
  // 不足 2 个时再退回全量扫描（老数据/新品种的兜底）。
  let candidateCodes = []
  for (const c of contractCodes(variety, now, 8)) if (known.has(c)) candidateCodes.push(c)
  if (candidateCodes.length < 2) candidateCodes = [...known].filter((c) => pattern.test(c))

  const candidates = []
  for (const contractCode of candidateCodes) {
    const month = contractMonth(contractCode)
    if (month === null) continue
    const bars = barsFor(contractCode)
    if (bars.length === 0) continue
    const last = bars[bars.length - 1]
    candidates.push({
      code: contractCode,
      year: month.year,
      month: month.month,
      date: last.d,
      close: last.c,
      volume: Number.isFinite(last.v) ? last.v : null,
      openInterest: Number.isFinite(last.p) ? last.p : null,
    })
  }
  if (candidates.length === 0) {
    return { code: variety.code, name: variety.name, exchange: variety.exchange, board: variety.board ?? 'oil', kind: variety.kind ?? null, asOf: null, selection: null, contracts: [], pairs: [], error: '本地没有该品种的合约日线' }
  }

  /* 2. 选一个"至少两个合约都有数据"的交易日：
   * 源站对临近交割的合约会提前停更（实测 M2611 停在 11-06），
   * 如果硬用全局最新日，那个合约会被整条剔除，甚至只剩 1 个合约没法配对；
   * 如果混用不同日期，价差又会跨日不一致。所以取"最近一个能有 ≥2 个合约的日子"。 */
  const byDate = new Map()
  for (const c of candidates) {
    if (!byDate.has(c.date)) byDate.set(c.date, [])
    byDate.get(c.date).push(c)
  }
  const datesDesc = [...byDate.keys()].sort().reverse()
  let asOf = datesDesc[0]
  let alive = byDate.get(asOf) ?? []
  /** 往回找最多 3 个自然日（覆盖周末/停更一两天的情况） */
  for (let i = 0; i < Math.min(3, datesDesc.length) && alive.length < 2; i += 1) {
    asOf = datesDesc[i]
    alive = byDate.get(asOf) ?? []
  }
  // 没有持仓量字段时退回按成交量排序，再退回按合约月份
  const score = (c) => (c.openInterest ?? 0) || (c.volume ?? 0)
  const picked = [...alive].sort((a, b) => score(b) - score(a)).slice(0, top)
  picked.sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month))

  /* 3. 任意两个合约两两配对（不限于相邻：用户常看 2701-2705、2705-2709 这类跨月价差） */
  const pairs = []
  for (let i = 0; i < picked.length - 1; i += 1) {
    for (let j = i + 1; j < picked.length; j += 1) {
      const near = picked[i]
      const far = picked[j]
      if (far.year * 12 + far.month <= near.year * 12 + near.month) continue
      const monthGap = far.year * 12 + far.month - (near.year * 12 + near.month)
      const days = Math.round(monthGap * 30.44)
      // 价差 = 近月 − 远月（交易所组合指令口径）
      const spread = near.close - far.close
      const rate = near.close > 0 ? (spread / near.close) * 100 : null
      const annualized = rate === null || days <= 0 ? null : (rate * 365) / days

      // 同一对合约的重叠历史：只在同 pair 内算分位
      const nearBars = barsFor(near.code)
      const farByDate = new Map(barsFor(far.code).map((b) => [b.d, b.c]))
      const rates = []
      for (const b of nearBars) {
        const farClose = farByDate.get(b.d)
        if (!Number.isFinite(farClose) || !(b.c > 0)) continue
        rates.push(((b.c - farClose) / b.c) * 100)
      }
      let percentile = null
      if (rates.length >= MIN_SAMPLE && rate !== null) {
        const sorted = [...rates].sort((a, b) => a - b)
        percentile = {
          value: Number(percentileOf(sorted, rate)?.toFixed(1) ?? NaN),
          sample: rates.length,
          min: Number(sorted[0].toFixed(2)),
          max: Number(sorted[sorted.length - 1].toFixed(2)),
          median: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
          from: nearBars.find((b) => farByDate.has(b.d))?.d ?? null,
        }
      }
      const volume = Math.min(near.volume ?? Infinity, far.volume ?? Infinity)
      pairs.push({
        near: near.code,
        far: far.code,
        monthGap,
        days,
        nearClose: near.close,
        farClose: far.close,
        spread: Number(spread.toFixed(1)),
        spreadRate: rate === null ? null : Number(rate.toFixed(2)),
        annualized: annualized === null ? null : Number(annualized.toFixed(1)),
        percentile,
        volume: { near: near.volume, far: far.volume },
        openInterest: { near: near.openInterest, far: far.openInterest },
        liquidity: Number.isFinite(volume) && volume < THIN_VOLUME ? 'thin' : 'ok',
      })
    }
  }

  return {
    code: variety.code,
    name: variety.name,
    exchange: variety.exchange,
    board: variety.board ?? 'oil',
    kind: variety.kind ?? null,
    asOf,
    selection: { by: 'openInterest', top, candidates: candidates.length, alive: alive.length, fallbackDays: datesDesc.indexOf(asOf) },
    contracts: picked.map((c) => ({
      code: c.code,
      month: `${String(c.year).slice(2)}/${String(c.month).padStart(2, '0')}`,
      close: c.close,
      volume: c.volume,
      openInterest: c.openInterest,
      date: c.date,
      /** 与该日不同日期的合约不参与配对，这里只用于提示"源站停更" */
      stale: c.date !== asOf,
    })),
    pairs,
    /** 界面提示：价差/年化的口径与限制 */
    notes: [
      '合约按当日持仓量取前几名，再按交割月排列，任意两个月配对（不限相邻）',
      '价差 = 近月 − 远月（元/吨，交易所组合指令口径）；正 = 近强远弱，负 = 近弱远强',
      '年化 = 价差率 × 365 ÷ 交割月间隔，不含仓储、资金与交割成本，不是无风险收益',
      '分位只在同一合约对内部计算，不同合约对之间不可比',
    ],
  }
}

/**
 * 多个品种的跨期结构（界面一次拉全，避免逐品种请求）。
 *
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {Array<{code: string}>} varieties
 * @param {{top?: number}} [options]
 * @returns {Array<Record<string, any>>}
 */
export function termStructures(store, varieties, options = {}) {
  const out = []
  for (const v of varieties) {
    const term = termStructure(store, v.code, options)
    if (term !== null && term.pairs.length > 0) out.push(term)
  }
  return out
}
