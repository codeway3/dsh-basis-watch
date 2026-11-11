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
