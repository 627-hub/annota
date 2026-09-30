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

  return { contentRect, boxToPixels, pixelsToBox, clampBox, dragToBox, iou };
});
