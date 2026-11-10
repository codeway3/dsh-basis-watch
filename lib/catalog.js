/**
 * 品种目录（唯一事实来源）
 *
 * 为什么把"即将上市"也写进目录：葵花籽油期货 2026-11-12 上市，
 * 如果等上市后再加，第一天的行情/仓单就永久缺失，以后做不了分位。
 * 所以这里预置 status='upcoming' + listDate，加载时按日期自动转为 active。
 *
 * @module dsh-basis-watch/lib/catalog
 */

/** 一个品种的静态描述。 */
/**
 * @typedef {object} Variety
 * @property {string} code      新浪主连代码（如 M0），也是本地文件名
 * @property {string} name      中文名
 * @property {string} exchange  DCE / CZCE
 * @property {string} status    active | upcoming
 * @property {string} [listDate] 上市日（upcoming 时必填，YYYY-MM-DD）
 * @property {number[]} months  挂牌月份，用于跨期曲线
 * @property {string[]} spotKeys 生意社现期表里的品名（可能有多个写法）
 * @property {string} [note]    展示用备注
 */

/** @type {Variety[]} */
export const CATALOG = [
  {
    code: 'M0',
    name: '豆粕',
    exchange: 'DCE',
    status: 'active',
    months: [1, 3, 5, 7, 9, 11],
    spotKeys: ['豆粕'],
  },
  {
    code: 'Y0',
    name: '豆油',
    exchange: 'DCE',
    status: 'active',
    months: [1, 3, 5, 7, 9, 11],
    spotKeys: ['豆油'],
  },
  {
    code: 'P0',
    name: '棕榈油',
    exchange: 'DCE',
    status: 'active',
    months: [1, 3, 5, 7, 9, 11],
    spotKeys: ['棕榈油'],
  },
  {
    code: 'OI0',
    name: '菜油',
    exchange: 'CZCE',
    status: 'active',
    months: [1, 3, 5, 7, 9, 11],
    spotKeys: ['菜籽油OI', '菜籽油', '菜油'],
  },
  {
    code: 'RM0',
    name: '菜粕',
    exchange: 'CZCE',
    status: 'active',
    months: [1, 3, 5, 7, 9, 11],
    // 生意社现期表里的品名是「菜籽粕」，不是「菜粕」
    spotKeys: ['菜籽粕', '菜粕'],
  },
  {
    code: 'A0',
    name: '豆一',
    exchange: 'DCE',
    status: 'active',
    months: [1, 3, 5, 7, 9, 11],
    spotKeys: ['豆一'],
  },
  {
    code: 'B0',
    name: '豆二',
    exchange: 'DCE',
    status: 'active',
    months: [1, 3, 5, 7, 9, 11],
    spotKeys: ['豆二'],
  },
  {
    // 2026-11-12 上市；首批合约 SO2705/SO2707/SO2709/SO2711（只有 5/7/9/11）
    code: 'SO0',
    name: '葵油',
    exchange: 'CZCE',
    status: 'upcoming',
    listDate: '2026-11-12',
    months: [5, 7, 9, 11],
    /**
     * 首个挂牌合约：新品不会自动补齐当月之前的月份，
     * 不写这个字段就会算出不存在的 SO2611。
     */
    firstContract: 'SO2705',
    /**
     * 现货源：生意社现期表没有葵花籽油，改用 Mysteel 免费报价页（多地均价）。
     * 该源是贸易商报价聚合，不是交易所现货基准，页面上必须标注。
     */
    spotSource: 'mysteel-sunflower',
    // 生意社现期表目前没有葵花籽油 → 基差暂不可算，页面需明确标注
    spotKeys: [],
    note: '现货源待接入（生意社现期表无葵花籽油）',
  },
]

/**
 * 按当前时间解析品种目录：到了上市日的 upcoming 自动变成 active。
 * @param {Date|number} [now]
 * @returns {Variety[]} 每项附加 effectiveStatus
 */
export function resolveCatalog(now = Date.now()) {
  const ts = typeof now === 'number' ? now : now.getTime()
  return CATALOG.map((v) => {
    if (v.status !== 'upcoming' || v.listDate === undefined) return { ...v, effectiveStatus: v.status }
    // 上市日当天 00:00 起即可抓取（首批合约当日开盘，但日线当晚才有）
    const listed = Date.parse(`${v.listDate}T00:00:00+08:00`) <= ts
    return { ...v, effectiveStatus: listed ? 'active' : 'upcoming' }
  })
}

/**
 * 当前应抓取的品种（active，含已到上市日的 upcoming）。
 * @param {Date|number} [now]
 * @returns {Variety[]}
 */
export function activeVarieties(now = Date.now()) {
  return resolveCatalog(now).filter((v) => v.effectiveStatus === 'active')
}

/**
 * 尚未上市的品种。
 * @param {Date|number} [now]
 * @returns {Variety[]}
 */
export function upcomingVarieties(now = Date.now()) {
  return resolveCatalog(now).filter((v) => v.effectiveStatus === 'upcoming')
}

/**
 * 按代码查品种（支持 M0 / M 两种写法）。
 * @param {string} code
 * @returns {Variety|undefined}
 */
export function varietyOf(code) {
  const upper = String(code).toUpperCase()
  return CATALOG.find((v) => v.code === upper || v.code.replace(/0$/, '') === upper)
}

/**
 * 生成某品种在指定年月附近的主力候选合约代码（用于跨期/月差）。
 * 大商所/郑商所都是 4 位年月：2701 = 2027 年 1 月。
 * @param {Variety} variety
 * @param {Date|number} [now]
 * @param {number} [count] 向后取几个合约
 * @returns {string[]} 如 ['M2701','M2703',...]
 */
export function contractCodes(variety, now = Date.now(), count = 4) {
  const d = new Date(typeof now === 'number' ? now : now.getTime())
  const base = variety.code.replace(/0$/, '')
  let year = d.getFullYear()
  let month = d.getMonth() + 1
  // 新品种：从首个挂牌合约开始，绝不生成挂牌之前的月份
  if (variety.firstContract !== undefined) {
    const fy = 2000 + Number(variety.firstContract.slice(-4, -2))
    const fm = Number(variety.firstContract.slice(-2))
    if (fy * 100 + fm > year * 100 + month) {
      year = fy
      month = fm
    }
  }
  const out = []
  for (let guard = 0; guard < 60 && out.length < count; guard += 1) {
    const idx = variety.months.findIndex((m) => m >= month)
    if (idx === -1) {
      // 本年剩下的月份都过了，跳到明年
      year += 1
      month = 1
      continue
    }
    const useMonth = variety.months[idx]
    out.push(`${base}${String(year % 100).padStart(2, '0')}${String(useMonth).padStart(2, '0')}`)
    month = useMonth + 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return out
}
