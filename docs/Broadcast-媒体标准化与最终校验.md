# 显式标准化副本与最终故事校验

2026-09-30，本地开发记录；没有 AWS 部署、语言自然度或新视频识别验收的声明。

## 导入副本

`python tools/normalize_broadcast_media.py source.mov --output normalized.mp4 --fps 30`

可选目标 CFR 为25、30、60。工具不覆盖原片或已有输出；同时生成 `normalized.mp4.normalization.json`，保留原片 SHA-256、原始 ffprobe 流/容器元数据及帧 PTS、转换参数、输出 SHA-256 与新时基。非零 PTS 归零；旋转烘焙到像素；非方形像素转方形；VFR 通过显式重采样转 CFR。上传标准化副本后，必须重新抽帧、取证和审核，不能复用原片观察 ID、源帧 ID 或原时间戳。

时间日志给出原首帧时刻和每个输出帧的最近原始 PTS 候选。这是可审计的近邻时间映射；丢帧/重复帧重采样不宣称逐帧内容完全相同。本轮没有把 CLI 自动接入 UI 上传。

真实媒体反例覆盖30/60 CFR、VFR、非零 PTS、旋转、非方形像素、原片哈希不变及已有输出拒绝。

## 最终故事

共享 `validation.story` 在模型提议、人工编辑、复核和渲染执行，统一检查 `text / label / secondaryLabel`。具名配合战术需要当前节点已引用的完整、过去、已接受源帧观察；解释正文和含战术名称的标签保留条件措辞。基本手递手、反切、无球掩护、低位背身动作在完整线索支持时允许画面事实的自然改述。简繁术语归一，含英文 no/not/might 等否定或疑似描述不能产生正向战术特征。发布 manifest 的 `evidence.tacticKnowledge` 保存节点术语出处与画面引用，两者不能相互替代。

语言通过 `language=zh-CN|en-US|yue-HK` 与 `commentaryStyle=analysis|energetic|data` 独立选择。旧 `zh-analysis/en-live/yue-live` 及缺省故事仍可读取。能力返回 `commentaryLanguages` 的可配置 `voiceModes` 和 `verified:false`，另有 `commentaryStyleOptions`。可配置不代表自然度验收；StepFun/Polly仍限定普通话。英文/粤语不得靠普通话音色假冒。

## 视觉结果反例与任务预算

同场留出片独立源帧核对发现：旧比分牌在球入篮后可能尚未更新，剪辑也可能跳时。因此三个StepFun视觉提示入口共用规则：比分未变、单独底线取球或防守者拿球均不足以认定投篮不中；需要独立可见入篮/弹出或连续完整后续球权证据，否则只描述出手、结果unknown。规则没有硬编码样片答案；提示约束不能替代源帧审核，未审结果仍不得发布。

云worker业务等待固定600秒，超时取消并拒绝部分输出。外层runner维持900秒、任务维持1080秒；Agent调用210秒计入外层总预算，不能把离线预算测试称为云端实测。
