// node dev/check-shell-drift.mjs —— 守护 core.js 的「浏览器壳接缝」不扩散。
// 契约：core.js 只能通过 window.VA_BROWSER_SHELL 与壳交互；分支应集中在 mountShell / applyMode。
// 若有人把壳逻辑散落进其它函数，这里会失败（提示去 docs/shell-contract.md）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = fs.readFileSync(path.join(here, '..', 'src', 'core.js'), 'utf8');
const shell = fs.readFileSync(path.join(here, '..', 'src', 'browser-shell.js'), 'utf8');

const checks = [];
const check = (label, ok, detail = '') => { checks.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`); };

// 1) core.js 中 VA_BROWSER_SHELL 的出现次数应受控（当前设计：mountShell 1 + applyMode 1 = 2）。
const coreRefs = (core.match(/VA_BROWSER_SHELL/g) || []).length;
check('core.js 引用 VA_BROWSER_SHELL 次数 ≤ 3', coreRefs <= 3, `refs=${coreRefs}`);

// 2) 每次引用都应贴着接缝注释（防止壳逻辑到处漂）。允许注释行含关键词。
const seamMentions = (core.match(/浏览器壳接缝/g) || []).length;
check('core.js 有接缝注释（浏览器壳接缝）', seamMentions >= 1, `mentions=${seamMentions}`);

// 3) 每个 VA_BROWSER_SHELL 出现处，其所在函数名应为 mountShell / applyMode（就近判定）。
function functionOf(source, index) {
  const before = source.slice(0, index);
  const m = [...before.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].pop();
  return m ? m[1] : '(top)';
}
const allowedFns = new Set(['mountShell', 'applyMode']);
let idx = -1, offenders = [];
while ((idx = core.indexOf('VA_BROWSER_SHELL', idx + 1)) >= 0) {
  const fn = functionOf(core, idx);
  if (!allowedFns.has(fn)) offenders.push(`${fn}@${idx}`);
}
check('VA_BROWSER_SHELL 只出现在 mountShell/applyMode', offenders.length === 0, offenders.join(', ') || 'none');

// 4) browser-shell.js 不得直接引用 core 内部标识（只允许通过 adopt 交出的 api / document / localStorage）。
// 注意：经 `api.` / `ctx.api.` 前缀的调用是允许的（那是接缝交出的受控入口）。
const forbidden = [
  { re: /window\.__VA\b/, why: 'window.__VA' },
  { re: /\bstate\.\w+/, why: 'state.*' },
  { re: /(?<!\.)\btoggleAnnotate\b/, why: '裸 toggleAnnotate' },
];
const hardRefs = forbidden
  .filter(({ re, why }) => {
    // 逐行判断：若该标识只以 api./ctx.api. 前缀出现，放过
    return shell.split('\n').some((line) => re.test(line) && !/\bapi\.\w/.test(line.replace(re, 'api.X')));
  })
  .map((f) => f.why);
check('browser-shell.js 未直连 core 内部状态', hardRefs.length === 0, hardRefs.join(' | ') || 'none');

// 5) 浏览器变体不含 userscript 自动更新探测（version-check.js）
const browserBundle = path.join(here, '..', 'dist', 'annotate.browser.js');
if (fs.existsSync(browserBundle)) {
  const b = fs.readFileSync(browserBundle, 'utf8');
  check('浏览器变体不含 VA_DIST_BASE（无脚本自动更新混入）', !/VA_DIST_BASE/.test(b));
  check('浏览器变体含 browser-shell 接缝', /VA_BROWSER_SHELL/.test(b));
} else {
  console.log('SKIP dist/annotate.browser.js 不存在（先 python3 build.py）');
}

console.log(`RESULT ${checks.every(Boolean) ? 'PASS' : 'FAIL'} (${checks.filter(Boolean).length}/${checks.length} assertions)`);
if (checks.some((p) => !p)) process.exitCode = 1;
