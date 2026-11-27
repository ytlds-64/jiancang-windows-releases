'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { renameSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { readCloudOriginal } = require('../cloud-original-worker.cjs');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, kind = 'jiancang') {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-cloud-read-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = path.join(root, kind === 'jiancang' ? 'blobs' : 'images', kind === 'jiancang' ? '集合' : 'asset.info');
  await fs.mkdir(base, { recursive: true });
  return { root, kind, base };
}

test('reads all bytes in-place and falls back from a same-length reused format 6 path', async t => {
  const { root, kind, base } = await fixture(t);
  const bytes = Buffer.alloc(2 * 1024 ** 2 + 1, 42);
  const reused = path.join(base, '已重用.jpg');
  const verified = path.join(base, '原件.jpg');
  await Promise.all([fs.writeFile(reused, Buffer.alloc(bytes.length, 7)), fs.writeFile(verified, bytes)]);
  const progress = [];
  const params = { root, kind, candidates: [reused, verified], byteCount: bytes.length, sha256: hash(bytes) };
  assert.deepEqual(await readCloudOriginal(params, count => progress.push(count)), { ok: true, bytes: bytes.length });
  assert.equal(progress.at(-1), bytes.length);
  assert.equal(progress.filter(bytesRead => bytesRead === 0).length, 2);
  assert.equal((await readCloudOriginal({ ...params, candidates: [reused] })).code, 'CHECKSUM');
  assert.deepEqual(await fs.readFile(verified), bytes);
  assert.deepEqual((await fs.readdir(base)).sort(), ['原件.jpg', '已重用.jpg'].sort());
});

test('maps absent and truncated files to different retry reasons and ignores macOS placeholder sidecars', async t => {
  const { root, kind, base } = await fixture(t);
  const bytes = Buffer.from('source');
  const file = path.join(base, '封面.jpg');
  const sidecar = path.join(base, '.封面.jpg.icloud');
  await fs.writeFile(sidecar, bytes);
  const request = { root, kind, candidates: [file, sidecar], byteCount: bytes.length, sha256: hash(bytes) };
  const progress = [];
  assert.equal((await readCloudOriginal(request, count => progress.push(count))).code, 'MISSING');
  assert.deepEqual(progress, []);
  await fs.writeFile(file, bytes.subarray(1));
  assert.equal((await readCloudOriginal(request)).code, 'INCOMPLETE');
  assert.equal((await readCloudOriginal({ ...request, sha256: undefined })).code, 'INVALID_INPUT');
  assert.ok(!(await readCloudOriginal(request)).message.includes(root));
});

test('refuses paths outside the original directory, aliased paths, and a replaced root', async t => {
  const { root, base, kind } = await fixture(t);
  const bytes = Buffer.from('untouched');
  const outside = path.join(root, 'external.jpg');
  const file = path.join(base, '照片.jpg');
  const nestedLink = path.join(root, 'blobs', '链接');
  await fs.writeFile(outside, bytes);
  await fs.writeFile(file, bytes);
  const params = { root, kind, byteCount: bytes.length, sha256: hash(bytes) };
  assert.equal((await readCloudOriginal({ ...params, candidates: [outside] })).code, 'PATH_CHANGED');
  assert.equal((await readCloudOriginal({ ...params, candidates: [file], rootIdentity: '0:0' })).code, 'PATH_CHANGED');
  if (process.platform !== 'win32') {
    await fs.symlink(base, nestedLink);
    assert.equal((await readCloudOriginal({ ...params, candidates: [path.join(nestedLink, '照片.jpg')] })).code, 'PATH_CHANGED');
    await fs.symlink(outside, path.join(base, '链接.jpg'));
    assert.equal((await readCloudOriginal({ ...params, candidates: [path.join(base, '链接.jpg')] })).code, 'PATH_CHANGED');
  }
});

test('validates a stable Eagle original and refuses its same-length replacement mid-read', async t => {
  const { root, kind, base } = await fixture(t, 'eagle');
  const file = path.join(base, '照片.png');
  const old = path.join(base, '照片-先前.png');
  const metadata = path.join(base, 'metadata.json');
  const bytes = Buffer.from('unchanged');
  await Promise.all([fs.writeFile(file, bytes), fs.writeFile(metadata, bytes)]);
  const request = { root, kind, candidates: [file], byteCount: bytes.length };
  assert.deepEqual(await readCloudOriginal(request), { ok: true, bytes: bytes.length });
  assert.equal((await readCloudOriginal({ ...request, candidates: [metadata] })).code, 'PATH_CHANGED');
  const replaced = await readCloudOriginal(request, count => {
    if (count !== 0) return;
    renameSync(file, old);
    writeFileSync(file, Buffer.alloc(bytes.length, 5));
  });
  assert.equal(replaced.code, 'PATH_CHANGED');
  assert.deepEqual(await fs.readFile(old), bytes);
});
