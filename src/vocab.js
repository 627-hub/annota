/* video-annotate · vocab search
 * 词库索引与中英联想（纯函数，可被 node 单测）。
 * 行格式: [word, phonetic, cn, pos, tag]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VASearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const CJK = /[\u3400-\u9fff]/;

  function makeIndex(rows) {
    rows = rows || [];
    // 预小写，避免每次搜索重复转换
    const lc = rows.map((r) => (r[0] || '').toLowerCase());
    function search(q, limit) {
      q = String(q || '').trim().toLowerCase();
      limit = limit || 8;
      if (!q) return [];
      const zh = CJK.test(q);
      const starts = [], contains = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (zh) {
          const cn = r[2] || '';
          if (cn.indexOf(q) >= 0) (cn.startsWith(q) ? starts : contains).push(r);
        } else {
          const w = lc[i];
          if (w.startsWith(q)) starts.push(r);
          else if (w.indexOf(q) >= 0) contains.push(r);
        }
        if (starts.length >= limit) break;
      }
      return starts.concat(contains).slice(0, limit);
    }
    return { search, size: rows.length };
  }

  return { makeIndex };
});
