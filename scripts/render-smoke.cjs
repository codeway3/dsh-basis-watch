#!/usr/bin/env node
/**
 * 客户端渲染冒烟：用 react-dom/server 把面板渲染一遍，验证组件不崩、关键文案出现。
 *
 * 需要在有 react / react-dom 的目录下运行（DSH 插件包本身不带依赖）：
 *   FR_REACT_DIR=/path/to/node_modules node scripts/render-smoke.cjs
 *
 * 原理：模拟浏览器的 window.__ModuleLoader__，加载 client.js 拿到插件对象，
 * 再渲染其中的 Page 组件。数据请求用假 fetch 返回固定样本。
 */

const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const reactDir = process.env.FR_REACT_DIR
if (reactDir === undefined || !fs.existsSync(reactDir)) {
  console.log('跳过：未设置 FR_REACT_DIR（需要 react/react-dom 所在目录）')
  process.exit(0)
}
const req = createRequire(path.join(reactDir, 'index.js'))
const React = req('react')
const ReactDOMServer = req('react-dom/server')

/* ── 假浏览器环境 ── */
let factory = null
global.window = {
  __ModuleLoader__: {
    load: ({ id, factory: f }) => {
      factory = f
    },
  },
}
global.document = {
  head: { appendChild: () => {} },
  createElement: () => ({ dataset: {}, textContent: '' }),
  querySelector: () => null,
}
global.localStorage = {
  getItem: () => null,
  setItem: () => {},
}
global.setInterval = () => 0
global.clearInterval = () => {}

/* ── 样本数据 ── */
const closes = Array.from({ length: 60 }, (_, i) => 3000 + Math.sin(i / 5) * 40)
const basisRates = Array.from({ length: 60 }, (_, i) => Math.cos(i / 6) * 4)
const overview = {
  ok: true,
  quoteAt: '2026-11-06T15:00:00+08:00',
  rows: [
    {
      code: 'M0', name: '豆粕', exchange: 'DCE', status: 'active', price: 3080, changePct: -0.68,
      basis: { date: '2026-11-06', spot: 3180, future: 2985, basis: 195, basisRate: 6.13 },
      basisPercentile: 82.2, stock: { date: '2026-11-06', warrant: 52633, delta: -116, days: 67 },
      spark: closes.slice(-30),
      priceSeries: closes.map((c, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, close: c })),
      basisSeries: basisRates.map((b, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, basisRate: b, contract: '2611' })),
    },
    {
      code: 'SO0', name: '葵油', exchange: 'CZCE', status: 'upcoming', listDate: '2026-11-12',
      price: null, changePct: null, basis: null, basisPercentile: null, stock: null,
      spark: [], priceSeries: [], basisSeries: [],
    },
  ],
}
const detail = {
  ok: true,
  variety: { code: 'M0', name: '豆粕', exchange: 'DCE', effectiveStatus: 'active' },
  quote: { hold: 1890657 },
  foreign: [{ code: 'S', name: '美国大豆', last: 1194.6, prevClose: 1188.25 }],
  price: {
    last: 3080, date: '2026-11-06',
    spark: closes, dates: closes.map((_, i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}`),
    stats: {
      sample: 180, from: '2026-01-01', to: '2026-11-06', last: 3080, changePct: -0.68,
      high: 3400, low: 2800, maxDrawdown: -12.5, vol20: 18.2, vol60: 21.4,
      windows: { '1y': { percentile: 62, sample: 240 }, '3y': { percentile: 48, sample: 700 }, '5y': { percentile: 55, sample: 1200 }, '10y': { percentile: 71, sample: 2400 } },
    },
    percentile: {},
  },
  season: { days: Array.from({ length: 300 }, (_, i) => ({ day: i + 1, p10: -8, p25: -4, p50: 0, p75: 4, p90: 8, sample: 10 })), current: [{ day: 1, value: 0 }, { day: 300, value: 3 }], years: 10 },
  seasonWin: [],
  basis: { sample: 485, from: '2024-11-05', to: '2026-11-06', current: 6.13, basis: 195, p1y: { percentile: 70, sample: 240 }, p3y: { percentile: 82.2, sample: 485, min: -3.69, max: 20.57, median: 3.45 }, p5y: { percentile: 75, sample: 485 } },
  basisSeries: basisRates.map((v, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, basisRate: v })),
  stock: { sample: 67, from: '2026-07-29', to: '2026-11-06', last: { date: '2026-11-06', warrant: 52633, delta: -116 }, series: Array.from({ length: 40 }, (_, i) => ({ date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`, warrant: 50000 + i * 10 })) },
  contracts: [{ code: 'M2701', month: '27/01', close: 3079, date: '2026-11-06', hold: 100000, bars: 600 }],
  spreads: [{ id: 'ym', label: '油粕比', type: 'ratio', available: true, current: 2.82, percentile3y: 65, z3y: 0.42, min3y: 2.4, max3y: 3.4, spark: [2.7, 2.8, 2.9] }],
  news: [{ id: 'n1', time: '2026-11-06T16:52:00+08:00', title: '11月6日进口大豆港口分销价持平', url: 'https://example.com', tags: ['大豆'] }],
  gaps: [],
}

global.fetch = async (url) => {
  const u = String(url)
  let body = { ok: true, rows: [], spreads: [], catalog: [], coverage: {} }
  if (u.includes('op=overview')) body = overview
  else if (u.includes('op=detail')) body = detail
  else if (u.includes('op=spreads')) body = { ok: true, spreads: detail.spreads }
  else if (u.includes('op=news')) body = { ok: true, rows: detail.news }
  else if (u.includes('op=status')) body = { ok: true, catalog: [], coverage: { root: '/data/basis-watch', daily: {}, stock: {}, basis: { rows: 1 }, gapCount: 0 } }
  return { json: async () => body }
}

/* ── 加载并渲染 ── */
const clientPath = path.join(__dirname, '..', 'client.js')
delete require.cache[clientPath]
require(clientPath)
if (factory === null) {
  console.log('  ✗ 客户端未通过 __ModuleLoader__ 注册')
  process.exit(1)
}
const plugin = factory(req)
console.log(`  ✓ 客户端注册成功: ${plugin.name}（inject=${JSON.stringify(plugin.inject)}）`)

// 拿到 Page 组件：通过 apply 时的 slots 捕获注册的组件
const registered = []
const fakeSlots = {
  inject: (name, fn) => {
    fn()
    return () => {}
  },
  register: (spec, component) => {
    registered.push({ spec, component })
    return () => {}
  },
}
const fakeShortcuts = { register: () => () => {} }
const fakeLayout = { selectPanel: () => {}, panelInfo: { getSnapshot: () => ({ activePanelId: null }) } }
plugin.apply({
  slots: fakeSlots,
  effect: () => {},
  get: (key) => (key === 'shortcuts' ? fakeShortcuts : key === 'layout' ? fakeLayout : undefined),
})
const page = registered.find((r) => r.spec.name === 'main')
if (page === undefined) {
  console.log('  ✗ 没有注册 main 面板')
  process.exit(1)
}

const CONFIGS = [
  { label: '总览', component: plugin.__components.Overview, props: { onOpen: () => {}, preview: { ...overview, spreadsPreview: { ok: true, spreads: detail.spreads } } } },
  { label: '品种详情', component: plugin.__components.Detail, props: { code: 'M0', onBack: () => {}, preview: detail } },
  { label: '套利', component: plugin.__components.Spreads, props: { preview: { ok: true, spreads: detail.spreads } } },
  { label: '库存', component: plugin.__components.StockTab, props: { onOpen: () => {}, preview: overview } },
  { label: '资讯', component: plugin.__components.NewsList, props: { limit: 20, preview: { ok: true, rows: detail.news } } },
  {
    label: '折线图',
    component: plugin.__components.LineChart,
    props: {
      width: 640,
      height: 220,
      labels: closes.map((_, i) => `2026-0${(i % 9) + 1}-01`),
      series: [
        { name: '收盘', values: closes, color: '#888', area: true },
        { name: '基差率', values: basisRates, color: '#b07c3f', axis: 'right', dash: true },
      ],
    },
  },
  {
    label: 'K线图',
    component: plugin.__components.CandleChart,
    props: {
      width: 640,
      height: 260,
      bars: closes.map((c, i) => ({ d: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, o: c - 5, h: c + 12, l: c - 14, c })),
    },
  },
  {
    label: '术语答疑',
    component: plugin.__components.GlossaryModal,
    props: { onClose: () => {} },
  },
  {
    label: '分位条',
    component: plugin.__components.PercentileBar,
    props: { value: 82 },
  },
  {
    label: '季节图（p10-p90）',
    component: plugin.__components.SeasonChart,
    props: {
      width: 640,
      height: 220,
      season: {
        bands: 'p10-p90',
        years: 10,
        days: Array.from({ length: 300 }, (_, i) => ({ day: i + 1, p10: -8, p25: -4, p50: 0, p75: 4, p90: 8, sample: 10 })),
        current: [{ day: 1, value: 0 }, { day: 300, value: 3 }],
      },
    },
  },
  {
    label: '季节图（降级 p25-p75）',
    component: plugin.__components.SeasonChart,
    props: {
      width: 640,
      height: 220,
      season: {
        bands: 'p25-p75',
        years: 5,
        // 降级时 calc 层只保证 p25/p50/p75；p10/p90 故意不给，复现真实数据形态
        days: Array.from({ length: 300 }, (_, i) => ({ day: i + 1, p25: -4, p50: 0.5, p75: 4, sample: 5 })),
        current: [{ day: 1, value: 0 }, { day: 300, value: 3 }],
      },
    },
  },
]
let pass = 0
let fail = 0
// 季节图专项断言：降级路径曾因读取 undefined 的 p10/p90 让整块图变成 NaN
const seasonChecks = (label, html) => {
  if (!label.startsWith('季节图')) return null
  if (html.includes('NaN')) return '含 NaN'
  const lines = (html.match(/<line/g) ?? []).length
  if (lines < 3) return `网格线只有 ${lines} 条`
  // p10-p90 模式应是「外层浅带 + 内层深带」两层；降级模式只有一层。
  // 曾因内层误用 loKey/hiKey 导致两层 points 完全相同、深色带消失，这里钉住。
  const points = [...html.matchAll(/<polygon points="([^"]*)"/g)].map((m) => m[1])
  if (label.includes('p10-p90')) {
    if (points.length !== 2) return `分位带应有 2 层，实际 ${points.length} 层`
    if (points[0] === points[1]) return '两层分位带完全重合（内层深色带丢失）'
  } else if (points.length !== 1) {
    return `降级模式应只有 1 层分位带，实际 ${points.length} 层`
  }
  return null
}
const expectByLabel = {
  总览: '板块总览',
  品种详情: '跨期结构',
  套利: '跨品种价差',
  库存: '注册仓单',
  资讯: '进口大豆',
  折线图: '<svg',
  K线图: '<rect',
  术语答疑: '术语说明',
  分位条: '82%',
  '季节图（p10-p90）': '<polygon',
  '季节图（降级 p25-p75）': '<polygon',
}
for (const cfg of CONFIGS) {
  try {
    const html = ReactDOMServer.renderToStaticMarkup(React.createElement(cfg.component, cfg.props))
    const need = expectByLabel[cfg.label]
    const extraError = seasonChecks(cfg.label, html)
    const ok = html.length > 120 && html.includes(need) && extraError === null
    if (ok) {
      pass += 1
      console.log(`  ✓ 渲染 ${cfg.label} 成功（${html.length} 字符，含「${need}」）`)
    } else {
      fail += 1
      const why = extraError ?? `输出不含「${need}」`
      console.log(`  ✗ 渲染 ${cfg.label} ${why}（${html.length} 字符）`)
    }
  } catch (error) {
    fail += 1
    console.log(`  ✗ 渲染 ${cfg.label} 抛错: ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`\n  结果: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
