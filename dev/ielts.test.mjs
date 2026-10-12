// node dev/ielts.test.mjs — 雅思词库插件：注册/查词渲染/缓存/未配置降级
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'src', 'plugins', 'ielts.js'), 'utf8');

function mkNode(tag) {
  return {
    tag, className: '', textContent: '', children: [],
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(n) { this.children.push(n); return n; },
    append(...ns) { this.children.push(...ns); },
    querySelector(sel) {
      const cls = String(sel).replace(/^\./, '');
      const walk = (n) => {
        for (const c of n.children) {
          if (String(c.className || '').split(/\s+/).includes(cls)) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
  };
}

function mkSandbox(httpImpl) {
  const hooks = {};
  const httpCalls = [];
  const coreApi = {
    resolveBase: async () => 'http://127.0.0.1:8793',
    httpJson: async (method, url) => {
      httpCalls.push({ method, url });
      return httpImpl(url);
    },
    onHook: (name, fn) => { (hooks[name] = hooks[name] || []).push(fn); },
  };
  const s = {
    console, Date, Math, JSON, Object, String, Number, Array, Promise, Map, Set, Error,
    setTimeout, clearTimeout,
    document: { createElement: (tag) => mkNode(tag) },
  };
  s.self = s; s.window = s;
  vm.createContext(s);
  vm.runInContext(code, s);
  const def = (s.__VA_PLUGIN_DEFS__ || []).find((p) => p.id === 'ielts');
  assert.ok(def, '应向 __VA_PLUGIN_DEFS__ 注册 id=ielts');
  assert.equal(def.viewOnly, true, 'ielts 应为只读插件（观看端也装）');
  def.install(coreApi);
  return { s, hooks, httpCalls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// 1) 命中：气泡底部追加雅思块（音标/释义/例句）
{
  const found = {
    ok: true, found: true, word: 'abandon', us: "ə'bændən", uk: "ə'bænd(ə)n",
    translations: [{ type: 'v', translation: '离弃；放弃' }],
    sentences: [{ sentence: 'How could she abandon her own child?', translation: 'x' }],
  };
  const { s, hooks, httpCalls } = mkSandbox(() => ({ ok: true, status: 200, json: found }));
  assert.ok(hooks.entryPop && hooks.entryPop.length === 1, '应订阅 entryPop 钩子');
  const pop = mkNode('div');
  hooks.entryPop[0]({ entry: { word: 'Abandon' }, pop });
  await tick();
  const block = pop.querySelector('.va-ielts-block');
  assert.ok(block, '命中后应追加 .va-ielts-block');
  assert.equal(block.querySelector('.va-ielts-tag').textContent, '雅思');
  assert.ok(block.querySelector('.va-ielts-phon').textContent.includes('bænd'), '应含音标');
  assert.equal(block.querySelector('.va-ielts-trans').textContent, '离弃；放弃');
  assert.equal(block.querySelector('.va-ielts-example').textContent, 'How could she abandon her own child?');
  assert.equal(httpCalls.length, 1);
  assert.ok(httpCalls[0].url.includes('/api/ielts/lookup?word=Abandon'), '按原词形查（服务端管大小写）');

  // 同词再开一个气泡：走缓存，不再发请求
  const pop2 = mkNode('div');
  hooks.entryPop[0]({ entry: { word: 'abandon' }, pop: pop2 });
  await tick();
  assert.equal(httpCalls.length, 1, '5 分钟内同词应命中缓存');
  assert.ok(pop2.querySelector('.va-ielts-block'), '第二个气泡也应渲染');
}

// 2) 负缓存：found:false 不渲染、重复词不重复请求；非法词直接拦截
{
  const { s, hooks, httpCalls } = mkSandbox(() => ({ ok: true, status: 200, json: { ok: true, found: false } }));
  const pop = mkNode('div');
  hooks.entryPop[0]({ entry: { word: 'zzzznotaword' }, pop });
  await tick();   // 等首个请求落缓存，再重复同词（并发未落缓存时会重复请求，属预期）
  hooks.entryPop[0]({ entry: { word: 'zzzznotaword' }, pop });
  hooks.entryPop[0]({ entry: { word: '../../etc/passwd' }, pop });
  hooks.entryPop[0]({ entry: { word: '' }, pop });
  await tick();
  assert.equal(httpCalls.length, 1, '未命中词负缓存；非法词不发请求');
  assert.equal(pop.querySelector('.va-ielts-block'), null, '未命中不渲染块');
}

// 3) 未配置（501）：首个词后停用，后续词不再发请求、不刷屏
{
  const { hooks, httpCalls, s } = mkSandbox(() => ({ ok: false, status: 501, json: { ok: false, error: 'ielts-data-not-configured' } }));
  const pop = mkNode('div');
  hooks.entryPop[0]({ entry: { word: 'alpha' }, pop });
  await tick();
  hooks.entryPop[0]({ entry: { word: 'beta' }, pop });
  await tick();
  assert.equal(httpCalls.length, 1, '501 后应停用查词');
  assert.equal(s.VAIELTS.isConfigured(), false, 'isConfigured 应报告未配置');
  assert.equal(await s.VAIELTS.lookup('beta'), null, '未配置时 lookup 直接 null');
}

// 4) VAIELTS 运行期 API 暴露
{
  const { s } = mkSandbox(() => ({ ok: true, status: 200, json: { ok: true, found: false } }));
  assert.equal(typeof s.VAIELTS.lookup, 'function');
  assert.equal(s.VAIELTS.isConfigured(), true);
}

console.log('ielts.test.mjs  PASS');
