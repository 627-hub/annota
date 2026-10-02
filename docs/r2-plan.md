# Annota R2 多媒态 · 实施方案

> 承接 [`implementation-plan.md`](implementation-plan.md) 的 R2「多媒态」。本文是 R2 的**详细做法归档**，
> 目标：compact / 换会话后仍能照此续做。原则：**接缝先行（媒态收进 binding 层）→ 每媒态一个可独立验收的增量**。

---

## 0. 背景与不变量

R1 的 `core.js` 假设「唯一媒态 = `<video>`」：`state.video`、全局 `visibleNow/LEAD`、条目一律 `box`。
R2 要同时支撑 **视频 / 图片 / 文章**，做法不是到处加 `if (isImage)`，而是**把差异收进一层 binding**。

**不变量（改任何东西都不能破）：**

1. 注入 UI 全在 Shadow DOM（`#annota-shadow-host` → `.va-ui-root`）；视觉深色玻璃 + 琥珀 `#F5A623`。
2. `pack` 形状向后兼容：`{ format, media, entries }`；`format` 以**服务端回显**为准，本地新建默认 `video-annotate/0.1`。
3. `media` 至少含 `{ platform, type, mediaId, videoId, url, title }`；**`videoId` 与 `mediaId` 双写**（读旧不破）。
4. 条目形状守卫：`word` 非空 且（`box` 合法 **或** `quote.exact` 非空）。脏数据不进、不抛。
5. 安全红线：仓库/产物无局域网 IP、主机名、`/Users/lhq`、密钥；`dist/*.user.js` 保持 `VA_SYNC_URLS=[]`。
6. 端口：Rust 本地服务 **8793**（`HOST=127.0.0.1`）、MCP **8794**；`va_fetch` 白名单限 `127.0.0.1:8793`。

**数据模型扩展（R2 终态）：**

```
media:  { platform, type: 'video'|'image'|'article', mediaId, videoId, url, title,
          intrinsic?: {w,h} }            // image/video 用；article 省略
entry:  { id, word, ...,
          box?:   {x,y,w,h},              // 归一化 [0,1]，相对「内容矩形」
          quote?: { exact, prefix?, suffix?, start?, end? },   // 文章文本锚点
          t?: number, dur?: number,       // 仅 timed 媒态
          rects?: [...] }                 // 可选：多矩形（跨行高亮缓存）
```

`box` 与 `quote` **互斥语义、二选一**：`box` 用于 video/image，`quote` 用于 article。
同一条目不同时带两者；服务端合并按锚点分流去重。

---

## 1. 分层与文件职责

| 文件 | 职责 | R2 动作 |
|---|---|---|
| `src/geometry.js` | 纯函数：坐标换算、`contentRect`（已兼容 `object-fit`） | 复用；新增长图映射纯函数（Step 3） |
| `src/adapter.js` | 平台识别、`findVideo`、`watch` | 新增 `findImage`；`watch` 回调带 `kind` |
| `src/media.js` | **媒态 binding 层**（R2 新增核心） | `VideoBinding`（已有）→ `ImageBinding`、`ArticleBinding` |
| `src/core.js` | 标注核心 + 注入 UI，**只面向 binding 接口** | 已完成 `state.video`→`state.binding`；补无时间轴 UI 分支 |
| `src/overlay-theme.js` | 注入态全量 CSS | 补 quote 高亮、图片态样式 |
| `src/textquote.js` | **文章划词纯函数**（Step 5 新增） | 定位/序列化 TextQuoteSelector |
| `build.py` | 拼接顺序 | `PARTS=["geometry.js","adapter.js","media.js"]`；`TAIL` 追加 `textquote.js`（Step 5） |

**MediaBinding 接口契约**（core 只依赖这些，`src/media.js` 顶部注释即权威文档）：

```
kind, timed, capture           能力标记（video/image timed=false→无时间轴）
el                             宿主元素（article 为 null）
ready()                        是否可标注
mediaId(), mediaMeta()         标识与 pack.media
layout()                       {rect, cr} | null（无轴媒态返回 null）
entryRects(e, cr)              像素矩形列表（渲染唯一入口，支持多矩形）
isVisible(e)                   当前是否显示
locate(e)                      跳转/滚动到该标注
time(), seek(t), setPlaying(b) 时间能力（timed 才有意义）
beginAnnotate(), endAnnotate() 进入/退出标注模式
capturePayload()               提交时额外选择的 selector 数据
contextText(), captureRect()   给桌面豆包/agent 的上下文
tick()                         loop 每帧调用；媒体被移除返回 false
destroy()
```

---

## 2. 分步计划（每步独立验收）

### Step 0 · 接缝重构 ✅ 完成（2026-10-02）

- 新增 `src/media.js`：`VAMedia.VideoBinding` 实现上述全套接口；`VAMedia.create({kind,el})`。
- `core.js` 全量 30 处 `state.video` → `state.binding`；`attach(target)` 兼容裸 `<video>` 与 `{kind,el}`；
  `loop()` 走 `binding.tick()/layout()/isVisible()`；`render()` 走 `entryRects(e, cr)`；
  `detach()` 调 `binding.destroy()`；删除 core 内 `visibleNow`/`LEAD`。
- `build.py`：`PARTS = ["geometry.js","adapter.js","media.js"]`。
- **验收**：`python3 build.py` + `node --test dev/geometry.test.mjs` + `node dev/smoke.mjs` + `cargo build` 全过；
  截图对比重构前后（视频标注、编辑卡）行为零变化。

### Step 1 · Schema 与合并规则 ✅ 完成（2026-10-02）

- 三处 `merge_entries` 同步放开 `box|quote` 二选一：
  - `src/core.js`：`validQuote`/`validAnchor`/`sameEntry`/`validEntries`。
  - `app/service/sync_server.py`：`valid_quote`/`valid_anchor`/`same`/`merge_entries`。
  - `app/annota/src/sync_server.rs`：`valid_quote`/`valid_anchor`/`same`/`merge_entries`。
- `format` **回显**（incoming → cur → 默认 `video-annotate/0.1`），不再硬编码。
- `media.type`/`media.mediaId` 双写（core fallback + `media.js`）。
- **验收**：Rust 6 例（`mod r2_merge_tests`）、Python 7 例（`dev/merge_rules.test.py`）、
  端到端（quote 存活 / 按 exact 去重 / format 回显 / `media.type` 保留）。

### Step 2 · 图片标注 MVP ✅ 完成（2026-10-02）

**目标**：普通 `<img>`（含 `srcset`/`<picture>`）可拖框标注，无时间轴 UI，pack 与视频同构。

- `src/adapter.js`：新增 `findImage()`——通用站点（`platform==='generic'`）内**可见面积最大且自然尺寸 ≥200px** 的 `<img>`
  （`naturalWidth>0`，排除视频 `poster`/小图标）；`imageSupported()`；`pageSupported()`；`watch` 回调改 `{kind,el}`；
  `mediaId()` 图片页用 `hashId('image:'+currentSrc)`（画廊换图 → 换 key）。
- `src/media.js`：新增 `ImageBinding(el)`：`kind:'image'`, `timed:false`, `capture:'box'`；
  `layout()` 复用 `VAGeo.contentRect`；`isVisible()` 恒真；`locate()` = `scrollIntoView`；时间能力空操作。
- `src/core.js`：无时间轴分支——面板行/编辑弹窗/查看态隐藏时间字段，非 timed 不按分钟分组、按词排序；
  `videoContext()` 图片显示尺寸而非进度；`render()`/`loop()` 已 binding-generic。
- `dev/image.html` + `dev/sample-image.png`：图片调试页。
- **验收**：`dev/smoke-image.mjs`（图片 binding 走通拖框→绑词→保存；断言 `timed=false`、无 `t` 字段、`media.type='image'`、
  `intrinsic` 正确）通过；`node dev/smoke.mjs` 视频路径不回归；`build.py` + geometry 9 例全绿。
  截图留档（Tauri 内打开 `dev/image.html`）待补。

### Step 3 · 长图与画廊 SPA ✅ 完成（2026-10-02）

**目标**：超高长图（`naturalHeight` 远大于可视）滚动映射正确；图片画廊（多图切换）SPA adapter。

- `src/geometry.js`：加纯函数 `intersects(a,b)`（兼容 `{x,y,w,h}` 与 `{left,top,width,height}`）、
  `scrollMap(box, imgRect, viewport)`（整图归一化 box → 视口像素，超窗口返回 null）。
  单测进 `dev/geometry.test.mjs`（`intersects` + `scrollMap` 共 2 例）。
- `src/media.js` `ImageBinding`：
  - 长图（`imgRect.height > innerHeight`）时 `entryRects`/`isVisible` 走 `scrollMap` 逐帧剔除，
    只渲染落在当前窗口内的框，省 DOM；短图仍恒显示。
  - `layout()` 用整图矩形（含滚动偏移），`cr` 为整图内容矩形。
- **画廊 SPA adapter**：`A.mediaId()` 对图片页用 `hashId('image:'+currentSrc)`；
  core `loop()` 检测 `mediaId` 变化 → `detach`/`reload`，换图后标注按新图 key 归属。
- **验收**：geometry 11 例全过；`dev/smoke-image.mjs` 增画廊切换断言
  （换 `currentSrc` → `mediaId` 变化且仍为 `img-` 前缀）通过。

### Step 4 · 我的库 / 起始页 / MCP 混媒态 ✅ 完成（2026-10-02）

**目标**：`app/service/index.html` 的「我的库」与首页能展示 image/article 条目；入口不串味。

- `app/service/index.html`：
  - 新增 `mediaType`/`mediaTypeLabel`/`typeIcon`（视频/图片/文章三套图标）；
  - 库条目 + 首页卡片加媒态图标、meta 显示「平台 · 媒态 · 更新时间」；
  - `renderEntries` 按 `media.type` 分流：视频显示「时刻」列，图片显示「区域标注」，文章显示只读「锚定文本」；
  - `saveEntries` 保留 pack 原 `format`（不再硬编码 `0.1`）；`recordTitle` 兜底 `media.mediaId`；
  - 文案去「视频页」化（quick-url placeholder、设置页说明）。
- `app/annota/src/main.rs`：
  - `words_at` 按 `media.type` 分流：非视频忽略 t 窗口返回全部；
  - `media_id_from_url` 保持 URL 推导，图片/文章经 `find_pack_key_by_url`（按 `media.url` 扫库）命中。
- `render_note`（Rust + Python）按 `type` 分流：视频保留「时刻/时长」列，非视频改「锚点」列
  （文章输出 `quote.exact`），frontmatter 加 `type`，`media` 字段兜底 `mediaId`。
- **验收**：`dev/merge_rules.test.py` 增 3 例 render_note 分流断言（共 10 例）通过；
  `app/service/index.html` JS `node --check` 通过；`cargo build` 通过。

### Step 5 · 文章划词（`TextQuoteSelector` 纯函数 + 高亮）✅ 完成（2026-10-02）

**目标**：正文段落可划词标注，用文本锚点而非坐标，重排/换字号仍能定位。

- `src/textquote.js`（新，纯函数 + 薄封装，进 `build.py` 的 `PARTS`）：
  - `serialize(range, rootEl)` → `{exact, prefix, suffix, start, end}`（各 32 字上下文）；
  - `locateText(quote, fullText)` → `{start,end}`（offset 命中优先 → prefix+exact+suffix → exact）；
  - `locate(quote, rootEl)` → `Range`（`_advance` 跨文本节点推进边界）；
  - `rectsOfRange(range)` → 多矩形（跨行）。
- `src/media.js` `ArticleBinding(rootEl)`：`kind:'article'`, `timed:false`, `capture:'quote'`, `el:null`；
  `layout()` 覆盖整页；`entryRects` 走 `locate`+`rectsOfRange`；`isVisible` 按视口剔除；
  `serializeSelection()` 读当前 Selection。
- `src/adapter.js`：`findArticle()`（generic 且无视频/大图 → 语义容器 `article/main/[role=main]/.post…` 文本 > 600 字）；
  `watch` 三级退化 video→image→article。
- `src/core.js`：划词模式——不拦截指针、`mouseup` 读选区 → `askWord(null,{quote})`；
  编辑卡显示「锚定文字」预览、隐藏时间字段；`commit` 存 `quote` 而非 `box`；`proposeAnnotation` 接受 `quote`；
  详情弹窗按类型显示锚点/整段。
- `src/overlay-theme.js`：`.va-quote-preview` 引号高亮块、`.va-entry-time--none`。
- `dev/article.html` 调试页。
- **验收**：`dev/textquote.test.mjs` 7 例（offset 命中/上下文消歧/漂移回退/折叠 Range）全过；
  `dev/smoke-article.mjs`（划词→绑词→保存，断言 `capture='quote'`、存 `quote.exact`、无 `box`/`t`）通过；
  视频/图片 smoke 无回归；geometry 11 例 + build + cargo 全绿。

### Step 6 · 手动选择对象 + 去掉「猜主图」+ 图片版本校验 ✅ 完成（2026-10-02）

**背景（为何改）**：`https://opencode.ai/docs/zh-cn/` 里的文档截图劫持整页 → 正文无法标注；
`https://www.pexels.com/`（JS 渲染瀑布流，curl 拿到空壳）三者判定全落空 → 完全无法标注。
**结论**：「最大图 / 占页面主体比例」是不可靠的启发式——真实网页大多没有单一主体。改为
**自动绑定只处理确定信号，不确定一律交给手动选择对象**。

**6.1 手动选择对象（picker）**
- dock 新增「选对象」按钮（dock 常驻，即使无可自动绑定媒态也显示）→ 进入 picker 模式：
  `document` 上捕获阶段监听 `mousemove`，用 `document.elementFromPoint` 取光标下元素，
  `A.classify` 向上归类为 `<video>` / `<img>` / 语义正文容器，加琥珀描边 + 浮动标签；点击即 `attach`。
- picker 期间注入 UI 不拦截指针；`setPageCursor('crosshair')` 用 `* { cursor: crosshair !important }`
  压过站点光标（如 pexels 的放大镜）；`Esc` 退出。
- 选中图片/视频后**自动进入标注模式**（`toggleAnnotate(true)`），用户可立即拖框。
- 任何页面都能用，不依赖启发式；pexels 等站从此可标注。

**6.2 去掉不可靠的自动判断**
- 删除 `imageDominant`（占视口比例）与「同量级大图/兄弟节点数」等脆弱规则。
- 自动绑定只保留**简单可预测**的确定信号：
  - 已知视频站视频页 → 视频；
  - 通用站点**整页仅一张可见大图**（无视频、无成规模正文）→ 图片；
  - 有语义正文容器（`article/main/[role=main]/.post…`，文本 > 600 字）→ 文章；
  - 其余（瀑布流、画廊、列表、多图详情页）→ **不自动绑定**，用「选对象」。
- `findVideo` 加 250ms 短时缓存，避免重页面上每张图全量扫 DOM。
- **不做逐站适配**。
- **实机确认的最终行为**：pexels 首页不自动绑（用「选对象」）；pexels 详情页有多张相关图 → 不自动绑 →
  「选对象」选主图后弹出编辑卡；opencode docs 不再被截图劫持（自动绑为文章）。

**6.3 图片版本校验（跨终端统一性）**
- entry 增存锚定证据：`img.key`（`img.currentSrc || src`）+ `img.natural {w,h}`。
- 渲染时 `imgStale(e)` 校验：不符 → 该框红色虚线 + 提示「图片版本已变，锚点可能需复核」，不静默错位。
- **明确不承诺**：`object-fit:cover` 裁切、响应式换图（`<picture>`/`srcset` 换版本）下的绝对对齐——
  靠用户重新标注兜底。
- **能保证**：单图、详情页主图、手动选定图；归一化坐标跨显示尺寸（窄屏/桌面/resize）稳定。

**6.4 顺带修复（实机暴露）**
- `detach()` 未重置 `shellMounted` → 重绑时 overlay/dock 丢失。已修。
- 标记层 `overlay` 改为**始终覆盖视口**，标记用视口坐标 → 长图/滚动图不再飘出屏幕。
- `loop()` 重绘触发在 `showAll` 分支只清签名不重绘 → 「不点选看不到框」。已改为按当前应显示集合签名重绘。

**验收（已过）**：
- `dev/smoke-article.mjs` 内嵌小图不再劫持；
- `dev/smoke-picker.mjs`：瀑布流不自动绑 → dock 常驻 → 手动选中 → 自动进入标注 → 重绑后壳/overlay 仍在；
- 四套 smoke（video/image/article/picker）+ geometry 11 + textquote 7 + Python 10 + cargo 全绿；
- pexels / opencode docs 实机验证通过。

---

## 3. 测试与验收规范

- **纯函数**：一律进 `dev/*.test.mjs` / `dev/*.test.py`，`node --test` 或 `python3` 直跑。
- **冒烟**：`dev/smoke.mjs`（假 DOM）覆盖每种 binding 的 `attach→标注→pack` 基本路径。
- **服务端**：Rust `cargo test`（合并规则）+ Python `merge_rules.test.py` + 端到端 PUT/GET 脚本（临时，跑完清）。
- **截图留档**：`app/annota/scripts/capture_screenshot.py`（`--navigate`/`--open-panel`/`--propose-word` 可叠加），
  产物进 `docs/assets/`；临时截图放 `/tmp/annota-*`，任务结束清理。
- **发送前**：跑敏感串扫描（局域网 IP / 主机名 / `/Users/lhq` / 密钥 / `VA_SYNC_URLS`）。
- **提交**：仅用户明确要求时 commit/push；作者身份 `627-hub <58074363+627-hub@users.noreply.github.com>`。

---

## 4. 待修与已知风险

| 项 | 说明 | 归属 |
|---|---|---|
| 设置页 AI 状态换行破词 | `.ai-status span` 加 `overflow-wrap:anywhere` 或单行省略 | 独立小修 |
| 助手对话态截图未收录 | 侧栏展开时序不稳，三次仅成功一次 | 留档补齐 |
| 长图性能 | 超高长图逐帧 `getBoundingClientRect` 可能卡 | Step 3，缓存 rect |
| 画廊 SPA 路由拦截 | 不同站 pushState 行为不一 | Step 3，逐站适配 |
| 文章跨 iframe 正文 | 部分站点正文在 iframe 内 | Step 5，先做同文档，iframe 延后 |

---

## 5. 参考

- [`product-spec.md`](product-spec.md) §17（A1–A6 决策）
- [`implementation-plan.md`](implementation-plan.md)（R0–R4 分期 + 进度）
- [`agent-panel-ui-handoff.md`](agent-panel-ui-handoff.md)（1.6/1.8 UI 契约）
- [`mobile.md`](mobile.md)（观看端 M0 验证清单）
