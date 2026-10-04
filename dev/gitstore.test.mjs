// node dev/gitstore.test.mjs — GitStore 纯逻辑（mock fetch）：读/写/409 重试/merge 幂等
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- 假 GitHub Contents API（内存仓库）----
function makeRepo() {
  const files = new Map();   // path -> { content(obj), sha, n }
  let shaSeq = 1;
  return {
    files,
    fetch: async (url, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      const u = new URL(url);
      const m = u.pathname.match(/\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/);
      if (!m) return resp(404, { message: 'no route' });
      const p = m[2];
      if (method === 'GET') {
        if (!files.has(p)) return resp(404, { message: 'Not Found' });
        const f = files.get(p);
        return resp(200, { content: b64(JSON.stringify(f.content)), sha: f.sha });
      }
      if (method === 'PUT') {
        const body = JSON.parse(opts.body);
        const cur = files.get(p);
        // 与真实 GitHub 一致：更新已存在文件必须带匹配的 sha，否则 409/422
        if (cur && (!body.sha || cur.sha !== body.sha)) return resp(409, { message: 'sha mismatch' });
        const f = { content: JSON.parse(fromB64(body.content)), sha: 'sha' + (shaSeq++) };
        files.set(p, f);
        return resp(200, { content: {}, sha: f.sha, commit: { sha: f.sha } });
      }
      return resp(405, { message: 'method' });
    },
  };
}
function resp(status, json) { return { ok: status >= 200 && status < 300, status, json: async () => json }; }

// 假 Gitee Contents API：新建用 POST（PUT 对不存在文件报 sha is empty）
function makeGiteeRepo() {
  const files = new Map(); let shaSeq = 1;
  return {
    fetch: async (url, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      const u = new URL(url);
      const m = u.pathname.match(/\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/);
      if (!m) return resp(404, { message: 'no route' });
      const p = m[2];
      if (method === 'GET') {
        if (!files.has(p)) return resp(404, { message: 'Not Found' });
        const f = files.get(p); return resp(200, { content: b64(JSON.stringify(f.content)), sha: f.sha });
      }
      if (method === 'POST') {   // Gitee 新建
        if (files.has(p)) return resp(400, { messages: ['file exists'] });
        const body = JSON.parse(opts.body);
        const f = { content: JSON.parse(fromB64(body.content)), sha: 'g' + (shaSeq++) };
        files.set(p, f); return resp(201, { content: { sha: f.sha } });
      }
      if (method === 'PUT') {    // Gitee 更新必须带非空 sha
        const body = JSON.parse(opts.body);
        if (!body.sha) return resp(400, { messages: ['sha is empty'] });
        const cur = files.get(p);
        if (!cur || cur.sha !== body.sha) return resp(409, { message: 'sha mismatch' });
        const f = { content: JSON.parse(fromB64(body.content)), sha: 'g' + (shaSeq++) };
        files.set(p, f); return resp(200, { content: { sha: f.sha } });
      }
      return resp(405, { message: 'method' });
    },
  };
}
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function fromB64(s) { return Buffer.from(s, 'base64').toString('utf8'); }

// ---- 载入 VAGroup（core 用最小桩）----
const code = fs.readFileSync(path.join(here, '..', 'src', 'group.js'), 'utf8');
const sandbox = {
  console, btoa, atob, TextEncoder, TextDecoder, URL, URLSearchParams, JSON, Object, Array, String, Number, Promise, Error,
  fetch: null,
  localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
  VAIdentity: { current: () => ({ name: 'tester' }) },
};
sandbox.self = sandbox; sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const repo = makeRepo();
sandbox.fetch = repo.fetch;
// 注入 core 合并桩（用 id 去重；真实实现由 core.mergePack 提供）
sandbox.VAGroup.install({
  mergePack: (a, b) => {
    const out = a.slice();
    for (const e of b) if (!out.some((o) => o.id === e.id)) out.push(e);
    return out;
  },
});

const bind = { kind: 'github', repo: 'alice/annota-group', branch: 'main', token: 'TOK', gid: 'grp_test' };
const G = sandbox.VAGroup.GitStore;

// 1) 读不存在 → missing / 空 pack
let p = await G.readPack(bind, 'BV1');
assert.equal(p.entries.length, 0, '缺文件应返回空 pack');

// 2) 写 pack → 读回
await G.writePack(bind, 'BV1', { media: { videoId: 'BV1' }, entries: [{ id: 'e1', word: 'apple', box: { x: .1, y: .1, w: .2, h: .2 }, t: 1 }] });
p = await G.readPack(bind, 'BV1');
assert.equal(p.entries.length, 1);
assert.equal(p.entries[0].word, 'apple');

// 3) 再写一条 → 合并保留两条
await G.writePack(bind, 'BV1', { media: { videoId: 'BV1' }, entries: [{ id: 'e2', word: 'banana', box: { x: .3, y: .3, w: .2, h: .2 }, t: 2 }] });
p = await G.readPack(bind, 'BV1');
assert.equal(p.entries.length, 2, 'merge 后应 2 条');

// 3b) 重复写同 id → 幂等，不重复
await G.writePack(bind, 'BV1', { media: { videoId: 'BV1' }, entries: [{ id: 'e2', word: 'banana', box: { x: .3, y: .3, w: .2, h: .2 }, t: 2 }] });
p = await G.readPack(bind, 'BV1');
assert.equal(p.entries.length, 2, '同 id 重复写应幂等');

// 4) 409 重试：手动制造 sha 过期（try/finally 保证恢复 mock，避免污染后续步骤）
const realFetch = repo.fetch;
try {
  repo.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET').toUpperCase() === 'PUT' && JSON.parse(opts.body).sha) {
      if (!repo.__forced) { repo.__forced = true; return resp(409, { message: 'forced conflict' }); }
    }
    return realFetch(url, opts);
  };
  await G.writePack(bind, 'BV1', { media: { videoId: 'BV1' }, entries: [{ id: 'e3', word: 'cherry', box: { x: .5, y: .5, w: .1, h: .1 }, t: 3 }] });
  p = await G.readPack(bind, 'BV1');
  assert.equal(p.entries.length, 3, '409 重试后应写入第 3 条');
} finally {
  repo.fetch = realFetch;
}

// 4b) write 的 builder 语义：409 重试会用「最新远端内容」重建 → 不覆盖并发写入（review High 的核心）
//     直接验证 GitStore.write 的 builder 在每次尝试都拿到 remote，并基于它生成内容。
{
  const files2 = new Map([['packs/X.json', { content: { format: 'video-annotate/0.1', entries: [{ id: 'old' }] }, sha: 'v1' }]]);
  let puts = 0;
  const mock = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const p = url.split('/contents/')[1].split('?')[0];
    if (method === 'GET') { const f = files2.get(p); return f ? resp(200, { content: b64(JSON.stringify(f.content)), sha: f.sha }) : resp(404, {}); }
    if (method === 'PUT') {
      puts += 1;
      if (puts === 1) {   // 首次：模拟并发——远端被别人加了 e9，sha 变化 → 409
        files2.set(p, { content: { format: 'video-annotate/0.1', entries: [{ id: 'old' }, { id: 'external' }] }, sha: 'v2' });
        return resp(409, { message: 'sha changed' });
      }
      const body = JSON.parse(opts.body);
      if (body.sha !== files2.get(p).sha) return resp(409, {});
      files2.set(p, { content: JSON.parse(fromB64(body.content)), sha: 'v3' });
      return resp(200, { sha: 'v3' });
    }
  };
  sandbox.fetch = mock;
  const merge2 = (cur, add) => { const o = (cur || []).slice(); for (const e of add) if (!o.some((x) => x.id === e.id)) o.push(e); return o; };
  const res = await G.write(bind, 'packs/X.json', (remote) => ({ format: 'video-annotate/0.1', entries: merge2(remote && remote.entries, [{ id: 'mine' }]) }));
  const ids = res.content.entries.map((e) => e.id).sort().join(',');
  assert.equal(ids, 'external,mine,old', '重试应基于最新远端重合并，不覆盖他人条目');
  sandbox.fetch = realFetch;
}

// 5) group.json 读/写
assert.equal(await G.readGroup(bind), null, 'group.json 缺失应 null');
await G.writeGroup(bind, { type: 'va:Group', id: 'grp_test', name: 'G' });
const g = await G.readGroup(bind);
assert.equal(g.name, 'G');

// 6) 组注册表
sandbox.VAGroup.addGroup({ gid: 'grp_test', name: 'G', host: 'github', repo: 'alice/annota-group', branch: 'main', token: 'TOK' });
assert.equal(sandbox.VAGroup.listGroups().length, 1);
assert.equal(sandbox.VAGroup.findGroup('grp_test').repo, 'alice/annota-group');

// 7) 建组 → group.json 落库 → 注册
sandbox.VAIdentity = { current: () => ({ id: 'urn:hash:alice', name: 'alice' }) };
const created = await sandbox.VAGroup.createGroup({
  host: 'github', repo: 'alice/annota-group', branch: 'main', token: 'TOK',
  name: 'IELTS 互助组', contentItems: [{ media: { platform: 'bilibili', videoId: 'BV1' } }],
});
assert.ok(created.doc.id.startsWith('grp_'), 'gid 形状');
assert.equal(created.doc.owner.id, 'urn:hash:alice');
assert.equal(created.doc.members[0].role, 'owner');
const gdoc = await G.readGroup({ kind: 'github', repo: 'alice/annota-group', branch: 'main', token: 'TOK', gid: created.doc.id });
assert.equal(gdoc.name, 'IELTS 互助组');
assert.equal(gdoc.contentList.items.length, 1);

// 8) 邀请链接 round-trip
const link = sandbox.VAGroup.inviteLink(created.rec, 'TOK');
assert.ok(link.startsWith('annota://join?'), link);
const parsed = sandbox.VAGroup.parseInvite(link);
assert.equal(parsed.gid, created.doc.id);
assert.equal(parsed.repo, 'alice/annota-group');
assert.equal(parsed.token, 'TOK');
// token 在 fragment（不在 query）
assert.ok(link.indexOf('?') < link.indexOf('#t='), 'token 应在 fragment');

// 9) 加入组（读仓库拿名称）
const joined = await sandbox.VAGroup.joinGroup(link);
assert.equal(joined.rec.name, 'IELTS 互助组');
assert.equal(joined.rec.role, 'member');

// 10) Gitee 路径：新建用 POST、更新用 PUT+sha
const giteeRepo = makeGiteeRepo();
sandbox.fetch = giteeRepo.fetch;
const gbind = { kind: 'gitee', repo: 'hub627/annota', branch: 'main', token: 'TOK', gid: 'grp_gitee' };
await G.writeGroup(gbind, { type: 'va:Group', id: 'grp_gitee', name: 'Gitee 组' });   // 新建 → POST
const gg = await G.readGroup(gbind);
assert.equal(gg.name, 'Gitee 组', 'Gitee 新建应成功（POST）');
await G.writeGroup(gbind, { type: 'va:Group', id: 'grp_gitee', name: 'Gitee 组2' });  // 更新 → PUT+sha
assert.equal((await G.readGroup(gbind)).name, 'Gitee 组2', 'Gitee 更新应成功（PUT+sha）');

console.log('gitstore.test  PASS · 读/写/merge幂等/409重试/group.json/注册表/建组/邀请round-trip/加入/Gitee(POST新建+PUT更新) OK');
process.exit(0);
