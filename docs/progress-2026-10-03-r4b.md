# 进展 · 2026-10-03~04（R4b 托管后端：CloudBase PG + HubStore + GitHub OAuth）

> 承接 [`r4-plan.md`](r4-plan.md) R4a / [`r4b-plan.md`](r4b-plan.md) v0.1。目标：把小组共享从「用户自建 git 仓 + PAT」升级为「托管后端」——登录一次即可建组/加入/同步，全程不见 git。
> 状态：**R4b-1（PG schema+RLS）**、**R4b-2（HubStore + vendor SDK）**、**R4b-3（GitHub OAuth 云函数，已部署上线）**、**R4b-4（RLS 修正：递归 + 自助加入）**、**R4b-5（前端接线）已完成**；回归全绿；**未提交**（用户暂不提交）。

---

## 1. 决策（本轮，勿再讨论）

- **R4b 后端 = 腾讯云 CloudBase**（环境 `tencentcloudtest-d2eg4lu85c76fb0`，ap-shanghai，PG 模式）。组 CRUD 走**浏览器直连 `app.rdb()` + RLS**；云函数只做 OAuth（唯一需要 secret 的地方）。
- **匿名可读公开组**；登录仅用于建组/入组/发布/署名。R4a GitStore 降为「进阶：用我自己的 git 仓库」。
- **产品不经 CLI/`sec`/env**：凭据只活在浏览器（Publishable Key / 会话）与服务端（云函数 env）。
- **`auth.uid()` 返回 text（非 uuid）** → owner/user 列一律 `text`。
- 不搬媒体，公开组页无媒体本体。
- **OAuth 云函数是 Event 云函数**，HTTP 网关路由上游类型 `SCF`（不是 WEB_SCF）。
- **数据 API 回显任意 Origin**（实测 `access-control-allow-origin: http://localhost:8793`）→ 浏览器直连不受「安全域名」白名单限制；体验版套餐无法配置安全域名，但对 RDB/Auth 无影响。

## 2. R4b-1：PG schema + RLS（已 apply，已核验）

- migration `cloudbase/migrations/20261003153332_rb_groups.sql`。
- 表：`public.groups` / `members` / `packs`（`packs` 唯一键 `(group_id, media_key)`）。

## 3. R4b-2：HubStore + vendor SDK（完成）

| 项 | 交付 |
|---|---|
| vendor SDK | `app/service/vendor/cloudbase.full.js`（esbuild 打包 `@cloudbase/js-sdk@3.10.1` 为 IIFE，暴露 `window.cloudbase.init`）；`vendor/README.md` 记来源/重建命令 |
| HubStore | `src/group.js`：`app.rdb()` 实现 `readGroup/writeGroup/readPack/writePack` + `createGroup/joinGroup/myGroups`；`storeFor(host)` 分发 hub↔git |
| 分流 | `bindOf`/`pullForMedia`/`pushForMedia`/`createGroup`/`joinGroup`/`inviteLink` 全按 `host` 分流；hub 邀请链接 `annota://join?host=hub&gid=…` **无 token/repo** |
| 初始化 | `cbInit()`：`cloudbase.init({ env, region:'ap-shanghai', accessKey: <PK> })` → `app.rdb()`；PK 从 `window.__ANNOTA_CB_PK__` 或 localStorage 读 |

## 4. R4b-3：GitHub OAuth 云函数（已部署，已核验）

- `cloudbase/functions/auth-github/`（Event 云函数，`exports.main(event)`；`@cloudbase/node-sdk` 签 ticket）。
- 路由（`event.path` 分发）：`GET /auth/github/start` → 302 GitHub；`GET /auth/github/callback` → code→token→`/user`→自定义登录 ticket。
- **回跳**：优先 `ANNOTA_APP_URL`，否则从 OAuth `state`（前端 base64url 的页面地址）解码后回跳 → 任意页面登录都能回原页。
- 部署：`sh cloudbase/deploy.sh`（`tcb fn deploy … --force --runtime Nodejs18.15`，**不加 `--httpFn`**；密钥经 `secenv` 注入 env，临时 `cloudbaserc.json` 用完即删）。
- **HTTP 网关路由**：`…ap-shanghai.app.tcloudbase.com/auth/github` → 上游 `SCF` `auth-github`（`EnablePathTransmission=true`，匿名，auth=false）。
- **自定义登录 provider 已启用**（`ModifyProvider On=TRUE`）；私钥在 `sec` 条目 `cloudbase-custom-login-key`（key id `dbc200e6-…`）。
- 线上验证：`/auth/github/start` 正确 302（client_id/redirect_uri/scope/state 全对）；`/callback` 无 code→400；未知路径→404。

## 5. R4b-4：RLS 修正（migration `20261004010000_rb_join_and_rls.sql`，已 apply）

原 R4b-1 的两处缺陷：
1. `members_read` 自引用 `members` → PostgreSQL **infinite recursion detected in policy**（任何 members 读都失败）。
2. 私有组**无法加入**：members 仅 owner 可写，且非成员读不到组。

修正：
- 加 `security definer` 助手 `public.is_member(gid)` / `public.is_owner(gid)`（绕过 RLS，无递归）。
- `groups_read` = public 或 `is_member`；`members_read` = `is_member`；`members_write` = `is_owner`。
- 新增 `members_self_join`（insert）：`with check (user_id = auth.uid() and role = 'member')` → **凭 gid 自助加入**（邀约链接即授权）。
- `packs_read` = public 或 `is_member`；`packs_write` = `is_member`。
- 加入流程改为**先 insert 成员、再读组**（原来先读组会因非成员读不到而失败）。
- 真实库核验：`authenticated`/`anon` 角色查询无递归错误，RLS 正常过滤。

## 6. R4b-5：前端接线（完成）

- `app/service/cb-config.js`：设 `window.__ANNOTA_CB_PK__`（公开 Publishable Key）。
- `src/group.js` 新增登录态核心：`loginUrl/startLogin/handleTicket/session/currentUser/signOut/hubMe/setHubMe/hubIdentity`；`createGroup` 对 hub 用云端身份署名。
- `app/service/index.html`：引入 vendor + cb-config；组页加登录状态栏（GitHub 登录/退出）；建组向导默认「云开发（hub）」，保留 Git 仓库三步进阶流程；建组/加入对 hub 校登录态；hub 组卡片 meta=`云开发 · 私有组/公开组 · 角色`；组页 URL（hub）→ `group.html?host=hub&gid=…`。
- `app/service/group.html`：引入 vendor + cb-config + group.js；`host=hub` 分支用 `VAGroup.HubStore.readGroup/readPack`（私有组需登录，提供登录入口）；git 分支原样保留。
- 未验证：浏览器端 OAuth 全链路（需人工在浏览器点一次）。

## 6.5 浏览器端真机验证（E2E，Playwright headless · 全部 PASS）

用本地 `python3 app/service/sync_server.py`（127.0.0.1:8793）+ Playwright Chromium 驱动真实页面。因自定义登录私钥失效（见 §6.6），改用**用户名密码测试用户**（`usernamePassword=true`）取得真实会话：

- A 密码登录，会话 uid 一致 ✓
- A 建组（RLS `groups_insert`）✓ · 卡片出现 ✓
- A `pushForMedia('bilibili:…')` 命中片单项并写 pack（RLS 写策略）✓
- 匿名读私有组被 RLS 拒绝 + 给登录入口 ✓
- B 凭邀请链接**自助加入**（RLS `members_self_join`）✓
- B（成员）可读 pack ✓ · B 推送后 A 读到**合并 2 条**（幂等）✓
- 组转公开后**匿名可读**（含标注词条）✓ · 退出登录回未登录态 ✓

**本轮真机暴露并修复的问题**：

1. **`app.auth` 不是方法**：v3 SDK 的 `app.auth` 直接就是认证实例（`typeof` 恰为 function），**不可当方法调用**（调用会丢 `this` → `Cannot read properties of undefined (reading 'adapter')`）。`cbAuth()` 已改为直接返回；init 补 `auth: { detectSessionInUrl: false }`。
2. **云函数凭据缺 `env_id`** 且 **sec 私钥是 hex 编码的 PEM**（非 PEM）→ ticket 签发会报错/失败。函数加 `normalizePrivateKey()`（兼容 PEM / `tcb_custom_login.json` JSON / hex-PEM / base64-DER）+ 补 `env_id`，已重新部署。
3. **片单项 mediaId 前缀不一致**（真实主链路 bug）：workspace 建的片单项存裸 id（`BV1…`），userscript `adapter.mediaId` 存带前缀（`bilibili:BV1…`）→ `groupsForMedia` 不匹配 → **userscript 不会往该组推/拉标注**。`groupHasMedia` 增加前缀容错（`sameMediaId`），并加测试。
4. **CORS 实测**：数据/认证 API（`{env}.{region}.tcb-api.tencentcloudapi.com`）**回显任意 Origin** → 浏览器直连不受「安全域名」白名单限制（体验版禁配安全域名也不影响 rdb/auth）。

## 6.6 自定义登录私钥（已解决）

**症状**：`signInWithCustomTicket` / `createTicket` 报 `私钥已过期或私钥不存在，请重新生成`。

**排查与真因**（三条独立错误叠在一起）：
1. **编码**：sec 里最初是「hex 编码的 PEM」；后来用户重存为整份 `tcb_custom_login.json`（`private_key` 是 PEM）。函数加 `normalizePrivateKey()` 兼容 PEM / JSON / hex-PEM / base64-DER。
2. **key_id 过期**：一直往云端写的是**旧 key_id `dbc200e6-…`**；重生成后当前 key_id 是 **`4b93500c-66dd-43be-aba1-0d20d39fd1b2`**（在整份 JSON 的 `private_key_id` 里）。函数改为**优先从 JSON 取 key_id**。
3. **CloudBase 强制 `env_id`**：`credentials` 缺 `env_id` 会直接报「私钥未包含 env_id」。函数固定带 `env_id`。

**注入方式（关键坑）**：`tcb config update fn` 把**整份 JSON 塞进环境变量会失败**（`Environment.Variables.N.Value` 类型错——值里的换行/花括号被当对象）。**必须只注入 `private_key` 的单行值**（PEM 换行转义成 `\n` 字面量），`key_id` 另用 `TCB_CUSTOM_LOGIN_KEY_ID`。且要用「覆盖更新」并**同时注入 `GITHUB_CLIENT_SECRET`**（否则会被覆盖成空 → `OAuth 未配置完整`）。

**验证**：本地用同一把私钥 `createTicket` 成功（447B）→ Playwright 客户端 `signInWithCustomTicket` 返回 uid ✓ → **用户在浏览器点「用 GitHub 登录」真实跑通，页面显示「已登录：<GH 名>」**（档 1 完成）。

## 6.7 已知缺口

- **userscript 未注入 Publishable Key** → 注入态（B 站等）暂时用不了 hub 组（需在 `build.py` 里内联 `window.__ANNOTA_CB_PK__` 或加设置项）。本轮 E2E 覆盖的是工作区/组页 + SDK + RLS。

## 7. 关键环境信息（备查）

- **环境**：CloudBase `tencentcloudtest-d2eg4lu85c76fb0`（ap-shanghai，PG 模式）；静态托管域名 `tencentcloudtest-d2eg4lu85c76fb0-1414056833.tcloudbaseapp.com`。
- **Auth**：`usernamePassword=true`；内置 provider `email`/`custom`；**自定义登录已启用**。GitHub OAuth 走 CUSTOM + 云函数签 ticket。
- **GitHub OAuth App**：Client ID `Ov23liPnpRSQnkmz04VT`；回调 `/auth/github/callback`；Secret 存 `sec` 条目 `github-oauth`（勿回显）。
- **PK**：`app/service/cb-config.js`（公开值，可轮换）。
- **v3 语法**：`cloudbase.init({ env, region, accessKey })` → `app.rdb()`；`app.auth`（属性）。
- **数据 API**：`https://{envId}.{region}.tcb-api.tencentcloudapi.com`，回显任意 Origin。

## 8. 回归结果（全绿）

- JS：`geometry` / `textquote`
- Node：`identity` / `gitstore` / `group_sync` / `group_hub`
- Python：`merge_rules` / `anki_export` / `export_server` / `sync_replace`
- smoke×7：`smoke` / `smoke-image` / `smoke-article` / `smoke-picker` / `smoke-export` / `smoke-visibility` / `smoke-group-ui`
- HTML 内联脚本语法校验（vm.compileFunction）：0 错误

## 9. 待办 / 已知缺口

- **GitHub 登录（档 1）已真机跑通**（见 §6.6）；档 2/3（建组/自助加入/成员互见/合并/越权拒绝/公开读）另用密码测试用户真机跑通（ALL PASS）。
- **userscript 注入 PK**（§6.7）后方可在 B 站等注入态用 hub 组。
- douyin/通用 web 片单项的 mediaKey 前缀归一化仍待统一（bilibili/youtube 正常）。
- myGroups 未与本地组注册表自动合并（本地注册表为准）。
- 提交 R4b（用户确认后）。

## 10. 未提交内容

- `docs/r4b-plan.md`、`docs/progress-2026-10-03-r4b.md`（本文件）
- `cloudbase/`（deploy.sh、functions/auth-github/、migrations/×2）
- `app/service/vendor/`、`app/service/cb-config.js`
- `src/group.js`（HubStore + 登录态 + 加入流程）、`dev/group_hub.test.mjs`
- `app/service/index.html`、`app/service/group.html`（前端接线）
