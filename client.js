/**
 * 期现瞭望 · 浏览器半
 *
 * 注册为 DSH 官方面板：
 * - `main`            整页（总览 / 套利 / 库存 / 资讯，可下钻品种详情）
 * - `sidebar.panellist` 侧边栏入口（默认隐藏，设置里开启）
 *
 * 所有数据来自 /basis-watch/api，全部读本地文件；页面不做任何外部请求。
 * 图表全部手绘 SVG，不引入第三方图表库。
 */

window.__ModuleLoader__.load({
  id: 'dsh-basis-watch',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useMemo, useRef, useCallback } = React
    const h = React.createElement

    const API = '/basis-watch/api'
    const PANEL_ID = 'basis-watch'
    const CFG_KEY = 'dsh-basis-watch.cfg.v1'

    /** apply 时捕获的插件上下文，供设置项调用 layout 服务。 */
    let pluginCtx = null

    /** 面板是否挂载中（= 用户当前在本插件内），快捷键据此决定是否顺带跳回会话。 */
    let panelActive = false

    /** 本插件自己的弹层（术语说明）是否打开；打开时快捷键不响应。 */
    let panelModalOpen = false

    /* ───────────── 配置 ───────────── */

    const DEFAULT_CFG = { showEntry: false }

    /** 资讯来源说明（按板块），总览与资讯页共用。 */
    const NEWS_SOURCE_LABEL = {
      oil: '粮油网 · 油脂油料',
      black: '金十快讯 · 黑色关键词',
      chem: '金十快讯 · 能化关键词',
      nonferrous: '金十快讯 · 有色关键词',
      agri: '金十快讯 · 农产品关键词',
      precious: '金十快讯 · 贵金属关键词',
      newenergy: '金十快讯 · 新能源关键词',
      energy: '金十快讯 · 能源关键词',
      other: '金十快讯 · 其他关键词',
      cffex: '中金所公告 · 金十快讯',
    }

    const cfgSubs = new Set()
    let cfgMemo = null
    function readCfg() {
      if (cfgMemo !== null) return cfgMemo
      let out = Object.assign({}, DEFAULT_CFG)
      try {
        const raw = localStorage.getItem(CFG_KEY)
        if (raw) out = Object.assign(out, JSON.parse(raw))
      } catch {
        /* localStorage 不可用时用默认值 */
      }
      cfgMemo = out
      return out
    }
    function writeCfg(patch) {
      const next = Object.assign({}, readCfg(), patch)
      cfgMemo = next
      try {
        localStorage.setItem(CFG_KEY, JSON.stringify(next))
      } catch {
        /* 忽略 */
      }
      for (const fn of cfgSubs) fn(next)
    }

    /**
     * 面板内视图状态（页签、套利模式、跨期品种）。
     * 放在 localStorage 而不是组件 state：切到别的页签再回来不会重置。
     */
    const VIEW_KEY = 'dsh-basis-watch.view.v1'

    function readView() {
      const fallback = { tab: 'overview', board: 'oil', spreadsMode: 'cross', termCode: null }
      try {
        const raw = localStorage.getItem(VIEW_KEY)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        return Object.assign(fallback, parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        return fallback
      }
    }

    function writeView(patch) {
      try {
        localStorage.setItem(VIEW_KEY, JSON.stringify(Object.assign({}, readView(), patch)))
      } catch {
        /* 忽略 */
      }
    }

    /* ───────────── 样式 ───────────── */

    const CSS = `
      .bw-page{height:100%;display:flex;flex-direction:column;min-height:0;
        font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary,#e6e8eb);
        background:var(--dsw-alias-bg-base,#141517)}
      .bw-head{display:flex;align-items:center;gap:12px;padding:10px 16px 0;flex:none;flex-wrap:wrap}
      .bw-title{font-size:14px;font-weight:600;letter-spacing:.02em}
      .bw-tabs{display:flex;gap:2px;margin-left:8px}
      .bw-tab{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#868c94);
        font:inherit;font-size:12.5px;padding:6px 10px;cursor:pointer;border-radius:6px 6px 0 0;
        border-bottom:2px solid transparent}
      .bw-tab:hover{color:var(--dsw-alias-label-primary,#e6e8eb)}
      .bw-tab[data-on="1"]{color:var(--dsw-alias-label-primary,#e6e8eb);border-bottom-color:var(--dsw-alias-label-primary,#e6e8eb)}
      /* 板块切换：外层上下文，放在标题行 */
      /* 板块切换：外层上下文，放在标题行；10 个板块用短标签平铺，放不下自动换行 */
      .bw-boardbar{display:inline-flex;flex-wrap:wrap;gap:2px;margin-left:10px;padding:2px;
        border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.10));border-radius:8px;max-width:100%}
      .bw-board{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#868c94);font:inherit;font-size:11px;
        padding:3px 8px;border-radius:6px;cursor:pointer;white-space:nowrap}
      .bw-board:hover{color:var(--dsw-alias-label-primary,#e6e8eb)}
      .bw-board[data-on="1"]{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.10));color:var(--dsw-alias-label-primary,#e6e8eb)}
      .bw-sortbtns{display:inline-flex;gap:8px;margin-left:auto}
      .bw-movebtns{display:inline-flex;gap:2px;margin-left:6px}
      .bw-movebtn{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:transparent;color:var(--dsw-alias-label-tertiary,#868c94);
        font-size:11px;line-height:1;padding:2px 5px;border-radius:4px;cursor:pointer}
      .bw-movebtn:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e8eb)}
      .bw-movebtn:disabled{opacity:.35;cursor:default}
      .bw-table tbody tr{height:38px}
      .bw-table tbody td{vertical-align:middle}
      .bw-tabsrow{display:flex;padding:0 16px;flex:none}
      .bw-tabsrow .bw-tabs{margin-left:0}
      .bw-spacer{flex:1}
      .bw-caliber{font-size:11px;color:var(--dsw-alias-label-quaternary,#6b7280);padding:2px 0 8px}
      .bw-fresh{font-size:11px;color:var(--dsw-alias-label-quaternary,#6b7280);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:42%}
      .bw-stale{font-size:11px;padding:4px 10px;border-radius:6px;margin:0 0 8px;
        background:rgba(240,180,80,.12);color:#d8a657;border:1px solid rgba(240,180,80,.3)}
      .bw-btn{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:transparent;
        color:inherit;font:inherit;font-size:12px;padding:4px 9px;border-radius:6px;cursor:pointer}
      .bw-btn:hover{border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.2))}
      .bw-body{flex:1;overflow:auto;padding:10px 16px 20px;min-height:0}
      /* 内容按栅格排布：宽屏居中定宽、窄屏铺满，卡片与表格共用同一套边距 */
      .bw-body-inner{width:100%;max-width:1440px;margin:0 auto}
      .bw-card{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.09));border-radius:10px;
        padding:10px 12px;margin-bottom:12px;background:color-mix(in srgb, var(--dsw-alias-bg-l1,#1b1c1f) 55%, transparent)}
      .bw-card-head{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}
      .bw-card-title{font-size:12.5px;font-weight:600}
      .bw-card-sub{font-size:11px;color:var(--dsw-alias-label-quaternary,#6b7280)}
      /* 固定表格算法 + 每列定宽：表头与单元格永远同一套列宽，不再各自为政 */
      .bw-table{width:100%;border-collapse:collapse;font-size:12.5px;table-layout:fixed}
      .bw-table th,.bw-table td{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .bw-table th:nth-child(1){width:15%}
      .bw-table th:nth-child(2){width:11%}
      .bw-table th:nth-child(3){width:11%}
      .bw-table th:nth-child(4){width:12%}
      .bw-table th:nth-child(5){width:19%}
      .bw-table th:nth-child(6){width:12%}
      .bw-table th:nth-child(7){width:9%}
      .bw-table th:nth-child(8){width:11%}
      .bw-table th{text-align:right;font-weight:500;color:var(--dsw-alias-label-quaternary,#6b7280);
        font-size:11px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08))}
      .bw-table th:first-child,.bw-table td:first-child{text-align:left}
      .bw-table td{text-align:right;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.05));
        font-variant-numeric:tabular-nums}
      /* 陈旧数据：与最新日期不同日的合约行整体压暗，避免被当成同一天的价格 */
      .bw-table tr.bw-stale td{color:var(--dsw-alias-label-quaternary,#6b7280);opacity:.72}
      /* 两栏布局：左图表、右资讯；两栏等高拉伸，视觉上成为一块 */
      .bw-cols{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(300px,1fr);gap:12px;align-items:stretch}
      .bw-cols>.bw-card{margin-bottom:0}
      .bw-colstack{display:flex;flex-direction:column;gap:12px;min-width:0}
      .bw-colstack>.bw-card{margin-bottom:0}
      .bw-colstack>.bw-card:last-child{flex:1 1 auto}
      /* 响应式用**容器查询**：面板宽度由壳子决定，和视口宽度不是一回事。
         保留同阈值的 @media 作为老内核兜底（不支持 @container 时仍能收窄）。 */
      .bw-page{container-type:inline-size;container-name:bw}
      @container bw (max-width:1120px){
        .bw-cols{grid-template-columns:minmax(0,1fr)}
        .bw-table th:nth-child(8),.bw-table td:nth-child(8){display:none}
        .bw-table th:nth-child(5){width:26%}
      }
      @container bw (max-width:760px){
        .bw-body{padding:8px 10px 16px}
        .bw-table th:nth-child(7),.bw-table td:nth-child(7){display:none}
        .bw-table{font-size:12px}
        .bw-table th:nth-child(1){width:22%}
        .bw-table th:nth-child(5){width:34%}
      }
      /* 跨期表：窄屏优先隐藏 流动性→持仓量，分位始终保留 */
      @container bw (max-width:1120px){
        .bw-table--term th:nth-child(8),.bw-table--term td:nth-child(8){display:none}
      }
      @container bw (max-width:760px){
        .bw-table--term th:nth-child(7),.bw-table--term td:nth-child(7){display:none}
      }
      @container bw (max-width:600px){
        .bw-table--term th:nth-child(5),.bw-table--term td:nth-child(5){display:none}
        .bw-table--term th:nth-child(1){width:26%}
      }
      @container bw (max-width:600px){
        .bw-table th:nth-child(6),.bw-table td:nth-child(6){display:none}
        .bw-table th:nth-child(1){width:24%}
        .bw-table th:nth-child(2){width:20%}
        .bw-table th:nth-child(3){width:18%}
        .bw-table th:nth-child(4){width:16%}
        .bw-table th:nth-child(5){width:22%}
      }
      @media (max-width:1120px){
        .bw-cols{grid-template-columns:minmax(0,1fr)}
        .bw-table th:nth-child(8),.bw-table td:nth-child(8){display:none}
        .bw-table th:nth-child(5){width:26%}
      }
      @media (max-width:760px){
        .bw-body{padding:8px 10px 16px}
        .bw-table th:nth-child(7),.bw-table td:nth-child(7){display:none}
        .bw-table{font-size:12px}
        .bw-table th:nth-child(1){width:22%}
        .bw-table th:nth-child(5){width:34%}
      }
      @media (max-width:600px){
        .bw-table th:nth-child(6),.bw-table td:nth-child(6){display:none}
        .bw-table th:nth-child(1){width:24%}
        .bw-table th:nth-child(2){width:20%}
        .bw-table th:nth-child(3){width:18%}
        .bw-table th:nth-child(4){width:16%}
        .bw-table th:nth-child(5){width:22%}
      }
      .bw-row{cursor:pointer}
      .bw-row:hover td{background:color-mix(in srgb, var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05)) 70%, transparent)}
      .bw-num{font-variant-numeric:tabular-nums}
      /* 单元格内上下两行：主数值 + 单位/比率 */
      .bw-stack{display:inline-flex;flex-direction:column;align-items:flex-end;line-height:1.3}
      .bw-stack-sub{font-size:10.5px;font-weight:400;color:var(--dsw-alias-label-quaternary,#6b7280)}
      .bw-up{color:#c8553d}
      .bw-down{color:#3f8f5f}
      .bw-muted{color:var(--dsw-alias-label-quaternary,#6b7280)}
      .bw-bar{position:relative;height:6px;border-radius:3px;background:var(--dsw-alias-border-l2,rgba(255,255,255,.08));min-width:78px}
      .bw-bar>i{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:var(--dsw-alias-label-tertiary,#868c94)}
      .bw-bar>b{position:absolute;top:-2px;width:2px;height:10px;background:var(--dsw-alias-label-primary,#e6e8eb)}
      /* 走势图容器：让 svg 参与行内排版，才能跟随单元格右对齐 */
      .bw-spark{display:inline-flex;align-items:center;vertical-align:middle}
      /* 分位图例与答疑弹层 */
      .bw-legend{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;font-size:11px;
        color:var(--dsw-alias-label-quaternary,#6b7280);line-height:1.7}
      .bw-link{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#b6bcc4);font:inherit;
        font-size:11px;cursor:pointer;padding:0;border-bottom:1px dashed currentColor}
      .bw-link:hover{color:var(--dsw-alias-label-primary,#e6e8eb)}
      .bw-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;
        justify-content:center;z-index:120;padding:16px}
      .bw-modal{width:min(760px,100%);max-height:82vh;overflow:auto;border-radius:12px;padding:16px 18px;
        background:var(--dsw-alias-bg-l1,#1b1c1f);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
        box-shadow:0 24px 64px rgba(0,0,0,.55)}
      .bw-modal-head{display:flex;align-items:center;gap:10px;margin-bottom:6px}
      .bw-modal h3{margin:0;font-size:14px;font-weight:600}
      .bw-modal h4{margin:16px 0 4px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#b6bcc4)}
      .bw-modal p{margin:0 0 6px;font-size:12px;line-height:1.8;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
      .bw-modal b{color:var(--dsw-alias-label-primary,#e6e8eb);font-weight:600}
      .bw-swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
      .bw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
      .bw-kv{display:flex;justify-content:space-between;gap:10px;padding:2px 0;font-size:12px}
      .bw-kv>span:first-child{color:var(--dsw-alias-label-quaternary,#6b7280)}
      .bw-news{display:flex;flex-direction:column;gap:6px}
      .bw-news a{color:inherit;text-decoration:none}
      .bw-news a:hover{text-decoration:underline}
      .bw-news-item{display:flex;gap:8px;font-size:12px;line-height:1.5}
      .bw-news-time{color:var(--dsw-alias-label-quaternary,#6b7280);font-variant-numeric:tabular-nums;flex:none}
      .bw-tag{font-size:10px;padding:0 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));
        color:var(--dsw-alias-label-tertiary,#868c94);flex:none}
      .bw-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-quaternary,#6b7280);font-size:12.5px}
      .bw-loading{padding:16px;color:var(--dsw-alias-label-quaternary,#6b7280);font-size:12.5px}
      /* 套利页分段控件：跨品种 / 跨期 */
      .bw-seg{display:inline-flex;gap:2px;margin-left:10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.10));
        border-radius:6px;overflow:hidden}
      .bw-seg-btn{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#868c94);padding:3px 10px;font-size:12px;cursor:pointer}
      .bw-seg-btn[data-on="1"]{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#e6e8eb)}
      /* 品种切换 chip */
      .bw-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
      .bw-chip{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.10));background:transparent;
        color:var(--dsw-alias-label-secondary,#a8adb5);border-radius:999px;padding:2px 10px;font-size:12px;cursor:pointer}
      .bw-chip[data-on="1"]{border-color:var(--dsw-alias-label-primary,#e6e8eb);color:var(--dsw-alias-label-primary,#e6e8eb)}
      /* 跨期表 8 列，列宽与响应式隐藏顺序和总览表不同 */
      .bw-table--term th:nth-child(1){width:18%}
      .bw-table--term th:nth-child(2){width:14%}
      .bw-table--term th:nth-child(3){width:11%}
      .bw-table--term th:nth-child(4){width:11%}
      .bw-table--term th:nth-child(5){width:11%}
      .bw-table--term th:nth-child(6){width:15%}
      .bw-table--term th:nth-child(7){width:12%}
      .bw-table--term th:nth-child(8){width:8%}
      .bw-detail-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
      .bw-back{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#868c94);cursor:pointer;font:inherit;font-size:12px}
      .bw-back:hover{color:var(--dsw-alias-label-primary,#e6e8eb)}
      .bw-crumb{font-size:12px;color:var(--dsw-alias-label-quaternary,#6b7280)}
      .bw-chips{display:flex;gap:6px;flex-wrap:wrap}
      .bw-chip{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:999px;
        padding:2px 9px;font-size:11.5px;cursor:pointer;color:var(--dsw-alias-label-tertiary,#868c94);background:transparent;font:inherit}
      .bw-chip[data-on="1"]{color:var(--dsw-alias-label-primary,#e6e8eb);border-color:var(--dsw-alias-label-primary,#e6e8eb)}
      .bw-set{max-width:520px;font-size:12.5px}
      .bw-set-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.06))}
      .bw-set-hint{color:var(--dsw-alias-label-quaternary,#6b7280);font-size:11.5px;line-height:1.6}
      .bw-icon{display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%}
      .bw-pending{opacity:.55}
    `

    let stylesInjected = false
    function injectStyles() {
      if (stylesInjected) return
      stylesInjected = true
      const tag = document.createElement('style')
      tag.dataset.bwStyle = 'basis-watch'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ───────────── 工具 ───────────── */

    const fmt = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '—')
    const pct = (v, digits = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(digits) + '%' : '—')
    const int = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('zh-CN') : '—')
    const cls = (v) => (!Number.isFinite(v) || v === 0 ? 'bw-muted' : v > 0 ? 'bw-up' : 'bw-down')
    /** 手数 → 万手（跨期表用）；缺失显示 — */
    const wan = (v) => (Number.isFinite(v) ? `${(v / 10000).toFixed(1)}万` : '—')

    /**
     * SVG 折线：把数值序列映射到给定宽高。
     *
     * 外面必须包一层 inline-flex 的 span：`<svg>` 是替换元素，若按块级渲染，
     * 父单元格的 `text-align:right` 对它无效，会靠左 —— 这就是走势图与表头错位的原因。
     */
    function Spark({ values, width = 78, height = 20, tone = 'muted', strokeWidth = 1.2 }) {
      const use = (values ?? []).filter((v) => Number.isFinite(v))
      if (use.length < 2) return h('span', { className: 'bw-muted', style: { fontSize: 11 } }, '—')
      const min = Math.min(...use)
      const max = Math.max(...use)
      const span = max - min || 1
      const step = width / (use.length - 1)
      const points = use.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`).join(' ')
      const color = tone === 'up' ? '#c8553d' : tone === 'down' ? '#3f8f5f' : 'currentColor'
      return h(
        'span',
        { className: 'bw-spark' },
        h(
          'svg',
          { width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true', style: { display: 'block', color: 'var(--dsw-alias-label-tertiary,#868c94)' } },
          h('polyline', { points, fill: 'none', stroke: color, strokeWidth, strokeLinejoin: 'round', strokeLinecap: 'round' }),
        ),
      )
    }

    /** 分位 5 档配色：低 → 高（冷 → 暖）。只做视觉分级，不代表贵贱判断。 */
    const PCT_STAGES = [
      { limit: 20, color: '#4a9ecf', label: '很低' },
      { limit: 40, color: '#5cab9b', label: '偏低' },
      { limit: 60, color: '#9aa0a8', label: '居中' },
      { limit: 80, color: '#cf8a4c', label: '偏高' },
      { limit: Infinity, color: '#c8553d', label: '很高' },
    ]
    const pctStage = (v) => PCT_STAGES.find((s) => v < s.limit) ?? PCT_STAGES[PCT_STAGES.length - 1]
    const PCT_GRADIENT = 'linear-gradient(90deg,#4a9ecf 0%,#5cab9b 20%,#9aa0a8 40%,#cf8a4c 60%,#c8553d 80%,#c8553d 100%)'

    /** 分位条：0–100，分段渐变填充 + 当前值标记。fluid=true 时条宽自适应单元格。 */
    function PercentileBar({ value, label, fluid = false, hint }) {
      if (!Number.isFinite(value)) {
        return h('span', { className: 'bw-muted', style: { fontSize: 11 }, title: '本地历史样本太少，暂算不出分位' }, '样本不足')
      }
      const clamped = Math.max(0, Math.min(100, value))
      const stage = pctStage(clamped)
      const title = hint ?? `当前值在历史样本中的位置：${Math.round(value)}（0 = 历史最低，100 = 历史最高），阶段「${stage.label}」。分位只描述位置，不代表该买或该卖。`
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6, width: fluid ? '100%' : undefined, justifyContent: 'flex-end' }, title },
        h(
          'span',
          { className: 'bw-bar', style: fluid ? { width: 'auto', flex: '1 1 auto', minWidth: 40, maxWidth: 120 } : { width: 84 } },
          h('i', {
            style: {
              width: `${clamped}%`,
              // 渐变按整条 100% 铺设，再按当前值裁剪，所以同一分位在任何宽度下颜色一致
              backgroundImage: PCT_GRADIENT,
              backgroundSize: `${(100 / Math.max(clamped, 1)) * 100}% 100%`,
              backgroundRepeat: 'no-repeat',
            },
          }),
          h('b', { style: { left: `${clamped}%`, background: stage.color } }),
        ),
        h('span', { className: 'bw-num', style: { fontSize: 11.5, minWidth: 34, textAlign: 'right', color: stage.color } }, `${Math.round(value)}%`),
        label ? h('span', { className: 'bw-muted', style: { fontSize: 10.5 } }, label) : null,
      )
    }

    /* ───────────── 图表 ───────────── */

    /**
     * 测量容器宽度。
     *
     * 之前的图用 `preserveAspectRatio="none"` + viewBox 固定宽度，等于把坐标系
     * 横向硬拉伸 —— 宽度越大变形越严重，这就是"图很丑"的根因。
     * 现在按真实像素宽度绘制，永不拉伸。
     */
    function useWidth() {
      const ref = useRef(null)
      const [width, setWidth] = useState(0)
      useEffect(() => {
        const el = ref.current
        if (el === null) return undefined
        const update = () => setWidth(el.clientWidth)
        update()
        if (typeof ResizeObserver === 'undefined') return undefined
        const ro = new ResizeObserver(update)
        ro.observe(el)
        return () => ro.disconnect()
      }, [])
      return [ref, width]
    }

    /** 生成 1/2/5 × 10^n 的刻度。 */
    function niceTicks(min, max, count = 5) {
      if (!Number.isFinite(min) || !Number.isFinite(max)) return { ticks: [], lo: 0, hi: 1 }
      if (min === max) return { ticks: [min], lo: min - 1, hi: max + 1 }
      const rawStep = (max - min) / count
      const mag = 10 ** Math.floor(Math.log10(Math.abs(rawStep) || 1))
      const norm = rawStep / mag
      const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
      const lo = Math.floor(min / step) * step
      const hi = Math.ceil(max / step) * step
      const ticks = []
      for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)))
      return { ticks, lo, hi, step }
    }

    /** 把 asOf 汇总成一句"数据时点"（过期项加 ⚠）。 */
    function freshLabel(asOf) {
      if (asOf === undefined || asOf === null) return ''
      const fmt = (key) => {
        const item = asOf[key]
        if (item === undefined || item.asOf === null) return '—'
        const at = String(item.asOf).slice(5, 16).replace('T', ' ')
        return item.stale === true ? `${at}⚠` : at
      }
      return `行情 ${fmt('quotes')} · 基差 ${fmt('basis')} · 日线 ${fmt('daily')}`
    }

    /** 数字缩写：1.2 万 / 3.4 亿。 */
    function abbr(v) {
      if (!Number.isFinite(v)) return '—'
      const a = Math.abs(v)
      if (a >= 1e8) return (v / 1e8).toFixed(1) + '亿'
      if (a >= 1e4) return (v / 1e4).toFixed(1) + '万'
      if (a >= 100) return v.toFixed(0)
      if (a >= 1) return v.toFixed(1)
      return v.toFixed(2)
    }

    /**
     * 折线/面积图：左轴 + 可选右轴、网格、刻度、十字线与读数气泡。
     *
     * 序列统一成 {date, value} 点集后**按日期 join**（取并集再各自取点）：
     * 早先按数组长度右对齐，基差少一天整条曲线就错位几天。
     *
     * @param {object} props
     * @param {Array<{name: string, points?: {date: string, value: number}[], values?: number[], color?: string, axis?: 'left'|'right', area?: boolean, dash?: boolean}>} props.series
     * @param {string[]} props.labels points 缺日期时按位置回退
     * @param {number} [props.height]
     */
    function LineChart({ series = [], labels = [], height = 200, formatLeft = abbr, formatRight = (v) => v.toFixed(2) + '%', width: forcedWidth }) {
      const [ref, measured] = useWidth()
      const width = measured || forcedWidth || 0
      const [hover, setHover] = useState(null)
      const gid = useMemo(() => 'bwg' + Math.random().toString(36).slice(2, 8), [])
      const usable = series
        .map((s) => {
          const points = Array.isArray(s.points)
            ? s.points
            : (s.values ?? []).map((v, i) => ({ date: labels[i] ?? String(i), value: v }))
          return { ...s, points: points.filter((p) => Number.isFinite(p?.value)) }
        })
        .filter((s) => s.points.length >= 2)
      // X 轴 = 所有序列日期的并集（排序后），缺数据处断开而不是整体平移
      const xDates = [...new Set(usable.flatMap((s) => s.points.map((p) => p.date)))].sort()
      const xIndex = new Map(xDates.map((d, i) => [d, i]))
      const n = xDates.length
      const hasRight = usable.some((s) => s.axis === 'right')
      const padL = 46
      const padR = hasRight ? 60 : 14
      const padT = 10
      const padB = 22
      if (usable.length === 0 || n < 2) return h('div', { ref, style: { height } }, h('div', { className: 'bw-empty' }, '暂无数据'))
      if (width < 120) return h('div', { ref, style: { height } })

      const plotW = Math.max(10, width - padL - padR)
      const plotH = Math.max(10, height - padT - padB)
      const rangeOf = (list) => {
        const vals = list.flatMap((s) => s.points.map((p) => p.value)).filter((v) => Number.isFinite(v))
        if (vals.length === 0) return { lo: 0, hi: 1 }
        let lo = Math.min(...vals)
        let hi = Math.max(...vals)
        const pad = (hi - lo) * 0.1 || Math.abs(hi || 1) * 0.05
        return { lo: lo - pad, hi: hi + pad }
      }
      const leftRange = rangeOf(usable.filter((s) => s.axis !== 'right'))
      const rightRange = hasRight ? rangeOf(usable.filter((s) => s.axis === 'right')) : null
      const xOf = (i) => padL + (i / (n - 1)) * plotW
      const leftTicks = niceTicks(leftRange.lo, leftRange.hi, 4)
      const rightTicks = rightRange === null ? null : niceTicks(rightRange.lo, rightRange.hi, 4)
      // 映射必须用"刻度范围"（niceTicks 会向外扩），否则最外侧刻度会画到画布外
      const yOf = (v, r) => padT + plotH - ((v - r.lo) / (r.hi - r.lo || 1)) * plotH

      // 面积渐变需要稳定 id；颜色取自 series
      const paths = usable.map((s, si) => {
        const r = s.axis === 'right' ? rightTicks ?? leftTicks : leftTicks
        const pts = []
        const byDate = new Map()
        for (const p of s.points) {
          const idx = xIndex.get(p.date)
          if (idx === undefined) continue
          byDate.set(p.date, p.value)
          pts.push(`${xOf(idx).toFixed(1)},${yOf(p.value, r).toFixed(1)}`)
        }
        return { s, si, r, byDate, pts }
      })

      const xLabelIdx = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i)
      const hoverDate = hover === null ? null : xDates[hover]
      const hoverItem = hoverDate === null ? null : paths
        .map((p) => ({
          name: p.s.name,
          value: p.byDate.get(hoverDate),
          axis: p.s.axis ?? 'left',
          color: p.s.color,
        }))
        .filter((it) => Number.isFinite(it.value))

      return h(
        'div',
        { ref, style: { position: 'relative', height } },
        h(
          'svg',
          {
            role: 'img',
            'aria-label': series.map((s) => s.name).filter(Boolean).join(' / ') || '走势图',
            width,
            height,
            style: { display: 'block', overflow: 'visible' },
            onMouseMove: (e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const x = e.clientX - rect.left
              if (x < padL - 2 || x > padL + plotW + 2) return setHover(null)
              const idx = Math.round(((x - padL) / plotW) * (n - 1))
              setHover(Math.max(0, Math.min(n - 1, idx)))
            },
            onMouseLeave: () => setHover(null),
          },
          h(
            'defs',
            null,
            h(
              'linearGradient',
              { id: `${gid}-area`, x1: '0', y1: '0', x2: '0', y2: '1' },
              h('stop', { offset: '0%', stopColor: 'var(--dsw-alias-label-secondary,#9aa0a8)', stopOpacity: 0.16 }),
              h('stop', { offset: '100%', stopColor: 'var(--dsw-alias-label-secondary,#9aa0a8)', stopOpacity: 0.02 }),
            ),
          ),
          // 网格 + 左轴刻度
          leftTicks.ticks.map((t) =>
            h(
              'g',
              { key: 'lg' + t },
              h('line', { x1: padL, x2: padL + plotW, y1: yOf(t, leftTicks), y2: yOf(t, leftTicks), stroke: 'var(--dsw-alias-border-l2,rgba(255,255,255,.07))', strokeWidth: 1 }),
              h('text', { x: padL - 6, y: yOf(t, leftTicks) + 3.5, textAnchor: 'end', fontSize: 10, fill: 'var(--dsw-alias-label-quaternary,#6b7280)' }, formatLeft(t)),
            ),
          ),
          // 右轴刻度
          rightTicks === null
            ? null
            : rightTicks.ticks.map((t) =>
                h(
                  'text',
                  { key: 'rg' + t, x: padL + plotW + 6, y: yOf(t, rightTicks) + 3.5, fontSize: 10, fill: 'var(--dsw-alias-label-quaternary,#6b7280)' },
                  formatRight(t),
                ),
              ),
          // X 轴标签
          xLabelIdx.map((i) =>
            h(
              'text',
              {
                key: 'xl' + i,
                x: xOf(i),
                y: height - 6,
                textAnchor: i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
                fontSize: 10,
                fill: 'var(--dsw-alias-label-quaternary,#6b7280)',
              },
              String(xDates[i] ?? '').slice(5),
            ),
          ),
          // 数据
          paths.map((p) => {
            if (p.pts.length < 2) return null
            const isArea = p.s.area === true && p.s.axis !== 'right'
            const line = h('polyline', {
              key: 'ln' + p.si,
              points: p.pts.join(' '),
              fill: 'none',
              stroke: p.s.color ?? 'var(--dsw-alias-label-secondary,#9aa0a8)',
              strokeWidth: p.s.axis === 'right' ? 1.2 : 1.5,
              strokeDasharray: p.s.dash ? '3 3' : undefined,
              strokeLinejoin: 'round',
              strokeLinecap: 'round',
            })
            if (!isArea) return line
            const areaPts = `${p.pts[0].split(',')[0]},${padT + plotH} ` + p.pts.join(' ') + ` ${p.pts[p.pts.length - 1].split(',')[0]},${padT + plotH}`
            return h('g', { key: 'ar' + p.si }, h('polygon', { points: areaPts, fill: `url(#${gid}-area)` }), line)
          }),
          // 十字线
          hover === null
            ? null
            : h(
                'g',
                null,
                h('line', { x1: xOf(hover), x2: xOf(hover), y1: padT, y2: padT + plotH, stroke: 'var(--dsw-alias-label-quaternary,#6b7280)', strokeDasharray: '3 3', strokeWidth: 1 }),
                hoverItem.map((it) =>
                  h('circle', {
                    key: 'dot' + it.name,
                    cx: xOf(hover),
                    cy: yOf(it.value, it.axis === 'right' ? (rightTicks ?? leftTicks) : leftTicks),
                    r: 3,
                    fill: it.color ?? 'var(--dsw-alias-label-primary,#e6e8eb)',
                  }),
                ),
              ),
        ),
        hover === null
          ? null
          : h(
              'div',
              {
                style: {
                  position: 'absolute',
                  left: Math.min(Math.max(xOf(hover) + 10, 8), Math.max(8, width - 150)),
                  top: 6,
                  pointerEvents: 'none',
                  background: 'color-mix(in srgb, var(--dsw-alias-bg-l1,#1b1c1f) 92%, transparent)',
                  border: '1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14))',
                  borderRadius: 6,
                  padding: '5px 8px',
                  fontSize: 11,
                  lineHeight: 1.6,
                  whiteSpace: 'nowrap',
                  boxShadow: '0 4px 14px rgba(0,0,0,.25)',
                },
              },
              h('div', { style: { color: 'var(--dsw-alias-label-quaternary,#6b7280)' } }, String(xDates[hover] ?? '').slice(0, 10)),
              hoverItem.map((it) =>
                h(
                  'div',
                  { key: 'tip' + it.name, style: { display: 'flex', gap: 8, justifyContent: 'space-between' } },
                  h('span', { style: { color: 'var(--dsw-alias-label-tertiary,#868c94)' } }, it.name),
                  h('span', { className: 'bw-num' }, it.axis === 'right' ? formatRight(it.value) : formatLeft(it.value)),
                ),
              ),
            ),
      )
    }

    /**
     * K 线图（详情页用）：红涨绿跌、带影线、十字线读数。
     * @param {{bars: Array<{d: string, o: number, h: number, l: number, c: number}>}} props
     */
    function CandleChart({ bars = [], height = 260, labels = [], width: forcedWidth }) {
      const [ref, measured] = useWidth()
      const width = measured || forcedWidth || 0
      const [hover, setHover] = useState(null)
      const use = bars.filter((b) => [b.o, b.h, b.l, b.c].every((v) => Number.isFinite(v)))
      if (use.length < 2) return h('div', { ref, style: { height } }, h('div', { className: 'bw-empty' }, '暂无 K 线数据'))
      if (width < 120) return h('div', { ref, style: { height } })
      const padL = 46
      const padR = 12
      const padT = 10
      const padB = 22
      const plotW = Math.max(10, width - padL - padR)
      const plotH = Math.max(10, height - padT - padB)
      const lo = Math.min(...use.map((b) => b.l))
      const hi = Math.max(...use.map((b) => b.h))
      const ticks = niceTicks(lo, hi, 4)
      const xOf = (i) => padL + ((i + 0.5) / use.length) * plotW
      const yOf = (v) => padT + plotH - ((v - ticks.lo) / (ticks.hi - ticks.lo || 1)) * plotH
      const cw = Math.max(1, (plotW / use.length) * 0.62)
      const hoverBar = hover === null ? null : use[hover]
      return h(
        'div',
        { ref, style: { position: 'relative', height } },
        h(
          'svg',
          {
            role: 'img',
            'aria-label': '价格 K 线图（日线）',
            width,
            height,
            style: { display: 'block' },
            onMouseMove: (e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const x = e.clientX - rect.left
              if (x < padL || x > padL + plotW) return setHover(null)
              setHover(Math.max(0, Math.min(use.length - 1, Math.floor(((x - padL) / plotW) * use.length))))
            },
            onMouseLeave: () => setHover(null),
          },
          ticks.ticks.map((t) =>
            h(
              'g',
              { key: 'k' + t },
              h('line', { x1: padL, x2: padL + plotW, y1: yOf(t), y2: yOf(t), stroke: 'var(--dsw-alias-border-l2,rgba(255,255,255,.07))' }),
              h('text', { x: padL - 6, y: yOf(t) + 3.5, textAnchor: 'end', fontSize: 10, fill: 'var(--dsw-alias-label-quaternary,#6b7280)' }, abbr(t)),
            ),
          ),
          use.map((b, i) => {
            const up = b.c >= b.o
            const color = up ? '#c8553d' : '#3f8f5f'
            const x = xOf(i)
            return h(
              'g',
              { key: 'c' + i },
              h('line', { x1: x, x2: x, y1: yOf(b.h), y2: yOf(b.l), stroke: color, strokeWidth: 1 }),
              h('rect', {
                x: x - cw / 2,
                y: Math.min(yOf(b.o), yOf(b.c)),
                width: cw,
                height: Math.max(1, Math.abs(yOf(b.c) - yOf(b.o))),
                fill: color,
              }),
            )
          }),
          hover === null
            ? null
            : h('line', { x1: xOf(hover), x2: xOf(hover), y1: padT, y2: padT + plotH, stroke: 'var(--dsw-alias-label-quaternary,#6b7280)', strokeDasharray: '3 3' }),
          [0, Math.floor((use.length - 1) / 2), use.length - 1].map((i) =>
            h(
              'text',
              { key: 'kx' + i, x: xOf(i), y: height - 6, textAnchor: i === 0 ? 'start' : i === use.length - 1 ? 'end' : 'middle', fontSize: 10, fill: 'var(--dsw-alias-label-quaternary,#6b7280)' },
              String(use[i]?.d ?? labels[i] ?? '').slice(5),
            ),
          ),
        ),
        hoverBar === null
          ? null
          : h(
              'div',
              {
                style: {
                  position: 'absolute',
                  right: 8,
                  top: 6,
                  pointerEvents: 'none',
                  background: 'color-mix(in srgb, var(--dsw-alias-bg-l1,#1b1c1f) 92%, transparent)',
                  border: '1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14))',
                  borderRadius: 6,
                  padding: '5px 8px',
                  fontSize: 11,
                  lineHeight: 1.6,
                  fontVariantNumeric: 'tabular-nums',
                },
              },
              h('div', { style: { color: 'var(--dsw-alias-label-quaternary,#6b7280)' } }, hoverBar.d),
              h('div', null, `开 ${abbr(hoverBar.o)}　高 ${abbr(hoverBar.h)}`),
              h('div', null, `低 ${abbr(hoverBar.l)}　收 ${abbr(hoverBar.c)}`),
            ),
      )
    }

    /** 季节性：近 N 年分位带 + 当年曲线（口径：相对当年首个收盘的百分比）。 */
    function SeasonChart({ season, height = 200, width: forcedWidth }) {
      const [ref, measured] = useWidth()
      const width = measured || forcedWidth || 0
      const days = season?.days ?? []
      const current = season?.current ?? []
      if (days.length < 20) return h('div', { ref, style: { height } }, h('div', { className: 'bw-empty' }, '季节性样本不足'))
      if (width < 120) return h('div', { ref, style: { height } })
      const padL = 42
      const padR = 12
      const padT = 10
      const padB = 22
      // 复权覆盖 2022 起，每个日历日期只有约 5 个年点，逐日分位呈锯齿；做 7 日居中平滑去掉条纹感
      // 年点 < 8 时 seasonCurve 已让 p10/p90 等于 p25/p75，这里按 bands 只平滑真实参与计算的键
      const smoothKeys = season?.bands === 'p25-p75' ? ['p25', 'p50', 'p75'] : ['p10', 'p25', 'p50', 'p75', 'p90']
      const smoothDays = days.map((d, i) => {
        const out = { day: d.day }
        for (const k of smoothKeys) {
          let sum = 0
          let cnt = 0
          for (let j = Math.max(0, i - 3); j <= Math.min(days.length - 1, i + 3); j += 1) {
            sum += days[j][k]
            cnt += 1
          }
          out[k] = sum / cnt
        }
        return out
      })
      const plotW = Math.max(10, width - padL - padR)
      const plotH = Math.max(10, height - padT - padB)
      // 降级模式（年点 < 8）只有 p25/p75 参与平滑，绘制边界必须跟着换，
      // 否则 p10/p90 是 undefined → 整块图变成 NaN（SSR 实测 712 处）
      const bands = season?.bands === 'p25-p75' ? 'p25-p75' : 'p10-p90'
      const loKey = bands === 'p25-p75' ? 'p25' : 'p10'
      const hiKey = bands === 'p25-p75' ? 'p75' : 'p90'
      const all = smoothDays.flatMap((d) => [d[loKey], d[hiKey]]).concat(current.map((c) => c.value))
      const ticks = niceTicks(Math.min(...all), Math.max(...all), 4)
      const xOf = (day) => padL + ((day - 1) / 365) * plotW
      const yOf = (v) => padT + plotH - ((v - ticks.lo) / (ticks.hi - ticks.lo || 1)) * plotH
      const band = (lo, hi) =>
        smoothDays.map((d) => `${xOf(d.day).toFixed(1)},${yOf(d[hi]).toFixed(1)}`).join(' ') +
        ' ' +
        [...smoothDays].reverse().map((d) => `${xOf(d.day).toFixed(1)},${yOf(d[lo]).toFixed(1)}`).join(' ')
      const zeroY = yOf(0)
      return h(
        'div',
        { ref, style: { position: 'relative', height } },
        h(
          'svg',
          { role: 'img', 'aria-label': '季节性曲线', width, height, style: { display: 'block' } },
          ticks.ticks.map((t) =>
            h(
              'g',
              { key: 's' + t },
              h('line', { x1: padL, x2: padL + plotW, y1: yOf(t), y2: yOf(t), stroke: 'var(--dsw-alias-border-l2,rgba(255,255,255,.07))' }),
              h('text', { x: padL - 6, y: yOf(t) + 3.5, textAnchor: 'end', fontSize: 10, fill: 'var(--dsw-alias-label-quaternary,#6b7280)' }, `${t > 0 ? '+' : ''}${t.toFixed(0)}%`),
            ),
          ),
          bands === 'p10-p90'
            ? h('polygon', { points: band('p10', 'p90'), fill: 'var(--dsw-alias-label-quaternary,#6b7280)', opacity: 0.13 })
            : null,
          // 内层深带固定 p25/p75（两种模式的 smoothKeys 都含这两键）；loKey/hiKey 只用于定 Y 轴范围，
          // 拿它画内层会让 p10-p90 模式的两层多边形完全重合，深色带消失
          h('polygon', { points: band('p25', 'p75'), fill: 'var(--dsw-alias-label-quaternary,#6b7280)', opacity: 0.22 }),
          h('line', { x1: padL, x2: padL + plotW, y1: zeroY, y2: zeroY, stroke: 'var(--dsw-alias-label-quaternary,#6b7280)', strokeDasharray: '4 4', opacity: 0.6 }),
          h('polyline', { points: smoothDays.map((d) => `${xOf(d.day).toFixed(1)},${yOf(d.p50).toFixed(1)}`).join(' '), fill: 'none', stroke: 'var(--dsw-alias-label-tertiary,#868c94)', strokeWidth: 1, strokeDasharray: '2 2' }),
          current.length > 1
            ? h('polyline', { points: current.map((c) => `${xOf(c.day).toFixed(1)},${yOf(c.value).toFixed(1)}`).join(' '), fill: 'none', stroke: 'var(--dsw-alias-label-primary,#e6e8eb)', strokeWidth: 1.6 })
            : null,
          [1, 3, 5, 7, 9, 11].map((m) =>
            h('text', { key: 'm' + m, x: xOf((m - 1) * 30.4 + 1), y: height - 6, textAnchor: 'middle', fontSize: 10, fill: 'var(--dsw-alias-label-quaternary,#6b7280)' }, `${m}月`),
          ),
        ),
      )
    }

    /**
     * 弹层无障碍：打开时把焦点移进来、Esc 关闭、Tab 在弹层里循环，关闭后焦点回到原处。
     * @param {() => void} onClose
     */
    function useModalA11y(onClose) {
      const ref = useRef(null)
      useEffect(() => {
        const prev = document.activeElement
        const el = ref.current
        el?.focus?.()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
            return
          }
          if (event.key !== 'Tab' || el === null) return
          const items = el.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')
          if (items.length === 0) return
          const first = items[0]
          const last = items[items.length - 1]
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          prev?.focus?.()
        }
      }, [onClose])
      return ref
    }

    /* ───────────── 取数 ───────────── */

    /**
     * 统一的取数 hook。
     *
     * 三件事之前没做、现在必须有：
     * 1. 检查 HTTP 状态：400 也被当成功解析，界面会渲染出空数据；
     * 2. 失败保留上一份数据（stale），一次网络抖动不该把页面清空；
     * 3. 暴露 error/stale，让界面能显示"数据可能过期"而不是假装正常。
     *
     * @param {string} query 查询串（不含前导 ?）
     * @param {any[]} deps 额外依赖
     * @param {any} [preview] 服务端渲染冒烟测试用的假数据
     */
    function useApi(query, deps = [], preview = undefined) {
      const [state, setState] = useState({ loading: true, data: null, error: null, stale: false, asOf: null })
      const [nonce, setNonce] = useState(0)
      const reload = useCallback(() => setNonce((n) => n + 1), [])
      useEffect(() => {
        if (preview !== undefined) return undefined
        let alive = true
        setState((s) => ({ ...s, loading: true }))
        fetch(`${API}?${query}${nonce > 0 ? `&_=${nonce}` : ''}`, { cache: 'no-store' })
          .then(async (r) => {
            let body = null
            try {
              body = await r.json()
            } catch {
              body = null
            }
            if (!r.ok || body === null) {
              throw new Error(body?.error ?? `HTTP ${r.status}`)
            }
            if (body.ok === false) throw new Error(body.error ?? '接口返回失败')
            return body
          })
          .then((data) => alive && setState({ loading: false, data, error: null, stale: false, asOf: new Date() }))
          .catch((error) => {
            if (!alive) return
            // 失败时保留旧数据，只标记 stale
            setState((s) => ({
              loading: false,
              data: s.data,
              error: String(error?.message ?? error),
              stale: s.data !== null,
              asOf: s.asOf,
            }))
          })
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [query, nonce, preview, ...deps])
      // preview 用于服务端渲染冒烟测试：跳过请求，直接喂数据
      if (preview !== undefined) return { loading: false, data: preview, error: null, stale: false, asOf: null, reload }
      return { ...state, reload }
    }

    /* ───────────── 总览 ───────────── */

    /**
     * 总览页。板块（board）是页面级上下文：
     * - 油脂油料：基差 = 现货 − 期货，有仓单；
     * - 中金所：股指用"贴水 = 期货 − 指数"，国债没有现货基准，两者都没有仓单。
     */
    function Overview({ onOpen, reloadKey, preview, onGlossary, board = 'oil' }) {
      const { loading, data, error, stale } = useApi('op=overview', [reloadKey], preview)
      const spreadsApi = useApi('op=spreads', [reloadKey], preview?.spreadsPreview)
      const [picked, setPicked] = useState('M0')
      // 板块内自定义排序（localStorage 持久化）：数组即用户看到的顺序
      const orderKey = 'dsh-basis-watch:order:' + board
      const readOrder = () => {
        try {
          const raw = window.localStorage.getItem(orderKey)
          const list = raw === null ? [] : JSON.parse(raw)
          return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []
        } catch {
          return []
        }
      }
      const [customOrder, setCustomOrder] = useState(readOrder)
      const [sortMode, setSortMode] = useState(false)
      useEffect(() => {
        setCustomOrder(readOrder())
        setSortMode(false)
      }, [board])
      if (loading && data === null) return h('div', { className: 'bw-loading' }, '读取本地数据…')
      if (data === null && error !== null) return h('div', { className: 'bw-empty' }, `读取失败：${error}`)
      const isCffex = board === 'cffex'
      const isEnergy = board === 'energy'
      const rows = (data?.rows ?? []).filter((r) => (r.board ?? 'oil') === board)
      // 自定义顺序优先；新上市/未记录的品种按默认顺序追加在末尾
      const orderedRows = (() => {
        if (customOrder.length === 0) return rows
        const idx = new Map(customOrder.map((code, i) => [code, i]))
        return rows
          .map((r, i) => ({ r, i }))
          .sort((a, b) => (idx.get(a.r.code) ?? 10000 + a.i) - (idx.get(b.r.code) ?? 10000 + b.i))
          .map((x) => x.r)
      })()
      const moveRow = (code, delta) => {
        const list = orderedRows.map((r) => r.code)
        const i = list.indexOf(code)
        const j = i + delta
        if (i < 0 || j < 0 || j >= list.length) return
        ;[list[i], list[j]] = [list[j], list[i]]
        setCustomOrder(list)
        try {
          window.localStorage.setItem(orderKey, JSON.stringify(list))
        } catch {
          /* 存不了就只影响当前会话 */
        }
      }
      const resetOrder = () => {
        setCustomOrder([])
        try {
          window.localStorage.removeItem(orderKey)
        } catch {
          /* ignore */
        }
      }
      const row = orderedRows.find((r) => r.code === picked) ?? orderedRows[0]
      // 能源板块里只有原油/燃料油是 Brent 折算，LPG 有正常现货基差
      const energyRow = isEnergy && row?.basis?.mode === 'energy'
      const spreads = (spreadsApi.data?.spreads ?? []).filter((s) => (s.board ?? 'oil') === board)
      const basisLabel = isCffex ? '贴水 / 贴水率' : isEnergy ? '基差 / 价差' : '基差 / 基差率'
      const basisPercentileLabel = isCffex ? '3 年分位（贴水/价格）' : isEnergy ? '3 年分位（基差/价差）' : '基差 3 年分位'
      const emptyBasisText = isCffex
        ? h('span', { className: 'bw-muted', title: '国债期货需要 CTD/IRR 才能算基差，免费源拿不到可交割券数据，所以只做期限结构与跨期' }, '无现货基准')
        : isEnergy
          ? h('span', { className: 'bw-muted', title: '现货 = Brent × 汇率 × 系数（元/桶 或 元/吨），不是国内现货报价' }, '无能源参考')
          : board === 'other'
            ? h('span', { className: 'bw-muted', title: 'SCFIS 欧线每周一更新，当天没有新一期时沿用上期' }, '周度现货')
            : h('span', { className: 'bw-muted' }, '无现货源')
      return h(
        'div',
        null,
        stale
          ? h('div', { className: 'bw-stale' }, `刷新失败（${error ?? '网络错误'}），下面显示的是上一次成功读取的数据`)
          : null,
        h(
          'div',
          { className: 'bw-card' },
          h(
            'div',
            { className: 'bw-card-head' },
            h('span', { className: 'bw-card-title' }, isCffex ? '中金所总览' : '板块总览'),
            h('span', { className: 'bw-card-sub' }, `行情 ${data?.quoteAt ? new Date(data.quoteAt).toLocaleString('zh-CN', { hour12: false }) : '—'} · 点击行看详情`),
            h(
              'span',
              { className: 'bw-sortbtns' },
              h('button', { className: 'bw-link', onClick: () => setSortMode((v) => !v) }, sortMode ? '完成排序' : '排序'),
              customOrder.length > 0 ? h('button', { className: 'bw-link', onClick: resetOrder }, '恢复默认') : null,
            ),
          ),
          h(
            'table',
            { className: 'bw-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, '品种'),
                h('th', null, '最新'),
                h('th', null, '涨跌'),
                h('th', null, basisLabel),
                h('th', null, basisPercentileLabel),
                isCffex ? null : h('th', null, '仓单'),
                isCffex ? null : h('th', null, '增减'),
                h('th', { className: 'bw-hide-narrow' }, '近 60 日'),
              ),
            ),
            h(
              'tbody',
              null,
              orderedRows.map((r, rowIndex) =>
                h(
                  'tr',
                  { key: r.code, className: 'bw-row', onClick: () => onOpen(r.code) },
                  h(
                    'td',
                    null,
                    r.name,
                    r.status === 'upcoming' ? h('span', { className: 'bw-tag', style: { marginLeft: 6 } }, '待上市') : null,
                    sortMode
                      ? h(
                          'span',
                          { className: 'bw-movebtns', onClick: (e) => e.stopPropagation() },
                          h('button', { className: 'bw-movebtn', title: '上移', disabled: rowIndex === 0, onClick: () => moveRow(r.code, -1) }, '↑'),
                          h('button', { className: 'bw-movebtn', title: '下移', disabled: rowIndex === orderedRows.length - 1, onClick: () => moveRow(r.code, 1) }, '↓'),
                        )
                      : null,
                  ),
                  h('td', { className: 'bw-num' }, r.price === null ? '—' : fmt(r.price, 0)),
                  h('td', { className: 'bw-num ' + cls(r.changePct) }, pct(r.changePct)),
                  h(
                    'td',
                    { className: 'bw-num ' + (r.basis === null ? '' : cls(r.basis.basisRate)) },
                    r.basis === null
                      ? r.status === 'upcoming'
                        ? h('span', { className: 'bw-muted', title: '该品种期货尚未上市，暂无期货价' }, '—')
                        : h('span', { className: 'bw-stack' }, h('span', { className: 'bw-muted' }, '—'), h('span', { className: 'bw-stack-sub bw-muted' }, '无现货基准'))
                      : h(
                          'span',
                          { className: 'bw-stack' },
                          h('span', null, `${r.basis.basis > 0 ? '+' : ''}${int(r.basis.basis)}`),
                          h('span', { className: 'bw-stack-sub ' + cls(r.basis.basisRate) }, pct(r.basis.basisRate)),
                        ),
                  ),
                  h(
                    'td',
                    null,
                    r.basis !== null
                      ? h(PercentileBar, { value: r.basisPercentile, fluid: true })
                      : r.pricePercentile !== null && r.pricePercentile !== undefined
                        ? h('span', { title: '该品种没有现货基差，显示价格 3 年分位' }, h(PercentileBar, { value: r.pricePercentile, fluid: true }))
                        : h('span', { className: 'bw-muted' }, '—'),
                  ),
                  isCffex ? null : h('td', { className: 'bw-num' }, r.stock === null ? '—' : int(r.stock.warrant)),
                  isCffex ? null : h('td', { className: 'bw-num ' + (r.stock === null ? '' : cls(r.stock.delta)) }, r.stock === null ? '—' : (r.stock.delta > 0 ? '+' : '') + int(r.stock.delta)),
                  h('td', { className: 'bw-hide-narrow' }, h(Spark, { values: r.spark, width: 76, height: 18, tone: (r.changePct ?? 0) >= 0 ? 'up' : 'down' })),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'bw-legend' },
            h('span', null, '分位：当前值在近 3 年样本里的位置，0% = 历史最低，100% = 历史最高。'),
            h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
              PCT_STAGES.map((s) =>
                h(
                  'span',
                  { key: s.label, style: { display: 'inline-flex', alignItems: 'center', gap: 3 } },
                  h('i', { className: 'bw-swatch', style: { background: s.color } }),
                  h('span', null, s.label),
                ),
              ),
            ),
            h('span', null, isCffex ? '贴水为负表示期货低于指数；只描述统计位置，不构成买卖建议。' : '只描述统计位置，不构成买卖建议。'),
            onGlossary ? h('button', { className: 'bw-link', onClick: onGlossary }, '术语说明 →') : null,
          ),
        ),
        h(
          'div',
          { className: 'bw-cols' },
          h(
            'div',
            { className: 'bw-card' },
            h(
              'div',
              { className: 'bw-card-head' },
              h('span', { className: 'bw-card-title' }, `${row?.name ?? '—'} 价格与${isCffex ? '贴水' : energyRow ? '内外价差' : '基差'}`),
              h(
                'span',
                { className: 'bw-card-sub' },
                isCffex
                ? '实线=主连收盘（左轴）　虚线=贴水率（右轴，期货 vs 指数）'
                : energyRow
                  ? '实线=主连收盘（左轴）　虚线=内外价差率（右轴，Brent×汇率折算 vs 期货）'
                  : '实线=主连收盘（左轴，未复权）　虚线=基差率（右轴，对当时近月合约）',
              ),
            ),
            h(
              'div',
              { className: 'bw-chips', style: { marginBottom: 8 } },
              rows.map((r) =>
                h('button', { key: r.code, className: 'bw-chip', 'data-on': r.code === (row?.code ?? picked) ? '1' : '0', onClick: () => setPicked(r.code) }, r.name),
              ),
            ),
            h(LineChart, {
              series: [
                {
                  name: '主连收盘',
                  points: (row?.priceSeries ?? []).map((p) => ({ date: p.date, value: p.close })),
                  color: 'var(--dsw-alias-label-secondary,#9aa0a8)',
                  area: true,
                },
                {
                  name: isCffex ? '贴水率' : energyRow ? '内外价差率' : '基差率',
                  points: (row?.basisSeries ?? []).map((p) => ({ date: p.date, value: p.basisRate })),
                  color: '#b07c3f',
                  axis: 'right',
                  dash: true,
                },
              ],
              height: 260,
            }),
          ),
          h(
            'div',
            { className: 'bw-colstack' },
            h(
              'div',
              { className: 'bw-card' },
              h('div', { className: 'bw-card-head' }, h('span', { className: 'bw-card-title' }, '价差快照'), h('span', { className: 'bw-card-sub' }, '当前值 · 3 年分位')),
              spreads.length === 0
                ? h('div', { className: 'bw-empty' }, '暂无价差组合')
                : spreads.map((s) =>
                    h(
                      'div',
                      { key: s.id, className: 'bw-kv' },
                      h('span', null, s.label, h('span', { className: 'bw-muted', style: { marginLeft: 6, fontSize: 10.5 } }, s.type === 'ratio' ? '比值' : '元/吨')),
                      h(
                        'span',
                        { className: 'bw-num', style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
                        s.available ? (s.type === 'ratio' ? Number(s.current).toFixed(3) : fmt(s.current, 0)) : h('span', { className: 'bw-muted' }, '待上市'),
                        s.available ? h(PercentileBar, { value: s.percentile3y }) : null,
                      ),
                    ),
                  ),
            ),
            h(
              'div',
              { className: 'bw-card' },
              h('div', { className: 'bw-card-head' }, h('span', { className: 'bw-card-title' }, '最新资讯'), h('span', { className: 'bw-card-sub' }, NEWS_SOURCE_LABEL[board] ?? '粮油网 · 油脂油料')),
              h(NewsList, { limit: 10, board: board === 'oil' ? null : board }),
            ),
          ),
        ),
      )
    }
    /* ───────────── 资讯 ───────────── */

    /**
     * 资讯列表。
     *
     * @param {{limit?: number, tag?: string|null, board?: 'oil'|'cffex'|null, preview?: any, reloadKey?: number}} props
     */
    function NewsList({ limit = 20, tag = null, board = null, preview, reloadKey = 0 }) {
      const query = `op=news&limit=${limit}${tag !== null ? `&tag=${encodeURIComponent(tag)}` : ''}${board !== null ? `&board=${board}` : ''}`
      const { loading, data, error, stale } = useApi(query, [tag, board, limit, reloadKey], preview)
      if (loading && data === null) return h('div', { className: 'bw-loading' }, '读取…')
      if (data === null && error !== null) return h('div', { className: 'bw-empty' }, `读取失败：${error}`)
      // 两个板块的源时间粒度不同（公告只有日期），统一按时间倒序，避免旧的公告压在新快讯上面
      const rows = (data?.rows ?? []).slice().sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')))
      if (rows.length === 0) {
        return h('div', null, stale ? h('div', { className: 'bw-stale' }, `刷新失败（${error ?? '网络错误'}），显示的是上一次成功读取的数据`) : null, h('div', { className: 'bw-empty' }, '暂无资讯（抓取后自动出现）'))
      }
      return h(
        'div',
        { className: 'bw-news' },
        stale ? h('div', { className: 'bw-stale' }, `刷新失败（${error ?? '网络错误'}），下面是上一次成功读取的数据`) : null,
        rows.map((n) =>
          h(
            'div',
            { key: n.id, className: 'bw-news-item' },
            h('span', { className: 'bw-news-time' }, String(n.time ?? '').slice(5, 16).replace('T', ' ')),
            h('span', { className: 'bw-tag' }, (n.tags ?? []).find((t) => t !== '中金所') ?? (n.tags ?? [])[0] ?? '资讯'),
            h('a', { href: n.url, target: '_blank', rel: 'noreferrer' }, n.title),
          ),
        ),
      )
    }
    /* ───────────── 品种详情 ───────────── */

    function Detail({ code, onBack, preview, onGlossary, reloadKey = 0 }) {
      const { loading, data, error, stale } = useApi(`op=detail&code=${encodeURIComponent(code)}`, [code, reloadKey], preview)
      if (loading && data === null) return h('div', { className: 'bw-loading' }, '读取品种数据…')
      if (data === null && error !== null) return h('div', { className: 'bw-empty' }, `读取失败：${error}`)
      if (data?.ok === false) return h('div', { className: 'bw-empty' }, `读取失败：${data.error}`)
      const v = data.variety
      const stats = data.price.stats ?? {}
      const win = stats.windows ?? {}
      const basis = data.basis ?? {}
      const isCffex = v.board === 'cffex'
      const isIndexBasis = basis.mode === 'future-index'
      const isEnergy = basis.mode === 'energy'
      const noBasis = basis.mode === 'none'
      const basisName = v.basisLabel ?? (isIndexBasis ? '贴水' : isEnergy ? '内外价差' : '基差')
      // 原油按元/桶报价，燃料油按元/吨
      const basisUnit = isIndexBasis || v.board === 'other' ? '点' : v.code === 'SC0' ? '元/桶' : '元/吨'
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'bw-detail-head' },
          h('button', { className: 'bw-back', onClick: onBack }, '‹ 返回总览'),
          h('span', { className: 'bw-title' }, v.name, `（${v.code}）`),
          h('span', { className: 'bw-tag' }, v.exchange),
          v.effectiveStatus === 'upcoming' ? h('span', { className: 'bw-tag' }, `待上市 ${v.listDate}`) : null,
        ),
        h(
          'div',
          { className: 'bw-caliber' },
          data.price?.caliber?.stats === 'adjusted'
            ? `口径：分位/K 线=主连真实报价；回撤/波动=复权连续（比例复权，${data.continuous?.rolls ?? 0} 次换月，${data.price.caliber.coverage} 起）`
            : '口径：全部使用主连真实报价（无合约数据，回撤/波动含换月跳空）',
          stats.from ? `　统计区间 ${stats.from} ~ ${stats.to}（${stats.sample} 个交易日）` : '',
          isEnergy
            ? `　${basisName} = 折算现货 − 期货；现货 = Brent × 汇率 × ${v.brentFactor ?? 1}（不是国内现货报价）`
            : isIndexBasis
            ? `　贴水 = 期货 − 现货指数（${v.indexCode ?? '指数'}）；负值 = 期货贴水`
            : noBasis
              ? `　${v.noBasisReason ?? '没有现货基准，只做期限结构与跨期'}`
              : basis.contract
                ? `　基差对应 ${basis.contract} 合约（近月，来源 ${basis.source ?? '100ppi'}）${v.spotScale ? `；现货按 ×${v.spotScale} 从${v.spotUnit}折算` : ''}`
                : v.spotScale
                  ? `　现货按 ×${v.spotScale} 从${v.spotUnit}折算`
                  : '',
        ),
        stale ? h('div', { className: 'bw-stale' }, `刷新失败（${error ?? '网络错误'}），下面显示的是上一次成功读取的数据`) : null,
        h(
          'div',
          { className: 'bw-grid' },
          h(
            'div',
            { className: 'bw-card' },
            h(
              'div',
              { className: 'bw-card-head' },
              h('span', { className: 'bw-card-title' }, '关键数字'),
              h('span', { className: 'bw-card-sub' }, data.price?.caliber?.stats === 'adjusted' ? '回撤/波动=复权口径' : ''),
            ),
            h(Kv, { k: '最新收盘', v: fmt(stats.last, 0) + (stats.to ? `（${stats.to}）` : '') }),
            h(Kv, { k: '区间高低', v: `${fmt(stats.low, 0)} – ${fmt(stats.high, 0)}` }),
            h(Kv, { k: '最大回撤', v: pct(stats.maxDrawdown) }),
            h(Kv, { k: '20日波动', v: Number.isFinite(stats.vol20) ? stats.vol20.toFixed(1) + '%' : '—' }),
            h(Kv, { k: '60日波动', v: Number.isFinite(stats.vol60) ? stats.vol60.toFixed(1) + '%' : '—' }),
            h(Kv, { k: '持仓', v: data.quote?.hold ? int(data.quote.hold) : '—' }),
          ),
          h(
            'div',
            { className: 'bw-card' },
            h(
              'div',
              { className: 'bw-card-head' },
              h('span', { className: 'bw-card-title' }, '价格分位'),
              h('span', { className: 'bw-card-sub' }, '主连真实报价'),
            ),
            ['1y', '3y', '5y', '10y'].map((k) =>
              h('div', { key: k, className: 'bw-kv' }, h('span', null, k.replace('y', ' 年')), h(PercentileBar, { value: win[k]?.percentile, label: `${win[k]?.sample ?? 0} 点${win[k]?.short === true ? '（不足）' : ''}`, hint: win[k]?.short === true ? '样本不足以覆盖该窗口，实际是更短窗口的分位' : undefined })),
            ),
          ),
          h(
            'div',
            { className: 'bw-card' },
            h(
              'div',
              { className: 'bw-card-head' },
              h('span', { className: 'bw-card-title' }, `${basisName}分位`),
              h(
                'span',
                { className: 'bw-card-sub' },
                isIndexBasis
                  ? basis.mainContract
                    ? `对 ${basis.mainContract}（主力）`
                    : '期货 vs 现货指数'
                  : basis.contract
                    ? `对 ${basis.contract} 合约`
                    : '口径未记录',
              ),
            ),
            noBasis
              ? h('div', { className: 'bw-empty' }, basis.reason ?? '该板块没有现货基准')
              : h(
                  'div',
                  null,
                  h(Kv, { k: `当前${basisName}（${basisUnit}）`, v: `${basis.basis > 0 ? '+' : ''}${fmt(basis.basis, isEnergy && v.code === 'SC0' ? 2 : 0)}` }),
                  h(Kv, { k: `当前${basisName}率`, v: pct(basis.current) }),
                  isIndexBasis && Number.isFinite(basis.annualized) ? h(Kv, { k: '年化贴水（按主力到期折算）', v: `${basis.annualized.toFixed(1)}%` }) : null,
                  isIndexBasis && basis.expiry ? h(Kv, { k: '主力合约 / 到期', v: `${basis.mainContract} / ${basis.expiry}（剩 ${basis.daysToExpiry} 天）` }) : null,
                  h(Kv, { k: isIndexBasis ? '指数 / 期货' : isEnergy ? '折算现货 / 期货' : '现货 / 期货', v: `${fmt(basis.spot, 0)} / ${fmt(basis.future, 0)}` }),
                  ['p1y', 'p3y', 'p5y'].map((k) =>
                    h('div', { key: k, className: 'bw-kv' }, h('span', null, k.slice(1).replace('y', ' 年')), h(PercentileBar, { value: basis[k]?.percentile, label: `${basis[k]?.sample ?? 0} 天` })),
                  ),
                  basis.p3y
                    ? h(Kv, {
                        k: `3年${basisName}率区间`,
                        v: `${pct(basis.p3y.min)} ~ ${pct(basis.p3y.max)}（中位 ${pct(basis.p3y.median)}）`,
                      })
                    : null,
                  basis.p3y?.abs
                    ? h(Kv, {
                        k: `3年${basisName}区间`,
                        v: `${fmt(basis.p3y.abs.min, 0)} ~ ${fmt(basis.p3y.abs.max, 0)} ${basisUnit}（中位 ${fmt(basis.p3y.abs.median, 0)}）`,
                      })
                    : null,
                ),
          ),
          isCffex
            ? null
            : h(
                'div',
                { className: 'bw-card' },
                h('div', { className: 'bw-card-head' }, h('span', { className: 'bw-card-title' }, '注册仓单')),
                data.stock === null
                  ? h('div', { className: 'bw-empty' }, '暂无仓单数据')
                  : h(
                      'div',
                      null,
                      h(Kv, { k: '仓单', v: `${int(data.stock.last.warrant)}（${int(data.stock.last.delta)}）` }),
                      h(Kv, { k: '区间', v: `${data.stock.from} ~ ${data.stock.to}` }),
                      h(Spark, { values: data.stock.series.map((s) => s.warrant), width: 220, height: 40 }),
                    ),
              ),
        ),
        h(
          'div',
          { className: 'bw-card' },
          h('div', { className: 'bw-card-head' }, h('span', { className: 'bw-card-title' }, 'K 线'), h('span', { className: 'bw-card-sub' }, `近 ${data.price.bars?.length ?? 0} 个交易日 · 主连真实报价（未复权）`)),
          h(CandleChart, { bars: data.price.bars ?? [], height: 280 }),
        ),
        noBasis
          ? h(
              'div',
              { className: 'bw-card' },
              h('div', { className: 'bw-card-head' }, h('span', { className: 'bw-card-title' }, '基差率走势'), h('span', { className: 'bw-card-sub' }, '国债期货没有现货基准')),
              h('div', { className: 'bw-empty' }, basis.reason ?? '该品种没有可用的现货/指数基准，基差与历史分位不适用。'),
            )
          : h(
              'div',
              { className: 'bw-card' },
              h('div', { className: 'bw-card-head' }, h('span', { className: 'bw-card-title' }, `${basisName}率走势`), h('span', { className: 'bw-card-sub' }, isIndexBasis ? '0 以上=期货升水；负值=贴水（期货低于指数）' : isEnergy ? '0 以上=国内期货低于 Brent 折算价' : '0 以上=现货升水；每行对应当时的近月合约')),
              h(LineChart, {
                series: [
                  {
                    name: `${basisName}率`,
                    points: data.basisSeries.map((b) => ({ date: b.date, value: b.basisRate })),
                    color: '#b07c3f',
                    area: true,
                  },
                ],
                height: 180,
                formatLeft: (v) => v.toFixed(1) + '%',
              }),
            ),
        h(
          'div',
          { className: 'bw-card' },
          h('div', { className: 'bw-card-head' }, h('span', { className: 'bw-card-title' }, '季节性'), h('span', { className: 'bw-card-sub' }, `${data.season.years} 年样本 · 相对当年首个收盘 · 实线=当年 · 带=${data.season.bands === 'p25-p75' ? '25~75%' : '10~90%'}`)),
          h(SeasonChart, { season: data.season }),
        ),
        h(
          'div',
          { className: 'bw-grid' },
          h(
            'div',
            { className: 'bw-card' },
            h('div', { className: 'bw-card-head' }, h('span', { className: 'bw-card-title' }, '跨期结构'), data.contractsAsOf ? h('span', { className: 'bw-card-sub' }, `数据日期 ${data.contractsAsOf}`) : null),
            data.contracts.length === 0
              ? h('div', { className: 'bw-empty' }, '暂无分级合约数据')
              : h(
                  'table',
                  { className: 'bw-table' },
                  h(
                    'thead',
                    null,
                    h('tr', null, h('th', null, '合约'), h('th', null, '收盘'), h('th', null, '持仓'), h('th', { title: '该合约最后一根日线的日期；源站对临近交割的合约会提前停更' }, '数据日期')),
                  ),
                  h(
                    'tbody',
                    null,
                    data.contracts.map((c) =>
                      h(
                        'tr',
                        { key: c.code, className: c.stale ? 'bw-stale' : undefined },
                        h('td', null, c.code),
                        h('td', { className: 'bw-num' }, fmt(c.close, 0)),
                        h('td', { className: 'bw-num' }, int(c.hold)),
                        h('td', { className: 'bw-num bw-muted', title: c.stale ? '该合约早于最新日期停更，价格不是同一天的' : undefined }, c.date ?? '—'),
                      ),
                    ),
                  ),
                ),
          ),
          h(
            'div',
            { className: 'bw-card' },
            h('div', { className: 'bw-card-head' }, h('span', { className: 'bw-card-title' }, '相关价差'), h('span', { className: 'bw-card-sub' }, '当前值 · 3 年分位')),
            data.spreads.length === 0
              ? h('div', { className: 'bw-empty' }, '暂无')
              : data.spreads.map((s) =>
                  h(
                    'div',
                    { key: s.id, className: 'bw-kv' },
                    h(
                      'span',
                      null,
                      s.label,
                      h('span', { className: 'bw-muted', style: { marginLeft: 6, fontSize: 10.5 } }, s.type === 'ratio' ? '比值' : '元/吨'),
                    ),
                    h(
                      'span',
                      { className: 'bw-num', title: s.available ? `3 年区间 ${fmt(s.min3y, s.type === 'ratio' ? 3 : 0)} ~ ${fmt(s.max3y, s.type === 'ratio' ? 3 : 0)}，中位 ${fmt(s.median3y, s.type === 'ratio' ? 3 : 0)}` : undefined },
                      s.available ? `${fmt(s.current, s.type === 'ratio' ? 3 : 0)}（${Math.round(s.percentile3y)}%分位，z=${fmt(s.z3y, 2)}）` : h('span', { className: 'bw-muted' }, s.reason ?? '待上市'),
                    ),
                  ),
                ),
          ),
          v.board === 'oil'
            ? h(
                'div',
                { className: 'bw-card' },
                h('div', { className: 'bw-card-head' }, h('span', { className: 'bw-card-title' }, '外盘参考')),
                (data.foreign ?? []).length === 0
                  ? h('div', { className: 'bw-empty' }, '暂无外盘数据')
                  : (data.foreign ?? []).map((f) =>
                      h(Kv, { key: f.code, k: f.name, v: `${fmt(f.last, 2)}（${pct(((f.last - f.prevClose) / (f.prevClose || 1)) * 100)}）` }),
                    ),
              )
            : null,
          h(
            'div',
            { className: 'bw-card' },
            h('div', { className: 'bw-card-head' }, h('span', { className: 'bw-card-title' }, '数据完整度')),
            h(Kv, { k: '价格', v: `${stats.sample} 个交易日` }),
            h(Kv, { k: basisName, v: noBasis ? '不适用（国债无现货基准）' : basis.sample ? `${basis.sample} 天（${basis.from} 起）` : '无' }),
            h(Kv, { k: '仓单', v: isCffex ? '不适用（中金所无仓单）' : data.stock ? `${data.stock.sample} 天` : '无' }),
            h(Kv, { k: '分级合约', v: `${data.contracts.length} 个` }),
            (data.gaps ?? []).length > 0 ? h(Kv, { k: '缺口', v: `${data.gaps.length} 条（最近 ${data.gaps[data.gaps.length - 1]?.key}）` }) : null,
            // 葵油等额外现货源（Mysteel）失败时必须可见
            data.extraSpot && data.extraSpot.ok === false
              ? h(Kv, { k: '额外现货源', v: `失败：${data.extraSpot.error}（${data.extraSpot.date}）` })
              : null,
          ),
        ),
        h(
          'div',
          { className: 'bw-card' },
          h('div', { className: 'bw-card-head' }, h('span', { className: 'bw-card-title' }, '相关资讯')),
          (data.news ?? []).length === 0
            ? h('div', { className: 'bw-empty' }, '暂无')
            : h(
                'div',
                { className: 'bw-news' },
                data.news.map((n) =>
                  h(
                    'div',
                    { key: n.id, className: 'bw-news-item' },
                    h('span', { className: 'bw-news-time' }, String(n.time ?? '').slice(5, 16).replace('T', ' ')),
                    h('a', { href: n.url, target: '_blank', rel: 'noreferrer' }, n.title),
                  ),
                ),
              ),
        ),
      )
    }

    function Kv({ k, v }) {
      return h('div', { className: 'bw-kv' }, h('span', null, k), h('span', { className: 'bw-num' }, v))
    }

    /* ───────────── 套利 ───────────── */

    /**
     * 跨期结构（月差）。
     *
     * 合约不按"近月/次月"的固定规则取，而是取当日**持仓量**最高的前几名再按交割月配对：
     * 临近交割的合约持仓量会迅速掉到很低，固定规则经常选到没人交易的月份，价差噪音大。
     */
    function TermPanel({ rows, code, onSelect, sort = 'near', onSort }) {
      const current = rows.find((r) => r.code === code) ?? rows[0]
      if (current === undefined) {
        return h('div', { className: 'bw-empty' }, '本地没有合约日线：先运行一次「回填合约日线」')
      }
      const sel = current
      // 板块口径：商品价差是元/吨（整数），股指是点（1 位），国债是元（3 位）
      const isCffex = sel.board === 'cffex'
      const digits = isCffex ? (sel.kind === 'bond' ? 3 : 1) : 0
      const priceUnit = isCffex ? (sel.kind === 'bond' ? '元' : '点') : '元/吨'
      /** 排序：近月（默认）/ 价差率降序 / 年化降序；空值始终排最后。 */
      const sorted = [...sel.pairs].sort((a, b) => {
        if (sort === 'rate') return (b.spreadRate ?? -Infinity) - (a.spreadRate ?? -Infinity)
        if (sort === 'annual') return (b.annualized ?? -Infinity) - (a.annualized ?? -Infinity)
        return a.near.localeCompare(b.near) || a.far.localeCompare(b.far)
      })
      const sortBtn = (id, label) =>
        h('button', { key: id, className: 'bw-seg-btn', 'aria-pressed': sort === id ? 'true' : 'false', 'data-on': sort === id ? '1' : '0', onClick: () => onSort(id) }, label)
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'bw-chips' },
          rows.map((r) =>
            h(
              'button',
              { key: r.code, className: 'bw-chip', 'data-on': r.code === sel.code ? '1' : '0', onClick: () => onSelect(r.code) },
              `${r.name} ${r.code}`,
            ),
          ),
        ),
        h(
          'div',
          { className: 'bw-card-sub', style: { marginBottom: 6, display: 'flex', gap: 10, alignItems: 'center' } },
          h('span', null, `${sel.asOf} · 按持仓量取前 ${sel.selection?.top ?? 5} 个合约（候选 ${sel.selection?.candidates ?? 0}，当日有效 ${sel.selection?.alive ?? 0}）`),
          h('span', null, '排序'),
          h(
            'div',
            { className: 'bw-seg', style: { marginLeft: 0 } },
            sortBtn('near', '近月'),
            sortBtn('rate', '价差率'),
            sortBtn('annual', '年化'),
          ),
        ),
        sel.pairs.length === 0
          ? h('div', { className: 'bw-empty' }, '当日有效合约不足 2 个，无法计算跨期价差')
          : h(
              'table',
              { className: 'bw-table bw-table--term' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, '合约对'),
                  h('th', null, '近月 / 远月'),
                  h('th', null, '价差'),
                  h('th', null, '价差率'),
                  h('th', { title: '按交割月间隔折算的年化，不含仓储/资金/交割成本，不是无风险收益' }, '年化'),
                  h('th', { title: '当前价差率在该合约对自身重叠历史中的位置；样本不足 20 天不计算' }, '历史分位'),
                  h('th', null, '持仓量'),
                  h('th', null, '流动性'),
                ),
              ),
              h(
                'tbody',
                null,
                sorted.map((p) =>
                  h(
                    'tr',
                    { key: `${p.near}-${p.far}` },
                    h('td', null, `${p.near} − ${p.far}`, h('span', { className: 'bw-muted', style: { marginLeft: 6, fontSize: 11 } }, `${p.monthGap} 个月`)),
                    h(
                      'td',
                      { className: 'bw-num' },
                      h(
                        'span',
                        { className: 'bw-stack' },
                        h('span', null, `${fmt(p.nearClose, digits)} / ${fmt(p.farClose, digits)}`),
                        h('span', { className: 'bw-stack-sub' }, priceUnit),
                      ),
                    ),
                    h('td', { className: 'bw-num ' + cls(p.spread) }, `${p.spread > 0 ? '+' : ''}${fmt(p.spread, digits)}`),
                    h('td', { className: 'bw-num ' + cls(p.spreadRate) }, p.spreadRate === null ? '—' : `${p.spreadRate > 0 ? '+' : ''}${fmt(p.spreadRate, 2)}%`),
                    h('td', { className: 'bw-num ' + cls(p.annualized) }, p.annualized === null ? '—' : `${p.annualized > 0 ? '+' : ''}${fmt(p.annualized, 1)}%`),
                    h(
                      'td',
                      null,
                      p.percentile === null
                        ? h('span', { className: 'bw-muted', title: '该合约对重叠样本不足 20 天' }, '样本不足')
                        : h(
                            'span',
                            { className: 'bw-stack' },
                            h(PercentileBar, { value: p.percentile.value }),
                            h('span', { className: 'bw-stack-sub' }, `n=${p.percentile.sample}｜${fmt(p.percentile.min, 2)}% ~ ${fmt(p.percentile.max, 2)}%`),
                          ),
                    ),
                    h(
                      'td',
                      { className: 'bw-num bw-muted' },
                      h(
                        'span',
                        { className: 'bw-stack' },
                        h('span', null, `${wan(p.openInterest.near)} / ${wan(p.openInterest.far)}`),
                        h('span', { className: 'bw-stack-sub' }, '近 / 远 手'),
                      ),
                    ),
                    h('td', null, p.liquidity === 'thin' ? h('span', { className: 'bw-tag', title: '单腿成交量低于 5000 手，价格噪音较大' }, '偏薄') : h('span', { className: 'bw-muted' }, '正常')),
                  ),
                ),
              ),
            ),
        h(
          'div',
          { className: 'bw-legend' },
          h('span', null, '价差 = 近月 − 远月（交易所组合指令口径）：正值 = 近强远弱（backwardation），负值 = 近弱远强。'),
          h('span', null, '年化 = 价差率 × 365 ÷ 交割月间隔；分位只在同一合约对内部有意义，跨合约对不可比。'),
        ),
      )
    }

    function Spreads({ preview, reloadKey = 0, initialMode = null, initialCode = null, initialSort = null, board = 'oil' }) {
      const view = readView()
      const [mode, setMode] = useState(initialMode ?? view.spreadsMode)
      const [termCode, setTermCode] = useState(initialCode ?? view.termCode)
      const [sort, setSort] = useState(initialSort ?? 'near')
      const { loading, data, error, stale } = useApi(mode === 'term' ? 'op=term' : 'op=spreads', [mode, reloadKey], preview)
      const pickMode = (next) => {
        setMode(next)
        writeView({ spreadsMode: next })
      }
      const pickCode = (code) => {
        setTermCode(code)
        writeView({ termCode: code })
      }
      const seg = h(
        'div',
        { className: 'bw-seg' },
        h('button', { className: 'bw-seg-btn', 'aria-pressed': mode === 'cross' ? 'true' : 'false', 'data-on': mode === 'cross' ? '1' : '0', onClick: () => pickMode('cross'), title: '不同品种之间的价差（主力连续收盘）' }, '跨品种'),
        h('button', { className: 'bw-seg-btn', 'aria-pressed': mode === 'term' ? 'true' : 'false', 'data-on': mode === 'term' ? '1' : '0', onClick: () => pickMode('term'), title: '同一品种不同交割月之间的价差（按持仓量选合约）' }, '跨期'),
      )
      // 请求失败时不能显示成"暂无数据"：那是两回事
      const errorBox =
        error !== null && data === null
          ? h('div', { className: 'bw-empty' }, `读取失败：${error}（${stale ? '正在用旧数据' : '可稍后重试'}）`)
          : null
      if (loading && data === null) {
        return h('div', { className: 'bw-loading' }, mode === 'term' ? '计算跨期结构…' : '计算价差…')
      }

      if (mode === 'term') {
        const rows = (data?.rows ?? []).filter((r) => (r.board ?? 'oil') === board)
        return h(
          'div',
          { className: 'bw-card' },
          h(
            'div',
            { className: 'bw-card-head' },
            h('span', { className: 'bw-card-title' }, '跨期价差（月差）'),
            h('span', { className: 'bw-card-sub' }, '按当日持仓量选合约 · 任意两个交割月配对 · 分位取该合约对自身重叠历史'),
            seg,
          ),
          errorBox,
          rows.length === 0
            ? (error === null ? h('div', { className: 'bw-empty' }, '暂无跨期数据（需要合约日线）') : null)
            : h(TermPanel, { rows, code: termCode, onSelect: pickCode, sort, onSort: setSort }),
        )
      }

      const rows = (data?.spreads ?? []).filter((s) => (s.board ?? 'oil') === board)
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'bw-card' },
          h(
            'div',
            { className: 'bw-card-head' },
            h('span', { className: 'bw-card-title' }, '跨品种价差'),
            h('span', { className: 'bw-card-sub' }, '主力连续收盘计算 · 分位取近 3 年'),
            seg,
          ),
          errorBox,
          h(
            'table',
            { className: 'bw-table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, '组合'),
                h('th', null, '当前值'),
                h('th', null, '3年分位'),
                h('th', { title: 'z 值（标准分）：当前值偏离近 3 年均值多少个标准差。+2 以上或 −2 以下通常算统计上的异常区间。' }, 'z 值'),
                h('th', null, '3年区间'),
                h('th', null, '走势'),
              ),
            ),
            h(
              'tbody',
              null,
              rows.map((s) =>
                h(
                  'tr',
                  { key: s.id },
                  h('td', null, s.label, h('span', { className: 'bw-muted', style: { marginLeft: 6, fontSize: 11 } }, s.note)),
                  h(
                    'td',
                    { className: 'bw-num' },
                    s.available
                      ? h(
                          'span',
                          { className: 'bw-stack' },
                          h('span', null, fmt(s.current, s.type === 'ratio' ? 3 : 0)),
                          h('span', { className: 'bw-stack-sub' }, s.unit || (s.type === 'ratio' ? '比值' : '元/吨')),
                        )
                      : h('span', { className: 'bw-muted' }, '待上市'),
                  ),
                  h('td', null, s.available ? h(PercentileBar, { value: s.percentile3y }) : h('span', { className: 'bw-muted' }, '—')),
                  h(
                    'td',
                    { className: 'bw-num ' + cls(s.z3y), title: s.available ? `当前值偏离近 3 年均值 ${fmt(s.z3y, 2)} 个标准差` : undefined },
                    s.available ? fmt(s.z3y, 2) : '—',
                  ),
                  h(
                    'td',
                    { className: 'bw-num bw-muted' },
                    s.available
                      ? h(
                          'span',
                          { className: 'bw-stack' },
                          h('span', null, `${fmt(s.min3y, s.type === 'ratio' ? 3 : 0)} ~ ${fmt(s.max3y, s.type === 'ratio' ? 3 : 0)}`),
                          h('span', { className: 'bw-stack-sub' }, `中位 ${fmt(s.median3y, s.type === 'ratio' ? 3 : 0)}`),
                        )
                      : '—',
                  ),
                  h('td', null, s.available ? h(Spark, { values: s.spark, width: 110, height: 20 }) : '—'),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'bw-legend' },
            h('span', null, 'z 值 = 当前值偏离近 3 年均值的标准差倍数；|z| > 2 通常视为统计上的异常。'),
            h('span', null, '分位是"当前值在近 3 年同一条价差序列中的位置"，只描述统计位置，不构成交易建议。'),
          ),
        ),
      )
    }

    /* ───────────── 设置 ───────────── */

    function SettingsPanel({ onClose, onRefresh }) {
      const [cfg, setCfg] = useState(readCfg())
      useEffect(() => {
        const fn = (next) => setCfg(next)
        cfgSubs.add(fn)
        return () => cfgSubs.delete(fn)
      }, [])
      const status = useApi('op=status')
      const coverage = status.data?.coverage
      return h(
        'div',
        { className: 'bw-set' },
        h(
          'div',
          { className: 'bw-set-row' },
          h('input', {
            type: 'checkbox',
            checked: cfg.showEntry === true,
            onChange: (e) => writeCfg({ showEntry: e.target.checked }),
          }),
          h('span', null, '在侧边栏显示「期现瞭望」入口'),
        ),
        h('div', { className: 'bw-set-hint' }, '默认隐藏。开启后侧边栏出现入口，点击进入整页。'),
        h('div', { className: 'bw-set-row' }, h('button', { className: 'bw-btn', onClick: onRefresh }, '立即抓取（行情+新闻）')),
        h('div', { className: 'bw-set-hint' }, '抓取会访问外部数据源；页面展示始终读本地文件。'),
        h(
          'div',
          { style: { marginTop: 12 } },
          h('div', { className: 'bw-card-title', style: { marginBottom: 6 } }, '数据完整度'),
          coverage === undefined
            ? h('div', { className: 'bw-muted' }, '读取中…')
            : h(
                'div',
                null,
                h(Kv, { k: '数据目录', v: coverage.root ?? '—' }),
                h(Kv, { k: '日线品种', v: Object.keys(coverage.daily ?? {}).length + ' 个' }),
                h(Kv, { k: '基差行数', v: `${coverage.basis?.rows ?? 0}（${coverage.basis?.from ?? '—'} 起）` }),
                h(Kv, { k: '仓单品种', v: Object.keys(coverage.stock ?? {}).length + ' 个' }),
                h(Kv, { k: '缺口', v: `${coverage.gapCount ?? 0} 条` }),
              ),
        ),
        h('div', { className: 'bw-set-row', style: { marginTop: 10 } }, h('button', { className: 'bw-btn', onClick: onClose }, '关闭')),
      )
    }

    /* ───────────── 页面骨架 ───────────── */

    /** 页签与板块矩阵；中金所没有注册仓单。 */
    const ALL_BOARDS = ['oil', 'black', 'chem', 'nonferrous', 'precious', 'energy', 'agri', 'newenergy', 'other', 'cffex']
    const TABS = [
      { id: 'overview', label: '总览', boards: ALL_BOARDS },
      { id: 'spreads', label: '套利', boards: ALL_BOARDS },
      { id: 'news', label: '资讯', boards: ALL_BOARDS },
    ]

    /** 板块兜底（op=status 返回前也能渲染）。 */
    const FALLBACK_BOARDS = [
      { id: 'oil', name: '油脂油料', short: '油脂油料', note: '商品 · 现货基差' },
      { id: 'black', name: '黑色', short: '黑色', note: '商品 · 螺纹/铁矿/双焦/铁合金' },
      { id: 'chem', name: '能化', short: '能化', note: '商品 · 聚酯/聚烯烃/盐化工' },
      { id: 'nonferrous', name: '有色', short: '有色', note: '商品 · 铜铝锌镍锡铅' },
      { id: 'precious', name: '贵金属', short: '贵金属', note: '商品 · 黄金/白银/铂钯' },
      { id: 'energy', name: '能源', short: '能源', note: '原油/燃料油/LPG · Brent 折算内外价差' },
      { id: 'agri', name: '农产品', short: '农产品', note: '商品 · 白糖/棉花/玉米' },
      { id: 'newenergy', name: '新能源', short: '新能源', note: '广期所 · 碳酸锂/工业硅/多晶硅/氢氧化锂' },
      { id: 'other', name: '其他', short: '其他', note: '关联度较低的品种 · 当前：集运欧线' },
      { id: 'cffex', name: '中金所', short: '中金所', note: '金融 · 期指升贴水 / 国债期限结构' },
    ]

    /**
     * 顶部页签。
     *
     * 详情页里也要保留：早期版本在详情页把整条导航藏起来，用户想换页只能先「返回总览」，
     * 属于多余的一跳。现在详情页仍显示页签，点任一页签即退出详情并切到该页。
     */
    function TabBar({ tab, onSelect, board }) {
      const tabs = TABS.filter((t) => t.boards.includes(board))
      return h(
        'div',
        { className: 'bw-tabs' },
        tabs.map((t) =>
          h('button', { key: t.id, className: 'bw-tab', 'data-on': tab === t.id ? '1' : '0', onClick: () => onSelect(t.id) }, t.label),
        ),
      )
    }

    /**
     * 板块切换器。
     *
     * 为什么放在最外层（标题行）而不是每个页签内部：
     * 板块决定的是**口径**（基差=现货−期货 还是 贴水=期货−指数）、有没有仓单、资讯来源。
     * 放在内层会出现"总览是油脂油料、套利是中金所"这种自相矛盾的状态。
     */
    function BoardBar({ board, boards, onSelect }) {
      return h(
        'div',
        { className: 'bw-boardbar', role: 'tablist', 'aria-label': '板块' },
        boards.map((b) =>
          h(
            'button',
            {
              key: b.id,
              className: 'bw-board',
              role: 'tab',
              'aria-selected': board === b.id ? 'true' : 'false',
              'data-on': board === b.id ? '1' : '0',
              title: b.note ?? b.name,
              onClick: () => onSelect(b.id),
            },
            b.short ?? b.name,
          ),
        ),
      )
    }

    function Page(props) {
      // initialDetail / initialBoard 只给 SSR 冒烟用，运行时不传
      const view = readView()
      const [board, setBoard] = useState(props?.initialBoard ?? view.board)
      const [tab, setTab] = useState(() => {
        const wanted = props?.initialTab ?? view.tab
        return TABS.some((t) => t.id === wanted) ? wanted : 'overview'
      })
      const [detail, setDetail] = useState(props?.initialDetail ?? null)
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [glossaryOpen, setGlossaryOpen] = useState(false)
      const [reloadKey, setReloadKey] = useState(0)
      const refresh = useCallback(() => setReloadKey((n) => n + 1), [])
      // 表头的数据时点提示：哪些数据集过期一眼可见
      const statusApi = useApi('op=status', [reloadKey])
      const boards = statusApi.data?.boards ?? FALLBACK_BOARDS

      /** 切换页签：同时持久化，刷新/切页回来保持原位。 */
      const pickTab = (id) => {
        setDetail(null)
        setTab(id)
        writeView({ tab: id })
      }

      /** 切换板块：清掉详情；当前页签若不在新板块的页签集合里（理论不会发生），回总览。 */
      const pickBoard = (id) => {
        setBoard(id)
        setDetail(null)
        writeView({ board: id })
        const stillExists = TABS.some((t) => t.id === tab && t.boards.includes(id))
        if (!stillExists) pickTab('overview')
      }

      useEffect(() => {
        // 面板挂载 = 用户在本插件内；快捷键据此决定是否顺带跳回会话
        panelActive = true
        return () => {
          panelActive = false
        }
      }, [])

      useEffect(() => {
        // 总览每 60 秒刷新一次（只读本地，开销很小）
        const t = setInterval(refresh, 60 * 1000)
        return () => clearInterval(t)
      }, [refresh])

      const onOpen = (code) => setDetail(code)
      return h(
        'div',
        { className: 'bw-page' },
        h(
          'div',
          { className: 'bw-head' },
          h('span', { className: 'bw-title' }, '期现瞭望'),
          h(BoardBar, { board, boards, onSelect: pickBoard }),
          h('div', { className: 'bw-spacer' }),
          h('span', { className: 'bw-fresh', title: '各数据集最近一次成功抓取的时间；⚠ 表示已超过新鲜度阈值' }, freshLabel(statusApi.data?.asOf)),
          h('button', { className: 'bw-btn', onClick: () => setGlossaryOpen(true) }, '术语说明'),
          h('button', { className: 'bw-btn', onClick: () => setSettingsOpen((v) => !v) }, settingsOpen ? '收起设置' : '设置'),
        ),
        settingsOpen ? null : h('div', { className: 'bw-tabsrow' }, h(TabBar, { tab, onSelect: pickTab, board })),
        h(
          'div',
          { className: 'bw-body' },
          h(
            'div',
            { className: 'bw-body-inner' },
            settingsOpen
              ? h(SettingsPanel, { onClose: () => setSettingsOpen(false), onRefresh: refresh })
              : detail !== null
                ? h(Detail, { code: detail, onBack: () => setDetail(null), onGlossary: () => setGlossaryOpen(true), reloadKey, board })
                : tab === 'overview'
                  ? h(Overview, { onOpen, reloadKey, onGlossary: () => setGlossaryOpen(true), board })
                  : tab === 'spreads'
                    ? h(Spreads, { reloadKey, board })
                    : h(
                          'div',
                          { className: 'bw-card' },
                          h('div', { className: 'bw-card-head' }, h('span', { className: 'bw-card-title' }, '资讯'), h('span', { className: 'bw-card-sub' }, NEWS_SOURCE_LABEL[board] ?? '粮油网 · 油脂油料')),
                          h(NewsList, { limit: 80, reloadKey, board }),
                        ),
          ),
        ),
        glossaryOpen ? h(GlossaryModal, { onClose: () => setGlossaryOpen(false) }) : null,
      )
    }
    /* ───────────── 术语答疑 ───────────── */

    /** 术语条目：标题 + 说明。写在这里而不是散落在各处，方便以后补。 */
    const GLOSSARY = [
      {
        group: '核心指标',
        items: [
          {
            term: '基差 / 基差率',
            text: '基差 = 现货价 − 期货价；基差率 = 基差 ÷ 现货价 × 100%（与生意社现期表口径一致，例：195 ÷ 3180 = 6.13%）。正数叫"现货升水"（现货比期货贵），负数叫"现货贴水"。基差走强通常意味着现货紧张或期货预期偏弱。',
          },
          {
            term: '分位（百分位）',
            text: '把当前值放进历史样本里排队：0% = 历史最低，50% = 正中间，100% = 历史最高。它只回答"现在处于历史什么位置"，不回答"贵不贵"——高位可以继续高，低位也可以继续低。',
          },
          {
            term: '分位配色',
            text: '蓝色 = 很低（0–20%），青色 = 偏低（20–40%），灰色 = 居中（40–60%），橙色 = 偏高（60–80%），红色 = 很高（80–100%）。配色只做视觉分级，不是买卖信号。',
          },
          {
            term: '注册仓单',
            text: '交易所登记的、可用于交割的现货库存凭证数量。仓单增加说明可交割货源变多，减少说明在去库。"增减"是相对上一个交易日的变化。',
          },
          {
            term: 'z 值（标准分）',
            text: 'z = （当前值 − 近 3 年均值）÷ 近 3 年标准差。它衡量"现在偏离常态多少个标准差"：|z| > 2 通常算统计上的异常区间。z 为正表示高于均值，为负表示低于均值；和分位一起看更稳。',
          },
          {
            term: '基差的单位',
            text: '基差用元/吨表示（现货价 − 期货价的实际价差），基差率是它占现货价的百分比。同一个基差在不同价位上百分比会差很多，所以两个都看：绝对值看"差多少钱"，比率看"差多少比例"。',
          },
          {
            term: '口径：主连 vs 具体合约',
            text: '主连（如 M0）是"把最近月合约接起来"的连续价格，换月当天会从旧合约跳到新合约价格，产生假跳空；基差用的是具体合约（如 2611）当天的期货价。两者不是同一个价格，本插件在详情页明确标注：价格分位/K 线用主连真实报价，回撤/波动用复权连续，基差标注对应合约。',
          },
          {
            term: '复权用在哪些数字上',
            text: '回撤、波动率这类"收益率统计"用复权连续序列（换月跳空已被消除）；价格分位、K 线、走势图用主连真实报价（未复权）。原因：比例复权会按跨期价差缩放历史价格水平，直接拿来做"当前价在历史价格里的位置"会被系统性改写。',
          },
          {
            term: '复权连续（比例复权）',
            text: '把每次换月的价差按比例折回去，让历史序列在换月处不跳空，同时保持最新一段是真实价格。好处是收益率、波动率、回撤不再被换月污染；代价是历史价格水平经过了缩放。价格分位与 K 线仍用未复权主连，不复权（见上一条），只有收益率类统计才用复权。',
          },
          {
            term: '统计区间与样本',
            text: '复权需要新旧合约的重叠数据，所以统计只从"复权覆盖起点"开始算（详情页会写明起止日期与交易日数）。1/3/5/10 年分位在样本不足时会缩短窗口，界面同时显示实际样本量，避免用 20 个点去冒充 10 年。',
          },
          {
            term: '数据时点（asOf）与过期标记',
            text: '表头的"行情 / 基差 / 日线"各自显示最近一次成功抓取的时间，超过新鲜度阈值会带 ⚠。界面上的数字不是实时行情的等价物：盘中价格按 15 分钟刷新，基差每天收盘后更新一次。',
          },
        ],
      },
      {
        group: '套利与结构',
        items: [
          { term: '油粕比', text: '豆油价格 ÷ 豆粕价格。压榨同一批大豆同时产出油和粕，油粕比反映两者的相对强弱，也间接反映压榨利润结构。' },
          { term: '螺矿比 / 卷螺差', text: '螺矿比 = 螺纹钢 ÷ 铁矿石，粗略代理钢厂利润；卷螺差 = 热卷 − 螺纹钢，衡量板材与建材的相对强弱。' },
          { term: '金银比 / 铜铝比', text: '金银比 = 黄金(元/克)×1000 ÷ 白银(元/千克)，因为两者报价单位不同先换算到同一单位；铜铝比 = 沪铜 ÷ 沪铝。都是相对强弱的粗指标，不做方向判断。' },
          { term: '豆棕价差', text: '豆油 − 棕榈油。两者是最主要的替代油脂，价差走阔通常意味着豆油相对偏紧或棕榈油供应宽松。' },
          { term: '菜豆油价差 / 豆菜粕价差', text: '分别是 菜油 − 豆油、豆粕 − 菜粕，衡量同用途品种之间的相对强弱。' },
          { term: '跨期结构', text: '同一品种不同交割月的价格排列。近月明显高于远月（backwardation）通常代表现货紧张；反过来（contango）说明库存充裕。' },
          { term: '季节性', text: '把每年同一天的走势叠在一起看。图中灰色带是历年同期的分位区间，白色实线是今年到目前的走势，虚线是历年同期中位数。' },
          { term: '外盘参考', text: '美豆、美豆粉、美豆油、马棕等外盘报价。只作为外围参考，不进入主图，也不参与基差计算。' },
        ],
      },
      {
        group: '数据口径与缺少数据',
        items: [
          { term: '数据来源', text: '行情与日线来自新浪财经；现货与基差来自生意社现期表；注册仓单来自东方财富；资讯来自中国粮油信息网；葵油现货用 Mysteel 多地贸易商报价均价（非交易所现货基准）。' },
          { term: '为什么豆二没有基差', text: '生意社现期表只收录豆一、豆粕、豆油、菜籽粕、菜籽油、棕榈油等品名，不含豆二（进口大豆）。没有现货价就算不出基差，需要单独的进口大豆分销价来源，所以这里显示"无现货源"而不是填 0。' },
          { term: '为什么葵油暂无数据', text: '葵花籽油期货 2026-11-12 才在郑商所上市（代码 SO），之前没有期货价；现货用 Mysteel 报价先积累着。' },
          { term: '为什么氢氧化锂显示待上市', text: '广期所已发布氢氧化锂期货合约（交易代码 LI，1 吨/手，1–12 月），但上市交易时间另行通知。这里先预留槽位，上市后补上上市日就会自动开始抓取。' },
          { term: '能源的「内外价差」是什么', text: '原油 SC、燃料油 FU、低硫 LU 在国内没有公开可比的现货报价，所以现货腿用 Brent × USD/CNY × 桶吨系数折算（SC 1 桶 = 1，FU/LU 1 吨 ≈ 6.35 桶）。页面把这一列叫「内外价差」而不是基差，负值表示国内期货低于折算价。' },
          { term: '其他板块的集运现货是什么', text: '集运欧线 EC 的现货腿是上海航交所的 SCFIS 欧线结算运价指数，每周一更新一次（周度），不是每天都有新值；样本天数按周累积，分位需要更长时间才有统计意义。' },
          { term: '棉花棉纱、工业硅为什么基差偏高', text: '这些品种的现货报价与期货标的品级不同（棉花 3128B、棉纱普梳 32S、工业硅 553），基差水平天然偏高；分位仍在自己同口径的历史里比较，只做相对位置，不跨品种比较绝对值。' },
          { term: '为什么仓单样本只有几十天', text: '仓单接口（东方财富）只能取到最近约 67 个交易日。本地每天增量累积，时间越久分位越可靠；页面上会标注实际样本天数。' },
          { term: '样本不足是什么意思', text: '本地历史不够长，算出的分位没有统计意义，所以直接显示"样本不足"而不是给一个假数字。' },
          { term: '缺口 / 数据完整度', text: '抓取失败（网络、源站改版、接口限流）会记进缺口列表并在页面展示，不会静默跳过，也不会用旧数据顶替。' },
        ],
      },
    ]

    /** 术语答疑弹层。 */
    function GlossaryModal({ onClose }) {
      const dialogRef = useModalA11y(onClose)
      useEffect(() => {
        panelModalOpen = true
        return () => {
          panelModalOpen = false
        }
      }, [])
      return h(
        'div',
        {
          className: 'bw-overlay',
          onClick: onClose,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '术语说明',
        },
        h(
          'div',
          { className: 'bw-modal', ref: dialogRef, tabIndex: -1, onClick: (e) => e.stopPropagation() },
          h(
            'div',
            { className: 'bw-modal-head' },
            h('h3', null, '术语说明'),
            h('div', { className: 'bw-spacer' }),
            h('button', { className: 'bw-btn', onClick: onClose }, '关闭'),
          ),
          h('p', null, '这个面板只做两件事：把数据摆到它该在的位置上，把位置的含义说清楚。不做"高估/低估"结论，也不给买卖建议。'),
          GLOSSARY.map((section) =>
            h(
              'div',
              { key: section.group },
              h('h4', null, section.group),
              section.items.map((item) =>
                h('p', { key: item.term }, h('b', null, item.term), '　', item.text),
              ),
            ),
          ),
        ),
      )
    }
    /* ───────────── 设置项（设置页里的一节） ───────────── */

    /**
     * 设置页的「期现瞭望」一节。
     *
     * 为什么必须有它：面板入口默认隐藏，而"打开入口"的开关如果只放在面板内部，
     * 就形成死循环（入口隐藏 → 进不去面板 → 打不开开关）。设置页始终可达，
     * 所以开关必须在这里，同时提供一个「打开整页」按钮直接跳过侧边栏。
     */
    function SettingsSection() {
      const [cfg, setCfg] = useState(readCfg())
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')
      const status = useApi('op=status')
      useEffect(() => {
        const fn = (next) => setCfg(next)
        cfgSubs.add(fn)
        return () => cfgSubs.delete(fn)
      }, [])

      const openPanel = () => {
        const layout = pluginCtx?.get?.('layout')
        if (layout?.selectPanel !== undefined) {
          try {
            layout.selectPanel(PANEL_ID)
            setMsg('已打开面板；如果没反应，请开启上面的侧边栏入口')
            return
          } catch (error) {
            setMsg('当前壳子不允许直接打开面板，已改为显示侧边栏入口')
          }
        } else {
          setMsg('当前壳子不支持直接打开面板，已改为显示侧边栏入口')
        }
        // 兜底：至少让用户能从侧边栏进去
        writeCfg({ showEntry: true })
      }

      const runUpdate = () => {
        setBusy(true)
        setMsg('')
        fetch(`${API}?op=update&mode=intraday`)
          .then((r) => r.json())
          .then((res) => {
            setBusy(false)
            setMsg(res.ok ? `已更新：行情 ${res.result?.quotes?.rows ?? 0} 条，新闻新增 ${res.result?.news?.kept ?? 0} 条` : `失败：${res.error ?? '未知错误'}`)
            status.reload()
          })
          .catch((error) => {
            setBusy(false)
            setMsg(`失败：${String(error)}`)
          })
      }

      const coverage = status.data?.coverage
      return h(
        'div',
        { className: 'bw-set' },
        h(
          'div',
          { className: 'bw-set-row' },
          h('input', {
            type: 'checkbox',
            checked: cfg.showEntry === true,
            onChange: (e) => writeCfg({ showEntry: e.target.checked }),
          }),
          h('span', null, '在侧边栏显示「期现瞭望」入口'),
        ),
        h('div', { className: 'bw-set-hint' }, '默认隐藏。开启后侧边栏出现入口；也可以直接点下面的按钮进入整页。'),
        h(
          'div',
          { className: 'bw-set-row' },
          h('button', { className: 'bw-btn', onClick: openPanel }, '打开整页'),
          h('button', { className: 'bw-btn', onClick: runUpdate, disabled: busy }, busy ? '抓取中…' : '立即抓取行情+新闻'),
        ),
        msg !== '' ? h('div', { className: 'bw-set-hint' }, msg) : null,
        h(
          'div',
          { style: { marginTop: 10 } },
          h('div', { className: 'bw-card-title', style: { marginBottom: 6 } }, '数据完整度'),
          coverage === undefined
            ? h('div', { className: 'bw-muted' }, '读取中…')
            : h(
                'div',
                null,
                h(Kv, { k: '数据目录', v: coverage.root ?? '—' }),
                h(Kv, { k: '日线品种', v: `${Object.keys(coverage.daily ?? {}).length} 个` }),
                h(Kv, { k: '基差行数', v: `${coverage.basis?.rows ?? 0}（${coverage.basis?.from ?? '—'} 起）` }),
                h(Kv, { k: '仓单品种', v: `${Object.keys(coverage.stock ?? {}).length} 个` }),
                h(Kv, { k: '缺口', v: `${coverage.gapCount ?? 0} 条` }),
              ),
        ),
      )
    }

    /* ───────────── 侧边栏图标 ───────────── */

    function PanelIcon() {
      return h(
        'span',
        { className: 'bw-icon', title: '期现瞭望' },
        h(
          'svg',
          { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
          h('path', { d: 'M2 13V3M2 13h12' }),
          h('path', { d: 'M4 10l3-4 3 3 3-5' }),
        ),
      )
    }

    /* ───────────── 插件对象 ───────────── */

    return {
      name: 'dsh-basis-watch/client',
      /**
       * 仅供离线渲染冒烟测试使用（服务端渲染不跑 useEffect，
       * 组件接受 preview 数据以便直接验证渲染结果）。
       */
      /** 仅供离线渲染测试使用：组件与样式导出（服务端渲染不跑 useEffect）。 */
      __components: { Page, TabBar, Overview, Detail, Spreads, TermPanel, NewsList, SettingsPanel, SettingsSection, LineChart, CandleChart, SeasonChart, Spark, PercentileBar, GlossaryModal },
      __css: CSS,
      inject: ['slots'],
      apply(ctx) {
        injectStyles()
        pluginCtx = ctx
        const slots = ctx.slots ?? ctx.get?.('slots')
        if (slots === undefined) return
        const disposers = []
        try {
          disposers.push(slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, Page)))
          // 设置页始终可达：入口开关必须放在这里，否则"入口默认隐藏"会变成死循环
          disposers.push(
            slots.inject('settings.section', () =>
              slots.register({ name: 'settings.section', id: 'basis-watch', order: 54, label: '期现瞭望' }, SettingsSection),
            ),
          )
          // 侧边栏入口：默认隐藏，开关变化时动态注册/注销
          let entryDisposer = null
          const syncEntry = (cfg) => {
            const want = cfg ? cfg.showEntry === true : readCfg().showEntry === true
            if (want && entryDisposer === null) {
              entryDisposer = slots.inject('sidebar.panellist', () =>
                slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 21, label: () => '期现瞭望' }, PanelIcon),
              )
            } else if (!want && entryDisposer !== null) {
              entryDisposer()
              entryDisposer = null
            }
          }
          syncEntry(null)
          const sub = (cfg) => syncEntry(cfg)
          cfgSubs.add(sub)
          disposers.push(() => {
            cfgSubs.delete(sub)
            if (entryDisposer !== null) entryDisposer()
          })
          // Shift+Cmd+D（Windows/Linux 为 Shift+Ctrl+D）：切换侧边栏入口；
          // 如果当前正在本插件内，顺手回到会话视图（面板替换了会话区，selectPanel(null) 即回到进入前的会话）
          // 宿主 register() 会对六个 profile 全部校验，任一非法/冲突就整体抛错并丢弃该命令。
          // 因此先试全平台默认键，被拒时退化为"只给桌面三平台"，保证 macOS 一定能用上。
          const FULL_DEFAULTS = {
            // web:linux 只接受 Cmd/Ctrl+Slash、+Shift+Comma、+Shift+Period 三种组合，
            // 浏览器下不预置（留空 = 未绑定，用户可在「设置 → 快捷键」里自行录制）；
            // 桌面版 Linux 不受此限，照常给 Ctrl+Shift+D。
            'desktop:macos': { code: 'KeyD', modifiers: ['primary', 'shift'] },
            'desktop:windows': { code: 'KeyD', modifiers: ['primary', 'shift'] },
            'desktop:linux': { code: 'KeyD', modifiers: ['primary', 'shift'] },
            'web:macos': { code: 'KeyD', modifiers: ['primary', 'shift'] },
            'web:windows': { code: 'KeyD', modifiers: ['primary', 'shift'] },
          }
          const DESKTOP_ONLY_DEFAULTS = {
            'desktop:macos': { code: 'KeyD', modifiers: ['primary', 'shift'] },
            'desktop:windows': { code: 'KeyD', modifiers: ['primary', 'shift'] },
            'desktop:linux': { code: 'KeyD', modifiers: ['primary', 'shift'] },
          }
          const registerShortcut = () => {
            const shortcuts = ctx.get?.('shortcuts')
            if (shortcuts === undefined) return false
            for (const [variant, defaults] of [['全平台', FULL_DEFAULTS], ['仅桌面', DESKTOP_ONLY_DEFAULTS]]) {
              try {
                disposers.push(
                  shortcuts.register({
                    id: 'basis-watch.entry.toggle',
                    label: () => '显示/隐藏「期现瞭望」入口',
                    aliases: ['basis watch', 'basis-watch', '期现瞭望', 'toggle entry'],
                    defaults,
                    regions: ['page', 'editable'],
                    // modals 是宿主 dispatch 会读的字段（command.modals.includes），缺省会抛错
                    modals: [],
                    resolve: ({ modal }) => {
                      if (modal !== null || panelModalOpen) return { status: 'blocked', reason: 'modal' }
                      return {
                        status: 'handled',
                        run: () => {
                          const layout = pluginCtx?.get?.('layout')
                          // 是否正停在本插件：优先读 shell 的当前面板，读不到时退回挂载标记
                          let inPanel = panelActive
                          try {
                            const active = layout?.panelInfo?.getSnapshot?.()?.activePanelId
                            if (typeof active === 'string' || active === null) inPanel = active === PANEL_ID
                          } catch {
                            /* 读不到就用挂载标记 */
                          }
                          writeCfg({ showEntry: readCfg().showEntry !== true })
                          // 在插件内按下时顺手回到会话（面板替换了会话区，selectPanel(null) 即回到进入前的会话）
                          if (inPanel && typeof layout?.selectPanel === 'function') {
                            try {
                              layout.selectPanel(null)
                            } catch {
                              /* 壳子不允许时忽略 */
                            }
                          }
                        },
                      }
                    },
                  }),
                )
                console.info?.(`[basis-watch] 快捷键已注册（${variant}）：Shift+Cmd+D / Shift+Ctrl+D`)
                return true
              } catch (error) {
                // 键位冲突/被壳子拒绝时只记日志，不能让整个插件挂掉
                console.warn?.(
                  `[basis-watch] 快捷键注册失败（${variant}）：`,
                  error instanceof Error ? error.message : error,
                )
              }
            }
            return true
          }
          if (!registerShortcut()) {
            // shortcuts 服务可能比本插件晚就绪：短轮询最多 3 秒，注册上就停
            let tries = 0
            const timer = setInterval(() => {
              tries += 1
              if (registerShortcut()) {
                clearInterval(timer)
                return
              }
              if (tries >= 30) {
                clearInterval(timer)
                console.warn?.('[basis-watch] shortcuts 服务不可用，快捷键未注册')
              }
            }, 100)
            disposers.push(() => clearInterval(timer))
          }
          ctx.effect?.(() => () => {
            for (const d of disposers.splice(0).reverse()) {
              try {
                d()
              } catch {
                /* 忽略清理错误 */
              }
            }
          }, 'dsh-basis-watch: slots')
        } catch (error) {
          for (const d of disposers.splice(0).reverse()) {
            try {
              d()
            } catch {
              /* 忽略 */
            }
          }
          console.error('[basis-watch] 面板注册失败', error)
        }
      },
    }
  },
})
