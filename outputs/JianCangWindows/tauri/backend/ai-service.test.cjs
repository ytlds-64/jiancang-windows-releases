'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { AIService } = require('./ai-service.cjs');
const { LibraryService } = require('./library-service.cjs');
const { VisualService } = require('./visual-service.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const fixtureKey = 'only-a-synthetic-key';
const fixtureCipher = Buffer.from('fixture-encrypted-blob');
const safeStorage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => { assert.equal(value, fixtureKey); return fixtureCipher; },
  decryptStringAsync: async value => { assert.deepEqual(value, fixtureCipher); return { result: fixtureKey }; },
};

async function temporary(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-tauri-ai-')));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, cleanups };
}

async function complete(action, ready) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await action();
    if (ready(result)) return result;
    await delay(20);
  }
  assert.fail('AI 处理超过测试时限。');
}

test('reuses the Tauri asset revision and approved write path for suggestions and find-by-description', async t => {
  const { root, cleanups } = await temporary(t);
  const profile = path.join(root, 'profile');
  const library = new LibraryService(profile);
  await library.initialize();
  cleanups.push(() => library.close());
  const { activeLibraryId: id } = await library.command('local:create', ['合成测试库', root]);
  const target = library.captureTarget({ targetId: id });
  const captured = await library.importCapture({ id: '1'.repeat(32), targetId: id,
    source: { kind: 'buffer', targetLibraryId: target.libraryId, name: 'IMG_43210.png', bytes: png } });
  const { id: assetId } = captured;
  const asset = library.asset(assetId, id).asset;
  const reference = { registrationId: id, assetId, revision: JSON.stringify([asset.mediaRevision || assetId, asset.byteCount, asset.width, asset.height]) };

  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    requests.push({ path: request.url, authorization: request.headers.authorization, payload });
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'synthetic-vision-model' }] }));
      return;
    }
    const prompt = payload.messages[0].content;
    const value = prompt.includes('语义搜索') ? { description: '斜射光和浅色木桌' }
      : prompt.includes('按自然语言查询') ? { matches: [{ index: 0, score: 95 }] }
      : { title: '窗边的工作台', tags: ['木桌', '斜射光'], note: '阳光照到木桌上。' };
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const visual = new VisualService(library);
  if (library.ffmpeg) {
    await visual.initialize();
    cleanups.push(() => visual.close());
  }
  const rasterize = visual.image.bind(visual);
  const thumbnails = [];
  visual.image = async (requested, options) => {
    assert.ok(visual.current(requested));
    thumbnails.push(options.side);
    return library.ffmpeg ? rasterize(requested, options) : png;
  };
  const changes = [];
  const ai = new AIService(library, visual, { safeStorage, onChange: (name, snapshot) => changes.push({ name, snapshot }) });
  cleanups.push(() => ai.close());
  await ai.initialize();
  const call = (name, ...args) => ai.command(name, args);
  const settings = await call('suggestion:save-settings', { provider: 'lmstudio', model: 'synthetic-vision-model', key: fixtureKey, endpoint });
  assert.equal(settings.hasKey, true);
  const file = await fs.readFile(path.join(profile, 'asset-suggestions.json'), 'utf8');
  assert.ok(file.includes(fixtureCipher.toString('base64')));
  assert.ok(!file.includes(fixtureKey));
  assert.deepEqual(await call('suggestion:local-models', { endpoint }), ['synthetic-vision-model']);
  assert.throws(() => call('natural-search:start', '浅色木桌', [{ ...reference, revision: 'stale' }], settings), /素材已变化/);

  await call('suggestion:start', [{ registrationId: id, id: assetId }]);
  const batch = await complete(() => call('suggestion:batch'), batch => batch?.tasks[0]?.state === 'ready');
  assert.equal(batch.tasks[0].original.titleNeedsSuggestion, true);
  assert.equal(batch.tasks[0].writable, true);
  const [suggestion] = batch.tasks;
  const result = await call('suggestion:apply', [{ taskId: suggestion.taskId, fields: ['title'], fillMissing: ['title'] }]);
  assert.equal(result.applied, 1);
  assert.deepEqual(result.batch.tasks[0].applied, ['title']);
  const partial = await call('suggestion:batch');
  assert.equal(partial.tasks[0].writable, true);
  const tags = await call('suggestion:apply', [{ taskId: suggestion.taskId, fields: ['tags'], fillMissing: ['tags'] }]);
  assert.equal(tags.applied, 1);
  assert.deepEqual(tags.batch.tasks[0].applied, ['title', 'tags']);
  const updated = library.asset(assetId, id).asset;
  assert.equal(updated.name, '窗边的工作台');
  assert.deepEqual(updated.tags, ['木桌', '斜射光']);
  assert.equal(updated.note, '');

  const started = await call('natural-search:start', '浅色木桌', [reference], settings);
  assert.equal(started.total, 1);
  const search = await complete(() => call('natural-search:status'), status => status?.phase === 'completed');
  assert.equal(search.results[0].reference.assetId, assetId);
  assert.equal(search.results[0].score, 95);
  assert.deepEqual(thumbnails, [640, 384]);
  assert.ok(requests.every(item => item.authorization === `Bearer ${fixtureKey}`));
  assert.equal(requests.length, 4);
  assert.ok(!JSON.stringify(requests.map(item => item.payload)).includes('IMG_43210'));
  assert.ok(!JSON.stringify({ settings, changes }).includes(fixtureKey));
  assert.ok(changes.some(item => item.name === 'suggestion:changed') && changes.some(item => item.name === 'natural-search:changed'));
});

test('writes manually selected tags through Eagle and synchronizes approved format-6 metadata', async t => {
  const { root, cleanups } = await temporary(t);
  const eagleRoot = path.join(root, 'Eagle.library');
  const eagleItem = path.join(eagleRoot, 'images', 'ITEM01.info');
  const eagleMetadata = path.join(eagleItem, 'metadata.json');
  let item = { id: 'ITEM01', name: '原图', tags: ['原有标签'], annotation: '', folders: [],
    ext: 'png', width: 1, height: 1, isDeleted: false };
  await fs.mkdir(eagleItem, { recursive: true });
  await fs.writeFile(path.join(eagleRoot, 'metadata.json'), JSON.stringify({ id: 'local-qa-eagle', name: '测试 Eagle', folders: [] }));
  await fs.writeFile(path.join(eagleItem, '原图.png'), png);
  await fs.writeFile(eagleMetadata, JSON.stringify(item));

  const syncRoot = path.join(root, 'iCloud');
  await fs.mkdir(path.join(syncRoot, 'blobs', '.incoming'), { recursive: true });
  await fs.mkdir(path.join(syncRoot, 'changes'));
  await fs.writeFile(path.join(syncRoot, 'library.json'), JSON.stringify({ version: 6,
    format: 'com.materialshelf.directory-sync', libraryID: '00000000-0000-0000-a000-000000000001',
    namingDeviceID: '00000000-0000-0000-a000-000000000002', createdAt: 810_000_000 }));
  const library = new LibraryService(path.join(root, 'profile'), { eagleFetch: async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'http://127.0.0.1:41595');
    let data;
    if (url.pathname.endsWith('/library/info')) data = { path: eagleRoot, folders: [] };
    else if (url.pathname.endsWith('/item/get')) data = { data: [item], total: 1 };
    else {
      assert.equal(url.pathname, '/api/v2/item/update');
      item = { ...item, ...JSON.parse(options.body) };
      await fs.writeFile(eagleMetadata, JSON.stringify(item));
      data = item;
    }
    return Response.json({ status: 'success', data });
  } });
  await library.initialize();
  cleanups.push(() => library.close());
  const ai = new AIService(library, new VisualService(library), { safeStorage });
  cleanups.push(() => ai.close());
  await ai.initialize();

  function expected(ref, fillMissing = []) {
    const { name, tags, note, revision } = ai.suggestionAsset(ref);
    return { ...ref, revision, expected: { name, tags, note }, fillMissing };
  }
  const eagle = await library.command('library:choose', ['eagle', eagleRoot]);
  const eagleRef = { registrationId: eagle.activeLibraryId, id: eagle.library.assets[0].id };
  assert.equal(ai.suggestionAsset(eagleRef).writeBlock, 'eagle');
  await assert.rejects(ai.apply(expected(eagleRef), { tags: ['不可写'] }), /素材已变化/);
  await library.command('eagle:configure-write', [eagleRef.registrationId, true]);
  const eagleResult = await library.serial(() => ai.apply(expected(eagleRef), { tags: ['新标签'] }));
  assert.equal(eagleResult.ok, true);
  assert.deepEqual(item.tags, ['原有标签', '新标签']);

  const { activeLibraryId: syncID } = await library.command('library:choose', ['jiancang', syncRoot]);
  await library.command('sync:configure-write', [syncID, true]);
  const target = library.captureTarget({ targetId: syncID });
  const result = await library.importCapture({ id: '2'.repeat(32), targetId: syncID,
    source: { kind: 'buffer', targetLibraryId: target.libraryId, name: '同步素材.png', bytes: png } });
  const syncRef = { registrationId: syncID, id: result.id };
  assert.equal(ai.suggestionAsset(syncRef).writable, true);
  await library.serial(() => ai.apply(expected(syncRef, ['note']), { note: '来自整理建议' }));
  await library.command('library:refresh', [syncID]);
  assert.equal(ai.suggestionAsset(syncRef).note, '来自整理建议');
  await library.command('sync:configure-write', [syncID, false]);
  assert.equal(ai.suggestionAsset(syncRef).writeBlock, 'sync-disabled');
});

test('retains a Windows API key using the current user DPAPI across restarts', { skip: process.platform !== 'win32' }, async t => {
  const { root } = await temporary(t);
  const library = { profile: root, shutdown: new AbortController() };
  const first = new AIService(library, {});
  const settings = await first.command('suggestion:save-settings', [{ endpoint: 'https://api.example.invalid', model: 'vision', key: fixtureKey }]);
  assert.equal(settings.hasKey, true);
  const file = await fs.readFile(path.join(root, 'asset-suggestions.json'), 'utf8');
  assert.ok(!file.includes(fixtureKey) && !file.includes(Buffer.from(fixtureKey).toString('base64')));
  const second = new AIService(library, {});
  await second.initialize();
  assert.equal(typeof (await second.suggestions.openVisualSearch(settings)).describe, 'function');
  first.close();
  second.close();
});
