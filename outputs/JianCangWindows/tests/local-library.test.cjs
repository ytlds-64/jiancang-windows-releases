'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { LOCAL_MANIFEST, createLocalLibrary, readLocalLibrary, openLocalOriginal, importLocalAsset, mutateLocalLibrary,
  expireLocalTrash, replaceLocalPicture, validateEditedImage } = require('../local-library.cjs');

async function library(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-local-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, '见藏本地库');
  const created = await createLocalLibrary(root, '摄影项目');
  const expectedLibraryId = created.libraryId;
  const ingest = (input) => importLocalAsset(root, { expectedLibraryId, ...input });
  const mutate = (command) => mutateLocalLibrary(root, { expectedLibraryId, ...command });
  const read = () => readLocalLibrary(root, expectedLibraryId);
  return { directory, root, expectedLibraryId, ingest, mutate, read };
}

const originalPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const editedPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==', 'base64');

test('merges selected duplicate metadata with one undo and rejects a stale preview or changed original', async t => {
  const { ingest, mutate, read } = await library(t);
  const first = (await mutate({ action: 'createCollection', name: '原件集合' })).id;
  const second = (await mutate({ action: 'createCollection', name: '副本集合' })).id;
  const keeper = (await ingest({ jobId: 'merge-keeper', filename: '保留.png', bytes: originalPNG,
    tags: ['Photo', '保留'], collectionIds: [first], note: '留下的备注' })).id;
  const copy = (await ingest({ jobId: 'merge-copy', filename: '副本.png', bytes: originalPNG,
    tags: ['photo', '副本'], collectionIds: [second], note: '副本备注' })).id;
  const original = await read();
  const command = { action: 'mergeDuplicates', keeperId: keeper, ids: [copy], expectedRevision: original.revision,
    expectedMedia: new Map(original.assets.map(asset => [asset.id, asset.mediaRevision])) };
  await mutate({ action: 'edit', ids: [copy], addTags: ['稍后更新'] });
  await assert.rejects(mutate(command), /重新预览合并/);
  assert.equal((await read()).assets.find(asset => asset.id === copy).trashed, false);
  const before = await read();
  assert.equal((await mutate({ ...command, expectedRevision: before.revision })).count, 1);
  const after = await read();
  const retained = after.assets.find(asset => asset.id === keeper);
  assert.deepEqual(retained.tags, ['Photo', '保留', '副本', '稍后更新']);
  assert.deepEqual(retained.collectionIds, [first, second]);
  assert.equal(retained.note, '留下的备注');
  assert.equal(after.assets.find(asset => asset.id === copy).trashed, true);
  assert.equal((await mutate({ action: 'undo' })).undone, true);
  const undone = await read();
  assert.deepEqual(undone.assets, before.assets);
  await fs.writeFile(undone.originals.get(copy), editedPNG);
  await assert.rejects(mutate({ ...command, expectedRevision: undone.revision }), /原件已变化/);
  const replaced = await read();
  assert.equal(replaced.assets.find(asset => asset.id === copy).trashed, false);
  assert.deepEqual(replaced.assets.find(asset => asset.id === keeper).tags, ['Photo', '保留']);
});

test('redo survives reopening, follows original order, and preserves nested collections and asset memberships', async t => {
  const { directory, root, expectedLibraryId, ingest, mutate, read } = await library(t);
  const parent = await mutate({ action: 'createCollection', name: '原集合' });
  const child = await mutate({ action: 'createCollection', name: '子集合', parentId: parent.id });
  const other = await mutate({ action: 'createCollection', name: '新集合' });
  const { id } = await ingest({ jobId: 'redo-metadata', filename: '旧名称.png', bytes: originalPNG, collectionIds: [child.id, other.id] });
  await mutate({ action: 'rename', entries: [{ id, name: '新名称' }] });
  await mutate({ action: 'editCollection', id: child.id, parentId: other.id, color: '123456' });
  await mutate({ action: 'deleteCollection', id: other.id });
  await mutate({ action: 'trash', ids: [id] });
  await mutate({ action: 'restore', ids: [id] });
  for (let index = 0; index < 5; index++) assert.equal((await mutate({ action: 'undo' })).undone, true);
  const movedRoot = path.join(directory, 'relocated-library');
  await fs.rename(root, movedRoot);
  let result = await readLocalLibrary(movedRoot, expectedLibraryId);
  const redo = command => mutateLocalLibrary(movedRoot, { action: 'redo', expectedLibraryId, ...command });
  assert.equal(result.canRedo, true);
  assert.equal(result.redoRemoves, false);
  assert.equal(result.assets[0].name, '旧名称');
  assert.equal(result.collections.find(item => item.id === child.id).parentId, parent.id);
  await assert.rejects(redo({ revision: '0' }), /重新选择要重做/);
  assert.equal((await redo({ revision: result.revision })).redone, true);
  assert.equal((await redo()).redone, true);
  result = await readLocalLibrary(movedRoot, expectedLibraryId);
  assert.equal(result.assets[0].name, '新名称');
  assert.equal(result.collections.find(item => item.id === child.id).parentId, other.id);
  assert.equal(result.collections.find(item => item.id === child.id).color, '123456');
  assert.equal(result.redoRemoves, true);
  assert.equal((await redo()).redone, true);
  result = await readLocalLibrary(movedRoot, expectedLibraryId);
  assert.deepEqual(result.collections.map(item => item.id), [parent.id]);
  assert.deepEqual(result.assets[0].collectionIds, []);
  assert.equal(result.redoRemoves, true);
  assert.equal((await redo()).redone, true);
  result = await readLocalLibrary(movedRoot, expectedLibraryId);
  assert.equal(result.assets[0].trashed, true);
  assert.equal(result.redoRemoves, false);
  assert.equal((await redo()).redone, true);
  result = await readLocalLibrary(movedRoot, expectedLibraryId);
  assert.equal(result.assets[0].trashed, false);
  assert.equal(result.canRedo, false);
  assert.deepEqual(await fs.readFile(result.originals.get(id)), originalPNG);
  await mutateLocalLibrary(movedRoot, { action: 'undo', expectedLibraryId });
  assert.equal((await readLocalLibrary(movedRoot, expectedLibraryId)).assets[0].trashed, true);
});

test('reapplies a grouped import with the exact originals and collections, and never revives purged items', async t => {
  const { ingest, mutate, read } = await library(t);
  const group = { undoGroup: 'redo-import-batch', collectionPaths: [['组', '子组']] };
  const first = await ingest({ ...group, jobId: 'redo-group-1', filename: 'first.txt', bytes: Buffer.from('first') });
  const second = await ingest({ ...group, jobId: 'redo-group-2', filename: 'second.txt', bytes: Buffer.from('second') });
  const before = await read();
  await mutate({ action: 'undo' });
  const undone = await read();
  assert.equal(undone.canRedo, true);
  assert.equal(undone.redoRemoves, false);
  assert.deepEqual(undone.collections, []);
  assert.ok(undone.assets.every(asset => asset.trashed && !asset.collectionIds.length));
  await mutate({ action: 'redo' });
  const redone = await read();
  assert.deepEqual(redone.assets, before.assets);
  assert.deepEqual(redone.collections, before.collections);
  assert.deepEqual(redone.originals, before.originals);
  await mutate({ action: 'undo' });
  await mutate({ action: 'purgeTrash', ids: [first.id], revision: (await read()).revision });
  assert.equal((await mutate({ action: 'redo' })).redone, false);
  assert.deepEqual((await read()).assets.map(asset => [asset.id, asset.trashed]), [[second.id, true]]);
  await assert.rejects(fs.stat(before.originals.get(first.id)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(before.originals.get(second.id), 'utf8'), 'second');
});

test('keeps an undone picture version for redo, validates availability, and releases abandoned versions after a new edit', async t => {
  const { root, expectedLibraryId, ingest, mutate, read } = await library(t);
  const input = { jobId: 'redo-picture', filename: '原件.png', bytes: originalPNG };
  const { id } = await ingest(input);
  const before = await read();
  const oldPath = before.originals.get(id);
  await replaceLocalPicture(root, { id, expectedLibraryId, revision: before.assets[0].mediaRevision,
    format: 'png', bytes: editedPNG, width: 1, height: 1 });
  const newPath = (await read()).originals.get(id);
  await mutate({ action: 'undo' });
  const undone = await read();
  assert.equal(undone.originals.get(id), oldPath);
  assert.deepEqual(await fs.readFile(newPath), editedPNG);
  assert.equal((await mutate({ action: 'edit', ids: [id], tags: [] })).count, 0);
  await mutate({ action: 'planRename', entries: [{ id, name: '只预览' }] });
  await ingest(input);
  assert.equal((await read()).revision, undone.revision);
  assert.equal((await read()).canRedo, true);
  await fs.rename(newPath, `${newPath}.missing`);
  await assert.rejects(mutate({ action: 'redo' }), /重做所需的原件/);
  assert.equal((await read()).revision, undone.revision);
  await fs.rename(`${newPath}.missing`, newPath);
  await mutate({ action: 'redo' });
  assert.equal((await read()).originals.get(id), newPath);
  assert.deepEqual(await fs.readFile(oldPath), originalPNG);
  await mutate({ action: 'undo' });
  await mutate({ action: 'edit', ids: [id], tags: ['另一次编辑'] });
  assert.equal((await read()).canRedo, false);
  assert.equal((await mutate({ action: 'redo' })).redone, false);
  await assert.rejects(fs.stat(newPath), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(oldPath), originalPNG);
});

test('does not replay a redo stack left stale by an older app, and retires its abandoned files', async t => {
  const { root, expectedLibraryId, ingest, mutate, read } = await library(t);
  const { id } = await ingest({ jobId: 'redo-older-version', filename: '旧库.png', bytes: originalPNG });
  const before = await read();
  await replaceLocalPicture(root, { id, expectedLibraryId, revision: before.assets[0].mediaRevision,
    format: 'png', bytes: editedPNG, width: 1, height: 1 });
  const undoneVersion = (await read()).originals.get(id);
  await mutate({ action: 'undo' });
  const file = path.join(root, LOCAL_MANIFEST);
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.revision++;
  await fs.writeFile(file, JSON.stringify(manifest));
  assert.equal((await read()).canRedo, false);
  assert.equal((await mutate({ action: 'redo' })).redone, false);
  await mutate({ action: 'edit', ids: [id], rating: 4 });
  await assert.rejects(fs.stat(undoneVersion), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile((await read()).originals.get(id)), originalPNG);
});

test('removes only the requested collection membership from a batch and retains originals and other metadata', async t => {
  const { ingest, mutate, read } = await library(t);
  const current = await mutate({ action: 'createCollection', name: '当前集合' });
  const other = await mutate({ action: 'createCollection', name: '其他集合' });
  const first = await ingest({ jobId: 'organize-first', filename: 'first.png', bytes: originalPNG });
  const second = await ingest({ jobId: 'organize-second', filename: 'second.png', bytes: editedPNG });
  const ids = [first.id, second.id];
  await mutate({ action: 'edit', ids, collectionIds: [current.id], favorite: true, rating: 4, tags: ['待归档'] });
  await mutate({ action: 'edit', ids: [first.id], addCollectionIds: [other.id] });
  const remove = { action: 'edit', ids, removeCollectionIds: [current.id] };
  assert.equal((await mutate(remove)).count, 2);
  assert.equal((await mutate(remove)).count, 0);
  const result = await read();
  for (const [id, kept, bytes] of [[first.id, [other.id], originalPNG], [second.id, [], editedPNG]]) {
    const item = result.assets.find(asset => asset.id === id);
    assert.deepEqual([item.collectionIds, item.favorite, item.rating, item.tags, item.trashed], [kept, true, 4, ['待归档'], false]);
    assert.deepEqual(await fs.readFile(result.originals.get(id)), bytes);
  }
  await mutate({ action: 'undo' });
  const restored = await read();
  assert.deepEqual(restored.assets.find(item => item.id === first.id).collectionIds, [current.id, other.id]);
  assert.deepEqual(restored.assets.find(item => item.id === second.id).collectionIds, [current.id]);
});

test('permanently deletes a recycled image and its picture-edit history while retaining other undo entries', async t => {
  const { root, expectedLibraryId, ingest, mutate, read } = await library(t);
  const first = await ingest({ jobId: 'first-recycled', filename: 'first.png', bytes: originalPNG });
  const keep = await ingest({ jobId: 'keep-original', filename: 'keep.png', bytes: originalPNG });
  const before = await read();
  const firstOriginal = before.originals.get(first.id);
  const keepOriginal = before.originals.get(keep.id);
  await replaceLocalPicture(root, { id: first.id, expectedLibraryId, revision: before.assets.find(asset => asset.id === first.id).mediaRevision,
    format: 'png', bytes: editedPNG, width: 1, height: 1 });
  await mutate({ action: 'edit', ids: [keep.id], tags: ['保留编辑'] });
  await mutate({ action: 'trash', ids: [first.id, keep.id] });
  const recycled = await read();
  const latest = recycled.originals.get(first.id);
  assert.notEqual(latest, firstOriginal);

  await assert.rejects(mutate({ action: 'purgeTrash', ids: [first.id], revision: before.revision }), /回收站已更新/);
  assert.deepEqual(await fs.readFile(firstOriginal), originalPNG);
  assert.deepEqual(await fs.readFile(latest), editedPNG);

  const result = await mutate({ action: 'purgeTrash', ids: [first.id], revision: recycled.revision });
  assert.equal(result.count, 1);
  assert.equal(result.pendingPurge, 0);
  for (const deleted of [firstOriginal, latest]) await assert.rejects(fs.stat(deleted), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(keepOriginal), originalPNG);
  await mutate({ action: 'undo' });
  await mutate({ action: 'undo' });
  assert.deepEqual((await read()).assets.map(asset => [asset.id, asset.trashed, asset.tags]), [[keep.id, false, []]]);
  const manifest = JSON.parse(await fs.readFile(path.join(root, LOCAL_MANIFEST), 'utf8'));
  assert.ok(!manifest.undo.some(change => change.assets.some(([id]) => id === first.id) || change.imported.includes(first.id)));
});

test('empties only recycled items, refuses active or replaced files, and safely retries interrupted cleanup', async t => {
  const { directory, root, ingest, mutate, read } = await library(t);
  const one = await ingest({ jobId: 'recycle-one', filename: 'one.png', bytes: originalPNG });
  const two = await ingest({ jobId: 'recycle-two', filename: 'two.png', bytes: originalPNG });
  const keep = await ingest({ jobId: 'recycle-keep', filename: 'keep.png', bytes: originalPNG });
  await mutate({ action: 'trash', ids: [one.id, two.id] });
  const recycled = await read();
  const oneFile = recycled.originals.get(one.id);
  const twoFile = recycled.originals.get(two.id);
  const keepFile = recycled.originals.get(keep.id);
  await assert.rejects(mutate({ action: 'purgeTrash', ids: [one.id, keep.id], revision: recycled.revision }), /仍在回收站/);
  await assert.rejects(mutate({ action: 'purgeTrash', ids: [one.id], revision: recycled.revision,
    mediaRevisions: new Map([[one.id, 'stale-file']]) }), /原件在确认前发生变化/);
  assert.deepEqual(await fs.readFile(oneFile), originalPNG);

  const linkTarget = path.join(directory, 'outside.png');
  await fs.writeFile(linkTarget, editedPNG);
  await fs.unlink(twoFile);
  await fs.symlink(linkTarget, twoFile);
  await assert.rejects(mutate({ action: 'purgeTrash', all: true, revision: recycled.revision }), /原件在确认前发生变化/);
  assert.deepEqual(await fs.readFile(linkTarget), editedPNG);
  await fs.unlink(twoFile);

  const unlink = fs.unlink;
  const locked = t.mock.method(fs, 'unlink', async file => {
    if (file === oneFile) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return unlink(file);
  });
  const result = await mutate({ action: 'purgeTrash', all: true, revision: recycled.revision });
  locked.mock.restore();
  assert.equal(result.count, 2);
  assert.equal((await read()).pendingPurge, 1);
  assert.deepEqual((await read()).assets.map(asset => asset.id), [keep.id]);
  assert.deepEqual(await fs.readFile(oneFile), originalPNG);

  await fs.rename(oneFile, path.join(directory, 'moved-original.png'));
  await fs.symlink(linkTarget, oneFile);
  assert.equal((await mutate({ action: 'retryPurge' })).pendingPurge, 1);
  assert.deepEqual(await fs.readFile(linkTarget), editedPNG);
  await fs.unlink(oneFile);
  assert.equal((await mutate({ action: 'retryPurge' })).pendingPurge, 0);
  assert.equal((await read()).pendingPurge, 0);
  assert.deepEqual(await fs.readFile(keepFile), originalPNG);
});

test('expires only items older than 30 days and dates legacy trash conservatively', async t => {
  const { root, expectedLibraryId, ingest, mutate, read } = await library(t);
  const [old, boundary, legacy, restored] = await Promise.all(
    ['old', 'boundary', 'legacy', 'restored'].map(async jobId =>
      (await ingest({ jobId, filename: jobId + '.png', bytes: originalPNG })).id));
  await mutate({ action: 'trash', ids: [old, boundary, legacy, restored] });
  const trashed = await read();
  assert(trashed.assets.every(asset => Number.isFinite(Date.parse(asset.trashedAt))));
  await mutate({ action: 'restore', ids: [restored] });
  const filename = path.join(root, LOCAL_MANIFEST);
  const data = JSON.parse(await fs.readFile(filename, 'utf8'));
  const now = Date.now();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  data.assets[old].trashedAt = new Date(cutoff - 1).toISOString();
  data.assets[boundary].trashedAt = new Date(cutoff).toISOString();
  delete data.assets[legacy].trashedAt;
  // An active record is never cleaned solely because it has an old timestamp.
  data.assets[restored].trashedAt = data.assets[old].trashedAt;
  await fs.writeFile(filename, JSON.stringify(data));
  const rootStat = await fs.lstat(root, { bigint: true });
  const expectedIdentity = `${rootStat.dev}:${rootStat.ino}`;
  const expire = time => expireLocalTrash(root, { expectedLibraryId, expectedIdentity, now: time });
  assert.equal(await expire(now), true);
  const remaining = (await read()).assets;
  assert.deepEqual(new Set(remaining.map(asset => asset.id)), new Set([boundary, legacy, restored]));
  assert.equal(remaining.find(asset => asset.id === legacy).trashedAt, new Date(now).toISOString());
  await assert.rejects(fs.stat(trashed.originals.get(old)), { code: 'ENOENT' });
  assert.equal(await expire(now), false);
  assert.equal(await expire(now + 1), true);
  await assert.rejects(fs.stat(trashed.originals.get(boundary)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(trashed.originals.get(restored)), originalPNG);
});

test('starts a new trash retention period after restoring and putting an item back', async t => {
  const { root, ingest, mutate, read } = await library(t);
  const { id } = await ingest({ jobId: 'trash-again', filename: 'original.png', bytes: originalPNG });
  await mutate({ action: 'trash', ids: [id] });
  await mutate({ action: 'restore', ids: [id] });
  assert.equal((await read()).assets[0].trashedAt, undefined);
  const filename = path.join(root, LOCAL_MANIFEST);
  const data = JSON.parse(await fs.readFile(filename, 'utf8'));
  const oldDate = '2020-01-01T00:00:00.000Z';
  data.undo.at(-1).assets[0][1].trashedAt = oldDate;
  await fs.writeFile(filename, JSON.stringify(data));
  await mutate({ action: 'undo' });
  assert(Date.parse((await read()).assets[0].trashedAt) > Date.parse(oldDate));
  await mutate({ action: 'redo' });
  await mutate({ action: 'trash', ids: [id] });
  assert(Date.parse((await read()).assets[0].trashedAt) > Date.parse(oldDate));
});

test('rejects wrong output formats, incomplete PNGs, and replacement of animated sources', async t => {
  const { root, expectedLibraryId, ingest, read } = await library(t);
  const image = { bytes: editedPNG, format: 'png', width: 1, height: 1 };
  assert.throws(() => validateEditedImage({ ...image, width: 2 }), /格式或尺寸/);
  assert.throws(() => validateEditedImage({ ...image, format: 'webp' }), /格式或尺寸/);
  assert.throws(() => validateEditedImage({ ...image, bytes: editedPNG.subarray(0, -12) }), /格式或尺寸/);
  const animationChunk = Buffer.from('000000086163544c0000000200000000f38d9370', 'hex');
  const animated = Buffer.concat([originalPNG.subarray(0, 33), animationChunk, originalPNG.subarray(33)]);
  const { id } = await ingest({ jobId: 'animated-source', filename: 'animated.png', bytes: animated });
  const before = await read();
  await assert.rejects(replaceLocalPicture(root, { ...image, id, expectedLibraryId, revision: before.assets[0].mediaRevision }), /静态副本/);
  assert.equal((await read()).revision, before.revision);
  assert.deepEqual(await fs.readFile(before.originals.get(id)), animated);
});

test('retains the previous original while an image edit can be undone and releases it when later imports expire that history', async t => {
  const { root, expectedLibraryId, ingest, read } = await library(t);
  const { id } = await ingest({ jobId: 'first-photo', filename: 'first.png', bytes: originalPNG });
  const before = await read();
  const previous = before.originals.get(id);
  await replaceLocalPicture(root, { id, expectedLibraryId, revision: before.assets[0].mediaRevision,
    format: 'png', bytes: editedPNG, width: 1, height: 1 });
  for (let index = 0; index < 19; index++) {
    await ingest({ jobId: `later-${index}`, filename: 'page.txt', bytes: Buffer.from(String(index)) });
  }
  assert.deepEqual(await fs.readFile(previous), originalPNG);
  await ingest({ jobId: 'expiry', filename: 'expiry.txt', bytes: Buffer.from('20') });
  await assert.rejects(fs.stat(previous), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile((await read()).originals.get(id)), editedPNG);
});

test('previews and atomically merges tag aliases including recycled items, then undoes the merge', async t => {
  const { root, ingest, mutate, read } = await library(t);
  const first = await ingest({ jobId: 'merge-first', filename: 'one.txt', bytes: Buffer.from('one'), tags: ['Ｄｒａｆｔ', 'draft', 'keep'] });
  const second = await ingest({ jobId: 'merge-second', filename: 'two.txt', bytes: Buffer.from('two'), tags: ['Draft', 'Final', 'other'] });
  await ingest({ jobId: 'merge-destination', filename: 'three.txt', bytes: Buffer.from('three'), tags: ['Final', 'untouched'] });
  await mutate({ action: 'trash', ids: [second.id] });
  const before = await read();
  const command = { from: 'Draft', to: 'final' };
  const plan = await mutate({ action: 'planTagChange', ...command });
  assert.deepEqual(plan, { count: 2, trashedCount: 1, mode: 'merge', from: 'Draft', to: 'Final', revision: before.revision });
  assert.deepEqual((await read()).assets, before.assets);
  await assert.rejects(mutate({ action: 'changeTag', ...command }), /重新预览/);
  const applied = await mutate({ action: 'changeTag', ...command, revision: plan.revision });
  assert.equal(+applied.revision, +before.revision + 1);
  const after = await read();
  assert.deepEqual(after.assets.find(item => item.id === first.id).tags, ['Final', 'keep']);
  assert.deepEqual(after.assets.find(item => item.id === second.id).tags, ['Final', 'other']);
  assert.equal(after.assets.find(item => item.id === second.id).trashed, true);
  await assert.rejects(mutate({ action: 'changeTag', ...command, revision: plan.revision }), /重新预览/);
  const original = await openLocalOriginal(root, after.assets.find(item => item.id === first.id));
  try { assert.equal(await original.readFile('utf8'), 'one'); }
  finally { await original.close(); }
  await mutate({ action: 'undo' });
  assert.deepEqual((await read()).assets, before.assets);
  const removal = await mutate({ action: 'planTagChange', from: 'Draft', to: null });
  assert.equal(removal.mode, 'delete');
  await mutate({ action: 'changeTag', from: 'Draft', to: null, revision: removal.revision });
  assert.deepEqual((await read()).assets.find(item => item.id === second.id).tags, ['Final', 'other']);
});

test('creates only a fresh local library and refuses a replaced library identity', async t => {
  const { directory, root, expectedLibraryId, read } = await library(t);
  const initial = await read();
  assert.equal(initial.kind, 'local');
  assert.equal(initial.directoryName, '摄影项目');
  assert.equal(initial.canUndo, false);
  assert.deepEqual(initial.assets, []);

  const unrelated = path.join(directory, 'not-a-library');
  await fs.mkdir(unrelated);
  await fs.writeFile(path.join(unrelated, 'unrelated.txt'), 'keep');
  await assert.rejects(createLocalLibrary(unrelated, '旧文件夹'), { code: 'EEXIST' });
  assert.deepEqual(await fs.readdir(unrelated), ['unrelated.txt']);

  const secondRoot = path.join(directory, 'second-library');
  const second = await createLocalLibrary(secondRoot, '另一个库');
  assert.notEqual(second.libraryId, expectedLibraryId);
  await assert.rejects(importLocalAsset(secondRoot, { expectedLibraryId, jobId: 'wrong', filename: 'sample.txt', bytes: Buffer.from('content') }), /位置已变化/);
  await assert.rejects(mutateLocalLibrary(secondRoot, { expectedLibraryId, action: 'createCollection', name: '错误路径' }), /位置已变化/);
  assert.deepEqual((await readLocalLibrary(secondRoot)).collections, []);
});

test('streams unchanged originals with progress, rejects a source changed during copy and retries without duplicates', async t => {
  const { directory, root, ingest, read } = await library(t);
  const source = path.join(directory, '源视频.MP4');
  const bytes = Buffer.alloc(3 * 1024 ** 2, 0xa5);
  await fs.writeFile(source, bytes);
  const progress = [];
  let changing;
  await assert.rejects(ingest({
    jobId: 'file-task', filename: source, open: () => fs.open(source, 'r'), onProgress(ratio) {
      if (!changing) changing = fs.appendFile(source, 'changed');
      progress.push(ratio);
    },
  }), /源文件发生变化/);
  await changing;
  assert.deepEqual((await read()).assets, []);
  assert.deepEqual(await fs.readdir(path.join(root, 'originals')), []);

  await fs.writeFile(source, bytes);
  const args = { jobId: 'file-task', filename: source, open: () => fs.open(source, 'r'), onProgress: ratio => progress.push(ratio) };
  const [imported, retry] = await Promise.all([ingest(args), ingest(args)]);
  assert.equal(retry.id, imported.id);
  assert.equal(retry.existing, true);
  assert.equal(retry.revision, imported.revision);
  const [asset] = (await read()).assets;
  assert.equal(asset.extension, 'mp4');
  assert.equal(asset.name, '源视频');
  assert.equal(asset.kind, 'video');
  assert.equal(asset.available, true);
  assert.equal(asset.byteCount, bytes.length);
  const original = await openLocalOriginal(root, asset);
  try { assert.deepEqual(await original.readFile(), bytes); }
  finally { await original.close(); }
  assert.deepEqual(await fs.readFile(source), bytes);
  assert.ok(progress.some(ratio => ratio > 0 && ratio < 1));
  assert.equal(progress.at(-1), 1);
});

test('keeps pasted image geometry, exact bytes and URL shortcuts', async t => {
  const { root, ingest, read } = await library(t);
  const png = Buffer.alloc(33);
  png.writeBigUInt64BE(0x89504e470d0a1a0an);
  png.write('IHDR', 12);
  png.writeUInt32BE(90, 16);
  png.writeUInt32BE(120, 20);
  const picture = await ingest({ jobId: 'paste-image', filename: '粘贴.png', bytes: png });
  const link = await ingest({ jobId: 'paste-url', sourceURL: 'https://example.com/%E8%A7%81%E8%97%8F' });
  await assert.rejects(ingest({ jobId: 'refuse-url', sourceURL: 'file:///missing.jpg' }), /HTTPS/);
  const snapshot = await read();
  assert.equal(snapshot.assets.length, 2);
  assert.deepEqual(await fs.readFile(snapshot.originals.get(picture.id)), png);
  const assets = new Map(snapshot.assets.map(asset => [asset.id, asset]));
  assert.deepEqual([assets.get(picture.id).width, assets.get(picture.id).height], [90, 120]);
  assert.equal(assets.get(link.id).kind, 'link');
  assert.equal(assets.get(link.id).name, 'example.com');
  assert.match(await fs.readFile(snapshot.originals.get(link.id), 'utf8'), /^\[InternetShortcut\]\r\nURL=https:\/\/example\.com\//);
  const substitute = path.join(path.dirname(root), 'substitute.png');
  await fs.writeFile(substitute, png);
  const original = snapshot.originals.get(picture.id);
  await fs.rm(original);
  await fs.symlink(substitute, original, 'file');
  await assert.rejects(openLocalOriginal(root, assets.get(picture.id)), /路径已变化/);
  assert.equal((await read()).assets.find(asset => asset.id === picture.id).available, false);
});

test('copies nested classification and metadata, supports batch edits and survives deleting and undoing a collection tree', async t => {
  const { root, ingest, mutate, read } = await library(t);
  const preserved = { tags: ['人物', '人物', 'Light'], rating: 4, favorite: true, note: '一行\n二行', sourceURL: 'https://example.com/work', width: 180, height: 90 };
  const first = await ingest({ jobId: 'eagle-a', undoGroup: 'eagle-batch', filename: 'one.jpg', bytes: Buffer.from('one'), collectionPaths: [['Eagle 灵感', '电影', '摄影']], ...preserved });
  const second = await ingest({ jobId: 'eagle-b', undoGroup: 'eagle-batch', filename: 'two.jpg', bytes: Buffer.from('two'), collectionPaths: [['Eagle 灵感', '电影', '摄影']] });
  let snapshot = await read();
  const collection = Object.fromEntries(snapshot.collections.map(item => [item.name, item]));
  assert.equal(collection.摄影.parentId, collection.电影.id);
  assert.equal(collection.电影.parentId, collection['Eagle 灵感'].id);
  assert.ok(snapshot.assets.every(asset => asset.collectionIds[0] === collection.摄影.id));
  const asset = snapshot.assets.find(asset => asset.id === first.id);
  assert.deepEqual(asset.tags, ['人物', 'Light']);
  assert.equal(asset.note, preserved.note);
  assert.equal(asset.sourceURL, preserved.sourceURL);
  assert.equal(asset.width, preserved.width);
  await assert.rejects(mutate({ action: 'editCollection', id: collection['Eagle 灵感'].id, parentId: collection.摄影.id }), /自己的子集合/);

  const other = await mutate({ action: 'createCollection', name: '其他' });
  const selected = [first.id, second.id];
  await mutate({ action: 'edit', ids: selected, addTags: ['light', '批量'], removeTags: ['人物'], rating: 5, favorite: false, addCollectionIds: [other.id] });
  snapshot = await read();
  assert.ok(snapshot.assets.every(item => item.tags.join(',') === 'Light,批量' || item.tags.join(',') === 'light,批量'));
  assert.ok(snapshot.assets.every(item => item.rating === 5 && !item.favorite && item.collectionIds.length === 2));

  const removed = await mutate({ action: 'deleteCollection', id: collection['Eagle 灵感'].id });
  assert.equal(removed.count, 3);
  snapshot = await read();
  assert.equal(snapshot.collections.length, 1);
  assert.ok(snapshot.assets.every(item => !item.trashed && item.available && item.collectionIds[0] === other.id));
  await mutate({ action: 'undo' });
  snapshot = await read();
  assert.equal(snapshot.collections.length, 4);
  assert.ok(snapshot.assets.every(item => item.collectionIds.includes(collection.摄影.id)));

  await mutate({ action: 'undo' });
  await mutate({ action: 'undo' });
  await mutate({ action: 'undo' });
  snapshot = await read();
  assert.equal(snapshot.collections.length, 0);
  assert.ok(snapshot.assets.every(item => item.trashed && item.available));
  await mutate({ action: 'restore', ids: selected });
  assert.ok((await read()).assets.every(item => !item.trashed));
  await mutate({ action: 'trash', ids: selected });
  assert.ok((await read()).assets.every(item => item.trashed));
  assert.equal((await fs.readdir(path.join(root, 'originals'))).length, 2);
});

test('previews case-folded rename collisions and validates the preview revision before applying', async t => {
  const { ingest, mutate, read } = await library(t);
  const names = ['a.jpg', 'b.jpg', 'Original.JPG'];
  const ids = [];
  for (const filename of names) ids.push((await ingest({ jobId: filename, filename, bytes: Buffer.from(filename) })).id);
  const entries = [{ id: ids[0], name: 'original' }, { id: ids[1], name: 'Original.jpg' }];
  const first = await mutate({ action: 'planRename', entries });
  assert.deepEqual(first.entries.map(entry => entry.name), ['original（2）', 'Original（3）']);
  assert.deepEqual(new Set((await read()).assets.map(asset => asset.name)), new Set(['a', 'b', 'Original']));
  await mutate({ action: 'edit', ids: [ids[0]], rating: 2 });
  await assert.rejects(mutate({ action: 'rename', entries, revision: first.revision }), /核对最新名称/);
  const final = await mutate({ action: 'planRename', entries });
  const renamed = await mutate({ action: 'rename', entries, revision: final.revision });
  assert.deepEqual(renamed.entries, final.entries);
  const parsed = JSON.parse(await fs.readFile(path.join((await read()).originals.get(ids[0]), '..', '..', LOCAL_MANIFEST), 'utf8'));
  assert.equal(parsed.assets[ids[0]].name, 'original（2）');
  await mutate({ action: 'undo' });
  assert.equal((await read()).assets.find(asset => asset.id === ids[0]).name, 'a');
});

test('applies reviewed AI fields atomically with collision-safe naming, additive tags and one grouped local undo', async t => {
  const { ingest, mutate, read } = await library(t);
  const { id: first } = await ingest({ jobId: 'first', filename: '参考图.jpg', tags: ['已整理'], note: '原始备注', bytes: Buffer.from('first') });
  const { id: other } = await ingest({ jobId: 'other', filename: '木桌.jpg', bytes: Buffer.from('other') });
  const undoGroup = 'suggestions:01234567-89ab-4def-8123-0123456789ab';
  const expected = { name: '参考图', tags: ['已整理'], note: '原始备注' };
  const proposal = { action: 'applySuggestion', id: first, title: '木桌.jpg', tags: ['已整理', '木纹'], note: '木质桌面位于右侧。', undoGroup };
  await assert.rejects(mutate({ ...proposal, expected: { ...expected, note: '过时备注' } }), /已变化/);
  await assert.rejects(mutate({ ...proposal, expected, note: {} }), /有效文字/);
  assert.equal((await read()).assets.find(asset => asset.id === first).name, '参考图');
  assert.equal((await mutate({ ...proposal, expected })).name, '木桌（2）');
  await mutate({ action: 'applySuggestion', id: other, tags: ['暖光'], undoGroup });
  const changed = (await read()).assets.find(asset => asset.id === first);
  assert.deepEqual(changed.tags, ['已整理', '木纹']);
  assert.equal(changed.note, '木质桌面位于右侧。');
  await mutate({ action: 'undo' });
  const assets = (await read()).assets;
  assert.equal(assets.find(asset => asset.id === first).name, '参考图');
  assert.equal(assets.find(asset => asset.id === first).note, '原始备注');
  assert.deepEqual(assets.find(asset => asset.id === other).tags, []);
});
