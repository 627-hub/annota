/* dev/toolbar-browser.mjs — M6c/M6d/M7 工具栏验证（无头）
 * 用 mock Tauri 桥载入 app/annota/public/index.html，验证：
 *   1. omnibox 智能搜索：输入 → 建议下拉（收藏/历史/搜索行）→ 键盘导航
 *   2. 书签栏：切换展开 → 渲染收藏项 → 点击跳转
 *   3. 查找条：打开/关闭，输入触发 find_in_page
 *   4. 缩放：±/重置按钮 → set_zoom，localStorage 持久化
 *   5. 开发者工具菜单项存在
 *   6. 工具栏高度上报（书签栏展开时高度变化）
 * 不需要真实 Tauri 运行时。
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`# PASS ${label}`); }
  else { fail++; failures.push(label + (extra ? ` — ${extra}` : '')); console.log(`# FAIL ${label}${extra ? ' — ' + extra : ''}`); }
}

// ---------- mock 数据 ----------
const MOCK = {
  bookmarks: [
    { url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: 'BBC 纪录片 BBC', favicon: null },
    { url: 'https://docs.example.com/annota', title: 'Annota 文档', favicon: null },
  ],
  history: [
    { url: 'https://www.bilibili.com/video/BV1yy', title: 'BBC 纪录片 第二集', visit_at: Date.now() - 3600_000 },
    { url: 'https://news.ycombinator.com/', title: 'Hacker News', visit_at: Date.now() - 7200_000 },
  ],
  omnibox: {
    'bilibili': {
      history: [{ url: 'https://www.bilibili.com/video/BV1yy', title: 'BBC 纪录片 第二集', visit_at: Date.now() }],
      bookmarks: [{ url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: 'BBC 纪录片 BBC', favicon: null }],
    },
  },
};

// ---------- mock 桥 ----------
const mockBridge = `
(function () {
  const calls = { invoke: [], fetch: [] };
  window.__MOCK_CALLS__ = calls;
  const listeners = {};
  window.__TAURI_INTERNALS__ = {
    invoke(cmd, args) {
      calls.invoke.push({ cmd, args });
      switch (cmd) {
        case 'navigate_browser': return Promise.resolve();
        case 'browser_action': return Promise.resolve();
        case 'set_shell_mode': return Promise.resolve();
        case 'set_toolbar_expanded': return Promise.resolve();
        case 'set_toolbar_height': return Promise.resolve();
        case 'find_in_page': return Promise.resolve();
        case 'set_zoom': return Promise.resolve();
        case 'tab_new': case 'tab_activate': case 'tab_close': case 'tab_move': return Promise.resolve();
        case 'open_devtools': return Promise.resolve();
        case 'tab_session_clear': return Promise.resolve();
        case 'install_update': return Promise.resolve();
        default: return Promise.resolve();
      }
    },
    transformCallback(cb) { return cb; },
    convertFileSrc(p) { return p; },
  };
  window.__TAURI__ = {
    event: {
      emit(n, p) { (listeners[n] || []).forEach((f) => f({ payload: p })); },
      listen(n, f) { (listeners[n] = listeners[n] || []).push(f); return Promise.resolve(() => {}); },
    },
    invoke: window.__TAURI_INTERNALS__.invoke,
  };
  // vaFetch mock：直接命中本地 mock
  window.vaFetch = function (method, url, body) {
    calls.fetch.push({ method, url, body });
    const MOCK = ${JSON.stringify(MOCK)};
    const j = (o) => Promise.resolve({ ok: true, status: 200, json: o });
    if (url.indexOf('/api/bookmarks') >= 0) {
      if (method === 'GET') return j({ ok: true, bookmarks: MOCK.bookmarks });
      return j({ ok: true, created: true });
    }
    if (url.indexOf('/api/history') >= 0) return j({ ok: true, history: MOCK.history });
    if (url.indexOf('/api/downloads') >= 0) return j({ ok: true, downloads: [] });
    if (url.indexOf('/api/health') >= 0) return j({ ok: true });
    if (url.indexOf('/api/omnibox') >= 0) {
      const q = decodeURIComponent((url.split('q=')[1] || ''));
      return j({ ok: true, result: MOCK.omnibox[q] || { history: [], bookmarks: [] } });
    }
    return j({ ok: true });
  };
  window.__ANNOTA__ = { copyToClipboard: () => Promise.resolve({ ok: true }) };
})();
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// 用 addInitScript 在页面脚本执行前注入 mock 桥，再以 file:// 载入真实 index.html
await page.addInitScript(mockBridge);
const toolbarUrl = 'file://' + resolve(root, 'app/annota/public/index.html');
await page.goto(toolbarUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(400);

// 菜单 display 切换会让 Playwright 的稳定性检测反复失败，这里直接派发点击事件。
async function menuClick(sel) {
  return page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error('no ' + s); el.click(); }, sel);
}

// ---------- 1. omnibox 智能搜索 ----------
await page.fill('#url', 'bilibili');
await page.waitForTimeout(400);
const suggOpen = await page.getAttribute('#omnibox-suggestions', 'data-open');
ok(suggOpen === '1', 'omnibox：输入后建议下拉打开', `data-open=${suggOpen}`);

const osItems = await page.locator('#omnibox-suggestions .os-item').count();
ok(osItems >= 2, 'omnibox：收藏 + 历史建议各出现', `os-item=${osItems}`);

const osSearch = await page.locator('#omnibox-suggestions .os-search').count();
ok(osSearch === 1, 'omnibox：底部有「搜索」回落行', `os-search=${osSearch}`);

// 键盘导航
await page.locator('#url').press('ArrowDown');
await page.waitForTimeout(100);
const activeAfterDown = await page.locator('#omnibox-suggestions [data-active="1"]').count();
ok(activeAfterDown === 1, 'omnibox：↓ 键高亮第一条建议', `active=${activeAfterDown}`);

// 点击搜索行触发 navigate
await page.locator('#omnibox-suggestions .os-search').click();
await page.waitForTimeout(200);
const navCalls = await page.evaluate(() => window.__MOCK_CALLS__.invoke.filter((c) => c.cmd === 'navigate_browser'));
ok(navCalls.some((c) => c.args.url === 'bilibili'), 'omnibox：点搜索行走 navigate_browser', JSON.stringify(navCalls));

// ---------- 2. 书签栏 ----------
// 先确保收起
let bmOpen = await page.getAttribute('#bookmark-bar', 'data-open');
if (bmOpen === '1') { await page.click('#btn-bookmark-bar'); await page.waitForTimeout(200); }
await page.click('#btn-bookmark-bar');
await page.waitForTimeout(400);
bmOpen = await page.getAttribute('#bookmark-bar', 'data-open');
ok(bmOpen === '1', '书签栏：点击切换为展开', `data-open=${bmOpen}`);

const bmItems = await page.locator('.bookmark-item').count();
ok(bmItems === 2, '书签栏：渲染 2 个收藏项', `items=${bmItems}`);

// 点击书签项跳转
await page.locator('.bookmark-item').first().click();
await page.waitForTimeout(200);
const bmNav = await page.evaluate(() => window.__MOCK_CALLS__.invoke.filter((c) => c.cmd === 'navigate_browser'));
ok(bmNav.some((c) => (c.args.url || '').includes('bilibili')), '书签栏：点击收藏项触发 navigate', JSON.stringify(bmNav.slice(-2)));

// ---------- 6. 工具栏高度上报（书签栏展开） ----------
await page.waitForTimeout(300);
const heightCalls = await page.evaluate(() => window.__MOCK_CALLS__.invoke.filter((c) => c.cmd === 'set_toolbar_height'));
const lastH = heightCalls.length ? heightCalls[heightCalls.length - 1].args.height : 0;
ok(heightCalls.length > 0, '工具栏：已上报高度 set_toolbar_height', `calls=${heightCalls.length}`);
ok(lastH > 100, '工具栏：书签栏展开后高度 > 100', `h=${lastH}`);

// 收起后高度回落
await page.click('#btn-bookmark-bar');
await page.waitForTimeout(300);
const heightCalls2 = await page.evaluate(() => window.__MOCK_CALLS__.invoke.filter((c) => c.cmd === 'set_toolbar_height'));
const lastH2 = heightCalls2[heightCalls2.length - 1].args.height;
ok(lastH2 < lastH, '工具栏：书签栏收起后高度回落', `before=${lastH} after=${lastH2}`);

// ---------- 3. 查找条 ----------
await page.click('#btn-find');
await page.waitForTimeout(200);
let findOpen = await page.getAttribute('#find-bar', 'data-open');
ok(findOpen === '1', '查找条：点击打开', `data-open=${findOpen}`);
await page.fill('#find-input', 'hello');
await page.locator('#find-next').click();
await page.waitForTimeout(200);
const findCalls = await page.evaluate(() => window.__MOCK_CALLS__.invoke.filter((c) => c.cmd === 'find_in_page'));
ok(findCalls.some((c) => c.args.text === 'hello'), '查找条：next 触发 find_in_page(text)', JSON.stringify(findCalls.slice(-1)));
await page.click('#find-close');
await page.waitForTimeout(200);
findOpen = await page.getAttribute('#find-bar', 'data-open');
ok(findOpen === '0', '查找条：关闭', `data-open=${findOpen}`);

// ---------- 4/5. 菜单与面板已搬进 overlay.html ----------
// 工具栏只负责调 overlay_open；菜单/面板的渲染与交互由 dev/overlay-check.mjs 覆盖。
ok((await page.locator('#menu').count()) === 0, '工具栏：不再持有菜单 DOM（已搬 overlay）');
ok((await page.locator('#chrome-panel').count()) === 0, '工具栏：不再持有面板 DOM（已搬 overlay）');
await menuClick('#btn-menu');
await page.waitForTimeout(200);
const ovCalls = await page.evaluate(() => window.__MOCK_CALLS__.invoke.filter((c) => c.cmd === 'overlay_open'));
ok(ovCalls.length === 1 && ovCalls[0].args.kind === 'menu', '工具栏：点「更多」调 overlay_open(menu)', JSON.stringify(ovCalls));
ok((await page.locator('#menu').count()) === 0, '工具栏：打开浮层后工具栏仍无菜单 DOM（浮层是独立 webview）');

// ---------- 无 JS 报错 ----------
ok(errors.length === 0, '无 JS 报错', errors.slice(0, 3).join(' | '));

await page.screenshot({ path: resolve(root, 'docs/assets/annota-browser-m7-toolbar.png') });
await browser.close();

console.log(`\n# RESULT ${fail === 0 ? 'PASS' : 'FAIL'} (${pass}/${pass + fail})`);
if (failures.length) { console.log('# 失败项:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);