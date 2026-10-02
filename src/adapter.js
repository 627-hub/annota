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
