    /* ───────────── 工具 ───────────── */

    const fmt = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '—')
    const pct = (v, digits = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(digits) + '%' : '—')
    const int = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('zh-CN') : '—')
    const cls = (v) => (!Number.isFinite(v) || v === 0 ? 'bw-muted' : v > 0 ? 'bw-up' : 'bw-down')
    /** 手数 → 万手（跨期表用）；缺失显示 — */
    const wan = (v) => (Number.isFinite(v) ? `${(v / 10000).toFixed(1)}万` : '—')

    /**
     * SVG 折线：把数值序列映射到给定宽高。
     *
     * 外面必须包一层 inline-flex 的 span：`<svg>` 是替换元素，若按块级渲染，
     * 父单元格的 `text-align:right` 对它无效，会靠左 —— 这就是走势图与表头错位的原因。
     */
    function Spark({ values, width = 78, height = 20, tone = 'muted', strokeWidth = 1.2 }) {
      const use = (values ?? []).filter((v) => Number.isFinite(v))
      if (use.length < 2) return h('span', { className: 'bw-muted', style: { fontSize: 11 } }, '—')
      const min = Math.min(...use)
      const max = Math.max(...use)
      const span = max - min || 1
      const step = width / (use.length - 1)
      const points = use.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`).join(' ')
      const color = tone === 'up' ? '#c8553d' : tone === 'down' ? '#3f8f5f' : 'currentColor'
      return h(
        'span',
        { className: 'bw-spark' },
        h(
          'svg',
          { width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true', style: { display: 'block', color: 'var(--dsw-alias-label-tertiary,#868c94)' } },
          h('polyline', { points, fill: 'none', stroke: color, strokeWidth, strokeLinejoin: 'round', strokeLinecap: 'round' }),
        ),
      )
    }

    /** 分位 5 档配色：低 → 高（冷 → 暖）。只做视觉分级，不代表贵贱判断。 */
    const PCT_STAGES = [
      { limit: 20, color: '#4a9ecf', label: '很低' },
      { limit: 40, color: '#5cab9b', label: '偏低' },
      { limit: 60, color: '#9aa0a8', label: '居中' },
      { limit: 80, color: '#cf8a4c', label: '偏高' },
      { limit: Infinity, color: '#c8553d', label: '很高' },
    ]
    const pctStage = (v) => PCT_STAGES.find((s) => v < s.limit) ?? PCT_STAGES[PCT_STAGES.length - 1]
    const PCT_GRADIENT = 'linear-gradient(90deg,#4a9ecf 0%,#5cab9b 20%,#9aa0a8 40%,#cf8a4c 60%,#c8553d 80%,#c8553d 100%)'

    /** 分位条：0–100，分段渐变填充 + 当前值标记。fluid=true 时条宽自适应单元格。 */
    function PercentileBar({ value, label, fluid = false, hint }) {
      if (!Number.isFinite(value)) {
        return h('span', { className: 'bw-muted', style: { fontSize: 11 }, title: '本地历史样本太少，暂算不出分位' }, '样本不足')
      }
      const clamped = Math.max(0, Math.min(100, value))
      const stage = pctStage(clamped)
      const title = hint ?? `当前值在历史样本中的位置：${Math.round(value)}（0 = 历史最低，100 = 历史最高），阶段「${stage.label}」。分位只描述位置，不代表该买或该卖。`
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6, width: fluid ? '100%' : undefined, justifyContent: 'flex-end' }, title },
        h(
          'span',
          { className: 'bw-bar', style: fluid ? { width: 'auto', flex: '1 1 auto', minWidth: 40, maxWidth: 120 } : { width: 84 } },
          h('i', {
            style: {
              width: `${clamped}%`,
              // 渐变按整条 100% 铺设，再按当前值裁剪，所以同一分位在任何宽度下颜色一致
              backgroundImage: PCT_GRADIENT,
              backgroundSize: `${(100 / Math.max(clamped, 1)) * 100}% 100%`,
              backgroundRepeat: 'no-repeat',
            },
          }),
          h('b', { style: { left: `${clamped}%`, background: stage.color } }),
        ),
        h('span', { className: 'bw-num', style: { fontSize: 11.5, minWidth: 34, textAlign: 'right', color: stage.color } }, `${Math.round(value)}%`),
        label ? h('span', { className: 'bw-muted', style: { fontSize: 10.5 } }, label) : null,
      )
    }

