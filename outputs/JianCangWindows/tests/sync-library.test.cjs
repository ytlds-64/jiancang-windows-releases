'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readLibrary } = require('../sync-library.cjs');
const { registerLibrary, createRegistry, parseAssetRoute, assetForCatalog } = require('../library-registry.cjs');

const id = n => `00000000-0000-4000-a000-${n.toString(16).padStart(12, '0')}`;
const libraryID = id(1);
const a = id(2), b = id(3);
const string = _0 => ({ string: { _0 } });
const bool = _0 => ({ bool: { _0 } });
const int = _0 => ({ int: { _0 } });
const double = _0 => ({ double: { _0 } });
const nil = { null: {} };
const created = 1_700_000_000;
const image = Buffer.from('Original photo bytes for the sync-reader fixture');
const sha256 = createHash('sha256').update(image).digest('hex');
const media = {
  blob: { sha256, byteCount: image.length }, kind: 'image', fileExtension: 'png',
  pixelWidth: 1280, pixelHeight: 900, createdAt: created - 978_307_200, importedAt: created - 978_307_200 + 1,
};

async function workspace(t, version = 4) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-reader-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'changes'));
  await fs.mkdir(path.join(root, 'blobs'));
  await fs.writeFile(path.join(root, 'library.json'), JSON.stringify({
    libraryID, version, format: 'com.materialshelf.directory-sync', createdAt: created - 978_307_200,
  }));
  return root;
}

async function publish(root, { deviceID = a, counter, number, clock, entityKind = 'asset', entityID = sha256, changes }) {
  const operation = {
    id: id(number), libraryID, version: 1, deviceID, counter, clock: { ...clock, [deviceID]: counter }, entityKind, entityID, changes,
  };
  if (entityKind === 'asset') operation.asset = media;
  const dir = path.join(root, 'changes', deviceID);
  await fs.mkdir(dir, { recursive: true });
  const filename = path.join(dir, `${counter}-${operation.id}.json`);
  await fs.writeFile(filename, JSON.stringify(operation));
  return filename;
}

const assetFields = (extras = {}) => ({
  life: bool(true), name: string('样片'), note: string('灯光参考'), favorite: bool(true), rating: int(4),
  sourceURL: string('https://example.com/reference'), eagleID: nil, createdAt: double(created), deletedAt: nil, ...extras,
});

const collectionFields = (name, parentId = null) => ({
  life: bool(true), name: string(name), parentID: parentId === null ? nil : string(parentId),
  colorHex: string('A34337'), symbol: string('folder'), createdAt: double(created),
});

async function writeBlob(root, segments, content = image) {
  const filename = path.join(root, 'blobs', ...segments);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content);
  return filename;
}

test('routes duplicate asset IDs to their own registered sync source', async t => {
  const firstRoot = await workspace(t, 1);
  const secondRoot = await workspace(t, 1);
  await publish(firstRoot, { counter: 1, number: 20, changes: assetFields({ name: string('第一库样片') }) });
  await publish(secondRoot, { counter: 1, number: 20, changes: assetFields({ name: string('第二库样片') }) });
  const firstFile = await writeBlob(firstRoot, [sha256]);
  const secondFile = await writeBlob(secondRoot, [sha256]);
  const [first, second] = await Promise.all([readLibrary(firstRoot), readLibrary(secondRoot)]);
  const registered = registerLibrary(registerLibrary(createRegistry(), firstRoot, { ...first, kind: 'jiancang' }),
    secondRoot, { ...second, kind: 'jiancang' });
  const [firstId, secondId] = registered.entries.map(entry => entry.id);
  const catalogs = new Map([[firstId, first], [secondId, second]].map(([id, catalog]) =>
    [id, { ...catalog, assets: new Map(catalog.assets.map(asset => [asset.id, asset])) }]));

  const route = parseAssetRoute(`/${secondId}/${sha256}`);
  const scoped = assetForCatalog(catalogs, firstId, route.assetId, route.registrationId);
  assert.equal(scoped.asset.name, '第二库样片');
  assert.equal(scoped.file, secondFile);
  assert.equal(assetForCatalog(catalogs, firstId, sha256).file, firstFile);
  assert.equal(assetForCatalog(catalogs, secondId, sha256, firstId).file, firstFile);
  assert.deepEqual(parseAssetRoute(`/${sha256}`), { assetId: sha256 });
  assert.equal(parseAssetRoute(`/${firstId}/../${sha256}`), null);
  assert.equal(parseAssetRoute(`/%2e%2e/${sha256}`), null);
  catalogs.delete(secondId);
  assert.throws(() => assetForCatalog(catalogs, firstId, sha256, secondId), /素材已经变化/);
});

test('format 4 merges metadata and locates a real file under moved collection folders', async t => {
  const root = await workspace(t);
  const first = id(10), child = id(11);
  await publish(root, { counter: 1, number: 20, entityKind: 'collection', entityID: first, changes: collectionFields('项目') });
  await publish(root, { counter: 2, number: 21, entityKind: 'collection', entityID: child, changes: collectionFields('参考图', first) });
  await publish(root, { counter: 3, number: 22, changes: assetFields({ 'tag:设计': bool(true), [`member:${child}`]: bool(true) }) });
  const filename = await writeBlob(root, ['集合', '项目', '参考图', `${sha256}.${id(22)}.png`]);

  const catalog = await readLibrary(root);
  assert.equal(catalog.format, 4);
  assert.equal(catalog.partial, false);
  assert.equal(catalog.collections.find(folder => folder.id === child).parentId, first);
  assert.deepEqual(catalog.assets[0], {
    id: sha256, name: '样片', kind: 'image', extension: 'png', width: 1280, height: 900, duration: null,
    byteCount: image.length, createdAt: new Date(created * 1000).toISOString(), importedAt: new Date((created + 1) * 1000).toISOString(),
    tags: ['设计'], collectionIds: [child], favorite: true, rating: 4, note: '灯光参考', sourceURL: 'https://example.com/reference',
    trashed: false, available: true,
  });
  assert.equal(catalog.originals.get(sha256), filename);
  const movedDirectory = path.join(root, 'blobs', '集合', '新项目');
  await fs.mkdir(movedDirectory);
  const moved = path.join(movedDirectory, path.basename(filename));
  await fs.rename(filename, moved);
  assert.equal((await readLibrary(root)).originals.get(sha256), moved);
});

test('formats 1–3 read extensionless original identities and preserve user files', async t => {
  for (const version of [1, 2, 3]) {
    await t.test(`format ${version}`, async subtest => {
      const root = await workspace(subtest, version);
      const journal = await publish(root, { counter: 1, number: 20, changes: assetFields() });
      const filename = await writeBlob(root, [version === 1 ? sha256 : `${sha256}.${id(20)}`]);
      const stamp = await fs.stat(journal);
      const catalog = await readLibrary(root);
      assert.equal(catalog.partial, false);
      assert.equal(catalog.originals.get(sha256), filename);
      assert.equal((await fs.stat(journal)).mtimeMs, stamp.mtimeMs);
      assert.deepEqual(await fs.readFile(filename), image);
    });
  }
});

test('format 5 resolves display filenames with a stable short code and detects collisions', async t => {
  const root = await workspace(t, 5);
  const birth = 20;
  await publish(root, { counter: 1, number: birth, changes: assetFields() });
  const identity = `${sha256}.${id(birth)}`;
  const code = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16);
  const newFile = await writeBlob(root, ['集合', '项目', `好看的素材 [${code}].png`]);
  assert.equal((await readLibrary(root)).originals.get(sha256), newFile);
  await writeBlob(root, ['未分类', `重复搬运 [${code}].png`]);
  const duplicate = await readLibrary(root);
  assert.equal(duplicate.partial, true);
  assert.equal(duplicate.assets[0].available, false);
  assert.equal(duplicate.originals.size, 0);
  const legacy = await writeBlob(root, [identity + '.png']);
  assert.equal((await readLibrary(root)).originals.get(sha256), legacy);
});

test('format 6 opens plain filenames and keeps verified fallback candidates across migration and delayed moves', async t => {
  const root = await workspace(t, 6);
  const birth = 20;
  await publish(root, { counter: 1, number: birth, changes: assetFields() });
  const identity = `${sha256}.${id(birth)}`;
  const code = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16);
  const legacy = await writeBlob(root, ['集合', '项目', `样片 [${code}].png`]);
  const incoming = await writeBlob(root, ['.incoming', `${identity}.png`]);
  const before = await readLibrary(root);
  assert.equal(before.originals.get(sha256), legacy);
  assert.deepEqual(before.originalCandidates.get(sha256), [legacy, incoming]);

  const filename = ['集合', '项目', '样片 (2).png'];
  const expected = await writeBlob(root, filename);
  const previous = await writeBlob(root, ['未分类', '旧名.png'], Buffer.alloc(image.length, 9));
  const locationDirectory = path.join(root, 'blobs', '.locations');
  await fs.mkdir(locationDirectory);
  const record = path.join(locationDirectory, `${identity}.json`);
  await fs.writeFile(record, JSON.stringify({ version: 1, paths: [filename, ['未分类', '旧名.png']] }));
  await fs.unlink(legacy);
  const moved = await readLibrary(root);
  assert.equal(moved.originals.get(sha256), expected);
  assert.deepEqual(moved.originalCandidates.get(sha256), [expected, previous, incoming]);
  assert.equal(moved.partial, false);

  // The record can reach another machine before the corresponding rename.
  await fs.unlink(expected);
  const waitingForMove = await readLibrary(root);
  assert.deepEqual(waitingForMove.originalCandidates.get(sha256), [previous, incoming]);
  await fs.writeFile(record, JSON.stringify({ version: 1, paths: [['集合', '..', 'payload.png']] }));
  await assert.rejects(readLibrary(root), { code: 'UNSAFE_PATH' });
});

test('waits for missing causal ancestors before showing an independently arrived update', async t => {
  const root = await workspace(t);
  await publish(root, { counter: 1, number: 10, changes: assetFields() });
  await publish(root, { deviceID: b, counter: 1, number: 12, clock: { [a]: 2 }, changes: { name: string('新版名称') } });
  await writeBlob(root, ['未分类', `${sha256}.${id(10)}.png`]);
  const waiting = await readLibrary(root);
  assert.equal(waiting.partial, true);
  assert.equal(waiting.logIncomplete, true);
  assert.equal(waiting.assets[0].name, '样片');
  await publish(root, { counter: 2, number: 11, changes: { note: string('另一设备还未收到的备注') } });
  const complete = await readLibrary(root);
  assert.equal(complete.partial, false);
  assert.equal(complete.assets[0].name, '新版名称');
  assert.equal(complete.assets[0].note, '另一设备还未收到的备注');
});

test('concurrent removal wins and old tags and collection memberships cannot survive reimport', async t => {
  const root = await workspace(t);
  const group = id(9);
  await publish(root, { counter: 1, number: 10, entityKind: 'collection', entityID: group, changes: collectionFields('样片') });
  await publish(root, { counter: 2, number: 11, changes: assetFields({ 'tag:旧标签': bool(true), [`member:${group}`]: bool(true) }) });
  await publish(root, { counter: 3, number: 12, changes: { [`member:${group}`]: bool(false) } });
  await publish(root, { deviceID: b, counter: 1, number: 13, clock: { [a]: 2 }, changes: { [`member:${group}`]: bool(true) } });
  const oldPath = await writeBlob(root, ['集合', '样片', `${sha256}.${id(11)}.png`]);
  const concurrent = await readLibrary(root);
  assert.deepEqual(concurrent.assets[0].collectionIds, []);
  await publish(root, { counter: 4, number: 14, clock: { [b]: 1 }, changes: { life: bool(false) } });
  assert.equal((await readLibrary(root)).assets.length, 0);
  await publish(root, { counter: 5, number: 15, clock: { [b]: 1 }, changes: assetFields({ 'tag:新标签': bool(true) }) });
  const missingOriginal = await readLibrary(root);
  assert.equal(missingOriginal.assets[0].available, false);
  assert.equal(missingOriginal.partial, true);
  assert.equal(missingOriginal.logIncomplete, false);
  assert.deepEqual(missingOriginal.assets[0].tags, ['新标签']);
  const newPath = await writeBlob(root, ['未分类', `${sha256}.${id(15)}.png`]);
  assert.equal((await readLibrary(root)).originals.get(sha256), newPath);
  assert.deepEqual(await fs.readFile(oldPath), image);
});

test('parent cycles break deterministically and child of deleted folder follows its live ancestor', async t => {
  const root = await workspace(t);
  const first = id(30), second = id(31), dead = id(32), child = id(33);
  const writeCollection = (counter, entityID, changes) => publish(root, { counter, number: 40 + counter, entityKind: 'collection', entityID, changes });
  await writeCollection(1, first, collectionFields('A', second));
  await writeCollection(2, second, collectionFields('B', first));
  await writeCollection(3, dead, collectionFields('待删', first));
  await writeCollection(4, child, collectionFields('子集合', dead));
  await writeCollection(5, dead, { life: bool(false) });
  const catalog = await readLibrary(root);
  assert.equal(catalog.collections.find(collection => collection.id === second).parentId, null);
  assert.equal(catalog.collections.find(collection => collection.id === first).parentId, second);
  assert.equal(catalog.collections.find(collection => collection.id === child).parentId, first);
  assert.equal(catalog.collections.find(collection => collection.id === dead), undefined);
});

test('malformed records and symbolic links fail closed', async t => {
  const root = await workspace(t);
  const journal = await publish(root, { counter: 1, number: 10, changes: assetFields() });
  const good = await fs.readFile(journal);
  await fs.writeFile(journal, '{');
  await assert.rejects(readLibrary(root), { code: 'INVALID_OPERATION' });
  await fs.writeFile(journal, good);
  const external = path.join(root, 'External');
  await fs.mkdir(external);
  try {
    await fs.symlink(external, path.join(root, 'blobs', '集合'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return;
    throw error;
  }
  await assert.rejects(readLibrary(root), { code: 'UNSAFE_PATH' });
});
