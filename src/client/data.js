    /* ───────────── 取数 ───────────── */

    /**
     * 统一的取数 hook。
     *
     * 三件事之前没做、现在必须有：
     * 1. 检查 HTTP 状态：400 也被当成功解析，界面会渲染出空数据；
     * 2. 失败保留上一份数据（stale），一次网络抖动不该把页面清空；
     * 3. 暴露 error/stale，让界面能显示"数据可能过期"而不是假装正常。
     *
     * @param {string} query 查询串（不含前导 ?）
     * @param {any[]} deps 额外依赖
     * @param {any} [preview] 服务端渲染冒烟测试用的假数据
     */
    function useApi(query, deps = [], preview = undefined) {
      const [state, setState] = useState({ loading: true, data: null, error: null, stale: false, asOf: null })
      const [nonce, setNonce] = useState(0)
      const reload = useCallback(() => setNonce((n) => n + 1), [])
      useEffect(() => {
        if (preview !== undefined) return undefined
        let alive = true
        setState((s) => ({ ...s, loading: true }))
        fetch(`${API}?${query}${nonce > 0 ? `&_=${nonce}` : ''}`, { cache: 'no-store' })
          .then(async (r) => {
            let body = null
            try {
              body = await r.json()
            } catch {
              body = null
            }
            if (!r.ok || body === null) {
              throw new Error(body?.error ?? `HTTP ${r.status}`)
            }
            if (body.ok === false) throw new Error(body.error ?? '接口返回失败')
            return body
          })
          .then((data) => alive && setState({ loading: false, data, error: null, stale: false, asOf: new Date() }))
          .catch((error) => {
            if (!alive) return
            // 失败时保留旧数据，只标记 stale
            setState((s) => ({
              loading: false,
              data: s.data,
              error: String(error?.message ?? error),
              stale: s.data !== null,
              asOf: s.asOf,
            }))
          })
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [query, nonce, preview, ...deps])
      // preview 用于服务端渲染冒烟测试：跳过请求，直接喂数据
      if (preview !== undefined) return { loading: false, data: preview, error: null, stale: false, asOf: null, reload }
      return { ...state, reload }
    }

