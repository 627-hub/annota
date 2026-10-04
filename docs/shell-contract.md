# 浏览器壳接缝契约（shell-contract）

> Annota 的 `src/*.js` 三端共用。**浏览器端（Tauri 壳）**允许比 userscript 端做更激进的编辑 UX，
> 但不 fork 引擎层。分叉只发生在一个**受控接缝**上：`window.VA_BROWSER_SHELL`。

## 分层

| 层 | 文件 | 是否可被浏览器壳替换 |
|---|---|---|
| 引擎层 | `geometry / textquote / adapter / media / identity / group / export` | ❌ 三端单份，禁止分叉 |
| 视觉层 | `design-tokens.js / overlay-theme.js` | ⚠️ 只**增**不改（新增类，不动桌面规则） |
| 壳层 | `core.js` 的 dock/panel 容器 + `applyMode` | ✅ 由 `browser-shell.js` 接管 |
| 契约红线 | `state`（标注状态机）、popover/askWord、`__ANNOTA_UI__`、数据层（save/merge/sync） | ❌ **禁止分叉** |

## 接缝点（core.js，全部集中在两处）

1. **`mountShell()`** —— `uiRoot.append(overlay, bar, sidePanel, toast)` 之后，调用
   `window.VA_BROWSER_SHELL.adopt({ dock, panel, overlay, toast, uiRoot, api })`。
   - `api` 交出受控入口：`isView/applyMode/toggleAnnotate/togglePicker/togglePanel/toggleSources/toggleMenu/syncNow/render/renderPanel/getState`。
2. **`applyMode()`** —— 末尾调用 `window.VA_BROWSER_SHELL.onModeChange('view'|'edit')`。

## 红线（改 core.js 时遵守）

- **只允许**在 `mountShell` / `applyMode` 两处出现 `VA_BROWSER_SHELL`；出现即接缝注释。
- 不得为壳新增 core 的公开函数；壳需要的新能力，通过 `adopt()` 的 `api` 增项。
- `browser-shell.js` **不得**直接访问 `window.__VA` / `state.*` / core 内部函数——只经 `adopt()` 交出的对象。
- 标注状态机、popover、数据层**永不**因壳而分叉。

## 自动守护

- `dev/check-shell-drift.mjs`：断言上面红线，挂 CI。改了 core 后本地先跑它。
- 变体与数据：`annotate.browser.js` = PARTS + TAIL 去掉 `version-check.js`、加 `browser-shell.js`；
  烧本地同步地址（`127.0.0.1:8793`）；不含 `VA_DIST_BASE`（浏览器端用 tauri-plugin-updater，不走脚本自动更新）。

## 为什么这样分

框选捕捉层与 popover 锚定**页面坐标**，必须在目标页面 webview 内运行；但 dock/panel 只是容器。
把「容器/模式」与「引擎/数据」切开，既能让浏览器端换壳，又保证三端的数据与同步逻辑永不分叉。
