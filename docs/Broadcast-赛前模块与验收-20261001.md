# CourtLens Broadcast：赛前模块与验收

2026-10-01。依据用户提供的官方培训原文与 [技术方案](Broadcast-技术解决方案-vNext.md)。官网本轮抓取失败，未声称在线核实了更新后的规则。

目标是把普通比赛视频与官方深度数据变成带标注、解说和字幕的真实影片，同时提供可复核的互动网页。训练视频两段合计约 48 秒，考试一段；18:00 发放考试素材，20:00 硬截止。评分按培训纪要为机器 35、人工 55、知识问答 4、投篮 6；部署完整不等于保证机器满分。

## 当前交付边界

本轮完成赛前本地制作模块。最终赛事验收尚缺官方素材/字段、比赛 AWS 账户及 Portal。不可用 GitHub Pages 或 CDK synth 替代 CloudFront、真实 Agent 调用和私有仓库绑定。用户授权仓库赛前暂时公开，提交前恢复私有。

| 优先级 | 模块 | 当前实现 | 验收依据 / 尚缺内容 |
|---|---|---|---|
| P0 | 素材输入、真实 PTS、抽帧 | 已有上传/标准化/媒体检查；新增帧目录恢复及 PNG hash 核验 | 真实片段与 FFmpeg 回归；损坏/过期/软链接源帧不进入复核 |
| P0 | 视频模型候选 | 修正 StepFun 逐候选隔离、原始响应私有审计、全部拒绝进入 needs_review | mock 与任务取消/旧版本测试；本轮未发新外部识别请求，不能宣称真实识别准确率提升 |
| P0 | 视觉与身份复核 | 执行证据、镜头轨迹、单帧动作、队服映射、多帧号码、当场名单日期共同检查 | 新 26 项诊断测试；号码不可读/混框/日期冲突保持未知。现有 RF-DETR 不自动识别人名 |
| P0 | 原始官方指标准备 | CSV/JSON 检视、显式字段/单位/粒度映射、逐行拒绝、预览、显式导入 | 19 项转换与 10 项接口检查；官方真实字典/数据仍未知，演练值只用 synthetic |
| P1 | 比赛时钟对齐 | 两个源帧锚点、同镜头内插值、停钟/跨段/外推拒绝 | 8 项时钟反例；人工读数与镜头连续性待逐片核对，不宣称逐帧精度 |
| P1 | 专业知识库 | 复用已有 10 类动作与具名战术最终验证；新增三语篮球术语/发音提示 | 必要线索与反例检索；定义不能证明本回合真的执行；姓名发音无证据时警告 |
| P1 | 解说节奏 | 逐句时窗、文字估时、同版本音频实测、1.15 倍硬上限 | 16 项新节奏测试及语音合同；实际音频测时与文字估时严格区分 |
| P1 | 制作台 | 源片、事件/解说轨、当前事件源帧、循环回看、前后取证、节奏与交付页 | 真实 48 秒浏览器检查；切换保留视频 DOM 与时间；390px 无横向溢出 |
| P1 | 成片输出 | 复用审核→FFmpeg→MP4/VTT/Manifest；本轮重新运行离线配音影片 | H.264/AAC、48 秒、同稿音轨检查；不上传真实源片到公开 Pages |
| P2 | 可复现赛前检查 | 只读 CLI、导出报告、项目/媒体 hash、明确未知项 | 12 项检查；不自动探测模型或发送素材，不覆写项目/既有报告 |
| P2 | CDK/云接口与 Kiro | 新接口沿用 owner/revision 边界；打包新前端与发音字典 | 离线测试；镜像实际构建、账户权限、CloudFront/Agent 调用未验收 |
| 延后 | 三语自然声音、全自动 OCR、近实时理解 | 已有语言/风格/提供者接口；SAM2 为短窗增强实验 | 需要真实模型和音频测试、母语试听、标注集、AWS 权限；不以配置存在标记完成 |

## 真实使用路径

1. 启动完整应用，打开已有 48 秒测试项目或导入新片。在“素材”核对比赛日期、当场名单与视频信息。
2. 在“分析”选择已配置的画面理解，或导入实际视觉 worker 结果。候选逐条打开，回看片段、看引用帧、核对人名/动作/结果。未知姓名不补猜。
3. 必要时提取动作前后画面。“其他已保存画面”折叠收纳，避免几十行勾选框淹没影片。
4. “官方数据映射与外部视觉结果”提供原始 CSV/JSON 转换。先查看列，上传提供者字典，再选择字段。比赛倒计时需先建立源帧锚点；发生时间与可用时间独立处理。
5. 查看转换预览，检查排除行与空值，再明确确认导入。导入撤销旧绑定、旧稿和审核。确认对应事件后，只有适用且有值的数据可用于该故事时窗。
6. 编辑至多三个关键解说节点，在“解说节奏”看窗口和音频情况；缩短超窗句子，再审核并导出影片。
7. “提交检查”下载当前报告。AWS/Portal 项未验证时显示未知，不能称最终参赛成品可提交。

这些操作均不会因为播放、回看或打开检查页而重新请求模型。需执行模型/语音时才显式提交对应任务。

## 模块接口

所有接口共用 `/api/broadcast/v1`；云端认证、项目 owner 与 revision 约束保留。

| 接口 | 用途 | 是否更改项目 |
|---|---|---|
| `GET /projects/{id}/preflight` | 已保存源帧、理解复核、节奏与交付检查 | 否；云帧 URL 短期签名，不持久化到内容 hash |
| `POST /projects/{id}/clock/preview` | 两锚点比赛时钟映射 | 否；提供 expectedRevision/request |
| `POST /projects/{id}/metrics/source` | 读取 CSV/JSON 原始列 | 否；提供 expectedRevision/format/text |
| `POST /projects/{id}/metrics/preview` | 显式字段与字典转换预览 | 否；提供 expectedRevision/request |
| `POST /projects/{id}/metrics` | 确认接受的合法指标包 | 是；保持既有接口，撤销旧稿/绑定/审核 |

转换包保存 `intakeAudit`（原始 hash、字典 hash、映射、时间基准、粒度和时钟配置）及每记录原始行，保留在私有项目中。公开成片 Manifest 只按白名单发布故事引用的指标，不带未映射列、完整原始行或未使用记录。这里只认证合同一致性，不认证数据文件确由主办方发放。

## 不依赖 AWS 的复现

在仓库根目录使用已安装且包含 requirements 的 Python 环境：

```sh
python3 tools/launch.py --port 8774 --workspace workspace
python3 tools/preflight_broadcast.py --workspace workspace --project PROJECT_ID --output workspace/preflight-report.json
python3 tools/rehearse_broadcast.py PROJECT_JSON --manifest MANIFEST_JSON --output workspace/voice-report.json
python3 tools/prepare_broadcast_metrics.py RAW.csv --format csv
python3 tools/prepare_broadcast_metrics.py RAW.csv --format csv --project PROJECT_JSON --request MAPPING_JSON --frames FRAME_METADATA_JSON --output workspace/metric-preview.json
python3 -m unittest discover -s tests -p 'test_*.py'
npm test
python3 tools/build_site.py --mode cloud --output dist
npm --prefix infra test
python3 tools/test_site.py
```

CLI 报告独占创建新文件；重跑须选新文件名。`preflight_broadcast` 不调用模型、抽帧或配音，不运行配置的外部视觉命令。根 Python 测试在 macOS 需要本机端口与离线 `say` 权限；CI Linux 没有 macOS 声音时跳过该项。

## 本轮真实证据

本机开发资料保留在忽略目录，不上传真实 NBA 视频：

- `workspace/preflight-audit-20261001/reviewed-48s.json`：原制作项目修订 11，恢复 52 张源帧；三类官方指标与四项云/Portal 检查未知，已有审核仍对应其当前文稿。
- `workspace/preflight-browser-final-20261001/browser-report.json`：9 项浏览器检查，真实 48 秒/1280×720 视频解码、引用画面、DOM/时间保留、节奏、报告下载、循环、时钟锚点、重载恢复和手机布局；无页面运行错误。
- `workspace/preflight-audit-20261001/local-current.json`：另一个已有两句成片文稿的修订 2 项目；不能与上面的三句文稿混为同一验收版本。
- `workspace/preflight-render-final-20261001/release/`：本轮用两句已 AI 复核文稿与离线系统声音重新生成的真实 48 秒影片、字幕、声音报告和 Manifest。它验证制作闭环，不能证明自动视觉理解成功或声音自然度。

前一轮受限 StepFun 4 秒识别发生过实质人物/动作错误；这轮修复的是候选容错和证据审计。仍须未来在获准素材及模型上重测识别效果。旧音频与当前故事不一致时本轮检查会标记，不能沿用旧音频通过结论。

## 账户到达后的优先顺序

先保存 Portal 原文：账户 ID、指定区域、Agent 服务名称、模型 ID/模态、正式字典、素材许可与提交规范。核对 STS 身份/配额，再构建镜像和 CDK 部署最小影片链路，实际记录 Agent 调用与 CloudFront 播放/Range。先提交可访问 URL，再接考试片优化。最后恢复私有仓库、核对 Portal 绑定和提交回执。

18:00 后不临时引入新模型或训练。19:30 目标冻结可播放版本；有明确改善证据才替换，保留回退成片与提交余量。声音以一个稳定自然的语种为基线，其他语种不能影响主影片可靠交付。

本轮独立 Astra 审核发现并修正了公开原始行传播、来源覆盖遗漏和旧数字配音误匹配。新增真实渲染泄漏哨兵与指标值/单位变化回归。48 秒成片为 H.264/AAC、1280×720；两句本机音频 2.609s/2.334s、语速 1.0 倍且句尾未截断，声音自然度尚未人工验收。
