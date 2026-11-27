'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { exportVerified, exportCapturedFrame, openOriginal, openVerifiedOriginal, parseByteRange, readStableBytes,
  withVerifiedThumbnailFile } = require('../original-file.cjs');

test('browser thumbnail reads cap bytes and honor a canceled request', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-thumb-bound-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'source.webp');
  const bytes = Buffer.alloc(257 * 1024, 7);
  await fs.writeFile(file, bytes);
  const handle = await fs.open(file, 'r');
  try {
    assert.equal(await readStableBytes(handle, bytes.length, bytes.length - 1), null);
    assert.equal(await readStableBytes(handle, bytes.length - 1, bytes.length), null);
    assert.deepEqual(await readStableBytes(handle, bytes.length, bytes.length), bytes);
    await assert.rejects(readStableBytes(handle, bytes.length, bytes.length, AbortSignal.abort()), { name: 'AbortError' });
  } finally { await handle.close(); }
});

test('verified export preserves exact original bytes and refuses to replace or write inside the library', async () => {
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-original-'));
  try {
    const root = path.join(temp, 'library');
    const blobs = path.join(root, 'blobs');
    const source = path.join(blobs, 'original.png');
    const target = path.join(temp, 'export.png');
    const bytes = Buffer.from('original bytes');
    const asset = { id: createHash('sha256').update(bytes).digest('hex'), byteCount: bytes.length };
    await fs.mkdir(blobs, { recursive: true });
    await fs.writeFile(source, bytes);
    await exportVerified(root, source, asset, target);
    assert.deepEqual(await fs.readFile(target), bytes);
    await assert.rejects(exportVerified(root, source, asset, target), { code: 'EEXIST' });
    await assert.rejects(exportVerified(root, source, asset, path.join(blobs, 'export.png')), /同步库外/);
    const alias = path.join(blobs, 'alias.png');
    await fs.symlink(target, alias, 'file');
    await assert.rejects(openOriginal(root, alias, asset.byteCount), /路径已变化/);
    await fs.writeFile(source, Buffer.alloc(bytes.length, 9));
    await assert.rejects(exportVerified(root, source, asset, path.join(temp, 'damaged.png')), /校验失败/);
    assert.deepEqual((await fs.readdir(temp)).sort(), ['export.png', 'library']);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('media requests support seeking, suffix ranges and invalid byte positions', () => {
  assert.equal(parseByteRange(null, 200), null);
  assert.deepEqual(parseByteRange('bytes=30-60', 200), { start: 30, end: 60 });
  assert.deepEqual(parseByteRange('bytes=-5', 200), { start: 195, end: 199 });
  assert.deepEqual(parseByteRange('bytes=30-', 200), { start: 30, end: 199 });
  assert.equal(parseByteRange('bytes=200-', 200), false);
  assert.equal(parseByteRange('bytes=0-2,5-9', 200), false);
});

test('captured video frame exports a new PNG outside registered libraries', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-frame-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const library = path.join(root, 'library');
  const output = path.join(root, 'frame.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXsAAAAASUVORK5CYII=', 'base64');
  await fs.mkdir(library);
  await assert.rejects(exportCapturedFrame(Buffer.from('not a PNG'), output, [library]), /有效的 PNG/);
  await assert.rejects(exportCapturedFrame(png, path.join(library, 'frame.png'), [library]), /素材库以外/);
  await exportCapturedFrame(png, output, [library]);
  assert.deepEqual(await fs.readFile(output), png);
  await assert.rejects(exportCapturedFrame(png, output, [library]), { code: 'EEXIST' });
});

test('reused same-size format 6 paths cannot pass verification or supply thumbnail and export bytes', async () => {
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-original-'));
  try {
    const root = path.join(temp, 'library');
    const blobs = path.join(root, 'blobs');
    const oldName = path.join(blobs, '旧名.png');
    const renamed = path.join(blobs, '新名.png');
    const exported = path.join(temp, 'export.png');
    const bytes = Buffer.from('original bytes');
    const different = Buffer.alloc(bytes.length, 40);
    const asset = { id: createHash('sha256').update(bytes).digest('hex'), byteCount: bytes.length, extension: 'png' };
    await fs.mkdir(blobs, { recursive: true });
    await fs.writeFile(oldName, bytes);
    const first = await openVerifiedOriginal(root, [oldName], asset);
    await first.handle.close();
    await fs.rename(oldName, renamed);
    await fs.writeFile(oldName, different);

    const result = await openVerifiedOriginal(root, [oldName, renamed], asset);
    assert.equal(result.file, renamed);
    try { assert.deepEqual(await result.handle.readFile(), bytes); }
    finally { await result.handle.close(); }

    let temporary;
    await withVerifiedThumbnailFile(root, [oldName, renamed], asset, null, async file => {
      temporary = file;
      assert.equal(path.extname(file), '.png');
      assert.notEqual(file, renamed);
      assert.deepEqual(await fs.readFile(file), bytes);
    });
    await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });

    await exportVerified(root, [oldName, renamed], asset, exported);
    assert.deepEqual(await fs.readFile(exported), bytes);
    assert.deepEqual(await fs.readFile(oldName), different);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
