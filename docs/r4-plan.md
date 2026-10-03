# R4 社交层实现方案（r4-plan.md v0.2 · GitStore 主路径）

> 承接 [`roadmap.md`](roadmap.md) §4/§6、[`architecture.md`](architecture.md) ADR-1~6、[`product-spec.md`](product-spec.md) §9/§11、[`implementation-plan.md`](implementation-plan.md) R4。
> **已锁定**：小组共享（非社交网络）；**组后端 = Git 仓库（GitHub / Gitee Contents API），零自建服务器**；云服务器后议；托管 GitHub Pages / Gitee Pages；
> R4a 口令/token 先行、R4b 接 OAuth；匿名读公开页；登录绑高意愿动作；**版本管理直接用 git**（fork/还原/历史原生）；entry 带 `updated`。
> 本文细化到文件与端点级，可直接拆任务执行。v0.2 相对 v0.1 的核心变更：**主路径由 "本地 sync_server 当 hub" 改为 "GitStore（git 仓库当后端）"**，hub 降为可选未来实现。

---

## 0. 总纲

### 0.1 组 = 一个 git 仓库

- 组的数据就是仓库里的文件：`group.json`（组清单 + 片单 + 成员 + packIndex）、`packs/<mediaKey>.json`（每个媒体一个现有 Pack，格式零改动）。
- **读**：`raw.githubusercontent.com` / Gitee raw；公开组可匿名读，也可走 Pages。
- **写**：`PUT contents` API（`GET sha → 本地 merge → PUT base64`；`409`（sha 过期）→ 取新 sha 重试）。
- **鉴权**：写入 token = 建组者签发的 **fine-grained PAT**（仅该仓 `contents:write`）= **"组写口令"**；成员通过邀请链接获得。**私密组靠"仓库私有 + token 不下发"**，真私密（不是 obscurity）。
- **版本管理**：每次写入 = 一次 commit → **fork / pull / 还原到某 commit / 看历史** 全部 git 原生，吻合"非你的仓库→issue/PR；你的仓库→fork/还原"的模型。
- **托管**：GitHub Pages / Gitee Pages 出公开组页。**不部署任何服务器。**

### 0.2 组同步 = "第二个 syncBase"，不是第二种同步哲学

现有个人同步（progress-2026-10-03）已定：本地为主、服务器=云存储；显示/覆盖/推送三步；entry 带 `updated`。组同步**复用同一套**，只换存储目标：

```
个人同步（已有，不动）             组同步（新增，正交一层）
syncBase → /api/anno/<mediaId>    GitStore → repo:packs/<mediaKey>.json
localStorage: va:entries:<mid>    localStorage: va:group:<gid>:<mid>（只存组来源条目）
```

**铁律**
1. **个人库与组数据物理分层**：组来源条目单独存储、渲染成虚线 + 作者 chip；个人 `va:entries:` 永不被组写入污染，反之亦然。冲突只发生在"组仓库版 vs 我的组内草稿"，复用现有 `chooseVersion`/`fingerprint`。
2. **合并复用**：`merge_entries`/`sameEntry`（含 `tags` 去重）、`updated`、本地优先，全部沿用。
3. **组同步挂在 `save()` 后去抖触发**，与个人自动同步同一管线，不新开定时器。
4. **三形态 parity**：组逻辑只进 `src/*.js`（经 `build.py` 进三端同一产物）；网络走现有 `httpJson` 通道（vaFetch > chrome > GM > fetch）。

### 0.3 GroupStore 抽象（为将来留口）

客户端只面向 `GroupStore` 接口；R4a 只实现 **`GitStore`**。未来的 hub / 局域网实现作为可选实现后补，调用方不变。

```
interface GroupStore {
  readGroup(gid) / writeGroup(gid, doc)
  readPack(gid, mediaKey) / writePack(gid, mediaKey, pack)   // write = get sha → merge → put（409 重试）
  listPacks(gid)
}
```

---

## 1. R4a 详细设计（GitStore 主路径）

### 1.1 数据模型

```jsonc
// group.json —— 仓库根，组清单（对齐 W3C AnnotationCollection 语义，R4b 导出时映射）
{
  "type": "va:Group",
  "id": "grp_x7k2",                              // 8 位 base36，不可猜测
  "name": "IELTS 听力互助组",
  "created": "2026-10-03T…", "updated": "2026-10-03T…",
  "visibility": "private",                       // R4a 恒 private；R4b 才有 public
  "host": { "kind": "github" | "gitee", "repo": "owner/name", "branch": "main" },
  "owner":   { "id": "urn:hash:<sha256(pubJWK)>", "name": "alice" },
  "members": [{ "id": "urn:hash:…", "name": "bob", "role": "member", "addedAt": "…" }],
  "contentList": {                               // 共同片单 = 密度引擎本体
    "id": "list_x7k2", "label": "9–12 月真题听力",
    "items": [{ "media": {"platform":"bilibili","videoId":"BV…","url":"…","title":"…","type":"video"},
                "note": "", "addedBy": "urn:hash:…", "addedAt": "…" }]
  },
  "packIndex": { "BV…": {"updated": "…", "count": 12, "path": "packs/BV….json"} }
}
```

- **Member**：内嵌（小组 ≤50 无压力）；`id` = 本地公钥哈希；`name` = 昵称；**无邮箱无密码**。
- **Pack 路径**：`packs/<mediaKey>.json`，`mediaKey = re.sub(r'[^\w.-]+','_', mediaId)`（与 `sync_server.key_to_file` 同规则）；**文件体 = 现有 Pack，零改动直接过 `merge_entries`**。
- **写令牌**：仓库 URL + 分支 + PAT 存在每个成员的 localStorage `annota:gitstore:<gid>`；**不入仓库、不入 git**。
  - **用户侧不使用命令行 / `sec` / 环境变量**：PAT 由用户在 UI 里粘贴一次（或从邀请链接一键导入），此后只随请求发往对应平台（GitHub/Gitee），产品全程不依赖任何 CLI/密钥工具。
  - **令牌安全**：存 localStorage、fine-grained 仅该仓 `contents:write`、可轮换；**绝不出现在导出文件/仓库/日志**。
  - 开发者自测若要调 API，token 自行管理且**只显长度、不 echo 明文、不进程 env 传递**（仅测试用途，与产品无关）。
- **feed.json**（R4a 只生成不展示）：`{"type":"va:Feed","groups":[...]}`，只列公开组。

### 1.2 组页形态

- 公开组页 = 仓库 Pages 上的 `g/<gid>.html`（静态 shell + 内联 JS 拉 `group.json`/packs）：按片单分组的标注流，每条 = 词/标签 + 时间码 + **作者 chip** + 媒体外链（`#t=` 尽力）。
- **合规红线**：无媒体本体（无 iframe、无缩略图），只有文字与外链。
- 私密组（R4a 默认）：仓库私有，Pages 不可读（Pages 私有需付费），**组页仅在成员本地 hub-less 视图或客户端内**呈现；公开组才发 Pages。
- 邀请链接：`annota://join?host=github&repo=owner/name&gid=grp_x7k2#t=<token>`（token 走 fragment，不进日志/Referer）。

### 1.3 身份：本地密钥对（R4a 落地 ADR-3 前半）

新模块 **`src/identity.js`**（~80 行，WebCrypto，三形态通用）：
- `ensureIdentity()`：localStorage `annota:identity`，首次生成 P-256（extractable）存 JWK；`creator = {type:"Person", id:"urn:hash:"+sha256(pubJWK), name}`。
- name 取设置昵称（新增设置项，默认"匿名标注者"）。
- `entry.creator` 挂在 `commit()`/编辑保存处；**R4a 不强制 `va:sig`**（验签留 R4b 防冒充；schema 已有字段，纯加法）。
- 老数据无 creator 照常渲染。

### 1.4 GitStore 内核（Contents API，GitHub + Gitee）

新模块 **`src/group.js`**：
- **平台适配**：GitHub `api.github.com/repos/<repo>/contents/<path>`；Gitee `gitee.com/api/v5/repos/<repo>/contents/<path>`（接口同构，字段名近乎一致；Gitee 分页/限额实测核对）。
- **读**：`GET contents`（返回 base64 内容 + sha）；公开组可用 raw 免 token。
- **写**：`GET`(取 sha) → 本地 `mergeLocal(cur, incoming)` → `PUT contents`(content base64, sha, message=commit msg) → **`409/422` 冲突 → 重取 sha → 重合并 → 重试（最多 3 次）**。
- **并发写**：靠"重取 sha 重合并"保证不丢；同词同锚点极小窗口可能后写覆盖，其余天然并集。
- **限流**：GitHub 有 rate limit（带 token ~5000/h），Gitee 亦有；批量拉取走"一次 contents 列目录 + 逐个 pack"，避免高频。
- **提交信息**：`annota: <mediaKey> +N by <name>`（可读历史）。
- **Gitee 实测项**（R4a-6 **已实测**）：**新建文件必须 `POST /contents`**（`PUT` 对不存在文件报 `sha is empty`）、更新用 `PUT+非空 sha`；token 走 `access_token` query；raw 域名 `gitee.com/<repo>/raw/<branch>/`。代码已适配。

### 1.5 客户端组同步流程

1. **加入**：解析邀请链接 → `annota:groups` = `[{gid, name, host, repo, branch, token, joinedAt}]`（沿用 `decodeExportIntent` 的 fragment 套路，新增 `annota://join` / `#annota-group=`）。
2. **拉（打开媒体时）**：`state.mediaId ∈ 组 contentList` → `GitStore.readPack(gid, mediaKey)` → 存 `va:group:<gid>:<mediaId>`；渲染时个人层与组层**分层展示**：组来源＝虚线 + 作者 chip，个人＝实线。
3. **推（save() 后 5s 去抖）**：把锚点在组片单媒体上的实线条目推 `writePack`（服务端=仓库侧 merge 保全组）；个人 syncBase 若配置了，照常另推一次，互不等待。
4. **冲突**：仓库 pack 比我的组缓存新 → 组层内重放 `reconcileOnOpen`（fingerprint + chooseVersion，文案改"组内有新版本"）。`displayVersion` 只管个人层，不动。
5. **core 暴露**：把 `sameEntry/validEntries/mergeLocal/fingerprint/httpJson` 经 `coreApi` 传给 `VAGroup.install(coreApi)`（与 `VAExport.install` 同模式，不改全局）。`core.js` 末尾挂接；`save()` 后调 `VAGroup.onSaved(coreApi)`。

### 1.6 页面态 UI

- `app/service/index.html` 加「**组**」screen：组列表（`annota:groups`）→ 片单编辑（粘 URL 自动解析 platform/videoId，复用 `adapter.js`）、成员、邀请链接生成/复制；**建组向导** = 组名 → 钉首批片单 → 生成 token 邀请链接。组织者只做"建组+片单"（不做通知/催标）。
- Dock `⋯ ▸` 加「组 ▸」：所属组、加入组（粘链接）、手动"推送到组"。
- SidePanel 来源 tab：组来源作为一个来源，沿用三档信任。

### 1.7 与 W3C / 版本管理

- Pack 格式不变；组 = `AnnotationCollection` 容器，R4b 导出直接映射。
- 版本管理**用 git 原生**：还原 = checkout 历史 commit；fork = fork 仓库；R4c 后组内"还原到某版本"按 entry `updated` 排序版本链。

---

## 2. R4b 设计概要（OAuth）

- **OAuth 最小后端**（唯一需要服务器的地方，R4b 才引入）：只做 OAuth 回调 / 会话 / **token 代持**（避免成员各自粘贴 PAT）。GitHub 先行（零门槛）→ Google/Apple → 微信（需企业主体，后评）。
- 托管：单二进制丢 Fly.io / VPS / 隧道；无状态，会话存文件。
- **公开组页 + 署名**：`visibility:"public"` → 发 Pages；每条带 creator chip + 组 license。**公开前三开关**：① 一键转私密（删 Pages 并 404）；② 举报入口；③ 单条隐藏（写 hiddenIds 进 manifest）。
- **W3C 互通**：`src/w3c.js` 双向映射（fields 照 `schemas/annotation.schema.json`），导出 Collection / 导入 Hypothesis（`api.hypothes.is/api/search`），走现有 `importJSON` 合并（幂等）。

---

## 3. R4c / R4d 概要

- **R4c 镜头对齐**：`src/shot.js`，边播采帧（`requestVideoFrameCallback` 降采样）+ 相邻帧直方图差判切点 → 存 IndexedDB（本地、不同步）；`entry.va:shot={start,end}` 纯新增字段。**风险**：跨域视频 canvas 可能 taint → 走 Tauri `captureFrame` 通道，userscript 端降级"手动微调 dur"。计数器进 `/console`。
- **R4d 社交机制**：**触发线**（全满足才做）≥3 真实组 且 单组周新增 ≥50 且 连续 2 周；未触发一行不写。触发后：组内赞踩 → 组内点数 → 发现页（聚合各组 `feed.json` 静态产物，卡片=词云+平台标，无媒体本体）。

---

## 4. 文件 / 改动清单

**前端 `src/`（三形态共用，经 build.py）**
| 文件 | 类型 | 内容 |
|---|---|---|
| `src/identity.js` | 新增 | 本地 P-256、creator、`ensureIdentity()` |
| `src/group.js` | 新增 | `GroupStore` 抽象 + `GitStore`（GitHub/Gitee Contents API、409 重试）；`VAGroup.install(coreApi)`；邀请链接解析；组拉/推协调 |
| `src/w3c.js` | 新增(R4b) | entry↔W3C 双向映射、Hypothesis 导入 |
| `src/shot.js` | 新增(R4c) | 边播采帧、切点检测、两端对齐 |
| `src/core.js` | 小改 | 挂 `entry.creator`；`save()` 后 `VAGroup.onSaved`；组来源条目虚线+chip；末尾 `VAGroup.install` |
| `src/export.js` | 微改(R4c) | 卡背附镜头区间 |
| `build.py` | 微改 | 新文件并入产物 |

**页面态**
| 文件 | 类型 | 内容 |
|---|---|---|
| `app/service/index.html` | 改 | 「组」screen：组列表/建组向导/片单/成员/邀请链接 |
| `app/service/group.html` | 新增 | 组页 shell：片单分组标注流 + 作者 chip + 外链（供 Pages） |
| `app/service/console.html` | 改(R4c) | 镜头覆盖率卡 |

**测试**
| 文件 | 类型 | 内容 |
|---|---|---|
| `dev/gitstore.test.mjs` | 新增 | GitStore 纯逻辑（mock fetch）：读/写/409 重试/merge 幂等 |
| `dev/group_sync.test.mjs` | 新增 | 客户端组层流程（mock store）：加入→拉→分层渲染→推→两人合并 |
| `dev/w3c.test.mjs`/`smoke-w3c.mjs` | 新增(R4b) | round-trip + Hypothesis 样例 |
| `dev/shot.test.mjs` | 新增(R4c) | 合成帧序列切点检测（纯函数） |
| 存量测试 | 回归 | 全量续跑，个人同步零变化 |

> **无后端 / 无 Rust 改动**（GitStore 是纯客户端 + 第三方 API）。R4b 的 OAuth 后端另立。

---

## 5. 测试与验收（分档）

- **档 1（身份）**：新建标注带 `creator.id`(urn:hash)+name；重启/换形态 id 稳定；老数据照常。
- **档 2（GitStore 内核）**：mock fetch — 读 pack、写 pack、409 重试后成功、两次写同词异框并集正确；`dev/gitstore.test.mjs` 绿。
- **档 3（两人同组，R4a 核心）**：两台机器（或两浏览器配置）指向**同一个 GitHub/Gitee 测试仓**：A 建组钉片单(2 视频)发链接；A 标 3 条、B 标 3 条；各自同步后**双方注入态都能看到对方条目**（虚线+昵称）；**个人导出/Pack 不含对方条目**。
- **档 4（组管理 UI）**：工作区「组」screen 建组→加片单→成员→邀请链接全动线 ≤3 分钟。
- **档 5（Pages 公开组页）**：公开组发 Pages → 匿名无痕可读、permalink 可分享；JSON 可 `importJSON` 原样导回。
- **档 6（R4b）**：GitHub OAuth 登录入组；导出 Collection 过 W3C 校验/可被 Hypothesis 读；Hypothesis 导入幂等。
- **档 7（R4c）**：含 ≥5 硬切视频切点召回 ≥80%；标注自动获 `va:shot`；console 出覆盖率。
- **档 8（Gitee 实测）**：同一套 `GitStore` 在 Gitee 仓库跑通档 2/3（PAT/接口/raw 差异核对）。

---

## 6. 风险与未决

| 风险 | 等级 | 应对 |
|---|---|---|
| **写入门槛**（成员要会用 git / 粘 PAT） | 高 | 邀请链接一键带 token 入本地；R4b 用 OAuth 代持 token 彻底去掉粘贴 |
| **token 安全**（PAT = 写口令，泄露可改写组） | 高 | 存 localStorage 不入库；fine-grained 仅该仓 contents:write；组内可轮换 token（旧失效）；**产品不经命令行/`sec`/env，token 只活在浏览器内**；不进代码/仓库/导出/日志 |
| **GitHub 国内不稳定** | 中 | **R4a 同做 Gitee**（不后置）；公开页 Gitee Pages 备选 |
| **Contents API 限流 / 409** | 中 | 去抖批量、409 重取 sha 重合并重试、提交信息聚合 |
| **Gitee 接口差异** | 中 | R4a-6 专项实测（access_token 传参、raw 域名、限额） |
| **私密组在 GitHub Pages 不私密** | — | R4a 私密组**不发 Pages**（Pages 私有需付费）；仅公开组发 |
| **公开 UGC 合规** | 高(R4b) | 公开前三开关（转私密/举报/单条隐藏）；私密默认、公开二次确认 |
| **组来源污染个人数据** | 中 | 物理分层（§0.2 铁律 1）+ 档 3 卡死 |
| **creator 隐私** | 低 | name 可设"匿名"；id 是公钥哈希不含个人信息 |

**未决**：① 云服务器形态（R4b 的 OAuth 后端用 Fly.io/VPS/隧道，后议）；② 公开组默认 license（倾向 CC-BY-4.0）；③ 成员上限/踢人 UI（R4a 仅 owner 手工删）；④ Gitee 企业/个人 PAT 权限粒度细节。

---

## 7. R4a 第一批可实施任务（6 步，每步独立验收）

| 步 | 任务 | 关键文件 | 验收 |
|---|---|---|---|
| **R4a-1 身份先行** | `src/identity.js`；core commit/编辑挂 `entry.creator`；设置加昵称 | `src/identity.js`、`src/core.js` | 档 1 |
| **R4a-2 GitStore 内核** | `src/group.js`：`GitStore`（GitHub+Gitee Contents API、409 重试、合并复用）；`GroupStore` 抽象 | `src/group.js`、`build.py` | 档 2 |
| **R4a-3 组模型+令牌** | `group.json`/`packs` 结构、建组向导（生成仓库/写 group.json）、邀请链接（带 repo+token） | `src/group.js`、`app/service/index.html` | 建组→出邀请链接 |
| **R4a-4 客户端组同步+分层渲染** | 拉/推协调、`va:group:*` 分层、虚线+作者 chip；core 挂 `VAGroup.install` | `src/group.js`、`src/core.js` | 档 3 的 1–3 条 |
| **R4a-5 组页 + 组管理 UI** | `group.html`；「组」screen 完整动线；Dock「组 ▸」；公开组发 Pages | `app/service/group.html`、`app/service/index.html` | 档 3 第 4 条 + 档 4/5 |
| **R4a-6 回归 + Gitee 实测** | 全量测试续跑；Gitee 专项；`progress-*.md` 记录 | 测试 | 档 8 + cargo/JS/PY 全绿 |

完成 R4a-4 即达验收线（同组两人各自标注可见）；R4a-5/6 是分发与健壮性收尾。R4b 前置：R4a-6 完成 + §6 未决拍板。

---

**方案要点回顾**：组后端 = **git 仓库（GitHub/Gitee Contents API）**，零自建服务器、版本管理免费白送（对齐"参考 git"）；组同步是个人同步的正交一层（第二 syncBase + 分层存储），合并/显示-覆盖-推送/`updated` 全复用；身份用 WebCrypto 本地密钥对落地 ADR-3 前半，OAuth 押后 R4b（那时才引入唯一一个轻后端做 token 代持）。全程不碰 entry/Pack 语义、不建媒体云、三形态零分叉。
