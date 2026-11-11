#!/usr/bin/env node
/**
 * 宿主半冒烟测试：用假的 cordis 上下文挂载插件，验证路由与调度接线。
 * 不访问网络（只读本地空目录）。
 *
 * 运行：node scripts/selftest-host.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0
let fail = 0
const check = (label, cond, detail = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`)
  }
}

// 数据目录隔离：绝不能让测试写进真实 ~/.dsh
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'basis-watch-host-'))
process.env.DSH_HOME = tmpHome
// 关闭自动调度：否则 20 秒后会自己发起网络回填，测试会挂住
process.env.DSH_BASIS_WATCH_SCHED = '0'

const { apply, inject, name } = await import('../index.js')

const routes = []
const tools = []
const effects = []
const logs = []
const ctx = {
  logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) },
  webServer: {
    register: (spec) => {
      routes.push(spec)
      return () => {}
    },
  },
  tools: {
    register: (spec) => {
      tools.push(spec)
      return () => {}
    },
  },
  effect: (fn, label) => {
    effects.push({ fn, label })
    return () => {}
  },
}

apply(ctx)

console.log('\n  挂载')
check('插件名正确', name === 'dsh-basis-watch', name)
check('inject 声明 webServer 与 tools', Array.isArray(inject) && inject.includes('webServer') && inject.includes('tools'), JSON.stringify(inject))
check('注册了 1 条路由', routes.length === 1, `n=${routes.length}`)
check('注册了 5 个只读工具', tools.length === 5, `n=${tools.length}`)
check('工具名符合约定', ['oils_overview', 'oils_detail', 'oils_spreads', 'oils_news', 'oils_term'].every((n) => tools.some((t) => t.name === n)), tools.map((t) => t.name).join(','))
check('工具都声明了参数 schema', tools.every((t) => t.parameters?.type === 'object'))
check('路由是前缀匹配', routes[0]?.kind === 'prefix', routes[0]?.kind)
check('路由路径正确', routes[0]?.path === '/basis-watch/api', routes[0]?.path)
check('注册了一个 effect（清理）', effects.length === 1, `n=${effects.length}`)
check('数据目录建在隔离的 DSH_HOME 下', fs.existsSync(path.join(tmpHome, 'dsh-basis-watch', 'data')))
const createdFiles = fs.readdirSync(path.join(tmpHome, 'dsh-basis-watch', 'data'))
check('初始化了子目录', createdFiles.includes('daily') && createdFiles.includes('basis'))

/* 调用路由处理函数 */
const call = (url) =>
  new Promise((resolve) => {
    let body = ''
    const res = {
      writeHead: () => {},
      end: (text) => {
        body = text
        resolve(JSON.parse(text))
      },
    }
    Promise.resolve(routes[0].handler({ url }, res)).catch((error) => resolve({ ok: false, error: String(error) }))
    // handler 内部是 async，等 end 回调即可
    void body
  })

console.log('\n  路由')
const status = await call('/basis-watch/api?op=status')
check('status 返回 ok', status.ok === true)
check('status 含 76 个品种目录', status.catalog?.length === 76, `n=${status.catalog?.length}`)
check('status 含 10 个板块定义', Array.isArray(status.boards) && status.boards.map((b) => b.id).join(',') === 'oil,black,chem,nonferrous,precious,energy,agri,newenergy,other,cffex', JSON.stringify(status.boards?.map((b) => b.id)))
check('status 含葵油且是 upcoming', status.catalog?.some((v) => v.code === 'SO0' && v.effectiveStatus === 'upcoming'))
check('status 含数据覆盖块', status.coverage !== undefined && typeof status.coverage.daily === 'object')

const overview = await call('/basis-watch/api?op=overview')
check('overview 返回 ok', overview.ok === true)
check('overview 含 76 个品种', overview.rows?.length === 76, `n=${overview.rows?.length}`)
check('overview 返回板块定义', overview.boards?.length === 10)
check('中金所股指行有 basisMode 口径', overview.rows?.find((r) => r.code === 'IF0')?.basis === null && overview.rows?.find((r) => r.code === 'IF0')?.board === 'cffex')
check('空库时价格为 null', overview.rows?.[0]?.price === null)

const term = await call('/basis-watch/api?op=term')
check('term 返回 ok', term.ok === true)
check('空库时 term 行数为 0（无合约日线）', Array.isArray(term.rows) && term.rows.length === 0, `n=${term.rows?.length}`)

const termOne = await call('/basis-watch/api?op=term&code=M0')
check('term 单品种：无数据时返回空 rows 或带 error', termOne.ok === true)

const termBad = await call('/basis-watch/api?op=term&code=ZZ0')
check('term 未知品种返回 404 语义', termBad.ok === false && String(termBad.error).includes('未知品种'))

// 中金所：空库也要能返回结构（股指有贴水口径、国债明确说无基差），不能 500
const detIf = await call('/basis-watch/api?op=detail&code=IF0')
check('detail IF0 返回 ok', detIf.ok === true)
check('股指基差口径是 future-index', detIf.basis?.mode === 'future-index')
check('股指无仓单', detIf.stock === null)
const detT = await call('/basis-watch/api?op=detail&code=T0')
check('国债基差口径是 none 且给出原因', detT.basis?.mode === 'none' && String(detT.basis?.reason).includes('可交割券'))
const termTl = await call('/basis-watch/api?op=term&code=TL0')
check('国债也能进跨期结构', termTl.ok === true && Array.isArray(termTl.rows))

// 参数校验：非法日期/超大区间必须 400，且不能落到网络抓取
const badDate = await call('/basis-watch/api?op=basis&date=2026-13-99x')
check('basis 非法日期返回 400', badDate.ok === false && String(badDate.error).includes('YYYY-MM-DD'), JSON.stringify(badDate).slice(0, 120))
const injectDate = await call('/basis-watch/api?op=basis&date=2026-11-10/../../etc')
check('basis 日期路径注入被拒绝', injectDate.ok === false && String(injectDate.error).includes('YYYY-MM-DD'), JSON.stringify(injectDate).slice(0, 120))
const hugeRange = await call('/basis-watch/api?op=basis&from=1900-01-01&to=2100-01-01')
check('basis 超大区间被拒绝', hugeRange.ok === false && String(hugeRange.error).includes('区间过大'), JSON.stringify(hugeRange).slice(0, 120))
const newsClamp = await call('/basis-watch/api?op=news&limit=99999')
check('news limit 被夹取（不报错）', newsClamp.ok === true && Array.isArray(newsClamp.rows), JSON.stringify(newsClamp).slice(0, 80))
const newsCffex = await call('/basis-watch/api?op=news&board=cffex')
check('news 支持按板块筛选', newsCffex.ok === true && newsCffex.board === 'cffex' && Array.isArray(newsCffex.rows), JSON.stringify(newsCffex).slice(0, 80))
const newsOil = await call('/basis-watch/api?op=news&board=oil')
check('news board=oil 不返回中金所条目', newsOil.ok === true && newsOil.rows.every((n) => !(n.tags ?? []).includes('中金所')))

const bad = await call('/basis-watch/api?op=nope')
check('未知操作返回 400 语义', bad.ok === false && String(bad.error).includes('未知操作'))

/* 只读工具：能执行并产出文本 */
console.log('\n  只读工具')
const byName = (n) => tools.find((t) => t.name === n)
for (const name of ['oils_overview', 'oils_spreads', 'oils_term', 'oils_news']) {
  const tool = byName(name)
  const value = await tool.execute({}, {})
  const blocks = tool.output.render({}, value)
  check(`${name} 可执行并渲染文本`, Array.isArray(blocks) && typeof blocks[0]?.text === 'string', `${blocks[0]?.text?.length ?? 0} 字符`)
}
const detailTool = byName('oils_detail')
const detailValue = await detailTool.execute({ code: 'M0' }, {})
const detailText = detailTool.output.render({ code: 'M0' }, detailValue)[0].text
check('oils_detail 返回豆粕数据', detailValue.ok === true && detailText.includes('豆粕'), detailText.split('\n')[0])
check('oils_detail 参数 schema 要求 code', detailTool.parameters.required?.includes('code') === true)
check('工具不提供写操作（无 create/update/delete）', tools.every((t) => !/create|update|delete|move|write/i.test(t.name)))

/* 清理 effect：不应抛错 */
console.log('\n  清理')
let disposeError = null
try {
  effects[0].fn()
} catch (error) {
  disposeError = error
}
check('dispose 不抛错', disposeError === null, disposeError === null ? '' : String(disposeError))

console.log(`\n  结果: ${pass} 通过 / ${fail} 失败`)
fs.rmSync(tmpHome, { recursive: true, force: true })
if (fail > 0) process.exitCode = 1
