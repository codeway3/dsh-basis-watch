# Basis Watch · `dsh-basis-watch`

English | [简体中文](README.zh-CN.md)

A DSH (DeepSeek Harness) plugin that turns public market feeds into a **local-first dashboard**
for **basis / discount**, **cross-variety spreads**, **term structure** and **warehouse receipts**.

Release: **0.2.0** — see [CHANGELOG](CHANGELOG.md).

Ten boards ship today (76 varieties, including a reserved lithium-hydroxide slot):

- **油脂油料 (oilseeds)** — soybean meal / soybean oil / palm oil / rapeseed oil / rapeseed meal /
  soybean No.1 / soybean No.2 / sunflower oil: basis = spot − futures, plus receipts.
- **黑色 (ferrous)** — rebar RB, hot-rolled coil HC, iron ore I, coke J, ferrosilicon SF,
  silicomanganese SM, stainless SS: spot − futures, receipts, 螺矿比 / 卷螺差.
- **能化 (chemicals)** — PTA, methanol, urea, soda ash, PX, polyester staple fibre, bottle chip,
  PE, PP, PVC, MEG, styrene, natural rubber, TSR20, pulp, pure benzene, butadiene rubber,
  float glass, caustic soda, bitumen, propylene.
- **有色 (non-ferrous)** — copper / aluminium / zinc / nickel / tin / lead / alumina / international copper /
  cast aluminium alloy.
- **农产品 (agri)** — sugar / cotton / cotton yarn / corn / corn starch / eggs / hogs / red dates /
  apples / peanuts (eggs and hogs are converted to futures units).
- **贵金属 (precious)** — gold / silver / platinum / palladium, plus the gold-silver ratio.
- **新能源 (new energy)** — lithium carbonate / industrial silicon / polysilicon (GFEX); lithium
  hydroxide LI is reserved as an upcoming slot (contract published, listing date TBD).
- **能源 (energy)** — crude SC, LPG PG, fuel oil FU, low-sulphur fuel oil LU: no comparable onshore spot,
  so the "basis" is a **Brent × USD/CNY × factor** conversion, clearly labelled as such.
- **其他 (misc)** — a misc bucket for loosely-related contracts; currently containerised freight EC
  against the SCFIS Europe index (weekly settlement).
- **中金所 (CFFEX)** — index futures IF/IH/IC/IM (basis = futures − index, i.e. a discount, with
  annualized carry) and treasury futures T/TF/TS/TL (term structure and calendar spreads only;
  a real bond basis needs CTD/IRR, which no free feed provides).

Where the spot feed is not comparable the variety still ships, but its basis is explicitly empty with a
reason (e.g. caustic soda dry basis, TSR20 bonded quote, apples/red dates without a free spot source).
Float glass (元/㎡) and eggs/hogs (元/公斤) are converted to futures units instead of being dropped.

The board switch sits in the header, not inside a tab: the board decides the basis formula, whether
receipts exist and where news comes from, so it applies to every page at once.

The network is only used to append data. Every statistic, chart and percentile is computed from
local files, so the UI keeps working offline and history is never silently rewritten.

- Settings → **期现瞭望 (Basis Watch)** to enable the sidebar entry, or press <kbd>Shift</kbd>+<kbd>Cmd</kbd>+<kbd>D</kbd>.
- No composite score and no "overvalued / undervalued" label — statistics only, every page states its caliber.

## Features

- **Overview** — variety table (price, change, basis/discount rate, 3y percentile, receipts),
  dual-axis price/basis chart, spread snapshot, latest news, percentile legend
- **Detail** — key numbers, price percentiles (1/3/5/10y), basis percentiles, receipt curve,
  candlestick, basis-rate trend, seasonality band, forward curve, related spreads, foreign
  reference, data completeness, related news. CFFEX detail swaps "basis" for "discount" and shows
  the annualized discount plus expiry countdown for the main contract; treasury futures show a
  reason instead of a fabricated basis
- **Boards** — header-level dropdown across all ten boards; warehouse-receipt data is hidden for CFFEX and
  every board keeps its own news feed
- **Spreads** page has two modes: **cross-variety** (oil/meal ratio, soybean-palm, rapeseed-soybean oil,
  soybean vs rapeseed meal) and **calendar spread** (contracts picked by open interest each day, **any two
  months paired**, with spread = near − far / spread rate / annualized carry / same-pair percentile)
- **Inventory / News** pages; news follows the active board and tag (CFFEX shows exchange notices + filtered flashes)
- **Agent tools** (read-only): `oils_overview`, `oils_detail`, `oils_spreads`, `oils_term`, `oils_news`
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
| Quotes | Sina `hq.sinajs.cn` | realtime | GB18030 + Referer required; CFFEX has a different field layout |
| Daily bars (main + contracts) | Sina `getDailyKLine` | 2005 → | 4 nearest contracts |
| Index level (CFFEX spot leg) | Sina `s_sh000300` realtime + Eastmoney kline for history | index since 2005 | full history needed for 3y percentiles |
| Spot / basis | 100ppi spot-futures table | 2019 → | 54 commodities listed; only grade/unit-comparable ones are enabled; energy uses Brent×FX conversion, shipping uses SCFIS |
| Sunflower spot | Mysteel public quotes | same day, multi-market | trader quotes, not an exchange benchmark |
| Warehouse receipts | Eastmoney `RPT_FUTU_STOCKDATA` | ~67 trading days | accumulated locally over time |
| News (oilseeds) | chinagrain.com (6 columns) | latest list entries | titles only |
| News (all boards) | Jin10 flash + Eastmoney futures + Sina 7x24 + CFFEX notices + chinagrain | hundreds of candidates per run | tagged by board keywords, cross-source dedupe, market round-ups skipped |
| Energy reference | Sina `hf_OIL` (Brent) + `fx_susdcny` realtime; Brent daily via Sina global kline; USD/CNY history via frankfurter.dev (ECB) | Brent 2016 →, FX ~6y | conversion-level spot, **not** an onshore quote |
| Shipping spot | SCFIS Europe index (sse.net.cn, weekly) | weekly snapshots | Monday settlement, no intraday updates |
| Foreign reference | Sina `hf_S / hf_SM / hf_BO / hf_FCPO` | realtime | detail page only |

## Caliber (read before trusting a number)

| Item | How it is computed | Known limitation |
|---|---|---|
| Continuous contract | main contract inferred from contract bars, **ratio back-adjusted** (`lib/continuous.js`) | rescales historical levels, so it is **not** used for price percentiles |
| Price percentile / candles | **raw main-contract quotes**, 1/3/5/10y windows; windows with < 75 % of samples marked "insufficient" | real roll gaps remain |
| Max drawdown / volatility | ratio-adjusted series, restricted to the covered window (≈ 4.8 years) | shorter history than the 10y percentile |
| Seasonality | percent change from each year's first close; scaling cancels out, adjustment removes in-year roll gaps | only ~5 year points, so the band degrades from p10–p90 to p25–p75 |
| Basis | 100ppi spot vs the **specific contract** (e.g. 2611), not the continuous series | differs from the main-contract price (≈ 94 CNY in Nov 2026) |
| Index-futures discount (CFFEX) | future close − index close, annualized by natural days to the main contract's third-Friday expiry | dividend season (Jun–Aug) makes the discount jump; percentile is of the historical discount series |
| Treasury futures basis | not computed | requires CTD/IRR from deliverable bonds, no free feed; only term structure and calendar spreads are shown |
| Trading calendar | built-in 2024–2027 CN holidays; scheduling uses Asia/Shanghai | 2028+ is approximated by weekdays and flagged via `/status` |
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
GET /basis-watch/api?op=status | overview | detail&code=M0 | spreads | term&code=M0 | news
GET /basis-watch/api?op=update&mode=intraday|close | bootstrap&years=2 | basis&date=...&force=1
```

`op=term` picks contracts by **open interest** (top 5 by default), pairs **any two** delivery months and
returns spread (near − far, the exchange combo-order convention), spread rate, annualized carry and the
pair's own historical percentile. Percentiles are only meaningful within one contract pair.

## Development

```bash
npm install          # only for tests: react/react-dom (devDependencies)
npm run check        # syntax check
npm run selftest     # data / host / correctness / client / shortcut / manifest
npm run selftest:all # everything above + SSR smoke + table audit (needs npm install)
```

`FR_REACT_DIR` defaults to the repo's own `node_modules` in `npm run selftest:all`; point it elsewhere
if your `react`/`react-dom` live outside the repo. The plugin itself carries no runtime dependencies.
See [CHANGELOG.md](CHANGELOG.md) for release notes.

The browser half is authored as small ordered fragments in `src/client/*.js` and concatenated into
`client.js` by `npm run build:client` (no bundler, because the DSH client half must stay a plain
script). Edit the fragments, then rebuild; `npm run check` fails if `client.js` is stale.

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
