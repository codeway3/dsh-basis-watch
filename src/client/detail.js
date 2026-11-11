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

