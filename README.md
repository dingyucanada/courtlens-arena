# CourtLens Broadcast · 深度赛场解说工作室

**把一次进攻看懂，再把它讲回比赛画面。**

面向 BroadcastCode「深度赛场」黑客松，重新设计的视频解说制作系统。输入单个比赛片段，建立视频证据、核对官方指标、编排少量解释节点，导出带战术箭头、中文字幕和可选中文配音的真实 MP4，并生成可独立观看的成片页面。

当前主产品是 **Broadcast**。历史 Arena 的可靠指标验证能力部分复用，旧工作流不再是新版使用前提。历史说明见 [Arena 4.1 存档](docs/Archive-Arena-4.1-README.md)。

![制作工作台，合成流程演练](docs/broadcast-assets/story-desktop.png)

[观看带中文配音的实际导出样片](docs/broadcast-assets/voiced-rehearsal.mp4)（合成演练素材，不是真实 NBA 比赛）。

## 开始使用

需要 Python 3.12、Node.js 24、FFmpeg / FFprobe 和中文字体。安装媒体依赖后启动：

```sh
python3 -m pip install -r requirements-media.txt -r requirements-cloud.txt
python3 tools/launch.py --port 8769
```

打开 [本机 Broadcast](http://127.0.0.1:8769/broadcast/)。默认项目文件保存在 `workspace/`，视频不会因本地使用而自动上传。只有明确运行已配置的模型提供者时，才按界面选择的范围发送素材。

## 制作流程

| 阶段 | 可以完成的实际工作 |
| --- | --- |
| 选片 | 上传视频，读取实际时长、帧时间与文件指纹，确认比赛背景和素材来源。 |
| 看懂 | 提取真实关键帧；接受、修正或拒绝观察；配置模型时运行视频理解。没有模型时可人工完成。 |
| 讲清 | 编辑 1–3 个解释节点，把官方事件指标绑定到正确球员、回合和时间，在目标帧绘制人工箭头。 |
| 出片 | 对当前内容复核，生成 MP4、WebVTT 与证据清单；通过独立成片页面查看引用证据；本地可切换原片和解说版，公开云端成片默认不公开私有原片。 |

当前媒体边界：最长 180 秒、256 MiB，导出使用恒定帧率源片。带旋转元数据、非方形像素或非零起始时间的素材会明确拒绝，需先转换为标准 MP4，以免标注错位。

修改解释、来源或证据会撤销当前复核，已生成的历史成片保留。未配置的模型不会伪装在线，人工制作不会标成 AI 自动识别。

## 数据与模型边界

- Portal 下发的字典和指标记录是正式接入依据。数据缺失就保持缺失，不用防守距离近似替代官方 Gravity。
- 赛季指标不能作为这一次出手的数据。指标必须匹配比赛、球员、事件和完整显示时间窗。
- 观察区分可见事实与战术解释；球员身份不明时保留未知，不按当前球队名单猜历史身份。
- 模型、CV 与人工来源分开记录。RF-DETR / SAM2 可通过视觉提供者适配，但尚未用官方视频验证权重、吞吐与准确率。
- 随包演练视频及指标是合成素材。流程测试不等于真实 NBA 战术识别准确率。

## AWS 与继续开发

`infra/` 提供 AWS CDK 工程；`cloud/` 连接托管 API、私有素材、异步媒体任务与 Agent 服务。比赛最终入口必须是 CloudFront，代码仓库必须保持私有并在 Team Portal 绑定。

**AWS 比赛账户尚未分配，当前没有已验收的 CloudFront 部署。** CDK 本地合成和合同测试不能替代云上验收；区域、模型权限、Agent 服务名称、官方素材与字典须按 Portal 最终配置。语音供应商保留 MiniMax / StepFun 选择；StepFun 已完成本机真实配音成片，MiniMax 与 AWS 云端配音仍待实测。

本地标准源码、依赖与 CDK 可由 Kiro 继续开发；无需改写成专用 IDE 格式。

## 设计与证据

- [AWS 部署与验收](docs/Broadcast-AWS部署.md)
- [Kiro 接续开发](docs/Kiro接续开发与部署.md)
- [新版使用指南](docs/Broadcast使用指南.md)
- [架构设计](docs/Broadcast-架构设计.md)
- [设计裁决与科学边界](docs/Broadcast-设计裁决.md)
- [研究与事实核验](docs/Broadcast-研究与事实核验.md)
- 合同：`contracts/broadcast-v1.json`
- 核心服务：`core/broadcast/`
- 界面与播放器：`broadcast/`

最终测试结果与 AWS 接入状态以本版验收报告为准。CourtLens 是独立参赛项目，不代表 NBA 或 AWS 官方产品。

### 最新实测交付

- [StepFun 写稿＋配音真实成片](docs/broadcast-assets/stepfun-ai-story.mp4)：已核对的合成站位事实，经模型拟稿、复核和真实配音，8 秒成片。
- [StepFun 中文配音演练成片](docs/broadcast-assets/stepfun-rehearsal.mp4)：合成画面，真实语音接口，8 秒 H.264/AAC。
- [8 页产品与技术演示](docs/broadcast-assets/CourtLens-Broadcast.pptx)：真实界面、时间轴、可编辑图表与部署架构。
- [StepFun 真实成片记录](docs/broadcast-assets/stepfun-ai-verification.json)。
- [本版验收与剩余边界](docs/Broadcast-验收报告.md)。

StepFun 用于本机演练与可选配音；正式提交仍需赛方认可的 AWS Agent 服务、CDK 部署与 CloudFront URL。
