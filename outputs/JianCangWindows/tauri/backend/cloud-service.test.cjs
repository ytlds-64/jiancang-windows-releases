'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { CloudService } = require('./cloud-service.cjs');
const { LibraryService } = require('./library-service.cjs');
const { mediaHandler } = require('./media.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const hash = createHash('sha256').update(png).digest('hex');

async function waitFor(check) {
  for (let turn = 0; turn < 100; turn++) {
    const result = await check();
    if (result) return result;
    await delay(30);
  }
  assert.fail('原件取回操作未在测试时限内完成。');
}

async function fixture(t, options) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-tauri-cloud-')));
  const library = new LibraryService(path.join(directory, 'profile'));
  const clouds = [];
  t.after(async () => {
    await Promise.allSettled(clouds.map(service => service.close()));
    await library.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await library.initialize();
  async function cloud(overrides) {
    const service = new CloudService(library, { ...options, ...overrides });
    clouds.push(service);
    await service.initialize();
    return service;
  }
  return { directory, library, cloud };
}

async function writeSync(root, bytes = png) {
  const libraryID = randomUUID();
  const deviceID = randomUUID();
  const operationID = randomUUID();
  const changes = path.join(root, 'changes', deviceID);
  const blob = path.join(root, 'blobs', hash);
  await fs.mkdir(changes, { recursive: true });
  await fs.mkdir(path.dirname(blob));
  await Promise.all([
    fs.writeFile(path.join(root, 'library.json'), JSON.stringify({
      libraryID, version: 1, format: 'com.materialshelf.directory-sync', createdAt: 721692800,
    })),
    fs.writeFile(path.join(changes, `1-${operationID}.json`), JSON.stringify({
      libraryID, deviceID, clock: { [deviceID]: 1 }, id: operationID, version: 1, counter: 1, entityKind: 'asset', entityID: hash,
      changes: { life: { bool: { _0: true } }, name: { string: { _0: '=取回测试图' } },
        note: { string: { _0: '' } }, favorite: { bool: { _0: false } }, rating: { int: { _0: 0 } },
        sourceURL: { null: {} }, eagleID: { null: {} }, createdAt: { double: { _0: 1700000000 } },
        deletedAt: { null: {} } },
      asset: { blob: { sha256: hash, byteCount: png.length }, kind: 'image', fileExtension: 'png',
        pixelWidth: 1, pixelHeight: 1, createdAt: 721692800, importedAt: 721692800 },
    })),
    fs.writeFile(blob, bytes),
  ]);
  return blob;
}

test('verifies iCloud originals in the stock Node worker and retains resumable queue receipts', async t => {
  const { directory, library, cloud } = await fixture(t);
  const root = path.join(directory, '同步测试库');
  const changed = Buffer.alloc(png.length, 5);
  const blob = await writeSync(root, changed);
  const state = await library.command('library:choose', ['jiancang', root]);
  const id = state.activeLibraryId;
  assert.ok(id, state.message);
  assert.equal(state.libraries[0].syncWritable, false);
  const events = [];
  const service = await cloud({ onChange: id => events.push(id) });
  const request = (name, ...args) => service.command(`cloud-originals:${name}`, [id, ...args]);
  assert.throws(() => request('start', { ids: ['../../outside'] }), /请选择有效的素材/);
  assert.throws(() => service.command('cloud-originals:status', [root]), /选择一个/);
  assert.equal((await request('start', { ids: [hash, hash, 'f'.repeat(64)] })).unavailable, 1);
  await waitFor(() => request('status').failed === 1);
  const failed = request('status', { filter: 'failed' });
  assert.equal(failed.tasks[0].code, 'CHECKSUM');
  assert.equal(failed.downloadedBytes, 0);
  assert.ok(request('copy-failures').text.includes("'=取回测试图"));
  assert.ok(!request('copy-failures').text.includes(root));
  assert.deepEqual(await fs.readFile(blob), changed);

  await fs.writeFile(blob, png);
  assert.deepEqual(await request('retry', { id: hash }), { ok: true, count: 1 });
  await waitFor(() => request('status').done === 1);
  assert.equal(request('status').downloadedBytes, png.length);
  await waitFor(() => events.includes(id));
  await service.close();

  const reopened = await cloud();
  assert.equal(reopened.command('cloud-originals:status', [id]).done, 1);
  assert.equal(reopened.command('cloud-originals:history-clear', [id]).count, 1);
  assert.equal(reopened.command('cloud-originals:status', [id]).total, 0);
  assert.deepEqual(await fs.readFile(blob), png);
});

test('pausing and removing a running cloud task aborts the worker without deleting its source', async t => {
  let attempts = 0;
  let stopped = 0;
  const { directory, library, cloud } = await fixture(t, {
    readOriginal: (source, { signal }) => {
      assert.equal(source.sha256, hash);
      attempts++;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        stopped++;
        reject(signal.reason);
      }, { once: true }));
    },
  });
  const root = path.join(directory, '可暂停云盘');
  const blob = await writeSync(root);
  const state = await library.command('library:choose', ['jiancang', root]);
  const id = state.activeLibraryId;
  assert.ok(id, state.message);
  const service = await cloud();
  const request = (name, ...args) => service.command(`cloud-originals:${name}`, [id, ...args]);
  await request('start');
  await waitFor(() => attempts === 1);
  assert.equal(request('pause', true).paused, true);
  await waitFor(() => stopped === 1 && request('status').pending === 1);
  assert.equal(request('pause', false).paused, false);
  await waitFor(() => attempts === 2);
  assert.equal(request('remove-task', hash).removedStatus, 'running');
  await waitFor(() => stopped === 2);
  assert.equal(request('status').total, 0);
  assert.deepEqual(await fs.readFile(blob), png);
});

test('storage counts and clears generated thumbnails while preserving originals', { skip: !process.env.JIANCANG_TEST_FFMPEG }, async t => {
  const { directory, library, cloud } = await fixture(t);
  library.ffmpeg = process.env.JIANCANG_TEST_FFMPEG;
  const root = path.join(directory, '含缓存的同步库');
  const blob = await writeSync(root);
  const state = await library.command('library:choose', ['jiancang', root]);
  assert.ok(state.activeLibraryId, state.message);
  const serve = mediaHandler(library);
  const service = await cloud({ thumbnailCache: serve });
  const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(bytes) { this.bytes = bytes; } };
  await serve({ method: 'GET', headers: {} }, response, 'thumbnail', state.activeLibraryId, hash, library.shutdown.signal);
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'image/jpeg');
  const current = await service.command('storage:status');
  assert.equal(current.libraries[0].count, 1);
  assert.equal(current.libraries[0].originals, 1);
  assert.equal(current.cache.count, 1);
  assert.ok(current.cache.bytes >= response.bytes.length);
  const result = await service.command('storage:clear-thumbnails');
  assert.equal(result.cache.count, 0);
  assert.equal(result.cache.removedCount, 1);
  assert.deepEqual(await fs.readFile(blob), png);
});
