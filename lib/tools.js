/**
 * Agent 只读工具（4 个）。
 *
 * 约定：全部只读本地数据，不触发任何抓取、不写任何文件。
 * 工具只是把 routes 里已经算好的快照换一种更省 token 的文本形态给模型。
 *
 * @module dsh-basis-watch/lib/tools
 */

import { buildDetail, buildOverview, buildSpreads } from './routes.js'

/**
 * 极简 defineTool：把"作者友好的参数描述"编译成注册表要的 JSON Schema 子集。
 * @param {object} options
 * @returns {object}
 */
function defineTool(options) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(options.parameters ?? {})) {
    const { required: isRequired, description, type, enum: enumValues } = spec
    const node = {}
    if (description !== undefined) node.description = description
    if (type !== undefined) node.type = type
    if (enumValues !== undefined) node.enum = enumValues
    properties[name] = node
    if (isRequired === true) required.push(name)
  }
  const parameters = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) parameters.required = required
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: {},
      render(_args, value) {
        return [{ type: 'text', text: options.render(value) }]
      },
    },
    async execute(args) {
      return options.execute(args ?? {})
    },
  }
}

const fmtPct = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '—')
const fmtNum = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('zh-CN') : '—')
const fmtPctl = (v) => (Number.isFinite(v) ? Math.round(v) + '%分位' : '样本不足')

/**
 * 注册只读工具。
 * @param {any} ctx cordis 上下文（需 inject tools）
 * @param {ReturnType<import('./store.js').createStore>} store
 * @returns {Array<() => void>} 注销函数
 */
export function registerTools(ctx, store) {
  const disposers = []

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'oils_overview',
        description:
          '油脂油料板块快照（只读，读本地数据）：各品种最新价、涨跌、基差率与 3 年分位、注册仓单。'
          + '用于回答"豆粕现在基差多少/贵不贵/库存怎么样"这类问题。',
        parameters: {},
        execute: () => buildOverview(store),
        render: (v) => {
          const rows = v?.rows ?? []
          const asOf = v?.asOf ?? {}
          const fresh = (k) => {
            const a = asOf[k]
            if (a === undefined || a.asOf === null) return `${k} 无记录`
            return `${k} ${new Date(a.asOf).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)}${a.stale ? '（已过期）' : ''}`
          }
          const lines = [
            `油脂油料 ${rows.length} 个品种`,
            `数据时点：${fresh('quotes')}；${fresh('basis')}；${fresh('daily')}`,
          ]
          for (const r of rows) {
            const price = r.price === null ? '—' : fmtNum(r.price) + ' ' + fmtPct(r.changePct)
            const basis = r.basis === null
              ? '无现货源'
              : `基差 ${fmtNum(r.basis.basis)} 元（${fmtPct(r.basis.basisRate)}，对 ${r.basis.contract ?? '未记录'} 合约，${fmtPctl(r.basisPercentile)}，样本 ${r.basisSample ?? 0} 天）`
            const stock = r.stock === null ? '无仓单' : `仓单 ${fmtNum(r.stock.warrant)}（${fmtNum(r.stock.delta)}）`
            lines.push(`${r.name}(${r.code}) ${price} | ${basis} | ${stock}`)
          }
          return lines.join('\n')
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'oils_detail',
        description:
          '单个品种的中长期数据（只读）：价格分位（1/3/5/10 年）、基差分位、注册仓单、跨期结构、'
          + '季节性、相关价差、外盘参考、数据完整度。适合做"这个品种贵不贵、库存趋势如何"的判断。',
        parameters: {
          code: { type: 'string', required: true, description: '品种代码，如 M0（豆粕）、Y0（豆油）、P0（棕榈油）、OI0（菜油）、RM0（菜粕）、SO0（葵油）' },
        },
        execute: (args) => buildDetail(store, String(args.code)),
        render: (v) => {
          if (v?.ok === false) return `错误：${v.error}`
          const caliber = v.price.caliber ?? {}
          const lines = [
            `${v.variety.name}(${v.variety.code}) 数据完整度：价格 ${v.price.stats.sample} 个交易日，基差 ${v.basis.sample ?? 0} 天，仓单 ${v.stock?.sample ?? 0} 天`,
            caliber.stats === 'adjusted'
              ? `口径：分位/K 线=主连真实报价；回撤/波动=复权连续（比例复权，${v.continuous?.rolls ?? 0} 次换月，${caliber.coverage} 起）`
              : '口径：全部使用主连真实报价（无合约数据，回撤/波动含换月跳空）',
          ]
          // 分位用真实报价（rawBars），不是复权序列
          const w = v.price.percentile ?? {}
          const winText = (key) => {
            const item = w[key]
            if (item === undefined) return '—'
            return `${item.percentile ?? '—'}%${item.short === true ? `（仅${item.sample}个样本）` : ''}`
          }
          lines.push(
            `价格 ${fmtNum(v.price.last)}（${v.price.date}）| 真实报价分位 1年 ${winText('1y')} / 3年 ${winText('3y')} / 5年 ${winText('5y')} / 10年 ${winText('10y')}`,
            `回撤 ${Number.isFinite(v.price.stats.maxDrawdown) ? v.price.stats.maxDrawdown.toFixed(1) + '%' : '—'}（复权口径，${v.price.stats.sample} 个交易日）| 20日波动 ${Number.isFinite(v.price.stats.vol20) ? v.price.stats.vol20.toFixed(1) + '%' : '—'}`,
          )
          if (v.basis.sample > 0) {
            lines.push(
              `基差 ${fmtPct(v.basis.current)}（对 ${v.basis.contract ?? '未记录'} 合约，来源 ${v.basis.source ?? '100ppi'}）| 分位 1年 ${v.basis.p1y?.percentile ?? '—'}% / 3年 ${v.basis.p3y?.percentile ?? '—'}%`
              + (v.basis.p3y ? `（3年区间 ${fmtPct(v.basis.p3y.min)} ~ ${fmtPct(v.basis.p3y.max)}，中位 ${fmtPct(v.basis.p3y.median)}）` : ''),
            )
          }
          if (v.stock !== null) lines.push(`仓单 ${fmtNum(v.stock.last.warrant)}（${fmtNum(v.stock.last.delta)}），${v.stock.from} ~ ${v.stock.to}`)
          if (v.contracts.length > 0) lines.push('跨期：' + v.contracts.map((c) => `${c.code}=${fmtNum(c.close)}`).join(' '))
          if (v.spreads.length > 0) {
            lines.push('相关价差：' + v.spreads.map((s) => (s.available ? `${s.label} ${s.type === 'ratio' ? s.current?.toFixed(3) : fmtNum(s.current)}（${Math.round(s.percentile3y)}%）` : `${s.label} 待上市`)).join('；'))
          }
          if ((v.foreign ?? []).length > 0) lines.push('外盘：' + v.foreign.map((f) => `${f.name} ${f.last}`).join('，'))
          return lines.join('\n')
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'oils_spreads',
        description: '油脂油料跨品种价差（只读）：油粕比、豆棕价差、菜豆油价差、豆菜粕价差（葵油上市后自动加入）以及各自近 3 年分位与 z 值。',
        parameters: {},
        execute: () => buildSpreads(store),
        render: (v) => {
          const rows = v?.spreads ?? []
          if (rows.length === 0) return '暂无价差数据'
          return rows
            .map((s) => {
              if (s.available !== true) return `${s.label}：${s.reason ?? '待上市'}`
              const value = s.type === 'ratio' ? Number(s.current).toFixed(3) : fmtNum(s.current)
              return `${s.label}（${s.note}）${value} | 3年分位 ${Math.round(s.percentile3y)}%（样本 ${s.sample3y}）| z=${s.z3y} | 3年区间 ${s.type === 'ratio' ? Number(s.min3y).toFixed(3) : fmtNum(s.min3y)} ~ ${s.type === 'ratio' ? Number(s.max3y).toFixed(3) : fmtNum(s.max3y)}`
            })
            .join('\n')
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'oils_news',
        description: '油脂油料相关资讯（只读，来自中国粮油信息网各品种栏目，含标题、时间、链接）。',
        parameters: {
          limit: { type: 'number', description: '返回条数，默认 20，最大 80' },
          tag: { type: 'string', description: '按栏目过滤：豆粕 / 豆油 / 棕榈油 / 菜粕 / 菜籽 / 大豆' },
        },
        execute: (args) => {
          const limit = Math.max(1, Math.min(80, Number(args.limit) || 20))
          const tag = typeof args.tag === 'string' && args.tag !== '' ? args.tag : null
          let rows = store.readNews(limit * 3)
          if (tag !== null) rows = rows.filter((n) => (n.tags ?? []).includes(tag))
          return { rows: rows.slice(0, limit) }
        },
        render: (v) => {
          const rows = v?.rows ?? []
          if (rows.length === 0) return '暂无资讯'
          return rows.map((n) => `${String(n.time ?? '').slice(5, 16).replace('T', ' ')} [${(n.tags ?? []).join('/')}] ${n.title}`).join('\n')
        },
      }),
    ),
  )

  return disposers
}
