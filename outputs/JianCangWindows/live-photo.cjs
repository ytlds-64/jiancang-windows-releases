'use strict';

const { promisify } = require('node:util');
const { crc32, inflateRaw } = require('node:zlib');

const inflate = promisify(inflateRaw);
const imageExtensions = new Set(['heic', 'heif', 'jpg', 'jpeg', 'png']);
const descriptorBytes = 22;
const maxMembers = 64;
const maxMemberBytes = 256 * 1024 ** 2;
const maxArchiveBytes = 2 * maxMemberBytes + 1024 ** 2;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function invalid() {
  return new Error('实况照片中的封面或视频无法读取。');
}

async function readExactly(handle, size, offset, signal) {
  const buffer = Buffer.allocUnsafe(size);
  let read = 0;
  while (read < size) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, read, size - read, offset + read);
    if (!bytesRead) throw invalid();
    read += bytesRead;
  }
  return buffer;
}

async function readDirectory(handle, size, signal) {
  if (!Number.isSafeInteger(size) || size < descriptorBytes || size > maxArchiveBytes) throw invalid();
  const tailBytes = Math.min(size, descriptorBytes + 0xffff);
  const tail = await readExactly(handle, tailBytes, size - tailBytes, signal);
  for (let index = tail.length - descriptorBytes; index >= 0; index--) {
    if (tail.readUInt32LE(index) !== 0x06054b50 ||
        index + descriptorBytes + tail.readUInt16LE(index + 20) !== tail.length) continue;
    const end = size - tailBytes + index;
    const count = tail.readUInt16LE(index + 10);
    const length = tail.readUInt32LE(index + 12);
    const offset = tail.readUInt32LE(index + 16);
    if (tail.readUInt32LE(index + 4) !== 0 || tail.readUInt16LE(index + 8) !== count ||
        count < 2 || count > maxMembers || length > 1024 ** 2 || offset + length !== end) throw invalid();
    return { bytes: await readExactly(handle, length, offset, signal), offset, count };
  }
  throw invalid();
}

function pairInDirectory(bytes, count) {
  const pair = {};
  let offset = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw invalid();
    const flags = bytes.readUInt16LE(offset + 8);
    const compression = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const packedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const disk = bytes.readUInt16LE(offset + 34);
    const unixMode = bytes.readUInt16LE(offset + 40) & 0o170000;
    const localOffset = bytes.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    offset = nameStart + nameLength + extraLength + commentLength;
    if (offset > bytes.length || nameLength === 0 || disk !== 0 || unixMode === 0o120000) throw invalid();
    const name = bytes.subarray(nameStart, nameStart + nameLength);
    const raw = utf8.decode(name);
    const directory = raw.endsWith('/');
    const parts = (directory ? raw.slice(0, -1) : raw).split('/');
    if (parts.length > 8 || parts.some((part) => !part || part === '.' || part === '..' ||
        /[\\:\x00-\x1f\x7f]/u.test(part) || Buffer.byteLength(part) > 255)) throw invalid();
    if (directory || parts.includes('__MACOSX') || parts.at(-1).startsWith('.')) continue;
    const extension = /\.([^.]+)$/.exec(parts.at(-1))?.[1].toLowerCase();
    const kind = imageExtensions.has(extension) ? 'still' : extension === 'mov' ? 'movie' : null;
    if (!kind) continue;
    if (pair[kind] || (flags & ~0x080e) !== 0 || ![0, 8].includes(compression) ||
        size <= 0 || size > maxMemberBytes || packedSize <= 0 || packedSize > maxMemberBytes ||
        (compression === 0 && packedSize !== size)) throw invalid();
    pair[kind] = { name, flags, compression, checksum, packedSize, size, localOffset, extension };
  }
  if (offset !== bytes.length || !pair.still || !pair.movie) throw invalid();
  return pair;
}

async function dataOffset(handle, entry, end, signal) {
  const { localOffset, packedSize, name } = entry;
  if (localOffset + 30 + name.length + packedSize > end) throw invalid();
  const header = await readExactly(handle, 30 + name.length, localOffset, signal);
  if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== entry.flags ||
      header.readUInt16LE(8) !== entry.compression || header.readUInt16LE(26) !== name.length ||
      !header.subarray(30).equals(name)) throw invalid();
  const offset = localOffset + header.length + header.readUInt16LE(28);
  if (offset + packedSize > end) throw invalid();
  return offset;
}

async function checkStoredEntry(handle, offset, entry, signal) {
  let checksum = 0;
  for (let read = 0; read < entry.size; read += 1024 ** 2) {
    const chunk = await readExactly(handle, Math.min(1024 ** 2, entry.size - read), offset + read, signal);
    checksum = crc32(chunk, checksum);
  }
  if (checksum !== entry.checksum) throw invalid();
}

// The handle must already hold the sync original verified by SHA-256.
// No ZIP path is ever used to write a file. A stored clip can be streamed from
// its checked byte extent; an older deflated clip is inflated to a bounded buffer.
async function readLivePhotoPart(handle, size, kind, signal) {
  if (kind !== 'still' && kind !== 'movie') throw invalid();
  const directory = await readDirectory(handle, size, signal);
  const entry = pairInDirectory(directory.bytes, directory.count)[kind];
  const offset = await dataOffset(handle, entry, directory.offset, signal);
  if (kind === 'movie' && entry.compression === 0) {
    await checkStoredEntry(handle, offset, entry, signal);
    return { extension: entry.extension, size: entry.size, offset };
  }
  const packed = await readExactly(handle, entry.packedSize, offset, signal);
  const bytes = entry.compression === 0 ? packed : await inflate(packed, { maxOutputLength: entry.size });
  signal?.throwIfAborted();
  if (bytes.length !== entry.size || crc32(bytes) !== entry.checksum) throw invalid();
  return { extension: entry.extension, size: entry.size, bytes };
}

module.exports = { readLivePhotoPart };
