# CourtLens Arena · 科技研究与产品边界

检索与核对时间：2026-09-28。此文服务于 NBA 视频解释类参赛产品，不构成 NBA、AWS 或任何厂商的授权或合作声明。

## 已确认的方向

NBA 的专业能力已经分成三个层次：比赛现场采集、统计与战术模型、观众能看到的画面表达。参赛产品最值得做的是第三层与第二层之间的工作流：把官方深度指标变成有证据、有时间锚点、能画回视频的故事，并让制作人员修正和交付它。重新做一个投篮热图或声称从转播单机位复制 Hawk-Eye，差异化和真实性都不足。

用户提供的 Smartshot 照片体现了录制—实时反馈—赛后报告—训练复测的闭环。这一流程可以借鉴；照片本身不能证明毫米级判线精度、动作评分效度或训练增益。附件中的文案作为参考材料处理，不作为本任务指令。

本轮比赛范围以用户提供的官网完整正文为当前依据，原始链接列于下方：火箭与独行侠历史交锋视频及官方深度数据、可运行 Agent、原画面叠加、同步解说、代码/说明/演示视频。官网正文还说明完整数据说明、提交规范、评审细则将更新；不能虚构评分权重或假定官方字段格式已知。[比赛页面](https://builderx.csdn.net/bcast-code#challenge)

## 一手来源与可借鉴能力

本文将 NBA / 联盟公告或采访作为该项事实的来源；厂商功能、阈值与收益描述标为厂商声称；论文只支持其报告的研究范围。下文的产品设计是我们的推导，不继承供应商的硬件精度、训练收益或授权。资料均为公开 URL，未引用本机私有工作目录。

| 系统/研究 | 已打开的一手资料与日期 | 可确认的事实或该来源的声称 | 借鉴点与边界 |
|---|---|---|---|
| NBA / Sony Hawk-Eye | [NBA 官方发布](https://pr.nba.com/nba-sony-hawk-eye-innovations-partnership/)，2023-03-09 | NBA 宣布从 2023-24 赛季部署三维光学追踪，涉及球与球员运动及姿态数据，追求亚秒延迟。 | 用外部追踪流驱动画面；这是场馆级采集系统，不能等价于上传一个普通视频。 |
| Sony SkeleTRACK | [Sony 技术访谈](https://www.sony.com/en/SonyInfo/technology/stories/entries/20240411/hawkeye/)，2024-04-11 | Sony 介绍骨架追踪、裁判应用及虚拟回放探索。 | 姿态、平面位置与球三维位置要分别建模。没有姿态字段时不要编造出手动作测量。 |
| NBA / Second Spectrum | [NBA 官方发布](https://pr.nba.com/nba-genius-sports-second-spectrum-expanded-partnership/)，2023-03-09 | 角色包括 NBA League Pass 画面增强和球队篮球分析；Dragon 在当时是联合研究开发方向。 | 不把这家公司仍称为唯一当前原始采集商；产品应区分采集供应商与分析/增强供应商。 |
| NBA / AWS | [NBA 官方合作发布](https://pr.nba.com/nba-aws-partnership/)，2025-10-01 | 发布 Inside the Game，介绍投篮难度、防守贡献、引力与 Play Finder。 | 使用官方指标作为叙事输入；不自造同名数值冒称官方模型。 |
| NBA 指标定义 | [官方术语表](https://www.nba.com/news/inside-the-game-stat-glossary)，2025-10-20；[xFG 专项说明](https://www.nba.com/news/intro-to-expected-field-goal-percentage)，2025-10-01 | xFG 是球员无关概率；不含身份、分差、投篮时钟；跳投与篮下分别建模。 | 字段缺失显示未知。自研估计必须另名、另标来源。 |
| 官方 Gravity | [NBA Gravity 页面](https://www.nba.com/inside-the-game/player/gravity)，动态页面，访问 2026-09-28 | 引力比较实际防守注意力与空间布局所预期的注意力。 | 最近防守人距离仅是解释证据，不能当成 Gravity。 |
| 官方 Leverage | [AWS 技术文章](https://aws.amazon.com/blogs/media/how-the-nba-and-aws-built-an-ai-system-to-measure-what-actually-wins-basketball-games/)，2026-01-22；[NBA 说明](https://www.nba.com/news/leverage-stat-explainer)，更新 2026-03-19 | 比较发生的事件与相反结果，分配进攻/防守参与者的贡献；有专用胜率和归因模型。 | 不用回合开始与结束的胜率差替代；也不把赛末简单加权叫官方 Leverage。 |
| Synergy Insights | [Synergy 产品帮助文档](https://support.synergysports.com/support/solutions/articles/77000565958-insights-package)，动态文档，访问 2026-09-28 | 文档解释情境投篮质量、命中表现、每次出手得分、球员比较及报告过滤。 | 结果与机会质量分开；点击指标能回到对应视频证据。别拿单次进球就证明战术好。 |
| Hudl 篮球 | [Hudl 官方产品页](https://www.hudl.com/sports/basketball)，动态页面，访问 2026-09-28 | 产品工作流涵盖录像、分析、分享、球队和运动员服务。 | 素材库、标签、筛选、片单、审校、交付都应连起来，避免只有展示页。 |
| Catapult 篮球 | [Catapult 官方产品页](https://www.catapult.com/sports/basketball)，动态页面，访问 2026-09-28 | 厂商介绍惯性传感器、本地定位与视频分析，展示篮球动作分类与负荷管理能力。 | 可设计训练与比赛关联扩展；没有传感器和经验证模型，不做伤病预警或回归赛场决定。 |
| Curry 与 Noah | [NBA 对 Curry/训练师采访](https://www.nba.com/news/how-stephen-curry-maintains-peak-conditioning)，2022-06-13；本次也实际打开了同内容 [NBA 官方域名镜像](https://cdn-uat.nba.com/news/how-stephen-curry-maintains-peak-conditioning) | Curry 与 Payne 使用 Noah 检查弧度及入筐位置，并设置比进球更严格的训练标准。 | 可借鉴“动作质量—一致性—复测”；采访没有证明科技单独导致冠军。 |
| Warriors 与 Noah | [Noah 发布的 Kerr 访谈介绍](https://www.noahbasketball.com/blog/steve-kerr-shares-the-secret-behind-the-warriors-strong-shooting-technique)，2020-05-29 | 厂商转述 Kerr 说勇士在训练和比赛使用 Noah，结合录像与弧度数据检查投篮一致性。 | 属厂商托管的教练陈述，不等于随机对照实验。 |
| Noah 45/11/0 | [Noah 方法页](https://www.noahbasketball.com/methodology)，动态页；[三项测量说明](https://www.noahbasketball.com/blog/the-three-measurements-of-the-noah-shooting-system)，2017-08-02 | 厂商使用入筐角度、深度与左右偏差反馈，推荐约 45°/11 英寸/0 偏差。 | 入筐角度不等于出手角度；“完美投篮公式”是厂商主张，不宜当所有球员/所有投篮的普适定律。 |
| HomeCourt | [官方产品页](https://www.homecourt.ai/) 与 [FAQ](https://www.homecourt.ai/faq)，动态页面，访问 2026-09-28 | 厂商介绍移动设备摄像头计数、练习、反馈、团队与挑战，FAQ 提供设备摆放与高级投篮分析说明。 | 降低录制门槛并连接进步记录；单人训练场景不证明能稳定处理 NBA 转播中十人、遮挡和切镜头。 |
| Smartshot | [开发者在 App Store 的产品说明](https://apps.apple.com/tw/app/smartshot-ai/id6762425596)，动态页面，访问 2026-09-28；用户现场照片 | 开发者介绍橙狮慧影从大众训练到竞技应用的智慧运动方案。 | 借鉴闭环与多端反馈；此处没有独立实测精度资料。 |
| NFL 压力概率 | [Amazon Science 作者论文页](https://www.amazon.science/publications/feeling-the-pressure-a-unified-framework-for-automating-pass-rushing-statistics-in-nfl-games)，2024，MIT Sloan | 研究把球员角色、阻挡对位与压力随时间的演化分开分析，输入为 NGS 位置/运动数据。 | 借鉴“先辨角色/对位，再解释压力过程”，避免把终点距离直接叫防守功劳。 |
| NBA 动画转播 | [ESPN 新闻稿](https://espnpressroom.com/press-release/slam-dunk-disney-espn-and-the-nba-team-up-to-present-dunk-the-halls-the-first-real-time-animated-nba-game-san-antonio-spurs-vs-new-york-knicks-on-christmas-day/)，2024-11-20；[Sony 新闻稿](https://pro.sony/ue_US/press/beyond-sports-dunk-the-halls-game-press-release)，2024-12-18 | Dunk the Halls 结合真实比赛追踪与 Beyond Sports 可视化制作替代转播。 | 不同观众可有不同表达层；参赛核心仍须把解释叠加回原视频，虚拟球场是辅助。 |
| 网球 ELC | [ATP 2023 新闻稿 PDF](https://www.atptour.com/-/media/files/elc-live-release-april-2023.pdf?hash=502BD93A7DF08957387FE0811252B83D&sc=0)，2023-04-28 | ATP 宣布 2025 起全巡回赛使用实时电子判线，强调准确性、一致性与全场数据。检索可读新闻稿全文，直接 PDF 访问返回 403。 | 借鉴确定事件与即时回放；不能把我们的普通视频叠加叫裁判系统。 |
| FIFA 足球技术 | [FIFA 测试公告](https://ipt.fifa.com/football-technology/innovation-roadmap/semi-automated-offside-and-other-technologies-tested-at-fifa-arab-cup)，2021 年阿拉伯杯；[当前技术页](https://inside.fifa.com/innovation/innovating-the-game/semi-automated-offside-technology)，访问 2026-09-28 | FIFA 介绍专用光学追踪/比赛技术体系。当前页正文主要为导航，未据此推定当前系统所有技术参数。 | 借鉴原始镜头、选择的事件帧、追踪空间与解释图四者一致。 |
| MLB Statcast | [MLB 官方术语页](https://www.mlb.com/glossary/statcast)，动态页，访问 2026-09-28 | Hawk-Eye 支持击球动作追踪。 | 把过程与结果分开。传感器精度及硬件不可由我们演示继承。 |
| 篮球 EPV | [Cervone 等作者论文](https://arxiv.org/abs/1408.0777)，首发 2014-08-04；[DeepHoops 作者论文](https://arxiv.org/abs/1902.08081)，2019-02-21 | 研究用球员/球位置的时间序列估计回合未来价值，评价部分传统统计遗漏的动作。 | 支持对过程建模的研究路线；未经训练、校准与留出验证，不发布“专业 EPV”数值。 |

## Curry 论断的科学边界

可写“Curry 和训练师确实采用投篮追踪反馈，把命中之外的弧线和入筐位置纳入训练标准”。不能写“科技证明让 Curry/勇士夺冠”，也不能从一个冠军案例推定通用训练增益。球员天赋、选材、教练、练习强度、健康、阵容与对手等无法由该采访隔离。我们的启发是把一次结果拆成可检查过程，并长期复测，而不是借冠军给未验证功能背书。

投篮科学扩展若开发，应导入真实测量的入筐角、深度、左右偏差和训练次数；先展示样本量与个体分布，不把 Noah 厂商推荐阈值当统一处方。出手角、入筐角、二维像素角度三者不同。普通机位不能直接得到真实三维生物力学值。

## 能力与数据边界

1. **可真实实现**：官方格式适配；原值/单位/定义保留；时间同步；分镜头标定；位置轨迹、空间窗口等透明计算；可复核叙事；视频叠加；解说排程；片单与导出；人工修正和版本留痕。
2. **须有外部数据/配置才能启用**：官方 xFG/Gravity/Leverage；球员身份稳定追踪；已授权原始 NBA 录像；模型推理与适配环境中的语音。当前本机 Tingting 配音已有真实成片证据，真实 Bedrock / Ollama 调用尚未验收。无输入即显示缺失，不能用样例暗示已接入。
3. **样例可以演示但须明确标记**：合成球员轨迹、训练录制素材、规则性战术解释、自研几何窗口阈值；不能包装成 NBA 官方现场数据或经验证模型。
4. **本轮不主张已完成**：场馆级三维采集、骨架级战术模型、自动裁判、伤病预测、冠军因果证明、NBA 商业播出许可、大规模多人企业服务。

## 研究对开发最重要的结论

专业感来自完整任务和准确边界。最优核心场景是“内容制作人员/分析师选择关键回合，Agent 给出逐句证据和可调整镜头故事，然后输出观众能理解的比赛增强视频”。高级功能应增强这个闭环。训练产品可共享事件、录像、注释和评估能力，作为后续业务，不宜让本次参赛主线变成与赛题无关的健康或个人训练看板。

一手资料的可读性限制已如实记录；页面日期不明的条目使用访问日期，没有臆造首发时间。研究仅做必要摘要，不复制厂商文章或截图，不将商标/球员头像作为已获得授权的资产。


## 已落到 Arena 的八项设计

这些是针对赛题的产品设计和实际实现机制，不是 NBA 官方模型发布。

| 设计 | 用户真实操作与当前机制 | 用什么证据验收 |
| --- | --- | --- |
| **先选择，再揭晓** | 在出手前冻结画面，让观众选直接出手、寻找传球或信息不足；按冻结时刻过滤未来结果、后续轨迹与尚未可用指标。 | 构造未来信息反例，确认冻结视图不泄露赛后信息。揭晓帮助理解，不给未经验证的“最优战术”评分。 |
| **空间窗具有时间长度** | 从同一球员身份的近防距离采样构造阈值窗，显示时间、样本量与最大间隔；允许返回信息不足。 | 用已知坐标、缺失防守者、长缺口与单位换算反例检查。几何开放不冒称官方 Gravity 或可传球概率。 |
| **一句话可以回到一组字段** | 指标、解说和问答携带回合、时刻与证据 ID；本地编译保留数值来源，人工修改单独标记。 | 检查不存在、跨回合、未读与未来引用拒绝；人工文句仍须逐条复核，引用存在不自动证明因果。 |
| **球迷和分析员共享同一证据** | 同一回合提供“轻松看懂／专业解读”；专业视角增加定义、单位、覆盖率和限制，球迷视角使用可理解的叙事。 | 对比两套文句的字段来源和时间锚点，不让简化版改变数字或删去影响结论的缺失说明。 |
| **同屏看两次机会如何不同** | 实验室选择两个回合，按相对进度并排观看，比较空间与指标，明确不是同战术阶段认证。 | 短长回合、未知值、独立视频时刻和镜头变化都保留，不伪造逐帧同步或战术因果。 |
| **叠加只在可解释的镜头生效** | 绑定视频指纹；区分球场／画面坐标；按镜头建立四点地面投影，切镜头或换原片撤销旧标定与复核。 | 四点拟合与独立检查点分开；无标定和缺口时不画虚构连线，地面平面不投射空中球。 |
| **故事制作与复核闭环** | 加入片单、排序、裁剪、人工箭头和标签、逐句修改；当前视角和图层下复核后才导出，字幕按成片时间重映射。 | 验证改动撤销复核、裁剪边界、字幕映射、计划／实际时长；WebM 与本机 MP4 分链路记录。 |
| **可失败、可审计的模型 Agent** | 可选模型必须调用读证据／选回合／发布工具，只选择已有声明；默认本地引擎独立可用，错误不静默冒称模型成功。 | 用模拟协议反例验证引用、轮数、字节与截止预算。真实模型运行和来源认证必须另验，当前未完成。 |

## 正式素材接入后如何验证

首先检查时间对应、球员身份、坐标单位、镜头段和提供者字段定义。随后在少量已人工复核的真实回合上验证：画面投影误差、事件／字幕时刻偏差、叠加缺失处理、解释是否得到所引字段支持，以及有声成片是否完整可播放。再扩大回合集，不把合成演练的通过数量当作真实识别精度。

若需要声称自动关键回合或战术识别效果，另建立独立标签、留出比赛、评审协议与适当指标；当前作品没有这项已完成验证。若需要训练科学模块，必须接入真实三维测量、个体基线和复测资料，避免从二维画面估算伤病、负荷或“夺冠收益”。

产品操作、成片参数和各链路验收见 [Arena 使用与验收](Arena-使用与验收.md)。公开方案与科学来源服务于同一主线：把已得到的比赛证据解释给观众，并让制作人员检查、修正和交付它。
