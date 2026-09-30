# Broadcast 篮球 CV：真实 NBA 片段执行记录

2026-09-30，独立 CV 命令在 NBA 官方频道的 [2025-01-01 独行侠对火箭集锦](https://www.youtube.com/watch?v=HjzSVTdTM8M) 的前 48 秒上执行。源片被重编码为 1280×720、25fps、48.000 秒，SHA-256 为 `10dc5a80343dc97890fc89111fb40997565be2fe48732f815cb4af6902f7f24d`。这是公开集锦的本地技术核查，不是赛方授权比赛片，也不是连续单回合；本地预览不作为可公开发布的素材许可声明。

主执行器为社区作者 [koppolusameer 的篮球 RF-DETR Nano 模型](https://huggingface.co/koppolusameer/rfdetr-basketball-player-ball-referee-detection)，固定提交 `46c33088c790670a7e81e21e753fa368b2d77a70`。其模型卡声明 Apache 2.0，训练数据来源为 [Roboflow 篮球检测数据集 v18](https://universe.roboflow.com/roboflow-jvuqo/basketball-player-detection-3-ycjdo/dataset/18)，页面标示 CC BY 4.0；这里据此注明来源。模型权重并非 Roboflow 官方篮球预训练包，也未经本项目重训。模型卡称标签为 ball/player/referee，并报告测试集 player mAP 0.6228、ball mAP 0.1805、referee mAP 0.601；训练画面主要是 Celtics 比赛，因此不把其测试集分数转述为本 NBA 片的准确率。

从固定提交下载 `config.json`、`preprocessor_config.json`、`model.safetensors` 到 Git 忽略的 `workspace/cv-models/hf-basketball/`。本机直连 Hugging Face 超时，使用对应提交的 `hf-mirror.com` 镜像取得同一对象；镜像返回的 `X-Repo-Commit` 与官方模型页提交相符，`model.safetensors` 实际 SHA-256 为 `c141ac1f05ffce2ac678406df34143efb03d3470f32a6817505de3fdb8b76c35`，与镜像 `X-Linked-ETag` 相符。仅加载 `safetensors`，不加载仓库中的 `training_args.bin`，也不使用远程代码。

本地安装与服务启动：

```sh
.venv/bin/python -m pip install -r requirements-cv-rfdetr.txt
mkdir -p workspace/cv-models/hf-basketball
for file in config.json preprocessor_config.json model.safetensors; do
  curl -L --fail -o "workspace/cv-models/hf-basketball/$file" \
    "https://huggingface.co/koppolusameer/rfdetr-basketball-player-ball-referee-detection/resolve/46c33088c790670a7e81e21e753fa368b2d77a70/$file"
done
shasum -a 256 workspace/cv-models/hf-basketball/model.safetensors
tools/cv_basketball --capabilities
COURTLENS_CV_COMMAND="$PWD/tools/cv_basketball" .venv/bin/python server.py
```

若直连仓库不可达，可以将上述 `huggingface.co` 替换为 `hf-mirror.com`，并核对固定提交、模型文件 SHA-256 与配置映射 `0=ball, 1=player, 2=referee`。`--capabilities` 只离线检查包和权重、计算 SHA-256，不下载模型；没有权重时返回不可用。浏览器选择现有 `cv-command` 即调用该命令，后端控制可执行路径和视频路径，生成执行请求、校验源片 hash、范围、坐标与有限样本，结果保存在项目私有 run 中。真实服务测试成功产生 7 条待审观察，原始 6 帧框保留在 run 旁证；人工确认前不获得球员姓名或战术结论。

## 测得结果

| 范围与频率 | 实际帧数 | 执行耗时 | 候选框数量 | 待审轨迹观察 |
|---|---:|---:|---|---:|
| 0–12 秒，1fps | 13 | 9.0 秒 | player 61、referee 26、ball 12 | 20 |
| 16–21 秒，1fps | 6 | 8.0 秒 | player 28、referee 15、ball 3 | 7 |
| 0–47.96 秒，5fps | 240 | 34.9 秒 | player 1689、referee 592、ball 221 | 30（安全上限） |

完整 48 秒的 [原始 CV 结果](../workspace/real-nba/cv-review/basketball-result-0-48.json) 和 [H.264 逐帧候选框预览](../workspace/real-nba/cv-review/basketball-0-48-preview.mp4) 都在本地忽略目录。预览只展示实际参与推理的 240 帧，每帧按源 PTS 顺序以 5fps 播放；框不在取样帧之间插值或跨切镜延长。短窗有 [16–21 秒检查图](../workspace/real-nba/cv-review/basketball-16-21-sheet.png)。已实际解码并目视检查预览 17.8 秒帧：多数近景球员与裁判框落在画面目标上，但有漏检、相邻球员合并框；1 秒附近出现记分牌区域的球误报。完整片通过颜色直方图保守重置轨迹，检测到 2.0、2.2、2.4 秒附近的剪辑过渡和 26.0 秒的明显切换；切镜检测本身还不是已验证的真值标注。

ByteTrack 的 `trackId` 只表示短镜头内检测框关联，遮挡、人物交叉和画面切换会使 ID 丢失或交换。球衣中心颜色的 `visual-color-a/b` 也经实际画面核查发现混组，不能映射为独行侠/火箭。`jerseyText` 始终为 `null`，因为没有运行 OCR；姓名、真实球队、传球、投篮和进球都不由这个 CV 模型判断。球候选的模型卡 mAP 本来偏低，逐帧结果不能直接推导持球、轨迹或进球。人工复核与独立视频语义证据仍然必需。

通用 [RF-DETR Nano COCO](https://github.com/roboflow/rf-detr) 也在 16–21 秒实际运行，6 帧耗时 15.1 秒，输出 20 个 person、2 个 sports-ball 候选框与 5 条待审轨迹观察；其官方 Nano 权重 MD5 为 `fb6504cce7fbdc783f7a46991f07639f`。通用 Torchvision SSDLite COCO 在 0–5 秒仅于 6 帧中检出 2 个人，其中一人为裁判，没有持续轨迹，故不推荐它用于本片。通用 COCO 模型不能被描述为篮球专项模型。

默认单次服务任务最多抽 30 帧、默认 1fps（可配到 5fps），最长 90 秒；离线密集核查可设置 `COURTLENS_CV_MAX_FRAMES=300 COURTLENS_CV_SAMPLE_FPS=5`，但后端执行超时固定为 180 秒，慢机器应缩小时间窗。所有输出最多 300 个样本和 100 条事件；此实现最多写 30 条“人物轨迹待审”观察，以免把整场候选强塞进编辑流程。它不计算官方 xFG、GRAV 或 LVG，也没有球场标定或 SAM2 分割。

### 球衣号码定向识别小样本

从本片 16–21 秒的篮球专项检测结果选 6 个球员框，按框裁出上半身；[六张原裁图联系图](../workspace/real-nba/cv-review/jersey-probe/contact.png) 和逐图坐标、hash 保存在本地 `workspace/real-nba/cv-review/jersey-probe/`。由 Codex AI 对原帧及裁图直接复核可见号码（没有独立人类标注），再用 StepFun `step-3.7-flash` 仅询问颜色/号码，不问球队或姓名；每次最多 2 图、`max_tokens=1000`、30 秒超时。结果是局部可读性探测，不代表独立标注集或识别准确率。

| 裁图 | 原帧可见事实 | StepFun 回答 | 判定 |
|---|---|---|---|
| C1，16秒 | 白色 26 | 白色 25 | 号码错误 |
| C2，17秒 | 红色 9 | 红色 9 | 正确 |
| C3，18秒 | 白色 26 | 白色 25 | 号码错误 |
| C4，18秒 | 检测框合并红白两人；白色 25 可见 | 两次均在 1000 token 上限内未完成 | 不可读；上游混框 |
| C5，20秒 | 红色，号码被遮挡 | 红色、号码 null | 正确拒读 |
| C6，21秒 | 红色 9 | 红色 9 | 正确 |

号码计为 2 正确、2 错误、2 不可读/拒读。颜色在 5 个有完整回答的裁图中与肉眼一致；这不解决球员身份，且 C1/C3 同一名球员跨帧重复，不能当作 6 个独立球员样本。`jerseyText` 仍为 null，不启用自动姓名、球队或号码映射。这里还揭示了检测框混人和模型把清晰 26 读成 25 两种不同失败；后续若加入 OCR，须有独立人工标注集、低置信拒读及跨帧一致性门槛。
