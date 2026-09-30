---
inclusion: always
---

# 技术与验收

共享业务逻辑位于 `core/broadcast/`，网页位于 `broadcast/`，AWS CDK 位于 `infra/`，云适配器位于 `cloud/`。本地 API 与云 API 保持 `/api/broadcast/v1` 合同；云取帧/上传是异步 Job，成功结果经 `GET /jobs/{id}` 返回，短期私有 URL 不写入持久项目与 contentHash。

离线检查：根目录 `python3 tools/build_site.py --output site-dist`，再 `cd infra && npm ci && npm test && npm run synth`。`synth` 仅使用 fixture；正式 `validate`/`deploy` 须先核对比赛 Portal 的账号、区域、Agent 服务和模型。没有 AWS 真实运行证据时不称端到端通过。详见 `docs/Broadcast-AWS部署.md`。

赛前制作检查增加 `core/broadcast/{preflight,vision_readiness,clock_alignment,metric_intake,commentary_rehearsal}.py`。原始指标转换先只读预览、再通过既有 metrics 接口显式导入；不能接受零行或 blocked 结果。所有原始字段、字典和源行 hash 保留，不推导未知 availableAt。解说调速上限 1.15；超窗缩句而不截尾。详见 `docs/Broadcast-赛前模块与验收-20261001.md`。不要将模拟 AWS 单元测试写成已部署。
