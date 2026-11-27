'use strict';

const fs = require('node:fs/promises');
const { constants, createWriteStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const verifiedPaths = new Map();
const maxVerifiedPaths = 256;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function openContainedFile(expectedDirectory, file, expectedBytes) {
  if (!file || !isWithin(expectedDirectory, file)) throw new Error('原件还没同步到这台电脑。');
  const canonical = await fs.realpath(file);
  if (!isWithin(expectedDirectory, canonical) || path.relative(canonical, file) !== '') {
    throw new Error('原件路径已变化，请刷新素材库。');
  }
  const entry = await fs.lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('原件路径已变化，请刷新素材库。');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino ||
        (expectedBytes !== undefined && stat.size !== expectedBytes) ||
        await fs.realpath(file) !== canonical) {
      throw new Error('原件尚未完整同步，请在 iCloud Drive 中下载后刷新。');
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function openOriginal(root, file, expectedBytes) {
  return openContainedFile(path.join(root, 'blobs'), file, expectedBytes);
}

function fileStamp(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function readStableBytes(handle, byteCount, byteLimit, signal) {
  if (!Number.isSafeInteger(byteCount) || byteCount <= 0 || byteCount > byteLimit) return null;
  return readStablePrefix(handle, byteCount, byteCount, signal);
}

async function readStablePrefix(handle, byteCount, byteLimit, signal) {
  if (!Number.isSafeInteger(byteCount) || byteCount < 0 || !Number.isSafeInteger(byteLimit) || byteLimit <= 0) return null;
  signal?.throwIfAborted();
  const before = await handle.stat({ bigint: true });
  if (before.size !== BigInt(byteCount)) return null;
  const bytes = Buffer.allocUnsafe(Math.min(byteCount, byteLimit));
  let position = 0;
  while (position < bytes.length) {
    signal?.throwIfAborted();
    const chunk = Math.min(256 * 1024, bytes.length - position);
    const { bytesRead } = await handle.read(bytes, position, chunk, position);
    if (!bytesRead) return null;
    position += bytesRead;
  }
  signal?.throwIfAborted();
  return fileStamp(before) === fileStamp(await handle.stat({ bigint: true })) ? bytes : null;
}

async function verifyHandle(handle, asset, file, signal) {
  const before = fileStamp(await handle.stat({ bigint: true }));
  const key = `${asset.id}:${file}`;
  if (verifiedPaths.get(key) === before) return;

  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < asset.byteCount) {
    signal?.throwIfAborted();
    const length = Math.min(buffer.length, asset.byteCount - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) throw new Error('原件尚未完整同步。');
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (digest.digest('hex') !== asset.id || before !== fileStamp(await handle.stat({ bigint: true }))) {
    throw new Error('原件校验失败。');
  }
  if (verifiedPaths.size >= maxVerifiedPaths) verifiedPaths.delete(verifiedPaths.keys().next().value);
  verifiedPaths.set(key, before);
}

// Format 6 paths can be reused. Verify on the handle that the media stream
// will consume, falling back when a historical path now holds another file.
async function openVerifiedOriginal(root, candidates, asset, signal) {
  for (const file of candidates) {
    signal?.throwIfAborted();
    let handle;
    try {
      handle = await openOriginal(root, file, asset.byteCount);
      await verifyHandle(handle, asset, file, signal);
      signal?.throwIfAborted();
      return { file, handle };
    } catch {
      await handle?.close().catch(() => {});
      signal?.throwIfAborted();
    }
  }
  throw new Error('原件校验失败。请等待 iCloud 下载后刷新。');
}

async function validateExportTarget(target, roots, message) {
  const parent = await fs.realpath(path.dirname(target));
  if (roots.some(root => isWithin(root, parent))) throw new Error(message);
  const filename = path.basename(target);
  if (!filename || filename === '.' || filename === '..') throw new Error('请选择一个文件名。');
  return path.join(parent, filename);
}

async function exportCapturedFrame(bytes, target, protectedRoots) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
  if (buffer.length < 33 || buffer.length > 128 * 1024 ** 2 ||
      !buffer.subarray(0, 8).equals(pngSignature) || buffer.readUInt32BE(8) !== 13 ||
      buffer.toString('ascii', 12, 16) !== 'IHDR' ||
      buffer.readUInt32BE(16) === 0 || buffer.readUInt32BE(20) === 0) {
    throw new Error('未能生成有效的 PNG 视频帧。');
  }
  const targetPath = await validateExportTarget(target, protectedRoots, '请选择素材库以外的文件夹保存视频帧。');
  const temporaryDirectory = await fs.mkdtemp(path.join(path.dirname(targetPath), '.jiancang-export-'));
  try {
    const temporary = path.join(temporaryDirectory, 'frame.png');
    await fs.writeFile(temporary, buffer, { flag: 'wx', mode: 0o600 });
    await fs.copyFile(temporary, targetPath, constants.COPYFILE_EXCL);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function copyOriginal(root, file, asset, target, signal) {
  const handle = await openOriginal(root, file, asset.byteCount);
  try {
    const hash = createHash('sha256');
    let count = 0;
    const checksum = new Transform({
      transform(chunk, _encoding, done) {
        count += chunk.length;
        if (count > asset.byteCount) return done(new Error('原件内容在导出时发生变化。'));
        hash.update(chunk);
        return done(null, chunk);
      },
    });
    await pipeline(handle.createReadStream(), checksum, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal: signal ?? undefined });
    if (count !== asset.byteCount || hash.digest('hex') !== asset.id) {
      throw new Error('原件校验失败。请等待 iCloud 重新下载后重试。');
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

async function copyVerifiedCandidate(root, candidates, asset, target, signal) {
  for (const file of candidates) {
    signal?.throwIfAborted();
    try {
      await copyOriginal(root, file, asset, target, signal);
      return;
    } catch (error) {
      await fs.rm(target, { force: true });
      signal?.throwIfAborted();
      // A local copy error is unrelated to the location record.
      if (candidates.length === 1 || ['ENOSPC', 'EROFS', 'EEXIST'].includes(error.code)) throw error;
    }
  }
  throw new Error('原件校验失败。请等待 iCloud 下载后刷新。');
}

async function exportVerified(root, fileOrCandidates, asset, target, protectedRoots = [root]) {
  const targetPath = await validateExportTarget(target, protectedRoots, '请选择同步库外的文件夹保存副本。');
  const temporaryDirectory = await fs.mkdtemp(path.join(path.dirname(targetPath), '.jiancang-export-'));
  try {
    const temporary = path.join(temporaryDirectory, `${randomUUID()}.tmp`);
    const candidates = Array.isArray(fileOrCandidates) ? fileOrCandidates : [fileOrCandidates];
    await copyVerifiedCandidate(root, candidates, asset, temporary);
    await fs.copyFile(temporary, targetPath, constants.COPYFILE_EXCL);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function copyReadOnlySource(base, source, expectedBytes, target, signal) {
  const handle = await openContainedFile(base, source, expectedBytes);
  try {
    const before = fileStamp(await handle.stat({ bigint: true }));
    let count = 0;
    const checkLength = new Transform({
      transform(chunk, _encoding, done) {
        count += chunk.length;
        if (count > expectedBytes) return done(new Error('Eagle 原件在读取时发生变化，请刷新素材库。'));
        done(null, chunk);
      },
    });
    await pipeline(handle.createReadStream({ autoClose: false }), checkLength,
      createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
    if (count !== expectedBytes || before !== fileStamp(await handle.stat({ bigint: true }))) {
      throw new Error('Eagle 原件在读取时发生变化，请刷新素材库。');
    }
  } finally { await handle.close().catch(() => {}); }
}

async function exportReadOnly(base, source, byteCount, target, protectedRoots) {
  const targetPath = await validateExportTarget(target, protectedRoots, '请选择素材库以外的文件夹保存副本。');
  const temporaryDirectory = await fs.mkdtemp(path.join(path.dirname(targetPath), '.jiancang-export-'));
  try {
    const temporary = path.join(temporaryDirectory, 'original');
    await copyReadOnlySource(base, source, byteCount, temporary);
    await fs.copyFile(temporary, targetPath, constants.COPYFILE_EXCL);
  } finally { await fs.rm(temporaryDirectory, { recursive: true, force: true }); }
}

async function withReadOnlyThumbnailFile(base, source, byteCount, signal, decode) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-thumbnail-'));
  try {
    const extension = path.extname(source).toLowerCase();
    const temporary = path.join(temporaryDirectory, /^[.][a-z0-9]{1,16}$/.test(extension) ? `original${extension}` : 'original');
    await copyReadOnlySource(base, source, byteCount, temporary, signal);
    return await decode(temporary);
  } finally { await fs.rm(temporaryDirectory, { recursive: true, force: true }); }
}

// Native thumbnail codecs consume paths. Give them a private, byte-verified
// temporary file so concurrent changes to the cloud path cannot swap the input.
async function withVerifiedThumbnailFile(root, candidates, asset, signal, decode) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-thumbnail-'));
  try {
    const extension = /^[a-z0-9]{1,16}$/.test(asset.extension) ? `.${asset.extension}` : '';
    const temporary = path.join(temporaryDirectory, `original${extension}`);
    await copyVerifiedCandidate(root, candidates, asset, temporary, signal);
    return await decode(temporary);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) return false;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return false;
  if (first === null) return last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : false;
  const end = last === null ? size - 1 : Math.min(last, size - 1);
  return first <= end ? { start: first, end } : false;
}

function exportFilename(name, extension) {
  const legalExtension = /^[a-z0-9]{1,16}$/.test(extension) ? `.${extension}` : '';
  let filename = Array.from(name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/^[ .]+|[ .]+$/g, ''))
    .slice(0, 90).join('').replace(/[ .]+$/g, '') || '素材';
  if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(filename.trim())) filename = `_${filename}`;
  return legalExtension && !filename.toLowerCase().endsWith(legalExtension) ? filename + legalExtension : filename;
}

module.exports = { isWithin, openContainedFile, openOriginal, openVerifiedOriginal, readStableBytes, readStablePrefix, exportVerified, exportReadOnly, exportCapturedFrame, validateExportTarget,
  withVerifiedThumbnailFile, withReadOnlyThumbnailFile, parseByteRange, exportFilename };
