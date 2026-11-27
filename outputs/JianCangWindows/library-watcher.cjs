'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { sourceStamp } = require('./thumbnail-cache.cjs');

const eaglePaths = ['metadata.json', 'mtime.json', 'images'];
const syncPaths = ['library.json', 'changes', 'blobs', path.join('blobs', '.locations')];
const localPaths = ['jiancang-local.json', 'originals'];
const syncDeviceID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const syncTemporary = /^\.materialshelf-publish-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const deviceStampBatchSize = 16;

function visibleChange(kind, filename) {
  if (!filename) return true;
  const parts = String(filename).replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  if (!parts.length) return true;
  const [head, ...rest] = parts;
  if (kind === 'eagle') {
    return eaglePaths.includes(head) && !rest.some(part => part === '.ds_store' || part === 'thumbs.db');
  }
  if (kind === 'local') return localPaths.includes(head) && !rest.some(part => part.startsWith('.'));
  const temporaryJournal = head === 'changes' && rest.length === 2 && syncDeviceID.test(rest[0]) && syncTemporary.test(rest[1]);
  return syncPaths.includes(head) && !temporaryJournal &&
    !rest.some(part => part === '.ds_store' || part === 'thumbs.db' || part === '.incoming');
}

async function pathStamp(filename, requireDirectory = false) {
  const info = await fs.promises.lstat(filename, { bigint: true }).catch(() => null);
  if (!info || info.isSymbolicLink() || requireDirectory && !info.isDirectory()) return null;
  return sourceStamp(info);
}

async function journalDirectoryStamps(changes) {
  const entries = await fs.promises.readdir(changes, { withFileTypes: true }).catch(() => []);
  const devices = entries.filter(entry => entry.isDirectory() && syncDeviceID.test(entry.name)).map(entry => entry.name).sort();
  const stamps = [];
  for (let offset = 0; offset < devices.length; offset += deviceStampBatchSize) {
    const batch = devices.slice(offset, offset + deviceStampBatchSize);
    stamps.push(...await Promise.all(batch.map(async name => [name, await pathStamp(path.join(changes, name), true)])));
  }
  return stamps;
}

async function directorySignature(entry) {
  const root = await fs.promises.lstat(entry.root, { bigint: true }).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) return { fingerprint: 'offline', identity: null };
  const paths = entry.kind === 'eagle' ? eaglePaths : entry.kind === 'local' ? localPaths : syncPaths;
  const stamps = await Promise.all(paths.map(async name => {
    const filename = path.join(entry.root, name);
    if (name !== 'changes') return pathStamp(filename);
    const stamp = await pathStamp(filename, true);
    // A journal added to an existing device folder does not change its parent's stamp.
    return stamp ? [stamp, await journalDirectoryStamps(filename)] : null;
  }));
  const identity = folderIdentity(root);
  return { fingerprint: JSON.stringify([identity, ...stamps]), identity };
}

function folderIdentity(stat) { return `${stat.dev}:${stat.ino}`; }

function createLibraryWatcher({ onChange, needsRetry = () => false, quietMs = 650, maxWaitMs = 3500,
  pollMs = 15_000, retryMs = 60_000, watchDirectory = fs.watch }) {
  const watches = new Map();
  let timer;
  let polling = false;
  let closed = false;

  function live(record) { return !closed && watches.get(record.entry.id) === record; }

  function changed(record) {
    record.change++;
    schedule(record);
  }

  function schedule(record) {
    if (!live(record)) return;
    clearTimeout(record.debounce);
    if (!record.pending) record.pending = Date.now();
    const remaining = maxWaitMs - (Date.now() - record.pending);
    record.debounce = setTimeout(() => publish(record), Math.max(0, Math.min(quietMs, remaining)));
    record.debounce.unref();
  }

  function publish(record) {
    clearTimeout(record.debounce);
    record.pending = 0;
    const needsRefresh = () => live(record) && record.covered < record.change;
    if (!needsRefresh()) return;
    if (record.refreshing) {
      record.dirty = true;
      return;
    }
    record.refreshing = true;
    record.lastRefresh = Date.now();
    Promise.resolve().then(() => onChange(record.entry.id, needsRefresh)).catch(() => {}).finally(() => {
      record.refreshing = false;
      if (record.dirty) {
        record.dirty = false;
        if (needsRefresh()) schedule(record);
      }
    });
  }

  function connect(record) {
    if (!live(record) || record.watch) return;
    try {
      const watcher = watchDirectory(record.entry.root, { recursive: true, persistent: false }, (_, filename) => {
        if (visibleChange(record.entry.kind, filename)) changed(record);
      });
      record.watch = watcher;
      watcher.on('error', () => {
        if (record.watch !== watcher) return;
        watcher.close();
        record.watch = null;
        changed(record);
      });
    } catch { /* Polling can still find a reconnected folder. */ }
  }

  async function pollOne(record) {
    const { fingerprint, identity } = await directorySignature(record.entry);
    if (!live(record)) return;
    const signatureChanged = record.signature !== undefined && record.signature !== fingerprint;
    if (!identity || record.identity && record.identity !== identity) {
      record.watch?.close();
      record.watch = null;
    }
    record.signature = fingerprint;
    record.identity = identity;
    if (identity) connect(record);
    if (signatureChanged || (identity && (!record.watch || needsRetry(record.entry.id)) &&
      Date.now() - record.lastRefresh >= retryMs)) changed(record);
  }

  async function beginRefresh(id) {
    const record = watches.get(id);
    if (!record) return null;
    const change = record.change;
    const { identity, fingerprint } = await directorySignature(record.entry);
    return { record, change, identity, fingerprint };
  }

  function finishRefresh(read, identity) {
    if (!read || read.identity !== identity || !live(read.record)) return;
    const { record, change, fingerprint } = read;
    // Keep changes reported while the catalog was being read.
    record.covered = Math.max(record.covered, change);
    if (record.covered !== record.change) return;
    record.signature = fingerprint;
    record.lastRefresh = Date.now();
    clearTimeout(record.debounce);
    record.pending = 0;
    record.dirty = false;
  }

  async function poll() {
    if (polling) return;
    polling = true;
    const iterator = watches.values();
    try {
      const probe = async () => {
        for (const record of iterator) {
          if (closed) return;
          await pollOne(record);
        }
      };
      await Promise.allSettled(Array.from({ length: Math.min(4, watches.size) }, probe));
    } finally { polling = false; }
  }

  function stop(record) {
    clearTimeout(record.debounce);
    record.watch?.close();
  }

  function update(entries) {
    if (closed) return;
    const retained = new Set(entries.map(entry => entry.id));
    for (const [id, record] of watches) {
      if (!retained.has(id)) {
        stop(record);
        watches.delete(id);
      }
    }
    for (const entry of entries) {
      const before = watches.get(entry.id);
      if (before?.entry.root === entry.root && before.entry.kind === entry.kind) continue;
      if (before) stop(before);
      const record = { entry, change: 0, covered: 0, lastRefresh: Date.now() };
      watches.set(entry.id, record);
    }
    if (watches.size && !timer) {
      timer = setInterval(poll, pollMs);
      timer.unref();
    } else if (!watches.size && timer) {
      clearInterval(timer);
      timer = null;
    }
    void poll();
  }

  function close() {
    closed = true;
    clearInterval(timer);
    for (const record of watches.values()) stop(record);
    watches.clear();
  }

  return { update, beginRefresh, finishRefresh, close };
}

function libraryFingerprint(library) {
  const hash = createHash('sha256');
  const append = value => hash.update(JSON.stringify(value) + '\0');
  const ordered = (items, key) => [...items].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const { assets, collections, originals, originalCandidates, hydrationCandidates, sourceThumbnails, warnings, ...details } = library;
  append(details);
  for (const item of ordered(assets, value => value.id)) append(item);
  for (const item of ordered(collections, value => value.id)) append(item);
  for (const source of [originals, originalCandidates, hydrationCandidates, sourceThumbnails]) {
    append(source?.size ?? 0);
    for (const item of ordered(source ?? [], value => value[0])) append(item);
  }
  for (const warning of [...warnings].sort()) append(warning);
  return hash.digest('hex');
}

module.exports = { createLibraryWatcher, folderIdentity, libraryFingerprint, visibleChange };
