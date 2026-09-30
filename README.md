# video-annotate · 内容标注层

> 给「别人的内容」加一层**可共享的标注**——**视频 / 图片 / 文章皆可**；众包积累标注与对话数据，
> 最终训练一个 **JEV 式 word↔region（词↔画面区域）决策模型**。
>
> **不生产内容、不托管媒体。** 只解决「标注 → 合并 → 分发 → 渲染 → 训练」的技术问题。
> 资产是用户投入时间积累并共享的标注数据；数据属于标注者，可导出、可自持、去中心化交换。
>
> **定位**：不止数据标注，更是「**内容之上的社交标注层**」。扩展方向见 `docs/spec.md §15` 与 `HANDOVER.md §7`。

## 定位
- **主题**：AI 应用 + 视频标注大模型。
- **首个应用场景**：语言学习（在平台视频上把词锚到画面区域，查词/收词）。
- 与 `../ielts-7.5` 的关系：本项目从那里拆出；词库/SRS/Anki 等作为**可选下游消费者**复用，不构成依赖。

## 三种用法（越来越「下载即用」）
| 方式 | 说明 |
|---|---|
| **MV3 扩展** | `app/extension/`；桌面 `chrome://extensions` 加载已解压，或 `bash dev/portable.sh <url>`（独立资料夹，不动日常浏览器）。请求走扩展后台，**绕过 CORS/混合内容** |
| **userscript** | `dist/*.user.js`，装进任意管理器（三端通用；手机只读用观看端） |
| **自建浏览器** | ★ `app/browser/`（Electron）：打开即浏览器、内置标注、零配置。`bash dev/app.sh` |
| **开源浏览器自带油猴** | 手机装 **Ezo / GuaBrowser / Solipsism / Cromite** 任一个，扫码装脚本即可（见 [`docs/browser.md`](docs/browser.md)） |

## 快速开始（一条命令）
```bash
python3 dev/hub.py
```
它会：探测本机地址 → **把同步地址烧进脚本（零配置）** → 构建 → 起两个服务 → 打开**入口页**（含手机二维码）。
入口页三件事：**手机扫码安装 / 电脑点击安装 / 先试玩**。之后在 B站视频上点 `⇅ 同步` 即可，不用配任何东西。

## 现状
- 阶段：**P0 可用**。完整设计见 [`docs/spec.md`](docs/spec.md)。
- 已能：任意 `<video>` 拖框绑词（**中英联想**）、**可调时刻/时长**、本地存储、**一键 `⇅ 同步`**、导入导出、B站/抖音适配、诊断面板、**🤖 AI 陪练（豆包 + 截图 + 语音）**、**📝 笔记导出（Obsidian）+ 数据沉淀**。
- 词库：内联 **11,821 词**（雅思+托福，来源 `../ielts-7.5`），`dist/annotate.user.js` 约 735KB。
- 终局模型：JEV 式决策（`Choice` / `Noul` / `Score` 三原语，prefill-only 概率，不生成）。

## 交付形态：自建浏览器（品牌）+ 扩展/脚本（铺量）
> 目标：**让用户知道「这是个标注浏览器，下载即用」**——无论是英语/小语种情境学习，还是通用视频数据标注。

| 形态 | 用途 | 状态 |
|---|---|---|
| **`app/browser/`（Electron 自建浏览器）** | 品牌载体：打开即浏览器、内置标注、零配置 | ✅ 可运行（`bash dev/app.sh`） |
| **`app/extension/`（MV3 扩展）** | Chrome/Edge 铺量，一键安装 | ✅ 可加载 |
| **userscript（三端 + 只读观看端）** | 任意管理器 / 手机只读 | ✅ |
| Android 自带油猴引擎的开源浏览器 | 手机端零 fork | 见 [`docs/browser.md`](docs/browser.md) |

- 桌面扩展：Chrome/Edge（`chrome://extensions` 加载 `app/extension/`）；Safari 用 Userscripts。
- 手机只观看不编辑：装「观看端」变体（只读 + 打开即自动同步）。
- 安装细节见 [`docs/install.md`](docs/install.md) / [`docs/mobile.md`](docs/mobile.md) / [`docs/browser.md`](docs/browser.md)。

## 结构
```
video-annotate/
├── docs/spec.md           # 设计文档（数据模型/共享/模型路线）
├── docs/install.md        # 各端免费宿主 + 安装
├── docs/sync.md           # 同步：上传/下载
├── docs/ai.md             # AI 陪练（豆包/OpenAI 兼容）
├── docs/notes.md          # 笔记导出（Obsidian）+ 数据沉淀
├── docs/mobile.md         # 移动端测试（局域网）
├── schemas/               # W3C Web Annotation 对齐的 JSON Schema
├── src/geometry.js        # 内容区坐标（可单测）
├── src/adapter.js         # 平台：bilibili/douyin/youtube/generic
├── src/vocab.js           # 中英词库联想（可单测）
├── src/core.js            # 叠层/拖框/绑词/时间/同步/导入导出
├── build_vocab.py         # ielts-7.5 词表 → dist/vocab.json
├── build.py               # src/*.js + vocab → dist/annotate.user.js
├── dist/annotate.user.js     # 脚本产物（@grant none）
├── dist/annotate.gm.user.js  # GM 变体（GM_xmlhttpRequest，移动端/https 同步用）
├── dist/vocab.json           # 轻量词库（雅思+托福 11,821 词）
├── app/browser/           # ★ 自建浏览器（Electron 壳，内置标注，下载即用）
├── app/extension/         # MV3 扩展（Chrome/Edge，铺量）
├── app/service/           # sync_server.py：单端口服务（静态 + 同步 API）
└── dev/                   # hub.py 一键入口 / serve.py / demo.html / 单测 / 冒烟
```

## 路线（详见 spec §10）
- **P0** 跨端 userscript 核心：任意 `<video>` 拖框绑词、本地存储、导入导出、内容区坐标 + 单测。
- **P1** 包成 MV3 扩展 + AI 建议框（云开放词表）+ 词库附义。
- **P2** W3C 兼容 Pack/Feed + 去中心化交换 + 客户端合并去重。
- **P3** 观看端叠加（他人标注）。
- **P4** 学习闭环（可选，接 `ielts-7.5`）。
- **P5** 平台适配（B站→抖音）。
- **P6** 轨迹/动作标注。
- **M0–M3** 移动端：Android 借扩展浏览器 → iOS 借脚本管理器（观看优先）→ 标注降级 → 自建 webview（可选）。
- **M** 终局：训 + 评测 JEV 式 word↔region 决策模型。

## 开发 / 调试
> 日常直接用 `python3 dev/hub.py`（一键）。以下是拆开手动跑：
```bash
python3 build_vocab.py             # ../ielts-7.5 词表 → dist/vocab.json（可选，已入库）
python3 build.py                   # src/*.js + vocab → dist/annotate.user.js（带 UTF-8 BOM）
node --test dev/geometry.test.mjs dev/vocab.test.mjs   # 单测（9 + 4）
node dev/smoke.mjs                 # 假 DOM 冒烟测试（抓运行时错误）
python3 app/service/sync_server.py # 单端口 8793：静态 + 同步 API（`/` 有入口页）
python3 dev/hub.py --tunnel        # 可选：https 隧道（手机跨网；国内域名可能被污染，见 mobile.md）
```
> 服务默认绑 `0.0.0.0`（便于手机访问），会暴露到局域网，仅可信网络使用。移动端步骤见 [`docs/mobile.md`](docs/mobile.md)。
> 静态与 API 同一端口（8793）且带 `charset=utf-8`；`dev/serve.py`(8792) 是纯静态备用。
- `dev/demo.html` 直接 `<script>` 引入 `dist/annotate.user.js`，**无需管理器即可本地测**。
- 真实用法：把 `dist/annotate.user.js` 装进免费管理器（桌面 TM/Violentmonkey，Apple 用 Userscripts）。

## B站适配说明
- 只在播放页启用（`/video/`、`/bangumi/play/`、`/cheese/play/`、`/festival/`、`/list/`），首页 feed 不打扰。
- 主视频优先取 `.bpx-player-video-wrap video` 等选择器，避免拿到悬停预览的小视频。
- 支持 SPA 切集（URL 的 BV/ep/ss 变化即换一份标注）。
- **已知限制**：`<video>` 元素**自身**进入真全屏时浏览器不允许叠加（此时右上会提示改用「网页全屏/影院模式」）；播放器容器全屏、网页全屏均正常。
- 右上工具栏点 **ⓘ** 打开诊断面板（platform/mediaId/video 分辨率/objectFit/rect/content/entries），实机排查截图用。

## 设计要点
- 数据模型对齐 **W3C Web Annotation**（`target`=视频+时间片段+归一化 box，`body`=词条），去中心化共享直接继承标准。
- **只共享标注**，不搬媒体；Pack 可托管任意静态 URL，客户端合并。
- `box` 为**左上角 `x,y,w,h`**（0–1），归一化到**视频内容区** + 记 `intrinsic`，兼容黑边/全屏/画中画/缩放。
- AI 只**提议 + 打分**，人确认（不做全自动、不做动作/跨镜头终审）。
