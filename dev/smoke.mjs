// node dev/smoke.mjs —— 用最小假 DOM 跑一遍 dist/annotate.user.js，抓运行时错误
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
  createElementNS: (_ns, t) => makeNode(t),
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
  PointerEvent: class PointerEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
sandbox.localStorage.setItem('va:entries:bilibili:BV1xx411c7mD', JSON.stringify({
  entries: [{ id: 'smoke-entry', t: 3, dur: 1, box: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, word: 'smoke', label: '冒烟标注' }],
}));

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'annotate.user.js' });

await new Promise((r) => setTimeout(r, 30));

assert.equal(sandbox.window.__VA_LOADED__, true, '__VA_LOADED__');
assert.ok(sandbox.window.VAGeo, 'VAGeo 未挂载');
assert.ok(sandbox.window.VAAdapter, 'VAAdapter 未挂载');
const host = document.body.children.find((n) => n.id === 'annota-shadow-host');
assert.ok(host, 'Annota Shadow DOM host 未挂到 body');
assert.ok(host.shadowRoot, 'Annota UI 未使用 Shadow DOM');
const uiRoot = host.shadowRoot.children.find((n) => n.className === 'va-ui-root');
assert.ok(uiRoot, 'Annota UI root 未创建');
assert.ok(uiRoot.children.some((n) => n.className === 'va-dock'), 'GlassDock 未创建');
assert.equal(stEntries().length, 1, '测试标注未加载');
const dock = uiRoot.children.find((n) => n.className === 'va-dock');
const annotateButton = dock.children.find((n) => n.attributes && n.attributes['aria-label'] === '标注');
const overlay = uiRoot.children.find((n) => n.children.some((c) => c.className === 'va-capture'));
const capture = overlay.children.find((n) => n.className === 'va-capture');
assert.ok(annotateButton && capture, '标注入口或画面捕获层未创建');
annotateButton.click();
capture.dispatchEvent(new sandbox.PointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 200 }));
capture.dispatchEvent(new sandbox.PointerEvent('pointermove', { pointerId: 1, clientX: 180, clientY: 280 }));
capture.dispatchEvent(new sandbox.PointerEvent('pointerup', { pointerId: 1, clientX: 180, clientY: 280 }));
const editor = uiRoot.children.find((n) => n.className === 'va-popover' && n.attributes['aria-label'] === '新建标注');
assert.ok(editor, '拖框后没有打开 EditorCard');
const wordInput = editor.children.find((n) => n.attributes && n.attributes['aria-label'] === '词语（必填）');
assert.ok(wordInput, 'EditorCard 缺少词语输入');
wordInput.value = 'tractor';
const actions = editor.children.find((n) => n.className === 'va-pop-actions');
const saveButton = actions.children.find((n) => n.className.includes('va-btn-primary'));
assert.ok(saveButton, 'EditorCard 保存按钮缺失');
saveButton.click();
assert.equal(stEntries().length, 2, 'EditorCard 保存后标注数量错误');
assert.equal(stEntries()[1].word, 'tractor', 'EditorCard 没有保存词语');
const listButton = dock.children.find((n) => n.attributes && n.attributes['aria-label'] === '列表');
assert.ok(listButton, '标注列表入口未创建');
listButton.click();
const panel = uiRoot.children.find((n) => n.className.split(/\s+/).includes('va-panel'));
const entriesPanel = panel.children.find((n) => n.className === 'va-entry-list');
assert.ok(entriesPanel && entriesPanel.children.some((n) => n.className === 'va-entry-row'), 'SidePanel 未渲染标注条目');
assert.ok(sandbox.window.VAAdapter.mediaId() === 'bilibili:BV1xx411c7mD', 'mediaId 解析错误: ' + sandbox.window.VAAdapter.mediaId());

const st = sandbox.window.__VA.state;
assert.ok(st.cr, 'cr 未计算');
for (const k of ['x', 'y', 'w', 'h']) {
  assert.ok(Number.isFinite(st.cr[k]), `content.${k} 为 NaN（DOMRect 字段不匹配？）: ` + JSON.stringify(st.cr));
}
assert.ok(Number.isFinite(st.rect.width) && Number.isFinite(st.rect.height), 'rect 字段异常');

console.log('smoke OK · frames=%d · body children=%d · mediaId=%s',
  frames, document.body.children.length, sandbox.window.VAAdapter.mediaId());

function stEntries() { return sandbox.window.__VA.state.entries; }
