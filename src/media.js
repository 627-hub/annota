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
