// 手机观看端「来源」交互验证：点来源勾选/取消 → 列表徽标与画面标注随之变化。
// 用法：先起本地服务 `python3 app/service/sync_server.py`（127.0.0.1:8793），再 `pw dev/dock-mobile-interact.mjs`
import { chromium } from 'playwright';

const BASE = process.env.VA_BASE || 'http://127.0.0.1:8793';
const MEDIA_ID = `generic:${BASE}/dev/fixture-video.html`;
const GID = 'g_demo1';
const VIEWPORT = { width: 390, height: 844 };
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const box = (x, y) => ({ x, y, w: 0.2, h: 0.15 });
const LOCAL_ENTRIES = [
  { id: 'L1', word: '本地甲', t: 0, dur: 1, box: box(0.10, 0.10) },
  { id: 'L2', word: '本地乙', t: 0, dur: 1, box: box(0.40, 0.10) },
  { id: 'L3', word: '本地丙', t: 0, dur: 1, box: box(0.70, 0.10) },
];
const GROUP_ENTRIES = [
  { id: 'G1', word: '组内甲', t: 0, dur: 1, box: box(0.10, 0.60), creator: { name: '小明' } },
  { id: 'G2', word: '组内乙', t: 0, dur: 1, box: box(0.40, 0.60), creator: { name: '小红' } },
];

const checks = [];
function check(label, passed, detail = '') {
  checks.push(!!passed);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: USER_AGENT });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource:')) pageErrors.push(m.text()); });

try {
  await page.addInitScript(({ mediaId, gid, local, group }) => {
    window.VA_SYNC_URLS = [];
    localStorage.setItem('va:entries:' + mediaId, JSON.stringify({ entries: local }));
    localStorage.setItem('annota:groups', JSON.stringify([
      { gid, name: '演示组A', host: 'git', role: 'member', doc: { contentList: { items: [{ mediaId }] } } },
    ]));
    localStorage.setItem('va:group:' + gid + ':' + mediaId, JSON.stringify({ media: { mediaId }, entries: group }));
    localStorage.removeItem('va:hiddenSources');
  }, { mediaId: MEDIA_ID, gid: GID, local: LOCAL_ENTRIES, group: GROUP_ENTRIES });

  await page.goto(`${BASE}/dev/fixture-video.html`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: `${BASE}/dist/annotate.view.user.js` });
  await page.addScriptTag({ url: `${BASE}/dist/annotate.user.js` });

  // 等视频媒态挂上 + videoWidth 就绪（渲染锚点需要）
  await page.waitForFunction((mid) => {
    const s = window.__VA && window.__VA.state;
    return !!(s && s.binding && s.mediaId === mid && s.binding.el && s.binding.el.videoWidth > 0);
  }, MEDIA_ID, { timeout: 8000 });

  await page.waitForTimeout(400);
  // 收起态只露圆钮：先 hover dock 展开菜单，再点「显示」→ 所有锚点可见
  const dock = page.locator('#annota-shadow-host .va-dock');
  await dock.hover();
  await page.waitForTimeout(300);
  await page.locator('#annota-shadow-host .va-dock button[aria-label="显示"]').click();
  await page.waitForTimeout(200);

  const snapshot = () => page.evaluate(() => {
    const shadow = document.getElementById('annota-shadow-host').shadowRoot;
    const marks = Array.from(shadow.querySelectorAll('.va-mark'));
    return {
      badge: shadow.querySelector('button[aria-label="列表"] .va-count-badge')?.textContent || '',
      total: marks.length,
      local: marks.filter((m) => !m.classList.contains('is-group')).length,
      group: marks.filter((m) => m.classList.contains('is-group')).length,
      rows: Array.from(shadow.querySelectorAll('.va-sources .va-src-item')).map((b) => ({
        name: (b.querySelector('.va-src-text b') || {}).textContent || '',
        on: b.classList.contains('is-on'),
      })),
      hidden: localStorage.getItem('va:hiddenSources') || '{}',
    };
  });

  const openSources = async () => {
    const btn = page.locator('#annota-shadow-host .va-dock button[aria-label="来源"]');
    if (!(await btn.evaluate((b) => b.classList.contains('is-active')))) await btn.click();
    await page.waitForTimeout(120);
  };
  const clickRow = async (index) => {
    await page.locator('#annota-shadow-host .va-sources .va-src-item').nth(index).click();
    await page.waitForTimeout(200);
  };

  let snap = await snapshot();
  check('baseline badge = 5 (本地3 + 组2)', snap.badge === '5', `badge=${snap.badge}`);
  check('baseline markers = 5 (3 本地 + 2 组)', snap.total === 5 && snap.local === 3 && snap.group === 2, JSON.stringify(snap));

  await openSources();
  await page.waitForTimeout(150);
  snap = await snapshot();
  check('来源弹层列出 2 个来源', snap.rows.length === 2, JSON.stringify(snap.rows));
  check('两个来源默认勾选', snap.rows.every((r) => r.on), JSON.stringify(snap.rows));

  // 取消「演示组A」（第 2 行）→ 组标注消失，徽标 5→3
  await clickRow(1);
  snap = await snapshot();
  check('取消组来源后徽标 = 3', snap.badge === '3', `badge=${snap.badge}`);
  check('取消组来源后组标注消失（本地3 组0）', snap.total === 3 && snap.local === 3 && snap.group === 0, JSON.stringify(snap));
  check('来源勾选状态持久化到 localStorage', JSON.parse(snap.hidden)[GID] === true, snap.hidden);
  check('该来源行显示为未勾选', snap.rows[1] && snap.rows[1].on === false, JSON.stringify(snap.rows));

  // 重新勾选「演示组A」→ 恢复 5
  await clickRow(1);
  snap = await snapshot();
  check('恢复组来源后徽标回到 5', snap.badge === '5', `badge=${snap.badge}`);
  check('恢复组来源后组标注重现（组2）', snap.total === 5 && snap.group === 2, JSON.stringify(snap));

  // 取消「我的本地标注」（第 1 行）→ 只剩组 2
  await clickRow(0);
  snap = await snapshot();
  check('取消本地来源后徽标 = 2', snap.badge === '2', `badge=${snap.badge}`);
  check('取消本地来源后本地标注消失（本地0 组2）', snap.total === 2 && snap.local === 0 && snap.group === 2, JSON.stringify(snap));

  // 复原
  await clickRow(0);
  snap = await snapshot();
  check('复原后徽标回到 5', snap.badge === '5' && snap.total === 5, JSON.stringify(snap));

  check('无 JS 报错', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
  console.log(`RESULT ${checks.every(Boolean) ? 'PASS' : 'FAIL'} (${checks.filter(Boolean).length}/${checks.length} assertions)`);
} finally {
  await context.close();
  await browser.close();
}

if (checks.some((p) => !p)) process.exitCode = 1;
