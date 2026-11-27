'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isWithin, openContainedFile, readStableBytes } = require('./original-file.cjs');
const { LOCAL_MANIFEST, parseManifest, historyAssetRecords } = require('./local-library.cjs');

const inventoryName = 'backup.json';
const payloadName = 'payload';
const originalsName = 'originals';
const format = 'jiancang-local-backup';
const groupFormat = 'jiancang-local-backup-group';
const snapshotFormat = 'jiancang-local-backup-snapshot';
const groupName = '见藏增量备份';
const groupManifest = 'backup-group.json';
const jsonLimit = 128 * 1024 ** 2;
const hashPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const snapshotPattern = /^(\d{13})-([a-f0-9-]{36})$/;
const sourceChanged = () => new Error('复制期间源文件发生变化，请重试。');
const invalidBackup = () => new Error('备份不完整或校验失败，请重新选择完整的见藏备份文件夹。');
const invalidDirectory = () => new Error('文件夹路径已变化，请重新选择。');
const nameTaken = () => new Error('保存位置已有同名文件夹，请更改新素材库的名称。');
const writeErrors = {
  ENOSPC: '保存位置的空间不足，请换一个文件夹或释放空间后再试。',
  EDQUOT: '保存位置的可用空间不足，请换一个文件夹。',
  EACCES: '无法读写所选文件夹，请检查文件夹权限。',
  EPERM: '无法读写所选文件夹，请检查文件夹权限。',
  EROFS: '所选位置只可读取，请选择其他文件夹。',
  EBUSY: '文件夹正被其他应用使用，请稍后重试。',
  ENAMETOOLONG: '保存路径太长，请选择层级更少的文件夹。',
};

function identity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function stamp(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function openDirectory(root, expected) {
  const stat = await fs.lstat(root, { bigint: true });
  const id = identity(stat);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (expected && id !== expected) ||
      path.relative(root, await fs.realpath(root)) !== '') throw invalidDirectory();
  return id;
}

async function readFileStamp(root, file) {
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || path.relative(root, await fs.realpath(file)) !== path.relative(root, file) ||
      stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidDirectory();
  return { file, stamp: stamp(stat), bytes: Number(stat.size) };
}

async function readStableJSON(root, file, signal, limit = jsonLimit) {
  const entry = await readFileStamp(root, file);
  if (entry.bytes === 0 || entry.bytes > limit) throw invalidBackup();
  const handle = await openContainedFile(root, file, entry.bytes);
  try {
    if (stamp(await handle.stat({ bigint: true })) !== entry.stamp) throw sourceChanged();
    const bytes = await readStableBytes(handle, entry.bytes, limit, signal);
    if (!bytes) throw sourceChanged();
    await checkUnchanged(root, entry, handle);
    return { entry, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await handle.close();
  }
}

async function checkUnchanged(root, entry, handle) {
  if (stamp(await handle.stat({ bigint: true })) !== entry.stamp ||
      (await readFileStamp(root, entry.file)).stamp !== entry.stamp) throw sourceChanged();
}

function originalReferences(manifest) {
  const originals = new Map();
  function add(asset) {
    const { id, extension, fileVersion, byteCount } = asset;
    const versionSuffix = fileVersion ? `-${fileVersion}` : '';
    const extensionSuffix = extension ? `.${extension}` : '';
    const relative = `${originalsName}/${id}${versionSuffix}${extensionSuffix}`;
    const previous = originals.get(relative);
    if (previous && previous.byteCount !== byteCount) throw invalidBackup();
    if (!previous) originals.set(relative, { byteCount, name: asset.name });
  }
  for (const asset of Object.values(manifest.assets)) add(asset);
  for (const [, asset] of historyAssetRecords(manifest)) add(asset);
  return originals;
}

function packageEntry(relative, bytes, sha256) {
  return { path: relative, bytes, sha256 };
}

function readInventory(bytes, expectedFormat = format) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw invalidBackup(); }
  if (value?.format !== expectedFormat || value.version !== 1 || !uuidPattern.test(value.libraryId) ||
      typeof value.libraryName !== 'string' || !value.libraryName || !Array.isArray(value.files)) throw invalidBackup();
  const entries = new Map();
  for (const file of value.files) {
    if (typeof file?.path !== 'string' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        typeof file.sha256 !== 'string' || !hashPattern.test(file.sha256) || entries.has(file.path)) throw invalidBackup();
    entries.set(file.path, file);
  }
  return { ...value, entries };
}

function libraryFolderName(name) {
  const normalized = typeof name === 'string' ? name.trim().normalize('NFC') : '';
  if (!normalized || Array.from(normalized).length > 80 || /[<>:"/\\|?*\p{Cc}\p{Cs}]|[. ]$/u.test(normalized) ||
      /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])(?:\s*\.|$)/iu.test(normalized)) {
    throw new Error('请输入 1 到 80 个字符的有效文件夹名称。');
  }
  return normalized;
}

function backupFolderName(name) {
  const safe = Array.from(name.replace(/[<>:"/\\|?*\p{Cc}\p{Cs}]/gu, ' ').trim()).slice(0, 45).join('');
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
  return `见藏备份 ${safe ? `${safe} ` : ''}${timestamp}`;
}

async function resolveDestination(destination, protectedRoots) {
  const root = await fs.realpath(destination);
  for (const protectedRoot of protectedRoots) {
    const canonical = await fs.realpath(protectedRoot).catch(() => null);
    if (isWithin(path.resolve(protectedRoot), root) || (canonical && isWithin(canonical, root))) {
      throw new Error('请选择素材库和备份文件夹之外的保存位置。');
    }
  }
  return { root, id: await openDirectory(root) };
}

function progress(operation, onProgress) {
  const state = { operation, phase: 'reading', filesDone: 0, totalFiles: 0, bytesDone: 0, totalBytes: 0 };
  let lastReport = -Infinity;
  function report(force = false) {
    const now = performance.now();
    if (force || now - lastReport >= 100) {
      lastReport = now;
      onProgress?.({ ...state });
    }
  }
  report(true);
  return {
    start(phase, sizes) {
      state.phase = phase;
      state.totalFiles = sizes.length;
      state.totalBytes = sizes.reduce((total, size) => total + size, 0);
      report(true);
    },
    add(bytes) {
      state.bytesDone += bytes;
      report();
    },
    fileDone() {
      state.filesDone += 1;
      report();
    },
    finish() {
      state.phase = 'finishing';
      report(true);
    },
    get totals() { return { files: state.totalFiles, bytes: state.totalBytes }; },
  };
}

async function writeNewFile(file, bytes) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function copyFile(root, source, target, buffer, reporter, signal) {
  signal?.throwIfAborted();
  const sourceHandle = await openContainedFile(root, source.file, source.bytes);
  let targetHandle;
  try {
    if (stamp(await sourceHandle.stat({ bigint: true })) !== source.stamp) throw sourceChanged();
    targetHandle = await fs.open(target, 'wx', 0o600);
    const digest = createHash('sha256');
    let position = 0;
    while (position < source.bytes) {
      signal?.throwIfAborted();
      const count = Math.min(buffer.length, source.bytes - position);
      const { bytesRead } = await sourceHandle.read(buffer, 0, count, position);
      if (bytesRead === 0) throw sourceChanged();
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await targetHandle.write(buffer, written, bytesRead - written, position + written);
        if (bytesWritten === 0) throw new Error('未能写入完整文件。');
        written += bytesWritten;
      }
      position += bytesRead;
      reporter.add(bytesRead);
    }
    await checkUnchanged(root, source, sourceHandle);
    await targetHandle.sync();
    return digest.digest('hex');
  } finally {
    await Promise.all([sourceHandle.close(), targetHandle?.close()]);
  }
}

async function stageOperation(destination, action) {
  let stage;
  let id;
  try {
    await openDirectory(destination.root, destination.id);
    stage = await fs.mkdtemp(path.join(destination.root, '.jiancang-backup-'));
    id = await openDirectory(stage);
    return await action(stage, id);
  } catch (error) {
    if (Object.hasOwn(writeErrors, error.code)) throw new Error(writeErrors[error.code]);
    throw error;
  } finally {
    if (id && await openDirectory(stage).catch(() => null) === id) {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function inventoryBytes(inventory) {
  const bytes = Buffer.from(JSON.stringify(inventory), 'utf8');
  if (bytes.length > jsonLimit) throw new Error('备份清单超过大小上限。');
  return bytes;
}

async function publish(destination, stage, stageId, folderName, entries, signal, allowSuffix = false) {
  let directory;
  for (let index = 1; ; index++) {
    const candidate = path.join(destination.root, index === 1 ? folderName : `${folderName}（${index}）`);
    signal?.throwIfAborted();
    await openDirectory(destination.root, destination.id);
    try {
      await fs.mkdir(candidate, { mode: 0o700 });
      directory = candidate;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!allowSuffix) throw nameTaken();
    }
  }
  const id = await openDirectory(directory);
  const moved = [];
  try {
    for (const entry of entries) {
      signal?.throwIfAborted();
      await openDirectory(stage, stageId);
      await openDirectory(directory, id);
      const from = path.join(stage, entry);
      const to = path.join(directory, entry);
      const entryId = identity(await fs.lstat(from, { bigint: true }));
      await fs.rename(from, to);
      moved.push({ to, entryId });
    }
    return directory;
  } catch (error) {
    if (await openDirectory(directory).catch(() => null) === id) {
      for (const { to, entryId } of moved) {
        const stat = await fs.lstat(to, { bigint: true }).catch(() => null);
        if (stat && identity(stat) === entryId) await fs.rm(to, { recursive: true, force: true }).catch(() => {});
      }
      await fs.rmdir(directory).catch(() => {});
    }
    throw error;
  }
}

async function readLibraryForBackup(root, expectedLibraryId, signal) {
  root = path.resolve(root);
  signal?.throwIfAborted();
  const rootId = await openDirectory(root);
  const originalRoot = path.join(root, originalsName);
  const originalsId = await openDirectory(originalRoot);
  const sourceManifest = await readStableJSON(root, path.join(root, LOCAL_MANIFEST), signal);
  const manifest = parseManifest(sourceManifest.bytes.toString('utf8'));
  if (expectedLibraryId !== undefined && manifest.libraryId !== expectedLibraryId) {
    throw new Error('本地素材库的位置已变化，请重新连接。');
  }
  const references = originalReferences(manifest);
  return { root, sourceManifest, manifest, references, async checkUnchanged() {
    await openDirectory(root, rootId);
    await openDirectory(originalRoot, originalsId);
    if ((await readFileStamp(root, sourceManifest.entry.file)).stamp !== sourceManifest.entry.stamp) {
      throw new Error('备份期间素材库有改动，请在整理完成后重试。');
    }
  } };
}

async function backupOriginal(root, relative, item) {
  const source = await readFileStamp(root, path.join(root, relative)).catch(() => null);
  if (!source || source.bytes !== item.byteCount) {
    throw new Error(`「${Array.from(item.name).slice(0, 100).join('')}」的原件不可用，请找回原件后重试。`);
  }
  return source;
}

async function createLocalBackup({ root, expectedLibraryId, destination, protectedRoots = [], signal, onProgress }) {
  const reporter = progress('backup', onProgress);
  const library = await readLibraryForBackup(root, expectedLibraryId, signal);
  const { sourceManifest, manifest, references } = library;
  const target = await resolveDestination(destination, [...protectedRoots, library.root]);
  reporter.start('copying', [sourceManifest.entry.bytes, ...Array.from(references.values(), item => item.byteCount)]);
  return stageOperation(target, async (stage, stageId) => {
    const payload = path.join(stage, payloadName);
    await fs.mkdir(payload, { mode: 0o700 });
    await fs.mkdir(path.join(payload, originalsName), { mode: 0o700 });
    await writeNewFile(path.join(payload, LOCAL_MANIFEST), sourceManifest.bytes);
    reporter.add(sourceManifest.entry.bytes);
    reporter.fileDone();
    const files = [packageEntry(LOCAL_MANIFEST, sourceManifest.entry.bytes, sourceManifest.sha256)];
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (const [relative, item] of references) {
      signal?.throwIfAborted();
      const source = await backupOriginal(library.root, relative, item);
      const sha256 = await copyFile(library.root, source, path.join(payload, relative), buffer, reporter, signal);
      files.push(packageEntry(relative, source.bytes, sha256));
      reporter.fileDone();
    }
    signal?.throwIfAborted();
    await library.checkUnchanged();
    const inventory = { format, version: 1, createdAt: new Date().toISOString(), libraryName: manifest.name, libraryId: manifest.libraryId, files };
    reporter.finish();
    await writeNewFile(path.join(stage, inventoryName), inventoryBytes(inventory));
    const dirname = backupFolderName(manifest.name);
    const directory = await publish(target, stage, stageId, dirname, [payloadName, inventoryName], signal, true);
    return { ok: true, directory, name: manifest.name, ...reporter.totals };
  });
}

async function openBackupGroup(backupRoot, expectedGroupId, signal) {
  const root = path.resolve(backupRoot);
  const id = await openDirectory(root);
  const marker = await readStableJSON(root, path.join(root, groupManifest), signal, 4096);
  let description;
  try { description = JSON.parse(marker.bytes.toString('utf8')); }
  catch { throw invalidBackup(); }
  const { format: kind, version, groupId, libraryId } = description ?? {};
  if (kind !== groupFormat || version !== 1 || !uuidPattern.test(groupId) || !uuidPattern.test(libraryId) ||
      (expectedGroupId && groupId !== expectedGroupId)) throw invalidBackup();
  const objects = path.join(root, 'objects');
  const snapshots = path.join(root, 'snapshots');
  const [objectsId, snapshotsId] = await Promise.all([openDirectory(objects), openDirectory(snapshots)]);
  return { root, id, groupId, libraryId, objects, snapshots, async checkUnchanged() {
    await openDirectory(root, id);
    await openDirectory(objects, objectsId);
    await openDirectory(snapshots, snapshotsId);
    if ((await readFileStamp(root, marker.entry.file)).stamp !== marker.entry.stamp) throw sourceChanged();
  } };
}

async function prepareLocalBackupGroup({ destination, libraryId, protectedRoots = [], signal }) {
  signal?.throwIfAborted();
  if (!uuidPattern.test(libraryId)) throw new Error('请选择一个见藏本地库。');
  const target = await resolveDestination(destination, protectedRoots);
  const selectedGroup = await fs.lstat(path.join(target.root, groupManifest)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (selectedGroup) {
    const group = await openBackupGroup(target.root, undefined, signal);
    if (group.libraryId !== libraryId) throw new Error('备份文件夹属于另一份素材库。请选择其他位置。');
    return { directory: group.root, groupId: group.groupId };
  }
  const name = `${groupName} ${libraryId}`;
  const root = path.join(target.root, name);
  for (const protectedRoot of protectedRoots) {
    const canonical = await fs.realpath(protectedRoot).catch(() => null);
    if (isWithin(root, path.resolve(protectedRoot)) || (canonical && isWithin(root, canonical))) {
      throw new Error('请选择素材库和备份文件夹之外的保存位置。');
    }
  }
  const existing = await fs.lstat(root).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!existing) {
    await stageOperation(target, async (stage, stageId) => {
      const groupId = randomUUID();
      await fs.mkdir(path.join(stage, 'objects'), { mode: 0o700 });
      await fs.mkdir(path.join(stage, 'snapshots'), { mode: 0o700 });
      await writeNewFile(path.join(stage, groupManifest), JSON.stringify({ format: groupFormat, version: 1, groupId, libraryId }));
      await publish(target, stage, stageId, name, ['objects', 'snapshots', groupManifest], signal);
    });
  }
  const group = await openBackupGroup(root, undefined, signal);
  if (group.libraryId !== libraryId) throw new Error('备份文件夹属于另一份素材库。请选择其他位置。');
  return { directory: group.root, groupId: group.groupId };
}

function snapshotDate(id) {
  if (typeof id !== 'string') return null;
  const match = snapshotPattern.exec(id);
  return match && uuidPattern.test(match[2]) ? new Date(Number(match[1])).toISOString() : null;
}

async function groupSnapshots(group) {
  const names = await fs.readdir(group.snapshots, { withFileTypes: true });
  return names.flatMap(entry => {
    if (!entry.isFile() || !entry.name.endsWith('.json')) return [];
    const id = entry.name.slice(0, -5);
    const createdAt = snapshotDate(id);
    return createdAt ? [{ id, createdAt }] : [];
  }).sort((left, right) => left.id < right.id ? 1 : left.id > right.id ? -1 : 0);
}

async function listLocalBackupSnapshots(backupRoot, { expectedGroupId, signal } = {}) {
  try {
    const group = await openBackupGroup(backupRoot, expectedGroupId, signal);
    const snapshots = await groupSnapshots(group);
    await group.checkUnchanged();
    return { directory: group.root, groupId: group.groupId, snapshots };
  } catch {
    signal?.throwIfAborted();
    throw new Error('无法读取增量备份，请选择包含备份清单的增量备份文件夹。');
  }
}

async function readSnapshot(group, id, signal) {
  const createdAt = snapshotDate(id);
  if (!createdAt) throw invalidBackup();
  const receipt = await readStableJSON(group.snapshots, path.join(group.snapshots, `${id}.json`), signal);
  const inventory = readInventory(receipt.bytes, snapshotFormat);
  if (inventory.createdAt !== createdAt || inventory.groupId !== group.groupId || inventory.libraryId !== group.libraryId) {
    throw invalidBackup();
  }
  return { receipt, inventory };
}

async function readObjectHash(root, entry, signal) {
  const handle = await openContainedFile(root, entry.file, entry.bytes);
  try {
    signal?.throwIfAborted();
    if (stamp(await handle.stat({ bigint: true })) !== entry.stamp) throw sourceChanged();
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) hash.update(chunk);
    await checkUnchanged(root, entry, handle);
    return hash.digest('hex');
  } finally { await handle.close(); }
}

async function createIncrementalLocalBackup({ root, expectedLibraryId, groupRoot, expectedGroupId,
  protectedRoots = [], signal, onProgress }) {
  const reporter = progress('backup', onProgress);
  const library = await readLibraryForBackup(root, expectedLibraryId, signal);
  const { manifest, sourceManifest, references } = library;
  const target = await resolveDestination(groupRoot, [...protectedRoots, library.root]);
  const group = await openBackupGroup(target.root, expectedGroupId, signal);
  if (group.libraryId !== manifest.libraryId || group.id !== target.id || isWithin(group.root, library.root)) throw invalidBackup();
  const [latest] = await groupSnapshots(group);
  const previous = latest && (await readSnapshot(group, latest.id, signal).catch(() => null))?.inventory;
  signal?.throwIfAborted();
  reporter.start('copying', [sourceManifest.entry.bytes, ...Array.from(references.values(), item => item.byteCount)]);

  return stageOperation(target, async (stage, stageId) => {
    const pending = new Map();
    const verified = new Map();
    const sourceFiles = [];
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const temp = path.join(stage, 'object.tmp');

    async function reusableObject(sha256, bytes, originalStamp) {
      if (pending.has(sha256)) return pending.get(sha256) === bytes;
      if (verified.has(sha256)) return verified.get(sha256).bytes === bytes;
      const object = await readFileStamp(group.objects, path.join(group.objects, sha256)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (object?.bytes !== bytes || (object.stamp !== originalStamp &&
          await readObjectHash(group.objects, object, signal) !== sha256)) return false;
      verified.set(sha256, object);
      return true;
    }

    async function stageObject(sha256, bytes) {
      const staged = path.join(stage, sha256);
      await fs.rename(temp, staged);
      pending.set(sha256, bytes);
    }

    const files = [packageEntry(LOCAL_MANIFEST, sourceManifest.entry.bytes, sourceManifest.sha256)];
    if (!await reusableObject(sourceManifest.sha256, sourceManifest.entry.bytes, previous?.entries.get(LOCAL_MANIFEST)?.objectStamp)) {
      await writeNewFile(temp, sourceManifest.bytes);
      await stageObject(sourceManifest.sha256, sourceManifest.entry.bytes);
    }
    reporter.add(sourceManifest.entry.bytes);
    reporter.fileDone();

    for (const [relative, item] of references) {
      signal?.throwIfAborted();
      const source = await backupOriginal(library.root, relative, item);
      sourceFiles.push(source);
      const old = previous?.entries.get(relative);
      let sha256;
      if (old?.sourceStamp === source.stamp && old.bytes === source.bytes &&
          await reusableObject(old.sha256, old.bytes, old.objectStamp)) {
        sha256 = old.sha256;
        reporter.add(source.bytes);
      } else {
        sha256 = await copyFile(library.root, source, temp, buffer, reporter, signal);
        if (await reusableObject(sha256, source.bytes, old?.sha256 === sha256 ? old.objectStamp : undefined)) await fs.unlink(temp);
        else await stageObject(sha256, source.bytes);
      }
      files.push({ ...packageEntry(relative, source.bytes, sha256), sourceStamp: source.stamp });
      reporter.fileDone();
    }

    for (const source of sourceFiles) {
      signal?.throwIfAborted();
      if ((await readFileStamp(library.root, source.file)).stamp !== source.stamp) throw sourceChanged();
    }
    await library.checkUnchanged();
    reporter.finish();
    signal?.throwIfAborted();
    await group.checkUnchanged();
    const unchanged = previous?.entries.size === files.length && files.every(entry => {
      const old = previous.entries.get(entry.path);
      return old?.sha256 === entry.sha256 && old.bytes === entry.bytes;
    });
    const now = Date.now();
    const snapshot = unchanged ? latest : { id: `${String(now).padStart(13, '0')}-${randomUUID()}`, createdAt: new Date(now).toISOString() };
    const bytesWritten = Array.from(pending.values()).reduce((total, bytes) => total + bytes, 0);
    for (const [sha256] of pending) {
      signal?.throwIfAborted();
      await openDirectory(stage, stageId);
      await group.checkUnchanged();
      const targetFile = path.join(group.objects, sha256);
      await fs.rename(path.join(stage, sha256), targetFile);
      const object = await readFileStamp(group.objects, targetFile);
      verified.set(sha256, object);
    }
    if (!unchanged) {
      const inventory = { format: snapshotFormat, version: 1, groupId: group.groupId, createdAt: snapshot.createdAt,
        libraryName: manifest.name, libraryId: manifest.libraryId,
        files: files.map(entry => ({ ...entry, objectStamp: verified.get(entry.sha256).stamp })) };
      await writeNewFile(temp, inventoryBytes(inventory));
      signal?.throwIfAborted();
      await group.checkUnchanged();
      await fs.rename(temp, path.join(group.snapshots, `${snapshot.id}.json`));
    }
    return { ok: true, directory: group.root, name: manifest.name, snapshot, unchanged, bytesWritten,
      objectsWritten: pending.size, ...reporter.totals };
  });
}

async function openFullArchive(backupRoot, signal) {
  const backupId = await openDirectory(backupRoot);
  const payload = path.join(backupRoot, payloadName);
  const originals = path.join(payload, originalsName);
  const [payloadId, originalsId] = await Promise.all([openDirectory(payload), openDirectory(originals)]);
  const inventoryFile = await readStableJSON(backupRoot, path.join(backupRoot, inventoryName), signal);
  const inventory = readInventory(inventoryFile.bytes);
  const sourceManifest = await readStableJSON(payload, path.join(payload, LOCAL_MANIFEST), signal);
  return { root: payload, sourceManifest, inventory, sourcePath: relative => path.join(payload, relative), async checkUnchanged() {
    await openDirectory(backupRoot, backupId);
    await openDirectory(payload, payloadId);
    await openDirectory(originals, originalsId);
    if ((await readFileStamp(backupRoot, inventoryFile.entry.file)).stamp !== inventoryFile.entry.stamp ||
        (await readFileStamp(payload, sourceManifest.entry.file)).stamp !== sourceManifest.entry.stamp) throw sourceChanged();
  } };
}

async function openIncrementalArchive(backupRoot, snapshotId, expectedGroupId, signal) {
  const group = await openBackupGroup(backupRoot, expectedGroupId, signal);
  const { receipt, inventory } = await readSnapshot(group, snapshotId, signal);
  const sourcePath = relative => {
    const entry = inventory.entries.get(relative);
    if (!entry) throw invalidBackup();
    return path.join(group.objects, entry.sha256);
  };
  const sourceManifest = await readStableJSON(group.objects, sourcePath(LOCAL_MANIFEST), signal);
  return { root: group.objects, sourceManifest, inventory, sourcePath, async checkUnchanged() {
    await group.checkUnchanged();
    if ((await readFileStamp(group.snapshots, receipt.entry.file)).stamp !== receipt.entry.stamp ||
        (await readFileStamp(group.objects, sourceManifest.entry.file)).stamp !== sourceManifest.entry.stamp) throw sourceChanged();
  } };
}

async function restoreLocalBackup({ backupRoot, snapshotId, expectedGroupId, destination, name, protectedRoots = [], signal, onProgress }) {
  const reporter = progress('restore', onProgress);
  const libraryName = libraryFolderName(name);
  backupRoot = path.resolve(backupRoot);
  signal?.throwIfAborted();
  const target = await resolveDestination(destination, [...protectedRoots, backupRoot]);
  const existing = await fs.lstat(path.join(target.root, libraryName)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) throw nameTaken();
  let archive;
  let manifest;
  try {
    archive = snapshotId === undefined ? await openFullArchive(backupRoot, signal) :
      await openIncrementalArchive(backupRoot, snapshotId, expectedGroupId, signal);
    const { inventory, sourceManifest } = archive;
    const manifestReceipt = inventory.entries.get(LOCAL_MANIFEST);
    if (manifestReceipt?.bytes !== sourceManifest.entry.bytes || manifestReceipt.sha256 !== sourceManifest.sha256) throw invalidBackup();
    manifest = parseManifest(sourceManifest.bytes.toString('utf8'));
    if (manifest.libraryId !== inventory.libraryId || manifest.name !== inventory.libraryName) throw invalidBackup();
  } catch {
    signal?.throwIfAborted();
    throw invalidBackup();
  }
  const { inventory, sourceManifest } = archive;
  const references = originalReferences(manifest);
  if (inventory.entries.size !== references.size + 1 ||
      Array.from(references).some(([relative, item]) => inventory.entries.get(relative)?.bytes !== item.byteCount)) throw invalidBackup();
  reporter.start('verifying', [sourceManifest.entry.bytes, ...Array.from(references.values(), item => item.byteCount)]);
  reporter.add(sourceManifest.entry.bytes);
  reporter.fileDone();
  return stageOperation(target, async (stage, stageId) => {
    await fs.mkdir(path.join(stage, originalsName), { mode: 0o700 });
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (const [relative, item] of references) {
      signal?.throwIfAborted();
      const source = await readFileStamp(archive.root, archive.sourcePath(relative)).catch(() => null);
      if (!source || source.bytes !== item.byteCount) throw invalidBackup();
      const sha256 = await copyFile(archive.root, source, path.join(stage, relative), buffer, reporter, signal);
      if (sha256 !== inventory.entries.get(relative).sha256) throw invalidBackup();
      reporter.fileDone();
    }
    signal?.throwIfAborted();
    await archive.checkUnchanged();
    const libraryId = randomUUID();
    const updated = Buffer.from(JSON.stringify({ ...manifest, libraryId, name: libraryName }), 'utf8');
    if (updated.length > jsonLimit) throw new Error('新素材库的目录信息超过大小上限。');
    reporter.finish();
    await writeNewFile(path.join(stage, LOCAL_MANIFEST), updated);
    const directory = await publish(target, stage, stageId, libraryName, [originalsName, LOCAL_MANIFEST], signal);
    return { ok: true, directory, libraryId, name: libraryName, ...reporter.totals };
  });
}

module.exports = { createLocalBackup, restoreLocalBackup, prepareLocalBackupGroup, createIncrementalLocalBackup, listLocalBackupSnapshots };
