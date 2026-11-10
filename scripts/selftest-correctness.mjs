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
const { buildDetail, freshness } = await import('../lib/routes.js')
const { percentileOf, seasonCurve } = await import('../lib/calc.js')
const { basisCoveredDates, basisDatesToFetch, pruneHolidayGaps } = await import('../lib/collect.js')
const { startBasisBatch } = await import('../lib/routes.js')
const { updateAfterClose, updateIntraday, runPart, mergeOutcome } = await import('../lib/collect.js')
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
  const store = createStore()
  store.ensure()
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
  })
  check('日线+仓单+合约全失败 → ok:false', allFail.ok === false, JSON.stringify(allFail.ok))
  check('失败项全部进 errors', allFail.errors.length === 4, JSON.stringify(allFail.errors))
  check('errors 里含 daily', allFail.errors.some((e) => e.startsWith('daily:')))
  check('errors 里含 basis（空表也算失败）', allFail.errors.some((e) => e.startsWith('basis:')))

  const partial = await updateAfterClose(store, now, {
    updateDaily: async () => ({ updated: ['M0'], failed: [] }),
    updateBasis: async () => ({ rows: 50, matched: 7 }),
    updateExtraSpot: async () => null,
    updateStock: async () => ({ updated: {}, failed: [{ code: 'M0', error: '502' }] }),
    updateContracts: async () => ({ updated: ['M2701'], failed: [] }),
  })
  check('只有仓单失败 → partial', partial.ok === 'partial', JSON.stringify(partial.ok))
  check('partial 只记失败项', partial.errors.length === 1, JSON.stringify(partial.errors))

  const allOk = await updateAfterClose(store, now, {
    updateDaily: async () => ({ updated: ['M0'], failed: [] }),
    updateBasis: async () => ({ rows: 50, matched: 7 }),
    updateExtraSpot: async () => null,
    updateStock: async () => ({ updated: {}, failed: [] }),
    updateContracts: async () => ({ updated: ['M2701'], failed: [] }),
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

console.log(`\n  结果: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
