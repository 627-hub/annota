// 抓手机视口下 dock 的实际计算样式 + 遮挡情况
import { chromium } from 'playwright';
const BASE = process.env.VA_BASE || 'http://127.0.0.1:8793';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
await page.addInitScript(() => { window.VA_SYNC_URLS = []; });
await page.goto(`${BASE}/dev/fixture-host.html`, { waitUntil: 'domcontentloaded' });
await page.addScriptTag({ url: `${BASE}/dist/annotate.user.js` });
await page.waitForTimeout(1600);
const info = await page.evaluate(() => {
  const dock = document.querySelector('.va-dock');
  if (!dock) return { noDock: true };
  const cs = getComputedStyle(dock);
  const r = dock.getBoundingClientRect();
  const label = dock.querySelector('.va-action-label');
  const labelCs = label ? getComputedStyle(label) : null;
  // 找压住 dock 的元素（dock 中心点命中测试）
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  const inner = innerWidth;
  return {
    innerWidth: inner,
    mediaMatched: matchMedia('(max-width: 768px)').matches,
    dockRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    dockPos: { position: cs.position, right: cs.right, bottom: cs.bottom, zIndex: cs.zIndex },
    labelDisplay: labelCs ? labelCs.display : 'n/a',
    actionWidth: getComputedStyle(dock.querySelector('.va-action')).width,
    hitAtCenter: hit ? (hit.className || hit.tagName) : null,
    hostZ: (() => { const el = document.elementFromPoint(4, 4); return el ? getComputedStyle(el).zIndex : null; })(),
  };
});
console.log(JSON.stringify(info, null, 1));
await browser.close();
