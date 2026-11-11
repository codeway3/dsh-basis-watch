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
