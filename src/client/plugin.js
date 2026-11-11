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
