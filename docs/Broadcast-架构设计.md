# CourtLens Broadcast：Astra 架构主审与可开发规格

日期：2026-09-30。审核基线：`courtlens-arena-runtime`，HEAD `dd30928bd6267ef98ddc3bb53b5ca3c9f4f4b9cd`。本文件保留重构开始时的研究与实施规格，**不是逐项已实现或已部署的声明**。当前实际入口、已实现边界与验证状态以 README、使用指南和验收报告为准。正式规则、模型 ID、Agent 服务、账号与区域仍待 Portal 核定。

## 1. 最终决策

建设独立的 `/broadcast/`，产品名可继续叫 CourtLens：**上传一个进攻回合，把一个关键选择讲清楚，产出真实 MP4 与可复核观赛页。** 保留 `/arena/` 与成熟证据内核。

选用“语义提议＋定向取证＋官方记录绑定＋人工校订”的机制。整段模型负责提出发生了什么、哪些时刻值得看；事件附近的真实帧、可插拔 CV 和人工复核确定身份、时刻及标注；确定性代码绑定官方数字、控制图层与导出。每回合最多三段故事，不要求凑满。自动模型未配置时，人工观察路径仍可完成制作，但界面和导出必须显示“人工辅助制作”，不得显示“AI 已看懂视频”。

P0 必做：真实上传与持久化、真实视频探测、关键帧、人工观察/复核、官方指标导入、三段以内故事编辑、已审计划、原速真实 MP4、中文配音可用性与可选生成、观看/下载。P0 同时交付**可真实调用的 Bedrock 视频/图像适配器和 CV 执行/导入适配器**，未配置返回可操作的阻塞状态，不以固定演示 JSON 冒充执行。

P1：官方样片实测与模型能力探测、定向 CV、指定云链路、Polly、真实部署。P2：短区间连续标签与自动球场标定。慢动作、整场追踪、三种声音、外部背景数据大聚合、全场战术地图不进入本次首个垂直切片。

## 2. 证据与附件审核

已读取两份 Downloads 附件、项目四份指定文档、培训原始转写和 `core/`、`pro/`、原生成片工具。官网与 Feishu 的实时页面核验本轮失败；培训结论以实际已读逐字稿为依据，不宣称在线页面已经重新确认。

关键修正：

| 附件主张 | 审核后规格 |
|---|---|
| 每段约 48 秒/两个 48 秒 | 逐字稿 02:09:39 是**两段训练回合合计 48 秒**；考试一段普通转播，具体时长不能提前写死 |
| Portal 必然提供逐事件 xFG/Gravity/LVG | 尚未见真实交付数据；数据粒度、字段、时钟与身份映射均是待验依赖。只有赛季数据时只展示赛季背景 |
| 三项必须做齐即可锁定机器 35 分 | 只是门槛线索，细分评分不明，不能锁分或保证夺冠 |
| Agent 服务就是 AgentCore、区域就是 us-east-1 | AgentCore 是技术首选候选；这两个正式配置不得由转写猜定 |
| Bedrock＋千问235B都可直接读整段视频 | 型号与输入能力必须实测；参数规模不是多模态能力证明。文本模型只消费观测与数据 |
| RF-DETR 原版开箱识别篮球/进球/球衣号 | 专项权重、标签表、许可与运行条件须实际取得；通用权重不能冒称篮球专用权重 |
| SAM2 就能认出球员或判进球 | SAM2 是视频分割/跟踪组件；身份、事件与 OCR 是独立问题 |
| 负 GRAV 就是被放空，低 xFG 必然精彩 | 均是过度推断。故事区分数据事实、画面事实、战术解释，不以一个值自动下因果结论 |
| DEF DIST 28–38 可以按英寸换米 | 没有字典明确单位就保留原值并停用距离解释，禁止靠量级猜单位 |
| 赛季数字直接讲成该回合事实 | 禁止；赛季、比赛、事件、瞬时值必须分层。附件具体榜单数值不写进程序或默认素材 |
| 独行侠默认认成东契奇 | 必须按比赛日期与当场名单识别。东契奇在 2025 年已转至湖人，[NBA球队公告](https://www.nba.com/lakers/news/lakers-acquire-doncic-kleber-morris-from-mavericks-020225)；历史录像仍可能属于独行侠 |
| xFG从39.6%变18%就是难一倍 | 禁止这种比值解说；只有同定义、同范围的百分数差才能说“相差若干百分点”，且赛季与单次对比需明确上下文 |

NBA官方公开资料确认三类指标含义不同，正式字段仍须以赛事字典为准。[官方术语入口](https://www.nba.com/news/inside-the-game-stat-glossary) Leverage 的事件归因不是将一项累计读数直接当成胜率百分点。[NBA Leverage说明](https://api-hub.nba.com/news/leverage-stat-explainer)

`nba_api`、`pbpstats`等第三方库和 ESPN 数据均不作为 P0 或官方高级指标的替代源。后续允许后台导入已缓存的背景数据，但必须保留供应方、获取时间、gameId、season、seasonType、聚合范围。网页显示公开数据不等于稳定 API、素材许可或赛事认可来源；本轮不承诺其在线可用性，也不批量抓取。

## 3. 三个实质不同机制的比较

| 机制 | 输入到成片方式 | 优点 | 主要失败点 | 结论 |
|---|---|---|---|---|
| A：整段多模态一次生成 | 视频→模型直接生成事件、坐标、台词→渲染 | 首次结果快，代码少 | 时间和身份可能幻觉；像素坐标不可靠；官方数字易混淆；难检测遗漏 | 可作语义提议，不能直通发布 |
| B：密集视觉重建 | 逐帧RF-DETR→SAM2→OCR/队伍→球场投影→事件规则→文本模型 | 几何可解释；充分调试后可生成连续标签 | 权重、GPU、遮挡、切镜、球太小、OCR错误与标定误差累积；训练样本不足 | 保留专项增强，不作为P0阻塞依赖 |
| C：语义提议＋定向证据 | 整段或分镜视频理解→挑事件窗→真实帧/CV取证→人工确认→数值编译→有限故事 | 自动理解与精确复核分工明确；算力集中关键几秒；能降级仍交付 | 仍需显式人工复核；视觉模型不保证战术理解；需要严谨合同 | **选择** |

选择 C 不是承诺更高分，而是控制比赛两小时内最可能失败的依赖，同时保留真正自动视频理解的实现空间。

技术核验：Roboflow 官方篮球教程确实组合 RF-DETR、SAM2、队伍聚类和号码识别，报告 T4 上约 1–2 FPS，SAM2 为瓶颈；该速度是教程样本数据，不是本项目承诺。[Roboflow教程](https://blog.roboflow.com/identify-basketball-players/) 官方 sports 仓库是可复用工具集合，不能视作一个已经打包好的 NBA 生产服务。[Roboflow仓库](https://github.com/roboflow/sports) SAM2 的视频预测器支持状态与交互修正，但不会因此自动获得球员名字。[SAM2代码](https://github.com/facebookresearch/sam2/blob/main/sam2/sam2_video_predictor.py)

Nova Lite/Pro 的视频输入对短片按约 1 FPS 采样；Nova 2 Lite 当前文档也写了 1 FPS。因此整段视频时间点只能是候选窗，出手瞬间需要帧级复核。不能把原片 60 FPS 等同模型看到60帧/秒。[Nova视频](https://docs.aws.amazon.com/nova/latest/userguide/modalities-video.html) [Nova 2多模态](https://docs.aws.amazon.com/nova/latest/nova2-userguide/using-multimodal-models.html)

## 4. 现有代码真正可复用之处

| 位置 | 已有机制 | 新方案使用方法与限制 |
|---|---|---|
| `pro/metrics-v2.mjs` | 字典、单位、来源、粒度、有效时刻、绑定检查 | 完整复用 `courtlens-metrics/2`；Broadcast增加更严格的身份绑定门槛，不重造概率封装 |
| `pro/story-plan.mjs` | proposal、revision、人审、引用、哈希、渲染身份 | 编译为 `courtlens-story-plan/1`；新接口不把模型任意输出直传renderer |
| `pro/camera-view.mjs` | 镜头/标定失效关闭图层、已审箭头 | 保留切镜保护；不要对整个移动镜头使用单一四点投影 |
| `pro/render.mjs` | Canvas叠加 | 新页面预览复用；精简默认图层，不动旧页面逻辑 |
| `tools/export_story_plan.mjs` | 无浏览器Node Canvas＋FFmpeg MP4、VTT、清单、缓存 | 首个版本原速、25fps明确网格；旧工具是静音，不能声称已有配音或慢动作 |
| `core/arena_voice.py` | macOS Tingting、逐句音频实测、PCM时间线、FFmpeg | 可提取其已有分句生成/测时/混音逻辑到新包装；旧HTTP只收WebM，不得把MP4直接塞进旧入口 |
| `core/arena_agent.py` / `model_agent.py` | 有限工具调用、读取已有claim再挑选 | 继续作历史功能；它们不是视频理解。新Observation执行器必须真正传视频或图像 |
| `core/jobs.py` / workspace | 本地任务、工作区、版本 | 可以复用底层，但新任务命名空间独立，避免修改旧合同 |

具体兼容点：v1 StoryPlan箭头只接受 `origin:"manual"`。P0 的自动CV几何先作为候选存入 ObservationBundle，人工接受后产生一个新的“人工确认标注”记录；v1箭头按人工确认记录编译，完整CV原始来源和修订保存在新项目旁证中。未经人审的自动跟踪箭头不能偷偷改为manual。旧渲染器输出的 `videoAIInference:false` 等元信息不可直接当新产品总状态；新发布清单分别保存媒体推理、内容审核与导出验证状态，不篡改旧清单。

**编译器必须处理的细节：** `verifyStoryPlan`会从原project重算证据并比对，不能通过`options.analyses`塞进自造“官方证据”。P0人工观察可编译为有对应源区间的人工事件及旁证，v1 cue使用合法事件/指标/结果handle，`basisStart:null`并保留原观察与人工审核hash；完整观察依据由Broadcast发布清单记录，旧事件handle只是归属锚点，不被吹成动作语义证明。若确需让旧内核直接认识新的观察证据，A必须向主代理提交最小显式扩展`pro/analytics.mjs`与校验合同，保留重算保护，不能绕开verify。窗口证据在旧规则中必须`end <= cue.start`：动作解释应在证据窗完成后出现；动作中只展示已可见单帧/身份锚点，不能把整段观察的availableAt倒拨到开头。结果文句必须关联已确认outcome且在结果时刻后出现。

## 5. 工作流与观赛体验

制作流程只有四步：

1. **选片。** 上传、立即可播放、展示真实时长和封面。填写来源标签与素材用途；可选导入官方指标。选择“自动理解”或“人工辅助”；能力不足时给出具体缺项和人工入口。
2. **看懂。** 视频占左侧主要区域，右侧是按时间排列的“发生了什么”。自动模式实际运行模型，产出1–3个事件窗；人工模式点“在此添加观察”，选择出手/传球/跑动/结果/其他，填写一句观察。可逐帧检查、确认球员或保留未知。点击记录回跳原片。
3. **讲清。** 最多三个故事节点，每节点一句主解释、最多一个主要数字和一个辅助标签、一个图形。修改句子、入出点、箭头、证据；“检查问题”列出具体可修复项。人工最终复核后版本冻结。
4. **出片。** 选择字幕版或可用中文配音，生成真实MP4；任务进度按真实阶段显示，无虚假百分比。播放结果、下载MP4/VTT、打开观赛页。失败保留此前成片，不覆盖发布。

观赛页 `/broadcast/?release=<id>` 默认是已发布成片，大视频＋一个标题＋“原片 / 解说版”切换；下方最多三个章节按钮；“这一刻的依据”抽屉而非常驻调试面板。原片/增强版切换保持同一 source 秒数。P0无慢动作，映射线性明确。字幕/语音开关不把不一致版本拼接在一起。

画面节奏：事件前短句提出问题，动作中轻标注，结果后解释；不必须套用“吸引防守→传球→命中”。可能只有“接球→出手→结果”，甚至只支持一段。无xFG就讲已确认动作，不补预测数字；没有连续轨迹就用经复核的短区间箭头或停在暂停状态的说明，播放时不挂漂移姓名。

视觉建议由另一UI主审定稿：NBA海军蓝底、白色文字、蓝色操作、橙色关键证据；红色只作错误或球队必要色。主视频应占桌面首屏宽度约65–75%，手机满宽。观众入口不出现云服务配置、schema、token等开发细节；制作端能力抽屉才显示。加载、无片、人工模式、模型失败、审核阻塞、正在导出、已有成片均有完整状态。每个按钮必须有真实保存/调用/播放行为。

## 6. 模块边界与目录

```text
broadcast/                    新页面，仅调用公开HTTP合同
  index.html app.mjs styles.css api.mjs
  contracts.mjs               前端类型/校验镜像；由后端合同生成或逐项一致
core/broadcast/               后端唯一业务入口
  routes.py service.py store.py jobs.py contracts.py
  media.py observations.py bindings.py story.py review.py
  providers/bedrock.py cv_command.py cv_import.py voice.py
tools/broadcast_compile.mjs   新项目→合法既有StoryPlan、预览数据
tools/broadcast_export.mjs    包装既有静音导出＋可选配音与新manifest
contracts/broadcast-v1.json   唯一JSON Schema/OpenAPI形状，先冻结
infra/                       独立CDK工程与云adapter/container
```

后端持久化在 `workspace/broadcast/<projectId>/`，项目JSON原子写入＋revision条件检查；媒体、模型结果、CV结果、审核记录和release不可变分开存。禁止将前端localStorage视作唯一事实来源。localStorage只记最近项目ID。

本地提供者与云提供者共用业务合同：本地磁盘 ↔ S3对象；本地任务线程/子进程 ↔ Step Functions/Fargate；文件元数据 ↔ DynamoDB；直接有限Agent loop ↔ 指定AWS Agent服务承载。API稳定不代表云实现已运行。

## 7. 核心合同（实施必须按此命名，额外字段需版本升级）

全局：JSON禁止NaN/Infinity；未知值为null，不用0表示未知；所有ID为服务端UUID/受限字母数字，用户文本绝不成为路径。源时钟字段均为**解码呈现PTS秒**，不是视频帧序号除fps，也不是比分牌比赛时钟。新上传探测实际帧率、时基、起始PTS和时长，保存归零关系。输出时钟单独命名 `outputStart/outputEnd`。

### 7.1 Project

```ts
type Project = {
 schema: "courtlens-broadcast/1";
 id: string; revision: number; title: string;
 createdAt: string; updatedAt: string;
 mode: "manual"|"assisted";
 media: MediaManifest|null;
 context: {gameId:string|null; gameDate:string|null; seasonId:string|null;
           seasonType:string|null; offenseTeamId:string|null; roster:Player[]};
 observations: Observation[];
 bindings: EventBinding[];
 metrics: object|null; // 原样验证后的 courtlens-metrics/2，不另拟简化形状
 story: BroadcastStory|null;
 review: Review|null;
 releases: ReleaseSummary[];
};
type Player = {id:string; name:string; teamId:string; jersey:string|null;
               source:string; validOn:string|null};
```

所有输入修改均revision+1，取消当前审核。生成中的job绑定起始revision和内容hash，不得静默覆盖编辑后的项目。

### 7.2 MediaManifest

```ts
type MediaManifest = {
 id:string; sha256:string; filename:string; bytes:number;
 duration:number; width:number; height:number;
 timeBase:string; startPts:number; fpsNumerator:number; fpsDenominator:number;
 variableFrameRate:boolean; hasAudio:boolean;
 mediaUrl:string; posterUrl:string|null;
 source:{label:string; kind:"official-provided"|"user-provided"|"synthetic";
         rightsNote:string; verified:boolean};
};
type FrameRef = {id:string; mediaSha256:string; requestedTime:number;
                 actualTime:number; pts:number; timeBase:string;
                 sha256:string; url:string; width:number; height:number};
```

`official-provided`是来源声明，verified只可由审核流程设置，不能由上传者直接控制。URL由服务端生成，模型不能指定任意文件或网址。

### 7.3 ObservationBundle / Observation

```ts
type ObservationBundle = {
 schema:"courtlens-observations/1"; mediaSha256:string;
 providerRun:{id:string; provider:string; modelId:string|null;
              mode:"video-model"|"image-model"|"cv-executed"|"cv-imported"|"manual";
              requestHash:string; responseHash:string; startedAt:string; completedAt:string};
 observations:Observation[];
};
type Observation = {
 id:string; type:"pass"|"shot"|"catch"|"movement"|"screen"|"result"|"other";
 start:number; end:number; anchorTime:number|null; segmentId:string;
 description:string; playerIds:string[]; unknownActors:string[];
 frameIds:string[];
 source:{kind:"manual"|"model"|"cv"; runId:string|null; recordId:string|null};
 confidence:number|null; // 模型自报，不是已校准正确率
 review:{status:"unreviewed"|"accepted"|"rejected"; actor:string|null;
         reason:string|null; at:string|null};
 geometry:{space:"screen-normalized"; points:{x:number;y:number}[];
           validFrom:number;validTo:number; segmentId:string}|null;
};
```

start < end；anchorTime若有必须在区间内；frameIds必须属于同媒体；geometry范围0–1且不跨segment。模型输出的playerId只允许从当场名单选取或留空。切镜后默认身份断开，不能依据相同号码自动延续。模型产生的screen、诱导、吸引等解释在未审核前均是候选。一个帧可证位置，不能单独证明运动方向或因果。

### 7.4 EventBinding

```ts
type EventBinding = {
 id:string; observationId:string; officialEventId:string|null; shotId:string|null;
 gameId:string|null; playerId:string|null;
 metricRecordIds:string[];
 timeMapping:{source:"video"|"game-clock"; videoTime:number;
              period:number|null; clock:string|null; mappingEvidenceIds:string[]};
 status:"proposed"|"confirmed"|"rejected";
 reason:string; confirmedBy:string|null; confirmedAt:string|null;
};
```

只有confirmed绑定允许事件数值进入主视频；游戏时钟停止、回放与切镜意味着不能简单固定offset。无明确eventId时要人审映射，不能按最近秒数默默绑定。v2中的season/player记录只进入背景，不放进瞬时xFG/Gravity/LVG槽位。来源未知记录可以保存，但不贴NBA官方徽标。

### 7.5 BroadcastStory

```ts
type BroadcastStory = {
 schema:"courtlens-broadcast-story/1"; title:string; audience:"fan"|"pro";
 sourceRange:{start:number;end:number};
 beats:Beat[]; // 1–3，按sourceStart排序且不重叠
};
type Beat = {
 id:string; label:string; sourceStart:number; sourceEnd:number;
 anchorTime:number; observationIds:string[]; bindingIds:string[];
 text:string; explanationKind:"visible-fact"|"data-fact"|"interpretation";
 metricRecordId:string|null; // 主指标至多一个
 secondaryLabel:string|null;
 annotation:{id:string; points:{x:number;y:number}[];
             sourceObservationId:string; confirmedBy:string;confirmedAt:string}|null;
};
type Review = {
 contentHash:string; projectRevision:number; actor:string; at:string;
 checks:{identity:boolean;timing:boolean;metrics:boolean;wording:boolean;geometry:boolean};
 result:"approved"; note:string;
};
```

text内的官方数值由后端根据metricRecordId确定性填充；模型提议使用占位符如`{{metric:m17}}`，不自由写18%。编辑器显示实际可读文字，但提交时保留引用与模板；手工正文出现新的数字则要求匹配来源或退回审核。一般文字与篮球因果仍需人工检查，校验器不能声称验证了所有自然语言事实。

默认剪辑为sourceRange内原速片段，beats只是叠加时窗；不要把每段beat独立拼接导致音视频总时钟意外改变。编译sourceRange的入出点到既有25fps网格时，向用户展示建议修正，并记录原请求与确认值，禁止不留痕的裁剪。VFR上传可保存并预览，首版导出需显式归一化派生片与源PTS映射；若尚未实现则返回`unsupported_timebase`，不得默默假定CFR。

### 7.6 Job / Release / Error

```ts
type Job = {
 id:string; projectId:string; inputRevision:number;
 type:"analyze"|"cv"|"render"|"probe-provider";
 status:"queued"|"running"|"needs_review"|"succeeded"|"failed"|"cancelled"|"blocked";
 stage:"queued"|"probe"|"frames"|"infer"|"bind"|"draft"|"voice"|"render"|"verify"|"done";
 startedAt:string|null; completedAt:string|null;
 progress:{completed:number;total:number;unit:string}|null;
 resultId:string|null; error:ApiError|null; cacheHit:boolean;
};
type ReleaseSummary = {
 id:string; projectRevision:number; contentHash:string; createdAt:string;
 videoUrl:string; captionsUrl:string; manifestUrl:string; watchUrl:string;
 duration:number; videoSha256:string;
 voice:{mode:"silent"|"local-tts"|"polly"; provider:string|null;
        voiceId:string|null; audioSha256:string|null};
 understanding:{mode:"manual"|"image-model"|"video-model"|"cv-assisted";
                providerRunIds:string[]; humanReviewed:boolean};
};
type ApiError = {code:string;message:string;retryable:boolean;
                fields:{path:string;message:string}[];jobId:string|null};
```

错误码最低集合：`invalid_request`、`revision_conflict`、`media_mismatch`、`media_unreadable`、`upload_too_large`、`provider_not_configured`、`provider_unverified`、`unsupported_modality`、`provider_failed`、`cv_not_installed`、`weights_missing`、`schema_invalid`、`unresolved_binding`、`review_required`、`voice_unavailable`、`voice_overflow`、`unsupported_timebase`、`render_failed`、`cancelled`。不能把provider_failed改成成功的模板结果。

## 8. HTTP合同与状态机

前缀固定 `/api/broadcast/v1`。成功响应 `{"data":...}`，失败 `{"error":ApiError}`。所有写操作含`expectedRevision`或`If-Match`，revision冲突返回409。分析/导出接受`Idempotency-Key`，相同键＋同请求重返同job，不同请求409。

| 方法/路径 | 请求 | 成功data |
|---|---|---|
| GET `/capabilities` | 无；只本地探测，绝不暗中下载/收费调用 | 下节Capabilities |
| POST `/providers/:id/probe` | `{projectId,expectedRevision,frameId:string|null,scope:{start,end}|null}`，使用当前项目已许可媒体 | Job，202；真实调用完成后才更新verified |
| POST `/projects` | `{title,mode:"manual"|"assisted"}` | Project，201 |
| GET `/projects` | 无 | `{projects:[{id,title,revision,updatedAt,hasMedia,latestReleaseId}]}` |
| GET `/projects/:id` | 无 | Project |
| POST `/projects/:id/media` | 原始二进制；`Content-Type`，`X-Filename`，`If-Match:<revision>`，来源通过下一行metadata保存 | 更新Project，201 |
| POST `/projects/:id/edit` | `{expectedRevision,patch:{title?,mode?,context?,source?,observations?,bindings?,story?}}`；只列出的字段可写 | 更新Project |
| POST `/projects/:id/metrics` | `{expectedRevision,bundle:<courtlens-metrics/2>}` | 更新Project |
| POST `/projects/:id/frames` | `{expectedRevision,times:[number]}`，最多16帧一次 | `{frames:FrameRef[]}`；不改内容revision，只增不可变帧库 |
| POST `/projects/:id/analyze` | `{expectedRevision,providerId,scope:{start,end},strategy:"video-first"|"frames-first"}` | Job，202；无法执行503并明确原因 |
| POST `/projects/:id/cv` | `{expectedRevision,providerId,scope:{start,end}}` | Job，202 |
| POST `/projects/:id/cv/import` | `{expectedRevision,result:<courtlens-cv-result/1>}` | 更新Project；规范化为cv-imported观察 |
| POST `/projects/:id/observations/import` | `{expectedRevision,bundle:ObservationBundle}` | 更新Project；cv-imported不能标成cv-executed |
| POST `/projects/:id/story` | `{expectedRevision,audience:"fan"|"pro",mode:"template"|"model",providerId:string|null}` | 更新Project；只用accepted观测、confirmed绑定 |
| POST `/projects/:id/review` | `{expectedRevision,actor,checks:{identity,timing,metrics,wording,geometry},note}` | 更新Project；先校验再冻结 |
| POST `/projects/:id/render` | `{expectedRevision,voiceMode:"silent"|"local-tts"|"polly",voiceId:string|null}` | Job，202；检查审核hash一致 |
| GET `/jobs/:id` | 无 | Job；轮询1–2秒即可，无需WebSocket |
| POST `/jobs/:id/cancel` | `{}` | Job；取消后不得发布部分输出 |
| GET `/releases/:id` | 无 | 发布清单与ReleaseSummary |
| GET `/media/:id` | 支持Range与HEAD | 二进制，正确Content-Type |
| GET `/frames/:id` | 无 | PNG/JPEG |
| GET `/releases/:id/:asset` | asset仅film.mp4/captions.vtt/manifest.json | 二进制或JSON白名单 |

创建项目→上传→人工/自动观察→接受观察及确认绑定→故事草稿→人工审定→渲染→独立验证→不可变release。所谓“已审”必须绑定当前内容hash。任何编辑都撤销复核，但历史release仍能看。模型调用失败不会吞掉人工输入；晚到的任务结果记录为独立proposal，前端显示“基于旧版本生成”，不能覆盖新版本。

本地上传首版上限256MiB、180秒，后端流式接收并测真实字节，禁止base64大视频JSON；是产品初始限制，不是赛方限制。媒体目录禁止任意路径拼接、符号链接逃逸、URL抓取与网络协议FFmpeg输入。localhost写接口仍需校验Origin/Host或会话token以免跨站写入。云端写接口必须认证。

## 9. 模型与CV：必须是真接口，能力探测不下载巨模型

### 9.1 Capabilities

```ts
type Capabilities = {
 schema:"courtlens-broadcast-capabilities/1";
 renderer:{available:boolean;ffmpeg:boolean;ffprobe:boolean;node:boolean;font:boolean};
 providers:{id:string;kind:"semantic"|"cv"|"voice";
   configured:boolean;available:boolean;verified:boolean;
   modalities:("text"|"image"|"video")[];
   mode:string;reasonCode:string|null;message:string;
   lastProbeAt:string|null;lastProbeResult:"passed"|"failed"|"never"}[];
 deployment:{mode:"local"|"aws";agentService:string|null;
             region:string|null;verified:boolean};
};
```

GET只检查配置存在、解释器/命令/本地权重路径、依赖metadata与程序`--capabilities`输出；不import触发自动拉模型、不联网、不下载权重、不以SDK存在等同调用可用。`configured=true, verified=false`是正常状态。真正probe由制作端显式按钮触发一项任务，读取一帧/一段合法测试片，写provider request/response指纹和耗时，验证当前账号/区域/模型模态。可见文字“已配置，尚未实测”而非绿色“模型就绪”。

### 9.2 Bedrock执行器

后端配置独立的 `semanticModelId`、`visionModelId`、`region`、`allowedInferenceProfile`，任何一个不得硬编码成附件猜测值。`bedrock-converse`执行器真正构造Converse video/image content；只文本模型拒绝video-first，提供frames-first（需要支持图像）或manual。文本Qwen可接已确认ObservationBundle组织语言，不标成视觉提供者。

提供者输入上限独立于上传上限：必须按当前实际模型的官方合同设置格式/时长/字节数/图片数；不把Nova文档的1GB媒体上限当成Converse内联body上限。首版采用保守的产品级内联视频上限4MiB；超出时只可选择已配置、获准的同区域S3对象或生成明确记录hash与PTS映射的压缩派生片，不能向API发送256MiB原上传字节赌成功。没配置S3也不允许任意外网URL替代。image与video content block的构造、模型返回拒绝、超限与未获准inference profile都有真实请求测试和可读错误。

真正Agent loop最多4轮、12次工具、任务180秒起步上限（可配置实测调整）：`inspect_clip`、`inspect_frames`、`read_observations`、`read_metric_records`、`propose_story`。工具参数白名单，模型不能执行shell、浏览任意网页、读任意S3对象或发布。视频内容和导入数据中的指令当作数据。工具读取以服务端projectId与revision授权为准，模型不能换项目。

返回先严格结构校验，最多一次纠错重试，仍失败以`schema_invalid`结束。保存请求hash、模型ID、输入媒体/帧hash、工具调用摘要、响应hash和usage；日志不保存密钥，不把隐藏推理链写为审计。所有语义结论进入unreviewed，不能仅靠confidence自动批准。

video-first：整段语义候选→选最多3个事件窗→每窗最多8个带实际PTS的帧→模型或人工确认。frames-first：分镜概览＋事件窗帧组，明确标“关键帧辅助理解”，不是“原生视频模型”。不为了满足附件口号而拒绝实用的定向抽帧；真正问题是纯孤立帧无法证明时序，而非“不能抽帧”。

### 9.3 CV执行与导入合同

必须实现可工作的 `cv-command` adapter，而不是只有抽象类。运行命令由服务器配置，不由请求提供：

```text
<approved-executable> --capabilities
<approved-executable> --request <server-created-request.json> --output <server-created-output.json>
```

`--capabilities`返回：`{schema:"courtlens-cv-capabilities/1",providerId,version,available,model:{name,weightsSha256,weightsPresent},tasks:["detect","track","jersey","court-keypoints"],reasonCode}`。必须遵循离线检查，不拉取模型。执行request为`{schema:"courtlens-cv-request/1",jobId,media:{localPath,sha256},scope:{start,end},outputTimeBase:"video-pts-seconds",limits:{maxFrames:300,maxSeconds:90},tasks:[...]}`。localPath只由服务器解析，不向浏览器暴露或接受用户值。

执行结果 `{schema:"courtlens-cv-result/1",mediaSha256,provider:{id,version,weightsSha256},samples:[{frameTime,segmentId,objects:[{trackId,classId,score,bbox:[x,y,w,h],jerseyText:null|str,jerseyScore:null|num,keypoints:[]}]}],events:[{type,start,end,confidence,trackIds}],diagnostics:{framesProcessed,elapsedMs}}`。全部坐标归一化，分数有限0–1；trackId是轨迹身份，不是playerId；OCR只作为号码候选。后端验证媒体hash、时间边界、box范围与样本量，转换为ObservationBundle。错源片结果拒绝。

提供真实导入功能接受同一结果并标cv-imported；提供真实执行功能启动允许命令、捕获stderr摘要、超时终止、读输出并验证。测试可用受控fixture程序验证协议，但该程序的provider名字必须带fixture，界面不得列为篮球模型已安装。

首个可选实际CV插件采用RF-DETR检测＋短窗跟踪；SAM2只在GPU/权重就绪后加。项目不能偷偷安装几十GB模型来让探测变绿。YOLO、DeepSportLab留作相同输出合同的备选，需各自权重、许可证、样本验证后才启用；本轮不宣称已核验其NBA转播泛化能力。

**Fargate不支持GPU任务参数**，因此渲染/FFmpeg走Fargate，SAM2等GPU推理不能被写成Fargate工作负载。[AWS Fargate限制](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html) 如赛方允许且配额存在，再选SageMaker GPU或获准外部CV；P0保留人工标注与视频模型，不让GPU资源成为必经环节。

## 10. 图层与数值的硬约束

1. 不从普通转播像素重建或“近似”官方xFG/Gravity/LVG。自建几何观察若未来增加，应使用独立名称，不进入官方三项指标槽位。
2. xFG只对确认的shot绑定；percent与probability显式转换一次。62 percent→62%，0.62 probability→62%；没有单位直接阻塞解释。
   百分数差另用`percentage_point`单位；56.9%−46.6%=10.3个百分点，不写成相对增长10.3%。只在两个输入都可验证且比较口径允许时计算。
3. Gravity保持持球/无球、内线/外线与统计范围；不能用最近防守距离、防守人数或圈面积代替。
4. LVG保持原单位和累计范围，不转换成0–1或胜率提升百分点，除非正式字典明确允许。
5. observedAt、availableAt与valid区间不同。出手前互动默认不做；所有预测/结果可见性仍沿用已有未来信息保护。
6. 每个时刻主指标最多1、辅助标签最多1；只对本秒有效的记录显示。赛季卡须显式“某赛季/常规赛或季后赛”。
7. 球场投影只作用地面点；空中篮球/头部不按地面homography测距离。移动镜头需要分段动态标定与独立检查点，遮挡或失效时关层。
8. 首版姓名标签仅显示确认球员，且只在已核验时窗出现；未确认身份用“持球人”等描述，不猜核心球星。

## 11. 中文解说与真实MP4

先交付一个有质量的中文声音，再谈三种人设。风格是同一事实的措辞控制，不是三个互相矛盾的脚本。P0本地可用已有Tingting机制；AWS优先Polly Zhiyu，区域/engine可用性要探测。[Polly可用声音](https://docs.aws.amazon.com/polly/latest/dg/available-voices.html) MiniMax留作后续适配，需要许可、密钥、API与音质实测，本轮没有依据将其设为硬依赖。

每句单独合成、测真实音长；speechStart对应输出时间，不能用字符数平均分配。声音溢出则返回voice_overflow并定位句子，允许缩句或选择字幕版；不得任意截断半句。复用已有语音代码时保留其时间缩放限制，不声称它提供逐字强制对齐。P0原始解说声默认不混，字幕版可静音，语音版使用生成解说；UI明确音轨模式。

新导出包装先调用既有 reviewed StoryPlan静音导出，再对同一版本可选合成语音和混音，最终重新ffprobe、hash与清单验证。原静音film.mp4保持不可变，新配音release是另一个ID。推理缓存键含media/data/model/prompt/observation revision；渲染缓存键含已审计划、字体、图层、真实音频hash、voice配置与编码器版本。修改一句话、一个箭头、声音模式都产生对应新结果。

MP4验收：H.264、yuv420p、faststart、720p起步、实际时长与计划差≤1输出帧；字幕帧与网页一致；有配音则AAC音轨、无截断、无重叠、字句一致。完整播放与关键帧截图检查是必要项，文件存在或API 200不是成片成功。

## 12. AWS目标架构与安全配置

```text
CloudFront → 私有S3发布桶（页面、不可变成片）
          → API Gateway → Lambda（授权、输入验证、任务创建/查询）
                         → DynamoDB（版本/任务/发布指针）
                         → S3原件桶（媒体、帧、证据）
                         → Step Functions Standard
                            ├─ 指定Agent服务（候选AgentCore Runtime）→ Bedrock
                            ├─ 可选Polly
                            └─ Fargate（CPU FFmpeg/Canvas导出）
所有运行 → CloudWatch（脱敏日志、耗时、失败计数）
```

AgentCore Runtime优先候选原因是承载自定义工具loop及可用CloudFormation资源；不是因为已经确认赛方指定。[CloudFormation资源](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-runtime.html) AWS当前文档称Bedrock Agents Classic不再向新客户开放，不能把Classic作为必定可用兜底。[AWS说明](https://docs.aws.amazon.com/bedrock/latest/userguide/agents.html) AgentCore容器协议要求ARM64、8080、`/invocations`及健康接口，渲染容器架构单独指定，不共享错误的镜像假设。[Runtime协议](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html)

单一 `infra/` CDK app可含多个stack但一个入口部署。配置 `teamAccountId,allowedRegion,agentService,modelIds,contestConfigConfirmed`；`synth`可用明确标注的本地测试context生成全部候选资源与断言，`deploy`入口必须确认非占位账号/区域/服务且caller identity相符。**不应为了无账号synth成功就把Agent资源条件删除**：本地候选模板也应包含真实AgentCore资源定义；但formal-ready始终false直至正式部署证据齐全。用户未取得AWS环境，本轮能完成源码、模板、容器构建检查，不承诺云可用。

配置要求：

- S3全部BlockPublicAccess；CloudFront OAC只获发布桶读取；输入桶不配公共distribution。OAC不等于观看授权，媒体许可不允许公开时加signed URL/cookie或认证观看。
- API写操作Cognito JWT或赛方认证，读only已发布release可公开；不让匿名触发模型/导出费用。CORS只允许作品origin，上传短期签名、固定key前缀与大小约束，超大文件不穿过API Gateway body。
- IAM按API、Agent、渲染、部署分角色；Agent不能写发布指针，渲染只读当前job输入、写自己的output前缀。模型权限限定获准model/profile；跨区域inference需独立确认。
- Secrets Manager仅在实际用外部服务时创建；前端不带密钥；日志不带token、原始授权URL。素材与日志有保留期，评审结束前不自动删除成片。
- Fargate只出站无入站；网络设计必须满足ECR/S3/CloudWatch访问，明确选NAT或端点，不以“private subnet”误以为无需网络。
- 初始并发render=1、analyze=1；模型最大轮次/token/调用数、Step Functions超时与有限重试；每任务记录耗时和usage。预算告警不是硬费用上限，另需停止创建新任务的开关。
- 大模型输入与导入文件均不可信，文件路径、shell命令、S3前缀、URL只由服务端决定。JSON和媒体解码有大小/时间/输出限额。

不为了服务数量新增向量库、多Agent、长期记忆或独立数据库种类。服务应有实际工作与验证记录，不能声称服务多必然得满分。

## 13. 最小垂直路径与可量测验收

### M0：无云也能完整制作

选一段有使用权的短片→上传→真实探测与抽帧→人工添加2–3观察并确认→可选导入一份明确标合成的指标或完全无指标→模板生成故事→修改→人审→静音MP4→观赛/下载→重启后项目和成片仍可读取。整个流程不得要求先拿AWS账号，也不得冒称自动理解。

### M1：真正模型与CV链

有真实配置时，用与fixture不同的视频完成一次真实video/image模型任务，保留输入/响应hash与观察；无配置时明确503/block，并能切人工路径。CV执行器对真实配置程序真正运行，导入不算执行；fixture只验证协议。训练片到达后才能报告NBA能力。

### M2：单工程云与官方数据

CDK本地synth验证资源合同→指定账号真实deploy→指定Agent实际调用→CloudFront在新浏览器打开→官方素材/数据逐句逐镜复核。synth、模拟测试、模板diff都不代替云运行。

### 验收矩阵

| 检查 | 通过标准 |
|---|---|
| 上传与持久化 | 真实源片hash、真实duration；重启后同项目可读取；未授权媒体路径拒绝 |
| 无配置 | 自动分析按钮给准确缺项；无模型成功徽标；人工路径仍可到MP4 |
| 模型输入 | 测试捕获真正video/image content；记录当前media/frame hash；纯文本拒绝冒充视觉 |
| 时间 | 所有观察、绑定、字幕在合法范围；出手锚点最终由人工逐帧确认；不能把1FPS候选声称帧准 |
| 身份 | 发布中出现的姓名100%有当场名单/人工确认依据；报告原始自动身份正确/错误/未知分母 |
| 数值 | 62 percent与0.62 probability都显示62%；无单位拒绝；season值不得进入瞬时槽；错shot/game拒绝 |
| 因果 | 无证据“必然”“因为”句进入待审；人工签署只表示人工判断，不标模型科学验证 |
| 图形 | 坐标0–1、同镜头、有限时窗；每时刻≤1主指标＋1辅助；无效/遮挡/切镜自动隐藏 |
| 复核与竞争写 | 改一句即撤销人审；旧revision导出409；过时job不覆盖当前内容；重复请求去重 |
| 导出 | 实际解码MP4，独立于浏览器；计划/成片时长差≤1帧；关键画面与网页内容一致 |
| 配音 | 真音轨存在且完整；每句占窗实测；无超窗截断；字幕版明确silent |
| 故障 | 模型超时/CV失败/语音溢出不假成功，已有release可看；取消后无半成品发布 |
| UI | 桌面1440与手机390宽无横向溢出；上传→编辑→审核→导出→观看真实完成；所有可点击项有真实动作 |
| AWS | 实际资源、角色权限拒绝、Agent run、外部CloudFront播放及版本与repo一致；未部署状态明确 |

性能指标是待测目标：本地短片人工辅助闭环≤10分钟（不含首次人工内容理解）；关键帧请求≤10秒；一次模型阶段≤180秒；90分钟内得到考试可评版本，最后30分钟用于修订提交。必须记录机器/视频/模型/耗时，目标未达就报告实际值。两训练片48秒不能据此声明比赛级准确率。自动事件定位评估报告绝对时间误差中位数/最大值及人工修正数，不只报“通过率”；最终发布重要事件目标误差≤0.2秒，无法达成则收窄声明或使用帧确认。

## 14. 交给 GPT-6 Sol High 的三个互不冲突工作包

先由主代理把本规格的第7–9节冻结成 `contracts/broadcast-v1.json`；之后三个包可并行，接口变更由主代理统一裁决。全部保留旧Arena入口；不得为快速让测试绿而移除真实性标签或数值校验。

| 包/所有者 | 独占文件 | 必须交付 | 禁止触碰 |
|---|---|---|---|
| A 后端与成片 | `server.py`、`core/broadcast/**`、`contracts/**`、`tools/broadcast_*.mjs`、`tests/test-broadcast-backend*`；必要根依赖变更由A统一 | 完整API/任务/存储/媒体、真实Bedrock执行/能力探测、CV执行＋导入、编译旧StoryPlan、真实MP4、复核/缓存/旧版本保护 | `broadcast/**`、`infra/**`、`tools/build_site.py`；不直接修改旧pro内核，若必要提出最小补丁 |
| B 前端与静态打包 | `broadcast/**`、`tools/build_site.py`、`tests/test-broadcast-ui*` | 真正可操作的四步流程、能力失败/人工路径、播放/证据/编辑/审核/导出/观看；打包新入口且保留Arena | `server.py`、`core/**`、`contracts/**`、`infra/**`；不构造冒充后端的假成功结果 |
| C CDK与运行容器 | `infra/**`、`docs/Broadcast-AWS.md`、`tests/test-broadcast-infra*` | 单CDK工程、本地synth与断言、AgentCore候选资源/容器协议、渲染容器、权限/配置门禁、部署说明 | A/B文件；不部署未知账号，不写“云已就绪” |

集成顺序：A先交空项目/上传/GET/capabilities与静音导出；B可依合同开发但最终只对真实API验收；C用固定artifact入口包装业务，配置未到保持未部署。主代理最后检查全部实际按钮、运行一个无云人工路径、一个提供者失败路径、一个已审真实MP4，运行旧功能必要回归。无需重复跑与改动无关的所有历史测试来替代端到端证据。

**Sol High第一批明确退出条件**：新入口能加载；真实视频上传与重启持久化；手工观察→三段以内故事→审核→MP4；观看页与下载可用；真实模型和CV适配器未配时准确blocked；已配时确实发请求/执行；CDK synth可重复；旧Arena仍可运行。云部署、官方样片准确度、Portal提交保持待外部条件确认，不能在本地验收中勾选。

环境事实由主代理提供：bundled Node v24.19、Python带Pillow但当前无boto3/aws_cdk，FFmpeg/FFprobe位于`/opt/homebrew/bin`；docker CLI存在但daemon未验。这些应进能力探测结果，不得在模块import时令整个制作端因缺boto3崩溃。模型SDK作为按需可选依赖，未安装时明确不可用；CDK构建依赖与应用依赖分离。容器构建只在daemon实际可用时标通过。

已交叉阅读同目录`astra-independent-review.md`，采纳其8组反例作为集成验收补充。独立审查的“自动理解功能完成”与本文件M0“人工辅助闭环完成”是两个里程碑，最终报告必须分开列，不能用M0替代真实视频理解验收。本轮不重做PPT。

## 15. 本轮审核结论

现有作品的证据内核值得保留，缺口集中在真实视频观察入口、可用制作流程和视频优先呈现。附件提出的混合视觉方向可采用，但其权重、算力、官方逐事件数据和模型能力假设不能照单全收。最强可实现路线是先打通一条诚实、可复核、能真实出片的自动/人工共用生产线，再把获准且实测的模型和CV逐段接入。同一合同使自动化提高时不需要重写UI、审核和渲染，也使失败时仍可完成明确标注的人工辅助版本。
