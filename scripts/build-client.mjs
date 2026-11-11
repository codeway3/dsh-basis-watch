#!/usr/bin/env node
/**
 * 把 src/client/*.js 按固定顺序拼成 client.js。
 *
 * 为什么要构建：DSH 的客户端半是普通脚本（`window.__ModuleLoader__.load({ factory })`），
 * 不能直接用 ESM import；但 2000+ 行单文件又没法维护。这里用"多个源码片段 + 顺序拼接"
 * 的方式拆分：片段共享同一个 factory 作用域，运行时零成本，也不需要打包器。
 *
 * 顺序为什么写死在下面：片段之间有依赖（entry 打开 factory、plugin 收尾；图表在页面之前定义），
 * 文件名不再带数字前缀，顺序只在这里维护——加片段必须同时加到 ORDER，否则构建直接报错。
 *
 * 用法：
 *   node scripts/build-client.mjs           # 生成 client.js
 *   node scripts/build-client.mjs --check   # 只校验 client.js 是否与源码一致（CI 用）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const srcDir = path.join(root, 'src', 'client')
const outFile = path.join(root, 'client.js')

/**
 * 片段拼接顺序（等价于原来的阅读顺序）。
 * 新增片段必须加到这里，否则构建会报"未列入 ORDER"。
 */
export const ORDER = [
  'entry.js', // 打开 ModuleLoader.factory、require React、常量
  'config.js', // 本地配置与视图状态（localStorage）
  'styles.js', // 面板 CSS
  'format.js', // 数字/时间格式化与小工具
  'charts.js', // 手绘 SVG：走势、K 线、季节、迷你线、分位条
  'data.js', // useApi / 宽度测量 / 弹层可访问性
  'overview.js', // 总览
  'news.js', // 资讯列表
  'detail.js', // 品种详情
  'spreads.js', // 跨品种 + 跨期（月差）
 // 注册仓单
  'settings.js', // 面板内设置抽屉
  'page.js', // 页签、页面骨架
  'glossary.js', // 术语答疑
  'settings-section.js', // 设置页里的「期现瞭望」一节
  'icon.js', // 侧边栏图标
  'plugin.js', // 插件对象与 apply（收尾）
]

const files = fs
  .readdirSync(srcDir)
  .filter((f) => f.endsWith('.js'))
  .sort()

const unknown = files.filter((f) => !ORDER.includes(f))
const missing = ORDER.filter((f) => !files.includes(f))
if (unknown.length > 0) {
  console.error(`[build-client] 以下片段未列入 ORDER：${unknown.join(', ')}`)
  process.exit(1)
}
if (missing.length > 0) {
  console.error(`[build-client] ORDER 中的片段不存在：${missing.join(', ')}`)
  process.exit(1)
}

const built = ORDER.map((file) => fs.readFileSync(path.join(srcDir, file), 'utf8')).join('')

if (process.argv.includes('--check')) {
  const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
  if (current !== built) {
    console.error('[build-client] client.js 与 src/client/*.js 不一致，请运行 npm run build:client')
    process.exit(1)
  }
  console.log(`[build-client] 一致：${ORDER.length} 个片段（${built.length} 字节）`)
  process.exit(0)
}

fs.writeFileSync(outFile, built)
console.log(`[build-client] 已生成 client.js：${ORDER.length} 个片段（${built.length} 字节）`)
