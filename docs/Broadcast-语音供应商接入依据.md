# 中文语音接入依据

查验日期：2026-09-30。比赛 AWS 账户尚未下发；StepFun Step Plan 已完成真实接口和本机成片验收，MiniMax 与云端配音仍未实测。模型与音色必须由部署配置指定，不根据市场最新型号自动选用。

## MiniMax

[官方同步语音 API 文档](https://platform.minimax.io/docs/api-reference/speech-t2a-http) 描述 `POST /v1/t2a_v2`，使用 Bearer 验证。请求包含 model、text、voice_setting 和 audio_setting。采用非流式、hex 音频返回，避免跟随任意音频下载 URL。检查 base_resp.status_code 为 0、data 非空且含音频；解码后仍需实际探测音频，不凭返回成功字段判定有效。

该 API 的 `language_boost` 明列 `Chinese`、`English`、`Chinese,Yue`。[官方系统音色表](https://platform.minimax.io/docs/faq/system-voice-id) 分列普通话、英语和粤语音色；例如 `English_expressive_narrator` 是英语，`Cantonese_ProfessionalHost (M)` 是粤语，`Chinese (Mandarin)_HK_Flight_Attendant` 仍被列为普通话。故三种语言须使用各自明确配置的音色；粤语不得从普通话音色或繁体文本推断。配置英语 `COURTLENS_MINIMAX_VOICE_ID_EN`、粤语 `COURTLENS_MINIMAX_VOICE_ID_YUE` 后，服务端分别强制 `English_`、`Cantonese_` 前缀并发送对应 `language_boost`。配置完整仅代表可以尝试合成，仍须真实试听、核对读音、音长与发布视频。

国内文档入口：[官方中文 API 文档](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)。不同账户区域的端点须显式配置，不能自动跨区切换。

## StepFun

文档页面本次访问失败，使用厂商官方仓库作为协议依据：[StepAudio-Skills 的 TTS 请求实现](https://github.com/stepfun-ai/StepAudio-Skills/blob/main/skills/step-tts/scripts/tts.sh)。其中同步接口为 `POST https://api.stepfun.com/v1/audio/speech`，主要字段 model、input、voice、response_format，返回音频字节；JSON 错误响应不能保存为音频。这里仅借鉴 HTTP 协议，不安装该仓库的技能、不读取其默认全局密钥文件。

当前账户只用 `elegantgentle-female` 完成普通话实测。厂商开源 Step-Audio 项目提到英语、粤语能力，不能据此推断当前商业 API 的指定模型与音色也可用；本实现因此拒绝用当前 StepFun 音色给英文或粤语稿配音。

## 语言与风格的发布合同

语言字段 `language` 独立选择 `zh-CN`、`en-US`、`yue-HK`；风格字段 `commentaryStyle` 独立选择 `analysis`（战术派）、`energetic`（现场派）、`data`（数据派）。旧 `zh-analysis`、`en-live`、`yue-live` 输入保留兼容，但不限制新项目的九种组合。一次制作选择一种组合，不自动生成九份影片。

故事先经证据复核，再按故事语言挑选声道。能力响应分别提供 `commentaryLanguages` 和 `commentaryStyleOptions`；语言条目的可用声音按当前机器和供应商配置计算，始终允许字幕版。服务端在入队和实际合成时重复核对语言，成片 `voice.language` 和 `voiceReport.language` 记录所用语言。浏览器已验证九种选择组合与实际后端响应；这不等于九种真实配音均已验收。

本机 macOS 探测到 `Tingting zh_CN`、`Samantha en_US`、`Sinji zh_HK`；这些声音仅供本地演练，存在和能生成音频并不证明篮球解说自然度。Amazon Polly 当前 `Zhiyu` 与 StepFun 当前已测音色只启用普通话。MiniMax 英语和粤语分别依赖明确的音色配置；云部署的三语音色配置与真实合成尚未全部验收，不能把本机可用声音当成 AWS 可用声音。语音提供者及音色均不得模仿具体真人解说员。

## 本项目统一边界

每个已复核解说节点单独合成、测量，再写入同一视频时间轴。保持字幕与配音文字一致；过长时应提示缩短文案或延长窗口，不截掉句尾冒充同步成功。密钥只从进程配置或 AWS Secrets Manager 注入，前端和成片清单不携带密钥。使用正式许可音色，不模仿或克隆具体真人解说员。配置、协议模拟通过和真实调用通过应分别显示。

## Step Plan 真实验收（2026-09-30）

用户提供 Step Plan 账户后，验证模型列表返回成功；`POST https://api.stepfun.com/step_plan/v1/audio/speech` 使用 `stepaudio-2.5-tts` 与 `elegantgentle-female` 返回可解码中文 MP3（单声道、24 kHz、2.736 秒）。随后通过本产品编辑、复核、渲染流程生成 8 秒 H.264/AAC 成片；manifest 记录 `provider=stepfun`、逐句实测时长、音轨哈希，未截断句尾。这不是 AWS 部署验收，也不是 NBA 战术准确率测试。

配置 `COURTLENS_STEPFUN_API_VARIANT=step-plan` 选择该固定路径；默认 `openapi` 仍为官方开放平台 `/v1/audio/speech`。不接受任意 URL、不自动跟随重定向；密钥仅在本机权限受限、被 Git 和 Docker 排除的配置中。

同账户 `step-3.7-flash` 已通过一次合成画面图像理解请求，返回完整内容；较小的输出预算曾导致空正文，该失败也被保留。单次协议成功不能证明模型对真实比赛视频的理解准确性。

## 本机启动

已配置环境变量的终端可直接启动；也可显式载入本机配置：

```sh
python3 tools/launch.py --port 8769 --env-file .env.stepfun.local
```

配置文件只接受文档中的 `COURTLENS_*` 供应商设置，按数据读取，不执行 shell 内容，不输出值。现有进程环境优先于文件；整份文件验证通过后才注入配置。不要提交该文件。网页只获取能力状态，不能获取密钥。

图像输入协议另已核对 [StepFun 官方 Step-3.7-Flash 示例](https://github.com/stepfun-ai/Step-3.7-Flash#52-text-and-image-input-example)，使用 `image_url` 与文字组成消息；Step Plan 路径以用户账户提供的地址和实际调用为准。

## 模型写稿与配音组合验收

真实模型调用也用于验证失败边界：一次图像提议包含源帧不支持的出手判断，未获采用；更保守提示下返回空观察。之后以明确标记为人工核对的合成站位事实作为输入，文字模型生成草稿。早期响应曾因叙事类别与证据尚不可用被拒绝，修正提示与服务端计算的最早可说时刻后，后台任务约5.33秒成功。

最终文本“合成画面下方，橙色与蓝色球员标记保持相邻站位。”经合成验收后生成真实StepFun配音，3—8秒窗口内音轨长4.9326秒，实际加速系数1.1268，未截断句尾；成片8秒、H.264/AAC。验证记录与影片见 `docs/broadcast-assets/stepfun-ai-verification.json`、`stepfun-ai-story.mp4`。这是接口与制作流程实测，不能表述为NBA自动战术识别准确率。
