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

