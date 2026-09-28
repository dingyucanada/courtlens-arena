# 独立专项回归

以下命令从应用根目录执行。检查直接调用实际输入适配、校验、证据规划和渲染代码；不修改应用项目或视频文件。

普通Python检查只需标准库，不依赖Pillow、云凭据或网络：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 tests/independent_core.py -v
```

网页检查用轻量DOM替身执行真实播放器函数，并检查实际标注创建函数；它不代替浏览器交互验收：

```sh
node --test tests/independent-annotation.test.cjs
```

可选媒体检查需要Pillow。它实际渲染内存帧并比较像素和文字；文件刻意不以 `test_` 开头，普通测试发现不会引入媒体依赖：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 tests/independent_media.py -v
```

重点边界包括：CSV空行与带引号跨行字段的物理结束行、缺失值、人工复核门控、回合终点、模型收到证据后才能发布，以及人工标注不启用未校准追踪、不制造镜头切换。云协议用明确的假提供者测试，不代表实际云服务已验证。
