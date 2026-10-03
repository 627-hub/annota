// node dev/group_sync.test.mjs — 客户端组层（mock GitStore）：拉→分层缓存→推→两人合并；个人层不被污染
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'src', 'group.js'), 'utf8');

function mkSandbox() {
  const s = {
    console, btoa, atob, TextEncoder, TextDecoder, URL, URLSearchParams,
    JSON, Object, Array, String, Number, Promise, Error,
    localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
    VAIdentity: { current: () => ({ id: 'urn:hash:me', name: 'me' }) },
  };
  s.self = s; s.window = s;
  vm.createContext(s);
  vm.runInContext(code, s);
  return s;
}

// 共享"远端仓库"（模拟 GitStore.readPack/writePack 的服务端状态）
const remote = new Map();  // mediaKey -> {entries:[...]}

function install(sb, who) {
  const merge = (a, b) => { const out = a.slice(); for (const e of b) if (!out.some((o) => o.id === e.id)) out.push(e); return out; };
  // 覆盖 GitStore 的 readPack/writePack 为内存实现（服务端 merge）
  sb.VAGroup.GitStore.readPack = async (bind, mk) => { const r = remote.get(bind.gid + '/' + mk); return r ? { format: 'video-annotate/0.1', media: { videoId: mk }, entries: r.slice() } : { format: 'video-annotate/0.1', media: { videoId: mk }, entries: [] }; };
  sb.VAGroup.GitStore.writePack = async (bind, mk, pack) => {
    const key = bind.gid + '/' + mk;
    const cur = remote.get(key) || [];
    const merged = merge(cur, pack.entries || []);
    remote.set(key, merged);
    return { format: 'video-annotate/0.1', media: pack.media || { videoId: mk }, entries: merged };
  };
  sb.VAGroup.install({ mergePack: merge, mediaMeta: () => ({ videoId: 'BV1', platform: 'bilibili', title: 'T' }) });
  // 注册一个组（模拟已加入）
  sb.VAGroup.addGroup({ gid: 'grp_x', name: '测试组', host: 'github', repo: 'a/g', branch: 'main', token: 'T' });
  return sb;
}

const A = install(mkSandbox(), 'A');
const B = install(mkSandbox(), 'B');

const box = (n) => ({ x: n, y: n, w: .2, h: .2 });

// A 标 2 条并推送
await A.VAGroup.pushForMedia('BV1', [
  { id: 'a1', word: 'apple', box: box(.1), t: 1, creator: { name: 'A' } },
  { id: 'a2', word: 'apricot', box: box(.2), t: 2, creator: { name: 'A' } },
]);
// B 拉 → 组缓存应含 A 的 2 条
await B.VAGroup.pullForMedia('BV1');
const bCache = JSON.parse(B.localStorage.getItem('va:group:grp_x:BV1'));
assert.equal(bCache.entries.length, 2, 'B 应拉到 A 的 2 条');

// B 标 1 条并推送 → 远端 3 条
await B.VAGroup.pushForMedia('BV1', [{ id: 'b1', word: 'banana', box: box(.3), t: 3, creator: { name: 'B' } }]);
// A 拉 → 3 条
await A.VAGroup.pullForMedia('BV1');
const aCache = JSON.parse(A.localStorage.getItem('va:group:grp_x:BV1'));
assert.equal(aCache.entries.length, 3, 'A 应看到自己 2 + B 的 1 = 3 条');
assert.ok(aCache.entries.some((e) => e.id === 'b1' && e.creator.name === 'B'), 'A 应看到 B 的条目及作者');

// 个人层不被污染：本地 va:entries 与组缓存是两把钥匙
assert.equal(A.localStorage.getItem('va:entries:BV1'), null, '个人层不应被组写入');
assert.ok(A.localStorage.getItem('va:group:grp_x:BV1'), '组层单独存储');

console.log('group_sync.test  PASS · 拉2条 → 各自推 → 合并3条 · 作者保留 · 个人层隔离');
process.exit(0);
