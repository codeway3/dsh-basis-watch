/**
 * 主连换月复权。
 *
 * 为什么需要：主连（M0）在换月当天会从旧合约跳到新合约的价格，产生一个"假跳空"。
 * 这个跳空会被算进波动率、最大回撤和分位，把统计口径污染掉。
 *
 * 做法（后复权 / 价差拼接）：
 * 1. 用具体合约的收盘价反推主连当天跟的是哪个合约（收盘价最接近且量最大的那个）；
 * 2. 换月日取新旧合约在前一交易日的收盘差 delta；
 * 3. 从最新往前累积 delta，把更早的历史整体平移，使序列在换月处连续。
 *
 * 复权方式：**比例复权（乘法）**。最新一段保持真实价格，历史按换月价差比例缩放。
 * 不用价差拼接的原因：累积几十次换月后价格水平严重偏离，7.6% 的真实涨跌会被放大成 14.7%，
 * 分位和波动率就失真了；比例复权保住收益率不变。
 *
 * @module dsh-basis-watch/lib/continuous
 */

/**
 * 判定"主连当天跟哪个合约"的容差（相对收盘价）。主连收盘价与对应合约完全一致，
 * 但两者抓取时点可能差几秒，留 0.3% 容忍。
 */
const MATCH_TOLERANCE = 0.003

/**
 * 用具体合约列表重建复权连续序列。
 *
 * @param {Array<{d: string, c: number}>} mainBars 主连日线（升序）
 * @param {Array<{code: string, bars: Array<{d: string, c: number, v?: number}>}>} legs 具体合约日线
 * @returns {{bars: Array<{d: string, raw: number, adj: number, leg: string|null}>,
 *   rolls: Array<{date: string, from: string, to: string, gap: number}>,
 *   coverage: {from: string|null, to: string|null, matchedDays: number, totalDays: number}}}
 */
export function buildAdjusted(mainBars, legs) {
  const byMainDate = new Map(mainBars.map((b) => [b.d, b]))

  /** date → [{code, c, v}] */
  const byDate = new Map()
  for (const leg of legs) {
    for (const b of leg.bars ?? []) {
      if (!Number.isFinite(b.c)) continue
      const list = byDate.get(b.d)
      const item = { code: leg.code, c: b.c, v: Number.isFinite(b.v) ? b.v : 0 }
      if (list === undefined) byDate.set(b.d, [item])
      else list.push(item)
    }
  }

  /** 主连每一天最可能对应的合约 */
  const legOfDay = new Map()
  for (const bar of mainBars) {
    if (!Number.isFinite(bar.c)) continue
    const candidates = byDate.get(bar.d) ?? []
    let best = null
    for (const c of candidates) {
      const diff = Math.abs(c.c - bar.c) / Math.max(Math.abs(bar.c), 1)
      if (diff > MATCH_TOLERANCE) continue
      if (best === null || c.v > best.v || (c.v === best.v && c.code > best.code)) best = c
    }
    if (best !== null) legOfDay.set(bar.d, best.code)
  }

  // 只在"真正匹配到合约"的区间内做填充：
  // 区间外（早期没有合约数据的历史）保持 leg=null、不做任何平移，
  // 否则会把二十年前的价格强行归到某个近月合约上，制造出巨大的假换月缺口。
  const filled = mainBars.map((bar) => ({ d: bar.d, c: bar.c, leg: legOfDay.get(bar.d) ?? null }))
  const matchedIdx = []
  filled.forEach((b, i) => {
    if (b.leg !== null) matchedIdx.push(i)
  })
  const firstIdx = matchedIdx.length > 0 ? matchedIdx[0] : -1
  const lastIdx = matchedIdx.length > 0 ? matchedIdx[matchedIdx.length - 1] : -1
  for (let i = 0; i < filled.length; i += 1) {
    if (i < firstIdx || i > lastIdx) filled[i].leg = null
  }
  // 区间内：先用前一个已知合约填住缺口
  let prevLeg = null
  for (let i = firstIdx; i <= lastIdx && i >= 0; i += 1) {
    if (filled[i].leg !== null) prevLeg = filled[i].leg
    else filled[i].leg = prevLeg
  }
  // 区间开头若仍为 null（首个匹配点之前的一小段），用后一个已知合约回填
  let nextLeg = null
  for (let i = lastIdx; i >= firstIdx && i >= 0; i -= 1) {
    if (filled[i].leg !== null) nextLeg = filled[i].leg
    else filled[i].leg = nextLeg
  }

  const closeOf = (code, date) => {
    const list = byDate.get(date) ?? []
    const hit = list.find((x) => x.code === code)
    return hit === undefined ? null : hit.c
  }

  // 从最新往前做**比例复权**：最新一段保持真实价格，历史按换月时的合约价差比例缩放。
  // 为什么不用价差拼接：价差复权保住绝对差，但累积几十次换月后价格水平会严重偏离，
  // 同一笔真实涨跌换算成百分比会被放大（实测 7.6% 变成 14.7%），不能用于分位/波动率。
  const out = new Array(filled.length)
  const rolls = []
  let factor = 1
  for (let i = filled.length - 1; i >= 0; i -= 1) {
    const cur = filled[i]
    const adj = Number((cur.c * factor).toFixed(3))
    const bar = byMainDate.get(cur.d)
    const scale = (v) => (Number.isFinite(v) && Number.isFinite(bar?.c) && bar.c > 0 ? Number((v * (adj / bar.c)).toFixed(3)) : adj)
    out[i] = {
      d: cur.d,
      raw: cur.c,
      adj,
      // 复权后的 OHLC：按当日 adj/raw 比例缩放，K 线与统计口径才能对齐
      o: scale(bar?.o),
      h: scale(bar?.h),
      l: scale(bar?.l),
      v: Number(bar?.v) || 0,
      leg: cur.leg,
    }
    if (i > 0 && cur.leg !== filled[i - 1].leg && cur.leg !== null && filled[i - 1].leg !== null) {
      const oldLeg = filled[i - 1].leg
      const newLeg = cur.leg
      const refDate = filled[i - 1].d
      const oldClose = closeOf(oldLeg, refDate)
      const newClose = closeOf(newLeg, refDate) ?? closeOf(newLeg, cur.d)
      if (Number.isFinite(oldClose) && Number.isFinite(newClose) && oldClose > 0 && newClose > 0) {
        const ratio = newClose / oldClose
        factor *= ratio
        rolls.unshift({
          date: cur.d,
          from: oldLeg,
          to: newLeg,
          ratio: Number(ratio.toFixed(6)),
          gap: Number((newClose - oldClose).toFixed(2)),
        })
      }
    }
  }

  const matchedDays = out.filter((b) => b.leg !== null).length
  return {
    bars: out,
    rolls,
    coverage: {
      from: out.find((b) => b.leg !== null)?.d ?? null,
      to: out.length > 0 ? out[out.length - 1].d : null,
      matchedDays,
      totalDays: out.length,
    },
  }
}

