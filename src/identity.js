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

  // 规范化 JWK：按固定字段顺序拼接后再 hash（不同浏览器 JWK 属性顺序可能不同）
  function canonicalJwk(jwk) {
    if (!jwk) return '';
    const kty = jwk.kty || '', crv = jwk.crv || '', x = jwk.x || '', y = jwk.y || '';
    // 兜底：无固定字段时按键名排序序列化
    if (!x && !y) {
      try { return JSON.stringify(jwk, Object.keys(jwk).sort()); } catch (e) { return String(jwk); }
    }
    return [kty, crv, x, y].join('|');
  }

  // 生成/加载身份；name 变化时更新（id 不变）。返回 {id, name, publicJwk?}
  // 只有"密码学身份"才落盘；非密码学兜底 id 用 urn:local: 且不落盘（留待 ensure 升级为 urn:hash:）。
  async function ensure(opts) {
    const wantName = nameFrom(opts);
    const stored = readStore();
    if (stored && stored.id) {
      if (stored.name !== wantName) { stored.name = wantName; writeStore(stored); }
      cached = stored;
      return { id: stored.id, name: stored.name, publicJwk: stored.publicJwk };
    }
    // 首次：生成本地密钥对
    let id = null, publicJwk = null;
    try {
      if (root.crypto && root.crypto.subtle && root.crypto.subtle.generateKey) {
        const kp = await root.crypto.subtle.generateKey(
          { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
        );
        publicJwk = await root.crypto.subtle.exportKey('jwk', kp.publicKey);
        id = 'urn:hash:' + (await sha256Hex(canonicalJwk(publicJwk)));
      }
    } catch (e) { /* WebCrypto 不可用 */ }
    if (!id) {
      // 无 WebCrypto：返回临时身份，但**不落盘**（下次有 WebCrypto 时可生成真正密钥身份）
      return { id: null, name: wantName, publicJwk: null, degraded: true };
    }
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

  // 同步取 creator（若尚未 ensure 过，用已存的）。无既有身份且缺 WebCrypto 时，
  // 给一个 urn:local: 临时 id（不落盘，避免把临时身份固化成"永久非密码学 id"）。
  function creatorSync(name) {
    const c = current();
    if (c) return { type: 'Person', id: c.id, name: c.name };
    const nm = (name || '匿名标注者').slice(0, 40);
    const hasCrypto = !!(root.crypto && root.crypto.subtle && root.crypto.subtle.generateKey);
    if (hasCrypto) {
      // 有 WebCrypto：预热（异步）生成真正身份；此处先返回占位（下一条起就是正式 id）
      warmup({ name: nm });
      return { type: 'Person', id: 'urn:local:' + randomId(), name: nm, provisional: true };
    }
    return { type: 'Person', id: 'urn:local:' + randomId(), name: nm, provisional: true };
  }

  // 后台预热（core 启动时调一次即可）。即便首次无 WebCrypto（id=null）也缓存 promise，避免重复尝试。
  function warmup(opts) {
    if (!readyPromise) readyPromise = ensure(opts).catch(() => null);
    return readyPromise;
  }

  root.VAIdentity = { ensure, current, creatorSync, warmup, canonicalJwk, _sha256Hex: sha256Hex };
})(typeof self !== 'undefined' ? self : this);
