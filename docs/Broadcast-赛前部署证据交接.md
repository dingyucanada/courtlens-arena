# CourtLens Broadcast｜赛前部署证据交接

2026-10-01。本工具补足「制作检查」与「比赛云交付」之间的证据登记，**不执行 AWS 请求、不部署、不修改仓库可见性、不读取凭证，也不认证比赛正式云资格**。赛事规则来源仍为用户提供培训纪要；指定区域、Agent 服务、模型及官方字段等待 Portal 原文。

## 已有工程与新接口

现有 `core/broadcast/preflight.py` 和 `tools/preflight_broadcast.py` 检查已保存项目、源帧、审核、解说与语音时窗，其中云门槛保持 unknown。现有 `infra/lib/config.ts` 负责 CDK 部署配置门槛，`infra/config.fixture.json` 是不可部署演练配置。新增检查不替换这两者。

- `core.broadcast.contest_delivery.inspect_delivery(config, packet, evidence_root, expected_version=...)`：返回机器可读 `courtlens-contest-delivery-report/1`。
- `tools/preflight_contest_delivery.py`：读取明确指定的非密钥 JSON，校验附件并只创建一个新报告。已有报告拒绝覆盖。
- `tests/test_contest_delivery.py`：覆盖旧 commit/构建号、错账号/区域、错误仓库绑定、public 仓库、错模型模态、synth 冒充部署、附件篡改/符号链接/越界路径和 URL 仿冒。

`checks[].status` 的 pass **只表示附件哈希、记录字段与预期配置/版本一致**，不是工具向 GitHub/AWS/Portal 查询后的远端认证。附件内容本身由操作方提供，工具不验证截图真假，也不能代替实际 CloudFront 播放。即使所有检查 pass，报告仍固定 `formalQualificationCertified=false`、`cloudRuntimeIndependentlyVerified=false`，且 `handoff.requiresIndependentOnlineAcceptance=true`；不产生比分或通过率。

## 运行

在仓库根目录执行：

```sh
python3 tools/preflight_contest_delivery.py \
  --config infra/config.example.json \
  --packet infra/contest-delivery.example.json \
  --git-commit 15b14aa5217ed15031e872ae9401bfd7b93607a6 \
  --build-id preseason-uncommitted-20261001 \
  --output workspace/preseason-20261001/contest-delivery-report-new.json
```

上面的 commit 是本次检查时读取的 HEAD，build ID 明确表示赛前未提交工作目录，**不表示新开发已经属于该 commit 或已经部署**。正式交接必须换成实际冻结提交和构建 ID；该工具按操作方显式给定的目标比较，不读取 Git 工作目录、不判断某 build 是否真正从 commit 构建。部署/浏览/调用证据必须采用相同冻结版本。当前 example 配置有占位符，所有云验收应保持 unknown。

报告是可交给 Kiro 或其他获准开发环境的普通 JSON：`handoff.tasks[]` 逐项给出 gate、状态、下一动作。未确认 Kiro 为比赛硬性要求，不调用任何自动部署或任务发消息接口。

## 输入和证据合同

packet 顶层是 `schema: "courtlens-contest-delivery-input/1"`、`repositoryUrl`、`facts`。仓库 URL 必须是规范 HTTPS GitHub 地址，例 `https://github.com/TEAM/REPO`；不要保存带 token 的 URL。每项可以保持 `{"status":"unknown"}`，不同事项不会相互推导。不要将 GitHub `package.json` 的 private 字段当作真实仓库权限。

每项 observed/failed 记录必须携带：

```json
{
  "status": "observed",
  "kind": "github-repository",
  "version": {"gitCommit": "完整40位commit", "buildId": "实际构建ID"},
  "repositoryUrl": "https://github.com/TEAM/REPO",
  "visibility": "private",
  "evidence": {
    "artifact": "evidence/repository.json",
    "sha256": "实际附件64位SHA256",
    "capturedAt": "2026-10-10T19:00:00+08:00"
  }
}
```

此例是格式说明，占位 SHA 不会通过。附件相对 packet 所在目录，须为现存常规文件，最大16 MiB；绝对路径、`..`、符号链接、错 SHA 和无时区时间戳拒绝。附件只保留脱敏的输出、页面或运行记录，不能含 AWS 凭证、供应商 key、Authorization、Cookie、预签名 token 或原始敏感日志。

| facts 键 | kind | 附加记录字段 |
|---|---|---|
| `portal-requirements` | `portal-requirements` | accountId、region、agentService、modelId 与正式配置完全匹配 |
| `private-repository` | `github-repository` | repositoryUrl 匹配顶层、visibility 为 private |
| `portal-binding` | `portal-binding` | repositoryUrl 匹配顶层、bound 为 true |
| `aws-account` | `aws-caller-identity` | accountId 与正式配置匹配 |
| `aws-region` | `aws-deployment-region` | accountId、region 与正式配置匹配 |
| `cdk-deployment` | `cdk-deployment` | accountId、region、tool 为 aws-cdk、stackStatus 为 CREATE_COMPLETE/UPDATE_COMPLETE、runtimeDeployment 为 true |
| `cloudfront` | `cloudfront-browser` | accountId、region、url、distributionId、browserOpened/filmPlayed 为 true |
| `agent-service` | `agent-runtime` | accountId、region、agentService、runtimeArn、invocationSucceeded 为 true |
| `model-authorization` | `model-invocation` | accountId、region、精确 modelId 与 modelResourceArn、invocationSucceeded 为 true、successfulInputModalities 为实际成功的 text/image/video 列表 |

CloudFront URL 限制为原生 `https://<主机名>.cloudfront.net/...`，仅允许默认或443端口；拒绝 IP、ALB、HTTP、尾缀仿冒、用户信息、query 和 fragment。当前 CDK 候选只实现 `bedrock-agentcore`，如果 Portal 指定其他 Agent 服务，配置合同会失败，须先调整实现。模型 ID、资源 ARN 必须来自 Portal 确认；成功 text 调用仅证明该次文本调用的记录，不赋予视频能力；未记录模态、未知模态或仅转写「千问235B」不能推断视频输入。

## 拿到模拟/正式环境后的执行顺序

1. 保存 Portal 原文，填写正式部署 JSON；核对 private 仓库和 Portal 实际绑定。
2. 在获准账号确认真实调用身份、区域、精确模型及模态、Agent 服务，记录各项，禁止复制 fixture 的假账号和区域。
3. 完成 CDK、三种容器构建/启动及真实部署；记录部署结果，未完成项继续 unknown/failed。
4. 按 `Broadcast-AWS部署.md` 的云端顺序走真实上传、抽帧、分析、审核、成片、匿名观影；记录 Agent 与模型调用成功及当前版本。
5. 冻结实际提交与构建 ID，重新生成制作报告及本交付报告；在新浏览器实际核验最终 CloudFront 页面、影片和 Portal 提交地址。

部署报告不能覆盖影片质量审核，制作报告不能替代云验收；官方素材、名单和逐事件指标依旧单独核验。18:00 发考试片后应以此前演练通过的同一流程换入考试素材，20:00 前持续提交，最后30分钟留给版本和正式提交核对。
