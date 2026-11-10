#!/usr/bin/env node
/**
 * 快捷键默认键位的「宿主规则」校验。
 *
 * 为什么需要：shortcuts.register() 会对 desktop/web × macos/windows/linux 六个 profile
 * 全部校验，任意一个默认值非法（web+linux 只接受三种组合）就整体抛错，
 * 结果是一条命令都不注册 —— 症状是"快捷键完全没反应"，而且没有任何界面提示。
 *
 * 做法：不重写规则，而是把宿主 @deepseek-ai/dsh-client-shortcuts 的 binding 规则
 * 源码原样取出来 eval，再用它校验插件实际提交的 defaults。
 *
 * 运行：node scripts/selftest-shortcut.mjs
 * 依赖：本机安装的 DSH（找不到时优雅跳过）
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}${detail === '' ? '' : '  ' + detail}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}${detail === '' ? '' : '  ' + detail}`)
  }
}

/* ── 1. 从插件源码里取出实际提交的 defaults（不跑 React，纯文本提取后求值） ── */
const clientPath = path.join(here, '..', 'client.js')
const clientSrc = fs.readFileSync(clientPath, 'utf8')
// 优先找 FULL_DEFAULTS 常量（当前实现），退回到内联 defaults
const fullAt = clientSrc.indexOf('FULL_DEFAULTS = {')
const inlineAt = clientSrc.indexOf("id: 'basis-watch.entry.toggle'")
const defaultsAt = fullAt >= 0
  ? fullAt + 'FULL_DEFAULTS = '.length
  : inlineAt < 0
    ? -1
    : clientSrc.indexOf('defaults: {', inlineAt) + 'defaults: '.length
if (defaultsAt < 0) {
  console.log('  ✗ 没能从 client.js 找到 defaults 字面量')
  process.exit(1)
}
// 花括号配平，避免正则被嵌套对象截断
let depth = 0
let end = -1
for (let i = defaultsAt; i < clientSrc.length; i += 1) {
  const ch = clientSrc[i]
  if (ch === '{') depth += 1
  else if (ch === '}') {
    depth -= 1
    if (depth === 0) {
      end = i + 1
      break
    }
  }
}
if (end < 0) {
  console.log('  ✗ defaults 字面量括号不配平')
  process.exit(1)
}
const defaults = new Function(`return ${clientSrc.slice(defaultsAt, end)}`)()
const profileCount = Object.keys(defaults).length
console.log(`  提取到 ${profileCount} 个 profile 默认键：${Object.keys(defaults).join(', ')}`)

/* ── 2. 定位宿主规则源码 ── */
// 宿主安装位置默认取自 DSH 的默认安装根；可用 DSH_INSTALL_DIR 覆盖
const installDir = process.env.DSH_INSTALL_DIR ?? path.join(os.homedir(), '.local/opt/dsh')
const pnpmDir = path.join(installDir, 'node_modules/.pnpm')
const findHostClient = () => {
  if (!fs.existsSync(pnpmDir)) return null
  const dir = fs.readdirSync(pnpmDir).find((n) => n.startsWith('@deepseek-ai+dsh-client-shortcuts@'))
  if (dir === undefined) return null
  const p = path.join(pnpmDir, dir, 'node_modules/@deepseek-ai/dsh-client-shortcuts/lib/client.js')
  return fs.existsSync(p) ? p : null
}
const hostPath = findHostClient()
if (hostPath === null) {
  console.log(`  跳过宿主规则校验：未找到 @deepseek-ai/dsh-client-shortcuts（查找目录 ${pnpmDir}）`)
  console.log(`\n  结果: ${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

const hostLines = fs.readFileSync(hostPath, 'utf8').split('\n')
const regionStart = hostLines.findIndex((l) => l.includes('//#region lib/types/binding.js'))
const configStart = hostLines.findIndex((l) => l.includes('//#region lib/types/configuration.js'))
const configEnd = hostLines.findIndex((l, i) => i > configStart && l.includes('//#endregion'))
if (regionStart < 0 || configStart < 0 || configEnd < 0) {
  console.log('  ✗ 宿主 bundle 结构变了，无法提取规则区段')
  process.exit(1)
}
const body = hostLines
  .slice(regionStart, configEnd)
  .filter((l) => !l.includes('//#region') && !l.includes('//#endregion'))
  .join('\n')
const rules = new Function('module', 'exports', `${body}\nreturn { normalizeBinding, isWebBindingAllowed, bindingIssue }`)({ exports: {} }, {})

/* ── 3. 用宿主规则逐个校验 ── */
const problems = []
for (const [profile, raw] of Object.entries(defaults)) {
  const [runtime, platform] = profile.split(':')
  const binding = rules.normalizeBinding(raw, platform)
  if (runtime === 'web' && !rules.isWebBindingAllowed(binding, platform)) {
    problems.push(`${profile} 不被浏览器接受（会导致整条命令注册失败）`)
    continue
  }
  const issue = rules.bindingIssue(binding, runtime, platform)
  if (issue !== null) problems.push(`${profile} 被宿主保留：${issue}`)
}
check('全部默认键都能通过宿主校验', problems.length === 0, problems.join('; '))
check('浏览器 Linux 不预置默认键（宿主只允许三种组合）', defaults['web:linux'] === undefined)
check('桌面 macOS 仍是 Shift+Cmd+D', defaults['desktop:macos']?.code === 'KeyD' && defaults['desktop:macos'].modifiers.includes('shift'))

/* ── 4. register 的其余必填字段 ── */
check('声明了 modals（dispatch 会读 command.modals）', /modals: \[[^\]]*\]/u.test(clientSrc))
check('声明了 regions', /regions: \['page', 'editable'\]/u.test(clientSrc))

console.log(`\n  结果: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
