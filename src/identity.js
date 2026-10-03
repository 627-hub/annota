/* Annota · 本地身份（R4a）
 * 离线可用的 creator 身份：本地生成 P-256 密钥对，creator.id = urn:hash:sha256(公钥 JWK)。
 * 纯 WebCrypto，无依赖；三形态（userscript / MV3 / Tauri）通用。
 *
 * 设计：不强制账号、不联网。密钥不可导出时（部分环境 WebCrypto 受限）退化为
 * 一次性随机 id（仍可用，只是跨设备不稳定）。R4b 才接 OAuth 做跨设备身份。
 */
(function (root) {
  'use strict';

  const LS_KEY = 'annota:identity';
  let cached = null;            // { id, name, publicJwk? }
  let readyPromise = null;

  function b64url(bytes) {
    let s = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function randomId() {
    const a = new Uint8Array(8);
    try {
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(a);
      else for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0;   // 兜底（无 WebCrypto 的环境）
    } catch (e) { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; }
    return b64url(a);
  }

  function readStore() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; }
  }
  function writeStore(obj) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch (e) {}
  }

  function nameFrom(opts) {
    const n = (opts && opts.name != null) ? String(opts.name) : '';
    return (n.trim() || '匿名标注者').slice(0, 40);
  }

  // 生成/加载身份；name 变化时更新（id 不变）。返回 {id, name, publicJwk?}
  async function ensure(opts) {
    const wantName = nameFrom(opts);
    const stored = readStore();
    if (stored && stored.id) {
      if (stored.name !== wantName) { stored.name = wantName; writeStore(stored); }
      cached = stored;
      return { id: stored.id, name: stored.name, publicJwk: stored.publicJwk };
    }
    // 首次：生成本地密钥对（失败则随机 id 兜底，仍可用）
    let id = 'urn:hash:' + randomId();
    let publicJwk = null;
    try {
      if (root.crypto && root.crypto.subtle && root.crypto.subtle.generateKey) {
        const kp = await root.crypto.subtle.generateKey(
          { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
        );
        publicJwk = await root.crypto.subtle.exportKey('jwk', kp.publicKey);
        id = 'urn:hash:' + (await sha256Hex(JSON.stringify(publicJwk)));
      }
    } catch (e) { /* WebCrypto 不可用 → 随机 id */ }
    const rec = { id, name: wantName, publicJwk, created: new Date().toISOString() };
    writeStore(rec);
    cached = rec;
    return { id, name: wantName, publicJwk };
  }

  function current() {
    if (cached) return { id: cached.id, name: cached.name, publicJwk: cached.publicJwk };
    const stored = readStore();
    if (stored && stored.id) { cached = stored; return { id: stored.id, name: stored.name, publicJwk: stored.publicJwk }; }
    return null;
  }

  // 同步取 creator（若尚未 ensure 过，用已存的；都没有则给一个占位，避免阻塞保存）
  function creatorSync(name) {
    const c = current();
    if (c) return { type: 'Person', id: c.id, name: c.name };
    const id = 'urn:hash:' + randomId();
    const rec = { id, name: (name || '匿名标注者').slice(0, 40), publicJwk: null, created: new Date().toISOString() };
    writeStore(rec); cached = rec;
    return { type: 'Person', id, name: rec.name };
  }

  // 后台预热（core 启动时调一次即可）
  function warmup(opts) {
    if (!readyPromise) readyPromise = ensure(opts).catch(() => null);
    return readyPromise;
  }

  root.VAIdentity = { ensure, current, creatorSync, warmup, _sha256Hex: sha256Hex };

  // 模块内自测（VM/无副作用）
})(typeof self !== 'undefined' ? self : this);
