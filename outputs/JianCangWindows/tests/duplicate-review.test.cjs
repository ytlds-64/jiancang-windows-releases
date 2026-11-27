'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: wait } = require('node:timers/promises');
const { DuplicateReview } = require('../duplicate-review.cjs');

function ref(id, extra) {
  return { registrationId: 'aa', assetId: id.toString(16).padStart(64, '0'), revision: 'test-v1',
    name: `测试素材 ${id}`, sourceName: '测试库', byteCount: 4, kind: 'image', extension: 'png', ...extra };
}

function itemKey(ref) { return `${ref.registrationId}:${ref.assetId}`; }

async function settled(review) {
  for (let step = 0; step < 400; step++) {
    const state = review.status({ includeGroups: true });
    if (state && state.status !== 'running') return state;
    await wait(5);
  }
  throw new Error('duplicate scan timed out');
}

async function files(t, pairs) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-duplicate-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const paths = new Map();
  for (const [ref, content] of pairs) {
    const file = path.join(directory, `${ref.registrationId}-${ref.assetId}`);
    await fs.writeFile(file, content);
    paths.set(itemKey(ref), file);
  }
  return paths;
}

test('hashes only equal-length originals, keeps registration identity and never plans an entire group for removal', async t => {
  const a = ref(1);
  const b = ref(1, { registrationId: 'bb', sourceName: '另一个库' });
  const c = ref(3);
  const d = ref(4, { byteCount: 8 });
  const paths = await files(t, [[a, 'same'], [b, 'same'], [c, 'diff'], [d, 'singular']]);
  const opened = [];
  const review = new DuplicateReview({ openOriginal: ref => {
    opened.push(itemKey(ref));
    return fs.open(paths.get(itemKey(ref)), 'r');
  } });
  const running = review.start([a,b,c,d], { mode: 'exact' });
  assert.equal(running.status, 'running');
  assert.equal(running.candidates, 3);
  const result = await settled(review);
  assert.equal(result.processed, 4);
  assert.equal(result.hashed, 3);
  assert.deepEqual(opened.sort(), [a,b,c].map(itemKey).sort());
  assert.equal(result.groups.length, 1);
  const group = result.groups[0];
  assert.equal(group.kind, 'same-original');
  assert.deepEqual(group.members.map(itemKey), [a,b].map(itemKey));
  const command = { jobId: result.jobId, groupId: group.id };
  assert.throws(() => review.planTrash({ ...command, selected: [a,b] }), /至少保留/);
  assert.throws(() => review.planTrash({ ...command, selected: [{ ...b, revision: 'later' }] }), /已变化/);
  assert.deepEqual(review.planTrash({ ...command, selected: [b] }).selected.map(itemKey), [itemKey(b)]);
  review.consumeTrash({ ...command, moved: [b] });
  assert.equal(review.status().groupCount, 0);
  assert.equal(await fs.readFile(paths.get(itemKey(b)), 'utf8'), 'same');
});

test('merges only exact copies from the keeper’s library and validates the keeper reference', async t => {
  const keeper = ref(1);
  const copy = ref(2);
  const external = ref(3, { registrationId: 'bb' });
  const paths = await files(t, [[keeper, 'same'], [copy, 'same'], [external, 'same']]);
  const review = new DuplicateReview({ openOriginal: ref => fs.open(paths.get(itemKey(ref)), 'r') });
  review.start([keeper, copy, external], { mode: 'exact' });
  const { jobId, groups: [group] } = await settled(review);
  const command = { jobId, groupId: group.id, keeper, selected: [copy] };
  assert.equal(review.planMerge(command).keeper.assetId, keeper.assetId);
  assert.throws(() => review.planMerge({ ...command, selected: [keeper] }), /重新选择要保留/);
  assert.throws(() => review.planMerge({ ...command, selected: [external] }), /同一本地库/);
  assert.throws(() => review.planMerge({ ...command, keeper: { ...keeper, revision: 'later' } }), /重新选择要保留/);
});

test('reports scoped I/O failures and invalidates stale digests when retrying hydrated records', async t => {
  const change = ref(1);
  const late = ref(2);
  const peer = ref(3, { registrationId: 'cc' });
  const paths = await files(t, [[change, 'same'], [late, 'same'], [peer, 'same']]);
  let hydrated = false;
  const reads = [];
  const review = new DuplicateReview({ openOriginal: ref => {
    reads.push(itemKey(ref));
    if (!hydrated && ref.assetId === late.assetId) throw new Error('Offline');
    return fs.open(paths.get(itemKey(ref)), 'r');
  } });
  const { jobId } = review.start([change, late, peer], { mode: 'exact' });
  let result = await settled(review);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.issues, [{ registrationId:'aa', sourceName:'测试库', failed:1, unindexed:0 }]);
  assert.deepEqual(result.groups[0].members.map(itemKey), [change, peer].map(itemKey));
  hydrated = true;
  await fs.writeFile(paths.get(itemKey(change)), 'diff');
  reads.length = 0;
  review.retry(jobId, 'aa', { refreshReference: ref => ({...ref, revision:'test-v2'}) });
  result = await settled(review);
  assert.deepEqual(reads.sort(), [change, late].map(itemKey).sort());
  assert.equal(result.failed, 0);
  assert.deepEqual(result.groups[0].members.map(itemKey), [late, peer].map(itemKey));
  assert.equal(result.groups[0].members[0].revision, 'test-v2');
  assert.equal(result.groups[0].members[1].revision, 'test-v1');
});

test('review groups keep identical normalized previews and do not join a chain of visually different images', async () => {
  const a = ref(1); const b = ref(2); const c = ref(3); const duplicated = ref(4); const offline = ref(5, { registrationId:'bb' });
  const signatures = new Map([
    [itemKey(a), { previewHash: 'e'.repeat(64), visualHash: '0000000000000000' }],
    [itemKey(b), { previewHash: 'f'.repeat(64), visualHash: '000000000000003f' }],
    [itemKey(c), { previewHash: 'a'.repeat(64), visualHash: '0000000000000fff' }],
    [itemKey(duplicated), { previewHash: 'e'.repeat(64), visualHash: '0000000000000000' }],
  ]);
  const review = new DuplicateReview({ getVisualRecords: refs => refs.flatMap(ref => {
    const data = signatures.get(itemKey(ref));
    return data ? [{ ...ref, ...data, aspect: 1, flat: false, primaryColor: '#aa6633' }] : [];
  }) });
  review.start([a,b,c,duplicated,offline], { mode:'visual' });
  const result = await settled(review);
  assert.equal(result.unindexed, 1);
  assert.equal(result.indexed, 4);
  assert.deepEqual(result.groups.map(group => [group.kind,group.members.map(itemKey)]), [
    ['same-preview',[a,duplicated].map(itemKey)], ['similar-image',[a,b].map(itemKey)],
  ]);
  assert.throws(() => review.planMerge({ jobId: result.jobId, groupId: result.groups[0].id,
    keeper: a, selected: [duplicated] }), /原件完全一致/);
  assert.equal(result.issues[0].registrationId, 'bb');
});

test('cancellation closes held original streams without classifying interrupted reads as I/O failure', async () => {
  const a = ref(1); const b = ref(2);
  let closed = 0;
  let releaseWaiting;
  const waiting = new Promise(resolve => { releaseWaiting = resolve; });
  let opened = 0;
  const review = new DuplicateReview({ openOriginal: async () => {
    opened++;
    await waiting;
    return {
      stat: () => ({ isFile: () => true, size: 4n, dev: 1n, ino: 1n, mtimeNs: 1n, ctimeNs: 1n }),
      read: () => { throw new Error('The cancelled read must not run'); },
      close: () => { closed++; },
    };
  } });
  const { jobId } = review.start([a,b]);
  assert.equal(opened, 2);
  review.cancel(jobId);
  releaseWaiting();
  const result = await settled(review);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.failed, 0);
  assert.equal(closed, 2);
});

test('resumes an interrupted original scan without hashing originals it already checked', async t => {
  const items = [ref(1), ref(2), ref(3), ref(4)];
  const paths = await files(t, items.map(item => [item, 'same']));
  let release;
  let notifyWaiting;
  const hold = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { notifyWaiting = resolve; });
  let interrupted = false;
  const reads = [];
  const review = new DuplicateReview({ openOriginal: async item => {
    reads.push(item.assetId);
    if (!interrupted && item.assetId !== items[0].assetId) {
      if (reads.length === 3) notifyWaiting();
      await hold;
    }
    return fs.open(paths.get(itemKey(item)), 'r');
  } });
  const { jobId } = review.start(items);
  await waiting;
  review.cancel(jobId);
  interrupted = true;
  release();
  const stopped = await settled(review);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.hashed, 1);
  assert.throws(() => review.resume('old-job'), /没有可继续/);

  reads.length = 0;
  assert.equal(review.resume(jobId).jobId, jobId);
  const resumed = await settled(review);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.hashed, items.length);
  assert.deepEqual(reads.sort(), items.slice(1).map(item => item.assetId).sort());
  assert.deepEqual(resumed.groups[0].members.map(itemKey), items.map(itemKey));
});

test('continues only the unfinished image batch and regroups the retained image signatures', async () => {
  const items = Array.from({ length: 282 }, (_, index) => ref(index + 1));
  const batches = [];
  let interruption = true;
  const review = new DuplicateReview({ getVisualRecords: (refs, { signal }) => {
    batches.push(refs.length);
    if (refs.length === 2 && interruption) {
      interruption = false;
      review.cancel(review.status().jobId);
      signal.throwIfAborted();
    }
    return refs.map(item => ({ ...item, previewHash: 'a'.repeat(64), visualHash: '0'.repeat(16), aspect: 1 }));
  } });
  const { jobId } = review.start(items, { mode: 'visual' });
  const stopped = await settled(review);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.indexed, 280);
  review.resume(jobId);
  const resumed = await settled(review);
  assert.deepEqual(batches, [280, 2, 2]);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.processed, items.length);
  assert.equal(resumed.groups[0].members.length, items.length);
});
