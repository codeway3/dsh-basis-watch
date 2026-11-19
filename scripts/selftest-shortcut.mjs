#!/usr/bin/env node
/**
 * 入口开关快捷键已移除的回归护栏。
 *
 * 产品调整：侧边栏「期现瞭望」入口常显，不再提供显示/隐藏勾选，
 * 因此也不应再注册 basis-watch.entry.toggle 快捷键。
 *
 * 运行：node scripts/selftest-shortcut.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')
const clientSrc = fs.readFileSync(clientPath, 'utf8')

let pass = 0
let fail = 0
const check = (label, ok) => {
  if (ok) {
    pass += 1
    console.log(`  ✓ ${label}`)
  } else {
    fail += 1
    console.log(`  ✗ ${label}`)
  }
}

console.log('\n  入口开关快捷键')
check('不再注册 basis-watch.entry.toggle', !clientSrc.includes("id: 'basis-watch.entry.toggle'"))
check('不再携带 FULL_DEFAULTS 入口键位', !clientSrc.includes('FULL_DEFAULTS = {'))
check('不再出现 showEntry 配置项', !clientSrc.includes('showEntry'))

console.log(`\n  结果: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
