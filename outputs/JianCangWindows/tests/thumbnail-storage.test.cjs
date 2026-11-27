'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createThumbnailCache } = require('../thumbnail-cache.cjs');

const photo = { type: 'image/png', bytes: Buffer.from('fixture thumbnail') };
const cacheName = key => createHash('sha256').update(key).digest('hex') + '.thumb';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-thumbnails-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('thumbnail storage reports measured bytes and deletes only managed cache files', async t => {
  const root = await workspace(t);
  const original = path.join(root, 'original.png');
  await fs.writeFile(original, 'keep original');
  const directory = path.join(root, 'cache');
  const cache = createThumbnailCache(directory);
  await cache.warm();
  await cache.set('first', photo);
  await cache.set('second', photo);
  await fs.writeFile(path.join(directory, 'note.txt'), 'keep note');
  await fs.symlink(original, path.join(directory, cacheName('symlink')));
  const temporary = `${cacheName('temporary')}.a1.tmp`;
  await fs.writeFile(path.join(directory, temporary), 'temp');
  const expectedBytes = 2 * (1 + photo.bytes.length) + 4;
  assert.deepEqual(await cache.status(), { count: 3, bytes: expectedBytes });
  assert.deepEqual(await cache.clear(), {
    count: 0, bytes: 0, removedCount: 3, removedBytes: expectedBytes, failedCount: 0,
  });
  assert.equal(await cache.get('first'), null);
  assert.equal(await fs.readFile(original, 'utf8'), 'keep original');
  assert.equal(await fs.readFile(path.join(directory, 'note.txt'), 'utf8'), 'keep note');
  assert.ok((await fs.lstat(path.join(directory, cacheName('symlink')))).isSymbolicLink());
});

test('thumbnail clearing observes queued writes and later thumbnails can be regenerated', async t => {
  const root = await workspace(t);
  const cache = createThumbnailCache(path.join(root, 'cache'));
  const before = cache.set('before', photo);
  const clear = cache.clear();
  const after = cache.set('after', photo);
  await before;
  assert.equal((await clear).removedCount, 1);
  await after;
  assert.equal(await cache.get('before'), null);
  assert.deepEqual(await cache.get('after'), photo);
  assert.deepEqual(await cache.status(), { count: 1, bytes: 1 + photo.bytes.length });
});

test('thumbnail storage rejects a directory swapped for a symlink or another directory', async t => {
  const root = await workspace(t);
  const directory = path.join(root, 'cache');
  const other = path.join(root, 'other');
  await fs.mkdir(other);
  const name = cacheName('replacement');
  await fs.writeFile(path.join(other, name), 'keep replacement');
  const cache = createThumbnailCache(directory);
  await cache.set('original', photo);
  await fs.rename(directory, path.join(root, 'saved'));
  await fs.symlink(other, directory, 'dir');
  await assert.rejects(cache.clear(), /位置已变化/);
  assert.equal(await fs.readFile(path.join(other, name), 'utf8'), 'keep replacement');
  await fs.unlink(directory);
  await fs.rename(other, directory);
  await assert.rejects(cache.status(), /位置已变化/);
  assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), 'keep replacement');
});
