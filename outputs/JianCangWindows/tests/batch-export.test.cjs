'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { exportBatch } = require('../batch-export.cjs');
const { exportReadOnly, exportVerified } = require('../original-file.cjs');

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-batch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'destination');
  await fs.mkdir(destination);
  return { root, destination };
}

test('batch exports originals from both library types without overwriting or changing the sources', async t => {
  const { root, destination } = await workspace(t);
  const syncRoot = path.join(root, 'synced');
  const eagleRoot = path.join(root, 'reference.library');
  const eagleImages = path.join(eagleRoot, 'images');
  await fs.mkdir(path.join(syncRoot, 'blobs'), { recursive: true });
  await fs.mkdir(eagleImages, { recursive: true });
  const syncFile = path.join(syncRoot, 'blobs', 'picture.png');
  const eagleFile = path.join(eagleImages, 'picture.png');
  const syncBytes = Buffer.from('sync original');
  const eagleBytes = Buffer.from('Eagle original');
  await fs.writeFile(syncFile, syncBytes);
  await fs.writeFile(eagleFile, eagleBytes);
  await fs.writeFile(path.join(destination, 'POSTER.PNG'), 'pre-existing file');
  await fs.mkdir(path.join(destination, 'poster (2).png'));

  const items = [
    { name: 'Poster', extension: 'png', file: syncFile, byteCount: syncBytes.length,
      id: createHash('sha256').update(syncBytes).digest('hex') },
    { name: 'poster', extension: 'png', file: eagleFile, byteCount: eagleBytes.length },
  ];
  const result = await exportBatch({
    items, destination, libraryRoots: [syncRoot, eagleRoot],
    copy: (item, target, roots) => item.id
      ? exportVerified(syncRoot, item.file, item, target, roots)
      : exportReadOnly(eagleImages, item.file, item.byteCount, target, roots),
  });

  assert.deepEqual(result, { written: 2, failed: [] });
  assert.equal(await fs.readFile(path.join(destination, 'POSTER.PNG'), 'utf8'), 'pre-existing file');
  assert.deepEqual(await fs.readFile(path.join(destination, 'Poster (3).png')), syncBytes);
  assert.deepEqual(await fs.readFile(path.join(destination, 'poster (4).png')), eagleBytes);
  assert.deepEqual(await fs.readFile(syncFile), syncBytes);
  assert.deepEqual(await fs.readFile(eagleFile), eagleBytes);
});

test('batch handles an external collision and continues after individual failure', async t => {
  const { destination } = await workspace(t);
  let attempted = 0;
  const result = await exportBatch({
    destination, libraryRoots: [],
    items: [
      { name: 'A', extension: 'png' },
      { name: 'B', extension: 'png', available: false },
      { name: 'C', extension: 'png' },
      { name: 'D', extension: 'png' },
    ],
    copy: async (item, target) => {
      attempted += 1;
      if (path.basename(target) === 'A.png') await fs.writeFile(target, 'racing file', { flag: 'wx' });
      if (item.name === 'C') throw new Error('原件校验失败。');
      await fs.writeFile(target, item.name, { flag: 'wx' });
    },
  });
  assert.deepEqual(result, { written: 2, failed: [
    { name: 'B', message: '原件暂不可用，请检查文件是否已下载。' },
    { name: 'C', message: '原件校验失败。' },
  ] });
  assert.equal(attempted, 4);
  assert.deepEqual((await fs.readdir(destination)).sort(), ['A (2).png', 'A.png', 'D.png']);
  assert.equal(await fs.readFile(path.join(destination, 'A.png'), 'utf8'), 'racing file');
});

test('batch refuses direct and aliased destination directories inside all registered library roots', async t => {
  const { root } = await workspace(t);
  const library = path.join(root, 'reference.library');
  const nested = path.join(library, 'nested');
  const alias = path.join(root, 'linked-directory');
  await fs.mkdir(nested, { recursive: true });
  await fs.symlink(library, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const copy = () => assert.fail('copy invoked inside a registered library');
  const items = [{ name: 'file', extension: 'png' }];

  await assert.rejects(exportBatch({ items, destination: nested, libraryRoots: [library], copy }), /素材库以外/);
  await assert.rejects(exportBatch({ items, destination: path.join(alias, 'nested'), libraryRoots: [library], copy }), /素材库以外/);
  await assert.rejects(exportBatch({ items, destination: nested, libraryRoots: [alias], copy }), /素材库以外/);
  assert.deepEqual(await fs.readdir(nested), []);
});

test('batch retains filename extensions and suffixes for long Unicode basenames', async t => {
  const { destination } = await workspace(t);
  const item = { name: '🎞'.repeat(150), extension: 'webp' };
  const unknown = { name: `素材.${'🎞'.repeat(90)}`, extension: '' };
  const result = await exportBatch({
    destination, libraryRoots: [], items: [item, item, unknown],
    copy: (_item, target) => fs.writeFile(target, 'original', { flag: 'wx' }),
  });
  assert.deepEqual(result, { written: 3, failed: [] });
  const filenames = await fs.readdir(destination);
  assert.equal(filenames.length, 3);
  assert.ok(filenames.every(name => Buffer.byteLength(name) <= 240));
  assert.equal(filenames.filter(name => name.endsWith('.webp')).length, 2);
  assert.ok(filenames.some(name => name.endsWith(' (2).webp')));
});

test('progress follows exported files and cancellation leaves successful copies in place', async t => {
  const { destination } = await workspace(t);
  const abort = new AbortController();
  const progress = [];
  const result = await exportBatch({
    destination, libraryRoots: [], signal: abort.signal,
    items: [{ name: 'A', extension: 'png' }, { name: 'B', extension: 'png' }, { name: 'C', extension: 'png' }],
    onProgress: value => progress.push(value),
    copy: async (item, target) => {
      if (item.name === 'B') abort.abort();
      abort.signal.throwIfAborted();
      await fs.writeFile(target, item.name, { flag: 'wx' });
    },
  });
  assert.deepEqual(result, { written: 1, failed: [] });
  assert.deepEqual(await fs.readdir(destination), ['A.png']);
  assert.deepEqual(progress.map(value => [value.current, value.processed]), [['A', 0], ['B', 1], ['', 1]]);
});
