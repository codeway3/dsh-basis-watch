#!/usr/bin/env node
/**
 * 正确性自测：时区 / 节假日 / 并发锁 / 失败注入 / 修订更新 / 3 年窗口 / 复权。
 *
 * 关注"数字是否正确"，而不是"有没有数据"：时区偏移、节假日排除、锁回收、
 * 部分失败聚合、复权口径这类问题，只断言长度或非空是抓不到的。
 *
 * 运行：node scripts/selftest-correctness.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createStore } = await import('../lib/store.js')
const { runJob, shouldSkip, jobLockStatus } = await import('../lib/jobs.js')
const { acquireLock } = await import('../lib/lock.js')
const cal = await import('../lib/calendar.js')
const sources = await import('../lib/sources.js')
const { buildDetail, buildOverview, freshness, registerRoutes } = await import('../lib/routes.js')
const { indexBasisSeries } = await import('../lib/routes.js')
const { varietyOf, contractCodes, sortByBoard, resolveCatalog, activeVarieties, BOARDS } = await import('../lib/catalog.js')
const maybeVariety = (code) => {
  try {
    return varietyOf(code) ?? null
  } catch {
    return null
  }
}
const { percentileOf, seasonCurve } = await import('../lib/calc.js')
const { basisCoveredDates, basisDatesToFetch, pruneHolidayGaps } = await import('../lib/collect.js')
const { startBasisBatch } = await import('../lib/routes.js')
const { termStructure, contractMonth } = await import('../lib/term.js')
const { updateAfterClose, updateIntraday, runPart, mergeOutcome, dropInProgressBar } = await import('../lib/collect.js')
const { buildAdjusted } = await import('../lib/continuous.js')
const { computeSpreads } = await import('../lib/calc.js')

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`    ✓ ${label}${detail === '' ? '' : '  ' + detail}`)
  } else {
    fail += 1
    console.log(`    ✗ ${label}${detail === '' ? '' : '  ' + detail}`)
  }
}
const group = (name) => console.log(`\n  ${name}`)

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bw-correct-'))

/* ───────────── 1. 时区 ───────────── */
group('时区（固定 Asia/Shanghai）')
{
  // 北京时间 2026-11-09 00:30 对应 UTC 2026-11-08 16:30，必须算成 11-09 而不是 11-08
  const d = new Date('2026-11-08T16:30:00Z')
  check('UTC 16:30 → 上海 11-09', cal.localDate(d) === '2026-11-09', cal.localDate(d))
  check('纯字符串加减跨月', cal.addDays('2026-11-30', 1) === '2026-12-01')
  check('纯字符串加减跨年', cal.addDays('2027-01-01', -1) === '2026-12-31')
  check('跨闰年 2 月', cal.addDays('2024-02-28', 1) === '2024-02-29' && cal.addDays('2024-02-29', 1) === '2024-03-01')
}

/* ───────────── 2. 节假日 ───────────── */
group('交易日历（含法定节假日）')
{
  check('2026-11-09（周一）交易', cal.isTradingDay('2026-11-09') === true)
  check('2026-11-07（周六）休市', cal.isTradingDay('2026-11-07') === false)
  check('2026-10-01 国庆休市', cal.isTradingDay('2026-10-01') === false)
  check('2026-10-07 国庆最后一天休市', cal.isTradingDay('2026-10-07') === false)
  check('2026-02-17 春节休市', cal.isTradingDay('2026-02-17') === false)
  check('2026-04-06 清明休市', cal.isTradingDay('2026-04-06') === false)
  check('2026-05-01 劳动节休市', cal.isTradingDay('2026-05-01') === false)
  const info = cal.calendarInfo('2026-10-01')
  check('给出休市原因', info.reason === 'holiday' && info.holiday === '国庆', JSON.stringify(info))
  check('已覆盖年份标记 covered', info.covered === true)
  check('超范围年份 covered=false', cal.calendarInfo('2030-06-03').covered === false)
  const prev = cal.prevTradingDay('2026-11-09')
  check('上一交易日跳过周末', prev === '2026-11-06', prev)
  const after = cal.nextTradingDay('2026-10-01')
  check('下一交易日跳过国庆', after === '2026-10-08', after)
}

/* ───────────── 3. 并发锁 ───────────── */
group('跨进程任务锁')
{
  const root = tmpRoot()
  const a = acquireLock(root, 'job')
  const b = acquireLock(root, 'job')
  check('第二个获取被拒绝', a !== null && b === null, JSON.stringify(jobLockStatus(root)))
  a.release()
  const c = acquireLock(root, 'job')
  check('释放后可以重新获取', c !== null)
  c.release()

  const store = createStore({ root })
  store.ensure()
  const slow = () => new Promise((resolve) => setTimeout(() => resolve('done'), 80))
  const [r1, r2] = await Promise.all([runJob(store, 'job-a', slow), runJob(store, 'job-b', slow)])
  const started = [r1, r2].filter((r) => r.started)
  check('两个并发任务只有一个真正执行', started.length === 1, `started=${started.length}`)
  check('另一个给出原因', [r1, r2].some((r) => r.started === false && typeof r.reason === 'string'))
  fs.rmSync(root, { recursive: true, force: true })
}

/* ───────────── 4. 失败注入 ───────────── */
group('失败注入与状态机')
{
  const root = tmpRoot()
  const store = createStore({ root })
  store.ensure()
  const out = await runJob(store, 'demo', async () => {
    throw new Error('模拟数据源失败')
  })
  check('失败被捕获', out.ok === false && out.started === true)
  const st = store.dataset('demo')
  check('状态写为 error', st.status === 'error', st.status)
  check('记录错误信息', String(st.lastError?.message).includes('模拟数据源失败'))
  check('写入 retryAt', typeof st.retryAt === 'string' && Date.parse(st.retryAt) > Date.now())
  check('shouldSkip 返回 retry-wait', shouldSkip(store, 'demo') === 'retry-wait')

  // 崩溃恢复：状态卡在 running 且开始时间很久以前
  store.updateDataset('stuck', { status: 'running', startedAt: new Date(Date.now() - 3600 * 1000).toISOString() })
  store.recoverDatasets(['stuck'])
  const recovered = store.dataset('stuck')
  check('卡住的任务被标记中断', recovered.status === 'interrupted', recovered.status)
  check('中断后可重试（retryAt 清空）', recovered.retryAt === null)
  fs.rmSync(root, { recursive: true, force: true })
}

/* ───────────── 5. 修订更新 ───────────── */
group('同日修订（force 覆盖）')
{
  const root = tmpRoot()
  const store = createStore({ root })
  store.ensure()
  store.appendBasis([{ date: '2026-11-06', commodity: '豆粕', code: 'M0', spot: 3180, future: 2985, basis: 195, basisRate: 6.13 }])
  const res = store.replaceBasisDate('2026-11-06', [
    { date: '2026-11-06', commodity: '豆粕', code: 'M0', spot: 3200, future: 2985, basis: 215, basisRate: 7.2, sourceDate: '2026-11-06' },
  ])
  const rows = store.readBasis()
  check('修订删掉旧行', res.removed === 1, `removed=${res.removed}`)
  check('修订写入新值', rows.length === 1 && rows[0].spot === 3200, JSON.stringify(rows[0]))
  check('保留 sourceDate', rows[0].sourceDate === '2026-11-06')
  fs.rmSync(root, { recursive: true, force: true })
}

/* ───────────── 6. 3 年窗口一致性 ───────────── */
group('价差 3 年窗口（分位与区间同源）')
{
  const days = []
  const start = new Date('2021-01-04T00:00:00Z')
  for (let i = 0; i < 1300; i += 1) {
    const d = new Date(start.getTime() + i * 86400000)
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    days.push(date)
  }
  // M0 恒定 3000；Y0 在 3 年内只有 8400~9000 的窄幅，4 年前有过 20000 的极值
  const M0 = days.map((d) => ({ d, o: 3000, h: 3000, l: 3000, c: 3000, v: 1 }))
  const Y0 = days.map((d, i) => {
    const old = i < 200
    const c = old ? 20000 : 8400 + (i % 60) * 10
    return { d, o: c, h: c, l: c, c, v: 1 }
  })
  const spreads = computeSpreads(new Map([['M0', M0], ['Y0', Y0]]))
  const ratio = spreads.find((s) => s.id === 'ym')
  check('价差可用', ratio?.available === true, JSON.stringify({ ok: ratio?.available }))
  check('3 年区间不含 4 年前的极值', ratio.max3y < 9000, `max3y=${ratio.max3y}`)
  check('3 年分位在 0~100', ratio.percentile3y >= 0 && ratio.percentile3y <= 100, `p=${ratio.percentile3y}`)
  check('3 年样本 < 全样本', ratio.sample3y < ratio.sample, `${ratio.sample3y} < ${ratio.sample}`)
}

/* ───────────── 7. 复权 ───────────── */
group('主连复权（消除换月跳空）')
{
  const main = [
    { d: '2026-01-05', c: 100, o: 100, h: 100, l: 100 },
    { d: '2026-01-06', c: 102, o: 102, h: 102, l: 102 },
    { d: '2026-01-07', c: 104, o: 104, h: 104, l: 104 },
    { d: '2026-01-08', c: 206, o: 206, h: 206, l: 206 },
    { d: '2026-01-09', c: 208, o: 208, h: 208, l: 208 },
    { d: '2026-01-12', c: 210, o: 210, h: 210, l: 210 },
  ]
  const legs = [
    { code: 'T2601', bars: [{ d: '2026-01-05', c: 100, v: 10 }, { d: '2026-01-06', c: 102, v: 10 }, { d: '2026-01-07', c: 104, v: 10 }, { d: '2026-01-08', c: 105, v: 1 }] },
    { code: 'T2603', bars: [{ d: '2026-01-08', c: 206, v: 20 }, { d: '2026-01-09', c: 208, v: 20 }, { d: '2026-01-12', c: 210, v: 20 }] },
  ]
  const adj = buildAdjusted(main, legs)
  const maxJump = adj.bars.reduce((max, b, i) => (i === 0 ? max : Math.max(max, Math.abs(b.adj - adj.bars[i - 1].adj))), 0)
  const rawJump = main.reduce((max, b, i) => (i === 0 ? max : Math.max(max, Math.abs(b.c - main[i - 1].c))), 0)
  check('识别出 1 次换月', adj.rolls.length === 1, JSON.stringify(adj.rolls))
  check('换月后最新价保持真实', adj.bars[adj.bars.length - 1].adj === 210, String(adj.bars[adj.bars.length - 1].adj))
  check('复权后无跳空（< 原始跳空的 1/10）', maxJump * 10 < rawJump, `adj=${maxJump.toFixed(2)} raw=${rawJump}`)
  check('历史段按比例缩放', Math.abs(adj.bars[0].adj - 100 * (206 / 104)) < 1, String(adj.bars[0].adj))
}

/* ───────────── 8. 日期链路不再偏移 ───────────── */
group('日期链路（UTC 宿主下也不偏移）')
{
  const range = sources.dateRange('2026-11-05', '2026-11-09')
  check('dateRange 含两端且不偏移', range[0] === '2026-11-05' && range[range.length - 1] === '2026-11-09', range.join(','))
  check('dateRange 长度正确', range.length === 5, String(range.length))
  check('isWeekday 周一', sources.isWeekday('2026-11-09') === true)
  check('isWeekday 周六', sources.isWeekday('2026-11-07') === false)
  const days = cal.tradingDaysBetween('2026-09-28', '2026-10-09')
  check('回填日期跳过国庆', !days.includes('2026-10-01') && days.includes('2026-10-08'), days.join(','))

  // 2027 年安排（国办发明电〔2026〕10号）：日历必须真正覆盖，而不是只按周末近似
  check('2027 已纳入覆盖范围', cal.calendarInfo('2027-10-04').covered === true)
  check('2027 春节 2/8 休市', cal.calendarInfo('2027-02-08').reason === 'holiday')
  check('2027 春节 2/13 是周末休市', cal.calendarInfo('2027-02-13').reason === 'weekend')
  check('2027 春节后 2/15 开市', cal.calendarInfo('2027-02-15').trading === true)
  check('2027 劳动节 5/3 休市', cal.calendarInfo('2027-05-03').reason === 'holiday')
  check('2027 国庆 10/4 休市', cal.calendarInfo('2027-10-04').reason === 'holiday')
  check('2027 国庆后 10/8 开市', cal.calendarInfo('2027-10-08').trading === true)
  check('2027 调休上班日（周末）仍休市', cal.calendarInfo('2027-10-09').trading === false)
}

/* ───────────── 9. 子任务失败不再报成功 ───────────── */
group('子任务失败聚合')
{
  const root = tmpRoot()
  const store = createStore({ root })
  store.ensure()
  const partial = await runJob(store, 'demo', async () => ({ ok: 'partial', errors: ['quotes: 502'], quotesError: '502' }))
  check('部分失败返回 ok:false', partial.ok === false && partial.partial === true, JSON.stringify(partial).slice(0, 80))
  const st = store.dataset('demo')
  check('状态写为 partial', st.status === 'partial', st.status)
  check('记录子任务错误', String(st.lastError?.message).includes('502'))
  check('不推进 watermark（下一轮可重试）', st.watermark === undefined || st.watermark === null, String(st.watermark))
  // 冷却：partial 不能把 retryAt 留空，否则调度器每 60 秒重跑一次全量抓取
  check('partial 写入冷却时间（避免每分钟重试）', typeof st.retryAt === 'string' && Date.parse(st.retryAt) > Date.now(), String(st.retryAt))
  check('冷却期内 shouldSkip 为 retry-wait', shouldSkip(store, 'demo') === 'retry-wait', String(shouldSkip(store, 'demo')))

  const failed = await runJob(store, 'demo2', async () => ({ ok: false, errors: ['quotes: 全部失败'] }))
  check('全部失败返回 ok:false', failed.ok === false && failed.partial === undefined)
  check('状态写为 error', store.dataset('demo2').status === 'error')

  const okOut = await runJob(store, 'demo3', async () => ({ ok: true, errors: [] }))
  check('全部成功才写 ok', okOut.ok === true && store.dataset('demo3').status === 'ok')
  fs.rmSync(root, { recursive: true, force: true })
}

/* ───────────── 10. 只读路径无副作用 ───────────── */
group('只读路径无写副作用')
{
  const root = tmpRoot()
  const store = createStore({ root })
  store.ensure()
  store.appendStock('M0', [{ date: '2026-11-06', code: 'M0', warrant: 100 }])
  const before = JSON.stringify(store.meta())
  store.readStock('M0')
  store.readStock('M0')
  const after = JSON.stringify(store.meta())
  check('readStock 不改 meta', before === after)
  fs.rmSync(root, { recursive: true, force: true })
}

/* ───────────── 11. 口径分层 ───────────── */
group('分位与收益率口径分离')
{
  // 必须在临时 store 里造数据：测试机/CI 的默认数据目录可能为空，不能依赖本地已有行情
  const root = tmpRoot()
  const store = createStore({ root })
  store.ensure()
  const bars = []
  const adjusted = []
  const start = Date.UTC(2016, 0, 4)
  for (let i = 0; i < 2800; i += 1) {
    const day = new Date(start + i * 86400000).toISOString().slice(0, 10)
    const close = Number((1000 + i * 0.3 + 50 * Math.sin(i / 30)).toFixed(2))
    bars.push({ d: day, o: close, h: close, l: close, c: close, v: 1000, p: 1000 })
    adjusted.push({ d: day, o: close, h: close, l: close, c: close, adj: close, v: 1000 })
  }
  store.writeDaily('M0', bars)
  store.writeContinuous('M0', {
    bars: adjusted,
    coverage: { from: bars[0].d, to: bars[bars.length - 1].d, matchedDays: bars.length, totalDays: bars.length },
    rolls: [],
  })
  store.writeQuotes([{ code: 'M0', name: '豆粕', last: bars[bars.length - 1].c, prevSettle: bars[bars.length - 2].c, hold: 1, at: '2026-11-11T15:00:00+08:00' }], [], [], null)
  const d = buildDetail(store, 'M0')
  check('统计用复权口径', d.price.caliber.stats === 'adjusted', JSON.stringify(d.price.caliber))
  check('分位用真实报价', d.price.caliber.percentile === 'raw')
  check('K 线用真实报价', d.price.caliber.chart === 'raw')
  const ten = d.price.percentile['10y']
  check('10 年分位样本来自全历史', ten.sample > 2000, String(ten.sample))
  check('回撤为复权口径（不再 -49.8%）', d.price.stats.maxDrawdown > -35, String(d.price.stats.maxDrawdown))

  const q = freshness(store)
  const snap = store.readQuotes()
  // asOf 必须是源站行情时间（rows[i].at），fetchedAt 才是落盘时刻
  const sourceAt = (snap?.rows ?? []).map((r) => r?.at).filter(Boolean).sort().pop() ?? null
  check('quotes 的 asOf 用源站时间', sourceAt === null || q.quotes?.asOf === sourceAt, `${q.quotes?.asOf} vs ${sourceAt}`)
  check('quotes 同时保留落盘时刻 fetchedAt', snap?.at === undefined || q.quotes?.fetchedAt === snap.at, `${q.quotes?.fetchedAt} vs ${snap?.at}`)
  fs.rmSync(root, { recursive: true, force: true })
}

/* ───────────── 12. percentileOf 夹取 ───────────── */
group('分位函数边界')
{
  check('样本内 0/50/100', percentileOf([1, 2, 3], 1) === 0 && percentileOf([1, 2, 3], 2) === 50 && percentileOf([1, 2, 3], 3) === 100)
  check('低于最小值夹到 0', percentileOf([1, 2, 3], 0) === 0, String(percentileOf([1, 2, 3], 0)))
  check('高于最大值夹到 100', percentileOf([1, 2, 3], 99) === 100, String(percentileOf([1, 2, 3], 99)))
  check('空样本返回 NaN', Number.isNaN(percentileOf([], 1)))
}

/* ───────────── 13. 长短任务锁互不阻塞 ───────────── */
group('锁分离（长回填不阻塞盘中更新）')
{
  const root = tmpRoot()
  const store = createStore({ root })
  store.ensure()
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 120))
  const backfill = runJob(store, 'bootstrap', slow, { lockName: 'backfill' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const quick = await runJob(store, 'update-intraday', async () => ({ ok: true }))
  check('回填进行中仍能跑盘中更新', quick.ok === true && quick.started === true, JSON.stringify(quick).slice(0, 80))
  const second = await runJob(store, 'bootstrap2', slow, { lockName: 'backfill' })
  check('长任务之间仍然互斥', second.ok === false && second.started === false)
  await backfill
  fs.rmSync(root, { recursive: true, force: true })
}

/* ───────────── 14. 采集失败契约（调用真实函数 + 注入失败） ───────────── */
group('采集失败契约（真实函数注入失败）')
{
  const store = {
    recordGap: () => {},
    clearGap: () => {},
    patchMeta: () => {},
    meta: () => ({}),
  }
  const now = new Date('2026-11-09T16:00:00+08:00')
  const allFail = await updateAfterClose(store, now, {
    updateDaily: async () => ({ updated: [], failed: [{ code: 'M0', error: '日线为空' }] }),
    updateBasis: async () => ({ rows: 0, matched: 0 }),
    updateExtraSpot: async () => null,
    updateStock: async () => ({ updated: {}, failed: [{ code: 'M0', error: '502' }] }),
    updateContracts: async () => {
      throw new Error('合约接口 502')
    },
    updateIndexHistory: async () => ({ updated: [], failed: [{ code: 'sh000300', error: '指数 502' }] }),
    updateEnergyRef: async () => {
      throw new Error('Brent 502')
    },
  })
  check('日线+仓单+合约全失败 → ok:false', allFail.ok === false, JSON.stringify(allFail.ok))
  check('失败项全部进 errors', allFail.errors.length === 6, JSON.stringify(allFail.errors))
  check('errors 里含 daily', allFail.errors.some((e) => e.startsWith('daily:')))
  check('errors 里含 basis（空表也算失败）', allFail.errors.some((e) => e.startsWith('basis:')))
  check('errors 里含 index', allFail.errors.some((e) => e.startsWith('index:')))
  check('errors 里含 energy', allFail.errors.some((e) => e.startsWith('energy:')))

  const partial = await updateAfterClose(store, now, {
    updateDaily: async () => ({ updated: ['M0'], failed: [] }),
    updateBasis: async () => ({ rows: 50, matched: 7 }),
    updateExtraSpot: async () => null,
    updateStock: async () => ({ updated: {}, failed: [{ code: 'M0', error: '502' }] }),
    updateContracts: async () => ({ updated: ['M2701'], failed: [] }),
    updateIndexHistory: async () => ({ updated: ['sh000300'], failed: [] }),
    updateEnergyRef: async () => ({ brent: 2500, fx: 6000 }),
  })
  check('只有仓单失败 → partial', partial.ok === 'partial', JSON.stringify(partial.ok))
  check('partial 只记失败项', partial.errors.length === 1, JSON.stringify(partial.errors))

  const allOk = await updateAfterClose(store, now, {
    updateDaily: async () => ({ updated: ['M0'], failed: [] }),
    updateBasis: async () => ({ rows: 50, matched: 7 }),
    updateExtraSpot: async () => null,
    updateStock: async () => ({ updated: {}, failed: [] }),
    updateContracts: async () => ({ updated: ['M2701'], failed: [] }),
    updateIndexHistory: async () => ({ updated: ['sh000300'], failed: [] }),
    updateEnergyRef: async () => ({ brent: 2500, fx: 6000 }),
  })
  check('全成功 → ok:true', allOk.ok === true, JSON.stringify(allOk.ok))

  const intra = await updateIntraday(store, {
    updateQuotes: async () => ({ rows: 8, failed: [] }),
    updateNews: async () => {
      throw new Error('新闻 502')
    },
  })
  check('盘中：行情成功 + 新闻失败 → partial', intra.ok === 'partial', JSON.stringify(intra.ok))

  // 契约本身
  check('mergeOutcome 全失败为 false', mergeOutcome([{ name: 'a', ok: false }]).ok === false)
  check('mergeOutcome 部分失败为 partial', mergeOutcome([{ name: 'a', ok: true }, { name: 'b', ok: false }]).ok === 'partial')
  const p = await runPart('x', async () => ({ failed: [{ code: 'M0', error: '空' }] }), (v) => v.failed)
  check('runPart 把 failed 数组算作失败', p.ok === false, JSON.stringify(p))
}

/* ───────────── 15. 季节分位带按年点降级 ───────────── */
group('季节分位带（年点 < 8 降级 p25-p75）')
{
  const makeBars = (years) => {
    const bars = []
    const base = new Date(Date.UTC(2026 - years, 0, 2))
    for (let y = 0; y < years; y += 1) {
      for (let d = 0; d < 250; d += 1) {
        const ts = Date.UTC(2026 - years + y, 0, 2) + d * 86400000
        const dt = new Date(ts)
        const date = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
        // 每年同一"日序"上叠加年际差异，保证 p10 与 p25 不同
        bars.push({ d: date, c: 3000 + d * 0.5 + y * 40 })
      }
    }
    return bars
  }
  const five = seasonCurve(makeBars(5), 10)
  check('5 年 → bands=p25-p75', five.bands === 'p25-p75', five.bands)
  check('5 年时 p10 等于 p25', five.days.every((x) => x.p10 === x.p25))
  check('5 年时 p90 等于 p75', five.days.every((x) => x.p90 === x.p75))
  const ten = seasonCurve(makeBars(10), 10)
  check('10 年 → bands=p10-p90', ten.bands === 'p10-p90', ten.bands)
  check('10 年时 p10 与 p25 不同', ten.days.some((x) => x.p10 !== x.p25))
}

/* ───────────── 16. 回填跳过逻辑（n>=5 阈值） ───────────── */
group('回填跳过已有交易日')
{
  const root = tmpRoot()
  const store = createStore({ root })
  store.ensure()
  const full = ['M0', 'Y0', 'P0', 'OI0', 'RM0'].map((code) => ({ date: '2026-11-05', commodity: code, code, spot: 100, future: 90, basis: 10, basisRate: 10 }))
  const partial = ['M0', 'Y0'].map((code) => ({ date: '2026-11-06', commodity: code, code, spot: 100, future: 90, basis: 10, basisRate: 10 }))
  store.appendBasis([...full, ...partial])
  const covered = basisCoveredDates(store)
  check('≥5 个品种算完整', covered.has('2026-11-05'), JSON.stringify([...covered]))
  check('不足 5 个品种不算完整', !covered.has('2026-11-06'))
  const res = basisDatesToFetch(store, '2026-11-05', '2026-11-06', { skip: true })
  check('待抓列表跳过完整日', !res.fetch.includes('2026-11-05'), res.fetch.join(','))
  check('待抓列表包含不完整日', res.fetch.includes('2026-11-06'), res.fetch.join(','))
  check('不跳时全部待抓', basisDatesToFetch(store, '2026-11-05', '2026-11-06').fetch.length === 2)
  fs.rmSync(root, { recursive: true, force: true })
}

/* ───────────── 17. extraSpot 两态 ───────────── */
group('额外现货源状态')
{
  const root = tmpRoot()
  const store = createStore({ root })
  store.ensure()
  const clean = buildDetail(store, 'SO0')
  check('无缺口时 ok', clean.extraSpot?.ok === true, JSON.stringify(clean.extraSpot))
  store.recordGap('extra-spot', '2026-11-12', '葵油现货数据不全')
  const broken = buildDetail(store, 'SO0')
  check('有缺口时 ok:false', broken.extraSpot?.ok === false, JSON.stringify(broken.extraSpot))
  check('带出错误与日期', broken.extraSpot?.error?.includes('葵油') && broken.extraSpot?.date === '2026-11-12', JSON.stringify(broken.extraSpot))
  store.clearGap('extra-spot', '2026-11-12')
  const recovered = buildDetail(store, 'SO0')
  check('清除缺口后恢复 ok', recovered.extraSpot?.ok === true, JSON.stringify(recovered.extraSpot))
  fs.rmSync(root, { recursive: true, force: true })
}

/* ───────────── 18. 批量修订抢锁失败写 idle ───────────── */
group('批量修订抢锁失败的状态')
{
  const root = tmpRoot()
  const store = createStore({ root })
  store.ensure()
  const held = acquireLock(root, 'job')
  const denied = await startBasisBatch(store, { days: [], force: true })
  check('抢锁失败返回 started:false', denied.started === false, JSON.stringify(denied))
  const st = store.dataset('basis-batch')
  check('补写 idle 状态', st?.status === 'idle', JSON.stringify(st))
  check('记录未启动原因', typeof st?.lastError?.message === 'string', JSON.stringify(st?.lastError))
  held.release()
  const okRun = await startBasisBatch(store, { days: [], force: true })
  check('释放后可正常启动', okRun.started === true, JSON.stringify(okRun))
  fs.rmSync(root, { recursive: true, force: true })
}

/* ───────────── 19. 节假日缺口清理 ───────────── */
group('清理旧链路的节假日缺口')
{
  const root = tmpRoot()
  const store = createStore({ root })
  store.ensure()
  store.recordGap('basis', '2026-10-01', '当日无数据（可能为节假日）') // 国庆
  store.recordGap('basis', '2026-10-02', '当日无数据（可能为节假日）') // 国庆
  store.recordGap('basis', '2025-01-27', '当日现期表为空（可能尚未发布）') // 真实交易日空表
  store.recordGap('daily:M0', '2026-11-03', '接口 502') // 非 basis，不该动
  const removed = pruneHolidayGaps(store)
  const left = store.meta().gaps.map((g) => `${g.dataset}:${g.key}`)
  check('清掉非交易日缺口', removed === 2, String(removed))
  check('保留真实交易日空表', left.includes('basis:2025-01-27'), JSON.stringify(left))
  check('不误删其它数据集缺口', left.includes('daily:M0:2026-11-03'), JSON.stringify(left))
  check('重复调用幂等', pruneHolidayGaps(store) === 0)
  fs.rmSync(root, { recursive: true, force: true })
}

/* ───────────── 20. 跨期结构（按持仓量动态选合约） ───────────── */
group('跨期结构（按持仓量选合约）')
{
  // 25 个交易日的序列：近月固定 3000，远月从 3100 线性收敛到 3039
  const days = Array.from({ length: 25 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`)
  const nearBars = days.map((d) => ({ d, c: 3000, v: 900000, p: 1900000 }))
  const farBars = days.map((d, i) => ({ d, c: 3100 - i * 2.5, v: 90000, p: 500000 }))
  const oldBars = [{ d: '2026-06-30', c: 2600, v: 100, p: 500 }] // 已到期，日期落后
  const thinBars = days.map((d) => ({ d, c: 3050, v: 100, p: 120000 }))

  const store = {
    listDailyCodes: () => ['M0', 'M2701', 'M2703', 'M2705', 'M2611'],
    readDaily: (code) => ({
      M0: [],
      M2701: nearBars,
      M2703: farBars,
      M2705: thinBars,
      M2611: oldBars,
    })[code] ?? [],
  }

  const term = termStructure(store, 'M0', { top: 3 })
  check('排除日期落后的已到期合约', term.contracts.every((c) => c.code !== 'M2611'), JSON.stringify(term.contracts.map((c) => c.code)))
  check('按持仓量降序选出前 3 个', term.contracts.map((c) => c.code).join(',') === 'M2701,M2703,M2705', JSON.stringify(term.contracts.map((c) => c.code)))
  check('选出的合约按交割月升序排列', term.contracts.map((c) => c.month).join(',').includes('27/01'), JSON.stringify(term.contracts.map((c) => c.month)))
  check('任意两个合约两两配对（不限相邻）', term.pairs.map((p) => `${p.near}-${p.far}`).join(',') === 'M2701-M2703,M2701-M2705,M2703-M2705', JSON.stringify(term.pairs.map((p) => `${p.near}-${p.far}`)))

  const p1 = term.pairs[0]
  // 末日远月收盘 = 3100 − 24 × 2.5 = 3040，近月 3000
  check('价差 = 近月 − 远月（交易所口径）', p1.spread === -40, String(p1.spread))
  check('价差率 = 价差 / 近月（保留两位）', Math.abs(p1.spreadRate - -1.33) < 1e-9, String(p1.spreadRate))
  check('交割月间隔 2 个月', p1.monthGap === 2)
  const expectAnnualized = Number(((p1.spreadRate * 365) / p1.days).toFixed(1))
  check('年化按交割月间隔折算', Math.abs(p1.annualized - expectAnnualized) < 1e-9, `${p1.annualized} vs ${expectAnnualized}`)
  check('同合约对历史分位有样本', p1.percentile !== null && p1.percentile.sample === 25, JSON.stringify(p1.percentile))
  check('分位在 0~100 之间', p1.percentile.value >= 0 && p1.percentile.value <= 100, String(p1.percentile.value))
  check('配对里同时给出成交量与持仓量', p1.volume.near === 900000 && p1.openInterest.far === 500000, JSON.stringify({ v: p1.volume, oi: p1.openInterest }))
  check('流动性判定：正常', p1.liquidity === 'ok', p1.liquidity)
  check('流动性判定：偏薄', term.pairs[1].liquidity === 'thin', term.pairs[1].liquidity)

  // 样本不足：只重叠 10 天
  const shortStore = {
    listDailyCodes: () => ['M2701', 'M2703'],
    readDaily: (code) => (code === 'M2701' ? nearBars.slice(0, 10) : farBars.slice(0, 10)),
  }
  const shortTerm = termStructure(shortStore, 'M0', { top: 2 })
  check('重叠样本不足 20 天不给分位', shortTerm.pairs[0].percentile === null, JSON.stringify(shortTerm.pairs[0].percentile))

  // 合约月份解析
  check('合约月份解析正确', JSON.stringify(contractMonth('M2701')) === JSON.stringify({ prefix: 'M', year: 2027, month: 1 }), JSON.stringify(contractMonth('M2701')))
  check('非合约代码返回 null', contractMonth('M0') === null && contractMonth('M2701X') === null)
  check('未知品种返回 null', termStructure(shortStore, 'ZZ0') === null)
}

/* ───────────── 21. 空表不算成功 / 参数边界 / 缓存 / 日期容错 ───────────── */
group('中金所（股指贴水 + 国债期限结构）')
{
  const now = new Date('2026-11-11T10:00:00+08:00')
  check('股指合约 = 当月 + 下月 + 两个季月', contractCodes(varietyOf('IF0'), now).join(',') === 'IF2611,IF2612,IF2703,IF2706', contractCodes(varietyOf('IF0'), now).join(','))
  check('国债合约 = 最近三个季月', contractCodes(varietyOf('T0'), now).join(',') === 'T2612,T2703,T2706', contractCodes(varietyOf('T0'), now).join(','))
  const dec = new Date('2026-12-20T10:00:00+08:00')
  check('12 月股指合约：2612/2701/2703/2706', contractCodes(varietyOf('IF0'), dec).join(',') === 'IF2612,IF2701,IF2703,IF2706', contractCodes(varietyOf('IF0'), dec).join(','))
  const jan = new Date('2027-01-05T10:00:00+08:00')
  check('1 月国债合约从 2703 起', contractCodes(varietyOf('T0'), jan).join(',') === 'T2703,T2706,T2709')

  check('股指最后交易日 = 第三个周五', cal.expiryOfContract('stock', 'IF2612') === '2026-12-18', cal.expiryOfContract('stock', 'IF2612'))
  check('国债最后交易日 = 第二个周五', cal.expiryOfContract('bond', 'T2612') === '2026-12-11', cal.expiryOfContract('bond', 'T2612'))
  check('2027-01 股指到期日', cal.cffexLastTradingDay('stock', 2027, 1) === '2027-01-15', cal.cffexLastTradingDay('stock', 2027, 1))

  // 贴水 = 期货 − 指数（与商品相反）；只保留两边都有数据的日期
  const idxStore = {
    readDaily: (code) => (code === 'IF0' ? { bars: [{ d: '2026-11-09', c: 4000 }, { d: '2026-11-10', c: 4010 }] } : null),
    readIndex: (sym) => (sym === 'sh000300' ? { bars: [{ d: '2026-11-09', c: 4050 }, { d: '2026-11-10', c: 4040 }] } : null),
  }
  const rows = indexBasisSeries(idxStore, { code: 'IF0', indexCode: 'sh000300' })
  check('贴水 = 期货 − 指数（与商品基差反向）', rows[1].basis === -30, String(rows[1].basis))
  check('贴水率按指数归一', Math.abs(rows[1].basisRate - (-30 / 4040) * 100) < 1e-3, String(rows[1].basisRate))
  check('指数缺数据的日子不参与计算', rows.length === 2, `n=${rows.length}`)
  check('没有指数时返回空序列', indexBasisSeries({ readDaily: () => ({ bars: [{ d: '2026-11-10', c: 4010 }] }), readIndex: () => null }, { code: 'IF0', indexCode: 'sh000300' }).length === 0)

  // 新浪中金所字段布局（最新价第 3 位、昨结第 14 位、日期第 36 位）
  const cf = new Array(50).fill('0')
  cf[3] = '4015.8'
  cf[4] = '24288'
  cf[13] = '4024.6'
  cf[14] = '4029.4'
  cf[15] = '173620'
  cf[36] = '2026-11-11'
  cf[37] = '11:04:43'
  const cfParsed = sources.parseSinaQuotes(`var hq_str_nf_IF0="${cf.join(',')}";`)
  check('中金所行情按自己的字段位置解析', cfParsed.length === 1 && cfParsed[0].last === 4015.8 && cfParsed[0].prevSettle === 4029.4 && cfParsed[0].hold === 173620, JSON.stringify(cfParsed[0] ?? null))
  check('中金所时间带冒号也能解析', cfParsed[0]?.time === '110443', cfParsed[0]?.time)
  const cm = new Array(20).fill('0')
  cm[1] = '110511'
  cm[8] = '3143'
  cm[10] = '3073'
  cm[13] = '1873018'
  cm[14] = '1039078'
  cm[16] = '豆粕'
  cm[17] = '2026-11-11'
  const cmParsed = sources.parseSinaQuotes(`var hq_str_nf_M0="${cm.join(',')}";`)
  check('商品行情布局不受影响', cmParsed.length === 1 && cmParsed[0].last === 3143 && cmParsed[0].name === '豆粕', JSON.stringify(cmParsed[0] ?? null))

  // 国债 15:15 才收盘：15:10 抓到的当天日线还不算收盘价
  const bondBars = [{ d: '2026-11-10' }, { d: '2026-11-11' }]
  const at1510 = new Date('2026-11-11T15:10:00+08:00')
  check('国债 15:10 仍视为未收盘', dropInProgressBar(bondBars, at1510, 15 * 60 + 20).length === 1)
  const at1520 = new Date('2026-11-11T15:20:00+08:00')
  check('国债 15:20 收盘后保留当天', dropInProgressBar(bondBars, at1520, 15 * 60 + 20).length === 2)
}

group('空表、边界与缓存')
{
  const { clampInt, daysBetween } = await import('../lib/routes.js')

  /* 单日基差空表：updateAfterClose 必须把"抓到 0 行"算失败 */
  {
    const root = tmpRoot()
    const store = createStore({ root })
    store.ensure()
    const out = await updateAfterClose(
      store,
      new Date('2026-11-10T16:40:00+08:00'),
      {
        updateDaily: async () => ({ updated: ['M0'], failed: [] }),
        updateBasis: async () => ({ ok: false, errors: ['当日现期表为空（可能尚未发布）'], rows: 0 }),
        updateStock: async () => ({ updated: {}, failed: [] }),
        updateContracts: async () => ({ updated: [], failed: [] }),
        updateExtraSpot: async () => null,
      },
      { withBasis: false },
    )
    check('withBasis:false 时不抓基差', out.basisSkipped === '交给 16:40 的基差任务' && out.basis === undefined, JSON.stringify(out.basisSkipped))

    const withBasis = await updateAfterClose(
      store,
      new Date('2026-11-10T16:40:00+08:00'),
      {
        updateDaily: async () => ({ updated: ['M0'], failed: [] }),
        updateBasis: async () => ({ ok: false, errors: ['当日现期表为空（可能尚未发布）'], rows: 0 }),
        updateStock: async () => ({ updated: {}, failed: [] }),
        updateContracts: async () => ({ updated: [], failed: [] }),
        updateExtraSpot: async () => null,
      },
    )
    check('空表 → 收盘任务 partial', withBasis.ok === 'partial', String(withBasis.ok))
    check('空表记入 basisError', typeof withBasis.basisError === 'string' && withBasis.basisError.includes('现期表为空'), withBasis.basisError)
    fs.rmSync(root, { recursive: true, force: true })
  }

  /* 参数边界 */
  check('clampInt 夹取上限', clampInt('99999', 2, 1, 5) === 5, String(clampInt('99999', 2, 1, 5)))
  check('clampInt 夹取下限', clampInt('0', 2, 1, 5) === 1, String(clampInt('0', 2, 1, 5)))
  check('clampInt 非法值回退', clampInt('abc', 2, 1, 5) === 2, String(clampInt('abc', 2, 1, 5)))
  check('daysBetween 正确', daysBetween('2026-11-01', '2026-11-11') === 10, String(daysBetween('2026-11-01', '2026-11-11')))
  check('daysBetween 反向为负', daysBetween('2026-11-11', '2026-11-01') === -10)

  /* 基差批写：跨年一次写入，计数正确且无重复 */
  {
    const root = tmpRoot()
    const store = createStore({ root })
    store.ensure()
    const rows = [
      { date: '2025-12-31', commodity: '豆粕', code: 'M0', basis: 1, basisRate: 1 },
      { date: '2026-01-02', commodity: '豆粕', code: 'M0', basis: 2, basisRate: 2 },
      { date: '2026-01-02', commodity: '豆油', code: 'Y0', basis: 3, basisRate: 3 },
    ]
    const first = store.appendBasis(rows)
    check('跨年批量写入计数正确', first.added === 3, JSON.stringify(first))
    const again = store.appendBasis(rows)
    check('重复写入全部跳过', again.added === 0 && again.skipped === 3, JSON.stringify(again))
    check('基差缓存失效后能读到新行', store.readBasis().length === 3, String(store.readBasis().length))
    fs.rmSync(root, { recursive: true, force: true })
  }

  /* 日线缓存：写后立即可读，外部改写后 mtime 变化能失效 */
  {
    const root = tmpRoot()
    const store = createStore({ root })
    store.ensure()
    store.writeDaily('M0', [{ d: '2026-11-09', c: 3000 }, { d: '2026-11-10', c: 3010 }])
    check('writeDaily 后立即可读', store.readDaily('M0')?.bars?.length === 2)
    const file = path.join(root, 'daily', 'M0.json')
    fs.writeFileSync(file, JSON.stringify({ code: 'M0', updatedAt: new Date().toISOString(), bars: [{ d: '2026-11-11', c: 3020 }] }))
    const after = store.readDaily('M0')
    check('外部改写后缓存自动失效', after?.bars?.length === 1 && after.bars[0].c === 3020, JSON.stringify(after?.bars))
    fs.rmSync(root, { recursive: true, force: true })
  }

  /* 跨期：最新日不足 2 个合约时，回退到"有 ≥2 个合约的最近日期" */
  {
    const mk = (days, price) => days.map((d) => ({ d, c: price, v: 1000, p: 10000 }))
    const store = {
      listDailyCodes: () => ['M2701', 'M2703', 'M2705'],
      readDaily: (code) => {
        const map = {
          // 2701/2703 停在 11-10，2705 停在 11-06
          M2701: { bars: mk(['2026-11-06', '2026-11-09', '2026-11-10'], 3000) },
          M2703: { bars: mk(['2026-11-06', '2026-11-09', '2026-11-10'], 2990) },
          M2705: { bars: mk(['2026-11-05', '2026-11-06'], 2950) },
        }
        return map[code]
      },
    }
    const term = termStructure(store, 'M0', { top: 3, now: new Date('2026-11-11T10:00:00+08:00') })
    check('asOf 取有 ≥2 个合约的最近日期', term.asOf === '2026-11-10', term.asOf)
    check('停更合约不参与配对', term.contracts.every((c) => c.code !== 'M2705'), term.contracts.map((c) => c.code).join(','))
    check('选中合约标记非陈旧', term.contracts.every((c) => c.stale === false), JSON.stringify(term.contracts.map((c) => c.stale)))
  }

  /* 详情页合约快照：给出 asOf 并标记陈旧 */
  {
    const root = tmpRoot()
    const store = createStore({ root })
    store.ensure()
    store.writeDaily('M0', [{ d: '2026-11-10', o: 1, h: 2, l: 1, c: 3000, v: 1 }])
    store.writeDaily('M2701', [{ d: '2026-11-10', o: 1, h: 2, l: 1, c: 3000, v: 1, p: 100 }])
    store.writeDaily('M2703', [{ d: '2026-11-06', o: 1, h: 2, l: 1, c: 2980, v: 1, p: 50 }])
    const detail = buildDetail(store, 'M0', new Date('2026-11-11T10:00:00+08:00'))
    check('详情返回合约数据日期', detail.contractsAsOf === '2026-11-10', detail.contractsAsOf)
    const stale = detail.contracts.find((c) => c.code === 'M2703')
    check('落后合约被标记 stale', stale?.stale === true && stale.date === '2026-11-06', JSON.stringify(stale))
    fs.rmSync(root, { recursive: true, force: true })
  }

  /* 盘中触发收盘任务：不能把当天未完成的日线当收盘价写盘 */
  {
    const bars = [{ d: '2026-11-10' }, { d: '2026-11-11' }]
    const morning = dropInProgressBar(bars, new Date('2026-11-11T10:00:00+08:00'))
    check('盘中丢弃当天未完成日线', morning.length === 1 && morning[0].d === '2026-11-10', JSON.stringify(morning))
    const afterClose = dropInProgressBar(bars, new Date('2026-11-11T15:30:00+08:00'))
    check('收盘后保留当天日线', afterClose.length === 2, JSON.stringify(afterClose))
    const justBefore = dropInProgressBar(bars, new Date('2026-11-11T15:04:00+08:00'))
    check('15:05 之前仍视为未收盘', justBefore.length === 1, JSON.stringify(justBefore))
  }
}

/* ───────────── 23. 中金所资讯（公告解析 / 快讯解析 / 相关性） ───────────── */
group('中金所资讯源')
{
  const html = [
    '<a href="/cn/jystz/20261028/48740.html" class="title">关于增加30年期国债期货合约可交割国债的通知</a>',
    '<a href="/cn/jystz/20261016/48692.html" class="title">关于股指期货和股指期权合约交割的通知</a>',
    '<a href="#">无关链接</a>',
  ].join('')
  const notices = sources.parseCffexNotices(html)
  check('公告解析出 2 条', notices.length === 2, `n=${notices.length}`)
  check('公告时间取日期（09:00）', notices[0].time === '2026-10-28T09:00:00+08:00', notices[0].time)
  check('公告标签=中金所/公告', notices[0].tags.join(',') === '中金所,公告', notices[0].tags.join(','))
  check('公告链接补全域名', notices[0].url === 'https://www.cffex.com.cn/cn/jystz/20261028/48740.html', notices[0].url)
  check('公告标题去掉标签', notices[0].title === '关于增加30年期国债期货合约可交割国债的通知', notices[0].title)

  const j10 = sources.parseJin10({
    data: [
      { id: 20261111112756425800, time: '2026-11-11 11:27:56', data: { content: '【期货热点追踪】棕榈油库存…' } },
      { id: 2, time: 'bad-time', data: { title: '时间格式错误应跳过' } },
    ],
  })
  check('金十解析：坏时间被跳过', j10.length === 1, `n=${j10.length}`)
  check('金十标题取【】内容', j10[0].title === '期货热点追踪', j10[0].title)
  check('金十时间带时区', j10[0].time === '2026-11-11T11:27:56+08:00', j10[0].time)
  check('金十主键不含 20 位 id（会丢精度）', j10[0].id.startsWith('jin10-') && !/\d{20}/u.test(j10[0].id), j10[0].id)
  check('金十链接指向快讯列表', j10[0].url === 'https://www.jin10.com/', j10[0].url)

  check('相关性：期指新闻命中', sources.cffexNewsRelevant('股指期货贴水扩大') === true)
  check('相关性：国债期货命中', sources.cffexNewsRelevant('10年期国债期货增仓') === true)
  check('相关性：外国央行不误命中', sources.cffexNewsRelevant('韩国央行：10月家庭贷款净增5万亿韩元') === false)
  check('相关性：普通商品新闻不命中', sources.cffexNewsRelevant('苹果价格创年内新低') === false)
  check('期货热点归入黑色/能化，不进中金所', JSON.stringify(sources.newsBoardsFor('【期货热点追踪】棕榈油上涨')) === '["black","chem"]', JSON.stringify(sources.newsBoardsFor('【期货热点追踪】棕榈油上涨')))
  check('快讯命中黑色', sources.newsBoardsFor('螺纹钢库存继续下降').includes('black'))
  check('快讯命中能化', sources.newsBoardsFor('PTA 加工费回升').includes('chem'))
  check('同一快讯可命中多个板块', sources.newsBoardsFor('原油上涨带动 PTA 走强').includes('chem'))
  check('与板块无关的快讯返回空', sources.newsBoardsFor('某公司发布董事会公告').length === 0, JSON.stringify(sources.newsBoardsFor('某公司发布董事会公告')))
  check('板块资讯标签映射正确', sources.BOARD_NEWS_TAGS.black === '黑色' && sources.BOARD_NEWS_TAGS.chem === '能化' && sources.BOARD_NEWS_TAGS.cffex === '中金所')
  check('多板块打标：有色', sources.newsBoardsForMulti('沪铜库存下降').includes('nonferrous'))
  check('多板块打标：贵金属', sources.newsBoardsForMulti('美联储降息，黄金上涨').includes('precious'))
  check('多板块打标：其他（集运）', sources.newsBoardsForMulti('集运欧线运价上涨').includes('other'))
  check('多板块打标：能源', sources.newsBoardsForMulti('OPEC 减产，原油上涨').includes('energy'))
  check('多板块打标：农产品', sources.newsBoardsForMulti('白糖产量下调').includes('agri'))
  check('多板块打标：新能源', sources.newsBoardsForMulti('碳酸锂库存去化').includes('newenergy'))
  check('期货热点只进商品板块', !sources.newsBoardsForMulti('【期货热点追踪】棕榈油上涨').includes('other'))
  const emSample = sources.parseEastmoneyFuturesNews('<a href="https://finance.eastmoney.com/a/202611113927819320.html">铜价回调是风险还是机会？</a><a href="https://finance.eastmoney.com/a/202611113927819320.html">重复链接</a>')
  check('东财期货资讯解析', emSample.length === 1 && emSample[0].url.endsWith('.html') && emSample[0].time === '2026-11-11T09:00:00+08:00', JSON.stringify(emSample[0]))
  const sinaSample = sources.parseSinaLive(JSON.stringify({ result: { data: { feed: { list: [{ id: 9, rich_text: '<b>螺纹</b>库存下降', create_time: '2026-11-11 09:30:00' }] } } } }))
  check('新浪直播解析并去 HTML', sinaSample.length === 1 && sinaSample[0].title === '螺纹库存下降' && sinaSample[0].time === '2026-11-11T09:30:00+08:00', JSON.stringify(sinaSample[0]))

  const allVarieties = resolveCatalog()
  const chemOrder = sortByBoard('chem', allVarieties.filter((v) => v.board === 'chem')).map((v) => v.code)
  check('能化默认排序：橡胶系在最前', chemOrder.slice(0, 3).join(',') === 'RU0,NR0,BR0', chemOrder.join(','))
  check('能化默认排序：聚酯在聚烯烃前', chemOrder.indexOf('TA0') < chemOrder.indexOf('L0') && chemOrder.indexOf('PX0') < chemOrder.indexOf('TA0'), chemOrder.join(','))
  check('农产品默认排序：软商品/谷物/养殖/果品', sortByBoard('agri', allVarieties.filter((v) => v.board === 'agri')).map((v) => v.code).slice(0, 2).join(',') === 'SR0,CF0')
  check('LPG 属于能源板块', varietyOf('PG0').board === 'energy')
  check('新能源排序：锂组在前且 LI 预留位在 LC 后', sortByBoard('newenergy', resolveCatalog().filter((v) => v.board === 'newenergy')).map((v) => v.code).join(',') === 'LC0,LI0,SI0,PS0')
  check('板块顺序：有色→贵金属→能源相邻', (() => { const ids = BOARDS.map((b) => b.id); return ids.indexOf('precious') === ids.indexOf('nonferrous') + 1 && ids.indexOf('energy') === ids.indexOf('precious') + 1 })())
  check('中金所默认排序：股指在国债前', sortByBoard('cffex', allVarieties.filter((v) => v.board === 'cffex')).map((v) => v.code).slice(0, 4).join(',') === 'IF0,IH0,IC0,IM0')
  check('玻璃按 72 折算到元/吨', varietyOf('FG0').spotScale === 72 && varietyOf('JD0').spotScale === 500 && varietyOf('LH0').spotScale === 1000)
  check('无现货品种有明确原因', varietyOf('CJ0').basisMode === 'none' && typeof varietyOf('CJ0').noBasisReason === 'string' && varietyOf('SH0').noBasisReason.length > 8)
  check('低流动性品种已移除', ['RR0', 'WR0', 'LG0', 'RS0'].every((code) => maybeVariety(code) === null))
  check('氢氧化锂是预留位', varietyOf('LI0').status === 'upcoming' && varietyOf('LI0').listDate === undefined && varietyOf('LI0').board === 'newenergy')
  check('预留位不参与抓取', !activeVarieties().some((v) => v.code === 'LI0'))
}

/* 粮油网：全栏目失败必须抛错（此前内部迭代曾漏掉这条护栏） */
{
  const origFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return { ok: false, status: 502, arrayBuffer: async () => new ArrayBuffer(0) }
  }
  let threw = false
  let message = ''
  try {
    await sources.chinagrainNews([{ tag: '大豆', path: '/x' }, { tag: '油脂', path: '/y' }])
  } catch (error) {
    threw = true
    message = error instanceof Error ? error.message : String(error)
  }
  globalThis.fetch = origFetch
  check('粮油网全栏目失败抛错', threw && calls > 0 && message.includes('栏目失败'), `fetch=${calls} ${message}`)
}


/* 跨期全品种结果缓存：隔离 + 日线更新失效（套件此前只测了 buildOverview） */
{
  const mkRoutes = () => {
    const root = tmpRoot()
    const store = createStore({ root })
    const routes = []
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      webServer: { register: (spec) => { routes.push(spec); return () => {} } },
    }
    registerRoutes(ctx, store)
    return { store, routes, root }
  }
  const callApi = (m, url) => new Promise((resolve) => {
    const res = {
      writeHead() {},
      end(text) { try { resolve(JSON.parse(text)) } catch (error) { resolve({ ok: false, parseError: String(error) }) } },
    }
    Promise.resolve(m.routes[0].handler({ url }, res)).catch((error) => resolve({ ok: false, error: String(error) }))
  })
  const bars = (close) => [{ d: '2026-11-10', o: close, h: close, l: close, c: close, v: 100, p: 1000 }]
  const A = mkRoutes()
  const B = mkRoutes()
  A.store.writeDaily('M2611', bars(3000))
  A.store.writeDaily('M2612', bars(3100))
  const tA = await callApi(A, '/basis-watch/api?op=term')
  const tB = await callApi(B, '/basis-watch/api?op=term')
  check('term 缓存按 store 隔离', tA.ok === true && tB.ok === true && tA.rows.length !== tB.rows.length, `A=${tA.rows?.length} B=${tB.rows?.length}`)
  const before = tA.rows.find((r) => r.code === 'M0') ?? null
  await new Promise((r) => setTimeout(r, 8))
  A.store.writeDaily('M2611', bars(3500))
  const after = (await callApi(A, '/basis-watch/api?op=term')).rows.find((r) => r.code === 'M0') ?? null
  check('term 合约日线更新后缓存失效', before !== null && after !== null && JSON.stringify(before) !== JSON.stringify(after), `before=${JSON.stringify(before?.contracts?.map((c) => c.close) ?? [])} after=${JSON.stringify(after?.contracts?.map((c) => c.close) ?? [])}`)
}

group('结果缓存契约')
{
  const rootA = tmpRoot()
  const storeA = createStore({ root: rootA })
  storeA.writeQuotes([{ code: 'M0', name: '豆粕', last: 1111, prevSettle: 1111, hold: 1 }], [], [], null)
  storeA.writeDaily('M0', [{ d: '2026-11-10', o: 1111, h: 1111, l: 1111, c: 1111, v: 1, p: 1 }])
  const at = new Date('2026-11-11T10:00:00+08:00')
  const priceOf = (o) => o.rows.find((r) => r.code === 'M0')?.price ?? null
  const first = buildOverview(storeA, at)
  check('总览缓存：首次可读', priceOf(first) === 1111, String(priceOf(first)))
  // 只更新日线、不动 quotes/basis：缓存必须失效（旧实现用裸 lastUpdate.daily，感知不到）
  storeA.writeDaily('M0', [{ d: '2026-11-11', o: 2222, h: 2222, l: 2222, c: 2222, v: 1, p: 1 }])
  const sparkLast = buildOverview(storeA, at).rows.find((r) => r.code === 'M0')?.spark?.at(-1) ?? null
  check('日线更新后总览缓存失效', sparkLast === 2222, String(sparkLast))
  // 只更新仓单：缓存同样必须失效
  storeA.appendStock('M0', [{ date: '2026-11-11', warrant: 12345, delta: 1 }])
  const warrant = buildOverview(storeA, at).rows.find((r) => r.code === 'M0')?.stock?.warrant ?? null
  check('仓单更新后总览缓存失效', warrant === 12345, String(warrant))
  // 两个 store 共用模块级缓存时必须隔离
  const storeB = createStore({ root: tmpRoot() })
  storeB.writeQuotes([{ code: 'M0', name: '豆粕', last: 3333, prevSettle: 3333, hold: 1 }], [], [], null)
  check('总览缓存按 store 隔离', priceOf(buildOverview(storeB, at)) === 3333)
  check('隔离后 storeA 仍可重建', priceOf(buildOverview(storeA, at)) === 1111)
}

console.log(`\n  结果: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
