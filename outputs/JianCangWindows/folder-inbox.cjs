'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const { isWithin, openContainedFile } = require('./original-file.cjs');
const { inLibrary } = require('./local-workflow.cjs');

const control = /[\u0000-\u001f\u007f]/;
const targetPattern = /^[a-f0-9-]{1,64}$/i;
const maximumWatches = 16;
const maximumEntries = 10_000;
const maximumBatch = 128;

function textPath(value) {
  return typeof value === 'string' && value.length <= 32767 && !control.test(value) && path.isAbsolute(value);
}

function overlaps(left, right) { return isWithin(left, right) || isWithin(right, left); }

function digest(...values) { return createHash('sha256').update(JSON.stringify(values)).digest('hex'); }

function directoryStamp(stat) { return [stat.dev, stat.ino, stat.birthtimeNs].join(':'); }

function fileStamp(stat) {
  return [stat.dev, stat.ino, stat.birthtimeNs, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function visibleName(name) {
  return !control.test(name) && !name.startsWith('.') && !name.startsWith('~$') &&
    !/^(?:thumbs\.db|desktop\.ini)$/i.test(name) &&
    !/\.(?:tmp|temp|swp|partial|part|download|crdownload|filepart|opdownload|icloud)$/i.test(name);
}

async function rootIdentity(directory) {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(await fs.realpath(directory), directory) !== '') {
    throw new Error('监控文件夹的位置已变化，请重新选择。');
  }
  return directoryStamp(stat);
}

async function openInboxOriginal(source) {
  if (await rootIdentity(source.root) !== source.inboxRootStamp) throw new Error('监控文件夹的位置已变化，请重新选择。');
  const handle = await openContainedFile(source.root, source.path);
  async function stat() {
    const current = await handle.stat({ bigint: true });
    if (fileStamp(current) !== source.inboxStamp || await rootIdentity(source.root) !== source.inboxRootStamp) {
      throw new Error('这份文件在加入队列后发生了变化，稳定后会重新加入队列。');
    }
    return current;
  }
  try {
    await stat();
    return { fd: handle.fd, stat, read: (...args) => handle.read(...args), close: () => handle.close() };
  } catch (error) { await handle.close(); throw error; }
}

async function snapshot(directory, identity, recursive) {
  if (await rootIdentity(directory) !== identity) throw new Error('监控文件夹的位置已变化，请重新选择。');
  const files = new Map();
  let inspected = 0;

  async function walk(parent, depth) {
    if (depth > 32) throw new Error('监控文件夹层级过深，请选择范围较小的文件夹。');
    const directoryEntry = await fs.opendir(parent);
    for await (const entry of directoryEntry) {
      if (++inspected > maximumEntries) throw new Error('监控范围超过 10,000 项，请选择范围较小的文件夹。');
      if (!visibleName(entry.name) || (!entry.isFile() && !entry.isDirectory())) continue;
      const absolute = path.join(parent, entry.name);
      const stat = await fs.lstat(absolute, { bigint: true }).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat || stat.isSymbolicLink()) continue;
      const resolved = await fs.realpath(absolute).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!resolved || path.relative(resolved, absolute) !== '') continue;
      if (stat.isFile()) files.set(path.relative(directory, absolute), { path: absolute, stamp: fileStamp(stat) });
      else if (stat.isDirectory() && recursive && !await inLibrary(absolute)) await walk(absolute, depth + 1);
    }
  }

  await walk(directory, 0);
  if (await rootIdentity(directory) !== identity) throw new Error('监控文件夹的位置已变化，请重新选择。');
  return files;
}

function errorMessage(error) {
  if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return '监控文件夹暂不可用，请检查磁盘或连接。';
  if (['EPERM', 'EACCES'].includes(error?.code)) return '无法读取监控文件夹，请检查访问权限。';
  if (error?.code === 'ENOSPC') return '本机磁盘空间不足。';
  return typeof error?.message === 'string' && /\p{Script=Han}/u.test(error.message) && !error.path
    ? error.message.slice(0, 160) : '监控检查未完成，可以再次检查。';
}

class FolderInbox {
  #db;
  #timer;
  #closed = false;
  #adding = Promise.resolve();
  #polling = false;
  #running = new Map();
  #seen = new Map();

  constructor({ directory, enqueue, getTarget, getProtectedRoots, onChange, pollMs = 2500, quietMs = 1400 } = {}) {
    if (!textPath(directory) || typeof enqueue !== 'function' || typeof getTarget !== 'function' || typeof getProtectedRoots !== 'function') {
      throw new TypeError('Folder inbox configuration is invalid');
    }
    Object.assign(this, { directory, enqueue, getTarget, getProtectedRoots, onChange, pollMs, quietMs });
  }

  async initialize() {
    if (this.#db) return;
    if (this.#closed) throw new Error('文件夹监控已关闭。');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(this.directory)).isDirectory()) throw new Error('无法打开文件夹监控设置。');
    const root = await fs.realpath(this.directory);
    const databaseFile = path.join(root, 'folder-inbox.sqlite');
    for (const file of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`, `${databaseFile}-journal`]) {
      const stat = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (stat && !stat.isFile()) throw new Error('无法打开文件夹监控设置。');
    }
    const db = new DatabaseSync(databaseFile);
    try {
      if (db.prepare('PRAGMA user_version').get().user_version > 1) throw new Error('请使用更新版本的见藏打开文件夹监控。');
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS watches (
          id TEXT PRIMARY KEY, source TEXT NOT NULL UNIQUE, root_stamp TEXT NOT NULL, target_id TEXT NOT NULL,
          collection_id TEXT, recursive INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
          queued INTEGER NOT NULL DEFAULT 0, waiting INTEGER NOT NULL DEFAULT 0, last_scan INTEGER, error TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS files (
          watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
          relative TEXT NOT NULL, stamp TEXT NOT NULL, PRIMARY KEY(watch_id, relative)
        ) WITHOUT ROWID;
        PRAGMA user_version = 1;
      `);
      this.#db = db;
    } catch (error) { db.close(); throw error; }
    if (this.pollMs > 0) {
      this.#timer = setInterval(() => void this.#poll(), this.pollMs);
      this.#timer.unref?.();
    }
  }

  list() {
    return (this.#db?.prepare('SELECT * FROM watches ORDER BY rowid').all() ?? []).map(row => this.#public(row));
  }

  #public(row) {
    return {
      id: row.id, sourcePath: row.source, targetId: row.target_id, collectionId: row.collection_id,
      recursive: !!row.recursive, paused: !!row.paused, queued: row.queued, waiting: row.waiting,
      lastScan: row.last_scan, error: row.error,
      status: row.paused ? 'paused' : this.#running.has(row.id) ? 'checking' : row.error ? 'error' : 'watching',
    };
  }

  #get(id) { return typeof id === 'string' ? this.#db?.prepare('SELECT * FROM watches WHERE id = ?').get(id) : null; }

  #notify() { try { this.onChange?.(); } catch { /* Status subscriptions do not control imports. */ } }

  async #assertSource(source) {
    const roots = [path.dirname(this.directory), ...await this.getProtectedRoots()];
    for (const root of roots) {
      if (!textPath(root)) continue;
      const resolved = await fs.realpath(root).catch(() => path.resolve(root));
      if (overlaps(resolved, source)) throw new Error('请选择与素材库或应用数据目录分开的文件夹。');
    }
    if (await inLibrary(source)) throw new Error('请选择素材库之外的文件夹。');
  }

  add(request) {
    const result = this.#adding.then(() => this.#add(request));
    this.#adding = result.catch(() => {});
    return result;
  }

  async #add({ sourcePath, targetId, collectionId = null, recursive = false, includeExisting = false } = {}) {
    if (!this.#db || this.#closed) throw new Error('文件夹监控尚未准备好。');
    if (!textPath(sourcePath) || !targetPattern.test(targetId || '') || (collectionId !== null &&
        (typeof collectionId !== 'string' || !collectionId.trim() || collectionId.length > 256 || control.test(collectionId)))) {
      throw new Error('请选择监控文件夹和有效的目标集合。');
    }
    if (!await this.getTarget({ targetId, collectionId })) throw new Error('请选择可用的见藏素材库与集合。');
    const stat = await fs.lstat(sourcePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('请选择实际的文件夹。');
    const source = await fs.realpath(sourcePath);
    await this.#assertSource(source);
    const existing = this.list();
    if (existing.length >= maximumWatches) throw new Error('最多可监控 16 个文件夹。');
    if (existing.some(row => overlaps(row.sourcePath, source))) throw new Error('这个文件夹或其中一层目录已在监控。');
    const identity = await rootIdentity(source);
    const ignored = includeExisting ? new Map() : await snapshot(source, identity, recursive === true);
    if (this.#closed) throw new Error('文件夹监控已关闭。');
    const id = randomUUID();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('INSERT INTO watches (id, source, root_stamp, target_id, collection_id, recursive) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, source, identity, targetId, collectionId, recursive === true ? 1 : 0);
      const insert = this.#db.prepare('INSERT INTO files (watch_id, relative, stamp) VALUES (?, ?, ?)');
      for (const [relative, item] of ignored) insert.run(id, relative, item.stamp);
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    this.#notify();
    return this.#public(this.#get(id));
  }

  async setPaused(id, paused) {
    if (!this.#get(id) || typeof paused !== 'boolean') throw new Error('这个监控文件夹已不存在。');
    this.#db.prepare('UPDATE watches SET paused = ?, waiting = 0 WHERE id = ?').run(paused ? 1 : 0, id);
    this.#seen.delete(id);
    this.#notify();
    return this.#public(this.#get(id));
  }

  async remove(id) {
    if (!this.#get(id)) throw new Error('这个监控文件夹已不存在。');
    this.#db.prepare('DELETE FROM watches WHERE id = ?').run(id);
    this.#seen.delete(id);
    this.#notify();
  }

  scan(id) {
    const watch = this.#get(id);
    if (!watch || this.#closed) return Promise.reject(new Error('这个监控文件夹已不存在。'));
    if (watch.paused) return Promise.resolve(this.#public(watch));
    if (this.#running.has(id)) return this.#running.get(id);
    const check = Promise.resolve().then(() => this.#scan(watch)).finally(() => {
      this.#running.delete(id);
      this.#notify();
    }).then(() => this.#get(id) ? this.#public(this.#get(id)) : null);
    this.#running.set(id, check);
    this.#notify();
    return check;
  }

  async #scan(watch) {
    try {
      const target = { targetId: watch.target_id, collectionId: watch.collection_id };
      if (!await this.getTarget(target)) throw new Error('目标素材库或集合暂不可用。');
      await this.#assertSource(watch.source);
      const sources = await snapshot(watch.source, watch.root_stamp, !!watch.recursive);
      if (!this.#active(watch.id)) return;
      const seen = this.#seen.get(watch.id) ?? new Map();
      const next = new Map();
      const now = performance.now();
      const ledger = this.#db.prepare('SELECT stamp FROM files WHERE watch_id = ? AND relative = ?');
      const ready = [];
      let waiting = 0;
      for (const [relative, item] of sources) {
        if (ledger.get(watch.id, relative)?.stamp === item.stamp) continue;
        const prior = seen.get(relative);
        const unchanged = prior?.stamp === item.stamp;
        next.set(relative, { stamp: item.stamp, since: unchanged ? prior.since : now });
        if (!unchanged || now - prior.since < this.quietMs || ready.length >= maximumBatch) waiting++;
        else ready.push({ relative, ...item });
      }
      this.#seen.set(watch.id, next);
      if (ready.length > 0) await this.#handoff(watch, target, ready);
      this.#db.prepare('UPDATE watches SET waiting = ?, last_scan = ?, error = NULL WHERE id = ? AND paused = 0')
        .run(waiting, Date.now(), watch.id);
    } catch (error) {
      this.#db.prepare('UPDATE watches SET last_scan = ?, error = ? WHERE id = ? AND paused = 0')
        .run(Date.now(), errorMessage(error), watch.id);
    }
  }

  #active(id) { const row = this.#get(id); return !this.#closed && row && !row.paused; }

  async #handoff(watch, target, ready) {
    await this.#assertSource(watch.source);
    if (!this.#active(watch.id)) return;
    const result = await this.enqueue({ ...target, sources: ready.map(item => ({
      kind: 'file', root: watch.source, path: item.path, name: path.basename(item.path),
      inboxKey: digest(watch.id, item.relative, item.stamp).slice(0, 32), inboxStamp: item.stamp,
      inboxRootStamp: watch.root_stamp,
    })) });
    if (result?.ok === false) throw new Error(result.message || '监控文件未加入导入队列。');
    if (!this.#get(watch.id)) return;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const keep = this.#db.prepare('INSERT INTO files (watch_id, relative, stamp) VALUES (?, ?, ?) ON CONFLICT(watch_id, relative) DO UPDATE SET stamp = excluded.stamp');
      for (const item of ready) keep.run(watch.id, item.relative, item.stamp);
      this.#db.prepare('UPDATE watches SET queued = queued + ? WHERE id = ?').run(ready.length, watch.id);
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }

  async #poll() {
    if (this.#closed || this.#polling) return;
    this.#polling = true;
    try { await Promise.allSettled(this.list().filter(watch => !watch.paused).map(watch => this.scan(watch.id))); }
    finally { this.#polling = false; }
  }

  async close() {
    this.#closed = true;
    clearInterval(this.#timer);
    await this.#adding;
    await Promise.allSettled(this.#running.values());
    this.#db?.close();
    this.#db = undefined;
  }
}

module.exports = { FolderInbox, openInboxOriginal };
