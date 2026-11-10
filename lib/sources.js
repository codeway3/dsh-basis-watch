/**
 * 数据源适配层：每个源都拆成"纯解析函数 + 抓取函数"两段。
 *
 * 拆开的原因：解析逻辑可以用固定样本做离线单测（不依赖网络），
 * 抓取函数只负责取字节、调用解析、透传错误。
 *
 * 已实测可用的源（2026-11-07）：
 * - 新浪主连行情（GB18030，需要 Referer）
 * - 新浪日线（JSONP，2005 年至今；主连与分级合约都支持）
 * - 生意社现期表（UTF-8，需要 Referer，可回溯 2019+）
 * - 东方财富注册仓单（JSON API，仅最近约 67 个交易日）
 * - 中国粮油信息网（HTML 列表页，按品种分栏目，最贴合本板块）
 *
 * @module dsh-basis-watch/lib/sources
 */

import { getJson, getText, sleep } from './http.js'

const SINA_REFERER = { Referer: 'https://finance.sina.com.cn/' }

/* ── 纯解析 ── */

/**
 * 解析新浪行情返回文本。
 * @param {string} text
 * @returns {Array<{code: string, name: string, last: number, prevSettle: number, hold: number, volume: number, date: string, time: string, at: string}>}
 */
export function parseSinaQuotes(text) {
  const out = []
  const re = /var hq_str_nf_([A-Za-z0-9]+)="([^"]*)"/g
  let m
  while ((m = re.exec(text)) !== null) {
    const code = m[1]
    const f = m[2].split(',')
    if (f.length < 18 || f[0] === '') continue
    const last = Number(f[8])
    const date = f[17]
    const hhmmss = f[1]
    if (!Number.isFinite(last) || last <= 0 || date === '') continue
    const at = `${date}T${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}+08:00`
    out.push({
      code,
      name: f[16] || f[0],
      last,
      prevSettle: Number(f[10]) || 0,
      hold: Number(f[13]) || 0,
      volume: Number(f[14]) || 0,
      date,
      time: hhmmss,
      at,
    })
  }
  return out
}

/**
 * 解析新浪日线 JSONP。
 * @param {string} text
 * @returns {Array<{d: string, o: number, h: number, l: number, c: number, v: number, p: number}>}
 */
export function parseDailyScript(text) {
  const start = text.indexOf('(')
  const end = text.lastIndexOf(')')
  if (start < 0 || end <= start) throw new Error('日线返回无法解析')
  const arr = JSON.parse(text.slice(start + 1, end))
  if (!Array.isArray(arr)) throw new Error('日线返回不是数组')
  return arr
    .map((b) => ({
      d: String(b.d),
      o: Number(b.o),
      h: Number(b.h),
      l: Number(b.l),
      c: Number(b.c),
      v: Number(b.v),
      p: Number(b.p),
    }))
    .filter((b) => Number.isFinite(b.c) && b.c > 0 && /^\d{4}-\d{2}-\d{2}$/.test(b.d))
}

/**
 * 解析生意社现期表 HTML。
 * 列序：商品 | 现货 | 合约 | 期货价 | 基差 | 基差率
 * @param {string} html
 * @returns {Array<{commodity: string, spot: number, contract: string, future: number, basis: number, basisRate: number}>}
 */
export function parseSpotTable(html) {
  const rows = []
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g
  let tr
  while ((tr = trRe.exec(html)) !== null) {
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g
    const cells = []
    let td
    while ((td = cellRe.exec(tr[1])) !== null) {
      cells.push(td[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim())
    }
    if (cells.length < 6) continue
    const spot = Number(cells[1])
    const future = Number(cells[3])
    if (!Number.isFinite(spot) || spot <= 0) continue
    if (!Number.isFinite(future) || future <= 0) continue
    rows.push({
      commodity: cells[0],
      spot,
      contract: cells[2],
      future,
      basis: Number(cells[4]),
      basisRate: Number(cells[5].replace('%', '')),
    })
  }
  return rows
}

/**
 * 解析东财仓单返回。
 * @param {any} json
 * @returns {Array<{date: string, warrant: number, delta: number}>}
 */
export function parseWarrantJson(json) {
  const rows = json?.result?.data
  if (!Array.isArray(rows)) return []
  return rows
    .map((r) => ({
      date: String(r.TRADE_DATE).slice(0, 10),
      warrant: Number(r.ON_WARRANT_NUM),
      delta: Number(r.ADDCHANGE),
    }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.warrant))
}

/**
 * 解析东财品种代码表。
 * @param {any} json
 * @returns {Record<string, string>} 品种名 → 代码
 */
export function parseWarrantCodeMap(json) {
  const rows = json?.result?.data
  if (!Array.isArray(rows)) return {}
  const out = {}
  for (const r of rows) out[String(r.TRADE_TYPE)] = String(r.TRADE_CODE)
  return out
}

/**
 * 解析中国粮油信息网的文章列表。
 *
 * 真实结构（2026-11 实测）：列表项是 <li>，锚点里包着 <h2> 标题，
 * 后面跟 <span>来源：…</span><span>时间：YYYY-MM-DD HH:MM:SS</span>。
 *
 * @param {string} html
 * @param {string} tag 栏目名（豆粕/豆油/棕榈油/菜粕/菜籽/大豆）
 * @returns {Array<{id: string, time: string, date: string, title: string, url: string, tags: string[]}>}
 */
export function parseChinagrainList(html, tag) {
  const out = []
  const seen = new Set()
  const blocks = html.split(/<li[^>]*>/i)
  for (const block of blocks) {
    const link = /href="(https?:\/\/www\.chinagrain\.cn\/axfwnh\/(\d{4})\/(\d{2})\/(\d{2})\/[^"]+\.shtml)"/.exec(block)
    if (link === null) continue
    const url = link[1]
    if (seen.has(url)) continue
    // 标题：优先 <h2>，退回锚点纯文本
    let title = ''
    const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block)
    if (h2 !== null) title = h2[1]
    else {
      const anchor = /<a[^>]*href="[^"]*axfwnh[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
      if (anchor !== null) title = anchor[1]
    }
    title = title.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    if (title.length < 4) continue
    // 广告/招商类内容不是行情信息
    if (/招商|诚招|代理|供应|批发|厂家直销/.test(title)) continue
    const timeHit = /时间：(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(block)
    const date = `${link[2]}-${link[3]}-${link[4]}`
    seen.add(url)
    out.push({
      id: url,
      time: timeHit !== null ? `${timeHit[1].replace(' ', 'T')}+08:00` : `${date}T00:00:00+08:00`,
      date,
      title,
      url,
      tags: [tag],
    })
  }
  return out
}

/**
 * 解析 Mysteel 现货价格表（免费页，无需登录）。
 *
 * 真实结构：`<tr link="..."><td><a>市场</a></td><td><span>品名</span></td>
 * <td><span>等级</span></td><td class="soft"><a>价格</a></td>…</tr>`
 *
 * @param {string} html
 * @returns {Array<{market: string, product: string, grade: string, price: number}>}
 */
export function parseMysteelSpot(html) {
  const out = []
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g
  let tr
  while ((tr = trRe.exec(html)) !== null) {
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g
    const cells = []
    let td
    while ((td = cellRe.exec(tr[1])) !== null) {
      cells.push(td[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim())
    }
    if (cells.length < 4) continue
    const price = Number(cells[3])
    if (!Number.isFinite(price) || price <= 0) continue
    out.push({ market: cells[0], product: cells[1], grade: cells[2], price })
  }
  return out
}

/**
 * 抓葵花籽油现货（Mysteel 免费页，多个市场）。
 * @returns {Promise<Array<{market: string, product: string, grade: string, price: number}>>}
 */
export async function mysteelSunflowerSpot() {
  const html = await getText('https://list1.m.mysteel.com/zhishi/khzyjtzxjg.html', {
    headers: { Referer: 'https://www.mysteel.com/' },
    timeoutMs: 15000,
  })
  return parseMysteelSpot(html).filter((r) => r.product.includes('葵花'))
}

/**
 * 把 Mysteel 多市场报价聚合成一条"现货参考价"（算术平均）。
 * @param {Array<{market: string, price: number}>} rows
 * @returns {number} 元/吨；无数据时 NaN
 */
export function averageSpot(rows) {
  const prices = rows.map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0)
  if (prices.length === 0) return NaN
  return Number((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(0))
}

/**
 * 解析新浪外盘行情。
 * 字段（实测）：[0]最新 [7]昨收 [12]日期 [13]名称
 * @param {string} text
 * @returns {Array<{code: string, name: string, last: number, prevClose: number, date: string, at: string}>}
 */
export function parseSinaForeign(text) {
  const out = []
  const re = /var hq_str_hf_([A-Za-z0-9]+)="([^"]*)"/g
  let m
  while ((m = re.exec(text)) !== null) {
    const f = m[2].split(',')
    if (f.length < 14 || f[0] === '') continue
    const last = Number(f[0])
    if (!Number.isFinite(last) || last <= 0) continue
    out.push({
      code: m[1],
      name: f[13] || m[1],
      last,
      prevClose: Number(f[7]) || 0,
      date: f[12],
      at: `${f[12]}T${String(f[6] ?? '00:00:00')}+08:00`,
    })
  }
  return out
}

/**
 * 抓外盘参考行情（美豆/美豆粉/美豆油/马棕）。
 * @returns {Promise<ReturnType<typeof parseSinaForeign>>}
 */
export async function sinaForeign() {
  const text = await getText('https://hq.sinajs.cn/list=hf_S,hf_SM,hf_BO,hf_FCPO,hf_C', {
    headers: SINA_REFERER,
    encoding: 'gb18030',
    timeoutMs: 10000,
  })
  return parseSinaForeign(text)
}

/* ── 抓取 ── */

/** 粮油网与本板块相关的栏目（栏目页 → 标签）。 */
export const CHINAGRAIN_SECTIONS = [
  { tag: '豆粕', path: '/doupo/' },
  { tag: '豆油', path: '/douyou/' },
  { tag: '棕榈油', path: '/zonglvyou/' },
  { tag: '菜粕', path: '/caipo/' },
  { tag: '菜籽', path: '/caizi/' },
  { tag: '大豆', path: '/dadou/' },
]

/**
 * 抓取粮油网各栏目的最新文章。
 * 单栏目失败只跳过该栏目，不影响其它栏目。
 * @param {Array<{tag: string, path: string}>} [sections]
 * @returns {Promise<ReturnType<typeof parseChinagrainList>>}
 */
export async function chinagrainNews(sections = CHINAGRAIN_SECTIONS) {
  const merged = new Map()
  for (const section of sections) {
    try {
      const html = await getText(`https://www.chinagrain.cn${section.path}`, {
        headers: { Referer: 'https://www.chinagrain.cn/' },
        timeoutMs: 15000,
      })
      for (const item of parseChinagrainList(html, section.tag)) {
        const prev = merged.get(item.id)
        if (prev === undefined) {
          merged.set(item.id, item)
        } else if (!prev.tags.includes(section.tag)) {
          prev.tags.push(section.tag)
        }
      }
    } catch {
      /* 单栏目失败可接受：下一轮会重试 */
    }
    await sleep(150)
  }
  return [...merged.values()]
}
/**
 * 新浪主连/合约实时行情。
 * @param {string[]} codes 如 ['M0','Y0']
 * @returns {Promise<ReturnType<typeof parseSinaQuotes>>}
 */
export async function sinaQuotes(codes) {
  if (codes.length === 0) return []
  const list = codes.map((c) => `nf_${c}`).join(',')
  const text = await getText(`https://hq.sinajs.cn/list=${list}`, {
    headers: SINA_REFERER,
    encoding: 'gb18030',
    timeoutMs: 10000,
  })
  return parseSinaQuotes(text)
}

/**
 * 新浪日线（主连或分级合约）。
 * @param {string} code 如 M0 / M2701
 * @returns {Promise<ReturnType<typeof parseDailyScript>>}
 */
export async function sinaDaily(code) {
  const url =
    'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/InnerFuturesNewService.getDailyKLine?symbol=' +
    encodeURIComponent(code)
  const text = await getText(url, { headers: SINA_REFERER, timeoutMs: 20000 })
  return parseDailyScript(text)
}

/**
 * 生意社「商品现货与期货价格对比表」。
 * @param {string} date YYYY-MM-DD（交易日）
 * @returns {Promise<ReturnType<typeof parseSpotTable>>}
 */
export async function spotFutureTable(date) {
  const url = `https://www.100ppi.com/sf/day-${date}.html`
  const html = await getText(url, {
    headers: { Referer: 'https://www.100ppi.com/sf/' },
    timeoutMs: 20000,
  })
  return parseSpotTable(html)
}

/**
 * 东方财富注册仓单（交易所口径，最近约 67 个交易日）。
 * @param {string} productCode 如 M / Y / P / OI / RM / SO
 * @returns {Promise<ReturnType<typeof parseWarrantJson>>}
 */
export async function warrantSeries(productCode) {
  const base = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
  const params = new URLSearchParams({
    reportName: 'RPT_FUTU_STOCKDATA',
    columns: 'SECURITY_CODE,TRADE_DATE,ON_WARRANT_NUM,ADDCHANGE',
    filter: `(SECURITY_CODE="${productCode}")`,
    pageNumber: '1',
    pageSize: '500',
    sortTypes: '1',
    sortColumns: 'TRADE_DATE',
    source: 'WEB',
    client: 'WEB',
  })
  const json = await getJson(`${base}?${params.toString()}`, { timeoutMs: 20000 })
  return parseWarrantJson(json)
}

/**
 * 东方财富品种代码表（品种名 → 代码）。
 * @returns {Promise<Record<string, string>>}
 */
export async function warrantCodeMap() {
  const base = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
  const params = new URLSearchParams({
    reportName: 'RPT_FUTU_POSITIONCODE',
    columns: 'TRADE_MARKET_CODE,TRADE_CODE,TRADE_TYPE',
    filter: '(IS_MAINCODE="1")',
    pageNumber: '1',
    pageSize: '500',
    source: 'WEB',
    client: 'WEB',
  })
  const json = await getJson(`${base}?${params.toString()}`, { timeoutMs: 20000 })
  return parseWarrantCodeMap(json)
}

/* ── 日期工具 ── */

/**
 * 判断一个日期是否是工作日（简单版：排除周六周日；法定节假日由缺口记录暴露）。
 * @param {string} date YYYY-MM-DD
 * @returns {boolean}
 */
export function isWeekday(date) {
  // getDay() 取的是"宿主本地时区"的星期，UTC 机器上会把周一算成周日。
  // 这里用 UTC 日期构造 + getUTCDay()，结果与宿主时区无关。
  const [y, m, d] = String(date).split('-').map(Number)
  if (!y || !m || !d) return false
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return w !== 0 && w !== 6
}

/**
 * 生成 [from, to] 之间的日期序列（含两端）。
 * @param {string} from YYYY-MM-DD
 * @param {string} to YYYY-MM-DD
 * @returns {string[]}
 */
export function dateRange(from, to) {
  // 纯字符串日历运算：早先用 toISOString() 取日期，+08:00 的 00:00 在 UTC 是前一天 16:00，
  // 结果整个序列比预期早一天（UTC 宿主上还会漏掉最后一天）。
  const out = []
  let [y, m, d] = String(from).split('-').map(Number)
  const [ey, em, ed] = String(to).split('-').map(Number)
  let guard = 0
  while (guard < 40000) {
    guard += 1
    const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    out.push(date)
    if (y === ey && m === em && d === ed) break
    if (y > ey || (y === ey && (m > em || (m === em && d > ed)))) break
    const next = new Date(Date.UTC(y, m - 1, d) + 86400000)
    y = next.getUTCFullYear()
    m = next.getUTCMonth() + 1
    d = next.getUTCDate()
  }
  return out
}
