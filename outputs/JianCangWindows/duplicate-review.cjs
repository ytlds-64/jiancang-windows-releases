'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { setImmediate: nextStep } = require('node:timers/promises');

const maximumScan = 50_000;
const matchingDistance = 10;
const registrationPattern = /^[\da-f-]{1,64}$/i;
const assetPattern = /^[\da-f]{64}$/;
const hashPattern = /^[\da-f]{16}$/;
const byteBits = Uint8Array.from({ length: 256 }, (_, value) => value.toString(2).replace(/0/g, '').length);
const neighborMasks = [0];
for (let bit = 0; bit < 16; bit++) {
  neighborMasks.push(1 << bit);
  for (let other = 0; other < bit; other++) neighborMasks.push((1 << bit) | (1 << other));
}

const key = ref => `${ref.registrationId}:${ref.assetId}`;

function cleanText(value, size) {
  return typeof value === 'string' ? value.slice(0, size) : '';
}

function scanRefs(input) {
  if (!Array.isArray(input) || input.length > maximumScan) throw new Error('一次最多扫描 50,000 份素材，请选择较小的素材范围。');
  const unique = new Map();
  for (const ref of input) {
    if (typeof ref?.registrationId !== 'string' || !registrationPattern.test(ref.registrationId) ||
        typeof ref.assetId !== 'string' || !assetPattern.test(ref.assetId) ||
        typeof ref.revision !== 'string' || !ref.revision.length || ref.revision.length > 512 || ref.revision.includes('\0') ||
        !Number.isSafeInteger(ref.byteCount) || ref.byteCount < 0) {
      throw new Error('素材信息已变化，请刷新后扫描。');
    }
    unique.set(key(ref), {
      registrationId: ref.registrationId, assetId: ref.assetId, revision: ref.revision, byteCount: ref.byteCount,
      kind: cleanText(ref.kind, 24), extension: cleanText(ref.extension, 24), name: cleanText(ref.name, 256),
      sourceName: cleanText(ref.sourceName, 160),
    });
  }
  return [...unique.values()];
}

function sameStamp(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function originalHash(ref, openOriginal, signal, chunk) {
  signal.throwIfAborted();
  const handle = await openOriginal(ref, { signal });
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(ref.byteCount)) throw new Error('原件大小已变化。');
    const digest = createHash('sha256');
    let position = 0;
    while (position < ref.byteCount) {
      signal.throwIfAborted();
      const length = Math.min(chunk.length, ref.byteCount - position);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) throw new Error('原件读取不完整。');
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    signal.throwIfAborted();
    if (!sameStamp(before, await handle.stat({ bigint: true }))) throw new Error('扫描过程中原件发生变化。');
    return digest.digest('hex');
  } finally { await handle.close(); }
}

function appendTo(map, group, value) {
  const existing = map.get(group);
  if (existing) existing.push(value);
  else map.set(group, [value]);
}

function groupExact(candidates, digests, removed) {
  const byHash = new Map();
  for (const ref of candidates) {
    const hash = digests.get(key(ref));
    if (!hash || removed.has(key(ref))) continue;
    appendTo(byHash, hash, ref);
  }
  return [...byHash].flatMap(([digest, members]) => members.length > 1
    ? [{ id: `original-${digest}`, kind: 'same-original', members }] : []);
}

function toSignature(row, ref) {
  if (row.revision !== ref.revision || typeof row.previewHash !== 'string' || !assetPattern.test(row.previewHash) ||
      typeof row.visualHash !== 'string' || !hashPattern.test(row.visualHash) ||
      !Number.isFinite(row.aspect) || row.aspect <= 0) return null;
  const signature = [0, 4, 8, 12].map(index => Number.parseInt(row.visualHash.slice(index, index + 4), 16));
  const color = typeof row.primaryColor === 'string' && /^#[\da-f]{6}$/i.test(row.primaryColor)
    ? [1, 3, 5].map(index => Number.parseInt(row.primaryColor.slice(index, index + 2), 16)) : null;
  return { ref, previewHash: row.previewHash, signature, color, flat: row.flat === true, aspect: row.aspect };
}

function visuallyClose(left, right) {
  if (left.flat !== right.flat || Math.abs(Math.log(left.aspect / right.aspect)) > 0.36) return false;
  if (left.color && right.color && Math.hypot(...left.color.map((value, index) => value - right.color[index])) > (left.flat ? 32 : 95)) return false;
  let differing = 0;
  for (let index = 0; index < left.signature.length; index++) {
    const bits = left.signature[index] ^ right.signature[index];
    differing += byteBits[bits >> 8] + byteBits[bits & 255];
    if (differing > matchingDistance) return false;
  }
  return true;
}

async function groupVisual(references, indexed, removed, signal, advance) {
  const byPreview = new Map();
  for (const ref of references) {
    const row = indexed.get(key(ref));
    if (row && !removed.has(key(ref))) appendTo(byPreview, row.previewHash, row);
  }
  const groups = [...byPreview].flatMap(([hash, rows]) => rows.length > 1
    ? [{ id: `preview-${hash}`, kind: 'same-preview', members: rows.map(row => row.ref) }] : []);
  const buckets = Array.from({ length: 4 }, () => new Map());
  const clusters = [];
  let strides = 0;
  for (const rows of byPreview.values()) {
    const [representative] = rows;
    signal.throwIfAborted();
    // At most 10 bits differ. At least one of the four 16-bit blocks must be within two bits.
    const candidates = new Set();
    for (let index = 0; index < buckets.length; index++) {
      for (const mask of neighborMasks) {
        const list = buckets[index].get(representative.signature[index] ^ mask);
        if (list) for (const cluster of list) candidates.add(cluster);
      }
    }
    let destination = null;
    for (const candidate of candidates) {
      if ((++strides & 4095) === 0) { await nextStep(); signal.throwIfAborted(); }
      if (candidate.every(member => visuallyClose(member, representative))) { destination = candidate; break; }
    }
    if (destination) destination.push(representative);
    else {
      const cluster = [representative];
      clusters.push(cluster);
      representative.signature.forEach((block, index) => appendTo(buckets[index], block, cluster));
    }
    advance(rows.length);
    if (((++strides) & 127) === 0) await nextStep();
  }
  for (const cluster of clusters) {
    if (cluster.length < 2) continue;
    const members = cluster.map(row => row.ref);
    groups.push({ id: `similar-${key(members[0])}`, kind: 'similar-image', members });
  }
  return groups;
}

class DuplicateReview {
  #job = null;
  #controller = null;
  #notifyAt = 0;

  constructor({ openOriginal, getVisualRecords, onChange }) {
    this.openOriginal = openOriginal;
    this.getVisualRecords = getVisualRecords;
    this.onChange = onChange;
  }

  status({ includeGroups = false } = {}) {
    const job = this.#job;
    if (!job) return null;
    const { jobId, mode, status, stage, total, processed, candidates, hashed, indexed, unindexed, message } = job;
    const response = { jobId, mode, status, stage, total, processed, candidates, hashed, indexed, unindexed,
      failed: job.failures.size, groupCount: job.groups.length, message };
    if (!includeGroups) return response;
    const issues = new Map();
    for (const [refs, reason] of [[job.failures.values(), 'failed'], [job.missing.values(), 'unindexed']]) {
      for (const ref of refs) {
        const row = issues.get(ref.registrationId) || { registrationId: ref.registrationId,
          sourceName: ref.sourceName, failed: 0, unindexed: 0 };
        row[reason]++;
        issues.set(ref.registrationId, row);
      }
    }
    return { ...response, groups: structuredClone(job.groups), issues: [...issues.values()] };
  }

  #emit(force = false) {
    const now = Date.now();
    if (!force && now - this.#notifyAt < 130) return;
    this.#notifyAt = now;
    try { this.onChange?.(this.status()); }
    catch { /* Scans do not depend on a visible progress panel. */ }
  }

  start(references, { mode = 'exact' } = {}) {
    if (this.#job?.status === 'running') throw new Error('已有扫描正在进行。');
    if (!['exact', 'visual'].includes(mode)) throw new Error('请选择一种扫描方式。');
    const refs = scanRefs(references).filter(ref => mode === 'exact' || ref.kind === 'image' || ref.extension === 'livp');
    if (!refs.length) throw new Error(mode === 'visual' ? '当前范围没有可分析的图片。' : '当前范围没有可扫描的素材。');
    const sizes = new Map();
    if (mode === 'exact') for (const ref of refs) appendTo(sizes, ref.byteCount, ref);
    const matching = mode === 'exact' ? refs.filter(ref => sizes.get(ref.byteCount).length > 1) : refs;
    const job = { jobId: randomUUID(), mode, status: 'running', stage: mode === 'exact' ? 'hashing' : 'reading-index',
      total: refs.length, candidates: matching.length, processed: refs.length - matching.length, hashed: 0, indexed: 0,
      unindexed: 0, message: '', groups: [], refs, matching, failures: new Map(), missing: new Map(),
      digests: new Map(), signatures: new Map(), removed: new Set() };
    this.#job = job;
    this.#launch(job, matching);
    return this.status();
  }

  cancel(jobId) {
    if (this.#job?.status === 'running' && (jobId == null || this.#job.jobId === jobId)) this.#controller?.abort();
    return this.status();
  }

  resume(jobId) {
    const job = this.#job;
    if (!job || job.jobId !== jobId || job.status !== 'cancelled') throw new Error('当前没有可继续的扫描。');
    const { queue, completed, prepare } = job.pass;
    const remaining = queue.filter(ref => !completed.has(key(ref)) && !job.removed.has(key(ref)));
    job.status = 'running';
    job.stage = job.mode === 'exact' ? 'hashing' : 'reading-index';
    job.processed = job.total - remaining.length;
    this.#launch(job, remaining, prepare);
    return this.status();
  }

  retry(jobId, registrationId, { refreshReference } = {}) {
    const job = this.#job;
    if (!job || job.jobId !== jobId || job.status === 'running') throw new Error('当前没有可重试的扫描结果。');
    const retryItems = [...(job.mode === 'exact' ? job.failures : new Map([...job.missing, ...job.failures])).values()]
      .filter(ref => ref.registrationId === registrationId && !job.removed.has(key(ref)));
    if (!retryItems.length) throw new Error('该素材库没有可重试的扫描项。');
    job.status = 'running';
    job.stage = job.mode === 'exact' ? 'hashing' : 'reading-index';
    job.message = '';
    job.processed = job.total - retryItems.length;
    const prepare = typeof refreshReference === 'function'
      ? signal => this.#refreshLibrary(job, registrationId, refreshReference, signal)
      : null;
    this.#launch(job, retryItems, prepare);
    return this.status();
  }

  async #refreshLibrary(job, registrationId, refreshReference, signal) {
    const pending = job.refs.filter(ref => ref.registrationId === registrationId && !job.removed.has(key(ref)));
    const current = new Map();
    let read = 0;
    for (const ref of pending) {
      signal.throwIfAborted();
      try {
        const replacement = await refreshReference(ref, { signal });
        if (replacement && key(replacement) === key(ref)) current.set(key(ref), scanRefs([replacement])[0]);
      } catch { /* The item remains available for another scan once the source reconnects. */ }
      if ((++read & 127) === 0) await nextStep();
    }
    signal.throwIfAborted();
    const replaced = new Set();
    const offline = new Set();
    job.refs = job.refs.map(previous => {
      const id = key(previous);
      if (previous.registrationId !== registrationId || job.removed.has(id)) return previous;
      const ref = current.get(id);
      if (!ref) {
        offline.add(id);
        job.failures.set(id, previous);
        job.missing.delete(id);
      }
      if (!ref || previous.revision !== ref.revision || previous.byteCount !== ref.byteCount) {
        replaced.add(id);
        job.digests.delete(id);
        job.signatures.delete(id);
      }
      return ref || previous;
    });
    job.groups = job.groups.map(group => ({ ...group,
      members: group.members.filter(ref => !replaced.has(key(ref))).map(ref => current.get(key(ref)) || ref),
    })).filter(group => group.members.length > 1);
    const usable = ref => !job.removed.has(key(ref)) && !offline.has(key(ref));
    if (job.mode === 'exact') {
      const sizes = new Map();
      for (const ref of job.refs) if (!job.removed.has(key(ref))) sizes.set(ref.byteCount, (sizes.get(ref.byteCount) || 0) + 1);
      job.matching = job.refs.filter(ref => sizes.get(ref.byteCount) > 1 && !job.removed.has(key(ref)));
      job.candidates = job.matching.length;
      job.hashed = job.digests.size;
      const kept = new Set(job.matching.map(key));
      for (const id of job.failures.keys()) if (!kept.has(id)) job.failures.delete(id);
      return job.matching.filter(ref => usable(ref) && !job.digests.has(key(ref)) &&
        (ref.registrationId === registrationId || !job.failures.has(key(ref))));
    }
    job.indexed = job.signatures.size;
    return job.refs.filter(ref => ref.registrationId === registrationId && usable(ref) && !job.signatures.has(key(ref)));
  }

  #launch(job, queue, prepare) {
    this.#controller = new AbortController();
    const { signal } = this.#controller;
    job.pass = { queue, prepare, completed: new Set() };
    this.#emit(true);
    void this.#run(job, job.pass, signal);
  }

  async #run(job, pass, signal) {
    let oldGroups = job.groups;
    try {
      if (pass.prepare) {
        pass.queue = await pass.prepare(signal);
        pass.prepare = null;
        oldGroups = job.groups;
        job.processed = job.total - pass.queue.length;
      }
      const { queue, completed } = pass;
      if (job.mode === 'exact') {
        let cursor = 0;
        const worker = async () => {
          const chunk = Buffer.allocUnsafe(1024 * 1024);
          for (; !signal.aborted && cursor < queue.length;) {
            const ref = queue[cursor++];
            try {
              const digest = await originalHash(ref, this.openOriginal, signal, chunk);
              job.digests.set(key(ref), digest);
              job.failures.delete(key(ref));
            } catch {
              if (signal.aborted) break;
              job.failures.set(key(ref), ref);
            }
            completed.add(key(ref));
            job.hashed = job.digests.size;
            job.processed++;
            this.#emit();
          }
        };
        // Two readers keep disk latency bounded without opening whole videos or archives in memory.
        await Promise.all([worker(), worker()]);
        job.groups = groupExact(job.matching, job.digests, job.removed);
      } else {
        for (let offset = 0; offset < queue.length; offset += 280) {
          signal.throwIfAborted();
          const batch = queue.slice(offset, offset + 280);
          try {
            const rows = await this.getVisualRecords(batch, { signal });
            signal.throwIfAborted();
            if (!Array.isArray(rows)) throw new Error('无法读取图片索引。');
            const indexed = new Map(rows.map(row => [key(row), row]));
            for (const ref of batch) {
              const row = indexed.get(key(ref));
              const signature = row && toSignature(row, ref);
              job.failures.delete(key(ref));
              if (signature) {
                job.missing.delete(key(ref));
                job.signatures.set(key(ref), signature);
              } else job.missing.set(key(ref), ref);
            }
          } catch (error) {
            if (signal.aborted) throw error;
            for (const ref of batch) {
              job.missing.delete(key(ref));
              job.failures.set(key(ref), ref);
            }
          }
          for (const ref of batch) completed.add(key(ref));
          job.indexed = job.signatures.size;
          job.unindexed = job.missing.size;
          job.processed += batch.length;
          this.#emit();
          await nextStep();
        }
        if (!signal.aborted) {
          job.stage = 'matching';
          job.processed = job.total - job.indexed;
          this.#emit(true);
          job.groups = await groupVisual(job.refs, job.signatures, job.removed, signal, matched => {
            job.processed += matched;
            this.#emit();
          });
        }
      }
    } catch (error) {
      job.groups = oldGroups;
      if (!signal.aborted) job.message = cleanText(error?.message, 180) || '扫描未完成。';
    }
    job.status = signal.aborted ? 'cancelled' : job.message ? 'failed' : 'completed';
    if (job.status === 'completed') job.processed = job.total;
    if (job.status !== 'cancelled') job.pass = null;
    job.unindexed = job.missing.size;
    job.stage = null;
    this.#emit(true);
  }

  planTrash({ jobId, groupId, selected } = {}) {
    const job = this.#job;
    const group = job?.jobId === jobId && job.status !== 'running' && job.groups.find(row => row.id === groupId);
    if (!group || !Array.isArray(selected) || selected.length === 0 || selected.length >= group.members.length) {
      throw new Error('请重新核对该组，并至少保留一份素材。');
    }
    const members = new Map(group.members.map(ref => [key(ref), ref]));
    const accepted = new Map();
    for (const ref of selected) {
      const known = ref && members.get(key(ref));
      if (!known || known.revision !== ref.revision) throw new Error('素材已变化，请重新扫描该组。');
      accepted.set(key(known), known);
    }
    return { kind: group.kind, members: group.members.map(ref => ({ ...ref })),
      selected: [...accepted.values()].map(ref => ({ ...ref })) };
  }

  planMerge(command) {
    const { kind, members, selected } = this.planTrash(command);
    if (kind !== 'same-original') throw new Error('合并资料需要原件完全一致。请使用按原件扫描。');
    const reference = command.keeper;
    const keeper = reference && members.find(ref => key(ref) === key(reference) && ref.revision === reference.revision);
    if (!keeper || selected.some(ref => key(ref) === key(keeper))) {
      throw new Error('请重新选择要保留的素材。');
    }
    if (selected.some(ref => ref.registrationId !== keeper.registrationId)) {
      throw new Error('请选择与保留项在同一本地库中的副本。');
    }
    return { keeper, selected };
  }

  consumeTrash({ jobId, groupId, moved } = {}) {
    const job = this.#job;
    if (!job || job.jobId !== jobId || !Array.isArray(moved) || !moved.length) return this.status();
    const { selected } = this.planTrash({ jobId, groupId, selected: moved });
    for (const ref of selected) job.removed.add(key(ref));
    job.groups = job.groups.map(group => ({ ...group,
      members: group.members.filter(ref => !job.removed.has(key(ref))),
    })).filter(group => group.members.length > 1);
    this.#emit(true);
    return this.status();
  }
}

module.exports = { DuplicateReview };
