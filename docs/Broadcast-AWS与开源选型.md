# AWS 优先与开源补位：执行边界

更新于 2026-09-30。用户最新授权：优先采用 AWS 现成服务，缺少对应能力时可使用合规开源软件。这里区分目标架构与已运行能力，AWS 账号未分配，云端尚未验收。

| 工作 | 首选 | 开源或外部补位 | 验收依据 |
|---|---|---|---|
| 视频整体理解、候选动作、解说草稿 | 账号获准的 Bedrock 多模态模型 | 本地 StepFun 适配器用于开发实测 | 保存真实请求模式、派生视频 hash、候选与定向画面；接口成功不代表识别准确 |
| Agent 工具执行 | 赛方指定 AWS Agent 服务；当前 CDK 实现 AgentCore 候选 | 本地同合同服务 | 实际云调用日志、区域、模型权限，不能只验模板 |
| 精确球员框、短时跟踪、颜色分组 | 有相应模型权限时在 SageMaker 托管推理 | RF-DETR / ByteTrack；资源不足可用明确标识的通用检测器 | 权重 hash、包版本、许可证、真实帧输出、误检漏检检查 |
| 视频标注与合成 | AWS 托管任务承载；现有 CDK 使用 Fargate CPU 渲染 | FFmpeg / Pillow | 实际 MP4、音画时序、源帧与几何有效窗、渲染器版本 |
| 配音 | 若音色和语言满足需求，采用赛方允许的 AWS 语音服务 | 可切换 StepFun / MiniMax；目前仅 StepFun 有真实接口实测 | 实测每句音长、窗口容纳情况、音轨存在；不可静默截断 |
| 上传、状态与发布 | S3、DynamoDB、Step Functions、CloudFront、Cognito、CloudWatch | 本地磁盘与任务用于开发 | 一套 CDK 工程、私有源媒体、CloudFront 成片入口 |

## 为什么不把通用云视觉当作篮球专项追踪

AWS 文档已注明 Rekognition People Pathing 于 **2025-10-31 停止支持**，因此新架构不以它作为人物路径服务。其余通用识别能力也不能未经实测就当成球衣号码、持球关系、掩护或 NBA 身份识别。[AWS 官方说明](https://docs.aws.amazon.com/rekognition/latest/dg/persons.html)

Nova v1 的短视频理解文档给出的采样为约 1 FPS。整体语义适合找候选片段，但一次出手的瞬间、遮挡和号码仍须用定向帧或专项检测复核。此限制只适用于所引版本，正式运行需按实际获准模型重新核对。[Nova 视频文档](https://docs.aws.amazon.com/nova/latest/userguide/modalities-video.html)

AWS 也有以 Nova/Agents 进行视频分析、结合 MediaConvert 与开源工具做后处理的公开案例。因此“托管基础设施 + 专项开源后处理”符合可落地的工程路线；案例不是本项目完成情况的证明。[AWS 视频分析案例](https://aws.amazon.com/blogs/machine-learning/accenture-scales-video-analysis-with-amazon-nova-and-amazon-bedrock-agents/)

## 开源准入与数据边界

分别检查代码、权重和输入视频的许可；代码开源不代表 NBA 片段可公开再分发。实际测试视频保存在被忽略的 workspace 中，仓库仅保存来源与方法记录。通用 COCO 人体检测器不能改称篮球专项模型；跟踪 ID 和颜色组不能直接改称球员姓名或球队。

官方 xFG / GRAV / LVG 始终独立于视觉估计。缺官方数据时仍可生成有事实依据的动作解说，但不填造指标；赛季统计和逐回合记录只能做有来源的背景与交叉佐证。

Fargate 不提供 GPU。GPU 视觉部署须在赛方允许服务与配额中另选，例如 SageMaker；不会为了“全用托管”把无法运行的模型塞进 Lambda 或 Fargate。[Fargate 任务限制](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html)
