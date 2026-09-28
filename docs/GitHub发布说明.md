> **2026-09-28培训修订：本文保留为历史公开演示发布说明。** 正式参赛改用私有仓库、CDK、指定AWS Agent服务及CloudFront，详见[新策略](参赛策略与产品方案.md)和[AWS迁移方案](培训后AWS架构与迁移方案.md)。本文原有实现描述不能作为正式云要求已通过的证据。

# CourtLens Arena v4 · GitHub 发布说明

文档日期：2026-09-28。本版本是产品演练交付；正式赛事提交规格与官方素材仍待公布，公开发布不代表已完成赛事提交。

- 源码：[GitHub 仓库](https://github.com/dingyucanada/courtlens)
- Arena v4：[公开根首页](https://dingyucanada.github.io/courtlens/)
- Studio v3 保留入口：[studio.html](https://dingyucanada.github.io/courtlens/studio.html)
- 旧证据演示：[demo.html](https://dingyucanada.github.io/courtlens/demo.html)
- 产品包：[GitHub Releases](https://github.com/dingyucanada/courtlens/releases/latest)

## 发布布局与保存范围

本版本构建根页为 Arena v4，包含智能观赛、战术实验室、故事导演及素材与校准。项目、修订和原视频 Blob 保存在当前浏览器、当前网址来源的 IndexedDB 中；导入内容不会因使用 GitHub Pages 而上传。项目 JSON 备份不包含原视频，请另行保管原件。

`studio.html` 保留 Studio v3；`demo.html` 保留固定合成证据演示。原 Python / SQLite / FFmpeg 工作台只在本机 `projects.html` 运行。三套项目存储互不自动同步，相关旧版文档只解释其各自入口，不替代 [Arena v4 使用与验收](Arena-使用与验收.md)。`pro/` 只有 Arena 模块，不是独立网页入口。

GitHub Pages 仅提供静态应用，不运行 Python、中文配音或模型服务。浏览器可以实际录制无原音 WebM，最长 180 秒；保持录制标签页前台，下载后再关闭。中文 MP4 配音和本机持久成片下载需要本机服务与已安装工具；具体依赖与已验证平台见 Arena 验收文档。

## 构建与维护

在项目根目录运行：

```sh
python3 tools/build_site.py --output site-dist --presentation docs/CourtLens-Arena-产品与参赛方案.pptx
```

构建器只接受公开静态文件白名单，核对合成演练原片的字节指纹，并拒绝已有输出目录中的未知文件或符号链接。构建内容包括 Arena、兼容入口、合成演练和产品 PPT；不包含本机用户工作区、数据库、密钥或临时日志。

修改源码后按 [README 的验证命令](../README.md#验证与发布) 复跑对应检查。原v4曾推送 `main` 后自动部署。当前4.1已改为手动触发历史合成演示发布，普通推送只做检查；实际发布状态以该提交对应的 Actions 结果为准。Linux 检查与 macOS 本机语音的实测范围分别记录，缺失依赖导致的跳过不算通过。

本机启动使用：

```sh
python3 tools/launch.py --port 8765
```

启动器构建静态文件并仅绑定 `127.0.0.1`，不自动安装依赖。Arena 本机入口为 `/arena/`，Studio 为 `/studio/`，旧工作台为 `/projects.html`。Windows 启动脚本存在不代表 Windows 配音或完整实机录制已验收。

## 当前交付物与版本一致性

当前 Arena 路演稿是 [18 页产品与参赛方案](CourtLens-Arena-产品与参赛方案.pptx)，真实浏览器成片为 [arena-browser-story.mp4](../media/arena-browser-story.mp4)。[PPT 校验记录](arena-assets/deck-validation.json) 与 [浏览器成片校验](arena-assets/browser-export-validation.json) 记录各自文件指纹和实测范围。旧版 PPT 或旧工作台报告不能替代这些 v4 验收记录。

产品 ZIP 从明确的最终 Git 提交读取源码白名单，并附逐文件大小、SHA-256 和提交标识；不从尚未提交的工作目录拷贝文件。发布前应核对 ZIP、PPT、成片与仓库提交对应一致。仓库公开地址存在不表示正式比赛的指定仓库、队伍资料和提交格式已经确认。

来源与第三方材料的范围见 [NOTICES](../NOTICES.md)。所有随包分析数据和原始比赛演练视频仍为合成，真实 NBA 数据、真实 Bedrock / Ollama 调用和正式赛事条件应在下一轮独立验收。
