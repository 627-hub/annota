/* Annota · textquote
 * 文章划词的文本锚点：不存坐标，存「选中文字 + 前后文」，重排/换字号后仍能定位。
 * winner of W3C Web Annotation Data Model 的 TextQuoteSelector 简化版。
 *
 * 纯函数 + 对 Range/Selection 的薄封装（依赖 window/document，与 media 同级）。
 * 可被 node 单测（用假 Range）。
 */
(function (root) {
  'use strict';
  const T = {};

  const CONTEXT_LEN = 32;   // prefix/suffix 各取多少字符

  function nodeText(node) {
    return (node && node.textContent) || '';
  }

  // 从选中 Range 序列化 TextQuoteSelector
  // range: 原生 Range；rootEl: 限定容器（用于计算 start/end 偏移与前后文）
  T.serialize = function (range, rootEl) {
    if (!range || range.collapsed) return null;
    const exact = String(range.toString ? range.toString() : '').trim();
    if (!exact) return null;

    let prefix = '', suffix = '', start = null, end = null;
    try {
      const pre = range.cloneRange();
      pre.selectNodeContents(rootEl || range.startContainer);
      pre.setEnd(range.startContainer, range.startOffset);
      const before = nodeText(pre);
      prefix = before.slice(Math.max(0, before.length - CONTEXT_LEN));
      start = before.length;

      const post = range.cloneRange();
      post.selectNodeContents(rootEl || range.endContainer);
      post.setStart(range.endContainer, range.endOffset);
      const after = nodeText(post);
      suffix = after.slice(0, CONTEXT_LEN);
      end = start + exact.length;
    } catch (e) { /* 跨节点失败时至少保留 exact */ }

    return { exact, prefix, suffix, start, end };
  };

  // 全文里找第一个匹配：优先 start/end 命中，否则 prefix+exact+suffix → exact
  T.locateText = function (quote, fullText) {
    const text = String(fullText || '');
    const exact = (quote && quote.exact) || '';
    if (!exact) return null;

    // 1) 位置命中（offset 仍指同一段）
    if (Number.isInteger(quote.start) && quote.start >= 0 &&
        text.slice(quote.start, quote.start + exact.length) === exact) {
      return { start: quote.start, end: quote.start + exact.length };
    }
    // 2) 带上下文命中（处理重复文字）
    if (quote.prefix || quote.suffix) {
      const needle = (quote.prefix || '') + exact + (quote.suffix || '');
      const at = text.indexOf(needle);
      if (at >= 0) {
        const s = at + (quote.prefix || '').length;
        return { start: s, end: s + exact.length };
      }
    }
    // 3) 退化：精确子串
    const first = text.indexOf(exact);
    if (first >= 0) return { start: first, end: first + exact.length };
    return null;
  };

  // 在 rootEl 内的纯文本里定位 quote，构造 Range
  T.locate = function (quote, rootEl) {
    if (!quote || !rootEl) return null;
    const full = nodeText(rootEl);
    const hit = T.locateText(quote, full);
    if (!hit) return null;
    try {
      const doc = rootEl.ownerDocument || document;
      const range = doc.createRange();
      range.setStart(rootEl, 0);
      range.setEnd(rootEl, 0);
      if (!T._advance(range, rootEl, hit.start, hit.end)) return null;
      return range;
    } catch (e) { return null; }
  };

  // 把 range 的边界推进到纯文本 offset [start,end)（跨文本节点）
  T._advance = function (range, rootEl, start, end) {
    const walker = (rootEl.ownerDocument || document).createTreeWalker(rootEl, 4 /* TEXT_NODE */);
    let idx = 0, doneStart = false, node;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue ? node.nodeValue.length : 0;
      if (!doneStart && idx + len >= start) {
        range.setStart(node, Math.max(0, start - idx));
        doneStart = true;
      }
      if (doneStart && idx + len >= end) {
        range.setEnd(node, Math.max(0, end - idx));
        return true;
      }
      idx += len;
    }
    return false;
  };

  // Range → 视口像素矩形列表（跨行多矩形）
  T.rectsOfRange = function (range) {
    if (!range) return [];
    const out = [];
    const list = range.getClientRects ? range.getClientRects() : null;
    if (list && list.length) {
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r.width > 0 && r.height > 0) out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
      }
      return out;
    }
    const r = range.getBoundingClientRect && range.getBoundingClientRect();
    if (r && r.width > 0) out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
    return out;
  };

  root.VATextQuote = T;
})(typeof self !== 'undefined' ? self : this);
