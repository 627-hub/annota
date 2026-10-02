# Annota 实现规划 v0.1

> 承接 [`product-spec.md`](product-spec.md) v1.1。先做 Tauri 壳 + MCP-first agent，再铺 UI/多媒态/AI/社交。
> 原则：**不重复造轮子；每个界面做完再做下一个；10MB 安装包 + 浏览器内置 agent 是 R1 核心卖点。**

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
| 1.6 设置 | ◐ 外观三档 + MCP 地址复制 + 默认词典链接模板（视频页 ⚙ 菜单）已做；同步/快捷键项待补 |
| 1.8 内置 agent 面板 | ⏸️ 搁置（MCP server 已就绪；聊天 UI + 调用审计尚未做） |
| 1.9 词库下线 | ✅ 完成（构建不再注入词库；词典外链替代） |
| 1.10 分发 | ✅ 完成（v0.1.0 已发布：dmg / exe / 扩展 zip / userscript + Pages 官网） |
| 1.11 测试 | ✅ 完成（geometry 单测 + smoke + MCP 工具冒烟，含新增 `words_at`） |

**移动端 M0（2026-10-02）**：✅ 同 Wi‑Fi 下观看端（只读 + 自动同步）真机验证通过；验证清单见 [`mobile.md`](mobile.md)。

### R2 多媒态（预计 3–4 周）

- 图片标注：`<img>` intrinsic 归一、长图滚动映射、画廊 SPA adapter
- 文章划词：`TextQuoteSelector`、高亮底层、评论侧栏
- Pack/我的库/起始页 支持混媒态

### R3 AI 协作（预计 3–4 周）

- `/suggest` AI 找词：云开放词表检测 → 虚线候选框 → 人确认
- 数据工作台（`/console`）
- Agent loop 增强：多轮调用、记忆上下文

### R4 社交层（预计 4–6 周）

- 发现页 / Feed 订阅 / 作者关注
- 信任管理与合并 diff 面板
- 轻后端（可选静态 Feed 聚合）

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
