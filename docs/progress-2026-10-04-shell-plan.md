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

### 待办（M7 / M8）
- M7 平板/响应式收尾（`overlay-theme.js` + `public/`）。
- M8 Electron 冻结（README/HANDOVER 标注 deprecated；build.py 停发 browser core）。

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






