'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { openContainedFile, readStableBytes } = require('./original-file.cjs');
const { imageExtensions, readImageDimensions } = require('./image-dimensions.cjs');

const maxBlobBytes = 16 * 1024 ** 3;
const maxJSONBytes = 65_536;
const transferBuffer = 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/;
const extension = /^[0-9a-z]{0,16}$/;
const stageName = /^sync-original-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/i;
const managedFolders = new Set(['集合', '未分类', '回收站', '历史原件']);
const windowsLinkErrors = new Set(['EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'UNKNOWN']);
const utf8 = new TextDecoder('utf-8', { fatal: true });

function errorWith(message, code) { return Object.assign(new Error(message), { code }); }

function samePath(left, right) { return path.relative(left, right) === ''; }

function stamp(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'); }

async function status(file) {
  try { return await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function directoryIdentity(directory) {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(directory), directory)) {
    throw errorWith('同步目录路径已变化，请重新连接原素材库。', 'UNSAFE_PATH');
  }
  return `${stat.dev}:${stat.ino}`;
}

async function validateDirectory(directory, identity) {
  if (await directoryIdentity(directory) !== identity) throw errorWith('同步目录位置已变化。', 'UNSAFE_PATH');
}

async function readJSON(directory, file) {
  const handle = await openContainedFile(directory, file);
  try {
    const stat = await handle.stat();
    const bytes = await readStableBytes(handle, stat.size, maxJSONBytes);
    if (!bytes) throw errorWith('同步记录尚未到齐，请稍后重试。', 'SYNC_PENDING');
    try { return JSON.parse(utf8.decode(bytes)); }
    catch { throw errorWith('同步记录损坏或尚未到齐，请稍后重试。', 'SYNC_PENDING'); }
  } finally { await handle.close(); }
}

async function validateSyncWriteRoot(root, libraryId) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !uuid.test(libraryId)) {
    throw errorWith('请选择格式 6 的见藏同步库。', 'INVALID_LIBRARY');
  }
  const identity = await directoryIdentity(root);
  const manifest = await readJSON(root, path.join(root, 'library.json'));
  if (manifest?.format !== 'com.materialshelf.directory-sync' || manifest.libraryID !== libraryId ||
      manifest.version !== 6 || !Number.isFinite(manifest.createdAt) || !uuid.test(manifest.namingDeviceID)) {
    throw errorWith('同步库身份已变化，或还未升级到格式 6。', 'INVALID_LIBRARY');
  }
  await validateDirectory(root, identity);
  return identity;
}

async function ensureChild(parent, identity, name) {
  await validateDirectory(parent, identity);
  const child = path.join(parent, name);
  try { await fs.mkdir(child); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await validateDirectory(parent, identity);
  return { path: child, identity: await directoryIdentity(child) };
}

function validSize(byteCount) { return Number.isSafeInteger(byteCount) && byteCount >= 0 && byteCount <= maxBlobBytes; }

async function transfer(source, output, report) {
  const before = await source.stat({ bigint: true });
  const byteCount = Number(before.size);
  if (!before.isFile() || !validSize(byteCount)) throw errorWith('无法读取原件，单个文件上限为 16 GB。', 'INVALID_ORIGINAL');
  const buffer = Buffer.allocUnsafe(Math.min(transferBuffer, Math.max(1, byteCount)));
  const digest = createHash('sha256');
  let transferred = 0;
  let last = 0;
  while (transferred < byteCount) {
    const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, byteCount - transferred), transferred);
    if (bytesRead === 0) break;
    digest.update(buffer.subarray(0, bytesRead));
    if (output) {
      let written = 0;
      while (written < bytesRead) {
        const chunk = await output.write(buffer, written, bytesRead - written, transferred + written);
        if (chunk.bytesWritten === 0) throw new Error('无法写入同步原件。');
        written += chunk.bytesWritten;
      }
    }
    transferred += bytesRead;
    if (report && transferred < byteCount && transferred / byteCount - last >= 0.01) {
      last = transferred / byteCount;
      report(last);
    }
  }
  if (transferred !== byteCount || stamp(before) !== stamp(await source.stat({ bigint: true }))) {
    throw errorWith('读取时原件发生变化，请重新导入。', 'SOURCE_CHANGED');
  }
  if (output) await output.sync();
  report?.(1);
  return { sha256: digest.digest('hex'), byteCount };
}

async function prepareSyncOriginal({ directory, open, bytes, fileExtension = '', onProgress } = {}) {
  const fromFile = typeof open === 'function' && bytes === undefined;
  const fromBytes = open === undefined && bytes instanceof Uint8Array;
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof fileExtension !== 'string' ||
      !extension.test(fileExtension.toLowerCase()) || (!fromFile && !fromBytes)) {
    throw errorWith('无法准备同步原件。', 'INVALID_ORIGINAL');
  }
  fileExtension = fileExtension.toLowerCase();
  const probeSize = imageExtensions.has(fileExtension);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await fs.realpath(directory);
  if (!samePath(root, directory)) throw errorWith('原件暂存目录包含链接。', 'UNSAFE_PATH');
  const identity = await directoryIdentity(root);
  const file = path.join(root, `sync-original-${randomUUID()}.part`);
  let owned = false;
  let completed = false;
  let source;
  let target;
  async function discard() {
    await validateDirectory(root, identity);
    await fs.rm(file, { force: true });
  }
  try {
    target = await fs.open(file, probeSize ? 'wx+' : 'wx', 0o600);
    owned = true;
    let blob;
    if (fromFile) {
      source = await open();
      blob = await transfer(source, target, onProgress);
    } else {
      if (!validSize(bytes.byteLength)) throw errorWith('单个文件上限为 16 GB。', 'INVALID_ORIGINAL');
      // Own the bytes until the write and its digest have completed.
      const content = Buffer.from(bytes);
      blob = { byteCount: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') };
      await target.writeFile(content);
      await target.sync();
      onProgress?.(1);
    }
    const [width, height] = probeSize ? await readImageDimensions(target, blob.byteCount) : [];
    await target.close();
    target = null;
    await validateDirectory(root, identity);
    completed = true;
    return { blob, fileExtension, file, discard, width, height };
  } finally {
    await source?.close();
    await target?.close();
    if (owned && !completed) await discard().catch(() => {});
  }
}

function locationPart(part) {
  return typeof part === 'string' && part.length > 0 && Buffer.byteLength(part, 'utf8') <= 255 &&
    part !== '.' && part !== '..' && !/[<>:"/\\|?*\p{Cc}\p{Cs}]/u.test(part) && !/[ .]$/.test(part) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(part.normalize('NFKC').split('.')[0].trim());
}

async function mappedFiles(blobs, generation) {
  const index = path.join(blobs, '.locations');
  if (!await status(index)) return [];
  await directoryIdentity(index);
  const name = `${generation}.json`;
  const file = path.join(index, name);
  if (!await status(file)) {
    if (await status(`${file}.icloud`) || await status(path.join(index, `.${name}.icloud`))) {
      throw errorWith('云端文件位置尚未下载。', 'SYNC_PENDING');
    }
    return [];
  }
  const location = await readJSON(index, file);
  if (location?.version !== 1 || !Array.isArray(location.paths) || !location.paths.length || location.paths.length > 8 ||
      new Set(location.paths.map(parts => JSON.stringify(parts))).size !== location.paths.length ||
      !location.paths.every(parts => Array.isArray(parts) && parts.length >= 2 && parts.length <= 41 &&
        managedFolders.has(parts[0]) && parts.every(locationPart))) {
    throw errorWith('云端文件位置记录无效，请在同步设备上检查后重试。', 'UNSAFE_PATH');
  }
  return location.paths.map(parts => path.join(blobs, ...parts));
}

function sameBlob(a, b) { return a.sha256 === b.sha256 && a.byteCount === b.byteCount; }

async function matchesFile(blobs, file, blob) {
  if (!await status(file)) return false;
  let handle;
  try {
    handle = await openContainedFile(blobs, file);
    if ((await handle.stat()).size !== blob.byteCount) return false;
    return sameBlob(await transfer(handle), blob);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  } finally { await handle?.close(); }
}

const moveWithoutOverwrite = promisify(execFile);
const windowsMoveScript = Buffer.from([
  "$ErrorActionPreference = 'Stop'",
  '[System.IO.File]::Move($env:JIANCANG_MOVE_SOURCE, $env:JIANCANG_MOVE_TARGET)',
].join('\r\n'), 'utf16le').toString('base64');

async function publishSyncFileNoReplace(stage, target) {
  const parent = path.dirname(stage);
  if (!path.isAbsolute(stage) || !samePath(parent, path.dirname(target)) || samePath(stage, target)) {
    throw errorWith('无法安全发布同步文件。', 'UNSAFE_PATH');
  }
  await directoryIdentity(parent);
  const entry = await status(stage);
  if (!entry?.isFile() || entry.isSymbolicLink()) throw errorWith('无法打开待发布的同步文件。', 'UNSAFE_PATH');
  try { await fs.link(stage, target); }
  catch (error) {
    if (process.platform !== 'win32' || !windowsLinkErrors.has(error.code)) throw error;
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Keep names out of the script. A same-directory managed Move refuses to replace existing files.
    try {
      await moveWithoutOverwrite(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', windowsMoveScript], {
        env: { ...process.env, JIANCANG_MOVE_SOURCE: stage, JIANCANG_MOVE_TARGET: target },
        windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024,
      });
    } catch (moveError) {
      if (await status(target)) throw errorWith('同步文件已存在。', 'EEXIST');
      throw errorWith('云盘暂时无法发布同步文件，请稍后重试。', typeof moveError.code === 'string' ? moveError.code : 'SYNC_PENDING');
    }
  }
}

async function publishSyncOriginal({ root, libraryId, birthId, prepared, onProgress } = {}) {
  const { blob, file, fileExtension } = prepared ?? {};
  if (!uuid.test(birthId) || typeof file !== 'string' || !path.isAbsolute(file) || !stageName.test(path.basename(file)) ||
      typeof fileExtension !== 'string' || !extension.test(fileExtension) || !hash.test(blob?.sha256) || !validSize(blob?.byteCount)) {
    throw errorWith('同步原件或导入任务标识不正确。', 'INVALID_ORIGINAL');
  }
  const rootIdentity = await validateSyncWriteRoot(root, libraryId);
  const base = await ensureChild(root, rootIdentity, 'blobs');
  const incoming = await ensureChild(base.path, base.identity, '.incoming');
  const generation = `${blob.sha256}.${birthId}`;
  const target = path.join(incoming.path, fileExtension ? `${generation}.${fileExtension}` : generation);
  const temporary = path.join(incoming.path, `.materialshelf-publish-${randomUUID()}`);
  const sourceDirectory = path.dirname(file);
  await directoryIdentity(sourceDirectory);
  const source = await openContainedFile(sourceDirectory, file, blob.byteCount);
  let ownTemporary = false;
  try {
    const known = [...await mappedFiles(base.path, generation), target];
    for (const candidate of known) {
      if (!(await matchesFile(base.path, candidate, blob))) continue;
      if (!sameBlob(await transfer(source, null, onProgress), blob)) throw errorWith('本机暂存原件的校验未通过。', 'INVALID_ORIGINAL');
      if (rootIdentity !== await validateSyncWriteRoot(root, libraryId)) throw errorWith('同步目录位置已变化。', 'UNSAFE_PATH');
      return { published: false, file: candidate };
    }
    await validateDirectory(incoming.path, incoming.identity);
    const output = await fs.open(temporary, 'wx', 0o600);
    ownTemporary = true;
    try {
      if (!sameBlob(await transfer(source, output, onProgress), blob)) throw errorWith('本机暂存原件的校验未通过。', 'INVALID_ORIGINAL');
    } finally { await output.close(); }
    if (rootIdentity !== await validateSyncWriteRoot(root, libraryId)) throw errorWith('同步目录位置已变化。', 'UNSAFE_PATH');
    await validateDirectory(incoming.path, incoming.identity);
    try { await publishSyncFileNoReplace(temporary, target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!await matchesFile(base.path, target, blob)) throw errorWith('云端同一原件位置已被占用，请刷新后重试。', 'IMMUTABLE_COLLISION');
      return { published: false, file: target };
    }
    return { published: true, file: target };
  } finally {
    await source.close();
    if (ownTemporary) {
      await validateDirectory(incoming.path, incoming.identity).then(() => fs.rm(temporary, { force: true })).catch(() => {});
    }
  }
}

module.exports = { prepareSyncOriginal, publishSyncOriginal, publishSyncFileNoReplace, validateSyncWriteRoot };
