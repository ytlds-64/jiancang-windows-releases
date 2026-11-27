'use strict';

const { fork } = require('node:child_process');
const path = require('node:path');
const { spreadsheetCell } = require('../../asset-clipboard.cjs');
const { createCloudOriginalReader } = require('../../cloud-original-process.cjs');
const { CloudOriginalQueue } = require('../../cloud-original-queue.cjs');

const cloudKinds = new Set(['jiancang', 'eagle']);
const assetId = /^[a-f0-9]{64}$/;
const maximumSourceCount = 100_000;
const copyLimit = 5000;
const clipboardBytes = 2 * 1024 ** 2;

function forkOriginalWorker(modulePath) {
  const child = fork(modulePath, [], {
    execArgv: ['--max-old-space-size=128'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  child.postMessage = data => child.send(data);
  return child;
}

function downloadableAsset(asset) {
  return asset && !asset.trashed && asset.kind !== 'link' && Number.isSafeInteger(asset.byteCount) && asset.byteCount >= 0;
}

function changedLibrary() {
  return Object.assign(new Error('素材库连接已变化，请重新定位或刷新。'), { code: 'LIBRARY_CHANGED' });
}

class CloudService {
  #ready = false;
  #closed = false;
  #refreshAfterDownload = new Set();
  #queue;

  constructor(library, { onChange, thumbnailCache, readOriginal = createCloudOriginalReader(forkOriginalWorker) } = {}) {
    this.library = library;
    this.thumbnailCache = thumbnailCache;
    this.onChange = onChange;
    this.#queue = new CloudOriginalQueue({
      directory: path.join(library.profile, 'cloud-originals-v1'),
      resolve: (reference, options) => this.resolve(reference, options),
      readOriginal,
      onChange: id => this.changed(id),
    });
  }

  static handles(name) {
    return name.startsWith('cloud-originals:') || name === 'storage:status' || name === 'storage:clear-thumbnails';
  }

  async initialize() {
    await this.#queue.initialize();
    if (this.#closed) return;
    this.#ready = true;
    // Permit the desktop to finish starting while a provider reads its catalog.
    void this.library.startup.then(() => {
      if (this.#closed || this.library.shutdown.signal.aborted) return;
      for (const { id, kind } of this.library.registry.entries) {
        if (!cloudKinds.has(kind)) continue;
        const { pending, running } = this.#queue.status(id, { includeTasks: false });
        if (pending || running) this.#refreshAfterDownload.add(id);
      }
      this.#queue.start();
    }).catch(() => {});
  }

  close() {
    this.#closed = true;
    this.#ready = false;
    this.#refreshAfterDownload.clear();
    return this.#queue.close();
  }

  discard(id) {
    this.#refreshAfterDownload.delete(id);
    if (this.#ready) this.#queue.discard(id);
  }

  entry(id) {
    const entry = this.library.registry.entries.find(item => item.id === id);
    if (!entry || !cloudKinds.has(entry.kind)) {
      throw Object.assign(new Error('请选择一个见藏同步库或 Eagle 库。'), { code: 'LIBRARY_CHANGED' });
    }
    return entry;
  }

  catalog(entry) {
    const catalog = this.library.catalogs.get(entry.id);
    if (!catalog || catalog.publicLibrary.libraryId !== entry.libraryId || path.relative(entry.root, catalog.root) !== '') throw changedLibrary();
    return catalog;
  }

  async resolve({ registrationId, libraryId, id }, { signal }) {
    await this.library.startup;
    signal.throwIfAborted();
    this.library.shutdown.signal.throwIfAborted();
    const entry = this.entry(registrationId);
    if (entry.libraryId !== libraryId) throw changedLibrary();
    const catalog = this.catalog(entry);
    const asset = catalog.assets.get(id);
    const originals = catalog.originalCandidates?.get(id) ?? [catalog.originals.get(id)].filter(Boolean);
    const candidates = [...new Set([...originals, ...(catalog.hydrationCandidates?.get(id) ?? [])])].slice(0, 32);
    if (!downloadableAsset(asset) || !candidates.length) {
      throw Object.assign(new Error('原件暂未同步到此文件夹，请等待云盘同步后重试。'), { code: 'MISSING' });
    }
    return { root: catalog.root, rootIdentity: catalog.identity, kind: entry.kind, candidates, byteCount: asset.byteCount,
      ...(entry.kind === 'jiancang' && { sha256: asset.id }) };
  }

  async refresh(entry) {
    if (!await this.library.refreshEntry(entry)) {
      throw new Error('暂时无法读取素材库，请确认云盘联网或重新定位。');
    }
    return this.catalog(entry);
  }

  start(id, { ids } = {}) {
    if (ids !== undefined && (!Array.isArray(ids) || ids.length === 0 || ids.length > maximumSourceCount ||
        ids.some(value => typeof value !== 'string' || !assetId.test(value)))) {
      throw new Error('请选择有效的素材。');
    }
    return this.library.serial(async () => {
      const entry = this.entry(id);
      const catalog = await this.refresh(entry);
      const selected = ids === undefined ? [...catalog.assets.values()]
        : [...new Set(ids)].map(value => catalog.assets.get(value));
      const items = selected.filter(downloadableAsset);
      if (!items.length) throw new Error('当前范围没有可取回的原件。');
      const result = this.#queue.enqueue(id, entry.libraryId, items, { recheck: true });
      if (result.added) this.#refreshAfterDownload.add(id);
      return { ok: true, ...result, alreadyQueued: items.length - result.added, unavailable: selected.length - items.length };
    });
  }

  retry(id, { id: task } = {}) {
    if (task !== undefined && (typeof task !== 'string' || !assetId.test(task))) throw new Error('请选择要重试的原件。');
    return this.library.serial(async () => {
      await this.refresh(this.entry(id));
      const count = this.#queue.retry(id, task);
      if (count) this.#refreshAfterDownload.add(id);
      return { ok: true, count };
    });
  }

  changed(id) {
    if (!this.#ready) return;
    this.onChange?.(id);
    const entry = this.library.registry.entries.find(item => item.id === id);
    if (!entry) return;
    const { pending, running, done } = this.#queue.status(id, { includeTasks: false });
    if (pending || running) this.#refreshAfterDownload.add(id);
    else if (this.#refreshAfterDownload.delete(id) && done) {
      void this.library.serial(async () => {
        if (this.library.registry.entries.includes(entry)) await this.library.refreshEntry(entry);
      }).catch(() => {});
    }
  }

  failureList(id) {
    const { failed } = this.#queue.status(id, { includeTasks: false });
    const rows = [];
    let bytes = 128;
    while (rows.length < Math.min(copyLimit, failed)) {
      const { tasks } = this.#queue.status(id, { offset: rows.length, limit: 100, filter: 'failed' });
      if (!tasks.length) break;
      const before = rows.length;
      for (const item of tasks) {
        const row = `${spreadsheetCell(item.name)}\t${spreadsheetCell(item.message)}`;
        bytes += Buffer.byteLength(row) + 2;
        if (bytes > clipboardBytes || rows.length === copyLimit) break;
        rows.push(row);
      }
      if (rows.length === before || bytes > clipboardBytes) break;
    }
    const count = rows.length;
    if (count && count < failed) rows.push(`还有 ${failed - count} 项失败任务，可在队列中查看。`);
    return { ok: true, count, ...(count && { text: ['素材\t失败原因', ...rows].join('\r\n') }) };
  }

  async storage(clear) {
    const cache = clear ? await this.thumbnailCache?.clearThumbnails()
      : await this.thumbnailCache?.thumbnailStatus().catch(() => null);
    if (clear && !cache) throw new Error('无法清理缩略图缓存，请重试。');
    const libraries = this.library.registry.entries.map(({ id, name, kind }) => {
      const library = this.library.catalogs.get(id)?.publicLibrary;
      const row = { id, name: library?.directoryName ?? name, kind, loaded: !!library };
      if (!library) return row;
      let count = 0;
      let originals = 0;
      let bytes = 0;
      for (const asset of library.assets) {
        if (asset.trashed) continue;
        count++;
        if (asset.available) originals++;
        if (Number.isSafeInteger(asset.byteCount) && asset.byteCount > 0) bytes += asset.byteCount;
      }
      return { ...row, count, originals, bytes };
    });
    return { ok: true, cache: cache ?? null, libraries };
  }

  command(name, [id, detail] = []) {
    if (name === 'storage:status' || name === 'storage:clear-thumbnails') return this.storage(name === 'storage:clear-thumbnails');
    if (!this.#ready) throw new Error('无法打开原件取回队列，请重启见藏。');
    this.entry(id);
    switch (name) {
      case 'cloud-originals:status': return { ok: true, ...this.#queue.status(id, detail ?? {}) };
      case 'cloud-originals:start': return this.start(id, detail ?? {});
      case 'cloud-originals:retry': return this.retry(id, detail ?? {});
      case 'cloud-originals:remove-task': return { ok: true, removedStatus: this.#queue.remove(id, detail) };
      case 'cloud-originals:pause': return { ok: true, paused: this.#queue.setPaused(id, detail) };
      case 'cloud-originals:history-clear': return { ok: true, count: this.#queue.clearCompleted(id) };
      case 'cloud-originals:copy-failures': return this.failureList(id);
      default: throw new Error('此原件取回操作尚不支持。');
    }
  }
}

module.exports = { CloudService };
