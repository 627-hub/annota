# 进展 · 2026-10-03（R4a 小组共享落地）

> 承接 [`r4-plan.md`](r4-plan.md) v0.2（GitStore 主路径）。R4a 六步全部完成，含**真实 Gitee API round-trip 实测**。
> 状态：全量回归（JS×2 / identity·gitstore·group_sync / PY×4 / smoke×7 / cargo×8）全绿；**已提交**（7597510，含本文件）。
> 注：提交后工作区仍有后续改动未提交（src/core.js / group.js / identity.js 等 15 文件，及未跟踪的 cloudbase/、docs/r4b-plan.md），属 R4b 进行中工作，不在本批范围。

---

## 1. 决策（本轮）

- R4 后端：**git 仓库当后端（GitHub/Gitee Contents API），零自建服务器**；hub/局域降为可选未来实现。
- 版本管理直接用 git（fork/还原/历史原生），对齐"参考 git"模型。
- 建组方式：**用户自建空仓 + fine-grained PAT（仅该仓 contents:write）**；Annota 只写入。
- 身份：R4a 本地密钥对（creator 署名）；OAuth 留 R4b。
- **产品不依赖命令行/`sec`/env**：用户凭据只活在浏览器 localStorage，UI 粘贴。

## 2. R4a 六步交付

| 步 | 交付 | 测试 |
|---|---|---|
| R4a-1 身份 | `src/identity.js`（P-256 本地密钥对，`creator.id=urn:hash:sha256(pubJWK)`）；entry 挂 `creator`；设置加昵称 | `dev/identity.test.mjs` |
| R4a-2 GitStore 内核 | `src/group.js`：`GroupStore` 抽象 + `GitStore`（GitHub/Gitee Contents API、409 重试、merge 复用） | `dev/gitstore.test.mjs` |
| R4a-3 组模型+令牌 | `group.json`/`packs/*.json`、`createGroup`/`inviteLink`/`parseInvite`/`joinGroup`（token 走 fragment） | 同上（建组/邀请 round-trip） |
| R4a-4 客户端组同步+分层渲染 | `pullForMedia`/`pushForMedia`；core 叠组来源层（**虚线+作者 chip**，不进 `state.entries`）；`VAGroup.install` | `dev/group_sync.test.mjs` |
| R4a-5 组页+组管理 UI | `app/service/group.html`（静态组页，无媒体本体）；工作区「组」screen；Dock「组管理菜单」 | `dev/smoke-group-ui.mjs` |
| R4a-6 回归+Gitee 实测 | 见下 | 全量回归绿 |

## 3. Gitee 实测（真实 API，重要差异已修）

用真实仓库 `hub627/annota`（private）跑 `GitStore` round-trip：建组→写 pack→再写一条（服务端 merge=3）→读回（apple/banana/cherry）→读 group.json → **PASS**。测试数据已清理。

**发现并修复的平台差异**：
- **Gitee 新建文件必须用 `POST /contents`**（`PUT` 对不存在文件报 `sha is empty`）；更新用 `PUT + 非空 sha`。GitHub 是 `PUT` 统一处理（新建可省 sha）。
- `GitStore.write` 改为：先 GET 判存在 → 不存在且 Gitee 走 POST、否则 PUT+sha。token 传输初版走 `access_token` query（Gitee 官方推荐），提交后已改为 `Authorization: token` header（避免 token 进 URL/日志/Referer，Gitee 同样支持）。
- mock 测试补 Gitee 分支（POST 新建 + PUT 更新）。

## 4. 顺带修复（Rust）

- 工作区页面靠 `/src/identity.js`、`/src/group.js` 加载组模块。Python `_static` 可服务 `/src/*`；但 **Rust release 无 `ServeDir`**（debug 才有）→ 打包 Tauri 会 404。
- 修：Rust `include_str!` 两个 JS + 加 `/src/identity.js`、`/src/group.js` 路由（与 `index.html`/`console.html` 内嵌同理）。`cargo check`/`test` 通过。

## 5. 安全

- 用户 PAT 由 UI 粘贴、存 localStorage，仅发往对应平台；**产品不经 CLI/`sec`/env**。
- 开发者自测：token 走 `sec`（`gitee`），经 `secenv` 管道注入，**未回显明文、未进 history/仓库**。
- 工作区 `AGENTS.md`（本机全局 `~/.config/opencode/AGENTS.md`，未入库）已补：禁 `echo $KEY`/导出 env 传密钥；产品不得要求用户用 `sec`/CLI/env。

## 6. 未做 / 待办

- **真机验收**（需人工）：真实浏览器走 建组→邀请链接→两人同视频各自标注在组内可见；组页打开。
- **R4b**：OAuth（GitHub 先）+ 轻后端 token 代持 + 公开组页署名 + W3C 互通。
- 云服务器形态未决。
- 提交：本批次（R4a-1~6 + Gitee 修复 + 文档）待提交。
