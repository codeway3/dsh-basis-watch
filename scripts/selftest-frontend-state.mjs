#!/usr/bin/env node
/**
 * 前端状态契约（SSR 级，不依赖浏览器）。
 *
 * 背景：此前内部迭代曾出现「CHANGELOG 说修了、片段没改」和「stale 分支写了但走不到」，
 * 这里把资讯页 stale/首次失败、详情页修复落地、产物一致性固化成断言。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
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

const vnode = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
const texts = (node, acc = []) => {
  if (node === null || node === undefined || typeof node === 'boolean') return acc
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node))
    return acc
  }
  if (Array.isArray(node)) {
    for (const item of node) texts(item, acc)
    return acc
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const item of node.children) texts(item, acc)
  }
  return acc
}

// 片段是工厂函数体，用 with + Proxy 注入 h/useApi 等依赖；内置对象必须显式提供，否则 with 会把作用域兜空
const BUILTINS = {
  String, Number, Boolean, Array, Object, Math, JSON, Date, isFinite, parseInt, parseFloat,
  encodeURIComponent, decodeURIComponent, RegExp, Map, Set, Error, Symbol, Promise,
}
const fragment = (file, exportName, scope) => {
  const src = fs.readFileSync(path.join(ROOT, 'src/client', file), 'utf8')
  const proxy = new Proxy({ ...BUILTINS, ...scope }, { has: () => true, get: (target, key) => (key in target ? target[key] : () => null) })
  return new Function('scope', `with (scope) { ${src}\n; return ${exportName} }`)(proxy)
}

console.log('\n  前端状态契约')

// D1：有旧数据 + 刷新失败 → 提示 + 旧行；不能出现「读取失败」「暂无资讯」
{
  const state = {
    loading: false,
    data: { ok: true, rows: [{ id: '1', time: '2026-11-10T10:00:00', title: '旧新闻标题', url: 'https://example.org', tags: ['大豆'] }] },
    error: 'offline',
    stale: true,
    asOf: null,
    reload() {},
  }
  const NewsList = fragment('news.js', 'NewsList', { h: vnode, useApi: () => state })
  const text = texts(NewsList({ limit: 20 })).join(' | ')
  check('资讯页 stale 保留旧数据并提示', text.includes('刷新失败') && text.includes('旧新闻标题') && !text.includes('读取失败') && !text.includes('暂无资讯'), text.slice(0, 120))
}

// D2：首次失败无旧数据 → 整页「读取失败」
{
  const state = { loading: false, data: null, error: 'offline', stale: false, asOf: null, reload() {} }
  const NewsList = fragment('news.js', 'NewsList', { h: vnode, useApi: () => state })
  const text = texts(NewsList({ limit: 20 })).join(' | ')
  check('资讯页首次失败显示读取失败', text.includes('读取失败：offline') && !text.includes('暂无资讯'), text.slice(0, 100))
}

// D3：详情页修复进片段与产物，旧 bug 模式消失
{
  const frag = fs.readFileSync(path.join(ROOT, 'src/client/detail.js'), 'utf8')
  const built = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
  const oldBug = 'if (error !== null || data?.ok === false)'
  const line = frag.split('\n').find((l) => l.includes('data === null && error !== null')) ?? ''
  check('详情页 stale 修复进片段与产物', line !== '' && !frag.includes(oldBug) && !built.includes(oldBug) && built.includes('刷新失败（'), line.trim().slice(0, 90))
}

// D4：资讯页/粮油网修复同时存在于片段、源码与产物（此前的翻车点就是只改产物或只改片段）
{
  const built = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
  const newsFrag = fs.readFileSync(path.join(ROOT, 'src/client/news.js'), 'utf8')
  const sources = fs.readFileSync(path.join(ROOT, 'lib/sources.js'), 'utf8')
  const ok = newsFrag.includes('data === null && error !== null')
    && built.includes('刷新失败（${error')
    && sources.includes('个栏目失败')
    && sources.includes('throw new Error')
  check('资讯/粮油网修复在片段、源码与产物中', ok, `news=${newsFrag.length}B client=${built.length}B`)
}

// D5：供需页签已整体删除，源码/产物里不应再有入口或接口引用
{
  const built = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
  const page = fs.readFileSync(path.join(ROOT, 'src/client/page.js'), 'utf8')
  const routes = fs.readFileSync(path.join(ROOT, 'lib/routes.js'), 'utf8')
  const ok = !built.includes('op=supply') && !built.includes('SupplyTab')
    && !page.includes("id: 'stock'") && !routes.includes("op === 'supply'")
  check('供需页签/接口已彻底移除', ok, `client=${built.length}B`)
}

console.log(`\n  结果: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
