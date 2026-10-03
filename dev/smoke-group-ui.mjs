// node dev/smoke-group-ui.mjs — injected group menu + workspace screen guard
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.join(here, '..', 'dist', 'annotate.user.js'), 'utf8');
const page = fs.readFileSync(path.join(here, '..', 'app', 'service', 'index.html'), 'utf8');
function makeNode(tag) {
  const listeners = {};
  const n = {
    tagName: (tag || 'div').toUpperCase(), style: {}, textContent: '', value: '', children: [], parentElement: null,
    className: '', isConnected: true, dataset: {}, attributes: {}, innerHTML: '',
    classList: {
      contains(c) { return n.className.split(/\s+/).includes(c); },
      add(c) { if (!this.contains(c)) n.className = (n.className + ' ' + c).trim(); },
      remove(c) { n.className = n.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      toggle(c, force) { const on = force == null ? !this.contains(c) : !!force; on ? this.add(c) : this.remove(c); return on; },
    },
    appendChild(c) { if (typeof c === 'string' || typeof c === 'number') c = { textContent: String(c), parentElement: null }; c.parentElement = n; n.children.push(c); return c; },
    append(...cs) { cs.forEach((c) => n.appendChild(c)); }, attachShadow() { n.shadowRoot = makeNode('shadow-root'); return n.shadowRoot; },
    setAttribute(k, v) { n.attributes[k] = String(v); }, getAttribute(k) { return n.attributes[k] || null; },
    contains(c) { while (c) { if (c === n) return true; c = c.parentElement; } return false; }, remove() { n.parentElement = null; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, removeEventListener() {}, dispatchEvent(ev) { ev.target ||= n; (listeners[ev.type] || []).forEach((fn) => fn(ev)); },
    setPointerCapture() {}, querySelectorAll: () => [], querySelector: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }),
    focus() {}, click() { if (typeof n.onclick === 'function') n.onclick({ target: n, currentTarget: n, stopPropagation() {}, preventDefault() {} }); },
  };
  return n;
}
const video = Object.assign(makeNode('video'), { videoWidth: 640, videoHeight: 360, readyState: 4, currentTime: 0, pause() {}, play() { return Promise.resolve(); }, getBoundingClientRect: () => ({ x: 0, y: 0, width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 }) });
const document = { body: makeNode('body'), fullscreenElement: null, createElement: (tag) => makeNode(tag), createElementNS: (_ns, tag) => makeNode(tag), querySelectorAll: (selector) => String(selector).includes('video') ? [video] : [], querySelector: () => null, addEventListener() {} };
const store = {};
const sandbox = {
  console, document, location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', search: '', href: 'https://www.bilibili.com/video/BV1xx411c7mD', origin: 'https://www.bilibili.com' },
  localStorage: { getItem(k) { return store[k] || null; }, setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
  getComputedStyle: () => ({ objectFit: 'contain', display: 'block', visibility: 'visible', opacity: '1' }), innerWidth: 1200, innerHeight: 800,
  setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, Error, Promise, URLSearchParams, btoa, atob, TextEncoder, TextDecoder,
  crypto: globalThis.crypto || { getRandomValues: (a) => { a.fill(7); return a; } }, PointerEvent: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
store['annota:groups'] = JSON.stringify([{ gid: 'seed', name: '冒烟测试组', host: 'github', repo: 'owner/repo', branch: 'main', role: 'member', token: 'test-token' }]);
store['va:group:seed:bilibili:BV1xx411c7mD'] = JSON.stringify({ entries: [] });
vm.createContext(sandbox);
vm.runInContext(bundle, sandbox, { filename: 'annotate.user.js' });
await new Promise((resolve) => setTimeout(resolve, 20));
const host = document.body.children.find((node) => node.id === 'annota-shadow-host');
assert.ok(host && host.shadowRoot, 'overlay Shadow DOM should mount');
const root = host.shadowRoot.children.find((node) => node.className === 'va-ui-root');
const dock = root.children.find((node) => node.className === 'va-dock');
const more = dock.children.find((node) => node.attributes && node.attributes['aria-label'] === '更多');
assert.ok(more, 'dock more menu button exists');
more.click();
const descendants = [];
function walk(node) { (node.children || []).forEach((child) => { descendants.push(child); walk(child); }); }
walk(root);
const section = descendants.find((node) => node.attributes && /组/.test(node.attributes['aria-label'] || ''));
assert.ok(section, 'injected group menu has an aria-label containing 组');
assert.ok(descendants.some((node) => node.attributes && node.attributes['aria-label'] === '加入组邀请链接'), 'dock join invite input exists');
assert.ok(descendants.some((node) => node.textContent === '冒烟测试组 · 组成员'), 'seeded local group is rendered in menu');
assert.match(page, /id="screen-groups"/, 'workspace groups screen is present');
assert.match(page, /id="group-list"/, 'workspace local group list is present');
assert.match(bundle, /组管理菜单/, 'built bundle contains group menu');
console.log('smoke-group-ui OK · group menu/input/list + workspace screen');
