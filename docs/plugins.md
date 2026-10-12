# 插件模块（Annota Plugins）

构建期静态注册的插件机制（无打包器、无运行时动态加载）。

## 产品定位：Annota 是底座，插件承载专业模块

Annota 浏览器（注入态引擎 + 本地服务）做**标注底座**：媒体绑定、词条锚点、同步、截图、REST。
专业能力（如语言学习、领域词库、导出管线）以插件形式集成在底座之上——插件只依赖稳定的
`coreApi` 契约，不侵入 core。演进方向：

- **v1（本机制）**：构建期静态注册，插件随发行物内置（见下方「清单与接线」）。
- **v2 · 选装**：插件按需启用/禁用（`enabled` 钩子已预留；设置面板加开关，安装态由 `window.VAPlugins` 可查）。
- **v2+ · 用户自研插件**：受控的第三方插件加载——本地插件目录扫描或用户显式配置的来源，
  配合 CSP 白名单与用户确认；`coreApi` 契约冻结为公共 API，插件文档即开发文档。
  （不做无确认的远程注入：注入态有账号/凭据，供应链风险必须由用户显式承担。）

## 设计边界

- 插件是 `src/plugins/*.js` 下的 IIFE 文件，由 `build.py` 的 `PLUGINS` 清单拼进所有产物
  （3 个 userscript 变体 + `dist/annotate.browser.js` + `app/extension/core.js`）。
- 文案硬编码中文（跟随注入态现状，无 i18n 接缝）。

## 插件契约 v1

```js
// src/plugins/<name>.js
(function (root) {
  'use strict';
  function install(coreApi) { /* 同步完成；可在这里挂 API / 订阅钩子 */ }
  root.VAMyPlugin = { /* 可选：运行期 API 命名空间 */ };
  (root.__VA_PLUGIN_DEFS__ = root.__VA_PLUGIN_DEFS__ || []).push({
    id: 'my-plugin',        // 必填，唯一，kebab-case
    name: '显示名',          // 中文
    viewOnly: false,        // true = 观看端（VA_VIEW_ONLY）也安装
    enabled: (ctx) => true, // 可选运行期门，ctx = { viewOnly }
    install,
  });
})(typeof window !== 'undefined' ? window : this);
```

规则：

- `install(coreApi)` 必须**同步**返回；异步探测放后台（install 之后自己发起），不得在里面 await 网络。
- 单个插件安装失败被隔离：`console.error` 一条，绝不打断标注启动。
- 插件间不互相 import；通信走 `window.VA<Name>` 命名空间。
- `__ANNOTA_EXPORT__` 是 anki-export 的兼容别名（URL intent 链路依赖），勿删。
- 已安装插件列表：`window.VAPlugins`（调试/冒烟用）。

### coreApi（core.js 提供）

`state`（活对象）/ `binding()` / `entries()` / `mediaMeta()` / `renderOnly(entry)` / `render()` /
`setChromeHidden(bool)` / `save()` / `captureFrame()` / `videoRect()` / `resolveBase()` /
`httpJson(method,url,body)` / `setSyncStatus(msg)` / `showToast(msg,error?)` / `uiRoot` /
`mergePack(a,b)` / `validEntries(list)` / `fingerprint(entries)` / `onHook(name,fn)`。

### 钩子

- `entryPop`：词条详情气泡挂载前触发，载荷 `{ entry, pop }`。插件可异步往 `pop` 里 append 内容。

## 清单与接线

- `build.py`：`PLUGINS = [...]`（顺序即拼接顺序；userscript/browser 两个变体共用，禁止分叉）。
  插件拼在 `core.js` 之前（core 统一安装）。
- `app/annota/build.rs`：新鲜度守卫同时扫 `src/` 与 `src/plugins/`（非递归），并
  `rerun-if-changed` 两者——改插件后必须重跑 `python3 build.py`，否则 `cargo build` 直接 panic。

## VIEW_ONLY 语义

观看端（`annotate.view.user.js` / 手机场景）只安装 `viewOnly: true` 的插件；
写操作类插件（导出等）标 `viewOnly: false`。
