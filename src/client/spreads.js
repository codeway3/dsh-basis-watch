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

