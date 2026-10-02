// node --test dev/geometry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const G = require(path.join(here, '..', 'src', 'geometry.js'));

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('contain: 宽视频在方形容器 → 上下黑边 (letterbox)', () => {
  const cr = G.contentRect({ w: 1920, h: 1080 }, { x: 0, y: 0, w: 800, h: 800 }, 'contain');
  near(cr.w, 800); near(cr.h, 450);
  near(cr.x, 0); near(cr.y, 175);
});

test('contain: 竖视频在宽容器 → 左右黑边 (pillarbox)', () => {
  const cr = G.contentRect({ w: 1080, h: 1920 }, { x: 0, y: 0, w: 1000, h: 500 }, 'contain');
  near(cr.h, 500); near(cr.w, 281.25);
  near(cr.y, 0); near(cr.x, 359.375);
});

test('cover: 撑满并溢出（负偏移）', () => {
  const cr = G.contentRect({ w: 1920, h: 1080 }, { x: 0, y: 0, w: 800, h: 800 }, 'cover');
  near(cr.h, 800); near(cr.w, 800 * 1920 / 1080);
  near(cr.y, 0); assert.ok(cr.x < 0);
});

test('fill / 无 intrinsic → 内容区等于元素 rect', () => {
  const r = { x: 10, y: 20, w: 300, h: 200 };
  assert.deepEqual(G.contentRect({ w: 1920, h: 1080 }, r, 'fill'), r);
  assert.deepEqual(G.contentRect({ w: 0, h: 0 }, r, 'contain'), r);
});

test('rect 兼容 DOMRect 的 {width,height} 与 {w,h}', () => {
  const a = G.contentRect({ w: 1280, h: 720 }, { x: 239.5, y: 172, w: 983, h: 553 }, 'contain');
  const b = G.contentRect({ w: 1280, h: 720 }, { x: 239.5, y: 172, width: 983, height: 553, left: 239.5, top: 172 }, 'contain');
  for (const k of ['x', 'y', 'w', 'h']) {
    near(a[k], b[k]);
    assert.ok(Number.isFinite(b[k]), `${k} 不应为 NaN`);
  }
});

test('box <-> 像素 往返一致', () => {
  const cr = G.contentRect({ w: 1920, h: 1080 }, { x: 100, y: 50, w: 640, h: 480 }, 'contain');
  const box = { x: 0.42, y: 0.55, w: 0.18, h: 0.22 };
  const rt = G.pixelsToBox(G.boxToPixels(box, cr), cr);
  near(rt.x, box.x); near(rt.y, box.y); near(rt.w, box.w); near(rt.h, box.h);
});

test('clampBox: 越界被收回 [0,1]', () => {
  const b = G.clampBox({ x: -0.1, y: 0.95, w: 0.5, h: 0.5 });
  assert.ok(b.x >= 0 && b.y + b.h <= 1 + 1e-9 && b.x + b.w <= 1 + 1e-9);
});

test('dragToBox: 反向拖拽也能得到正 box', () => {
  const cr = { x: 0, y: 0, w: 1000, h: 1000 };
  const b = G.dragToBox(800, 900, 300, 400, cr);
  near(b.x, 0.3); near(b.y, 0.4); near(b.w, 0.5); near(b.h, 0.5);
});

test('iou: 相同=1，不相交=0', () => {
  const a = { x: 0, y: 0, w: 0.2, h: 0.2 };
  near(G.iou(a, a), 1);
  near(G.iou(a, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }), 0);
});

test('intersects: 相交/相离判定', () => {
  const vp = { x: 0, y: 0, w: 800, h: 600 };
  assert.ok(G.intersects({ x: 100, y: 100, w: 50, h: 50 }, vp));
  assert.ok(!G.intersects({ x: 100, y: 700, w: 50, h: 50 }, vp), '视口下方应判离');
  assert.ok(!G.intersects({ x: 900, y: 100, w: 50, h: 50 }, vp), '视口右侧应判离');
});

test('scrollMap: 长图滚动窗口内外的映射/剔除', () => {
  // 2000×6000 长图，显示宽 1000、高 3000；视口高 600
  const imgRect = { x: 0, y: -1200, w: 1000, h: 3000 };   // 已向上滚 1200px
  const vp = { x: 0, y: 0, w: 1000, h: 600 };
  // box 在图片顶部 → 实际像素 y=-1200，已滚出视口上方 → 剔除
  assert.equal(G.scrollMap({ x: 0.1, y: 0.01, w: 0.2, h: 0.05 }, imgRect, vp), null);
  // box 在图片中部附近 → 落在视口内
  const p = G.scrollMap({ x: 0.1, y: 0.45, w: 0.2, h: 0.05 }, imgRect, vp);
  assert.ok(p, '窗口内的框应返回像素矩形');
  near(p.left, 100); near(p.top, -1200 + 0.45 * 3000);
  near(p.width, 200); near(p.height, 150);
});
