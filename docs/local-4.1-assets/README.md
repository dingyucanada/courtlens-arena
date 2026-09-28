# CourtLens Arena 4.1 本地产品验收材料

这是独立新增的 10 页本地验收说明；旧 18 页材料不参与本次构建。截图、解码帧、测试统计与发布清单保存在本目录，供交付包离线重建。图表数据读取仓库的 `data/demo.json`，由 `rehearsalProject` 和 `analyzePossession` 实际计算；动态镜头图读取 `tests/fixtures/dynamic-camera.json` 并调用 `projectAt`。这些数据与画面是合成演练，不能当作真实 NBA 数据或模型准确率。

## 重建

使用 Codex 的 `load_workspace_dependencies` 查询当前 Node、Python 与依赖目录。设置下列变量为当前环境的实际路径，再从仓库根目录执行：

```sh
export RUNTIME_NODE_MODULES='/path/to/bundled/node/node_modules'
export RUNTIME_PYTHON='/path/to/bundled/python/bin/python3'
export PRESENTATIONS_SKILL_DIR='/path/to/presentations/skills/presentations'
/path/to/bundled/node/bin/node tools/build_local_upgrade_deck.mjs
```

默认输出 `docs/CourtLens-Arena-4.1-本地产品验收.pptx`。`--draft` 只生成私有候选文件与 PNG 预览；`--output /absolute/path.pptx` 可生成另存版本。默认优先使用本目录冻结的截图与记录，不要求原验收工作目录仍然存在。若在原工作区更新了验收证据，用 `--live-assets --config /absolute/path/config.json` 明确更新。构建会运行 PPTX 包完整性、页面几何、原生图表/表格和字体检查，然后导入最终 PPTX 并逐页渲染 PNG。

## 资产与边界

- `watch.png`、`mobile.png`、`director.png`、`dynamic.png`：真实本地浏览器截图；PPTX 使用原生裁剪，没有重画界面。
- `frame0.png` 至 `frame2.png`：实际源视频解码帧；第三张请求 10.5 秒，实际 PTS 为 10.48 秒。
- `film.png`：实际静音 MP4 在成片 9 秒处的解码帧，对应源片 33 秒。
- `native-manifest.json`：原生发布清单，包含实际成片参数与输出字节 SHA-256；此目录不复制完整视频。
- `browser-audit.json`、`deck-config.json`、`statistics.json`：冻结的实际验收数字和图表计算结果。

测试次数分别统计 Node、Python 和浏览器流程，没有把跳过项计为通过。MP4 实测运行于 macOS；Linux 实机、AWS 部署、正式数据、正式视觉模型执行与 Portal 绑定/提交回执均未验证。AWS 页面是目标架构，T+50/T+70/T+90/T+120 是现场收敛目标，不冒称已完成陌生正式素材的全程计时验收。

PPTX 的流程图、图表和表格可编辑。最终文件以 Artifact Tool 导入渲染检查；这不等同于已在 Microsoft PowerPoint 中逐页打开检查。
