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

