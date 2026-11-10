# 期现瞭望 · `dsh-basis-watch`

[English](README.md) | 简体中文

一个 DSH（DeepSeek Harness）插件：把公开的商品行情源变成**本地优先**的 **期现基差、跨品种价差、注册仓单**观察台，首个板块是油脂油料（豆粕 / 豆油 / 棕榈油 / 菜油 /
菜粕 / 豆一 / 豆二 / 葵油）。

网络只负责增量追加数据，所有统计、图表与分位都由本地文件计算，断网也能看，历史不会被静默改写。

- **设置 → 期现瞭望** 开启侧边栏入口，或按 <kbd>Shift</kbd>+<kbd>Cmd</kbd>+<kbd>D</kbd> 随时切换。
- 不做综合评分、不给「高估/低估」结论，只给统计位置，并在每处标注口径。

## 功能

- **总览**：品种表格（最新价、涨跌、基差率、3 年分位、仓单）、价格/基差双轴图、价差快照、
  最新资讯、分位图例
- **品种详情**：关键数字、价格分位（1/3/5/10 年）、基差分位、仓单曲线、K 线、基差率走势、
  季节性分位带、跨期结构、相关价差、外盘参考、数据完整度、相关资讯
- **套利 / 库存 / 资讯** 三个子页；资讯按当前标签过滤
- **Agent 只读工具**：`oils_overview`、`oils_detail`、`oils_spreads`、`oils_news`
- 自适应布局；图表全部手绘 SVG（零图表依赖）；术语答疑弹层解释基差、分位、z 值等概念
- 数据缺失不伪造：没有现货源显示「无现货源」，样本不足显示「样本不足」，不填 0、不拿旧值顶替
- 插件标题/描述跟随宿主语言（`locale/en.json`、`locale/zh.json`），界面文案目前为中文

## 安装

```bash
git clone https://github.com/codeway3/dsh-basis-watch.git
cd dsh-basis-watch
dsh plugin --profile web add link:$PWD
```

需要 **DSH ≥ 0.1.7-rc.2**、**Node.js ≥ 22**；无运行时依赖，`react` 由宿主提供。安装后重启
`dsh web`。

数据落在仓库之外：`<DSH_HOME>/dsh-basis-watch/data/`
（`daily/ basis/ stock/ news/ quotes/ continuous/ meta.json`）。

## 数据源

| 数据 | 通道 | 历史深度 | 限制 |
|---|---|---|---|
| 内盘行情 | 新浪 `hq.sinajs.cn` | 实时 | 需要 GB18030 + Referer |
| 日线（主连 + 分级合约） | 新浪 `getDailyKLine` | 2005 至今 | 取最近 4 个合约 |
| 现货 / 基差 | 生意社现期表 | 2019 至今 | 无豆二 / 葵油 |
| 葵油现货 | Mysteel 公开报价 | 当日多市场 | 贸易商报价聚合，非交易所基准 |
| 注册仓单 | 东财 `RPT_FUTU_STOCKDATA` | 约 67 个交易日 | 本地持续累积 |
| 新闻 | 中国粮油信息网（6 个栏目） | 列表页最新条目 | 不抓正文 |
| 外盘参考 | 新浪 `hf_S / hf_SM / hf_BO / hf_FCPO` | 实时 | 仅详情页参考 |

## 口径与已知偏差（看数字前先看这里）

| 项 | 做法 | 已知偏差 |
|---|---|---|
| 连续合约 | 用具体合约日线反推主连，按**比例复权**拼接（`lib/continuous.js`） | 会缩放历史价格水平，因此**不用于价格分位** |
| 价格分位 / K 线 | 用**主连真实报价**，1/3/5/10 年各自取窗口；样本 < 窗口 75 % 标「不足」 | 换月处仍有真实跳空 |
| 回撤 / 波动率 | 比例复权序列，只取覆盖区间（约 4.8 年） | 历史比 10 年分位短 |
| 季节性 | 年内相对首日收盘的百分比，常数因子约掉，复权还能去掉年内换月跳空 | 只有约 5 个年点，分位带自动从 p10–p90 降级为 p25–p75 |
| 基差 | 生意社现货价 vs **具体合约**（如 2611），不是主连 | 与主连价格不同（2026-11 实测差约 94 元） |
| 交易日历 | 内置 2024–2026 节假日；调度按北京时间 | 2027 及以后按周末近似，`/status` 会标 `covered:false` |
| 数据时点 | `asOf` = 源站时间，`fetchedAt` = 抓取时刻 | 行情 15 分钟一轮，基差每交易日一次 |

## 命令行（不依赖 DSH 宿主）

```bash
node scripts/collect.mjs --status                     # 数据覆盖
node scripts/collect.mjs --bootstrap --years=2        # 首次回填（约 5–10 分钟）
node scripts/collect.mjs --update                     # 盘中行情 + 新闻
node scripts/collect.mjs --update --mode=close        # 收盘：日线 / 仓单 / 基差
node scripts/collect.mjs --basis --date=2026-11-06 --force
node scripts/collect.mjs --contracts --years=3        # 回填合约日线并重建复权
node scripts/collect.mjs --rebuild-continuous
```

所有写操作都走跨进程锁（`job` 短任务 / `backfill` 长任务）和按数据集的状态机，调度器、HTTP
接口与命令行可以并行使用。

## HTTP 接口

```
GET /basis-watch/api?op=status | overview | detail&code=M0 | spreads | news&limit=60&tag=豆粕
GET /basis-watch/api?op=update&mode=intraday|close | bootstrap&years=2 | basis&date=...&force=1
```

## 开发

```bash
npm run check        # 语法检查
npm run selftest     # data / host / correctness / client / shortcut / manifest
FR_REACT_DIR=/path/to/node_modules node scripts/render-smoke.cjs   # SSR 冒烟（11 项）
FR_REACT_DIR=/path/to/node_modules node scripts/table-audit.mjs    # 表头/表体一致性
```

`FR_REACT_DIR` 指向包含 `react` 与 `react-dom` 的 `node_modules`（插件本身不带依赖）。

- `client.js` 改动在运行中的 DSH 里热更新；
- `index.js` / `lib/*` 改动需要在 **设置 → 插件** 里关掉再打开一次插件。

## 免责声明

本项目不构成投资建议。行情、现货、仓单与资讯均来自第三方公开接口（新浪财经、生意社、东方财富、
中国粮油信息网、Mysteel），这些接口可能变更、限流或停止服务，作者不对其可用性、及时性与准确性
作保证。抓取频率已刻意压低（盘中 15 分钟、基差每交易日一次、回填 200 ms 节流），请勿自行提高；
二次分发前请确认各数据源的服务条款。期货交易风险极高，据此操作风险自担。

## 许可

[MIT](LICENSE) © dsh-basis-watch contributors
