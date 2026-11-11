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
    index: path.join(root, 'index'),
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
   * 日线读缓存：key → { mtimeMs, data }。
   *
   * 为什么需要：一次 `op=term` 会逐个合约读文件，加上 overview/status 每分钟被前端轮询，
   * 每次请求都重新 JSON.parse 200 多个文件很浪费。用 mtime 做失效判断，
   * 外部进程（CLI）改写文件后也能自动读到新内容。
   */
  const dailyCache = new Map()

  /**
   * 读某品种日线（带 mtime 缓存）。
   * @param {string} code
   * @returns {{code: string, updatedAt: string, bars: any[]}|null}
   */
  const readDaily = (code) => {
    const file = dailyFile(code)
    let mtimeMs
    try {
      mtimeMs = fs.statSync(file).mtimeMs
    } catch {
      dailyCache.delete(code)
      return null
    }
    const cached = dailyCache.get(code)
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.data
    const data = readJson(file, null)
    const value = data === null || !Array.isArray(data.bars) ? null : data
    dailyCache.set(code, { mtimeMs, data: value })
    return value
  }

  /**
   * 写某品种日线（整体覆盖：日线会因除权/修正变化，覆盖比追加安全）。
   * @param {string} code
   * @param {any[]} bars
   */
  const writeDaily = (code, bars) => {
    const payload = { code, updatedAt: new Date().toISOString(), bars }
    writeJson(dailyFile(code), payload)
    // 直接刷新缓存，避免写完还要 stat 一次
    dailyCache.set(code, { mtimeMs: fs.statSync(dailyFile(code)).mtimeMs, data: payload })
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

  const indexFile = (symbol) => path.join(dirs.index, `${symbol}.json`)

  /**
   * 读指数日线（中金所股指的现货基准）。
   * @param {string} symbol 如 sh000300
   * @returns {{symbol: string, updatedAt: string, bars: Array<{d: string, c: number}>}|null}
   */
  const readIndex = (symbol) => {
    const data = readJson(indexFile(symbol), null)
    if (data === null || !Array.isArray(data.bars)) return null
    return data
  }

  /**
   * 写指数日线（整体覆盖）。
   * @param {string} symbol
   * @param {Array<{d: string, c: number}>} bars
   */
  const writeIndex = (symbol, bars) => {
    writeJson(indexFile(symbol), { symbol, updatedAt: new Date().toISOString(), bars })
    markUpdated(`index:${symbol}`)
  }

  /** 写复权连续序列。 */
  const writeContinuous = (code, payload) => {
    writeJson(continuousFile(code), { code, updatedAt: new Date().toISOString(), ...payload })
    markUpdated(`continuous:${code}`)
  }

  const basisFile = (year) => path.join(dirs.basis, `${year}.jsonl`)

  /** 基差全量读缓存：basis 文件不多（按年），一次请求里会被多处用到。 */
  let basisCache = null

  /** 让基差缓存失效（任何写基差之后调用）。 */
  const invalidateBasisCache = () => {
    basisCache = null
  }

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
      const tmp = `${file}.tmp-${process.pid}`
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8')
      fs.renameSync(tmp, file)
    }
    // 一次写完整天：早期实现逐行 appendJsonl，每行都把整年文件读一遍，属 O(n²)
    const added = rows.length === 0 ? 0 : appendJsonl(file, rows.map((r) => ({ ...r })), (r) => `${r.date}|${r.commodity}`).added
    if (added > 0 || removed > 0) {
      markUpdated('basis')
      invalidateBasisCache()
    }
    return { removed, added }
  }

  /**
   * 追加基差行（主键 date+commodity）。
   * @param {any[]} rows
   */
  const appendBasis = (rows) => {
    // 按年分组后各写一次：逐行 appendJsonl 会每行重读整年文件
    const byYear = new Map()
    for (const row of rows) {
      const year = String(row.date).slice(0, 4)
      if (!byYear.has(year)) byYear.set(year, [])
      byYear.get(year).push({ ...row })
    }
    let added = 0
    let skipped = 0
    for (const [year, list] of byYear) {
      const res = appendJsonl(basisFile(year), list, (r) => `${r.date}|${r.commodity}`)
      added += res.added
      skipped += res.skipped
    }
    if (added > 0) {
      markUpdated('basis')
      invalidateBasisCache()
    }
    return { added, skipped }
  }

  /**
   * 读全部基差行（按年文件合并，带缓存）。
   * 返回的是浅拷贝数组，调用方排序/过滤不会污染缓存。
   *
   * 缓存键包含每个年文件的 mtime+size：CLI/后台任务在另一个进程里写了基差后，
   * 常驻的 host 进程也能立刻看到新数据，不需要重启插件（曾经因此读到旧基差）。
   *
   * @returns {any[]}
   */
  const basisCacheKey = () => {
    try {
      return fs
        .readdirSync(dirs.basis)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .map((f) => {
          const st = fs.statSync(path.join(dirs.basis, f))
          return `${f}:${st.mtimeMs}:${st.size}`
        })
        .join('|')
    } catch {
      return ''
    }
  }

  const readBasis = () => {
    const key = basisCacheKey()
    if (basisCache !== null && basisCache.key === key) return basisCache.rows.slice()
    const out = []
    let years = []
    try {
      years = fs.readdirSync(dirs.basis).filter((f) => f.endsWith('.jsonl')).sort()
    } catch {
      basisCache = { key, rows: [] }
      return []
    }
    for (const file of years) {
      const { rows } = readJsonl(path.join(dirs.basis, file))
      for (const row of rows) out.push(row)
    }
    basisCache = { key, rows: out }
    return out.slice()
  }

  /**
   * 按谓词清理基差行（一次性维护用，比如口径改名后清掉旧行）。
   * @param {(row: any) => boolean} keep 返回 true 的行保留
   * @returns {number} 删除行数
   */
  const rewriteBasis = (keep) => {
    let removed = 0
    let files = []
    try {
      files = fs.readdirSync(dirs.basis).filter((f) => f.endsWith('.jsonl'))
    } catch {
      return 0
    }
    for (const file of files) {
      const full = path.join(dirs.basis, file)
      const { rows } = readJsonl(full)
      const kept = rows.filter((r) => keep(r))
      if (kept.length === rows.length) continue
      removed += rows.length - kept.length
      fs.writeFileSync(full, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length > 0 ? '\n' : ''))
    }
    if (removed > 0) {
      markUpdated('basis')
      invalidateBasisCache()
    }
    return removed
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
    // 跨源同一件事只显示一条；盘面综述类（午盘/收盘/期货热点）不当板块资讯
    const ROUNDUP = /午盘收盘|早盘收盘|商品期货收盘|期货热点追踪|收盘播报/u
    const normalize = (t) => String(t).replace(/[【】\[\]\s，。！？：；、,.:;!?]/gu, '')
    // 长标题包含短标题时视为同一条（东财长摘要 vs 金十短快讯）
    const isDuplicate = (key, keys) => {
      if (keys.has(key)) return true
      for (const other of keys) {
        if (other.startsWith(key) || key.startsWith(other)) return true
      }
      return false
    }
    // 同一件事的不同措辞（如「日内涨6%，现报2530」vs「涨6%至2530点」）用字符二元组相似度兜底
    const bigrams = (text) => {
      const set = new Set()
      for (let i = 0; i + 1 < text.length; i += 1) set.add(text.slice(i, i + 2))
      return set
    }
    const similar = (key, keys) => {
      const a = bigrams(key)
      if (a.size < 6) return false
      for (const other of keys) {
        const b = bigrams(other)
        if (b.size < 6) continue
        let inter = 0
        for (const g of a) if (b.has(g)) inter += 1
        if (inter / Math.max(a.size, b.size) > 0.62) return true
      }
      return false
    }
    const seen = new Set()
    const out = []
    for (const file of files) {
      const { rows } = readJsonl(path.join(dirs.news, file))
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i]
        const title = String(row?.title ?? '').replace(/<[^>]+>/gu, '').replace(/\s+/gu, ' ').trim()
        if (title === '' || ROUNDUP.test(title)) continue
        const key = normalize(title)
        if (key === '' || isDuplicate(key, seen) || similar(key, seen)) continue
        seen.add(key)
        out.push(title === row.title ? row : { ...row, title })
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
   * @param {Array<{symbol: string, name: string, last: number, change: number, changePct: number}>} [indices] 指数快照（中金所股指的现货基准）
   * @param {{brent: number, usdcny: number}|null} [energy] 能源板块的折算参考
   */
  const writeQuotes = (rows, foreign = [], indices = [], energy = null) => {
    writeJson(quotesFile, { at: new Date().toISOString(), rows, foreign, indices, energy })
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
      const code = file.replace(/\.json$/, '')
      // 走带缓存的 readDaily：status 每分钟被前端轮询，避免每次重解析全部文件
      const data = readDaily(code)
      const bars = Array.isArray(data?.bars) ? data.bars : []
      daily[code] = {
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
      index: (() => {
        const symbols = {}
        try {
          for (const file of fs.readdirSync(dirs.index).filter((f) => f.endsWith('.json'))) {
            const symbol = file.replace(/\.json$/, '')
            const data = readIndex(symbol)
            const bars = data?.bars ?? []
            symbols[symbol] = { bars: bars.length, from: bars[0]?.d ?? null, to: bars[bars.length - 1]?.d ?? null }
          }
        } catch {
          /* 尚未抓取指数 */
        }
        return symbols
      })(),
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
    readIndex,
    writeIndex,
    appendBasis,
    rewriteBasis,
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
