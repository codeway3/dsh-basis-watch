#!/usr/bin/env node
/**
 * 客户端行为自测：不依赖真实浏览器，用假 ctx 把插件 apply 起来，
 * 检查快捷键注册、入口开关切换、以及"在插件内按下时回到会话"的行为。
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
check('注册了 slots: main / settings.section', registeredSlots.includes('main') && registeredSlots.includes('settings.section'), registeredSlots.join(','))
check('注册了 1 个快捷键', registeredShortcuts.length === 1, `n=${registeredShortcuts.length}`)

const sc = registeredShortcuts[0]
if (sc === undefined) {
  console.log('\n  结果: 快捷键未注册，后续断言跳过')
  process.exit(1)
}

check('快捷键 id 正确', sc.id === 'basis-watch.entry.toggle', sc.id)
const mac = sc.defaults['desktop:macos']
check('macOS 默认键位是 Shift+Cmd+D', mac?.code === 'KeyD' && mac.modifiers.includes('primary') && mac.modifiers.includes('shift'), JSON.stringify(mac))
const win = sc.defaults['desktop:windows']
check('Windows 默认键位也是 KeyD + primary/shift', win?.code === 'KeyD' && win.modifiers.includes('shift'), JSON.stringify(win))
check('声明了 label 与 aliases', typeof sc.label === 'function' && Array.isArray(sc.aliases))

/* 面板不在前台时：只切换入口，不跳会话 */
activePanelId = null
const first = sc.resolve({ modal: null })
check('无弹层时 resolve 返回 handled', first?.status === 'handled', first?.status)
first.run()
check('第一次按下：开启入口', JSON.parse(storage.get('dsh-basis-watch.cfg.v1') ?? '{}').showEntry === true)
check('不在插件内时不跳会话', layoutCalls.length === 0, `selectPanel 调用 ${layoutCalls.length} 次`)

/* 面板在前台时：切换入口并回到会话 */
activePanelId = 'basis-watch'
const second = sc.resolve({ modal: null })
second.run()
check('第二次按下：关闭入口', JSON.parse(storage.get('dsh-basis-watch.cfg.v1') ?? '{}').showEntry === false)
check('在插件内按下：回到会话（selectPanel(null)）', layoutCalls.length === 1 && layoutCalls[0] === null, JSON.stringify(layoutCalls))

/* 有弹层时：不处理 */
const blocked = sc.resolve({ modal: 'settings' })
check('有弹层时返回 blocked', blocked?.status === 'blocked' && blocked.reason === 'modal', JSON.stringify(blocked))

console.log(`\n  结果: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
