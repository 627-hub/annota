// node dev/smoke-image.mjs —— 图片媒态冒烟：验证 ImageBinding 走通「拖框→绑词→保存」
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
    dispatchEvent(ev) {
      ev.target ||= n; ev.currentTarget = n;
      ev.stopPropagation ||= () => {}; ev.preventDefault ||= () => {};
      for (const fn of listeners[ev.type] || []) fn(ev);
      return true;
    },
    setPointerCapture() {},
    querySelectorAll: () => [], querySelector: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }),
    focus() {}, click() { if (typeof n.onclick === 'function') n.onclick({ target: n, currentTarget: n, stopPropagation() {}, preventDefault() {} }); },
  };
  return n;
}

const img = Object.assign(makeNode('img'), {
  complete: true, naturalWidth: 2400, naturalHeight: 1600,
  currentSrc: 'https://example.com/photo.jpg', src: 'https://example.com/photo.jpg',
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 900, height: 600, left: 0, top: 0, right: 900, bottom: 600 }),
});

let frames = 0;
const document = {
  body: makeNode('body'),
  fullscreenElement: null,
  createElement: (t) => makeNode(t),
  createElementNS: (_ns, t) => makeNode(t),
  querySelectorAll: (sel) => (String(sel).includes('img') ? [img] : []),
  querySelector: () => null,
  addEventListener() {},
};

const sandbox = {
  console,
  document,
  location: { hostname: 'example.com', pathname: '/photo', search: '', href: 'https://example.com/photo', origin: 'https://example.com' },
  localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
  getComputedStyle: () => ({ objectFit: 'fill', display: 'block', visibility: 'visible', opacity: '1' }),
  innerWidth: 1200, innerHeight: 800,
  setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
  requestAnimationFrame: (cb) => { if (frames < 3) { frames++; setTimeout(() => cb(0), 0); } return frames; },
  cancelAnimationFrame() {},
  Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, Error, Promise, URLSearchParams,
  PointerEvent: class PointerEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'annotate.user.js' });

await new Promise((r) => setTimeout(r, 30));

assert.equal(sandbox.window.__VA_LOADED__, true, '__VA_LOADED__');
const host = document.body.children.find((n) => n.id === 'annota-shadow-host');
assert.ok(host && host.shadowRoot, 'Shadow DOM host 缺失');
const uiRoot = host.shadowRoot.children.find((n) => n.className === 'va-ui-root');
assert.ok(uiRoot, 'UI root 缺失');

const st = sandbox.window.__VA.state;
assert.equal(st.binding && st.binding.kind, 'image', '应绑定为图片媒态，实为 ' + (st.binding && st.binding.kind));
assert.equal(st.binding.timed, false, '图片媒态 timed 应为 false');

const dock = uiRoot.children.find((n) => n.className === 'va-dock');
const annotateButton = dock.children.find((n) => n.attributes && n.attributes['aria-label'] === '标注');
const overlay = uiRoot.children.find((n) => n.children.some((c) => c.className === 'va-capture'));
const capture = overlay.children.find((n) => n.className === 'va-capture');
annotateButton.click();
capture.dispatchEvent(new sandbox.PointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 200 }));
capture.dispatchEvent(new sandbox.PointerEvent('pointermove', { pointerId: 1, clientX: 280, clientY: 340 }));
capture.dispatchEvent(new sandbox.PointerEvent('pointerup', { pointerId: 1, clientX: 280, clientY: 340 }));
const editor = uiRoot.children.find((n) => n.className === 'va-popover' && n.attributes['aria-label'] === '新建标注');
assert.ok(editor, '拖框后没有打开 EditorCard');
const wordInput = editor.children.find((n) => n.attributes && n.attributes['aria-label'] === '标题或词语（选填）');
wordInput.value = 'bicycle';
const actions = editor.children.find((n) => n.className === 'va-pop-actions');
actions.children.find((n) => n.className.includes('va-btn-primary')).click();
assert.equal(st.entries.length, 1, '图片标注保存失败');
assert.equal(st.entries[0].word, 'bicycle');
assert.ok(!('t' in st.entries[0]), '图片标注不应带时间字段 t');
assert.ok(st.entries[0].box, '图片标注应有 box');

// media.type 应为 image
const meta = st.binding.mediaMeta();
assert.equal(meta.type, 'image', 'mediaMeta.type 应为 image');
assert.ok(meta.intrinsic && meta.intrinsic.w === 2400, 'mediaMeta.intrinsic 缺失');

// 画廊切换：换 src → mediaId 变 → 标注按新图 reload（旧图条目不应串到新图）
const firstId = sandbox.window.VAAdapter.mediaId();
assert.ok(firstId.startsWith('img-'), '图片 mediaId 应为 img- 前缀: ' + firstId);
img.currentSrc = 'https://example.com/photo-2.jpg';
img.src = 'https://example.com/photo-2.jpg';
const secondId = sandbox.window.VAAdapter.mediaId();
assert.notEqual(secondId, firstId, '换图后 mediaId 应变化');
assert.ok(secondId.startsWith('img-'), '换图后仍应是图片 id');

console.log('smoke-image OK · kind=%s · entries=%d · mediaId=%s · gallery %s→%s',
  st.binding.kind, st.entries.length, firstId, firstId, secondId);
