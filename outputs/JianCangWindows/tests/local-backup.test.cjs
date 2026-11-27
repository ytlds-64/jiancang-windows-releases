'use strict';

const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createLocalBackup, restoreLocalBackup, prepareLocalBackupGroup,
  createIncrementalLocalBackup, listLocalBackupSnapshots } = require('../local-backup.cjs');
const {
  LOCAL_MANIFEST, createLocalLibrary, importLocalAsset, mutateLocalLibrary, readLocalLibrary, replaceLocalPicture,
} = require('../local-library.cjs');

const red = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const green = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==', 'base64');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-backup-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, '本地库');
  const destination = path.join(directory, '备份位置');
  const restoreDestination = path.join(directory, '还原位置');
  const { libraryId: expectedLibraryId } = await createLocalLibrary(root, '本地库');
  await fs.mkdir(destination);
  await fs.mkdir(restoreDestination);
  const read = () => readLocalLibrary(root, expectedLibraryId);
  const mutate = command => mutateLocalLibrary(root, { ...command, expectedLibraryId });
  const ingest = input => importLocalAsset(root, { ...input, expectedLibraryId });
  const backup = options => createLocalBackup({ root, destination, expectedLibraryId, ...options });
  const restore = (backupRoot, options) => restoreLocalBackup({ backupRoot, destination: restoreDestination, name: '恢复的资料库', ...options });
  return { root, destination, restoreDestination, expectedLibraryId, read, mutate, ingest, backup, restore };
}

test('backs up a photo version referenced only by redo and can replay it after restore', async t => {
  const { root, expectedLibraryId, read, mutate, ingest, backup, restore } = await fixture(t);
  const { id } = await ingest({ jobId: 'backup-redo-photo', filename: '原片.png', bytes: red });
  const { mediaRevision: revision } = (await read()).assets[0];
  await replaceLocalPicture(root, { expectedLibraryId, id, revision, bytes: green, format: 'png', width: 1, height: 1 });
  await mutate({ action: 'undo' });
  const created = await backup();
  assert.equal(created.files, 3);
  const restored = await restore(created.directory);
  const snap = () => readLocalLibrary(restored.directory, restored.libraryId);
  const before = await snap();
  assert.equal(before.canRedo, true);
  assert.deepEqual(await fs.readFile(before.originals.get(id)), red);
  assert.equal((await mutateLocalLibrary(restored.directory, {
    action: 'redo', expectedLibraryId: restored.libraryId, revision: before.revision,
  })).redone, true);
  assert.deepEqual(await fs.readFile((await snap()).originals.get(id)), green);
  assert.deepEqual(await fs.readFile((await read()).originals.get(id)), red);
});

test('restores an independent library with collections, metadata, trash and historical originals needed to undo an edit', async t => {
  const { root, expectedLibraryId, read, mutate, ingest, backup, restore } = await fixture(t);
  const { id: parentId } = await mutate({ action: 'createCollection', name: '日常' });
  const { id: childId } = await mutate({ action: 'createCollection', name: '现场', parentId });
  const { id } = await ingest({ jobId: 'backup-red', filename: '原片.png', bytes: red, collectionIds: [childId], tags: ['参考'], rating: 4, note: '保留原片' });
  const trashed = await ingest({ jobId: 'backup-trashed', filename: '回收站.txt', bytes: Buffer.from('trashed') });
  await mutate({ action: 'trash', ids: [trashed.id] });
  const revision = (await read()).assets.find(asset => asset.id === id).mediaRevision;
  await replaceLocalPicture(root, { expectedLibraryId, id, revision, bytes: green, format: 'png', width: 1, height: 1 });
  const from = await read();
  const activeOriginal = from.originals.get(id);
  assert.notEqual(path.basename(activeOriginal), `${id}.png`);
  await fs.writeFile(path.join(root, 'originals', '.ignored.tmp'), 'temporary');
  const phases = [];
  const created = await backup({ onProgress: update => phases.push(update) });
  assert.equal(created.files, 4);
  assert.deepEqual([...new Set(phases.map(update => update.phase))], ['reading', 'copying', 'finishing']);
  assert.equal(phases.at(-1).filesDone, created.files);
  assert.equal(phases.at(-1).bytesDone, created.bytes);
  const manifest = JSON.parse(await fs.readFile(path.join(created.directory, 'backup.json'), 'utf8'));
  assert.equal(manifest.libraryId, expectedLibraryId);
  assert.equal(manifest.files.length, 4);
  for (const { path: relative, bytes, sha256 } of manifest.files) {
    const copied = await fs.readFile(path.join(created.directory, 'payload', relative));
    assert.equal(copied.length, bytes);
    assert.equal(createHash('sha256').update(copied).digest('hex'), sha256);
  }
  const restored = await restore(created.directory);
  assert.notEqual(restored.libraryId, expectedLibraryId);
  const next = await readLocalLibrary(restored.directory, restored.libraryId);
  assert.equal(next.directoryName, '恢复的资料库');
  assert.equal(next.revision, from.revision);
  assert.deepEqual(next.collections, from.collections);
  assert.deepEqual(next.assets.map(({ mediaRevision, ...asset }) => asset), from.assets.map(({ mediaRevision, ...asset }) => asset));
  assert.equal(next.canUndo, true);
  assert.deepEqual(await fs.readFile(next.originals.get(id)), green);
  assert.deepEqual(await fs.readFile(next.originals.get(trashed.id)), Buffer.from('trashed'));
  await mutateLocalLibrary(restored.directory, { action: 'undo', expectedLibraryId: restored.libraryId });
  const undo = await readLocalLibrary(restored.directory, restored.libraryId);
  assert.deepEqual(await fs.readFile(undo.originals.get(id)), red);
  assert.deepEqual(await fs.readFile(activeOriginal), green);
});

test('rejects a corrupted backup without publishing a partial library', async t => {
  const { ingest, backup, restore, restoreDestination } = await fixture(t);
  const { id } = await ingest({ jobId: 'backup-corrupt', filename: '原片.png', bytes: red });
  const created = await backup();
  assert.equal(red.length, green.length);
  await fs.writeFile(path.join(created.directory, 'payload', 'originals', `${id}.png`), green);
  await assert.rejects(restore(created.directory), /备份不完整或校验失败/);
  assert.deepEqual(await fs.readdir(restoreDestination), []);
});

test('refuses substituted paths and inventory entries outside the allowed library files', async t => {
  const { root, ingest, backup, restore, restoreDestination } = await fixture(t);
  const { id } = await ingest({ jobId: 'backup-links', filename: '原片.png', bytes: red });
  const created = await backup();
  const inventoryPath = path.join(created.directory, 'backup.json');
  const inventory = JSON.parse(await fs.readFile(inventoryPath, 'utf8'));
  const [ignored, image] = inventory.files;
  await fs.writeFile(inventoryPath, JSON.stringify({ ...inventory, files: [ignored, { ...image, path: '../../原片.png' }] }));
  await assert.rejects(restore(created.directory), /备份不完整或校验失败/);
  await fs.writeFile(inventoryPath, JSON.stringify(inventory));

  const original = path.join(root, 'originals', `${id}.png`);
  const copied = path.join(created.directory, 'payload', 'originals', `${id}.png`);
  await fs.rename(copied, `${copied}.keep`);
  try {
    await fs.symlink(original, copied, 'file');
  } catch (error) {
    if (error.code === 'EPERM' && process.platform === 'win32') return;
    throw error;
  }
  await assert.rejects(restore(created.directory), /备份不完整或校验失败/);
  assert.deepEqual(await fs.readdir(restoreDestination), []);
  await fs.rename(original, `${original}.keep`);
  await fs.symlink(`${original}.keep`, original, 'file');
  await assert.rejects(backup(), /原件不可用/);
});

test('protects existing folders and rejects stale manifest backups or cancelled copies', async t => {
  const { root, destination, restoreDestination, ingest, backup, restore } = await fixture(t);
  await ingest({ jobId: 'source-change', filename: '大文件.bin', bytes: Buffer.alloc(2 * 1024 ** 2, 0xf1) });
  await assert.rejects(backup({ destination: path.join(root, 'originals') }), /素材库和备份文件夹之外/);
  await assert.rejects(backup({ onProgress(update) {
    if (update.phase === 'copying' && update.filesDone === 0 && update.bytesDone === 0) {
      appendFileSync(path.join(root, LOCAL_MANIFEST), '\n');
    }
  } }), /素材库有改动/);
  assert.deepEqual(await fs.readdir(destination), []);
  const controller = new AbortController();
  await assert.rejects(backup({ signal: controller.signal, onProgress(update) {
    if (update.phase === 'finishing') controller.abort();
  } }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(destination), []);
  const created = await backup();
  const existing = path.join(restoreDestination, '恢复的资料库');
  await fs.mkdir(existing);
  await fs.writeFile(path.join(existing, '保留.txt'), 'keep');
  await assert.rejects(restore(created.directory), /已有同名文件夹/);
  assert.equal(await fs.readFile(path.join(existing, '保留.txt'), 'utf8'), 'keep');
  assert.deepEqual(await fs.readdir(restoreDestination), ['恢复的资料库']);
  await assert.rejects(restore(created.directory, { name: 'AUX.txt' }), /有效文件夹名称/);
  await assert.rejects(restore(created.directory, { name: '../目录' }), /有效文件夹名称/);
});

test('stores changed objects once and restores either dated version after an original was deleted', async t => {
  const { root, expectedLibraryId, destination, ingest, mutate, read, restore } = await fixture(t);
  const photo = await ingest({ jobId: 'snapshot-photo', filename: '原片.png', bytes: red });
  const removed = await ingest({ jobId: 'snapshot-removed', filename: '旧资料.txt', bytes: Buffer.from('previous') });
  const config = await prepareLocalBackupGroup({ destination, libraryId: expectedLibraryId, protectedRoots: [root] });
  const group = config.directory;
  const save = options => createIncrementalLocalBackup({ root, expectedLibraryId, groupRoot: group,
    expectedGroupId: config.groupId, ...options });
  const first = await save();
  assert.equal(first.objectsWritten, 3);
  assert.equal(first.unchanged, false);
  const noChange = await save();
  assert.equal(noChange.unchanged, true);
  assert.equal(noChange.bytesWritten, 0);
  assert.deepEqual(noChange.snapshot, first.snapshot);

  await mutate({ action: 'trash', ids: [removed.id] });
  await mutate({ action: 'purgeTrash', ids: [removed.id], revision: (await read()).revision });
  const photoPath = (await read()).originals.get(photo.id);
  assert.equal(red.length, green.length);
  await fs.writeFile(photoPath, green);
  const second = await save();
  assert.equal(second.objectsWritten, 2);
  assert.notEqual(second.snapshot.id, first.snapshot.id);
  assert.equal((await fs.readdir(path.join(group, 'objects'))).length, 5);
  const dates = await listLocalBackupSnapshots(group);
  assert.deepEqual(dates.snapshots, [second.snapshot, first.snapshot]);

  // The store is portable as a directory and may be explicitly selected after a move.
  const moved = `${group}-moved`;
  await fs.rename(group, moved);
  const reselected = await prepareLocalBackupGroup({ destination: moved, libraryId: expectedLibraryId, protectedRoots: [root] });
  assert.deepEqual(reselected, { directory: moved, groupId: config.groupId });
  const earlier = await restore(moved, { snapshotId: first.snapshot.id });
  const later = await restore(moved, { snapshotId: second.snapshot.id, name: '第二个时间点' });
  const original = await readLocalLibrary(earlier.directory, earlier.libraryId);
  const updated = await readLocalLibrary(later.directory, later.libraryId);
  assert.deepEqual(await fs.readFile(original.originals.get(photo.id)), red);
  assert.deepEqual(await fs.readFile(original.originals.get(removed.id)), Buffer.from('previous'));
  assert.deepEqual(await fs.readFile(updated.originals.get(photo.id)), green);
  assert.equal(updated.assets.some(asset => asset.id === removed.id), false);
});

test('rejects a corrupted incremental object and skips publishing an aborted snapshot', async t => {
  const { root, expectedLibraryId, destination, restoreDestination, ingest, restore } = await fixture(t);
  await ingest({ jobId: 'snapshot-checks', filename: '原片.png', bytes: red });
  await assert.rejects(prepareLocalBackupGroup({ destination: root, libraryId: expectedLibraryId, protectedRoots: [root] }), /素材库和备份文件夹之外/);
  const { directory, groupId } = await prepareLocalBackupGroup({ destination, libraryId: expectedLibraryId });
  const save = options => createIncrementalLocalBackup({ root, expectedLibraryId, groupRoot: directory,
    expectedGroupId: groupId, ...options });
  const controller = new AbortController();
  await assert.rejects(save({ signal: controller.signal, onProgress(update) {
    if (update.phase === 'finishing') controller.abort();
  } }), { name: 'AbortError' });
  assert.deepEqual((await listLocalBackupSnapshots(directory)).snapshots, []);
  assert.deepEqual(await fs.readdir(path.join(directory, 'objects')), []);

  const first = await save();
  const object = path.join(directory, 'objects', createHash('sha256').update(red).digest('hex'));
  await fs.writeFile(object, green);
  await assert.rejects(restore(directory, { snapshotId: first.snapshot.id }), /备份不完整或校验失败/);
  assert.deepEqual(await fs.readdir(restoreDestination), []);
  const repaired = await save();
  assert.equal(repaired.unchanged, true);
  assert.equal(repaired.objectsWritten, 1);
  const restored = await restore(directory, { snapshotId: first.snapshot.id });
  assert.equal((await readLocalLibrary(restored.directory, restored.libraryId)).assets.length, 1);
});
