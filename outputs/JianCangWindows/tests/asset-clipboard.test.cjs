'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { clipboardText } = require('../asset-clipboard.cjs');

const items = [
  { asset: { name: '测试照', sourceURL: 'https://example.test/material', tags: ['样张', '笔记'], note: '＝1+1\n|第二行',
    width: 100, height: 50, byteCount: 20, extension: 'png', rating: 4 }, libraryName: '示例库', originalPath: '/root/示例库/照片.png' },
  { asset: { name: '远端缺失', sourceURL: 'javascript:alert(1)', note: '\u200b+2' }, libraryName: '云端' },
];

test('copies ready paths and valid web sources while reporting missing values', () => {
  assert.deepEqual(clipboardText(items, 'names'), { text: '测试照\r\n远端缺失', copied: 2, skipped: 0 });
  assert.deepEqual(clipboardText(items, 'paths'), { text: '/root/示例库/照片.png', copied: 1, skipped: 1 });
  assert.deepEqual(clipboardText(items, 'sources'), { text: 'https://example.test/material', copied: 1, skipped: 1 });
});

test('produces tabular Unicode metadata with fixed columns and escaped spreadsheet formulas', () => {
  const table = clipboardText(items, 'table');
  const lines = table.text.split('\r\n').map(line => line.split('\t'));
  assert.equal(lines.length, 3);
  assert.ok(lines.every(line => line.length === 10));
  assert.deepEqual(lines[1], ['测试照', '示例库', 'png', '100', '50', '20', '4', '样张、笔记', 'https://example.test/material', "'＝1+1 |第二行"]);
  assert.equal(lines[2][8], '');
  assert.equal(lines[2][9], "'\u200b+2");
  assert.throws(() => clipboardText([{ asset: { name: '字'.repeat(750_000) } }], 'names'), /请分批复制/);
});
