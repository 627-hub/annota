/* Annota · 雅思词库插件（只读，viewOnly:true）。查词走本地服务 GET /api/ielts/lookup。
 * 词条详情气泡（entryPop）底部追加雅思信息块；失败/未命中/未配置一律静默，不打断标注。 */
(function (root) {
  'use strict';

  const WORD_RE = /^[A-Za-z][A-Za-z0-9' -]{0,60}$/;
  const TTL_MS = 5 * 60 * 1000;
  const SENTENCE_MAX = 120;
  const cache = new Map();          // lowercased word -> { ts, data }（data 为 null 表示词不在库）
  let coreApi = null;
  let unconfigured = false;         // 服务端未配置雅思数据：之后不再发请求
  let warnedUnconfigured = false;

  /* ---------- 查词（带 5 分钟缓存） ---------- */
  async function lookup(word) {
    if (unconfigured || !coreApi) return null;
    const trimmed = String(word || '').trim();
    const key = trimmed.toLowerCase();
    if (!key) return null;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;
    try {
      const base = await coreApi.resolveBase();
      const res = await coreApi.httpJson('GET', base + '/api/ielts/lookup?word=' + encodeURIComponent(trimmed));
      if (res.status === 501 || (res.json && res.json.error === 'ielts-data-not-configured')) {
        unconfigured = true;
        if (!warnedUnconfigured) { warnedUnconfigured = true; console.info('[annota] 雅思词库未配置，已停用查词'); }
        return null;
      }
      if (!res.ok || !res.json || res.json.ok !== true) return null;   // 临时错误不缓存
      const data = res.json.found === true ? res.json : null;          // found:false 为合法结果，负缓存
      cache.set(key, { ts: Date.now(), data });
      return data;
    } catch (e) {
      return null;
    }
  }

  /* ---------- 气泡信息块（最小 DOM 构建，风格同 export.js/group.js） ---------- */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const stripSlashes = (s) => String(s || '').replace(/^\/+|\/+$/g, '');

  function buildBlock(data) {
    const block = el('div', 'va-ielts-block');
    block.setAttribute('data-va-plugin', 'ielts');

    const head = el('div', 'va-ielts-head');
    head.append(el('span', 'va-ielts-tag', '雅思'));
    const phon = [];
    if (data.us) phon.push('美 /' + stripSlashes(data.us) + '/');
    if (data.uk) phon.push('英 /' + stripSlashes(data.uk) + '/');
    if (phon.length) head.append(el('span', 'va-ielts-phon', phon.join('  ')));
    block.append(head);

    const meanings = (data.translations || []).slice(0, 2);
    for (const item of meanings) {
      const text = item && item.translation;
      if (text) block.append(el('div', 'va-ielts-trans', String(text)));
    }

    const first = data.sentences && data.sentences[0];
    const sentence = first && first.sentence ? String(first.sentence) : '';
    if (sentence) {
      const cut = sentence.length > SENTENCE_MAX ? sentence.slice(0, SENTENCE_MAX) + '…' : sentence;
      block.append(el('div', 'va-ielts-example', cut));
    }
    return block;
  }

  /* ---------- entryPop 钩子：不阻塞，失败静默 ---------- */
  function onEntryPop(payload) {
    try {
      const entry = payload && payload.entry;
      const pop = payload && payload.pop;
      if (!entry || !pop) return;
      const word = String(entry.word || '').trim();
      if (!WORD_RE.test(word)) return;
      lookup(word).then((data) => {
        if (!data || pop.querySelector('.va-ielts-block')) return;
        pop.appendChild(buildBlock(data));
      }).catch(() => {});
    } catch (e) {}
  }

  /* ---------- 注册 ---------- */
  const install = (api) => {
    coreApi = api;
    api.onHook('entryPop', onEntryPop);
  };

  root.VAIELTS = { lookup, isConfigured: () => !unconfigured };
  (root.__VA_PLUGIN_DEFS__ = root.__VA_PLUGIN_DEFS__ || []).push({
    id: 'ielts', name: '雅思词库', viewOnly: true, install,
  });
})(typeof window !== 'undefined' ? window : this);
