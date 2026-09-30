// node --test dev/vocab.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const V = require(path.join(here, '..', 'src', 'vocab.js'));

const rows = [
  ['abandon', "ə'bændən", '离弃；放弃', 'v', 'it'],
  ['abbey', "'æbi", '修道院', 'n', 't'],
  ['abnormal', 'æbˈnɔːrml', '反常的', 'a', 'i'],
  ['tractor', "'træktə", '拖拉机', 'n', 'i'],
];
const idx = V.makeIndex(rows);

test('英文前缀优先', () => {
  const r = idx.search('ab');
  assert.deepEqual(r.map((x) => x[0]), ['abandon', 'abbey', 'abnormal']);
});

test('英文子串匹配', () => {
  assert.deepEqual(idx.search('bey').map((x) => x[0]), ['abbey']);
});

test('中文联想', () => {
  assert.deepEqual(idx.search('放弃').map((x) => x[0]), ['abandon']);
  assert.deepEqual(idx.search('拖拉').map((x) => x[0]), ['tractor']);
});

test('空查询与 limit', () => {
  assert.deepEqual(idx.search('   '), []);
  assert.equal(idx.search('ab', 2).length, 2);
});
