# CourtLens 指标适配 v2 · 本地导入契约

`pro/metrics-v2.mjs` 将提供者的指标字典与数值记录导入本地项目。入口是原有「导入数据」，`parseInput` 自动识别 `schema: "courtlens-metrics/2"`。这条路径不连接 AWS，不调用模型，不估计官方指标，也不认证提供者声称的 `official` 来源。

正式指标须先取得并核对原始字典、版本、定义、单位、统计粒度、身份和时间映射。本仓库没有赛方正式字典；不会猜测未知 Leverage 的尺度，也不会用防守距离生成 Gravity。`pro/fixtures/metrics-v2-sample.json` 是可以直接导入的完整样例，数据集和字典都明确标为 `synthetic`。里面的数字只用于结构演练。

## 导入包

| 顶层字段 | 要求 |
|---|---|
| `schema` | 固定为 `courtlens-metrics/2`，不接受其他指标版本 |
| `name`、`video`、`plays` | 沿用 Arena 回合／视频契约；每条回合有唯一 `id`、视频秒 `start,end` |
| `dictionary` | 含非空 `id`、`version`、`provenance`、`metrics`；最多 200 个指标定义 |
| `bindings` | 把 `difficulty`、`gravity`、`leverage` 明确映射到字典指标 ID；可为 `{}` |
| `records` | 独立记录数组，最多 20,000 条；每个关联回合最多 1,000 条，全项目展开关联最多 40,000 条 |
| `provenance` | 可选数据集来源；若提供须有非空 `kind`、`source` |

v2 回合不同时提供旧 `metrics` 数值，避免形成两个互相矛盾的数据来源。其他事件、视频和轨迹字段继续按 [Arena 数据契约](Arena-data-contract.md) 验证，文件仍受 16 MiB UTF-8 上限约束。

字典 `metrics` 是以指标 ID 为键的对象，每项必须声明：

```json
{
  "version": "provider-definition-version",
  "label": "提供者的原始指标名称",
  "role": "gravity",
  "semantics": "provider_off_ball_gravity_index",
  "unit": "provider-index",
  "definition": "来自提供者字典的完整定义",
  "granularity": "event",
  "ballState": "off-ball"
}
```

`role` 为 `difficulty`、`gravity`、`leverage` 或 `context`。`granularity` 为 `shot`、`event`、`possession`、`player` 或 `season`。Gravity 必须另外声明 `ballState: "on-ball" | "off-ball" | "combined" | "unknown"`；有球与无球指标应使用独立指标 ID。字典可保存 `range`、`higherIs`、`provenance` 和额外提供者字段。

每条数值记录包含以下字段，完整例子见样例文件：

```json
{
  "id": "provider-record-42",
  "metricId": "off-ball-gravity",
  "value": null,
  "scope": {
    "granularity": "event",
    "playId": "p01",
    "eventId": "event-42",
    "playerId": "player-12"
  },
  "time": {
    "timeBase": "video",
    "observedAt": 12,
    "availableAt": null,
    "validFrom": 12,
    "validTo": 15
  }
}
```

`value` 必须显式存在，只允许有限数字或 `null`。空白、布尔值和数字字符串不能冒充测量值；实际数值 0 保留。记录可以重复写 `unit`、`semantics`、`version`、`dictionaryVersion`、`ballState` 等字段，但它们必须与字典一致，否则拒绝导入。每条记录有独立原始快照，来源按记录、字典项、字典的顺序选取并完整保存。

## 粒度与身份

| 粒度 | 范围字段与处理 |
|---|---|
| `shot` | 必须有 `playId,shotId`；提供的出手身份、球员及观察秒须与回合事件一致 |
| `event` | 必须有 `playId,eventId`；允许同回合不同球员分别提供有球／无球指标 |
| `possession` | 必须有 `playId`；只能解释该回合的定义和范围 |
| `player` | 必须有 `playerId` 与 `aggregation`；按对应球员绑定，始终是范围背景 |
| `season` | 必须有 `seasonId` 和 `playerId` 或 `teamId`，并有 `aggregation`；按球员／球队／赛季精确关联 |

`aggregation` 保存 `start`、`end`、`label` 三个非空原始范围文本，例如提供者的赛季区间与「本比赛前累计」。它们不是视频秒；系统不猜测统计结束日期与录像时刻的对应关系。操作者必须在 `time.availableAt` 中提供经过核对的视频可用时间映射。缺少这种映射的统计仍可保存，但不会进入可用证据或故事。

球员和赛季汇总不进入瞬时回合排序，也不声称解释「此刻引力变化」。即使把赛季 Leverage 绑定到 `bindings.leverage`，它仍只以原始值及统计范围展示。难度排序只接收单次出手粒度；Leverage 排序只接收回合粒度且定义须明确兼容。

同一指标、相同完整 scope 和相同观察时刻／有效区间的重复记录必须先消解，系统不自行选择一个“正确值”。不同球员或事件同时竞争一个绑定字段时，没有唯一适用记录就显示无法选定，完整记录仍保留。绑定 Gravity 首先选择当前回合球员的记录，然后在有效候选中取最新观察；同时刻的多个不同范围仍拒绝合并。

## 时间、缺失与故事

所有数值记录显式声明 `timeBase: "video"` 和 `observedAt,availableAt`；未知用 `null`。不把比赛钟、回合经过秒或日期自行转换成视频秒。旧版轨迹 `timeBase` 转换不影响这些指标时间。

v2 已经声明为视频秒，因此 `metricTimeSyncPolicy(project)` 明确阻止再次执行旧版整项目来源轴偏移；`assertMetricTimeSyncAllowed(project)` 以 `metric-v2-video-axis-fixed` 错误拒绝该操作，且不改动数据。界面允许核对时间锚，应用全局同步时展示具体原因。需要更换轴时，先明确映射回合事件、指标观察／可用／有效区间与轨迹的时间，使用同一新视频秒重新导入 v2。系统不猜测源轴、不单独平移旧版投影视图，不制造与 raw records 不一致的“同步成功”。

动态记录须同时满足观察已发生、指标已提供、有效区间已开始，才能在指定 `asOf` 查看。`validTo` 为不含终点的失效时刻。缺失可用时间始终保持不可用；v2 不自动推定它在回合结束已经可用。更新记录明确为 `null` 时，它覆盖同指标同范围的旧读数，不回退到此前数字。回合开始前不暴露这条回合的球员背景或故事。

当前专业面板读取 `analyzePossession(...).scopedMetrics`；`metricContext` 是其中球员／赛季记录的子集，合并展示时须按 `evidenceId` 去重。它们保留原始值、单位、定义、粒度、时间、字典和指标版本，以及有球／无球状态。

完整故事还使用 `metricHistory`：某条事件记录虽然在回合末已经失效，其当时有效的读数仍可在当时视频秒生成声明和字幕。历史证据明确带有 `historical` 和 `availableNow`，保留失效区间；字幕不越过 `validTo`。独立派生的 `displayUntil` 还限制后续同范围更新前的展示时长，包括新值为 `null` 的情况；它不覆写来源时刻。历史读数的文案写明事件秒数，不能解释为当前持续动态。未到达的观察／可用时刻不会出现在证据或解说中。

## 显式转换

原始 `value` 和 `unit` 从不被转换覆写。可比概率或编辑分量另存于分析结果。字典只有明确声明以下转换时才执行：

| 字典 `transforms` | 前提与输出 |
|---|---|
| `probability: "percent-to-probability"` | 明确命中概率语义、`unit: "percent"`；另产生 `probability = value/100` |
| `editorial: "one-minus-probability"` | `role: "difficulty"`、明确命中概率、已声明概率单位或上述转换；另产生 `1-p` |
| `editorial: "identity-0-1"` | 明确难度或回合胜率机会差定义，单位 `probability`；用于兼容的编辑分量 |
| `editorial: "declared-range"` | 逐事件／出手／回合 Gravity，提供者明确 `range` 与 `higherIs: "more"`；产生独立编辑分量 |

概率单位值须在 0–1，百分数概率须在 0–100。未知 Leverage 不允许通过便利范围归一化；球员／赛季指标禁止使用编辑转换。最近防守距离等距离语义不能绑定为 Gravity。具有不同字典 ID、字典版本、指标版本、粒度、定义、单位、分项或转换的记录不会被放在统一排序尺度上。

样例 62% 在画面和解说中仍显示 62%；独立 `probability` 为 0.62，声明转换后的编辑难度为 0.38。没有声明转换时保留 62%，排序分量为 `null`。示例赛季 Leverage 6.2 保持其 `example-score` 单位，不解释成 620% 或回合机会差。

## 保存和调用

Arena 项目 schema 保持 `courtlens-arena/1`，旧备份继续打开。v2 项目新增 `metricAdapter` 保存原始字典、记录、绑定和版本；每条回合的 `metricRecords` 保存关联口径，`sourceRecord` 保存原回合。备份导入时重新核对展开记录与来源字典，冲突或篡改不会静默修复。旧格式无法完整表达这些多粒度记录，因此 `datasetForLegacy` 明确拒绝 v2，用户应保存 Arena JSON 备份。

可用接口：

```js
import { parseInput } from './model.mjs';
import { analyzePossession, buildNarration } from './analytics.mjs';
import { selectMetricRecords, formatScopedMetric } from './metrics-v2.mjs';

const { project } = parseInput(providerJson, 'provider.json');
const analysis = analyzePossession(project.plays[0], { asOf: 14 });
const rows = analysis.scopedMetrics.map(formatScopedMetric);
const story = buildNarration(project.plays[0], analysis);
```

Agent 检索继续提供有界摘要：每回合最多 48 条证据、16 条范围记录、16 条历史记录，保留截断计数。完整数据通过本地项目和单回合分析查看。测试覆盖原值保存、明确转换、单位冲突、缺失／零值、未来信息、失效区间、有球／无球身份、赛季范围、混合粒度、备份篡改及有界证据；它们证明输入契约行为，不是官方指标或模型精度验证。
