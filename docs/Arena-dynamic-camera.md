# Arena 动态镜头标定与本地验收

`pro/calibration.mjs` 与 `pro/render.mjs` 支持按视频绝对秒保存、检查与选择动态平面标定。浏览器预览和离线导出调用同一份 Canvas 渲染器；它们使用同一套镜头、关键帧、独立检查点和失效区间。

这条路径是**人工核对的时间关键帧与屏幕锚点插值**。没有执行自动光流、球员检测、镜头切换检测或视觉身份跟踪。输入球员轨迹、镜头边界和遮挡标志仍由提供者或操作者给出。合成测试通过不代表任何真实 NBA 素材已经完成标定。

## 操作顺序

1. 在原视频中找出每次切镜，建立不重叠的 `segments`。镜头 ID 和起止秒必须对应当前绑定的视频。
2. 对每个镜头保存多个当前画面的四点关键帧。四个球场锚点要保持同一顺序；平移、变焦或镜头运动改变后补关键帧。关键帧写入当前视频绝对秒 `t`，不是回合经过秒或比赛倒计时。
3. 在每个相邻关键帧的时间范围内，另选至少两个不同的球场位置作为独立检查点。检查点须与四个拟合锚点不同，并从其自身视频时刻读取实际画面位置。界面能保存不合格的真实观察值，以便审计看见误差；不能直接拿预测位置当观察值。
4. 为遮挡、身份丢失、无法判断镜头运动的区间填写 `invalidIntervals`，包括具体原因。失效区间两侧补关键帧与独立检查点后才恢复相应跨度。
5. 查看审计的逐点预测、观察值、误差和有效跨度，再预览并独立检查导出。

缺少检查点时可以继续保存关键帧，但投影会保持隐藏。相邻关键帧之间的任一不合格检查点会禁用这个局部跨度，其他已检查的跨度可继续使用。

## 数据结构

下面的数值仅演示一个合成镜头的结构，不是比赛数据。球场坐标单位 `ft` 与 0–1 画面坐标分开声明。真实对象保存在 `play.calibration`。

```json
{
  "mode": "dynamic",
  "court": {"units": "ft"},
  "segments": [{
    "id": "shot-a",
    "start": 0,
    "end": 0.5,
    "reviewed": true,
    "source": "人工逐帧核对当前原片",
    "interpolation": "anchors-linear",
    "maxGap": 0.5,
    "maxError": 0.01,
    "courtPoints": [[0,0],[50,0],[50,47],[0,47]],
    "keyframes": [
      {"id":"k0","t":0,"segmentId":"shot-a","reviewed":true,"source":"人工四点",
       "imagePoints":[[0.1,0.2],[0.5,0.2],[0.5,0.67],[0.1,0.67]]},
      {"id":"k1","t":0.5,"segmentId":"shot-a","reviewed":true,"source":"人工四点",
       "imagePoints":[[0.125,0.1875],[0.575,0.1875],[0.575,0.681],[0.125,0.681]]}
    ],
    "checkpoints": [
      {"id":"c0","t":0.25,"court":[10,10],"image":[0.1975,0.29625],
       "independent":true,"source":"另行观察罚球区域内点"},
      {"id":"c1","t":0.25,"court":[30,30],"image":[0.3675,0.50125],
       "independent":true,"source":"另行观察右侧内点"}
    ],
    "invalidIntervals": []
  }]
}
```

| 字段 | 实际要求 |
|---|---|
| `court.units` | 新动态标定须明确球场锚点物理单位 `ft` / `m`（可由所属镜头覆盖）；不从数值大小猜单位 |
| `segments[].id` | 非空、项目标定内唯一；关键帧显式引用同名 `segmentId` |
| `start,end` | 有限视频绝对秒，`0 <= start < end`；镜头时间不重叠；活动区间是 `[start,end)` |
| `reviewed,source` | 镜头与每个关键帧都须明确复核并记录人工操作或来源；明确 `false` 不被其他字段覆盖 |
| `interpolation` | 显式写 `anchors-linear`；其他方法不会被当成已经实现 |
| `maxGap` | 相邻关键帧允许的最大秒数；默认 1，合法范围 `(0,10]` |
| `maxError` | 独立点的归一化画面欧氏距离阈值；默认 0.01，合法范围 `(0,1]` |
| `courtPoints,imagePoints` | 4 对同序对应点；球场点可来自关键帧、所属镜头或顶层；直接输入的画面点须在 0–1 内 |
| `matrix` | 可替代关键帧的 `imagePoints`；仍须声明四个固定球场锚点，先从矩阵投影这些锚点再插值；矩阵锚点可在裁切画面外 |
| `checkpoints` | 每个相邻关键帧区间至少两个不同、非拟合球场点；`id,t,court,image,independent:true,source` 都须有效 |
| `invalidIntervals` | 数组，元素含 `start,end,reason`，位于镜头范围内；可附 `kind:"occlusion"` 或 `"identity"` 等操作说明 |

关键帧可位于所属镜头的结束秒，作为左侧镜头的边界几何支持。渲染在这个秒选择右侧的新镜头，不能借用左侧映射。球员轨迹也不能用右侧镜头的样本为左侧内插。

`play.cameraSegments` 存在时仍会检查当前时刻是否落在唯一已核对镜头内；动态标定的镜头 ID 必须与它对应。没有外部镜头分段时，动态标定自己的 `segments` 提供边界。校验和渲染不会自动猜切镜。

## 插值与隐藏规则

在同一镜头内，渲染将相邻关键帧的四个**画面锚点**按视频时间内插，再用固定球场锚点重新求单应性。它不直接内插未规范化的九个矩阵系数。球员运动先在球场坐标中内插，然后用当前画面的映射投影。历史球场路径也使用当前镜头映射，避免把摄像机平移误画成球员跑动。

以下情形隐藏对应自动位置和路径：没有唯一镜头、关键帧未复核、关键帧属于其他镜头、退化几何、无穷投影、超过 `maxGap`、动态关键帧范围外、独立检查点不足或超过阈值、当前失效区间、跨失效区间的关键帧插值。镜头边缘没有关键帧支持时禁止外推。

球员或整帧的 `reliable:false`、`identityReliable:false`、`positionReliable:false`、`occluded:true` 会隐藏受影响的位置。提供了 `confidence` 的单个位置只有有限且 `>= 0.5` 时才显示；没有提供该字段不制造一个置信度。重复球员身份、缺失身份、长采样缺口和切镜仍由既有 `frameAt` 规则阻断。显式镜头失效区间同样适用于直接提供的 `screenTracks`，其路径和插值不会跨失效区间连线。

隐藏平面投影不删除球场记录。独立球场视图仍可显示自身可靠、单位明确的球场输入。人工画面批注继续受自身时间与图层规则控制；它们不是自动恢复的球员轨迹。平面单应性也不会恢复空中篮球的三维位置。

线性锚点只是一个有界的运动近似。两个检查点不证明区间内所有帧都准确；镜头运动变化快、透视变化非线性或遮挡时，操作者须增加关键帧、检查更多实际时刻并标出无法检查的区间。

## 公共接口

全部接口从 `pro/calibration.mjs` 导出。

```js
const updated = addCalibrationKeyframe(calibration, "shot-a", {
  id: "k0", t: video.currentTime, segmentId: "shot-a",
  reviewed: true, source: "人工点击当前原片", imagePoints
});

const checked = addCalibrationCheckpoint(updated, "shot-a", {
  id: "c0", t: video.currentTime, court: [10,10], image: observedImage,
  independent: true, source: "人工独立画面检查"
});

const audit = auditCalibration(checked);
const selection = calibrationAt(checked, video.currentTime, {segmentId:"shot-a"});
if (selection.valid) draw(projectAt(checked, video.currentTime, [20,20]));
```

| 接口 | 返回或行为 |
|---|---|
| `addCalibrationKeyframe(calibration,segmentId,keyframe)` | 返回新的动态标定对象；不原地修改；同 ID 替换；其他 ID 占用同时间拒绝；无效几何、时刻或声明抛错 |
| `addCalibrationCheckpoint(calibration,segmentId,checkpoint)` | 返回新对象；格式无效或使用拟合点时抛错；超阈值的真实检查值会保留并让对应跨度失效 |
| `validateDynamicCalibration(calibration)` | 返回 `valid,errors,warnings,segments,error`；`valid` 只在所有镜头完整覆盖且每个跨度都合格时为真 |
| `validateCalibration(calibration)` | 动态对象转到动态验证；旧静态对象继续做原有几何、来源与范围检查 |
| `calibrationAt(calibration,t,{segmentId?})` | 可靠时返回 `matrix,segmentId,keyframeIds,interpolated,error,warnings`；否则返回 `valid:false,matrix:null,reason` |
| `projectAt(calibration,t,courtPoint,options)` | 返回归一化画面 `x,y`；失效时抛错，不能静默沿用上一个镜头 |
| `auditCalibration(calibration)` | 列出每个关键帧、每个独立点及局部跨度；检查点含 `predicted,residual,errors`，跨度含 `checkpointIds,error,valid,reasons` |
| `createCalibrationSelector(calibration)` | 返回对标定不可变快照的 `(t,options) => selection`，批量渲染复用同一份检查结果；与 `calibrationAt` 使用相同选择规则 |

完整审计可以为 `valid:false`，同时包含若干可用的局部跨度。实际渲染使用当前秒的 `calibrationAt`，不会因另一镜头的单个差检查点抹掉当前可靠的镜头。重复 ID 或重叠镜头等歧义结构会阻断所有动态选择。单个关键帧只有在该精确秒另有至少两个独立合格检查点时才可投影，不会扩展为整段固定镜头。

`renderOverlay` 的摘要中 `calibration` 含选中的 `segmentId,keyframeIds,interpolated,error`，可用于显示预览当前依据和导出验收记录。

## 误差解释

`residual = hypot(predicted.x-observed.x, predicted.y-observed.y)`。`error` 给出实际参与检查的点数、RMS 与最大值，单位是 `normalized image`。缺少观测值时返回 `null`，不填零。四个拟合角点会被拒作动态独立检查证据。

归一化二维距离不是球场英尺误差。换算到像素时，横、纵分量应分别乘以视频宽、高后再求距离；不能把一个归一化欧氏距离统一乘以视频宽度。审计报告仅描述这些检查点的观察一致性，不认证来源、镜头自动跟踪或所有球员的真实定位精度。

## 旧固定镜头备份

旧 `matrix` 或四点对象仍保留原字段。渲染固定区间需要显式 `stationary:true` 或 `cameraMotion:"stationary"`，以及 `start,end`、复核与来源声明。没有固定镜头声明时，选择器返回“旧标定已保留；须明确声明整段镜头 stationary:true 或重新保存动态关键帧”的原因。

软件不会在真实用户旧对象上默认补固定镜头声明。只有操作者核对整段没有移动、变焦或切镜后，才能使用固定区间。真实转播镜头有运动时应转为动态分段，而不是给长区间套一个矩阵。

## 确定性本地验收

`tests/fixtures/dynamic-camera.json` 是小型合成 fixture：球员 A 始终在球场 `(20,20)`，第一镜头按已知算式平移、变焦，2 秒切至独立新镜头，另提供遮挡区间用于失效测试。它不是比赛素材，也没有视觉识别结果。

`tests/test-pro-dynamic-camera.mjs` 直接检验预先算好的画面坐标：

| 视频秒 | 已知预期画面坐标 |
|---|---|
| 0.25 | `(0.2825, 0.39875)` |
| 1.75 | `(0.4175, 0.39125)` |
| 2.00 新镜头 | `(0.34, 0.48)` |
| 2.25 | `(0.3475, 0.4775)` |

测试覆盖共享渲染器选镜头、固定球员的路径不受摄像机移动影响、切镜禁借旧矩阵、外推禁用、遮挡与身份失效隐藏、独立误差、错误检查点局部失效、矩阵关键帧、不可变保存和旧备份迁移。独立观察加横向偏移 `0.006` 时报告最大误差 `0.006`、两个检查点 RMS `0.006/√2`；偏移变为 `0.016` 后超过声明阈值 `0.01`，对应跨度隐藏。

运行：

```sh
node --test tests/test-pro-dynamic-camera.mjs tests/test-pro-calibration.mjs tests/test-pro-render.mjs
```

## 预览与原生成片的项目标定视图

`pro/camera-view.mjs` 提供 `playAt(project,play,t)`。它解析项目 `calibrations` 中唯一、当前有效的人工标定；没有项目标定时使用回合自己的标定。有效固定镜头声明或带独立检查的动态标定只能启用当前匹配的镜头，范围必须完整落在同一来源镜头内。重叠项目标定、错误 `segmentId`、跨来源切镜或旧标定缺少 `stationary:true` 时，投影继续关闭。

它创建展示副本，不修改 `tracks`、`screenTracks`、`sourceRecord`、来源镜头 ID 或项目保存的标定。浏览器 `viewPlay` 与原生成片使用同一函数，所以项目层人工标定不会仅在预览中生效。

`storyFrameAt(project,play,t,plan)` 返回 `{play,arrows}`，先应用共享镜头视图，再去掉原回合 `annotations` 中的人工箭头。成片只绘制当前 `plan.arrows` 中有效的人工箭头，遵守 `plan.layers.paths`；用户编辑或删除计划中的箭头后，原回合旧几何不会重复绘制或重新出现。其他人工区域、标签与来源标注保持自己的渲染规则。这个函数用于已验证的计划，不承担内容复核。

`tests/test-pro-camera-view.mjs` 检查项目固定标定、移动镜头、多镜头边界和原始数据保持不变，并可运行实际 MP4 像素验收。启用 `ARENA_EXPORT_INTEGRATION=1` 且提供 `ARENA_CJK_FONT` 后，测试生成两版 320×180 MP4，解码 0.5 秒画面，核对球员在预期像素 `(96,72)`、编辑箭头在新位置、删除箭头无残留、原人工箭头不会被重复画入。此测试仍为合成媒体。

原生成片资产哈希包含 `pro/camera-view.mjs`；修改选择和箭头渲染规则会改变成片缓存身份。
