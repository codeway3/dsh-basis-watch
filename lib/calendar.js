/**
 * 交易日历（中国大陆期货市场）。
 *
 * 规则：**周六周日一律休市**（期货不搞周末调休交易），法定节假日休市。
 * 因此只需要"工作日 + 非法定节假日"两个条件。
 *
 * 数据来源：国务院办公厅节假日安排通知（2024–2027 已发布，逐年补充）。
 * 覆盖范围之外只按周末判断，并在 calendarInfo() 里标记 covered=false，
 * 避免悄悄把未知年份当成正常交易日。
 *
 * @module dsh-basis-watch/lib/calendar
 */

/**
 * 休市日 → 节日名。只登记落在工作日、真正影响交易的日期；
 * 落在周末的放假日已由"周末休市"覆盖，不必重复登记。
 * @type {Record<string, string>}
 */
export const HOLIDAYS = {
  // 2024
  '2024-01-01': '元旦',
  '2024-02-12': '春节',
  '2024-02-13': '春节',
  '2024-02-14': '春节',
  '2024-02-15': '春节',
  '2024-02-16': '春节',
  '2024-04-04': '清明',
  '2024-04-05': '清明',
  '2024-05-01': '劳动节',
  '2024-05-02': '劳动节',
  '2024-05-03': '劳动节',
  '2024-06-10': '端午',
  '2024-09-16': '中秋',
  '2024-09-17': '中秋',
  '2024-10-01': '国庆',
  '2024-10-02': '国庆',
  '2024-10-03': '国庆',
  '2024-10-04': '国庆',
  '2024-10-07': '国庆',
  // 2025
  '2025-01-01': '元旦',
  '2025-01-28': '春节',
  '2025-01-29': '春节',
  '2025-01-30': '春节',
  '2025-01-31': '春节',
  '2025-02-03': '春节',
  '2025-02-04': '春节',
  '2025-04-04': '清明',
  '2025-05-01': '劳动节',
  '2025-05-02': '劳动节',
  '2025-05-05': '劳动节',
  '2025-06-02': '端午',
  '2025-10-01': '国庆',
  '2025-10-02': '国庆',
  '2025-10-03': '国庆',
  '2025-10-06': '国庆',
  '2025-10-07': '国庆',
  '2025-10-08': '国庆',
  // 2026（国办发明电〔2025〕7号）
  '2026-01-01': '元旦',
  '2026-01-02': '元旦',
  '2026-02-16': '春节',
  '2026-02-17': '春节',
  '2026-02-18': '春节',
  '2026-02-19': '春节',
  '2026-02-20': '春节',
  '2026-02-23': '春节',
  '2026-04-06': '清明',
  '2026-05-01': '劳动节',
  '2026-05-04': '劳动节',
  '2026-05-05': '劳动节',
  '2026-06-19': '端午',
  '2026-09-25': '中秋',
  '2026-10-01': '国庆',
  '2026-10-02': '国庆',
  '2026-10-05': '国庆',
  '2026-10-06': '国庆',
  '2026-10-07': '国庆',
  // 2027（国办发明电〔2026〕10号，2026-11-05 发布）
  // 调休上班日（1/31、2/14、5/8、9/26、10/9）都落在周末，期货本来就不交易，
  // 因此这里只登记落在工作日、真正减少交易日的日期。
  '2027-01-01': '元旦',
  '2027-02-05': '春节',
  '2027-02-08': '春节',
  '2027-02-09': '春节',
  '2027-02-10': '春节',
  '2027-02-11': '春节',
  '2027-02-12': '春节',
  '2027-04-05': '清明',
  '2027-05-03': '劳动节',
  '2027-05-04': '劳动节',
  '2027-05-05': '劳动节',
  '2027-06-09': '端午',
  '2027-09-15': '中秋',
  '2027-10-01': '国庆',
  '2027-10-04': '国庆',
  '2027-10-05': '国庆',
  '2027-10-06': '国庆',
  '2027-10-07': '国庆',
}

/** 日历已覆盖的区间（超出后仅按周末判断）。 */
export const COVERAGE = { from: '2024-01-01', to: '2027-12-31' }

/**
 * 本地日期字符串（固定 Asia/Shanghai，避免宿主时区不同导致跨日）。
 *
 * @param {Date} [date]
 * @returns {string} YYYY-MM-DD
 */
export function localDate(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(date)
}

/**
 * 任意时刻换算成"北京时间的一天内分钟数"（宿主时区不影响）。
 * 调度器判断 15:10 / 16:40 这类时刻必须用它，不能用 date.getHours()。
 *
 * @param {Date} [date]
 * @returns {number} 0..1439
 */
export function shanghaiMinutes(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  })
  const [h, m] = fmt.format(date).split(':').map(Number)
  return h * 60 + m
}

/**
 * 纯字符串日期加减（不经过 Date 对象，杜绝时区/夏令时干扰）。
 *
 * @param {string} date YYYY-MM-DD
 * @param {number} days 可正可负
 * @returns {string} YYYY-MM-DD
 */
export function addDays(date, days) {
  const [y, m, d] = String(date).split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d) + days * 86400000
  const dt = new Date(ms)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

/**
 * 判断是否交易日，并给出原因。
 *
 * @param {string|Date} [value] YYYY-MM-DD 或 Date
 * @returns {{trading: boolean, reason: 'weekend'|'holiday'|null, holiday: string|null, covered: boolean, date: string}}
 */
export function calendarInfo(value = new Date()) {
  const date = typeof value === 'string' ? value : localDate(value)
  const [y, m, d] = date.split('-').map(Number)
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  const covered = date >= COVERAGE.from && date <= COVERAGE.to
  if (weekday === 0 || weekday === 6) {
    return { trading: false, reason: 'weekend', holiday: null, covered, date }
  }
  const holiday = HOLIDAYS[date] ?? null
  if (holiday !== null) return { trading: false, reason: 'holiday', holiday, covered, date }
  return { trading: true, reason: null, holiday: null, covered, date }
}

/**
 * 是否交易日。
 * @param {string|Date} [value]
 * @returns {boolean}
 */
export function isTradingDay(value = new Date()) {
  return calendarInfo(value).trading
}

/**
 * 下一个交易日（含当天）。
 * @param {string|Date} [value]
 * @returns {string} YYYY-MM-DD
 */
export function nextTradingDay(value = new Date()) {
  let date = typeof value === 'string' ? value : localDate(value)
  for (let i = 0; i < 30; i += 1) {
    if (isTradingDay(date)) return date
    date = addDays(date, 1)
  }
  return date
}

/**
 * 上一个交易日（不含当天）。
 * @param {string|Date} [value]
 * @returns {string}
 */
export function prevTradingDay(value = new Date()) {
  let date = typeof value === 'string' ? value : localDate(value)
  for (let i = 0; i < 30; i += 1) {
    date = addDays(date, -1)
    if (isTradingDay(date)) return date
  }
  return date
}

/**
 * 两个日期之间的交易日列表。
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
export function tradingDaysBetween(from, to) {
  const out = []
  let date = from
  for (let i = 0; i < 4000 && date <= to; i += 1) {
    if (isTradingDay(date)) out.push(date)
    date = addDays(date, 1)
  }
  return out
}

/**
 * 中金所合约最后交易日。
 *
 * - 股指期货：合约到期月份的**第三个周五**（遇法定假日顺延）
 * - 国债期货：合约到期月份的**第二个周五**（遇法定假日顺延）
 *
 * @param {'stock'|'bond'} kind
 * @param {number} year
 * @param {number} month 1..12
 * @returns {string} YYYY-MM-DD
 */
export function cffexLastTradingDay(kind, year, month) {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const firstFriday = 1 + ((5 - firstWeekday + 7) % 7)
  const day = firstFriday + (kind === 'bond' ? 7 : 14)
  const pad = (n) => String(n).padStart(2, '0')
  let date = `${year}-${pad(month)}-${pad(day)}`
  // 遇法定假日顺延：中金所规则如此，交易日历覆盖范围内可精确判断
  for (let i = 0; i < 10 && !isTradingDay(date); i += 1) date = addDays(date, 1)
  return date
}

/**
 * 从合约代码推最后交易日：`IF2612` → 2026-12-18（第三个周五）。
 * @param {'stock'|'bond'} kind
 * @param {string} code
 * @returns {string|null}
 */
export function expiryOfContract(kind, code) {
  const m = /(\d{2})(\d{2})$/u.exec(String(code))
  if (m === null) return null
  const year = 2000 + Number(m[1])
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  return cffexLastTradingDay(kind, year, month)
}

/**
 * 两个 YYYY-MM-DD 之间的自然日天数（UTC 计算）。
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)
}
