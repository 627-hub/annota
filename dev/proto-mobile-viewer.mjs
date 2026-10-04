// 手机端「观看端」目标形态原型（供确认，不是最终代码）
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'docs/assets'; fs.mkdirSync(OUT, { recursive: true });

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;background:#0b0e13;color:#e6edf3;font:14px/1.6 -apple-system,"PingFang SC",sans-serif;min-height:100vh}
  .video{height:300px;background:#000;display:grid;place-items:center;color:#3d4451;font-size:20px}
  .info{padding:18px 22px}.info h1{margin:0 0 6px;font-size:19px}.info p{margin:0;color:#8b949e;font-size:13px}
  /* ===== 目标 dock（移动端观看态）===== */
  .dock{position:fixed;left:12px;right:12px;bottom:12px;z-index:9;display:flex;align-items:center;justify-content:center;gap:10px;
    padding:8px;border:1px solid rgba(255,255,255,.12);border-radius:18px;background:rgba(16,18,22,.92);
    backdrop-filter:blur(20px) saturate(150%);box-shadow:0 12px 36px rgba(0,0,0,.5)}
  .abtn{display:grid;place-items:center;width:48px;height:48px;flex:none;border:1px solid transparent;border-radius:14px;
    background:transparent;color:#c6cbd2;cursor:pointer}
  .abtn:active{transform:scale(.95)}
  .abtn.on{border-color:rgba(245,166,35,.3);background:rgba(245,166,35,.14);color:#ffd18a}
  .abtn svg{width:22px;height:22px}
  .pill{display:flex;align-items:center;gap:7px;height:48px;padding:0 16px;border-radius:14px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#e6edf3;font-weight:650;font-size:13px}
  .badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--acc,#f5a623);color:#241707;font:700 11px/18px sans-serif;text-align:center}
  .src{position:absolute;left:12px;right:12px;bottom:76px;padding:8px;border:1px solid rgba(255,255,255,.12);border-radius:14px;background:rgba(16,18,22,.97);box-shadow:0 16px 44px rgba(0,0,0,.55)}
  .src h4{margin:2px 6px 8px;color:#9b8260;font-size:11px;letter-spacing:.08em}
  .row{display:flex;align-items:center;gap:10px;padding:10px 10px;border-radius:10px}
  .row+.row{margin-top:2px}.row.on{background:rgba(245,166,35,.1)}
  .row .t{flex:1;min-width:0}.row .t b{display:block;font-size:13px}.row .t small{color:#8b949e;font-size:11px}
  .chk{width:22px;height:22px;flex:none;border:1.5px solid #5a6068;border-radius:7px;display:grid;place-items:center;color:#f5a623;font-weight:800}
  .row.on .chk{border-color:var(--acc,#f5a623);background:rgba(245,166,35,.18)}
  :root{--acc:#f5a623}
</style></head><body>
  <div class="video">VIDEO AREA</div>
  <div class="info"><h1>视频标题示例</h1><p>up主 · 1.2万播放 · 手机观看端</p></div>

  <div class="src">
    <h4>标注来源（本视频 3 个）</h4>
    <div class="row on"><span class="chk">✓</span><span class="t"><b>英语听力互助组</b><small>云开发 · 12 条 · Alice</small></span></div>
    <div class="row"><span class="chk"></span><span class="t"><b>公开标注（所有人）</b><small>云开发 · 5 条</small></span></div>
    <div class="row"><span class="chk"></span><span class="t"><b>我的本地标注</b><small>本机 · 3 条</small></span></div>
  </div>

  <div class="dock">
    <button class="abtn on" title="显示/隐藏全部"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.6"/></svg></button>
    <button class="pill"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>列表<span class="badge">12</span></button>
    <button class="abtn" title="标注来源"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M12 11v4M10 13h4"/></svg></button>
  </div>
</body></html>`;

const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
const p = await ctx.newPage();
await p.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(300);
await p.screenshot({ path: `${OUT}/proto-mobile-viewer.png` });
console.log('->', `${OUT}/proto-mobile-viewer.png`);
await b.close();
