    /* ───────────── 资讯 ───────────── */

    /**
     * 资讯列表。
     *
     * @param {{limit?: number, tag?: string|null, board?: 'oil'|'cffex'|null, preview?: any, reloadKey?: number}} props
     */
    function NewsList({ limit = 20, tag = null, board = null, preview, reloadKey = 0 }) {
      const query = `op=news&limit=${limit}${tag !== null ? `&tag=${encodeURIComponent(tag)}` : ''}${board !== null ? `&board=${board}` : ''}`
      const { loading, data, error, stale } = useApi(query, [tag, board, limit, reloadKey], preview)
      if (loading && data === null) return h('div', { className: 'bw-loading' }, '读取…')
      if (data === null && error !== null) return h('div', { className: 'bw-empty' }, `读取失败：${error}`)
      // 两个板块的源时间粒度不同（公告只有日期），统一按时间倒序，避免旧的公告压在新快讯上面
      const rows = (data?.rows ?? []).slice().sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')))
      if (rows.length === 0) {
        return h('div', null, stale ? h('div', { className: 'bw-stale' }, `刷新失败（${error ?? '网络错误'}），显示的是上一次成功读取的数据`) : null, h('div', { className: 'bw-empty' }, '暂无资讯（抓取后自动出现）'))
      }
      return h(
        'div',
        { className: 'bw-news' },
        stale ? h('div', { className: 'bw-stale' }, `刷新失败（${error ?? '网络错误'}），下面是上一次成功读取的数据`) : null,
        rows.map((n) =>
          h(
            'div',
            { key: n.id, className: 'bw-news-item' },
            h('span', { className: 'bw-news-time' }, String(n.time ?? '').slice(5, 16).replace('T', ' ')),
            h('span', { className: 'bw-tag' }, (n.tags ?? []).find((t) => t !== '中金所') ?? (n.tags ?? [])[0] ?? '资讯'),
            h('a', { href: n.url, target: '_blank', rel: 'noreferrer' }, n.title),
          ),
        ),
      )
    }
