# Basis Watch · `dsh-basis-watch`

English | [简体中文](README.zh-CN.md)

A DSH (DeepSeek Harness) plugin that turns public commodity-market feeds into a
**local-first dashboard** for **basis (spot − futures)**, **cross-variety spreads** and
**warehouse receipts**, focused on China's oilseed complex: soybean meal / soybean oil / palm oil /
rapeseed oil / rapeseed meal / soybean No.1 / soybean No.2 / sunflower oil.

The network is only used to append data. Every statistic, chart and percentile is computed from
local files, so the UI keeps working offline and history is never silently rewritten.

- Settings → **期现瞭望 (Basis Watch)** to enable the sidebar entry, or press <kbd>Shift</kbd>+<kbd>Cmd</kbd>+<kbd>D</kbd>.
- No composite score and no "overvalued / undervalued" label — statistics only, every page states its caliber.

## Features

- **Overview** — variety table (price, change, basis rate, 3y percentile, receipts), dual-axis
  price/basis chart, spread snapshot, latest news, percentile legend
- **Detail** — key numbers, price percentiles (1/3/5/10y), basis percentiles, receipt curve,
  candlestick, basis-rate trend, seasonality band, forward curve, related spreads, foreign
  reference, data completeness, related news
- **Spreads / Inventory / News** pages; news filtered by tab
- **Agent tools** (read-only): `oils_overview`, `oils_detail`, `oils_spreads`, `oils_news`
- Adaptive layout and hand-drawn SVG charts (zero chart dependencies); plugin title/description are
  localized (en/zh) for the settings list, while the dashboard UI itself is Chinese for now
- Graceful degradation: missing data shows "no spot source" or "insufficient sample" instead of 0
  or stale values

## Install

```bash
git clone https://github.com/codeway3/dsh-basis-watch.git
cd dsh-basis-watch
dsh plugin --profile web add link:$PWD
```

Requires **DSH ≥ 0.1.7-rc.2** and **Node.js ≥ 22**. No runtime dependencies; `react` is provided by
the host. Restart `dsh web` after installing.

Data lives outside the repository, under `<DSH_HOME>/dsh-basis-watch/data/`
(`daily/ basis/ stock/ news/ quotes/ continuous/ meta.json`).

## Data sources

| Data | Source | History | Limits |
|---|---|---|---|
| Quotes | Sina `hq.sinajs.cn` | realtime | GB18030 + Referer required |
| Daily bars (main + contracts) | Sina `getDailyKLine` | 2005 → | 4 nearest contracts |
| Spot / basis | 100ppi spot-futures table | 2019 → | no soybean No.2 / sunflower oil |
| Sunflower spot | Mysteel public quotes | same day, multi-market | trader quotes, not an exchange benchmark |
| Warehouse receipts | Eastmoney `RPT_FUTU_STOCKDATA` | ~67 trading days | accumulated locally over time |
| News | chinagrain.com (6 columns) | latest list entries | titles only |
| Foreign reference | Sina `hf_S / hf_SM / hf_BO / hf_FCPO` | realtime | detail page only |

## Caliber (read before trusting a number)

| Item | How it is computed | Known limitation |
|---|---|---|
| Continuous contract | main contract inferred from contract bars, **ratio back-adjusted** (`lib/continuous.js`) | rescales historical levels, so it is **not** used for price percentiles |
| Price percentile / candles | **raw main-contract quotes**, 1/3/5/10y windows; windows with < 75 % of samples marked "insufficient" | real roll gaps remain |
| Max drawdown / volatility | ratio-adjusted series, restricted to the covered window (≈ 4.8 years) | shorter history than the 10y percentile |
| Seasonality | percent change from each year's first close; scaling cancels out, adjustment removes in-year roll gaps | only ~5 year points, so the band degrades from p10–p90 to p25–p75 |
| Basis | 100ppi spot vs the **specific contract** (e.g. 2611), not the continuous series | differs from the main-contract price (≈ 94 CNY in Nov 2026) |
| Trading calendar | built-in 2024–2026 CN holidays; scheduling uses Asia/Shanghai | 2027+ is approximated by weekdays and flagged via `/status` |
| Data time | `asOf` = source timestamp, `fetchedAt` = our fetch time | quotes refresh every 15 min, basis once per trading day |

## CLI (works without the DSH host)

```bash
node scripts/collect.mjs --status                     # coverage snapshot
node scripts/collect.mjs --bootstrap --years=2        # first fill (~5–10 min)
node scripts/collect.mjs --update                     # intraday quotes + news
node scripts/collect.mjs --update --mode=close        # after close: bars, receipts, basis
node scripts/collect.mjs --basis --date=2026-11-06 --force
node scripts/collect.mjs --contracts --years=3        # backfill contract bars, rebuild adjustment
node scripts/collect.mjs --rebuild-continuous
```

Every write goes through a cross-process lock (`job` for incremental work, `backfill` for long
backfills) and a per-dataset state machine, so the scheduler, HTTP API and CLI can run side by side.

## HTTP API

```
GET /basis-watch/api?op=status | overview | detail&code=M0 | spreads | news&limit=60&tag=豆粕
GET /basis-watch/api?op=update&mode=intraday|close | bootstrap&years=2 | basis&date=...&force=1
```

## Development

```bash
npm run check        # syntax check
npm run selftest     # data / host / correctness / client / shortcut / manifest
FR_REACT_DIR=/path/to/node_modules node scripts/render-smoke.cjs   # SSR smoke (11 checks)
FR_REACT_DIR=/path/to/node_modules node scripts/table-audit.mjs    # table header/body alignment
```

`FR_REACT_DIR` must point at a `node_modules` containing `react` and `react-dom`; the plugin itself
carries no dependencies.

- `client.js` hot-reloads in the running DSH app.
- `index.js` / `lib/*` need a profile recomposition (toggle the plugin off/on in Settings → Plugins).

## Disclaimer

Not investment advice. Market, spot, receipt and news data come from third-party public endpoints
(Sina Finance, 100ppi, Eastmoney, chinagrain.com, Mysteel). They may change, rate-limit or shut
down; availability, timeliness and accuracy are not guaranteed. Fetch intervals are deliberately
low (15 min intraday, one basis pass per trading day, 200 ms throttle on backfills) — please do not
raise them, and check each source's terms before redistributing. Futures trading carries
substantial risk.

## License

[MIT](LICENSE) © dsh-basis-watch contributors
