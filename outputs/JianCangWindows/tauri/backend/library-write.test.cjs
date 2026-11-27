'use strict';

const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { LibraryService } = require('./library-service.cjs');
const { publishSyncOriginal } = require('../../sync-upload.cjs');
const { DirectorySyncWriter } = require('../../sync-writer.cjs');
const { LOCAL_MANIFEST, createLocalLibrary, importLocalAsset, mutateLocalLibrary } = require('../../local-library.cjs');

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const checksum = createHash('sha256').update(image).digest('hex');
const iosDevice = '00000000-0000-4000-a000-000000000002';
const syncIdentity = '00000000-0000-4000-a000-000000000001';
const string = _0 => ({ string: { _0 } });

async function temporary(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-tauri-write-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('only reveals the real folder from a timed out library read', async t => {
  const directory = await temporary(t);
  const service = new LibraryService(path.join(directory, 'profile'));
  await assert.rejects(service.command('library:reveal-open-path', [directory]), /先选择/);
  service.opening = { directory, status: 'reading', controller: new AbortController() };
  await assert.rejects(service.command('library:reveal-open-path', []), /先选择/);
  service.opening.status = 'timed-out';
  assert.equal(await service.command('library:reveal-open-path', [path.join(directory, '..')]), directory);
  const alias = path.join(directory, 'alias');
  await fs.symlink(directory, alias, 'junction');
  service.opening.directory = alias;
  await assert.rejects(service.command('library:reveal-open-path', []), /真实的文件夹/);
  service.cancelOpen();
  await assert.rejects(service.command('library:reveal-open-path', []), /先选择/);
});

async function waitFor(predicate) {
  for (let turn = 0; turn < 80; turn++) {
    const result = await predicate();
    if (result) return result;
    await delay(50);
  }
  assert.fail('后台修改超过测试时限。');
}

test('publishes a partial local import catalog, covers watcher notifications and survives a final source failure', async t => {
  const directory = await temporary(t);
  const service = new LibraryService(path.join(directory, 'profile'));
  const firstVisible = Promise.withResolvers();
  const lastSource = Promise.withResolvers();
  const files = ['first.txt', 'second.txt', 'third.txt', 'fourth.txt', 'fifth.txt', 'missing.txt'];
  const paths = files.map(file => path.join(directory, file));
  await Promise.all(paths.map((file, index) => fs.writeFile(file, files[index])));
  let fileChanged;
  t.mock.method(require('node:fs'), 'watch', (_root, _options, listener) => {
    fileChanged = listener;
    return { on() {}, close() {} };
  });
  await service.initialize();
  try {
    const call = (name, ...args) => service.command(name, args);
    const { activeLibraryId: id, catalogs } = await call('local:create', '分批入库', directory);
    await waitFor(() => fileChanged);
    const initialRevision = catalogs.find(catalog => catalog.libraryId === id).revision;
    const refreshImported = service.refreshImportedEntry.bind(service);
    service.refreshImportedEntry = (...args) => {
      fileChanged('rename', LOCAL_MANIFEST);
      return refreshImported(...args);
    };
    const originalImport = service.importTask.bind(service);
    service.importTask = async (task, progress) => {
      if (task.name === 'second.txt') await firstVisible.promise;
      if (task.name === 'missing.txt') await lastSource.promise;
      return originalImport(task, progress);
    };
    let scans = 0;
    const originalRefresh = service.refreshEntry.bind(service);
    service.refreshEntry = (...args) => {
      scans++;
      return originalRefresh(...args);
    };
    await call('local-import:set-paused', id, true);
    await call('local-import:choose', id, null, paths);
    await fs.unlink(paths.at(-1));
    await call('local-import:set-paused', id, false);

    const queueState = () => call('local-import:list', id, false);
    const first = await waitFor(async () => {
      const queue = await queueState();
      return queue.summary.done === 1 && queue;
    });
    assert.notEqual(first.catalogRevision, initialRevision);
    assert.equal(first.refreshPending, false);
    assert.deepEqual(service.state().library.assets.map(asset => asset.name), ['first']);
    firstVisible.resolve();

    const available = files.length - 1;
    const partial = await waitFor(async () => {
      const queue = await queueState();
      return queue.summary.running === 1 && queue.summary.done === available && !queue.refreshPending &&
        service.state().library.assets.length === available && queue;
    });
    assert.notEqual(partial.catalogRevision, first.catalogRevision);
    assert.ok(scans < available, `expected consolidated scans instead of ${scans} individual scans`);
    lastSource.resolve();
    const failed = await waitFor(async () => {
      const queue = await queueState();
      return queue.summary.failed === 1 && queue;
    });
    assert.deepEqual(failed.summary, { pending: 0, running: 0, done: available, failed: 1 });
    assert.equal(failed.catalogRevision, partial.catalogRevision);
    for (const asset of service.state().library.assets) {
      assert.equal(await fs.readFile(service.original(asset.id, id).file, 'utf8'), `${asset.name}.txt`);
    }
  } finally {
    firstVisible.resolve();
    lastSource.resolve();
    await service.close();
  }
});

test('publishes committed local originals when paused and shows the first item of a following batch immediately', async t => {
  const directory = await temporary(t);
  const service = new LibraryService(path.join(directory, 'profile'));
  const files = ['first.txt', 'second.txt', 'cancelled.txt', 'next.txt', 'last.txt'];
  const paths = files.map(file => path.join(directory, file));
  await Promise.all(paths.map(file => fs.writeFile(file, path.basename(file))));
  await service.initialize();
  const finish = Promise.withResolvers();
  try {
    const call = (name, ...args) => service.command(name, args);
    const { activeLibraryId: id } = await call('local:create', '暂停入库', directory);
    service.watcher.close();
    const importTask = service.importTask.bind(service);
    const assetNames = () => service.state().library.assets.map(asset => asset.name).sort();
    let namesAfterNext;
    service.importTask = async (task, progress) => {
      if (task.name === 'last.txt') await finish.promise;
      const result = await importTask(task, progress);
      if (task.name === 'second.txt') await call('local-import:set-paused', id, true);
      if (task.name === 'next.txt') namesAfterNext = assetNames();
      return result;
    };
    await call('local-import:choose', id, null, paths.slice(0, 3));
    await waitFor(async () => {
      const queue = await call('local-import:list', id, false);
      return queue.paused && queue.summary.done === 2 && !queue.refreshPending;
    });
    assert.deepEqual(assetNames(), ['first', 'second']);
    assert.deepEqual(await call('local-import:cancel-pending', id), { ok: true, cancelled: 1 });
    await call('local-import:choose', id, null, paths.slice(3));
    await call('local-import:set-paused', id, false);
    await waitFor(() => namesAfterNext);
    assert.deepEqual(namesAfterNext, ['first', 'next', 'second']);
    finish.resolve();
    await waitFor(async () => {
      const queue = await call('local-import:list', id, false);
      return queue.summary.done === 4 && !queue.refreshPending;
    });
    assert.deepEqual(assetNames(), ['first', 'last', 'next', 'second']);
  } finally {
    finish.resolve();
    await service.close();
  }
});

test('cleans expired local trash when reopening an already connected library', async t => {
  const directory = await temporary(t);
  const root = path.join(directory, '启动后清理');
  const profile = path.join(directory, 'profile');
  await createLocalLibrary(root, '启动后清理');
  const old = await importLocalAsset(root, { jobId: 'expire', filename: 'old.png', bytes: image });
  const active = await importLocalAsset(root, { jobId: 'active', filename: 'active.png', bytes: image });
  await mutateLocalLibrary(root, { action: 'trash', ids: [old.id] });
  const first = new LibraryService(profile);
  await first.initialize();
  let original;
  try {
    const { activeLibraryId } = await first.command('library:choose', ['local', root]);
    original = first.catalogs.get(activeLibraryId).originals.get(old.id);
  } finally {
    await first.close();
  }
  const manifestFile = path.join(root, LOCAL_MANIFEST);
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.assets[old.id].trashedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  await fs.writeFile(manifestFile, JSON.stringify(manifest));

  const reopened = new LibraryService(profile);
  await reopened.initialize();
  try {
    await waitFor(() => reopened.state().library?.assets.every(asset => asset.id !== old.id));
    assert.deepEqual(reopened.state().library.assets.map(asset => asset.id), [active.id]);
    await assert.rejects(fs.stat(original), { code: 'ENOENT' });
  } finally {
    await reopened.close();
  }
});

test('permanently deletes only confirmed trash in the registered local library', async t => {
  const directory = await temporary(t);
  const service = new LibraryService(path.join(directory, 'profile'));
  await service.initialize();
  t.after(() => service.close());
  const call = (name, ...args) => service.command(name, args);
  const { activeLibraryId: id } = await call('local:create', '本地回收站', directory);
  const { activeLibraryId: other, catalogs } = await call('local:create', '其他素材库', directory);
  const otherRevision = catalogs.find(catalog => catalog.libraryId === other).revision;
  const localRoot = await call('library:reveal-path', id);
  const source = path.join(directory, '临时图.png');
  const otherSource = path.join(directory, '保留.csv');
  await fs.writeFile(source, image);
  await fs.writeFile(otherSource, '保留原件');
  await call('local-import:choose', id, null, [source, otherSource]);
  const localCatalog = state => state.catalogs.find(catalog => catalog.libraryId === id);
  const assets = await waitFor(async () => {
    const catalog = localCatalog(await call('library:state'));
    return catalog?.library.assets.length === 2 && catalog.library.assets;
  });
  const removed = assets.find(asset => asset.extension === 'png');
  const kept = assets.find(asset => asset.extension === 'csv');
  const removedFile = service.original(removed.id, id).file;
  const keptFile = service.original(kept.id, id).file;
  assert.equal(await call('asset:default-path', kept.id, id), keptFile);
  const { state } = await call('local:mutate', id, { action: 'trash', ids: [removed.id] });
  await assert.rejects(call('asset:default-path', removed.id, id), /请先导出/);
  // Keep the confirmation snapshot fixed while deliberately replacing test paths.
  service.watcher.close();
  const request = ({ library, revision }) => ({
    action: 'purgeTrash', ids: [removed.id], revision: library.revision, catalogRevision: revision,
  });
  const command = request(localCatalog(state));
  await assert.rejects(call('local:mutate', id, { ...command, catalogRevision: otherRevision }), /回收站已更新/);
  await assert.rejects(call('local:mutate', id, { ...command, revision: '0' }), /回收站已更新/);
  await assert.rejects(call('local:mutate', id, { ...command, ids: [removed.id, kept.id] }), /仍在回收站/);
  await assert.rejects(call('local:mutate', id, { ...command, ids: ['../外部素材'] }), /素材已变化/);
  assert.deepEqual(await fs.readFile(removedFile), image);

  const replacement = path.join(directory, '替换.png');
  await fs.writeFile(replacement, image);
  await fs.rename(replacement, removedFile);
  await assert.rejects(call('local:mutate', id, command), /原件在确认前发生变化/);

  const confirmed = request(localCatalog(await call('library:refresh', id)));
  const originalRoot = path.join(directory, '暂移回收站');
  await fs.rename(localRoot, originalRoot);
  await fs.cp(originalRoot, localRoot, { recursive: true });
  await assert.rejects(call('local:mutate', id, confirmed), /素材库位置已变化/);
  assert.deepEqual(await fs.readFile(removedFile), image);
  const copyRoot = path.join(directory, '库副本');
  await fs.rename(localRoot, copyRoot);
  await fs.rename(originalRoot, localRoot);

  const current = request(localCatalog(await call('library:refresh', id)));
  const result = await call('local:mutate', id, current);
  assert.equal(result.count, 1);
  assert.equal(result.pendingPurge, 0);
  await assert.rejects(fs.stat(removedFile), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(source), image);
  assert.deepEqual(await fs.readFile(path.join(copyRoot, path.relative(localRoot, removedFile))), image);
  assert.equal(await fs.readFile(keptFile, 'utf8'), '保留原件');
  assert.deepEqual(localCatalog(result.state).library.assets.map(asset => asset.id), [kept.id]);
  await assert.rejects(call('local:mutate', id, { action: 'retryPurge', catalogRevision: current.catalogRevision }), /回收站已更新/);
  const retry = await call('local:mutate', id, { action: 'retryPurge', catalogRevision: localCatalog(result.state).revision });
  assert.equal(retry.pendingPurge, 0);
});

async function syncFixture(root, libraryID, version) {
  await fs.mkdir(path.join(root, 'blobs', '.incoming'), { recursive: true });
  await fs.mkdir(path.join(root, 'changes'));
  await fs.writeFile(path.join(root, 'library.json'), JSON.stringify({
    libraryID, version, namingDeviceID: iosDevice, format: 'com.materialshelf.directory-sync', createdAt: 810_000_000,
  }));
}

async function publishMobileEdit(root, desktopOperation, changes, { device = iosDevice, ordinal = 1, clock = {} } = {}) {
  const id = randomUUID();
  const { asset, entityID, libraryID, deviceID, counter } = desktopOperation;
  const operation = { version: 1, id, entityID, libraryID, asset, entityKind: 'asset', deviceID: device,
    counter: ordinal, clock: { [deviceID]: counter, ...clock, [device]: ordinal }, changes };
  const records = path.join(root, 'changes', device);
  await fs.mkdir(records, { recursive: true });
  await fs.writeFile(path.join(records, `${ordinal}-${id}.json`), JSON.stringify(operation));
  return id;
}

test('coalesces the watcher read after a confirmed move to trash and observes a later mobile edit', async t => {
  const directory = await temporary(t);
  const root = path.join(directory, '同步回收站');
  await syncFixture(root, syncIdentity, 6);
  const writer = new DirectorySyncWriter({ directory: path.join(directory, 'seed') });
  await writer.initialize();
  try {
    const imported = await writer.upload({ root, libraryId: syncIdentity }, {
      jobId: randomUUID(), filename: '样片.png', bytes: image,
    });
    assert.equal(imported.pending, 0);
  } finally { await writer.close(); }

  const service = new LibraryService(path.join(directory, 'profile'));
  let fileChanged;
  t.mock.method(require('node:fs'), 'watch', (_root, _options, listener) => {
    fileChanged = listener;
    return { on() {}, close() {} };
  });
  await service.initialize();
  try {
    const call = (name, ...args) => service.command(name, args);
    const { activeLibraryId: id } = await call('library:choose', 'jiancang', root);
    await call('sync:configure-write', id, true);
    await service.operations;
    await waitFor(() => fileChanged);
    let reads = 0;
    const refresh = service.refreshEntry.bind(service);
    service.refreshEntry = (...args) => {
      reads++;
      return refresh(...args);
    };
    const commit = service.commitMutation.bind(service);
    service.commitMutation = async (...args) => {
      const result = await commit(...args);
      fileChanged('rename', 'changes/desktop/record.json');
      return result;
    };

    const moved = await call('local:mutate', id, { action: 'trash', ids: [checksum] });
    assert.equal(moved.count, 1);
    assert.equal(moved.pending, 0);
    assert.equal(moved.state.library.assets[0].trashed, true);
    await delay(800);
    await service.operations;
    assert.equal(reads, 1);
    assert.deepEqual(await fs.readFile(service.original(checksum, id).file), image);

    const published = JSON.parse(await fs.readFile(await call('sync:latest-record-path', id), 'utf8'));
    await publishMobileEdit(root, published, { name: string('稍后到达的 iPad 更新') }, { clock: published.clock });
    fileChanged('rename', 'changes/mobile/record.json');
    await waitFor(() => service.state().library.assets[0]?.name === '稍后到达的 iPad 更新');
    assert.equal(service.state().library.assets[0].trashed, true);
  } finally { await service.close(); }
});

test('coalesces sync imports and watcher updates before verifying the final catalog', async t => {
  const directory = await temporary(t);
  const root = path.join(directory, '同步导入');
  await syncFixture(root, syncIdentity, 6);
  const service = new LibraryService(path.join(directory, 'profile'));
  const paths = ['sync-first.txt', 'sync-second.txt', 'sync-third.txt', 'sync-last.txt']
    .map(file => path.join(directory, file));
  const expected = new Map(paths.map(file => {
    const original = Buffer.from(path.basename(file));
    return [createHash('sha256').update(original).digest('hex'), original];
  }));
  const secondStarted = Promise.withResolvers();
  const resume = Promise.withResolvers();
  await Promise.all(paths.map(file => fs.writeFile(file, path.basename(file))));
  let fileChanged;
  t.mock.method(require('node:fs'), 'watch', (_root, _options, listener) => {
    fileChanged = listener;
    return { on() {}, close() {} };
  });
  await service.initialize();
  try {
    const call = (name, ...args) => service.command(name, args);
    const { activeLibraryId: id, catalogs } = await call('library:choose', 'jiancang', root);
    const initialRevision = catalogs.find(catalog => catalog.libraryId === id).revision;
    await call('sync:configure-write', id, true);
    await service.operations;
    await waitFor(() => fileChanged);
    const importTask = service.importTask.bind(service);
    service.importTask = async (task, progress) => {
      if (task.name === 'sync-second.txt') {
        secondStarted.resolve();
        await resume.promise;
      }
      return importTask(task, progress);
    };
    let scans = 0;
    const refresh = service.refreshEntry.bind(service);
    service.refreshEntry = (...args) => {
      scans++;
      return refresh(...args);
    };
    await call('local-import:choose', id, null, paths);
    await secondStarted.promise;
    const first = JSON.parse(await fs.readFile(await call('sync:latest-record-path', id), 'utf8'));
    const firstEdit = await publishMobileEdit(root, first, { name: string('导入中的外部更新') });
    fileChanged('rename', `changes/${iosDevice}/1-${firstEdit}.json`);
    await delay(800);
    assert.equal(scans, 0);
    const running = await call('local-import:list', id, false);
    assert.deepEqual(running.summary, { pending: 2, running: 1, done: 1, failed: 0 });
    assert.equal(running.refreshPending, true);
    resume.resolve();

    const complete = await waitFor(async () => {
      const queue = await call('local-import:list', id, false);
      return queue.summary.done === paths.length && !queue.refreshPending && queue;
    });
    assert.notEqual(complete.catalogRevision, initialRevision);
    assert.equal(scans, 1);
    const state = service.state();
    assert.equal(state.libraries.find(library => library.id === id).writeStatus.pending, 0);
    assert.deepEqual(new Set(state.library.assets.map(asset => asset.id)), new Set(expected.keys()));
    assert.equal(state.library.assets.find(asset => asset.id === first.entityID).name, '导入中的外部更新');
    for (const [assetId, bytes] of expected) assert.deepEqual(await fs.readFile(service.original(assetId, id).file), bytes);

    const last = JSON.parse(await fs.readFile(await call('sync:latest-record-path', id), 'utf8'));
    const lastEdit = await publishMobileEdit(root, last, { name: string('外部更新') }, { ordinal: 2 });
    fileChanged('rename', `changes/${iosDevice}/2-${lastEdit}.json`);
    await waitFor(() => service.state().library.assets.some(asset => asset.id === last.entityID && asset.name === '外部更新'));
  } finally {
    resume.resolve();
    await service.close();
  }
});

test('flushes committed sync imports after pause, cancellation and the final source failure', async t => {
  const directory = await temporary(t);
  const root = path.join(directory, '同步导入');
  await syncFixture(root, syncIdentity, 6);
  const service = new LibraryService(path.join(directory, 'profile'));
  const paths = ['first.txt', 'cancelled.txt', 'last-good.txt', 'last-missing.txt'].map(file => path.join(directory, file));
  await Promise.all(paths.map(file => fs.writeFile(file, path.basename(file))));
  await service.initialize();
  try {
    const call = (name, ...args) => service.command(name, args);
    const { activeLibraryId: id } = await call('library:choose', 'jiancang', root);
    await call('sync:configure-write', id, true);
    // No filesystem events here, so the final refresh must come from the queue boundary.
    service.watcher.close();
    const importTask = service.importTask.bind(service);
    service.importTask = async (task, progress) => {
      const result = await importTask(task, progress);
      if (task.name === 'first.txt') await call('local-import:set-paused', id, true);
      return result;
    };
    await call('local-import:choose', id, null, paths.slice(0, 2));
    await waitFor(async () => {
      const queue = await call('local-import:list', id, false);
      return queue.paused && queue.summary.done === 1 && !queue.refreshPending;
    });
    assert.equal(service.state().library.assets[0].name, 'first');
    assert.deepEqual(await call('local-import:cancel-pending', id), { ok: true, cancelled: 1 });

    await call('local-import:choose', id, null, paths.slice(2));
    await fs.rm(paths.at(-1));
    await call('local-import:set-paused', id, false);
    await waitFor(async () => {
      const queue = await call('local-import:list', id, false);
      return queue.summary.failed === 1 && queue.summary.done === 2 && !queue.refreshPending;
    });
    assert.deepEqual(service.state().library.assets.map(asset => asset.name).sort(), ['first', 'last-good']);
  } finally { await service.close(); }
});

test('migrates explicit Eagle update, stale baselines and batch changes through the existing local API', async t => {
  const directory = await temporary(t);
  const root = path.join(directory, '样片.library');
  const other = path.join(directory, '备用.library');
  const itemPath = path.join(root, 'images', 'ITEM01.info');
  const itemFile = path.join(itemPath, 'metadata.json');
  const folders = [{ id: 'FOLDER1', name: '测试文件夹' }];
  let item = { id: 'ITEM01', name: '原图', tags: ['保留'], annotation: '', url: '', folders: [], star: 2,
    ext: 'png', width: 1, height: 1, isDeleted: false };
  let active = other;
  const updates = [];
  const save = () => fs.writeFile(itemFile, JSON.stringify(item));
  await fs.mkdir(itemPath, { recursive: true });
  await fs.mkdir(other);
  await fs.writeFile(path.join(root, 'metadata.json'), JSON.stringify({ id: 'test-eagle', name: '样片', folders }));
  await fs.writeFile(path.join(itemPath, '原图.png'), image);
  await save();
  const service = new LibraryService(path.join(directory, 'profile'), { eagleFetch: async (url, options) => {
    const request = new URL(url);
    assert.equal(request.origin, 'http://127.0.0.1:41595');
    let data;
    if (request.pathname.endsWith('/library/info')) data = { path: active, folders };
    else if (request.pathname.endsWith('/item/get')) {
      assert.equal(request.searchParams.get('id'), item.id);
      data = { data: [item], total: 1 };
    } else {
      assert.equal(request.pathname, '/api/v2/item/update');
      const patch = JSON.parse(options.body);
      assert.equal(patch.id, item.id);
      updates.push(patch);
      const previousName = item.name;
      item = { ...item, ...patch };
      if (item.name !== previousName) {
        await fs.rename(path.join(itemPath, `${previousName}.png`), path.join(itemPath, `${item.name}.png`));
      }
      await save();
      data = item;
    }
    return Response.json({ status: 'success', data });
  } });
  await service.initialize();
  t.after(() => service.close());
  const opened = await service.command('library:choose', ['eagle', root]);
  const id = opened.activeLibraryId;
  const asset = opened.library.assets[0].id;
  assert.equal(opened.libraries[0].eagleWritable, false);
  await assert.rejects(service.command('eagle:edit', [id, asset, { rating: 4 }, { rating: 2 }]), /开启双向同步/);
  await assert.rejects(service.command('eagle:configure-write', [id, true]), /当前打开的素材库/);
  active = root;
  const enabled = await service.command('eagle:configure-write', [id, true]);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.state.libraries[0].eagleWritable, true);
  await assert.rejects(service.command('local:mutate', [id, { action: 'purgeTrash', ids: [asset] }]), /不支持这项回收站操作/);
  assert.deepEqual(service.captureLibraries(), []);
  const edited = await service.command('eagle:edit', [id, asset, { rating: 4 }, { rating: 2 }]);
  assert.equal(edited.state.library.assets[0].rating, 4);
  await assert.rejects(service.command('eagle:edit', [id, asset, { rating: 3 }, { rating: 2 }]), /已在 Eagle 中修改/);
  assert.equal(updates.length, 1);
  const bulk = await service.command('local:mutate', [id, { action: 'edit', ids: [asset, checksum], addTags: ['追加'], addCollectionIds: ['FOLDER1'] }]);
  assert.equal(bulk.count, 1);
  assert.equal(bulk.failed.length, 1);
  assert.deepEqual(bulk.state.library.assets[0].tags, ['保留', '追加']);
  const entries = [{ id: asset, name: '新名称' }];
  const plan = await service.command('local:mutate', [id, { action: 'planRename', entries }]);
  await assert.rejects(service.command('local:mutate', [id, { action: 'rename', entries, revision: checksum }]), /素材已变化/);
  const renamed = await service.command('local:mutate', [id, { action: 'rename', entries, revision: plan.revision }]);
  assert.equal(renamed.state.library.assets[0].name, '新名称');
  await service.command('eagle:configure-write', [id, false]);
  await assert.rejects(service.command('local:mutate', [id, { action: 'edit', ids: [asset], addTags: ['不能写'] }]), /开启双向同步/);
});

test('controls format-6 two-way sync, captured originals, durable retry and connected history', async t => {
  const directory = await temporary(t);
  const profile = path.join(directory, 'profile');
  const root = path.join(directory, 'iCloud');
  const sibling = path.join(directory, 'iCloud duplicate');
  const old = path.join(directory, 'iCloud legacy');
  await Promise.all([syncFixture(root, syncIdentity, 6), syncFixture(sibling, syncIdentity, 6), syncFixture(old, randomUUID(), 5)]);
  let outage = true;
  const notifications = [];
  let service;
  async function create() {
    service = new LibraryService(profile, { onStateChange: state => notifications.push(state),
      publishSyncOriginal: async input => {
        if (outage) throw Object.assign(new Error('临时中断'), { code: 'EIO' });
        return publishSyncOriginal(input);
      } });
    await service.initialize();
  }
  t.after(() => service?.close());
  await create();
  const call = (...args) => service.command(...args);
  const { activeLibraryId: oldID } = await call('library:choose', ['jiancang', old]);
  await assert.rejects(call('sync:configure-write', [oldID, true]), /升级到同步格式 6/);
  const local = await call('local:create', ['可采集的本地库', directory]);
  const localSelection = service.captureTarget({ targetId: local.activeLibraryId });
  const sourceURL = 'https://example.org/notes/123?desc=complete';
  const localCapture = await service.importCapture({ id: '4'.repeat(32), targetId: localSelection.targetId,
    source: { kind: 'buffer', targetLibraryId: localSelection.libraryId, name: '网页图片.png', bytes: image, sourceURL } });
  assert.match(localCapture.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(await fs.readFile(service.original(localCapture.id, localSelection.targetId).file), image);

  const opened = await call('library:choose', ['jiancang', root]);
  const id = opened.activeLibraryId;
  assert.equal(opened.libraries.find(item => item.id === id).syncWritable, false);
  assert.deepEqual(service.captureLibraries().map(item => item.targetId), [localSelection.targetId]);
  await assert.rejects(call('local:mutate', [id, { action: 'createCollection', name: '未授权的写入' }]), /开启双向同步/);
  assert.deepEqual(await fs.readdir(path.join(root, 'changes')), []);
  assert.equal((await call('sync:configure-write', [id, true])).state.libraries.find(item => item.id === id).syncWritable, true);
  await assert.rejects(call('local:mutate', [id, { action: 'purgeTrash', all: true }]), /重新确认/);
  const { activeLibraryId: siblingID } = await call('library:choose', ['jiancang', sibling]);
  await assert.rejects(call('sync:configure-write', [siblingID, true]), /另一个文件夹开启写入/);
  await call('library:switch', [id]);
  const collection = await service.createCaptureCollection({ targetId: id }, '采集目录');
  const selection = service.captureTarget({ targetId: id, collectionId: collection.id });
  assert.match(selection.destination, /采集目录$/);
  const task = { id: '2'.repeat(32), targetId: id, collectionId: collection.id, tags: ['采集'],
    source: { kind: 'buffer', targetLibraryId: selection.libraryId, name: '网页原图.png', bytes: image, sourceURL } };
  await assert.rejects(service.importCapture({ ...task, source: { ...task.source, targetLibraryId: randomUUID() } }), /目标素材库已变化/);
  await assert.rejects(service.importCapture(task), /同步/);
  assert.equal((await call('library:state', [])).libraries.find(item => item.id === id).writeStatus.pending, 1);
  assert.equal(service.captureLibraries().some(item => item.targetId === id), false);
  await call('sync:configure-write', [id, false]);
  await service.close();
  service = null;
  outage = false;
  await create();
  const restarted = await call('library:state', []);
  assert.equal(restarted.libraries.find(item => item.id === id).writeStatus.pending, 1);
  assert.equal(restarted.libraries.find(item => item.id === id).syncWritable, false);
  await call('sync:configure-write', [id, true]);
  const completed = await call('sync:retry-write', [id]);
  assert.equal(completed.pending, 0);
  const saved = completed.state.library.assets[0];
  assert.deepEqual([saved.id, saved.width, saved.height, saved.sourceURL, saved.tags, saved.collectionIds],
    [checksum, 1, 1, sourceURL, ['采集'], [collection.id]]);
  assert.equal((await service.importCapture(task)).id, checksum);
  const lastPublished = await call('sync:latest-record-path', [id]);
  const desktop = JSON.parse(await fs.readFile(lastPublished, 'utf8'));
  assert.equal(desktop.entityID, checksum);
  assert.deepEqual(await fs.readFile(service.original(checksum, id).file), image);
  await publishMobileEdit(root, desktop, { name: string('来自 iPad 的名称') });
  await waitFor(() => service.state().library.assets[0]?.name === '来自 iPad 的名称');
  await waitFor(() => notifications.some(state => state.library?.assets[0]?.name === '来自 iPad 的名称'));
  const edited = await call('local:mutate', [id, { action: 'edit', ids: [checksum], addTags: ['桌面'] }]);
  assert.deepEqual(edited.state.library.assets[0].tags, ['桌面', '采集']);
  const undone = await call('local:mutate', [id, { action: 'undo' }]);
  assert.deepEqual(undone.state.library.assets[0].tags, ['采集']);
  assert.equal((await call('sync-conflicts:list', [id])).total, 0);
  await publishMobileEdit(root, desktop, { note: string('iPad 备注') }, { ordinal: 2 });
  const phoneEdit = await publishMobileEdit(root, desktop, { note: string('iPhone 备注') },
    { device: randomUUID(), clock: { [iosDevice]: 1 } });
  const review = await call('sync-conflicts:list', [id]);
  assert.equal(review.total, 1);
  const [{ kind, entityId, field, signature }] = review.conflicts;
  const choice = { kind, entityId, field, signature, choiceId: phoneEdit };
  await assert.rejects(call('sync-conflicts:resolve', [id, { ...choice, choiceId: randomUUID() }]), { code: 'SYNC_CONFLICT_CHOICE' });
  const resolved = await call('sync-conflicts:resolve-batch', [id, [{ ...choice, value: '请求中注入的备注' }]]);
  assert.deepEqual(resolved.results, [{ signature, status: 'resolved' }]);
  assert.equal(resolved.state.library.assets[0].note, 'iPhone 备注');
  assert.equal((await call('sync-conflicts:list', [id])).total, 0);

  const originalFile = service.original(checksum, id).file;
  const change = action => call('local:mutate', [id, { action, ids: [checksum] }]);
  const catalog = state => state.catalogs.find(item => item.libraryId === id);
  const purge = (state, ids = [checksum]) => call('local:mutate', [id, { action: 'purgeTrash', ids,
    trashRevision: catalog(state).library.trashRevision }]);
  const trashed = await change('trash');
  assert.equal(trashed.state.library.assets[0].trashed, true);
  assert.equal((await change('restore')).state.library.assets[0].trashed, false);
  await assert.rejects(purge(trashed.state), /重新确认/);
  await assert.rejects(purge(service.state()), /重新确认/);

  const currentTrash = (await change('trash')).state;
  await assert.rejects(purge(trashed.state), /重新确认/);
  await assert.rejects(purge(currentTrash, [checksum, 'a'.repeat(64)]), /重新确认/);
  assert.equal(service.state().library.assets[0].trashed, true);

  // Hydrating or evicting an original changes the gallery snapshot, while this remains the same trash entry.
  service.watcher.close();
  const stagedOriginal = path.join(directory, 'staged.png');
  await fs.rename(originalFile, stagedOriginal);
  const refreshed = await call('library:refresh', [id]);
  assert.equal(refreshed.library.assets[0].available, false);
  assert.notEqual(catalog(refreshed).revision, catalog(currentTrash).revision);
  assert.equal(catalog(refreshed).library.trashRevision, catalog(currentTrash).library.trashRevision);
  await fs.rename(stagedOriginal, originalFile);

  const savedRoot = path.join(directory, 'moved-sync');
  const copiedRoot = path.join(directory, 'copied-sync');
  await fs.rename(root, savedRoot);
  await fs.cp(savedRoot, root, { recursive: true });
  await assert.rejects(purge(currentTrash), /重新确认/);
  await fs.rename(root, copiedRoot);
  await fs.rename(savedRoot, root);

  const deleted = await purge(currentTrash);
  assert.equal(deleted.count, 1);
  assert.equal(deleted.pending, 0);
  assert.deepEqual(deleted.state.library.assets, []);
  const deletion = JSON.parse(await fs.readFile(await call('sync:latest-record-path', [id]), 'utf8'));
  assert.deepEqual(deletion.changes, { life: { bool: { _0: false } } });
  assert.equal(deletion.entityID, checksum);
  assert.deepEqual(await fs.readFile(originalFile), image);
  assert.deepEqual(await fs.readFile(path.join(copiedRoot, path.relative(root, originalFile))), image);
});
