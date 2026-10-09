# 交接文件 · Annota

> 一句话：**给「别人的内容」加一层可共享的标注**（视频 / 图片 / 文章皆可），众包积累标注与对话数据，
> 终局是训一个 JEV 式 word↔region 决策模型。**不生产内容、不托管媒体**，只存标注。
> 产品形态：**「标注浏览器」**（打开即浏览器、内置标注、下载即用）+ 扩展/脚本铺量；AI 层用桌面豆包当大脑、
> 我们只喂它拿不到的上下文（画面截图 + 秒数 + 你的标注）。
> **市场定位**：不止数据标注，更是「内容之上的社交标注层」。

- 项目路径：`video-annotate/`（仓库根）
- 从 `../ielts-7.5` 拆出（词库/SRS/Anki 为可选下游消费者）
- **最近提交**：`7f5e859`（M6a–M7：会话恢复、浏览器功能补齐、浮层重构、菜单与视觉精简 + OCR 修复），已推送 `origin/main`，工作区干净。
- 本文日期：2026-10-07（**最新进展见 [`docs/progress-2026-10-04-shell-plan.md`](docs/progress-2026-10-04-shell-plan.md)：M6a–M7 已完成，M8 待办**）

---

## 0. 发布与提交约定（重要，先读这段）

**CloudBase 试用额度有限 → 日常改动只提交 git，不要发布。**

| 动作 | 何时做 |
|---|---|
| `git commit` | **每次改完都做**（本项目唯一的留档手段） |
| `git push` | 提交后即可推（纯 fast-forward，不强推） |
| `sh cloudbase/publish.sh` | **仅在需要真机验证、或准备发版时**做。会消耗 CloudBase 额度 |

- 发布会让线上 `@version` +1，**所有用户端会收到更新提示**。为避免小额改动反复打扰用户，
  攒够一批再发。
- 允许线上落后于本地：本地 `VERSION` / `dist/version.json` 会持续前进，线上落后是预期状态。
  任何时候想补发，跑 `sh cloudbase/publish.sh` 即可（幂等，会覆盖线上三个脚本与 `version.json`）。
- 发布后校验：线上 `version.json` 的 `usVersion`、三个脚本与 `dist/` 的 sha256 是否一致。

**其它提交约定**
- `dist/` 产物与 `docs/assets/*.png` 截图**入库**（沿用既有惯例，便于回溯当时状态）。
- `push` 前必须 `git fetch` 确认无分叉；网络不稳时**宁可重试也不要强推**。
- 运行时数据（`app/service/annota.db`、`app/service/tabs.json`）已在 `.gitignore`，不要提交。

---

## 1. 现在完成了什么

### 标注（编辑端）
- 任意网页 `<video>` 叠层热区；热区 = `word + 中文 + 词性`，按时间窗口显示。
- **拖框标注**：`✎ 标注` → 暂停 → 框选 → 弹层填词。
- **填词标注**：词必填、释义/词性选填；EditorCard 查词行外链剑桥/有道/欧路（内联词库 11,821 词已按决策 A3 下线，745KB→0）。
- **时间可调**：每个标注可改 **开始 `t`**（或 `⏱ 用当前`）与**时长 `dur`**（默认 1.0s）；区间 `[t−0.15, t+dur]`。
- 本地存储 `localStorage`（按 `mediaId` 分桶）；导出/导入 JSON pack。
- 平台适配：`bilibili`（播放页/主播放器/SPA 切集）、**`douyin`（穿透 shadow DOM 找 `<video>`）**、`youtube`、`generic`；`ⓘ` 诊断面板；真全屏兜底提示；找不到视频时有「未检测到视频·诊断」浮标。

### 同步
- 工具条 **`⇅ 同步`**：拉取→合并→回传（union），去重 `(word + |Δt|<0.4 + IoU>0.6)`；`⚙` 里另有仅上传/仅下载。
- 桌面版内置 Rust 服务监听 **127.0.0.1:8793**（本地页面 + 同步 API）；独立 `app/service/sync_server.py` 是纯标准库 LAN 服务，供 userscript 配对同步。
- **零配置**：候选地址烧进脚本（`window.VA_SYNC_URLS`：127.0.0.1 / 局域网IP / `.local`），运行期自动探测。
- 请求通道优先级：`vaFetch(自建浏览器主进程)` ≈ `chrome 扩展后台` > `GM_xmlhttpRequest` > `fetch`（前两者绕过 CORS/混合内容）。

### AI 上下文桥 + 截图 + 笔记
- 桌面 Rust 服务目前 `GET /api/ai` 仅报告 LLM 配置状态；内置聊天 Agent UI 与工具调用审计（R1-3）**搁置**。
- 独立 Python 服务保留可选 LLM 代理；密钥只从环境变量读取，不随发行包分发。
- **不做第二个豆包**：浏览器内**不内置聊天**（桌面豆包/系统助手更强）。工具条 **`📋 发豆包`** 一键把「**画面截图 + 视频上下文**（平台/链接/标题/进度/已标注词）」写进**富剪贴板** → 到桌面豆包粘贴即问。
- **截图**（让豆包「看见画面」）：自建浏览器 `capturePage` / 扩展 `captureVisibleTab` / 同源 canvas 兜底；截图含标注框。
- **笔记 + 数据沉淀**：`⚙ → 📝 存笔记` → 把「截图 + 生词表」写成 Markdown（`NOTES_DIR`，可指向 Obsidian 库），
  并把 `{media, entries}` 追加进 `data.jsonl`（标注数据沉淀）。
- MCP server 默认 `127.0.0.1:8794/mcp`，与桌面同步服务分别监听。

### 分发形态（都可运行）
| 形态 | 路径 | 说明 |
|---|---|---|
| **自建浏览器（Tauri v2）** | `app/annota/` | 品牌载体；内置 core；Rust 本地服务与 MCP |
| **MV3 扩展** | `app/extension/` | Chrome/Edge；`background.js` 代发请求 + 截图 |
| **userscript** | `dist/annotate*.user.js` | 编辑 / GM / 观看端（只读+自动同步） |
| Android 自带油猴的开源浏览器 | `docs/browser.md` | Ezo / GuaBrowser / Solipsism / Cromite，零 fork |

### 辅助
- `dev/hub.py`：一键入口（探测地址→烧地址→构建→起服务→入口页+二维码）；`--tunnel` 起 https 隧道（带自检）。
- 测试：`geometry.test.mjs`(9) + `smoke.mjs`（假 DOM 冒烟）。
- 文档：`docs/spec.md`、`install.md`、`mobile.md`、`sync.md`、`browser.md`、**`ai.md`**、**`notes.md`**。

---

## 2. 怎么跑

```bash
python3 dev/hub.py                 # userscript 本地服务与入口页
(cd app/annota && cargo tauri dev) # Tauri 桌面浏览器（主线）
python3 build.py                   # src/*.js → dist/*.user.js + app/*/core.js
node --test dev/*.test.mjs && node dev/smoke.mjs   # 基础回归
sh cloudbase/publish.sh            # 发布 userscript（**消耗额度，仅在需要真机验证时**，见 §0）
bash dev/portable.sh <url>         # 用系统 Chromium 系浏览器加载扩展（开发者模式，不会自动更新）
```

配置（AI 与笔记）：
```bash
sec set ark                                  # 豆包/火山方舟 Key（也支持 sec set doubao）
export ARK_MODEL="ep-2025xxxx-xxxxx"         # 视觉模型才好读截图
export NOTES_DIR="/path/to/your/ObsidianVault/annota"   # 笔记输出到 Obsidian 库
# 或接任意 OpenAI 兼容：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
export ANNOTA_SEARCH_ENGINE="https://www.bing.com/search?q="   # omnibox 搜索回落引擎
```

端口：**8793**（主：静态+API）、**8794**（MCP）、**8792**（`dev/serve.py` 纯静态，遗留）。

> `app/browser/`（Electron）已冻结：不再投入，保留末版；`build.py` **不再**生成其 `core.js`（M8-1，2026-10-09），
> M8 起停发。主线是 `app/annota/`（Tauri）。

---

## 3. 代码结构

```
video-annotate/
├── src/
│   ├── geometry.js      # 内容区坐标（contain/cover/fill…；DOMRect 兼容；clamp/IoU）——可单测
│   ├── adapter.js       # 平台：generic/bilibili/douyin/youtube；选主视频(穿透 shadow DOM)；mediaId
│   ├── core.js          # 叠层/拖框/绑词/时间/同步/导入导出/诊断/观看端/AI面板/截图/笔记
│   ├── browser-shell.js # 浏览器壳接缝（M2 接缝 + M5 常驻编辑抽屉）；契约见 docs/shell-contract.md
│   ├── overlay-theme.js # 注入态样式（含 .va-panel--docked 编辑抽屉、.va-fold 折叠组）
│   └── version-check.js # 版本探测兜底：落后则提示重装（重装链接按变体区分）
├── build.py             # 拼装产物（UTF-8 BOM；写 dist/ 与 app/extension|browser/core.js）
├── dist/                # annotate.{user,gm,view}.user.js + annotate.browser.js（不内联词库）
├── app/
│   ├── annota/          # Tauri v2 桌面浏览器（主线）：Rust 同步服务 + MCP + tabs/store
│   │   ├── public/      # index.html（两行式工具栏）、overlay.html（下拉浮层）
│   │   ├── permissions/ # Tauri 命令权限（tabs/toolbar/find/devtools + autogenerated）
│   │   └── src/         # main.rs / tabs.rs / store.rs / sync_server.rs / apkg.rs / agent.rs
│   ├── extension/       # manifest.json + background.js(fetch+captureVisibleTab) + core.js
│   └── service/         # 本地页 + 纯标准库 sync_server.py；store/ notes/(gitignore)
├── dev/                 # hub.py / 单测 / smoke / Playwright 校验脚本 / fixture-*.html
├── schemas/annotation.schema.json   # W3C Web Annotation 对齐草案
├── docs/                # spec install mobile sync browser ai notes + progress-*
├── README.md
└── HANDOVER.md          # 本文件
```

### 数据 / 接口速查
- **pack**：`{format:"video-annotate/0.1", media:{platform,videoId,url,intrinsic:{w,h}}, entries:[{id,t,box:{x,y,w,h},word,label,pos,dur,created}]}`
- **box**：左上角 `x,y,w,h`（0–1），按**内容区**归一化（去黑边），配 `intrinsic` 复投影 → 兼容全屏/画中画/缩放。
- **桌面 API**：`GET /api/health`、`GET /api/list`、`GET|PUT /api/anno/<mediaId>`、`GET /api/ai`、`POST /api/note`、
  `GET|POST|DELETE /api/bookmarks`、`GET|DELETE /api/history`、`GET|DELETE /api/downloads`、
  `GET /api/omnibox?q=`、`GET|PUT /api/settings`、`GET /console`；`GET /` = Annota 首页。Python 服务有独立接口实现。
- **Tauri 命令**（工具栏/浮层用，`app/annota/src/main.rs`）：
  `navigate_browser`、`browser_action`、`tab_new/activate/close/move/session_clear`、`tabs_snapshot`、
  `overlay_open/close`、`set_shell_mode`、`set_toolbar_height`、`find_in_page`、`set_zoom`、`open_devtools`、`va_fetch`。
  每个命令都必须在 `permissions/*.toml` 声明 **且**被 `capabilities/default.json` 引用（`dev/check-tauri-permissions.mjs` 守着这条）。
- **笔记产物**：`<NOTES_DIR>/<date>_<mediaId>.md` + `.../shot.png` + `<NOTES_DIR>/data.jsonl`。
- **终局模型（未开始）**：JEV 式 word↔region 决策（Choice/Noul/Score，prefill-only）——见 `docs/spec.md §9`。

---

## 4. 关键决策 & 原因

1. **拆出独立项目**：目标（AI 应用 + 标注大模型）与雅思线偏离。
2. **只共享标注、不搬媒体**：绕开托管版权；标注可去中心化交换（Pack/Feed）。
3. **自建浏览器用 Tauri v2 壳**（不 fork Chromium）：品牌认知需要「下载即用的标注浏览器」，但 fork Chromium 维护地狱。
4. **同步优先 GM/扩展/浏览器主进程通道**：`https 页面 → http 局域网` 会被**混合内容**拦截，只有扩展/主进程能绕。
5. **通用聊天不自建，交给桌面豆包**；我们只做「**上下文桥**（截图+秒数+标注）+ 动作型 AI」——上下文与数据才是护城河。
6. **词库内联 → 已下线**：曾离线可用（代价 ~745KB）；R1 按决策 A3 整体移除（745KB→0，注入产物约 27.8 KB gz），查词改走外链词典。
7. **坐标必须内容区归一化**：曾因 `getBoundingClientRect()` 的 `width/height` 与代码里的 `w/h` 不一致 → 全 NaN → 框选失效；已兼容并加回归测试。
8. **产物带 UTF-8 BOM**：本地简单 http 服务不给 charset，中文会乱码。
9. **不造轮子**：追踪/分割用现成（CoTracker/SAM2）；字幕查词/Anki 用现成（Yomitan/asbplayer）；通用语音/Agent 用桌面豆包。

---

## 5. 已知限制 / 坑

- **真全屏**：`<video>` 自身全屏时无法叠加（提示改用网页全屏/影院模式）。
- **iOS**：无截图/AI 抓帧；真机 https 同步需 GM 变体脚本。
- **隧道**：`*.trycloudflare.com` 国内 DNS 常被污染，不可靠；`hub.py --tunnel` 会自检。
- **同步无鉴权/无账号**：局域网内可读写；仅可信网络。
- **Electron 浏览器**：抖音有站点检测（已做 shadow DOM 适配，仍可能受登录墙影响）。
- **语音输入**：`Web Speech` 在 Chrome/Edge 可用，**Electron 内可能不可用**（无 Google 语音服务）→ 回退文字；真语音需接服务端 ASR。
- **视觉理解**需 `ARK_MODEL` 选支持图片的模型，否则截图被忽略。
- **端口占用**：`hub.py` 见端口已占用**不会重启服务**（改服务端代码后需手动 kill）。
- **Electron 安装**：需镜像 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（`dev/app.sh` 已内置）。

---

## 6. 环境相关

- 已装：**cloudflared** `~/.local/bin/cloudflared`；**Rust** `~/.rustup`（Tauri 备选，尚未用）；Electron（`app/browser/node_modules`）。
- macOS 防火墙：已放行 python 入站。
- 手机连不上排查：① 关 VPN ② 同一 Wi‑Fi（非访客网络）③ 防火墙放行 ④ `http://<IP>:8793/api/health` 自测。
- 密钥统一走 `sec`（豆包用 `sec set ark`）。

---

## 7. 愿景扩展（新提出）：从「视频标注」到「通用内容标注 + 社交」

用户新方向：**图片可标注、文章可写 comments、Facebook/X/Ins 也可标注 → 不止数据标注市场，也是社交市场。**

- **多媒态（一套数据模型通吃）**
  | 媒态 | 选择器 | 说明 |
  |---|---|---|
  | 视频 | `t + box` | 已支持 |
  | **图片** | `box` | **直接复用 `geometry.js`**：把「内容区」换成图片显示区，`t/dur` 置空即可（最小改动） |
  | **文章/网页** | **文字范围**（W3C `TextQuoteSelector`/`TextPositionSelector`）+ **评论**（`motivation:"commenting"`） | 不画框，标句子/选区；正是 W3C 的原生用例 |
- **多平台**：现有 bilibili/douyin/youtube/generic → 扩 **Facebook / X(Twitter) / Instagram**。同为网页内容，走同一 `adapter` + `core`；难点是登录墙与反爬。
- **社交属性**：标注是「内容之上的一层」——别人的内容 + 我们的标注 + 共享/关注/热门/幂等合并。
  → 定位从「数据标注」升级为「**社交标注层**」（内容不搬，只在上面加可共享的一层）。
- **结构优势**：现有 `entries[{box,word,…}]` 已是 **W3C Web Annotation** 的子集；图片=去时间维、文章=换 `selector`、评论=换 `body`。**同一套 schema 通吃**——这是本项目最大的结构性红利。
- **落地顺序建议**：① **图片标注**（复用 geometry，最小改动，可当第二个场景验证）② **文章文字标注 + comments**（引入 TextQuoteSelector）③ **社交平台 adapter**（FB/X/IG）④ **社会化**（关注 / 发现 / 热门标注，需轻后端）。

---

## 7.5 Agent / MCP 接入（重要取舍，2026-09-30 调研结论）

**用户结论**：「API 才有 MCP 接入；豆包 GUI（工作任务模式/PC 客户端）不对外提供 MCP。想用 Claude/LobeChat 那类客户端走 MCP 用豆包，得靠社区 `doubao-mcp-server` + 方舟 API。」
**核心矛盾**：桌面豆包（GUI）才是 agent，但**浏览器够不着它**；方舟 API 能调，但**API 不是 agent**。

### 能力矩阵
| 目标 | 方舟 API | 豆包 GUI |
|---|---|---|
| 程序自动调用 | ✅ | ❌ |
| MCP 工具调用 | ✅（可选） | ❌ |
| 会操作文件/浏览器/定时任务的 **agent** | ❌（API 做不了 agent 的活） | ✅ 工作任务模式 |
| 浏览器直接调 | ✅（已有 `/api/chat`） | ❌（只能用**剪贴板桥** `📋 发豆包`） |

> 结论：**「浏览器 → 直接调豆包 agent」这条路不存在。** 要么用 API（丢 agent）、要么用 GUI（丢自动调用）。

### 可行办法（按可行性）
1. **方舟 API + 自己写 agent loop（推荐，唯一真解）**：「agent 的活」＝**工具 + 多轮循环**，不是非得豆包 GUI。
   把我们的工具实现成函数，走方舟 **function calling / MCP 工具调用**：
   `list_annotations(videoId)`、`words_at(t)`、`save_note(...)`、`suggest_boxes(frame, words)`。
2. **我们自建浏览器当 agent 宿主**（＝把 1 做进 `app/browser`）：截图 → API(function calling) → 执行工具 → 再问。**完全绕开豆包 GUI。**
3. **GUI 自动化桥**（连豆包 GUI agent，但脆）：`osascript`/辅助功能驱动豆包 PC 客户端：复制截图+上下文 → 激活窗口 → 粘贴/回车 → 读回。**依赖 UI 结构、易碎、需辅助功能授权**，只做 demo 不做主力。
4. **换有 MCP 的宿主（Hermes / Claude Desktop / LobeChat）**：是「**它们用我们的数据**」（我们做 MCP server），不是「我们调豆包」。要「现成 agent 能力」时是干净解法。

### 待办
- [ ] 服务端 `POST /api/agent` + 工具定义 + 多轮循环（方案 1/2）。
- [ ] 是否要做成 **MCP server**（让 Hermes/Claude Desktop 直接调我们的数据）。
- [ ] 方案 3 仅作可选项，不投入。

---

## 8. 下一步（建议）

**M8（浏览器收尾）**
1. **Electron 冻结**：✅ 已完成（2026-10-09）——`app/browser/` README 已标 DEPRECATED；`build.py` 停发其
   `core.js`；README 更新。P1 其余收尾（前进/后退、tab 标题、查找计数、健壮性、in-app key）见
   `docs/product-plan.md` P1。
2. **标注菜单继续精简**：`core.js` 的「更多」菜单已从 22 压到 7 个首屏元素（低频项收进
   「高级设置」「组管理」折叠区）。仍可考虑：把「组管理」整块移出菜单（已有 hub 组页）。
   （`pw dev/more-menu-check.mjs` 已 36/36，本轮不再动。）

**产品主线**
3. **数据管理台**：查看已收集的 `data.jsonl`（标注 + 对话），按视频/词聚合，一键导出训练集。
4. **AI 建议框**（视觉开放词表，人工确认）——真护城河。
5. **Agent loop（方舟 function calling）**：见 §7.5 方案 1/2 —— `POST /api/agent` + 工具 + 多轮循环。
6. **打包分发**：`electron-builder` 出 `.dmg/.exe`；扩展上架 Chrome/Edge。
7. **终局模型**：按 `docs/spec.md §9` 的 Phase A→B→C 推进 JEV 式 word↔region 决策。

> 图片标注（`geometry` 复用）与文章标注 + TextQuoteSelector 已在 R2 完成，见 §1。

---

## 9. 立即接手要点（TL;DR）

- 跑起来：`python3 dev/hub.py`（userscript 本地服务）/ `cd app/annota && cargo tauri dev`（桌面浏览器）。
- 改代码：只改 `src/*.js` → `python3 build.py`（产物/扩展/浏览器三处 core 一起更新，**别手改 core.js**）。
- 改完必跑：`node --test dev/*.test.mjs && node dev/smoke.mjs`。
  新增 UI 改动还要跑对应的 Playwright 脚本（见下表）。
- AI/笔记：`sec set ark`；接 Obsidian 设 `NOTES_DIR`。
- **提交即留档**：改完 `git add/commit`（见 §0 发布约定——**不要顺手 publish**）。
- 代码审查：`ocr review --provider opencode-go --effort low`（**必须用 low**，high/medium 在大 diff 上会超时且无输出）。

### 回归脚本对照（改动类型 → 必跑）

| 改动 | 脚本 |
|---|---|
| 任何改动 | `node --test dev/*.test.mjs`、`node dev/smoke*.mjs`、`cargo test` |
| `core.js` 菜单 / dock | `pw dev/more-menu-check.mjs`（36 项） |
| `index.html` 工具栏 | `pw dev/toolbar-browser.mjs`（19 项）、`pw dev/chrome-preview.mjs`（13 项） |
| `overlay.html` 浮层 | `pw dev/overlay-check.mjs`（22 项） |
| `capabilities/` / `permissions/` | `node dev/check-tauri-permissions.mjs`（3 项，含自检） |
| `core.js` 浏览器壳接缝 | `node dev/check-shell-drift.mjs`（6 项） |

### 已知的坑（别重复踩）

- **恒真断言**：检查器/守卫脚本必须自己证明能报错。本项目已两次栽在这上面
  （权限检查器曾把被检查项塞进白名单、`version_check.test.mjs` 曾因 mock 不回调而只跑一半却 exit 0）。
  写完断言务必**注入一个坏输入验证它会 FAIL**。
- **事件桥可能不可用**：`withGlobalTauri: true` 已配，但 `.event` 在部分上下文不暴露。
  工具栏已加 `tabs_snapshot` 轮询兜底（500ms 首拉 + 1500ms 间隔）——新增事件订阅时注意同样要有降级路径，
  别写成 `if (能力) { 订阅 }` 这种静默失效的形态。
- **`window.find` 参数位**：第 3 位是 `backwards`、第 7 位是 `showDialog`，写错会弹出原生查找框。
- **子 webview 叠放**：macOS 上按**添加顺序**叠放，后加的在上。工具栏先加 → 永远在页面之下；
  浮层必须按需创建（才能自然在最上层）。`always_on_top` 只适用于 `WebviewWindow`，不适用 child webview。
- **`on_navigation(|_| false)` 会拦掉 webview 自身的初始加载** → 得到 URL 为空的空白 webview。
