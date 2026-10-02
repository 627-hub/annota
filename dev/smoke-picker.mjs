// node dev/smoke-picker.mjs —— 手动选择对象：瀑布流页不自动绑定，但 dock 常驻、classify 可用
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'dist', 'annotate.user.js'), 'utf8');

function makeNode(tag) {
  const listeners = {};
  const n = {
    tagName: (tag || 'div').toUpperCase(),
    style: {}, textContent: '', value: '', children: [], parentElement: null,
    className: '', isConnected: true, dataset: {}, attributes: {}, innerHTML: '',
    classList: {
      contains(c) { return n.className.split(/\s+/).includes(c); },
      add(c) { if (!this.contains(c)) n.className = (n.className + ' ' + c).trim(); },
      remove(c) { n.className = n.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      toggle(c, force) { const on = force == null ? !this.contains(c) : !!force; on ? this.add(c) : this.remove(c); return on; },
    },
    appendChild(c) { if (typeof c === 'string' || typeof c === 'number') c = { textContent: String(c), parentElement: null }; c.parentElement = n; n.children.push(c); return c; },
    append(...cs) { for (const c of cs) n.appendChild(c); },
    attachShadow() { n.shadowRoot = makeNode('shadow-root'); n.shadowRoot.host = n; return n.shadowRoot; },
    setAttribute(k, v) { n.attributes[k] = String(v); },
    getAttribute(k) { return n.attributes[k] || null; },
    contains(c) { while (c) { if (c === n) return true; c = c.parentElement; } return false; },
    remove() { n.parentElement = null; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    dispatchEvent(ev) { ev.target ||= n; ev.currentTarget = n; ev.stopPropagation ||= () => {}; ev.preventDefault ||= () => {}; for (const fn of listeners[ev.type] || []) fn(ev); return true; },
    setPointerCapture() {},
    querySelectorAll(sel) { const s = String(sel); if (s.includes('img')) return n._imgs || []; return []; },
    querySelector: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 300, height: 300, left: 0, top: 0, right: 300, bottom: 300 }),
    focus() {}, click() { if (typeof n.onclick === 'function') n.onclick({ target: n, currentTarget: n, stopPropagation() {}, preventDefault() {} }); },
  };
  return n;
}

// 瀑布流：一个容器里多张同量级大图（模拟 pexels 网格）
const grid = makeNode('div');
const gallery = makeNode('div');
const pics = [];
for (let i = 0; i < 6; i++) {
  const img = Object.assign(makeNode('img'), {
    complete: true, naturalWidth: 1200, naturalHeight: 800,
    currentSrc: 'https://example.com/p' + i + '.jpg', src: 'https://example.com/p' + i + '.jpg',
    getBoundingClientRect: () => ({ x: (i % 3) * 300, y: Math.floor(i / 3) * 300, width: 280, height: 280, left: (i % 3) * 300, top: Math.floor(i / 3) * 300, right: (i % 3) * 300 + 280, bottom: Math.floor(i / 3) * 300 + 280 }),
  });
  pics.push(img); gallery.appendChild(img);
}
grid.appendChild(gallery);
grid._imgs = pics;

// 页面里先有一个视频 → A.watch 会自动绑定它（state.binding 非空），
// 之后手动选图片会走 attach→detach(旧)→重新 mountShell，用来回归「壳丢失」bug。
const video = Object.assign(makeNode('video'), {
  videoWidth: 1280, videoHeight: 720, readyState: 4, currentTime: 1,
  pause() {}, play() { return Promise.resolve(); },
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 }),
});

let frames = 0;
const document = {
  body: makeNode('body'),
  fullscreenElement: null,
  createElement: (t) => makeNode(t),
  createElementNS: (_ns, t) => makeNode(t),
  querySelectorAll: (sel) => {
    const s = String(sel);
    if (s.includes('video')) return [video];
    if (s === 'img' || s.includes('img')) return pics;
    return [];
  },
  querySelector: () => null,
  _listeners: {},
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); },
  dispatchEvent(ev) { for (const fn of (this._listeners[ev.type] || [])) fn(ev); return true; },
};

const sandbox = {
  console, document,
  location: { hostname: 'www.pexels.com', pathname: '/zh-cn/', search: '', href: 'https://www.pexels.com/zh-cn/', origin: 'https://www.pexels.com' },
  localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', objectFit: 'cover' }),
  innerWidth: 1200, innerHeight: 800,
  setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
  requestAnimationFrame: (cb) => { if (frames < 3) { frames++; setTimeout(() => cb(0), 0); } return frames; },
  cancelAnimationFrame() {},
  Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, Error, Promise, URLSearchParams, Set, Map,
  getSelection: () => null,
  PointerEvent: class PointerEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
sandbox.document.elementFromPoint = () => pics[2];   // 悬停在第三张图上

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'annotate.user.js' });
await new Promise((r) => setTimeout(r, 30));

const A = sandbox.window.VAAdapter;
const st = sandbox.window.__VA.state;

// 瀑布流不应自动绑定
assert.ok(st.binding && st.binding.kind === 'video', '页面先自动绑定视频（用于回归重绑路径），实为 ' + (st.binding && st.binding.kind));

// dock（含「选对象」）应常驻
const host = document.body.children.find((n) => n.id === 'annota-shadow-host');
const uiRoot = host && host.shadowRoot.children.find((n) => n.className === 'va-ui-root');
assert.ok(uiRoot, 'UI root 应存在');
const dock = uiRoot.children.find((n) => n.className === 'va-dock');
assert.ok(dock, 'dock 应常驻');
const pickBtn = dock.children.find((n) => n.attributes && n.attributes['aria-label'] === '选对象');
assert.ok(pickBtn, 'dock 应含「选对象」入口');

// classify：命中图片
const hit = A.classify(pics[2]);
assert.ok(hit && hit.kind === 'image', 'classify 应命中图片，实为 ' + (hit && hit.kind));

// 通过 picker 把绑定的视频换成图片（触发 attach→detach(video)→重新 mountShell）
sandbox.document.elementFromPoint = () => pics[2];
pickBtn.click();
document.dispatchEvent({ type: 'mousemove', clientX: 100, clientY: 100 });
document.dispatchEvent({ type: 'click', clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} });
await new Promise((r) => setTimeout(r, 5));
assert.ok(st.binding && st.binding.kind === 'image', '手动选择后应绑定图片，实为 ' + (st.binding && st.binding.kind));
assert.equal(st.annotate, true, '选中图片后应自动进入标注模式');
assert.equal(st.picking, false, '选取后应退出 picker 模式');

// dock / overlay 在重绑后必须仍在（回归：detach 未重置 shellMounted → 壳丢失）
const dockAfter = uiRoot.children.find((n) => n.className === 'va-dock');
assert.ok(dockAfter, '重绑后 dock 应仍在');
const overlayAfter = uiRoot.children.find((n) => n.children && n.children.some((c) => c.className === 'va-capture'));
assert.ok(overlayAfter, '重绑后 overlay（含 va-capture）应仍在（detach 未重置 shellMounted？）');

// 再选另一张图（模拟「重绑」）：绑定切换后壳与 capture 仍应存在
sandbox.document.elementFromPoint = () => pics[4];
pickBtn.click();
document.dispatchEvent({ type: 'mousemove', clientX: 100, clientY: 100 });
document.dispatchEvent({ type: 'click', clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {} });
await new Promise((r) => setTimeout(r, 5));
const overlayAfter2 = uiRoot.children.find((n) => n.children && n.children.some((c) => c.className === 'va-capture'));
assert.ok(overlayAfter2, '重绑后 overlay（含 va-capture）仍应存在（detach 未重置 shellMounted？）');

console.log('smoke-picker OK · 瀑布流不自动绑定 → 手动选中 → kind=%s · annotate=%s', st.binding.kind, st.annotate);
