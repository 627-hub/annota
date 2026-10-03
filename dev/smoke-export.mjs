// node dev/smoke-export.mjs — export driver smoke test with the demo video and a local HTTP contract stub.
// Limitation: this uses the repository's minimal VM DOM (not a real browser/player), so it verifies
// isolated rendering, chrome hiding, sequencing and the card/finalize HTTP contract, not pixels/codecs.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = fs.readFileSync(path.join(here, 'demo.html'), 'utf8');
assert.match(demo, /<video[^>]+src="sample\.mp4"/, 'dev/demo.html should provide the demo video');
const code = fs.readFileSync(path.join(here, '..', 'dist', 'annotate.user.js'), 'utf8');
const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/api/export/finalize') res.end(JSON.stringify({ ok: true, path: '/tmp/test.apkg', url: '/exports/test.apkg', cards: 3, media: 0 }));
    else res.end(JSON.stringify({ ok: true, has_shot: false, done: requests.filter((r) => r.url === '/api/export/card').length }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

function makeNode(tag) {
  const listeners = {};
  let ownText = '';
  const n = {
    tagName: (tag || 'div').toUpperCase(), style: {}, value: '', children: [], parentElement: null,
    className: '', isConnected: true, dataset: {}, attributes: {}, innerHTML: '',
    get textContent() { return ownText + n.children.map((c) => typeof c === 'string' ? c : (c.textContent || '')).join(''); },
    set textContent(value) { ownText = String(value == null ? '' : value); n.children = []; },
    classList: {
      contains(c) { return n.className.split(/\s+/).includes(c); },
      add(c) { if (!this.contains(c)) n.className = (n.className + ' ' + c).trim(); },
      remove(c) { n.className = n.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      toggle(c, force) { const on = force == null ? !this.contains(c) : !!force; on ? this.add(c) : this.remove(c); return on; },
    },
    appendChild(child) { if (typeof child === 'string' || typeof child === 'number') child = makeText(String(child)); child.parentElement = n; n.children.push(child); return child; },
    append(...children) { for (const child of children) n.appendChild(child); },
    attachShadow() { n.shadowRoot = makeNode('shadow-root'); n.shadowRoot.host = n; return n.shadowRoot; },
    setAttribute(k, v) { n.attributes[k] = String(v); }, getAttribute(k) { return n.attributes[k] || null; },
    contains(child) { while (child) { if (child === n) return true; child = child.parentElement; } return false; },
    remove() { if (n.parentElement) n.parentElement.children = n.parentElement.children.filter((child) => child !== n); n.parentElement = null; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((item) => item !== fn); },
    dispatchEvent(event) { event.target ||= n; event.currentTarget = n; for (const fn of listeners[event.type] || []) fn(event); return true; },
    setPointerCapture() {}, querySelectorAll(selector) { return queryAll(n, selector); }, querySelector(selector) { return queryAll(n, selector)[0] || null; },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }),
    focus() {}, click() { if (typeof n.onclick === 'function') n.onclick({ target: n, currentTarget: n, stopPropagation() {}, preventDefault() {} }); },
  };
  return n;
}
function makeText(text) { const node = makeNode('#text'); node.textContent = text; return node; }
function queryAll(root, selector) {
  const className = selector.startsWith('.') ? selector.slice(1) : '';
  const found = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (className && child.className && child.className.split(/\s+/).includes(className)) found.push(child);
      walk(child);
    }
  };
  walk(root); return found;
}

const listenersVideo = {};
let currentTime = 3.2;
const video = Object.assign(makeNode('video'), {
  videoWidth: 640, videoHeight: 360, readyState: 4, duration: 10,
  get currentTime() { return currentTime; },
  set currentTime(value) { currentTime = Number(value); setTimeout(() => { for (const fn of (listenersVideo.seeked || []).slice()) fn({ type: 'seeked' }); listenersVideo.seeked = []; }, 5); },
  addEventListener(type, fn) { (listenersVideo[type] ||= []).push(fn); },
  removeEventListener(type, fn) { listenersVideo[type] = (listenersVideo[type] || []).filter((item) => item !== fn); },
  requestVideoFrameCallback(cb) { return setTimeout(() => cb(Date.now(), { mediaTime: currentTime + 0.001 }), 1); },
  cancelVideoFrameCallback(id) { clearTimeout(id); }, pause() {}, play() { return Promise.resolve(); },
  // 与真实状态一致：seek 后 currentTime 立即生效，rVFC 的 mediaTime 才会 >= t
  get _t() { return currentTime; },
  getBoundingClientRect: () => ({ x: 40, y: 40, left: 40, top: 40, right: 680, bottom: 400, width: 640, height: 360 }),
});
const document = {
  body: makeNode('body'), head: makeNode('head'), documentElement: makeNode('html'), fullscreenElement: null, title: 'Export demo',
  createElement: (tag) => makeNode(tag), createElementNS: (_ns, tag) => makeNode(tag),
  querySelectorAll: (selector) => String(selector).includes('video') ? [video] : [], querySelector: () => null,
  addEventListener() {},
};
document.body.appendChild(video);
let scheduledFrames = 0;
const sandbox = {
  console, document,
  location: { hostname: '127.0.0.1', pathname: '/dev/demo.html', search: '', hash: '', href: 'http://127.0.0.1/dev/demo.html', origin: 'http://127.0.0.1' },
  history: { replaceState() {} },
  localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
  getComputedStyle: () => ({ objectFit: 'contain', display: 'block', visibility: 'visible', opacity: '1' }),
  innerWidth: 800, innerHeight: 600,
  setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
  requestAnimationFrame: (cb) => { if (scheduledFrames < 6) { scheduledFrames++; setTimeout(() => cb(Date.now()), 0); } return scheduledFrames; },
  cancelAnimationFrame() {}, fetch, URL, Blob, TextEncoder, TextDecoder, btoa, atob,
  // 最小 Image：onload 立即触发，供 canvasOverlay 叠框（无真实像素，只走通合约）
  Image: class Image { constructor() { this.width = 1; this.height = 1; } set src(v) { this._src = v; setTimeout(() => { if (this.onload) this.onload(); }, 0); } get src() { return this._src; } },
  Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, Error, Promise, Uint8Array, URLSearchParams,
  PointerEvent: class PointerEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
sandbox.localStorage.setItem('va:syncUrl', base);
sandbox.vaCapture = async () => {
  const host = document.body.children.find((node) => node.id === 'annota-shadow-host');
  const root = host && host.shadowRoot && host.shadowRoot.children.find((node) => node.className === 'va-ui-root');
  const marks = root ? queryAll(root, '.va-mark') : [];
  const label = marks[0] && queryAll(marks[0], '.va-mark-label')[0];
  assert.equal(marks.length, 1, 'isolated frame should render only the requested annotation');
  assert.equal(label && label.textContent, 'one explanation', 'isolated label should include this annotation text');
  assert.equal(root.dataset.uiHidden, '1', 'chrome should be hidden during capture');
  // 返回 1×1 PNG data URL：Tauri 分支现在会按 videoRect 裁剪（cropDataUrl），走真实路径
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
};

try {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'annotate.user.js' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const state = sandbox.__VA.state;
  assert.equal(state.binding.kind, 'video', 'demo video should be attached');
  const firstId = String(state.mediaId || 'demo-media');
  state.entries = [
    { id: 'export-one', word: 'one', label: 'explanation', t: 1, dur: 1, box: { x: .1, y: .1, w: .2, h: .2 } },
    { id: 'export-two', word: 'two', label: 'meaning', t: 2, dur: 1, box: { x: .3, y: .2, w: .2, h: .2 } },
    { id: 'export-three', word: 'three', label: 'sense', t: 3, dur: 1, box: { x: .5, y: .3, w: .2, h: .2 } },
  ];
  // Stop additional simulated core-loop frames; the export driver's own rAF waits remain active.
  sandbox.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  const result = await sandbox.__ANNOTA_EXPORT__.start({ format: 'apkg', deckName: 'Demo deck', settle: 0, onlyMissing: false });
  assert.equal(result.total, 3);
  const deadline = Date.now() + 8000;
  while (!['complete', 'error'].includes(sandbox.__ANNOTA_EXPORT__.status().state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(sandbox.__ANNOTA_EXPORT__.status().state, 'complete', 'export should complete: ' + JSON.stringify(sandbox.__ANNOTA_EXPORT__.status()));
  const cards = requests.filter((request) => request.method === 'POST' && request.url === '/api/export/card');
  const finalize = requests.filter((request) => request.method === 'POST' && request.url === '/api/export/finalize');
  assert.equal(cards.length, 3, 'one card POST per annotation');
  assert.equal(finalize.length, 1, 'one finalize request');
  assert.ok(cards.every((request) => request.body.screenshot === null), 'unavailable screenshots should be sent as null');
  assert.ok(cards.every((request) => request.body.deck_id && Number.isInteger(request.body.idx)));
  assert.ok(sandbox.localStorage.getItem('va:export:' + firstId), 'completed ids should be persisted for resume');
  const host = document.body.children.find((node) => node.id === 'annota-shadow-host');
  const root = host.shadowRoot.children.find((node) => node.className === 'va-ui-root');
  const css = host.shadowRoot.children.find((node) => node.tagName === 'STYLE').textContent;
  assert.equal(root.dataset.uiHidden, '', 'chrome should be restored after export');
  assert.match(css, /data-ui-hidden="1"\] \.va-dock/);
  assert.match(css, /data-ui-hidden="1"\] \.va-panel/);
  console.log('smoke-export OK · cards=%d · finalize=%d · state=%s', cards.length, finalize.length, sandbox.__ANNOTA_EXPORT__.status().state);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
