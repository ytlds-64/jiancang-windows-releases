'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createThumbnailCache, sourceStamp } = require('../thumbnail-cache.cjs');
const { createLibraryWatcher, libraryFingerprint, visibleChange } = require('../library-watcher.cjs');
const { readLibrary } = require('../sync-library.cjs');

async function scratch(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-preview-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('reuses disk thumbnails on restart and keeps byte and item limits', async t => {
  const directory = await scratch(t);
  const options = { maxBytes: 20, maxEntries: 3, maxEntryBytes: 11 };
  const first = createThumbnailCache(directory, options);
  const image = bytes => ({ bytes: Buffer.from(bytes), type: 'image/webp' });
  await first.set('library-a/original/480', image('apple'));
  await first.set('library-b/original/480', image('berry'));
  await first.set('library-a/original/1600', image('0123456789abcd'));
  await first.set('library-a/original/480/edited', image('plum'));
  assert.deepEqual(await first.get('library-b/original/480'), image('berry'));
  assert.equal(await first.get('library-a/original/1600'), null);
  const next = createThumbnailCache(directory, options);
  assert.deepEqual(await next.get('library-a/original/480'), image('apple'));
  assert.deepEqual(await next.get('library-b/original/480'), image('berry'));
  assert.deepEqual(await next.get('library-a/original/480/edited'), image('plum'));
  await next.set('library-a/next', image('mango'));
  assert.deepEqual(await next.get('library-a/next'), image('mango'));
  const files = await fs.readdir(directory);
  const storage = await Promise.all(files.map(name => fs.lstat(path.join(directory, name))));
  assert.equal(files.length, 3);
  assert.ok(storage.reduce((sum, info) => sum + info.size, 0) <= options.maxBytes);
});

test('a same-size Eagle file change changes the thumbnail stamp and catalog revision', async t => {
  const directory = await scratch(t);
  const original = path.join(directory, 'original.webp');
  await fs.writeFile(original, 'aaaa');
  const before = sourceStamp(await fs.lstat(original, { bigint: true }));
  await fs.writeFile(original, 'bbbb');
  const later = new Date(Date.now() + 3000);
  await fs.utimes(original, later, later);
  const after = sourceStamp(await fs.lstat(original, { bigint: true }));
  assert.notEqual(before, after);

  const library = {
    kind: 'eagle', assets: [{ id: 'a', mediaRevision: before }, { id: 'b' }],
    collections: [], originals: new Map([['a', original], ['b', '/test/b']]), warnings: [],
  };
  const orderOnly = { ...library, assets: [...library.assets].reverse(), originals: new Map([...library.originals].reverse()) };
  assert.equal(libraryFingerprint(library), libraryFingerprint(orderOnly));
  const changed = { ...library, assets: [{ id: 'a', mediaRevision: after }, { id: 'b' }] };
  assert.notEqual(libraryFingerprint(library), libraryFingerprint(changed));
});

async function waitUntil(condition) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (condition()) return;
    await delay(30);
  }
  assert.fail('directory change did not reach the watcher');
}

test('coalesces changes, revisits changes during refresh, and isolates an offline root', async t => {
  const directory = await scratch(t);
  const first = path.join(directory, 'first.library');
  const second = path.join(directory, 'second.library');
  await fs.mkdir(first);
  await fs.mkdir(second);
  const firstHeader = path.join(first, 'metadata.json');
  const secondHeader = path.join(second, 'metadata.json');
  await fs.writeFile(firstHeader, '{}');
  await fs.writeFile(secondHeader, '{}');
  const calls = [];
  let recording = false;
  let unblock;
  const block = new Promise(resolve => { unblock = resolve; });
  const watch = createLibraryWatcher({
    async onChange(id) {
      if (!recording) return;
      calls.push(id);
      if (calls.length === 1) await block;
    },
    quietMs: 45, maxWaitMs: 160, pollMs: 90, retryMs: 10_000,
  });
  t.after(() => { unblock(); watch.close(); });
  watch.update([{ id: 'first', root: first, kind: 'eagle' }, { id: 'second', root: second, kind: 'eagle' }]);
  // macOS can deliver events for fixture creation after fs.watch first attaches.
  await delay(350);
  recording = true;
  await fs.writeFile(firstHeader, '{"n":1}');
  await fs.writeFile(firstHeader, '{"n":2}');
  await waitUntil(() => calls.length === 1);
  assert.deepEqual(calls, ['first']);
  await fs.writeFile(firstHeader, '{"n":3}');
  await delay(170);
  assert.deepEqual(calls, ['first']);
  unblock();
  await waitUntil(() => calls.length >= 2);
  assert.deepEqual(calls.slice(0, 2), ['first', 'first']);

  await fs.rename(first, path.join(directory, 'first-moved.library'));
  await fs.writeFile(secondHeader, '{"n":2}');
  await waitUntil(() => calls.includes('second') && calls.filter(id => id === 'first').length >= 3);
  watch.update([{ id: 'second', root: second, kind: 'eagle' }]);
  await delay(150);
  const old = calls.filter(id => id === 'first').length;
  await fs.mkdir(first);
  await fs.writeFile(firstHeader, '{}');
  await delay(200);
  assert.equal(calls.filter(id => id === 'first').length, old);
});

test('polls an existing sync device directory when a healthy watcher misses a journal arrival', async t => {
  const root = await fs.realpath(await scratch(t));
  const libraryID = randomUUID();
  const deviceID = randomUUID();
  const entityID = randomUUID();
  const journals = path.join(root, 'changes');
  const device = path.join(journals, deviceID);
  const createdAt = 721_692_800;
  await fs.mkdir(device, { recursive: true });
  await fs.mkdir(path.join(root, 'blobs'));
  await fs.writeFile(path.join(root, 'library.json'), JSON.stringify({
    format: 'com.materialshelf.directory-sync', version: 6, libraryID, namingDeviceID: deviceID, createdAt,
  }));

  async function append(counter, changes) {
    const id = randomUUID();
    const staged = path.join(root, `${id}.stage`);
    await fs.writeFile(staged, JSON.stringify({
      version: 1, libraryID, id, deviceID, counter, clock: { [deviceID]: counter },
      entityKind: 'collection', entityID, changes,
    }));
    await fs.rename(staged, path.join(device, `${counter}-${id}.json`));
  }

  await append(1, {
    life: { bool: { _0: true } }, name: { string: { _0: '旧名称' } }, parentID: { null: {} },
    colorHex: { string: { _0: 'A34337' } }, symbol: { string: { _0: 'folder' } }, createdAt: { double: { _0: createdAt } },
  });
  const initialDate = new Date('2000-01-01T00:00:00Z');
  await fs.utimes(device, initialDate, initialDate);
  const before = await readLibrary(root);
  assert.equal(before.partial, false);
  assert.equal(before.collections[0].name, '旧名称');
  const journalStamp = sourceStamp(await fs.lstat(journals, { bigint: true }));
  const deviceStamp = sourceStamp(await fs.lstat(device, { bigint: true }));
  const names = [];
  const attached = Promise.withResolvers();
  const watch = createLibraryWatcher({
    async onChange() { names.push((await readLibrary(root)).collections[0].name); },
    watchDirectory() {
      // The provider's watcher stays connected but does not deliver this event.
      attached.resolve();
      return { on() {}, close() {} };
    },
    quietMs: 5, maxWaitMs: 20, pollMs: 25, retryMs: 70,
  });
  t.after(() => watch.close());
  watch.update([{ id: libraryID, root, kind: 'jiancang' }]);
  await attached.promise;
  await delay(100);
  assert.deepEqual(names, []);

  await append(2, { name: { string: { _0: '晚到的名称' } } });
  assert.equal(sourceStamp(await fs.lstat(journals, { bigint: true })), journalStamp);
  assert.notEqual(sourceStamp(await fs.lstat(device, { bigint: true })), deviceStamp);
  await waitUntil(() => names.length > 0);
  await delay(160);
  assert.deepEqual(names, ['晚到的名称']);
});

test('a completed catalog read covers earlier watcher events and keeps new events', async t => {
  const root = await scratch(t);
  const attached = Promise.withResolvers();
  const requests = [];
  const watch = createLibraryWatcher({
    onChange(id, needsRefresh) { requests.push({ id, needsRefresh }); },
    watchDirectory(_root, _options, fire) {
      attached.resolve(fire);
      return { on() {}, close() {} };
    },
    quietMs: 10,
  });
  t.after(() => watch.close());
  watch.update([{ id: 'sync', root, kind: 'jiancang' }]);
  const fire = await attached.promise;

  fire('rename', 'changes/device/1-record.json');
  await waitUntil(() => requests.length === 1);
  const covered = await watch.beginRefresh('sync');
  assert.equal(requests[0].needsRefresh(), true);
  watch.finishRefresh(covered, covered.identity);
  assert.equal(requests[0].needsRefresh(), false);

  const reading = await watch.beginRefresh('sync');
  fire('rename', 'changes/device/2-record.json');
  watch.finishRefresh(reading, reading.identity);
  await waitUntil(() => requests.length === 2);
  assert.equal(requests[1].needsRefresh(), true);
});

test('ignores filesystem bookkeeping without missing library paths', () => {
  assert.equal(visibleChange('eagle', 'images\\x.info\\file.jpg'), true);
  assert.equal(visibleChange('eagle', 'metadata.json'), true);
  assert.equal(visibleChange('eagle', 'images/.DS_Store'), false);
  assert.equal(visibleChange('jiancang', 'blobs\\.locations\\item.json'), true);
  assert.equal(visibleChange('jiancang', 'blobs/.incoming/file.tmp'), false);
  assert.equal(visibleChange('jiancang', 'changes/00000000-0000-4000-a000-000000000001/.materialshelf-publish-00000000-0000-4000-a000-000000000002'), false);
  assert.equal(visibleChange('jiancang', 'unrelated.txt'), false);
  assert.equal(visibleChange('jiancang', undefined), true);
});
