'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { createCloudOriginalReader } = require('../cloud-original-process.cjs');

function child() {
  const worker = new EventEmitter();
  worker.messages = [];
  worker.kills = 0;
  worker.postMessage = message => worker.messages.push(message);
  worker.kill = () => { worker.kills++; return true; };
  return worker;
}

test('cloud child copies no data through IPC and requires a complete-byte receipt', async () => {
  const worker = child();
  const read = createCloudOriginalReader(() => worker);
  const observed = [];
  const promise = read({ byteCount: 5 }, { onProgress: bytes => observed.push(bytes) });
  worker.emit('spawn');
  assert.deepEqual(worker.messages, [{ byteCount: 5 }]);
  worker.emit('message', { type: 'progress', bytes: 2 });
  worker.emit('message', { type: 'progress', bytes: 2 });
  worker.emit('message', { type: 'progress', bytes: 7 });
  assert.deepEqual(observed, [2]);
  worker.emit('message', { type: 'result', ok: true, bytes: 3 });
  await assert.rejects(promise, { code: 'INCOMPLETE' });
  assert.equal(worker.kills, 1);
});

test('cloud child is killed on provider timeout or cancellation before it spawns', async () => {
  const stalled = child();
  const readStalled = createCloudOriginalReader(() => stalled, { idleMs: 15 });
  const pending = readStalled({ byteCount: 12 });
  stalled.emit('spawn');
  await Promise.all([assert.rejects(pending, { code: 'TIMEOUT' }), delay(25)]);
  assert.equal(stalled.kills, 1);

  const cancelled = child();
  const readCancelled = createCloudOriginalReader(() => cancelled);
  const controller = new AbortController();
  const awaiting = readCancelled({ byteCount: 12 }, { signal: controller.signal });
  controller.abort();
  cancelled.emit('spawn');
  await assert.rejects(awaiting, { name: 'AbortError' });
  assert.deepEqual(cancelled.messages, []);
  assert.equal(cancelled.kills, 2);
});
