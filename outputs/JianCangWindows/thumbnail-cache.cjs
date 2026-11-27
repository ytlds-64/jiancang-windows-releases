'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { openContainedFile } = require('./original-file.cjs');

const formatTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif', 'image/bmp', 'image/x-icon'];
const entryName = /^[a-f0-9]{64}\.thumb$/;
const temporaryName = /^[a-f0-9]{64}\.thumb\.[a-f0-9-]+\.tmp$/;
const MiB = 1024 ** 2;

function cacheFilename(key) {
  return createHash('sha256').update(key).digest('hex') + '.thumb';
}

function sourceStamp(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function thumbnailSourceRevision(original, sidecar) {
  return createHash('sha256').update(JSON.stringify([original ?? null, sidecar ?? null])).digest('hex');
}

function createThumbnailCache(directory, { maxBytes = 128 * MiB, maxEntries = 8192, maxEntryBytes = MiB } = {}) {
  let root;
  let rootIdentity;
  let startup;
  let writes = Promise.resolve();
  const entries = new Map();
  let total = 0;

  async function checkRoot() {
    const stat = await fs.lstat(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || rootIdentity !== `${stat.dev}:${stat.ino}` ||
        path.relative(root, await fs.realpath(root)) !== '') {
      throw new Error('缩略图缓存位置已变化，请重启见藏。');
    }
  }

  function forgetIndex(name) {
    const info = entries.get(name);
    if (info && entries.delete(name)) total -= info.size;
  }

  async function forget(name) {
    if (!entries.has(name)) return;
    try {
      await checkRoot();
      const file = path.join(root, name);
      const entry = await fs.lstat(file);
      if (entry.isFile() && !entry.isSymbolicLink()) await fs.unlink(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    forgetIndex(name);
  }

  async function makeRoom(bytes, newEntries) {
    while (total + bytes > maxBytes || entries.size + newEntries > maxEntries) {
      const oldest = entries.keys().next().value;
      if (!oldest) return false;
      await forget(oldest);
    }
    return true;
  }

  function initialize() {
    if (!startup) startup = (async () => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const real = await fs.realpath(directory);
      const info = await fs.lstat(directory, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      root = real;
      rootIdentity = `${info.dev}:${info.ino}`;
      await checkRoot();
      const found = [];
      const iterator = await fs.opendir(root);
      for await (const entry of iterator) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const file = path.join(root, entry.name);
        if (temporaryName.test(entry.name)) {
          await checkRoot();
          await fs.unlink(file).catch(() => {});
        } else if (entryName.test(entry.name)) {
          const stat = await fs.lstat(file).catch(() => null);
          if (!stat?.isFile() || stat.isSymbolicLink()) continue;
          if (stat.size <= 1 || stat.size > maxEntryBytes) {
            await checkRoot();
            await fs.unlink(file).catch(() => {});
          } else found.push([entry.name, { size: stat.size, modified: stat.mtimeMs }]);
        }
      }
      found.sort((a, b) => a[1].modified - b[1].modified);
      for (const [name, entry] of found) {
        entries.set(name, entry);
        total += entry.size;
      }
      await makeRoom(0, 0);
      return true;
    })().catch(() => false);
    return startup;
  }

  function serialized(action) {
    const current = writes.then(action);
    writes = current.catch(() => {});
    return current;
  }

  async function cacheContents() {
    if (!await initialize()) throw new Error('无法打开缩略图缓存，请检查应用权限。');
    await checkRoot();
    const files = [];
    const iterator = await fs.opendir(root);
    for await (const entry of iterator) {
      if ((!entryName.test(entry.name) && !temporaryName.test(entry.name)) || !entry.isFile()) continue;
      const stat = await fs.lstat(path.join(root, entry.name), { bigint: true }).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat?.isFile() && !stat.isSymbolicLink()) files.push({ name: entry.name, stat });
    }
    await checkRoot();
    return files;
  }

  function stats(files) {
    return { count: files.length, bytes: files.reduce((sum, file) => sum + Number(file.stat.size), 0) };
  }

  function status() {
    return serialized(async () => stats(await cacheContents()));
  }

  function clear() {
    return serialized(async () => {
      const files = await cacheContents();
      let removedCount = 0;
      let removedBytes = 0;
      let failedCount = 0;
      for (const { name, stat } of files) {
        await checkRoot();
        const file = path.join(root, name);
        try {
          const current = await fs.lstat(file, { bigint: true });
          if (!current.isFile() || current.isSymbolicLink() || sourceStamp(current) !== sourceStamp(stat)) {
            failedCount++;
            continue;
          }
          await fs.unlink(file);
          removedCount++;
          removedBytes += Number(stat.size);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            failedCount++;
            continue;
          }
        }
        forgetIndex(name);
      }
      const remaining = await cacheContents();
      return { ...stats(remaining), removedCount, removedBytes, failedCount };
    });
  }

  async function get(key) {
    if (!await initialize()) return null;
    const name = cacheFilename(key);
    const prior = entries.get(name);
    if (!prior) return null;
    let handle;
    let valid = false;
    try {
      handle = await openContainedFile(root, path.join(root, name), prior.size);
      const buffer = Buffer.allocUnsafe(prior.size);
      for (let offset = 0; offset < buffer.length;) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) return null;
        offset += bytesRead;
      }
      const type = formatTypes[buffer[0]];
      if (!type) return null;
      valid = true;
      // An overlapping insertion might already have evicted this entry.
      if (entries.get(name) === prior) {
        entries.delete(name);
        entries.set(name, prior);
      }
      return { bytes: buffer.subarray(1), type };
    } catch { return null; }
    finally {
      await handle?.close().catch(() => {});
      if (!valid) await serialized(async () => {
        if (entries.get(name) === prior) await forget(name);
      }).catch(() => {});
    }
  }

  function set(key, payload) {
    const kind = formatTypes.indexOf(payload.type);
    const size = payload.bytes.length + 1;
    if (kind < 0 || size <= 1 || size > maxEntryBytes || size > maxBytes || !maxEntries) return;
    const name = cacheFilename(key);
    return serialized(async () => {
      if (!await initialize() || entries.has(name) || !await makeRoom(size, 1)) return;
      await checkRoot();
      const file = path.join(root, name);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, Buffer.concat([Buffer.from([kind]), payload.bytes]), { flag: 'wx', mode: 0o600 });
        await checkRoot();
        await fs.rename(temporary, file);
        entries.set(name, { size });
        total += size;
      } finally {
        await checkRoot();
        await fs.rm(temporary, { force: true });
      }
    }).catch(() => null);
  }

  return { get, set, status, clear, warm: initialize };
}

module.exports = { createThumbnailCache, sourceStamp, thumbnailSourceRevision };
