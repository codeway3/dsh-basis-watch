#!/usr/bin/env node
/**
 * 客户端行为自测：不依赖真实浏览器，用假 ctx 把插件 apply 起来，
 * 检查主面板/侧边栏入口常驻、且不再注册 DSH 设置页与入口开关快捷键。
 *
 * 运行：node scripts/selftest-client.mjs
 * 需要 FR_REACT_DIR 指向包含 react / react-dom 的 node_modules。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const reactDir = process.env.FR_REACT_DIR
if (reactDir === undefined || !fs.existsSync(reactDir)) {
  console.log('跳过：未设置 FR_REACT_DIR')
  process.exit(0)
}
const req = createRequire(path.join(reactDir, 'index.js'))

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

/* ── 浏览器环境桩 ── */
const storage = new Map()
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => (globalThis.__factory = factory) } }
globalThis.document = {
  head: { appendChild: () => {} },
  createElement: () => ({ dataset: {}, textContent: '' }),
  querySelector: () => null,
}
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
}
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.clearTimeout = () => {}

await import('../client.js')
const plugin = globalThis.__factory(req)

console.log('\n  客户端行为')

/* ── 假 ctx ── */
const registeredShortcuts = []
const registeredSlots = []
const layoutCalls = []
let activePanelId = null
const layout = {
  panelInfo: { getSnapshot: () => ({ activePanelId }) },
  selectPanel: (id) => layoutCalls.push(id),
}
const slots = {
  inject: (name, fn) => {
    const dispose = fn()
    registeredSlots.push(name)
    return () => dispose?.()
  },
  register: (spec) => () => {},
}
const ctx = {
  slots,
  get: (key) => (key === 'layout' ? layout : key === 'shortcuts' ? shortcuts : undefined),
  effect: (fn) => {
    fn()
    return () => {}
  },
}
const shortcuts = {
  register: (spec) => {
    registeredShortcuts.push(spec)
    return () => {}
  },
}

plugin.apply(ctx)

/* ── 断言 ── */
check('注册了 slots: main / sidebar.panellist', registeredSlots.includes('main') && registeredSlots.includes('sidebar.panellist'), registeredSlots.join(','))
check('不再注册 settings.section', !registeredSlots.includes('settings.section'), registeredSlots.join(','))
check('侧边栏入口常显（无条件注册）', registeredSlots.filter((n) => n === 'sidebar.panellist').length === 1)
check('不再注册显示/隐藏入口快捷键', registeredShortcuts.length === 0, `n=${registeredShortcuts.length}`)
check('不再写入 showEntry 配置', JSON.parse(storage.get('dsh-basis-watch.cfg.v1') ?? '{}').showEntry === undefined)

console.log(`\n  结果: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
