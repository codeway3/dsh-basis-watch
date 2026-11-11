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

