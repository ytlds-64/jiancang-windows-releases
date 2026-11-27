'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { CloudOriginalQueue } = require('../cloud-original-queue.cjs');

const assetId = number => number.toString(16).padStart(64, '0');
const entry = (number, byteCount = 10) => ({ id: assetId(number), name: `素材 ${number}`, byteCount });
const codeError = code => Object.assign(new Error('Private system path /Users/test/secret'), { code });
const success = byteCount => ({ ok: true, bytes: byteCount });
const references = { a: { registrationId: 'a', libraryId: 'a1' }, b: { registrationId: 'b', libraryId: 'b1' } };

async function waitFor(ready, what = 'queue to finish') {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (ready()) return;
    await delay(5);
  }
  assert.fail(`Timed out waiting for ${what}`);
}

async function fixture(t, options) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-cloud-test-'));
  const queues = [];
  t.after(async () => {
    await Promise.all(queues.map(queue => queue.close()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function open(settings = {}) {
    const queue = new CloudOriginalQueue({ directory,
      resolve: async ref => ({ ...ref, byteCount: 10 }),
      readOriginal: async source => success(source.byteCount),
      ...options, ...settings });
    queues.push(queue);
    await queue.initialize();
    return queue;
  }
  const queue = await open();
  return { directory, queue, open };
}

test('keeps batches deduplicated, advances no more than two readers, and reports verified bytes', async t => {
  const active = new Map();
  let simultaneous = 0;
  const changed = [];
  const { queue } = await fixture(t, {
    onChange: id => changed.push(id),
    readOriginal(source, { signal, onProgress }) {
      return new Promise((resolve, reject) => {
        const abort = () => { active.delete(source.id); reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        active.set(source.id, {
          onProgress,
          finish() {
            active.delete(source.id);
            signal.removeEventListener('abort', abort);
            resolve(success(source.byteCount));
          },
        });
        simultaneous = Math.max(simultaneous, active.size);
      });
    },
  });
  assert.deepEqual(queue.enqueue('a', 'a1', [entry(1), entry(2), entry(3), entry(1)]), { added: 3, total: 3 });
  assert.deepEqual(queue.enqueue('b', 'b1', [entry(4)]), { added: 1, total: 1 });
  queue.start();
  await waitFor(() => active.has(assetId(1)) && active.has(assetId(4)), 'one reader from each queued library');
  assert.deepEqual(queue.enqueue('a', 'a1', [entry(1), entry(2)], { recheck: true }), { added: 0, total: 3 });
  active.get(assetId(1)).onProgress(-1);
  assert.equal(queue.status('a').downloadedBytes, 0);
  active.get(assetId(1)).onProgress(6);
  assert.deepEqual(queue.status('a', { filter: 'running' }).tasks[0], {
    id: assetId(1), name: '素材 1', byteCount: 10, status: 'running', downloadedBytes: 6, code: null, message: null,
  });
  assert.equal(queue.status('a').downloadedBytes, 6);
  assert.equal(queue.status('b').downloadedBytes, 0);
  active.get(assetId(1)).finish();
  await waitFor(() => active.has(assetId(2)));
  active.get(assetId(2)).finish();
  await waitFor(() => active.has(assetId(3)));
  active.get(assetId(3)).finish();
  active.get(assetId(4)).finish();
  await waitFor(() => queue.status('a').done === 3 && queue.status('b').done === 1);
  assert.equal(queue.status('a').downloadedBytes, 30);
  assert.equal(queue.status('a').totalBytes, 30);
  assert.equal(simultaneous, 2);
  await waitFor(() => changed.includes('a') && changed.includes('b'));
  assert.ok(changed.every(id => id === 'a' || id === 'b'));
});

test('retries individual or all failures within one library and exposes no source paths or private errors', async t => {
  const failures = new Map([[assetId(1), 'ENOENT'], [assetId(2), 'CHECKSUM'], [assetId(3), 'ENOSPC']]);
  const { queue } = await fixture(t, {
    readOriginal(source, { onProgress }) {
      const failure = failures.get(source.id);
      if (!failure) return success(source.byteCount);
      onProgress(6);
      if (failure === 'CHECKSUM') return { ok: false, code: failure, message: 'Private /Users/test/path' };
      throw codeError(failure);
    },
  });
  queue.enqueue('a', 'a1', [entry(1), entry(2)]);
  queue.enqueue('b', 'b1', [entry(3)]);
  queue.start();
  await waitFor(() => queue.status('a').failed === 2 && queue.status('b').failed === 1);
  assert.deepEqual(queue.status('a', { filter: 'failed' }).tasks.map(task => task.code), ['MISSING', 'CHECKSUM']);
  assert.equal(queue.status('b').tasks[0].code, 'DISK_SPACE');
  assert.equal(queue.status('a').downloadedBytes, 0);
  assert.doesNotMatch(JSON.stringify(queue.status('a')), /Private|\/Users/);
  failures.delete(assetId(1));
  failures.delete(assetId(2));
  assert.equal(queue.retry('a', assetId(3)), 0);
  assert.equal(queue.retry('a', assetId(1)), 1);
  await waitFor(() => queue.status('a').done === 1);
  assert.equal(queue.status('a').failed, 1);
  assert.equal(queue.retry('a'), 1);
  await waitFor(() => queue.status('a').done === 2);
  assert.equal(queue.status('b').failed, 1);
});

test('pauses an in-progress read, lets another library finish, and keeps pause through restart and retries', async t => {
  let aborted = false;
  const { queue, open } = await fixture(t, {
    readOriginal(source, { signal, onProgress }) {
      if (source.id === assetId(2) || source.registrationId === 'b') return success(source.byteCount);
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
        onProgress(4);
      });
    },
  });
  queue.enqueue('a', 'a1', [entry(1), entry(2)]);
  queue.setPaused('a', true);
  queue.enqueue('b', 'b1', [entry(3)]);
  queue.start();
  await waitFor(() => queue.status('b').done === 1);
  assert.equal(queue.status('a').pending, 2);
  queue.setPaused('a', false);
  await waitFor(() => queue.status('a').running === 1 && queue.status('a').done === 1);
  assert.equal(queue.status('a').downloadedBytes, 14);
  queue.setPaused('a', true);
  await waitFor(() => queue.status('a').pending === 1);
  assert.equal(queue.status('a').downloadedBytes, 10);
  assert.equal(aborted, true);
  await queue.close();

  const reopened = await open({ readOriginal: async source => success(source.byteCount) });
  reopened.start();
  assert.equal(reopened.status('a').paused, true);
  assert.deepEqual(reopened.enqueue('a', 'a1', [entry(2)], { recheck: true }), { added: 1, total: 2 });
  await delay(50);
  assert.equal(reopened.status('a').pending, 2);
  assert.equal(reopened.status('b').done, 1);
  reopened.setPaused('a', false);
  await waitFor(() => reopened.status('a').done === 2);
});

test('uses the latest authorized size, handles short reads, and allows an explicit recheck after completion', async t => {
  let currentSize = 64;
  let suppliedSize = 63;
  const resolved = [];
  const { queue } = await fixture(t, {
    resolve(ref) { resolved.push(ref); return { byteCount: currentSize, root: 'sensitive absolute directory' }; },
    readOriginal() { return success(suppliedSize); },
  });
  queue.enqueue('a', 'a1', [entry(1, 0)]);
  queue.start();
  await waitFor(() => queue.status('a').failed === 1);
  assert.equal(queue.status('a').totalBytes, 64);
  assert.equal(queue.status('a').tasks[0].code, 'INCOMPLETE');
  suppliedSize = 64;
  assert.equal(queue.retry('a', assetId(1)), 1);
  await waitFor(() => queue.status('a').done === 1);
  assert.equal(queue.status('a').downloadedBytes, 64);
  assert.deepEqual(queue.enqueue('a', 'a1', [entry(1, 64)]), { added: 0, total: 1 });
  currentSize = suppliedSize = 200;
  assert.deepEqual(queue.enqueue('a', 'a1', [entry(1, 64)], { recheck: true }), { added: 1, total: 1 });
  await waitFor(() => queue.status('a').done === 1);
  assert.equal(queue.status('a').totalBytes, 200);
  assert.equal(queue.status('a').downloadedBytes, 200);
  assert.deepEqual(resolved, Array.from({ length: 3 }, () => ({ ...references.a, id: assetId(1) })));
  assert.equal(queue.clearCompleted('a'), 1);
  assert.equal(queue.status('a').totalBytes, 0);
  assert.equal(queue.status('a').downloadedBytes, 0);
});

test('keeps a fixed library identity and ignores a discarded worker result after the registration is reused', async t => {
  let finishOld;
  let abortSeen = false;
  const { queue } = await fixture(t, {
    readOriginal(source, { signal }) {
      if (source.libraryId === 'a2') return success(source.byteCount);
      signal.addEventListener('abort', () => { abortSeen = true; }, { once: true });
      return new Promise(resolve => {
        finishOld = () => resolve({ ok: false, code: 'CHECKSUM' });
      });
    },
  });
  t.after(() => finishOld?.());
  queue.enqueue('a', 'a1', [entry(1)]);
  queue.start();
  await waitFor(() => !!finishOld);
  assert.throws(() => queue.enqueue('a', 'a2', [entry(1)]), /素材库身份已经变化/);
  queue.discard('a');
  assert.equal(abortSeen, true);
  queue.enqueue('a', 'a2', [entry(1)]);
  await waitFor(() => queue.status('a').done === 1);
  finishOld();
  await delay(30);
  assert.equal(queue.status('a').done, 1);
  assert.equal(queue.status('a').failed, 0);
});

test('removes pending and failed tasks only from the chosen library and keeps completed history', async t => {
  const { queue, open } = await fixture(t, {
    readOriginal(source) {
      if (source.id === assetId(2)) throw codeError('ENOENT');
      return success(source.byteCount);
    },
  });
  queue.enqueue('a', 'a1', [entry(1), entry(2), entry(3)]);
  queue.enqueue('b', 'b1', [entry(2), entry(3)]);
  queue.setPaused('b', true);
  assert.throws(() => queue.remove('a', 'bad'), /原件取回任务/);
  assert.equal(queue.remove('a', assetId(3)), 'pending');
  assert.equal(queue.status('a').totalBytes, 20);
  queue.start();
  await waitFor(() => queue.status('a').done === 1 && queue.status('a').failed === 1);
  assert.equal(queue.remove('a', assetId(1)), null);
  assert.equal(queue.remove('a', assetId(2)), 'failed');
  assert.equal(queue.remove('a', assetId(2)), null);
  assert.equal(queue.status('a').downloadedBytes, 10);
  assert.equal(queue.status('a').failed, 0);
  await queue.close();

  const reopened = await open();
  assert.deepEqual(reopened.status('a').tasks.map(task => [task.id, task.status]), [[assetId(1), 'done']]);
  assert.deepEqual(reopened.status('b').tasks.map(task => [task.id, task.status]), [[assetId(2), 'pending'], [assetId(3), 'pending']]);
  assert.equal(reopened.status('b').paused, true);
});

test('cancels an active read and ignores its late progress or result after the same item is queued again', async t => {
  let old;
  let reads = 0;
  const { queue, open } = await fixture(t, {
    readOriginal(source, { signal, onProgress }) {
      reads += 1;
      if (reads > 1) return success(source.byteCount);
      return new Promise(resolve => {
        old = { signal, onProgress, finish: () => resolve({ ok: false, code: 'CHECKSUM' }) };
      });
    },
  });
  queue.enqueue('a', 'a1', [entry(1)]);
  queue.start();
  try {
    await waitFor(() => !!old);
    old.onProgress(4);
    assert.equal(queue.status('a').downloadedBytes, 4);
    assert.equal(queue.remove('a', assetId(1)), 'running');
    assert.equal(old.signal.aborted, true);
    old.onProgress(8);
    assert.equal(queue.status('a').downloadedBytes, 0);
    assert.equal(queue.status('a').total, 0);
    assert.deepEqual(queue.enqueue('a', 'a1', [entry(1)]), { added: 1, total: 1 });
    await waitFor(() => queue.status('a').done === 1);
  } finally {
    old?.finish();
  }
  await queue.close();
  const reopened = await open();
  assert.equal(reads, 2);
  assert.deepEqual(reopened.status('a').tasks.map(task => [task.id, task.status, task.code]), [[assetId(1), 'done', null]]);
});

test('bounds list payloads, validates whole batches, and resets a crash-interrupted status on open', async t => {
  const { queue, open, directory } = await fixture(t);
  assert.throws(() => queue.enqueue('a', 'a1', [entry(1), { id: 'bad', name: 'test', byteCount: 0 }]), /原件记录无效/);
  assert.equal(queue.status('a').total, 0);
  queue.enqueue('a', 'a1', Array.from({ length: 120 }, (_, index) => entry(index)));
  assert.equal(queue.status('a', { limit: 1000 }).tasks.length, 100);
  assert.equal(queue.status('a', { offset: 100, limit: 50 }).tasks.length, 20);
  assert.equal(queue.status('a', { offset: 999 }).offset, 100);
  assert.equal(queue.status('a', { includeTasks: false }).tasks.length, 0);
  await queue.close();
  const db = new DatabaseSync(path.join(directory, 'queue.sqlite'));
  db.prepare("UPDATE tasks SET status = 'running' WHERE registration_id = ? AND id = ?").run('a', assetId(0));
  db.close();
  const reopened = await open();
  assert.equal(reopened.status('a').pending, 120);
  assert.equal(reopened.status('a').running, 0);
  reopened.start();
  await waitFor(() => reopened.status('a').done === 120);
});
