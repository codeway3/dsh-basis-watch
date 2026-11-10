#!/usr/bin/env node
/**
 * DSH 插件清单体检：按宿主读取插件元信息的方式校验本包的声明。
 *
 * 检查项对应宿主 app-boot 的约定：
 * - `dsh.bundle.patch` 指向的 patch 存在，且 insert 的 id 与包名一致；
 * - `dsh.client` 声明 inject/platform，`./client` 导出的文件存在；
 * - `exports` 能被 module resolver 解析（locale 需要显式导出）；
 * - `locale/*.json` 符合 `{ meta: { title, description } }` 结构；
 * - `icon` 存在、为 SVG/PNG/JPEG/WebP、且 ≤ 256 KiB；
 * - `files` 列出的路径都真实存在；
 * - README 双语互链、LICENSE 存在；
 * - 源码里没有本机绝对路径或邮箱（避免发布时泄露）。
 *
 * 运行：node scripts/check-manifest.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
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
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
const exists = (rel) => fs.existsSync(path.join(root, rel))

const pkg = readJson('package.json')

/* ── 1. 基础字段 ── */
check('name / version / description 齐全',
  typeof pkg.name === 'string' && typeof pkg.version === 'string' && typeof pkg.description === 'string')
check('type=module 且 main 存在', pkg.type === 'module' && typeof pkg.main === 'string' && exists(pkg.main), pkg.main)
check('license 声明为 MIT 且 LICENSE 文件存在', pkg.license === 'MIT' && exists('LICENSE'))
check('engines.node 声明', typeof pkg.engines?.node === 'string', pkg.engines?.node ?? '')
check('repository 指向 GitHub', typeof pkg.repository?.url === 'string' && pkg.repository.url.includes('github.com'))

/* ── 2. dsh 清单 ── */
check('dsh.bundle.patch 声明且文件存在', typeof pkg.dsh?.bundle?.patch === 'string' && exists(pkg.dsh.bundle.patch), pkg.dsh?.bundle?.patch ?? '')
const patchText = exists(pkg.dsh?.bundle?.patch ?? '') ? fs.readFileSync(path.join(root, pkg.dsh.bundle.patch), 'utf8') : ''
check('patch 内有 insert 且 id 等于包名',
  patchText.includes('insert:') && new RegExp(`id:\\s*${pkg.name}\\b`).test(patchText))
check('dsh.client 声明 inject 与 platform',
  Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0 && pkg.dsh?.client?.platform === 'web')
check('dsh.compatibility.dshReleases 声明', typeof pkg.dsh?.compatibility?.dshReleases === 'object')

/* ── 3. 导出可解析 ── */
check('exports["."] 指向 main', pkg.exports?.['.'] === `./${pkg.main}` || pkg.exports?.['.'] === pkg.main)
check('exports["./client"] 存在', typeof pkg.exports?.['./client'] === 'string' && exists(pkg.exports['./client']), pkg.exports?.['./client'] ?? '')
check('exports 暴露 locale/*.json（宿主据此解析插件标题）', typeof pkg.exports?.['./locale/*.json'] === 'string')

const clientSrc = exists(pkg.exports?.['./client'] ?? '') ? fs.readFileSync(path.join(root, pkg.exports['./client']), 'utf8') : ''
check('client 用 __ModuleLoader__ 注册且 id 等于包名', clientSrc.includes('__ModuleLoader__.load') && clientSrc.includes(`id: '${pkg.name}'`))

/* ── 4. 本地化元信息 ── */
for (const lang of ['en', 'zh']) {
  const rel = `locale/${lang}.json`
  let ok = false
  let detail = ''
  try {
    const doc = readJson(rel)
    ok = typeof doc.meta?.title === 'string' && doc.meta.title !== '' && typeof doc.meta?.description === 'string' && doc.meta.description.length >= 10
    detail = ok ? doc.meta.title : '缺少 meta.title / meta.description'
  } catch (error) {
    detail = String(error instanceof Error ? error.message : error)
  }
  check(`${rel} 结构正确`, ok, detail)
}

/* ── 5. 图标 ── */
const iconRel = pkg.icon
const iconOk = typeof iconRel === 'string' && exists(iconRel)
const iconSize = iconOk ? fs.statSync(path.join(root, iconRel)).size : 0
check('icon 存在且 ≤256KiB', iconOk && iconSize <= 262144, iconRel ?? '', `${Math.round(iconSize / 1024)}KB`)
check('icon 为受支持格式', iconOk && /\.(svg|png|jpe?g|webp)$/iu.test(iconRel))

/* ── 6. files 白名单 ── */
const missing = (pkg.files ?? []).filter((rel) => !exists(rel))
check('files 列出的路径都存在', missing.length === 0, missing.join(', '))

/* ── 7. 文档与互链 ── */
const readmeEn = exists('README.md') ? fs.readFileSync(path.join(root, 'README.md'), 'utf8') : ''
const readmeZh = exists('README.zh-CN.md') ? fs.readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8') : ''
check('英文 README 链接到中文版', readmeEn.includes('README.zh-CN.md'))
check('中文 README 链接回英文版', readmeZh.includes('](README.md)'))
check('两份 README 都在 files 白名单', (pkg.files ?? []).includes('README.md') && (pkg.files ?? []).includes('README.zh-CN.md'))

/* ── 8. 发布隐私：本机路径 / 邮箱 ── */
const sourceFiles = (pkg.files ?? []).filter((rel) => {
  try {
    return fs.statSync(path.join(root, rel)).isFile()
  } catch {
    return false
  }
})
const leaks = []
for (const rel of [...sourceFiles, 'README.md', 'README.zh-CN.md', 'scripts/collect.mjs', 'scripts/check-manifest.mjs']) {
  const file = path.join(root, rel)
  if (!fs.existsSync(file)) continue
  const text = fs.readFileSync(file, 'utf8')
  if (/\/Users\/[^/\s]+/u.test(text)) leaks.push(`${rel}: 绝对路径`)
  if (/\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/u.test(text)) leaks.push(`${rel}: 邮箱`)
}
check('源码与文档不含本机绝对路径/邮箱', leaks.length === 0, leaks.slice(0, 5).join('; '))

console.log(`\n  结果: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
