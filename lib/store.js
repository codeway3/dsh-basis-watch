/**
 * 本地存储层：插件的数据全部落在 <DSH_HOME>/dsh-basis-watch/data 下。
 *
 * 设计要点：
 * - **分析只读本地**：界面与分位计算从不直接打网络，网络只负责增量追加；
 * - **原子写**：JSON 文件先写 .tmp 再 rename，避免进程被杀留下半截文件；
 * - **追加去重**：JSONL 按业务主键去重，重复抓取同一交易日不会产生重复行；
 * - **缺口可见**：抓取失败写入 meta.gaps，页面据此显示"缺哪几天"，不静默跳过。
 *
 * @module dsh-basis-watch/lib/store
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 默认数据根目录。
 * @param {string} [dshHome]
 * @returns {string}
 */
export function defaultDataRoot(dshHome = process.env.DSH_HOME) {
  const home = dshHome !== undefined && dshHome !== '' ? dshHome : path.join(process.env.HOME ?? '.', '.dsh')
  return path.join(path.resolve(home), 'dsh-basis-watch', 'data')
}

/**
 * 创建存储实例。
 * @param {object} [opts]
 * @param {string} [opts.root] 数据根目录（默认见 defaultDataRoot）
 */
export function createStore(opts = {}) {
  const root = opts.root ?? defaultDataRoot()
  const dirs = {
    daily: path.join(root, 'daily'),
    basis: path.join(root, 'basis'),
    stock: path.join(root, 'stock'),
    news: path.join(root, 'news'),
    quotes: path.join(root, 'quotes'),
    continuous: path.join(root, 'continuous'),
  }
  const metaFile = path.join(root, 'meta.json')

  const ensure = () => {
    fs.mkdirSync(root, { recursive: true })
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true })
  }

  /**
   * 读 JSON；损坏或不存在时返回 fallback（不抛错，避免一个坏文件拖垮整页）。
   * @param {string} file
   * @param {any} fallback
   */
  const readJson = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return fallback
    }
  }

  /**
   * 原子写 JSON：先写 .tmp，再 rename 覆盖。
   * @param {string} file
   * @param {any} value
   */
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(value))
    fs.renameSync(tmp, file)
  }

  /**
   * 读 JSONL，坏行跳过并计数。
   * @param {string} file
   * @returns {{rows: any[], badLines: number}}
   */
  const readJsonl = (file) => {
    const rows = []
    let badLines = 0
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      return { rows, badLines }
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        badLines += 1
      }
    }
    return { rows, badLines }
  }

  /**
   * 追加 JSONL 并按主键去重（已有主键的行跳过）。
   * @param {string} file
   * @param {any[]} rows
   * @param {(row: any) => string} keyOf
   * @returns {{added: number, skipped: number}}
   */
  const appendJsonl = (file, rows, keyOf) => {
    const { rows: existing } = readJsonl(file)
    const seen = new Set(existing.map(keyOf))
    const fresh = []
    let skipped = 0
    for (const row of rows) {
      const key = keyOf(row)
      if (seen.has(key)) {
        skipped += 1
        continue
      }
      seen.add(key)
      fresh.push(row)
    }
    if (fresh.length > 0) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n')
    }
    return { added: fresh.length, skipped }
  }

  /* ── meta ── */

  const defaultMeta = () => ({
    schema: 1,
    createdAt: new Date().toISOString(),
    lastUpdate: {},
    gaps: [],
    jobs: {},
  })

  const meta = () => ({ ...defaultMeta(), ...readJson(metaFile, {}) })

  /**
   * 更新 meta 的部分字段。
   * @param {Record<string, any>} patch
   */
  const patchMeta = (patch) => {
    const next = { ...meta(), ...patch }
    if (next.gaps !== undefined && next.gaps.length > 400) next.gaps = next.gaps.slice(-400)
    writeJson(metaFile, next)
    return next
  }

  /**
   * 记录一次数据缺口（去重：同 dataset+key 只留最新一条）。
   * @param {string} dataset 如 'basis' / 'daily:M0'
   * @param {string} key 如 '2026-11-06'
   * @param {string} reason
   */
  const recordGap = (dataset, key, reason) => {
    const now = new Date().toISOString()
    const gaps = meta().gaps.filter((g) => !(g.dataset === dataset && g.key === key))
    gaps.push({ dataset, key, reason, at: now })
    patchMeta({ gaps })
  }

  /**
   * 清除某个缺口（后续补抓成功时调用）。
   * @param {string} dataset
   * @param {string} key
   */
  const clearGap = (dataset, key) => {
    const gaps = meta().gaps.filter((g) => !(g.dataset === dataset && g.key === key))
    patchMeta({ gaps })
  }

  const markUpdated = (dataset, at = new Date().toISOString()) => {
    const lastUpdate = { ...meta().lastUpdate, [dataset]: at }
    patchMeta({ lastUpdate })
  }

  /* ── 数据集状态机 ── */

  /**
   * 读某数据集的运行状态。
   * @param {string} name
   * @returns {{status?: string, lastSuccess?: string, lastError?: {at: string, message: string}|null, watermark?: string|null, retryAt?: string|null, startedAt?: string}|null}
   */
  const dataset = (name) => (meta().datasets ?? {})[name] ?? null

  /**
   * 更新数据集状态（合并写入）。
   * @param {string} name
   * @param {Record<string, any>} patch
   * @returns {Record<string, any>}
   */
  const updateDataset = (name, patch) => {
    const datasets = { ...(meta().datasets ?? {}) }
    const next = { ...(datasets[name] ?? {}), ...patch, updatedAt: new Date().toISOString() }
    datasets[name] = next
    patchMeta({ datasets })
    return next
  }

  /** 列出全部数据集状态。 */
  const listDatasets = () => meta().datasets ?? {}

  /**
   * 崩溃恢复：把"正在跑但进程已不在"的数据集标为中断，允许重试。
   * @param {string[]} names
   * @param {number} [staleMs]
   */
  const recoverDatasets = (names, staleMs = 15 * 60 * 1000) => {
    const datasets = { ...(meta().datasets ?? {}) }
    let changed = false
    for (const name of names) {
      const st = datasets[name]
      if (st?.status !== 'running') continue
      const startedAt = st.startedAt === undefined ? 0 : Date.parse(st.startedAt)
      if (Number.isFinite(startedAt) && Date.now() - startedAt < staleMs) continue
      datasets[name] = {
        ...st,
        status: 'interrupted',
        lastError: { at: new Date().toISOString(), message: '上次运行未正常结束（进程中断）' },
        retryAt: null,
        updatedAt: new Date().toISOString(),
      }
      changed = true
    }
    if (changed) patchMeta({ datasets })
    return datasets
  }

  /* ── 各数据集 ── */

  const dailyFile = (code) => path.join(dirs.daily, `${code}.json`)

  /**
   * 读某品种日线。
   * @param {string} code
   * @returns {{code: string, updatedAt: string, bars: any[]}|null}
   */
  const readDaily = (code) => {
    const data = readJson(dailyFile(code), null)
    if (data === null || !Array.isArray(data.bars)) return null
    return data
  }

  /**
   * 写某品种日线（整体覆盖：日线会因除权/修正变化，覆盖比追加安全）。
   * @param {string} code
   * @param {any[]} bars
   */
  const writeDaily = (code, bars) => {
    writeJson(dailyFile(code), { code, updatedAt: new Date().toISOString(), bars })
    markUpdated(`daily:${code}`)
  }

  const continuousFile = (code) => path.join(dirs.continuous, `${code}.json`)

  /** 列出本地已有的日线品种/合约代码。 */
  const listDailyCodes = () => {
    try {
      return fs
        .readdirSync(dirs.daily)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
    } catch {
      return []
    }
  }

  /** 读复权连续序列（不存在返回 null）。 */
  const readContinuous = (code) => readJson(continuousFile(code), null)

  /** 写复权连续序列。 */
  const writeContinuous = (code, payload) => {
    writeJson(continuousFile(code), { code, updatedAt: new Date().toISOString(), ...payload })
    markUpdated(`continuous:${code}`)
  }

  const basisFile = (year) => path.join(dirs.basis, `${year}.jsonl`)

  /**
   * 用新抓取结果整体替换某一天的基差行（源站事后修订时使用）。
   * 只删该日期的行，其余保持不动。
   * @param {string} date YYYY-MM-DD
   * @param {any[]} rows 新行
   * @returns {{ removed: number, added: number }}
   */
  const replaceBasisDate = (date, rows) => {
    const file = basisFile(String(date).slice(0, 4))
    let existing = []
    try {
      existing = readJsonl(file).rows
    } catch {
      existing = []
    }
    const kept = existing.filter((r) => String(r.date) !== date)
    const removed = existing.length - kept.length
    if (removed > 0) {
      // 原子重写：先写临时文件再改名，避免中途崩溃丢数据
      const tmp = `${file}.tmp`
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8')
      fs.renameSync(tmp, file)
    }
    let added = 0
    for (const row of rows) {
      added += appendJsonl(file, [{ ...row }], (r) => `${r.date}|${r.commodity}`).added
    }
    if (added > 0 || removed > 0) markUpdated('basis')
    return { removed, added }
  }

  /**
   * 追加基差行（主键 date+commodity）。
   * @param {any[]} rows
   */
  const appendBasis = (rows) => {
    let added = 0
    let skipped = 0
    for (const row of rows) {
      const year = String(row.date).slice(0, 4)
      const res = appendJsonl(basisFile(year), [{ ...row }], (r) => `${r.date}|${r.commodity}`)
      added += res.added
      skipped += res.skipped
    }
    if (added > 0) markUpdated('basis')
    return { added, skipped }
  }

  /**
   * 读全部基差行（按年文件合并）。
   * @returns {any[]}
   */
  const readBasis = () => {
    const out = []
    let years = []
    try {
      years = fs.readdirSync(dirs.basis).filter((f) => f.endsWith('.jsonl')).sort()
    } catch {
      return out
    }
    for (const file of years) {
      const { rows } = readJsonl(path.join(dirs.basis, file))
      for (const row of rows) out.push(row)
    }
    return out
  }

  const stockFile = (code) => path.join(dirs.stock, `${code}.jsonl`)

  /**
   * 追加仓单行（主键 date）。
   * @param {string} code
   * @param {any[]} rows
   */
  const appendStock = (code, rows) => {
    const res = appendJsonl(stockFile(code), rows, (r) => String(r.date))
    if (res.added > 0) markUpdated(`stock:${code}`)
    return res
  }

  /**
   * 读某品种仓单序列。
   * @param {string} code
   * @returns {any[]}
   */
  const readStock = (code) => {
    const { rows, badLines } = readJsonl(stockFile(code))
    // 只读路径不再写 meta：读一次页面就改一次 meta 会造成无意义的写放大，
    // 也会让"读"在锁外产生副作用。坏行数随数据返回，由调用方/界面决定怎么提示。
    readStock.lastBadLines = badLines
    return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)))
  }

  const newsFile = (month) => path.join(dirs.news, `${month}.jsonl`)

  /**
   * 追加新闻（主键 id）。
   * @param {any[]} rows
   */
  const appendNews = (rows) => {
    let added = 0
    let skipped = 0
    for (const row of rows) {
      const month = String(row.time ?? '').slice(0, 7) || new Date().toISOString().slice(0, 7)
      const res = appendJsonl(newsFile(month), [{ ...row, month }], (r) => String(r.id))
      added += res.added
      skipped += res.skipped
    }
    if (added > 0) markUpdated('news')
    return { added, skipped }
  }

  /**
   * 读最近新闻（按月份倒序合并，最多 limit 条）。
   * @param {number} [limit]
   * @returns {any[]}
   */
  const readNews = (limit = 50) => {
    let files = []
    try {
      files = fs.readdirSync(dirs.news).filter((f) => f.endsWith('.jsonl')).sort().reverse()
    } catch {
      return []
    }
    const out = []
    for (const file of files) {
      const { rows } = readJsonl(path.join(dirs.news, file))
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        out.push(rows[i])
        if (out.length >= limit) return out
      }
    }
    return out
  }

  const quotesFile = path.join(dirs.quotes, 'latest.json')

  /**
   * 保存最新一轮行情快照。
   * @param {any[]} rows 内盘行情
   * @param {any[]} [foreign] 外盘参考行情
   */
  const writeQuotes = (rows, foreign = []) => {
    writeJson(quotesFile, { at: new Date().toISOString(), rows, foreign })
    markUpdated('quotes')
  }

  /**
   * 读最新行情快照。
   * @returns {{at: string, rows: any[]}|null}
   */
  const readQuotes = () => readJson(quotesFile, null)

  /**
   * 汇总数据覆盖情况（页面"数据完整度"面板用）。
   * @returns {Record<string, any>}
   */
  const coverage = () => {
    const m = meta()
    let dailyFiles = []
    try {
      dailyFiles = fs.readdirSync(dirs.daily).filter((f) => f.endsWith('.json'))
    } catch {
      /* 目录还不存在 */
    }
    const daily = {}
    for (const file of dailyFiles) {
      const data = readJson(path.join(dirs.daily, file), null)
      const bars = Array.isArray(data?.bars) ? data.bars : []
      daily[file.replace(/\.json$/, '')] = {
        bars: bars.length,
        from: bars[0]?.d ?? null,
        to: bars[bars.length - 1]?.d ?? null,
        updatedAt: data?.updatedAt ?? null,
      }
    }
    const basis = readBasis()
    const stock = {}
    let stockFiles = []
    try {
      stockFiles = fs.readdirSync(dirs.stock).filter((f) => f.endsWith('.jsonl'))
    } catch {
      /* 尚未抓取 */
    }
    for (const file of stockFiles) {
      const code = file.replace(/\.jsonl$/, '')
      const rows = readStock(code)
      stock[code] = {
        rows: rows.length,
        from: rows[0]?.date ?? null,
        to: rows[rows.length - 1]?.date ?? null,
      }
    }
    return {
      root,
      lastUpdate: m.lastUpdate,
      gaps: m.gaps.slice(-60),
      gapCount: m.gaps.length,
      daily,
      basis: {
        rows: basis.length,
        from: basis[0]?.date ?? null,
        to: basis[basis.length - 1]?.date ?? null,
        commodities: [...new Set(basis.map((r) => r.commodity))].length,
      },
      stock,
      news: { lastUpdate: m.lastUpdate.news ?? null },
      quotes: readQuotes()?.at ?? null,
    }
  }

  return {
    root,
    dirs,
    ensure,
    readJson,
    writeJson,
    readJsonl,
    appendJsonl,
    meta,
    patchMeta,
    recordGap,
    clearGap,
    markUpdated,
    dataset,
    updateDataset,
    listDatasets,
    recoverDatasets,
    readDaily,
    listDailyCodes,
    writeDaily,
    readContinuous,
    writeContinuous,
    appendBasis,
    replaceBasisDate,
    readBasis,
    appendStock,
    readStock,
    appendNews,
    readNews,
    writeQuotes,
    readQuotes,
    coverage,
  }
}
