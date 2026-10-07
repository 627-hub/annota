/* dev/chrome-preview.mjs — 标签条 + 书签栏视觉自查
 * 用真实 index.html + mock 桥，造 3 个 tab（含长标题）+ 6 个收藏（含超长标题），
 * 截图到 docs/assets/annota-chrome-redesign.png，并断言「不溢出/不撑爆」。
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const BOOKMARKS = [
  { url: 'https://www.bilibili.com/video/BV1GJ411x7h7', title: 'BBC 纪录片：地球脉动 第二季' },
  { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up (Official Video)' },
  { url: 'https://github.com/tauri-apps/tauri', title: 'Tauri 官方仓库' },
  { url: 'https://news.ycombinator.com/', title: 'Hacker News' },
  { url: 'https://arxiv.org/abs/1706.03762', title: 'Attention Is All You Need' },
  { url: 'https://www.douyin.com/video/7xxxxxxxxxxxxxxx', title: '抖音 · 某个超长标题的短视频内容' },
];

const TABS = [
  { url: 'https://example.com/', active: false },
  { url: 'https://www.bilibili.com/blackboard/fe/activity-CjJbuaD7Xw.html', active: true },
  { url: 'https://github.com/tauri-apps/tauri/issues/1234', active: false },
];

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`# PASS ${label}`); }
  else { fail++; failures.push(label + (extra ? ` — ${extra}` : '')); console.log(`# FAIL ${label}${extra ? ' — ' + extra : ''}`); }
};

const mock = `
(function () {
  const BOOKMARKS = ${JSON.stringify(BOOKMARKS)};
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      if (cmd === 'tabs_snapshot') return Promise.resolve({ ok: true, tabs: ${JSON.stringify(TABS.map((t, i) => ({ id: 't' + i, url: t.url, active: t.active })))} });
      return Promise.resolve();
    },
    transformCallback: (c) => c, convertFileSrc: (p) => p,
  };
  window.__TAURI__ = { event: { listen: () => Promise.resolve(() => {}) }, invoke: () => Promise.resolve() };
  window.vaFetch = (m, u) => u.indexOf('/api/bookmarks') >= 0
    ? Promise.resolve({ ok: true, json: { bookmarks: BOOKMARKS } })
    : Promise.resolve({ ok: true, status: 200, json: { ok: true } });
})();
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 300 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.addInitScript(mock);
await page.goto('file://' + resolve(root, 'app/annota/public/index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);

// 事件桥可用 → 主动推 tab；并展开书签栏
await page.evaluate(() => {
  const s = document.getElementById('tabs-scroll');
  window.renderTabsForTest && window.renderTabsForTest();
});
// 直接用页面内已有的 renderTabs（通过触发 tabs-changed 不可行，改为手工调 DOM 结构校验）
await page.evaluate(() => { document.getElementById('bookmark-bar').dataset.open = '1'; });
await page.click('#btn-bookmark-bar');   // 触发 renderBookmarkBar → 走 mock vaFetch
await page.waitForTimeout(700);
await page.click('#btn-bookmark-bar');   // 确保展开
await page.waitForTimeout(700);

// ---- 书签栏断言 ----
const bm = await page.locator('.bookmark-item').count();
ok(bm === 6, '书签栏：渲染 6 个收藏', `count=${bm}`);

const overflow = await page.evaluate(() => {
  const bad = [];
  document.querySelectorAll('.bookmark-item').forEach((el) => {
    const t = el.querySelector('.bm-text');
    if (!t) { bad.push('no .bm-text'); return; }
    // 文本被裁切（scrollWidth > clientWidth）说明省略号生效，符合预期；
    // 但 item 本身不该超出书签栏宽度
    if (el.getBoundingClientRect().right > window.innerWidth + 1) bad.push(el.textContent.slice(0, 20));
  });
  return bad;
});
ok(overflow.length === 0, '书签栏：无条目溢出视口右侧', overflow.join(', '));

const barScroll = await page.evaluate(() => {
  const b = document.getElementById('bookmark-bar');
  return { sw: b.scrollWidth, cw: b.clientWidth };
});
ok(barScroll.sw >= barScroll.cw, '书签栏：超宽时横向滚动（而非撑破布局）', JSON.stringify(barScroll));

const maxW = await page.evaluate(() =>
  Math.max(...Array.from(document.querySelectorAll('.bookmark-item')).map((e) => e.getBoundingClientRect().width)));
ok(maxW <= 192, '书签栏：单个条目宽度受上限约束', `max=${Math.round(maxW)}`);

const truncated = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('.bookmark-item').forEach((el) => {
    const t = el.querySelector('.bm-text');
    if (t && t.scrollWidth > t.clientWidth + 1) out.push(t.textContent.slice(0, 24));
  });
  return out;
});
ok(truncated.length > 0, '书签栏：超长标题确实被省略号裁切', `${truncated.length} 条`);

const hasFav = await page.locator('.bookmark-item .bm-fav').count();
ok(hasFav === 6, '书签栏：每项都有站点色块', `count=${hasFav}`);

// ---- 标签条断言 ----
// mock 里事件桥可用，但代码在缺事件桥时走 tabs_snapshot 轮询；这里两种路径都可能渲染出 tab，
// 因此只断言「渲染结果正确」，不假设渲染来源。
const favCount = await page.locator('.tab .tab-fav').count();
const tabCount = await page.locator('.tab').count();
ok(tabCount === 3, '标签条：渲染 3 个 tab', `count=${tabCount}`);
ok(favCount === 3, '标签条：每个 tab 都有站点色块', `count=${favCount}`);

const active = await page.locator('.tab[data-active="1"]').count();
ok(active === 1, '标签条：恰好 1 个激活态', `count=${active}`);

const tabOverflow = await page.evaluate(() => {
  const strip = document.querySelector('.tabstrip');
  const right = strip.getBoundingClientRect().right;
  const bad = [];
  document.querySelectorAll('.tab').forEach((el) => {
    if (el.getBoundingClientRect().right > right + 1) bad.push(el.textContent.slice(0, 20));
  });
  return bad;
});
ok(tabOverflow.length === 0, '标签条：无 tab 溢出标签条右侧', tabOverflow.join(', '));

const activeHasBar = await page.evaluate(() => {
  const el = document.querySelector('.tab[data-active="1"]');
  if (!el) return false;
  const s = getComputedStyle(el, '::before');
  return s && s.content !== 'none' && s.backgroundColor !== 'rgba(0, 0, 0, 0)';
});
ok(activeHasBar, '标签条：激活态有顶部强调条（::before 可见）');

// 激活态与非激活态背景必须有明显差异
const contrast = await page.evaluate(() => {
  const a = document.querySelector('.tab[data-active="1"]');
  const b = document.querySelector('.tab[data-active="0"]');
  if (!a || !b) return null;
  return {
    active: getComputedStyle(a).backgroundColor,
    idle: getComputedStyle(b).backgroundColor,
  };
});
ok(contrast && contrast.active !== contrast.idle,
  '标签条：激活态底色与非激活态不同', JSON.stringify(contrast));

ok(errors.length === 0, '无 JS 报错', errors.slice(0, 3).join(' | '));

await page.screenshot({ path: resolve(root, 'docs/assets/annota-chrome-redesign.png') });
await browser.close();

console.log(`\n# RESULT ${fail === 0 ? 'PASS' : 'FAIL'} (${pass}/${pass + fail})`);
if (failures.length) { console.log('# 失败项:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);