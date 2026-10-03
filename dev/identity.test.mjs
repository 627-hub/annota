// node dev/identity.test.mjs — 本地身份：id 稳定 / name 可变 / creator 形状
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'src', 'identity.js'), 'utf8');

function mkSandbox() {
  const s = {
    console, btoa, atob, TextEncoder, TextDecoder,
    crypto: globalThis.crypto,
    localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
    setTimeout, clearTimeout, Date, Math, JSON, Object, String, Number, Array, Promise, Uint8Array, Error,
  };
  s.self = s; s.window = s;
  vm.createContext(s);
  vm.runInContext(code, s);
  return s;
}

const s = mkSandbox();
const id = s.VAIdentity;

const a = await id.ensure({ name: 'alice' });
assert.ok(a.id.startsWith('urn:hash:'), 'id 应为 urn:hash:… got ' + a.id);
assert.equal(a.name, 'alice');
assert.ok(a.publicJwk && a.publicJwk.kty === 'EC', '应产出 P-256 公钥 JWK');

const b = await id.ensure({ name: 'alice-renamed' });
assert.equal(b.id, a.id, '改名不改 id');
assert.equal(b.name, 'alice-renamed');

const c = id.creatorSync('x');
assert.equal(c.type, 'Person');
assert.equal(c.id, a.id, 'creatorSync 应复用已存 id');
assert.equal(c.name, 'alice-renamed');

// 新环境（清空 localStorage）→ id 不同（本例无跨环境持久，验证"换存储换 id"）
const s2 = mkSandbox();
const d = await s2.VAIdentity.ensure({ name: 'bob' });
assert.notEqual(d.id, a.id, '不同存储应得到不同 id');

// 空名 → 默认
const s3 = mkSandbox();
const e = await s3.VAIdentity.ensure({ name: '   ' });
assert.equal(e.name, '匿名标注者');

console.log('identity.test  PASS · id=' + a.id.slice(0, 22) + '… · name 可变 · creator 形状 OK');
process.exit(0);
