// node dev/smoke-article.mjs —— 文章划词媒态冒烟：验证 ArticleBinding + quote 条目
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

// 正文容器（有足够文本触发 findArticle）
const article = makeNode('article');
article.textContent = ('In 1684 the tea was planted on the hills of this quiet district near the old road. ' +
  'Later, the monsoon arrived late and the tea was scarce for a whole season, so the farmers waited. ').repeat(6);
article.isConnected = true;

// 文档内嵌的示意图（占屏比例小）——不应劫持整页为图片媒态
const inlineImg = Object.assign(makeNode('img'), {
  complete: true, naturalWidth: 1824, naturalHeight: 1488,
  currentSrc: 'https://example.com/docs/screenshot.webp', src: 'https://example.com/docs/screenshot.webp',
  // 渲染尺寸小：~560×450，占 1200×800 视口约 26% → 非主导
  getBoundingClientRect: () => ({ x: 300, y: 300, width: 560, height: 450, left: 300, top: 300, right: 860, bottom: 750 }),
});

let frames = 0;
const document = {
  body: makeNode('body'),
  fullscreenElement: null,
  createElement: (t) => makeNode(t),
  createElementNS: (_ns, t) => makeNode(t),
  querySelectorAll: (sel) => {
    const s = String(sel);
    if (s.includes('article')) return [article];
    if (s.includes('img')) return [inlineImg];
    return [];
  },
  querySelector: () => null,
  _listeners: {},
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
  dispatchEvent(ev) { for (const fn of (this._listeners[ev.type] || [])) fn(ev); return true; },
};

// 假 Range：serialize 需要 cloneRange / toString / startContainer 等
const fakeRange = {
  collapsed: false,
  toString: () => 'the tea was',
  cloneRange() { return { selectNodeContents() {}, setEnd() {}, setStart() {}, toString: () => '' }; },
  startContainer: {}, endContainer: {}, startOffset: 0, endOffset: 0,
  getBoundingClientRect: () => ({ x: 100, y: 200, width: 80, height: 16, left: 100, top: 200, right: 180, bottom: 216 }),
  getClientRects: () => [],
};

const sandbox = {
  console,
  document,
  location: { hostname: 'example.com', pathname: '/story', search: '', href: 'https://example.com/story', origin: 'https://example.com' },
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
sandbox.getSelection = () => ({ isCollapsed: false, rangeCount: 1, getRangeAt: () => fakeRange, removeAllRanges() {} });
sandbox.window.getSelection = sandbox.getSelection;

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'annotate.user.js' });

await new Promise((r) => setTimeout(r, 30));

const st = sandbox.window.__VA.state;
assert.equal(st.binding && st.binding.kind, 'article', '应绑定为文章媒态，实为 ' + (st.binding && st.binding.kind));
assert.equal(st.binding.timed, false, '文章媒态 timed 应为 false');
assert.equal(st.binding.capture, 'quote', '文章媒态 capture 应为 quote');

// 直接走 serializeSelection + askWord 路径：模拟划词
const quote = st.binding.serializeSelection();
assert.ok(quote && quote.exact === 'the tea was', 'serializeSelection 应产出 exact');

// 用 UI 的内部 API 打开编辑卡并保存
sandbox.window.__ANNOTA_UI__.startAnnotating();
const uiHost = document.body.children.find((n) => n.id === 'annota-shadow-host');
const uiRoot = uiHost.shadowRoot.children.find((n) => n.className === 'va-ui-root');
// 触发文章划词提交
document.dispatchEvent({ type: 'mouseup' });
await new Promise((r) => setTimeout(r, 5));
const editor = uiRoot.children.find((n) => n.className === 'va-popover' && n.attributes['aria-label'] === '新建标注');
assert.ok(editor, '划词后应打开编辑卡');
const wordInput = editor.children.find((n) => n.attributes && n.attributes['aria-label'] === '标题或词语（选填）');
wordInput.value = 'monsoon';
const actions = editor.children.find((n) => n.className === 'va-pop-actions');
actions.children.find((n) => n.className.includes('va-btn-primary')).click();
assert.equal(st.entries.length, 1, '文章标注保存失败');
assert.ok(st.entries[0].quote, '文章标注应带 quote');
assert.equal(st.entries[0].quote.exact, 'the tea was', 'quote.exact 应保存');
assert.ok(!('box' in st.entries[0]), '文章标注不应带 box');
assert.ok(!('t' in st.entries[0]), '文章标注不应带 t');

console.log('smoke-article OK · kind=%s · capture=%s · entries=%d · quote="%s"',
  st.binding.kind, st.binding.capture, st.entries.length, st.entries[0].quote.exact);
