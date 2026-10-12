# 插件模块（Annota Plugins）

Annota 浏览器（桌面版 Tauri）是**底座**：标注引擎、媒体绑定、词条锚点、同步、截图、本地 REST。
专业能力（语言学习、领域词库、导出管线……）以插件形式集成在底座之上——插件只依赖稳定的
`coreApi` 契约，不侵入 core。契约冻结为公共 API，第三方可自行开发插件。

插件包规范与开发模板见插件仓 [annota-plugins](https://github.com/627-hub/annota-plugins)
（包格式 SPEC、脚手架、官方示例 ielts）。

## 两条装载通道

| 通道 | 说明 | 壳 |
|---|---|---|
| **内置** | `build.py` 的 `PLUGINS` 清单拼进发行物（出厂自带，当前：`anki-export`、`group`） | 全部（userscript ×3 / 浏览器变体 / MV3 扩展） |
| **运行时安装** | zip 包拖进工作区「插件」页安装，存 `app_data/plugins/`，新标签页注入生效 | 仅 Annota 桌面版（MV3/油猴受浏览器远程代码政策限制，无法做拖入安装） |

### 内置接线

- `build.py`：`PLUGINS = [...]`（顺序即拼接顺序；userscript/browser 两个变体共用，禁止分叉）。
  插件拼在 `core.js` 之前（core 统一安装）。
- `app/annota/build.rs`：新鲜度守卫同时扫 `src/` 与 `src/plugins/`（非递归），并
  `rerun-if-changed` 两者——改插件后必须重跑 `python3 build.py`，否则 `cargo build` 直接 panic。

### 运行时装载协议（v2）

- **包格式**：zip 根目录平铺 `manifest.json` + `main.js`（详见插件仓 SPEC.md）。
- **安装**：工作区「插件」页拖入 zip → 服务端 dry-run 校验 → 用户确认（展示 id/版本/权限/来源）→ 落盘。
  同 id 重复安装 = 覆盖升级（保留启用状态）。
- **API**（`app/annota/src/plugins.rs`，均在 guard+限流中间件之后）：
  - `GET /api/plugins` → 列表 + 安装 token（同源可读；跨源无 CORS 读不到）
  - `POST /api/plugins/install?dry_run=1&name=` 预览校验；去掉 dry_run 正式安装（body = zip 字节）
  - `POST /api/plugins/:id/toggle` `{"enabled":bool}`；`DELETE /api/plugins/:id`
  - 写请求校验 `X-Annota-Token` 头（挡恶意网页静默安装）
- **注入**（`tabs.rs`）：已启用插件源码在建 tab 时以**每插件独立 initialization_script** 注入，
  排在标注引擎 `ANNOTATE_JS` **之前**（插件先 push `__VA_PLUGIN_DEFS__`，core 再统一安装）；
  每次顶层导航自动重放。独立 script = parse 阶段天然隔离，单插件语法错误只死它自己。
  **新打开的标签页生效**；已开标签不受影响（禁用/卸载时页面会提示重载）。
- **存储**：`app_data/plugins/<id>/{manifest.json,main.js}` + `plugins.json`（启用状态，原子写 + .bak 恢复）。
  损坏插件（manifest/入口缺失）只列表展示「损坏」，不注入、可卸载。
- **限额**：zip ≤4MB、条目 ≤32、单文件 ≤512KB、解压总量 ≤2MB、压缩比 ≤20:1、zip-slip 防护
  （`enclosed_name` + 仅包根平铺）；内置 id（`anki-export`/`group`）保留，撞 id 拒装。
- **engine 字段**：manifest 可声明 `engine: ">=0.2.4"`，当前仅警告级（记录，不拒装）。

## 插件契约 v1（冻结层）

```js
(function (root) {
  'use strict';
  function install(coreApi) { /* 同步完成；可在这里挂 API / 订阅钩子 */ }
  root.VAMyPlugin = { /* 可选：运行期 API 命名空间 */ };
  (root.__VA_PLUGIN_DEFS__ = root.__VA_PLUGIN_DEFS__ || []).push({
    id: 'my-plugin',        // 必填，唯一，kebab-case（与 manifest.id 一致）
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
- 插件间不互相 import；通信走 `window.VA<Name>` 命名空间；CSS 类名用 `.va-<id>-*` 约定防冲突，
  样式内联（插件不依赖 core 样式表）。
- `__ANNOTA_EXPORT__` 是 anki-export 的兼容别名（URL intent 链路依赖），勿删。
- 已安装插件列表：`window.VAPlugins`（调试/冒烟用）。
- **契约演进规则**：钩子只增不改、payload 只增字段；删除/改义需 major 并同步装载层拒装旧插件。

### coreApi（core.js 提供）

`state`（活对象）/ `binding()` / `entries()` / `mediaMeta()` / `renderOnly(entry)` / `render()` /
`setChromeHidden(bool)` / `save()` / `captureFrame()` / `videoRect()` / `resolveBase()` /
`httpJson(method,url,body)` / `setSyncStatus(msg)` / `showToast(msg,error?)` / `uiRoot` /
`mergePack(a,b)` / `validEntries(list)` / `fingerprint(entries)` / `onHook(name,fn)`。

### 钩子

- `entryPop`：词条详情气泡挂载前触发，载荷 `{ entry, pop }`。插件可异步往 `pop` 里 append 内容。

## VIEW_ONLY 语义

观看端（`annotate.view.user.js` / 手机场景）只安装 `viewOnly: true` 的插件；
写操作类插件（导出等）标 `viewOnly: false`。运行时装载的插件由装载层按 manifest 过滤。

## 内置插件

### anki-export（`src/plugins/anki_export.js`）

- apkg 单路径：逐条截图 → `POST /api/export/card` → `POST /api/export/finalize` → 下载。
- 保留：进度条、断点续跑（`va:export:<mediaId>`）、`stableDeckId`、rVFC 等帧、截图叠框、pause/resume/cancel。
- 删除（git 历史可找回）：csv/json/jsonl 客户端下载、手动确认截图（`confirmShot`/`captureEntryManual`，当时无 UI 入口）。
- deck 命名回退：`opts.deckName` → 条目含「雅思」tag 时 `Annota::IELTS` → 视频标题 → `Annota 学习卡`。
- 测试：`dev/smoke-export.mjs`（拼接产物完整驱动）。

### group（`src/group.js`）

组同步层，运行期 API 仍挂 `window.VAGroup`，以插件身份注册（`viewOnly: true`）。

## 官方示例插件：ielts（外移至插件仓）

- 前端插件在 [annota-plugins/plugins/ielts](https://github.com/627-hub/annota-plugins)（词条详情查雅思词库，
  内联样式，`viewOnly`）。安装包由插件仓 `template/build.sh` 打出。
- 底座侧数据服务**留在本仓**：`app/annota/src/ielts.rs` `GET /api/ielts/lookup?word=`，
  跨仓只读联动姐妹仓 ielts-7.5（`雅思.jsonl` 音标/释义/例句 + `enrich/ielts.jsonl` 词源/同反义词）。
  数据目录解析：env `ANNOTA_IELTS_DIR` → settings `ielts.dataDir` → debug 兄弟仓默认 → 无则 501（前端静默停用）。
- `word` 只做格式校验 + 键查找，永不参与路径拼接。测试：`cargo test ielts`（含真实词库冒烟）。

## 安全模型

- **安装即信任**：安装确认框展示插件声明的权限、来源与「可读写你的标注数据」警示；插件与标注引擎
  同权限运行（无沙箱）。只安装你信任的包。
- **token**：写端点校验 `X-Annota-Token`（从 `GET /api/plugins` 同源获取）——挡「恶意网页静默安装」
  （跨源 fetch 带 Origin 会被 guard 拦、读不到 token）。**残余风险**：本机已运行的恶意 GM 脚本/进程
  可拿到 token 调安装端点——该威胁模型下攻击者已拥有用户权限，装插件不是其最狠手段，显式声明。
- **不做**无确认的远程 URL 安装、运行时 eval（注入由 Rust 拼 initialization_script，不经页面 CSP）。

## 测试

- `cargo test plugins`：装载层（校验矩阵/zip-slip/token/真实 ielts 包/HTTP 全流程）
- `cargo test ielts`：数据服务端点
- `dev/smoke-export.mjs`：内置导出插件全链路
- `dev/plugin-install-check.mjs`（`pw` 手动跑，不进 CI）：管理页安装流 Playwright 冒烟
