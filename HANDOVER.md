# 交接文件 · video-annotate

> 一句话：**给「别人的内容」加一层可共享的标注**（视频 / 图片 / 文章皆可），众包积累标注与对话数据，
> 终局是训一个 JEV 式 word↔region 决策模型。**不生产内容、不托管媒体**，只存标注。
> 产品形态：**「标注浏览器」**（打开即浏览器、内置标注、下载即用）+ 扩展/脚本铺量；AI 层用桌面豆包当大脑、
> 我们只喂它拿不到的上下文（画面截图 + 秒数 + 你的标注）。
> **市场定位**：不止数据标注，更是「内容之上的社交标注层」。

- 项目路径：`video-annotate/`（仓库根）
- 从 `../ielts-7.5` 拆出（词库/SRS/Anki 为可选下游消费者）
- **git 状态：全部未提交**（`git init` 过，无任何 commit）
- 本文日期：2026-09-30（含 AI 陪练/截图/笔记 与 图片·文章·社交 愿景）

---

## 1. 现在完成了什么

### 标注（编辑端）
- 任意网页 `<video>` 叠层热区；热区 = `word + 中文 + 词性`，按时间窗口显示。
- **拖框标注**：`✎ 标注` → 暂停 → 框选 → 弹层填词。
- **中英词库联想**：输英文（前缀/子串）或中文（释义）→ 下拉选 → 自动填 词/义/词性；词库内联 **11,821 词**（雅思+托福）。
- **时间可调**：每个标注可改 **开始 `t`**（或 `⏱ 用当前`）与**时长 `dur`**（默认 1.0s）；区间 `[t−0.15, t+dur]`。
- 本地存储 `localStorage`（按 `mediaId` 分桶）；导出/导入 JSON pack。
- 平台适配：`bilibili`（播放页/主播放器/SPA 切集）、**`douyin`（穿透 shadow DOM 找 `<video>`）**、`youtube`、`generic`；`ⓘ` 诊断面板；真全屏兜底提示；找不到视频时有「未检测到视频·诊断」浮标。

### 同步
- 工具条 **`⇅ 同步`**：拉取→合并→回传（union），去重 `(word + |Δt|<0.4 + IoU>0.6)`；`⚙` 里另有仅上传/仅下载。
- 服务端 `app/service/sync_server.py`（**纯标准库**）：**单端口 8793** 同时供静态 + API；CORS 全开。
- **零配置**：候选地址烧进脚本（`window.VA_SYNC_URLS`：127.0.0.1 / 局域网IP / `.local`），运行期自动探测。
- 请求通道优先级：`vaFetch(自建浏览器主进程)` ≈ `chrome 扩展后台` > `GM_xmlhttpRequest` > `fetch`（前两者绕过 CORS/混合内容）。

### AI 陪练（豆包）+ 截图 + 笔记（本轮新增）
- 服务端 LLM 代理：`GET /api/ai`（状态）、`POST /api/chat`（转发到豆包/方舟或任意 OpenAI 兼容端点）。**密钥只在服务端**（`sec`/环境变量）。
- **不做第二个豆包**：浏览器内**不内置聊天**（桌面豆包/系统助手更强）。工具条 **`📋 发豆包`** 一键把「**画面截图 + 视频上下文**（平台/链接/标题/进度/已标注词）」写进**富剪贴板** → 到桌面豆包粘贴即问。
- **截图**（让豆包「看见画面」）：自建浏览器 `capturePage` / 扩展 `captureVisibleTab` / 同源 canvas 兜底；截图含标注框。
- **笔记 + 数据沉淀**：`⚙ → 📝 存笔记` → 把「截图 + 生词表」写成 Markdown（`NOTES_DIR`，可指向 Obsidian 库），
  并把 `{media, entries}` 追加进 `data.jsonl`（标注数据沉淀）。
- 本地服务保留 `/api/ai`、`/api/chat`（**备用**：留给后续动作型 AI 与 MCP，不在 UI 暴露）。

### 分发形态（都可运行）
| 形态 | 路径 | 说明 |
|---|---|---|
| **自建浏览器（Electron）** | `app/browser/` | 品牌载体；内置 core；同步/截图走主进程 |
| **MV3 扩展** | `app/extension/` | Chrome/Edge；`background.js` 代发请求 + 截图 |
| **userscript** | `dist/annotate*.user.js` | 编辑 / GM / 观看端（只读+自动同步） |
| Android 自带油猴的开源浏览器 | `docs/browser.md` | Ezo / GuaBrowser / Solipsism / Cromite，零 fork |

### 辅助
- `dev/hub.py`：一键入口（探测地址→烧地址→构建→起服务→入口页+二维码）；`--tunnel` 起 https 隧道（带自检）。
- 测试：`geometry.test.mjs`(9) + `vocab.test.mjs`(4) + `smoke.mjs`（假 DOM 冒烟）。
- 文档：`docs/spec.md`、`install.md`、`mobile.md`、`sync.md`、`browser.md`、**`ai.md`**、**`notes.md`**。

---

## 2. 怎么跑

```bash
python3 dev/hub.py                 # 一键：构建+起服务(8793)+入口页 http://127.0.0.1:8793/
bash dev/app.sh                    # 自建浏览器（Electron，依赖已装）
python3 app/service/sync_server.py # 只起服务（0.0.0.0:8793）
python3 build.py                   # src/*.js + vocab → dist/*.user.js + app/*/core.js
node --test dev/geometry.test.mjs dev/vocab.test.mjs && node dev/smoke.mjs
bash dev/portable.sh <url>         # 用系统 Chromium 系浏览器加载扩展
```

配置（AI 与笔记）：
```bash
sec set ark                                  # 豆包/火山方舟 Key（也支持 sec set doubao）
export ARK_MODEL="ep-2025xxxx-xxxxx"         # 视觉模型才好读截图
export NOTES_DIR="/path/to/your/ObsidianVault/annota"   # 笔记输出到 Obsidian 库
# 或接任意 OpenAI 兼容：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
```

端口：**8793**（主：静态+API）、**8792**（`dev/serve.py` 纯静态，遗留）。

---

## 3. 代码结构

```
video-annotate/
├── src/
│   ├── geometry.js      # 内容区坐标（contain/cover/fill…；DOMRect 兼容；clamp/IoU）——可单测
│   ├── adapter.js       # 平台：generic/bilibili/douyin/youtube；选主视频(穿透 shadow DOM)；mediaId
│   ├── vocab.js         # 中英词库联想索引——可单测
│   └── core.js          # 叠层/拖框/绑词/时间/同步/导入导出/诊断/观看端/AI面板/截图/笔记
├── build.py             # 拼装产物（UTF-8 BOM；写 dist/ 与 app/extension|browser/core.js）
├── build_vocab.py       # 词表 → dist/vocab.json
├── dist/                # annotate.{user,gm,view}.user.js + vocab.json
├── app/
│   ├── browser/         # main.js(窗口/net.fetch/capturePage/rich clipboard) + shell-preload + webview-preload + index.html + renderer.js + core.js
│   ├── extension/       # manifest.json + background.js(fetch+captureVisibleTab) + core.js
│   └── service/         # sync_server.py（静态 + 同步 + /api/chat + /api/note）；store/ notes/(gitignore)
├── dev/                 # hub.py / serve.py / app.sh / portable.sh / demo.html / 单测 / smoke / sample.mp4
├── schemas/annotation.schema.json   # W3C Web Annotation 对齐草案
├── docs/                # spec install mobile sync browser ai notes
├── README.md
└── HANDOVER.md          # 本文件
```

### 数据 / 接口速查
- **pack**：`{format:"video-annotate/0.1", media:{platform,videoId,url,intrinsic:{w,h}}, entries:[{id,t,box:{x,y,w,h},word,label,pos,dur,created}]}`
- **box**：左上角 `x,y,w,h`（0–1），按**内容区**归一化（去黑边），配 `intrinsic` 复投影 → 兼容全屏/画中画/缩放。
- **API**：`GET /api/health`、`GET /api/list`、`GET|PUT /api/anno/<mediaId>`、`GET /api/ai`、`POST /api/chat`、`POST /api/note`；`GET /` = 入口页。
- **笔记产物**：`<NOTES_DIR>/<date>_<mediaId>.md` + `.../shot.png` + `<NOTES_DIR>/data.jsonl`。
- **终局模型（未开始）**：JEV 式 word↔region 决策（Choice/Noul/Score，prefill-only）——见 `docs/spec.md §9`。

---

## 4. 关键决策 & 原因

1. **拆出独立项目**：目标（AI 应用 + 标注大模型）与雅思线偏离。
2. **只共享标注、不搬媒体**：绕开托管版权；标注可去中心化交换（Pack/Feed）。
3. **自建浏览器用 Electron 壳**（不 fork Chromium）：品牌认知需要「下载即用的标注浏览器」，但 fork Chromium 维护地狱。
4. **同步优先 GM/扩展/浏览器主进程通道**：`https 页面 → http 局域网` 会被**混合内容**拦截，只有扩展/主进程能绕。
5. **通用聊天不自建，交给桌面豆包**；我们只做「**上下文桥**（截图+秒数+标注）+ 动作型 AI」——上下文与数据才是护城河。
6. **词库内联**：离线可用（代价：产物 ~745KB）。
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

1. **数据管理台**：起个页面查看已收集的 `data.jsonl`（标注 + 对话），按视频/词聚合，一键导出训练集——让「数据引擎」可见可用。
2. **图片标注**（复用 `geometry`）：把核心从 `<video>` 泛化到 `<img>`/画布，验证「多媒态」假设。
3. **文章标注 + comments**：引入 W3C 文字选择器，标注网页段落/句子，支持评论。
4. **AI 建议框**（视觉开放词表，人工确认）——真护城河。
5. **Agent loop（方舟 function calling）**：见 §7.5 方案 1/2 —— `POST /api/agent` + 工具 + 多轮循环，把「浏览器里的 agent」真正做出来。
6. **打包分发**：`electron-builder` 出 `.dmg/.exe`；扩展上架 Chrome/Edge。
7. **终局模型**：按 `docs/spec.md §9` 的 Phase A→B→C 推进 JEV 式 word↔region 决策。

---

## 9. 立即接手要点（TL;DR）

- 跑起来：`python3 dev/hub.py` + `bash dev/app.sh`（自建浏览器）。
- 改代码：只改 `src/*.js` → `python3 build.py`（产物/扩展/浏览器三处 core 一起更新，**别手改 core.js**）。
- 改完必跑：`node --test dev/*.test.mjs && node dev/smoke.mjs`。
- AI/笔记：`sec set ark`；接 Obsidian 设 `NOTES_DIR`。
- **git 未提交**：需要留档请先 `git add/commit`。
