    /* ───────────── 图表 ───────────── */

    /**
     * 测量容器宽度。
     *
     * 之前的图用 `preserveAspectRatio="none"` + viewBox 固定宽度，等于把坐标系
     * 横向硬拉伸 —— 宽度越大变形越严重，这就是"图很丑"的根因。
     * 现在按真实像素宽度绘制，永不拉伸。
     */
    function useWidth() {
      const ref = useRef(null)
      const [width, setWidth] = useState(0)
      useEffect(() => {
        const el = ref.current
        if (el === null) return undefined
        const update = () => setWidth(el.clientWidth)
        update()
        if (typeof ResizeObserver === 'undefined') return undefined
        const ro = new ResizeObserver(update)
        ro.observe(el)
        return () => ro.disconnect()
      }, [])
      return [ref, width]
    }

    /** 生成 1/2/5 × 10^n 的刻度。 */
    function niceTicks(min, max, count = 5) {
      if (!Number.isFinite(min) || !Number.isFinite(max)) return { ticks: [], lo: 0, hi: 1 }
      if (min === max) return { ticks: [min], lo: min - 1, hi: max + 1 }
      const rawStep = (max - min) / count
      const mag = 10 ** Math.floor(Math.log10(Math.abs(rawStep) || 1))
      const norm = rawStep / mag
      const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
      const lo = Math.floor(min / step) * step
      const hi = Math.ceil(max / step) * step
      const ticks = []
      for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)))
      return { ticks, lo, hi, step }
    }

    /** 把 asOf 汇总成一句"数据时点"（过期项加 ⚠）。 */
    function freshLabel(asOf) {
      if (asOf === undefined || asOf === null) return ''
      const fmt = (key) => {
        const item = asOf[key]
        if (item === undefined || item.asOf === null) return '—'
        const at = String(item.asOf).slice(5, 16).replace('T', ' ')
        return item.stale === true ? `${at}⚠` : at
      }
      return `行情 ${fmt('quotes')} · 基差 ${fmt('basis')} · 日线 ${fmt('daily')}`
    }

    /** 数字缩写：1.2 万 / 3.4 亿。 */
    function abbr(v) {
      if (!Number.isFinite(v)) return '—'
      const a = Math.abs(v)
      if (a >= 1e8) return (v / 1e8).toFixed(1) + '亿'
      if (a >= 1e4) return (v / 1e4).toFixed(1) + '万'
      if (a >= 100) return v.toFixed(0)
      if (a >= 1) return v.toFixed(1)
      return v.toFixed(2)
    }

    /**
     * 折线/面积图：左轴 + 可选右轴、网格、刻度、十字线与读数气泡。
     *
     * 序列统一成 {date, value} 点集后**按日期 join**（取并集再各自取点）：
     * 早先按数组长度右对齐，基差少一天整条曲线就错位几天。
     *
     * @param {object} props
     * @param {Array<{name: string, points?: {date: string, value: number}[], values?: number[], color?: string, axis?: 'left'|'right', area?: boolean, dash?: boolean}>} props.series
     * @param {string[]} props.labels points 缺日期时按位置回退
     * @param {number} [props.height]
     */
    function LineChart({ series = [], labels = [], height = 200, formatLeft = abbr, formatRight = (v) => v.toFixed(2) + '%', width: forcedWidth }) {
      const [ref, measured] = useWidth()
      const width = measured || forcedWidth || 0
      const [hover, setHover] = useState(null)
      const gid = useMemo(() => 'bwg' + Math.random().toString(36).slice(2, 8), [])
      const usable = series
        .map((s) => {
          const points = Array.isArray(s.points)
            ? s.points
            : (s.values ?? []).map((v, i) => ({ date: labels[i] ?? String(i), value: v }))
          return { ...s, points: points.filter((p) => Number.isFinite(p?.value)) }
        })
        .filter((s) => s.points.length >= 2)
      // X 轴 = 所有序列日期的并集（排序后），缺数据处断开而不是整体平移
      const xDates = [...new Set(usable.flatMap((s) => s.points.map((p) => p.date)))].sort()
      const xIndex = new Map(xDates.map((d, i) => [d, i]))
      const n = xDates.length
      const hasRight = usable.some((s) => s.axis === 'right')
      const padL = 46
      const padR = hasRight ? 60 : 14
      const padT = 10
      const padB = 22
      if (usable.length === 0 || n < 2) return h('div', { ref, style: { height } }, h('div', { className: 'bw-empty' }, '暂无数据'))
      if (width < 120) return h('div', { ref, style: { height } })

      const plotW = Math.max(10, width - padL - padR)
      const plotH = Math.max(10, height - padT - padB)
      const rangeOf = (list) => {
        const vals = list.flatMap((s) => s.points.map((p) => p.value)).filter((v) => Number.isFinite(v))
        if (vals.length === 0) return { lo: 0, hi: 1 }
        let lo = Math.min(...vals)
        let hi = Math.max(...vals)
        const pad = (hi - lo) * 0.1 || Math.abs(hi || 1) * 0.05
        return { lo: lo - pad, hi: hi + pad }
      }
      const leftRange = rangeOf(usable.filter((s) => s.axis !== 'right'))
      const rightRange = hasRight ? rangeOf(usable.filter((s) => s.axis === 'right')) : null
      const xOf = (i) => padL + (i / (n - 1)) * plotW
      const leftTicks = niceTicks(leftRange.lo, leftRange.hi, 4)
      const rightTicks = rightRange === null ? null : niceTicks(rightRange.lo, rightRange.hi, 4)
      // 映射必须用"刻度范围"（niceTicks 会向外扩），否则最外侧刻度会画到画布外
      const yOf = (v, r) => padT + plotH - ((v - r.lo) / (r.hi - r.lo || 1)) * plotH

      // 面积渐变需要稳定 id；颜色取自 series
      const paths = usable.map((s, si) => {
        const r = s.axis === 'right' ? rightTicks ?? leftTicks : leftTicks
        const pts = []
        const byDate = new Map()
        for (const p of s.points) {
          const idx = xIndex.get(p.date)
          if (idx === undefined) continue
          byDate.set(p.date, p.value)
          pts.push(`${xOf(idx).toFixed(1)},${yOf(p.value, r).toFixed(1)}`)
        }
        return { s, si, r, byDate, pts }
      })

      const xLabelIdx = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i)
      const hoverDate = hover === null ? null : xDates[hover]
      const hoverItem = hoverDate === null ? null : paths
        .map((p) => ({
          name: p.s.name,
          value: p.byDate.get(hoverDate),
          axis: p.s.axis ?? 'left',
          color: p.s.color,
        }))
        .filter((it) => Number.isFinite(it.value))

      return h(
        'div',
        { ref, style: { position: 'relative', height } },
        h(
          'svg',
          {
            role: 'img',
            'aria-label': series.map((s) => s.name).filter(Boolean).join(' / ') || '走势图',
            width,
            height,
            style: { display: 'block', overflow: 'visible' },
            onMouseMove: (e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const x = e.clientX - rect.left
              if (x < padL - 2 || x > padL + plotW + 2) return setHover(null)
              const idx = Math.round(((x - padL) / plotW) * (n - 1))
              setHover(Math.max(0, Math.min(n - 1, idx)))
            },
            onMouseLeave: () => setHover(null),
          },
          h(
            'defs',
            null,
            h(
              'linearGradient',
              { id: `${gid}-area`, x1: '0', y1: '0', x2: '0', y2: '1' },
              h('stop', { offset: '0%', stopColor: 'var(--dsw-alias-label-secondary,#9aa0a8)', stopOpacity: 0.16 }),
              h('stop', { offset: '100%', stopColor: 'var(--dsw-alias-label-secondary,#9aa0a8)', stopOpacity: 0.02 }),
            ),
          ),
          // 网格 + 左轴刻度
          leftTicks.ticks.map((t) =>
            h(
              'g',
              { key: 'lg' + t },
              h('line', { x1: padL, x2: padL + plotW, y1: yOf(t, leftTicks), y2: yOf(t, leftTicks), stroke: 'var(--dsw-alias-border-l2,rgba(255,255,255,.07))', strokeWidth: 1 }),
              h('text', { x: padL - 6, y: yOf(t, leftTicks) + 3.5, textAnchor: 'end', fontSize: 10, fill: 'var(--dsw-alias-label-quaternary,#6b7280)' }, formatLeft(t)),
            ),
          ),
          // 右轴刻度
          rightTicks === null
            ? null
            : rightTicks.ticks.map((t) =>
                h(
                  'text',
                  { key: 'rg' + t, x: padL + plotW + 6, y: yOf(t, rightTicks) + 3.5, fontSize: 10, fill: 'var(--dsw-alias-label-quaternary,#6b7280)' },
                  formatRight(t),
                ),
              ),
          // X 轴标签
          xLabelIdx.map((i) =>
            h(
              'text',
              {
                key: 'xl' + i,
                x: xOf(i),
                y: height - 6,
                textAnchor: i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
                fontSize: 10,
                fill: 'var(--dsw-alias-label-quaternary,#6b7280)',
              },
              String(xDates[i] ?? '').slice(5),
            ),
          ),
          // 数据
          paths.map((p) => {
            if (p.pts.length < 2) return null
            const isArea = p.s.area === true && p.s.axis !== 'right'
            const line = h('polyline', {
              key: 'ln' + p.si,
              points: p.pts.join(' '),
              fill: 'none',
              stroke: p.s.color ?? 'var(--dsw-alias-label-secondary,#9aa0a8)',
              strokeWidth: p.s.axis === 'right' ? 1.2 : 1.5,
              strokeDasharray: p.s.dash ? '3 3' : undefined,
              strokeLinejoin: 'round',
              strokeLinecap: 'round',
            })
            if (!isArea) return line
            const areaPts = `${p.pts[0].split(',')[0]},${padT + plotH} ` + p.pts.join(' ') + ` ${p.pts[p.pts.length - 1].split(',')[0]},${padT + plotH}`
            return h('g', { key: 'ar' + p.si }, h('polygon', { points: areaPts, fill: `url(#${gid}-area)` }), line)
          }),
          // 十字线
          hover === null
            ? null
            : h(
                'g',
                null,
                h('line', { x1: xOf(hover), x2: xOf(hover), y1: padT, y2: padT + plotH, stroke: 'var(--dsw-alias-label-quaternary,#6b7280)', strokeDasharray: '3 3', strokeWidth: 1 }),
                hoverItem.map((it) =>
                  h('circle', {
                    key: 'dot' + it.name,
                    cx: xOf(hover),
                    cy: yOf(it.value, it.axis === 'right' ? (rightTicks ?? leftTicks) : leftTicks),
                    r: 3,
                    fill: it.color ?? 'var(--dsw-alias-label-primary,#e6e8eb)',
                  }),
                ),
              ),
        ),
        hover === null
          ? null
          : h(
              'div',
              {
                style: {
                  position: 'absolute',
                  left: Math.min(Math.max(xOf(hover) + 10, 8), Math.max(8, width - 150)),
                  top: 6,
                  pointerEvents: 'none',
                  background: 'color-mix(in srgb, var(--dsw-alias-bg-l1,#1b1c1f) 92%, transparent)',
                  border: '1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14))',
                  borderRadius: 6,
                  padding: '5px 8px',
                  fontSize: 11,
                  lineHeight: 1.6,
                  whiteSpace: 'nowrap',
                  boxShadow: '0 4px 14px rgba(0,0,0,.25)',
                },
              },
              h('div', { style: { color: 'var(--dsw-alias-label-quaternary,#6b7280)' } }, String(xDates[hover] ?? '').slice(0, 10)),
              hoverItem.map((it) =>
                h(
                  'div',
                  { key: 'tip' + it.name, style: { display: 'flex', gap: 8, justifyContent: 'space-between' } },
                  h('span', { style: { color: 'var(--dsw-alias-label-tertiary,#868c94)' } }, it.name),
                  h('span', { className: 'bw-num' }, it.axis === 'right' ? formatRight(it.value) : formatLeft(it.value)),
                ),
              ),
            ),
      )
    }

    /**
     * K 线图（详情页用）：红涨绿跌、带影线、十字线读数。
     * @param {{bars: Array<{d: string, o: number, h: number, l: number, c: number}>}} props
     */
    function CandleChart({ bars = [], height = 260, labels = [], width: forcedWidth }) {
      const [ref, measured] = useWidth()
      const width = measured || forcedWidth || 0
      const [hover, setHover] = useState(null)
      const use = bars.filter((b) => [b.o, b.h, b.l, b.c].every((v) => Number.isFinite(v)))
      if (use.length < 2) return h('div', { ref, style: { height } }, h('div', { className: 'bw-empty' }, '暂无 K 线数据'))
      if (width < 120) return h('div', { ref, style: { height } })
      const padL = 46
      const padR = 12
      const padT = 10
      const padB = 22
      const plotW = Math.max(10, width - padL - padR)
      const plotH = Math.max(10, height - padT - padB)
      const lo = Math.min(...use.map((b) => b.l))
      const hi = Math.max(...use.map((b) => b.h))
      const ticks = niceTicks(lo, hi, 4)
      const xOf = (i) => padL + ((i + 0.5) / use.length) * plotW
      const yOf = (v) => padT + plotH - ((v - ticks.lo) / (ticks.hi - ticks.lo || 1)) * plotH
      const cw = Math.max(1, (plotW / use.length) * 0.62)
      const hoverBar = hover === null ? null : use[hover]
      return h(
        'div',
        { ref, style: { position: 'relative', height } },
        h(
          'svg',
          {
            role: 'img',
            'aria-label': '价格 K 线图（日线）',
            width,
            height,
            style: { display: 'block' },
            onMouseMove: (e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const x = e.clientX - rect.left
              if (x < padL || x > padL + plotW) return setHover(null)
              setHover(Math.max(0, Math.min(use.length - 1, Math.floor(((x - padL) / plotW) * use.length))))
            },
            onMouseLeave: () => setHover(null),
          },
          ticks.ticks.map((t) =>
            h(
              'g',
              { key: 'k' + t },
              h('line', { x1: padL, x2: padL + plotW, y1: yOf(t), y2: yOf(t), stroke: 'var(--dsw-alias-border-l2,rgba(255,255,255,.07))' }),
              h('text', { x: padL - 6, y: yOf(t) + 3.5, textAnchor: 'end', fontSize: 10, fill: 'var(--dsw-alias-label-quaternary,#6b7280)' }, abbr(t)),
            ),
          ),
          use.map((b, i) => {
            const up = b.c >= b.o
            const color = up ? '#c8553d' : '#3f8f5f'
            const x = xOf(i)
            return h(
              'g',
              { key: 'c' + i },
              h('line', { x1: x, x2: x, y1: yOf(b.h), y2: yOf(b.l), stroke: color, strokeWidth: 1 }),
              h('rect', {
                x: x - cw / 2,
                y: Math.min(yOf(b.o), yOf(b.c)),
                width: cw,
                height: Math.max(1, Math.abs(yOf(b.c) - yOf(b.o))),
                fill: color,
              }),
            )
          }),
          hover === null
            ? null
            : h('line', { x1: xOf(hover), x2: xOf(hover), y1: padT, y2: padT + plotH, stroke: 'var(--dsw-alias-label-quaternary,#6b7280)', strokeDasharray: '3 3' }),
          [0, Math.floor((use.length - 1) / 2), use.length - 1].map((i) =>
            h(
              'text',
              { key: 'kx' + i, x: xOf(i), y: height - 6, textAnchor: i === 0 ? 'start' : i === use.length - 1 ? 'end' : 'middle', fontSize: 10, fill: 'var(--dsw-alias-label-quaternary,#6b7280)' },
              String(use[i]?.d ?? labels[i] ?? '').slice(5),
            ),
          ),
        ),
        hoverBar === null
          ? null
          : h(
              'div',
              {
                style: {
                  position: 'absolute',
                  right: 8,
                  top: 6,
                  pointerEvents: 'none',
                  background: 'color-mix(in srgb, var(--dsw-alias-bg-l1,#1b1c1f) 92%, transparent)',
                  border: '1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14))',
                  borderRadius: 6,
                  padding: '5px 8px',
                  fontSize: 11,
                  lineHeight: 1.6,
                  fontVariantNumeric: 'tabular-nums',
                },
              },
              h('div', { style: { color: 'var(--dsw-alias-label-quaternary,#6b7280)' } }, hoverBar.d),
              h('div', null, `开 ${abbr(hoverBar.o)}　高 ${abbr(hoverBar.h)}`),
              h('div', null, `低 ${abbr(hoverBar.l)}　收 ${abbr(hoverBar.c)}`),
            ),
      )
    }

    /** 季节性：近 N 年分位带 + 当年曲线（口径：相对当年首个收盘的百分比）。 */
    function SeasonChart({ season, height = 200, width: forcedWidth }) {
      const [ref, measured] = useWidth()
      const width = measured || forcedWidth || 0
      const days = season?.days ?? []
      const current = season?.current ?? []
      if (days.length < 20) return h('div', { ref, style: { height } }, h('div', { className: 'bw-empty' }, '季节性样本不足'))
      if (width < 120) return h('div', { ref, style: { height } })
      const padL = 42
      const padR = 12
      const padT = 10
      const padB = 22
      // 复权覆盖 2022 起，每个日历日期只有约 5 个年点，逐日分位呈锯齿；做 7 日居中平滑去掉条纹感
      // 年点 < 8 时 seasonCurve 已让 p10/p90 等于 p25/p75，这里按 bands 只平滑真实参与计算的键
      const smoothKeys = season?.bands === 'p25-p75' ? ['p25', 'p50', 'p75'] : ['p10', 'p25', 'p50', 'p75', 'p90']
      const smoothDays = days.map((d, i) => {
        const out = { day: d.day }
        for (const k of smoothKeys) {
          let sum = 0
          let cnt = 0
          for (let j = Math.max(0, i - 3); j <= Math.min(days.length - 1, i + 3); j += 1) {
            sum += days[j][k]
            cnt += 1
          }
          out[k] = sum / cnt
        }
        return out
      })
      const plotW = Math.max(10, width - padL - padR)
      const plotH = Math.max(10, height - padT - padB)
      // 降级模式（年点 < 8）只有 p25/p75 参与平滑，绘制边界必须跟着换，
      // 否则 p10/p90 是 undefined → 整块图变成 NaN（SSR 实测 712 处）
      const bands = season?.bands === 'p25-p75' ? 'p25-p75' : 'p10-p90'
      const loKey = bands === 'p25-p75' ? 'p25' : 'p10'
      const hiKey = bands === 'p25-p75' ? 'p75' : 'p90'
      const all = smoothDays.flatMap((d) => [d[loKey], d[hiKey]]).concat(current.map((c) => c.value))
      const ticks = niceTicks(Math.min(...all), Math.max(...all), 4)
      const xOf = (day) => padL + ((day - 1) / 365) * plotW
      const yOf = (v) => padT + plotH - ((v - ticks.lo) / (ticks.hi - ticks.lo || 1)) * plotH
      const band = (lo, hi) =>
        smoothDays.map((d) => `${xOf(d.day).toFixed(1)},${yOf(d[hi]).toFixed(1)}`).join(' ') +
        ' ' +
        [...smoothDays].reverse().map((d) => `${xOf(d.day).toFixed(1)},${yOf(d[lo]).toFixed(1)}`).join(' ')
      const zeroY = yOf(0)
      return h(
        'div',
        { ref, style: { position: 'relative', height } },
        h(
          'svg',
          { role: 'img', 'aria-label': '季节性曲线', width, height, style: { display: 'block' } },
          ticks.ticks.map((t) =>
            h(
              'g',
              { key: 's' + t },
              h('line', { x1: padL, x2: padL + plotW, y1: yOf(t), y2: yOf(t), stroke: 'var(--dsw-alias-border-l2,rgba(255,255,255,.07))' }),
              h('text', { x: padL - 6, y: yOf(t) + 3.5, textAnchor: 'end', fontSize: 10, fill: 'var(--dsw-alias-label-quaternary,#6b7280)' }, `${t > 0 ? '+' : ''}${t.toFixed(0)}%`),
            ),
          ),
          bands === 'p10-p90'
            ? h('polygon', { points: band('p10', 'p90'), fill: 'var(--dsw-alias-label-quaternary,#6b7280)', opacity: 0.13 })
            : null,
          // 内层深带固定 p25/p75（两种模式的 smoothKeys 都含这两键）；loKey/hiKey 只用于定 Y 轴范围，
          // 拿它画内层会让 p10-p90 模式的两层多边形完全重合，深色带消失
          h('polygon', { points: band('p25', 'p75'), fill: 'var(--dsw-alias-label-quaternary,#6b7280)', opacity: 0.22 }),
          h('line', { x1: padL, x2: padL + plotW, y1: zeroY, y2: zeroY, stroke: 'var(--dsw-alias-label-quaternary,#6b7280)', strokeDasharray: '4 4', opacity: 0.6 }),
          h('polyline', { points: smoothDays.map((d) => `${xOf(d.day).toFixed(1)},${yOf(d.p50).toFixed(1)}`).join(' '), fill: 'none', stroke: 'var(--dsw-alias-label-tertiary,#868c94)', strokeWidth: 1, strokeDasharray: '2 2' }),
          current.length > 1
            ? h('polyline', { points: current.map((c) => `${xOf(c.day).toFixed(1)},${yOf(c.value).toFixed(1)}`).join(' '), fill: 'none', stroke: 'var(--dsw-alias-label-primary,#e6e8eb)', strokeWidth: 1.6 })
            : null,
          [1, 3, 5, 7, 9, 11].map((m) =>
            h('text', { key: 'm' + m, x: xOf((m - 1) * 30.4 + 1), y: height - 6, textAnchor: 'middle', fontSize: 10, fill: 'var(--dsw-alias-label-quaternary,#6b7280)' }, `${m}月`),
          ),
        ),
      )
    }

    /**
     * 弹层无障碍：打开时把焦点移进来、Esc 关闭、Tab 在弹层里循环，关闭后焦点回到原处。
     * @param {() => void} onClose
     */
    function useModalA11y(onClose) {
      const ref = useRef(null)
      useEffect(() => {
        const prev = document.activeElement
        const el = ref.current
        el?.focus?.()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
            return
          }
          if (event.key !== 'Tab' || el === null) return
          const items = el.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')
          if (items.length === 0) return
          const first = items[0]
          const last = items[items.length - 1]
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          prev?.focus?.()
        }
      }, [onClose])
      return ref
    }

