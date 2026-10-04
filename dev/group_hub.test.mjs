// node dev/group_hub.test.mjs — HubStore（CloudBase app.rdb()）纯逻辑：mock cloudbase
// 验证：createGroup/join/pull/push 走 rdb；storeFor 分发 hub/git；inviteLink(hub) 无 token
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'src', 'group.js'), 'utf8');

// ---- 极简 pg 内存（模拟 postgREST 链式调用，够测我们用的方法）----
function makeDb() {
  const tables = { groups: [], members: [], packs: [] };
  const api = {
    from(name) {
      const rows = tables[name];
      const q = { _f: [], _eq: {}, _single: false };
      const match = (r) => Object.entries(q._eq).every(([k, v]) => r[k] === v);
      q.eq = (k, v) => { q._eq[k] = v; return q; };
      q.single = () => { q._single = true; return q; };
      q.select = () => q;
      const run = async () => { const out = rows.filter(match); return { data: q._single ? (out[0] || null) : out, error: q._single && !out[0] ? { message: 'no row' } : null }; };
      q.then = (res, rej) => run().then(res, rej);
      q.insert = (obj) => { rows.push(Object.assign({}, obj)); return Promise.resolve({ data: obj, error: null }); };
      q.update = (obj) => { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, obj)); return { eq: q.eq, then: (res) => Promise.resolve({ data: hit }).then(res) }; };
      q.upsert = (obj, opt) => {
        const keys = String((opt && opt.onConflict) || '').split(',');
        const hit = rows.find((r) => keys.every((k) => r[k] === obj[k]));
        if (hit) Object.assign(hit, obj); else rows.push(Object.assign({}, obj));
        return Promise.resolve({ data: obj, error: null });
      };
      return q;
    },
    _tables: tables,
  };
  return api;
}

function mkSandbox() {
  const db = makeDb();
  const calls = { replaceState: [], signedIn: null };
  const s = {
    console, btoa, atob, TextEncoder, TextDecoder, URL, URLSearchParams,
    JSON, Object, Array, String, Number, Promise, Error, fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
    location: { href: 'https://app.local/group.html', assign(u) { s.location.href = u; } },
    history: { replaceState(a, b, u) { calls.replaceState.push(u); s.location.href = u; } },
    VAIdentity: { current: () => ({ id: 'user-A', name: 'Alice' }) },
    cloudbase: {
      init: () => ({
        rdb: () => db,
        auth: {
          signInWithCustomTicket: async (getTicket) => { calls.signedIn = await getTicket(); return { data: { user: { id: 'gh-1' } }, error: null }; },
          getSession: async () => ({ data: { session: null }, error: null }),
          signOut: async () => ({ data: {}, error: null }),
        },
      }),
    },
  };
  s.self = s; s.window = s;
  vm.createContext(s); vm.runInContext(code, s);
  s.VAGroup.setPublishableKey('PK-test');   // 让 cbInit 通过
  s.VAGroup.install({ mergePack: (a, b) => { const o = a.slice(); for (const e of b) if (!o.some((x) => x.id === e.id)) o.push(e); return o; }, mediaMeta: () => ({ videoId: 'BV1' }) });
  s.__db = db;
  s.__calls = calls;
  return s;
}

const S = mkSandbox();
const G = S.VAGroup;

// storeFor 分发
assert.equal(G.storeFor('hub'), G.HubStore);
assert.equal(G.storeFor('github'), G.GitStore);

// createGroup(hub) → groups + members(owner)
const created = await G.createGroup({ host: 'hub', name: '云组', contentItems: [{ media: { videoId: 'BV1' } }] });
assert.equal(created.rec.host, 'hub');
assert.equal(S.__db._tables.groups.length, 1);
assert.equal(S.__db._tables.members.length, 1);
assert.equal(S.__db._tables.members[0].role, 'owner');

// 片单项裸 id 与 userscript 带前缀 mediaId 视作同一媒体（R4b 主链路）
assert.ok(G.groupsForMedia('bilibili:BV1').some((g) => g.gid === created.rec.gid), '带前缀 mediaId 应匹配裸 videoId 片单项');
assert.ok(G.groupsForMedia('BV1').some((g) => g.gid === created.rec.gid), '裸 id 也应匹配');
assert.equal(G.groupsForMedia('bilibili:OTHER').length, 0, '不相关媒体不应匹配');

// inviteLink(hub) 无 token、无 repo
const link = G.inviteLink(created.rec);
assert.ok(link.indexOf('token') < 0 && link.indexOf('#t=') < 0, 'hub 邀请链接不应带 token');
const parsed = G.parseInvite(link);
assert.equal(parsed.host, 'hub');
assert.equal(parsed.gid, created.rec.gid);

// 推 pack（hub）→ packs 表
await G.pushForMedia('BV1', [{ id: 'a1', word: 'apple', box: { x: .1, y: .1, w: .2, h: .2 }, t: 1 }]);
assert.equal(S.__db._tables.packs.length, 1);
assert.equal(S.__db._tables.packs[0].entries.length, 1);

// 拉 pack → 本地缓存
await G.pullForMedia('BV1');
const cache = JSON.parse(S.localStorage.getItem('va:group:' + created.rec.gid + ':BV1'));
assert.equal(cache.entries.length, 1, '应拉到 1 条');

// 幂等：再推同 id → 仍 1 条
await G.pushForMedia('BV1', [{ id: 'a1', word: 'apple', box: { x: .1, y: .1, w: .2, h: .2 }, t: 1 }]);
assert.equal(S.__db._tables.packs[0].entries.length, 1, 'hub 合并应幂等');

// myGroups
const mines = await G.myGroups();
assert.deepEqual(mines, [created.rec.gid]);

// ---- 登录态：loginUrl 的 state 可逆；handleTicket 兑换会话并缓存云端身份 ----
const LU = G.loginUrl('https://app.local/p?x=1');
assert.ok(LU.startsWith(G.HUB_BASE + '/auth/github/start?state='), 'loginUrl 指向云函数 start');
const st = decodeURIComponent(new URL(LU).searchParams.get('state'));
const back = new TextDecoder().decode(Uint8Array.from(atob(st.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
assert.equal(back, 'https://app.local/p?x=1', 'state 可还原回跳地址');

S.location.href = 'https://app.local/group.html?ticket=T-123&uid=gh-1&name=octo';
const u = await G.handleTicket();
assert.equal(S.__calls.signedIn, 'T-123', '应把 ticket 交给 SDK');
assert.equal(u.id, 'gh-1');
assert.equal(G.hubMe().id, 'gh-1');
assert.equal(G.hubMe().name, 'octo');
assert.ok(!/ticket=/.test(S.location.href), 'handleTicket 后地址栏应清掉 ticket');
assert.ok(G.hubIdentity().id === 'gh-1', '登录后 hub 操作用云端身份');

// ---- 加入：B 凭 gid 自助加入（先 insert 成员，再读组）----
G.setHubMe(null);                                   // A 建组用本地身份
const gA = await G.createGroup({ host: 'hub', name: 'G-A' });
const inviteA = G.inviteLink(gA.rec);
S.VAIdentity.current = () => ({ id: 'user-B', name: 'Bob' });
const joined = await G.joinGroup(inviteA);
assert.equal(joined.rec.role, 'member');
assert.equal(joined.rec.name, 'G-A');
assert.ok(S.__db._tables.members.some((m) => m.group_id === gA.rec.gid && m.user_id === 'user-B' && m.role === 'member'), 'B 应成为成员');

console.log('group_hub.test  PASS · storeFor 分发 · createGroup/join/push/pull/幂等/邀请(hub) 走 app.rdb() · 无 token · 登录态/自助加入 OK');
process.exit(0);
