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
    const stamp = (date, hhmmss) =>
      `${date}T${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}+08:00`

    // 中金所字段布局与商品不同（实测：最新价第 3 位、昨结第 14 位、日期第 36 位）
    if (/^(IF|IH|IC|IM|T|TF|TS|TL)0$/u.test(code)) {
      const last = Number(f[3])
      const date = f[36]
      // 中金所的时间带冒号（11:04:43），商品是纯数字（110443）
      const hhmmss = String(f[37] ?? '').replace(/:/gu, '')
      if (!Number.isFinite(last) || last <= 0 || !/^\d{4}-\d{2}-\d{2}$/u.test(date ?? '') || !/^\d{6}$/u.test(hhmmss)) continue
      out.push({
        code,
        name: f[0],
        last,
        prevSettle: Number(f[14]) || 0,
        prevClose: Number(f[13]) || 0,
        hold: Number(f[15]) || 0,
        volume: Number(f[4]) || 0,
        date,
        time: hhmmss,
        at: stamp(date, hhmmss),
      })
      continue
    }

    const last = Number(f[8])
    const date = f[17]
    const hhmmss = f[1]
    if (!Number.isFinite(last) || last <= 0 || date === '') continue
    out.push({
      code,
      name: f[16] || f[0],
      last,
      prevSettle: Number(f[10]) || 0,
      hold: Number(f[13]) || 0,
      volume: Number(f[14]) || 0,
      date,
      time: hhmmss,
      at: stamp(date, hhmmss),
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
  let failedSections = 0
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
      // 单栏目失败可接受；全栏目失败必须抛，否则油料资讯长期为空也会报 ok
      failedSections += 1
    }
    await sleep(150)
  }
  if (merged.size === 0 && failedSections > 0) throw new Error(`粮油网 ${failedSections}/${sections.length} 个栏目失败`)
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

/* ───────────── 指数（中金所股指的现货基准） ───────────── */

/**
 * 解析新浪指数快照（`s_sh000300` 格式）。
 * 字段：名称,最新,涨跌,涨跌幅,成交量(手),成交额(万元)
 *
 * @param {string} text
 * @returns {Array<{symbol: string, name: string, last: number, change: number, changePct: number}>}
 */
export function parseIndexQuotes(text) {
  const out = []
  const re = /var hq_str_s_(\w+)="([^"]*)"/g
  let m
  while ((m = re.exec(text)) !== null) {
    const f = m[2].split(',')
    const last = Number(f[1])
    if (!Number.isFinite(last) || last <= 0) continue
    out.push({
      symbol: m[1],
      name: f[0],
      last,
      change: Number(f[2]) || 0,
      changePct: Number(f[3]) || 0,
    })
  }
  return out
}

/**
 * 抓多个指数的最新快照。
 * @param {string[]} symbols 如 ['sh000300']
 * @returns {Promise<Array<{symbol: string, name: string, last: number, change: number, changePct: number}>>}
 */
export async function indexQuotes(symbols) {
  if (symbols.length === 0) return []
  const list = symbols.map((s) => `s_${s}`).join(',')
  const text = await getText(`https://hq.sinajs.cn/list=${list}`, {
    headers: { Referer: 'https://finance.sina.com.cn' },
    encoding: 'gb18030',
    timeoutMs: 10000,
  })
  return parseIndexQuotes(text)
}

/**
 * 解析东财指数日线（`klines: ["2024-10-22,3957.78", ...]`）。
 * @param {any} json
 * @returns {Array<{d: string, c: number}>}
 */
export function parseIndexDaily(json) {
  const klines = json?.data?.klines
  if (!Array.isArray(klines)) return []
  const out = []
  for (const line of klines) {
    const [d, c] = String(line).split(',')
    const close = Number(c)
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(d ?? '') || !Number.isFinite(close) || close <= 0) continue
    out.push({ d, c: close })
  }
  return out
}

/**
 * 抓指数历史日线（东财，lmt 足够大即全量）。
 * 用东财而不是新浪：新浪接口只回最近约 1023 根，做 3 年分位不够。
 *
 * @param {string} symbol 如 sh000300
 * @param {number} [limit]
 * @returns {Promise<Array<{d: string, c: number}>>}
 */
export async function indexDaily(symbol, limit = 6000) {
  const apiSymbol = String(symbol).replace(/^(sh|sz)/, '')
  const market = String(symbol).startsWith('sh') ? 1 : 0
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${market}.${apiSymbol}` +
    `&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=0&lmt=${limit}&end=20500101`
  const json = await getJson(url, {
    headers: { Referer: 'https://quote.eastmoney.com/' },
    timeoutMs: 15000,
  })
  return parseIndexDaily(json)
}

/* ───────────── 中金所资讯：交易所公告 + 金十快讯 ───────────── */

/** 中金所「交易所通知」列表页。 */
// 官网只开 http（https 连接超时），且需要浏览器 UA
export const CFFEX_NOTICE_URL = 'http://www.cffex.com.cn/cn/jystz.html'

/**
 * 解析中金所通知列表。
 * 结构：`<a href="/cn/jystz/20261028/48740.html">关于……的通知</a>`
 *
 * @param {string} html
 * @returns {Array<{id: string, time: string, title: string, url: string, tags: string[], source: string}>}
 */
export function parseCffexNotices(html) {
  const out = []
  const re = /href="(\/cn\/jystz\/(\d{4})(\d{2})(\d{2})\/(\d+)\.html)"[^>]*>([^<]{4,160})</g
  let m
  while ((m = re.exec(html)) !== null) {
    const [, path, y, mo, d, n, rawTitle] = m
    const title = rawTitle.trim()
    if (title === '') continue
    out.push({
      id: `cffex-${n}`,
      // 公告只给日期，没有时刻；按当天 09:00 排，避免压过盘中快讯
      time: `${y}-${mo}-${d}T09:00:00+08:00`,
      title,
      url: `https://www.cffex.com.cn${path}`,
      tags: ['中金所', '公告'],
      source: 'cffex',
    })
  }
  return out
}

/**
 * 抓中金所交易所通知（官方公告：新合约上市、交割、可交割国债等）。
 * @returns {Promise<ReturnType<typeof parseCffexNotices>>}
 */
export async function cffexNotices() {
  const html = await getText(CFFEX_NOTICE_URL, {
    headers: {
      Referer: 'http://www.cffex.com.cn/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    },
    timeoutMs: 15000,
  })
  return parseCffexNotices(html)
}

/** 金十快讯接口（含期货热点追踪、宏观流动性）。 */
export const JIN10_FLASH_URL = 'https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1'

/**
 * 解析金十快讯。
 *
 * 注意：金十的 `id` 是 20 位整数，超过 `Number.MAX_SAFE_INTEGER`，JSON.parse 会丢末尾几位。
 * 所以不用它做主键/链接，改用「时间 + 标题哈希」；链接指向快讯总列表。
 *
 * @param {any} json
 * @returns {Array<{id: string, time: string, title: string, tags: string[], url: string, source: string}>}
 */
export function parseJin10(json) {
  const list = Array.isArray(json?.data) ? json.data : []
  const out = []
  const hash = (text) => {
    let h = 5381
    for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
    return h.toString(36)
  }
  for (const item of list) {
    const timeText = String(item?.time ?? '')
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(timeText)) continue
    const content = String(item?.data?.content ?? '')
    const title = String(item?.data?.title ?? '') || (/^【([^】]+)】/u.exec(content)?.[1] ?? content.slice(0, 60))
    if (title.trim() === '') continue
    out.push({
      id: `jin10-${timeText.replace(/[-: ]/gu, '')}-${hash(title)}`,
      time: `${timeText.replace(' ', 'T')}+08:00`,
      title: title.trim(),
      url: 'https://www.jin10.com/',
      tags: ['中金所', '快讯'],
      source: 'jin10',
    })
  }
  return out
}

/**
 * 抓金十快讯。
 * @returns {Promise<ReturnType<typeof parseJin10>>}
 */
export async function jin10FlashNews() {
  const json = await getJson(JIN10_FLASH_URL, {
    headers: { 'x-app-id': 'bVBF4FyRTn5NJF5n', 'x-version': '1.0.0', Referer: 'https://www.jin10.com/' },
    timeoutMs: 12000,
  })
  return parseJin10(json)
}

/** 中金所板块的资讯关键词：股指/国债/期货/宏观流动性。 */
export const CFFEX_NEWS_KEYWORDS = [
  '股指期货',
  '期指',
  '国债期货',
  '沪深300',
  '上证50',
  '中证500',
  '中证1000',
  '贴水',
  '升水',
  '基差',
  '交割',
  '持仓',
  'MLF',
  'LPR',
  '降准',
  '降息',
  '逆回购',
  '公开市场',
  '人民银行',
]

/**
 * 中金所资讯相关性判断。
 * @param {string} text
 * @returns {boolean}
 */
export function cffexNewsRelevant(text) {
  return CFFEX_NEWS_KEYWORDS.some((k) => text.includes(k))
}

/** 黑色板块关键词（钢材/炉料/铁合金）。 */
export const BLACK_NEWS_KEYWORDS = [
  '螺纹',
  '热卷',
  '热轧',
  '铁矿',
  '焦炭',
  '焦煤',
  '焦化',
  '硅铁',
  '锰硅',
  '不锈钢',
  '粗钢',
  '钢厂',
  '高炉',
  '铁水',
  '钢材',
  '唐山',
  '限产',
]

/** 能化板块关键词（聚酯/聚烯烃/盐化工/橡胶纸浆）。 */
export const CHEM_NEWS_KEYWORDS = [
  'PTA',
  '甲醇',
  '乙二醇',
  '聚丙烯',
  '聚乙烯',
  'PVC',
  '纯碱',
  '尿素',
  '橡胶',
  '纸浆',
  '苯乙烯',
  '液化气',
  '瓶片',
  '短纤',
  'PX',
  '纯苯',
  '丁二烯',
  '聚酯',
  '烯烃',
  '化工',
  '原油',
]

/** 板块 id → 资讯标签名（同时用于按板块筛资讯）。 */
export const BOARD_NEWS_TAGS = {
  cffex: '中金所',
  black: '黑色',
  chem: '能化',
  nonferrous: '有色',
  agri: '农产品',
  precious: '贵金属',
  newenergy: '新能源',
  other: '其他',
  energy: '能源',
}

/**
 * 一条快讯命中了哪些板块（可能多个，比如「原油带动化工」）。
 * @param {string} text
 * @returns {string[]} 板块 id 列表
 */
export function newsBoardsFor(text) {
  const out = []
  if (cffexNewsRelevant(text)) out.push('cffex')
  if (BLACK_NEWS_KEYWORDS.some((k) => text.includes(k))) out.push('black')
  if (CHEM_NEWS_KEYWORDS.some((k) => text.includes(k))) out.push('chem')
  // 金十的「期货热点追踪」是多品种综述，黑色/能化都值得看
  if (text.includes('期货热点') && !out.includes('black')) out.push('black')
  if (text.includes('期货热点') && !out.includes('chem')) out.push('chem')
  return out
}

/* ───────────── 航运：SCFIS 欧线结算运价指数（上海航交所） ───────────── */

/** 上海航交所 SCFIS 页面。 */
export const SCFIS_URL = 'https://www.sse.net.cn/index/singleIndex?indexType=scfis'

/**
 * 解析 SCFIS 页面里的「欧洲航线」本期值与日期。
 * @param {string} html
 * @returns {{date: string, value: number}|null}
 */
export function parseScfis(html) {
  const date = /本期[\s\S]{0,300}?(\d{4}-\d{2}-\d{2})/u.exec(html)?.[1]
  if (date === undefined) return null
  const rows = html.match(/<tr[\s\S]{0,500}?<\/tr>/gu) ?? []
  for (const row of rows) {
    const text = row.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim()
    if (!text.includes('欧洲航线')) continue
    // 「欧洲航线（基本港）… 点 2198.66 -4.6」
    const nums = text.match(/\d+(?:\.\d+)?/gu) ?? []
    const values = nums.map(Number).filter((n) => Number.isFinite(n) && n > 100)
    if (values.length === 0) continue
    return { date, value: values[0] }
  }
  return null
}

/**
 * 抓 SCFIS 最新一期（周度）。
 * @returns {Promise<{date: string, value: number}>}
 */
export async function scfisLatest() {
  const html = await getText(SCFIS_URL, {
    headers: {
      Referer: 'https://www.sse.net.cn/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    },
    timeoutMs: 15000,
  })
  const parsed = parseScfis(html)
  if (parsed === null) throw new Error('SCFIS 页面解析失败')
  return parsed
}

/** 各板块的资讯关键词（金十快讯打标用）。 */
export const BOARD_KEYWORDS = {
  black: BLACK_NEWS_KEYWORDS,
  chem: CHEM_NEWS_KEYWORDS,
  nonferrous: ['铜', '铝', '锌', '镍', '锡', '铅', '氧化铝', '电解铝', '冶炼', '矿端', '铜价', '铝价', 'LME', '智利', '印尼', '有色'],
  agri: ['白糖', '棉花', '棉纱', '玉米', '淀粉', '鸡蛋', '生猪', '红枣', '苹果', '花生', '菜籽', '种植', '产量', '抛储', '糖醇', '甘蔗', '甜菜', '猪价', '蛋价', '养殖', '大豆', '豆粕', '豆油', '棕榈油', '菜籽', '菜油', '菜粕', '油脂'],
  precious: ['黄金', '白银', '铂', '钯', '金价', '银价', '美联储', '非农', 'CPI', 'PPI', '美元', '降息', '加息', '地缘', '避险', '实际利率'],
  newenergy: ['碳酸锂', '氢氧化锂', '锂', '工业硅', '硅料', '多晶硅', '储能', '新能源车', '正极', '负极', '盐湖', '光伏', '电池'],
  other: ['集运', '运价', '欧线', 'SCFIS', '红海', '苏伊士', '巴拿马', '港口', '运力', '集装箱', '马士基', 'MSC', '达飞', '赫伯罗特', '航运', '运费', '出口集装箱', '订舱', '运价指数', '停航', '跳港', '欧地', '美西', '美东'],
  energy: ['原油', '油价', 'OPEC', '减产', '燃料油', '低硫', '高硫', '船燃', '裂解', '柴油', '汽油', '液化气', 'LPG', '天然气', '炼厂'],
}

/**
 * 一条快讯命中的板块（可能多个）。
 * @param {string} text
 * @returns {string[]}
 */
export function newsBoardsForMulti(text) {
  const out = []
  if (cffexNewsRelevant(text)) out.push('cffex')
  for (const [board, keywords] of Object.entries(BOARD_KEYWORDS)) {
    if (keywords.some((k) => text.includes(k))) out.push(board)
  }
  if (text.includes('期货热点')) {
    for (const b of ['black', 'chem', 'nonferrous', 'agri', 'newenergy']) {
      if (!out.includes(b)) out.push(b)
    }
  }
  return out
}

/* ───────────── 能源：Brent 与汇率（内外价差折算用） ───────────── */

/** 新浪外盘 Brent 日线。 */
export const BRENT_DAILY_URL =
  'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=OIL'

/**
 * 解析新浪外盘日线（date/open/high/low/close）。
 * @param {string} text
 * @returns {Array<{d: string, c: number}>}
 */
export function parseGlobalDaily(text) {
  const m = /var\s+_=\((\[[\s\S]*?\])\)/u.exec(text)
  if (m === null) return []
  let rows = []
  try {
    rows = JSON.parse(m[1])
  } catch {
    return []
  }
  const out = []
  for (const row of rows) {
    const d = String(row?.date ?? '')
    const c = Number(row?.close)
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(d) || !Number.isFinite(c) || c <= 0) continue
    out.push({ d, c })
  }
  return out.sort((a, b) => a.d.localeCompare(b.d))
}

/**
 * 抓 Brent 日线（2016 至今）。
 * @returns {Promise<Array<{d: string, c: number}>>}
 */
export async function brentDaily() {
  const text = await getText(BRENT_DAILY_URL, {
    headers: { Referer: 'https://finance.sina.com.cn' },
    timeoutMs: 20000,
  })
  return parseGlobalDaily(text)
}

/**
 * 解析外盘/汇率快照。
 * @param {string} brentText
 * @param {string} fxText
 * @returns {{brent: number, usdcny: number}|null}
 */
export function parseEnergyRef(brentText, fxText) {
  const brent = Number(/hq_str_hf_OIL="([^,]*)/u.exec(brentText)?.[1])
  // 新浪外汇：时间,现汇买入,现钞买入,现汇卖出,现钞卖出,…
  const usdcny = Number(/hq_str_fx_susdcny="[^,]*,([^,]*)/u.exec(fxText)?.[1])
  if (!Number.isFinite(brent) || brent <= 0 || !Number.isFinite(usdcny) || usdcny <= 0) return null
  return { brent, usdcny }
}

/**
 * 抓 Brent 与 USD/CNY 最新值（用于折算能源现货）。
 * @returns {Promise<{brent: number, usdcny: number}>}
 */
export async function energyRef() {
  const headers = { Referer: 'https://finance.sina.com.cn' }
  const [brentText, fxText] = await Promise.all([
    getText('https://hq.sinajs.cn/list=hf_OIL', { headers, encoding: 'gb18030', timeoutMs: 10000 }),
    getText('https://hq.sinajs.cn/list=fx_susdcny', { headers, encoding: 'gb18030', timeoutMs: 10000 }),
  ])
  const parsed = parseEnergyRef(brentText, fxText)
  if (parsed === null) throw new Error('Brent/汇率快照解析失败')
  return parsed
}

/**
 * 解析 frankfurter.dev（ECB 参考汇率）区间响应。
 * @param {any} json
 * @returns {Array<{d: string, c: number}>}
 */
export function parseFrankfurter(json) {
  const rates = json?.rates
  if (rates === null || typeof rates !== 'object') return []
  const out = []
  for (const [d, v] of Object.entries(rates)) {
    const c = Number(v?.CNY)
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(d) || !Number.isFinite(c) || c <= 0) continue
    out.push({ d, c })
  }
  return out.sort((a, b) => a.d.localeCompare(b.d))
}

/**
 * 抓 USD/CNY 历史（ECB 参考价，免费无 key）。
 * 注意：这是参考汇率，不是在岸中间价，和实时新浪价可能有零点几个百分点差异。
 *
 * @param {string} from YYYY-MM-DD
 * @param {string} [to] 默认今天
 * @returns {Promise<Array<{d: string, c: number}>>}
 */
export async function fxDaily(from, to = new Date().toISOString().slice(0, 10)) {
  const url = `https://api.frankfurter.dev/v1/${from}..${to}?base=USD&symbols=CNY`
  const json = await getJson(url, { timeoutMs: 20000 })
  return parseFrankfurter(json)
}

/* ───────────── 补充资讯源：东财期货首页 + 新浪财经直播 ───────────── */

/** 东财期货首页（含各品种要闻列表）。 */
export const EM_FUTURES_URL = 'https://futures.eastmoney.com/'

/**
 * 解析东财资讯链接：文章 URL 里带 yyyymmdd，可反推发布日期。
 * @param {string} html
 * @returns {Array<{id: string, title: string, url: string, time: string, tags: string[]}>}
 */
export function parseEastmoneyFuturesNews(html) {
  const out = []
  const seen = new Set()
  const re = /<a[^>]+href="(https:\/\/finance\.eastmoney\.com\/a\/(\d{8})\d+\.html)"[^>]*>([^<]{6,120})<\/a>/gu
  for (const m of html.matchAll(re)) {
    const [, url, day, rawTitle] = m
    if (seen.has(url)) continue
    const title = rawTitle.replace(/\s+/gu, ' ').trim()
    if (title.length < 6) continue
    seen.add(url)
    const y = day.slice(0, 4)
    const mo = day.slice(4, 6)
    const d = day.slice(6, 8)
    out.push({
      id: `em-${day}-${url.slice(-6)}`,
      title,
      url,
      time: `${y}-${mo}-${d}T09:00:00+08:00`,
      tags: [],
    })
  }
  return out
}

/** 抓东财期货首页要闻。 */
export async function eastmoneyFuturesNews() {
  const html = await getText(EM_FUTURES_URL, {
    headers: { Referer: 'https://futures.eastmoney.com/', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
    timeoutMs: 20000,
  })
  return parseEastmoneyFuturesNews(html)
}

/** 新浪财经 7×24 直播（zhibo_id=152 财经）。 */
export const SINA_LIVE_URL =
  'https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=60&zhibo_id=152&tag_id=0&dire=f&dpc=1'

/**
 * 解析新浪直播 feed。
 * @param {string} text
 * @returns {Array<{id: string, title: string, url: string, time: string, tags: string[]}>}
 */
export function parseSinaLive(text) {
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    return []
  }
  const list = json?.result?.data?.feed?.list ?? []
  const out = []
  for (const item of list) {
    const raw = String(item?.rich_text ?? '')
      .replace(/<[^>]+>/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
    if (raw.length < 6) continue
    const created = String(item?.create_time ?? '')
    const time = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u.test(created)
      ? `${created.slice(0, 10)}T${created.slice(11, 16)}:00+08:00`
      : new Date().toISOString()
    out.push({
      id: `sina-${item?.id ?? raw.slice(0, 12)}`,
      title: raw.length > 120 ? `${raw.slice(0, 120)}…` : raw,
      url: String(item?.docurl ?? 'https://finance.sina.com.cn/7x24/'),
      time,
      tags: [],
    })
  }
  return out
}

/** 抓新浪财经直播。 */
export async function sinaLiveNews() {
  const text = await getText(SINA_LIVE_URL, {
    headers: { Referer: 'https://finance.sina.com.cn/7x24/', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
    timeoutMs: 20000,
  })
  return parseSinaLive(text)
}
