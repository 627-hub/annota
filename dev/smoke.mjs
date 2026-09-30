// node dev/smoke.mjs —— 用最小假 DOM 跑一遍 dist/annotate.user.js，抓运行时错误
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'dist', 'annotate.user.js'), 'utf8');

function makeNode(tag) {
  const n = {
    tagName: (tag || 'div').toUpperCase(),
    style: {}, textContent: '', children: [], parentElement: null,
    className: '', isConnected: true,
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    appendChild(c) { if (typeof c === 'string' || typeof c === 'number') c = { textContent: String(c), parentElement: null }; c.parentElement = n; n.children.push(c); return c; },
    append(...cs) { for (const c of cs) n.appendChild(c); },
    remove() { n.parentElement = null; },
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {},
    querySelectorAll: () => [], querySelector: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }),
    focus() {}, click() {},
  };
  return n;
}

const video = Object.assign(makeNode('video'), {
  videoWidth: 1920, videoHeight: 1080, readyState: 4, currentTime: 3.2,
  pause() {}, play() { return Promise.resolve(); },
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 800, left: 0, top: 0, right: 800, bottom: 800 }),
});

let frames = 0;
const document = {
  body: makeNode('body'),
  fullscreenElement: null,
  createElement: (t) => makeNode(t),
  querySelectorAll: (sel) => (String(sel).includes('video') ? [video] : []),
  querySelector: () => null,
  addEventListener() {},
};

const sandbox = {
  console,
  document,
  location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '', href: 'https://www.bilibili.com/video/BV1xx411c7mD', origin: 'https://www.bilibili.com' },
  localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
  getComputedStyle: () => ({ objectFit: 'contain', display: 'block', visibility: 'visible', opacity: '1' }),
  innerWidth: 1200, innerHeight: 800,
  setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
  requestAnimationFrame: (cb) => { if (frames < 3) { frames++; setTimeout(() => cb(0), 0); } return frames; },
  cancelAnimationFrame() {},
  Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, Error, Promise, URLSearchParams,
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'annotate.user.js' });

await new Promise((r) => setTimeout(r, 30));

assert.equal(sandbox.window.__VA_LOADED__, true, '__VA_LOADED__');
assert.ok(sandbox.window.VAGeo, 'VAGeo 未挂载');
assert.ok(sandbox.window.VAAdapter, 'VAAdapter 未挂载');
assert.ok(document.body.children.length >= 2, 'overlay/bar 未挂到 body（可能适配层没找到主视频）');
assert.ok(sandbox.window.VAAdapter.mediaId() === 'bilibili:BV1xx411c7mD', 'mediaId 解析错误: ' + sandbox.window.VAAdapter.mediaId());

const st = sandbox.window.__VA.state;
assert.ok(st.cr, 'cr 未计算');
for (const k of ['x', 'y', 'w', 'h']) {
  assert.ok(Number.isFinite(st.cr[k]), `content.${k} 为 NaN（DOMRect 字段不匹配？）: ` + JSON.stringify(st.cr));
}
assert.ok(Number.isFinite(st.rect.width) && Number.isFinite(st.rect.height), 'rect 字段异常');

console.log('smoke OK · frames=%d · body children=%d · mediaId=%s',
  frames, document.body.children.length, sandbox.window.VAAdapter.mediaId());
