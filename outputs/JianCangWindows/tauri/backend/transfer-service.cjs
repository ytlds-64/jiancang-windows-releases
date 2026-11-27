'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { exportBatch } = require('../../batch-export.cjs');
const { isWithin, openContainedFile } = require('../../original-file.cjs');
const { exportAsset } = require('./media.cjs');

const ticketLifetime = 15 * 60_000;
const receiverGrace = 10 * 60_000;
const cleanupInterval = 60_000;
const maximumTickets = 64;
const ownerFile = '.jiancang-drag-owner';
const ticketName = /^drag-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;

function sameFile(before, after) {
  return after?.isFile() && !after.isSymbolicLink() &&
    before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.ctimeNs === after.ctimeNs && before.mtimeNs === after.mtimeNs;
}

function sameDirectory(before, after) {
  return after.isDirectory() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino;
}

async function checkedDirectory(directory) {
  const stamp = await fs.lstat(directory, { bigint: true });
  if (!stamp.isDirectory() || stamp.isSymbolicLink() || path.relative(directory, await fs.realpath(directory)) !== '') {
    throw new Error('无法打开真实的文件副本目录。');
  }
  return stamp;
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

class TransferService {
  constructor(library, downloads, { temporary = os.tmpdir(), now = Date.now } = {}) {
    this.library = library;
    this.downloads = downloads;
    this.temporary = temporary;
    this.now = now;
    this.ready = new Map();
    this.preparing = false;
    this.closed = false;
  }

  initialize() {
    this.starting ??= this.openCache().catch(error => {
      this.starting = null;
      throw error;
    });
    return this.starting;
  }

  async openCache() {
    const temporary = await fs.realpath(this.temporary);
    const profile = await fs.realpath(this.library.profile);
    this.scope = createHash('sha256').update(process.platform === 'win32' ? profile.toLowerCase() : profile)
      .digest('hex').slice(0, 16);
    const directory = path.join(temporary, 'JianCang-Drag-' + this.scope);
    await this.outsideLibraries(directory);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    this.cacheStamp = await checkedDirectory(directory);
    this.cache = directory;
    await this.sweep().catch(() => {});
    if (!this.closed) this.timer = setInterval(() => void this.sweep().catch(() => {}), cleanupInterval).unref();
  }

  async outsideLibraries(destination, includeChildren = false) {
    const roots = this.library.protectedRoots();
    const canonical = await Promise.all(roots.map(root => fs.realpath(root).catch(() => root)));
    if ([...roots, ...canonical].some(root => isWithin(root, destination) || includeChildren && isWithin(destination, root))) {
      throw new Error('文件副本目录必须位于素材库和应用数据目录之外。');
    }
  }

  async verifyCache() {
    if (!sameDirectory(this.cacheStamp, await checkedDirectory(this.cache))) {
      throw new Error('临时拖出目录已变化，请重新启动。');
    }
    await this.outsideLibraries(this.cache, true);
  }

  async ownership(directory, token) {
    if (path.dirname(directory) !== this.cache || ticketName.exec(path.basename(directory))?.[1] !== token) return null;
    const stamp = await checkedDirectory(directory);
    const marker = path.join(directory, ownerFile);
    const entry = await fs.lstat(marker);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 512) return null;
    const handle = await openContainedFile(directory, marker, entry.size);
    try {
      const data = JSON.parse(await handle.readFile('utf8'));
      if (data.version !== 1 || data.scope !== this.scope || data.token !== token ||
          !Number.isSafeInteger(data.pid) || data.pid <= 0 || data.pid > 0x7fffffff) return null;
      return { stamp, pid: data.pid, modified: entry.mtimeMs };
    } finally { await handle.close(); }
  }

  async touch(record, now) {
    const { directory, token, folderStamp } = record;
    const owner = await this.ownership(directory, token);
    if (!owner || owner.pid !== process.pid || !sameDirectory(folderStamp, owner.stamp)) {
      throw new Error('拖出副本已变化，请重新准备。');
    }
    const marker = path.join(directory, ownerFile);
    const handle = await fs.open(marker, constants.O_RDWR | (constants.O_NOFOLLOW || 0));
    try {
      if (!(await handle.stat()).isFile() || await fs.realpath(marker) !== marker) {
        throw new Error('拖出副本已变化，请重新准备。');
      }
      await handle.utimes(now / 1000, now / 1000);
    } finally { await handle.close(); }
  }

  async removeTicket(directory, token, expected) {
    await this.verifyCache();
    const owner = await this.ownership(directory, token);
    if (!owner || !sameDirectory(expected, owner.stamp)) return;
    const entries = (await fs.readdir(directory, { withFileTypes: true })).filter(item => item.name !== ownerFile);
    if (entries.filter(entry => entry.isFile()).length > 1 || entries.some(entry =>
      !entry.isFile() && !(entry.isDirectory() && /^\.jiancang-export-[a-z0-9]{6}$/i.test(entry.name)))) return;
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (!sameDirectory(expected, await checkedDirectory(directory))) return;
      await fs.rm(file, { recursive: entry.isDirectory(), force: true });
    }
    // Keep the ownership record if a receiver still has an open handle.
    if (!sameDirectory(expected, await checkedDirectory(directory))) return;
    await fs.unlink(path.join(directory, ownerFile));
    await fs.rmdir(directory);
  }

  sweep() {
    this.sweeping ??= this.prune().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  async prune() {
    if (!this.cache) return;
    await this.verifyCache();
    const now = this.now();
    for (const [token, record] of this.ready) {
      if (record.active || record.deleting || Math.max(record.expiresAt, record.retainUntil) > now) continue;
      record.deleting = true;
      try {
        await this.removeTicket(record.directory, token, record.folderStamp);
        this.ready.delete(token);
      } catch (error) {
        if (error.code === 'ENOENT') this.ready.delete(token);
        else record.deleting = false;
      }
    }

    for (const entry of await fs.readdir(this.cache, { withFileTypes: true })) {
      const token = ticketName.exec(entry.name)?.[1];
      if (!token || !entry.isDirectory() || entry.isSymbolicLink() || this.ready.has(token)) continue;
      const directory = path.join(this.cache, entry.name);
      const owner = await this.ownership(directory, token).catch(() => null);
      if (owner && now - owner.modified >= ticketLifetime && !processExists(owner.pid)) {
        await this.removeTicket(directory, token, owner.stamp).catch(() => {});
      }
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.starting?.catch(() => {});
    await this.sweeping?.catch(() => {});
    const now = this.now();
    for (const record of this.ready.values()) {
      if (!record.active && record.retainUntil <= now) record.expiresAt = now;
    }
    await this.sweep().catch(() => {});
  }

  async copyTo(original, destination) {
    const { asset, library } = original;
    let prepared;
    const result = await exportBatch({ items: [asset], destination, libraryRoots: this.library.protectedRoots(),
      signal: this.library.shutdown.signal,
      copy: async (_asset, target, roots) => {
        if (this.library.catalogs.get(library.registrationId) !== library) throw new Error('素材库已变更，请重新准备。');
        await exportAsset(original, target, [...roots, ...this.library.protectedRoots()]);
        prepared = target;
      },
    });
    if (!result.written) throw new Error(result.failed[0]?.message || '文件副本准备失败。');
    if (this.library.catalogs.get(library.registrationId) !== library) throw new Error('素材库已变更，请重新准备。');
    return prepared;
  }

  async prepare(id, registrationId) {
    if (this.closed) throw new Error('见藏正在退出。');
    if (this.preparing) throw new Error('正在准备另一份素材副本，请稍后再试。');
    this.preparing = true;
    let record;
    try {
      const original = this.library.original(id, registrationId);
      if (original.asset.trashed) throw new Error('请先从回收站恢复素材。');
      await this.initialize();
      this.library.shutdown.signal.throwIfAborted();
      await this.verifyCache();
      const token = randomUUID();
      const directory = path.join(this.cache, 'drag-' + token);
      await fs.mkdir(directory, { mode: 0o700 });
      const folderStamp = await checkedDirectory(directory);
      record = { token, directory, folderStamp, library: original.library };
      await fs.writeFile(path.join(directory, ownerFile), JSON.stringify({
        version: 1, scope: this.scope, token, pid: process.pid,
      }), { flag: 'wx', mode: 0o600 });

      record.file = await this.copyTo(original, directory);
      record.stamp = await fs.lstat(record.file, { bigint: true });
      if (!record.stamp.isFile() || record.stamp.isSymbolicLink()) {
        throw new Error('素材已变化，请重新准备。');
      }
      const now = this.now();
      await this.touch(record, now);
      if (this.closed || this.library.shutdown.signal.aborted) throw new Error('见藏正在退出。');
      record.active = false;
      record.retainUntil = 0;
      record.expiresAt = now + ticketLifetime;
      const valid = [...this.ready.values()].filter(row => row.expiresAt > now);
      if (valid.length >= maximumTickets) valid[0].expiresAt = now;
      this.ready.set(token, record);
      void this.sweep().catch(() => {});
      return { ok: true, token, expiresAt: record.expiresAt };
    } catch (error) {
      if (record) await this.removeTicket(record.directory, record.token, record.folderStamp).catch(() => {});
      throw error;
    } finally { this.preparing = false; }
  }

  async use(token) {
    const record = typeof token === 'string' && this.ready.get(token);
    const now = this.now();
    if (!record || this.closed || record.deleting || now >= record.expiresAt ||
        this.library.catalogs.get(record.library.registrationId) !== record.library) {
      throw new Error('拖出副本已失效，请重新准备。');
    }
    if (record.active) throw new Error('这份副本正在拖出。');
    record.active = true;
    try {
      await this.verifyCache();
      const actual = await fs.realpath(record.file);
      const stamp = await fs.lstat(record.file, { bigint: true });
      if (path.relative(actual, record.file) !== '' || !sameFile(record.stamp, stamp)) {
        throw new Error('拖出副本已变化，请重新准备。');
      }
      await this.touch(record, now);
      return record.file;
    } catch {
      record.active = false;
      record.expiresAt = now;
      throw new Error('拖出副本已变化，请重新准备。');
    }
  }

  async finish(token) {
    const record = typeof token === 'string' && this.ready.get(token);
    if (record?.active) {
      const now = this.now();
      record.retainUntil = now + receiverGrace;
      await this.touch(record, now).catch(() => {});
      record.active = false;
    }
    return { ok: true };
  }

  async forClipboard(id, registrationId) {
    if (!path.isAbsolute(this.downloads ?? '')) throw new Error('找不到 Windows 的下载文件夹。');
    const original = this.library.original(id, registrationId);
    if (original.asset.trashed) throw new Error('请先从回收站恢复素材。');
    const downloads = await fs.realpath(this.downloads);
    const destination = path.join(downloads, '见藏拖出');
    await this.outsideLibraries(destination);
    await fs.mkdir(destination, { recursive: true });
    await checkedDirectory(destination);
    return this.copyTo(original, destination);
  }
}

module.exports = { TransferService };

