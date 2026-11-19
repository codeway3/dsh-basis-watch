    /* ───────────── 插件对象 ───────────── */

    return {
      name: 'dsh-basis-watch/client',
      /** 仅供离线渲染测试使用：组件与样式导出（服务端渲染不跑 useEffect）。 */
      __components: { Page, TabBar, Overview, Detail, Spreads, TermPanel, NewsList, SettingsPanel, LineChart, CandleChart, SeasonChart, Spark, PercentileBar, GlossaryModal },
      __css: CSS,
      inject: ['slots'],
      apply(ctx) {
        injectStyles()
        const slots = ctx.slots ?? ctx.get?.('slots')
        if (slots === undefined) return
        const disposers = []
        try {
          // 主面板 + 左侧栏入口：入口常显，配置都在面板自己的「配置」按钮里。
          disposers.push(slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, Page)))
          disposers.push(
            slots.inject('sidebar.panellist', () =>
              slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 21, label: () => '期现瞭望' }, PanelIcon),
            ),
          )
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
