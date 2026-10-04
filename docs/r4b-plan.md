# R4b 实施方案（r4b-plan.md v0.1 · CloudBase 托管 + GitHub OAuth）

> 承接 [`r4-plan.md`](r4-plan.md)（R4a GitStore）、[`architecture.md`](architecture.md) ADR-1~6。
> **目标**：给小组共享加**低门槛托管后端**——用户**只 OAuth 登录一次**即可建组/加入/同步，**不需要 git / PAT / 建仓**。GitStore 降级为"进阶：用我自己的 git 仓库"。

---

## 0. 环境事实（已核实）

- CloudBase 环境：`tencentcloudtest-d2eg4lu85c76fb0`（ap-shanghai，PG 模式）。
- **PG 已开通**（`postgres-q5rcytym`）；**无 NoSQL / 无 MySQL** → 业务数据只用 PG。
- **CloudBase Auth 已开**：`usernamePassword=true`；内置 provider 只有 `email` / **`custom`（自定义登录）**，**没有内置 GitHub**。
- 云函数（SCF）可用；静态托管域名 `tencentcloudtest-d2eg4lu85c76fb0-1414056833.tcloudbaseapp.com`。
- GitHub OAuth App：Client ID `Ov23liPnpRSQnkmz04VT`；回调 `…/auth/github/callback`；Secret 存本机 `sec`（`github-oauth`）。

## 1. 架构

```
浏览器（注入态 core.js / 工作区页面）
   │  1) 点「用 GitHub 登录」→ 302 到 /auth/github/start
   ▼
CloudBase 云函数（hub）
   ├ /auth/github/start     → 302 github.com/login/oauth/authorize
   ├ /auth/github/callback  → code 换 token → 取 GitHub 用户
   │                         → CloudBase 自定义登录：签发 tickets → 前端 customAuth 换会话
   ├ /api/me                → 当前用户（来自 CloudBase 会话）
   └ /api/group/*、/api/pack/* → 读写 PG（RLS 以 auth.uid 判权限；公开组匿名可读）
   ▼
CloudBase PostgreSQL
   ├ auth.*（平台自带：users/identity/provider/session）——身份来源
   └ public.groups / members / packs / invites（业务表）
```

- **身份**：GitHub OAuth（自定义登录源）→ CloudBase Auth 会话。RLS 用平台 `auth.uid()`（**返回 text，不是 uuid**）。
- **数据访问走 JS SDK v3 `app.rdb()`**（浏览器直连 PG + RLS），**不自己写云函数 proxy**。云函数**只做 OAuth**（换 token/签 ticket，因涉及 secret）。→ 组 CRUD 无自建端点，平台直连。
- **默认后端 = HubStore（CloudBase + rdb）**；GitStore 保留为进阶通道（同 `GroupStore` 接口）。
- 本地优先不破：单机标注仍存本地；组同步是"第二 syncBase"，与个人同步正交（复用 R4a 的 `pullForMedia`/`pushForMedia`/分层渲染）。

## 2. 数据模型（PG）

```sql
-- 组（owner_id 用 TEXT：CloudBase auth.uid() 返回 text，不是 uuid）
create table public.groups (
  id          text primary key,                          -- grp_xxxx
  name        text not null,
  owner_id    text not null default auth.uid(),
  visibility  text not null default 'private',           -- private | public
  content_list jsonb not null default '{"items":[]}'::jsonb,
  pack_index   jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 成员（user_id 用 TEXT，同 auth.uid()）
create table public.members (
  group_id   text not null references public.groups(id) on delete cascade,
  user_id    text not null,
  role       text not null default 'member',             -- owner | member
  name       text,
  added_at   timestamptz not null default now(),
  primary key (group_id, user_id)
);

-- 组内某媒体的标注包（entries 用 JSONB，格式沿用 W3C Pack，含 updated/creator）
create table public.packs (
  group_id   text not null references public.groups(id) on delete cascade,
  media_key  text not null,
  media      jsonb not null default '{}'::jsonb,
  entries    jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (group_id, media_key)
);

create index on public.members (user_id);
create index on public.packs (group_id);
-- GRANT（browser 走 authenticated / anon 角色）
grant select, insert, update, delete on public.groups, public.members, public.packs to authenticated;
grant select on public.groups, public.packs to anon;   -- 公开组匿名读由 RLS 再收紧
```

**RLS（权限核心）**：业务表启用 RLS，按"是否该组成员 / 是否公开组"放行；所有写走"成员"校验。

```sql
alter table public.groups  enable row level security;
alter table public.members enable row level security;
alter table public.packs   enable row level security;

-- 组：成员可读；公开组任何人可匿名读；仅 owner 可改元数据；登录用户可建组
-- 组：成员可读；公开组任何人可匿名读；owner 可改；登录用户可建组（owner_id 默认 auth.uid()）
create policy groups_read on public.groups for select
  using (visibility = 'public'
     or exists (select 1 from public.members m where m.group_id = id and m.user_id = auth.uid()));
create policy groups_insert on public.groups for insert
  with check (owner_id = auth.uid());
create policy groups_update on public.groups for update
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- 成员：可读本组成员；仅 owner 可增删成员
create policy members_read on public.members for select
  using (exists (select 1 from public.members m where m.group_id = members.group_id and m.user_id = auth.uid()));
create policy members_write on public.members for all
  using (exists (select 1 from public.groups g where g.id = members.group_id and g.owner_id = auth.uid()))
  with check (exists (select 1 from public.groups g where g.id = members.group_id and g.owner_id = auth.uid()));

-- packs：成员可读；公开组匿名可读；成员可写
create policy packs_read on public.packs for select
  using (exists (select 1 from public.groups g where g.id = packs.group_id
    and (g.visibility = 'public'
      or exists (select 1 from public.members m where m.group_id = g.id and m.user_id = auth.uid()))));
create policy packs_write on public.packs for all
  using (exists (select 1 from public.members m where m.group_id = packs.group_id and m.user_id = auth.uid()))
  with check (exists (select 1 from public.members m where m.group_id = packs.group_id and m.user_id = auth.uid()));
```

> 注意：① RLS `with check` 引用同表子查询可能递归受限 → 若受限改用 `security definer` 函数 `is_member(gid)`；② **`auth.uid()` 返回 text**，owner/user 列一律 `text`（不要 uuit）；③ RLS 启用却零 policy = 全拒（务必先建 policy 再测）。

## 3. 访问契约（分两层）

**A. 组 CRUD —— 浏览器直连 `app.rdb()`（无自建端点）**

前端（`src/group.js` 的 HubStore）用 `@cloudbase/js-sdk` 的 `app.rdb()` 直连 PG，RLS 以会话身份放行：

```ts
// 建组（owner_id 由 DEFAULT auth.uid() 填，前端不传）
await db.from('groups').insert({ id: gid, name, visibility: 'private', content_list: { items: [] } });
await db.from('members').insert({ group_id: gid, user_id: me.id, role: 'owner', name: me.name });
// 我的组（join members）
const { data } = await db.from('members').select('group_id');
// 读/写片单
await db.from('groups').update({ content_list }).eq('id', gid);
// 读 pack
const { data } = await db.from('packs').select('*').eq('group_id', gid).eq('media_key', mk).single();
// upsert pack（合并：读出→mergeLocal→upsert；entries JSONB）
await db.from('packs').upsert({ group_id: gid, media_key: mk, media: m, entries: merged }, { onConflict: 'group_id,media_key' });
```
- 权限全在 **RLS**，不在客户端。
- 合并沿用 R4a `mergeLocal`（按 `id`/`updated`）；`upsert onConflict group_id,media_key` 幂等。

**B. OAuth —— 云函数（唯一需要 secret 的地方）**

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/auth/github/start` | 匿名 | 302 github.com/login/oauth/authorize（state） |
| GET | `/auth/github/callback` | 匿名 | code→token→GitHub user→**CloudBase 自定义登录 ticket** |
| GET | `/api/me` | 会话 | 可选：返回身份（其实前端 `auth.getSession()` 就够，未必需要） |

**自定义登录**：callback 用 GitHub 用户 + `manageAppAuth(action=createCustomLoginKeys)` 的私钥签发 ticket → 前端 `auth.customAuth().signInWithTicket(ticket)` 换 CloudBase 会话（`auth.getSession()`）。之后 `app.rdb()` 自动带会话，RLS 生效。

## 4. 前端改造

- `src/group.js`：新增 **`HubStore`**（实现同一 `GroupStore` 接口：`listGroups/readGroup/writeGroup/readPack/writePack`），网络走 `httpJson`（同源 CloudBase 域名）；`listGroups/addGroup` 本地注册表复用。
- **登录态**：`/api/me` 探测；"用 GitHub 登录"按钮（302 或弹窗）；未登录时组功能引导登录（**登录只用于建组/入组/发布/署名**——匿名仍可读公开组）。
- **GitStore 下移**：设置/组页加"进阶：用我自己的 git 仓库"，R4a 的建仓向导保留在那里。
- 组来源层渲染不变（虚线 + 作者 chip，`state.entries` 不污染）。

## 5. 部署

1. **PG DDL**：经 `managePgDatabase(action=applyMigration, migrationVersion=…)` 落地（migration 规范见 skill）。
2. **云函数**：`manageFunctions` 部署 `hub`（Node）；依赖 `@cloudbase/node-sdk`、`node-fetch`（或内置 fetch）。
3. **环境变量**：`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`（从 `sec` 注入，不入库/代码）、CloudBase 自定义登录私钥。
4. **静态托管**：组页沿用 `group.html`（可放静态托管）；公开组匿名读走 RLS。
5. **回调 URL**：已设 `…/auth/github/callback`。

## 6. 本地可跑

- **组 CRUD 不依赖本地服务**：前端直接用 `@cloudbase/js-sdk` 连 CloudBase（Publishable Key 公开），**开发期就能真跑**（连的是云 PG）。本机 `python3 -m http.server` 起工作区即可。
- **OAuth 本地调试**：云函数回调可先用 CloudBase 部署后的正式回调；若要本机调，加临时回调并在 OAuth App 加一条（GitHub OAuth App 支持多回调？单条，需切换）。
- 无 CloudBase 时：HubStore 不可用 → 退回 GitStore（R4a 通道），功能不中断。

## 7. 测试与验收

- **档 1**：GitHub OAuth 登录成功，`/api/me` 返回身份。
- **档 2**：A 建组、B 加入；各自在**同视频**标注 → 双方注入态互见（虚线+作者 chip）。
- **档 3**：RLS——非成员读私密组 pack 被拒（403/空）；公开组匿名可读。
- **档 4**：`updated` 合并幂等；并发写不覆盖（复用 R4a 语义）。
- **档 5**：GitStore 进阶通道仍可用（回归 R4a 测试）。

## 8. 风险与未决

| 风险 | 应对 |
|---|---|
| CloudBase 体验版额度/QPS | 早期够用；超限评估升配 |
| 自定义登录私钥/secret 管理 | 走 `sec` + 云函数环境变量；不入库 |
| RLS 子查询写法版本限制 | 退 `security definer is_member()` 函数 |
| GitHub 国内可达性 | 中国用户 GitHub 登录本身可能慢；后续评估 Gitee/微信 provider |
| 托管 vs 本地优先定位张力 | 组数据托管是"可选"；单机全功能仍本地，导出自持不破 |
| 会话安全 | HttpOnly/SameSite；ticket 一次性、短时效 |

## 9. 第一批可实施步骤

1. **PG schema + RLS**（经 `managePgDatabase(action=applyMigration)`，本地写 `cloudbase/migrations/<ver>_r4b_groups.sql`）——可独立验收（RLS 越权测试）。
2. **前端 HubStore + `app.rdb()` CRUD**（`src/group.js`）+ Publishable Key 初始化——本机可先用手动插入的种子数据验证读写与 RLS。
3. **OAuth 云函数**（`/auth/github/start`、`/callback` + 自定义登录签发）——部署到 CloudBase，线上验证登录。
4. **接起来**：登录态 → HubStore 建组/加入/同步 → 档 1/2/3 验收。
5. **GitStore 下移为进阶** + 回归 R4a 测试。
