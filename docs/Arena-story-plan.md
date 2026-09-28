# 可审阅 StoryPlan 与便携发布

StoryPlan 是依据输入事件、指标与轨迹编排的剪辑和文句提议。它把输入快照、证据、生成请求、模型标识、原始提议、人工改动与最终审阅保存在一个 JSON 文件中。默认本地生成器是确定性证据编排，`model: "none"`；本流程没有运行视频 AI 识别，也不认证素材来源。

`pro/story-plan.mjs` 可在现代浏览器和 Node 中使用。外部模型可以提交同一提议结构，但模型调用发生在该边界之外；导入时记录提供者、模型、提示词、请求和参数，`generation.execution: "imported-proposal"` 明确表示应用接收了提议，没有声称自行完成推理。`STORY_PLAN_PROPOSAL_SCHEMA` 提供可送给任意结构化输出提供者的 JSON Schema。

## 编写与审阅接口

```js
import {
  createLocalStoryPlan, createStoryPlan, reviseStoryPlan,
  reviewStoryPlan, verifyStoryPlan, storyTimeMap
} from './pro/story-plan.mjs';

const draft = await createLocalStoryPlan(project, {
  analyses, narrations, audience: 'fan', question: '解释这个回合',
  layers: {players:true, paths:true, labels:true, zones:true,
           defenders:false, ball:true, metrics:false}
});
// 传入的 narrations 的最终 text / origin / originalText 会保留。
const reviewed = await reviewStoryPlan(draft, {
  reviewer: '本地审阅者', reason: '逐句核对时间、来源、最终文句与人工箭头。'
});
await verifyStoryPlan(reviewed, project, {requireReviewed:true});
const map = storyTimeMap(reviewed);
```

`validateStoryPlan` 是同步结构检查；`verifyStoryPlan` 还重算全部哈希、对比原始项目，并从项目重新计算被引用的证据和原引擎文句。两者成功返回 `{ok:true, errors:[], warnings:[...]}`，拒绝时抛出 `StoryPlanError`。正式导出必须调用异步验证并要求 `requireReviewed:true`。`reviewStoryPlan` 记录实际人工决定，调用它不会自动证明文字语义正确。

`reviseStoryPlan(plan, {cues, arrows, clips, layers, title}, {actor})` 返回新修订；只传修改字段即可。它保留初始提议，将改动、作者、时间和父版本哈希加入 `history`，撤销旧审阅。重新审阅前不能发布。原 JSON 不会被修改。

## 提议结构与证据边界

提议含 `title`、`clips`、`cues`，以及可选 `arrows`、`layers`。完整示例：

```json
{
  "title": "来源概率读数",
  "clips": [{"playId":"p01","start":10,"end":14}],
  "cues": [{
    "id":"cue-1", "clipIndex":0, "playId":"p01", "start":11,"end":13,
    "text":"输入概率为 62%。", "evidenceIds":["p01:metric:difficulty"],
    "playerIds":["Alice"], "origin":"external-model",
    "basisStart":null, "originalText":"",
    "facts":[{"evidenceId":"p01:metric:difficulty","path":"",
      "value":0.62,"format":"percent","decimals":0}]
  }],
  "arrows": [], "layers":{"players":true,"paths":false,"labels":true}
}
```

证据值为对象时，`facts.path` 是对象内的点分路径；空路径代表 `evidence.value` 本身。`fact.value` 必须等于原始证据值。`percent` 按证据单位显示：只有明确 `unit: "probability"` 且数值在 0–1 内时乘 100；`unit: "percent"` 或 `%` 保留原百分数，例如原值 0.62 只能表示 0.62%，原值 62 表示 62%。相同的概率语义名称不会覆盖单位，也不允许用 ft、index 或未知单位转成百分号。每个带百分号的文句数字都须绑定正确单位的百分数句柄，不能借用旧引擎文句里的数字或原值句柄绕过尺度检查；`raw` 保留原值，`absolute-percent` 只用于已声明的防守凸包收缩测量。显示小数位只能是 0–6。

本地 `createLocalStoryPlan(project, options)` 未显式传 `options.arrows` 时，会把片单中项目的人工 arrow 编译到 `plan.arrows`：保留 playId、有效源时间、归一化原坐标、颜色和 `sourceAnnotation` 来源记录。源记录包括原 annotation ID、未裁剪窗口、原点数组、origin/source、人工 evidence_id 标记与 frame_reviewed。人工 evidence_id 是绘图来源标记，不冒充测量证据；默认使用本回合 event 证据锚定身份/源时刻，最终几何仍须单独人工审阅。明确 frame_reviewed:false 的箭头不会自动进入本地草案，时间/坐标/身份/证据越界会拒绝。

片单裁剪保留原窗口，重复或重叠播放窗口只编译一份当前源几何，避免叠加重复箭头。显式 `arrows: []` 是删除指令，显式非空数组是最终编辑结果；导入外部 proposal 或通过 `reviseStoryPlan` 修改时不会重新恢复源人工箭头。新箭头草案保持 pending，修改箭头撤销旧审阅并产生新内容/渲染身份。`sourceAnnotation` 必须与保存的原项目记录一致，最终点可经过人工编辑，但不能伪造原始来源。

每句使用绝对视频秒数并属于指定 `clipIndex`。重复播放同一回合时，字幕依照各自片单项映射，不会把每个相同源时间的字幕重复叠加。输出映射保留 `sourceStart/sourceEnd` 和成片 `start/end`。

检查拒绝不存在或跨回合的回合、球员、证据 ID，已知的跨回合球员名字、无效入出点、越界箭头、未完成的证据时间窗，以及字幕开始时尚未可用的指标或结果。已知结果与文句直接矛盾时也拒绝。箭头坐标必须位于归一化画面 0–1 内并标明 `origin: "manual"`，不能把模型提出的坐标冒称测量轨迹。

数字检查包括阿拉伯/全角数字、科学计数法、Unicode 负号与中文相邻数字。人工新增的数字不会自动从其他字段碰巧匹配：新增断言须明确提供数值证据句柄；自动句柄只绑定原引擎文句已使用的数字。保留旧文句的上下文数字（节次、时钟、量表边界等）来自重新核对的引擎锚点。

这些检查不具备自然语言语义推断能力。例如，它不能仅靠数字相同证明一句因果判断、指标含义或陌生人名正确，也不能识别用汉字全拼的新数值断言。最终人工审阅须检查这些内容；`warnings` 与发布清单明确保留这一限制。

上限为 24 MiB 快照、100 个片段、1000 句字幕、500 个箭头，每句 1200 字符、32 条证据引用、128 个数字句柄、100 次修订。拒绝非有限数值、循环对象和未知内容字段。

## 两种缓存与发布身份

| 身份 | 纳入内容 | 用途 |
|---|---|---|
| `generation.inferenceIdentity` | 原始项目/证据/原文快照、提供者、模型、提示词及版本、问题/受众请求、生成参数 | 相同生成请求的缓存标识；本地编排仍明示未调用模型 |
| `contentHash` | 输入哈希、最终标题、片段时间、字幕全文和证据绑定、箭头与图层 | 人工审阅绑定的最终内容 |
| `planHash` | 完整计划，包括原始提议、请求、审阅与修改历史 | 具体可追溯修订 |
| `renderIdentity` | 最终内容、源片字节、渲染代码和 Canvas 原生资产、FFmpeg 字节/版本、Node 版本、字体字节、音频模式、尺寸与帧率 | 渲染身份；任何渲染依赖改动都产生新标识 |
| `releaseIdentity` | 渲染身份及具体 `planHash` | 不可覆盖的发布目录，避免复用成片时丢失新审阅来源 |

生成缓存和渲染缓存不是同一个键。修改文字、箭头、图层或片段必须创建新的内容与渲染身份；只改提供者声明或审阅者时，像素依赖可以相同，但发布身份仍不同。缓存命中时会重新验证清单及所有输出字节；损坏缓存会拒绝使用。

## 本地与 Linux 命令

需要现代 Node、FFmpeg/ffprobe、`npm install` 安装的 `@napi-rs/canvas`，以及明确指定的中文字体。可使用 Linux 的 Noto Sans CJK 字体文件。此路径不使用 macOS 语音、本机 `say`、浏览器录屏、AWS 或任何云账号。输出为静音 MP4。

```sh
node tools/story_plan.mjs create --project project.json --output draft.json
node tools/story_plan.mjs review --plan draft.json --reviewer "审阅者" \
  --reason "逐句核对画面、证据与人工文句" --output reviewed.json
node tools/story_plan.mjs validate --plan reviewed.json --require-reviewed
node tools/export_arena.mjs --story-plan reviewed.json --video source.mp4 \
  --font /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc \
  --release-dir releases
```

外部提议导入：

```sh
node tools/story_plan.mjs import --project project.json --proposal proposal.json \
  --provider external-provider --model actual-reported-model-id \
  --prompt prompt.txt --output draft.json
```

CLI 的写入采用排他创建；修改或审阅须给新文件名。导出默认 1280×720、25fps，也可显式指定偶数尺寸与 1–60fps。片段入出点必须落在选定帧率网格上，超界、暗中取整或解码帧数不完整时拒绝导出。VFR 源片的精确帧对齐仍须独立复核。

成功后输出 `releases/<releaseIdentity>/film.mp4`、`captions.vtt`、`story-plan.json`、`manifest.json`。先在暂存区完整生成并核验，再原子发布目录；不覆盖历史发布。清单保存源到成片时间映射、实际编码时长、帧数、源片/字体/资产哈希和人审记录，`outputs[].sha256` 从最终写入的实际字节计算，`manifestHash` 覆盖清单本身的其余字段。MP4 不是 HTML 替代文件。

`node tools/export_arena.mjs` 的既有演示路径和手工演练文句保持原有行为；只有使用 `--story-plan` 才进入新发布流程。

## 实测

```sh
node --test tests/test-pro-story-plan.mjs tests/test-pro-story-release.mjs
ARENA_EXPORT_INTEGRATION=1 ARENA_CJK_FONT=/path/to/CJK-font.ttc \
  node --test tests/test-pro-story-release.mjs
```

结构测试覆盖证据攻击、数字符号、跨回合身份、时间窗、输入篡改、伪造但自洽的证据快照、修改后审阅撤销与各渲染依赖。集成测试实际生成源 MP4，渲染 20 帧、2 秒静音成片，验证输出字节哈希、清单自哈希、重复缓存、人工文字改动后的新成片与旧发布保留，并确认损坏成片不能命中缓存。另一个集成测试真实生成默认 UI 箭头、编辑后的箭头和显式清空三份 MP4，在输出 0.5 秒解码帧中数像素，验证原位置保留、编辑后旧位置消失和清空后源箭头不复活，并验证三个渲染身份不同。未设置集成测试开关时，媒体测试明确显示 skip。
