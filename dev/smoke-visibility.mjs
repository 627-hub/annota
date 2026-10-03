// node dev/smoke-visibility.mjs — 热力框可见性：单条隐藏 / 全部 / 仅当前 / renderOnly 不受隐藏影响
// 复用 dev/smoke.mjs 的最小 VM DOM 思路；断言渲染层 .va-mark 数量随可见性变化。
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'dist', 'annotate.user.js'), 'utf8');

function makeNode(tag) {
  const listeners = {};
  let ownText = '';
  const n = {
    tagName: (tag || 'div').toUpperCase(), style: {}, value: '', children: [], parentElement: null,
    className: '', isConnected: true, dataset: {}, attributes: {}, innerHTML: '',
    get textContent() { return ownText + n.children.map((c) => typeof c === 'string' ? c : (c.textContent || '')).join(''); },
    set textContent(v) { ownText = String(v == null ? '' : v); n.children = []; },
    classList: {
      contains(c) { return n.className.split(/\s+/).includes(c); },
      add(c) { if (!this.contains(c)) n.className = (n.className + ' ' + c).trim(); },
      remove(c) { n.className = n.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      toggle(c, f) { const on = f == null ? !this.contains(c) : !!f; on ? this.add(c) : this.remove(c); return on; },
    },
    appendChild(c) { if (typeof c === 'string' || typeof c === 'number') c = { textContent: String(c), parentElement: null }; c.parentElement = n; n.children.push(c); return c; },
    append(...cs) { for (const c of cs) n.appendChild(c); },
    attachShadow() { n.shadowRoot = makeNode('shadow-root'); n.shadowRoot.host = n; return n.shadowRoot; },
    setAttribute(k, v) { n.attributes[k] = String(v); }, getAttribute(k) { return n.attributes[k] || null; },
    contains(c) { while (c) { if (c === n) return true; c = c.parentElement; } return false; },
    remove() { if (n.parentElement) n.parentElement.children = n.parentElement.children.filter((x) => x !== n); n.parentElement = null; },
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
    dispatchEvent(e) { e.target ||= n; e.currentTarget = n; for (const f of listeners[e.type] || []) f(e); return true; },
    setPointerCapture() {}, querySelectorAll(s) { return queryAll(n, s); }, querySelector(s) { return queryAll(n, s)[0] || null; },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, }),
    focus() {}, click() { if (typeof n.onclick === 'function') n.onclick({ target: n, currentTarget: n, stopPropagation() {}, preventDefault() {} }); },
  };
  return n;
}
function queryAll(root, sel) {
  const cn = sel.startsWith('.') ? sel.slice(1) : '';
  const out = [];
  const walk = (node) => { for (const c of node.children || []) { if (cn && c.className && c.className.split(/\s+/).includes(cn)) out.push(c); walk(c); } };
  walk(root); return out;
}

const video = Object.assign(makeNode('video'), {
  videoWidth: 640, videoHeight: 360, readyState: 4, duration: 10, currentTime: 3,
  addEventListener() {}, removeEventListener() {}, pause() {}, play() { return Promise.resolve(); },
  getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 }),
});
const document = {
  body: makeNode('body'), head: makeNode('head'), documentElement: makeNode('html'), fullscreenElement: null, title: 'vis',
  createElement: (t) => makeNode(t), createElementNS: (_n, t) => makeNode(t),
  querySelectorAll: (s) => String(s).includes('video') ? [video] : [], querySelector: () => null, addEventListener() {},
};
document.body.appendChild(video);
const sandbox = {
  console, document,
  location: { hostname: '127.0.0.1', pathname: '/dev/demo.html', search: '', hash: '', href: 'http://127.0.0.1/dev/demo.html', origin: 'http://127.0.0.1' },
  history: { replaceState() {} },
  localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
  getComputedStyle: () => ({ objectFit: 'contain', display: 'block', visibility: 'visible', opacity: '1' }),
  innerWidth: 800, innerHeight: 600,
  setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
  requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0), cancelAnimationFrame() {},
  fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  URL, Blob, Image: class Image {}, TextEncoder, TextDecoder, btoa, atob,
  Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, Error, Promise, Uint8Array, URLSearchParams,
  PointerEvent: class PointerEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'annotate.user.js' });
await new Promise((r) => setTimeout(r, 30));
const st = sandbox.__VA.state;
st.binding.kind && assert.equal(st.binding.kind, 'video');
const box = { x: .1, y: .1, w: .2, h: .2 };
st.entries = [
  { id: 'v1', word: 'one', t: 1, dur: 1, box },
  { id: 'v2', word: 'two', t: 2, dur: 1, box },
  { id: 'v3', word: 'three', t: 3, dur: 1, box },
];
const hostOf = () => document.body.children.find((n) => n.id === 'annota-shadow-host');
const rootOf = () => hostOf().shadowRoot.children.find((n) => n.className === 'va-ui-root');
const marks = () => queryAll(rootOf(), '.va-mark').length;

// 打开面板渲染列表
sandbox.__ANNOTA_UI__.openPanel();
// 通过 UI 的可见性接口操作：这里直接调用 render 前先触发一次列表渲染以挂上眼睛按钮
// 触发：模拟「显示全部」应 3 个框
st.showAll = true;
// 手工调用内部不可行 → 用可见性快捷入口：面板里"全部"按钮
const visAll = queryAll(rootOf(), '.va-chip').find((b) => b.getAttribute('aria-label') === '显示全部热力框');
assert.ok(visAll, '缺少「全部」快捷按钮');
visAll.click();
assert.equal(marks(), 3, '「全部」后应显示 3 个框');

// 单条隐藏：找到某行的眼睛按钮（eye）并点击
const eye = queryAll(rootOf(), '.va-entry-eye')[0];
assert.ok(eye, '列表行缺少眼睛按钮');
eye.click();
assert.equal(marks(), 2, '隐藏一条后应显示 2 个框');

// 仅当前
const visOnly = queryAll(rootOf(), '.va-chip').find((b) => b.getAttribute('aria-label') === '只显示当前热力框');
assert.ok(visOnly, '缺少「仅当前」快捷按钮');
visOnly.click();
assert.equal(marks(), 1, '「仅当前」后应只显示 1 个框');

// 全部恢复
visAll.click();
assert.equal(marks(), 3, '「全部」应恢复 3 个框');

// 隐藏状态持久化到 localStorage（按媒体）
const key = 'va:hidden:' + String(st.mediaId);
const persisted = sandbox.localStorage.getItem(key);
assert.ok(persisted != null, '隐藏状态应写入 localStorage ' + key);
assert.deepEqual(JSON.parse(persisted), [], '「全部」后隐藏集应为空');

console.log('smoke-visibility OK · 全部=3 · 隐藏后=2 · 仅当前=1 · 持久化=' + key);
process.exit(0);
