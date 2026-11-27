'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readRegistry, writeRegistry, registerLibrary, detachLibrary, locationMatches, assetForCatalog } = require('../../library-registry.cjs');
const { createLocalLibrary, mutateLocalLibrary, importLocalAsset, expireLocalTrash } = require('../../local-library.cjs');
const { LocalImportQueue } = require('../../local-import-queue.cjs');
const { openInboxOriginal } = require('../../folder-inbox.cjs');
const { collectImportSources, inLibrary, maximumImportBatch, sourceCollectionPaths, syncUploadId, webURL } = require('../../local-workflow.cjs');
const { isWithin, openContainedFile, exportFilename } = require('../../original-file.cjs');
const { createLibraryWatcher, folderIdentity } = require('../../library-watcher.cjs');
const { createEagleLocalApi, planEagleRename } = require('../../eagle-local-api.cjs');
const { resolveEagleReadingDirectory } = require('../../eagle-library.cjs');
const { DirectorySyncWriter } = require('../../sync-writer.cjs');
const { listSyncConflicts } = require('../../sync-library.cjs');
const { downloadDroppedImage, imageExtension, imageFilename } = require('../../dropped-image.cjs');
const { imageDimensions } = require('../../image-dimensions.cjs');
const { clipboardModes, clipboardText } = require('../../asset-clipboard.cjs');
const { readTextPreview } = require('../../text-preview.cjs');
const { findFfmpeg, openAsset, exportAsset, canGenerateThumbnail } = require('./media.cjs');

const kinds = new Set(['local', 'eagle', 'jiancang']);
const trashCheckInterval = 60 * 60 * 1000;
const importRefreshInterval = 350;
const syncImportRefreshInterval = 10_000;
const localActions = new Set(['edit', 'trash', 'restore', 'rename', 'planRename', 'planTagChange', 'changeTag',
  'createCollection', 'editCollection', 'deleteCollection', 'undo', 'redo', 'applySuggestion']);
const eagleBulkFields = new Set(['action', 'ids', 'expected', 'rating', 'note', 'sourceURL', 'addTags', 'removeTags',
  'addCollectionIds', 'removeCollectionIds']);
const externalOpenExtensions = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'psd',
  'mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'mpeg', 'mpg',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aif', 'aiff',
  'pdf', 'txt', 'md', 'csv', 'tsv', 'json', 'log', 'docx', 'xlsx', 'pptx',
]);

function absolutePath(value) {
  return typeof value === 'string' && value.length <= 32_767 && path.isAbsolute(value) && !value.includes('\0');
}

async function checkedDirectory(directory) {
  if (!absolutePath(directory)) throw new Error('请选择有效的文件夹。');
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('请选择真实的文件夹。');
  return fs.realpath(directory);
}

function readCatalog(directory, kind, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, '../../library-worker.cjs'), [], {
      execArgv: ['--max-old-space-size=512'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', windowsHide: true,
    });
    let settled = false;
    const timer = setTimeout(() => finish(Object.assign(new Error('读取素材库超时。请确认文件夹和 iCloud 原件已可用。'),
      { code: 'LIBRARY_READ_TIMEOUT' })), 120_000);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      child.kill();
      if (error) reject(error);
      else resolve(result);
    }
    function cancel() { finish(signal.reason); }
    signal.addEventListener('abort', cancel, { once: true });
    child.once('error', error => finish(error));
    child.once('exit', () => finish(new Error('素材库读取进程已结束，请重试。')));
    child.once('message', result => {
      if (result?.error) finish(new Error(result.error));
      else if (!result?.library || !(result.library.originals instanceof Map)) finish(new Error('素材库读取结果无效。'));
      else finish(null, result);
    });
    child.send({ directory, kind }, error => { if (error) finish(error); });
  });
}

class LibraryService {
  constructor(profile, { onStateChange, eagleFetch, publishSyncOriginal } = {}) {
    if (!absolutePath(profile)) throw new Error('候选版数据目录无效。');
    this.profile = profile;
    this.catalogs = new Map();
    this.statuses = new Map();
    this.importRefreshes = new Map();
    this.operations = Promise.resolve();
    this.shutdown = new AbortController();
    this.onStateChange = onStateChange;
    this.eagleApi = createEagleLocalApi({ fetchImpl: eagleFetch });
    this.publishSyncOriginal = publishSyncOriginal;
  }

  async initialize() {
    await fs.mkdir(this.profile, { recursive: true, mode: 0o700 });
    this.profile = await checkedDirectory(this.profile);
    this.registryPath = path.join(this.profile, 'library.json');
    this.registry = (await readRegistry(this.registryPath)).registry;
    this.ffmpeg = await findFfmpeg();
    const writer = new DirectorySyncWriter({ directory: path.join(this.profile, 'directory-sync-write-v1'),
      publishOriginal: this.publishSyncOriginal, onChange: () => this.notify() });
    try { await writer.initialize(); this.syncWriter = writer; }
    catch { await writer.close().catch(() => {}); }
    this.queue = new LocalImportQueue({ directory: path.join(this.profile, 'local-imports-v1'),
      perform: (task, progress) => this.importTask(task, progress),
      onChange: id => this.scheduleSyncImportRefresh(id) });
    await this.queue.initialize();
    this.watcher = createLibraryWatcher({
      needsRetry: id => {
        const entry = this.registry.entries.find(item => item.id === id);
        return Boolean(this.statuses.get(id)?.status !== 'available' || this.statuses.get(id)?.syncLogIncomplete ||
          entry?.syncWritable && this.syncWriter?.status(entry.libraryId).pending);
      },
      onChange: (id, needsRefresh) => this.serial(async () => {
        const entry = this.registry.entries.find(item => item.id === id);
        if (!entry || !needsRefresh()) return;
        if (entry.kind === 'jiancang' && this.importQueueBusy(id)) {
          this.deferSyncImportRefresh(entry);
          return;
        }
        await this.refreshEntry(entry);
        await this.flushSync(entry);
      }),
    });
    this.startup = this.serial(async () => {
      const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(120_000)]);
      for (const entry of this.registry.entries) await this.refreshEntry(entry, { signal });
      this.watcher.update(this.registry.entries);
      this.queue.start();
      this.notify();
    }).catch(() => {});
    void this.startup.then(() => this.serial(async () => {
      for (const entry of this.registry.entries) await this.flushSync(entry);
    })).catch(() => {});
    const checkTrash = () => void this.serial(async () => {
      for (const entry of this.registry.entries) {
        this.shutdown.signal.throwIfAborted();
        await this.maintainLocalTrash(entry);
      }
    }).catch(() => {});
    void this.startup.then(checkTrash);
    this.trashCheckTimer = setInterval(checkTrash, trashCheckInterval).unref();
  }

  serial(action) {
    const work = this.operations.then(() => {
      this.shutdown.signal.throwIfAborted();
      return action();
    });
    this.operations = work.catch(() => {});
    return work;
  }

  async close() {
    this.shutdown.abort(new Error('见藏已关闭。'));
    this.cancelOpen();
    this.watcher?.close();
    clearInterval(this.trashCheckTimer);
    clearTimeout(this.stateEvent);
    for (const refresh of this.importRefreshes.values()) clearTimeout(refresh.timer);
    this.importRefreshes.clear();
    await this.operations;
    await this.queue?.close();
    await this.syncWriter?.close();
  }

  notify() {
    if (!this.onStateChange || this.stateEvent || this.shutdown.signal.aborted) return;
    this.stateEvent = setTimeout(() => {
      this.stateEvent = null;
      const snapshot = this.state();
      const revision = JSON.stringify([snapshot.activeLibraryId, snapshot.message, snapshot.libraryOpening, snapshot.libraries,
        snapshot.catalogs.map(({ libraryId, revision, library }) => [libraryId, revision, library.syncConflicts])]);
      if (revision === this.notifiedRevision) return;
      this.notifiedRevision = revision;
      try { this.onStateChange(snapshot); } catch { /* Core work stays independent of notification delivery. */ }
    }, 120);
    this.stateEvent.unref();
  }

  catalogForRenderer(catalog) {
    if (!catalog) return null;
    const { publicLibrary, deletionConflictSignatures } = catalog;
    if (!deletionConflictSignatures?.length || !this.syncWriter) return publicLibrary;
    const acknowledged = this.syncWriter.acknowledgedConflicts(publicLibrary.libraryId);
    const count = deletionConflictSignatures.filter(signature => acknowledged.has(signature)).length;
    return count > 0 ? { ...publicLibrary, syncConflicts: Math.max(0, publicLibrary.syncConflicts - count) } : publicLibrary;
  }

  state() {
    const current = this.catalogs.get(this.registry.selectedId);
    return {
      library: this.catalogForRenderer(current), message: this.message ?? null, activeLibraryId: current?.registrationId ?? null,
      libraryOpening: this.opening?.status ?? null,
      libraries: this.registry.entries.map(entry => ({
        id: entry.id, name: this.catalogs.get(entry.id)?.publicLibrary.directoryName ?? entry.name,
        root: entry.root, kind: entry.kind, libraryId: entry.libraryId,
        ...(this.statuses.get(entry.id) ?? { status: 'unknown' }),
        ...(entry.kind === 'eagle' && { eagleWritable: entry.eagleWritable === true }),
        ...(entry.kind === 'jiancang' && { syncWritable: entry.syncWritable === true,
          format: this.catalogs.get(entry.id)?.publicLibrary.format ?? null,
          writeStatus: this.syncWriter?.status(entry.libraryId) ??
            { pending: null, error: '无法打开本机同步队列。', conflicts: 0 } }),
      })),
      catalogs: this.registry.entries.flatMap(({ id }) => {
        const catalog = this.catalogs.get(id);
        return catalog ? [{ libraryId: id, library: this.catalogForRenderer(catalog), revision: catalog.cacheKey }] : [];
      }),
    };
  }

  entry(id) {
    const entry = this.registry.entries.find(item => item.id === id);
    if (!entry) throw new Error('素材库已经移除，请重新添加。');
    return entry;
  }

  importEntry(id) {
    const entry = this.entry(id);
    if (entry.kind !== 'local' && entry.kind !== 'jiancang') throw new Error('请选择一个见藏素材库。');
    return entry;
  }

  writable(id) {
    const entry = this.importEntry(id);
    if (!this.catalogs.has(id) || this.statuses.get(id)?.status !== 'available') throw new Error('素材库暂不可用，请刷新后重试。');
    if (entry.kind === 'jiancang') {
      if (!entry.syncWritable) throw new Error('请先为这份见藏同步库开启双向同步。');
      if (!this.syncWriter) throw new Error('无法打开本机同步队列，请重启见藏。');
      if (this.catalogs.get(id).publicLibrary.format !== 6) throw new Error('请先在 iPhone 或 iPad 上将这份库升级到同步格式 6。');
      if (this.duplicateSyncWriter(entry)) throw new Error('这份同步库还在另一个位置开启了写入，请保留一个连接。');
    }
    return entry;
  }

  duplicateSyncWriter(entry) {
    return this.registry.entries.some(peer => peer.id !== entry.id && peer.libraryId === entry.libraryId && peer.syncWritable);
  }

  async saveRegistry(registry) {
    await writeRegistry(this.registryPath, registry);
    this.registry = registry;
    for (const [id, refresh] of this.importRefreshes) {
      if (registry.entries.some(entry => entry.id === id && entry.root === refresh.root)) continue;
      clearTimeout(refresh.timer);
      this.importRefreshes.delete(id);
    }
    this.watcher.update(registry.entries);
    this.notify();
  }

  keepCatalog(id, { root, library, fingerprint, identity }) {
    const previous = this.catalogs.get(id);
    const sameFolder = previous?.root === root && previous.identity === identity;
    if (sameFolder && previous.fingerprint === fingerprint) return null;
    if (sameFolder && library.logIncomplete && previous.publicLibrary.libraryId === library.libraryId && !previous.publicLibrary.logIncomplete) {
      return 'iCloud 正在接收变更，暂时显示上次完整的素材库。';
    }
    const { originals, originalCandidates, hydrationCandidates, sourceThumbnails, pathIndependentIdentity,
      deletionConflictSignatures, ...publicLibrary } = library;
    publicLibrary.assets = library.assets.map(asset => !asset.thumbnailAvailable && canGenerateThumbnail(asset, this.ffmpeg)
      ? { ...asset, thumbnailAvailable: true } : asset);
    this.catalogs.set(id, { root, registrationId: id, publicLibrary, cacheKey: randomUUID(), fingerprint, identity,
      originals, originalCandidates, hydrationCandidates, sourceThumbnails, deletionConflictSignatures,
      assets: new Map(publicLibrary.assets.map(asset => [asset.id, asset])) });
    return null;
  }

  async refreshEntry(entry, { signal = this.shutdown.signal, coverWatchChanges = false } = {}) {
    // Keep the last verified catalog usable during a background refresh.
    // Writes run in the serial queue and see the refreshed status.
    if (!this.catalogs.has(entry.id)) this.statuses.set(entry.id, { status: 'loading' });
    try {
      const trackChanges = coverWatchChanges || this.importRefreshes.get(entry.id)?.syncDirty;
      const read = trackChanges ? await this.watcher.beginRefresh(entry.id) : null;
      const loaded = await readCatalog(entry.root, entry.kind, signal);
      if (!locationMatches(entry, loaded.library, false)) throw new Error('这个文件夹包含另一份素材库，请重新定位。');
      const message = this.keepCatalog(entry.id, loaded);
      this.statuses.set(entry.id, { status: 'available', ...(message && { message }), ...(loaded.library.logIncomplete && { syncLogIncomplete: true }) });
      if (!loaded.library.logIncomplete) this.watcher.finishRefresh(read, loaded.identity);
      return true;
    } catch (error) {
      this.catalogs.delete(entry.id);
      const message = error.name === 'TimeoutError' ? '启动时读取素材库超时，请刷新后重试。' : error.message;
      this.statuses.set(entry.id, { status: 'unavailable', message });
      return false;
    } finally {
      const refresh = this.importRefreshes.get(entry.id);
      if (refresh?.root === entry.root) {
        clearTimeout(refresh.timer);
        refresh.timer = null;
        refresh.lastScan = performance.now();
        refresh.syncDirty = false;
      }
      this.notify();
    }
  }

  importRefreshFor(entry) {
    let refresh = this.importRefreshes.get(entry.id);
    if (!refresh) {
      refresh = { root: entry.root, lastScan: -Infinity, timer: null, syncDirty: false };
      this.importRefreshes.set(entry.id, refresh);
    }
    return refresh;
  }

  importQueueBusy(id) {
    const { running, pending } = this.queue.summary(id);
    return running > 0 || (pending > 0 && !this.queue.isPaused(id));
  }

  deferSyncImportRefresh(entry) {
    const refresh = this.importRefreshFor(entry);
    refresh.syncDirty = true;
    if (!refresh.timer) {
      // A continuous stream of queued work still gets periodic catalog updates.
      const timer = setTimeout(() => this.scheduleSyncImportRefresh(entry.id, timer), syncImportRefreshInterval).unref();
      refresh.timer = timer;
    }
  }

  scheduleSyncImportRefresh(id, dueTimer) {
    const refresh = this.importRefreshes.get(id);
    const ready = () => refresh?.syncDirty && (dueTimer ? refresh.timer === dueTimer : !this.importQueueBusy(id));
    if (!ready()) return;
    void this.serial(async () => {
      const entry = this.registry.entries.find(item => item.id === id && item.root === refresh.root);
      if (!entry || this.importRefreshes.get(id) !== refresh || !ready()) return;
      await this.refreshEntry(entry);
      await this.flushSync(entry);
    }).catch(() => {});
  }

  async refreshImportedEntry(entry) {
    if (this.shutdown.signal.aborted) return;
    if (entry.kind === 'jiancang') {
      this.deferSyncImportRefresh(entry);
      return;
    }
    const refresh = this.importRefreshFor(entry);
    const remaining = importRefreshInterval - (performance.now() - refresh.lastScan);
    if (remaining <= 0 || !this.queue.hasPending(entry.id)) {
      await this.refreshEntry(entry);
      return;
    }
    // Flush the intermediate writes even if the rest of the batch fails, is paused or is cancelled.
    if (refresh.timer) return;
    const timer = setTimeout(() => {
      void this.serial(async () => {
        if (this.importRefreshes.get(entry.id) !== refresh || refresh.timer !== timer) return;
        await this.refreshEntry(this.entry(entry.id));
      }).catch(() => {});
    }, remaining).unref();
    refresh.timer = timer;
  }

  async open(directory, kind, previous) {
    if (!absolutePath(directory) || (kind != null && !kinds.has(kind))) throw new Error('请选择有效的素材库文件夹。');
    const controller = new AbortController();
    const opening = { controller, directory, status: 'reading' };
    this.opening = opening;
    this.message = null;
    this.notify();
    try {
      const loaded = await readCatalog(directory, previous?.kind ?? kind, AbortSignal.any([controller.signal, this.shutdown.signal]));
      if (previous && !locationMatches(previous, loaded.library, true)) throw new Error('这个文件夹包含另一份素材库。请选择原素材库的位置。');
      const next = registerLibrary(this.registry, loaded.root, loaded.library, previous);
      await this.saveRegistry(next);
      this.message = this.keepCatalog(next.selectedId, loaded);
      this.statuses.set(next.selectedId, { status: 'available', ...(loaded.library.logIncomplete && { syncLogIncomplete: true }) });
      const entry = this.entry(next.selectedId);
      if (entry.kind === 'local') void this.serial(() => this.maintainLocalTrash(entry)).catch(() => {});
    } catch (error) {
      if (error.code === 'LIBRARY_READ_TIMEOUT') opening.status = 'timed-out';
      this.message = error.message || '无法打开素材库。';
    } finally {
      if (this.opening === opening && opening.status !== 'timed-out') this.opening = null;
      this.notify();
    }
    return this.state();
  }

  cancelOpen() {
    this.opening?.controller.abort(new Error('已取消读取素材库。'));
    this.opening = null;
  }

  async revealOpenFolder() {
    const opening = this.opening;
    if (opening?.status !== 'timed-out') throw new Error('请先选择要打开的素材库。');
    const directory = await checkedDirectory(opening.directory);
    if (this.opening !== opening) throw new Error('素材库已变化，请重新选择。');
    return directory;
  }

  async revealReadingItem(id, revision, index) {
    const stale = '这个目录已经变化，请重新读取后再打开。';
    try {
      const catalog = this.catalogs.get(id);
      if (!catalog || catalog.cacheKey !== revision || !Number.isInteger(index) || index < 0 ||
          this.entry(id).kind !== 'eagle') throw new Error();
      const directory = catalog.publicLibrary.readingIssues?.entries[index]?.directory;
      if (!directory) throw new Error();
      const root = await fs.lstat(catalog.root, { bigint: true });
      if (!root.isDirectory() || root.isSymbolicLink() || folderIdentity(root) !== catalog.identity) throw new Error();
      const target = await resolveEagleReadingDirectory(catalog.root, directory);
      if (this.catalogs.get(id) !== catalog) throw new Error();
      return target;
    } catch { throw new Error(stale); }
  }

  async create(name, directory) {
    if (typeof name !== 'string' || !name.trim() || Array.from(name.trim()).length > 80) throw new Error('请输入 1 到 80 个字符的素材库名称。');
    const parent = await checkedDirectory(directory);
    if (this.registry.entries.some(entry => isWithin(entry.root, parent)) || await inLibrary(parent) || isWithin(this.profile, parent)) {
      throw new Error('请选择现有素材库及应用数据目录以外的文件夹。');
    }
    const stem = Array.from(exportFilename(name.trim(), '')).slice(0, 56).join('');
    const root = path.join(parent, stem);
    try { await createLocalLibrary(root, name.trim()); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('这个位置已有同名文件夹，请换一个库名或位置。');
      throw error;
    }
    return this.open(root, 'local');
  }

  async commitMutation(entry, command) {
    return entry.kind === 'local'
      ? mutateLocalLibrary(entry.root, { ...command, expectedLibraryId: entry.libraryId })
      : this.syncWriter.mutate(entry, command);
  }

  async maintainLocalTrash(entry) {
    if (entry.kind !== 'local' || this.statuses.get(entry.id)?.status !== 'available') return;
    const current = this.registry.entries.find(item => item.id === entry.id);
    const catalog = this.catalogs.get(entry.id);
    if (current !== entry || catalog?.root !== entry.root) return;
    const mediaRevisions = new Map();
    for (const asset of catalog.assets.values()) {
      if (asset.trashed) mediaRevisions.set(asset.id, asset.mediaRevision);
    }
    if (!mediaRevisions.size && !catalog.publicLibrary.pendingPurge) return;
    try {
      const changed = await expireLocalTrash(entry.root, {
        expectedLibraryId: entry.libraryId, expectedIdentity: catalog.identity, mediaRevisions,
      });
      if (changed) await this.refreshEntry(entry);
    } catch (error) {
      process.stderr.write(`回收站自动清理等待重试：${error.message}\n`);
    }
  }

  async mutate(id, command) {
    const registered = this.entry(id);
    const purging = command?.action === 'purgeTrash' || command?.action === 'retryPurge';
    if (purging && registered.kind !== 'local') throw new Error('永久删除只适用于本地素材库。');
    if (registered.kind === 'eagle') return this.organizeEagle(id, command);
    const entry = this.writable(id);
    if (!purging && !localActions.has(command?.action)) throw new Error('此操作未在见藏中启用。');
    let mutation = command;
    if (purging) {
      const catalog = this.catalogs.get(id);
      if (!catalog || catalog.cacheKey !== command.catalogRevision) {
        throw new Error('回收站已更新，请重新确认要删除的素材。');
      }
      const mediaRevisions = new Map();
      if (command.action === 'purgeTrash') {
        const all = command.all === true;
        const ids = all ? [] : command.ids;
        if (!Array.isArray(ids) || ids.length > 100_000) throw new Error('请选择要删除的素材。');
        const records = all ? catalog.assets.values() : ids.map(assetId => catalog.assets.get(assetId));
        for (const asset of records) {
          if (asset?.trashed && asset.mediaRevision) mediaRevisions.set(asset.id, asset.mediaRevision);
        }
      }
      mutation = { ...command, mediaRevisions, purgeRootIdentity: catalog.identity };
    }
    if (['undo', 'redo'].includes(command.action)) {
      const { pending, running } = this.queue.summary(id);
      if (pending || running) throw new Error('请等待当前导入结束后再撤销或重做。');
    }
    const result = await this.commitMutation(entry, mutation);
    if (!['planRename', 'planTagChange'].includes(command.action)) {
      // The confirmed trash operation already needs a verified snapshot; cover the watcher events it reads.
      await this.refreshEntry(entry, { coverWatchChanges: command.action === 'trash' && !(result.pending > 0) });
    }
    return { ok: true, ...result, state: this.state(),
      ...(result.pending > 0 && !result.message && { message: '操作已加入本机待提交队列。' }) };
  }

  async setWriteEnabled(id, enabled, kind) {
    const entry = this.entry(id);
    if (entry.kind !== kind || typeof enabled !== 'boolean') throw new Error('请选择要设置双向同步的素材库。');
    if (enabled) {
      if (kind === 'jiancang' && !this.syncWriter) throw new Error('无法打开本机同步队列。');
      if (!(await this.refreshEntry(entry))) throw new Error(this.statuses.get(id).message);
      if (kind === 'eagle') await this.eagleApi.checkLibrary(entry.root);
      else {
        if (this.catalogs.get(id).publicLibrary.format !== 6) throw new Error('请先在 iPhone 或 iPad 上将这份库升级到同步格式 6。');
        if (this.duplicateSyncWriter(entry)) throw new Error('这份同步库已在另一个文件夹开启写入，请使用该连接。');
      }
    }
    const key = kind === 'eagle' ? 'eagleWritable' : 'syncWritable';
    await this.saveRegistry({ ...this.registry, entries: this.registry.entries.map(item => item.id === id
      ? { ...item, [key]: enabled } : item) });
    if (kind === 'jiancang' && enabled) {
      void this.serial(() => this.flushSync(this.entry(id))).catch(() => {});
    }
    return { ok: true, enabled, state: this.state() };
  }

  syncEntry(id) {
    const entry = this.entry(id);
    if (entry.kind !== 'jiancang') throw new Error('请选择一个见藏同步库。');
    return entry;
  }

  async flushSync(entry, manual = false) {
    if (entry.kind !== 'jiancang' || !entry.syncWritable || !this.syncWriter || this.duplicateSyncWriter(entry) ||
        this.catalogs.get(entry.id)?.publicLibrary.format !== 6 || this.statuses.get(entry.id)?.status !== 'available') return null;
    const before = this.syncWriter.status(entry.libraryId);
    if (!manual && (!before.pending || this.statuses.get(entry.id)?.syncLogIncomplete)) return before;
    const result = await this.syncWriter.retry(entry);
    if (manual || result.pending < before.pending) {
      const ok = await this.refreshEntry(entry);
      return { ...result, catalogRefresh: { ok, message: this.statuses.get(entry.id)?.message ?? null } };
    }
    return result;
  }

  async resolveSyncConflict(id, command) {
    const entry = this.syncEntry(id);
    this.writable(id);
    const result = await this.commitMutation(entry, { ...command, action: 'resolveConflict' });
    await this.refreshEntry(entry);
    return { ok: true, ...result, state: this.state() };
  }

  async eagleWritable(id) {
    const entry = this.entry(id);
    if (entry.kind !== 'eagle' || !entry.eagleWritable) throw new Error('请先为这份 Eagle 库开启双向同步。');
    const catalog = this.catalogs.get(id);
    if (!catalog || this.statuses.get(id)?.status !== 'available') throw new Error('请先重新连接这份 Eagle 库。');
    const info = await fs.lstat(entry.root, { bigint: true }).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink() || folderIdentity(info) !== catalog.identity) {
      throw new Error('Eagle 素材库位置已变化，请先刷新再修改。');
    }
    return entry;
  }

  eagleAsset(entry, id) {
    const { asset, library } = this.asset(id, entry.id);
    if (!asset.eagleItemId || asset.trashed || library.root !== entry.root || library.publicLibrary.libraryId !== entry.libraryId) {
      throw new Error('请重新选择可编辑的 Eagle 素材。');
    }
    return asset;
  }

  async editEagle(id, assetId, changes, expected) {
    const entry = await this.eagleWritable(id);
    const asset = this.eagleAsset(entry, assetId);
    if (Array.isArray(changes?.collectionIds)) {
      const folders = new Set(this.catalogs.get(id).publicLibrary.collections.map(folder => folder.id));
      if (changes.collectionIds.some(folderId => !folders.has(folderId))) throw new Error('集合已变化，请重新选择。');
    }
    await this.eagleApi.updateItem({ root: entry.root, id: asset.eagleItemId, changes, expected });
    await this.refreshEntry(entry);
    return { ok: true, state: this.state() };
  }

  async organizeEagle(id, command) {
    const entry = await this.eagleWritable(id);
    let requests;
    if (command?.action === 'planRename' || command?.action === 'rename') {
      const plan = planEagleRename(this.catalogs.get(id).assets, command.entries);
      if (command.action === 'planRename') return { ok: true, ...plan };
      if (plan.revision !== command.revision) throw new Error('素材已变化，请核对最新名称后重试。');
      requests = plan.entries.map(item => ({ id: item.id, changes: { name: item.name }, expected: { name: item.oldName } }));
    } else if (command?.action === 'edit') {
      if (!Array.isArray(command.ids) || !command.ids.length || command.ids.length > 100_000) throw new Error('请先选择素材。');
      if (Object.keys(command).some(key => !eagleBulkFields.has(key))) throw new Error('Eagle 批量整理不支持这项操作。');
      const changes = Object.fromEntries(['rating', 'note', 'sourceURL'].filter(key => Object.hasOwn(command, key)).map(key => [key, command[key]]));
      const edits = { tags: { add: command.addTags, remove: command.removeTags },
        collectionIds: { add: command.addCollectionIds, remove: command.removeCollectionIds } };
      requests = [...new Set(command.ids)].map(assetId => ({ id: assetId, changes, expected: command.expected?.[assetId], edits }));
    } else throw new Error('Eagle 批量整理不支持这项操作。');

    await this.eagleApi.checkLibrary(entry.root);
    let count = 0;
    let connectionError;
    const failed = [];
    for (const request of requests) {
      let asset;
      try {
        asset = this.eagleAsset(entry, request.id);
        if (connectionError) throw connectionError;
        await this.eagleApi.updateItem({ ...request, root: entry.root, id: asset.eagleItemId });
        count++;
      } catch (error) {
        if (error.code === 'EAGLE_CONNECTION') connectionError = error;
        failed.push({ id: request.id, name: asset?.name || '素材已变化', message: error.message });
      }
    }
    await this.refreshEntry(entry);
    return { ok: true, count, failed, state: this.state() };
  }

  async enqueue(id, collectionId, paths) {
    if (!Array.isArray(paths) || paths.length > maximumImportBatch || !paths.every(absolutePath)) throw new Error('请选择要导入的文件或分批添加。');
    if (!paths.length) return { cancelled: true };
    const target = this.captureTarget({ targetId: id, collectionId }, { allowPending: true });
    const { sources, skipped } = await this.pathSources(paths);
    if (!sources.length) throw new Error('没有可导入的文件。');
    return this.enqueueSources(id, collectionId, sources, skipped, target.libraryId);
  }

  pathSources(paths) {
    return collectImportSources(paths, this.protectedRoots());
  }

  protectedRoots() {
    return [this.profile, ...this.registry.entries.map(entry => entry.root)];
  }

  async enqueueSources(id, collectionId, sources, skipped = 0, libraryId) {
    const target = this.captureTarget({ targetId: id, collectionId, libraryId }, { allowPending: true });
    const tied = sources.map(source => ({ ...source, targetLibraryId: target.libraryId }));
    return { ok: true, ...await this.queue.enqueue({ targetId: id, collectionId, sources: tied }), skipped };
  }

  distinctCatalogs(first, second) {
    return first.id !== second.id && first.libraryId !== second.libraryId && path.relative(first.root, second.root) !== '';
  }

  async copyFromLibraries(id, collectionId, references, preserveCollections, eagleOnly = false) {
    const target = this.writable(id);
    if (eagleOnly && target.kind !== 'local') throw new Error('请选择接收 Eagle 素材的见藏本地库。');
    if (!Array.isArray(references) || references.length > maximumImportBatch) throw new Error('请分批选择要复制的素材。');
    const selected = new Map();
    let skipped = 0;
    for (const { id: assetId, registrationId } of references.map(reference => reference ?? {})) {
      const donor = this.registry.entries.find(entry => entry.id === registrationId);
      const asset = donor && this.catalogs.get(donor.id)?.assets.get(assetId);
      if (!asset || asset.trashed || !this.distinctCatalogs(donor, target) || (eagleOnly && donor.kind !== 'eagle')) {
        skipped++;
        continue;
      }
      selected.set(`${registrationId}:${assetId}`, { kind: 'catalog', registrationId, assetId, libraryId: donor.libraryId,
        ...(asset.eagleItemId && { eagleItemId: asset.eagleItemId }), name: asset.name, preserveCollections: preserveCollections === true });
    }
    if (!selected.size) throw new Error('请选择其他素材库里的可复制素材。');
    return this.enqueueSources(id, collectionId, [...selected.values()], skipped, target.libraryId);
  }

  captureTarget({ targetId, libraryId, collectionId } = {}, { allowPending = false } = {}) {
    if (typeof targetId !== 'string' || (collectionId != null && typeof collectionId !== 'string')) {
      throw new Error('请选择要接收浏览器采集的素材库。');
    }
    const entry = this.writable(targetId);
    if (libraryId != null && libraryId !== entry.libraryId) throw new Error('目标素材库已变化，请重新选择。');
    const library = this.catalogs.get(targetId).publicLibrary;
    if (entry.kind === 'jiancang') {
      if (library.logIncomplete || this.statuses.get(targetId)?.syncLogIncomplete) {
        throw new Error('目录记录尚未同步完整，请等待 iCloud 同步后重试。');
      }
      const { pending, error } = this.syncWriter.status(entry.libraryId);
      if (!allowPending && pending && error) throw new Error('目标库有待提交的修改，请在「同步状态」中重试。');
    }
    if (collectionId && !library.collections.some(item => item.id === collectionId)) throw new Error('目标集合已变化，请重新选择。');
    const [trail] = collectionId ? sourceCollectionPaths([collectionId], library.collections) : [];
    return { targetId, collectionId, libraryId: entry.libraryId,
      destination: trail?.length ? [library.directoryName, ...trail].join(' / ') : library.directoryName };
  }

  captureLibraries() {
    const available = [];
    for (const { id, kind, syncWritable } of this.registry.entries) {
      if (kind !== 'local' && !syncWritable) continue;
      try {
        const { targetId, libraryId } = this.captureTarget({ targetId: id });
        const { directoryName, collections } = this.catalogs.get(id).publicLibrary;
        available.push({ targetId, libraryId, name: directoryName, collections });
      } catch { /* Unavailable locations stay in the desktop library manager. */ }
    }
    return available;
  }

  createCaptureCollection(selection, name) {
    return this.serial(async () => {
      const { targetId, collectionId: parentId } = this.captureTarget(selection);
      const entry = this.writable(targetId);
      const result = await this.commitMutation(entry, { action: 'createCollection', name, parentId });
      if (result.pending) throw new Error('新集合已加入同步队列，写入完成后可在浏览器中选择。');
      await this.refreshEntry(entry);
      const collection = this.catalogs.get(targetId)?.publicLibrary.collections.find(item => item.id === result.id);
      if (!collection) throw new Error('集合已创建，请重新读取浏览器采集列表。');
      return collection;
    });
  }

  async importCapture(task) {
    const { id, targetId, collectionId, source } = task ?? {};
    if (!/^[a-f0-9]{32}$/.test(id ?? '') || typeof source?.targetLibraryId !== 'string') {
      throw new Error('无法识别此次采集，请重试。');
    }
    const selection = { targetId, collectionId, libraryId: source.targetLibraryId };
    this.captureTarget(selection, { allowPending: true });
    let input;
    let browserCapture;
    if (source.kind === 'image-url') {
      const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(25_000)]);
      const remote = await downloadDroppedImage([source.url, ...(source.fallbackURLs ?? [])], { signal });
      input = { filename: remote.name, bytes: remote.bytes, kind: 'image', sourceURL: webURL(source.sourceURL) ?? remote.sourceURL };
      browserCapture = { filename: remote.name, resolvedImageURL: remote.resolvedImageURL ?? remote.sourceURL,
        dimensions: imageDimensions(remote.bytes) };
    } else if (source.kind === 'buffer') {
      const extension = imageExtension(source.bytes);
      if (!extension) throw new Error('网页图片格式无效。');
      input = { filename: imageFilename(source.name || 'image', extension), bytes: source.bytes, kind: 'image', sourceURL: webURL(source.sourceURL) };
    } else if (source.kind === 'url') {
      const sourceURL = webURL(source.url);
      if (!sourceURL) throw new Error('找不到可保存的网页链接。');
      input = { sourceURL, name: source.name };
    } else throw new Error('无法识别此采集来源。');
    return this.serial(async () => {
      this.captureTarget(selection, { allowPending: true });
      const entry = this.writable(targetId);
      const result = await this.commitImport(entry, task, { ...input, tags: task.tags });
      if (result.pending) throw new Error(result.error || '同步素材尚未写入，请确认 iCloud Drive 可用后重试。');
      return { ...result, ...(browserCapture && { browserCapture }) };
    });
  }

  async importTask(task, onProgress) {
    const { source } = task;
    const remote = source.kind === 'image-url' && await downloadDroppedImage([source.url, ...(source.fallbackURLs ?? [])],
      { signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(25_000)]) });
    return this.serial(async () => {
      const entry = this.writable(task.targetId);
      if (source.targetLibraryId && source.targetLibraryId !== entry.libraryId) throw new Error('目标素材库已变化，请重新选择。');
      let input;
      if (remote) {
        input = { filename: remote.name, bytes: remote.bytes, kind: 'image', sourceURL: source.sourceURL ?? remote.sourceURL };
      } else if (source.kind === 'file') {
        input = { filename: source.name || path.basename(source.path), collectionPaths: source.collectionPaths, sourceURL: source.sourceURL,
          open: () => source.inboxKey ? openInboxOriginal(source) : openContainedFile(source.root, source.path) };
      } else if (source.kind === 'buffer') {
        input = { filename: source.name, bytes: source.bytes, kind: 'image', sourceURL: source.sourceURL };
      } else if (source.kind === 'url') {
        input = { sourceURL: source.url, name: source.name };
      } else if (source.kind === 'catalog') {
        input = await this.copyInput(entry, source);
      } else throw new Error('无法识别此导入来源。');
      return this.commitImport(entry, task, { ...input, onProgress }, { queued: true });
    });
  }

  async copyInput(target, source) {
    const donor = this.registry.entries.find(entry => entry.id === source.registrationId && entry.libraryId === source.libraryId)
      ?? this.registry.entries.find(entry => entry.libraryId === source.libraryId);
    if (!donor) throw new Error('请重新连接原素材库后重试。');
    if (!this.distinctCatalogs(donor, target)) throw new Error('请选择另一个接收素材的见藏库。');
    const locate = () => {
      const catalog = this.catalogs.get(donor.id);
      const asset = catalog?.assets.get(source.assetId) ??
        (source.eagleItemId && [...(catalog?.assets.values() ?? [])].find(asset => asset.eagleItemId === source.eagleItemId));
      return asset ? this.asset(asset.id, donor.id) : null;
    };
    let original = locate();
    if (!original || !original.file && original.asset.kind !== 'link') {
      await this.refreshEntry(donor);
      original = locate();
    }
    if (!original || original.asset.trashed || (!original.file && (original.asset.kind !== 'link' || !webURL(original.asset.sourceURL)))) {
      throw new Error('原件暂不可用，取回原件后可以重试。');
    }
    const { library, asset } = original;
    return {
      filename: exportFilename(asset.name, asset.extension), name: asset.name,
      open: original.file ? async () => (await openAsset(original, this.shutdown.signal)).handle : undefined,
      tags: asset.tags, note: asset.note, sourceURL: asset.sourceURL, rating: asset.rating, favorite: asset.favorite,
      collectionPaths: source.preserveCollections ? sourceCollectionPaths(asset.collectionIds, library.publicLibrary.collections) : [],
      kind: asset.kind, width: asset.width, height: asset.height, duration: asset.duration, createdAt: asset.createdAt,
    };
  }

  async commitImport(entry, task, fields, { queued = false } = {}) {
    const input = { ...fields, jobId: entry.kind === 'local' ? task.id : syncUploadId(task.id),
      expectedLibraryId: entry.libraryId, undoGroup: task.batchId,
      collectionIds: task.collectionId ? [task.collectionId] : [], collectionParentId: task.collectionId };
    const result = await (entry.kind === 'local' ? importLocalAsset(entry.root, input) : this.syncWriter.upload(entry, input));
    if (queued) await this.refreshImportedEntry(entry);
    else await this.refreshEntry(entry);
    return result;
  }

  asset(id, registrationId) {
    return assetForCatalog(this.catalogs, this.registry.selectedId, id, registrationId);
  }

  original(id, registrationId) {
    const result = this.asset(id, registrationId);
    if (!result.file) throw new Error('原件暂不可用。');
    return result;
  }

  async revealAsset(id, registrationId) {
    const original = this.original(id, registrationId);
    const { file, handle } = await openAsset(original, this.shutdown.signal);
    await handle.close();
    return file;
  }

  async defaultAssetPath(id, registrationId) {
    const original = this.original(id, registrationId);
    const { asset, library } = original;
    if (asset.trashed || !externalOpenExtensions.has(asset.extension)) throw new Error('请先导出这个格式的原件。');
    const { file, handle } = await openAsset(original, this.shutdown.signal);
    await handle.close();
    if (this.catalogs.get(library.registrationId)?.root !== library.root ||
        path.extname(file).slice(1).toLowerCase() !== asset.extension) {
      throw new Error('原件位置已变化，请刷新素材库。');
    }
    return file;
  }

  async copyTextPreview(id, registrationId, revision) {
    const original = this.original(id, registrationId);
    const { library } = original;
    if (library.cacheKey !== revision) throw new Error('素材已发生变化，请重新打开预览。');
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(15_000)]);
    const result = await readTextPreview(original, async input => (await openAsset(input, signal)).handle, signal);
    if (this.catalogs.get(library.registrationId) !== library) throw new Error('素材已发生变化，请重新打开预览。');
    if (!result.ok) return result;
    return result.text ? { ok: true, text: result.text } : { ok: false, message: '文件中没有可复制的文本。' };
  }

  async assetClipboard(references, mode) {
    const limit = mode === 'paths' ? 128 : maximumImportBatch;
    if (!clipboardModes.has(mode) || !Array.isArray(references) || !references.length || references.length > limit) {
      throw new Error(`请分批选择要复制的信息，每次最多 ${limit} 项。`);
    }
    const cells = [];
    const seen = new Set();
    for (const reference of references) {
      const { id, registrationId } = reference ?? {};
      if (typeof id !== 'string' || typeof registrationId !== 'string') continue;
      const key = `${registrationId}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const { library, asset } = this.asset(id, registrationId);
        const originalPath = mode === 'paths'
          ? await this.revealAsset(id, registrationId).catch(() => undefined) : undefined;
        cells.push({ asset, libraryName: library.publicLibrary.directoryName,
          originalPath: originalPath && !/[\r\n\t]/.test(originalPath) ? originalPath : undefined });
      } catch { /* Stale or inaccessible entries are omitted. */ }
    }
    const { text, copied } = clipboardText(cells, mode);
    const skipped = references.length - copied;
    if (!copied) throw new Error('所选素材暂无可复制的内容。');
    return { ok: true, text, copied, skipped,
      message: skipped ? `已复制 ${copied} 项，${skipped} 项暂无可用信息。` : `已复制 ${copied} 项。` };
  }

  async exportOriginal(id, registrationId, destination) {
    if (destination == null) return { cancelled: true };
    const filename = absolutePath(destination) && path.basename(destination);
    if (!filename || filename === '.' || filename === '..' || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(filename) ||
        /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(filename)) {
      throw new Error('请选择有效的导出文件名。');
    }
    const original = this.original(id, registrationId);
    await exportAsset(original, destination, [this.profile, ...this.registry.entries.map(entry => entry.root)]);
    return { ok: true };
  }

  command(name, args) {
    switch (name) {
      case 'library:state': return this.startup.then(() => this.state());
      case 'library:cancel-open': this.cancelOpen(); return this.state();
      case 'library:choose': return this.serial(() => this.open(args[1], args[0]));
      case 'library:relocate': return this.serial(() => this.open(args[1], null, this.entry(args[0])));
      case 'library:switch': return this.serial(async () => {
        const entry = this.entry(args[0]);
        this.message = null;
        if (!this.catalogs.has(entry.id) && !(await this.refreshEntry(entry))) {
          this.message = this.statuses.get(entry.id).message;
          return this.state();
        }
        await this.saveRegistry({ ...this.registry, selectedId: entry.id });
        return this.state();
      });
      case 'library:refresh': return this.serial(async () => {
        const entry = this.registry.entries.find(item => item.id === (args[0] ?? this.registry.selectedId));
        if (entry) {
          if (await this.refreshEntry(entry)) await this.flushSync(entry);
          this.message = this.statuses.get(entry.id).message ?? null;
        }
        return this.state();
      });
      case 'library:refresh-all': return this.serial(async () => {
        let unavailable = 0;
        for (const entry of this.registry.entries) {
          if (await this.refreshEntry(entry)) await this.flushSync(entry);
          else unavailable++;
        }
        this.message = unavailable ? `有 ${unavailable} 个素材库暂不可用，可在素材库管理中重新定位。` : null;
        return this.state();
      });
      case 'library:remove': return this.serial(async () => {
        const { id, kind } = this.entry(args[0]);
        if (kind !== 'eagle') {
          const { pending, running } = this.queue.summary(id);
          if (pending || running) {
            this.message = '请等本次导入结束后再移除素材库。';
            return this.state();
          }
        }
        await this.saveRegistry(detachLibrary(this.registry, id));
        this.catalogs.delete(id);
        this.statuses.delete(id);
        this.message = null;
        return this.state();
      });
      case 'library:reveal-path': return checkedDirectory(this.entry(args[0] ?? this.registry.selectedId).root);
      case 'library:reveal-open-path': return this.revealOpenFolder();
      case 'library:reveal-reading-path': return this.revealReadingItem(...args);
      case 'eagle:configure-write': return this.serial(() => this.setWriteEnabled(args[0], args[1], 'eagle'));
      case 'eagle:edit': return this.serial(() => this.editEagle(...args));
      case 'sync:configure-write': return this.serial(() => this.setWriteEnabled(args[0], args[1], 'jiancang'));
      case 'sync:retry-write': return this.serial(async () => {
        const entry = this.syncEntry(args[0]);
        this.writable(entry.id);
        const result = await this.flushSync(entry, true);
        if (!result) throw new Error('同步库暂不可写，请重新打开同步状态。');
        return { ok: true, ...result, state: this.state() };
      });
      case 'sync:latest-record-path': return this.serial(() => {
        if (!this.syncWriter) throw new Error('同步库暂不可用。');
        return this.syncWriter.lastPublishedPath(this.syncEntry(args[0]));
      });
      case 'sync-conflicts:list': {
        const entry = this.syncEntry(args[0]);
        return listSyncConflicts(entry.root, entry.libraryId, this.syncWriter?.acknowledgedConflicts(entry.libraryId));
      }
      case 'sync-conflicts:resolve': return this.serial(() => this.resolveSyncConflict(...args));
      case 'local:create': return this.serial(() => this.create(...args));
      case 'local:mutate': return this.serial(() => this.mutate(...args));
      case 'local-import:choose': return this.serial(() => this.enqueue(...args));
      case 'local-import:copy-assets': return this.serial(() => this.copyFromLibraries(...args));
      case 'local-import:copy-eagle': return this.serial(() => this.copyFromLibraries(...args.slice(0, 4), true));
      case 'local-import:list': {
        const { id } = this.importEntry(args[0]);
        const details = args[1]?.preview === true ? this.queue.previewSnapshot(id, args[1].collectionIds)
          : args[1] !== false ? { tasks: this.queue.snapshot(id) } : {};
        const refresh = this.importRefreshes.get(id);
        return { ok: true, ...details,
          summary: this.queue.summary(id), paused: this.queue.isPaused(id), catalogRevision: this.catalogs.get(id)?.cacheKey ?? null,
          refreshPending: Boolean(refresh?.timer || refresh?.syncDirty) };
      }
      case 'local-import:retry': return this.serial(async () => ({ ok: true, ...(await this.queue.retry(this.writable(args[0]).id, args[1])) }));
      case 'local-import:retry-failed': return this.serial(async () => ({ ok: true, ...(await this.queue.retryFailed(this.writable(args[0]).id)) }));
      case 'local-import:cancel': return this.serial(async () => ({ ok: true, ...(await this.queue.cancel(this.importEntry(args[0]).id, args[1])) }));
      case 'local-import:cancel-pending': return this.serial(async () => {
        const { id } = this.importEntry(args[0]);
        return { ok: true, cancelled: await this.queue.cancelPending(id) };
      });
      case 'local-import:set-paused': return this.serial(() => ({ ok: true, paused: this.queue.setPaused(this.writable(args[0]).id, args[1]) }));
      case 'asset:export-name': {
        const { asset } = this.original(...args);
        return exportFilename(asset.name, asset.extension);
      }
      case 'asset:export': return this.exportOriginal(...args);
      case 'asset:reveal-path': return this.revealAsset(...args);
      case 'asset:default-path': return this.defaultAssetPath(...args);
      case 'assets:copy-preview-text': return this.copyTextPreview(...args);
      case 'asset:link-url': {
        const url = webURL(this.asset(...args).asset.sourceURL);
        if (!url) throw new Error('此素材没有有效的网址。');
        return url;
      }
      case 'assets:write-clipboard': return this.assetClipboard(...args);
      default: throw new Error('此操作尚未接入 Tauri 候选版。');
    }
  }
}

module.exports = { LibraryService };
