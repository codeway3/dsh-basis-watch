#!/usr/bin/env node
/**
 * 独立采集脚本：不依赖 DSH 宿主，可直接用 node 运行。
 *
 * 用途：让数据从 2026-11-12（葵油上市）起就能开始积累，
 * 即使界面还没做完、插件还没在 DSH 里启用。
 *
 * 用法：
 *   node scripts/collect.mjs --status
 *   node scripts/collect.mjs --bootstrap [--years=2]
 *   node scripts/collect.mjs --update            # 盘中：行情 + 新闻
 *   node scripts/collect.mjs --update --mode=close  # 收盘：日线 + 基差 + 仓单
 *   node scripts/collect.mjs --basis --date=2026-11-06
 *
 * 环境变量 DSH_HOME 可覆盖数据根目录的父目录。
 */

import { createStore, defaultDataRoot } from '../lib/store.js'
import { runJob } from '../lib/jobs.js'
import {
  bootstrap,
  localDate,
  rebuildContinuous,
  updateContractHistory,
  backfillEnergyBasis,
  updateAfterClose,
  updateEnergyRef,
  updateBasis,
  updateIntraday,
} from '../lib/collect.js'

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const val = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.split('=').slice(1).join('=')
}

const log = (msg) => console.log(`[basis-watch] ${msg}`)

/** 任务没跑成：打印原因并让退出码非 0，脚本化调用才不会被当成成功。 */
const notDone = (out) => {
  log(`未执行：${out.reason ?? out.error}`)
  process.exitCode = 1
}

const main = async () => {
  const store = createStore()
  store.ensure()
  log(`数据目录 ${store.root}`)

  if (has('--status')) {
    const coverage = store.coverage()
    console.log(JSON.stringify(coverage, null, 2))
    return
  }

  if (has('--bootstrap')) {
    const years = Number(val('years', 2))
    const skipExistingBasis = has('--skip-basis')
    log(`开始回填（基差回溯 ${years} 年${skipExistingBasis ? '，跳过已有完整交易日' : ''}）…`)
    const out = await runJob(
      store,
      'bootstrap',
      () => bootstrap(store, { basisYears: Number.isFinite(years) ? years : 2, skipExistingBasis, log }),
      { ttlMs: 2 * 3600 * 1000, lockName: 'backfill' },
    )
    if (!out.ok) {
      notDone(out)
      return
    }
    const summary = out.result
    const b = summary.basis ?? {}
    const basisText = b.skipped > 0
      ? `新增 ${b.ok ?? 0} 天 / 已有 ${b.skipped} 天 / 空 ${b.empty ?? 0} 天`
      : `基差 ${b.ok ?? 0} 天（空 ${b.empty ?? 0}）`
    log(`完成：日线 ${Object.keys(summary.daily).length} 个品种，${basisText}，仓单 ${Object.keys(summary.stock).length} 个品种`)
    if (summary.errors.length > 0) log(`错误 ${summary.errors.length} 条：${summary.errors.slice(0, 5).join('; ')}`)
    return
  }

  if (has('--energy-basis')) {
    const years = Number(val('years', '3'))
    const ref = await updateEnergyRef(store)
    const out = backfillEnergyBasis(store, Number.isFinite(years) && years > 0 ? years : 3)
    log(`能源参考：Brent ${ref.brent} 根 / 汇率 ${ref.fx} 天；回填基差 ${out.rows} 行（${out.from ?? '—'} ~ ${out.to ?? '—'}）`)
    return
  }

  if (has('--basis')) {
    const force = has('--force')
    const from = val('from', null)
    const to = val('to', null)
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
    if (from !== null || to !== null) {
      if (from === null || to === null || !DATE_RE.test(from) || !DATE_RE.test(to)) {
        log(`日期格式应为 YYYY-MM-DD：${from ?? '?'} ~ ${to ?? '?'}`)
        process.exitCode = 1
        return
      }
      const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)
      if (!Number.isFinite(span) || span < 0 || span > 1200) {
        log(`区间不合法或过大（${span} 天），一次最多 1200 天`)
        process.exitCode = 1
        return
      }
    }
    if (from !== null && to !== null) {
      // 批量修订：按交易日逐日重抓（源站事后修订历史数据时用）
      const { tradingDaysBetween } = await import('../lib/calendar.js')
      const days = tradingDaysBetween(from, to)
      log(`批量修订 ${from} ~ ${to}：${days.length} 个交易日${force ? '（覆盖旧值）' : '（只补缺失）'}`)
      const { sleep } = await import('../lib/http.js')
      const out = await runJob(
        store,
        'basis-batch',
        async () => {
          let rows = 0
          let matched = 0
          let replaced = 0
          const errors = []
          for (let i = 0; i < days.length; i += 1) {
            try {
              const res = await updateBasis(store, days[i], { force, quiet: true })
              rows += res.rows
              matched += res.matched
              replaced += res.replaced?.removed ?? 0
            } catch (error) {
              errors.push(`${days[i]}: ${error instanceof Error ? error.message : String(error)}`)
            }
            // 节流：连续几百天零间隔请求容易被源站限流/412
            await sleep(200)
            if ((i + 1) % 20 === 0 || i === days.length - 1) log(`  ${i + 1}/${days.length} ${days[i]} 累计 ${rows} 行`)
          }
          return { ok: errors.length === 0 ? true : 'partial', errors, dates: days.length, rows, matched, replaced }
        },
        // 与调度器 basis 任务互斥（同一数据集），长批量用 2 小时 TTL
        { ttlMs: 2 * 3600 * 1000 },
      )
      if (!out.ok) {
        notDone(out)
        return
      }
      log(`完成：${out.result.dates} 天，抓到 ${out.result.rows} 行，匹配 ${out.result.matched} 行，覆盖旧值 ${out.result.replaced} 行`)
      return
    }
    const date = val('date', localDate())
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      log(`日期格式应为 YYYY-MM-DD：${date}`)
      process.exitCode = 1
      return
    }
    const out = await runJob(store, 'basis', () => updateBasis(store, date, { force }), { watermarkOf: () => date })
    if (!out.ok) {
      notDone(out)
      return
    }
    const res = out.result
    log(`基差 ${date}: 抓到 ${res.rows} 行，匹配品种 ${res.matched} 行${force && res.replaced ? `，修订覆盖 ${res.replaced.removed} 行` : ''}`)
    return
  }

  if (has('--contracts')) {
    const years = Number(val('years', 3))
    log(`回填合约日线（覆盖 ${years} 年）…`)
    const out = await runJob(
      store,
      'contracts',
      async () => {
        const res = await updateContractHistory(store, {
          years: Number.isFinite(years) ? years : 3,
          onProgress: ({ done, total, code }) => {
            if (done % 10 === 0 || done === total) log(`  ${done}/${total} ${code}`)
          },
        })
        const rebuilt = await rebuildContinuous(store)
        return { ...res, rebuilt }
      },
      { ttlMs: 2 * 3600 * 1000, lockName: 'backfill' },
    )
    if (!out.ok) {
      notDone(out)
      return
    }
    const res = out.result
    log(`完成：新抓 ${res.fetched.length}，跳过已有 ${res.skipped.length}，失败 ${res.failed.length}`)
    log(`复权重建：${res.rebuilt.built.map((b) => `${b.code}(${b.rolls}次换月)`).join(' ')}`)
    return
  }

  if (has('--rebuild-continuous')) {
    // 重建会重写 continuous/*.json，必须与其它写任务互斥
    const out = await runJob(store, 'rebuild-continuous', () => rebuildContinuous(store), {
      ttlMs: 30 * 60 * 1000,
      lockName: 'backfill',
    })
    if (!out.ok) {
      notDone(out)
      return
    }
    log(`复权重建：${JSON.stringify(out.result.built)}`)
    return
  }

  if (has('--update')) {
    const mode = val('mode', 'intraday')
    // 收盘模式在 16:40 前不抓基差：当天现期表还没发布，抓了只会把任务判成 partial
    const { shanghaiMinutes } = await import('../lib/calendar.js')
    const withBasis = mode === 'close' ? shanghaiMinutes(new Date()) >= 16 * 60 + 40 : false
    const out = await runJob(
      store,
      mode === 'close' ? 'update-close' : 'update-intraday',
      async () => (mode === 'close' ? await updateAfterClose(store, new Date(), {}, { withBasis }) : await updateIntraday(store)),
      // 盘中任务的 watermark 是时刻（一天内可多次跑）；收盘任务是日期（一天一次）
      { watermarkOf: () => (mode === 'close' ? localDate() : new Date().toISOString()) },
    )
    if (!out.ok) {
      notDone(out)
      return
    }
    if (mode === 'close' && !withBasis) log('基差未抓（16:40 前），稍后由 --basis 或调度器补上')
    log(`更新完成（${mode}）：${JSON.stringify(out.result)}`)
    return
  }

  console.log(`期现瞭望 · 采集脚本
  数据目录: ${defaultDataRoot()}

  用法:
    --status              查看本地数据覆盖
    --bootstrap [--years=2] [--skip-basis]  首次回填（--skip-basis 跳过本地已有完整的交易日）
    --update [--mode=close]  增量更新（默认 intraday）
    --basis [--date=YYYY-MM-DD] [--force]  单独抓某天基差（force=同日修订）
    --contracts [--years=3]   回填历史合约日线并重建复权序列
    --energy-basis [--years=3] 更新 Brent/汇率并回填能源内外价差
    --rebuild-continuous      仅用已有合约数据重建复权序列`)
}

main().catch((error) => {
  console.error(`[basis-watch] 失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
