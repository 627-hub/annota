/* dev/overlay-check.mjs — 浮层页面（overlay.html）无头验证
 * 浮层现在是独立 webview，工具栏不再持有菜单/面板 DOM。
 * 这里用 mock 桥载入 overlay.html，验证菜单 / 历史 / 下载三种形态。
 * 注意：不能验证 z 序（那是 macOS 原生行为），只验证页面逻辑与视觉。
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`# PASS ${label}`); }
  else { fail++; failures.push(label + (extra ? ` — ${extra}` : '')); console.log(`# FAIL ${label}${extra ? ' — ' + extra : ''}`); }
};

const MOCK = {
  history: [
    { url: 'https://www.bilibili.com/video/BV1yy', title: 'BBC 纪录片 第二集', visit_at: Date.now() - 3600_000 },
    { url: 'https://news.ycombinator.com/', title: 'Hacker News', visit_at: Date.now() - 7200_000 },
  ],
  downloads: [
    { id: 1, url: 'https://a.com/f.bin', filename: 'f.bin', path: '/Users/x/Downloads/Annota/f.bin', status: 'done', size: 1234567, created_at: Date.now() - 600_000 },
  ],
};

const mockBridge = `
(function () {
  const calls = [];
  window.__MOCK_CALLS__ = calls;
  const MOCK = ${JSON.stringify(MOCK)};
  window.__TAURI_INTERNALS__ = {
    invoke(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === 'tabs_snapshot') return Promise.resolve({ ok: true, tabs: [{ id: 'browser', url: 'https://a.com/', active: true }] });
      return Promise.resolve();
    },
    transformCallback(cb) { return cb; },
    convertFileSrc(p) { return p; },
  };
  window.__TAURI__ = { invoke: window.__TAURI_INTERNALS__.invoke };
  window.vaFetch = function (method, url) {
    const j = (o) => Promise.resolve({ ok: true, status: 200, json: o });
    if (url.indexOf('/api/history') >= 0) return j({ ok: true, history: MOCK.history });
    if (url.indexOf('/api/downloads') >= 0) return j({ ok: true, downloads: MOCK.downloads });
    return j({ ok: true });
  };
  window.__ANNOTA__ = { copyToClipboard: () => Promise.resolve({ ok: true }) };
})();
`;

async function loadKind(kind, viewport) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(mockBridge);
  await page.addInitScript(`window.__VA_OVERLAY_KIND__ = ${JSON.stringify(kind)};`);
  await page.goto('file://' + resolve(root, 'app/annota/public/overlay.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  return { browser, page, errors };
}

// ---------- 菜单形态 ----------
{
  const { browser, page, errors } = await loadKind('menu', { width: 240, height: 380 });
  ok((await page.getAttribute('#menu', 'data-open')) === '1', '菜单形态：data-open=1');
const cmds = await page.locator('#menu [data-cmd]').count();
ok(cmds === 6, '菜单形态：6 个命令项（历史/下载/不恢复会话/工作区/开发者工具/诊断）', `count=${cmds}`);
  const zoomBtns = await page.locator('#menu [data-zoom]').count();
  ok(zoomBtns === 3, '菜单形态：3 个缩放按钮', `count=${zoomBtns}`);
  // 缩放生效 + 菜单不关
  await page.locator('[data-zoom="in"]').evaluate((el) => el.click());
  await page.locator('[data-zoom="in"]').evaluate((el) => el.click());
  await page.waitForTimeout(200);
  const zc = await page.evaluate(() => window.__MOCK_CALLS__.filter((c) => c.cmd === 'set_zoom'));
  ok(Math.abs(zc[zc.length - 1].args.factor - 1.2) < 0.01, '菜单形态：缩放 1.2', `z=${zc[zc.length - 1].args.factor}`);
  ok((await page.locator('#menu-zoom-label').textContent()).trim() === '120%', '菜单形态：缩放标签 120%');
  ok((await page.getAttribute('#menu', 'data-open')) === '1', '菜单形态：连点缩放后菜单保持打开');
  // 点遮罩关闭
  await page.locator('#backdrop').evaluate((el) => el.click());
  await page.waitForTimeout(200);
  const cc = await page.evaluate(() => window.__MOCK_CALLS__.filter((c) => c.cmd === 'overlay_close'));
  ok(cc.length === 1, '菜单形态：点遮罩触发 overlay_close', `calls=${cc.length}`);
  ok(errors.length === 0, '菜单形态：无 JS 报错', errors.slice(0, 2).join(' | '));
  await page.screenshot({ path: resolve(root, 'docs/assets/annota-overlay-menu.png') });
  await browser.close();
}

// ---------- 历史面板形态 ----------
{
  const { browser, page, errors } = await loadKind('history', { width: 1200, height: 420 });
  ok((await page.getAttribute('#chrome-panel', 'data-open')) === '1', '历史形态：面板打开');
  const items = await page.locator('.chrome-item').count();
  ok(items === 2, '历史形态：2 条记录', `count=${items}`);
  const title = await page.locator('.chrome-panel-title').textContent();
  ok(title.trim() === '历史记录', '历史形态：标题正确', title);
  await page.screenshot({ path: resolve(root, 'docs/assets/annota-overlay-history.png') });
  ok(errors.length === 0, '历史形态：无 JS 报错', errors.slice(0, 2).join(' | '));
  await browser.close();
}

// ---------- 下载面板形态 ----------
{
  const { browser, page, errors } = await loadKind('downloads', { width: 1200, height: 420 });
  ok((await page.getAttribute('#chrome-panel', 'data-open')) === '1', '下载形态：面板打开');
  const items = await page.locator('.chrome-item').count();
  ok(items === 1, '下载形态：1 条记录', `count=${items}`);
  const badge = await page.locator('.chrome-badge').first().textContent();
  ok(badge.trim() === '已完成', '下载形态：状态徽标', badge);
  await page.screenshot({ path: resolve(root, 'docs/assets/annota-overlay-downloads.png') });
  ok(errors.length === 0, '下载形态：无 JS 报错', errors.slice(0, 2).join(' | '));
  await browser.close();
}

// ---------- 工具栏不再持有菜单/面板 DOM ----------
{
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 200 } });
  await page.addInitScript(mockBridge);
  await page.goto('file://' + resolve(root, 'app/annota/public/index.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  ok((await page.locator('#menu').count()) === 0, '工具栏：已无内联菜单 DOM');
  ok((await page.locator('#chrome-panel').count()) === 0, '工具栏：已无内联面板 DOM');
  ok((await page.locator('#btn-menu').count()) === 1, '工具栏：保留「更多」按钮');
  // 点「更多」→ 调 overlay_open('menu')，且不动工具栏高度
  const beforeH = await page.evaluate(() => document.querySelector('.toolbar').offsetHeight);
  await page.locator('#btn-menu').evaluate((el) => el.click());
  await page.waitForTimeout(300);
  const calls = await page.evaluate(() => window.__MOCK_CALLS__);
  const oc = calls.filter((c) => c.cmd === 'overlay_open');
  ok(oc.length === 1 && oc[0].args.kind === 'menu', '工具栏：点「更多」调 overlay_open(menu)');
  ok(!(calls.some((c) => c.cmd === 'set_toolbar_expanded')), '工具栏：不再调 set_toolbar_expanded');
  const afterH = await page.evaluate(() => document.querySelector('.toolbar').offsetHeight);
  ok(beforeH === afterH, '工具栏：高度未被改变', `${beforeH} → ${afterH}`);
  await browser.close();
}

console.log(`\n# RESULT ${fail === 0 ? 'PASS' : 'FAIL'} (${pass}/${pass + fail})`);
if (failures.length) { console.log('# 失败项:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);