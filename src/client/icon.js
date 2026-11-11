    /* ───────────── 侧边栏图标 ───────────── */

    function PanelIcon() {
      return h(
        'span',
        { className: 'bw-icon', title: '期现瞭望' },
        h(
          'svg',
          { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
          h('path', { d: 'M2 13V3M2 13h12' }),
          h('path', { d: 'M4 10l3-4 3 3 3-5' }),
        ),
      )
    }

