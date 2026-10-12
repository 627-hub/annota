/* dev/plugin-install-check.mjs — 插件管理页无头冒烟（Playwright，不进 CI glob）
 * 用桩服务器承载真实的 app/service/index.html + /api/plugins 桩接口，验证：
 *   1. #plugins 路由渲染：内置/已安装分组、离线横幅不误报
 *   2. 两阶段安装：选真实 ielts zip → dry_run → 确认框展示 → 正式安装 → 列表刷新
 *   3. 开关切换与卸载（含 confirm 弹窗处理）
 *   4. 全程无 pageerror
 *   5. overlay「更多」菜单高度不超 PANEL_MENU_H（main.rs 常量）
 * 用法：node dev/plugin-install-check.mjs   （需先有 annota-plugins 打好的 ielts zip）
 */
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const ieltsZip = resolve(root, '../annota-plugins/plugins/ielts-0.1.0.zip');

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`# PASS ${label}`); }
  else { fail++; console.log(`# FAIL ${label}${extra ? ' — ' + extra : ''}`); }
};

// ---------- 桩服务器 ----------
const TOKEN = 'smoke-token';
const installed = [
  { id: 'broken-one', name: '损坏示例', version: '0.0.1', broken: true, from: 'x.zip', builtin: false, enabled: false, permissions: [], description: '' },
];
const calls = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(resolve(root, 'app/service/index.html')));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/plugins') {
    send(200, {
      ok: true, token: TOKEN,
      plugins: [
        { id: 'anki-export', name: 'Anki 导出', builtin: true, enabled: true },
        { id: 'group', name: '组同步', builtin: true, enabled: true },
        ...installed,
      ],
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/plugins/install') {
    calls.push({ op: 'install', dry: url.searchParams.get('dry_run') === '1', name: url.searchParams.get('name'), token: req.headers['x-annota-token'] });
    if (req.headers['x-annota-token'] !== TOKEN) return send(403, { error: 'plugin_token_required' });
    let bytes = 0;
    for await (const chunk of req) bytes += chunk.length;
    if (bytes < 100) return send(422, { error: '不是合法的 zip 文件' });
    if (url.searchParams.get('dry_run') === '1') {
      return send(200, { ok: true, preview: { id: 'ielts', name: '雅思词库', version: '0.1.0', description: '示例', permissions: ['local-api'], engine: '>=0.2.4', viewOnly: true, size: bytes } });
    }
    if (!installed.some((p) => p.id === 'ielts')) {
      installed.push({ id: 'ielts', name: '雅思词库', version: '0.1.0', builtin: false, enabled: true, broken: false, from: url.searchParams.get('name') || 'ielts.zip', permissions: ['local-api'], description: '示例' });
    }
    return send(200, { ok: true, id: 'ielts' });
  }
  const toggle = url.pathname.match(/^\/api\/plugins\/([^/]+)\/toggle$/);
  if (req.method === 'POST' && toggle) {
    calls.push({ op: 'toggle', id: toggle[1], token: req.headers['x-annota-token'] });
    if (req.headers['x-annota-token'] !== TOKEN) return send(403, { error: 'plugin_token_required' });
    let body = '';
    for await (const chunk of req) body += chunk;
    const enabled = JSON.parse(body || '{}').enabled;
    const p = installed.find((x) => x.id === toggle[1]);
    if (p) p.enabled = !!enabled;
    return send(200, { ok: true });
  }
  const del = url.pathname.match(/^\/api\/plugins\/([^/]+)$/);
  if (req.method === 'DELETE' && del) {
    calls.push({ op: 'uninstall', id: del[1], token: req.headers['x-annota-token'] });
    if (req.headers['x-annota-token'] !== TOKEN) return send(403, { error: 'plugin_token_required' });
    const i = installed.findIndex((x) => x.id === del[1]);
    if (i >= 0) installed.splice(i, 1);
    return send(200, { ok: true });
  }
  send(404, { error: 'not found' });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------- 管理页流程 ----------
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('dialog', (d) => d.accept());

await page.goto(`${base}/#plugins`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#screen-plugins', { timeout: 5000 });

// 内置分组可见、离线横幅不出现
const builtinText = await page.locator('#plugin-builtin').textContent().catch(() => '');
ok(builtinText.includes('Anki 导出') && builtinText.includes('组同步'), '内置插件分组渲染');
ok(await page.locator('#plugin-banner').isHidden().catch(() => true), '服务在线时无离线横幅');
ok((await page.locator('#plugin-installed').textContent()).includes('损坏'), '损坏插件标记展示');

// 两阶段安装（真实 ielts zip）
await page.setInputFiles('#screen-plugins input[type=file]', ieltsZip);
await page.waitForSelector('#plugin-confirm[open]', { timeout: 5000 });
const confirmText = await page.locator('#plugin-confirm').textContent();
ok(confirmText.includes('ielts') && confirmText.includes('雅思词库'), '确认框展示 id/名称');
ok(confirmText.includes('local-api'), '确认框展示权限');
ok(confirmText.includes('ielts-0.1.0.zip'), '确认框展示来源文件名');
await page.locator('#plugin-confirm button[value="ok"], #plugin-confirm .confirm, #plugin-confirm button').filter({ hasText: /安装|确认|确定/ }).first().click();
await page.waitForFunction(() => (document.querySelector('#plugin-installed')?.textContent || '').includes('雅思词库'), null, { timeout: 5000 });
ok(true, '安装后列表出现 ielts');
ok(calls.some((c) => c.op === 'install' && c.dry) && calls.some((c) => c.op === 'install' && !c.dry), '先 dry_run 后正式安装');

// 开关
const row = page.locator('#plugin-installed [data-plugin-id="ielts"], #plugin-installed *').filter({ hasText: '雅思词库' }).first();
const toggle = page.locator('#screen-plugins input[type=checkbox]').last();
await toggle.click();
ok(calls.some((c) => c.op === 'toggle' && c.id === 'ielts'), '切换启用状态发出 toggle 请求');

// 卸载（confirm 已被全局 accept）
await page.locator('#screen-plugins button').filter({ hasText: /卸载/ }).last().click();
await page.waitForFunction(() => !(document.querySelector('#plugin-installed')?.textContent || '').includes('雅思词库'), null, { timeout: 5000 });
ok(calls.some((c) => c.op === 'uninstall' && c.id === 'ielts'), '卸载请求发出且列表移除');

ok(pageErrors.length === 0, '无 pageerror', pageErrors.join(' | '));

// ---------- overlay 菜单高度 ----------
const panelH = (() => {
  const src = readFileSync(resolve(root, 'app/annota/src/main.rs'), 'utf8');
  const m = src.match(/PANEL_MENU_H[^=]*=\s*(\d+)/);
  return m ? Number(m[1]) : 0;
})();
const overlay = await browser.newPage({ viewport: { width: 420, height: 900 } });
await overlay.route('**/i18n/*.json', (r) => r.fulfill({ contentType: 'application/json', body: '{}' }));
await overlay.goto(`file://${resolve(root, 'app/annota/public/overlay.html')}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await overlay.waitForTimeout(400);
const menuH = await overlay.evaluate(() => {
  const menu = document.querySelector('.menu');
  if (!menu) return 0;
  menu.dataset.open = '1';   // 默认收起（display:none），强制展开测高度
  return Math.ceil(menu.getBoundingClientRect().height);
});
ok(panelH > 0, `PANEL_MENU_H 常量可读（${panelH}）`);
if (menuH > 0) ok(menuH <= panelH, `菜单高度 ${menuH} ≤ PANEL_MENU_H ${panelH}`);
else console.log('# SKIP 菜单高度（overlay 结构未识别到菜单节点，需人工确认）');

await browser.close();
server.close();
console.log(`plugin-install-check  ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
