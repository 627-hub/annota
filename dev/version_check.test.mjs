// node dev/version_check.test.mjs —— 用最小假 DOM/环境跑 version-check.js：探测→提示/静默
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'src', 'version-check.js'), 'utf8');

const checks = [];
const check = (label, ok, detail = '') => { checks.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`); };

function makeEl(tag) {
  const n = {
    tagName: (tag || 'div').toUpperCase(), style: { cssText: '' }, textContent: '', children: [],
    className: '', id: '', setAttribute(k, v) { this[k] = v; }, append(...c) { this.children.push(...c); },
    remove() { this.removed = true; }, onclick: null,
  };
  Object.defineProperty(n, 'href', { writable: true, value: '' });
  return n;
}

function makeEnv({ fetchImpl, gmImpl, build, distBase, lastCheck }) {
  const created = [];
  const store = { [lastCheck == null ? '__none' : 'va:lastVersionCheck']: lastCheck == null ? undefined : String(lastCheck) };
  const document = {
    getElementById: (id) => created.find((e) => e.id === id) || null,
    createElement: (tag) => { const e = makeEl(tag); created.push(e); return e; },
    body: makeEl('body'),
    documentElement: makeEl('html'),
  };
  const localStorage = {
    getItem: (k) => (k === 'va:lastVersionCheck' ? (store['va:lastVersionCheck'] ?? null) : null),
    setItem: (k, v) => { store[k] = v; },
  };
  const sandbox = {
    document, localStorage, VA_BUILD: build, VA_DIST_BASE: distBase,
    console, JSON, Promise, Number, Date,
    fetch: fetchImpl, GM_xmlhttpRequest: gmImpl,
  };
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(code, ctx, { filename: 'version-check.js' });
  return { ctx, sandbox, created };
}

const resp = (text) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) });

(async () => {
  // 1) 远端更新 → 出现提示条
  {
    const { ctx } = makeEnv({ fetchImpl: () => resp('{"build":2000}'), build: 1000, distBase: 'https://x.test', lastCheck: 0 });
    await ctx.VAVersion.check();
    const host = ctx.document.getElementById('annota-version-nudge');
    check('远端更新 → 显示提示条', !!host);
    if (host) {
      const link = host.children.find((c) => c.href);
      check('提示条链接指向观看端脚本', !!link && link.href === 'https://x.test/annotate.view.user.js', link && link.href);
    }
  }
  // 2) 已是最新 → 不提示
  {
    const { ctx } = makeEnv({ fetchImpl: () => resp('{"build":1000}'), build: 1000, distBase: 'https://x.test', lastCheck: 0 });
    await ctx.VAVersion.check();
    check('已是最新 → 不提示', !ctx.document.getElementById('annota-version-nudge'));
  }
  // 3) 6 小时内已探测过 → 跳过（不请求）
  {
    let called = 0;
    const { ctx } = makeEnv({ fetchImpl: () => { called++; return resp('{"build":2000}'); }, build: 1000, distBase: 'https://x.test', lastCheck: Date.now() });
    await ctx.VAVersion.check();
    check('节流：6h 内不重复探测', called === 0, `called=${called}`);
  }
  // 4) 探测失败 → 静默、不抛
  {
    const { ctx } = makeEnv({ fetchImpl: () => Promise.reject(new Error('net')), build: 1000, distBase: 'https://x.test', lastCheck: 0 });
    let threw = false;
    try { await ctx.VAVersion.check(); } catch (e) { threw = true; }
    check('探测失败静默不抛', !threw && !ctx.document.getElementById('annota-version-nudge'));
  }
  // 5) GM_xmlhttpRequest 通道优先
  {
    let used = 0;
    const gmImpl = (opts) => { used++; opts.onload({ responseText: '{"build":3000}' }); };
    const { ctx } = makeEnv({ gmImpl, fetchImpl: () => { throw new Error('should not use fetch'); }, build: 1000, distBase: 'https://x.test', lastCheck: 0 });
    await ctx.VAVersion.check();
    check('GM 通道可用时走 GM', used === 1 && !!ctx.document.getElementById('annota-version-nudge'), `used=${used}`);
  }
  // 6) 缺 build/distBase → 直接返回
  {
    let called = 0;
    const { ctx } = makeEnv({ fetchImpl: () => { called++; return resp('{}'); }, build: 0, distBase: '', lastCheck: 0 });
    await ctx.VAVersion.check();
    check('缺 build/distBase → 不探测', called === 0);
  }

  console.log(`RESULT ${checks.every(Boolean) ? 'PASS' : 'FAIL'} (${checks.filter(Boolean).length}/${checks.length} assertions)`);
  if (checks.some((p) => !p)) process.exitCode = 1;
})();
