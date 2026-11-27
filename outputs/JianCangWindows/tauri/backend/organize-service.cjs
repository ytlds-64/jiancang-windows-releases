'use strict';

const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { DuplicateReview } = require('../../duplicate-review.cjs');
const { FolderInbox } = require('../../folder-inbox.cjs');
const { duplicateMergeMetadata } = require('../../local-library.cjs');
const { openAsset } = require('./media.cjs');

const key = ref => `${ref.registrationId}:${ref.assetId}`;
const contentRevision = asset => JSON.stringify([asset.mediaRevision || asset.id, asset.byteCount, asset.width, asset.height]);

function describeDuplicate({ asset, library }) {
  return { registrationId: library.registrationId, assetId: asset.id, revision: contentRevision(asset),
    byteCount: asset.byteCount, kind: asset.kind, extension: asset.extension, name: asset.name,
    sourceName: library.publicLibrary.directoryName };
}

class OrganizeService {
  #review;
  #inbox;
  #inboxReady = false;
  #inboxRevision = 0;

  constructor(library, visual, { pollMs, quietMs } = {}) {
    this.library = library;
    this.visual = visual;
    this.#review = new DuplicateReview({
      openOriginal: async (reference, { signal } = {}) => {
        const original = this.#duplicateOriginal(reference);
        if (!original?.file) throw new Error('原件暂时无法读取。');
        const lifetime = signal ? AbortSignal.any([signal, library.shutdown.signal]) : library.shutdown.signal;
        return (await openAsset(original, lifetime)).handle;
      },
      getVisualRecords: (references, { signal }) => this.#visualRecords(references, signal),
    });
    this.#inbox = new FolderInbox({
      directory: path.join(library.profile, 'folder-inbox-v1'), pollMs, quietMs,
      getTarget: selection => library.captureTarget(selection),
      getProtectedRoots: () => library.registry.entries.map(entry => entry.root),
      enqueue: ({ targetId, collectionId, sources }) => library.serial(() => {
        const { libraryId } = library.captureTarget({ targetId, collectionId });
        return library.queue.enqueue({ targetId, collectionId, sources: sources.map(source => ({ ...source, targetLibraryId: libraryId })) });
      }),
      onChange: () => { this.#inboxRevision++; },
    });
  }

  async initialize() {
    await this.#inbox.initialize();
    this.#inboxReady = true;
  }

  async close() {
    this.#inboxReady = false;
    this.#review.cancel();
    await this.#inbox.close();
  }

  get inboxRevision() { return this.#inboxRevision; }
  duplicateProgress() { return this.#review.status(); }

  #duplicateOriginal(reference, allowRevisionChange = false) {
    if (typeof reference?.registrationId !== 'string' || typeof reference.assetId !== 'string') return null;
    try {
      const original = this.library.asset(reference.assetId, reference.registrationId);
      const { asset } = original;
      if (asset.trashed || !Number.isSafeInteger(asset.byteCount) || asset.byteCount < 0 ||
        (!allowRevisionChange && contentRevision(asset) !== reference.revision)) return null;
      return original;
    } catch { return null; }
  }

  #start(references, mode) {
    if (!Array.isArray(references) || references.length > 50_000) throw new Error('请选择不超过 50,000 项的素材范围。');
    const current = references.flatMap(reference => {
      const original = this.#duplicateOriginal(reference);
      return original ? [describeDuplicate(original)] : [];
    });
    return this.#review.start(current, { mode });
  }

  async #retry(jobId, registrationId) {
    if (this.#review.status()?.jobId !== jobId) throw new Error('扫描结果已变化，请重新打开重复素材整理。');
    const entry = this.library.entry(registrationId);
    await this.library.refreshEntry(entry);
    return this.#review.retry(jobId, registrationId, {
      refreshReference: reference => {
        const original = this.#duplicateOriginal(reference, true);
        return original ? describeDuplicate(original) : null;
      },
    });
  }

  async #visualRecords(references, signal) {
    const index = this.visual?.index;
    if (!index) throw new Error('无法读取本机图片索引。');
    const images = this.visual.refs(references);
    const settings = { includeSignatures: true };
    let indexed = index.lookup(images, settings);
    if (!this.library.ffmpeg || indexed.length === images.length) return indexed;
    while (index.status()?.status === 'running') await wait(120, undefined, { signal });
    signal.throwIfAborted();
    indexed = index.lookup(images, settings);
    const existing = new Set(indexed.map(key));
    const remaining = images.filter(ref => !existing.has(key(ref)) && this.#duplicateOriginal(ref)?.file);
    if (!remaining.length) return indexed;
    const job = index.start(remaining);
    try {
      for (let status = index.status(); status?.jobId === job.jobId && status.status === 'running'; status = index.status()) {
        await wait(120, undefined, { signal });
      }
      return index.lookup(images, settings);
    } finally {
      if (signal.aborted) index.cancel(job.jobId);
    }
  }

  #mergeContext(command) {
    const plan = this.#review.planMerge(command);
    const entry = this.library.entry(plan.keeper.registrationId);
    if (entry.kind !== 'local') throw new Error('合并标签和集合适用于同一本地库的副本。');
    this.library.writable(entry.id);
    const catalog = this.library.catalogs.get(entry.id);
    const assets = [plan.keeper, ...plan.selected].map(ref => {
      const original = this.#duplicateOriginal(ref);
      if (!original?.file || !original.asset.mediaRevision) throw new Error('有原件已变化或无法读取，请重新扫描该组。');
      return original.asset;
    });
    return { entry, catalog, plan, assets };
  }

  async #previewMerge(command) {
    const { keeper } = this.#review.planMerge(command);
    const entry = this.library.entry(keeper.registrationId);
    if (entry.kind !== 'local') throw new Error('合并标签和集合适用于同一本地库的副本。');
    if (!await this.library.refreshEntry(entry)) throw new Error('请重新连接本地库。');
    const { catalog, assets: [survivor, ...copies] } = this.#mergeContext(command);
    const { addedTags, addedCollectionIds } = duplicateMergeMetadata(survivor, copies);
    const collections = new Map(catalog.publicLibrary.collections.map(item => [item.id, item]));
    const addedCollections = addedCollectionIds.map(id => {
      const trail = [];
      const seen = new Set();
      for (let current = id; current && !seen.has(current);) {
        const folder = collections.get(current);
        if (!folder) throw new Error('集合已变化，请重新扫描该组。');
        seen.add(current);
        trail.push(folder.name);
        current = folder.parentId;
      }
      return trail.reverse().join(' / ');
    });
    return { ok: true, revision: catalog.publicLibrary.revision, keeperName: survivor.name, addedTags, addedCollections };
  }

  async #merge(command) {
    const { entry, catalog, plan, assets } = this.#mergeContext(command);
    if (command.revision !== catalog.publicLibrary.revision) throw new Error('素材资料已变化，请重新预览合并。');
    const moved = plan.selected;
    await this.library.commitMutation(entry, {
      action: 'mergeDuplicates', keeperId: plan.keeper.assetId, ids: moved.map(ref => ref.assetId),
      expectedRevision: command.revision, expectedMedia: new Map(assets.map(asset => [asset.id, asset.mediaRevision])),
    });
    this.#review.consumeTrash({ jobId: command.jobId, groupId: command.groupId, moved });
    await this.library.refreshEntry(entry);
    return { ok: true, moved, state: this.library.state(), message: `已合并标签和集合，${moved.length} 项已移到回收站。` };
  }

  async #trash(command) {
    const plan = this.#review.planTrash(command);
    const entries = new Map(this.library.registry.entries.map(entry => [entry.id, entry]));
    for (const id of new Set(plan.members.map(ref => ref.registrationId))) {
      if (entries.has(id)) await this.library.refreshEntry(entries.get(id));
    }
    // The same synchronization entity may be visible in another registration of the same library.
    const identity = ref => {
      const entry = entries.get(ref.registrationId);
      return entry?.kind === 'jiancang' ? `sync:${entry.libraryId}:${ref.assetId}` : key(ref);
    };
    const removing = new Set(plan.selected.map(identity));
    let survivor = false;
    for (const ref of plan.members) {
      if (removing.has(identity(ref))) continue;
      const original = this.#duplicateOriginal(ref);
      if (!original?.file) continue;
      try {
        const { handle } = await openAsset(original, this.library.shutdown.signal);
        await handle.close();
        survivor = true;
        break;
      } catch { /* A scanned original can become unavailable before a move. */ }
    }
    if (!survivor) throw new Error('至少需要保留一份当前可以读取的原件。请刷新并重新核对。');
    const targets = new Map();
    const moved = [];
    const failed = [];
    let pending = 0;
    for (const ref of plan.selected) {
      try {
        const entry = this.library.writable(ref.registrationId);
        if (!this.#duplicateOriginal(ref)?.file) throw new Error('这份素材已变化，请重新扫描。');
        if (!targets.has(entry.id)) targets.set(entry.id, { entry, refs: [] });
        targets.get(entry.id).refs.push(ref);
      } catch (error) { failed.push({ reference: ref, message: error.message }); }
    }
    for (const { entry, refs } of targets.values()) {
      try {
        const result = await this.library.commitMutation(entry, { action: 'trash', ids: refs.map(ref => ref.assetId) });
        moved.push(...refs);
        if (result.pending > 0) pending += refs.length;
        await this.library.refreshEntry(entry);
      } catch (error) { failed.push(...refs.map(reference => ({ reference, message: error.message }))); }
    }
    if (moved.length) this.#review.consumeTrash({ jobId: command.jobId, groupId: command.groupId, moved });
    const removed = moved.length - pending;
    const summary = [removed ? `${removed} 项已移到回收站` : '', pending ? `${pending} 项待提交同步` : '',
      failed.length ? `${failed.length} 项未完成` : ''].filter(Boolean).join('，');
    return { ok: true, moved, failed, state: this.library.state(), message: `${summary || '没有可移动的素材'}。` };
  }

  command(name, args = []) {
    const [first, second] = args;
    if (name.startsWith('inbox:') && !this.#inboxReady) throw new Error('无法打开本机监视目录设置，请重启见藏。');
    switch (name) {
      case 'duplicates:start': return this.library.serial(() => this.#start(first, second));
      case 'duplicates:status': return this.#review.status({ includeGroups: true });
      case 'duplicates:cancel': return this.#review.cancel(first);
      case 'duplicates:resume': return this.library.serial(() => this.#review.resume(first));
      case 'duplicates:retry': return this.library.serial(() => this.#retry(first, second));
      case 'duplicates:preview-merge': return this.library.serial(() => this.#previewMerge(first));
      case 'duplicates:merge': return this.library.serial(() => this.#merge(first));
      case 'duplicates:trash': return this.library.serial(() => this.#trash(first));
      case 'inbox:list': return this.#inbox.list();
      case 'inbox:add': return this.#inbox.add({ sourcePath: second, targetId: first?.targetId, collectionId: first?.collectionId ?? null,
        recursive: first?.recursive === true, includeExisting: first?.includeExisting === true });
      case 'inbox:pause': return this.#inbox.setPaused(first, second);
      case 'inbox:remove': return this.#inbox.remove(first);
      case 'inbox:scan': return this.#inbox.scan(first);
      default: throw new Error('此整理操作不可用。');
    }
  }
}

module.exports = { OrganizeService };
