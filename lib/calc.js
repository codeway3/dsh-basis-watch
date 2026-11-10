/**
 * 计算层：分位、季节性、价差、跨期、波动率。
 *
 * 全部只读本地数据（store），不发起任何网络请求 —— 这是插件的核心约定：
 * 网络只负责增量落盘，分析与展示一律基于本地文件。
 *
 * @module dsh-basis-watch/lib/calc
 */

/* ── 基础统计 ── */

/**
 * 分位数（线性插值）。
 * @param {number[]} sorted 升序数组
 * @param {number} q 0..1
 * @returns {number}
 */
export function quantile(sorted, q) {
  if (sorted.length === 0) return NaN
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q))
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * 某个值在样本中的分位（0..100，越大表示越靠上）。
 *
 * 采用"秩线性归一"口径：(小于的个数 + 并列数的中点) / (n-1)。
 * 好处：最小值=0、最大值=100，并列值（例如基差长期为 0）落在并列区间的中点，
 * 不会因为大量重复值被挤到 0% 或 100%。
 *
 * @param {number[]} values
 * @param {number} v
 * @returns {number} 0..100；样本为空返回 NaN
 */
export function percentileOf(values, v) {
  if (values.length === 0 || !Number.isFinite(v)) return NaN
  if (values.length === 1) return 50
  let below = 0
  let equal = 0
  for (const x of values) {
    if (x < v) below += 1
    else if (x === v) equal += 1
  }
  // 契约是 0..100；样本外的输入（比最大还大 / 比最小还小）必须夹住，
  // 否则会返回 -25 / 125 这种不可能的百分位。
  const raw = ((below + (equal - 1) / 2) / (values.length - 1)) * 100
  return Math.min(100, Math.max(0, raw))
}

/**
 * 中位数。
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  return quantile(sorted, 0.5)
}

/**
 * 均值。
 * @param {number[]} values
 * @returns {number}
 */
export function mean(values) {
  if (values.length === 0) return NaN
  return values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * 样本标准差。
 * @param {number[]} values
 * @returns {number}
 */
export function stdev(values) {
  if (values.length < 2) return NaN
  const m = mean(values)
  const v = values.reduce((acc, x) => acc + (x - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(v)
}

/**
 * z 分数（相对样本本身）。
 * @param {number[]} values
 * @param {number} v
 * @returns {number}
 */
export function zScore(values, v) {
  const sd = stdev(values)
  if (!Number.isFinite(sd) || sd === 0) return 0
  return (v - mean(values)) / sd
}

/* ── 价格序列 ── */

/**
 * 从日线里取收盘价序列（按日期升序）。
 * @param {Array<{d: string, c: number}>} bars
 * @returns {Array<{date: string, close: number}>}
 */
export function closesOf(bars) {
  return (bars ?? [])
    .filter((b) => Number.isFinite(b.c) && b.c > 0 && typeof b.d === 'string')
    .map((b) => ({ date: b.d, close: b.c }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 多窗口分位：1 年 / 3 年 / 5 年 / 10 年。
 * @param {Array<{d: string, c: number}>} bars
 * @param {number} [value] 待评估的值（默认取最后一个收盘）
 * @returns {Record<string, {percentile: number, sample: number, min: number, max: number}>}
 */
export function percentileWindows(bars, value) {
  const all = closesOf(bars)
  if (all.length === 0) return {}
  const v = Number.isFinite(value) ? value : all[all.length - 1].close
  const anchor = all[all.length - 1].date
  const anchorTs = new Date(`${anchor}T00:00:00+08:00`).getTime()
  const out = {}
  for (const years of [1, 3, 5, 10]) {
    const from = anchorTs - years * 365 * 24 * 3600 * 1000
    const sample = all.filter((p) => new Date(`${p.date}T00:00:00+08:00`).getTime() >= from).map((p) => p.close)
    const sorted = [...sample].sort((a, b) => a - b)
    // 一个交易年约 244 个点；样本明显不足说明数据覆盖不到这个窗口，
    // 此时 percentile 其实是"更短窗口"的结果，必须显式标记，不能冒充 10 年。
    const expected = Math.round(years * 244 * 0.75)
    out[`${years}y`] = {
      percentile: Number(percentileOf(sample, v).toFixed(1)),
      sample: sample.length,
      short: sample.length < expected,
      min: sorted[0] ?? NaN,
      max: sorted[sorted.length - 1] ?? NaN,
    }
  }
  return out
}

/**
 * 最大回撤（用收盘价）。
 * @param {number[]} closes
 * @returns {number} 负数百分比，如 -18.5
 */
export function maxDrawdown(closes) {
  let peak = -Infinity
  let worst = 0
  for (const c of closes) {
    if (c > peak) peak = c
    if (peak > 0) {
      const dd = ((c - peak) / peak) * 100
      if (dd < worst) worst = dd
    }
  }
  return worst
}

/**
 * 年化波动率（对数收益标准差 × √252）。
 * @param {number[]} closes
 * @param {number} window 用最近多少个交易日
 * @returns {number} 百分比
 */
export function volatility(closes, window = 20) {
  const use = closes.slice(-Math.min(window + 1, closes.length))
  if (use.length < 3) return NaN
  const rets = []
  for (let i = 1; i < use.length; i += 1) {
    if (use[i - 1] > 0 && use[i] > 0) rets.push(Math.log(use[i] / use[i - 1]))
  }
  const sd = stdev(rets)
  return Number.isFinite(sd) ? sd * Math.sqrt(252) * 100 : NaN
}

/**
 * 基础统计摘要。
 * @param {Array<{d: string, c: number}>} bars
 * @returns {Record<string, any>}
 */
export function statsOf(bars) {
  const closes = closesOf(bars)
  if (closes.length === 0) return { sample: 0 }
  const values = closes.map((p) => p.close)
  const last = values[values.length - 1]
  const first = values[0]
  const prev = values.length > 1 ? values[values.length - 2] : first
  return {
    sample: values.length,
    from: closes[0].date,
    to: closes[closes.length - 1].date,
    last,
    changePct: prev > 0 ? ((last - prev) / prev) * 100 : 0,
    high: Math.max(...values),
    low: Math.min(...values),
    maxDrawdown: maxDrawdown(values),
    vol20: volatility(values, 20),
    vol60: volatility(values, 60),
    windows: percentileWindows(bars, last),
  }
}

/* ── 季节性 ── */

/**
 * 季节性曲线：把每年的价格按"当年首个收盘"归一化，再按日序（1..366）汇总多年分位。
 *
 * 用途：看"这个品种在一年中的哪个时段通常偏强/偏弱"。
 * 归一化的原因：绝对价格逐年抬升，直接平均会把趋势混进来。
 *
 * @param {Array<{d: string, c: number}>} bars
 * @param {number} [years] 取最近多少年（默认 10）
 * @returns {{days: Array<{day: number, p10: number, p25: number, p50: number, p75: number, p90: number, sample: number}>, years: number}}
 */
export function seasonCurve(bars, years = 10) {
  const all = closesOf(bars)
  if (all.length === 0) return { days: [], years: 0, bands: 'p10-p90', current: [], currentYear: null }
  const anchorDate = all[all.length - 1].date
  const fromTs = new Date(`${anchorDate}T00:00:00+08:00`).getTime() - years * 365 * 24 * 3600 * 1000
  const use = all.filter((p) => new Date(`${p.date}T00:00:00+08:00`).getTime() >= fromTs)

  // 按年分组，并把价格转成"相对当年首个收盘"的百分比
  const byYear = new Map()
  for (const p of use) {
    const year = p.date.slice(0, 4)
    if (!byYear.has(year)) byYear.set(year, [])
    byYear.get(year).push(p)
  }
  /** @type {Map<number, number[]>} day-of-year → 各年归一化值 */
  const byDay = new Map()
  let yearCount = 0
  for (const list of byYear.values()) {
    if (list.length < 20) continue // 数据太少的年份不计入
    const base = list[0].close
    if (!(base > 0)) continue
    // 只有真正参与统计的年份才计数，否则 bands 阈值会被坏年份抬高
    yearCount += 1
    for (const p of list) {
      const ts = new Date(`${p.date}T00:00:00+08:00`).getTime()
      const startOfYear = new Date(`${p.date.slice(0, 4)}-01-01T00:00:00+08:00`).getTime()
      const day = Math.min(366, Math.floor((ts - startOfYear) / (24 * 3600 * 1000)) + 1)
      const norm = ((p.close - base) / base) * 100
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push(norm)
    }
  }
  // 年点太少时 p10/p90 几乎等于 min/max（5 个点算 10% 分位没有统计意义），
  // 这时把带子降级到 p25/p75 并显式告诉前端，避免画出一条假装精确的分位带。
  const bands = yearCount >= 8 ? 'p10-p90' : 'p25-p75'
  const days = []
  for (const [day, values] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...values].sort((a, b) => a - b)
    const p25 = Number(quantile(sorted, 0.25).toFixed(2))
    const p75 = Number(quantile(sorted, 0.75).toFixed(2))
    days.push({
      day,
      p10: bands === 'p10-p90' ? Number(quantile(sorted, 0.1).toFixed(2)) : p25,
      p25,
      p50: Number(quantile(sorted, 0.5).toFixed(2)),
      p75,
      p90: bands === 'p10-p90' ? Number(quantile(sorted, 0.9).toFixed(2)) : p75,
      sample: values.length,
    })
  }

  // 当年曲线（同为"相对当年首个收盘"的口径，便于和分位带直接比较）
  const yearKeys = [...byYear.keys()].sort()
  const currentYear = yearKeys[yearKeys.length - 1]
  const currentList = byYear.get(currentYear) ?? []
  const current = currentList.length === 0
    ? []
    : (() => {
        const base = currentList[0].close
        return currentList.map((p) => ({
          day: Math.min(366, Math.floor((new Date(`${p.date}T00:00:00+08:00`).getTime() - new Date(`${p.date.slice(0, 4)}-01-01T00:00:00+08:00`).getTime()) / (24 * 3600 * 1000)) + 1),
          value: Number((((p.close - base) / base) * 100).toFixed(2)),
        }))
      })()
  return { days, years: yearCount, bands, current, currentYear }
}

/* ── 基差 ── */

/**
 * 取某品种的基差序列（按日期升序）。
 * @param {any[]} basisRows store.readBasis()
 * @param {string} code
 * @returns {Array<{date: string, basis: number, basisRate: number, spot: number, future: number}>}
 */
export function basisSeries(basisRows, code) {
  return (basisRows ?? [])
    .filter((r) => r.code === code && Number.isFinite(r.basisRate))
    .map((r) => ({
      date: String(r.date),
      basis: Number(r.basis),
      basisRate: Number(r.basisRate),
      spot: Number(r.spot),
      future: Number(r.future),
      /** 这条基差对应的期货合约（如 2611）；老数据可能没有 */
      contract: r.contract ?? null,
      /** 数据来源（100ppi / mysteel） */
      source: r.source ?? null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 基差分位（多窗口）。
 * @param {Array<{date: string, basisRate: number}>} series
 * @returns {Record<string, any>}
 */
export function basisStats(series) {
  if (series.length === 0) return { sample: 0 }
  const anchor = series[series.length - 1].date
  const anchorTs = new Date(`${anchor}T00:00:00+08:00`).getTime()
  const last = series[series.length - 1]
  const out = { sample: series.length, from: series[0].date, to: anchor, current: last.basisRate, basis: last.basis, spot: last.spot, future: last.future }
  for (const years of [1, 3, 5]) {
    const fromTs = anchorTs - years * 365 * 24 * 3600 * 1000
    const windowRows = series.filter((r) => new Date(`${r.date}T00:00:00+08:00`).getTime() >= fromTs)
    const sample = windowRows.map((r) => r.basisRate)
    if (sample.length < 20) {
      out[`p${years}y`] = { percentile: NaN, sample: sample.length }
      continue
    }
    const sorted = [...sample].sort((a, b) => a - b)
    // 同时给绝对值口径（元/吨），界面两边都显示，避免只看到百分比
    const absSorted = windowRows
      .map((r) => r.basis)
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b)
    out[`p${years}y`] = {
      percentile: Number(percentileOf(sample, last.basisRate).toFixed(1)),
      sample: sample.length,
      min: Number(sorted[0].toFixed(2)),
      max: Number(sorted[sorted.length - 1].toFixed(2)),
      median: Number(quantile(sorted, 0.5).toFixed(2)),
      abs:
        absSorted.length > 0
          ? {
              min: Math.round(absSorted[0]),
              max: Math.round(absSorted[absSorted.length - 1]),
              median: Math.round(quantile(absSorted, 0.5)),
            }
          : null,
    }
  }  return out
}

/* ── 价差（跨品种） ── */

/**
 * 按日期对齐两条收盘序列，返回共同交易日。
 * @param {Array<{date: string, close: number}>} a
 * @param {Array<{date: string, close: number}>} b
 * @returns {Array<{date: string, a: number, b: number}>}
 */
export function alignSeries(a, b) {
  const mapB = new Map(b.map((p) => [p.date, p.close]))
  const out = []
  for (const p of a) {
    const other = mapB.get(p.date)
    if (other === undefined || !(other > 0)) continue
    out.push({ date: p.date, a: p.close, b: other })
  }
  return out
}

/**
 * 价差组合定义。
 * ratio 型（如油粕比）用 a/b；diff 型（价差）用 a−b。
 */
export const SPREAD_DEFS = [
  { id: 'ym', label: '油粕比', a: 'Y0', b: 'M0', type: 'ratio', note: '豆油 ÷ 豆粕' },
  { id: 'yp', label: '豆棕价差', a: 'Y0', b: 'P0', type: 'diff', note: '豆油 − 棕榈油' },
  { id: 'oiy', label: '菜豆油价差', a: 'OI0', b: 'Y0', type: 'diff', note: '菜油 − 豆油' },
  { id: 'mrm', label: '豆菜粕价差', a: 'M0', b: 'RM0', type: 'diff', note: '豆粕 − 菜粕' },
  { id: 'soy', label: '葵豆油价差', a: 'SO0', b: 'Y0', type: 'diff', note: '葵油 − 豆油（挂牌后可用）', pending: true },
  { id: 'sooi', label: '葵菜油价差', a: 'SO0', b: 'OI0', type: 'diff', note: '葵油 − 菜油（挂牌后可用）', pending: true },
]

/**
 * 计算全部价差组合。
 * @param {Map<string, Array<{d: string, c: number}>>} dailyByCode 各品种日线
 * @returns {Array<Record<string, any>>}
 */
export function computeSpreads(dailyByCode) {
  const closes = new Map()
  for (const [code, bars] of dailyByCode.entries()) closes.set(code, closesOf(bars))
  const out = []
  for (const def of SPREAD_DEFS) {
    const a = closes.get(def.a) ?? []
    const b = closes.get(def.b) ?? []
    const aligned = alignSeries(a, b)
    if (aligned.length < 30) {
      out.push({ ...def, sample: 0, available: false, reason: aligned.length === 0 ? '缺少数据' : '样本不足' })
      continue
    }
    const series = aligned.map((p) => ({
      date: p.date,
      value: def.type === 'ratio' ? p.a / p.b : p.a - p.b,
    }))
    const values = series.map((p) => p.value)
    const last = series[series.length - 1]
    // 1 年与 3 年分位
    const anchorTs = new Date(`${last.date}T00:00:00+08:00`).getTime()
    const within = (years) => {
      const from = anchorTs - years * 365 * 24 * 3600 * 1000
      return series.filter((p) => new Date(`${p.date}T00:00:00+08:00`).getTime() >= from).map((p) => p.value)
    }
    const s3y = within(3)
    // 3 年窗口样本够用才算分位/区间；不够就整体返回 NaN，绝不偷偷退回全历史
    const enough = s3y.length >= 20
    const sorted3y = enough ? [...s3y].sort((x, y) => x - y) : []
    const digits = def.type === 'ratio' ? 4 : 1
    out.push({
      ...def,
      available: true,
      sample: series.length,
      from: series[0].date,
      to: last.date,
      current: Number(last.value.toFixed(digits)),
      unit: def.type === 'ratio' ? '' : '元/吨',
      percentile3y: enough ? Number(percentileOf(s3y, last.value).toFixed(1)) : NaN,
      sample3y: s3y.length,
      z3y: enough ? Number(zScore(s3y, last.value).toFixed(2)) : NaN,
      min3y: enough ? Number(sorted3y[0].toFixed(digits)) : NaN,
      max3y: enough ? Number(sorted3y[sorted3y.length - 1].toFixed(digits)) : NaN,
      median3y: enough ? Number(median(s3y).toFixed(digits)) : NaN,
      /** 最近 120 个点用于画走势 */
      spark: series.slice(-120).map((p) => Number(p.value.toFixed(digits))),
      series: series.slice(-260),
    })
  }
  return out
}

/* ── 季节胜率 ── */

/**
 * 季节胜率：按"当日同比上周同日"统计近 N 年该日上涨的比例。
 * @param {Array<{d: string, c: number}>} bars
 * @param {number} [years]
 * @returns {Array<{day: number, winRate: number, sample: number}>}
 */
export function seasonWinRate(bars, years = 10) {
  const all = closesOf(bars)
  if (all.length === 0) return []
  const anchorTs = new Date(`${all[all.length - 1].date}T00:00:00+08:00`).getTime()
  const fromTs = anchorTs - years * 365 * 24 * 3600 * 1000
  const use = all.filter((p) => new Date(`${p.date}T00:00:00+08:00`).getTime() >= fromTs)
  const byYear = new Map()
  for (const p of use) {
    const year = p.date.slice(0, 4)
    if (!byYear.has(year)) byYear.set(year, new Map())
    byYear.get(year).set(p.date, p.close)
  }
  /** @type {Map<number, {up: number, total: number}>} */
  const agg = new Map()
  for (const [, dayMap] of byYear) {
    const dates = [...dayMap.keys()].sort()
    for (let i = 1; i < dates.length; i += 1) {
      const prev = dayMap.get(dates[i - 1])
      const cur = dayMap.get(dates[i])
      if (!(prev > 0) || !(cur > 0)) continue
      const day = dayOfYear(dates[i])
      const hit = agg.get(day) ?? { up: 0, total: 0 }
      hit.total += 1
      if (cur > prev) hit.up += 1
      agg.set(day, hit)
    }
  }
  return [...agg.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, v]) => ({ day, winRate: Number(((v.up / v.total) * 100).toFixed(1)), sample: v.total }))
}

/**
 * 日序（1..366）。
 * @param {string} date YYYY-MM-DD
 * @returns {number}
 */
export function dayOfYear(date) {
  const ts = new Date(`${date}T00:00:00+08:00`).getTime()
  const start = new Date(`${date.slice(0, 4)}-01-01T00:00:00+08:00`).getTime()
  return Math.min(366, Math.floor((ts - start) / (24 * 3600 * 1000)) + 1)
}
