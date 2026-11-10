#!/usr/bin/env node
/**
 * P1 数据层自测：解析器 + 存储 + 快照组装 + 时段判断。
 * 全部离线（用固定样本），不访问网络。
 *
 * 运行：npm run selftest
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CATALOG, activeVarieties, contractCodes, resolveCatalog, upcomingVarieties, varietyOf } from '../lib/catalog.js'
import {
  parseChinagrainList,
  parseDailyScript,
  parseSinaQuotes,
  parseSpotTable,
  parseWarrantCodeMap,
  parseWarrantJson,
  isWeekday,
  dateRange,
} from '../lib/sources.js'
import { createStore } from '../lib/store.js'
import { buildOverview } from '../lib/routes.js'
import {
  basisSeries,
  basisStats,
  closesOf,
  computeSpreads,
  maxDrawdown,
  mean,
  percentileOf,
  percentileWindows,
  quantile,
  seasonCurve,
  seasonWinRate,
  statsOf,
  stdev,
  volatility,
} from '../lib/calc.js'
import { isTradingDay, isTradingSession, newsRelevant, varietyOfSpotName } from '../lib/collect.js'

let pass = 0
let fail = 0
const check = (label, cond, detail = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`)
  }
}

/* ── 1. 品种目录 ── */
console.log('\n  品种目录')
check('目录 8 个品种', CATALOG.length === 8, `n=${CATALOG.length}`)
const before = resolveCatalog(new Date('2026-11-11T12:00:00+08:00'))
const after = resolveCatalog(new Date('2026-11-12T12:00:00+08:00'))
check('葵油上市前是 upcoming', before.find((v) => v.code === 'SO0')?.effectiveStatus === 'upcoming')
check('葵油上市日自动变 active', after.find((v) => v.code === 'SO0')?.effectiveStatus === 'active')
check('上市前 active 不含葵油', activeVarieties(new Date('2026-11-11T12:00:00+08:00')).every((v) => v.code !== 'SO0'))
check('上市后 active 含葵油', activeVarieties(new Date('2026-11-12T12:00:00+08:00')).some((v) => v.code === 'SO0'))
check('uncoming 在上市前包含葵油', upcomingVarieties(new Date('2026-11-11T12:00:00+08:00')).some((v) => v.code === 'SO0'))
check('代码查询支持 M 与 M0 两种写法', varietyOf('M')?.code === 'M0' && varietyOf('M0')?.code === 'M0')

const m = CATALOG.find((v) => v.code === 'M0')
const codes = contractCodes(m, new Date('2026-11-07T10:00:00+08:00'), 3)
check('分级合约生成 3 个', codes.length === 3, codes.join(','))
check('分级合约格式正确', codes.every((c) => /^M\d{4}$/.test(c)), codes.join(','))
check('分级合约月份都在挂牌月内', codes.every((c) => m.months.includes(Number(c.slice(-2)))), codes.join(','))
const soCodes = contractCodes(CATALOG.find((v) => v.code === 'SO0'), new Date('2026-11-12T10:00:00+08:00'), 4)
check('葵油只生成 5/7/9/11 月合约', soCodes.every((c) => [5, 7, 9, 11].includes(Number(c.slice(-2)))), soCodes.join(','))
check('葵油合约不早于首个挂牌合约', soCodes[0] === 'SO2705', soCodes.join(','))

/* ── 2. 解析器 ── */
console.log('\n  解析器')
const quoteText =
  'var hq_str_nf_M0="豆粕连续,143026,3085.000,3105.000,3092.000,3078.000,3085.000,3086.000,3080.000,0.000,3101.000,55,256,1890657.000,345251,连,豆粕,2026-11-06,1";\n' +
  'var hq_str_nf_SO0="";\n'
const quotes = parseSinaQuotes(quoteText)
check('行情解析出 1 条（空值跳过）', quotes.length === 1, `n=${quotes.length}`)
check('行情字段正确', quotes[0].code === 'M0' && quotes[0].last === 3080 && quotes[0].prevSettle === 3101)
check('行情持仓与成交量', quotes[0].hold === 1890657 && quotes[0].volume === 345251)
check('行情时间转 ISO', quotes[0].at === '2026-11-06T14:30:26+08:00', quotes[0].at)

const dailyText =
  '/*<script>location.href=\'//sina.com\';</script>*/\nvar t=([{"d":"2026-11-04","o":"3100","h":"3120","l":"3090","c":"3110","v":"100","p":"200"},' +
  '{"d":"2026-11-05","o":"3110","h":"3125","l":"3100","c":"3118","v":"120","p":"210"}]);'
const bars = parseDailyScript(dailyText)
check('日线解析 2 根', bars.length === 2)
check('日线收盘价与持仓', bars[1].c === 3118 && bars[1].p === 210)
check('日线过滤非法日期', parseDailyScript('var t=([{"d":"bad","c":"1"}]);').length === 0)

const spotHtml = `<table>
<tr><td>商品</td><td>现货</td><td>合约</td><td>期货</td><td>基差</td><td>基差率</td></tr>
<tr><td>豆粕</td><td>3180.00&nbsp;</td><td>2611</td><td>2985</td><td>195</td><td>6.13%</td></tr>
<tr><td>棕榈油</td><td>8636.00</td><td>2611</td><td>9265</td><td>-629</td><td>-7.28%</td></tr>
<tr><td>某品种</td><td>--</td><td>1</td><td>2</td><td>3</td><td>4%</td></tr>
</table>`
const spotRows = parseSpotTable(spotHtml)
check('现期表解析 2 行（非法现货被跳过）', spotRows.length === 2, `n=${spotRows.length}`)
check('豆粕基差与基差率', spotRows[0].commodity === '豆粕' && spotRows[0].basis === 195 && spotRows[0].basisRate === 6.13)
check('棕榈油负基差', spotRows[1].basis === -629 && spotRows[1].basisRate === -7.28)

const warrantJson = {
  result: {
    data: [
      { TRADE_DATE: '2026-11-06 00:00:00', ON_WARRANT_NUM: 52633, ADDCHANGE: -116, SECURITY_CODE: 'M' },
      { TRADE_DATE: '2026-11-05 00:00:00', ON_WARRANT_NUM: 52749, ADDCHANGE: -150, SECURITY_CODE: 'M' },
    ],
  },
}
const stocks = parseWarrantJson(warrantJson)
check('仓单解析 2 条', stocks.length === 2)
check('仓单日期与数量', stocks[0].date === '2026-11-06' && stocks[0].warrant === 52633 && stocks[0].delta === -116)
check('仓单空结果不抛错', parseWarrantJson({ result: null }).length === 0)
const codeMap = parseWarrantCodeMap({ result: { data: [{ TRADE_TYPE: '豆粕', TRADE_CODE: 'M' }] } })
check('品种代码表解析', codeMap['豆粕'] === 'M')

const newsHtml = `<ul class="left-side-items" id="list">
<li><a href="http://www.chinagrain.cn/axfwnh/2026/11/07/2226308159.shtml" target="_blank"
  ><h2 style="color: #e41313; font-weight: bold;">2026年11月7日天津豆粕价格行情</h2></a>
  <span>来源：粮信网</span><span class="items-left-space">时间：2026-11-07 14:49:56</span></li>
<li><a href="http://www.chinagrain.cn/axfwnh/2026/11/06/0709651998.shtml" target="_blank"
  ><h2>2026年11月6日大连豆粕期货高开收跌</h2></a>
  <span>来源：粮信网</span><span>时间：2026-11-06 16:10:00</span></li>
<li><a href="http://www.chinagrain.cn/lyxw/2020/05/26/ly3542246626.shtml">豆粕厂家招商一件代发</a></li>
</ul>`
const news = parseChinagrainList(newsHtml, '豆粕')
check('粮油网列表解析 2 条（非文章链接被忽略）', news.length === 2, `n=${news.length}`)
check('粮油网日期从 URL 提取', news[0].date === '2026-11-07', news[0].date)
check('粮油网精确时间从列表提取', news[0].time === '2026-11-07T14:49:56+08:00', news[0].time)
check('粮油网标题去掉内嵌标签', news[0].title === '2026年11月7日天津豆粕价格行情', news[0].title)
check('粮油网标签正确', news[0].tags[0] === '豆粕')
check('板块关键词命中', newsRelevant(news[0].title) === true && newsRelevant('螺纹钢库存') === false)

check('现期表品名映射到品种', varietyOfSpotName('菜籽油OI')?.code === 'OI0' && varietyOfSpotName('豆粕')?.code === 'M0')
check('未知品名映射为 null', varietyOfSpotName('螺纹钢') === null)

/* ── 3. 时段判断 ── */
console.log('\n  时段判断')
const day = (h, mi) => new Date(`2026-11-06T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+08:00`)
check('周五 10:00 是交易日', isTradingDay(day(10, 0)) === true)
check('周六 10:00 不是交易日', isTradingDay(new Date('2026-11-07T10:00:00+08:00')) === false)
check('10:00 在日盘', isTradingSession(day(10, 0)) === true)
check('10:20 在上午休市区间', isTradingSession(day(10, 20)) === false)
check('12:00 午休', isTradingSession(day(12, 0)) === false)
check('22:00 在夜盘', isTradingSession(day(22, 0)) === true)
check('01:00 不在本插件覆盖的夜盘内', isTradingSession(day(1, 0)) === false)
check('周六不算交易日', isWeekday('2026-11-07') === false)
check('日期序列含两端', dateRange('2026-11-05', '2026-11-07').length === 3)

/* ── 4. 存储 ── */
console.log('\n  存储')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'basis-watch-test-'))
const store = createStore({ root: tmpRoot })
store.ensure()
check('目录已创建', fs.existsSync(path.join(tmpRoot, 'daily')) && fs.existsSync(path.join(tmpRoot, 'basis')))

store.writeDaily('M0', bars)
const back = store.readDaily('M0')
check('日线写入后能读回', back?.bars?.length === 2 && back.bars[1].c === 3118)
check('日线写文件无残留 .tmp', fs.readdirSync(path.join(tmpRoot, 'daily')).every((f) => !f.includes('.tmp')))

const r1 = store.appendBasis([
  { date: '2026-11-06', commodity: '豆粕', spot: 3180, future: 2985, basis: 195, basisRate: 6.13, code: 'M0' },
])
const r2 = store.appendBasis([
  { date: '2026-11-06', commodity: '豆粕', spot: 3180, future: 2985, basis: 195, basisRate: 6.13, code: 'M0' },
  { date: '2026-11-05', commodity: '豆粕', spot: 3170, future: 2975, basis: 195, basisRate: 6.15, code: 'M0' },
])
check('基差首次写入 1 条', r1.added === 1)
check('基差重复日期去重', r2.added === 1 && r2.skipped === 1, `added=${r2.added} skipped=${r2.skipped}`)
check('基差读回 2 条', store.readBasis().length === 2)

store.appendStock('M0', [
  { date: '2026-11-06', warrant: 52633, delta: -116 },
  { date: '2026-11-05', warrant: 52749, delta: -150 },
])
const s2 = store.appendStock('M0', [{ date: '2026-11-06', warrant: 52633, delta: -116 }])
check('仓单重复日期去重', s2.added === 0 && s2.skipped === 1)
check('仓单按日期升序', store.readStock('M0')[0].date === '2026-11-05')

store.appendNews([{ id: '1', time: '2026-11-06 20:00:00', title: 'USDA', content: 'x' }])
store.appendNews([{ id: '1', time: '2026-11-06 20:00:00', title: 'USDA', content: 'x' }])
check('新闻按 id 去重', store.readNews().length === 1)

store.writeQuotes([{ code: 'M0', name: '豆粕', last: 3080, prevSettle: 3101, hold: 1890657, at: '2026-11-06T23:00:00+08:00' }])
check('行情快照读写', store.readQuotes()?.rows?.[0]?.last === 3080)

store.recordGap('basis', '2026-10-01', '节假日')
check('缺口记录写入', store.meta().gaps.some((g) => g.key === '2026-10-01'))
store.clearGap('basis', '2026-10-01')
check('缺口可清除', store.meta().gaps.every((g) => g.key !== '2026-10-01'))

/* ── 5. 快照组装 ── */
console.log('\n  快照组装')
const overview = buildOverview(store, new Date('2026-11-12T10:00:00+08:00'))
check('快照含全部品种', overview.rows.length === 8, `n=${overview.rows.length}`)
const mp = overview.rows.find((r) => r.code === 'M0')
check('快照带价格', mp.price === 3080)
check('快照带涨跌幅', Math.abs(mp.changePct - ((3080 - 3101) / 3101) * 100) < 1e-9, mp.changePct?.toFixed(2))
check('快照带基差', mp.basis?.basis === 195)
check('快照带仓单', mp.stock?.warrant === 52633)
const so = overview.rows.find((r) => r.code === 'SO0')
check('葵油上市后出现在快照', so.status === 'active')
check('葵油无现货时基差为 null', so.basis === null)

/* ── 5. 计算层 ── */
console.log('\n  计算层')
check('分位数中位', quantile([1, 2, 3, 4, 5], 0.5) === 3)
check('分位数端点', quantile([1, 2, 3], 0) === 1 && quantile([1, 2, 3], 1) === 3)
check('分位插值', Math.abs(quantile([0, 10], 0.25) - 2.5) < 1e-9)
check('百分位：中间值约 45%', Math.abs(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5.5) - 50) < 6)
check('百分位：最大值为 100%', percentileOf([1, 2, 3], 3) === 100)
check('百分位：样本为空返回 NaN', Number.isNaN(percentileOf([], 1)))
check('均值与标准差', Math.abs(mean([2, 4, 6]) - 4) < 1e-9 && Math.abs(stdev([2, 4, 6]) - 2) < 1e-9)

/** 造一段两年日线：从 3000 起，带正弦波动。 */
const syntheticBars = Array.from({ length: 500 }, (_, i) => {
  const date = new Date(Date.parse('2024-01-01T00:00:00Z') + i * 24 * 3600 * 1000).toISOString().slice(0, 10)
  return { d: date, o: 3000, h: 3050, l: 2950, c: 3000 + Math.sin(i / 30) * 200 + i * 0.5, v: 1000, p: 10000 }
})
const closes = syntheticBars.map((b) => b.c)
check('收盘序列按日期升序', closesOf(syntheticBars)[0].date < closesOf(syntheticBars)[479].date)
check('最大回撤为负', maxDrawdown([100, 120, 90, 110]) < -20)
check('波动率为正数', volatility(closes, 20) > 0)
const pw = percentileWindows(syntheticBars)
check('多窗口分位有 4 档', Object.keys(pw).length === 4, Object.keys(pw).join(','))
check('1 年样本量小于 10 年', pw['1y'].sample < pw['10y'].sample, `${pw['1y'].sample} < ${pw['10y'].sample}`)
const st = statsOf(syntheticBars)
check('统计摘要含样本数与区间', st.sample === 500 && st.from === '2024-01-01')

const season = seasonCurve(syntheticBars, 3)
check('季节曲线有分位带', season.days.length > 100 && Number.isFinite(season.days[0].p50))
check('季节曲线含当年线', Array.isArray(season.current) && season.current.length > 0)
const winRate = seasonWinRate(syntheticBars, 2)
check('季节胜率在 0–100 之间', winRate.every((w) => w.winRate >= 0 && w.winRate <= 100))

const basisRows = [
  { code: 'M0', date: '2026-01-01', basis: 10, basisRate: 1, spot: 3000, future: 2990 },
  { code: 'M0', date: '2026-06-01', basis: 100, basisRate: 5, spot: 3100, future: 3000 },
  { code: 'Y0', date: '2026-06-01', basis: -50, basisRate: -2, spot: 5000, future: 5050 },
]
const mBasis = basisSeries(basisRows, 'M0')
check('基差序列只取指定品种', mBasis.length === 2 && mBasis[1].basisRate === 5)
const bStats = basisStats(mBasis)
check('基差统计给当前值与样本数', bStats.current === 5 && bStats.sample === 2)
check('样本不足时 3 年分位为 NaN', Number.isNaN(bStats.p3y.percentile) && bStats.p3y.sample === 2)

/* 样本充足时，基差统计要同时给"比率"和"绝对值（元/吨）"两种口径 */
const absRows = Array.from({ length: 30 }, (_, i) => ({
  code: 'M0',
  date: `2026-01-${String(i + 1).padStart(2, '0')}`,
  basis: 100 + i * 10,
  basisRate: 3 + i * 0.1,
  spot: 3000 + i * 10,
  future: 2900,
}))
const absStats = basisStats(basisSeries(absRows, 'M0'))
check('基差统计给出绝对值区间', absStats.p1y.abs !== null && absStats.p1y.abs !== undefined, JSON.stringify(absStats.p1y.abs))
check('绝对值区间随样本变化', absStats.p1y.abs.min === 100 && absStats.p1y.abs.max === 390 && absStats.p1y.abs.median === 245)

const dailyMap = new Map([
  ['Y0', syntheticBars],
  ['M0', syntheticBars.map((b) => ({ ...b, c: b.c / 2 }))],
])
const spreads = computeSpreads(dailyMap)
const ym = spreads.find((s) => s.id === 'ym')
check('油粕比可用且约为 2', ym.available === true && Math.abs(ym.current - 2) < 0.01, String(ym.current))
check('油粕比带分位与 z', Number.isFinite(ym.percentile3y) && Number.isFinite(ym.z3y))
const soySpread = spreads.find((s) => s.id === 'soy')
check('葵油价差在缺数据时标记不可用', soySpread.available === false, soySpread.reason)

/* ── 汇总 ── */
console.log(`\n  结果: ${pass} 通过 / ${fail} 失败`)
fs.rmSync(tmpRoot, { recursive: true, force: true })
if (fail > 0) process.exitCode = 1
