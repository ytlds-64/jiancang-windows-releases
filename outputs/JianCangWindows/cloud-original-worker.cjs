'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isWithin, openContainedFile } = require('./original-file.cjs');

const maximumBytes = 16 * 1024 ** 3;
const maximumCandidates = 32;
const chunkBytes = 1024 ** 2;
const progressInterval = 100;
const messages = {
  INVALID_INPUT: '原件记录无法读取，请刷新素材库后重试。',
  MISSING: '原件还没出现在同步文件夹中，请等 iCloud Drive 同步后重试。',
  PATH_CHANGED: '原件位置已变化或包含链接，请刷新素材库后重试。',
  INCOMPLETE: '原件尚未完整同步，请等 iCloud Drive 同步后重试。',
  CHECKSUM: '原件内容与素材记录不符，请核对 iCloud Drive 中的原件后重试。',
  ACCESS: '系统没有授予原件读取权限，请检查 iCloud Drive 和文件夹权限。',
  PROVIDER: '系统暂时无法取回原件，请检查网络和 iCloud Drive 状态后重试。',
  DISK_SPACE: '磁盘可用空间不足，请释放空间后重试。',
};
const sourceErrors = new Map([
  ['ENOENT', 'MISSING'], ['ENOTDIR', 'MISSING'], ['ENODATA', 'INCOMPLETE'], ['ELOOP', 'PATH_CHANGED'],
  ['EACCES', 'ACCESS'], ['EPERM', 'ACCESS'], ['ENOSPC', 'DISK_SPACE'], ['EDQUOT', 'DISK_SPACE'],
]);
// If a naming migration temporarily exposes several paths, report the most
// actionable reason across the attempted paths.
const failureOrder = ['MISSING', 'PROVIDER', 'ACCESS', 'INCOMPLETE', 'PATH_CHANGED', 'CHECKSUM', 'DISK_SPACE'];

function fail(code) {
  const error = new Error(messages[code]);
  error.code = code;
  return error;
}

function resultFor(code) {
  return { ok: false, code, message: messages[code] };
}

function safeAbsolute(value) {
  return typeof value === 'string' && value.length <= 32767 && path.isAbsolute(value) &&
    !/[\u0000-\u001f]/.test(value) && path.resolve(value) === value;
}

function isSidecar(name) {
  return name.startsWith('.') && /\.icloud$/i.test(name) || /^\.materialshelf-publish-/i.test(name);
}

function validateCandidate(base, file, kind) {
  if (!safeAbsolute(file) || !isWithin(base, file) || path.relative(base, file) === '') throw fail('PATH_CHANGED');
  const parts = path.relative(base, file).split(path.sep);
  if (process.platform === 'win32' && parts.some(part => /:|[ .]$/.test(part))) throw fail('PATH_CHANGED');
  if (isSidecar(parts.at(-1))) throw fail('MISSING');
  if (kind === 'eagle' && (parts.length !== 2 || !/^[a-z0-9_-]{1,128}\.info$/i.test(parts[0]) ||
      parts[1].startsWith('.') || /^(?:metadata|mtime)\.json$/i.test(parts[1]))) throw fail('PATH_CHANGED');
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameContentStamp(left, right) {
  // The provider can change the allocation and access attributes as blocks
  // are downloaded. Compare the logical size and data modification time.
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

async function stableDirectory(root) {
  const entry = await fs.lstat(root, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink() || path.relative(root, await fs.realpath(root)) !== '') {
    throw fail('PATH_CHANGED');
  }
  return entry;
}

async function replayCandidate({ root, base, rootEntry, baseEntry, file, byteCount, sha256, buffer, report }) {
  const observed = await fs.lstat(file, { bigint: true });
  if (!observed.isFile() || observed.isSymbolicLink() || path.relative(file, await fs.realpath(file)) !== '') {
    throw fail('PATH_CHANGED');
  }
  if (observed.size !== BigInt(byteCount)) throw fail('INCOMPLETE');
  let handle;
  try {
    try { handle = await openContainedFile(base, file, byteCount); }
    catch (error) { if (error.code) throw error; throw fail('PATH_CHANGED'); }
    const before = await handle.stat({ bigint: true });
    if (!sameContentStamp(observed, before)) throw fail('PATH_CHANGED');

    report(0);
    const digest = sha256 ? createHash('sha256') : null;
    let nextProgress = Date.now() + progressInterval;
    let position = 0;
    while (position < byteCount) {
      const length = Math.min(buffer.length, byteCount - position);
      // Reading the original placeholder lets Windows request the missing range
      // from its sync provider. The app opens no destination file.
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (!bytesRead) throw fail('INCOMPLETE');
      digest?.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      const now = Date.now();
      if (position < byteCount && now >= nextProgress) {
        report(position);
        nextProgress = now + progressInterval;
      }
    }

    const current = await fs.lstat(file, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || !sameContentStamp(before, current) ||
        !sameContentStamp(before, await handle.stat({ bigint: true })) || path.relative(file, await fs.realpath(file)) !== '' ||
        !sameIdentity(rootEntry, await stableDirectory(root)) || !sameIdentity(baseEntry, await stableDirectory(base))) {
      throw fail('PATH_CHANGED');
    }
    if (digest && digest.digest('hex') !== sha256) throw fail('CHECKSUM');
    report(byteCount);
    return { ok: true, bytes: byteCount };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function failureCode(error) {
  return Object.hasOwn(messages, error?.code) ? error.code : sourceErrors.get(error?.code) ?? 'PROVIDER';
}

async function readCloudOriginal(input, notify) {
  const { root, kind, candidates, byteCount, sha256, rootIdentity } = input ?? {};
  if (!safeAbsolute(root) || !['jiancang', 'eagle'].includes(kind) || !Array.isArray(candidates) ||
      candidates.length > maximumCandidates || !Number.isSafeInteger(byteCount) || byteCount < 0 || byteCount > maximumBytes ||
      (kind === 'jiancang' && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)))) {
    return resultFor('INVALID_INPUT');
  }
  if (!candidates.length) return resultFor('MISSING');

  const base = path.join(root, kind === 'eagle' ? 'images' : 'blobs');
  const report = bytes => {
    try { notify?.(bytes); } catch { /* The receiver may have stopped listening. */ }
  };
  const digest = kind === 'jiancang' ? sha256 : null;
  try {
    const rootEntry = await stableDirectory(root);
    if (rootIdentity != null && rootIdentity !== `${rootEntry.dev}:${rootEntry.ino}`) return resultFor('PATH_CHANGED');
    const baseEntry = await stableDirectory(base);
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, byteCount));
    let code = 'MISSING';
    for (const file of new Set(candidates)) {
      try {
        validateCandidate(base, file, kind);
        return await replayCandidate({ root, base, rootEntry, baseEntry, file, byteCount, sha256: digest, buffer, report });
      } catch (error) {
        const candidateCode = failureCode(error);
        if (failureOrder.indexOf(candidateCode) > failureOrder.indexOf(code)) code = candidateCode;
      }
    }
    return resultFor(code);
  } catch (error) { return resultFor(failureCode(error)); }
}

async function runOriginalRequest(data, send) {
  const report = bytes => send({ type: 'progress', bytes });
  const result = await readCloudOriginal(data, report).catch(() => resultFor('PROVIDER'));
  send({ type: 'result', ...result });
}

if (process.parentPort) {
  process.parentPort.once('message', ({ data }) => {
    void runOriginalRequest(data, message => process.parentPort.postMessage(message));
  });
} else if (require.main === module && process.send) {
  process.once('message', data => {
    void runOriginalRequest(data, message => { if (process.connected) process.send(message); });
  });
}

module.exports = { readCloudOriginal };
