# 方案 · 2026-10-04（Annota 浏览器重构：Tauri 为主 + 编辑态分叉）

> 承接 [`progress-2026-10-04-mobile-viewer.md`](progress-2026-10-04-mobile-viewer.md)。
> 本文记录**方向决策**与 `@architect` 出的架构方案，作为后续里程碑（M1~M8）的执行依据。

## 0. 用户决策（本次，勿再讨论）

1. **Electron 壳降级**：不再投入；**冻结不删、保留末版**（`app/browser/` 目录保留，build.py 停发其 core.js）。
2. **重心放 Tauri**（`app/annota/`）。
3. Tauri 浏览器要做：**① 自动更新 ② 标签页 ③ 收藏（v1 扁平列表）**；**导航/工具栏重新优化**。
4. **编辑要有独立 edit 界面（侧边展开）**，与"正常观看"明确区分，方便快速编辑。
5. **Annota 浏览器与插件/userscript 版分道扬镳**：浏览器端要成为最好用、最方便编辑的形态，允许为浏览器端做更激进 UX。
6. **本机有 Xcode → macOS 做公证（notarization）**。
7. **收藏 v1 = 扁平列表**；**历史记录默认开**（本地-only、可一键清空）。

## 1. 总策略：分层分叉，不 fork core

- `src/` 引擎层（标注/合并/同步/AI 卡/geometry/adapter/media/group/export）**三端保持单份**。
- core.js 引入**一处接缝对象** `window.VA_BROWSER_SHELL`：预计 3–5 处 `if (window.VA_BROWSER_SHELL)`，全部集中在壳层创建/模式切换；**popover / 框选状态机 / `__ANNOTA_UI__` 禁止分叉**（契约红线）。
- 新增 `src/browser-shell.js`（浏览器专用壳：常驻抽屉、编辑态、观看态零干扰）；build.py 增第 4 变体 `annotate.browser.js`；Tauri 的 `ANNOTATE_JS` 改 `include_str!("../../../dist/annotate.browser.js")`。
- **防漂移**：`docs/shell-contract.md` + `dev/check-shell-drift.mjs`（CI 断言 core.js 中 shell 分支数量与位置）。
- 理由：框选捕捉层与 popover 锚定**页面坐标**，必须留在目标页面 webview；但 dock/panel 容器可替换。

## 2. 标签页方案

- **每 tab 一个 child webview，单窗口内 hide/show 切换**。否决多 window、否决 iframe（X-Frame-Options 会挡住 YouTube 等）。
- 新模块 `app/annota/src/tabs.rs`：`TabManager { tabs, active }` 放 `tauri::State`；命令 `tab_new/tab_close/tab_activate/tab_move`。
- `get_webview("browser")`（`main.rs` 6 处）统一改 `tabs.active_webview()`；`apply_layout()` 重构为 `layout_active()`；`TOOLBAR_HEIGHT` 常量改为查询 toolbar webview。
- 后台 tab 继续运行；休眠（>8 tab / 后台 >30min）二期做，一期设 12 tab 上限提示。
- 事件：`annota://tabs-changed`（全量）、`annota://tab-updated`（单条增量）。

## 3. 导航/工具栏重设计

- `public/index.html` 重写为**两行式**：Row1 标签条（40px，`+` + tab chips），Row2 导航条（48px，`← → ⟳` + omnibox + `★收藏` + `编辑` 切换 + `⋯更多` + 引擎状态）。
- 全屏/专注模式：toolbars `data-collapsed="1"` 收起（所以 toolbar 高度不能再是 Rust 常量）。

## 4. 编辑面：页面内常驻右侧抽屉（非模态）

| 态 | 触发 | 表现 |
|---|---|---|
| **观看**（默认） | 默认 / `E` 退出 | 热力框渲染、dock 隐藏、零干扰 |
| **编辑** | 工具栏「编辑」/ `E` / `D` | 右侧常驻抽屉（360–420px 全高）：头部=对象信息+`标注`+`选对象`+同步态；主体=复用 core `renderPanel`（时间轴/词汇/来源/助手）；页面内容区被抽屉遮住 |
| **框选进行中** | 抽屉内「标注」/快捷键 | 现有 `state.annotate` 流程原样；抽屉可收起让位 |

- core.js 的 `applyMode()` 增加 `shell.onModeChange(mode)` 通知；浏览器态用新标记 `va:shellMode ∈ view|edit`（避免与 userscript 的 `va:viewOnly` 语义纠缠）。
- 抽屉视觉扩写 `overlay-theme.js` 的 `.va-panel`（加 `.va-panel--docked`），只在 browser 变体生效。

## 5. 自动更新

- `tauri-plugin-updater` + CloudBase 静态托管 endpoint `.../app/latest.json`（沿用 build.py 的 DIST_BASE），GitHub Releases 作 fallback endpoint。
- 签名：`TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]` 存 `sec`（条目 `annota-updater-key` / `annota-updater-key-password`，已生成）+ GitHub secrets。公钥进 `tauri.conf.json`。
- **macOS 公证**：本机有 Xcode → 补 `xcrun notarytool` 步骤（避免 updater 覆盖安装被 Gatekeeper 拦）。
- 检查时机：启动后 5s + 每 24h；发现更新→工具栏「更多」出角标→用户确认后下载安装重启。

## 6. 收藏/历史/下载

- 本地 **SQLite**（`rusqlite` 已在 Cargo.toml，未用）：`src/store.rs` + 迁移表。
  - `bookmarks(id,url,title,favicon,folder,created_at,sort)`（v1 扁平，folder 留空）
  - `history(id,url,title,visit_at,tab_id)`（默认开、上限 5000 自动裁剪、可一键清空）
  - `downloads(id,url,filename,path,status,size,created_at)`
- 走现有 `sync_server.rs` 加 `/api/bookmarks`、`/api/history`（同 8793，`vaFetch` 通道）；历史写入在 Rust `on_page_load` 钩子内直接调 store。
- 下载用 Tauri `on_download` 钩子，流式写到 `download_dir()/Annota/`，进度经 `annota://download-progress` 推给工具栏。

## 7. 平板/响应式

- **Tauri 窗口层**：shell CSS + JS 断点（<720 / <520）。
- **userscript 层（iPad 主战场）**：`overlay-theme.js` 加 `@media (pointer: coarse)`（命中区 ≥48px、触屏默认展开、popover 输入 ≥16px 防缩放）——**只增不改**桌面规则，真机回归。
- Tauri iOS 原生壳列为远期研究，不承诺。

## 8. 里程碑（依赖顺序）

| M | 内容 | 触碰范围 |
|---|---|---|
| **M1** | 自动更新（updater + 公证 + latest.json 发布） | 仅 `app/annota/` + `release.yml` + `cloudbase/deploy.sh` |
| **M2** | Shell 接缝（core.js 分支 + `src/browser-shell.js` + build.py 第 4 变体 + 漂移检查） | **`src/core.js`（红线内小改）**、`build.py`、`overlay-theme.js` |
| **M3** | 标签页（拆 `tabs.rs`/`layout.rs` + `tab_*` 命令 + `apply_layout` 重构） | 仅 `app/annota/` |
| **M4** | 工具栏重设计（两行式 shell） | 仅 `app/annota/public/` + Rust 少量 emit |
| **M5** | 编辑抽屉（三态 + `E` 快捷键 + `.va-panel--docked`） | **`src/browser-shell.js`、`overlay-theme.js`、`core.js`（接缝扩展）** |
| **M6** | 收藏/历史/下载（store.rs + API + on_download） | 仅 `app/annota/` |
| **M7** | 平板/响应式收尾 | **`overlay-theme.js`** + `public/` |
| **M8** | Electron 冻结（README/HANDOVER 标注 deprecated；build.py 停发 browser core） | `build.py`、文档 |

- **最快见效**：M1（自动更新）+ M4 工具栏先行版。
- M3 与 M4 可并行；M5 依赖 M2+M3+M4；M6 可与 M5 并行。

## 9. 风险与回退

1. **M2 接缝引入**：全部走 `if (window.VA_BROWSER_SHELL)`，不注入时不改行为 → 回退=改回 `include_str!` 对象。
2. **`include_str!` 新鲜度**：`app/annota/build.rs` 加 mtime 检查，`dist/annotate.browser.js` 过期则 `panic!`。
3. **macOS 公证**（已决定做）：M1 上线前补 notarytool。
4. **多 webview 资源**：一期 12 tab 上限；二期休眠。
5. **core.js if 膨胀**：`dev/check-shell-drift.mjs` CI 卡点。

## 10. 执行进度

### M1 自动更新（已完成接线，待发布验证）

- [x] 生成 updater 密钥对：公钥写入 `app/annota/tauri.conf.json` `plugins.updater.pubkey`；
      私钥与密码存 `sec`（`annota-updater-key` / `annota-updater-key-password`）。
- [x] `Cargo.toml`：加 `tauri-plugin-updater = "2.13.1"`、`tauri-plugin-process = "2.4.0"`。
- [x] `main.rs`：注册插件；`spawn_update_check()`（启动 5s 后首查 + 24h 轮询，`emit annota://update-available`）；
      `install_update` 命令（`download_and_install` + `app.restart()`）；`build.rs` + `permissions/install_update.toml` + capabilities。
- [x] `capabilities/default.json`：加 `updater:default`、`process:allow-restart`、`allow-install-update`。
- [x] `public/index.html`：`.update-pill` + 订阅 `annota://update-available` + 点按调 `install_update`。
- [x] `release.yml`：macOS 公证（沿用现有 APPLE_* secrets）+ 收集 `.app.tar.gz`/`.sig` + 生成 `latest.json` + 推 CloudBase `app/latest.json`。
- [x] 本地 `cargo build` 通过。

**待办（需用户/GitHub 侧）**：
1. GitHub 仓库 Secrets 配：`APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD`/`APPLE_SIGNING_IDENTITY`/`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`（公证）+ `TAURI_SIGNING_PRIVATE_KEY`/`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（`sec get annota-updater-key` 的值）+ `TCB_ENV`（CloudBase 环境 ID）。
2. 打 tag（如 `v0.1.1`，需先把 `tauri.conf.json` version 提上去）验证一次端到端更新。
3. 首次发布后确认 `.../app/latest.json` 可达。

### M2 Shell 接缝（已完成）

- `src/core.js` 两处接缝：`mountShell()` 调 `VA_BROWSER_SHELL.adopt({dock,panel,overlay,toast,uiRoot,api})`；
  `applyMode()` 调 `VA_BROWSER_SHELL.onModeChange('view'|'edit')`。未注入壳时行为与旧版一致。
- 新增 `src/browser-shell.js`（M2 pass-through；M5 才实现抽屉）；`docs/shell-contract.md` 固化红线。
- `build.py` 增第 4 变体 `dist/annotate.browser.js`（无 userscript header/BOM、不含 `version-check.js`、
  烧本地同步地址、含 browser-shell）；Tauri `ANNOTATE_JS` 改指它。
- `app/annota/build.rs` 加新鲜度守护（产物缺失/比 src 旧则 `panic!` 提示先 `python3 build.py`）。
- `dev/check-shell-drift.mjs`（6 断言）：core 引用次数/位置、shell 不直连内部、变体纯净度；已挂 release.yml CI。
- 验证：Playwright 注入 mock `__ANNOTA__` 后 `data-va-shell="browser"`、shell 已 adopt；全量回归绿。

### M3 标签页（已完成）

- 新增 `app/annota/src/tabs.rs`：`TabManager`（`tabs`/`active`/`seq`）+ `TabState = Mutex<TabManager>`。
  - `active_webview(app)` —— 所有「当前页」操作的**唯一入口**（取代硬编码 `get_webview("browser")`）。
  - `create_tab/activate_tab/close_tab/move_tab/emit_tabs`；首个 tab id = `browser`（兼容 MCP），其后 `tab-<n>`。
  - 切换 = 目标 `show()+set_focus()`、其余 `hide()`；最后一个 tab 禁止关闭；最多 12 个（前端隐藏 `+`）。
- `main.rs`：
  - `.manage(Mutex::new(TabManager::new()))`；`setup_webviews` 首个 tab 改走 `tabs::create_tab`。
  - `run_tool` 5 处 + `navigate_browser`/`browser_action` 全改 `tabs::active_webview`。
  - `apply_layout` 只摆激活 tab；新增命令 `tab_new/tab_activate/tab_close/tab_move`（+ build.rs 清单 + `permissions/tabs.toml` + capabilities `allow-tab-manage`）。
  - 事件：`annota://tabs-changed`（全量）、`annota://tab-updated`（单条）。
- `public/index.html`：标签条（M3 先行版）+ `annota://tabs-changed` 渲染 + `Cmd/Ctrl+T/W`；`TOOLBAR_HEIGHT` 56→94（两行）。
- **运行验证**（`ANNOTA_TABS_TEST=1` debug 钩子）：建 3 tab → 切回首 tab → 关闭首 tab 自动激活相邻，且各 tab 独立真实导航；日志确认。`cargo check` 无警告。

### M4 工具栏重设计（已完成）

- `public/index.html` 重写为**两行式**：
  - Row1 标签条：可横向滚动 `.tabs-scroll` + `+`（≥12 隐藏）。
  - Row2 导航条：品牌 / `← → ⟳`（disabled 态）/ omnibox（站点图标+URL 回显+打开）/
    `★收藏` / `编辑`（态切换）/ `⋯更多` 菜单 / 引擎状态。
- 新增命令 `set_shell_mode(mode)`（Rust → `active_webview.eval("VA_BROWSER_SHELL.setMode(...)")`）：
  toolbar 的「编辑」按钮切换浏览器 webview 的观看/编辑态；`Cmd/Ctrl+E` 同效；态记 localStorage。
- omnibox 随激活 tab 回显（`annota://tab-updated`/`tabs-changed`）；新 tab 自动同步编辑态。
- ⋯ 菜单：历史 / 下载（M6 接口）/ 打开工作区 / 诊断。`Cmd/Ctrl+T/W/L` 快捷键。
- 验证：Playwright 载入 toolbar（mock 桥）→ 标签渲染/omnibox 回显/编辑切换（实发 `set_shell_mode`）/菜单展开，无 JS 报错；截图 `docs/assets/annota-browser-toolbar.png`。`cargo check` 无警告。

### M5 编辑抽屉（已完成）

- `src/browser-shell.js`：M2 pass-through → 常驻右侧编辑抽屉。
  - 三态：观看（默认，零干扰）/ 编辑（右侧常驻抽屉）/ 框选进行中（复用 core `toggleAnnotate` 流程，popover 原样）。
  - `buildEditBar()`：抽屉头部对象信息（标题/类型）+ 提示 + `标注 / 选对象 / 同步 / 来源`，全部经 `ctx.api` 调 core。
  - `applyShellMode()`：编辑态给 `ctx.panel` 加 `.va-panel--docked` 并 `api.togglePanel(true)`；观看态收起并清 `annotate/picking`；
    用 `.va-shell-hidden-dock`（`!important`）稳定隐藏 core 每帧重设的 dock。
  - `E` / `Cmd·Ctrl+E` 切换（`editableTarget` 规避输入框；capture + `stopImmediatePropagation`）；`storage` 事件同步外壳模式。
  - 契约：仅操作 `adopt()` 交出的 `dock/panel/uiRoot/api`；浏览器桥不存在时完全 pass-through。
- `src/overlay-theme.js`：`.va-panel--docked`（`top/right/bottom` 贴边、`min(400px,40vw)`、去圆角）+ `.va-shell-*` 编辑头样式 +
  `[data-va-docked]` 下 `.va-sources` 左移避让；`@media (max-width:720px)` 转底部弹出式抽屉（`56vh`、安全区、触屏网格布局）。
- `dev/check-shell-drift.mjs`：禁引用规则改逐行判断，放过 `api.`/`ctx.api.` 前缀的受控调用（仍拦裸 `toggleAnnotate`、`state.*`、`window.__VA`）。
- `src/core.js` **未改**：M2 接缝已交出 M5 所需 `toggleAnnotate/togglePicker/toggleSync/toggleSources/getState` 与 `onModeChange`，无需扩展。
- Rust `set_shell_mode` 命令 + 权限 + `public/index.html` 编辑按钮沿用 M4 接线。
- 验证：`dev/check-shell-drift.mjs` 6/6 PASS；抽屉渲染截图 `docs/assets/annota-browser-editdrawer.png`。

### 产品方向备忘

- `docs/ideas-training-data.md`：标注数据用于 AI 训练的 opt-in 公共数据集方向（授权/隐私/格式/激励），**暂不实现**。

### M6 收藏 / 历史 / 下载（已完成）

**后端（Rust）**
- 新增 `src/store.rs`：SQLite（rusqlite bundled）。DB 路径 `<store>/../annota.db`（debug 落在 `app/service/annota.db`）。
  三表 `bookmarks` / `history` / `downloads` + 迁移 + WAL/busy_timeout；`Db`（`Arc<Mutex<Connection>>`）可 Clone，跨命令 / axum handler / 钩子共享；经 Tauri `manage(DbState)` 托管。
  - history 默认开、**上限 5000**（插入后自动裁剪）、可一键清空。
- `sync_server.rs`：`AppState` 注入 `db`；新增路由
  - `GET/POST/DELETE /api/bookmarks`（POST 幂等；DELETE `?url=`）
  - `GET/DELETE /api/history`（`?limit=`，默认 200）
  - `GET/DELETE /api/downloads`
- `tabs.rs`：
  - `on_page_load`(Finished) → 记一条历史（仅 http(s)）。
  - `on_download` → 落盘到 `~/Downloads/Annota/<filename>`（清洗路径非法字符），写入 downloads，并 emit `annota://download-started` / `annota://download-finished`。
- `main.rs`：打开 Db → `manage(DbState)` → 传入 `run_server`；新增命令 `set_toolbar_expanded(expanded)`。

**工具栏展开机制（新增，必要）**
- 工具栏 webview 物理高仅 94px，任何下拉菜单/面板超出即被裁掉（M4 的 ⋯ 菜单在真机同样受此影响）。
- `set_toolbar_expanded(true)` → 工具栏增高 `PANEL_HEIGHT=420`，浏览器内容区自动下移；`false` 复原。历史/下载面板与「更多」菜单均在此展开区内渲染。

**前端（`app/annota/public/index.html`）**
- 收藏星标接后端：随激活标签刷新命中态；点击 POST/DELETE，星标真实点亮/熄灭。
- 「⋯更多」菜单：打开即展开工具栏；历史 / 下载 → 展开式面板（列表、相对时间 `fmtAgo`、清空、空态、关闭）。
- 下载事件 → 「更多」按钮角标 + 面板实时刷新；面板状态徽标（已完成/下载中/失败）、大小 `fmtBytes`、点条目复制路径。
- 面板：深色玻璃、约 420px 高、可滚动、与既有 toolbar/menu 风格一致。

**验证**
- `cargo test`：store 单测 3 项（bookmarks 幂等 / history 顺序+清空 / downloads 生命周期）全绿，连同既有共 **11/11**。
- Playwright（`pw`，mock 桥 + fixture）：**20/20** 通过；截图 `docs/assets/annota-browser-m6-panels.png`。
- 回归：`node --test dev/*.test.mjs` **23/23**；`node dev/smoke.mjs` OK。
- 注：`@frontend` 子代理本轮因服务端地域限制不可用，前端由主代理实现。

**与计划偏差**
- 计划写「进度经 `annota://download-progress`」；Tauri `on_download` 只提供 `Requested`/`Finished` 两个事件，无字节级进度 → 改为 `download-started` / `download-finished` 两事件（无百分比）。

### M6c omnibox 智能搜索（已完成）

**后端（Rust）**
- `store.rs`：`search_omnibox(q)` —— 历史 + 收藏按 `url/title LIKE %q%` 各取 5 条（历史按 `visit_at DESC`、收藏按 `created_at DESC`）；空查询直接返回空数组，不查库。
- `sync_server.rs`：`GET /api/omnibox?q=` → `{ok, result:{history,bookmarks}}`，走既有 `spawn_blocking` 通道。
- `main.rs`：`resolve_nav_url` 加**搜索引擎回落**（`ANNOTA_SEARCH_ENGINE` 可覆盖，默认 Bing）。判定顺序：
  `http(s)://` 原样 → `dev/` 走本地 → **含点且无空格**当域名 → **首段含点的路径**当 URL → 其余走搜索。
  修掉了旧实现把 `foo bar` 也当域名拼 `https://foo bar` 的问题。

**前端**
- omnibox 包一层 `.omnibox-wrap` 挂建议下拉：收藏区 / 历史区 / 底部「搜索『xxx』」回落行；`↑`/`↓` 键盘导航、`Enter` 选中、点外部关闭、输入 150ms 去抖。

### M6d 开发者工具（已完成）

- `Cargo.toml`：`tauri` features 加 `devtools`。
- `main.rs`：`open_devtools` 命令 → `tabs::active_webview()?.open_devtools()`。
- 权限：`core:webview:allow-internal-toggle-devtools` + `permissions/devtools.toml`。
- 「⋯更多」菜单加「开发者工具」项。
- ⚠️ macOS 上 WKWebView 需 Safari 16.4+；旧系统点了没反应属平台限制。

### M7 壳能力收尾（已完成）

**前置：TOOLBAR_HEIGHT 去常量化**（M4 欠的债）
- `main.rs`：`TOOLBAR_HEIGHT` 常量 → `TOOLBAR_HEIGHT_BITS`（`AtomicU64` 存 f64 bits，标准库无 `AtomicF64`）。
- 新增命令 `set_toolbar_height(height)`（`0 < h < 500` 才生效）→ 缓存进 static 并 `apply_layout()`。
- 工具栏 JS 在 `load` 后 100ms / 500ms 两次 + `window.resize` 上报实测高度
  （标签条 + 书签栏 + 导航条），书签栏显隐即自动参与布局。

**书签栏**
- 第三行 `.bookmark-bar`（32px，可滚动），`⌘⇧B` 切换，显隐态存 `localStorage`。
- 渲染 `GET /api/bookmarks` 扁平列表，点条目直接 `navigate`。

**页面内查找**
- `main.rs`：`find_in_page(text, forward)` → 注入 `window.find(text, true, false,false,false,false, !forward)`。
- 工具栏查找条（`⌘F` / 找图标）：`Enter` 下一个、`Shift+Enter` 上一个、`Esc` 关闭；关闭时发一次空串清除高亮。

**缩放**
- `main.rs`：`set_zoom(factor)` → `document.body.style.zoom`，clamp 到 `[0.25, 5.0]`。
  **不用 `transform: scale`** —— 那会改变 layout，让 `geometry.js` 的标注框复投影漂移。
- **收在「⋯更多」菜单内**（`− / 百分比 / +` 一行），`⌘+` / `⌘−` / `⌘0`，值持久化到 `localStorage`。
  初版把三个缩放按钮常驻导航条，截图后发现导航条明显变挤，遂收进菜单（导航条回到 6 个图标）。
- 缩放按钮用 `data-zoom`（非 `data-cmd`），且处理器里 `stopPropagation` ——
  否则冒泡到 document 的「点外部关菜单」会把菜单关掉，连点缩放就失焦。

**验证**
- `cargo test` **12/12**（新增 `omnibox_searches_history_and_bookmarks`）；`cargo check` 零警告。
- Playwright（`pw`，mock 桥 + 真实 `index.html`）：**25/25**，新增 `dev/toolbar-browser.mjs`；
  截图 `docs/assets/annota-browser-m7-toolbar.png`。
- 回归：`node --test dev/*.test.mjs` 23/23；`dev/check-shell-drift.mjs` 6/6；`dev/smoke.mjs` OK；`python3 build.py` 已重建产物。

**踩坑**
- 菜单 `display:none ↔ flex` 切换会让 Playwright 的 actionability 稳定性检测反复失败（元素明明 `isVisible=true`）。
  测试里改用 `el.click()` 派发合成事件（`menuClick()` 辅助函数）。

### M6a 会话恢复（已完成）

**后端（`tabs.rs`）**
- 会话文件 `tabs.json`（`{version, active, tabs:[{id,url}]}`）。路径规则与 `store.rs` 一致：
  `ANNOTA_SESSION` env → debug 落 `app/service/tabs.json` → release 落 `app_data_dir/tabs.json`。
- **防抖落盘**：`emit_tabs` 已在收集 `(id, url, active)` 全量快照 → 抽出 `snapshot()` 复用，
  标脏 `SESSION_DIRTY_AT`；`spawn_session_persister` 后台线程 400ms 轮询，静默 400ms 后写盘。
  连续开关 tab 只落一次盘。写入用「临时文件 + rename」，断电不留半个 JSON。
- **恢复**：`setup_webviews` 先试 `restore_tabs`（仅 http(s)，上限 12），失败/无记录才回落单个工作区 tab。
  `create_tab` 会把每个新 tab 置为激活，故恢复完再 `activate_tab` 切回原激活下标；单个 tab 失败不阻断其余。
- **「不恢复上次会话」**（「⋯更多」菜单 → `tab_session_clear`）：
  写 `{disabled:true}` + 置内存标志停写。本次运行跳过落盘，下次启动消费掉标记并删除它，之后恢复常规持久化。
  **刻意做成一次性而非永久开关** —— 永久关闭会让用户无法再启用（死路）。
- `parse_session` 与文件 IO 分离（纯函数），便于单测。

**验证**
- `cargo test` **20/20**（新增 `session_tests` 8 项：顺序+激活下标、跳过非 http(s)、全非法视作无会话、
  disabled→SkipOnce、激活下标越界丢弃、上限截断、坏 JSON、空 URL 数组、空白裁剪）。
- **真机端到端**（debug binary 跑两轮）：
  - 第 1 轮（无文件）→ 建工作区 tab → 退出前落盘 3 tabs + `active:2`；
  - 第 2 轮 → 日志 `会话恢复：3 个 tab`，未建默认 tab；
  - 写 `disabled` 后第 3 轮 → 日志 `已按上次请求跳过恢复（此后重新启用）` → 建工作区 tab → 标记被删除、恢复常规落盘。
- Playwright `dev/toolbar-browser.mjs` **27/27**（新增「不恢复上次会话」菜单项存在 + 触发 `tab_session_clear`）。
- 回归：JS 23/23；`check-shell-drift` 6/6；`smoke.mjs` OK；`cargo check` 零警告。

### Bugfix：菜单/面板被裁剪（权限缺失，M6-M7 收尾时发现）

**症状**：点「⋯更多」菜单只露出顶部一条就消失；历史/下载面板同样打不开。截图证据：菜单 `top:38px` 处
只渲染到工具栏 webview 底边。

**根因**：`set_toolbar_expanded` 与 `set_toolbar_height` 注册进了 `invoke_handler`，
但**既无 `permissions/*.toml` 声明、也没在 `capabilities/default.json` 引用**。
Tauri 权限层直接拒绝调用 → 工具栏永不增高（恒 94px）→ 下拉浮层被裁。
`permissions/autogenerated/` 是 build.rs 按「命令出现在 `invoke_handler` 里」生成的，
所以这两个命令本该自动有权限——但它们是在 build.rs 解析之后加进 handler 的，
`capabilities` 里也没补引用，于是静默失效。**M6b 的历史/下载面板当时应该也是同样症状。**

**修复**
- 新增 `app/annota/permissions/toolbar.toml`：`allow-set-toolbar-expanded` + `allow-set-toolbar-height`。
- `capabilities/default.json` 补上两条引用。

**防回归**：`dev/check-tauri-permissions.mjs`（已挂 release.yml CI）
- 正向：每个 `generate_handler![]` 里的命令，都能追溯到「某个 `permissions/*.toml` 的 `commands.allow`
  **且**该 toml 的 `identifier` 出现在 capabilities」——两者缺一即 FAIL。
- 反向：capabilities 里无悬空 `allow-*`（指向不存在的 permission 标识符）。
- ⚠️ 初版写成「被某个 toml 覆盖就算过」，是**假阴性**（移除 capabilities 引用后仍 PASS），
  因为漏掉的正是「toml 有、capabilities 没引用」这一半。已按 Tauri 真实规则重写，
  并用「临时移除权限 → 必须 FAIL → 还原」验证过检查器本身有效。

### Bugfix：打开菜单/面板时页面整体下移（M7 重做浮层）

**症状**：点「⋯更多」后页面内容区瞬间被下推约 420px，视觉上「跳一下」。

**根因**：M6 为了让浮层不被裁剪，引入了 `set_toolbar_expanded` —— 把工具栏 webview 从 94px 增高
`PANEL_HEIGHT=420`，同时 `apply_layout` 把页面 webview 下移并压矮。菜单需要多少高度是固定的，
但代价是每次开关浮层都重排整个内容区。

**方案对比**
- ❌ 调 z 序：macOS 上子 webview 按**添加顺序**叠放，工具栏先加 → 永远在页面之下，无法提到上层。
  （Tauri v2 的 `always_on_top` 只存在于 `WebviewWindow` 这类独立窗口，不适用于 child webview。）
- ❌ 继续增高工具栏 + 缩小增高幅度：治标，页面仍然会动。
- ✅ **独立 overlay webview**：浮层按需创建 → 永远是最后添加的 child webview → 天然盖在所有 tab 之上。
  工具栏高度与页面布局**完全不变**。

**实现**
- 新增 `app/annota/public/overlay.html`：承载菜单 / 历史 / 下载三种形态（`window.__VA_OVERLAY_KIND__` 决定初始形态）。
  透明背景 + 全屏 `.backdrop` 吃掉点击、点外部/Esc 关闭。
- `main.rs`：
  - 命令 `overlay_open(kind)` / `overlay_close`：创建/复用/销毁 `overlay` webview；
    尺寸按形态算（菜单 240×380 锚在导航条右下；面板铺满工具栏下方剩余高度）。
  - `TAB_GEN` / `OVERLAY_GEN` 代数：新建 tab 会盖住已开的浮层（后加者在上），
    故 `create_tab` 自增 `TAB_GEN` 并直接关掉浮层；下次 `overlay_open` 发现代数不符就销毁重建。
  - `overlay_close` 后把焦点还给页面，否则键盘事件仍落在已关闭的浮层上。
  - 命令 `tabs_snapshot`：浮层是独立 webview，收不到 `tabs-changed`，「诊断信息」需要主动取 tab 状态。
- `index.html`：删除菜单 / 面板 DOM 与相关 CSS/JS，「更多」按钮只调 `overlay_open('menu')`；
  缩放 UI 搬去 overlay.html，工具栏只留 `⌘+ / ⌘− / ⌘0` 快捷键。
- 移除 `set_toolbar_expanded`（含 `PANEL_HEIGHT` / `TOOLBAR_EXPANDED`），权限改挂 `allow-overlay`。

**验证**
- 新增 `dev/overlay-check.mjs`：**22/22**（菜单形态 6 命令 + 3 缩放 + 遮罩关闭；历史 2 条；下载 1 条 + 状态徽标；
  三形态均无 JS 报错；工具栏已无菜单/面板 DOM、点「更多」只发 `overlay_open`、**工具栏高度不变**）。
- 截图 `docs/assets/annota-overlay-{menu,history,downloads}.png`。
- `dev/toolbar-browser.mjs` 精简为 19/19（移除已搬迁的缩放/菜单断言）。
- 回归：`cargo test` 20/20；JS 23/23；shell 漂移 6/6；权限 2/2；smoke OK；真机启动无权限拒绝。

**局限**
- 浮层是独立 webview，首次打开有一次 webview 创建开销（macOS 上约几十毫秒）。
- 浮层内的键盘事件自成焦点域；已用 `overlay_close` 归还焦点处理。

### Bugfix：浮层不可见 + 多标签只显示一个（真机回归发现）

两个 bug 同源，都在浮层/工具栏这一层，且**都不是 UI 逻辑问题，而是 webview 层面的静默失败**。

#### Bug 1「点 ⋯ 更多后 webview 不可见」

- **根因**：`overlay_open` 里给浮层 webview 加了 `.on_navigation(|_| false)`（本意「不允许浮层跳走」），
  但 wry 把 `navigation_handler` 挂在 **WKNavigationDelegate** 上，它会拦掉 **webview 自身的初始加载**。
  结果：webview 创建成功、几何正确，但 **URL 为空** → 一个从没加载过页面的空白透明 webview → 看起来「点了没反应」。
- **定位方式**：加 debug 钩子打印 `w.url()`，看到 `url=None` 才定位到（肉眼与 Rust 侧日志都看不出异常）。
- **修复**：去掉 `on_navigation(|_| false)`。浮层是纯本地页、无 `<a href>`，本就不需要跳转拦截；
  真要收口用 capability + CSP。
- **验证**：修复后 `url=Some("tauri://localhost/overlay.html")`，真机截图菜单浮层正常显示。

#### Bug 2「能开多个标签，但只看到最后一个」

- **现象**：Rust 侧 `TabState` 里有 3 个 tab，但标签条**一个 chip 都不渲染**，`+` 按钮也不见了。
- **根因**：不是 tab 状态机的问题（实测 `create/activate/close` 全部正确），而是
  **工具栏 webview 收不到 Tauri 事件** → `renderTabs()` 从未执行 → 标签条空白。
  `subscribe()` 里 `if (t && t.event && t.event.listen)` 判定失败时**静默跳过所有订阅**，
  既不降级也不报错，于是整个标签条 UI 永远空白。
  （探针实测：`window.__TAURI__` 存在但 `.event` 在该上下文未暴露，`bridge_probe_reply` 从无回调。）
- **修复**：
  - 订阅改为 `on(name, fn)` 包装，**缺事件桥时不再静默**，走 `tabs_snapshot` 命令轮询兜底
    （500ms 首拉 + 1500ms 间隔；`tabs_snapshot` 走 invoke，不依赖事件）。
  - 补回 `shell-mode-changed` 订阅。
- **验证**：真机截图确认 2 个 tab chip 正常渲染、激活态高亮、omnibox 正确回显。

**教训**
1. 「加了拦截/限制」类改动要确认它是否会拦掉**自身加载**（`on_navigation` 就有这个语义）。
2. 事件桥这类**可选能力**必须有降级路径；`if (能力) { 订阅 } ` 这种写法在能力缺失时会让 UI 整体静默失效，
   比报错更难查。
3. webview 层的 bug（没加载、被盖住、尺寸为 0）在 Rust 日志里看不出来 —— 必须打印 `url()/position()/size()` 实测。

### 标签条 / 书签栏 视觉重做（M7 收尾）

真机截图暴露的问题：tab 全挤在左侧、`+` 飘在最右、激活态只是微弱描边（看不出当前页）、两侧都没有 favicon；
书签栏最糟——6 个书签挤一行，全是「统一图标 + 完整标题」，`Rick Astley - Never Gonna Give You Up` 直接撑爆，
视觉权重完全相同，像一排文本标签。

**标签条**
- 改为「斜切标签」造型：底边无边框 + 顶部圆角，非激活 `#16171b`、激活 `#22242a`（同色系分两档）。
- 激活态加**顶部 2px 橙色强调条**（`::before`），贴合标签条上沿指向导航条 —— 这是「当前页」最直接的识别信号，
  比原来仅靠 `border-color: rgba(245,166,35,.32)` 微弱描边清楚得多。
- `+` 按钮紧贴 tab 群末尾（左移 4px + 左侧 1px 分隔线），形成「新建」独立分组，不再孤立飘在右侧。
- 固定宽度 180px（`min-width:56px`），标题省略号生效；关闭按钮改为 `<button>`，hover tab 时才显影（`opacity .55→1`）。
- 高度 38 → 40px。

**书签栏**
- **宽度上限 190px + 单行省略**，`flex:0 1 auto`（同时满足「按内容宽度」与「超长时收缩」，`auto` 会让末项拉伸占满剩余空间）。
- 横向滚动保留，超宽时滚动而非撑破布局。
- 条目改为透明底 + hover 才出边框/底色；间距 4→3px 但配合高度 32→36px，视觉更透气。
- 空态补图标 + 快捷键提示（`暂无收藏 · 按 ⌘⇧B 隐藏`），hover title 显示完整标题 + URL。

**站点色块（标签条与书签栏共用 `siteTile()`）**
- 无 favicon 时按**域名 hash → 固定色相表**生成单色圆角色块 + 首字母，比统一书签图标辨识度高得多。
- 不拉跨域图片：无加载失败、无性能开销、无 CSP 问题。

**顺带修的两处布局缺陷**
1. `engine-state`（LOCAL 状态灯）缺 `flex:none`，被 omnibox 挤压，窄窗口下被裁成半个字母「L」。截图发现 → 补 `flex:none`。
2. 标签条高度变化后 Rust `TOOLBAR_HEIGHT_BITS` 初值需同步 94 → 96（40+56），否则首帧内容区错位。

**验证**
- 新增 `dev/chrome-preview.mjs`：**13/13**（3 tab + 6 收藏，含超长标题）：
  书签无溢出、条目宽度受上限、超长标题确实被裁切、每项有色块；
  tab 渲染数正确、恰好 1 个激活态、激活态 `::before` 可见、激活/非激活底色不同、无溢出。
  截图 `docs/assets/annota-chrome-redesign.png`。
- 真机双轮截图确认（多 tab + 书签栏展开）：色块/强调条/省略号全部生效，`LOCAL` 不再被裁，布局无错位。
- 回归：toolbar 19/19、overlay 22/22、JS 23/23、shell 漂移 6/6、权限 2/2、cargo 20/20、`cargo check` 零警告。

### 「更多」菜单精简（userscript / 扩展端）

真机截图暴露：菜单 4 个区块、**22 个平铺可点元素**，其中大半与别处重复或低频。按「是否重复 / 使用频率」两条标准重构。

**删掉的冗余**
- **查看全部标注** —— dock 常驻已有 `查看全部` 按钮，**完全重复**。
- **同步地址输入框 + 保存地址 + 清空地址 + 测试** —— 脚本已内置候选地址**自动探测**
  （`VA_SYNC_URLS`：127.0.0.1 / 局域网 IP / `.local`），用户日常无需填；这是调试逃生口，不该占首屏。
- **仅上传 / 仅下载** —— dock 的 `⇅ 同步` 已做「拉取→合并→回传」，这两个是同动作的退化版。

**折叠（不是删）**
- **高级设置**：同步地址 / 仅上传 / 仅下载 / 只读模式 / 导出 / 导入 / 清空当前 / 词典模板 / 候选地址。
- **组管理**：云开发登录 / 邀请链接 / 加入组 / 推送到组 / 当前组列表 + 一句说明。

**首屏保留**：`发给 AI 助手` `截图` `存笔记`（三者互相配合构成 AI 上下文桥，是产品核心差异点）、
`查看全部标注`、`诊断信息`。**结果：22 → 7 个可点元素。**

**危险操作分离**
- `清空当前` 加 `.is-danger`（红色描边 + hover 红底），不再与日常按钮混为一谈。

**视觉**
- 新增 `mkFold()` + `.va-fold` CSS：折叠头右侧 chevron（新增 `chevronDown` 图标，展开时旋转 180°），
  明确「这是可展开分组」而非又一个动作按钮；展开态头部转橙色 + 内容区内缩分隔。
- `aria-expanded` 正确翻转，可键盘操作。

**踩坑（值得记）**
1. `groupPanel` 变量被重写成 `groupFold.body` 后，append 时写成 `groupPanel.fold` —— 值是 `undefined`，
   **组管理整块静默消失**，Rust 侧与 smoke 都不报错。Playwright 断言「恰好 2 个折叠区」才抓到。
2. 测试统计「首屏元素数」时必须**按可见性过滤**（祖先 `display:none` 的不算），
   否则折叠体里的按钮/输入框会被计入，看起来像没折叠成功。

**验证**
- 新增 `dev/more-menu-check.mjs`：**30/30**（对真实 `dist/annotate.user.js` 跑，非源码）
  —— 首屏 ≤10 按钮 / 0 输入框 / 0 危险按钮 / 恰好 2 个默认收起的折叠区；
  展开后 18 按钮 2 输入框、10 个高级设置功能逐项断言仍在、`aria-expanded` 翻转、可重复收起、
  组管理「加入组/推送到组」保留、菜单不超出视口。
  截图 `docs/assets/annota-more-menu-{collapsed,expanded}.png`。
- 回归：JS 23/23；shell 漂移 6/6；权限 2/2；**smoke ×7 全过**（含 `smoke-group-ui` 专门测组管理 UI）；
  toolbar 19/19、overlay 22/22、chrome-preview 13/13。
- 影响面：`src/core.js` 三端共用，但 **Tauri 浏览器端用 overlay.html 的独立菜单，本改动不影响它**；
  观看端 `annotate.view.user.js` 本就只显示 dock 四个按钮，不受影响。

### 待办（剩余）
- M8 Electron 冻结（README/HANDOVER 标注 deprecated；build.py 停发 browser core）。
- M8 标注体验精简（页面内 ⋯ 菜单区块级收编 + 设置页归并，见 §方案 M8）。
- M7 剩余：`withGlobalTauri: true` 的暴露面安全复查（OCR 遗留低优先项）。

### OCR 审查（M1–M6）与修复（2026-10-07）

两轮 `ocr review`（provider=opencode-go）：M1–M5（`34cfe90..HEAD`，17 文件 / 27 条）、M6（workspace，6 文件 / 14 条）。
结果保留在 `~/.local/share/ocr-reviews/video-annotate/{m1-m5.txt,m6.txt}`。

**已修（高 / 中）**
1. **工具栏收不到任何 Tauri 事件**：`tauri.conf.json` 加 `app.withGlobalTauri: true`。此前 `window.__TAURI__` 不存在（`__TAURI_INTERNALS__` 不含 `.event`）→ 标签条 / omnibox / 更新 pill / 编辑态同步 / 下载角标全部静默失效。
2. **自动更新实际不可用**：`bundle.createUpdaterArtifacts: true`；`release.yml` 断言 `.app.tar.gz(.sig)` 存在、updater 产物上传 `if-no-files-found: error`、`latest.json` 空 `platforms` 直接失败、去掉错误的 `darwin-x86_64` 别名、macOS `sig` 校验、`pub_date` 用当前时间、删未用 import。
3. **重复权限标识符**：删除手写 `permissions/install_update.toml`（`allow-install-update` 已由 autogenerated 提供）。
4. **移动端入口属性错位**：`#[cfg_attr(mobile, tauri::mobile_entry_point)]` 归位到 `pub fn main()`。
5. **防漂移守卫失效**：修正 `dev/check-shell-drift.mjs` 的恒真断言（剥注释后严格匹配）；`core.getState` 改返回只读快照；`browser-shell.js` 不再直连 `state.*`。现 6/6 真通过。
6. **`tab-updated` 缺 `active`**：`tabs.rs` 补字段 → omnibox 正确回显。
7. `tabs.rs`：`move_tab` 激活下标修正；`create_tab` 置前并聚焦新 tab、隐藏其余；`emit_tabs` 释放锁后再查 webview URL（避免持锁调 UI 线程）。
8. **编辑态跨 webview 同步**：`browser-shell.setMode` 广播 `annota://shell-mode-changed`，工具栏据此同步按钮；顺带修正内容页 `Cmd/Ctrl+E` 只进不退。
9. **browser-shell 定时器**：仅编辑态轮询，观看态清理（不再 250ms 空转写 DOM）。
10. **`overlay-theme.js` 断点重叠**：新块 `720px → 768px`，与既有移动断点对齐。
11. **阻塞 I/O**：M6 的 SQLite 调用经 `tokio::task::spawn_blocking` 移出 async worker。
12. **DB 打开失败**：改为回退临时库，不再直接 `panic!`。
13. **下载文件名**：去首尾点/空格/控制符、避开 Windows 保留名、同名自动去重 `name (n)`；创建目录失败记录日志。
14. **前端**：`vaFetch` 校验 `r.ok`（失败不清空、不误置星标）；历史/下载面板加 stale-fetch 竞态守卫。

**验证**：`cargo test` 11/11；`node --test dev/*.test.mjs` 23/23；`dev/check-shell-drift.mjs` 6/6；`dev/smoke.mjs` OK；Playwright M6 复验 9/9。

**未修（低优先，记录）**
- `sync_server` 本地 API 无 Host/Origin 校验（DNS rebinding）；`downloads` 无 `url` 索引/上限；history 每次插入全表裁剪；面板行/标签无障碍（`role`/`tabindex`）。
- `withGlobalTauri: true` 会向所有 webview（含远程内容页）暴露 `window.__TAURI__` 便捷面；但远程页此前已通过既有 capabilities 持有 `__TAURI_INTERNALS__`，属既有设计暴露面，建议 M7 安全复查。
- `release.yml` 上传 CloudBase 现需 GitHub Secrets 配 `TENCENTCLOUD_SECRETID/SECRETKEY`（缺失即失败，不再静默）。







### OCR 审查（M6-M7，2026-10-07）

`ocr review --provider opencode-go --effort low`（24 文件 / 27 条）。
结果：`~/.local/share/ocr-reviews/video-annotate/m6-m7.txt`。

> 踩坑：`--effort high` + `--effort medium` 各跑一次都**超时且无输出**（>25 min）；
> `--effort low` 8 分 40 秒完成。大 diff 必须用 low，先保证拿到结果。

**已修（真 bug）**

1. **`window.find` 参数传错位**（`main.rs`）——签名第 3 位是 `backwards`，第 7 位是 `showDialog`，
   原实现把 `forward` 喂给 `showDialog`、第 3 位写死 `false`。后果：点「上一个」方向不对，
   且会**弹出 WebKit 原生查找对话框**。改为 `find(text, false, !forward, true, false, false, false)`。
2. **`.chrome-dot` CSS 被误删**（`index.html`）——浮层搬到 `overlay.html` 时把角标样式一起删了，
   元素还在但无任何样式，永不显示。已恢复样式，并让 `download-finished` 熄灭角标
   （原先只会点亮、永不熄灭）。
3. **会话恢复 active 下标错位**（`tabs.rs`）——`active` 是**未过滤**列表的下标，
   而解析时跳过非 http(s) 条目。若被跳过的 tab 排在激活 tab 之前，会激活错的那个。
   改为记录「原始下标→过滤后下标」映射再翻译；新增 2 项单测。
4. **权限检查器有恒真断言**（`dev/check-tauri-permissions.mjs`）——
   `for (const p of capsPerms) knownIds.add(p)` 把**被检查项自己**塞进白名单，
   导致悬空权限检查永远是空数组、永远 PASS。而这正是该脚本存在的意义（静默废掉防线）。
   同时 autogenerated 的 identifier 是 kebab-case 而文件名是 snake_case，一并修正。
   已加**自检断言**（喂进伪造标识符必须报出来），并用「注入悬空权限 → 必须 FAIL」验证过。
5. **overlay 复用时尺寸不匹配**（`main.rs`）——复用分支只比对 tab 代数、从不重新摆位，
   以 `menu`(240×380) 打开后请求 `history`(整行) 会得到被压成 240 宽的面板。复用时重新 `set_position/size`。
6. **`persist_session` 竞态**（`tabs.rs`）——只在标脏处检查 `SESSION_DISABLED`，
   写盘前不复查；用户点「不恢复上次会话」后，防抖线程可能刚好已通过检查而写回完整快照，
   覆盖 `disabled` 标记。写盘前加复查。
7. **`omnibox` LIKE 通配符未转义**（`store.rs`）——用户输入 `%`/`_` 会匹配全部行。
   （已参数化，无注入风险，属结果不正确而非安全问题。）
8. **`.gitignore` 漏 `app/service/tabs.json`**——新加的会话文件会被提交进版本库，已补。
9. **`version-check.js` 重复检测 + `var`**——`relinkHref`/`variantLabel` 各自重复一遍 GM 环境判断；
   且 `corsFetch` 只看 `GM_xmlhttpRequest`、变体判断还看 `GM.xmlHttpRequest`，两者不一致。
   抽出 `isGmEnv()` 统一。

**未修（判定为可接受，记录）**

- **release 构建启用 `devtools` feature**（安全）——M6d 的「开发者工具」是**产品功能**（用户自助排障），
  不是调试遗留；关掉等于砍掉已交付能力。暴露面与 `withGlobalTauri: true` 同源，
  已在前轮 OCR 记录为待复查项。
- `set_toolbar_height` 被两个 permission 重复授权（`find.toml` + `toolbar.toml`）——
  目前无功能影响，后续整理时归口到 `toolbar.toml`。
- `check-tauri-permissions.mjs` 里 `allowedByTauriFile` 与 `parsePermissionBlocks` 重复，
  且只统计首个 `commands.allow`（多块文件计数不准）——仅影响一行日志输出，已改为不参与断言。

**收尾（低优先项一并清掉）**
- `set_toolbar_height` 原本被 `allow-find` 与 `allow-set-toolbar-height` **双重授权** → 归口到
  `toolbar.toml`，`find.toml` 只管 `find_in_page` / `set_zoom`。已校验：无任何命令被多个 permission 覆盖。
- 删除 `permissions/toolbar.toml` 里空壳的 `allow-set-toolbar-expanded`（命令 `set_toolbar_expanded`
  已随浮层重构删除，留着会让 capabilities 引用一个空 permission）。
- `check-tauri-permissions.mjs` 删除冗余的 `allowedByTauriFile`（与 `parsePermissionBlocks`
  重复解析、且 `match` 只取每文件首个块，多块文件计数失真）。日志统计口径改由真实解析器派生，
  避免「日志说覆盖 N 个、断言里是另一套」的漂移。

**验证**：`cargo test` 22/22（新增 2 项会话下标测试）；`cargo check` 零警告；
JS 23/23；smoke ×7；Playwright 四套（19/22/13/35）；shell 漂移 6/6；权限 3/3（新增自检）。
已发布 `0.1.0.41`，三脚本 sha256 与本地一致。
