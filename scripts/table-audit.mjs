#!/usr/bin/env node
/**
 * 表格结构审查：渲染每个页面的组件，逐张表比对"表头列数"与"每行单元格数"。
 *
 * 为什么需要它：曾经出现过表头 6 列、表格内容 8 个单元格的情况
 * （改表头的那次编辑成功、改内容的那次失败），肉眼很难一眼看出，
 * 所以用机器逐表核对，避免回归。
 *
 * 运行：node scripts/table-audit.mjs [--verbose]
 * 需要 FR_REACT_DIR 指向包含 react / react-dom 的 node_modules。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const reactDir = process.env.FR_REACT_DIR
if (reactDir === undefined || !fs.existsSync(reactDir)) {
  console.log('跳过：未设置 FR_REACT_DIR（需要 react/react-dom 所在目录）')
  process.exit(0)
}
const req = createRequire(path.join(reactDir, 'index.js'))
const React = req('react')
const ReactDOMServer = req('react-dom/server')

let factory = null
global.window = { __ModuleLoader__: { load: ({ factory: f }) => (factory = f) } }
global.document = { head: { appendChild: () => {} }, createElement: () => ({ dataset: {}, textContent: '' }) }
global.localStorage = { getItem: () => null, setItem: () => {} }
global.setInterval = () => 0
global.clearInterval = () => {}

await import('../client.js')
const plugin = factory(req)

/** 造一份覆盖各种状态的数据（含待上市品种、无现货源品种）。 */
const overview = {
  ok: true,
  quoteAt: '2026-11-06T15:00:00+08:00',
  rows: [
    {
      code: 'M0', name: '豆粕', exchange: 'DCE', status: 'active', price: 3080, changePct: -0.68,
      basis: { date: '2026-11-06', spot: 3180, future: 2985, basis: 195, basisRate: 6.13 },
      basisPercentile: 82.2, stock: { date: '2026-11-06', warrant: 52633, delta: -116, days: 67 },
      spark: [3000, 3050, 3080], closes: [3000, 3050, 3080], dates: ['2026-11-04', '2026-11-05', '2026-11-06'], basisCloses: [5, 6, 6.13],
    },
    {
      code: 'SO0', name: '葵油', exchange: 'CZCE', status: 'upcoming', listDate: '2026-11-12',
      price: null, changePct: null, basis: null, basisPercentile: null, stock: null,
      spark: [], closes: [], dates: [], basisCloses: [],
    },
  ],
}
const spreads = [
  { id: 'ym', label: '油粕比', note: '豆油 ÷ 豆粕', type: 'ratio', available: true, current: 2.823, percentile3y: 73, z3y: 0.77, min3y: 2.4, max3y: 3.4, spark: [2.7, 2.8, 2.9] },
  { id: 'yp', label: '豆棕价差', note: '豆油 − 棕榈油', type: 'diff', available: true, current: -31, percentile3y: 83, z3y: 0.94, min3y: -900, max3y: 400, spark: [-100, -60, -31] },
  { id: 'soy', label: '葵豆油价差', note: '葵油 − 豆油', type: 'diff', available: false, reason: '缺少数据' },
]
const detail = {
  ok: true,
  variety: { code: 'M0', name: '豆粕', exchange: 'DCE', effectiveStatus: 'active' },
  quote: { hold: 1890657 },
  foreign: [{ code: 'S', name: '美国大豆', last: 1194.6, prevClose: 1188.25 }],
  price: {
    last: 3080, date: '2026-11-06',
    bars: [
      { d: '2026-11-05', o: 3070, h: 3090, l: 3060, c: 3080, v: 1000 },
      { d: '2026-11-06', o: 3080, h: 3100, l: 3070, c: 3085, v: 1100 },
    ],
    spark: [3070, 3080], dates: ['2026-11-05', '2026-11-06'],
    stats: { sample: 180, from: '2026-01-02', to: '2026-11-06', last: 3080, changePct: -0.68, high: 3400, low: 2800, maxDrawdown: -12.5, vol20: 18.2, vol60: 21.4, windows: { '1y': { percentile: 62, sample: 240 }, '3y': { percentile: 48, sample: 700 }, '5y': { percentile: 55, sample: 1200 }, '10y': { percentile: 71, sample: 2400 } } },
  },
  season: { days: Array.from({ length: 40 }, (_, i) => ({ day: i + 1, p10: -8, p25: -4, p50: 0, p75: 4, p90: 8, sample: 10 })), current: [{ day: 1, value: 0 }, { day: 40, value: 2 }], years: 10 },
  basis: { sample: 485, from: '2024-11-05', to: '2026-11-06', current: 6.13, basis: 195, p1y: { percentile: 70, sample: 240 }, p3y: { percentile: 82.2, sample: 485, min: -3.69, max: 20.57, median: 3.45 }, p5y: { percentile: 75, sample: 485 } },
  basisSeries: [{ date: '2026-11-05', basisRate: 6 }, { date: '2026-11-06', basisRate: 6.13 }],
  stock: { sample: 67, from: '2026-07-29', to: '2026-11-06', last: { date: '2026-11-06', warrant: 52633, delta: -116 }, series: [{ date: '2026-11-05', warrant: 52749 }, { date: '2026-11-06', warrant: 52633 }] },
  contracts: [
    { code: 'M2701', month: '27/01', close: 3079, date: '2026-11-06', hold: 100000, bars: 600 },
    { code: 'M2703', month: '27/03', close: 3038, date: '2026-11-06', hold: 80000, bars: 500 },
  ],
  spreads: spreads.filter((s) => s.id === 'ym'),
  news: [{ id: 'n1', time: '2026-11-06T16:52:00+08:00', title: '进口大豆港口分销价持平', url: 'https://example.com', tags: ['大豆'] }],
  gaps: [],
}

const CASES = [
  ['总览', plugin.__components.Overview, { onOpen: () => {}, preview: { ...overview, spreadsPreview: { ok: true, spreads } } }],
  ['品种详情', plugin.__components.Detail, { code: 'M0', onBack: () => {}, preview: detail }],
  ['库存', plugin.__components.StockTab, { onOpen: () => {}, preview: overview }],
  ['套利', plugin.__components.Spreads, { preview: { ok: true, spreads } }],
]

let tablesChecked = 0
let problems = 0
for (const [label, Component, props] of CASES) {
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(Component, props))
  const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? []
  if (tables.length === 0) {
    console.log(`  ${label}: 无表格`)
    continue
  }
  tables.forEach((table, index) => {
    tablesChecked += 1
    const thead = /<thead[\s\S]*?<\/thead>/.exec(table)?.[0] ?? ''
    const headCount = (thead.match(/<th[\s>]/g) ?? []).length
    const tbody = /<tbody[\s\S]*?<\/tbody>/.exec(table)?.[0] ?? ''
    const rows = tbody.match(/<tr[\s\S]*?<\/tr>/g) ?? []
    const counts = rows.map((row) => (row.match(/<td[\s>]/g) ?? []).length)
    const mismatched = counts.filter((c) => c !== headCount)
    if (headCount === 0 || mismatched.length > 0) {
      problems += 1
      console.log(`  ✗ ${label} 表${index + 1}: 表头 ${headCount} 列，行单元格数 ${[...new Set(counts)].join('/') || '无行'}`)
    } else {
      console.log(`  ✓ ${label} 表${index + 1}: 表头 ${headCount} 列，${rows.length} 行全部一致`)
    }
  })
}

console.log(`\n  共检查 ${tablesChecked} 张表，${problems === 0 ? '全部一致' : `${problems} 张不一致`}`)
if (problems > 0) process.exitCode = 1
