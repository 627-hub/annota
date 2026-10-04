// Real viewer-mode dock verification at an iPhone-sized viewport.
// Run with: pw dev/dock-mobile.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.VA_BASE || 'http://127.0.0.1:8793';
const OUT = path.join(process.cwd(), 'docs', 'assets');
const VIEWPORT = { width: 390, height: 844 };
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: VIEWPORT,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
  userAgent: USER_AGENT,
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) pageErrors.push(message.text());
});
page.on('response', (response) => {
  const optionalSettingsProbe = response.status() === 404 && /\/api\/settings(?:\?|$)/.test(response.url());
  const optionalVersionProbe = response.status() === 404 && /\/version\.json(?:\?|$)/.test(response.url());
  if (response.status() >= 400 && !optionalSettingsProbe && !optionalVersionProbe && !/\/favicon\.ico(?:\?|$)/.test(response.url())) {
    pageErrors.push(`HTTP ${response.status()} ${response.url()}`);
  }
});

const checks = [];
function check(label, passed, detail = '') {
  checks.push(!!passed);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

try {
  await page.addInitScript(() => { window.VA_SYNC_URLS = []; });
  await page.goto(`${BASE}/dev/fixture-host.html`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: `${BASE}/dist/annotate.view.user.js` });
  // Inject the ordinary build too: the viewer build must win via its read-only
  // config, and the standard bundle's duplicate-load guard must be harmless.
  await page.addScriptTag({ url: `${BASE}/dist/annotate.user.js` });
  await page.waitForTimeout(1500);

  const dock = page.locator('#annota-shadow-host .va-dock');
  const foundDock = await dock.count();
  check('viewer dock mounted', foundDock === 1, `count=${foundDock}`);
  if (!foundDock) {
    const boot = await page.evaluate(() => {
      const host = document.getElementById('annota-shadow-host');
      return { title: document.title, host: !!host, shadow: !!(host && host.shadowRoot), rootMarkup: host && host.shadowRoot ? host.shadowRoot.innerHTML.slice(0, 800) : '' };
    });
    console.log(`DIAGNOSTIC ${JSON.stringify({ boot, pageErrors })}`);
    process.exitCode = 1;
  } else {
  await dock.hover();
  await page.waitForTimeout(250);
  const seededCount = await page.evaluate(() => {
    const state = window.__VA && window.__VA.state;
    if (!state) return 0;
    // In-memory fixture data only; give the screenshot a representative badge.
    state.entries = Array.from({ length: 12 }, (_, index) => ({ id: `mobile-demo-${index + 1}`, word: `demo-${index + 1}` }));
    return state.entries.length;
  });
  check('mobile fixture seeded for count badge', seededCount === 12, `count=${seededCount}`);
  const sourceButton = page.locator('#annota-shadow-host .va-dock button[aria-label="来源"]');
  const sourceCount = await sourceButton.count();
  check('来源 action exists', sourceCount === 1, `count=${sourceCount}`);
  await page.locator('#annota-shadow-host .va-dock button[aria-label="显示"]').click();
  if (sourceCount) await sourceButton.click();
  await page.waitForTimeout(150);
  const sourceRow = page.locator('#annota-shadow-host .va-sources .va-src-item').first();
  await sourceRow.evaluate((button) => button.click());
  await sourceRow.evaluate((button) => button.click());

  const result = await page.evaluate(() => {
    const host = document.getElementById('annota-shadow-host');
    const shadow = host && host.shadowRoot;
    const dockNode = shadow && shadow.querySelector('.va-dock');
    if (!dockNode) return { dock: false };
    const visible = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const labelButton = (name) => dockNode.querySelector(`button[aria-label="${name}"]`);
    const rect = dockNode.getBoundingClientRect();
    const brandCopy = shadow.querySelector('.va-brand-copy');
    const brandMark = shadow.querySelector('.va-brand-mark');
    const buttons = ['显示', '列表', '来源'];
    const hiddenButtons = ['标注', '选对象', '同步', '更多'];
    const sources = shadow.querySelector('.va-sources');
    return {
      dock: true,
      brandCopyHidden: !visible(brandCopy),
      brandMarkSize: brandMark ? { width: brandMark.getBoundingClientRect().width, height: brandMark.getBoundingClientRect().height } : null,
      showIsActive: labelButton('显示')?.classList.contains('is-active') || false,
      listBadgeText: dockNode.querySelector('button[aria-label="列表"] .va-count-badge')?.textContent || '',
      present: buttons.map((name) => [name, visible(labelButton(name))]),
      absent: hiddenButtons.map((name) => [name, !visible(labelButton(name))]),
      noOverflow: rect.right <= window.innerWidth + 1 && rect.left >= -1,
      bounds: { left: rect.left, right: rect.right, viewport: window.innerWidth },
      sourcePopoverOpen: !!sources && visible(sources),
      sourceRows: sources ? Array.from(sources.querySelectorAll('.va-src-text b')).map((node) => node.textContent) : [],
      sourceStyles: sources ? { position: getComputedStyle(sources).position, left: getComputedStyle(sources).left, right: getComputedStyle(sources).right } : null,
    };
  });

  check('viewer brand copy hidden', result.brandCopyHidden);
  check('brand mark is compact 40px square', !!result.brandMarkSize && Math.abs(result.brandMarkSize.width - 40) < 1 && Math.abs(result.brandMarkSize.height - 40) < 1, JSON.stringify(result.brandMarkSize));
  check('显示 control supports active state', result.showIsActive);
  check('列表 badge shows visible-entry count', result.listBadgeText === '12', `count=${result.listBadgeText || '(none)'}`);
  for (const [name, present] of result.present || []) check(`viewer button present: ${name}`, present);
  for (const [name, absent] of result.absent || []) check(`viewer button absent: ${name}`, absent);
  check('dock has no horizontal overflow', result.noOverflow, JSON.stringify(result.bounds));
  check('sources popover opened', result.sourcePopoverOpen);
  check('sources list rendered', Array.isArray(result.sourceRows) && result.sourceRows.length >= 1, JSON.stringify(result.sourceRows));

  await page.screenshot({ path: path.join(OUT, 'mobile-viewer-final.png'), fullPage: true });
  await dock.screenshot({ path: path.join(OUT, 'mobile-viewer-dock.png') });
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
  console.log(`RESULT ${checks.every(Boolean) ? 'PASS' : 'FAIL'} (${checks.filter(Boolean).length}/${checks.length} assertions)`);
  console.log(`SCREENSHOT ${path.join(OUT, 'mobile-viewer-final.png')}`);
  console.log(`SCREENSHOT ${path.join(OUT, 'mobile-viewer-dock.png')}`);
  }
} finally {
  await context.close();
  await browser.close();
}

if (checks.some((passed) => !passed)) process.exitCode = 1;
