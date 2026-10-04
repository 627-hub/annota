// node dev/group_sync.test.mjs — 客户端组层（真 writePack + mock 网络）：
// 拉→分层缓存→推→两人合并；幂等；作者保留；个人层隔离
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'src', 'group.js'), 'utf8');

// 共享"远端仓库"（Contents API 语义），所有 sandbox 指向它
const remote = new Map();  // path -> { content(pack), sha }
let shaSeq = 1;
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function fromB64(s) { return Buffer.from(s, 'base64').toString('utf8'); }
function resp(st, j) { return { ok: st >= 200 && st < 300, status: st, json: async () => j }; }
async function remoteFetch(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const p = url.split('/contents/')[1].split('?')[0];
  if (method === 'GET') { const f = remote.get(p); return f ? resp(200, { content: b64(JSON.stringify(f.content)), sha: f.sha }) : resp(404, { message: 'NF' }); }
  if (method === 'PUT') {
    const body = JSON.parse(opts.body); const cur = remote.get(p);
    if (cur && (!body.sha || cur.sha !== body.sha)) return resp(409, { message: 'sha mismatch' });
    const f = { content: JSON.parse(fromB64(body.content)), sha: 's' + (shaSeq++) };
    remote.set(p, f); return resp(200, { sha: f.sha });
  }
  return resp(405, {});
}

const mergeReal = (a, b) => { const out = a.slice(); for (const e of b) if (!out.some((o) => o.id === e.id)) out.push(e); return out; };

function mkSandbox() {
  const s = {
    console, btoa, atob, TextEncoder, TextDecoder, URL, URLSearchParams,
    JSON, Object, Array, String, Number, Promise, Error, fetch: remoteFetch,
    localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
    VAIdentity: { current: () => ({ id: 'urn:hash:me', name: 'me' }) },
  };
  s.self = s; s.window = s;
  vm.createContext(s);
  vm.runInContext(code, s);
  // 用真 writePack，仅注入 core 的 mergePack + mediaMeta
  s.VAGroup.install({ mergePack: mergeReal, mediaMeta: () => ({ videoId: 'BV1', platform: 'bilibili', title: 'T' }) });
  s.VAGroup.addGroup({ gid: 'grp_x', name: '测试组', host: 'github', repo: 'a/g', branch: 'main', token: 'T' });
  // 组片单含 BV1（否则不会推——这是 High 修复后的行为）
  s.VAGroup.saveGroups(s.VAGroup.listGroups().map((g) => Object.assign({}, g, { doc: { id: 'grp_x', name: '测试组', contentList: { items: [{ media: { videoId: 'BV1' } }] } } })));
  return s;
}

const A = mkSandbox();
const B = mkSandbox();
const box = (n) => ({ x: n, y: n, w: .2, h: .2 });

// A 推 2 条
await A.VAGroup.pushForMedia('BV1', [
  { id: 'a1', word: 'apple', box: box(.1), t: 1, creator: { name: 'A' } },
  { id: 'a2', word: 'apricot', box: box(.2), t: 2, creator: { name: 'A' } },
]);
// B 拉 → 2 条
await B.VAGroup.pullForMedia('BV1');
let bCache = JSON.parse(B.localStorage.getItem('va:group:grp_x:BV1'));
assert.equal(bCache.entries.length, 2, 'B 应拉到 A 的 2 条');

// B 推 1 条 → 远端 3 条
await B.VAGroup.pushForMedia('BV1', [{ id: 'b1', word: 'banana', box: box(.3), t: 3, creator: { name: 'B' } }]);
// A 拉 → 3 条，且含 B 的作者
await A.VAGroup.pullForMedia('BV1');
let aCache = JSON.parse(A.localStorage.getItem('va:group:grp_x:BV1'));
assert.equal(aCache.entries.length, 3, 'A 应看到 2+1=3 条');
assert.ok(aCache.entries.some((e) => e.id === 'b1' && e.creator.name === 'B'), 'A 应看到 B 的条目及作者');
// A 自己的条目作者保留
assert.ok(aCache.entries.some((e) => e.id === 'a1' && e.creator.name === 'A'), 'A 的条目作者应保留');

// 幂等：A 重推同 id 两条 → 远端仍 3 条
await A.VAGroup.pushForMedia('BV1', [
  { id: 'a1', word: 'apple', box: box(.1), t: 1, creator: { name: 'A' } },
  { id: 'a2', word: 'apricot', box: box(.2), t: 2, creator: { name: 'A' } },
]);
assert.equal((remote.get('packs/BV1.json').content.entries || []).length, 3, '重复推送同 id 应幂等（仍 3 条）');

// 个人层隔离：组代码不碰 va:entries
assert.equal(A.localStorage.getItem('va:entries:BV1'), null, '组代码不应写个人层 va:entries');
assert.ok(A.localStorage.getItem('va:group:grp_x:BV1'), '组层单独存储');

// 片单过滤（High 修复）：不在片单的媒体，pushForMedia 不应推到该组
const pushed = await A.VAGroup.pushForMedia('BV_OTHER', [{ id: 'z1', word: 'zzz', box: box(.1), t: 1 }]);
assert.equal(pushed.groups.length, 0, '不在片单的媒体不应推送到组');
assert.equal(remote.has('packs/BV_OTHER.json'), false, '不应为无关媒体建包');

console.log('group_sync.test  PASS · 拉2→各自推→合并3 · 幂等 · 作者保留 · 个人层隔离 · 片单过滤');
process.exit(0);
