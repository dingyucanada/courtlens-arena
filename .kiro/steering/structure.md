---
inclusion: always
---

# 目录与改动位置

- `core/broadcast/service.py`：项目、证据、故事、复核、任务、发布的单一业务服务。
- `core/broadcast/cloud_worker.py`：Fargate hydrate 后调用业务服务的有限任务入口。
- `broadcast/`：编辑台和匿名观众页；云登录使用 Cognito Hosted UI PKCE。
- `cloud/api/`：Cognito 保护 API、私有媒体签名、Job 提交/轮询。
- `cloud/render/`：CPU Fargate 媒体任务与受控发布；`cloud/agent/`：AgentCore 视频 proposal。
- `cloud/common/`：S3 快照 hydrate 与 DynamoDB revision CAS。
- `infra/`：单 CDK 工程、配置门禁、模板与安全测试。
- `docs/Broadcast-AWS部署.md`：部署条件、运行与验收；`docs/Kiro接续开发与部署.md`：接手入口。

开发时保持源码归属清楚：改业务语义去 `core/broadcast/`，改 AWS 适配去 `cloud/` 和 `infra/`，不要在网页内复制验证规则。
