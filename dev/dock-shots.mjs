// 三处 dock 对比截图 —— 宿主环境不同，注入代码相同（core.js / annotate.user.js）
// 用法：先起本地服务 `python3 app/service/sync_server.py`（127.0.0.1:8793），再：
//   pw dev/dock-shots.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.VA_BASE || 'http://127.0.0.1:8793';
const OUT = process.env.VA_OUT || path.join(process.cwd(), 'docs', 'assets');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function shootDock(label, injectUrl) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  await page.addInitScript(() => { window.VA_SYNC_URLS = []; });
  await page.goto(`${BASE}/dev/fixture-host.html`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: `${BASE}${injectUrl}` });
  await page.waitForTimeout(1600);
  const hasDock = !!(await page.$('.va-dock'));
  if (hasDock) { await page.hover('.va-dock').catch(() => {}); await page.waitForTimeout(500); }
  const dockEl = await page.$('.va-dock');
  if (dockEl) await dockEl.screenshot({ path: `${OUT}/${label}-dock.png` }).catch(() => {});
  await page.screenshot({ path: `${OUT}/${label}-full.png` });
  console.log(`${label}: dock=${hasDock} -> ${OUT}/${label}-{dock,full}.png`);
  await page.close();
}

// A: Tauri 壳内容区（core.js，与 app/annota webview 内加载的一致）
await shootDock('A-tauri-content', '/app/extension/core.js');
// B: userscript（dist/annotate.user.js）
await shootDock('B-userscript', '/dist/annotate.user.js');
// C: 扩展（core.js，与 A 同源）
await shootDock('C-extension', '/app/extension/core.js');

console.log('done ->', OUT);
await browser.close();
