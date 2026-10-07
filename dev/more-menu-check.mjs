/* dev/more-menu-check.mjs — 「更多」菜单精简验证（userscript/扩展端）
 * 目标：首屏只留高频动作，低频项收进折叠区，危险操作独立着色。
 * 验证：
 *   1. 首屏可点元素数量大幅下降
 *   2. 折叠区默认收起，展开后功能仍在（没被删掉）
 *   3. 折叠区 aria-expanded 正确翻转
 *   4. 清空当前有 is-danger 样式
 *   5. 展开后无溢出、无 JS 报错
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`# PASS ${label}`); }
  else { fail++; failures.push(label + (extra ? ` — ${extra}` : '')); console.log(`# FAIL ${label}${extra ? ' — ' + extra : ''}`); }
};

// 用真实 dist 产物（build.py 已拼装），保证测的是线上代码
const dist = readFileSync(resolve(root, 'dist/annotate.user.js'), 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  // fixture 页无本地服务 / file:// 跨源限制：同步探测、组接口、版本探测必然报错，与本次改动无关。
  if (/ERR_CONNECTION_REFUSED|Failed to load resource|CORS policy/.test(t)) return;
  errors.push(t);
});

// fixture：最小视频页
await page.goto('file://' + resolve(root, 'dev/fixture-video.html'), { waitUntil: 'domcontentloaded' });
await page.addScriptTag({ content: dist });
await page.waitForTimeout(900);

// 打开「更多」
await page.evaluate(() => {
  const host = document.querySelector('#annota-shadow-host');
  const btn = host && host.shadowRoot && host.shadowRoot.querySelector('button[aria-label="更多"]');
  if (btn) btn.click();
});
await page.waitForTimeout(500);

// 只统计「用户当前能看到」的元素：折叠体 display:none，其内容不算首屏。
const inMenu = () => page.evaluate(() => {
  const host = document.querySelector('#annota-shadow-host');
  const root = host && host.shadowRoot;
  const menu = root && root.querySelector('.va-more-menu, .va-menu-pop');
  if (!menu) return null;
  const rect = menu.getBoundingClientRect();
  const folds = Array.from(menu.querySelectorAll('.va-fold')).map((f) => ({
    head: f.querySelector('.va-fold-head').textContent.trim(),
    open: f.dataset.open === '1',
  }));
  const visible = (n) => {
    // 自身及祖先都可见才算可见
    for (let e = n; e && e !== menu.parentNode; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
    }
    return true;
  };
  return {
    buttons: Array.from(menu.querySelectorAll('button')).filter(visible).length,
    inputs: Array.from(menu.querySelectorAll('input')).filter(visible).length,
    folds,
    danger: Array.from(menu.querySelectorAll('.va-btn.is-danger')).filter(visible).length,
    w: Math.round(rect.width), h: Math.round(rect.height),
    scrollH: menu.scrollHeight, clientH: menu.clientHeight,
  };
});

const collapsed = await inMenu();
ok(collapsed !== null, '菜单已打开');
if (collapsed) {
  console.log(`#   折叠态：buttons=${collapsed.buttons} inputs=${collapsed.inputs} folds=${JSON.stringify(collapsed.folds)}`);

  ok(collapsed.folds.length === 2, '折叠区：恰好 2 个（高级设置 / 组管理）', JSON.stringify(collapsed.folds));
  ok(collapsed.folds.every((f) => !f.open), '折叠区：默认全部收起');
  ok(collapsed.buttons <= 10, '首屏按钮数已精简到 ≤10', `buttons=${collapsed.buttons}`);
  ok(collapsed.inputs === 0, '首屏不再有输入框（同步地址/词典模板已折叠）', `inputs=${collapsed.inputs}`);
  ok(collapsed.danger === 0, '危险按钮不在首屏', `danger=${collapsed.danger}`);

  // 首屏必须保留核心三件套
  const labels = await page.evaluate(() => {
    const host = document.querySelector('#annota-shadow-host');
    const menu = host && host.shadowRoot && host.shadowRoot.querySelector('.va-more-menu, .va-menu-pop');
    const visible = (n) => {
      for (let e = n; e && e !== menu.parentNode; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
      }
      return true;
    };
    return Array.from(menu.querySelectorAll('button')).filter(visible).map((b) => b.textContent.trim());
  });
  const joined = labels.join('|');
  ok(/发给 AI 助手/.test(joined), '首屏保留「发给 AI 助手」', joined);
  ok(/截图/.test(joined), '首屏保留「截图」', joined);
  ok(/存笔记|保存为笔记/.test(joined), '首屏保留「存笔记」', joined);
  ok(/诊断/.test(joined), '首屏保留「诊断信息」', joined);
  // dock 已有「列表」按钮打开标注侧栏，菜单里再放一份是纯重复
  ok(!/查看全部标注/.test(joined), '首屏无「查看全部标注」（与 dock「列表」重复）', joined);
}

// 展开「高级设置」→ 功能必须还在（没被删）
const heads = await page.$$('.va-fold-head');
if (heads.length >= 1) {
  await heads[0].evaluate((el) => el.click());
  await page.waitForTimeout(400);
  const opened = await inMenu();
  console.log(`#   展开「高级设置」：buttons=${opened.buttons} inputs=${opened.inputs}`);
  ok(opened.buttons > collapsed.buttons, '展开后按钮数增加（功能未被删除）', `${collapsed.buttons} → ${opened.buttons}`);
  ok(opened.inputs >= 2, '展开后同步地址/词典模板输入框可用', `inputs=${opened.inputs}`);
  ok(opened.danger === 2, '展开后两个破坏性操作都带 is-danger 样式', `danger=${opened.danger}`);
  // 展开后菜单不得超出视口（超一点高度、由页面滚动兜底是可接受的）
  const fits = await page.evaluate(() => {
    const host = document.querySelector('#annota-shadow-host');
    const menu = host && host.shadowRoot && host.shadowRoot.querySelector('.va-more-menu, .va-menu-pop');
    const r = menu.getBoundingClientRect();
    return { bottom: Math.round(r.bottom), vh: window.innerHeight, scrollable: menu.scrollHeight > menu.clientHeight };
  });
  ok(fits.bottom <= fits.vh + 2, '展开后菜单未超出视口底部', JSON.stringify(fits));

  const aria = await page.$eval('.va-fold', (f) => f.querySelector('.va-fold-head').getAttribute('aria-expanded'));
  ok(aria === 'true', 'aria-expanded 正确翻转为 true', aria);

  // 同步地址相关功能仍在
  const advLabels = await page.evaluate(() => {
    const host = document.querySelector('#annota-shadow-host');
    const f = host && host.shadowRoot && host.shadowRoot.querySelector('.va-fold[data-open="1"]');
    return f ? Array.from(f.querySelectorAll('button')).map((b) => b.textContent.trim()).join('|') : '';
  });
  for (const kw of ['保存地址', '清空地址', '测试', '只读模式', '导出 Pack', '导入 Pack', '清空当前', '保存模板']) {
    ok(advLabels.includes(kw), `高级设置内保留「${kw}」`, advLabels);
  }
  // 「仅上传」曾是 syncNow 的别名（同功能纯冗余）→ 已删
  ok(!advLabels.includes('仅上传'), '高级设置内无「仅上传」（与同步同功能，已删）', advLabels);
  // 「仅下载」会用服务器版丢弃本地改动 → 改名并标危险色
  ok(!advLabels.includes('仅下载') && advLabels.includes('以服务器覆盖本地'),
    '「仅下载」已改名为「以服务器覆盖本地」', advLabels);

  // 破坏性操作必须标危险色
  const dangerBtns = await page.evaluate(() => {
    const host = document.querySelector('#annota-shadow-host');
    const f = host && host.shadowRoot && host.shadowRoot.querySelector('.va-fold[data-open="1"]');
    if (!f) return [];
    return Array.from(f.querySelectorAll('.va-btn.is-danger')).map((b) => b.textContent.trim());
  });
  ok(dangerBtns.includes('以服务器覆盖本地') && dangerBtns.includes('清空当前'),
    '两个破坏性操作都标了 is-danger', JSON.stringify(dangerBtns));

  // 收起后回到折叠态
  await heads[0].evaluate((el) => el.click());
  await page.waitForTimeout(300);
  const recollapsed = await inMenu();
  ok(recollapsed.folds[0].open === false, '可再次收起');
  ok(recollapsed.buttons === collapsed.buttons, '收起后按钮数复原', `${collapsed.buttons} vs ${recollapsed.buttons}`);
}

// 展开「组管理」
const heads2 = await page.$$('.va-fold-head');
if (heads2.length >= 2) {
  await heads2[1].evaluate((el) => el.click());
  await page.waitForTimeout(400);
  const gLabels = await page.evaluate(() => {
    const host = document.querySelector('#annota-shadow-host');
    const fs = host && host.shadowRoot && host.shadowRoot.querySelectorAll('.va-fold');
    const f = fs && fs[1];
    return f ? Array.from(f.querySelectorAll('button')).map((b) => b.textContent.trim()).join('|') : '';
  });
  for (const kw of ['加入组', '推送到组']) {
    ok(gLabels.includes(kw), `组管理内保留「${kw}」`, gLabels);
  }
  await page.screenshot({ path: resolve(root, 'docs/assets/annota-more-menu.png') });
}

// ---- 回归：诊断面板不得盖住菜单 ----
// 曾经的 bug：.va-diag 的 z-index 高 .va-more-menu 一档，打开诊断后点「更多」菜单被整块遮住。
// 规则写在 shadow DOM 的样式表里，document.styleSheets 遍历不到 → 改为实测层叠顺序。
{
  // 「诊断信息」按钮（btnDiag）只在菜单打开时挂到 DOM 上，
  // 而点它之后菜单会关闭 —— 所以顺序必须是：开菜单 → 点诊断 → 再开菜单。
  await page.evaluate(() => {
    const root = document.querySelector('#annota-shadow-host').shadowRoot;
    const btn = root.querySelector('button[aria-label="更多"]');
    const menu = root.querySelector('.va-more-menu, .va-menu-pop');
    if (menu) btn.click();               // 先确保菜单关闭
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const root = document.querySelector('#annota-shadow-host').shadowRoot;
    root.querySelector('button[aria-label="更多"]').click();   // 开菜单
  });
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const root = document.querySelector('#annota-shadow-host').shadowRoot;
    const diagBtn = Array.from(root.querySelectorAll('button'))
      .find((b) => b.textContent.trim() === '诊断信息');
    if (diagBtn) diagBtn.click();
  });
  await page.waitForTimeout(500);
  const diagOpen = await page.evaluate(() => {
    const root = document.querySelector('#annota-shadow-host').shadowRoot;
    const d = root.querySelector('.va-diag');
    return !!d && getComputedStyle(d).display !== 'none';
  });
  ok(diagOpen, '诊断面板已打开（复现场景）');

  // 诊断开着时再点「更多」，验证菜单可见且位于诊断之上
  await page.evaluate(() => {
    const root = document.querySelector('#annota-shadow-host').shadowRoot;
    root.querySelector('button[aria-label="更多"]').click();
  });
  await page.waitForTimeout(500);

  const overlap = await page.evaluate(() => {
    const root = document.querySelector('#annota-shadow-host').shadowRoot;
    const menu = root.querySelector('.va-more-menu, .va-menu-pop');
    const diag = root.querySelector('.va-diag');
    if (!menu || !diag) return { err: 'menu=' + !!menu + ' diag=' + !!diag };
    const mr = menu.getBoundingClientRect(), dr = diag.getBoundingClientRect();
    // 取菜单中心点，看它命中的是菜单自己还是诊断面板
    const cx = mr.left + mr.width / 2, cy = mr.top + Math.min(24, mr.height / 2);
    const hit = document.elementFromPoint
      ? root.elementFromPoint ? root.elementFromPoint(cx, cy) : null
      : null;
    const inMenu = !!(hit && (hit === menu || menu.contains(hit)));
    return {
      inMenu,
      menuZ: Number(getComputedStyle(menu).zIndex) || 0,
      diagZ: Number(getComputedStyle(diag).zIndex) || 0,
      overlapY: mr.top < dr.bottom && dr.top < mr.bottom,
    };
  });
  ok(!overlap.err, '菜单与诊断面板同时存在', overlap.err || '');
  ok(overlap.inMenu === true,
    '诊断面板打开时，菜单顶部仍可点击（不再被遮挡）',
    JSON.stringify(overlap));
  ok(overlap.diagZ ? overlap.menuZ > overlap.diagZ : true,
    '菜单 z-index 实测高于诊断面板', `menu=${overlap.menuZ} diag=${overlap.diagZ}`);
}

ok(errors.length === 0, '无 JS 报错', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n# RESULT ${fail === 0 ? 'PASS' : 'FAIL'} (${pass}/${pass + fail})`);
if (failures.length) { console.log('# 失败项:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);