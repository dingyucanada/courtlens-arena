# 陌生片段盲测评测协议

赛方视频尚未发放时，先冻结计分方式；收到素材后再由人工逐帧建立真值。现有 NBA 集锦盲测只证实模型能给出候选及失败记录，**没有足够独立真值，不能宣称识别准确率**。

`tools/evaluate_broadcast_blind.py` 读取独立标注的事件文件和本地 Broadcast `project.json`。两者必须拥有完全相同的源视频 SHA-256；默认只评分 `source.kind=model` 的原始观察候选，不把人工修订或 CV 匿名轨迹混成模型成绩。按源 PTS 单调一对一匹配：先最大化匹配数量，再最小化时间误差。默认容忍窗口为 1 秒，输出召回、候选精度、动作类型正确数、实名正确/错误/拒答、缺锚点及跨切镜候选。报告逐事件列出误差，便于回看原片。**自由文本的得分结果、战术因果、球队归属和解说质量不会被程序从描述中猜测打分**，须另由篮球知识审核者人工判定。

至少标注 10 个独立事件，才能把 `goldComplete` 设为 `true`；少于 10 个时 CLI 退出码为 2。标注者应先看源片及另一份同场记录，不看模型候选，保存可复查的证据说明。剪辑集锦的比赛钟不能直接当源 PTS；每个事件的 `anchorTime` 必须在播放器源视频时间轴上逐帧确认。真实片、真值和模型原始响应保存在忽略的 `workspace/`，不可直接推送到公开仓库。

标注 JSON 示例（示意结构和占位 ID，**不是 NBA 真值**）：

```json
{
  "schema": "courtlens-blind-gold/1",
  "mediaSha256": "<当前 project.media.sha256 的 64 位值>",
  "sceneCuts": [5.2, 13.52],
  "events": [
    {"id": "e01", "anchorTime": 2.4, "type": "pass", "playerId": null,
     "evidence": "源片 2.36–2.44 秒逐帧复看；传球者号码不可辨"}
  ]
}
```

在仓库根目录执行：

```sh
python3 tools/evaluate_broadcast_blind.py \
  --gold workspace/blind-gold.json \
  --project workspace/<本地项目目录>/project.json \
  --source model --tolerance 1.0 \
  --output workspace/blind-evaluation.json
```

输出中 `precision` / `recall` 只衡量事件定位窗口，`actionCorrect` 是匹配项中的类型正确数，不可将它写成整片理解正确率。模型观察若没有锚点，程序用窗口中点尝试匹配并单列 `missingAnchors`；这不是帧级定位证据。球员实名只在真值有主角 ID 时计分，候选 `playerIds` 的首位才算主角，未写姓名记为拒答，错误 ID 记为错误；同场名单仅帮助核对 ID，并不能单独证明画面身份。单条事件窗失败、超时、模型拒答与候选误报均需保留在原始运行记录，不能从分母删去。

比赛现场收敛门槛：先给两段训练片各自建立真值与失败样例，再做留一片盲测；考试片到手后只运行已冻结版本，不依据考试结果调参。人工对每条拟发布字幕复核“球员/球队、动作、结果、源 PTS、指标来源”五项；有任一项不确定，改成可观察事实或删去。最终交付仍须真实 CloudFront、CDK 和指定 AWS Agent 服务验收。
