# CourtLens Broadcast AWS 部署与验收

本工程的云入口位于 `infra/`，业务逻辑仍由 `core.broadcast.service.BroadcastService` 执行。当前只完成**离线合成与本地合同检查**；尚无比赛分配的 AWS 账号、允许区域、模型及 Agent 服务确认，也没有在真实 AWS 上部署或实测 Fargate、AgentCore、CloudFront 登录。`npm run synth` 使用不可部署的假账号，只证明 CDK 能生成模板。

## 架构和数据边界

- CloudFront 通过 OAC 读取两个始终私有的 S3 桶之一的站点文件与已发布影片；编辑 API 走同域 `/api/broadcast/v1`，由 Cognito User Pool 验证浏览器取得的 ID token。浏览器没有长期 AWS 密钥。
- 上传走 10 分钟预签名 PUT，最长 256 MiB。完成 PUT 后调用 `/projects/{id}/media/commit`，Fargate 校验长度、SHA-256、ffprobe 元数据，再更新项目。收到上传 URL 或 PUT 成功均不代表媒体可用。
- 项目快照保存在私有输入桶，DynamoDB 存当前 revision 与快照指针。API 编辑和异步任务只用条件写推进指针；过时任务无法覆盖新 revision。S3 上可能保留失败任务产生的私有孤儿对象，需按运行记录清理。
- `/projects/{id}/frames` 在云端返回 202 Job；Fargate hydrate 已校验的源片，调用同一个 `BroadcastService.frames` 提取真实 PTS 帧，私存帧 PNG 并 CAS 更新快照。`GET /jobs/{id}` 成功后返回 `result.frames`，其中 `url` 每次响应重新签发、有效 10 分钟。本地 API 保持同步 200。最多 16 帧/次，时间在源片前 180 秒内。
- analyze/probe 任务在 Fargate 中调用部署的 AgentCore runtime。AgentCore 读取已校验的私有源片，向配置的 Bedrock 模型请求最多三个事件窗的 proposal；任务把原始提案与调用哈希写入固定文件，后端再逐窗抽取源片真实帧并保存为未审观察。云端 `mode=model` 的故事请求也返回 202 Job，由同一 Fargate/AgentCore 路径完成；输入只包含已接受观察和已确认绑定，不再次自由猜测视频。后端校验最多三条故事、时间、证据 ID 与指标占位符，随后仍要求人工逐句复核。`mode=template` 维持同步 200。render 由 CPU Fargate 运行 FFmpeg；未使用 GPU。
- 影片先经过项目 CAS，再写入私有发布桶，`film.mp4` 最后上传。只有写入发布索引的 Release 会出现在编辑 API；匿名观众通过 `/releases/{id}/summary.json`、`manifest.json`、`film.mp4`、`captions.vtt` 观看。云匿名页不提供原片切换；源片及帧只给已登录编辑者的短期签名地址。公开影片的传播权由操作方确认。

## 本地预备

需要 Node.js 24、npm、Python 3.12、Docker daemon、AWS CLI，以及有权在目标账号创建 CDK bootstrap 和本栈资源的凭证。工程不依赖 Codex 专属命令。先在仓库根目录构建站点，然后在 `infra` 安装锁定依赖：

```sh
python3 tools/build_site.py --output site-dist
cd infra
npm ci
npm test
npm run synth
```

`npm run synth` 固定读取 `config.fixture.json`，生成 `infra/cdk.out`；`config.fixture.json` 中的账号、区域和模型只是测试数据。该命令不访问 AWS，也不会构建 Docker 镜像。要单独检查语法可运行 `npx tsc --noEmit` 与 `PYTHONPYCACHEPREFIX=/tmp/courtlens-pycache python3 -m compileall -q ../cloud`。API 使用含 Python 3.12 和固定 Node 24.11.1 的 Lambda 容器，保证同步指标验证器随镜像打包；renderer 与 AgentCore 也需 Docker 构建。

本轮容器构建记录：`docker info --format '{{.ServerVersion}}'` 返回 `28.5.1`，但 `docker build --platform linux/amd64 -f cloud/api/Dockerfile -t courtlens-api-local .` 在拉取 `node:24.11.1-bookworm-slim` / `python:3.12.12-slim-bookworm` 时失败，Docker daemon 报 `auth.docker.io/token ... i/o timeout`。另试 `docker pull public.ecr.aws/docker/library/node:24.11.1-bookworm-slim`，镜像层下载报 `cloudfront.net ... TLS handshake timeout`。因此 API、renderer、AgentCore 三个镜像均**未构建验证**，真实部署前须在可联网环境完成镜像构建和容器启动测试；CDK synth 不能代替这一步。

## 正式配置与部署

从 `infra/config.example.json` 复制为 `infra/deploy.json`，按比赛 Portal 原文核定以下值：团队 AWS 账号 ID、允许 Region、指定的 Agent 服务是否确为 Bedrock AgentCore、准确的模型 ID 与可调用资源 ARN、Portal 证据引用。填入 `operatorEmail`、已构建的 `siteAssetDirectory`，并在核对后将 `contestConfigConfirmed` 设为 `true`。如果 Portal 指定的 Agent 服务不是 AgentCore，应先改架构和工程；当前部署入口会拒绝继续。不要把真实账号、模型或密钥写回 fixture。`deploy.json` 已由 `infra/.gitignore` 忽略。

语音默认不配置，`voiceProviders: []` 时云端只提供静音字幕版。若获批使用 MiniMax、StepFun 或两者，可在正式配置中加入以下结构；这些字符串均为**格式示意，不是已确认的模型、音色或可用密钥**：

```json
"voiceProviders": [
  {"provider":"minimax","modelId":"<核定模型ID>","voiceId":"<核定音色ID>","secretArn":"arn:aws:secretsmanager:<允许Region>:<团队账号>:secret:<名称>-<六位后缀>","minimaxRegion":"global"},
  {"provider":"stepfun","modelId":"<核定模型ID>","voiceId":"<核定音色ID>","secretArn":"arn:aws:secretsmanager:<允许Region>:<团队账号>:secret:<名称>-<六位后缀>","stepfunApiVariant":"step-plan"}
]
```

每个 Secrets Manager Secret 的**完整 ARN**须位于同一账号与 Region，SecretString 直接存该供应商 API key（非 JSON）。CDK 只把 secret 注入 Fargate 容器环境变量，并将读取权限授予任务执行角色；API 只知道哪些 provider 已配置，不能读密钥。能力响应对已配置项给出 `available=true, verified=false`，代表可以排队尝试但尚未真实验证供应商、模型及音色。未经真实供应商测试时不承诺配音可用，也不在配置、站点或日志中写明文 key。云端 `local-tts` 与未配置的供应商请求会拒绝。

StepFun `stepfunApiVariant` 只允许 `openapi`（默认固定 `https://api.stepfun.com/v1/audio/speech`）和 `step-plan`（固定 `https://api.stepfun.com/step_plan/v1/audio/speech`）；未知值会在部署配置或服务端调用前拒绝，不接受任意 base URL、重定向或浏览器提供的地址。本地最小 probe 已对 step-plan 的 `stepaudio-2.5-tts` / `elegantgentle-female` 收到 HTTP 200、有效 MP3（24 kHz、2.736 秒）；这只验证供应商接口，云端 Fargate 配音与最终成片仍待实测。

```sh
cd infra
AWS_PROFILE=<团队配置的profile> npm run validate
AWS_PROFILE=<团队配置的profile> npm run deploy
```

`validate` 使用正式配置作本地模板合成；`deploy` 先用 AWS STS 核对实际凭证账号与 `teamAccountId`，再执行 CDK bootstrap 和全栈部署。账户尚未分配时不要执行 deploy。脚本会拒绝 fixture、占位值、未经确认的 Portal 配置和冲突 Region。部署入口自动写非密钥的 `/cloud-config.json`，包含 `apiBase`、Cognito Hosted UI 域名、client ID、回调 URL。CloudFront 的 `/broadcast/` 目录索引由 viewer function 改写为 `/broadcast/index.html`。

部署后还需要在 Cognito User Pool 为编辑者创建/邀请用户；工程只创建私有注册池，不自动发送邀请。CloudFormation 输出包含观赛 URL、Pool ID、Client ID、桶名和 Agent Runtime ARN。站点登录使用 Hosted UI 授权码加 PKCE，回调为 CloudFront `/broadcast/`。实际模型访问权限、AgentCore 容器启动与网络、ECR 拉取、Fargate FFmpeg 字体、Cognito 回调和 S3 预签名 CORS 必须在真实账号验收，模板合成不证明这些行为。

## 云端验收顺序

1. 检查 CloudFormation 与两个 S3 桶的 public access block、OAC、DynamoDB PITR、CloudWatch 告警；确认 CloudFront 可打开 `/broadcast/` 且编辑页跳转 Cognito 登录。
2. 用有权使用的短片走签名上传、commit Job；验证真实长度、SHA-256、ffprobe 数据和 revision。测试错误哈希/过期 revision 拒绝。
3. 请求帧，轮询 Job 到 succeeded，核对 `result.frames` 的真实 PTS、SHA-256 与可显示的短期私有 URL；过期后重新 GET Job 刷新 URL。
4. 对同一片走 analyze → 定向取证与数据绑定 → 异步辅助拟稿或同步证据模板 → 人工复核 → render。检查 AgentCore 请求和结果哈希、证据指纹、FFmpeg 成片与字幕。
5. 用匿名窗口打开观众页，确认仅已发布影片可访问，源片、项目快照和帧不能匿名读取；并发改动、取消和 CAS 冲突不得公开过时成片。

目前 `cv` 仍会返回 503，因为无确定的云 CV 权重/执行器；这不影响视频语义主链。CloudWatch `WorkflowFailures` 告警阈值为一次失败，任务和状态机最长约 18/20 分钟。运维暂停新任务可在 DynamoDB 放置 `pk=SYSTEM, sk=CONTROL#jobs, paused=true`；恢复时清除此标志。已运行任务不受该开关中断。部署后的资源会产生费用，尤其 Fargate、AgentCore/Bedrock、CloudFront 和 S3；不用时按实际资源清理，私有桶与表默认 RETAIN，避免误删作品数据。
