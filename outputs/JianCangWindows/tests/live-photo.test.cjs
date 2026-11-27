'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { crc32, deflateRawSync } = require('node:zlib');
const { readLivePhotoPart } = require('../live-photo.cjs');

function zip(entries) {
  const data = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const bytes = entry.bytes;
    const packed = entry.deflate ? deflateRawSync(bytes) : bytes;
    const checksum = entry.checksum ?? crc32(bytes);
    const method = entry.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    data.push(local, name, packed);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(entry.advertisedBytes ?? bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(entry.symlink ? 0o120000 : 0o100000, 40);
    record.writeUInt32LE(offset, 42);
    directory.push(record, name);
    offset += local.length + name.length + packed.length;
  }
  const index = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...data, index, end]);
}

const still = { name: '原照片/IMG_0001.HEIC', bytes: Buffer.from('original still frame'), deflate: true };
const movie = { name: '原照片/IMG_0001.MOV', bytes: Buffer.from('motion and audio track bytes') };

async function withArchive(t, entries, body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-live-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const archive = zip(entries);
  const file = path.join(directory, 'test.livp');
  await fs.writeFile(file, archive);
  const handle = await fs.open(file);
  try { return await body(handle, archive.length); }
  finally { await handle.close(); }
}

test('reads a deflated still and checks and streams the exact stored movie extent', async (t) => {
  await withArchive(t, [still, movie, { name: '__MACOSX/._aux', bytes: Buffer.from('metadata') }], async (handle, size) => {
    const cover = await readLivePhotoPart(handle, size, 'still');
    assert.equal(cover.extension, 'heic');
    assert.deepEqual(cover.bytes, still.bytes);
    const clip = await readLivePhotoPart(handle, size, 'movie');
    assert.equal(clip.extension, 'mov');
    assert.equal(clip.size, movie.bytes.length);
    const bytes = Buffer.alloc(clip.size);
    await handle.read(bytes, 0, clip.size, clip.offset);
    assert.deepEqual(bytes, movie.bytes);
  });
});

test('accepts a deflated legacy movie without including adjacent ZIP bytes', async (t) => {
  await withArchive(t, [still, { ...movie, deflate: true }], async (handle, size) => {
    const clip = await readLivePhotoPart(handle, size, 'movie');
    assert.equal(clip.offset, undefined);
    assert.deepEqual(clip.bytes, movie.bytes);
  });
});

test('rejects ZIP paths, links, ambiguous pairs and invalid media checksums and sizes', async (t) => {
  for (const [name, entries, kind] of [
    ['traversal', [{ ...still, name: '../IMG.jpg' }, movie], 'still'],
    ['symlink', [{ ...still, symlink: true }, movie], 'still'],
    ['second still', [still, { ...still, name: 'Duplicate.png' }, movie], 'still'],
    ['missing movie', [still], 'still'],
    ['invalid stored CRC', [still, { ...movie, checksum: 0 }], 'movie'],
    ['invalid deflated CRC', [{ ...still, checksum: 0 }, movie], 'still'],
    ['decompression overrun', [{ ...still, advertisedBytes: 1 }, movie], 'still'],
  ]) await t.test(name, async (subtest) => {
    await withArchive(subtest, entries, async (handle, size) => {
      await assert.rejects(readLivePhotoPart(handle, size, kind));
    });
  });
});
