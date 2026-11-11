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

