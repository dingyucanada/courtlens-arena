# Kiro 接续开发与部署

Kiro 可直接打开本仓库继续开发。业务核心在 `core/broadcast/`，编辑和观众网页在 `broadcast/`，AWS CDK 在 `infra/`，云适配器与任务容器在 `cloud/`；无需把工程迁移到 Kiro 专属格式。项目级 `.kiro/steering/{product,tech,structure}.md` 已按 [Kiro 官方 steering 文档](https://kiro.dev/docs/steering/) 放在仓库内，也可沿用仓库的 `AGENTS.md`。项目级指导不能替代比赛 Portal 的实际规则。

交接时先读 `docs/Broadcast-技术解决方案-vNext.md`（第13A节为审核后的冻结裁决）与 `docs/Broadcast-技术方案独立审核.md`，再读 `docs/Broadcast-真实NBA验证.md`、`docs/Broadcast-CV-实测.md`、`docs/Broadcast-AWS与开源选型.md`，再读 `docs/Broadcast-架构设计.md`、`docs/Broadcast-研究与事实核验.md`、`docs/Broadcast-设计裁决.md`、`docs/Broadcast使用指南.md` 和 `docs/Broadcast-AWS部署.md`。主链是源片语义 proposal、定向取证、严格数据绑定、最多三条故事、人工复核、MP4 与 CloudFront 观赛；不能把模型文字或演示数据称作已核实事实。`core.broadcast.service.BroadcastService` 是本地与云端共享的业务逻辑。云端任务入口是 `python -m core.broadcast.cloud_worker --request <json> --workspace <dir>`，由 `cloud/render/runner.py` 管理 S3 hydrate、CAS、AgentCore 调用和发布。

普通命令：仓库根目录运行 `python3 tools/build_site.py --mode cloud --output dist`；`cd infra && npm ci && npm test && npm run synth`。正式配置填 `infra/deploy.json` 后可运行 `npm run validate`；账号、Region、Agent 服务和模型获 Portal 确认且 AWS 凭证匹配时才运行 `npm run deploy`。`synth` 使用不可部署 fixture，不能当作 AWS 验收。Docker daemon、Fargate、AgentCore、Cognito 和 CloudFront 的端到端验证仍待比赛账号。当前 `cv` 云执行器尚未配置，视频语义主链使用 AgentCore 候选实现。StepFun step-plan 已完成本地实际配音成片和 NBA 视频请求，但云配音尚未实测；MiniMax 未实测。不要把本地密钥写入配置或仓库。

继续工作时优先处理真实 AWS 验收、失败恢复与权限收紧：核对 Portal 规则；运行三个容器构建及启动；创建 Cognito 编辑用户；用获授权的真实短片验证上传、帧、AgentCore 视频提案/故事拟稿、渲染和匿名观众；记录实际耗时、费用、日志及失败注入。本机 Docker daemon 已能连接，但本轮 Docker Hub/ECR 公共镜像层下载超时，镜像构建未通过，须在可联网环境重试。若 Portal 不允许 AgentCore 或当前模型，应先修订 CDK 和调用路径，再部署。任何部署成功的宣称都需要真实 Stack 输出与运行证据，不能从 `cdk synth` 推断。
