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
 * @property {string} code      新浪主连代码（如 M0 / IF0），也是本地文件名
 * @property {string} name      中文名
 * @property {string} exchange  DCE / CZCE / CFFEX / SHFE / GFEX / INE
 * @property {'oil'|'cffex'} board 所属板块
 * @property {string} status    active | upcoming
 * @property {string} [listDate] 上市日（upcoming 时必填，YYYY-MM-DD）
 * @property {number[]} months  挂牌月份，用于跨期曲线
 * @property {string[]} spotKeys 生意社现期表里的品名（可能有多个写法）
 * @property {'spot-future'|'future-index'|'none'} [basisMode] 基差口径
 * @property {string} [indexCode] 股指对应的现货指数（新浪 sh000300 等）
 * @property {'stock'|'bond'} [kind] 中金所的品种类型
 * @property {string} [note]    展示用备注
 */

/**
 * 板块定义：板块是"页面级上下文"——它决定基差口径、有没有仓单、资讯来源。
 * UI 的板块切换放在最外层（标题行），切换后所有页签都在该板块下工作。
 */
export const BOARDS = [
  { id: 'oil', name: '油脂油料', short: '油脂油料', note: '商品 · 现货基差' },
  { id: 'black', name: '黑色', short: '黑色', note: '商品 · 螺纹/铁矿/双焦/铁合金' },
  { id: 'chem', name: '能化', short: '能化', note: '商品 · 聚酯/聚烯烃/盐化工' },
  // 有色 → 贵金属 → 能源 相邻：都受宏观/美元/实际利率驱动，放一起方便横向看
  { id: 'nonferrous', name: '有色', short: '有色', note: '商品 · 铜铝锌镍锡铅' },
  { id: 'precious', name: '贵金属', short: '贵金属', note: '商品 · 黄金/白银/铂钯' },
  { id: 'energy', name: '能源', short: '能源', note: '原油/燃料油/LPG · Brent 折算内外价差' },
  { id: 'agri', name: '农产品', short: '农产品', note: '商品 · 白糖/棉花/玉米' },
  { id: 'newenergy', name: '新能源', short: '新能源', note: '广期所 · 碳酸锂/工业硅/多晶硅/氢氧化锂' },
  { id: 'other', name: '其他', short: '其他', note: '关联度较低的品种 · 当前：集运欧线' },
  { id: 'cffex', name: '中金所', short: '中金所', note: '金融 · 期指升贴水 / 国债期限结构' },
]

/**
 * 按 id 取板块信息。
 * @param {string} id
 * @returns {{id: string, name: string, short: string, note: string}|undefined}
 */
export function boardOf(id) {
  return BOARDS.find((b) => b.id === id)
}

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
  /* ───── 黑色（现货来自生意社现期表，元/吨口径与期货一致） ───── */
  {
    code: 'RB0',
    name: '螺纹钢',
    exchange: 'SHFE',
    board: 'black',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['螺纹钢'],
  },
  {
    code: 'HC0',
    name: '热卷',
    exchange: 'SHFE',
    board: 'black',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['热轧卷板', '热卷'],
  },
  {
    code: 'I0',
    name: '铁矿石',
    exchange: 'DCE',
    board: 'black',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['铁矿石'],
  },
  {
    code: 'J0',
    name: '焦炭',
    exchange: 'DCE',
    board: 'black',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['焦炭'],
  },
  {
    code: 'SF0',
    name: '硅铁',
    exchange: 'CZCE',
    board: 'black',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['硅铁'],
  },
  {
    code: 'SM0',
    name: '锰硅',
    exchange: 'CZCE',
    board: 'black',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['锰硅'],
  },
  {
    code: 'SS0',
    name: '不锈钢',
    exchange: 'SHFE',
    board: 'black',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['不锈钢'],
  },
  /* ───── 能化（同样只收单位/品级可比的品种） ───── */
  {
    code: 'TA0',
    name: 'PTA',
    exchange: 'CZCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['PTA'],
  },
  {
    code: 'MA0',
    name: '甲醇',
    exchange: 'CZCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    // 生意社品名是「甲醇MA」
    spotKeys: ['甲醇MA', '甲醇'],
  },
  {
    code: 'UR0',
    name: '尿素',
    exchange: 'CZCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['尿素'],
  },
  {
    code: 'SA0',
    name: '纯碱',
    exchange: 'CZCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['纯碱'],
  },
  {
    code: 'PX0',
    name: 'PX',
    exchange: 'CZCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['PX'],
  },
  {
    code: 'PF0',
    name: '短纤',
    exchange: 'CZCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['涤纶短纤', '短纤'],
  },
  {
    code: 'PR0',
    name: '瓶片',
    exchange: 'CZCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['瓶片'],
  },
  {
    code: 'L0',
    name: '塑料',
    exchange: 'DCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['聚乙烯', '塑料'],
  },
  {
    code: 'PP0',
    name: '聚丙烯',
    exchange: 'DCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['聚丙烯'],
  },
  {
    code: 'V0',
    name: 'PVC',
    exchange: 'DCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['聚氯乙烯', 'PVC'],
  },
  {
    code: 'EG0',
    name: '乙二醇',
    exchange: 'DCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['乙二醇'],
  },
  {
    code: 'EB0',
    name: '苯乙烯',
    exchange: 'DCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['苯乙烯'],
  },
  {
    code: 'PG0',
    name: '液化气',
    exchange: 'DCE',
    board: 'energy',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['液化石油气', '液化气'],
  },
  {
    code: 'RU0',
    name: '橡胶',
    exchange: 'SHFE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['天然橡胶', '橡胶'],
  },
  {
    code: 'SP0',
    name: '纸浆',
    exchange: 'SHFE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['纸浆'],
  },
  {
    code: 'BZ0',
    name: '纯苯',
    exchange: 'DCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['纯苯'],
  },
  {
    code: 'BR0',
    name: '丁二烯橡胶',
    exchange: 'SHFE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['丁二烯橡胶'],
  },
  /* ───── 有色（现货含税价与期货同单位，元/吨） ───── */
  {
    code: 'CU0',
    name: '铜',
    exchange: 'SHFE',
    board: 'nonferrous',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['铜'],
  },
  {
    code: 'AL0',
    name: '铝',
    exchange: 'SHFE',
    board: 'nonferrous',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['铝'],
  },
  {
    code: 'ZN0',
    name: '锌',
    exchange: 'SHFE',
    board: 'nonferrous',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['锌'],
  },
  {
    code: 'NI0',
    name: '镍',
    exchange: 'SHFE',
    board: 'nonferrous',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['镍'],
  },
  {
    code: 'SN0',
    name: '锡',
    exchange: 'SHFE',
    board: 'nonferrous',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['锡'],
  },
  {
    code: 'PB0',
    name: '铅',
    exchange: 'SHFE',
    board: 'nonferrous',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['铅'],
  },
  /* ───── 农产品（谷物/软商品；鸡蛋生猪因单位不同暂不收） ───── */
  {
    code: 'SR0',
    name: '白糖',
    exchange: 'CZCE',
    board: 'agri',
    status: 'active',
    months: [1, 3, 5, 7, 9, 11],
    spotKeys: ['白糖'],
  },
  {
    code: 'CF0',
    name: '棉花',
    exchange: 'CZCE',
    board: 'agri',
    status: 'active',
    months: [1, 3, 5, 7, 9, 11],
    // 生意社棉花现货（3128B）与期货标的存在品级/地区差，基差水平偏高
    spotKeys: ['棉花'],
    note: '现货 3128B 与期货标的有品级差',
  },
  {
    code: 'CY0',
    name: '棉纱',
    exchange: 'CZCE',
    board: 'agri',
    status: 'active',
    months: [1, 3, 5, 7, 9, 11],
    spotKeys: ['棉纱'],
    note: '现货普梳 32S 与期货标的有品级差',
  },
  {
    code: 'C0',
    name: '玉米',
    exchange: 'DCE',
    board: 'agri',
    status: 'active',
    months: [1, 3, 5, 7, 9, 11],
    spotKeys: ['玉米'],
  },
  /* ───── 贵金属 ───── */
  {
    code: 'AU0',
    name: '黄金',
    exchange: 'SHFE',
    board: 'precious',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['黄金'],
  },
  {
    code: 'AG0',
    name: '白银',
    exchange: 'SHFE',
    board: 'precious',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['白银'],
  },
  /* ───── 新能源（广期所） ───── */
  {
    code: 'LC0',
    name: '碳酸锂',
    exchange: 'GFEX',
    board: 'newenergy',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['碳酸锂'],
  },
  {
    code: 'SI0',
    name: '工业硅',
    exchange: 'GFEX',
    board: 'newenergy',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    // 工业硅现货 553/421 品级与期货基准不同，基差水平偏高
    spotKeys: ['工业硅'],
    note: '现货 553 与期货基准有品级差',
  },
  /* ───── 能源（国内没有可比现货，用 Brent×汇率折算做「内外价差」） ───── */
  {
    code: 'SC0',
    name: '原油',
    exchange: 'INE',
    board: 'energy',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: [],
    spotSource: 'brent',
    brentFactor: 1,
    basisLabel: '内外价差',
    note: '现货 = Brent×汇率（元/桶），不是国内现货报价',
  },
  {
    code: 'FU0',
    name: '燃料油',
    exchange: 'SHFE',
    board: 'energy',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: [],
    spotSource: 'brent',
    // 燃料油 1 吨 ≈ 6.35 桶
    brentFactor: 6.35,
    basisLabel: '裂解价差',
    note: '现货 = Brent×汇率×6.35（元/吨），高硫燃料油折算',
  },
  {
    code: 'LU0',
    name: '低硫燃料油',
    exchange: 'INE',
    board: 'energy',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: [],
    spotSource: 'brent',
    brentFactor: 6.35,
    basisLabel: '裂解价差',
    note: '现货 = Brent×汇率×6.35（元/吨），低硫燃料油折算',
  },
  /* ───── 其他（现货 = SCFIS 欧线结算运价指数，周度） ───── */
  {
    code: 'EC0',
    name: '集运欧线',
    exchange: 'INE',
    board: 'other',
    status: 'active',
    months: [2, 4, 6, 8, 10, 12],
    spotKeys: [],
    // 不走生意社现期表：现货是上海航交所 SCFIS 欧线指数
    spotSource: 'scfis',
    basisLabel: 'SCFIS价差',
    note: '现货 = SCFIS 欧线（周度）',
  },
  /* ───── 补全：能化/农产品/有色/黑色/贵金属/新能源 的其余品种 ───── */
  {
    code: 'FG0',
    name: '玻璃',
    exchange: 'CZCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['玻璃'],
    // 现货按元/㎡ 报价，期货按元/吨；5mm 浮法玻璃 1 吨≈72㎡
    spotScale: 72,
    spotUnit: '元/㎡',
    note: '现货元/㎡×72 折算为元/吨（约 5mm 玻璃）',
  },
  {
    code: 'SH0',
    name: '烧碱',
    exchange: 'CZCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: [],
    basisMode: 'none',
    noBasisReason: '现货是 32% 液碱（湿基）报价，与期货折百口径不一致，不做基差',
  },
  {
    code: 'BU0',
    name: '石油沥青',
    exchange: 'SHFE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['石油沥青', '沥青'],
    note: '现货为华东重交沥青，与期货标的有品级/地区差',
  },
  {
    code: 'PL0',
    name: '丙烯',
    exchange: 'CZCE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['丙烯'],
  },
  {
    code: 'JD0',
    name: '鸡蛋',
    exchange: 'DCE',
    board: 'agri',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['鸡蛋'],
    // 现货元/公斤 → 期货元/500kg
    spotScale: 500,
    spotUnit: '元/公斤',
    note: '现货元/公斤×500 折算为元/500kg',
  },
  {
    code: 'LH0',
    name: '生猪',
    exchange: 'DCE',
    board: 'agri',
    status: 'active',
    months: [1, 3, 5, 7, 9, 11],
    spotKeys: ['生猪'],
    spotScale: 1000,
    spotUnit: '元/公斤',
    note: '现货元/公斤×1000 折算为元/吨',
  },
  {
    code: 'CJ0',
    name: '红枣',
    exchange: 'CZCE',
    board: 'agri',
    status: 'active',
    months: [1, 3, 5, 7, 9, 11],
    spotKeys: [],
    basisMode: 'none',
    noBasisReason: '生意社现期表没有红枣现货，暂不做基差',
  },
  {
    code: 'AP0',
    name: '苹果',
    exchange: 'CZCE',
    board: 'agri',
    status: 'active',
    months: [1, 3, 5, 7, 10, 11, 12],
    spotKeys: [],
    basisMode: 'none',
    noBasisReason: '生意社现期表没有苹果现货，暂不做基差',
  },
  {
    code: 'CS0',
    name: '玉米淀粉',
    exchange: 'DCE',
    board: 'agri',
    status: 'active',
    months: [1, 3, 5, 7, 9, 11],
    spotKeys: [],
    basisMode: 'none',
    noBasisReason: '没有免费的玉米淀粉现货源，暂不做基差',
  },
  {
    code: 'PK0',
    name: '花生',
    exchange: 'CZCE',
    board: 'agri',
    status: 'active',
    months: [1, 3, 4, 10, 11, 12],
    spotKeys: [],
    basisMode: 'none',
    noBasisReason: '没有免费的花生现货源，暂不做基差',
  },
  {
    code: 'AO0',
    name: '氧化铝',
    exchange: 'SHFE',
    board: 'nonferrous',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: [],
    basisMode: 'none',
    noBasisReason: '生意社现期表没有氧化铝现货，暂不做基差',
  },
  {
    code: 'BC0',
    name: '国际铜',
    exchange: 'INE',
    board: 'nonferrous',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: [],
    basisMode: 'none',
    noBasisReason: '国际铜是保税/不含税报价，与国内现货不同口径，不做基差',
  },
  {
    code: 'AD0',
    name: '铸造铝合金',
    exchange: 'SHFE',
    board: 'nonferrous',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: [],
    basisMode: 'none',
    noBasisReason: '没有免费的铸造铝合金现货源，暂不做基差',
  },
  {
    code: 'PT0',
    name: '铂',
    exchange: 'GFEX',
    board: 'precious',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: [],
    basisMode: 'none',
    noBasisReason: '国内没有自由流通的铂现货报价，暂不做基差',
  },
  {
    code: 'PD0',
    name: '钯',
    exchange: 'GFEX',
    board: 'precious',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: [],
    basisMode: 'none',
    noBasisReason: '国内没有自由流通的钯现货报价，暂不做基差',
  },
  {
    code: 'PS0',
    name: '多晶硅',
    exchange: 'GFEX',
    board: 'newenergy',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: ['多晶硅'],
    note: '现货致密料与期货基准有品级差，基差水平偏高',
  },
  {
    code: 'LI0',
    name: '氢氧化锂',
    exchange: 'GFEX',
    board: 'newenergy',
    // 广期所已发布合约（代码 LI，1 吨/手，1–12 月），上市时间另行通知；
    // 预留槽位：没有上市日，effectiveStatus 一直是 upcoming，不会被抓取
    status: 'upcoming',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: [],
    basisMode: 'none',
    noBasisReason: '氢氧化锂期货尚未上市（广期所合约已发布，交易代码 LI，上市时间待定）',
    note: '广期所 LI，1 吨/手，上市时间待定',
  },
  {
    code: 'NR0',
    name: '20号胶',
    exchange: 'INE',
    board: 'chem',
    status: 'active',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    spotKeys: [],
    basisMode: 'none',
    noBasisReason: '20号胶是保税/不含税报价，与国内全乳胶现货不同口径，不做基差',
  },
  /* ───── 中金所 · 股指期货（基差 = 期货 − 现货指数，贴水为负） ───── */
  {
    code: 'IF0',
    name: '沪深300',
    exchange: 'CFFEX',
    board: 'cffex',
    kind: 'stock',
    basisMode: 'future-index',
    indexCode: 'sh000300',
    status: 'active',
    months: [],
    spotKeys: [],
    note: '期指 · 标的 沪深300',
  },
  {
    code: 'IH0',
    name: '上证50',
    exchange: 'CFFEX',
    board: 'cffex',
    kind: 'stock',
    basisMode: 'future-index',
    indexCode: 'sh000016',
    status: 'active',
    months: [],
    spotKeys: [],
    note: '期指 · 标的 上证50',
  },
  {
    code: 'IC0',
    name: '中证500',
    exchange: 'CFFEX',
    board: 'cffex',
    kind: 'stock',
    basisMode: 'future-index',
    indexCode: 'sh000905',
    status: 'active',
    months: [],
    spotKeys: [],
    note: '期指 · 标的 中证500',
  },
  {
    code: 'IM0',
    name: '中证1000',
    exchange: 'CFFEX',
    board: 'cffex',
    kind: 'stock',
    basisMode: 'future-index',
    indexCode: 'sh000852',
    status: 'active',
    months: [],
    spotKeys: [],
    note: '期指 · 标的 中证1000',
  },
  /* ───── 中金所 · 国债期货（无现货基差，只做期限结构/跨期） ───── */
  {
    code: 'TS0',
    name: '2年期国债',
    exchange: 'CFFEX',
    board: 'cffex',
    kind: 'bond',
    basisMode: 'none',
    status: 'active',
    months: [3, 6, 9, 12],
    spotKeys: [],
    note: '国债 · 无 CTD/IRR 现货源',
  },
  {
    code: 'TF0',
    name: '5年期国债',
    exchange: 'CFFEX',
    board: 'cffex',
    kind: 'bond',
    basisMode: 'none',
    status: 'active',
    months: [3, 6, 9, 12],
    spotKeys: [],
    note: '国债 · 无 CTD/IRR 现货源',
  },
  {
    code: 'T0',
    name: '10年期国债',
    exchange: 'CFFEX',
    board: 'cffex',
    kind: 'bond',
    basisMode: 'none',
    status: 'active',
    months: [3, 6, 9, 12],
    spotKeys: [],
    note: '国债 · 无 CTD/IRR 现货源',
  },
  {
    code: 'TL0',
    name: '30年期国债',
    exchange: 'CFFEX',
    board: 'cffex',
    kind: 'bond',
    basisMode: 'none',
    status: 'active',
    months: [3, 6, 9, 12],
    spotKeys: [],
    note: '国债 · 无 CTD/IRR 现货源',
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
    // 板块与基差口径给默认值：老品种都属于油脂油料、现货−期货口径
    const withDefaults = {
      board: v.board ?? 'oil',
      basisMode: v.basisMode ?? 'spot-future',
      ...v,
    }
    if (withDefaults.status !== 'upcoming' || withDefaults.listDate === undefined) {
      return { ...withDefaults, effectiveStatus: withDefaults.status }
    }
    // 上市日当天 00:00 起即可抓取（首批合约当日开盘，但日线当晚才有）
    const listed = Date.parse(`${withDefaults.listDate}T00:00:00+08:00`) <= ts
    return { ...withDefaults, effectiveStatus: listed ? 'active' : 'upcoming' }
  })
}

/**
 * 某板块下当前可用的品种。
 * @param {string} board
 * @param {Date|number} [now]
 * @returns {Variety[]}
 */
export function varietiesOfBoard(board, now = Date.now()) {
  return activeVarieties(now).filter((v) => v.board === board)
}

/**
 * 按代码取所属板块 id。
 * @param {string} code
 * @returns {string}
 */
export function boardIdOf(code) {
  const v = varietyOf(code)
  return v?.board ?? 'oil'
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

/** 默认向后取的合约个数：跨期页要覆盖到 4 个月后的月差，4 个不够（2705→2709 会缺）。 */
export const DEFAULT_CONTRACT_COUNT = 6

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
 * @param {number} [count] 向后取几个合约（默认 6）
 * @returns {string[]} 如 ['M2701','M2703',...]
 */
export function contractCodes(variety, now = Date.now(), count = DEFAULT_CONTRACT_COUNT) {
  if (variety.exchange === 'CFFEX') return cffexContractCodes(variety, now)
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

/** 国债/股指的季月月份。 */
const QUARTER_MONTHS = [3, 6, 9, 12]

/**
 * 月份偏移（纯整数运算，不做 Date 转换）。
 * @param {number} year
 * @param {number} month
 * @param {number} delta
 * @returns {[number, number]}
 */
function shiftMonth(year, month, delta) {
  const idx = year * 12 + (month - 1) + delta
  return [Math.floor(idx / 12), (idx % 12) + 1]
}

/**
 * 中金所合约代码：与商品不同，股指/国债都是"当月 + 随后季月"的挂牌规则。
 *
 * - 股指（IF/IH/IC/IM）：当月、下月、随后两个季月；例如 2026-11 → 2611/2612/2703/2706
 * - 国债（TS/TF/T/TL）：最近的三个季月；例如 2026-11 → 2612/2703/2706
 *
 * @param {Variety} variety
 * @param {Date|number} [now]
 * @returns {string[]}
 */
export function cffexContractCodes(variety, now = Date.now()) {
  const d = new Date(typeof now === 'number' ? now : now.getTime())
  const base = variety.code.replace(/0$/, '')
  const out = []
  const push = (y, m) => {
    const code = `${base}${String(y % 100).padStart(2, '0')}${String(m).padStart(2, '0')}`
    if (!out.includes(code)) out.push(code)
  }

  if (variety.kind === 'stock') {
    let [y, m] = [d.getFullYear(), d.getMonth() + 1]
    push(y, m)
    ;[y, m] = shiftMonth(y, m, 1)
    push(y, m)
    // 随后两个季月：严格大于"下月"
    for (let guard = 0; guard < 12 && out.length < 4; guard += 1) {
      ;[y, m] = shiftMonth(y, m, 1)
      if (QUARTER_MONTHS.includes(m)) push(y, m)
    }
    return out
  }

  // 国债：最近的三个季月（当月是季月则包含当月）
  let [y, m] = [d.getFullYear(), d.getMonth() + 1]
  for (let guard = 0; guard < 4 && !QUARTER_MONTHS.includes(m); guard += 1) {
    ;[y, m] = shiftMonth(y, m, 1)
  }
  for (let guard = 0; guard < 8 && out.length < 3; guard += 1) {
    if (QUARTER_MONTHS.includes(m)) push(y, m)
    ;[y, m] = shiftMonth(y, m, 1)
  }
  return out
}

/**
 * 某品种的收盘时刻（北京时间分钟数）。
 * 商品 15:00；中金所股指 15:00、国债 15:15。
 * @param {Variety} variety
 * @returns {number}
 */
export function marketCloseMinutes(variety) {
  if (variety.exchange === 'CFFEX') return variety.kind === 'bond' ? 15 * 60 + 15 : 15 * 60
  return 15 * 60
}

/**
 * 当前需要抓取的指数代码（去重，来自股指品种的 indexCode）。
 * @param {Date|number} [now]
 * @returns {string[]}
 */
export function indexCodes(now = Date.now()) {
  const out = []
  for (const v of activeVarieties(now)) {
    if (typeof v.indexCode === 'string' && !out.includes(v.indexCode)) out.push(v.indexCode)
  }
  return out
}

/* ───────────── 板块内的产业分组与默认排序 ───────────── */

/**
 * 每个板块的产业分组（组内顺序即默认排序的大类顺序）。
 * 这些分组只影响展示顺序，不影响任何统计口径。
 */
export const BOARD_SECTORS = {
  oil: [
    ['meal', '粕类'],
    ['oil', '油脂'],
    ['soy', '大豆'],
  ],
  black: [
    ['steel', '钢材'],
    ['ore', '炉料'],
    ['ferroalloy', '铁合金'],
    ['other', '其他'],
  ],
  chem: [
    ['rubber', '橡胶系'],
    ['polyester', '聚酯'],
    ['olefin', '聚烯烃/烯烃'],
    ['chlor-alkali', '盐化工/建材'],
    ['coal', '煤化工'],
    ['aromatic', '芳烃'],
    ['other', '其他'],
  ],
  nonferrous: [
    ['copper', '铜'],
    ['aluminium', '铝产业链'],
    ['base', '锌镍锡铅'],
  ],
  agri: [
    ['soft', '软商品'],
    ['grain', '谷物'],
    ['livestock', '养殖'],
    ['fruit', '果品'],
    ['oilseed', '油料'],
    ['other', '其他'],
  ],
  precious: [
    ['metal', '金银'],
    ['pgm', '铂钯'],
  ],
  newenergy: [
    ['lithium', '锂'],
    ['silicon', '硅'],
  ],
  energy: [
    ['crude', '原油'],
    ['gas', '液化气'],
    ['refined', '燃料油'],
  ],
  other: [['freight', '集运'], ['misc', '其他']],
  cffex: [
    ['index', '股指'],
    ['bond', '国债'],
  ],
}

/** 品种 → 产业分组（未列出的归 other）。 */
export const VARIETY_SECTOR = {
  M0: 'meal',
  RM0: 'meal',
  Y0: 'oil',
  P0: 'oil',
  OI0: 'oil',
  SO0: 'oil',
  A0: 'soy',
  B0: 'soy',
  RB0: 'steel',
  HC0: 'steel',
  I0: 'ore',
  J0: 'ore',
  SF0: 'ferroalloy',
  SM0: 'ferroalloy',
  SS0: 'other',
  RU0: 'rubber',
  NR0: 'rubber',
  BR0: 'rubber',
  PX0: 'polyester',
  TA0: 'polyester',
  EG0: 'polyester',
  PF0: 'polyester',
  PR0: 'polyester',
  L0: 'olefin',
  PP0: 'olefin',
  V0: 'olefin',
  PL0: 'olefin',
  SA0: 'chlor-alkali',
  SH0: 'chlor-alkali',
  FG0: 'chlor-alkali',
  MA0: 'coal',
  UR0: 'coal',
  BZ0: 'aromatic',
  EB0: 'aromatic',
  PG0: 'gas',
  SP0: 'other',
  BU0: 'other',
  CU0: 'copper',
  BC0: 'copper',
  AL0: 'aluminium',
  AO0: 'aluminium',
  AD0: 'aluminium',
  ZN0: 'base',
  NI0: 'base',
  SN0: 'base',
  PB0: 'base',
  SR0: 'soft',
  CF0: 'soft',
  CY0: 'soft',
  C0: 'grain',
  CS0: 'grain',
  JD0: 'livestock',
  LH0: 'livestock',
  CJ0: 'fruit',
  AP0: 'fruit',
  PK0: 'oilseed',
  AU0: 'metal',
  AG0: 'metal',
  PT0: 'pgm',
  PD0: 'pgm',
  LC0: 'lithium',
  SI0: 'silicon',
  PS0: 'silicon',
  LI0: 'lithium',
  SC0: 'crude',
  FU0: 'refined',
  LU0: 'refined',
  EC0: 'freight',
  IF0: 'index',
  IH0: 'index',
  IC0: 'index',
  IM0: 'index',
  TS0: 'bond',
  TF0: 'bond',
  T0: 'bond',
  TL0: 'bond',
}

/** 组内默认次序（数字小的在前）；未列出的按代码排序。 */
export const VARIETY_ORDER = {
  M0: 10,
  RM0: 20,
  Y0: 10,
  P0: 20,
  OI0: 30,
  SO0: 40,
  A0: 10,
  B0: 20,
  RB0: 10,
  HC0: 20,
  I0: 10,
  J0: 20,
  SF0: 10,
  SM0: 20,
  SS0: 10,
  RU0: 10,
  NR0: 20,
  BR0: 30,
  PX0: 10,
  TA0: 20,
  EG0: 30,
  PF0: 40,
  PR0: 50,
  L0: 10,
  PP0: 20,
  V0: 30,
  PL0: 40,
  SA0: 10,
  SH0: 20,
  FG0: 30,
  MA0: 10,
  UR0: 20,
  BZ0: 10,
  EB0: 20,
  PG0: 10,
  SP0: 20,
  BU0: 30,
  CU0: 10,
  BC0: 20,
  AL0: 10,
  AO0: 20,
  AD0: 30,
  ZN0: 10,
  NI0: 20,
  SN0: 30,
  PB0: 40,
  SR0: 10,
  CF0: 20,
  CY0: 30,
  C0: 10,
  CS0: 20,
  JD0: 10,
  LH0: 20,
  CJ0: 10,
  AP0: 20,
  PK0: 10,
  AU0: 10,
  AG0: 20,
  PT0: 10,
  PD0: 20,
  LC0: 10,
  SI0: 10,
  PS0: 20,
  LI0: 30,
  SC0: 10,
  FU0: 10,
  LU0: 20,
  EC0: 10,
  IF0: 10,
  IH0: 20,
  IC0: 30,
  IM0: 40,
  TS0: 10,
  TF0: 20,
  T0: 30,
  TL0: 40,
}

/**
 * 按板块的产业分组给品种列表排序（返回新数组）。
 * @param {string} board
 * @param {Array<{code: string}>} list
 * @returns {any[]}
 */
export function sortByBoard(board, list) {
  const groups = BOARD_SECTORS[board] ?? [['other', '其他']]
  const groupIndex = new Map(groups.map((g, i) => [g[0], i]))
  const rank = (v) => groupIndex.get(VARIETY_SECTOR[v.code] ?? 'other') ?? 999
  const order = (v) => VARIETY_ORDER[v.code] ?? 999
  return list.slice().sort((a, b) => rank(a) - rank(b) || order(a) - order(b) || String(a.code).localeCompare(String(b.code)))
}

/**
 * 产业分组的中文名（前端展示分组标题用）。
 * @param {string} board
 * @returns {Array<{id: string, name: string}>}
 */
export function boardGroups(board) {
  return (BOARD_SECTORS[board] ?? [['other', '其他']]).map(([id, name]) => ({ id, name }))
}
