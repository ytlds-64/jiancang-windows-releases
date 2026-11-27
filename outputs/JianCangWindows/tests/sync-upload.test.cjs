'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readLibrary } = require('../sync-library.cjs');
const { prepareSyncOriginal, publishSyncOriginal, publishSyncFileNoReplace } = require('../sync-upload.cjs');

const bytes = Buffer.from('Test file at the sync provider');
const deviceId = '9EC34FA5-7C05-4F0E-8124-CDE965A41D88';
const libraryId = 'E80BBCAC-14BA-44DE-9634-3146D13F387D';

async function fixture(t, version = 6) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-incoming-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'Library');
  const staging = path.join(directory, 'Private');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'library.json'), JSON.stringify({
    format: 'com.materialshelf.directory-sync', version, createdAt: 700_000_000, libraryID: libraryId,
    namingDeviceID: deviceId,
  }));
  return { directory, root, staging, birthId: randomUUID() };
}

async function stage(staging) {
  return prepareSyncOriginal({ directory: staging, bytes, fileExtension: 'PNG' });
}

function destination(root, birthId, prepared) {
  return path.join(root, 'blobs', '.incoming', `${prepared.blob.sha256}.${birthId}.${prepared.fileExtension}`);
}

test('streams large originals and exposes an incoming generation that the Windows reader resolves after the birth', async t => {
  const { root, staging, directory, birthId: rawBirth } = await fixture(t);
  const birthId = rawBirth.toUpperCase();
  const source = path.join(directory, 'original.PNG');
  const content = Buffer.alloc(3 * 1024 * 1024 + 17, 69);
  await fs.writeFile(source, content);
  const progress = [];
  const prepared = await prepareSyncOriginal({ directory: staging, open: () => fs.open(source, 'r'), fileExtension: 'PNG',
    onProgress: ratio => progress.push(ratio) });
  const { blob, fileExtension } = prepared;
  assert.deepEqual(blob, { byteCount: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  assert.equal(fileExtension, 'png');
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.length > 1);

  const { published, file } = await publishSyncOriginal({ root, libraryId, birthId, prepared });
  assert.equal(published, true);
  assert.equal(file, destination(root, birthId, prepared));
  assert.deepEqual(await fs.readFile(file), content);
  assert.equal((await readLibrary(root)).assets.length, 0);

  const adopted = 700_000_000;
  const string = _0 => ({ string: { _0 } });
  const bool = _0 => ({ bool: { _0 } });
  const nil = { null: {} };
  const changes = path.join(root, 'changes', deviceId);
  await fs.mkdir(changes, { recursive: true });
  await fs.writeFile(path.join(changes, `1-${birthId}.json`), JSON.stringify({
    version: 1, libraryID: libraryId, deviceID: deviceId, id: birthId, counter: 1, clock: { [deviceId]: 1 },
    entityKind: 'asset', entityID: blob.sha256,
    changes: { life: bool(true), name: string('新素材'), note: string(''), favorite: bool(false), rating: { int: { _0: 0 } },
      sourceURL: nil, deletedAt: nil, eagleID: nil, createdAt: { double: { _0: adopted + 978_307_200 } } },
    asset: { blob, fileExtension, kind: 'image', pixelWidth: 0, pixelHeight: 0, createdAt: adopted, importedAt: adopted },
  }));
  const library = await readLibrary(root);
  assert.equal(library.assets[0].id, blob.sha256);
  assert.equal(library.assets[0].available, true);
  assert.equal(library.originals.get(blob.sha256), file);
  await prepared.discard();
  assert.deepEqual(await fs.readdir(staging), []);
});

test('one generation publishes only once through a restart-compatible, concurrent retry', async t => {
  const { root, staging, birthId } = await fixture(t);
  const prepared = await stage(staging);
  const { file, blob, fileExtension } = prepared;
  const upload = () => publishSyncOriginal({ root, libraryId, birthId, prepared: { file, blob, fileExtension } });
  const results = await Promise.all([upload(), upload(), upload()]);
  assert.equal(results.filter(result => result.published).length, 1);
  const target = destination(root, birthId, prepared);
  assert.equal((await upload()).published, false);
  assert.deepEqual(await fs.readdir(path.dirname(target)), [path.basename(target)]);
  const replacement = await publishSyncOriginal({ root, libraryId, birthId: randomUUID(), prepared });
  assert.equal(replacement.published, true);
  assert.notEqual(replacement.file, target);
  await prepared.discard();
});

test('follows the naming owner’s recorded move and ignores stale paths reused by other originals', async t => {
  const { root, staging, birthId } = await fixture(t);
  const prepared = await stage(staging);
  const { file } = await publishSyncOriginal({ root, libraryId, birthId, prepared });
  const realPath = path.join(root, 'blobs', '集合', '参考图', '近景.png');
  const stalePath = path.join(root, 'blobs', '集合', '旧名.png');
  await fs.mkdir(path.dirname(realPath), { recursive: true });
  await fs.writeFile(stalePath, Buffer.alloc(bytes.length, 66));
  await fs.rename(file, realPath);
  const locations = path.join(root, 'blobs', '.locations');
  await fs.mkdir(locations);
  await fs.writeFile(path.join(locations, `${prepared.blob.sha256}.${birthId}.json`), JSON.stringify({
    version: 1, paths: [['集合', '旧名.png'], ['集合', '参考图', '近景.png']],
  }));
  assert.deepEqual(await publishSyncOriginal({ root, libraryId, birthId, prepared }), { published: false, file: realPath });
  assert.deepEqual(await fs.readdir(path.dirname(file)), []);
  await prepared.discard();
});

test('fails closed if the original or cloud name changed, then allows retry with valid bytes', async t => {
  const { root, staging, birthId } = await fixture(t);
  const prepared = await stage(staging);
  const original = destination(root, birthId, prepared);
  const run = () => publishSyncOriginal({ root, libraryId, birthId, prepared });
  const different = Buffer.alloc(bytes.length, 17);
  await fs.writeFile(prepared.file, different);
  await assert.rejects(run, /校验未通过/);
  assert.deepEqual(await fs.readdir(path.dirname(original)), []);
  await fs.writeFile(prepared.file, bytes);
  await fs.writeFile(original, different);
  await assert.rejects(run, { code: 'IMMUTABLE_COLLISION' });
  assert.deepEqual(await fs.readFile(original), different);
  await fs.rm(original);
  assert.equal((await run()).published, true);
  assert.deepEqual(await fs.readFile(original), bytes);
  await fs.writeFile(prepared.file, different);
  await assert.rejects(run, /校验未通过/);
  await prepared.discard();
});

test('refuses mismatched libraries, old formats, directory symlinks and unsafe location records', async t => {
  const { root, staging, directory, birthId } = await fixture(t);
  const prepared = await stage(staging);
  const run = () => publishSyncOriginal({ root, libraryId, birthId, prepared });
  await assert.rejects(() => publishSyncOriginal({ root, libraryId: randomUUID(), birthId, prepared }), { code: 'INVALID_LIBRARY' });
  const other = await fixture(t, 5);
  await assert.rejects(() => publishSyncOriginal({ root: other.root, libraryId, birthId, prepared }), { code: 'INVALID_LIBRARY' });
  assert.deepEqual(await fs.readdir(root), ['library.json']);
  assert.deepEqual(await fs.readdir(other.root), ['library.json']);
  const unowned = path.join(directory, 'Unowned');
  await fs.mkdir(unowned);
  const blobs = path.join(root, 'blobs');
  await fs.symlink(unowned, blobs, 'junction');
  await assert.rejects(run, { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(unowned), []);
  await fs.unlink(blobs);
  const locations = path.join(blobs, '.locations');
  await fs.mkdir(locations, { recursive: true });
  const filename = `${prepared.blob.sha256}.${birthId}.json`;
  const placeholder = path.join(locations, `.${filename}.icloud`);
  await fs.writeFile(placeholder, 'wait');
  await assert.rejects(run, { code: 'SYNC_PENDING' });
  await fs.rm(placeholder);
  await fs.writeFile(path.join(locations, filename), JSON.stringify({ version: 1, paths: [['集合', '..', '别处.png']] }));
  await assert.rejects(run, { code: 'UNSAFE_PATH' });
  await prepared.discard();
});

test('the immutable publisher refuses to overwrite a native destination', async t => {
  const { directory } = await fixture(t);
  const source = path.join(directory, "原件 (2) '样本'&");
  const target = path.join(directory, "同名 '片段'&.json");
  await fs.writeFile(source, 'new');
  await fs.writeFile(target, 'old');
  await assert.rejects(() => publishSyncFileNoReplace(source, target), { code: 'EEXIST' });
  assert.equal(await fs.readFile(target, 'utf8'), 'old');
  await fs.rm(target);
  await publishSyncFileNoReplace(source, target);
  assert.equal(await fs.readFile(target, 'utf8'), 'new');
});
