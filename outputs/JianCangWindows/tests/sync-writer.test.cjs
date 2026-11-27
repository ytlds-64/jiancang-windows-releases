'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DirectorySyncWriter } = require('../sync-writer.cjs');
const { readLibrary, listSyncConflicts } = require('../sync-library.cjs');
const { publishSyncOriginal } = require('../sync-upload.cjs');

const libraryID = '00000000-0000-4000-a000-000000000001';
const appleDevice = '00000000-0000-4000-a000-000000000002';
const otherDevice = '00000000-0000-4000-a000-000000000003';
const time = 1_786_040_000;
const original = Buffer.from('Windows sync fixture original');
const assetID = createHash('sha256').update(original).digest('hex');
const media = {
  blob: { sha256: assetID, byteCount: original.length }, kind: 'image', fileExtension: 'png',
  pixelWidth: 1280, pixelHeight: 900, createdAt: time - 978_307_200, importedAt: time - 978_307_200,
};
const wrap = (type, value) => ({ [type]: { _0: value } });
const nil = { null: {} };

async function setup(t, version = 6) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-sync-writer-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'Connected');
  const profile = path.join(directory, 'Profile');
  await fs.mkdir(path.join(root, 'blobs', '.incoming'), { recursive: true });
  await fs.mkdir(path.join(root, 'changes'));
  await fs.writeFile(path.join(root, 'library.json'), JSON.stringify({
    version, libraryID, namingDeviceID: appleDevice, format: 'com.materialshelf.directory-sync', createdAt: time - 978_307_200,
  }));
  return { directory, entry: { root, libraryId: libraryID }, profile };
}

async function remote(entry, device, counter, changes, predecessors = {}, birth = false, collectionId) {
  const operation = { version: 1, libraryID, deviceID: device, counter, id: randomUUID(),
    clock: { ...predecessors, [device]: counter }, changes,
    ...(collectionId ? { entityKind: 'collection', entityID: collectionId } : { entityKind: 'asset', entityID: assetID, asset: media }) };
  const dir = path.join(entry.root, 'changes', device);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${counter}-${operation.id}.json`), JSON.stringify(operation));
  if (birth) await fs.writeFile(path.join(entry.root, 'blobs', '.incoming', `${assetID}.${operation.id}.png`), original);
  return operation;
}

const mobileBirth = { life: wrap('bool', true), name: wrap('string', '手机素材'), note: wrap('string', ''),
  favorite: wrap('bool', false), rating: wrap('int', 1), sourceURL: nil, eagleID: nil,
  createdAt: wrap('double', time), deletedAt: nil, 'tag:旧标签': wrap('bool', true) };

function remoteCollectionBirth(name, parentId = null) {
  return { life: wrap('bool', true), name: wrap('string', name), parentID: parentId === null ? nil : wrap('string', parentId),
    colorHex: wrap('string', '46786B'), symbol: wrap('string', 'folder'), createdAt: wrap('double', time) };
}

test('clears just the selected collection membership from a format-6 sync library', async t => {
  const { entry, profile } = await setup(t);
  const current = randomUUID();
  const other = randomUUID();
  await remote(entry, appleDevice, 1, remoteCollectionBirth('当前集合'), {}, false, current);
  await remote(entry, appleDevice, 2, remoteCollectionBirth('其他集合'), {}, false, other);
  await remote(entry, appleDevice, 3, {
    ...mobileBirth, favorite: wrap('bool', true), rating: wrap('int', 4),
    [`member:${current}`]: wrap('bool', true), [`member:${other}`]: wrap('bool', true),
  }, {}, true);
  const writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  const command = { action: 'edit', ids: [assetID], removeCollectionIds: [current] };
  assert.equal((await writer.mutate(entry, command)).count, 1);
  assert.equal((await writer.mutate(entry, command)).count, 0);
  const operations = await records(entry);
  assert.deepEqual(operations.map(item => item.changes), [{ [`member:${current}`]: wrap('bool', false) }]);
  const catalog = await readLibrary(entry.root);
  const [asset] = catalog.assets;
  assert.deepEqual([asset.collectionIds, asset.favorite, asset.rating, asset.tags, asset.trashed], [[other], true, 4, ['旧标签'], false]);
  assert.deepEqual(await fs.readFile(catalog.originals.get(assetID)), original);
});

test('publishes one inspector edit for the name, note, tags, URL and collection membership', async t => {
  const { entry, profile } = await setup(t);
  const originalGroup = randomUUID();
  const newGroup = randomUUID();
  await remote(entry, appleDevice, 1, remoteCollectionBirth('待整理'), {}, false, originalGroup);
  await remote(entry, appleDevice, 2, remoteCollectionBirth('收录'), {}, false, newGroup);
  await remote(entry, appleDevice, 3, { ...mobileBirth, [`member:${originalGroup}`]: wrap('bool', true) }, {}, true);
  const writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  const command = { action: 'edit', ids: [assetID], name: '晨光.png', note: '窗口的自然光', tags: ['新标签'],
    sourceURL: 'https://example.org/photo', removeCollectionIds: [originalGroup], addCollectionIds: [newGroup] };
  await assert.rejects(writer.mutate(entry, { ...command, sourceURL: 'ftp://example.org/photo' }), /HTTP/);
  assert.deepEqual(await records(entry), []);
  assert.equal((await writer.mutate(entry, command)).pending, 0);
  assert.deepEqual((await records(entry)).map(operation => operation.changes), [{
    name: wrap('string', '晨光'), note: wrap('string', '窗口的自然光'), sourceURL: wrap('string', 'https://example.org/photo'),
    'tag:旧标签': wrap('bool', false), 'tag:新标签': wrap('bool', true),
    [`member:${originalGroup}`]: wrap('bool', false), [`member:${newGroup}`]: wrap('bool', true),
  }]);
  const catalog = await readLibrary(entry.root);
  assert.deepEqual(await fs.readFile(catalog.originals.get(assetID)), original);
  assert.deepEqual(catalog.assets[0].collectionIds, [newGroup]);
  assert.equal(catalog.assets[0].name, '晨光');
});

test('undoes and redoes successive sync edits across restart without reverting another field from iPad', async t => {
  const { entry, profile } = await setup(t);
  const collection = randomUUID();
  await remote(entry, appleDevice, 1, remoteCollectionBirth('参考板'), {}, false, collection);
  await remote(entry, appleDevice, 2, mobileBirth, {}, true);
  let writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  const edit = patch => writer.mutate(entry, { action: 'edit', ids: [assetID], ...patch });
  const latest = async () => (await readLibrary(entry.root)).assets[0];
  assert.equal((await edit({ name: '桌面素材', note: '初稿', addTags: ['新标签'], addCollectionIds: [collection] })).canUndo, true);
  await edit({ note: '定稿' });
  const [, second] = await records(entry);
  await remote(entry, otherDevice, 1, { rating: wrap('int', 5) }, { [appleDevice]: 2, [second.deviceID]: second.counter });
  assert.equal((await writer.mutate(entry, { action: 'undo' })).undone, true);
  assert.deepEqual([(await latest()).note, (await latest()).rating], ['初稿', 5]);
  assert.equal((await writer.mutate(entry, { action: 'undo' })).undone, true);
  assert.deepEqual([(await latest()).name, (await latest()).note, (await latest()).rating, (await latest()).tags, (await latest()).collectionIds],
    ['手机素材', '', 5, ['旧标签'], []]);
  assert.equal(writer.status(libraryID).canUndo, false);
  assert.equal(writer.status(libraryID).canRedo, true);
  await writer.close();
  writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  const redo = () => writer.mutate(entry, { action: 'redo', revision: writer.status(libraryID).historyRevision });
  assert.equal((await redo()).redone, true);
  assert.equal((await redo()).redone, true);
  assert.deepEqual([(await latest()).name, (await latest()).note, (await latest()).rating, (await latest()).tags, (await latest()).collectionIds],
    ['桌面素材', '定稿', 5, ['新标签', '旧标签'].sort(), [collection]]);
});

test('rejects undo after a distinct peer edit and revalidates confirmed redo of a trash action', async t => {
  const { entry, profile } = await setup(t);
  await remote(entry, appleDevice, 1, mobileBirth, {}, true);
  const writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  await writer.mutate(entry, { action: 'edit', ids: [assetID], note: 'Windows 修改' });
  const [first] = await records(entry);
  await remote(entry, otherDevice, 1, { note: wrap('string', '手机修改') }, { [appleDevice]: 1, [first.deviceID]: first.counter });
  const result = await writer.mutate(entry, { action: 'undo' });
  assert.equal(result.undone, false);
  assert.match(result.message, /资料已有新变化/);
  assert.equal(result.canUndo, false);
  assert.equal((await readLibrary(entry.root)).assets[0].note, '手机修改');
  assert.equal((await records(entry)).length, 1);
  await writer.mutate(entry, { action: 'trash', ids: [assetID] });
  assert.equal((await readLibrary(entry.root)).assets[0].trashed, true);
  await writer.mutate(entry, { action: 'undo' });
  assert.equal((await readLibrary(entry.root)).assets[0].trashed, false);
  assert.equal(writer.status(libraryID).redoRemoves, true);
  await assert.rejects(writer.mutate(entry, { action: 'redo', revision: 'stale' }), /重新确认/);
  assert.equal((await writer.mutate(entry, { action: 'redo', revision: writer.status(libraryID).historyRevision })).redone, true);
  assert.equal((await readLibrary(entry.root)).assets[0].trashed, true);
});

test('does not undo an earlier edit across another device’s same-value journal write', async t => {
  const { entry, profile } = await setup(t);
  await remote(entry, appleDevice, 1, mobileBirth, {}, true);
  const writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  const edit = note => writer.mutate(entry, { action: 'edit', ids: [assetID], note });
  await edit('确认的备注');
  const [first] = await records(entry);
  await remote(entry, otherDevice, 1, { note: wrap('string', '确认的备注') }, { [appleDevice]: 1, [first.deviceID]: first.counter });
  await edit('临时备注');
  assert.equal((await writer.mutate(entry, { action: 'undo' })).undone, true);
  // Branching to a new operation clears redo but must keep the provenance of
  // the restored peer value, even though the displayed text is identical.
  await writer.mutate(entry, { action: 'edit', ids: [assetID], favorite: true });
  assert.equal((await writer.mutate(entry, { action: 'undo' })).undone, true);
  assert.equal((await writer.mutate(entry, { action: 'undo' })).undone, false);
  assert.equal((await readLibrary(entry.root)).assets[0].note, '确认的备注');
});

test('locates the most recent confirmed local journal across restart without treating a reread as a write', async t => {
  const { entry, profile } = await setup(t);
  await remote(entry, appleDevice, 1, mobileBirth, {}, true);
  let writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  assert.equal(writer.status(libraryID).publishedAt, null);
  assert.equal((await writer.retry(entry)).publishedAt, null);
  await assert.rejects(writer.lastPublishedPath(entry), /暂无可定位的同步记录/);

  const command = { action: 'edit', ids: [assetID], note: '本机写入' };
  const { publishedAt } = await writer.mutate(entry, command);
  assert.ok(Number.isSafeInteger(publishedAt) && publishedAt > 0);
  const recordPath = record => path.join(entry.root, 'changes', record.deviceID, `${record.counter}-${record.id}.json`);
  const [first] = await records(entry);
  assert.equal(await writer.lastPublishedPath(entry), recordPath(first));
  assert.equal((await writer.mutate(entry, command)).publishedAt, publishedAt);
  assert.equal((await writer.retry(entry)).publishedAt, publishedAt);
  const secondWrite = await writer.mutate(entry, { ...command, note: '更新的本机写入' });
  assert.ok(secondWrite.publishedAt >= publishedAt);
  const [, latest] = await records(entry);
  const filename = recordPath(latest);
  assert.equal(await writer.lastPublishedPath(entry), filename);

  await writer.close();
  writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  assert.equal(writer.status(libraryID).publishedAt, secondWrite.publishedAt);
  assert.equal(await writer.lastPublishedPath(entry), filename);
  await fs.rename(filename, `${filename}.moved`);
  await assert.rejects(writer.lastPublishedPath(entry), /最新记录在此文件夹中暂不可用/);
  assert.equal(writer.status(libraryID).publishedAt, secondWrite.publishedAt);
});

test('previews tag changes and publishes exact format-6 tag deltas from the confirmed revision', async t => {
  const { entry, profile } = await setup(t);
  await remote(entry, appleDevice, 1, { ...mobileBirth, 'tag:Ｄｒａｆｔ': wrap('bool', true),
    'tag:Draft': wrap('bool', true), 'tag:Final': wrap('bool', true) }, {}, true);
  const writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  const command = { from: 'draft', to: 'final' };
  const plan = await writer.mutate(entry, { action: 'planTagChange', ...command });
  assert.equal(plan.count, 1);
  assert.equal(plan.mode, 'merge');
  assert.equal(plan.to, 'Final');
  assert.deepEqual(await records(entry), []);
  await remote(entry, appleDevice, 2, { note: wrap('string', '远端新备注') });
  await assert.rejects(writer.mutate(entry, { action: 'changeTag', ...command, revision: plan.revision }), /重新预览/);
  const fresh = await writer.mutate(entry, { action: 'planTagChange', ...command });
  await writer.mutate(entry, { action: 'changeTag', ...command, revision: fresh.revision });
  const [operation] = await records(entry);
  assert.deepEqual(operation.changes, { 'tag:Draft': wrap('bool', false), 'tag:Ｄｒａｆｔ': wrap('bool', false) });
  const [asset] = (await readLibrary(entry.root)).assets;
  assert.deepEqual(asset.tags, ['Final', '旧标签']);
  assert.equal(asset.note, '远端新备注');
});

async function records(entry) {
  const root = path.join(entry.root, 'changes');
  const devices = await fs.readdir(root);
  const results = [];
  for (const device of devices) {
    if (device === appleDevice || device === otherDevice) continue;
    for (const file of await fs.readdir(path.join(root, device))) {
      if (file.endsWith('.json')) results.push(JSON.parse(await fs.readFile(path.join(root, device, file), 'utf8')));
    }
  }
  return results.sort((a, b) => a.counter - b.counter);
}

function resolve(conflict, choiceId) {
  const { kind, entityId, field, signature } = conflict;
  return { action: 'resolveConflict', kind, entityId, field, signature, choiceId };
}

test('a batch writes independent conflict choices while leaving stale and duplicate rows untouched', async t => {
  const { entry, profile } = await setup(t);
  await remote(entry, appleDevice, 1, mobileBirth, {}, true);
  await remote(entry, appleDevice, 2, { note: wrap('string', '手机备注'), rating: wrap('int', 2),
    'tag:摄影': wrap('bool', true) });
  const alternative = await remote(entry, otherDevice, 1, { note: wrap('string', '另一条备注'), rating: wrap('int', 4),
    'tag:摄影': wrap('bool', false) }, { [appleDevice]: 1 });
  const { conflicts } = await listSyncConflicts(entry.root, entry.libraryId);
  const [note, rating, tag] = ['note', 'rating', 'tag:摄影'].map(field => conflicts.find(item => item.field === field));
  await remote(entry, appleDevice, 3, { note: wrap('string', '刚修改的手机备注') });
  const writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  const outcomes = await writer.resolveConflicts(entry, [resolve(note, alternative.id), resolve(rating, alternative.id),
    resolve(tag, tag.winnerId), resolve(rating, rating.winnerId)]);
  assert.deepEqual(outcomes.results.map(row => row.status), ['failed', 'resolved', 'resolved', 'failed']);
  assert.equal(outcomes.results[0].code, 'SYNC_CONFLICT_STALE');
  assert.equal(outcomes.pending, 0);
  const journal = await records(entry);
  assert.deepEqual(journal.map(operation => operation.changes), [{ rating: wrap('int', 4) }, { 'tag:摄影': wrap('bool', false) }]);
  assert.equal(journal[1].clock[journal[0].deviceID], 2);
  const remaining = await listSyncConflicts(entry.root, entry.libraryId);
  assert.deepEqual(remaining.conflicts.map(item => item.field), ['note']);
});

test('batch parent choices are revalidated after earlier collection moves', async t => {
  const { entry, profile } = await setup(t);
  await remote(entry, appleDevice, 1, remoteCollectionBirth('第一层'), {}, false, 'alpha');
  await remote(entry, appleDevice, 2, remoteCollectionBirth('第二层'), {}, false, 'beta');
  await remote(entry, appleDevice, 3, { parentID: nil }, {}, false, 'alpha');
  await remote(entry, appleDevice, 4, { parentID: nil }, {}, false, 'beta');
  const moveAlpha = await remote(entry, otherDevice, 1, { parentID: wrap('string', 'beta') }, { [appleDevice]: 2 }, false, 'alpha');
  const moveBeta = await remote(entry, otherDevice, 2, { parentID: wrap('string', 'alpha') }, { [appleDevice]: 2 }, false, 'beta');
  const { conflicts } = await listSyncConflicts(entry.root, entry.libraryId);
  const alpha = conflicts.find(item => item.entityId === 'alpha');
  const beta = conflicts.find(item => item.entityId === 'beta');
  assert.ok(alpha.candidates.find(item => item.choiceId === moveAlpha.id).selectable);
  assert.ok(beta.candidates.find(item => item.choiceId === moveBeta.id).selectable);
  const writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  const { results } = await writer.resolveConflicts(entry, [resolve(alpha, moveAlpha.id), resolve(beta, moveBeta.id)]);
  assert.deepEqual(results.map(row => row.status), ['resolved', 'failed']);
  assert.equal(results[1].code, 'SYNC_CONFLICT_CHOICE');
  assert.equal((await records(entry)).length, 1);
  const catalog = await readLibrary(entry.root);
  assert.equal(catalog.collections.find(row => row.id === 'alpha').parentId, 'beta');
  assert.equal(catalog.collections.find(row => row.id === 'beta').parentId, null);
});

test('batch returns separate published and durable pending results when a provider write is interrupted', async t => {
  const { entry, profile } = await setup(t);
  await remote(entry, appleDevice, 1, mobileBirth, {}, true);
  await remote(entry, appleDevice, 2, { note: wrap('string', '手机备注'), rating: wrap('int', 2) });
  const alternative = await remote(entry, otherDevice, 1, { note: wrap('string', '另一条备注'), rating: wrap('int', 4) }, { [appleDevice]: 1 });
  const { conflicts } = await listSyncConflicts(entry.root, entry.libraryId);
  const writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  const open = fs.open;
  let staged = 0;
  const fault = t.mock.method(fs, 'open', (filename, ...args) => {
    if (args[0] === 'wx' && String(filename).startsWith(entry.root + path.sep) &&
        path.basename(filename).startsWith('.materialshelf-publish-') && ++staged === 2) {
      return Promise.reject(Object.assign(new Error('synthetic provider interruption'), { code: 'EIO' }));
    }
    return open(filename, ...args);
  });
  const outcome = await writer.resolveConflicts(entry, conflicts.map(item => resolve(item, alternative.id)));
  fault.mock.restore();
  assert.deepEqual(outcome.results.map(row => row.status), ['resolved', 'pending']);
  assert.equal(outcome.pending, 1);
  assert.match(outcome.results[1].message, /暂时无法写入/);
  assert.equal((await records(entry)).length, 1);
  assert.equal((await writer.retry(entry)).pending, 0);
  assert.equal((await records(entry)).length, 2);
  assert.equal((await listSyncConflicts(entry.root, entry.libraryId)).total, 0);
});

test('reviews both peer values, adopts only an observed choice, and keeps the current value with a causal delta', async t => {
  const { entry, profile } = await setup(t);
  await remote(entry, appleDevice, 1, mobileBirth, {}, true);
  const first = await remote(entry, appleDevice, 2, { note: wrap('string', 'iPhone 写的备注'),
    'tag:选题': wrap('bool', true), favorite: wrap('bool', false) });
  const second = await remote(entry, otherDevice, 1, { note: wrap('string', 'iPad 写的备注'),
    'tag:选题': wrap('bool', false), favorite: wrap('bool', false) }, { [appleDevice]: 1 });
  const review = await listSyncConflicts(entry.root, entry.libraryId);
  assert.equal(review.total, 2);
  assert.equal(review.logIncomplete, false);
  assert.equal((await readLibrary(entry.root)).syncConflicts, 2);
  const note = review.conflicts.find(item => item.field === 'note');
  const tag = review.conflicts.find(item => item.field === 'tag:选题');
  assert.equal(note.entityName, '手机素材');
  assert.equal(note.winnerId, first.id);
  assert.deepEqual(note.candidates.map(item => [item.deviceId, item.counter, item.value]), [
    [appleDevice, 2, 'iPhone 写的备注'], [otherDevice, 1, 'iPad 写的备注'],
  ]);
  assert.equal(tag.winnerId, second.id);
  const writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  await assert.rejects(writer.mutate(entry, resolve(note, randomUUID())), { code: 'SYNC_CONFLICT_CHOICE' });
  assert.deepEqual(await records(entry), []);
  const result = await writer.mutate(entry, { ...resolve(note, second.id), value: '不能由界面提供' });
  assert.equal(result.pending, 0);
  assert.equal(result.conflicts, 1);
  const kept = await writer.mutate(entry, resolve(tag, tag.winnerId));
  assert.equal(kept.conflicts, 0);
  const [chosen, keptCurrent] = await records(entry);
  assert.deepEqual(chosen.changes, { note: wrap('string', 'iPad 写的备注') });
  assert.deepEqual(keptCurrent.changes, { 'tag:选题': wrap('bool', false) });
  assert.equal(chosen.clock[appleDevice], 2);
  assert.equal(chosen.clock[otherDevice], 1);
  assert.equal(keptCurrent.clock[chosen.deviceID], 2);
  const library = await readLibrary(entry.root);
  assert.equal(library.assets[0].note, 'iPad 写的备注');
  assert.equal(library.syncConflicts, 0);
  assert.equal((await listSyncConflicts(entry.root, entry.libraryId)).total, 0);
});

test('round-trips device labels without changing conflict identity or requiring labels on old operations', async t => {
  const { entry, profile } = await setup(t);
  await remote(entry, appleDevice, 1, mobileBirth, {}, true);
  const writer = new DirectorySyncWriter({ directory: profile,
    device: { platform: 'windows', model: '测试电脑型号', name: ' WIN-TEST\u202e ' } });
  await writer.initialize();
  t.after(() => writer.close());
  await writer.mutate(entry, { action: 'edit', ids: [assetID], note: 'Windows 修改' });
  const [desktop] = await records(entry);
  const phone = await remote(entry, appleDevice, 2, { note: wrap('string', '手机修改') });
  const legacy = await remote(entry, otherDevice, 1, { note: wrap('string', '旧客户端') }, { [appleDevice]: 1 });
  const conflict = async () => (await listSyncConflicts(entry.root, entry.libraryId)).conflicts[0];
  const before = await conflict();
  const annotate = (operation, device) => fs.writeFile(path.join(entry.root, 'changes', operation.deviceID,
    `${operation.counter}-${operation.id}.json`), JSON.stringify({ ...operation, device }));
  const laterPhone = await remote(entry, appleDevice, 3, { rating: wrap('int', 3) });
  await annotate(laterPhone, { platform: 'iphone', model: 'iPhone16,2' });
  await annotate(legacy, { platform: 'unsupported', name: 'should be ignored' });
  const after = await conflict();
  const candidates = new Map(after.candidates.map(candidate => [candidate.choiceId, candidate]));
  assert.deepEqual(desktop.device, { platform: 'windows', model: '测试电脑型号', name: 'WIN-TEST' });
  assert.deepEqual(candidates.get(desktop.id).device, desktop.device);
  assert.deepEqual(candidates.get(phone.id).device, { platform: 'iphone', model: 'iPhone16,2' });
  assert.equal(candidates.get(legacy.id).device, undefined);
  assert.equal(candidates.get(legacy.id).deviceId, otherDevice);
  assert.equal(after.signature, before.signature);
});

test('rejects conflict choices after a newer peer value while keeping pending and old-format libraries read-only', async t => {
  const { entry, profile } = await setup(t);
  await remote(entry, appleDevice, 1, mobileBirth, {}, true);
  await remote(entry, appleDevice, 2, { rating: wrap('int', 2) });
  const second = await remote(entry, otherDevice, 1, { rating: wrap('int', 3) }, { [appleDevice]: 1 });
  const { conflicts: [old] } = await listSyncConflicts(entry.root, entry.libraryId);
  await remote(entry, appleDevice, 3, { rating: wrap('int', 4) });
  const writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  await assert.rejects(writer.mutate(entry, resolve(old, second.id)), { code: 'SYNC_CONFLICT_STALE' });
  assert.deepEqual(await records(entry), []);
  const { conflicts: [fresh] } = await listSyncConflicts(entry.root, entry.libraryId);
  assert.notEqual(fresh.signature, old.signature);
  assert.equal(fresh.candidates[0].value, 4);
  const placeholder = path.join(entry.root, 'changes', appleDevice, '.next.json.icloud');
  await fs.writeFile(placeholder, '');
  const waiting = await listSyncConflicts(entry.root, entry.libraryId);
  assert.equal(waiting.logIncomplete, true);
  assert.equal(waiting.conflicts[0].resolvable, false);
  await assert.rejects(writer.mutate(entry, resolve(fresh, second.id)), { code: 'SYNC_LOG_PENDING' });
  await fs.unlink(placeholder);
  const manifestPath = path.join(entry.root, 'library.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, version: 5 }));
  const oldFormat = await listSyncConflicts(entry.root, entry.libraryId);
  assert.equal(oldFormat.format, 5);
  assert.equal(oldFormat.conflicts[0].resolvable, false);
  assert.equal(oldFormat.conflicts[0].candidates[1].value, 3);
  await assert.rejects(writer.mutate(entry, resolve(fresh, second.id)), { code: 'SYNC_UPGRADE_REQUIRED' });
  await assert.rejects(listSyncConflicts(entry.root, randomUUID()), { code: 'SYNC_LIBRARY_CHANGED' });
  assert.deepEqual(await records(entry), []);
});

test('resolves an observed trash dispute and publishes a safe top-level repair for a collection cycle', async t => {
  const { entry, profile } = await setup(t);
  await remote(entry, appleDevice, 1, remoteCollectionBirth('第一层', 'beta'), {}, false, 'alpha');
  await remote(entry, appleDevice, 2, remoteCollectionBirth('第二层', 'alpha'), {}, false, 'beta');
  await remote(entry, appleDevice, 3, mobileBirth, {}, true);
  await remote(entry, appleDevice, 4, { deletedAt: wrap('double', time) });
  const other = await remote(entry, otherDevice, 1, { deletedAt: nil }, { [appleDevice]: 3 });
  const review = await listSyncConflicts(entry.root, entry.libraryId);
  assert.equal(review.total, 2);
  assert.equal((await readLibrary(entry.root)).syncConflicts, 2);
  const cycle = review.conflicts.find(conflict => conflict.reason === 'collection-cycle');
  assert.equal(cycle.entityName, '第二层');
  assert.equal(cycle.displayedParent, '顶层集合');
  assert.deepEqual(cycle.candidates.map(item => item.sourceEntityName), ['第二层', '第一层']);
  assert.equal(cycle.moveToRoot, true);
  assert.ok(cycle.candidates.every(candidate => !candidate.selectable));
  const deletion = review.conflicts.find(conflict => conflict.field === 'deletedAt');
  assert.equal(deletion.resolvable, true);
  const writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  await assert.rejects(writer.mutate(entry, { ...resolve(cycle), moveToRoot: true, signature: 'stale' }), { code: 'SYNC_CONFLICT_STALE' });
  await assert.rejects(writer.mutate(entry, resolve(cycle, cycle.winnerId)), { code: 'SYNC_CONFLICT_STALE' });
  assert.deepEqual(await records(entry), []);
  assert.equal((await writer.mutate(entry, resolve(deletion, other.id))).conflicts, 1);
  assert.equal((await writer.mutate(entry, { ...resolve(cycle), moveToRoot: true })).conflicts, 0);
  const [restore, repair] = await records(entry);
  assert.deepEqual(restore.changes, { deletedAt: nil });
  assert.deepEqual(repair.changes, { parentID: nil });
  assert.equal(repair.entityID, 'beta');
  const library = await readLibrary(entry.root);
  assert.equal(library.assets[0].trashed, false);
  assert.equal(library.collections.find(item => item.id === 'beta').parentId, null);
  assert.equal(library.collections.find(item => item.id === 'alpha').parentId, 'beta');
  assert.equal((await listSyncConflicts(entry.root, entry.libraryId)).total, 0);
});

test('acknowledges permanent deletion locally without writing to the library and surfaces a later conflict', async t => {
  const { entry, profile } = await setup(t);
  await remote(entry, appleDevice, 1, mobileBirth, {}, true);
  await remote(entry, appleDevice, 2, { life: wrap('bool', false) });
  await remote(entry, otherDevice, 1, mobileBirth, { [appleDevice]: 1 }, true);
  let writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  const review = () => listSyncConflicts(entry.root, entry.libraryId, writer.acknowledgedConflicts(libraryID));
  const initial = (await review()).conflicts[0];
  assert.equal(initial.acknowledgeDeletion, true);
  assert.ok(initial.candidates.every(candidate => !candidate.selectable));
  const command = { ...resolve(initial), acknowledgeDeletion: true };
  await assert.rejects(writer.mutate(entry, { ...command, signature: 'stale' }), { code: 'SYNC_CONFLICT_STALE' });
  assert.equal((await writer.mutate(entry, command)).conflicts, 0);
  assert.equal((await writer.mutate(entry, command)).conflicts, 0);
  assert.equal((await review()).total, 0);
  assert.equal((await listSyncConflicts(entry.root, entry.libraryId)).total, 1);
  assert.deepEqual(await records(entry), []);
  await writer.close();
  writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  assert.equal((await review()).total, 0);
  await remote(entry, appleDevice, 3, { life: wrap('bool', false) });
  assert.equal((await review()).total, 1);
  await assert.rejects(writer.mutate(entry, command), { code: 'SYNC_CONFLICT_STALE' });
  assert.deepEqual(await records(entry), []);
});

test('adopts a membership only for a live collection and treats canonically equivalent strings as equal', async t => {
  const { entry, profile } = await setup(t);
  const field = 'member:project';
  await remote(entry, appleDevice, 1, remoteCollectionBirth('摄影项目'), {}, false, 'project');
  await remote(entry, appleDevice, 2, mobileBirth, {}, true);
  const included = await remote(entry, appleDevice, 3, { [field]: wrap('bool', true), note: wrap('string', 'Café') });
  const excluded = await remote(entry, otherDevice, 1, { [field]: wrap('bool', false), note: wrap('string', 'Cafe\u0301') }, { [appleDevice]: 2 });
  const review = await listSyncConflicts(entry.root, entry.libraryId);
  assert.equal(review.total, 1);
  const [membership] = review.conflicts;
  assert.equal(membership.fieldLabel, '摄影项目');
  assert.equal(membership.winnerId, excluded.id);
  const writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  await writer.mutate(entry, resolve(membership, included.id));
  assert.deepEqual((await readLibrary(entry.root)).assets[0].collectionIds, ['project']);
  // Two devices that have not seen the resolution produce a new register
  // frontier. The old candidate must stay blocked after the collection dies.
  const prior = await remote(entry, appleDevice, 4, { [field]: wrap('bool', true) });
  const alternate = await remote(entry, otherDevice, 2, { [field]: wrap('bool', false) }, { [appleDevice]: 2 });
  await writer.mutate(entry, { action: 'deleteCollection', id: 'project' });
  const updated = await listSyncConflicts(entry.root, entry.libraryId);
  const nowMissing = updated.conflicts.find(conflict => conflict.field === field);
  assert.equal(nowMissing.candidates.find(item => item.choiceId === prior.id).selectable, false);
  assert.equal(nowMissing.candidates.find(item => item.choiceId === alternate.id).selectable, true);
  await assert.rejects(writer.mutate(entry, resolve(nowMissing, prior.id)), { code: 'SYNC_CONFLICT_CHOICE' });
});

test('publishes valid causal metadata edits, nested collections, rename and recycle across restarts', async t => {
  const { entry, profile } = await setup(t);
  await remote(entry, appleDevice, 1, mobileBirth, {}, true);
  let writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(async () => { await writer.close(); });
  const parent = await writer.mutate(entry, { action: 'createCollection', name: '素材' });
  const child = await writer.mutate(entry, { action: 'createCollection', name: '灯光', parentId: parent.id });
  assert.equal(child.pending, 0);
  await writer.mutate(entry, { action: 'edit', ids: [assetID], tags: ['新标签'], favorite: true, rating: 5, note: '跨端同步',
    sourceURL: 'https://example.com/light', collectionIds: [child.id] });
  const read = await readLibrary(entry.root);
  assert.equal(read.collections.find(item => item.id === child.id).parentId, parent.id);
  assert.equal(read.assets[0].name, '手机素材');
  assert.deepEqual(read.assets[0].tags, ['新标签']);
  assert.equal(read.assets[0].note, '跨端同步');
  assert.deepEqual(read.assets[0].collectionIds, [child.id]);
  assert.equal(read.assets[0].favorite, true);
  assert.equal(read.assets[0].rating, 5);
  assert.deepEqual(await fs.readFile(read.originals.get(assetID)), original);
  const [before, , edit] = await records(entry);
  assert.equal(before.clock[appleDevice], 1);
  assert.equal(edit.deviceID, before.deviceID);
  assert.equal(edit.clock[edit.deviceID], 3);
  assert.deepEqual(edit.changes['tag:旧标签'], wrap('bool', false));
  assert.equal(edit.asset.blob.sha256, assetID);
  const entries = [{ id: assetID, name: '重命名.png' }];
  const plan = await writer.mutate(entry, { action: 'planRename', entries });
  assert.deepEqual(plan.entries, [{ id: assetID, oldName: '手机素材', name: '重命名' }]);
  await remote(entry, appleDevice, 2, { note: wrap('string', '手机也有更改') });
  await assert.rejects(writer.mutate(entry, { action: 'rename', entries, revision: plan.revision }), /核对最新名称/);
  const newPlan = await writer.mutate(entry, { action: 'planRename', entries });
  await writer.mutate(entry, { action: 'rename', entries, revision: newPlan.revision });
  await writer.mutate(entry, { action: 'trash', ids: [assetID] });
  assert.equal((await readLibrary(entry.root)).assets[0].trashed, true);
  await writer.close();
  writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  await writer.mutate(entry, { action: 'restore', ids: [assetID] });
  await writer.mutate(entry, { action: 'deleteCollection', id: parent.id });
  const final = await readLibrary(entry.root);
  assert.equal(final.assets[0].name, '重命名');
  assert.equal(final.assets[0].trashed, false);
  assert.deepEqual(final.assets[0].collectionIds, []);
  assert.deepEqual(final.collections, []);
  const all = await records(entry);
  assert.equal(new Set(all.map(operation => operation.deviceID)).size, 1);
  assert.deepEqual(all.map(operation => operation.counter), all.map((_, index) => index + 1));
  assert.equal(all.at(-1).clock[appleDevice], 2);
});

test('publishes reviewed AI fields as one causal operation and retains prior tags', async t => {
  const { entry, profile } = await setup(t);
  await remote(entry, appleDevice, 1, mobileBirth, {}, true);
  const writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  const command = { action: 'applySuggestion', id: assetID, title: '室内暖光.png', tags: ['旧标签', '木纹'], note: '暖光照亮桌面。',
    expected: { name: '手机素材', note: '', tags: ['旧标签'] } };
  await assert.rejects(writer.mutate(entry, { ...command, expected: { ...command.expected, note: '已失效' } }), /已变化/);
  assert.deepEqual(await records(entry), []);
  assert.equal((await writer.mutate(entry, command)).pending, 0);
  const operations = await records(entry);
  assert.equal(operations.length, 1);
  assert.deepEqual(operations[0].changes, { name: wrap('string', '室内暖光'), note: wrap('string', '暖光照亮桌面。'), 'tag:木纹': wrap('bool', true) });
  const read = (await readLibrary(entry.root)).assets[0];
  assert.deepEqual(new Set(read.tags), new Set(['旧标签', '木纹']));
  assert.equal(read.name, '室内暖光');
  assert.equal(read.note, '暖光照亮桌面。');
});

test('refuses old, mismatched or incomplete catalogs and surfaces concurrent fields', async t => {
  const old = await setup(t, 5);
  const writer = new DirectorySyncWriter({ directory: old.profile });
  await writer.initialize();
  t.after(() => writer.close());
  await assert.rejects(writer.mutate(old.entry, { action: 'createCollection', name: '未升级' }), /格式 6/);
  assert.deepEqual(await fs.readdir(path.join(old.entry.root, 'changes')), []);
  const { entry } = await setup(t);
  await assert.rejects(writer.mutate({ ...entry, libraryId: randomUUID() }, { action: 'createCollection', name: '身份错误' }), /另一份同步库/);
  const first = await remote(entry, appleDevice, 1, mobileBirth, {}, true);
  const placeholder = path.join(entry.root, 'changes', appleDevice, `.${first.counter}-${first.id}.json.icloud`);
  await fs.writeFile(placeholder, 'pending');
  await assert.rejects(writer.mutate(entry, { action: 'edit', ids: [assetID], note: '缺记录' }), /尚未到齐/);
  assert.deepEqual(await records(entry), []);
  await fs.rm(placeholder);
  await remote(entry, appleDevice, 2, { note: wrap('string', '手机 A') });
  await remote(entry, otherDevice, 1, { note: wrap('string', '手机 B') }, { [appleDevice]: 1 });
  assert.equal((await readLibrary(entry.root)).syncConflicts, 1);
  const plan = await writer.mutate(entry, { action: 'planRename', entries: [{ id: assetID, name: '改名' }] });
  assert.equal(plan.conflicts, 1);
  await writer.mutate(entry, { action: 'edit', ids: [assetID], note: '两端核对之后' });
  const latest = await readLibrary(entry.root);
  assert.equal(latest.assets[0].note, '两端核对之后');
  assert.equal(latest.syncConflicts, 0);
});

test('persists imported image dimensions and the full source link in a format-6 sync catalog', async t => {
  const { entry, profile } = await setup(t);
  const writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  t.after(() => writer.close());
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+WQAAAAASUVORK5CYII=', 'base64');
  const sourceURL = 'https://x.com/example/status/123456/photo/2?view=full';
  const result = await writer.upload(entry, { jobId: randomUUID(), filename: '网页采集.png', kind: 'image', bytes, sourceURL });
  const library = await readLibrary(entry.root);
  const asset = library.assets.find(asset => asset.id === result.id);
  assert.deepEqual([asset.width, asset.height, asset.sourceURL], [1, 1, sourceURL]);
  assert.deepEqual(await fs.readFile(library.originals.get(asset.id)), bytes);
});

test('replays a durable upload after interrupted blob publication without a duplicate birth or original', async t => {
  const { entry, profile } = await setup(t);
  const jobId = randomUUID();
  const calls = [];
  let writer = new DirectorySyncWriter({ directory: profile, publishOriginal: async input => {
    calls.push(input.birthId);
    await publishSyncOriginal(input);
    throw Object.assign(new Error('provider temporarily unavailable'), { code: 'EBUSY' });
  } });
  await writer.initialize();
  t.after(() => writer.close());
  const failed = await writer.upload(entry, { jobId, filename: '样片.png', bytes: original, tags: ['测试'], collectionPaths: [['项目', '子层']] });
  assert.equal(failed.pending, 1);
  assert.match(failed.error, /暂时无法写入/);
  assert.deepEqual(calls, [jobId]);
  const before = await readLibrary(entry.root);
  assert.equal(before.assets.length, 0);
  assert.equal(before.collections.length, 2);
  await writer.close();
  writer = new DirectorySyncWriter({ directory: profile });
  await writer.initialize();
  assert.equal(writer.status(libraryID).pending, 1);
  const retry = await writer.retry(entry);
  assert.equal(retry.pending, 0);
  assert.equal(retry.error, null);
  const after = await writer.upload(entry, { jobId, open() { throw new Error('successful old task must not access source'); } });
  assert.equal(after.id, assetID);
  const catalog = await readLibrary(entry.root);
  assert.equal(catalog.assets.length, 1);
  assert.equal(catalog.assets[0].name, '样片');
  assert.equal(catalog.assets[0].available, true);
  assert.deepEqual(await fs.readFile(catalog.originals.get(assetID)), original);
  assert.deepEqual(await fs.readdir(path.join(entry.root, 'blobs', '.incoming')), [`${assetID}.${jobId}.png`]);
  assert.equal((await records(entry)).filter(operation => operation.entityKind === 'asset').length, 1);
  assert.deepEqual(await fs.readdir(path.join(profile, 'staging')), []);
});
