'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { PNG } = require('../../vendor/ocr/node_modules/pngjs');
const { importLocalAsset } = require('../../local-library.cjs');
const { LibraryService } = require('./library-service.cjs');
const { EditService } = require('./edit-service.cjs');

function png(width, height, color) {
  const picture = new PNG({ width, height });
  for (let pixel = 0; pixel < picture.data.length; pixel += 4) picture.data.set(color, pixel);
  return PNG.sync.write(picture);
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-edit-'));
  const library = new LibraryService(path.join(directory, 'profile'));
  const editor = new EditService(library);
  t.after(async () => {
    await editor.close();
    await library.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await library.initialize();
  const { activeLibraryId: registrationId } = await library.command('local:create', ['编辑样本', directory]);
  const { root, libraryId } = library.entry(registrationId);
  const bytes = png(8, 4, [24, 80, 160, 255]);
  const { id: photo } = await importLocalAsset(root, { expectedLibraryId: libraryId, jobId: 'edit-sample-photo',
    filename: '彩色样本.png', bytes, width: 8, height: 4, tags: ['样本'] });
  const { id: video } = await importLocalAsset(root, { expectedLibraryId: libraryId, jobId: 'edit-sample-video',
    filename: '彩色视频.mp4', bytes: Buffer.from('000000146674797069736f6d0000020069736f6d', 'hex'), kind: 'video' });
  await library.command('library:refresh', [registrationId]);
  const destination = path.join(directory, 'saved');
  await fs.mkdir(destination);
  function reference(id, target = registrationId) {
    const { asset } = library.original(id, target);
    return { id, registrationId: target, revision: asset.mediaRevision,
      contentRevision: JSON.stringify([asset.mediaRevision || id, asset.byteCount, asset.width, asset.height]) };
  }
  return { library, editor, root, destination, bytes, photo, video, registrationId, reference };
}

async function upload(editor, kind, options, bytes) {
  const { token } = await editor.command('edit:upload-begin', [kind, { ...options, byteCount: bytes.length }]);
  for (const chunk of [bytes.subarray(0, 24), bytes.subarray(24)]) {
    editor.command('edit:upload-append', [token, chunk.toString('base64')]);
  }
  return token;
}

test('exports PNG frames only after full transfer, preserving dimensions and existing files', async t => {
  const { editor, root, destination, video, reference, bytes } = await fixture(t);
  const input = { ...reference(video), width: 8, height: 4, seconds: 2.5 };
  const { token: pending } = await editor.command('edit:upload-begin', ['frame', { ...input, byteCount: bytes.length }]);
  assert.throws(() => editor.command('edit:destination', [pending]), /未传输完毕/);
  assert.throws(() => editor.command('edit:upload-append', [pending, '!@#$']), /读取/);
  editor.command('edit:upload-discard', [pending]);
  assert.throws(() => editor.command('edit:upload-append', [pending, 'Ag==']), /过期/);

  const token = await upload(editor, 'frame', input, bytes);
  const suggested = editor.command('edit:destination', [token]);
  assert.match(suggested.defaultName, /2\.500秒 - 视频帧\.png$/u);
  assert.equal(suggested.extension, 'png');
  const pathWithoutSuffix = path.join(destination, '当前帧');
  assert.equal((await editor.command('edit:save', [token, pathWithoutSuffix])).ok, true);
  const frame = await fs.readFile(`${pathWithoutSuffix}.png`);
  assert.deepEqual(frame, bytes);

  const collision = await upload(editor, 'frame', input, bytes);
  await assert.rejects(editor.command('edit:save', [collision, pathWithoutSuffix]), /同名/);
  const protectedPath = await upload(editor, 'frame', input, bytes);
  await assert.rejects(editor.command('edit:save', [protectedPath, path.join(root, '拒绝.png')]), /素材库以外/);
  const mismatched = await upload(editor, 'frame', { ...input, width: 4 }, bytes);
  await assert.rejects(editor.command('edit:save', [mismatched, path.join(destination, '尺寸错误.png')]), /尺寸/);
  assert.deepEqual(await fs.readdir(destination), ['当前帧.png']);
  assert.deepEqual(await fs.readFile(`${pathWithoutSuffix}.png`), bytes);
});

test('saves an edited copy without modifying the original and rejects stale media before writing', async t => {
  const { editor, library, root, destination, photo, reference, bytes } = await fixture(t);
  const input = { ...reference(photo), mode: 'export', format: 'png', width: 3, height: 7 };
  const edited = png(3, 7, [88, 48, 24, 128]);
  const token = await upload(editor, 'image', input, edited);
  assert.equal(editor.command('edit:destination', [token]).defaultName, '彩色样本 - 编辑.png');
  const copy = path.join(destination, '编辑副本.png');
  assert.equal((await editor.command('edit:save', [token, copy])).ok, true);
  const { width, height } = PNG.sync.read(await fs.readFile(copy));
  assert.deepEqual([width, height], [3, 7]);
  const source = library.original(photo, input.registrationId).file;
  assert.deepEqual(await fs.readFile(source), bytes);
  const occupied = await upload(editor, 'image', input, edited);
  await assert.rejects(editor.command('edit:save', [occupied, copy]), /同名/);

  const protectedPath = await upload(editor, 'image', input, edited);
  await assert.rejects(editor.command('edit:save', [protectedPath, path.join(root, '拒绝.png')]), /素材库以外/);
  const badSize = await upload(editor, 'image', { ...input, width: 4 }, edited);
  await assert.rejects(editor.command('edit:save', [badSize, path.join(destination, '尺寸错误.png')]), /尺寸/);
  const stale = await upload(editor, 'image', input, edited);
  await fs.writeFile(source, bytes);
  await assert.rejects(editor.command('edit:save', [stale, path.join(destination, '过期.png')]), /变化/);
  assert.deepEqual(await fs.readdir(destination), ['编辑副本.png']);
});

test('replaces a local original through existing undo history and refuses an out-of-date editor', async t => {
  const { editor, library, photo, registrationId, reference, bytes } = await fixture(t);
  const input = { ...reference(photo), mode: 'replace', format: 'png', width: 4, height: 8 };
  const edited = png(4, 8, [88, 48, 24, 255]);
  const token = await upload(editor, 'image', input, edited);
  assert.equal(editor.command('edit:destination', [token]), null);
  const result = await editor.command('edit:save', [token]);
  assert.equal(result.ok, true);
  const current = library.original(photo, registrationId);
  assert.deepEqual([current.asset.width, current.asset.height], [4, 8]);
  assert.deepEqual(current.asset.tags, ['样本']);
  assert.deepEqual(await fs.readFile(current.file), edited);
  await assert.rejects(editor.command('edit:upload-begin', ['image', { ...input, byteCount: edited.length }]), /变化/);
  await library.command('local:mutate', [registrationId, { action: 'undo' }]);
  assert.deepEqual(await fs.readFile(library.original(photo, registrationId).file), bytes);
});

test('adds a separate edited sync original only when writes are enabled', async t => {
  const { editor, library, root, bytes, reference } = await fixture(t);
  const sync = path.join(path.dirname(root), '同步样本');
  const libraryId = randomUUID();
  await fs.mkdir(path.join(sync, 'blobs', '.incoming'), { recursive: true });
  await fs.mkdir(path.join(sync, 'changes'));
  await fs.writeFile(path.join(sync, 'library.json'), JSON.stringify({
    libraryID: libraryId, format: 'com.materialshelf.directory-sync', version: 6,
    namingDeviceID: randomUUID(), createdAt: 810_000_000,
  }));
  const { activeLibraryId: registrationId } = await library.command('library:choose', ['jiancang', sync]);
  await library.command('sync:configure-write', [registrationId, true]);
  const { id } = await library.importCapture({ id: '1'.repeat(32), targetId: registrationId,
    source: { kind: 'buffer', targetLibraryId: libraryId, name: '源样本.png', bytes } });
  const original = library.original(id, registrationId);
  const input = { ...reference(id, registrationId), mode: 'sync-copy', format: 'png',
    width: 2, height: 2, expectedLibraryId: libraryId };
  const edited = png(2, 2, [20, 30, 40, 255]);
  await library.command('sync:configure-write', [registrationId, false]);
  await assert.rejects(editor.command('edit:upload-begin', ['image', { ...input, byteCount: edited.length }]), /开启双向同步/);

  await library.command('sync:configure-write', [registrationId, true]);
  const token = await upload(editor, 'image', input, edited);
  assert.equal(editor.command('edit:destination', [token]), null);
  const result = await editor.command('edit:save', [token]);
  assert.equal(result.ok, true);
  assert.notEqual(result.id, id);
  assert.deepEqual(await fs.readFile(original.file), bytes);
  assert.deepEqual(await fs.readFile(library.original(result.id, registrationId).file), edited);
});
