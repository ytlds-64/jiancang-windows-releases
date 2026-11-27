'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readBoard, readFilter, prepareFilter } = require('../ui/studio-documents.js');

const filterFor = changes => readFilter({ title: '最近三天的竖图', text: '', orientation: 'portrait', recentDays: 3,
  untagged: true, minRating: 0, favoritesOnly: false, match: 'all', groups: [], ...changes });

test('applies the same relative-date, orientation and untagged intersection on either device', () => {
  const now = Date.parse('2026-11-26T10:00:00Z') / 1000;
  const matches = prepareFilter(filterFor({ kind: 'image' }), now);
  const photo = { name: '正面', kind: 'image', width: 800, height: 1200, importedAt: '2026-11-23T10:00:00Z', tags: [] };
  assert.ok(matches(photo));
  assert.equal(matches({ ...photo, importedAt: '2026-11-23T09:59:59Z' }), false);
  assert.equal(matches({ ...photo, importedAt: '' }), false);
  assert.equal(matches({ ...photo, width: photo.height }), false);
  assert.equal(matches({ ...photo, tags: ['春天'] }), false);
  assert.equal(matches({ ...photo, kind: 'video' }), false);
});

test('preserves advanced group modes and rejects malformed limits', () => {
  const groups = [{ match: 'all', rules: [{ field: 'tagIncluded', tag: '春天' }, { field: 'pixelWidth', min: 2000 }] },
    { match: 'any', rules: [{ field: 'tagIncluded', tag: '人像' }, { field: 'fileSize', max: 1024 }] }];
  const filter = filterFor({ match: 'any', recentDays: null, untagged: false, orientation: 'any', groups });
  const matches = prepareFilter(readFilter(JSON.stringify(filter)));
  assert.ok(matches({ tags: ['春天'], width: 2400, byteCount: 5000 }));
  assert.ok(matches({ tags: [], width: 1600, byteCount: 900 }));
  assert.equal(matches({ tags: ['春天'], width: 1600, byteCount: 5000 }), false);
  assert.throws(() => filterFor({ groups: [{ match: 'all', rules: [{ field: 'pixelWidth', min: 120, max: 10 }] }] }), /文档无效/);
  assert.throws(() => filterFor({ groups: [{ match: 'all', rules: [{ field: 'fileSize', min: 9_007_199_254_740_992 }] }] }), /文档无效/);
  assert.throws(() => filterFor({ groups: [{ match: 'all', rules: [{ field: 'unrecognized' }] }] }), /文档无效/);
});

test('orders board cards by document position and keeps every caption under its asset hash', () => {
  const entries = [{ assetID: 'b'.repeat(64), title: '布光', caption: '第二次走位的低机位' },
    { assetID: 'a'.repeat(64), title: '正面', caption: '左侧留白' }];
  const board = { title: '参考图', entries };
  assert.deepEqual(readBoard(JSON.stringify(board)), board);
  assert.throws(() => readBoard({ ...board, entries: [...entries, { ...entries[0], caption: '重复图片' }] }), /文档无效/);
  assert.throws(() => readBoard({ ...board, entries: [{ ...entries[0], assetID: '../原件' }] }), /文档无效/);
});
