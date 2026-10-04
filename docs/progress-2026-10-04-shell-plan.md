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

### 产品方向备忘

- `docs/ideas-training-data.md`：标注数据用于 AI 训练的 opt-in 公共数据集方向（授权/隐私/格式/激励），**暂不实现**。




