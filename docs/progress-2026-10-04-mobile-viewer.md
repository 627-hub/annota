# 进展 · 2026-10-04（R4b 收尾 + 手机观看端底栏改造）

> 承接 [`progress-2026-10-03-r4b.md`](progress-2026-10-03-r4b.md)。
> 本文记录本次会话（R4b 收尾之后）的工作：**手机端「观看端」底栏重做 + 来源选择**，以及全局 Playwright 工具 `pw` 的固化。**未提交**。

## 0. 一句话状态

- **R4b 全链路已真机验证通过**（GitHub OAuth 登录 + 建组/加入/RLS/合并/公开读；见上一份进度 §6.5/§6.6）。
- **手机「观看端」底栏**从「旧式混杂工具条」改成 **`小A标 | 显示 | 列表(条数) | 来源`** 的纯看形态（方案 B），逻辑+样式已实现、构建通过、回归全绿、手机视口截图已验收。
- **本轮续作**：待办 #1（来源勾选交互真机自动验证）与 #2（底栏安全间距）**已完成**，见 §7；剩更新用户手机 userscript + 提交。

## 1. 手机观看端底栏改造（本轮主线）

### 需求（用户确认）
- 手机端**去掉标注/选对象/同步/更多等一切编辑入口**，**纯看**。
- 保留：**显示/隐藏全部**、**列表**（查看词条）、**跳转原内容**。
- **同一视频可能有多个标注来源 → 需要「来源」可选列表**，入口放在**底栏「来源」按钮 → 弹出列表**。
- 品牌块：**不砍，降级为底栏左端一个小方 A 标**（方案 B）。

### 已实现（src/core.js）
- ICON_PATHS.layers 图标。
- btnSources = mkAction('来源','layers',()=>toggleSources())，已加入 bar.append(...)。
- applyMode() 观看态（isView()）：隐藏 btnAnno/btnPick/btnSync/btnCfg/status/separator，显示 btnSources，bar.classList.toggle('va-dock--viewer', v)，调 updateListBadge()；并修了一处初始化 TDZ（if (v && state.annotate) toggleAnnotate(false)）。
- updateListBadge()：列表按钮上的条数徽标（.va-count-badge），数值 = visibleEntryCount()。
- sourceList() / visibleEntryCount() / hiddenSources() / setSourceVisible()：来源 = local（我的本地标注）+ 每个 groupsForMedia 组；勾选状态存 localStorage['va:hiddenSources']。
- 来源弹层：sourcesPanel(.va-sources) + toggleSources() + renderSources() + 点击外部关闭。
- groupEntries() 尊重来源开关；render() 中本地条目按 hiddenSources().local 过滤。

### 已实现（src/overlay-theme.js）
- .va-dock--viewer 系列：gap 5px；品牌块收成 40x40 小方标、.va-brand-copy 隐藏；分隔线保留。
- .va-count-badge、.va-sources（玻璃弹层）、.va-sources-head、.va-src-item/.is-on、.va-src-check、.va-src-text。
- 移动端 @media (max-width:768px)：viewer dock 居中（left:50%;transform:translateX(-50%)）、48x48 按钮、列表按钮保留文字+徽标、来源弹层 left/right:12px;bottom:76px。
- 同步状态 .va-sync-indicator 加 white-space:nowrap（修竖排断行）。

### 验收截图（docs/assets/）
- mobile-viewer-final.png — 手机 390x844 全页，方案 B 已落地。
- mobile-viewer-dock.png — dock 元素特写。
- 对照原型：proto-mobile-viewer.png、proto-brand-B.png、proto-brand-C.png。
- 旧/现状对比：A-tauri-content-full.png、M-mobile-iphone-edit.png。

### 已知小瑕疵（待微调）
- 手机底栏整体略偏右（.va-dock--viewer 与 .va-dock 原有 right:24px 可能叠加），可再校一次居中。
- 底栏贴屏底略挤（可加大 bottom 安全距离）。

## 2. 为什么「用户浏览器里不是这个样式」

- 用户手机 Safari 装的是**旧版 userscript**（有「发豆包/全部/⚙/ⓘ」等按钮，现代码里已无），需**重装** dist/annotate.view.user.js 才能看到新 UI。
- 三处（userscript / 扩展 / Tauri 壳内容区）**共用同一份 core.js**；差异在宿主与视口，不在代码分叉。
- 之前截图错在：用**桌面视口** + 缺 viewport meta 的夹具页（innerWidth=980 导致移动媒体查询不命中）。已在 dev/fixture-host.html 补 meta viewport。

## 3. 全局 Playwright 工具 pw（已固化）

- 入口：~/.local/bin/pw；实现：~/.local/share/playwright/（Chromium+ffmpeg 557MB、playwright@1.63.0、@cloudbase/node-sdk@3.16.0、examples/、README.md）。
- 用法：pw script.mjs / pw -e "..." / pw --version / pw --path / pw --upgrade。
- ESM 修复：pw 会在脚本目录按需建 node_modules 软链 → import { chromium } from 'playwright' 可用。
- 已写入 ~/.config/opencode/AGENTS.md。

## 4. 待办（下一步）

1. ~~手机交互真机跑一遍~~ —— **已完成（本轮）**，见 §7。
2. ~~微调手机底栏居中/安全间距~~ —— **已完成（本轮）**，见 §7。
3. 更新/重装用户手机的 viewers userscript —— **已用「自动更新」根治（本轮，见 §8）**：
   装了带 `@updateURL` 的新版后，后续更新由管理器自动完成，**不用再手动重装**。
   首次仍需用户手机与电脑同 Wi‑Fi 跑 `python3 dev/hub.py` 扫一次码（本 agent 不能代扫）。
4. ~~（可选）userscript 注入 Publishable Key~~ —— **已完成（本轮，见 §7.4）**。
5. 提交（用户确认后）。

## 7. 本轮续作（待办 #1/#2/#4，已完成；#3 就绪）

### 7.1 待办 #1：手机「来源」交互自动验证

- 新增 `dev/fixture-video.html`（带 `<video src=sample.mp4>` 的仿真媒态页）+ `dev/dock-mobile-interact.mjs`（Playwright 脚本）：
  预置 3 条本地标注 + 1 个 git 来源组（2 条组标注），在 390×844 视口跑真实点击。
- **发现并修复一处交互盲区**：收起态下 `.va-dock > .va-action { display:none }`，dock 悬停在触屏上不持续 →
  即便 Playwright 能 `click()` 到隐藏按钮，真实触屏用户会在「菜单不可见」时误触「来源」却看不到弹层。
  修复：`toggleSources()` 先 `await revealDock()` —— 观看态且未展开时，临时置 `bar.dataset.open='1'` 展开菜单、
  派发合成的 `pointermove` 唤醒宿主 hover，等 260ms 后再展示来源弹层；置 `openAutoDone='1'`，用户打开过一次后不再自动展开。
- 脚本断言 14/14 全绿：徽标 5→3（取消组）→5→2（取消本地）→5；画面 `.va-mark` 的本地/组标数随之变化；
  勾选状态持久化到 `va:hiddenSources`；无 JS 报错。

### 7.2 待办 #2：底栏安全间距

- `@media (max-width:768px)` 观看态底栏 `bottom:12px` → `calc(16px + env(safe-area-inset-bottom))`；
  来源弹层 `bottom:76px` → `calc(80px + env(safe-area-inset-bottom))`，避开 iPhone 底部横条。
- 居中（`left:50%; transform:translateX(-50%)`）经计算确认已正确，无需再改。

### 7.3 回归（全绿）

- JS：`geometry`(11) / `textquote`(7)
- Node：`identity` / `gitstore` / `group_sync` / `group_hub`
- Python：`merge_rules`(13) / `anki_export` / `export_server` / `sync_replace`
- smoke×7 全 OK
- Playwright：`dock-mobile.mjs` 18/18、`dock-mobile-interact.mjs` 14/14
- 已 `python3 build.py` 重建 dist/{annotate,annotate.gm,annotate.view}.user.js + app/{browser,extension}/core.js

### 7.4 待办 #4：userscript 内联 Publishable Key（已完成）

- `build.py` 新增 `read_pk()`：优先 `ANNOTA_CB_PK` 环境变量，否则读 `app/service/cb-config.js` 里的
  `window.__ANNOTA_CB_PK__`（与工作区/组页同一份来源）；构建时把公开 PK 内联进三个 dist 变体
  （`window.__ANNOTA_CB_PK__=<JSON>`，仅非空时写入）。
- 效果：注入态（B站/YouTube 等）没有宿主页的 `cb-config.js`，现在也能拿到 PK → hub 组可用。
- 验证：Playwright 在 `fixture-video.html` 注入 `annotate.view.user.js` 后，
  `VAGroup.cbPublishableKey()` 返回内联 PK（1190 字符，`resolved:true`）。
- 待办 #3（手机重装）：代码已就绪；实际重装需用户手机与电脑同 Wi‑Fi，
  跑 `python3 dev/hub.py` → 手机扫入口页二维码（本 agent 不能代扫）。

## 8. userscript 自动更新（本轮新增，根治「每次都要手动重装」）

**问题**：`dist/*.user.js` 之前是 `@version 0.1.0` 且无 `@updateURL` → 管理器无从自动更新，只能手动重装。

**方案（管理器自动更新 + 脚本内兜底探测）**：

- `build.py`：
  - 元数据加 `@updateURL`/`@downloadURL` → 发布基址（默认 CloudBase 静态托管域名，`ANNOTA_DIST_BASE` 可覆盖）。
  - `@version` 每次构建自动递增（`VERSION` 计数，形如 `0.1.0.3`）——**版本不变管理器不更新**。
  - 内联 `window.VA_BUILD`（内容构建号，含旧脚本「版本探测」比对）、`VA_US_VER`、`VA_DIST_BASE`。
  - 产出 `dist/version.json`（版本顶标）。
- `src/version-check.js`（新，注册进 `build.py` 的 TAIL）：启动时（6 小时节流）拉远端 `version.json`
  比对 `VA_BUILD`；落后则在底栏上方弹「Annota 有新版本，建议更新 → 重装」提示条
  （优先 `GM_xmlhttpRequest`，退化 `fetch`；失败静默）。这是对 iOS Userscripts 等「@updateURL 支持不稳」的兜底。
- `cloudbase/publish.sh`（新）：构建 + 上传三个脚本与 `version.json` 到静态托管根。
- `.gitignore`：`dist/.buildtime`（本地构建状态）不入库；`dist/version.json` 入库。

**已验证**：
- `dev/version_check.test.mjs`（新）7/7：更新提示 / 最新不提示 / 节流 / 失败静默 / GM 优先 / 缺配置跳过。
- Playwright 端到端：把本地 `VA_BUILD` 置 1 → 拉线上 `version.json` → 弹提示条且链接正确。
- 线上核对：`curl` 三个产物 + `version.json` 可达，元数据 `@updateURL`/`@version 0.1.0.3` 正确。
- 回归全绿（含 smoke×7、dock-mobile 18/18、dock-mobile-interact 14/14）。

**发布方式**：`sh cloudbase/publish.sh`（会构建并把 `@version` 再 +1）。已发布到
`https://tencentcloudtest-d2eg4lu85c76fb0-1414056833.tcloudbaseapp.com/`。

**仍待用户做**：手机端**首次**装一次带 `@updateURL` 的新版（扫码），之后自动对齐。

## 9. 本轮追加：手机端痛点（拥挤 / hub.py / 同步逻辑）

用户手机上装的仍是**旧版观看端**（底栏 `👁全部|⇅同步|⚙|ⓘ`——新版已砍掉这些编辑入口），故觉得"挤"。

### 9.1 消除「每次都要 hub.py」——hook 进 hub 登录 UI

- 根因：本机（userscript）此前**没有登录云开发的入口** → 只能 `tcb login`（agent 侧）或靠局域网 `sync_server.py`（`hub.py` 拉起）→ 形成"每次开电脑"的依赖。
- 新增（`src/core.js` toggleMenu，改为 async）：
  - 组面板加「云开发登录行」：未登录 → 「用 GitHub 登录云开发」（`VAGroup.startLogin()`，OAuth 回跳本页）；
    已登录 → 显示「已登录：<名>」+「退出」（`hubMe()/currentUser()/signOut()`）。
  - 打开菜单时若 URL 带 `?ticket=`（OAuth 回跳）→ 自动 `VAGroup.handleTicket()` 兑换会话并刷新登录行。
- 注：登录本身仍是 agent 侧能力（`AGENTS.md` 有明示）；此项只是把**入口**暴露给用户，凭据只活在浏览器 localStorage。

### 9.2 手机端同步逻辑（澄清）

- 观看端 = `annotate.view.user.js`（`VA_VIEW_ONLY=true` + `VA_AUTO_SYNC=true`）：按 `mediaId` 自动**拉取**服务端标注并渲染，**只读不回推**。
- 两条通道：
  1. **局域网服务** `app/service/sync_server.py`（`:8793`，`hub.py` 拉起）——需电脑常开、IP 稳定；截图的「已同步·12 条」即此路。
  2. **CloudBase hub 组**（云上 PG+RLS）——不依赖电脑；需浏览器有会话+PK（PK 已内联进脚本）。
- 结论：要"不依赖电脑"，手机端须**已登录 hub 组**且该媒体在此组片单；纯个人标注的同步仍走局域网服务。

### 9.3 「拥挤」

- 属**旧版** UI；装新版观看端后底栏为 `小A标|显示|列表(N)|来源`（4 项、纯看），拥挤消失。

### 9.4 已重新发布

- `sh cloudbase/publish.sh` → `@version 0.1.0.8`，`version.json build=1791082601`；`curl` 核对可达。
- 回归全绿（含 smoke×7、dock-mobile 18/18、dock-mobile-interact 14/14、smoke-group-ui）。
- 临时脚本已清理。

## 5. 未提交内容（git status）

- 改动：src/core.js、src/overlay-theme.js、src/group.js、src/identity.js、app/service/index.html、app/service/group.html、dist/*、app/{browser,extension}/core.js、dev/*.test.mjs
- 新增：cloudbase/、app/service/vendor/、app/service/cb-config.js、dev/group_hub.test.mjs、dev/dock-*.mjs、dev/proto-*.mjs、dev/fixture-host.html、dev/fixture-video.html（本轮）、dev/dock-mobile-interact.mjs（本轮）、docs/*r4b*、docs/assets/*（截图）

## 6. 踩坑备忘（下个会话注意）

- 本 agent（deepseek-v4.1-flash）在长上下文里**反复生成畸形工具调用**（伪 invoke/parameter），会被静默吞掉 → 以为改了其实没改。对策：关键改动后必须回读；复杂调用拆小；已写入 AGENTS.md。
- opencode 已知家族：#13900、PR #21688、#2132/#1693 等，「malformed tool args 静默失败」值得单独提 issue。
