# Annota 实现规划 v0.2

> 承接 [`product-spec.md`](product-spec.md) v1.2 与 [`roadmap.md`](roadmap.md)。先做 Tauri 壳 + MCP-first agent，再铺 UI/多媒态/R3a/社交。
> 原则：**不重复造轮子；每个界面做完再做下一个；10MB 安装包 + 浏览器内置 agent 是 R1 核心卖点。**
> **R3 拆分（v1.2 A9）**：AI 押后到 R3b，先做 R3a（数据工作台 + 通用 tag + 批量导出）；R4 重定义为**小组共享**（Group + 片单 + 组页），不做通用社交网络。

---

## 0. 关键调研结论（省时间的轮子）

| 问题 | 成熟方案 | 决策 |
|---|---|---|
| Tauri webview 截图 | ① `wry` 上游 PR #1674（2026-02 已合并）`WebView::screenshot()` — 原生截 viewport，macOS/Win/Linux 全支持；② fallback `tauri-plugin-screenshots`（xcap 窗口截屏） | **主用 wry screenshot API**，Tauri 版本需 ≥ 该 PR 合并后的 release；fallback 备用 |
| 富剪贴板 | Tauri 官方 `tauri-plugin-clipboard-manager` v2：`writeImage` / `writeText` / `writeHtml` | **直接用官方插件**；豆包 fallback 写 image+text/html |
| MCP server in Tauri | `tauri-plugin-mcp-server`（基于 `rmcp` + `axum`，stdio/SSE）；或自搭 `rmcp` + `axum` | **先 spike `tauri-plugin-mcp-server`**；若太厚重则自搭最小实现 |
| Claude Desktop 接 Rust MCP | 已知 Rust stdio server 会被 Claude Desktop 断开；需 Node wrapper，或主推 Hermes/SSE | **Claude Desktop 用 Node wrapper 配置；Hermes / 内置面板走 SSE/直接调用** |

---

## 1. 技术栈终局

| 层级 | 选型 | 说明 |
|---|---|---|
| 桌面浏览器壳 | **Tauri v2 (Rust)** | ~10MB 包；WebView 注入 `src/core.js`；Rust sidecar 通道 |
| 注入标注核心 | 现有 `src/*.js`（`geometry.js`/`adapter.js`/`core.js`） | 不动逻辑；加一层 `window.__ANNOTA__` 桥接 Tauri API |
| 本地服务 / MCP | Rust（`axum` + `rmcp` 或 `tauri-plugin-mcp-server`） | 端口 8793；同时提供 HTTP 同步 API + MCP server |
| 截图 | `wry` screenshot API / `tauri-plugin-screenshots` | 见上 |
| 剪贴板 | `tauri-plugin-clipboard-manager` | 见上 |
| 同步协议 | 现有 Pack/Feed + HTTP API（向后兼容） | Python `sync_server.py` 逻辑迁移到 Rust |
| AI backend | 豆包/Ark API via Rust server（function calling） | 内置 agent 面板用；外部 MCP host 也可用 |
| 数据存储 | IndexedDB（前端）+ `data.jsonl` / `NOTES_DIR` | 本地优先 |
| 页面态 UI | Tauri WebView 内嵌页面（React/Vue/Svelte 或纯 TS+DOM） | 建议轻量框架；页面态自由度完整 |
| 注入态 UI | 纯 JS + 内联 CSS（Shadow DOM） | 与现有 userscript 一致，保持自包含 |

---

## 2. 架构（文字 + ASCII）

```
外部 Agent 宿主              Annota 内置 Agent 面板
(Claude Desktop/Hermes)            (Tauri WebView)
        │                                │
        ├──── MCP stdio ────┐            │
        ├──── MCP SSE ──────┤            │
        └───────────────────┼────────────┘
                            ▼
                  [Annota Tauri 后端 (Rust)]
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   [MCP server]        [同步 API]        [截图/剪贴板]
        │                   │                   │
        ▼                   ▼                   ▼
   function calling    HTTP/Pack/Feed      wry screenshot
   (Ark/豆包 API)                            + clipboard plugin
        │
        ▼
   [data.jsonl / IndexedDB / NOTES_DIR]
        │
        ▼
   [src/core.js 注入到 B站/YouTube/抖音/任意网页]
```

**关键桥接**：Tauri WebView 里运行 `src/core.js`（userscript 模式）。当 core 需要截图/同步/笔记时，检查 `window.__ANNOTA__`：
- `__ANNOTA__.captureFrame()` → Rust `wry::screenshot`
- `__ANNOTA__.sync(payload)` → Rust HTTP client → 本地服务
- `__ANNOTA__.saveNote(...)` → Rust → NOTES_DIR + data.jsonl
- `__ANNOTA__.copyToClipboard({image, text, html})` → clipboard plugin

这样同一套 `core.js` 在 extension/userscript 里走现有通道，在 Tauri 里走 Rust 通道。

---

## 3. 实现阶段

### R0 基础（预计 3–4 周）

**目标**：Tauri 浏览器能跑起来，能截图，能接 MCP，同步 API 可用。

| # | 任务 | 验收 |
|---|---|---|
| 0.1 | `app/annota/` Tauri v2 项目脚手架；保留 Electron 目录不动 | `cargo tauri dev` 能启动空窗口 |
| 0.2 | 注入桥：Tauri WebView 加载现有 `dist/annotate.user.js`（或内嵌 core），暴露 `window.__ANNOTA__` | 在 B站页面上能看到现有 GlassDock（或至少标注功能可用） |
| 0.3 | 集成 webview 截图：主路径 `wry::screenshot`，fallback `tauri-plugin-screenshots` | 在 B站视频页调用 `captureFrame()` 返回 PNG base64，画面与肉眼所见一致 |
| 0.4 | 集成官方剪贴板插件：`writeImage` + `writeText` + `writeHtml` | 能把截图+上下文文本一起写入剪贴板，粘贴到豆包可见图 |
| 0.5 | MCP server 脚手架：stdio + SSE；暴露 hello-world tool | Claude Desktop/Hermes 能连上并调用 hello tool |
| 0.6 | 同步 API 迁移：Python `sync_server.py` → Rust `axum`，保持 `/api/health`、`/api/list`、`/api/anno/<id>` 不变 | 现有 extension/userscript 仍能 `⇅ 同步` |
| 0.7 | 设计系统 tokens 落地：CSS 变量/内联样式生成器 | 页面态和注入态组件能用同一套颜色/圆角/玻璃 |

### R1 MVP（预计 5–7 周）

**目标**：一个好看、顺手、内置 agent 的 Annota 浏览器，GitHub 可下载。

| # | 任务 | 验收 |
|---|---|---|
| 1.1 | **GlassDock**：玻璃胶囊工具坞，可拖拽、环境感知、二级菜单 | 右下圆钮展开，视频/图片/文章页显示对应工具组 |
| 1.2 | **EditorCard**：词必填、释义/词性选填、查词外链、时间 scrubber | `D` → 框选 → 输词 → `Enter` 保存，全程 ≤6s |
| 1.3 | **SidePanel**：时间轴 / 生词本 / 来源三 tab | 点击条目 seek + flash 对应框 |
| 1.4 | **起始页**：搜索框、三步引导卡、查词工具行、继续标注卡 | 新用户零数据时无假推荐 |
| 1.5 | **我的库**：左栏媒体列表 + 右区标注表/生词视图 | 可编辑/删除/批量导出 Pack |
| 1.6 | **设置**：外观/同步/词典/AI/快捷键/数据 | 可改默认词典链接模板 |
| 1.7 | **Onboarding**：触发式三步气泡 | 新用户 3 分钟内完成首条标注 |
| 1.8 | **内置 agent 面板**：SidePanel 聊天 UI + function calling + MCP tools 调用审计 | 用户说「这个词在画面哪里？」→ agent 调 `capture_frame` + `words_at` 回答 |
| 1.9 | ~~**词库下线**：移除 `src/vocab.js`、`build_vocab.py`、内联 vocab.json~~ | ✅ 2026-10-02 完成，注入产物约 27.8 KB gz |
| 1.10 | **分发**：GitHub Releases（Tauri dmg/exe）+ 扩展 zip + userscript + GitHub Pages 官网 | 用户从 release 下载 dmg 双击可用 |
| 1.11 | **测试**：geometry 单测；Tauri 截图/MCP 冒烟 | 改 `src/*.js` 仍跑 `build.py` + 单测 |

**进度（2026-10-02）**

| 项 | 状态 |
|---|---|
| 1.1 / 1.2 / 1.3 / 1.4 / 1.5 / 1.7 | ✅ 完成（1.3 时间轴/词汇/来源三 tab；1.5 支持条目编辑/删除） |
| 1.6 设置 | ✅ 完成（外观三档 / MCP 地址 / 词典模板 / 同步地址与自动同步开关 / 三个快捷键改键 / AI endpoint 与模型名）；设置 API `GET·PUT /api/settings` |
| 1.8 内置 agent 面板 | ✅ 完成（后端 `agent_run`/`agent_chat`/`agent_cancel` + `annota-agent-tool` 审计 + 写操作确认闸门；SidePanel「助手」tab UI）；契约见 [`agent-panel-ui-handoff.md`](agent-panel-ui-handoff.md) |
| 1.9 词库下线 | ✅ 完成（构建不再注入词库；词典外链替代） |
| 1.10 分发 | ✅ 完成（v0.1.0 已发布：dmg / exe / 扩展 zip / userscript + Pages 官网） |
| 1.11 测试 | ✅ 完成（geometry 单测 + smoke + MCP 工具冒烟，含新增 `words_at`） |

**移动端 M0（2026-10-02）**：✅ 同 Wi‑Fi 下观看端（只读 + 自动同步）真机验证通过；验证清单见 [`mobile.md`](mobile.md)。

**已知待修（UI 排版）**：设置页 AI 状态文字较长时会在窄列内换行破词（如 `https://ark.cn-` 被截断）。需要给 `.ai-status span` 加 `overflow-wrap:anywhere` / `word-break:break-word`，或改为单行省略（`text-overflow:ellipsis; white-space:nowrap; overflow:hidden`）。截图见 `docs/assets/settings.png` 底部。

**R2 进度（2026-10-02）**

| 步 | 状态 |
|---|---|
| Step 0 接缝重构 | ✅ 完成（新增 `src/media.js`，`core.js` 全量 `state.video` → `state.binding`；行为零变化） |
| Step 1 Schema 与合并规则 | ✅ 完成（`box\|quote` 二选一：`validAnchor`/`same`/`merge_entries` 三处同步放开；`format` 回显取代硬编码 `0.1`；`media.type`/`media.mediaId` 双写）。测试：Rust 6 例 + Python 7 例 + 端到端 quote 存活/去重/format 回显 |
| Step 2 图片标注 MVP | ✅ 完成（`ImageBinding` + `A.findImage`/`imageSupported` + 无时间轴 UI；`dev/smoke-image.mjs` 通过；`dev/image.html` 调试页）。Tauri 内截图留档待补 |
| Step 3 长图与画廊 SPA | ✅ 完成（`VAGeo.intersects`/`scrollMap` 长图视口剔除；图片 `mediaId` 用 `currentSrc` hash，换图换 key）。geometry 11 例 + smoke-image 画廊断言通过 |
| Step 4 我的库/首页/MCP 混媒态 | ✅ 完成（库/首页媒态图标与标签、`renderEntries` 按 type 分流、`render_note` 三态分流、`words_at` 非视频忽略时间窗）；merge_rules 10 例通过 |
| Step 5 文章划词 | ✅ 完成（`src/textquote.js` TextQuoteSelector 纯函数 + `ArticleBinding` + 划词 UI；`findArticle` 三级退化）。textquote 7 例 + smoke-article 通过 |
| Step 6 选对象/去猜主图/图片校验 | ✅ 完成（dock「选对象」picker + 自动绑只做确定信号 + 图片版本校验 `imgStale`；顺修壳丢失/overlay 视口定位/showAll 不重绘）。smoke-picker 通过 |

**规划调整（2026-10-03，product-spec v1.2）**

- **R3 拆分为 R3a / R3b**：AI（`/suggest`、AI 辅助建议、agent loop）**押后**到 R3b（等模型选型 + 数据基线）；
  先做 **R3a**（数据工作台 + 通用 tag §8.3 A + **批量导出**）。
- **R4 重定义为「小组共享，非社交网络」**：Group + 共同片单 + 组页 permalink + W3C 互通；赞踩/点数/发现**有密度后再做**。
- **批量导出（新增）**：标注时点截图（仅本条文本 + 热力框）+ 词汇/句子要素 → Anki/CSV/JSONL。
- 依据文档：[`roadmap.md`](roadmap.md)（竞争格局 / 四层清单 / 分期 / 导出规格）。

### R2 多媒态（预计 3–4 周）

> 详细实施方案（接缝重构、图片/长图/画廊/文章划词分步做法、测试规范）见 **[`r2-plan.md`](r2-plan.md)**。

- 图片标注：`<img>` intrinsic 归一、长图滚动映射、画廊 SPA adapter
- 文章划词：`TextQuoteSelector`、高亮底层、评论侧栏
- Pack/我的库/起始页 支持混媒态

### R3a 数据可见 + 学习闭环（非 AI，预计 2–3 周）

> 从原 R3 抽出的**非 AI**部分：不依赖模型选型，先把数据引擎变现与学习闭环跑通。

| # | 任务 | 验收 |
|---|---|---|
| a.1 | 数据工作台 `/console`：总量卡 / top 媒体 / 词频 / 时刻分布 / 一致性 | 一键导出训练集 JSONL（对齐 spec.md §9.2） |
| a.2 | 通用批注 / 自定义 tag（product-spec §8.3 A）；文案去语言化 | 纯评论标注（word 可空）+ 自定义 tag 可用 |
| a.3 | **批量导出**（product-spec §6.14）：标注时点截图（**仅本条**文本 + 热力框）+ 词汇/句子要素 → Anki/CSV/JSONL | 我的库选中媒体 → 一键出带截图的 `.apkg`；共享 Pack 不含截图 |
| a.4 | `renderOnly(entry)` 单项渲染 + `seek(t)` 等帧稳定后截帧 | 截图只出现本条标注的框与文本 |

**R3a 进度（2026-10-03）**

| 项 | 状态 |
|---|---|
| a.3 批量导出 | ✅ 完成（`src/export.js` 驱动 + 我的库「批量导出…」入口 + `app/service/anki_export.py` 标准库 `.apkg` 写出器 + `sync_server.py` 三个端点）。测试：`dev/anki_export.test.py`、`dev/export_server.test.py`、`dev/smoke-export.mjs` 通过 |
| a.4 单项渲染/等帧 | ✅ 完成（`drawEntry`/`renderOnly`/`renderLock`/`setChromeHidden`；等帧走 `seeked`+rVFC，超时降级为纯文字卡） |
| a.1 数据工作台 `/console` | ✅ 完成（`app/service/console.html` 单页：总量/按媒体/词频 + 训练集 JSONL/CSV/JSON 导出；Python `/console` 路由 + Rust axum `/console`；工作区导航加入口） |
| a.2 通用批注/自定义 tag | ✅ 完成（决策：**word 可空**、**词典按 tag 触发**）：editor 词性→标签 chips + 文案去语言化；校验放宽 `box\|quote` + (**word \| tags \| comment** 至少一个)，core/Python/Rust 三处对齐；渲染/面板/导出空词回退标签；`schemas/annotation.schema.json` 增 `va:tags`/`va:comment` |
| **Tauri 原生通道** | ✅ 完成（`app/annota/src/apkg.rs` Rust `.apkg` 写出器 + `sync_server.rs` axum `/api/export/card|finalize|exports/*`；桥新增 `__ANNOTA__.navigate`，库页在桌面端直接驱动内置 webview 跳转并复用 `#annota-export=` 自启）。测试：`cargo test` 8 例通过（含 apkg 结构校验） |
| 真机截图验证 | ✅ 已验（2026-10-03）：桌面端全链路跑通（库页→内置 webview→自动导出→下载 `.apkg`）。**发现并修复**整窗截图（`captureFrame` 漏裁剪）；随后针对"画面/时机"再改：跳转后等 2s、每条间隔 1.2s、截前 pause → 再升级为**手动确认模式**（见下） |
| 截图时机/对齐 | ✅ 手动确认（默认开）：`seek(t+0.15)` + pause + `renderOnly` 单条框 → 确认条（带实时时间码/回到标注点/截图/跳过）→ 用户手动拖过则**以当前帧为准回写 `t`+`updated`**。解决"框滞后/停在上一条" |
| 导出文件名 | ✅ 改为 `annota_<视频号>.apkg`（不再把中文 deck 名洗成下划线） |
| 卡片格式 | ✅ 正面=单词；背面=词+截图+释义/词性+来源；标签=固定 `annota` + 用户选的语言学习类 tag |
| OCR 代码审查 | ✅ 已跑（24 文件/35 条），critical/high/medium 全修（详见 [`progress-2026-10-03.md`](progress-2026-10-03.md)） |

**同步模型重构（2026-10-03，真机验收后）**：把「显示 / 覆盖 / 推送」三步拆开（见下），修掉"库里改完、视频页被还原"的根因。

- **显示**：打开视频页只读选版——服务器更新则显示服务器版；本地有未同步离线改动则弹窗选看哪版；**显示不写数据**。
- **覆盖**：服务器更新、本地没动 → 弹一次"是否用服务器版覆盖本地"，带「以后不再询问」记忆。
- **推送**：`⇅ 同步` = 把**当前显示的这版**推到服务器（**本地为主**；服务器=云存储/分享/公开），`replace:true` 整包替换。
- **删除**：本地删只影响本地，点同步才推到服务器。
- **entry 加 `updated`**：合并/多用户版本管理用；服务器保留冲突双方（R4 版本 UI 预留）。
- 测试：`dev/sync_replace.test.py`（replace/updated 透传/无词区分）；三处校验（core/Python/Rust）对齐。

### R3b AI 协作（押后，触发条件见下）

> **触发条件**：① 云开放词表模型选型定（product-spec §16 #4）；② 有可用数据基线（R3a 工作台产出）。
> 在此之前不做，避免在不确定的模型/成本上押注。

- `/suggest` AI 找词：云开放词表检测 → 虚线候选框 → 人确认
- **AI 辅助标注**：划词/框选后点「AI 建议」→ 模型读选区上下文，判断 tag + 生成草稿，人确认后落库（复用内置 agent / MCP tool loop）
- AI 引导词自定义；Agent loop 增强：多轮调用、记忆上下文

### R4 社交层：小组共享，非社交网络（预计 4–6 周）

> 重定义依据：product-spec §9、[`roadmap.md`](roadmap.md) §1–4、[`architecture.md`](architecture.md)。核心对象 = **Group**，逐级放开。
> 架构接缝（ADR-1/2）：本地服务与托管服务分两个部署目标、共用同一契约；同步 **云默认 / 本地兜底 / 公开可匿名读**，本地服务降级不取消；登录绑高意愿动作，不拦浏览。

| 期 | 内容 | 验收 |
|---|---|---|
| **R4a 私组** | 私密 Group + 共同片单 ContentList + 组内同步列表 + 私密组页 | 同组两人各自标注在组页可见 |
| **R4b 公开组页 + 互通** | 可选假名轻账号 + private/public + tag + 公开组页 permalink + **W3C 导入/导出（对接 Hypothesis）** | 公开组页可分享且可被标准工具导入；私密组不公开 |
| **R4c 镜头对齐** | shot/take 分割（**边播边采帧**，不搬媒体）+ **从标注点向两端对齐镜头** + 计数器 | 标注自动获得镜头长度的片段（R5 训练样本） |
| **R4d 社交机制** | 赞踩 / 点数（防刷+审核）/ 关注 / 发现 / 热门 | **有密度后**才做；不做全局空榜 |

> 后端形态（product-spec §16 #6）：**组后端 = Git 仓库（GitHub/Gitee Contents API），零自建服务器**；组页走 Pages；不建媒体云；身份本地密钥起步（§16 #3），OAuth 留 R4b。
> **详细方案见 [`r4-plan.md`](r4-plan.md)**（GroupStore/GitStore、group.json/packs 结构、邀请令牌、分层渲染、R4a 六步）。

---

## 4. 关键决策点（本周要拍）

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| D1 | MCP server 实现方式 | A. `tauri-plugin-mcp-server`；B. 自搭 `rmcp` + `axum` | **先 A 做 spike**（1 天），若 API 不顺或太厚重切 B |
| D2 | 页面态 UI 框架 | A. 纯 TS+DOM（轻）；B. Svelte（编译轻、产物小）；C. React | **A 或 B**；React 对 10MB 包不友好 |
| D3 | `core.js` 在 Tauri 里的加载方式 | A. 直接注入 `dist/annotate.user.js`；B. 内联编译进 Tauri 资源 | **A**（保留与 extension/userscript 同源，减少分叉） |
| D4 | 域名/仓库名 | `annota.app` / `annota.dev` / GitHub `annota-browser` | 本周查可注册性 |

---

## 5. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| `wry::screenshot` 不在当前 Tauri stable | R0 blocker | fallback `tauri-plugin-screenshots`（xcap 窗口截图），先让功能跑通再优化 |
| Claude Desktop Rust stdio 断开 | 外部 agent 体验 | 提供 Node wrapper 配置；主推 Hermes/SSE；内置 agent 面板不依赖外部 host |
| Tauri WebView 与平台播放器兼容性问题 | B站/抖音/YouTube 叠层异常 | 保留现有 adapter.js 平台逻辑；逐平台实机测试 |
| R1 范围膨胀 | 延迟 | 严格执行「界面做完才下一个」；data 控制台/AI 找词/社交不进 R1 |

---

## 6. 本周立即开始（Day 1–3）

1. 创建 `app/annota/` Tauri v2 项目脚手架。
2. 验证 `wry::screenshot` 在当前 Tauri stable 是否可用；不可用则换 `tauri-plugin-screenshots`。
3. `tauri-plugin-mcp-server` hello-world spike：暴露一个 `capture_frame` tool，stdio/SSE 都能调通。
4. 查 `annota.app` / `annota.dev` / `annota-browser` 域名与 GitHub 组织名可注册性。
5. 在 `product-spec.md` §16 关闭已解决的 open items（截图/剪贴板/MCP transport），或等 R0 后再更新。

---

## 7. 与外部 Agent 的集成说明

**Claude Desktop**：通过 `claude_desktop_config.json` 配置一个 Node wrapper（wrapper 启动 Annota MCP server 二进制并转发 stdio）。这是当前 Rust MCP server 的已知兼容做法。

**Hermes**：通过 SSE URL（如 `http://127.0.0.1:8793/mcp/sse`）直接连接；Hermes 作为 MCP client 调用 tools。

**Annota 内置 agent 面板**：不走 stdio/SSE，直接调用 Tauri 命令 → Rust backend → 同一套 tool 实现。UI 显示每次 tool call 的可展开审计卡片。

**记忆系统**：agent 可调 `list_annotations`、`words_at`、`get_recent_media`、`get_notes`，把 `data.jsonl` + IndexedDB 当作长期记忆。新标注/笔记通过 `add_annotation`、`save_note` 写入，写操作默认需用户在 UI 确认。
