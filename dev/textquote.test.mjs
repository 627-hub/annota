// node --test dev/textquote.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

// textquote.js 用 UMD 风格挂在 self/window 上；构造最小 root 注入
const code = (await import('node:fs')).readFileSync(path.join(here, '..', 'src', 'textquote.js'), 'utf8');
const sandbox = { createTreeWalker: () => ({ nextNode: () => null }) };
new Function('self', code)(sandbox);
const T = sandbox.VATextQuote;

const FULL = 'In 1684 the tea was planted on the hills. Later, the monsoon arrived late and the tea was scarce.';

test('locateText: offset 命中优先', () => {
  const hit = T.locateText({ exact: 'the monsoon arrived late', start: 49, end: 73 }, FULL);
  assert.deepEqual(hit, { start: 49, end: 73 });
  assert.equal(FULL.slice(hit.start, hit.end), 'the monsoon arrived late');
});

test('locateText: 重复文本用 prefix/suffix 消歧', () => {
  // "the tea was" 出现两次，用后缀消歧到第二处
  const first = T.locateText({ exact: 'the tea was', suffix: ' scarce' }, FULL);
  const second = T.locateText({ exact: 'the tea was', suffix: ' planted' }, FULL);
  assert.ok(first && second);
  assert.notEqual(first.start, second.start);
  assert.equal(FULL.slice(second.start, second.end), 'the tea was');
});

test('locateText: 无 offset 无上下文 → 退化取第一个', () => {
  const hit = T.locateText({ exact: 'the tea was' }, FULL);
  assert.equal(hit.start, FULL.indexOf('the tea was'));
});

test('locateText: 找不到返回 null', () => {
  assert.equal(T.locateText({ exact: 'not present here' }, FULL), null);
  assert.equal(T.locateText({ exact: '' }, FULL), null);
});

test('locateText: offset 漂移（重排后）回退到上下文命中', () => {
  // offset 指向错误位置（文字被插入后整体后移），但 prefix 仍在附近
  const shifted = 'PREFACE ... ' + FULL;
  const hit = T.locateText({ exact: 'the monsoon arrived late', start: 49, end: 73, prefix: 'Later, ' }, shifted);
  assert.ok(hit);
  assert.equal(shifted.slice(hit.start, hit.end), 'the monsoon arrived late');
});

test('serialize: 需要非折叠 Range，纯文本 exact', () => {
  const range = {
    collapsed: false,
    toString: () => '  the monsoon  ',
    cloneRange() { return { selectNodeContents() {}, setEnd() {}, setStart() {}, toString: () => '' }; },
    startContainer: {}, endContainer: {}, startOffset: 0, endOffset: 0,
  };
  const q = T.serialize(range, {});
  assert.equal(q.exact, 'the monsoon');
  assert.equal(typeof q.prefix, 'string');
  assert.equal(typeof q.suffix, 'string');
});

test('serialize: 折叠 Range 返回 null', () => {
  assert.equal(T.serialize({ collapsed: true, toString: () => 'x' }, {}), null);
});
