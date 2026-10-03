/* ===== src/geometry.js ===== */
/* video-annotate · geometry
 * 内容区坐标：把「左上角归一化 box(x,y,w,h)」在 <video> 元素与其内容矩形之间互相换算。
 * 纯函数、无 DOM 依赖，可被 userscript 内联，也可被 node 单测 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VAGeo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // rect: {x,y,w,h} 视口坐标（元素 getBoundingClientRect）
  // intrinsic: {w,h} 视频原始分辨率（videoWidth/Height）
  // objectFit: CSS object-fit（'contain'|'cover'|'fill'|'none'|'scale-down'）
  // 同时接受 {w,h} 与 DOMRect 的 {width,height}
  function dims(rect) {
    return {
      x: rect.x, y: rect.y,
      w: rect.w != null ? rect.w : rect.width,
      h: rect.h != null ? rect.h : rect.height,
    };
  }

  function contentRect(intrinsic, rect, objectFit) {
    const r = dims(rect);
    const iw = intrinsic && intrinsic.w, ih = intrinsic && intrinsic.h;
    if (!iw || !ih) return { x: r.x, y: r.y, w: r.w, h: r.h };
    const fit = objectFit || 'contain';
    if (fit === 'fill') return { x: r.x, y: r.y, w: r.w, h: r.h };

    let sw, sh;
    if (fit === 'none') {
      sw = iw; sh = ih;                                   // 原始像素，不缩放
    } else if (fit === 'cover') {
      const s = Math.max(r.w / iw, r.h / ih); sw = iw * s; sh = ih * s;
    } else if (fit === 'scale-down') {
      const s = Math.min(1, Math.min(r.w / iw, r.h / ih)); sw = iw * s; sh = ih * s;
    } else {                                              // contain（默认）
      const s = Math.min(r.w / iw, r.h / ih); sw = iw * s; sh = ih * s;
    }
    return { x: r.x + (r.w - sw) / 2, y: r.y + (r.h - sh) / 2, w: sw, h: sh };
  }

  // 归一化 box -> 视口像素
  function boxToPixels(box, cr) {
    return {
      left: cr.x + box.x * cr.w,
      top: cr.y + box.y * cr.h,
      width: box.w * cr.w,
      height: box.h * cr.h,
    };
  }

  // 视口像素 -> 归一化 box
  function pixelsToBox(p, cr) {
    return {
      x: (p.left - cr.x) / cr.w,
      y: (p.top - cr.y) / cr.h,
      w: p.width / cr.w,
      h: p.height / cr.h,
    };
  }

  // 夹到 [0,1]，保证 x+w<=1、y+h<=1
  function clampBox(b, min) {
    const m = min || 0.005;
    let w = Math.min(1, Math.max(m, b.w));
    let h = Math.min(1, Math.max(m, b.h));
    let x = Math.min(1 - w, Math.max(0, b.x));
    let y = Math.min(1 - h, Math.max(0, b.y));
    return { x, y, w, h };
  }

  // 由拖拽起止点（视口像素）得到归一化 box（自动纠正负向拖拽）
  function dragToBox(x0, y0, x1, y1, cr) {
    const left = Math.min(x0, x1), top = Math.min(y0, y1);
    const width = Math.abs(x1 - x0), height = Math.abs(y1 - y0);
    return clampBox(pixelsToBox({ left, top, width, height }, cr));
  }

  // IoU（合并去重预留）
  function iou(a, b) {
    const ax2 = a.x + a.w, ay2 = a.y + a.h, bx2 = b.x + b.w, by2 = b.y + b.h;
    const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
    const inter = ix * iy, un = a.w * a.h + b.w * b.h - inter;
    return un > 0 ? inter / un : 0;
  }

  // 两个视口矩形是否相交（长图逐帧剔除用；接受 {x,y,w,h} 或 {left,top,width,height}）
  function intersects(a, b) {
    const ax = a.x != null ? a.x : a.left, ay = a.y != null ? a.y : a.top;
    const aw = a.w != null ? a.w : a.width, ah = a.h != null ? a.h : a.height;
    const bx = b.x != null ? b.x : b.left, by = b.y != null ? b.y : b.top;
    const bw = b.w != null ? b.w : b.width, bh = b.h != null ? b.h : b.height;
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  // 长图：整图归一化 box → 当前滚动窗口内的像素矩形（超窗口返回 null）
  // imgRect: 整图在视口的 rect（超长时 y 为负/超出视口）；viewport: {x,y,w,h}
  function scrollMap(box, imgRect, viewport) {
    const p = boxToPixels(box, imgRect);
    if (viewport && !intersects(p, viewport)) return null;
    return p;
  }

  return { contentRect, boxToPixels, pixelsToBox, clampBox, dragToBox, iou, intersects, scrollMap };
});

/* ===== src/textquote.js ===== */
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

/* ===== src/adapter.js ===== */
/* video-annotate · adapter
 * 平台适配：识别平台、页面类型、稳定 mediaId、「主视频」元素。
 * 只依赖 window/document，运行期调用。
 */
(function (root) {
  'use strict';
  const A = {};

  A.platform = function () {
    const h = location.hostname;
    if (/(^|\.)bilibili\.com$/.test(h)) return 'bilibili';
    if (/(^|\.)douyin\.com$/.test(h)) return 'douyin';
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(h)) return 'youtube';
    return 'generic';
  };

  // 是否处于「值得启用」的页面：避免在首页 feed / 搜索页对所有预览视频生效
  A.supported = function () {
    const p = A.platform();
    if (p === 'bilibili') {
      return /\/(video|bangumi\/play|cheese\/play)\b/.test(location.pathname) ||
        /(^|\/)video\//.test(location.pathname);
    }
    if (p === 'douyin') return true;   // 抖音 SPA 路径多变（feed/modal），交给「能否找到视频」来判断
    if (p === 'youtube') return location.pathname === '/watch';
    return true;                      // 通用：有足够大的可见视频即可
  };

  // 页面是否值得启用（视频优先；无视频时有足够大主图则图片，否则有正文则文章）
  A.pageSupported = function () {
    if (A.supported() && A.findVideo()) return true;
    return A.imageSupported();
  };

  // 稳定标识：优先平台内容 id，退化到 origin+pathname
  A.mediaId = function () {
    const p = A.platform();
    const path = location.pathname;
    let m;
    if (p === 'bilibili') {
      if ((m = path.match(/\/video\/(BV[0-9A-Za-z]+)/))) return 'bilibili:' + m[1];
      if ((m = path.match(/\/video\/av(\d+)/))) return 'bilibili:av' + m[1];
      if ((m = path.match(/\/bangumi\/play\/(ep\d+|ss\d+)/))) return 'bilibili:' + m[1];
      if ((m = path.match(/\/cheese\/play\/(ep\d+|ss\d+)/))) return 'bilibili:cheese:' + m[1];
      // 合集/播放列表：当前播放的 bvid 常在 query 里
      const bv = new URLSearchParams(location.search).get('bvid');
      if (bv) return 'bilibili:' + bv;
    } else if (p === 'douyin') {
      const mid = new URLSearchParams(location.search).get('modal_id');
      if (mid) return 'douyin:' + mid;
      if ((m = path.match(/\/video\/(\d+)/))) return 'douyin:' + m[1];
      if ((m = path.match(/\/note\/(\d+)/))) return 'douyin:' + m[1];
    } else if (p === 'youtube') {
      const v = new URLSearchParams(location.search).get('v');
      if (v) return 'youtube:' + v;
    }
    // 图片页：主图占页面主体时用主图 src 稳定 hash（画廊换图 → 换 key）
    if (A.imageSupported()) {
      const img = A.findImage();
      if (img && img.currentSrc) return hashId('image:' + img.currentSrc);
    }
    return p + ':' + location.origin + path;
  };

  // 轻量 32 位 hash → 36 进制短串（同图稳定、跨图区分；非加密用途）
  function hashId(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'img-' + (h >>> 0).toString(36) + '-' + s.length.toString(36);
  }

  // 主播放器候选容器（B站多套播放器版本）
  const MAIN_SELECTORS = [
    '.bpx-player-video-wrap video',
    '.bpx-player-container video',
    '#bilibili-player video',
    '.bilibili-player-video video',
    '.bilibili-player-area video',
    '.bpx-player-video-area video',
  ];

  function visible(v) {
    const r = v.getBoundingClientRect();
    if (r.width < 120 || r.height < 68) return 0;
    const cs = getComputedStyle(v);
    if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
    // 不再因 opacity:0 直接排除（部分播放器用 canvas 渲染、video 透明）；有画面的加权
    return r.width * r.height * (v.videoWidth > 0 ? 1 : 0.5);
  }

  // 穿透 shadow DOM 的 querySelectorAll（抖音等把 <video> 放在 shadow root 里）
  function deepQueryAll(sel, root) {
    const out = [], seen = new Set();
    const walk = (node) => {
      let list = [];
      try { list = node.querySelectorAll(sel); } catch (e) { A._err && A._err(e); }
      for (const el of list) out.push(el);
      let all = [];
      try { all = node.querySelectorAll('*'); } catch (e) { A._err && A._err(e); }
      for (const el of all) {
        if (el.shadowRoot && !seen.has(el.shadowRoot)) { seen.add(el.shadowRoot); walk(el.shadowRoot); }
      }
    };
    walk(root || document);
    return out;
  }

  A.allVideos = function () { return deepQueryAll('video'); };
  A.countVideos = function () { return A.allVideos().length; };

  // findVideo 结果短时缓存（同一次判定内多次调用只扫一遍 DOM）
  let _vidCache = { t: 0, v: undefined };
  A.invalidateVideoCache = function () { _vidCache = { t: 0, v: undefined }; };

  A.findVideo = function () {
    const now = Date.now();
    if (_vidCache.v !== undefined && now - _vidCache.t < 250) return _vidCache.v;
    const v = _findVideoUncached();
    _vidCache = { t: now, v };
    return v;
  };

  function _findVideoUncached() {
    const p = A.platform();
    // 平台主播放器选择器优先（B站多套播放器版本）
    if (p === 'bilibili') {
      let best = null, bestA = 0;
      for (const sel of MAIN_SELECTORS) {
        let nodes = [];
        try { nodes = document.querySelectorAll(sel); } catch (e) {}
        for (const v of nodes) { const a = visible(v); if (a > bestA) { bestA = a; best = v; } }
      }
      if (best) return best;
    }
    // 通用：穿透 shadow DOM，取可见面积最大者（readyState 高者加权）
    let best = null, bestScore = 0;
    for (const v of A.allVideos()) {
      const area = visible(v);
      if (area <= 0) continue;
      const score = area * (v.readyState >= 2 ? 1.5 : 1);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best;
  }

  // 图片可见性打分：自然尺寸 + 可见面积。小图标/头像/缩略图被尺寸门槛挡掉。
  const IMG_MIN = 200;   // 最小边（px）：低于此不视为主图
  function imgScore(img) {
    if (img.naturalWidth < IMG_MIN || img.naturalHeight < IMG_MIN) return 0;
    if (img === A.findVideo()) return 0;   // 视频封面 poster 等不抢
    const r = img.getBoundingClientRect();
    if (r.width < IMG_MIN || r.height < IMG_MIN) return 0;
    const cs = getComputedStyle(img);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return 0;
    return r.width * r.height;
  }

  A.allImages = function () { return deepQueryAll('img'); };

  // 主图：可见面积最大的「大图」（普通图片页）
  A.findImage = function () {
    let best = null, bestScore = 0;
    for (const img of A.allImages()) {
      const s = imgScore(img);
      if (s > bestScore) { bestScore = s; best = img; }
    }
    return best;
  };

  // 可见大图列表（按面积降序）。用于「单图详情页」判定与 picker。
  A.visibleImages = function () {
    const out = [];
    for (const img of A.allImages()) {
      const s = imgScore(img);
      if (s > 0) out.push({ el: img, area: s });
    }
    return out.sort((a, b) => b.area - a.area);
  };

  // 已绑为当前媒体的视频（供 imgScore 排除封面）
  A.imageIsMain = false;   // 由 core 在 attach/detach 时维护（非必须）

  const ARTICLE_SELECTORS = ['article', 'main', '[role="main"]', '.post', '.article', '.content', '#content'];
  // 自动判定图片页：**整页只有一张可见大图**（无视频、无成规模正文）。
  // 简单、可预测；多图（瀑布流/详情页带相关图）一律交给「选对象」，不做脆弱启发式猜测。
  A.imageSupported = function () {
    if (A.platform() !== 'generic') return false;
    if (A.findVideo()) return false;
    if (A.articleText()) return false;   // 有成规模正文 → 优先文章
    return A.visibleImages().length === 1;
  };

  // 页面是否存在成规模的正文块（语义容器内文本 > 600 字）
  A.articleText = function () {
    for (const sel of ARTICLE_SELECTORS) {
      let nodes = [];
      try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const n of nodes) {
        if ((n.textContent || '').trim().length > 600) return n;
      }
    }
    return null;
  };

  // 正文容器候选：语义标签优先，退化到文本量最大的块
  A.findArticle = function () {
    if (A.platform() !== 'generic') return null;
    if (A.findVideo() || A.imageSupported()) return null;   // 视频/单图详情页优先
    return A.articleText();
  };

  A.articleSupported = function () { return !!A.findArticle(); };

  // ---------- 手动选择对象（picker） ----------
  // 从任意元素向上归类为标注对象：video / img / 正文容器 / null
  const ARTICLE_TAGS = new Set(['ARTICLE', 'MAIN']);
  A.classify = function (el) {
    let node = el;
    let depth = 0;
    while (node && node !== document.body && depth < 12) {
      const tag = node.tagName;
      if (tag === 'VIDEO') return { kind: 'video', el: node };
      if (tag === 'IMG') {
        // 太小/还没加载的图不当对象
        if ((node.naturalWidth >= IMG_MIN || node.naturalHeight >= IMG_MIN) && node.complete) return { kind: 'image', el: node };
        return null;
      }
      if (ARTICLE_TAGS.has(tag) || (node.getAttribute && node.getAttribute('role') === 'main')) {
        if ((node.textContent || '').trim().length > 200) return { kind: 'article', el: node };
      }
      node = node.parentElement; depth++;
    }
    return null;
  };

  // 主媒态变化时回调（视频优先，退化图片）；回调 {kind, el} | null。
  // kind 变化、元素被替换、页面类型变化都会触发（轮询，简单可靠）。
  A.watch = function (cb, intervalMs) {
    let cur = null, curKind = null;
    const tick = () => {
      A.invalidateVideoCache();   // 每轮重新扫一遍
      let next = null, kind = null;
      if (A.supported()) {
        const v = A.findVideo();
        if (v) { next = v; kind = 'video'; }
      }
      if (!next && A.imageSupported()) {
        const img = A.findImage();
        if (img) { next = img; kind = 'image'; }
      }
      if (!next) {
        const art = A.findArticle();
        if (art) { next = art; kind = 'article'; }
      }
      if (next !== cur || kind !== curKind) {
        cur = next; curKind = kind;
        cb(next ? { kind, el: next } : null);
      }
    };
    tick();
    const t = setInterval(tick, intervalMs || 800);
    return () => clearInterval(t);
  };

  // 诊断信息（供屏上面板显示）
  A.diag = function () {
    return {
      platform: A.platform(),
      supported: A.supported(),
      mediaId: A.mediaId(),
      href: location.pathname + location.search,
      fullscreen: document.fullscreenElement ? document.fullscreenElement.tagName : null,
    };
  };

  root.VAAdapter = A;
})(typeof self !== 'undefined' ? self : this);

/* ===== src/media.js ===== */
/* Annota · media bindings
 * 把「媒态」差异收进一层：core.js 只面向 binding 接口，
 * 视频 / 图片 / 文章各自实现，互不污染。
 *
 * MediaBinding 接口（core 依赖面）：
 *   kind, timed, capture            —— 能力标记
 *   el                              —— 宿主元素（article 为 null）
 *   ready()                         —— 是否可标注（video 等尺寸、img 等 load）
 *   mediaId(), mediaMeta()          —— 标识与 pack.media
 *   layout()                        —— {rect, cr} | null（无轴媒态返回 null）
 *   entryRects(e)                   —— 像素矩形列表（渲染唯一入口）
 *   isVisible(e)                    —— 当前是否显示
 *   locate(e)                       —— 跳转/滚动到该标注
 *   time(), seek(t), setPlaying(b)  —— 时间能力（timed 才有意义）
 *   beginAnnotate(), endAnnotate()  —— 进入/退出标注模式
 *   capturePayload()                —— 提交时的 selector 数据
 *   contextText(), captureRect()    —— 给桌面豆包/agent 的上下文
 *   tick()                          —— loop 每帧调用；媒体被移除返回 false
 *   destroy()
 *
 * 纯逻辑、依赖 window/document（与 adapter/geometry 同级）。
 */
(function (root) {
  'use strict';
  const B = {};
  const LEAD = 0.15; // 与 core 的提前浮现保持一致

  /* ---------- 视频（R1 行为原样搬入） ---------- */
  function VideoBinding(el) {
    return {
      kind: 'video',
      timed: true,
      capture: 'box',
      el,

      ready() { return !!el && el.isConnected && el.videoWidth > 0; },

      mediaId() { return root.VAAdapter.mediaId(); },

      mediaMeta() {
        return {
          platform: root.VAAdapter.platform(),
          mediaId: root.VAAdapter.mediaId(),
          videoId: root.VAAdapter.mediaId(),
          type: 'video',
          url: location.href,
          title: document.title,
          intrinsic: { w: el.videoWidth, h: el.videoHeight },
        };
      },

      layout() {
        const r = el.getBoundingClientRect();
        const fit = getComputedStyle(el).objectFit || 'contain';
        const cr = root.VAGeo.contentRect({ w: el.videoWidth, h: el.videoHeight }, r, fit);
        return { rect: r, cr, fit };
      },

      // cr 由 core 从 layout() 结果传入，binding 不持有隐式状态
      entryRects(e, cr) {
        return [root.VAGeo.boxToPixels(e.box, cr)];
      },

      isVisible(e) {
        const d = e.dur || 1.0;
        return el.currentTime >= e.t - LEAD && el.currentTime <= e.t + d;
      },

      locate(e) {
        el.currentTime = Math.max(0, Number(e.t) || 0);
        el.pause();
      },

      time() { return el.currentTime; },
      seek(t) { el.currentTime = Math.max(0, Number(t) || 0); },
      setPlaying(play) { try { if (play) el.play().catch(() => {}); else el.pause(); } catch (e) {} },

      beginAnnotate() { try { el.pause(); } catch (e) {} },
      endAnnotate() { try { el.play().catch(() => {}); } catch (e) {} },

      capturePayload() { return {}; }, // 视频用 box，由 core 统一收集

      contextText() {
        const line = '进度: ' + Math.floor(el.currentTime) + 's / ' + Math.floor(el.duration || 0) + 's';
        return { progress: line };
      },
      captureRect() { return el.getBoundingClientRect(); },

      tick() { return !!el && el.isConnected; },
      destroy() {},
    };
  }

  B.video = VideoBinding;

  /* ---------- 图片（静态、无时间轴） ---------- */
  function ImageBinding(el) {
    return {
      kind: 'image',
      timed: false,
      capture: 'box',
      el,

      ready() { return !!el && el.isConnected && el.complete && el.naturalWidth > 0; },

      mediaId() { return root.VAAdapter.mediaId(); },

      mediaMeta() {
        return {
          platform: root.VAAdapter.platform(),
          mediaId: root.VAAdapter.mediaId(),
          videoId: root.VAAdapter.mediaId(),
          type: 'image',
          url: location.href,
          title: document.title,
          src: el.currentSrc || el.src || '',
          intrinsic: { w: el.naturalWidth, h: el.naturalHeight },
        };
      },

      layout() {
        const r = el.getBoundingClientRect();
        const fit = getComputedStyle(el).objectFit || 'fill';
        const cr = root.VAGeo.contentRect({ w: el.naturalWidth, h: el.naturalHeight }, r, fit);
        return { rect: r, cr, fit };
      },

      entryRects(e, cr) {
        const r = el.getBoundingClientRect();
        // 长图（超出视口）：只渲染落在当前窗口内的框，逐帧剔除，省 DOM
        if (r.height > (root.innerHeight || 0)) {
          const vp = { x: 0, y: 0, w: root.innerWidth || 0, h: root.innerHeight || 0 };
          const p = root.VAGeo.scrollMap(e.box, cr, vp);
          return p ? [p] : [];
        }
        return [root.VAGeo.boxToPixels(e.box, cr)];
      },

      // 静态图无时间维度：长图按视口剔除，短图恒显示
      isVisible(e) {
        const r = el.getBoundingClientRect();
        if (r.height > (root.innerHeight || 0)) {
          const cr = this.layout().cr;
          const vp = { x: 0, y: 0, w: root.innerWidth || 0, h: root.innerHeight || 0 };
          return !!root.VAGeo.scrollMap(e.box, cr, vp);
        }
        return true;
      },

      locate() { try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (err) {} },

      time() { return 0; },
      seek() {},
      setPlaying() {},

      beginAnnotate() {},
      endAnnotate() {},

      capturePayload() { return {}; },

      contextText() {
        return { intrinsic: el.naturalWidth + '×' + el.naturalHeight };
      },
      captureRect() { return el.getBoundingClientRect(); },

      tick() { return !!el && el.isConnected && el.complete; },
      destroy() {},
    };
  }

  B.image = ImageBinding;

  /* ---------- 文章（划词、文本锚点、无时间轴） ---------- */
  function ArticleBinding(rootEl) {
    const host = rootEl || document.body;
    return {
      kind: 'article',
      timed: false,
      capture: 'quote',
      el: null,
      rootEl: host,

      ready() { return !!host && host.isConnected; },

      mediaId() { return root.VAAdapter.mediaId(); },

      mediaMeta() {
        return {
          platform: root.VAAdapter.platform(),
          mediaId: root.VAAdapter.mediaId(),
          videoId: root.VAAdapter.mediaId(),
          type: 'article',
          url: location.href,
          title: document.title,
        };
      },

      // 无矩形内容区：overlay 覆盖整页，entryRects 直接给视口坐标
      layout() {
        const r = { x: 0, y: 0, w: root.innerWidth || 0, h: root.innerHeight || 0 };
        return { rect: r, cr: r, fit: 'page' };
      },

      entryRects(e) {
        if (!e.quote || !root.VATextQuote) return [];
        const range = root.VATextQuote.locate(e.quote, host);
        return root.VATextQuote.rectsOfRange(range);
      },

      // 文本锚点是否在当前视口可见
      isVisible(e) {
        const rects = this.entryRects(e);
        if (!rects.length) return false;
        const vp = { x: 0, y: 0, w: root.innerWidth || 0, h: root.innerHeight || 0 };
        return rects.some((r) => root.VAGeo.intersects(r, vp));
      },

      locate(e) {
        if (!e.quote || !root.VATextQuote) return;
        const range = root.VATextQuote.locate(e.quote, host);
        if (!range) return;
        try {
          const r = range.getBoundingClientRect();
          if (r && (r.top < 0 || r.bottom > (root.innerHeight || 0))) {
            const scroller = (range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer);
            if (scroller && scroller.scrollIntoView) scroller.scrollIntoView({ block: 'center' });
          }
        } catch (err) {}
      },

      time() { return 0; },
      seek() {},
      setPlaying() {},

      beginAnnotate() {},
      endAnnotate() {},

      // 核心：提交时的 TextQuoteSelector（由 core 用当前 Selection 传入 range 序列化）
      capturePayload() { return {}; },
      serializeSelection() {
        const sel = root.getSelection && root.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
        return root.VATextQuote ? root.VATextQuote.serialize(sel.getRangeAt(0), host) : null;
      },

      contextText() { return {}; },
      captureRect() { return { x: 0, y: 0, width: root.innerWidth || 0, height: root.innerHeight || 0 }; },

      tick() { return !!host && host.isConnected; },
      destroy() {},
    };
  }

  B.article = ArticleBinding;

  B.create = function (target) {
    if (!target) return null;
    if (target.kind === 'video') return VideoBinding(target.el);
    if (target.kind === 'image') return ImageBinding(target.el);
    if (target.kind === 'article') return ArticleBinding(target.el);
    return null;
  };

  root.VAMedia = B;
})(typeof self !== 'undefined' ? self : this);

/* ===== data: sync urls ===== */
window.VA_SYNC_URLS=[];

/* ===== src/design-tokens.js ===== */
/**
 * Annota 设计系统 tokens（与 product-spec.md §5.3 对齐）。
 * 页面态用 public/tokens.css；注入态用本文件的 VA_TOKENS_CSS。
 */
(function () {
  const TOKENS_CSS = `
:host, :root {
  --va-accent: #F5A623;
  --va-word: #F5A623;
  --va-comment: #38BDF8;
  --va-question: #A78BFA;
  --va-ai-suggest: rgba(255, 255, 255, 0.55);
  --va-glass-bg: rgba(17, 19, 23, 0.78);
  --va-glass-border: 1px solid rgba(255, 255, 255, 0.08);
  --va-glass-blur: blur(20px) saturate(160%);
  --va-glass-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  --va-text: #F4F5F7;
  --va-text-secondary: #A6ACB5;
  --va-text-muted: #6E747D;
  --va-success: #34C77B;
  --va-warning: #F5484D;
  --va-info: #3E82F7;
  --va-font-ui: -apple-system, "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif;
  --va-font-mono: ui-monospace, "SF Mono", "JetBrains Mono", monospace;
  --va-text-xs: 12px;
  --va-text-sm: 13px;
  --va-text-base: 14px;
  --va-text-md: 16px;
  --va-text-lg: 20px;
  --va-text-xl: 24px;
  --va-line-height: 1.5;
  --va-line-height-cjk: 1.6;
  --va-space-1: 4px;
  --va-space-2: 8px;
  --va-space-3: 12px;
  --va-space-4: 16px;
  --va-space-5: 20px;
  --va-space-6: 24px;
  --va-radius-sm: 8px;
  --va-radius-md: 12px;
  --va-radius-lg: 16px;
  --va-radius-pill: 999px;
  --va-duration-fast: 120ms;
  --va-duration-base: 200ms;
  --va-duration-slow: 240ms;
  --va-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --va-z-marks: 1;
  --va-z-dock: 2;
  --va-z-panel: 3;
  --va-z-editor: 4;
  --va-z-toast: 5;
}
.va-glass {
  background: var(--va-glass-bg);
  backdrop-filter: var(--va-glass-blur);
  -webkit-backdrop-filter: var(--va-glass-blur);
  border: var(--va-glass-border);
  box-shadow: var(--va-glass-shadow);
}
.va-text-secondary { color: var(--va-text-secondary); }
.va-text-muted { color: var(--va-text-muted); }
.va-mono { font-family: var(--va-font-mono); }
`;

  const TOKENS = {
    accent: '#F5A623',
    word: '#F5A623',
    comment: '#38BDF8',
    question: '#A78BFA',
    aiSuggest: 'rgba(255,255,255,0.55)',
    glassBg: 'rgba(17,19,23,0.78)',
    glassBorder: '1px solid rgba(255,255,255,0.08)',
    glassBlur: 'blur(20px) saturate(160%)',
    glassShadow: '0 8px 32px rgba(0,0,0,0.4)',
    text: '#F4F5F7',
    textSecondary: '#A6ACB5',
    textMuted: '#6E747D',
    success: '#34C77B',
    warning: '#F5484D',
    info: '#3E82F7',
    fontUi: '-apple-system, "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif',
    fontMono: 'ui-monospace, "SF Mono", "JetBrains Mono", monospace',
    space: [4, 8, 12, 16, 20, 24],
    radius: { sm: '8px', md: '12px', lg: '16px', pill: '999px' },
    duration: { fast: 120, base: 200, slow: 240 },
    ease: 'cubic-bezier(0.2,0.8,0.2,1)',
    z: { marks: 1, dock: 2, panel: 3, editor: 4, toast: 5 }
  };

  // 暴露给全局，供 src/core.js 在 Shadow DOM / 页面 head 中注入
  window.VA_TOKENS_CSS = TOKENS_CSS;
  window.VA_TOKENS = TOKENS;
})();

/* ===== src/overlay-theme.js ===== */
/* Annota injected UI theme (R1: GlassDock + EditorCard + SidePanel + Onboarding).
 * Loaded after design-tokens.js and before core.js. */
(function () {
  'use strict';
  window.VA_OVERLAY_CSS = (window.VA_TOKENS_CSS || '') + `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  color-scheme: dark;
}
*, *::before, *::after { box-sizing: border-box; }
button, input, select { font: inherit; }
button { color: inherit; }
.va-ui-root {
  position: fixed;
  inset: 0;
  pointer-events: none;
  isolation: isolate;
  color: var(--va-text);
  font: 13px/1.45 var(--va-font-ui);
  -webkit-font-smoothing: antialiased;
}
.va-ui-root[data-ui-hidden="1"] .va-panel,
.va-ui-root[data-ui-hidden="1"] .va-dock,
.va-ui-root[data-ui-hidden="1"] .va-toast,
.va-ui-root[data-ui-hidden="1"] .va-more-menu,
.va-ui-root[data-ui-hidden="1"] .va-menu,
.va-ui-root[data-ui-hidden="1"] .va-popover,
.va-ui-root[data-ui-hidden="1"] .va-diag,
.va-ui-root[data-ui-hidden="1"] .va-probe,
.va-ui-root[data-ui-hidden="1"] .va-pick-box,
.va-ui-root[data-ui-hidden="1"] .va-pick-hint,
.va-ui-root[data-ui-hidden="1"] .va-onb,
.va-ui-root[data-ui-hidden="1"] .va-export-progress { visibility:hidden !important; opacity:0 !important; pointer-events:none !important; }

.va-export-progress {
  position:fixed; z-index:2147483007; top:16px; left:50%; transform:translateX(-50%);
  display:flex; align-items:center; gap:10px; min-width:190px; max-width:min(440px,calc(100vw - 24px));
  padding:8px 10px 9px 13px; overflow:hidden; pointer-events:auto;
  border:1px solid rgba(255,255,255,.12); border-radius:999px;
  background:rgba(17,19,23,.88); color:#e7e8eb; font:11px/1.2 var(--va-font-ui);
  -webkit-backdrop-filter:blur(20px) saturate(150%); backdrop-filter:blur(20px) saturate(150%);
  box-shadow:0 10px 32px rgba(0,0,0,.38),inset 0 1px rgba(255,255,255,.05);
}
.va-export-progress > span { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.va-export-progress-track { position:relative; display:block; width:62px; height:3px; flex:none; overflow:hidden; border-radius:999px; background:rgba(255,255,255,.12); }
.va-export-progress-fill { display:block; width:0; height:100%; border-radius:inherit; background:var(--va-accent); box-shadow:0 0 8px rgba(245,166,35,.52); transition:width 140ms ease; }
.va-export-progress button {
  min-height:24px; padding:0 8px; border:1px solid rgba(245,166,35,.24); border-radius:999px;
  background:rgba(245,166,35,.09); color:#f0d2a0; font:550 10px var(--va-font-ui); cursor:pointer;
}
.va-export-progress button:hover { background:rgba(245,166,35,.17); color:#fff0d4; }

/* 可见性：快捷条 / 眼睛按钮 / 隐藏行 */
.va-vis-bar { display:flex; gap:6px; padding:0 14px 8px; }
.va-vis-bar .va-chip { font-size:11px; }
.va-entry-eye { width:24px; height:24px; flex:none; opacity:.62; }
.va-entry-eye:hover { opacity:1; }
.va-entry-row.is-hidden { opacity:.45; }
.va-entry-row.is-hidden .va-entry-copy strong { text-decoration:line-through; }

/* 手动确认截图条 */
.va-export-confirm {
  position:fixed; z-index:2147483008; bottom:24px; left:50%; transform:translateX(-50%);
  display:flex; align-items:center; gap:10px; max-width:min(560px,calc(100vw - 24px));
  padding:10px 12px 10px 16px; border:1px solid rgba(255,255,255,.12); border-radius:999px;
  background:rgba(17,19,23,.9); color:#e7e8eb; font:12px/1.3 var(--va-font-ui);
  -webkit-backdrop-filter:blur(20px) saturate(150%); backdrop-filter:blur(20px) saturate(150%);
  box-shadow:0 10px 32px rgba(0,0,0,.42),inset 0 1px rgba(255,255,255,.05); pointer-events:auto;
}
.va-export-confirm-text { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.va-export-clock { flex:none; font:600 12px ui-monospace,monospace; color:#f0d2a0; }
.va-export-confirm button {
  min-height:28px; padding:0 12px; border-radius:999px; cursor:pointer; font:550 12px var(--va-font-ui);
  border:1px solid rgba(245,166,35,.3); background:rgba(245,166,35,.12); color:#f0d2a0;
}
.va-export-confirm button:first-of-type:hover { background:rgba(245,166,35,.22); color:#fff0d4; }

/* 标签编辑（通用批注） */
.va-tag-box {
  display:flex; flex-wrap:wrap; gap:5px; align-items:center; min-height:34px; padding:5px 7px;
  border:1px solid rgba(255,255,255,.12); border-radius:8px; background:rgba(255,255,255,.04);
}
.va-tag-box:focus-within { border-color:rgba(245,166,35,.55); }
.va-tag-chip {
  display:inline-flex; align-items:center; gap:4px; padding:2px 4px 2px 8px; border-radius:999px;
  background:rgba(245,166,35,.13); color:#f0d2a0; font-size:11px;
}
.va-tag-chip .va-tag-x { width:16px; height:16px; opacity:.7; }
.va-tag-chip .va-tag-x:hover { opacity:1; }
.va-tag-input { flex:1 1 90px; min-width:80px; border:0; outline:0; background:transparent; color:var(--va-text); font:inherit; padding:3px 2px; }
.va-tag-presets { display:flex; flex-wrap:wrap; gap:5px; margin-top:6px; }
.va-tag-presets .va-chip { font-size:11px; }

/* ---------- 更多菜单（⚙ 浮层） ---------- */
.va-more-menu {
  position: fixed;
  right: 24px;
  bottom: 88px;
  z-index: 2147483003;
  width: min(320px, calc(100vw - 32px));
  max-height: min(70vh, 560px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px;
  pointer-events: auto;
  border: 1px solid rgba(255,255,255,.105);
  border-radius: 16px;
  background: rgba(16,18,22,.96);
  -webkit-backdrop-filter: blur(22px) saturate(145%);
  backdrop-filter: blur(22px) saturate(145%);
  box-shadow: 0 18px 52px rgba(0,0,0,.5), inset 0 1px rgba(255,255,255,.055);
  color: var(--va-text);
  font: 12px/1.5 var(--va-font-ui);
}
.va-more-menu .va-btn { width: 100%; justify-content: flex-start; margin: 1px 0; }
.va-more-menu .va-btn.is-active { border-color: rgba(245,166,35,.35); background: rgba(245,166,35,.12); color: #f3d4a2; }
.va-more-menu .va-input { width: 100%; margin-top: 4px; }
.va-dock[data-side="left"] ~ .va-more-menu { right: auto; left: 24px; }

/* ---------- 手动选择对象（picker） ---------- */
.va-pick-box {
  position: fixed;
  z-index: 2147483001;
  pointer-events: none;
  border: 2px solid var(--va-accent);
  border-radius: 4px;
  background: rgba(245,166,35,.08);
  box-shadow: 0 0 0 9999px rgba(0,0,0,.28);
  transition: left 60ms linear, top 60ms linear, width 60ms linear, height 60ms linear;
}
.va-pick-hint {
  position: fixed;
  z-index: 2147483002;
  left: 50%;
  top: 16px;
  transform: translateX(-50%);
  pointer-events: none;
  padding: 8px 14px;
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 10px;
  background: rgba(16,18,22,.94);
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
  color: #d5d8dc;
  font: 12px/1.4 var(--va-font-ui);
  box-shadow: 0 10px 30px rgba(0,0,0,.4);
}
.va-pick-hint[data-valid="1"] { border-color: rgba(245,166,35,.4); color: #f3d4a2; }

/* ---------- GlassDock（C1） ---------- */
.va-dock {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 2147483002;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 48px;
  padding: 4px;
  pointer-events: auto;
  border: 1px solid rgba(255,255,255,.105);
  border-radius: 999px;
  background: rgba(16,18,22,.84);
  -webkit-backdrop-filter: blur(22px) saturate(145%);
  backdrop-filter: blur(22px) saturate(145%);
  box-shadow: 0 14px 42px rgba(0,0,0,.42), inset 0 1px rgba(255,255,255,.055);
  transition: height var(--va-duration-base) var(--va-ease), border-radius var(--va-duration-base) var(--va-ease), transform var(--va-duration-base) var(--va-ease), opacity var(--va-duration-base) var(--va-ease);
}
.va-dock[data-side="left"] { right: auto; left: 24px; }
.va-dock[data-grow="1"] { animation: va-dock-grow 520ms var(--va-ease) both; }
.va-dock-fab {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  flex: none;
  border: 1px solid rgba(245,166,35,.3);
  border-radius: 50%;
  background: rgba(245,166,35,.12);
  color: var(--va-accent);
  cursor: pointer;
  transition: background var(--va-duration-fast) ease, transform var(--va-duration-fast) ease;
}
.va-dock-fab:hover { background: rgba(245,166,35,.2); }
.va-dock-fab:active { transform: scale(.94); }
.va-dock-fab svg { width: 20px; height: 20px; }
.va-dock-fab.is-breathing { animation: va-breathe 2.6s ease-in-out infinite; }
/* 收起态只露圆钮；hover / 点开 / 键盘聚焦时展开 */
.va-dock > .va-action, .va-dock > .va-sync-badge { display: none; }
.va-dock:hover, .va-dock[data-open="1"], .va-dock:focus-within { height: 56px; padding: 6px 8px; border-radius: 20px; }
.va-dock:hover > .va-dock-fab, .va-dock[data-open="1"] > .va-dock-fab, .va-dock:focus-within > .va-dock-fab { display: none; }
.va-dock:hover > .va-action, .va-dock[data-open="1"] > .va-action, .va-dock:focus-within > .va-action { display: inline-flex; }
.va-dock:hover > .va-sync-badge, .va-dock[data-open="1"] > .va-sync-badge, .va-dock:focus-within > .va-sync-badge { display: grid; }
.va-action {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 38px;
  min-width: 38px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: #c6cbd2;
  font-size: 12px;
  font-weight: 560;
  white-space: nowrap;
  cursor: pointer;
  pointer-events: auto;
  transition: background var(--va-duration-fast) var(--va-ease), color var(--va-duration-fast) var(--va-ease), border-color var(--va-duration-fast) var(--va-ease), transform var(--va-duration-fast) var(--va-ease);
}
.va-action:hover { background: rgba(255,255,255,.075); color: #fff; }
.va-action:active { transform: scale(.96); }
.va-action svg { width: 17px; height: 17px; flex: none; }
.va-action.is-active {
  border-color: rgba(245,166,35,.24);
  background: rgba(245,166,35,.13);
  color: #ffd18a;
}
.va-action-chev { padding: 0 5px; }
.va-action-chev svg { width: 13px; height: 13px; }
.va-action-primary {
  padding: 0 13px;
  border-color: rgba(255,214,148,.34);
  background: var(--va-accent);
  color: #241707;
  font-weight: 700;
  box-shadow: 0 2px 9px rgba(245,166,35,.18), inset 0 1px rgba(255,255,255,.3);
}
.va-action-primary:hover { background: #ffb842; color: #211506; }
/* 同步状态徽标：badge / spinner / ✓ 淡出 */
.va-sync-badge {
  position: absolute;
  top: -5px;
  right: -3px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  place-items: center;
  border-radius: 999px;
  background: var(--va-accent);
  color: #241707;
  font: 700 9px/17px var(--va-font-mono);
  text-align: center;
  box-shadow: 0 2px 8px rgba(0,0,0,.35);
  pointer-events: none;
}
.va-action.is-busy svg { animation: va-spin 900ms linear infinite; }
.va-action.is-done { border-color: rgba(52,199,123,.5); color: #7fe0ae; }
.va-action.is-done::after { content: '\\2713'; position: absolute; top: -7px; right: -1px; font: 700 10px var(--va-font-ui); color: var(--va-success); animation: va-fade-check 800ms ease forwards; }

/* ---------- 分组 popover 菜单 ---------- */
.va-popover.va-menu-pop { width: 216px; padding: 7px; display: flex; flex-direction: column; gap: 2px; }
.va-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: #c7cbd1;
  font: 550 11px var(--va-font-ui);
  cursor: pointer;
  text-align: left;
}
.va-menu-item:hover { background: rgba(255,255,255,.075); color: #fff; }
.va-menu-item small { color: #717985; font-size: 9px; font-weight: 450; }
.va-menu-item .va-check { color: var(--va-accent); font-weight: 700; }
.va-menu-sep { height: 1px; margin: 4px 3px; background: rgba(255,255,255,.08); }
.va-menu-title { padding: 6px 9px 5px; color: #737b85; font-size: 9px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.va-menu-pop > .va-btn { justify-content: flex-start; width: 100%; padding-left: 10px; }
.va-menu-row { display: flex; gap: 5px; margin-top: 5px; }
.va-menu-row > .va-btn { min-width: 0; flex: 1; padding: 0 5px; font-size: 10px; }

/* ---------- 标注框（§6.1） ---------- */
.va-mark { border:1.5px solid var(--va-word); border-radius:5px; background:rgba(245,166,35,.105); pointer-events:auto; cursor:pointer; transition:background 120ms ease, box-shadow 120ms ease; }
.va-mark:hover { background:rgba(245,166,35,.19); box-shadow:0 0 0 2px rgba(245,166,35,.12); }
.va-mark.is-hl { background:rgba(245,166,35,.28); box-shadow:0 0 0 3px rgba(245,166,35,.2); }
.va-mark.is-stale { border-color:#ef7379; border-style:dashed; background:rgba(239,115,121,.08); }
.va-mark.is-stale .va-mark-label { border-color:rgba(239,115,121,.4); color:#f0b0b4; }
.va-mark.is-flash { animation: va-flash 160ms ease; }
.va-mark-label { position:absolute; left:-1px; top:-24px; display:inline-flex; align-items:center; gap:5px; max-width:min(240px,70vw); overflow:hidden; padding:3px 8px; border:1px solid rgba(245,166,35,.28); border-radius:8px; background:rgba(18,20,24,.94); color:#f3d4a2; font:600 10px/1.35 var(--va-font-ui); text-overflow:ellipsis; white-space:nowrap; box-shadow:0 4px 12px rgba(0,0,0,.22); }
.va-mark-label::before { content:""; width:5px; height:5px; flex:none; border-radius:50%; background:var(--va-word); }
.va-draft-mark { border:1.5px dashed #f5a623; border-radius:5px; background:rgba(245,166,35,.12); box-shadow:0 0 0 3px rgba(245,166,35,.06); }

/* ---------- SidePanel（C4） ---------- */
.va-panel {
  position: fixed;
  top: 16px;
  right: 16px;
  bottom: 88px;
  z-index: 2147483003;
  display: flex;
  flex-direction: column;
  width: min(360px, calc(100vw - 24px));
  overflow: hidden;
  pointer-events: auto;
  border: 1px solid rgba(255,255,255,.11);
  border-radius: 20px;
  background: rgba(17,19,23,.965);
  -webkit-backdrop-filter: blur(24px) saturate(150%);
  backdrop-filter: blur(24px) saturate(150%);
  box-shadow: 0 22px 70px rgba(0,0,0,.48), inset 0 1px rgba(255,255,255,.045);
  transform: translateX(calc(100% + 28px));
  opacity: 0;
  visibility: hidden;
  transition: transform 230ms var(--va-ease), opacity 180ms ease, visibility 230ms;
}
.va-panel.is-open { transform: translateX(0); opacity: 1; visibility: visible; }
.va-panel-head { display:flex; align-items:center; gap:12px; padding:18px 18px 13px; border-bottom:1px solid rgba(255,255,255,.075); }
.va-panel-title { min-width:0; flex:1; }
.va-panel-title strong { display:block; font-size:15px; font-weight:650; letter-spacing:-.02em; }
.va-panel-title span { display:block; overflow:hidden; margin-top:3px; color:var(--va-text-muted); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.va-close {
  display:grid; place-items:center; width:32px; height:32px; border:0; border-radius:10px;
  background:rgba(255,255,255,.055); color:#abb2bb; cursor:pointer;
}
.va-close:hover { background:rgba(255,255,255,.11); color:white; }
.va-close svg, .va-entry-more svg, .va-probe svg { width:15px; height:15px; flex:none; }
.va-panel-tabs { display:flex; gap:4px; padding:12px 16px 8px; }
.va-tab { padding:7px 11px; border:1px solid transparent; border-radius:9px; background:transparent; color:#858c96; font-size:11px; cursor:pointer; }
.va-tab:hover { color:#d4d7dc; background:rgba(255,255,255,.04); }
.va-tab.is-active { color:#ffd18a; border-color:rgba(245,166,35,.2); background:rgba(245,166,35,.1); }
.va-panel-search { padding:4px 16px 12px; }
.va-panel-tools { display:flex; gap:6px; padding:0 16px 10px; }
.va-panel-tools .va-btn { flex:1; min-height:30px; }
.va-input, .va-select {
  width:100%; min-width:0; height:38px; padding:0 11px; border:1px solid rgba(255,255,255,.105); border-radius:10px;
  background:rgba(255,255,255,.045); color:var(--va-text); font:13px var(--va-font-ui); outline:none;
}
.va-input::placeholder { color:#69717b; }
.va-input:focus, .va-select:focus { border-color:rgba(245,166,35,.65); box-shadow:0 0 0 3px rgba(245,166,35,.1); }
.va-input-mono { font-family: var(--va-font-mono); font-size: 12px; }
.va-entry-list { flex:1; min-height:0; overflow:auto; padding:0 10px 14px; scrollbar-width:thin; scrollbar-color:rgba(255,255,255,.16) transparent; }
.va-entry-group { padding:8px 8px 4px; color:#717985; font-size:10px; font-weight:650; letter-spacing:.08em; text-transform:uppercase; }
.va-entry-row {
  display:flex; align-items:center; gap:10px; width:100%; min-height:56px; padding:9px 10px; border:1px solid transparent;
  border-radius:12px; background:transparent; color:var(--va-text); text-align:left; cursor:pointer;
  transition:background var(--va-duration-fast) ease, border-color var(--va-duration-fast) ease;
}
.va-entry-row:hover { border-color:rgba(255,255,255,.075); background:rgba(255,255,255,.045); }
.va-entry-idx { display:grid; place-items:center; min-width:23px; height:23px; padding:0 3px; flex:none; border:1px solid rgba(255,255,255,.12); border-radius:7px; color:#89919b; font:600 9px var(--va-font-mono); transition:all 120ms ease; }
.va-entry-row:hover .va-entry-idx { color:#ffd18a; border-color:rgba(245,166,35,.35); background:rgba(245,166,35,.08); }
.va-entry-code { flex:none; padding:3px 6px; border:1px solid rgba(245,166,35,.14); border-radius:7px; background:rgba(245,166,35,.06); color:#eab76b; font:10px var(--va-font-mono); }
.va-entry-copy { min-width:0; flex:1; }
.va-entry-copy strong { display:block; overflow:hidden; font-size:13px; font-weight:620; text-overflow:ellipsis; white-space:nowrap; }
.va-entry-copy span { display:block; overflow:hidden; margin-top:3px; color:#89919b; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.va-entry-more { display:grid; place-items:center; width:28px; height:28px; flex:none; border:0; border-radius:8px; background:transparent; color:#7d8590; cursor:pointer; }
.va-entry-more:hover { background:rgba(255,255,255,.08); color:white; }
.va-empty { display:grid; place-items:center; min-height:180px; padding:24px; color:#9299a3; text-align:center; align-content:center; }
.va-empty-mark { display:grid; place-items:center; width:40px; height:40px; margin-bottom:12px; border:1px solid rgba(245,166,35,.2); border-radius:13px; background:rgba(245,166,35,.08); color:var(--va-accent); }
.va-empty strong { display:block; color:#d9dce1; font-size:13px; font-weight:600; }
.va-empty span { display:block; max-width:230px; margin-top:5px; color:#7d8590; font-size:11px; line-height:1.5; }
.va-empty-action { margin-top:14px; pointer-events:auto; }
.va-panel-foot { padding:12px 18px; border-top:1px solid rgba(255,255,255,.07); color:#77808b; font-size:10px; }
.va-src-row { display:flex; align-items:center; gap:8px; margin:4px 0; padding:10px 12px; border:1px solid rgba(255,255,255,.08); border-radius:12px; background:rgba(255,255,255,.03); font-size:12px; }
.va-src-name { font-weight:620; }
.va-src-tag { padding:2px 7px; border-radius:999px; background:rgba(245,166,35,.12); color:#ffd18a; font-size:9px; }
.va-src-count { margin-left:auto; color:#89919b; font-size:10px; }
.va-src-note { margin:10px 2px 0; padding:10px 12px; border:1px dashed rgba(255,255,255,.1); border-radius:10px; color:#7d8590; font-size:10px; line-height:1.55; }
.va-assistant { display:none; flex:1; min-height:0; flex-direction:column; }
.va-assistant-notice { flex:none; color:#e9c98f; font-size:10px; line-height:1.5; }
.va-assistant-notice:empty { display:none; }
.va-assistant-notice[data-state="error"] { margin:0 15px 8px; padding:9px 11px; border:1px solid rgba(240,113,120,.25); border-radius:10px; background:rgba(240,113,120,.07); color:#ffc6c9; }
.va-chat-transcript { display:flex; flex:1; min-height:0; flex-direction:column; gap:9px; overflow:auto; padding:4px 14px 14px; scrollbar-width:thin; scrollbar-color:rgba(255,255,255,.16) transparent; }
.va-chat-message { max-width:92%; padding:10px 12px; border:1px solid rgba(255,255,255,.075); border-radius:13px; background:rgba(255,255,255,.035); }
.va-chat-user { align-self:flex-end; border-color:rgba(245,166,35,.2); background:rgba(245,166,35,.085); }
.va-chat-assistant, .va-chat-notice { align-self:flex-start; }
.va-chat-role { display:block; margin-bottom:4px; color:#b08b56; font-size:9px; font-weight:700; letter-spacing:.06em; }
.va-chat-copy { margin:0; color:#e1e2e5; font-size:12px; line-height:1.6; overflow-wrap:anywhere; white-space:pre-wrap; }
.va-chat-form { display:flex; flex:none; align-items:flex-end; gap:8px; padding:11px 13px 13px; border-top:1px solid rgba(255,255,255,.075); background:rgba(12,14,17,.45); }
.va-chat-input { flex:1; min-width:0; min-height:42px; max-height:120px; resize:vertical; padding:10px 11px; border:1px solid rgba(255,255,255,.105); border-radius:11px; outline:none; background:rgba(255,255,255,.045); color:var(--va-text); font:12px/1.45 var(--va-font-ui); }
.va-chat-input::placeholder { color:#69717b; }
.va-chat-input:focus { border-color:rgba(245,166,35,.65); box-shadow:0 0 0 3px rgba(245,166,35,.1); }
.va-chat-form .va-btn { min-height:38px; flex:none; }
.va-chat-form .va-btn:disabled, .va-audit-actions .va-btn:disabled { opacity:.55; cursor:wait; }
.va-audit-card { flex:none; padding:10px 11px; border:1px solid rgba(245,166,35,.2); border-radius:12px; background:rgba(245,166,35,.045); color:#d5d8dc; font-size:10px; }
.va-audit-card summary { display:flex; align-items:center; justify-content:space-between; gap:8px; cursor:pointer; list-style:none; }
.va-audit-card summary::-webkit-details-marker { display:none; }
.va-audit-card summary strong { color:#f0d2a0; font-size:11px; }
.va-audit-state { color:#8f98a3; font-size:9px; }
.va-audit-label, .va-audit-card > span { display:block; margin:10px 0 4px; color:#8b929c; font-size:9px; font-weight:650; }
.va-audit-data { max-height:150px; overflow:auto; margin:0; padding:8px; border:1px solid rgba(255,255,255,.06); border-radius:8px; background:rgba(0,0,0,.18); color:#b7c0ca; font:9px/1.5 var(--va-font-mono); white-space:pre-wrap; overflow-wrap:anywhere; }
.va-audit-actions { display:flex; justify-content:flex-end; gap:6px; margin-top:9px; }
.va-audit-actions .va-btn { min-height:29px; }
.va-audit-actions .va-btn-danger { color:#f2a2a5; }
.va-audit-card summary:focus-visible, .va-audit-actions .va-btn:focus-visible {
  outline:2px solid var(--va-accent);
  outline-offset:2px;
}

/* ---------- EditorCard / WordCard（C3/C6，根节点统一 .va-popover） ---------- */
.va-popover {
  position:fixed; z-index:2147483004; width:min(304px,calc(100vw - 24px)); max-height:calc(100vh - 24px); overflow:auto;
  padding:17px; border:1px solid rgba(255,255,255,.13); border-radius:17px; background:rgba(19,21,25,.975);
  color:var(--va-text); box-shadow:0 24px 70px rgba(0,0,0,.56), inset 0 1px rgba(255,255,255,.045);
  -webkit-backdrop-filter:blur(24px) saturate(140%); backdrop-filter:blur(24px) saturate(140%);
  pointer-events:auto; animation:va-pop-in 150ms var(--va-ease) both;
}
.va-popover[data-ai="1"] { border-style:dashed; border-color:rgba(245,166,35,.58); box-shadow:0 24px 70px rgba(0,0,0,.56), 0 0 0 3px rgba(245,166,35,.06); }
@keyframes va-pop-in { from { opacity:0; transform:translateY(5px) scale(.985); } to { opacity:1; transform:translateY(0) scale(1); } }
.va-pop-head { display:flex; align-items:flex-start; gap:12px; margin-bottom:15px; }
.va-pop-heading { min-width:0; flex:1; }
.va-eyebrow { margin-bottom:5px; color:#9b8260; font-size:9px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
.va-pop-heading strong { display:block; font-size:15px; font-weight:650; letter-spacing:-.02em; }
.va-pop-heading span { display:block; margin-top:3px; color:#7f8792; font-size:11px; }
.va-field-label { display:block; margin:12px 0 6px; color:#9da4ad; font-size:10px; font-weight:620; }
.va-time-row { display:grid; grid-template-columns:1fr auto; gap:8px; align-items:center; }
.va-duration { display:flex; gap:5px; margin-top:7px; }
.va-chip { height:26px; padding:0 9px; border:1px solid rgba(255,255,255,.1); border-radius:8px; background:rgba(255,255,255,.035); color:#aeb4bc; font-size:10px; cursor:pointer; }
.va-chip:hover { border-color:rgba(245,166,35,.4); color:#ffd18a; }
.va-chip.is-active { border-color:rgba(245,166,35,.38); background:rgba(245,166,35,.12); color:#ffd18a; }
.va-dur-row { display:flex; align-items:center; gap:6px; margin-top:7px; }
.va-dur-row .va-input { width:64px; height:28px; padding:0 8px; font-family:var(--va-font-mono); font-size:11px; }
.va-scrub { position:relative; height:20px; margin:10px 0 2px; cursor:pointer; touch-action:none; }
.va-scrub::before { content:''; position:absolute; left:0; right:0; top:9px; height:2px; border-radius:2px; background:rgba(255,255,255,.14); }
.va-scrub-fill { position:absolute; left:0; top:9px; height:2px; border-radius:2px; background:var(--va-accent); }
.va-scrub-thumb { position:absolute; top:5px; left:0; width:10px; height:10px; margin-left:-5px; border-radius:50%; background:var(--va-accent); box-shadow:0 0 0 3px rgba(245,166,35,.22); }
.va-editor-hint { display:flex; align-items:center; gap:7px; margin:0 0 10px; padding:7px 10px; border:1px dashed rgba(245,166,35,.4); border-radius:10px; background:rgba(245,166,35,.08); color:#f0d2a0; font-size:11px; }
.va-editor-hint svg { width:13px; height:13px; flex:none; color:var(--va-accent); }
.va-dictionary { display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-top:12px; padding-top:11px; border-top:1px solid rgba(255,255,255,.07); }
.va-dictionary-label { margin-right:2px; color:#737b85; font-size:10px; }
.va-dictionary a { color:#c4a36f; font-size:10px; text-decoration:none; }
.va-dictionary a:hover { color:#ffd18a; text-decoration:underline; }
.va-quote-preview { margin:2px 0 4px; padding:8px 10px; border-left:2px solid var(--va-word); background:rgba(245,166,35,.06); color:#e6decf; font:12px/1.5 var(--va-font-ui); border-radius:0 6px 6px 0; max-height:88px; overflow:auto; }
.va-quote-preview::before { content:"“"; }
.va-quote-preview::after { content:"”"; }
.va-entry-time--none { font-size:12px; opacity:.7; }
.va-pop-actions { display:flex; justify-content:flex-end; gap:7px; margin-top:16px; }
.va-range { margin:0 0 4px; color:#bf9a62; font:10px var(--va-font-mono); }
.va-btn { display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:34px; padding:0 11px; border:1px solid rgba(255,255,255,.1); border-radius:9px; background:rgba(255,255,255,.055); color:#c7cbd1; font:550 11px var(--va-font-ui); cursor:pointer; transition:all 120ms ease; }
.va-btn:hover { border-color:rgba(255,255,255,.18); background:rgba(255,255,255,.095); color:#fff; }
.va-btn-primary { border-color:rgba(255,214,148,.32); background:var(--va-accent); color:#241707; font-weight:700; }
.va-btn-primary:hover { border-color:#ffc66a; background:#ffb842; color:#211506; }
.va-btn-danger { color:#ed9298; }

/* ---------- Onboarding 气泡（C8） ---------- */
.va-onb {
  position:fixed; z-index:2147483006; width:250px; padding:12px 13px 10px;
  border:1px solid rgba(245,166,35,.3); border-radius:14px; background:rgba(19,21,25,.97);
  box-shadow:0 18px 50px rgba(0,0,0,.5), 0 0 0 3px rgba(245,166,35,.05);
  pointer-events:auto; animation:va-pop-in 180ms var(--va-ease) both;
}
.va-onb::before { content:''; position:absolute; left:28px; bottom:-6px; width:10px; height:10px; transform:rotate(45deg); border-right:1px solid rgba(245,166,35,.3); border-bottom:1px solid rgba(245,166,35,.3); background:rgba(19,21,25,.97); }
.va-onb-text { color:#e8e2d6; font-size:11px; line-height:1.55; }
.va-onb-row { display:flex; justify-content:flex-end; gap:6px; margin-top:9px; }
.va-onb-ok { min-height:26px; padding:0 10px; border:1px solid rgba(255,214,148,.32); border-radius:8px; background:var(--va-accent); color:#241707; font:700 10px var(--va-font-ui); cursor:pointer; }
.va-onb-skip { min-height:26px; padding:0 10px; border:1px solid transparent; border-radius:8px; background:transparent; color:#8b939d; font:10px var(--va-font-ui); cursor:pointer; }
.va-onb-skip:hover { color:#d4d7dc; }

/* ---------- 反馈件 ---------- */
.va-toast { position:fixed; left:50%; bottom:94px; z-index:2147483005; max-width:min(520px,calc(100vw - 28px)); padding:10px 15px; border:1px solid rgba(255,255,255,.12); border-radius:12px; background:rgba(18,20,24,.96); color:#e8e9ec; font:12px/1.45 var(--va-font-ui); box-shadow:0 10px 35px rgba(0,0,0,.42); transform:translate(-50%,8px); opacity:0; transition:opacity 150ms ease, transform 150ms var(--va-ease); pointer-events:none; }
.va-toast.is-visible { opacity:1; transform:translate(-50%,0); }
.va-toast.is-error { border-color:rgba(240,113,120,.42); color:#ffd1d3; }
.va-diag { position:fixed; right:22px; bottom:86px; z-index:2147483004; width:min(560px,calc(100vw - 24px)); max-height:58vh; overflow:auto; margin:0; padding:15px; border:1px solid rgba(255,255,255,.11); border-radius:14px; background:rgba(12,14,17,.975); color:#a7c6e8; font:11px/1.6 var(--va-font-mono); white-space:pre-wrap; box-shadow:0 20px 60px rgba(0,0,0,.5); pointer-events:auto; }
.va-probe { position:fixed; right:22px; bottom:22px; z-index:2147483001; display:flex; align-items:center; gap:8px; padding:10px 13px; border:1px solid rgba(245,166,35,.24); border-radius:12px; background:rgba(17,19,23,.94); color:#f0d2a0; font:11px var(--va-font-ui); box-shadow:0 10px 30px rgba(0,0,0,.4); cursor:pointer; pointer-events:auto; }
.va-probe:hover { border-color:rgba(245,166,35,.5); }

/* ---------- 动效 ---------- */
@keyframes va-dock-grow { 0% { opacity:0; transform:scale(.2); } 60% { opacity:1; transform:scale(1.06); } 100% { opacity:1; transform:scale(1); } }
@keyframes va-breathe { 0%,100% { box-shadow:0 0 0 0 rgba(245,166,35,.38); } 50% { box-shadow:0 0 0 9px rgba(245,166,35,0); } }
@keyframes va-spin { to { transform:rotate(360deg); } }
@keyframes va-fade-check { 0% { opacity:1; transform:translateY(0); } 100% { opacity:0; transform:translateY(-6px); } }
@keyframes va-flash { 0% { box-shadow:0 0 0 0 rgba(245,166,35,.7); } 100% { box-shadow:0 0 0 12px rgba(245,166,35,0); } }

.va-reduced-motion *, .va-reduced-motion *::before, .va-reduced-motion *::after { animation-duration:.01ms !important; transition-duration:.01ms !important; }
.va-action:focus-visible, .va-btn:focus-visible, .va-input:focus-visible, .va-select:focus-visible, .va-menu-item:focus-visible, .va-dock-fab:focus-visible, .va-chip:focus-visible, .va-entry-row:focus-visible, .va-onb-ok:focus-visible, .va-onb-skip:focus-visible, .va-tab:focus-visible {
  outline: 2px solid var(--va-accent);
  outline-offset: 2px;
}
.va-chat-input:focus-visible { outline:2px solid var(--va-accent); outline-offset:2px; }
@media (max-width: 768px) {
  .va-dock { right:12px; bottom:12px; }
  .va-dock[data-side="left"] { left:12px; }
  .va-action { width:38px; padding:0; justify-content:center; }
  .va-action-label { display:none; }
  .va-action-primary { width:auto; padding:0 11px; }
  .va-panel { top:auto; right:8px; bottom:8px; left:8px; width:auto; height:70vh; border-radius:18px; transform:translateY(calc(100% + 24px)); }
  .va-panel.is-open { transform:translateY(0); }
  .va-popover { left:12px !important; right:12px; bottom:76px; top:auto !important; width:auto; }
  .va-onb { width:calc(100vw - 24px); }
  .va-probe { right:10px; bottom:10px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior:auto !important; animation-duration:.01ms !important; transition-duration:.01ms !important; }
}
`;
})();

/* ===== src/export.js ===== */
/* Annota · local learning-card export. Loaded before core.js. */
(function (root) {
  'use strict';

  const EXPORT_PREFIX = 'va:export:';
  let core = null;
  let state = 'idle';
  let done = 0;
  let total = 0;
  let current = '';
  let paused = false;
  let cancelled = false;
  let running = false;
  let progressEl = null;
  let progressText = null;
  let progressFill = null;
  let cancelButton = null;
  let warnedCapture = false;

  function capabilities() {
    // TODO: wire the native Tauri window.vaCapture driver in app/annota/src/main.rs;
    // the Rust bridge is out of scope here (see docs/architecture.md ADR-6).
    try { if (typeof root.vaCapture === 'function') return { capture: 'tauri' }; } catch (e) {}
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        return { capture: 'extension' };
      }
    } catch (e) {}
    return { capture: 'canvas' };
  }

  function ensureProgress() {
    if (!core || !core.uiRoot || progressEl) return;
    try {
      const doc = core.uiRoot.ownerDocument || document;
      progressEl = doc.createElement('div');
      progressEl.className = 'va-export-progress';
      progressEl.setAttribute('role', 'status');
      progressEl.setAttribute('aria-live', 'polite');
      progressText = doc.createElement('span');
      const progressBar = doc.createElement('i');
      progressBar.className = 'va-export-progress-track';
      progressFill = doc.createElement('i');
      progressFill.className = 'va-export-progress-fill';
      progressBar.appendChild(progressFill);
      cancelButton = doc.createElement('button');
      cancelButton.type = 'button';
      cancelButton.textContent = '取消';
      cancelButton.setAttribute('aria-label', '取消批量导出');
      cancelButton.onclick = () => {
        if (running) cancel();
        else if (progressEl) { progressEl.remove(); progressEl = null; progressText = null; progressFill = null; cancelButton = null; }
      };
      progressEl.append(progressText, progressBar, cancelButton);
      core.uiRoot.appendChild(progressEl);
    } catch (e) { progressEl = null; }
  }

  function paintProgress() {
    ensureProgress();
    if (!progressEl) return;
    const word = current ? ' · ' + current : '';
    progressText.textContent = (state === 'paused' ? '已暂停 · ' : '') + done + '/' + total + word;
    if (progressFill) progressFill.style.width = (total ? Math.min(100, done / total * 100) : 0) + '%';
    cancelButton.textContent = running ? '取消' : '关闭';
    cancelButton.setAttribute('aria-label', running ? '取消批量导出' : '关闭导出进度');
  }

  function status() { return { state, done, total, current }; }

  function readCompleted(mediaId) {
    try {
      const ids = JSON.parse(localStorage.getItem(EXPORT_PREFIX + mediaId) || '[]');
      return new Set(Array.isArray(ids) ? ids.map(String) : []);
    } catch (e) { return new Set(); }
  }

  function persistCompleted(mediaId, completed) {
    try { localStorage.setItem(EXPORT_PREFIX + mediaId, JSON.stringify(Array.from(completed))); } catch (e) {}
  }

  function stableDeckId(mediaId) {
    const value = String(mediaId || 'media');
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return 'annota-' + value.replace(/[^\w.-]+/g, '_').slice(0, 48) + '-' + (hash >>> 0).toString(36);
  }

  function waitForFrame(videoEl, t, seekChanged, timeoutMs) {
    return new Promise((resolve) => {
      let timer = null, seekHandler = null, videoFrameId = null, finished = false;
      const finish = (ok) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (seekHandler && videoEl && videoEl.removeEventListener) videoEl.removeEventListener('seeked', seekHandler);
        if (videoFrameId != null && videoEl && videoEl.cancelVideoFrameCallback) {
          try { videoEl.cancelVideoFrameCallback(videoFrameId); } catch (e) {}
        }
        resolve(!!ok);
      };
      const waitFrame = () => {
        if (videoEl && typeof videoEl.requestVideoFrameCallback === 'function') {
          const next = () => {
            if (finished) return;
            try {
              videoFrameId = videoEl.requestVideoFrameCallback((_now, metadata) => {
                videoFrameId = null;
                const mediaTime = metadata && Number(metadata.mediaTime);
                const observed = Number.isFinite(mediaTime) ? mediaTime : Number(videoEl.currentTime);
                if (Number.isFinite(observed) && observed >= Number(t) - 0.05) finish(true);
                else next();
              });
            } catch (e) { fallbackFrames(); }
          };
          next();
        } else fallbackFrames();
      };
      const fallbackFrames = () => {
        const raf = typeof root.requestAnimationFrame === 'function'
          ? root.requestAnimationFrame.bind(root) : (cb) => setTimeout(cb, 16);
        raf(() => raf(() => finish(true)));
      };
      timer = setTimeout(() => finish(false), timeoutMs || 1500);
      if (seekChanged && videoEl && videoEl.addEventListener) {
        seekHandler = () => { seekHandler = null; waitFrame(); };
        videoEl.addEventListener('seeked', seekHandler, { once: true });
      } else waitFrame();
    });
  }

  // 可选：在截图上叠当前这条的热力框 + 标签（仅当 opts.overlay 勾选时）。纯画面为默认。
  function canvasOverlay(dataUrl, entry) {
    if (!dataUrl || !entry || !entry.box) return Promise.resolve(dataUrl);
    return new Promise((resolve) => {
      try {
        const image = new root.Image();
        image.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = image.width; canvas.height = image.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) { resolve(dataUrl); return; }
            ctx.drawImage(image, 0, 0);
            const b = entry.box, x = Number(b.x) * canvas.width, y = Number(b.y) * canvas.height;
            const w = Number(b.w) * canvas.width, h = Number(b.h) * canvas.height;
            ctx.strokeStyle = '#F5A623'; ctx.lineWidth = Math.max(2, canvas.width * 0.002);
            ctx.fillStyle = 'rgba(245,166,35,.10)'; ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
            const label = entryTitle(entry);
            if (label) {
              const fontSize = Math.max(12, Math.round(canvas.width * 0.018));
              ctx.font = '600 ' + fontSize + 'px sans-serif';
              const pad = Math.max(5, Math.round(fontSize * .55));
              const labelW = Math.min(canvas.width - 2, ctx.measureText(label).width + pad * 2);
              const labelH = fontSize + pad * 1.5;
              const labelY = Math.max(labelH, y);
              ctx.fillStyle = 'rgba(18,20,24,.94)'; ctx.fillRect(x, labelY - labelH, labelW, labelH);
              ctx.strokeStyle = 'rgba(245,166,35,.55)'; ctx.lineWidth = 1; ctx.strokeRect(x, labelY - labelH, labelW, labelH);
              ctx.fillStyle = '#f3d4a2'; ctx.fillText(label, x + pad, labelY - pad * .45, labelW - pad * 2);
            }
            resolve(canvas.toDataURL('image/png'));
          } catch (e) { resolve(null); }
        };
        image.onerror = () => resolve(null);
        image.src = dataUrl;
      } catch (e) { resolve(null); }
    });
  }

  function entryTitle(entry) {
    const word = String(entry.word || '').trim();
    if (word) return word;
    const tags = entry.tags || [];
    if (tags.length) return String(tags[0]);
    const label = String(entry.label || '').trim();
    return label ? label.slice(0, 40) : '标注';
  }

  function entryPayload(entry) {
    return {
      id: entry.id, word: entry.word || '', label: entry.label || '', pos: entry.pos || '',
      tags: entry.tags || [], t: entry.t, dur: entry.dur, box: entry.box || null,
    };
  }

  function trainingRows(entries, media) {
    return entries.map((entry) => ({
      word: entry.word || '', label: entry.label || '', pos: entry.pos || '', tags: entry.tags || [],
      t: entry.t, dur: entry.dur, box: entry.box || null,
      mediaId: media.mediaId || media.videoId || '', url: media.url || '',
    }));
  }

  function download(text, format, mediaId) {
    const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8';
    const ext = format === 'jsonl' ? 'jsonl' : format;
    const blob = new Blob([text], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'annota_' + String(mediaId || 'cards').replace(/[^\w.-]+/g, '_') + '.' + ext;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function exportClient(entries, media, format) {
    const rows = trainingRows(entries, media);
    if (format === 'csv') {
      const keys = ['word', 'label', 'pos', 'tags', 't', 'dur', 'box', 'mediaId', 'url'];
      const cell = (value) => '"' + String(value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : value)).replace(/"/g, '""') + '"';
      download([keys.join(','), ...rows.map((row) => keys.map((key) => cell(row[key])).join(','))].join('\r\n'), format, media.mediaId);
    } else if (format === 'jsonl') download(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', format, media.mediaId);
    else download(JSON.stringify({ media, cards: rows }, null, 2), format, media.mediaId);
  }

  async function waitIfPaused() {
    while (paused && !cancelled) await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // seek 时加一点点提前量（+0.15s）：isVisible 有提前浮现，且落帧有延迟，
  // 直接 seek(t) 常常"框还没出现"或停在上一条。
  const SEEK_LEAD = 0.15;
  function seekToAnnot(binding, t, lead) {
    const target = Math.max(0, (Number(t) || 0) + (lead == null ? SEEK_LEAD : lead));
    try { binding.seek(target); } catch (e) {}
  }

  // 手动确认截图：seek 好、暂停、只显示本条框；条上实时显示当前时间码，
  // 用户可自行拖动画面 → 点「截图」（以当前帧为准并回写 t）/「跳过」（Enter=截图，Esc=跳过）
  function confirmShot(entry, idx, total, binding, videoEl) {
    return new Promise((resolve) => {
      const doc = (core.uiRoot && core.uiRoot.ownerDocument) || document;
      const el2 = (tag, style, ...kids) => {
        const n = doc.createElement(tag);
        if (style) for (const k in style) n.style[k] = style[k];
        for (const c of kids) if (c != null && c !== false) n.append(typeof c === 'string' ? String(c) : c);
        return n;
      };
      const fmt = (t) => { t = Math.max(0, Number(t) || 0); const m = Math.floor(t / 60); const s = (t % 60).toFixed(2); return m + ':' + (s.length < 5 ? '0' + s : s); };
      const pop = el2('div'); pop.className = 'va-export-confirm';
      pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', '确认截图');
      const txt = el2('span', null, '第 ' + (idx + 1) + '/' + total + ' 条 · ' + entryTitle(entry) + '：画面到位后点截图');
      txt.className = 'va-export-confirm-text';
      const clock = el2('span', null, 't=' + fmt(entry.t)); clock.className = 'va-export-clock';
      const bUse = el2('button'); bUse.type = 'button'; bUse.textContent = '回到标注点';
      const bShot = el2('button'); bShot.type = 'button'; bShot.textContent = '截图';
      const bSkip = el2('button'); bSkip.type = 'button'; bSkip.textContent = '跳过';
      let done = false;
      let tick = null;
      const finish = () => {
        if (done) return; done = true;
        doc.removeEventListener('keydown', onKey, true);
        if (tick) clearInterval(tick);
        pop.remove();
        resolve(Number(videoEl && videoEl.currentTime) || Number(entry.t) || 0);
      };
      const abort = () => { if (done) return; done = true; doc.removeEventListener('keydown', onKey, true); if (tick) clearInterval(tick); pop.remove(); resolve(null); };
      const onKey = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); finish(); } else if (ev.key === 'Escape') { ev.preventDefault(); abort(); } };
      bUse.onclick = () => { seekToAnnot(binding, entry.t); };
      bShot.onclick = () => finish();
      bSkip.onclick = () => abort();
      tick = setInterval(() => { if (videoEl) clock.textContent = 't=' + fmt(videoEl.currentTime); }, 120);
      pop.append(txt, clock, bUse, bShot, bSkip);
      doc.addEventListener('keydown', onKey, true);
      core.uiRoot.appendChild(pop);
    });
  }

  // 连续等 n 个视频帧回调（无 rVFC 时退化为 rAF），确保截到 seek 目标之后的稳定帧
  function waitFrames(videoEl, n) {
    return new Promise((resolve) => {
      if (videoEl && typeof videoEl.requestVideoFrameCallback === 'function') {
        let left = n;
        const step = () => {
          if (left-- <= 0) { resolve(); return; }
          try { videoEl.requestVideoFrameCallback(step); } catch (e) { resolve(); }
        };
        step();
      } else {
        const raf = (root.requestAnimationFrame || ((cb) => setTimeout(cb, 16))).bind(root);
        let left = n;
        const step = () => { if (left-- <= 0) resolve(); else raf(step); };
        step();
      }
    });
  }

  async function captureEntry(entry, previousTime, first, settleMs, overlay) {
    const binding = core.binding();
    const videoEl = binding.el;
    let resume = false;
    try {
      try { if (videoEl && videoEl.paused === false) { videoEl.pause(); resume = true; } } catch (e) {}
      seekToAnnot(binding, entry.t);
      const s = Number(settleMs);
      if (Number.isFinite(s)) {
        await sleep(s);   // 测试/快速模式：跳过等帧
      } else if (first) {
        // 首次截图最容易"滞后一个点"：空跳一次再回目标点，抖掉播放器残留帧，然后等 2 帧稳定
        seekToAnnot(binding, entry.t);
        await waitForFrame(videoEl, Number(entry.t) + SEEK_LEAD, true, 2500);
        await sleep(400);
        seekToAnnot(binding, entry.t);
        await waitForFrame(videoEl, Number(entry.t) + SEEK_LEAD, true, 2500);
        await sleep(1500);
      } else {
        await waitForFrame(videoEl, Number(entry.t) + SEEK_LEAD, Math.abs(Number(previousTime) - Number(entry.t)) > 0.05, 2500);
        await sleep(1200);
      }
      if (!Number.isFinite(s)) await waitFrames(videoEl, 2);   // 再等两帧，确保画面已更新到目标帧
      core.renderOnly(entry);
      core.setChromeHidden(true);
      let shot = await core.captureFrame();
      if (shot && overlay) shot = await canvasOverlay(shot, entry);   // 勾选时才叠当前框
      return shot || null;
    } catch (e) { return null; }
    finally {
      try { core.render(); } catch (e) {}
      try { core.setChromeHidden(false); } catch (e) {}
      try { if (resume && videoEl && videoEl.play) videoEl.play(); } catch (e) {}
    }
  }

  // 手动模式：seek(entry.t+0.15) + 暂停 + 只显示本条框 → 等确认 → 截图。
  // 用户若自己拖过画面，则以当前帧为准：回写该条 t + updated（所见即所得）。
  async function captureEntryManual(entry, idx, total, overlay) {
    const binding = core.binding();
    const videoEl = binding.el;
    try { if (videoEl && videoEl.play) videoEl.pause(); } catch (e) {}
    seekToAnnot(binding, entry.t);
    core.renderOnly(entry);                 // 先只显示本条，让你看清要标的是哪一帧
    // 立即弹确认条（不阻塞等待）——支持一条接一条连续截图；框随 seek 立即按当帧重算
    let chosen = null;
    try { chosen = await confirmShot(entry, idx, total, binding, videoEl); } catch (e) { chosen = null; }
    if (chosen == null) return null;        // 跳过
    try {
      // 以用户确认时的当前帧为准：写回 t（含 updated）——所见即所得
      const cur = Math.max(0, Number(videoEl && videoEl.currentTime) || chosen);
      if (isFinite(cur) && Math.abs(cur - Number(entry.t)) > 0.01) {
        entry.t = Math.round(cur * 100) / 100;
        entry.updated = new Date().toISOString();
      }
      core.renderOnly(entry);
      core.setChromeHidden(true);
      let shot = await core.captureFrame();
      if (shot && overlay) shot = await canvasOverlay(shot, entry);
      return shot || null;
    } catch (e) { return null; }
    finally {
      try { core.render(); } catch (e) {}
      try { core.setChromeHidden(false); } catch (e) {}
    }
  }

  async function run(opts, entries, media, mediaId, completed, deckId) {
    const format = ['apkg', 'csv', 'json', 'jsonl'].includes(opts.format) ? opts.format : 'apkg';
    try {
      if (format !== 'apkg') {
        state = 'running';
        for (let i = 0; i < entries.length; i++) {
          await waitIfPaused();
          if (cancelled) break;
          current = String(entries[i].word || '标注'); done = i + 1; paintProgress();
          if (typeof opts.onProgress === 'function') { try { opts.onProgress(status()); } catch (e) {} }
        }
        if (!cancelled) {
          exportClient(entries, media, format);
          state = 'complete';
          core.showToast('已导出 ' + entries.length + ' 条 · ' + format.toUpperCase());
        } else state = 'cancelled';
        return;
      }

      const sorted = entries.map((entry, index) => ({ entry, index }))
        .sort((a, b) => (Number(a.entry.t) || 0) - (Number(b.entry.t) || 0));
      const todo = opts.onlyMissing ? sorted.filter(({ entry }) => !completed.has(String(entry.id))) : sorted;
      core.state.renderLock = true;
      // Let the core's first layout tick establish the media/content rect before isolating marks.
      await new Promise((resolve) => (root.requestAnimationFrame || ((cb) => setTimeout(cb, 16)))(resolve));
      let firstShot = true;
      for (const item of todo) {
        await waitIfPaused();
        if (cancelled) break;
        const entry = item.entry;
        current = entryTitle(entry); paintProgress();
        const binding = core.binding();
        if (!binding || binding.kind !== 'video' || !binding.timed) throw new Error('当前绑定不是视频');
        const prior = binding.time();
        const shot = opts.manual
          ? await captureEntryManual(entry, item.index, todo.length, !!opts.overlay)
          : await captureEntry(entry, prior, firstShot, opts.settle, !!opts.overlay);
        firstShot = false;
        if (opts.manual && core.save) { try { core.save(); } catch (e) {} }   // 手动模式可能回写了 t
        if (!shot && !warnedCapture) {
          warnedCapture = true;
          core.setSyncStatus('当前环境无法截取视频画面，将导出纯文字卡');
        }
        const response = await core.httpJson('POST', (await core.resolveBase()) + '/api/export/card', {
          deck_id: deckId,
          idx: item.index,
          media,
          entry: entryPayload(entry),
          screenshot: shot,
        });
        if (!response.ok || !response.json || response.json.ok !== true) {
          throw new Error((response.json && response.json.error) || ('HTTP ' + response.status));
        }
        completed.add(String(entry.id));
        persistCompleted(mediaId, completed);
        done += 1;
        paintProgress();
        if (typeof opts.onProgress === 'function') { try { opts.onProgress(status()); } catch (e) {} }
      }
      if (cancelled) { state = 'cancelled'; core.showToast('批量导出已取消 · 可再次运行以续跑'); return; }
      const base = await core.resolveBase();
      const result = await core.httpJson('POST', base + '/api/export/finalize', {
        deck_id: deckId,
        deck_name: String(opts.deckName || media.title || 'Annota 学习卡'),
        format: 'apkg',
      });
      if (!result.ok || !result.json || result.json.ok !== true || !result.json.url) {
        throw new Error((result.json && result.json.error) || ('HTTP ' + result.status));
      }
      state = 'complete';
      const target = base.replace(/\/$/, '') + result.json.url;
      const a = document.createElement('a'); a.href = target; a.download = ''; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.click();
      core.showToast('Anki 牌组已生成 · ' + result.json.cards + ' 张卡');
    } catch (error) {
      state = 'error';
      core.setSyncStatus('批量导出失败：' + String(error && error.message || error));
    } finally {
      paused = false; running = false; current = '';
      try { core.state.renderLock = false; core.render(); core.setChromeHidden(false); } catch (e) {}
      paintProgress();
    }
  }

  async function start(opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    if (running) return { total, resumed: done };
    const binding = core && core.binding();
    const media = core ? core.mediaMeta() : {};
    if (!binding || binding.kind !== 'video' || !binding.timed) {
      state = 'error';
      if (core) core.showToast('批量导出仅支持视频');
      return { total: 0, resumed: 0 };
    }
    const mediaId = String(media.mediaId || media.videoId || binding.mediaId());
    const entries = (core.entries() || []).filter((entry) => entry && entry.box)
      .slice().sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
    total = entries.length;
    const completed = readCompleted(mediaId);
    const resumed = opts.onlyMissing ? entries.filter((entry) => completed.has(String(entry.id))).length : 0;
    done = resumed;
    current = '';
    paused = false; cancelled = false; warnedCapture = false;
    state = 'running'; running = true;
    ensureProgress(); paintProgress();
    if (!entries.length) {
      running = false; state = 'complete'; paintProgress();
      core.showToast('当前视频没有可导出的区域标注');
      return { total: 0, resumed: 0 };
    }
    if (capabilities().capture === 'canvas') {
      // Canvas 兜底：跨域视频常拿不到帧，会导出纯文字卡，提前告知用户
      core.setSyncStatus('当前环境截图能力有限（canvas 兜底），可能导出纯文字卡');
    }
    const deckId = stableDeckId(mediaId);
    run(opts, entries, media, mediaId, completed, deckId);
    return { total, resumed };
  }

  function pause() { if (running) { paused = true; state = 'paused'; paintProgress(); } }
  function resume() { if (running) { paused = false; state = 'running'; paintProgress(); } }
  function cancel() { if (running) { cancelled = true; paused = false; } }

  const api = { capabilities, start, pause, resume, cancel, status };
  root.VAExport = {
    install(coreApi) {
      core = coreApi;
      root.__ANNOTA_EXPORT__ = api;
    },
  };
})(typeof window !== 'undefined' ? window : this);

/* ===== src/core.js ===== */
/* video-annotate · core (P0)
 * 叠层 + 拖框 + 绑词 + 本地存储 + 导入导出。平台无关，依赖 VAGeo / VAAdapter / VAMedia。
 * 媒态差异（视频/图片/文章）由 VAMedia binding 承担，core 只面向 binding 接口。
 */
(function () {
  'use strict';
  if (window.__VA_LOADED__) return;
  window.__VA_LOADED__ = true;

  const G = window.VAGeo, A = window.VAAdapter, VAMedia = window.VAMedia;
  const ADAPTER_ERRORS = [];
  if (A) A._err = (e) => { ADAPTER_ERRORS.push(String((e && e.message) || e).slice(0, 80)); if (ADAPTER_ERRORS.length > 20) ADAPTER_ERRORS.shift(); };
  const DEFAULT_DUR = 1.0;                // 每个标注框默认时长(秒)
  const ICON_PATHS = {
    brand: '<path d="M4.5 19 12 5l7.5 14M8.2 13.2h7.6"/>',
    crosshair: '<circle cx="12" cy="12" r="7.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
    pick: '<path d="M5 3l14 8-6 1.5L11 19 5 3Z"/>',
    eye: '<path d="M2.5 12s3.2-6 9.5-6 9.5 6 9.5 6-3.2 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.6"/>',
    'eye-off': '<path d="M4 4l16 16"/><path d="M9.6 6.3A9.7 9.7 0 0 1 12 6c6.3 0 9.5 6 9.5 6a15 15 0 0 1-2.9 3.4M6.4 7.2A15 15 0 0 0 2.5 12s3.2 6 9.5 6a9.7 9.7 0 0 0 3-.5"/><path d="M9.9 10.1a2.6 2.6 0 0 0 3.7 3.7"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    sync: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.7-2L20 12M4 12l2.7 5a7 7 0 0 0 11.7-2"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.2 4.2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.3 2"/>',
    dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
    box: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h5"/>',
    book: '<path d="M5 4.5h11a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3v-12Z"/><path d="M5 16.5a3 3 0 0 1 3-3h11"/>'
  };

  // 词库已下线（决策 A3，product-spec §16）：词必填、释义/词性手填，查词走外链词典。

  const APP_SETTINGS_KEY = 'annota:settings';
  const DEFAULT_APP_SETTINGS = {
    sync: { address: '', auto: false },
    shortcuts: { annotate: 'alt+d', panel: 'alt+l', overlay: 'alt+s' },
    dictUrlTemplate: '',
    ai: { baseUrl: '', model: '' },
  };
  function mergeAppSettings(value) {
    value = value && typeof value === 'object' ? value : {};
    const sync = value.sync && typeof value.sync === 'object' ? value.sync : {};
    const shortcuts = value.shortcuts && typeof value.shortcuts === 'object' ? value.shortcuts : {};
    return {
      sync: {
        address: typeof sync.address === 'string' ? sync.address : DEFAULT_APP_SETTINGS.sync.address,
        auto: typeof sync.auto === 'boolean' ? sync.auto : DEFAULT_APP_SETTINGS.sync.auto,
      },
      shortcuts: {
        annotate: typeof shortcuts.annotate === 'string' ? shortcuts.annotate : DEFAULT_APP_SETTINGS.shortcuts.annotate,
        panel: typeof shortcuts.panel === 'string' ? shortcuts.panel : DEFAULT_APP_SETTINGS.shortcuts.panel,
        overlay: typeof shortcuts.overlay === 'string' ? shortcuts.overlay : DEFAULT_APP_SETTINGS.shortcuts.overlay,
      },
      dictUrlTemplate: typeof value.dictUrlTemplate === 'string' ? value.dictUrlTemplate : '',
      ai: {
        baseUrl: value.ai && typeof value.ai.baseUrl === 'string' ? value.ai.baseUrl : '',
        model: value.ai && typeof value.ai.model === 'string' ? value.ai.model : '',
      },
    };
  }
  let appSettings = (function () {
    try { return mergeAppSettings(JSON.parse(localStorage.getItem(APP_SETTINGS_KEY) || '{}')); }
    catch (e) { return mergeAppSettings(null); }
  })();

  // 观看端：只读（隐藏标注/编辑），可自动同步。构建时烧入或 ⚙ 里切换。
  const VIEW_ONLY = !!window.VA_VIEW_ONLY ||
    (function () { try { return localStorage.getItem('va:viewOnly') === '1'; } catch (e) { return false; } })();
  let AUTO_SYNC = !!window.VA_AUTO_SYNC || VIEW_ONLY || appSettings.sync.auto;
  let shortcuts = appSettings.shortcuts;
  function isView() { try { return window.VA_VIEW_ONLY || localStorage.getItem('va:viewOnly') === '1'; } catch (e) { return !!window.VA_VIEW_ONLY; } }
  function shortcutMatches(ev, spec) {
    const parts = String(spec || '').toLowerCase().split('+').map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) return false;
    const key = parts.pop();
    const mods = new Set(parts);
    return String(ev.key || '').toLowerCase() === key &&
      !!ev.altKey === mods.has('alt') && !!ev.ctrlKey === mods.has('ctrl') &&
      !!ev.metaKey === mods.has('meta') && !!ev.shiftKey === mods.has('shift');
  }

  const LS_PREFIX = 'va:entries:';
  const HIDDEN_PREFIX = 'va:hidden:';             // 本地显示状态：被隐藏（不可见）的热力框 id 列表（不进 entry、不同步、不导出）
  const SYNC_META_PREFIX = 'va:syncmeta:';       // 「已与服务端对齐到的版本」指纹 → 判定本地是否有未同步离线改动
  const OVERRIDE_PREFIX = 'va:coverpref:';        // 「服务器更新时是否覆盖本地」的记忆（用户勾选不再询问）
  const FORMAT = 'video-annotate/0.1';   // 服务端回显为准；此处是本地/新建默认

  const state = {
    binding: null, mediaId: null, platform: null,
    entries: [], showAll: false, annotate: false, picking: false,
    rect: null, cr: null, draft: null, dragging: false,
    renderLock: false, exportOnly: null,
    displayVersion: null,   // 'local' | 'server' 本次显示用的是哪版（决定同步推什么）
    hidden: new Set(),      // 本地隐藏的热力框 id（仅显示状态）
    lastActiveId: null,     // 「仅当前」用：最近定位/点击的条目
  };
  window.__VA = { get state() { return state; } };   // 调试：控制台可 __VA.state 查看

  /* ---------- 存储：本地 = 缓存/离线草稿；服务器 = 云存储（分享/公开） ---------- */
  function loadCached(mediaId) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + mediaId);
      const obj = raw ? JSON.parse(raw) : null;
      return validEntries((obj && obj.entries) || []);
    } catch (e) { return []; }
  }
  // 与顺序无关的稳定指纹：id + updated + 内容（老数据无 updated 时也能区分改动）
  function fingerprint(entries) {
    return entries.map((e) => [e.id, e.updated || e.created || '', e.word || '', e.label || '',
      (e.tags || []).join(','), e.t != null ? e.t : ''].join('@')).sort().join('|');
  }
  function syncMeta(mediaId) {
    try { return JSON.parse(localStorage.getItem(SYNC_META_PREFIX + mediaId) || 'null') || null; } catch (e) { return null; }
  }
  function setSyncMeta(mediaId, serverEntries) {
    try { localStorage.setItem(SYNC_META_PREFIX + mediaId, JSON.stringify({ fp: fingerprint(serverEntries), at: Date.now() })); } catch (e) {}
  }
  // 本地是否存在「未与服务器对齐」的离线改动
  function hasLocalDraft(mediaId, cached) {
    if (!cached.length) return false;
    const meta = syncMeta(mediaId);
    if (!meta) return true;                        // 从未同步过却有本地数据 → 视作离线改动
    return meta.fp !== fingerprint(cached);
  }

  // 可见性 = 本地显示状态（按媒体存 localStorage，不进 entry、不同步）
  function loadHidden(mediaId) {
    try {
      const arr = JSON.parse(localStorage.getItem(HIDDEN_PREFIX + mediaId) || '[]');
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch (e) { return new Set(); }
  }
  function saveHidden(mediaId, set) {
    try { localStorage.setItem(HIDDEN_PREFIX + mediaId, JSON.stringify(Array.from(set))); } catch (e) {}
  }
  function isHidden(e) { return !!(e && state.hidden && state.hidden.has(String(e.id))); }
  function toggleHidden(e) {
    const id = String(e.id);
    if (state.hidden.has(id)) state.hidden.delete(id); else state.hidden.add(id);
    saveHidden(state.mediaId, state.hidden);
    render(); renderPanel();
  }
  function showAllVisible() {
    state.hidden = new Set();
    saveHidden(state.mediaId, state.hidden);
    render(); renderPanel();
  }
  function onlyCurrentVisible() {
    // 当前条目：最近定位的；否则取离播放点最近的
    let cur = state.entries.find((e) => String(e.id) === String(state.lastActiveId));
    if (!cur && state.binding && state.binding.timed) {
      const t = state.binding.time();
      cur = state.entries.slice().sort((a, b) => Math.abs((Number(a.t) || 0) - t) - Math.abs((Number(b.t) || 0) - t))[0];
    }
    if (!cur) return;
    state.lastActiveId = String(cur.id);
    state.hidden = new Set(state.entries.filter((e) => e !== cur).map((e) => String(e.id)));
    saveHidden(state.mediaId, state.hidden);
    if (state.binding) state.binding.locate(cur);
    render(); renderPanel();
  }

  // 只读加载本地缓存（不联网、不询问）：打开页面先显示已有内容
  function load() {
    state.entries = loadCached(state.mediaId);
    state.hidden = loadHidden(state.mediaId);
    state.displayVersion = 'local';
  }
  function save() {
    const media = mediaMeta();
    const obj = { format: FORMAT, media, entries: state.entries };
    try { localStorage.setItem(LS_PREFIX + state.mediaId, JSON.stringify(obj)); }
    catch (e) { setSyncStatus('本地保存失败（隐私模式/空间不足？）'); }
    updateStatus();
    renderPanel();
  }

  /* ---------- Shadow DOM UI ---------- */
  const uiHost = document.createElement('div');
  uiHost.id = 'annota-shadow-host';
  uiHost.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
  const uiShadow = typeof uiHost.attachShadow === 'function' ? uiHost.attachShadow({ mode: 'open' }) : uiHost;
  const uiStyle = document.createElement('style');
  uiStyle.textContent = window.VA_OVERLAY_CSS || window.VA_TOKENS_CSS || '';
  const uiRoot = document.createElement('div');
  uiRoot.className = 'va-ui-root';
  uiShadow.append(uiStyle, uiRoot);
  (document.body || document.documentElement).appendChild(uiHost);

  /* ---------- DOM ---------- */
  const overlay = el('div', {
    position: 'fixed', left: '0', top: '0', width: '0', height: '0',
    pointerEvents: 'none', zIndex: '1', display: 'none',
  });
  const capture = el('div', {
    position: 'absolute', left: '0', top: '0', right: '0', bottom: '0',
    pointerEvents: 'none', cursor: 'crosshair',
  });
  capture.className = 'va-capture';
  const layer = el('div', {
    position: 'absolute', left: '0', top: '0', right: '0', bottom: '0', pointerEvents: 'none',
  });
  overlay.appendChild(capture); overlay.appendChild(layer);

  const bar = el('div');
  bar.className = 'va-dock';
  const brand = el('div'); brand.className = 'va-brand';
  const brandMark = el('span'); brandMark.className = 'va-brand-mark'; brandMark.appendChild(svgIcon('brand'));
  const brandCopy = el('span', null, 'Annota'); brandCopy.className = 'va-brand-copy';
  brandCopy.appendChild(el('small', null, 'CONTENT LAYER'));
  brand.append(brandMark, brandCopy);
  const separator = el('span'); separator.className = 'va-separator';
  const btnAnno = mkAction('标注', 'crosshair', () => toggleAnnotate(), 'primary');
  const btnAll = mkAction('显示', 'eye', () => {
    state.showAll = !state.showAll;
    btnAll.classList.toggle('is-active', state.showAll);
    render();
  });
  const btnPanel = mkAction('列表', 'list', () => togglePanel());
  const btnPick = mkAction('选对象', 'pick', () => togglePicker());
  const btnSync = mkAction('同步', 'sync', syncNow);
  const btnCfg = mkAction('更多', 'more', toggleMenu);
  const btnBridge = mkbtn('发给 AI 助手', copyContext);
  const btnDiag = mkbtn('诊断信息', toggleDiag);
  const status = el('span'); status.className = 'va-sync-indicator'; status.dataset.state = 'ready';
  const statusDot = el('i'); statusDot.className = 'va-sync-dot';
  const statusText = el('span', null, '就绪');
  status.append(statusDot, statusText);
  bar.append(brand, separator, btnAnno, btnAll, btnPanel, btnPick, btnSync, status, btnCfg);

  const sidePanel = el('aside'); sidePanel.className = 'va-panel';
  const panelHead = el('div'); panelHead.className = 'va-panel-head';
  const panelTitle = el('div'); panelTitle.className = 'va-panel-title';
  const panelTitleMain = el('strong', null, '当前标注');
  const panelTitleSub = el('span', null, '等待视频…');
  panelTitle.append(panelTitleMain, panelTitleSub);
  const panelClose = mkIconButton('关闭标注面板', 'close', () => togglePanel(false));
  panelClose.classList.add('va-close');
  panelHead.append(panelTitle, panelClose);
  const panelTabs = el('div'); panelTabs.className = 'va-panel-tabs';
  const tabTimeline = mkTab('时间轴', true);
  const tabWords = mkTab('词汇', false);
  const tabSources = mkTab('来源', false);
  const tabAssistant = mkTab('助手', false);
  panelTabs.setAttribute('role', 'tablist');
  panelTabs.setAttribute('aria-label', '侧栏视图');
  const panelTabItems = [[tabTimeline, 'timeline'], [tabWords, 'words'], [tabSources, 'sources'], [tabAssistant, 'assistant']];
  panelTabItems.forEach(([tab, name]) => {
    tab.id = 'va-tab-' + name;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', name === 'assistant' ? 'va-assistant-panel' : 'va-entry-panel');
    tab.setAttribute('aria-selected', String(name === 'timeline'));
    tab.tabIndex = name === 'timeline' ? 0 : -1;
  });
  panelTabs.append(tabTimeline, tabWords, tabSources, tabAssistant);
  const panelSearchWrap = el('div'); panelSearchWrap.className = 'va-panel-search';
  const panelSearch = el('input'); panelSearch.className = 'va-input';
  panelSearch.type = 'search'; panelSearch.placeholder = '筛选标注…'; panelSearch.setAttribute('aria-label', '筛选标注');
  panelSearchWrap.appendChild(panelSearch);
  // 可见性快捷：全部显示 / 仅当前
  const visBar = el('div'); visBar.className = 'va-vis-bar';
  const btnVisAll = mkbtn('全部', () => showAllVisible()); btnVisAll.classList.add('va-chip'); btnVisAll.setAttribute('aria-label', '显示全部热力框');
  const btnVisOnly = mkbtn('仅当前', () => onlyCurrentVisible()); btnVisOnly.classList.add('va-chip'); btnVisOnly.setAttribute('aria-label', '只显示当前热力框');
  visBar.append(btnVisAll, btnVisOnly);
  const entryList = el('div'); entryList.className = 'va-entry-list';
  entryList.id = 'va-entry-panel';
  entryList.setAttribute('role', 'tabpanel');
  entryList.setAttribute('aria-labelledby', 'va-tab-timeline');
  const panelFoot = el('div'); panelFoot.className = 'va-panel-foot'; panelFoot.textContent = '点击词条跳转到对应画面';
  const assistantPane = el('section'); assistantPane.className = 'va-assistant';
  assistantPane.id = 'va-assistant-panel';
  assistantPane.setAttribute('role', 'tabpanel');
  assistantPane.setAttribute('aria-labelledby', 'va-tab-assistant');
  assistantPane.setAttribute('aria-label', 'Annota 助手');
  const assistantNotice = el('div'); assistantNotice.className = 'va-assistant-notice';
  assistantNotice.setAttribute('role', 'status'); assistantNotice.setAttribute('aria-live', 'polite');
  const assistantTranscript = el('div'); assistantTranscript.className = 'va-chat-transcript';
  assistantTranscript.setAttribute('role', 'log'); assistantTranscript.setAttribute('aria-label', '对话记录');
  const assistantForm = el('form'); assistantForm.className = 'va-chat-form';
  const assistantInput = el('textarea'); assistantInput.className = 'va-chat-input';
  assistantInput.rows = 2; assistantInput.maxLength = 4000;
  assistantInput.placeholder = '问问当前画面或标注…';
  assistantInput.setAttribute('aria-label', '发送给助手');
  const assistantSend = el('button', null, '发送'); assistantSend.type = 'submit';
  assistantSend.className = 'va-btn va-btn-primary';
  assistantForm.append(assistantInput, assistantSend);
  assistantPane.append(assistantNotice, assistantTranscript, assistantForm);
  sidePanel.append(panelHead, panelTabs, panelSearchWrap, visBar, entryList, panelFoot, assistantPane);
  let panelOpen = false, panelTab = 'timeline';

  tabTimeline.onclick = () => { panelTab = 'timeline'; updatePanelTabs(); renderPanel(); };
  tabWords.onclick = () => { panelTab = 'words'; updatePanelTabs(); renderPanel(); };
  tabSources.onclick = () => { panelTab = 'sources'; updatePanelTabs(); renderPanel(); };
  tabAssistant.onclick = () => { panelTab = 'assistant'; updatePanelTabs(); renderPanel(); assistantInput.focus({ preventScroll: true }); };
  panelTabs.addEventListener('keydown', (event) => {
    const currentIndex = panelTabItems.findIndex(([tab]) => tab === event.target);
    if (currentIndex < 0) return;
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % panelTabItems.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex + panelTabItems.length - 1) % panelTabItems.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = panelTabItems.length - 1;
    else return;
    event.preventDefault();
    const nextTab = panelTabItems[nextIndex][0];
    nextTab.focus();
    nextTab.click();
  });
  panelSearch.addEventListener('input', renderPanel);
  panelSearch.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') panelSearch.value = ''; renderPanel(); });

  function applyMode() {
    const v = isView();
    btnAnno.style.display = v ? 'none' : '';
    if (v) toggleAnnotate(false);
  }
  applyMode();

  // 诊断面板（B站等实机上排查用）
  const diagPanel = el('pre', { display: 'none' });
  diagPanel.className = 'va-diag';
  // 无法叠加时的提示条
  const toast = el('div', null, '当前为「视频元素真全屏」，浏览器限制无法叠加标注。请用播放器的「网页全屏 / 影院模式」再标注。');
  toast.className = 'va-toast';
  let toastTimer = null;
  function showToast(message, error) {
    toast.textContent = message;
    toast.classList.toggle('is-error', !!error);
    toast.classList.add('is-visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
  }

  function svgIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.innerHTML = ICON_PATHS[name] || ICON_PATHS.box;
    return svg;
  }
  function mkAction(label, iconName, fn, variant) {
    const b = el('button');
    b.type = 'button';
    b.className = 'va-action' + (variant === 'primary' ? ' va-action-primary' : '');
    b.setAttribute('aria-label', label);
    b.title = label;
    b.appendChild(svgIcon(iconName));
    const text = el('span', null, label); text.className = 'va-action-label';
    b.appendChild(text);
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  }
  function mkIconButton(label, iconName, fn) {
    const b = el('button'); b.type = 'button'; b.setAttribute('aria-label', label); b.title = label;
    b.appendChild(svgIcon(iconName));
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  }
  function mkTab(label, active) {
    const b = el('button', null, label); b.type = 'button';
    b.className = 'va-tab' + (active ? ' is-active' : '');
    return b;
  }
  let diagTimer = null;
  function toggleDiag() {
    const on = diagPanel.style.display === 'none';
    diagPanel.style.display = on ? 'block' : 'none';
    btnDiag.classList.toggle('va-btn-primary', on);
    if (on) { uiRoot.appendChild(diagPanel); diagTimer = setInterval(renderDiag, 800); renderDiag(); }
    else { if (diagTimer) clearInterval(diagTimer); diagTimer = null; diagPanel.remove(); }
  }
  function renderDiag() {
    const d = A.diag ? A.diag() : {};
    const v = state.binding && state.binding.el, r = state.rect, cr = state.cr, m = state.meta || {};
    const lines = [
      'platform : ' + d.platform + '   supported=' + d.supported,
      'kind     : ' + (state.binding ? state.binding.kind : '-') + '   timed=' + (state.binding ? state.binding.timed : '-'),
      'mediaId  : ' + d.mediaId,
      'href     : ' + d.href,
      'fullscreen: ' + (d.fullscreen || '-') + (m.unsupported ? '  ⚠ 视频自身全屏' : ''),
      'media    : ' + (v ? ((v.videoWidth || v.naturalWidth || 0) + 'x' + (v.videoHeight || v.naturalHeight || 0) + ' ready=' + (v.readyState == null ? 'n/a' : v.readyState)) : 'null'),
      'videos   : ' + (A.countVideos ? A.countVideos() : '?') + '（含 shadow DOM）',
      'objectFit: ' + (m.fit || '-'),
      'rect     : ' + (r ? [r.x, r.y, r.width, r.height].map(n1).join(', ') : '-'),
      'content  : ' + (cr ? [cr.x, cr.y, cr.w, cr.h].map(n1).join(', ') : '-'),
      'overlay  : host=' + (overlay.parentElement ? overlay.parentElement.tagName : '-') + ' children=' + overlay.childElementCount,
      'entries  : ' + state.entries.length + '   annotate=' + state.annotate + '  showAll=' + state.showAll,
      'errors   : ' + (ADAPTER_ERRORS.length ? ADAPTER_ERRORS.slice(-3).join(' | ') : '-'),
    ];
    diagPanel.textContent = lines.join('\n');
  }
  function n1(x) { return Math.round(x * 10) / 10; }
  function r2(x) { return Math.round((parseFloat(x) || 0) * 100) / 100; }
  function formatTime(value) {
    const s = Math.max(0, Math.floor(Number(value) || 0));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function updatePanelTabs() {
    tabTimeline.classList.toggle('is-active', panelTab === 'timeline');
    tabWords.classList.toggle('is-active', panelTab === 'words');
    tabSources.classList.toggle('is-active', panelTab === 'sources');
    tabAssistant.classList.toggle('is-active', panelTab === 'assistant');
    for (const [tab, name] of [[tabTimeline, 'timeline'], [tabWords, 'words'], [tabSources, 'sources'], [tabAssistant, 'assistant']]) {
      tab.setAttribute('aria-selected', String(panelTab === name));
      tab.tabIndex = panelTab === name ? 0 : -1;
    }
    const isAssistant = panelTab === 'assistant';
    if (!isAssistant) entryList.setAttribute('aria-labelledby', 'va-tab-' + panelTab);
    panelSearchWrap.style.display = isAssistant ? 'none' : '';
    entryList.style.display = isAssistant ? 'none' : '';
    panelFoot.style.display = isAssistant ? 'none' : '';
    assistantPane.style.display = isAssistant ? 'flex' : 'none';
    panelSearch.placeholder = panelTab === 'words' ? '筛选词汇…' : panelTab === 'sources' ? '筛选来源…' : '筛选标注…';
  }
  let agentMessages = [];
  let agentAudits = [];
  function cleanAgentValue(value) {
    if (typeof value === 'string') {
      return value
        .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi, '[截图已省略]')
        .replace(/(["']?image_url["']?\s*:\s*)\{[^}]*\}/gi, '$1[截图已省略]')
        .replace(/[A-Za-z0-9+/]{512,}={0,2}/g, '[图像数据已省略]');
    }
    if (Array.isArray(value)) return value.map(cleanAgentValue);
    if (value && typeof value === 'object') {
      const clean = Object.create(null);
      for (const key of Object.keys(value)) {
        if (/image|screenshot|base64|data_url|dataurl/i.test(key)) {
          clean[key] = '[截图已省略]';
        } else clean[key] = cleanAgentValue(value[key]);
      }
      return clean;
    }
    return value;
  }
  function agentText(value) {
    if (typeof value === 'string') return cleanAgentValue(value);
    if (Array.isArray(value)) return value.map((part) => {
      if (typeof part === 'string') return cleanAgentValue(part);
      return part && typeof part.text === 'string' ? cleanAgentValue(part.text) : '';
    }).filter(Boolean).join('\n');
    return value == null ? '' : cleanAgentValue(String(value));
  }
  function appendChatMessage(role, text) {
    const item = el('article'); item.className = 'va-chat-message va-chat-' + role;
    const label = el('span', null, role === 'user' ? '你' : role === 'assistant' ? '助手' : '提示');
    label.className = 'va-chat-role';
    const body = el('p'); body.className = 'va-chat-copy'; body.textContent = cleanAgentValue(String(text || ''));
    item.append(label, body); assistantTranscript.appendChild(item);
    assistantTranscript.scrollTop = assistantTranscript.scrollHeight;
    return item;
  }
  function renderAssistantTranscript() {
    assistantTranscript.textContent = '';
    for (const message of agentMessages) {
      if (!message || !['user', 'assistant'].includes(message.role)) continue;
      const text = agentText(message.content);
      if (text) appendChatMessage(message.role, text);
    }
    renderAgentAudit(agentAudits);
  }
  function prettyAgentValue(value) {
    try { return JSON.stringify(cleanAgentValue(value), null, 2); }
    catch (e) { return String(cleanAgentValue(value)); }
  }
  function renderAgentAudit(audit) {
    for (const entry of Array.isArray(audit) ? audit : []) {
      // Entries are sanitized before being stored in agentAudits; keep the
      // reference so confirmation results survive transcript re-renders.
      const safe = entry && typeof entry === 'object' ? entry : {};
      const card = el('details'); card.className = 'va-audit-card';
      const needsConfirmation = !!(safe.result && safe.result.needs_confirmation && safe.result.confirm_id);
      card.open = needsConfirmation;
      const summary = el('summary');
      const toolName = el('strong', null, String(safe.name || '工具调用'));
      const statusText = el('span', null, needsConfirmation ? '等待确认' : safe.result && safe.result.error ? '执行失败' : '已执行');
      statusText.className = 'va-audit-state'; summary.append(toolName, statusText);
      const args = el('pre'); args.className = 'va-audit-data'; args.textContent = prettyAgentValue(safe.arguments || {});
      const result = el('pre'); result.className = 'va-audit-data'; result.textContent = prettyAgentValue(safe.result == null ? {} : safe.result);
      const resultLabel = el('span', null, '结果'); resultLabel.className = 'va-audit-label';
      card.append(summary, el('span', null, '参数'), args, resultLabel, result);
      if (needsConfirmation) {
        const actions = el('div'); actions.className = 'va-audit-actions';
        const confirm = el('button', null, '确认'); confirm.type = 'button'; confirm.className = 'va-btn va-btn-primary';
        const cancel = el('button', null, '取消'); cancel.type = 'button'; cancel.className = 'va-btn va-btn-danger';
        async function resolveConfirmation(accept) {
          confirm.disabled = true; cancel.disabled = true; statusText.textContent = accept ? '正在确认…' : '正在取消…';
          try {
            const bridge = window.__ANNOTA__;
            if (!bridge) throw new Error('Annota 助手接口不可用');
            const outcome = accept ? await bridge.agentConfirm(safe.result.confirm_id) : await bridge.agentCancel(safe.result.confirm_id);
            safe.result = cleanAgentValue(outcome == null ? (accept ? { confirmed: true } : { cancelled: true }) : outcome);
            result.textContent = prettyAgentValue(safe.result);
            statusText.textContent = accept ? '已确认' : '已取消';
          } catch (error) {
            const failure = { error: cleanAgentValue(error && error.message || '操作失败') };
            result.textContent = prettyAgentValue(failure);
            statusText.textContent = '操作失败 · 可重试';
            confirm.disabled = false;
            cancel.disabled = false;
          }
        }
        confirm.onclick = () => resolveConfirmation(true);
        cancel.onclick = () => resolveConfirmation(false);
        actions.append(confirm, cancel); card.appendChild(actions);
      }
      assistantTranscript.appendChild(card);
    }
    assistantTranscript.scrollTop = assistantTranscript.scrollHeight;
  }
  assistantForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = assistantInput.value.trim();
    if (!text || assistantSend.disabled) return;
    const bridge = window.__ANNOTA__;
    if (!bridge || typeof bridge.agentRun !== 'function') {
      assistantNotice.textContent = '当前环境暂未配置 Annota 助手。请在 Annota 桌面端配置模型后再试。';
      assistantNotice.dataset.state = 'error';
      return;
    }
    assistantNotice.textContent = '';
    assistantNotice.dataset.state = '';
    agentMessages.push({ role: 'user', content: cleanAgentValue(text) });
    assistantInput.value = '';
    renderAssistantTranscript();
    assistantSend.disabled = true;
    assistantSend.textContent = '思考中…';
    try {
      const result = await bridge.agentRun(cleanAgentValue(agentMessages));
      const finalContent = result && result.message && typeof result.message === 'object' && 'content' in result.message
        ? result.message.content : result && result.message;
      if (result && Array.isArray(result.messages)) {
        agentMessages = cleanAgentValue(result.messages).filter((message) => message && message.role !== 'system');
      } else if (finalContent != null) {
        agentMessages.push({ role: 'assistant', content: cleanAgentValue(finalContent) });
      }
      const lastMessage = agentMessages[agentMessages.length - 1];
      if (finalContent != null && !(lastMessage && lastMessage.role === 'assistant' && agentText(lastMessage.content) === agentText(finalContent))) {
        agentMessages.push({ role: 'assistant', content: cleanAgentValue(finalContent) });
      }
      if (result && Array.isArray(result.audit)) agentAudits = agentAudits.concat(cleanAgentValue(result.audit));
      renderAssistantTranscript();
      if (finalContent == null && !(result && Array.isArray(result.audit) && result.audit.length)) {
        assistantNotice.textContent = '助手暂时没有返回可显示的内容，请重试。';
        assistantNotice.dataset.state = 'error';
      }
      if (panelTab === 'assistant') assistantTranscript.scrollTop = assistantTranscript.scrollHeight;
    } catch (error) {
      const message = String(error && error.message || error || '请求失败');
      if (/未配置模型|LLM_API_KEY|ARK_API_KEY|LLM_MODEL/i.test(message)) {
        assistantNotice.textContent = '尚未配置 AI 模型。请设置 LLM_API_KEY（或 ARK_API_KEY）与 LLM_MODEL。';
      } else assistantNotice.textContent = '助手暂时无法响应，请检查 AI 配置或本地服务后重试。';
      assistantNotice.dataset.state = 'error';
      appendChatMessage('notice', assistantNotice.textContent);
    } finally {
      assistantSend.disabled = false;
      assistantSend.textContent = '发送';
      assistantInput.focus({ preventScroll: true });
    }
  });
  assistantInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); assistantForm.requestSubmit(); }
  });
  function togglePanel(force) {
    panelOpen = force == null ? !panelOpen : !!force;
    sidePanel.classList.toggle('is-open', panelOpen);
    btnPanel.classList.toggle('is-active', panelOpen);
    if (panelOpen) {
      renderPanel();
      (panelTab === 'assistant' ? assistantInput : panelSearch).focus({ preventScroll: true });
    }
  }
  document.addEventListener('keydown', (ev) => {
    const target = ev.composedPath ? ev.composedPath()[0] : ev.target;
    const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) return;
    if (!isView() && shortcutMatches(ev, shortcuts.annotate)) {
      ev.preventDefault(); toggleAnnotate();
    } else if (shortcutMatches(ev, shortcuts.panel)) {
      ev.preventDefault(); togglePanel();
    } else if (shortcutMatches(ev, shortcuts.overlay)) {
      ev.preventDefault(); state.showAll = !state.showAll; btnAll.classList.toggle('is-active', state.showAll); render();
    } else if (ev.key === 'Escape') {
      if (state.picking) togglePicker(false);
      if (panelOpen) togglePanel(false);
      if (menuPanel.style.display !== 'none') toggleMenu();
      if (state.annotate) toggleAnnotate(false);
    }
  }, true);
  function renderPanel() {
    if (!panelOpen) return;
    panelTitleMain.textContent = panelTab === 'assistant' ? 'Annota 助手' : '当前标注';
    panelTitleSub.textContent = panelTab === 'assistant'
      ? '可询问当前画面与标注'
      : (state.binding ? document.title : '当前页面') + ' · ' + state.entries.length + ' 条';
    if (panelTab === 'assistant') { renderAssistantTranscript(); return; }
    entryList.textContent = '';
    const query = (panelSearch.value || '').trim().toLocaleLowerCase();
    if (panelTab === 'sources') {
      const timedNow = !state.binding || state.binding.timed;
      const mine = state.entries.slice().sort((a, b) => timedNow ? (a.t - b.t) : (String(a.word || '').localeCompare(String(b.word || ''))));
      const matched = query ? mine.filter((e) => (e.word + ' ' + (e.label || '') + ' ' + (e.pos || '')).toLocaleLowerCase().includes(query)) : mine;
      const words = new Set(matched.map((e) => (e.word || '').toLocaleLowerCase()).filter(Boolean)).size;
      const seg = (title) => { const g = el('div', null, title); g.className = 'va-entry-group'; return g; };
      const note = (text) => { const n = el('div', null, text); n.className = 'va-src-note'; return n; };

      entryList.appendChild(seg('我的'));
      const mineRow = el('div'); mineRow.className = 'va-src-row';
      const mineName = el('span', null, '本机标注'); mineName.className = 'va-src-name';
      const mineTag = el('span', null, '我的'); mineTag.className = 'va-src-tag';
      const mineCount = el('span', null, query ? '匹配 ' + matched.length + ' / 共 ' + mine.length + ' 条' : matched.length + ' 条 · ' + words + ' 个词');
      mineCount.className = 'va-src-count';
      mineRow.append(mineName, mineTag, mineCount);
      entryList.appendChild(mineRow);
      if (query && !matched.length) entryList.appendChild(note('没有匹配的标注，换个词试试。'));

      entryList.appendChild(seg('他人'));
      entryList.appendChild(note('共享标注将随去中心化标注交换开放：同一段内容下，他人公开的标注会自动汇入这里。'));

      entryList.appendChild(seg('AI 建议'));
      entryList.appendChild(note('AI 候选框不会直接写入：经 MCP propose_annotation 进入确认卡，你核对保存后才成为标注。'));
      panelFoot.textContent = query ? '来源筛选 · 我的匹配 ' + matched.length + ' 条' : '来源 · 我的 ' + mine.length + ' 条';
      return;
    }
    let items;
    if (panelTab === 'words') {
      const byWord = new Map();
      for (const e of state.entries.slice().sort((a, b) => a.t - b.t)) {
        const key = (e.word || '').toLocaleLowerCase();
        if (!key) continue;
        if (!byWord.has(key)) byWord.set(key, { entry: e, count: 0 });
        const item = byWord.get(key); item.count += 1; item.entry = e;
      }
      items = Array.from(byWord.values()).sort((a, b) => a.entry.word.localeCompare(b.entry.word));
      items = items.filter((item) => !query || (item.entry.word + ' ' + (item.entry.label || '')).toLocaleLowerCase().includes(query));
    } else {
      items = state.entries.slice().sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0))
        .filter((e) => !query || (e.word + ' ' + (e.label || '') + ' ' + (e.pos || '')).toLocaleLowerCase().includes(query))
        .map((entry) => ({ entry, count: 1 }));
    }

    if (!items.length) {
      const empty = el('div'); empty.className = 'va-empty';
      const mark = el('span'); mark.className = 'va-empty-mark'; mark.appendChild(svgIcon('box'));
      const copy = el('div');
      copy.append(el('strong', null, query ? '没有匹配的标注' : '这一段还没有标注'),
        el('span', null, query ? '试试换个词搜索。' : '按 D 或点「标注」，把一个词锚在画面上。'));
      empty.append(mark, copy); entryList.appendChild(empty);
      panelFoot.textContent = query ? '搜索结果为 0 条' : '点击「标注」开始建立这段内容的记忆';
      return;
    }

    let lastMinute = -1;
    const timed = !state.binding || state.binding.timed;
    for (const item of items) {
      const e = item.entry;
      if (panelTab === 'timeline' && timed) {
        const minute = Math.floor((Number(e.t) || 0) / 60);
        if (minute !== lastMinute) {
          lastMinute = minute;
          const group = el('div', null, formatTime(minute * 60)); group.className = 'va-entry-group';
          entryList.appendChild(group);
        }
      }
      const row = el('button'); row.type = 'button'; row.className = 'va-entry-row';
      const time = el('span', null, timed ? formatTime(e.t) : '🖼');
      time.className = 'va-entry-time' + (timed ? '' : ' va-entry-time--none');
      const copy = el('span'); copy.className = 'va-entry-copy';
      const tagStr = entryTags(e).map((t) => '#' + t).join(' ');
      const title = el('strong', null, entryText(e));
      const subtitle = el('span', null, panelTab === 'words'
        ? ((e.label || '未添加备注') + (item.count > 1 ? ' · 出现 ' + item.count + ' 次' : ''))
        : ([e.label, tagStr].filter(Boolean).join(' · ') || '点击定位画面'));
      copy.append(title, subtitle);
      const hiddenNow = isHidden(e);
      if (hiddenNow) row.classList.add('is-hidden');
      const eye = mkIconButton(hiddenNow ? '显示这一条' : '隐藏这一条', hiddenNow ? 'eye-off' : 'eye', () => {
        toggleHidden(e);
      });
      eye.classList.add('va-entry-eye');
      eye.setAttribute('aria-pressed', hiddenNow ? 'true' : 'false');
      const more = mkIconButton('编辑或管理词条', 'dots', () => {
        const r = more.getBoundingClientRect(); openEntryPop(e, r.left, r.bottom);
      });
      more.classList.add('va-entry-more');
      row.append(time, copy, eye, more);
      row.onclick = (ev) => {
        if (ev.target === more || more.contains(ev.target) || ev.target === eye || eye.contains(ev.target)) return;
        state.lastActiveId = String(e.id);
        if (state.binding) state.binding.locate(e);
        render();
        showToast('已定位到 ' + (timed ? formatTime(e.t) + ' · ' : '') + entryText(e));
      };
      entryList.appendChild(row);
    }
    panelFoot.textContent = items.length + (panelTab === 'words' ? ' 个词 · 按词汇聚' : ' 条标注 · 点击词条定位画面');
  }

  /* ---------- 上下文桥（发给桌面豆包/系统助手）+ 截图 + 笔记 ---------- */
  // 不做第二个豆包：只把「别人拿不到的上下文」整理好，交给桌面豆包
  function videoContext() {
    const timed = !state.binding || state.binding.timed;
    const t = timed && state.binding ? Math.floor(state.binding.time()) : 0;
    const words = state.entries.slice(-12).map((e) => e.word).filter(Boolean).join(', ');
    const ctx = state.binding && state.binding.contextText ? state.binding.contextText() : {};
    return ['平台: ' + (state.platform || location.hostname), '链接: ' + location.href,
      '标题: ' + document.title,
      timed ? '当前进度: ' + t + 's' : (ctx.intrinsic ? '图片尺寸: ' + ctx.intrinsic : ''),
      words ? '画面已标注的词: ' + words : ''].filter(Boolean).join('\n');
  }
  function videoRect() {
    const r = state.binding ? state.binding.captureRect() : state.rect;
    if (!r) return null;
    return { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.round(r.width), height: Math.round(r.height) };
  }
  function cropDataUrl(dataUrl, rect) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          // 缩放用「实际截图宽度 / 视口宽度」推算（兼容 HiDPI/缩放），rect 为 CSS 像素
          const vp = (window.innerWidth || 1);
          const sx = img.width / vp, sy = img.height / (window.innerHeight || 1);
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(rect.width * sx));
          c.height = Math.max(1, Math.round(rect.height * sy));
          const ctx = c.getContext('2d');
          if (!ctx) { resolve(null); return; }        // 闭锁：宁可不给，也不给整屏
          ctx.drawImage(img, rect.x * sx, rect.y * sy, rect.width * sx, rect.height * sy, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/png'));
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }
  // 三通道统一：截图返回整窗/整屏，一律按视频（或媒态）矩形裁剪到画面。
  // 裁剪超时（图片解码卡住等）→ 返回原图，宁可整窗也不让批量导出挂死。
  async function cropToMedia(dataUrl, rect) {
    if (!dataUrl) return null;
    if (!rect) return dataUrl;
    return await Promise.race([
      cropDataUrl(dataUrl, rect),
      // 超时宁可不给整窗（与 cropDataUrl 的闭锁策略一致）→ 退化为纯文字卡，绝不泄露整屏
      new Promise((resolve) => setTimeout(() => resolve(null), 1200)),
    ]);
  }
  // canvas 直接取媒态像素：最可靠（拿到的是纯画面，不含宿主 UI/播放器遮罩的合成层问题）
  function captureViaCanvas() {
    try {
      const m = state.binding && state.binding.el; if (!m) return null;
      const w = m.videoWidth || m.naturalWidth || 0, h = m.videoHeight || m.naturalHeight || 0;
      if (!w || !h) return null;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(m, 0, 0);
      return c.toDataURL('image/png');           // 跨域会被 taint → 抛错 → null（由上层回落）
    } catch (e) { return null; }
  }
  async function captureFrame() {
    const rect = videoRect();
    // 1) 优先 canvas：桌面端窗口截图（xcap）拿不到视频合成层会黑屏；canvas 能拿到真实像素
    const viaCanvas = captureViaCanvas();
    if (viaCanvas) return viaCanvas;
    // 2) 回落：整窗/整屏截图 + 按媒态矩形裁剪（Tauri / 扩展）
    try {
      if (typeof window.vaCapture === 'function') {                                              // 自建浏览器（Tauri）
        const raw = await window.vaCapture(rect);
        return await cropToMedia(raw, rect);
      }
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {        // 扩展
        const resp = await new Promise((res) => chrome.runtime.sendMessage({ type: 'va-capture' }, res));
        return await cropToMedia(resp && resp.dataUrl, rect);
      }
    } catch (e) {}
    return null;
  }
  function contextText() {
    const list = state.entries.slice(-20).map((e) => '  - ' + e.word + (e.label ? '（' + e.label + '）' : '') + (e.pos ? ' [' + e.pos + ']' : '') + ' @' + e.t + 's').join('\n');
    return '我在看这个视频学英语，帮我讲解/陪练：\n' + videoContext() + '\n' + (list ? '我标注过的词：\n' + list + '\n' : '') +
      '\n请：1) 结合截图解释这些词在此语境下的意思；2) 给我一个例句；3) 用英文问我一个问题。';
  }
  async function copyRich(text, dataUrl) {
    try {
      if (typeof window.vaCopy === 'function') return !!(await window.vaCopy({ text, dataUrl }));   // 自建浏览器：富剪贴板
      if (!dataUrl) {   // 无图：直接文字
        await navigator.clipboard.writeText(text);
        return true;
      }
      const items = { 'text/plain': new Blob([text], { type: 'text/plain' }) };
      items['image/png'] = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem(items)]);
      return true;
    } catch (e) { return await fallbackCopy(text, !!dataUrl); }   // 富剪贴板失败 → 至少复制文字
  }
  function fallbackCopy(text, hadImage) {
    return new Promise((resolve) => {
      const ta = el('textarea', { position: 'fixed', left: '-9999px' });
      ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      resolve(!!ok && !hadImage);   // 回退只复制到文字：有图时视为「部分成功」(false)，无图成功=true
    });
  }
  // 一键：截图 + 上下文 → 剪贴板（到桌面豆包里粘贴即问）
  async function copyContext() {
    const text = contextText();
    const dataUrl = await captureFrame();
    const ok = await copyRich(text, dataUrl);
    if (!ok) { setSyncStatus('复制失败：浏览器拦了剪贴板，请手动选择文本'); return; }
    setSyncStatus(dataUrl ? '已复制「截图+上下文」→ 粘贴到桌面豆包' : '已复制文字（本环境无截图）→ 粘贴到桌面豆包');
  }
  async function shotOnly() {
    const d = await captureFrame();
    if (!d) { setSyncStatus('截图不可用（用扩展/自建浏览器）'); return; }
    const ok = await copyRich('', d);
    setSyncStatus(ok ? '截图已复制到剪贴板' : '复制失败（浏览器拦了剪贴板）');
  }
  // 存成 Markdown 笔记（→ Obsidian/Notebook）+ 标注写进 data.jsonl
  async function saveNote() {
    const shot = await captureFrame();
    const payload = {
      title: document.title, created: new Date().toISOString(),
      media: { platform: state.platform, videoId: state.mediaId, url: location.href },
      entries: state.entries, chat: [], screenshot: shot,
    };
    setSyncStatus('保存笔记中…');
    try {
      const base = await resolveBase();
      const r = await httpJson('POST', base + '/api/note', payload);
      if (r.ok && r.json && r.json.ok) setSyncStatus('已存笔记：' + r.json.path);
      else setSyncStatus('存笔记失败：' + ((r.json && r.json.error) || ('HTTP ' + r.status)));
    } catch (e) { setSyncStatus('存笔记失败：' + e.message); }
  }


  // 找不到视频时给个诊断入口（抖音等可能把 <video> 藏在 shadow DOM，或整页无视频）
  const probe = el('div'); probe.className = 'va-probe'; probe.style.display = 'none';
  probe.append(svgIcon('box'), el('span', null, '未检测到视频 · 查看诊断'));
  probe.setAttribute('role', 'button'); probe.tabIndex = 0;
  probe.onclick = () => { probe.style.display = 'none'; toggleDiag(); };
  probe.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); probe.click(); } };
  let noVideoSince = 0, probeTimer = null;
  function startProbe() {
    if (probeTimer) return;
    probeTimer = setInterval(() => {
      const plat = A.platform ? A.platform() : 'generic';
      const watchable = plat === 'bilibili' || plat === 'douyin' || plat === 'youtube';
      if (!watchable || state.binding || A.findVideo()) { noVideoSince = 0; probe.style.display = 'none'; return; }
      if (!noVideoSince) noVideoSince = Date.now();
      else if (Date.now() - noVideoSince > 3000) {
        if (probe.parentElement !== uiRoot) uiRoot.appendChild(probe);
        probe.style.display = 'block';
      }
    }, 1500);
  }
  startProbe();

  // 设置面板：同步地址 + 文件导入导出 + 清空
  const menuPanel = el('div', { display: 'none' });
  menuPanel.className = 'va-more-menu';
  const syncBox = el('input'); syncBox.className = 'va-input';
  syncBox.setAttribute('aria-label', '同步地址');
  // 默认词典链接模板（编辑器读同一个 key；须含 {word} 且为 http(s)）
  const dictBox = el('input'); dictBox.className = 'va-input';
  dictBox.setAttribute('aria-label', '默认词典链接模板');
  dictBox.placeholder = 'https://dictionary.cambridge.org/dictionary/english/{word}';
  async function saveDictTemplate() {
    const v = dictBox.value.trim();
    if (!v) {
      appSettings.dictUrlTemplate = '';
      try { localStorage.removeItem('annota:dictUrlTemplate'); } catch (e) {}
      await persistAppSettings();
      setSyncStatus('词典已恢复默认');
      return;
    }
    try {
      if (v.indexOf('{word}') < 0 || !isHttp(v)) { setSyncStatus('词典模板需含 {word} 且为 http(s)'); return; }
      localStorage.setItem('annota:dictUrlTemplate', v);
    } catch (e) {}
    appSettings.dictUrlTemplate = v;
    await persistAppSettings();
    setSyncStatus('词典模板已保存');
  }
  function toggleMenu() {
    const on = menuPanel.style.display === 'none';
    if (!on) { menuPanel.style.display = 'none'; btnCfg.classList.remove('is-active'); menuPanel.remove(); return; }
    btnCfg.classList.add('is-active');
    syncBox.value = syncUrl();
    try { dictBox.value = appSettings.dictUrlTemplate || localStorage.getItem('annota:dictUrlTemplate') || ''; } catch (e) {}
    const viewBtn = mkbtn(isView() ? '只读模式 · 已开启' : '只读模式', () => {
      try { localStorage.setItem('va:viewOnly', isView() ? '0' : '1'); } catch (e) {}
      applyMode();
      viewBtn.textContent = isView() ? '只读模式 · 已开启' : '只读模式';
    });
    const rowDir = el('div', { display: 'flex', gap: '5px', marginTop: '5px' }); rowDir.className = 'va-menu-row';
    rowDir.append(mkbtn('仅上传', uploadSync), mkbtn('仅下载', downloadSync), viewBtn);
    const row = el('div', { display: 'flex', gap: '5px', marginTop: '5px', flexWrap: 'wrap' }); row.className = 'va-menu-row';
    row.append(mkbtn('导出 Pack', exportJSON), mkbtn('导入 Pack', importJSON), mkbtn('清空当前', clearAll));
    menuPanel.textContent = '';
    const cands = (window.VA_SYNC_URLS || []).join('  ·  ');
    menuPanel.append(
      el('div', { color: '#9b8260', fontSize: '9px', fontWeight: '700', letterSpacing: '.1em', padding: '0 9px 3px' }, 'ANNOTATION TOOLS'),
      mkbtn('查看全部标注', () => togglePanel(true)),
      btnBridge,
      mkbtn('截图到剪贴板', shotOnly),
      mkbtn('保存为笔记', saveNote),
      btnDiag,
      el('div', { height: '1px', background: 'rgba(255,255,255,.08)', margin: '5px 3px' }),
      el('div', { color: '#9b8260', fontSize: '9px', fontWeight: '700', letterSpacing: '.1em', padding: '0 9px 3px' }, 'SYNC & FILES'),
      el('div', { color: '#89919b', fontSize: '10px', padding: '0 9px' }, '同步地址（留空=自动探测）'),
      syncBox,
      el('div', { display: 'flex', gap: '6px', marginTop: '6px' },
        mkbtn('保存地址', async () => {
          const v = syncBox.value.trim();
          if (v && !isHttp(v)) { setSyncStatus('同步地址必须是 http(s)://'); return; }
          appSettings.sync.address = v;
          if (v) setSyncBase(v); else { syncBase = null; try { localStorage.removeItem(SYNC_URL_KEY); } catch (e) {} }
          await persistAppSettings();
          setSyncStatus(v ? '同步地址已保存' : '已恢复自动');
        }),
        mkbtn('清空地址', async () => {
          appSettings.sync.address = '';
          localStorage.removeItem(SYNC_URL_KEY); syncBase = null; syncBox.value = '';
          await persistAppSettings(); setSyncStatus('已恢复自动');
        }),
        mkbtn('测试', testSync)),
      rowDir,
      row,
      el('div', { color: '#66717d', fontSize: '9px', padding: '2px 9px 0', overflowWrap: 'anywhere' }, cands ? '备选：' + cands : '默认 http://127.0.0.1:8793'),
      el('div', { height: '1px', background: 'rgba(255,255,255,.08)', margin: '5px 3px' }),
      el('div', { color: '#9b8260', fontSize: '9px', fontWeight: '700', letterSpacing: '.1em', padding: '0 9px 3px' }, 'DICTIONARY'),
      el('div', { color: '#89919b', fontSize: '10px', padding: '0 9px' }, '默认查词链接（用 {word} 占位）'),
      dictBox,
      el('div', { display: 'flex', gap: '6px', marginTop: '6px' },
        mkbtn('保存模板', saveDictTemplate),
        mkbtn('恢复默认', () => { dictBox.value = ''; try { localStorage.removeItem('annota:dictUrlTemplate'); } catch (e) {} setSyncStatus('词典已恢复默认'); })),
    );
    menuPanel.style.display = 'block';
    uiRoot.appendChild(menuPanel);
  }
  function setSyncStatus(msg) {
    const text = String(msg || '就绪');
    statusText.textContent = text;
    const error = /失败|异常|连不上|不可用/.test(text);
    const busy = /中…|测试中/.test(text);
    status.dataset.state = error ? 'error' : busy ? 'busy' : 'ready';
    if (error || /已同步|已上传|已下载|已保存|已复制/.test(text)) showToast(text, error);
  }

  function mkbtn(text, fn) {
    const b = el('button', null, text);
    b.type = 'button';
    b.className = 'va-btn';
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  }
  // el(tag, style, ...children)：children 可为字符串或节点（支持多个）
  function el(tag, style, ...kids) {
    const n = document.createElement(tag);
    if (style) for (const k in style) n.style[k] = style[k];
    for (const c of kids) {
      if (c == null || c === false) continue;
      n.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c);
    }
    return n;
  }

  /* ---------- 生命周期 ---------- */
  // 常驻 UI 外壳：即使页面没有可自动绑定的媒态，也保留 dock（含「选对象」入口）
  let shellMounted = false;
  function mountShell() {
    if (shellMounted) return;
    shellMounted = true;
    uiRoot.append(overlay, bar, sidePanel, toast);
  }

  function attach(target) {
    // 兼容：adapter 回调 {kind, el}；也接受裸 <video>
    const normalized = target && target.el !== undefined ? target : { kind: 'video', el: target };
    const binding = VAMedia.create(normalized);
    if (!binding) return;
    // 同一 binding 不重复挂（article 的 el 为 null，改用 kind+rootEl 判等）
    if (state.binding && state.binding.kind === binding.kind && state.binding.el === binding.el && state.binding.rootEl === binding.rootEl) return;
    if (state.binding) detach();
    state.binding = binding;
    state.mediaId = binding.mediaId();
    state.platform = binding.mediaMeta().platform;
    load(); save(); render();
    mountShell();
    toast.classList.remove('is-visible', 'is-error');
    renderPanel();
    lastSig = null;
    applyMode();
    startProbe();
    scheduleReconcile();     // 先只读选版显示（服务器更新 → 显示服务器版；覆盖本地要用户选）
    scheduleAutoSync();      // 自动同步：仅在开启时把本地当前版推上服务器
    if (!raf) raf = requestAnimationFrame(loop);
  }

  // 无绑定媒态：只保留 dock 与「选对象」，隐藏画面标注层
  function detachBinding() {
    if (state.binding) state.binding.destroy();
    state.binding = null; state.meta = null; lastSig = null; autoSyncedMedia = null;
    raf = null;   // 停帧；下次 attach 会重新启动 loop
    overlay.style.display = 'none';
    if (state.picking) togglePicker(false);
    renderPanel();
  }

  let raf = null, lastSig = null, autoSyncTimer = null, autoSyncedMedia = null, reconciledMedia = null;
  // 打开媒体：只读选版显示（不写不对齐）；覆盖本地由用户选，可记忆
  function scheduleReconcile() {
    if (!state.mediaId || reconciledMedia === state.mediaId) return;
    reconciledMedia = state.mediaId;
    setTimeout(() => { try { reconcileOnOpen(state.mediaId); } catch (e) {} }, 400);
  }
  function scheduleAutoSync() {
    if (!AUTO_SYNC || !state.mediaId || autoSyncedMedia === state.mediaId) return;
    autoSyncedMedia = state.mediaId;
    if (autoSyncTimer) clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => { autoSyncTimer = null; try { syncNow(); } catch (e) {} }, 900);
  }
  function loop() {
    const binding = state.binding;
    if (!binding || !binding.tick()) { detachBinding(); return; }   // 无媒态：停帧，等 A.watch 再 attach
    raf = requestAnimationFrame(loop);

    // SPA 切换（视频换集 / 画廊换图）：mediaId 变了就换一份标注
    const mid = binding.mediaId();
    if (mid !== state.mediaId) { state.mediaId = mid; load(); render(); renderPanel(); autoSyncedMedia = null; reconciledMedia = null; scheduleReconcile(); scheduleAutoSync(); }

    // 全屏宿主处理：只有 fullscreen 元素的后代可见
    const fs = document.fullscreenElement;
    let host = document.body, unsupported = false;
    if (fs) { if (fs.tagName === 'VIDEO' || fs.tagName === 'IMG') unsupported = true; else host = fs; }
    if (uiHost.parentElement !== host) host.appendChild(uiHost);

    if (unsupported) {
      overlay.style.display = 'none'; bar.style.display = 'none';
      toast.textContent = '视频元素处于系统全屏，浏览器不允许叠加。请切换到网页全屏或影院模式。';
      toast.classList.add('is-visible', 'is-error');
      state.meta = { unsupported: true };
      return;
    }

    const layout = binding.layout();
    if (!layout) { detachBinding(); return; }
    toast.classList.remove('is-visible', 'is-error');
    bar.style.display = 'flex';

    const r = layout.rect;
    state.rect = r;
    state.cr = layout.cr;
    state.meta = { fit: layout.fit, host: host.tagName, unsupported: false };

    overlay.style.display = 'block';
    // overlay 始终覆盖视口；标记用视口坐标（对长图/滚动图也正确）
    overlay.style.left = '0px'; overlay.style.top = '0px';
    overlay.style.width = '100vw'; overlay.style.height = '100vh';

    if (!state.renderLock) {
      if (state.dragging && state.draft) drawDraft();
      // 重绘触发：按「当前应显示的条目集合」签名；showAll 时是全集，否则是按可见性过滤的子集。
      // 无轴媒态（图片/文章）可见性恒真 → 签名稳定，天然只渲染一次；滚动进出视口时会变化并重绘。
      const sig = (state.showAll ? state.entries : state.entries.filter((e) => binding.isVisible(e)))
        .map((e) => e.id).join(',');
      if (sig !== lastSig) { lastSig = sig; render(); }
    }
  }

  function detach() {
    if (raf) cancelAnimationFrame(raf); raf = null;
    if (diagTimer) { clearInterval(diagTimer); diagTimer = null; }
    if (autoSyncTimer) { clearTimeout(autoSyncTimer); autoSyncTimer = null; }
    if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
    overlay.remove(); bar.remove(); sidePanel.remove(); diagPanel.remove(); toast.remove(); menuPanel.remove(); probe.remove();
    uiRoot.querySelectorAll('.va-popover').forEach((n) => n.remove());
    shellMounted = false;   // 关键：壳被移除，允许 mountShell 重新挂载（否则重绑时 overlay/dock 再也不出现）
    panelOpen = false;
    if (state.binding) state.binding.destroy();
    state.binding = null; state.meta = null; lastSig = null; autoSyncedMedia = null;
  }

  /* ---------- 渲染 ---------- */
  // 图片版本校验：anchored 时的图 URL / 原始尺寸与当前不符 → 标记 stale（不静默错位）
  function imgStale(e) {
    const b = state.binding;
    if (!b || b.kind !== 'image' || !b.el || !e.img) return false;
    const cur = b.el.currentSrc || b.el.src || '';
    if (e.img.key && cur && e.img.key !== cur) return true;
    const n = e.img.natural;
    return !!(n && (n.w && n.w !== b.el.naturalWidth || n.h && n.h !== b.el.naturalHeight));
  }

  function drawEntry(e) {
    const binding = state.binding, cr = state.cr;
    if (!binding || !cr || !e) return;
    const rects = binding.entryRects(e, cr);
    for (const p of rects) {
      // 视口坐标（overlay 覆盖整视口）
      const left = p.left, top = p.top;
      const box = el('div', {
        position: 'absolute', left: left + 'px', top: top + 'px',
        width: (p.width != null ? p.width : p.w) + 'px', height: (p.height != null ? p.height : p.h) + 'px',
      });
      box.className = 'va-mark';
      if (imgStale(e)) { box.classList.add('is-stale'); box.title = '图片版本已变，锚点可能需复核'; }
      const markText = entryText(e);
      const lab = el('span', {}, markText + (e.label && e.label !== markText ? ' ' + e.label : ''));
      lab.className = 'va-mark-label';
      box.appendChild(lab);
      box.onclick = (ev) => { ev.stopPropagation(); openEntryPop(e, ev.clientX, ev.clientY); };
      layer.appendChild(box);
    }
  }

  function render() {
    layer.textContent = '';
    state.exportOnly = null;
    const binding = state.binding; if (!binding) return;
    const cr = state.cr; if (!cr) return;
    for (const e of state.entries) {
      if (isHidden(e)) continue;                       // 本地隐藏：画面上不渲染
      if (!state.showAll && !binding.isVisible(e)) continue;
      drawEntry(e);
    }
  }

  function renderOnly(entry) {
    layer.textContent = '';
    state.exportOnly = entry || null;
    if (entry && state.binding && state.cr) drawEntry(entry);
  }

  function setChromeHidden(hidden) {
    const on = !!hidden;
    uiRoot.dataset.uiHidden = on ? '1' : '';
    if (on) setPageCursor('');
    else if (state.annotate && !state.picking) setPageCursor('crosshair');
  }

  function drawDraft() {
    layer.textContent = '';
    const cr = state.cr, d = state.draft;
    const b = G.dragToBox(d.x0, d.y0, d.x1, d.y1, cr);
    const p = G.boxToPixels(b, cr);
    const box = el('div', {
      position: 'absolute', left: p.left + 'px', top: p.top + 'px',
      width: p.width + 'px', height: p.height + 'px',
    });
    box.className = 'va-draft-mark';
    layer.appendChild(box);
  }

  /* ---------- 标注交互 ---------- */
  const isQuoteMode = () => !!(state.binding && state.binding.capture === 'quote');

  /* ---------- 手动选择对象（picker） ---------- */
  const pickBox = el('div'); pickBox.className = 'va-pick-box'; pickBox.style.display = 'none';
  const pickHint = el('div', null, '移动鼠标选中图片 / 视频 / 正文，点击确定；Esc 取消');
  pickHint.className = 'va-pick-hint'; pickHint.style.display = 'none';
  uiRoot.append(pickBox, pickHint);

  function pickerMove(ev) {
    let target = null;
    try { target = document.elementFromPoint(ev.clientX, ev.clientY); } catch (e) {}
    const hit = target ? A.classify(target) : null;
    if (!hit) { pickBox.style.display = 'none'; pickHint.dataset.valid = '0'; pickHint.textContent = '此处不可标注；移动到图片 / 视频 / 正文上'; pickHint.style.display = 'block'; return; }
    const r = (hit.kind === 'article' ? hit.el : hit.el).getBoundingClientRect();
    pickBox.style.display = 'block';
    pickBox.style.left = r.left + 'px'; pickBox.style.top = r.top + 'px';
    pickBox.style.width = r.width + 'px'; pickBox.style.height = r.height + 'px';
    pickHint.dataset.valid = '1';
    pickHint.textContent = ({ video: '视频', image: '图片', article: '正文' })[hit.kind] + ' · 点击选中';
    pickHint.style.display = 'block';
  }
  function pickerClick(ev) {
    let target = null;
    try { target = document.elementFromPoint(ev.clientX, ev.clientY); } catch (e) {}
    const hit = target ? A.classify(target) : null;
    if (!hit) return;
    ev.preventDefault(); ev.stopPropagation();
    togglePicker(false);
    attach({ kind: hit.kind, el: hit.el });
    showToast('已选定' + ({ video: '视频', image: '图片', article: '正文' })[hit.kind]);
    // 图片/视频：选完直接进入标注模式，用户可立即拖框
    if (hit.kind !== 'article' && !isView()) toggleAnnotate(true);
  }
  function togglePicker(force) {
    const on = force != null ? force : !state.picking;
    state.picking = on;
    btnPick.classList.toggle('is-active', on);
    pickBox.style.display = 'none';
    pickHint.style.display = on ? 'block' : 'none';
    if (on) {
      // picker 期间 UI 让出指针，便于点到页面元素；同时压过站点光标（如 pexels 的放大镜）
      capture.style.pointerEvents = 'none';
      overlay.style.pointerEvents = 'none';
      setPageCursor('crosshair');
      document.addEventListener('mousemove', pickerMove, true);
      document.addEventListener('click', pickerClick, true);
      showToast('选择一个要标注的对象');
    } else {
      document.removeEventListener('mousemove', pickerMove, true);
      document.removeEventListener('click', pickerClick, true);
      setPageCursor('');
      overlay.style.pointerEvents = 'none';   // 恢复默认（overlay 本身不拦截）
      applyMode();
    }
  }

  // 用 !important 覆盖站点自身光标（否则 pexels 图片的 zoom-in 盖过我们的 crosshair）
  let cursorStyleEl = null;
  function setPageCursor(cursor) {
    if (!cursor) { if (cursorStyleEl) { cursorStyleEl.remove(); cursorStyleEl = null; } return; }
    if (!cursorStyleEl) {
      const host = document.head || document.documentElement;
      if (!host || !host.appendChild) return;   // 罕见环境无 head/documentElement 时跳过
      cursorStyleEl = document.createElement('style');
      cursorStyleEl.id = 'annota-cursor';
      host.appendChild(cursorStyleEl);
    }
    cursorStyleEl.textContent = 'html,body,*{cursor:' + cursor + ' !important}';
  }

  function toggleAnnotate(force) {
    if (!state.binding) { showToast('先点「选对象」选定要标注的图片 / 视频 / 正文'); return; }
    state.annotate = force != null ? force : !state.annotate;
    // 文章划词：不拦截指针（要能选字），改为听 mouseup 读选区
    const quote = isQuoteMode();
    capture.style.pointerEvents = (state.annotate && !quote) ? 'auto' : 'none';
    btnAnno.classList.toggle('is-active', state.annotate);
    if (state.annotate && state.binding) state.binding.beginAnnotate();
    if (quote) {
      capture.style.display = 'none';
      if (state.annotate) showToast('选中正文里的文字即可标注');
    } else {
      capture.style.display = 'block';
      // 标注模式也用 crosshair，压过站点光标（如 pexels 的放大镜）
      if (!state.picking) setPageCursor(state.annotate ? 'crosshair' : '');
    }
    render();
  }

  // 文章划词提交
  function handleQuoteSelection() {
    const b = state.binding;
    if (!b || b.capture !== 'quote' || !b.serializeSelection) return;
    const quote = b.serializeSelection();
    if (!quote) return;
    askWord(null, { quote, suggested: false });
  }
  document.addEventListener('mouseup', () => {
    if (!state.annotate || !isQuoteMode()) return;
    setTimeout(() => {
      if (uiRoot.querySelector('.va-popover[aria-label="新建标注"]')) return;   // 已开着编辑卡
      handleQuoteSelection();
    }, 0);
  });

  capture.addEventListener('pointerdown', (e) => {
    if (!state.annotate) return;
    if (state.binding) state.binding.beginAnnotate();
    state.dragging = true;
    state.draft = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    capture.setPointerCapture(e.pointerId);
  });
  capture.addEventListener('pointermove', (e) => {
    if (!state.dragging) return;
    state.draft.x1 = e.clientX; state.draft.y1 = e.clientY;
    drawDraft();
  });
  capture.addEventListener('pointerup', (e) => {
    if (!state.dragging) return;
    state.dragging = false;
    const b = G.dragToBox(state.draft.x0, state.draft.y0, e.clientX, e.clientY, state.cr);
    state.draft = null;
    if (b.w * b.h < 0.0009) { render(); return; }   // 太小的框忽略
    askWord(b);
  });

  function askWord(box, initial) {
    initial = initial || {};
    const quoteMode = !!initial.quote;
    // 弹窗定位：框标注用框左上角；划词用选区矩形；都给不出来则居中
    let p = null;
    if (quoteMode) {
      const gs = (typeof window !== "undefined" && window.getSelection) ? window.getSelection() : null; const sel = gs;
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        p = { left: r.left, top: r.bottom };
      }
    } else if (box && state.cr) {
      p = G.boxToPixels(box, state.cr);
    }
    const width = Math.min(360, innerWidth - 24);
    const pop = el('div');
    pop.className = 'va-popover' + (initial.suggested ? ' va-ai-proposal' : '');
    pop.dataset.vaPop = '1'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', '新建标注');
    pop.style.left = Math.max(12, Math.min((p ? p.left : innerWidth / 3), innerWidth - width - 12)) + 'px';
    pop.style.top = Math.max(12, Math.min((p ? p.top + 8 : innerHeight / 3), innerHeight - 410)) + 'px';

    const head = el('div'); head.className = 'va-pop-head';
    const heading = el('div'); heading.className = 'va-pop-heading';
    const eyebrow = el('div', null, initial.suggested ? 'AI SUGGESTION · REVIEW' : (quoteMode ? 'TEXT SELECTED' : 'REGION CAPTURED')); eyebrow.className = 'va-eyebrow';
    heading.append(eyebrow, el('strong', null, initial.suggested ? '确认 AI 标注' : '新建标注'),
      el('span', null, quoteMode ? '已选中正文文字；填写标题、评论或标签。' : '标题、评论、标签至少填一个，也都能稍后补。'));
    const close = mkIconButton('关闭编辑卡', 'close', () => pop.remove()); close.classList.add('va-close');
    head.append(heading, close);

    const wordLabel = el('label', null, '标题 / 词语'); wordLabel.className = 'va-field-label';
    const wIn = el('input'); wIn.className = 'va-input'; wIn.placeholder = '词、句子或标题（可留空）'; wIn.autocomplete = 'off'; wIn.maxLength = 120;
    wIn.value = initial.word || '';
    wIn.setAttribute('aria-label', '标题或词语（选填）');
    const label = el('label', null, '评论 / 备注（选填）'); label.className = 'va-field-label';
    const lIn = el('input'); lIn.className = 'va-input'; lIn.placeholder = '写下此处语境里的意思或你的批注'; lIn.maxLength = 300; lIn.value = initial.label || '';
    lIn.setAttribute('aria-label', '评论或备注（选填）');
    const detailRow = el('div', { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '9px', alignItems: 'end' });
    const tagWrap = el('label', { display: 'block' });
    const tagLabel = el('span', null, '标签'); tagLabel.className = 'va-field-label';
    const tagBox = el('div'); tagBox.className = 'va-tag-box';
    const tagInput = el('input'); tagInput.className = 'va-tag-input'; tagInput.placeholder = '回车添加标签'; tagInput.maxLength = 40; tagInput.setAttribute('aria-label', '标签');
    const presetRow = el('div'); presetRow.className = 'va-tag-presets';
    for (const p of ['英语学习', '雅思', '日语', '校对', '情报', '待复习']) { const c = mkbtn(p, () => addTag(p)); c.className = 'va-chip'; presetRow.appendChild(c); }
    tagWrap.append(tagLabel, tagBox, presetRow);
    let tagList = entryTags(initial).slice();
    function renderTags() {
      tagBox.textContent = '';
      for (const t of tagList) {
        const chip = el('span'); chip.className = 'va-tag-chip';
        const tx = el('span', null, '#' + t);
        const x = mkIconButton('移除标签 ' + t, 'close', (ev) => { if (ev) ev.stopPropagation(); tagList = tagList.filter((v) => v !== t); renderTags(); updateDictionary(); });
        x.classList.add('va-tag-x');
        chip.append(tx, x); tagBox.appendChild(chip);
      }
      tagBox.appendChild(tagInput);
    }
    function addTag(raw) {
      const t = String(raw || '').trim().replace(/^[#\s]+/, '');
      if (t && !tagList.includes(t) && tagList.length < 12) { tagList.push(t); renderTags(); updateDictionary(); }
      tagInput.value = '';
    }
    tagInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ',' || ev.key === '，') { ev.preventDefault(); ev.stopPropagation(); addTag(tagInput.value); } });
    renderTags();

    const timeLabel = el('label', null, '出现时间'); timeLabel.className = 'va-field-label';
    const timeRow = el('div'); timeRow.className = 'va-time-row';
    const tIn = el('input'); tIn.className = 'va-input'; tIn.type = 'number'; tIn.min = '0'; tIn.step = '0.1';
    const timed = !state.binding || state.binding.timed;
    const nowTime = () => (state.binding ? state.binding.time() : 0);
    tIn.value = String(r2(initial.t == null ? nowTime() : initial.t)); tIn.setAttribute('aria-label', '出现时间（秒）');
    const nowButton = mkbtn('用当前时间', () => { tIn.value = String(r2(nowTime())); });
    timeRow.append(tIn, nowButton);
    const durationLabel = el('label', null, '显示时长'); durationLabel.className = 'va-field-label';
    const dIn = el('input'); dIn.className = 'va-input'; dIn.type = 'number'; dIn.min = '0.2'; dIn.step = '0.1'; dIn.value = String(initial.dur || DEFAULT_DUR);
    dIn.setAttribute('aria-label', '显示时长（秒）');
    const durationWrap = el('label'); durationWrap.append(durationLabel, dIn);
    if (timed && !quoteMode) detailRow.append(tagWrap, durationWrap);
    else detailRow.append(tagWrap);
    const durChips = el('div'); durChips.className = 'va-duration';
    for (const seconds of [0.5, 1, 2, 3]) {
      const chip = mkbtn(seconds + 's', () => {
        dIn.value = String(seconds);
        durChips.querySelectorAll('.va-chip').forEach((n) => n.classList.toggle('is-active', n === chip));
      });
      chip.className = 'va-chip' + (seconds === Number(dIn.value) ? ' is-active' : '');
      durChips.appendChild(chip);
    }

    const dictionary = el('div'); dictionary.className = 'va-dictionary';
    const dictionaryLabel = el('span', null, '查词'); dictionaryLabel.className = 'va-dictionary-label';
    dictionary.appendChild(dictionaryLabel);
    // 默认词典链接模板：localStorage `annota:dictUrlTemplate`（含 {word} 占位，须 http(s)）；隐私模式读取可能抛，回退剑桥
    const dictTemplate = (function () {
      try {
        const v = appSettings.dictUrlTemplate || localStorage.getItem('annota:dictUrlTemplate');
        if (v && v.indexOf('{word}') >= 0 && isHttp(v)) return v;
      } catch (e) {}
      return 'https://dictionary.cambridge.org/dictionary/english/{word}';
    })();
    const dictLinks = [
      ['查词', (word) => dictTemplate.replace('{word}', encodeURIComponent(word))],
      ['有道', (word) => 'https://www.youdao.com/result?word=' + encodeURIComponent(word) + '&lang=en'],
      ['欧路', (word) => 'https://dict.eudic.net/dicts/en/' + encodeURIComponent(word)],
    ].map(([name, href]) => {
      const a = el('a', null, name); a.href = href(''); a.target = '_blank'; a.rel = 'noopener noreferrer'; a.dataset.dict = name; a.dataset.template = '1';
      a.addEventListener('click', (ev) => { if (!wIn.value.trim()) { ev.preventDefault(); wIn.focus(); } });
      dictionary.appendChild(a); return { a, href };
    });
    function updateDictionaryLinks() { for (const d of dictLinks) d.a.href = d.href(wIn.value.trim()); }
    // 词典按标签触发：出现语言学习类标签（英语/日语/雅思…）才显示查词外链
    function updateDictionary() { updateDictionaryLinks(); dictionary.style.display = tagList.some(isLangTag) ? '' : 'none'; }
    wIn.addEventListener('input', updateDictionary);
    updateDictionary();

    const actions = el('div'); actions.className = 'va-pop-actions';
    const cancel = mkbtn('取消', () => pop.remove());
    const saveButton = mkbtn(initial.suggested ? '确认并保存' : '保存并继续播放', commit); saveButton.classList.add('va-btn-primary');
    actions.append(cancel, saveButton);
    pop.append(head, wordLabel, wIn, label, lIn);
    if (quoteMode) {
      const q = initial.quote || {};
      const qLabel = el('label', null, '锚定文字'); qLabel.className = 'va-field-label';
      const qBox = el('div', null, (q.exact || '').slice(0, 160) + ((q.exact || '').length > 160 ? '…' : ''));
      qBox.className = 'va-quote-preview';
      pop.append(qLabel, qBox);
    }
    pop.append(detailRow);
    if (timed && !quoteMode) pop.append(timeLabel, timeRow, durChips);
    pop.append(dictionary, actions);
    wIn.addEventListener('input', () => wIn.removeAttribute('aria-invalid'));

    function commit() {
      if (tagInput.value.trim()) addTag(tagInput.value);
      const word = wIn.value.trim();
      const label2 = lIn.value.trim();
      const tags = tagList.slice();
      if (!word && !label2 && !tags.length) { wIn.focus(); wIn.setAttribute('aria-invalid', 'true'); showToast('标题、评论、标签至少填一个'); return; }
      const nowIso = new Date().toISOString();
      const entry = {
        id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        word, label: label2, tags,
        created: nowIso, updated: nowIso,
      };
      if (quoteMode && initial.quote) entry.quote = initial.quote;
      else entry.box = box;
      if (timed && !quoteMode) {
        entry.t = Math.max(0, r2(parseFloat(tIn.value)));
        entry.dur = Math.max(0.2, r2(parseFloat(dIn.value) || DEFAULT_DUR));
      }
      // 图片：记录锚定证据，供跨尺寸/换图时校验（Step 6.3）
      if (state.binding && state.binding.kind === 'image' && state.binding.el) {
        const el2 = state.binding.el;
        entry.img = { key: el2.currentSrc || el2.src || '', natural: { w: el2.naturalWidth, h: el2.naturalHeight } };
      }
      state.entries.push(entry);
      state.displayVersion = 'local';   // 本地新建 → 之后同步应推本地
      save(); pop.remove(); render();
      if (state.binding) state.binding.endAnnotate();
      const s = (typeof window !== "undefined" && window.getSelection) ? window.getSelection() : null; if (s && s.removeAllRanges) s.removeAllRanges();
      showToast('已保存标注 · ' + entryText(entry));
    }
    pop.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); pop.remove(); }
      else if (ev.key === 'Enter' && ev.target !== nowButton) { ev.preventDefault(); commit(); }
    });
    uiRoot.appendChild(pop);
    if (innerWidth > 620) {
      const popRect = pop.getBoundingClientRect();
      if (popRect.bottom > innerHeight - 12) pop.style.top = Math.max(12, innerHeight - popRect.height - 12) + 'px';
    }
    wIn.focus({ preventScroll: true });
  }

  // Agent/MCP 只能把候选区域送进确认卡；用户点击保存后才写入标注。
  window.__ANNOTA_UI__ = {
    openPanel: () => togglePanel(true),
    closePanel: () => togglePanel(false),
    startAnnotating: () => toggleAnnotate(true),
    proposeAnnotation(payload) {
      if (!state.binding || !payload) return false;
      // 文章：quote 锚点
      if (payload.quote && payload.quote.exact) {
        const quote = {
          exact: String(payload.quote.exact),
          prefix: payload.quote.prefix != null ? String(payload.quote.prefix) : '',
          suffix: payload.quote.suffix != null ? String(payload.quote.suffix) : '',
        };
        state.binding.beginAnnotate(); toggleAnnotate(false);
        askWord(null, { ...payload, quote, suggested: true });
        return true;
      }
      // 视频/图片：box
      if (!payload.box) return false;
      const values = ['x', 'y', 'w', 'h'].map((k) => Number(payload.box[k]));
      if (!values.every(Number.isFinite)) return false;
      const box = G.clampBox({ x: values[0], y: values[1], w: values[2], h: values[3] });
      state.binding.beginAnnotate(); toggleAnnotate(false);
      askWord(box, { ...payload, suggested: true });
      return true;
    },
  };

  function openEntryPop(e, x, y) {
    if (state.binding) state.binding.beginAnnotate();
    const timed = !state.binding || state.binding.timed;
    const pop = el('div'); pop.className = 'va-popover'; pop.dataset.vaPop = '1';
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', '标注详情');
    pop.style.left = Math.max(12, Math.min((Number(x) || 0) + 10, innerWidth - 372)) + 'px';
    pop.style.top = Math.max(12, Math.min((Number(y) || 0) + 10, innerHeight - 430)) + 'px';
    const dur = e.dur || DEFAULT_DUR;
    const head = el('div'); head.className = 'va-pop-head';
    const heading = el('div'); heading.className = 'va-pop-heading';
    const eyebrow = el('div', null, 'ANNOTATION'); eyebrow.className = 'va-eyebrow';
    heading.append(eyebrow, el('strong', null, entryText(e)), el('span', null, (e.label || '未添加备注') + (entryTags(e).length ? ' · ' + entryTags(e).map((t) => '#' + t).join(' ') : '')));
    const close = mkIconButton('关闭词条详情', 'close', () => pop.remove()); close.classList.add('va-close');
    head.append(heading, close);
    const range = el('div'); range.className = 'va-range';
    pop.append(head, range);

    const tIn = el('input'); tIn.className = 'va-input'; tIn.type = 'number'; tIn.min = '0'; tIn.step = '0.1'; tIn.value = String(e.t); tIn.setAttribute('aria-label', '开始时间（秒）');
    const dIn = el('input'); dIn.className = 'va-input'; dIn.type = 'number'; dIn.min = '0.2'; dIn.step = '0.1'; dIn.value = String(dur); dIn.setAttribute('aria-label', '显示时长（秒）');
    const updRange = () => {
      if (timed) {
        const start = Math.max(0, parseFloat(tIn.value) || 0);
        range.textContent = formatTime(start) + ' – ' + formatTime(start + (parseFloat(dIn.value) || dur));
      } else if (e.quote && e.quote.exact) {
        range.textContent = '“' + e.quote.exact.slice(0, 80) + (e.quote.exact.length > 80 ? '…”' : '”');
      } else {
        range.textContent = state.binding && state.binding.kind === 'article' ? '整段文字' : '静态图片标注';
      }
    };
    tIn.addEventListener('input', updRange); dIn.addEventListener('input', updRange);
    const dictionary = el('div'); dictionary.className = 'va-dictionary';
    const dictLabel = el('span', null, '查词'); dictLabel.className = 'va-dictionary-label'; dictionary.appendChild(dictLabel);
    for (const [name, href] of [
      ['剑桥', 'https://dictionary.cambridge.org/dictionary/english/' + encodeURIComponent(e.word || '')],
      ['有道', 'https://www.youdao.com/result?word=' + encodeURIComponent(e.word || '') + '&lang=en'],
      ['欧路', 'https://dict.eudic.net/dicts/en/' + encodeURIComponent(e.word || '')],
    ]) {
      const a = el('a', null, name); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; dictionary.appendChild(a);
    }
    if (!entryTags(e).some(isLangTag)) dictionary.style.display = 'none';
    pop.appendChild(dictionary);

    if (isView()) {
      const actions = el('div'); actions.className = 'va-pop-actions';
      actions.append(mkbtn('跳转到画面', () => { if (state.binding) state.binding.locate(e); pop.remove(); }), mkbtn('关闭', () => pop.remove()));
      if (timed) pop.append(el('div', null, formatTime(e.t) + ' · 显示 ' + dur + ' 秒'), actions);
      else pop.append(actions);
      uiRoot.appendChild(pop);
      return;
    }

    const wordInput = el('input'); wordInput.className = 'va-input'; wordInput.value = e.word || ''; wordInput.placeholder = '词、句子或标题（可留空）'; wordInput.setAttribute('aria-label', '标题或词语');
    const labelInput = el('input'); labelInput.className = 'va-input'; labelInput.value = e.label || ''; labelInput.placeholder = '评论 / 备注（选填）'; labelInput.setAttribute('aria-label', '评论或备注');
    const tagsInput = el('input'); tagsInput.className = 'va-input'; tagsInput.value = entryTags(e).join(' '); tagsInput.placeholder = '标签，空格或逗号分隔'; tagsInput.setAttribute('aria-label', '标签');
    const timeLabel = el('label', null, '出现时间'); timeLabel.className = 'va-field-label';
    const timeRow = el('div'); timeRow.className = 'va-time-row';
    const now = mkbtn('用当前时间', () => { tIn.value = state.binding ? String(r2(state.binding.time())) : String(e.t); updRange(); });
    timeRow.append(tIn, now);
    const durationLabel = el('label', null, '显示时长'); durationLabel.className = 'va-field-label';
    const actions = el('div'); actions.className = 'va-pop-actions';
    const jump = mkbtn('跳转', () => { if (state.binding) state.binding.seek(parseFloat(tIn.value) || e.t); pop.remove(); });
    const remove = mkbtn('删除', () => { state.entries = state.entries.filter((item) => item !== e); state.displayVersion = 'local'; save(); pop.remove(); render(); showToast('已删除标注'); });
    remove.classList.add('va-btn-danger');
    const saveButton = mkbtn('保存修改', () => {
      const word = wordInput.value.trim();
      const label2 = labelInput.value.trim();
      const tags = tagsInput.value.split(/[\s,，]+/).map((t) => t.replace(/^[#\s]+/, '').trim()).filter(Boolean).slice(0, 12);
      if (!word && !label2 && !tags.length) { wordInput.focus(); showToast('标题、评论、标签至少填一个'); return; }
      e.word = word; e.label = label2; e.tags = tags;
      e.updated = new Date().toISOString();
      state.displayVersion = 'local';   // 本地修改 → 之后同步应推本地
      if (timed) {
        e.t = Math.max(0, r2(parseFloat(tIn.value)));
        e.dur = Math.max(0.2, r2(parseFloat(dIn.value) || DEFAULT_DUR));
      }
      save(); render(); pop.remove(); showToast('标注已更新');
    });
    saveButton.classList.add('va-btn-primary');
    if (timed) actions.append(jump);
    actions.append(remove, saveButton);
    pop.append(el('label', null, '标题 / 词语（选填）'), wordInput, el('label', null, '评论 / 备注（选填）'), labelInput, el('label', null, '标签'), tagsInput);
    if (timed) pop.append(timeLabel, timeRow, durationLabel, dIn);
    pop.append(actions);
    pop.querySelectorAll('.va-popover > label').forEach((n) => { n.className = 'va-field-label'; });
    updRange();
    uiRoot.appendChild(pop);
    wordInput.focus({ preventScroll: true });
  }

  /* ---------- 同步 ---------- */
  const SYNC_URL_KEY = 'va:syncUrl';
  const DEFAULT_SYNC = 'http://127.0.0.1:8793';
  let syncBase = (function () { try { return localStorage.getItem(SYNC_URL_KEY) || null; } catch (e) { return null; } })();

  // 构建时烧入的候选地址（本机 127.0.0.1 / 局域网 IP / .local），运行期自动探测，零配置
  function syncCandidates() {
    const a = (window.VA_SYNC_URLS && window.VA_SYNC_URLS.length) ? window.VA_SYNC_URLS.slice() : [];
    if (a.indexOf(DEFAULT_SYNC) < 0) a.push(DEFAULT_SYNC);
    return a.map((u) => String(u).replace(/\/+$/, ''));
  }
  function syncUrl() { return (syncBase || syncCandidates()[0]).replace(/\/+$/, ''); }

  // 只允许 http(s)（挡掉 javascript:/data:/file: 等，防标注数据被外发到意外 scheme）
  function isHttp(u) { return /^https?:\/\//i.test(String(u || '')); }
  function setSyncBase(u) {
    u = (u || '').trim().replace(/\/+$/, '');
    if (!u) return;
    if (!isHttp(u)) { setSyncStatus('同步地址必须是 http(s)://'); return; }
    syncBase = u;
    try { localStorage.setItem(SYNC_URL_KEY, u); } catch (e) {}
  }
  async function resolveBase() {
    if (syncBase) return syncBase.replace(/\/+$/, '');
    for (const u of syncCandidates()) {
      if (!isHttp(u)) continue;
      try { const r = await httpJson('GET', u + '/api/health'); if (r.ok && r.json && r.json.ok) { syncBase = u; return u; } } catch (e) {}
    }
    return syncUrl();
  }

  function mediaMeta() {
    if (state.binding) return state.binding.mediaMeta();
    return {
      platform: state.platform, type: 'video', mediaId: state.mediaId, videoId: state.mediaId,
      url: location.href, title: document.title,
    };
  }
  function pack() { return { format: FORMAT, media: mediaMeta(), entries: state.entries }; }
  // 推送包：本地为主 → replace=true，服务器以本次推送为准（云存储/分享/公开）
  function pushPack() { return { format: FORMAT, media: mediaMeta(), entries: state.entries, replace: true }; }

  function validBox(b) {
    return b && typeof b === 'object' &&
      ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(b[k]));
  }
  function validQuote(q) {
    if (!q || typeof q !== 'object') return false;
    const exact = typeof q.exact === 'string' ? q.exact.trim() : '';
    return !!exact;   // quote 只需非空 exact；prefix/suffix 可选
  }
  // box 与 quote 二选一即可（文章 = quote，视频/图片 = box）
  function validAnchor(e) { return validBox(e && e.box) || validQuote(e && e.quote); }
  // 通用批注：word 可空，标签/备注至少一个（§8.3 A）
  function entryTags(e) { return Array.isArray(e && e.tags) ? e.tags.filter(Boolean).map(String) : []; }
  function entryHasContent(e) {
    return !!(String((e && e.word) || '').trim() || entryTags(e).length || String((e && e.label) || '').trim());
  }
  function entryText(e) {
    if (!e) return '';
    const w = String(e.word || '').trim();
    if (w) return w;
    const tags = entryTags(e);
    if (tags.length) return tags[0];
    const label = String(e.label || '').trim();
    return label ? label.slice(0, 40) : '标注';
  }
  const LANG_TAGS = ['英语', '英文', '日语', '法语', '德语', '西班牙语', '韩语', '俄语',
    '雅思', '托福', '考研', '四六级', '专四', '专八', '英语学习', '语言学习'];
  function isLangTag(t) { t = String(t || ''); return LANG_TAGS.includes(t) || /语$/.test(t) || /^(英语|日语|法语|德语|韩语|西班牙|俄语|葡萄牙)/.test(t); }
  function tagKey(e) { return entryTags(e).map((t) => String(t).toLowerCase()).sort().join(','); }
  function sameEntry(e, o) {
    if ((e.word || '') !== (o.word || '')) return false;
    // 无词条目：备注 + 标签共同区分（纯标签标注不被误并）
    if (!e.word || !o.word) {
      if (String(e.label || '') !== String(o.label || '')) return false;
      if (tagKey(e) !== tagKey(o)) return false;
    }
    const eb = validBox(e.box), ob = validBox(o.box);
    const eq = validQuote(e.quote), oq = validQuote(o.quote);
    if (eb && ob) {
      if (Math.abs((Number(e.t) || 0) - (Number(o.t) || 0)) >= 0.4) return false;
      return G.iou(e.box, o.box) > 0.6;
    }
    if (eq && oq) return e.quote.exact === o.quote.exact;   // 文本锚点：同一段文字即同一标注
    return false;
  }
  function validEntries(list) {
    return (Array.isArray(list) ? list : []).filter((e) => {
      if (!e || !validAnchor(e) || !entryHasContent(e)) return false;  // 锚点 + 至少一个要素（词/标签/备注）
      if (!e.id) e.id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      return true;
    });
  }
  function mergeLocal(a, b) {
    const out = validEntries(a);
    for (const e of validEntries(b)) {
      if (out.some((o) => sameEntry(e, o))) continue;
      out.push(e);
    }
    return out;
  }

  // 统一 HTTP：优先级 vaFetch(自建浏览器壳) > chrome(扩展) > GM_xmlhttpRequest > fetch。前两者不受页面 CORS/混合内容限制
  // 直连 fetch（最后兜底；https→http 局域网会被拦，但同源/同协议可用）
  function fetchJson(method, url, body) {
    return fetch(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json().catch(() => null) }));
  }

  function viaExtChannel(method, url, body) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
      // Safari 等「假 chrome 对象」环境：sendMessage 可能抛错或永远不回 → 3s 超时后让调用方回退
      let chromeId = '';
      try { chromeId = (chrome.runtime && chrome.runtime.id) || ''; } catch (e) { chromeId = ''; }
      try {
        chrome.runtime.sendMessage({ type: 'va-fetch', method, url, body }, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) return finish(reject, new Error('扩展通道：' + err.message));
          if (!resp) return finish(reject, new Error('扩展通道无响应（后台未响应；Safari/非本扩展环境请用 GM 变体脚本）'));
          finish(resolve, resp);
        });
      } catch (e) {
        return finish(reject, new Error('扩展通道调用异常：' + (e && e.message)));
      }
      setTimeout(() => finish(reject, new Error('扩展通道超时（id=' + (chromeId || '?') + '）')), 3000);
    });
  }

  function gmAvailable() {
    return (typeof GM_xmlhttpRequest === 'function' && GM_xmlhttpRequest) ||
      (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function' && GM.xmlHttpRequest.bind(GM));
  }

  // 有 GM 就用 GM（Safari 的 Userscripts/Stay 走这条，能绕过混合内容）；否则先试扩展通道，失败回退 fetch
  function httpJson(method, url, body) {
    if (typeof window !== 'undefined' && typeof window.vaFetch === 'function') {
      return window.vaFetch(method, url, body);
    }
    const gm = gmAvailable();
    if (gm) {
      return new Promise((resolve, reject) => {
        gm({
          method, url, headers: { 'Content-Type': 'application/json' },
          data: body ? JSON.stringify(body) : undefined, timeout: 15000,
          onload: (res) => {
            let j = null;
            try { j = res.responseText ? JSON.parse(res.responseText) : null; } catch (e) {}
            resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, json: j });
          },
          onerror: () => reject(new Error('网络错误（GM 通道）')),
          ontimeout: () => reject(new Error('超时')),
        });
      });
    }
    // 无 GM、非自建浏览器：优先扩展后台（能绕 CORS/混合内容），失败则直连 fetch
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      return viaExtChannel(method, url, body).catch(() => fetchJson(method, url, body));
    }
    return fetchJson(method, url, body);
  }

  function cacheAppSettings() {
    try { localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(appSettings)); } catch (e) {}
  }
  function applyAppSettings(value, fromService) {
    const wasAuto = AUTO_SYNC;
    appSettings = mergeAppSettings(value);
    shortcuts = appSettings.shortcuts;
    AUTO_SYNC = !!window.VA_AUTO_SYNC || VIEW_ONLY || appSettings.sync.auto;
    cacheAppSettings();
    if (fromService) {
      if (appSettings.sync.address) {
        syncBase = appSettings.sync.address;
        try { localStorage.setItem(SYNC_URL_KEY, syncBase); } catch (e) {}
      } else {
        syncBase = null;
        try { localStorage.removeItem(SYNC_URL_KEY); } catch (e) {}
      }
    }
    if (!wasAuto && AUTO_SYNC) scheduleAutoSync();
  }
  function settingsBases() {
    const bases = [];
    // Tauri's local Rust service owns global settings; don't let a previously
    // selected remote sync server shadow this endpoint.
    if (typeof window.vaFetch === 'function') bases.push(DEFAULT_SYNC);
    if (syncBase) bases.push(syncBase);
    bases.push(...syncCandidates());
    return [...new Set(bases.map((base) => String(base).replace(/\/+$/, '')))];
  }
  async function loadAppSettings() {
    for (const base of settingsBases()) {
      try {
        const response = await httpJson('GET', base + '/api/settings');
        if (response.ok && response.json && response.json.settings) {
          applyAppSettings(response.json.settings, true);
          return;
        }
      } catch (e) { /* standalone Python/third-party sync servers may not expose settings */ }
    }
  }
  async function persistAppSettings() {
    cacheAppSettings();
    for (const base of settingsBases()) {
      try {
        const response = await httpJson('PUT', base + '/api/settings', appSettings);
        if (response.ok) return true;
      } catch (e) { /* try the next configured server */ }
    }
    return false; // per-page cache remains available offline
  }

  const SYNC_HINT = '\n· 电脑上是否在跑「同步服务」？python3 dev/hub.py 会一并启动' +
    '\n· 手机在 https 页面访问 http 局域网地址会被浏览器按混合内容拦截 → 用 GM 变体脚本（一键安装页可选）';

  async function testSync() {
    setSyncStatus('测试中…');
    try {
      const base = await resolveBase();
      const r = await httpJson('GET', base + '/api/health');
      setSyncStatus((r.ok && r.json && r.json.ok) ? '同步可用 ✓ ' + base : '同步异常 HTTP ' + r.status);
    } catch (e) { setSyncStatus('连不上：' + e.message); }
  }

  // ---- 显示：只读选版（不写数据）。同步：以本地为主推到服务器（云存储/分享/公开，非双向 union） ----
  function coverPref(mediaId) {
    try { return localStorage.getItem(OVERRIDE_PREFIX + mediaId); } catch (e) { return null; }   // 'server' | 'local' | null
  }
  function setCoverPref(mediaId, v) { try { localStorage.setItem(OVERRIDE_PREFIX + mediaId, v); } catch (e) {} }

  // 弹窗骨架：带 Esc / 点击外部关闭，close() 只会 resolve 一次（默认值由调用方给）
  function makeChoiceDialog(label, buildBody, onPick) {
    return new Promise((resolve) => {
      const pop = el('div'); pop.className = 'va-popover va-sync-choice';
      pop.style.left = '50%'; pop.style.transform = 'translateX(-50%)'; pop.style.top = '18px';
      pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', label);
      let done = false;
      const close = (value) => { if (done) return; done = true; document.removeEventListener('keydown', onKey, true); uiRoot.removeEventListener('pointerdown', onOutside, true); pop.remove(); resolve(value); };
      const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(onPick.dismiss); } };
      const onOutside = (ev) => { if (!pop.contains(ev.target)) close(onPick.dismiss); };
      buildBody(pop, close);
      document.addEventListener('keydown', onKey, true);
      setTimeout(() => uiRoot.addEventListener('pointerdown', onOutside, true), 0);
      uiRoot.appendChild(pop);
    });
  }

  // 冲突弹窗：两个确定性选项。Esc/点外部 = 默认看服务器版（不改数据，最安全）
  function chooseVersion({ serverEntries, cached }) {
    return makeChoiceDialog('选择要显示的版本', (pop, close) => {
      const head = el('div'); head.className = 'va-pop-head';
      const heading = el('div'); heading.className = 'va-pop-heading';
      heading.append(el('div', null, 'SYNC'), el('strong', null, '两版不一致，先看哪一版？'),
        el('span', null, '服务器 ' + serverEntries.length + ' 条 · 本地 ' + cached.length + ' 条。选版本只影响显示，不改数据。'));
      head.append(heading);
      const acts = el('div'); acts.className = 'va-pop-actions';
      const bLocal = mkbtn('看本地版（离线修改）', () => close('local'));
      const bServer = mkbtn('看服务器版', () => close('server'));
      bLocal.classList.add('va-btn-primary');
      acts.append(bLocal, bServer);
      pop.append(head, acts);
    }, { dismiss: 'server' });
  }

  // 打开媒体时：只处理「显示」，不写不对齐。覆盖本地要用户选，可记忆。
  async function reconcileOnOpen(mediaId) {
    if (!state.mediaId || state.mediaId !== mediaId) return;   // 已切走
    let serverEntries = null;
    try {
      const base = await resolveBase();
      const g = await httpJson('GET', base + '/api/anno/' + encodeURIComponent(mediaId));
      if (g.ok) serverEntries = validEntries((g.json && g.json.entries) || []);
    } catch (e) { return; }   // 离线：维持本地缓存显示
    if (!serverEntries) return;
    if (!state.mediaId || state.mediaId !== mediaId) return;

    const cached = loadCached(mediaId);
    const fpCached = fingerprint(cached);
    const localDraft = hasLocalDraft(mediaId, cached);
    const serverNewer = fingerprint(serverEntries) !== (syncMeta(mediaId) ? syncMeta(mediaId).fp : fpCached);
    const differ = fingerprint(serverEntries) !== fpCached;

    if (!differ) {                                   // 完全一致：对齐标记即可
      setSyncMeta(mediaId, serverEntries); return;
    }
    if (localDraft) {                                // 本地有未同步离线改动 → 选显示哪版
      const choice = await chooseVersion({ serverEntries, cached });
      // 弹窗期间用户若又改了本地（缓存与快照不一致）→ 放弃本次显示覆盖，保住在途编辑
      if (loadCached(mediaId) !== cached && fingerprint(loadCached(mediaId)) !== fpCached) return;
      state.entries = choice === 'local' ? cached : serverEntries;
      state.displayVersion = choice;
      save(); render(); renderPanel();
    } else if (serverNewer) {                         // 本地没动、服务器更新
      // 快照与当前缓存一致才动；否则说明期间有本地写入
      if (fingerprint(loadCached(mediaId)) !== fpCached) return;
      state.entries = serverEntries; state.displayVersion = 'server';
      save(); render(); renderPanel();
      const pref = coverPref(mediaId);
      if (pref === 'server') { setSyncMeta(mediaId, serverEntries); }
      else if (pref !== 'local') {                    // 未记忆过 → 询问是否覆盖本地
        const cover = await confirmCover(mediaId);
        if (cover) setSyncMeta(mediaId, serverEntries);
      }
    } else {
      setSyncMeta(mediaId, serverEntries);
    }
  }

  // Esc/点外部 = 保留本地版（不覆盖，最安全）
  function confirmCover(mediaId) {
    return makeChoiceDialog('是否用服务器版覆盖本地', (pop, close) => {
      const cb = el('input'); cb.type = 'checkbox';
      const done = (cover) => { if (cb.checked) setCoverPref(mediaId, cover ? 'server' : 'local'); close(cover); };
      const head = el('div'); head.className = 'va-pop-head';
      const heading = el('div'); heading.className = 'va-pop-heading';
      heading.append(el('div', null, 'SYNC'), el('strong', null, '服务器有新版本'),
        el('span', null, '当前已显示服务器版。要把本地缓存也更新为服务器版吗？'));
      head.append(heading);
      const remember = el('label', null); remember.className = 'va-remember';
      const tx = el('span', null, '可选，以后不再询问');
      remember.append(cb, tx);
      const acts = el('div'); acts.className = 'va-pop-actions';
      const bCover = mkbtn('用服务器版覆盖本地', () => done(true)); bCover.classList.add('va-btn-primary');
      const bKeep = mkbtn('保留本地版', () => done(false));
      acts.append(bCover, bKeep);
      pop.append(head, remember, acts);
    }, { dismiss: false });
  }

  // 同步 = 把「当前显示的这版」推到服务器（本地为主）；服务器是云存储/分享/公开
  async function syncNow() {
    if (!state.mediaId) return;
    setSyncStatus('同步中…');
    try {
      const base = await resolveBase();
      const url = base + '/api/anno/' + encodeURIComponent(state.mediaId);
      const meta = syncMeta(state.mediaId);
      const aligned = !!meta && meta.fp === fingerprint(state.entries);   // 本视图是否已知与服务端一致
      if (state.displayVersion === 'server') {         // 当前显示服务器版 → 拉下来作为本地
        const g = await httpJson('GET', url);
        if (!g.ok) throw new Error('HTTP ' + g.status);
        state.entries = validEntries((g.json && g.json.entries) || []);
        setSyncMeta(state.mediaId, state.entries);
        save(); render();
        setSyncStatus('已对齐服务器版 · ' + state.entries.length + ' 条');
        return;
      }
      // 本地为主推送。未与服务器确认对齐时不能整包替换（会删掉别处写入、本机没拉到的条目）→ 只做增量合并推送。
      const payload = aligned ? pushPack() : pack();
      const p = await httpJson('PUT', url, payload);
      if (!p.ok) throw new Error('HTTP ' + p.status);
      const pushed = validEntries((p.json && p.json.entries) || state.entries);
      state.entries = pushed;
      state.displayVersion = 'local';
      setSyncMeta(state.mediaId, pushed);
      save(); render();
      setSyncStatus((aligned ? '已同步到服务器 · ' : '已合并推送到服务器 · ') + state.entries.length + ' 条');
    } catch (e) {
      setSyncStatus('同步失败：' + e.message);
      alert('同步失败：' + e.message + SYNC_HINT);
    }
  }

  async function uploadSync() { await syncNow(); }
  async function downloadSync() {
    if (!state.mediaId) return;
    setSyncStatus('下载中…');
    try {
      const base = await resolveBase();
      const r = await httpJson('GET', base + '/api/anno/' + encodeURIComponent(state.mediaId));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      state.entries = validEntries((r.json && r.json.entries) || state.entries);
      state.displayVersion = 'server';
      save(); render();
      setSyncStatus('已载入服务器版 · ' + state.entries.length + ' 条');
    } catch (e) { setSyncStatus('下载失败：' + e.message); alert('下载失败：' + e.message + SYNC_HINT); }
  }

  /* ---------- 导入导出 ---------- */
  function exportJSON() {
    const blob = new Blob([JSON.stringify(pack(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'annotate_' + state.mediaId.replace(/[^\w.-]+/g, '_') + '.json';
    a.click();
  }

  function importJSON() {
    const f = document.createElement('input');
    f.type = 'file'; f.accept = '.json,application/json';
    f.onchange = () => {
      const file = f.files[0]; if (!file) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const obj = JSON.parse(rd.result);
          const inc = (obj && obj.entries) || (Array.isArray(obj) ? obj : []);
          const before = state.entries.length;
          state.entries = mergeLocal(state.entries, inc);
          state.displayVersion = 'local';
          save(); render();
          alert('导入完成：新增 ' + (state.entries.length - before) + ' 条（合并后 ' + state.entries.length + '）');
        } catch (err) { alert('导入失败：' + err.message); }
      };
      rd.readAsText(file);
    };
    f.click();
  }

  function clearAll() {
    if (!state.entries.length) return;
    if (!confirm('清空本视频的 ' + state.entries.length + ' 条标注？')) return;
    state.entries = []; state.displayVersion = 'local'; save(); render();
  }

  function updateStatus() {
    statusText.textContent = state.entries.length ? state.entries.length + ' 条标注' : '就绪';
    status.dataset.state = 'ready';
  }

  function decodeExportIntent(hash) {
    const match = String(hash || '').match(/(?:^#|&)annota-export=([A-Za-z0-9_-]+)/);
    if (!match) return null;
    try {
      const encoded = match[1].replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(encoded + '='.repeat((4 - encoded.length % 4) % 4));
      const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
      const intent = JSON.parse(new TextDecoder().decode(bytes));
      return intent && typeof intent === 'object' ? intent : null;
    } catch (e) { return null; }
  }

  let pendingExportIntent = decodeExportIntent(location.hash);
  if (pendingExportIntent) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }

  const coreApi = {
    state,
    binding: () => state.binding,
    entries: () => state.entries,
    mediaMeta,
    renderOnly,
    render,
    setChromeHidden,
    save,
    captureFrame,
    videoRect,
    resolveBase,
    httpJson,
    setSyncStatus,
    showToast,
    uiRoot,
  };
  try {
    if (window.VAExport && typeof window.VAExport.install === 'function') window.VAExport.install(coreApi);
  } catch (e) { /* Export UI must never interrupt annotation startup. */ }

  /* ---------- 启动 ---------- */
  loadAppSettings();
  mountShell();   // 即使页面无可自动绑定的媒态，也保留 dock（含「选对象」）
  A.watch((v) => {
    if (v) {
      attach(v);
      if (pendingExportIntent && window.__ANNOTA_EXPORT__) {
        const intent = pendingExportIntent;
        pendingExportIntent = null;
        try { window.__ANNOTA_EXPORT__.start(intent); } catch (e) { showToast('批量导出启动失败'); }
      }
    } else detachBinding();
  });
})();
