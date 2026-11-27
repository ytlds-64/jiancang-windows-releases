'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const extension = path.join(__dirname, '..', 'browser-extension', 'background.js');
const collections = [
  { id: 'parent', name: '摄影', parentId: null },
  { id: 'recent', name: '新采集', parentId: null },
  { id: 'favorite', name: '选片', parentId: 'parent' },
  { id: 'untouched', name: '其他', parentId: null },
];
const libraries = ['first', 'second'].map(targetId => ({ targetId, libraryId: 'shared-library-id', collections }));
const target = (index, collectionId) => ({ targetId: libraries[index].targetId, libraryId: libraries[index].libraryId, collectionId });

async function worker(storage, receiptFor) {
  const script = await fs.readFile(extension, 'utf8');
  const event = { addListener() {} };
  const sender = { id: 'test-extension', url: 'https://example.invalid/album', tab: { id: 5 }, frameId: 0 };
  let listener;
  const chrome = {
    runtime: { id: sender.id, getURL: name => `chrome-extension://${sender.id}/${name}`,
      onInstalled: event, onStartup: event, onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: {
      get: async key => ({ [key]: structuredClone(storage[key]) }),
      set: async values => Object.assign(storage, structuredClone(values)),
    } },
    permissions: { onAdded: event, onRemoved: event },
    alarms: { onAlarm: event, get: async () => ({}) },
    action: { onClicked: event }, contextMenus: { onClicked: event },
    scripting: { executeScript: async () => [] },
  };
  const response = (result, status = 200) => ({ ok: status === 200, status, json: async () => structuredClone(result) });
  runInNewContext(script, { chrome, URL, AbortSignal, crypto: { randomUUID }, setTimeout: setImmediate,
    fetch: async (url, input) => {
      const operation = new URL(url).pathname.split('/').at(-1);
      const payload = JSON.parse(input.body);
      if (operation === 'targets') return response({ ok: true, confirmedCapture: true, libraries, target: target(0, null) });
      return receiptFor(operation, payload, response);
    } });
  return (action, params = {}) => new Promise(resolve => {
    assert.equal(listener({ type: 'jiancang:collector-' + action, ...params }, sender, resolve), true);
  });
}

function image(save, explicit, requestId = randomUUID(), retry = false) {
  return save('image', { url: 'https://example.invalid/photo.jpg', target: explicit, requestId, retry, batch: true });
}

const collectionIDs = library => Array.from(library.collections, collection => collection.id);

test('browser collector ranks familiar destinations by count then recency independently for each registered library', async () => {
  const storage = { captureToken: 'synthetic' };
  const finish = (_operation, payload, reply) => reply({ ok: true, assetId: payload.requestId, target: payload.target });
  const save = await worker(storage, finish);
  const empty = await save('targets');
  assert.deepEqual(collectionIDs(empty.libraries[0]), ['parent', 'recent', 'favorite', 'untouched']);
  const captures = await Promise.all([
    image(save, target(0, 'favorite')), image(save, target(0, 'favorite')), image(save, target(0, 'favorite')),
    image(save, target(0, 'recent')), image(save, target(0, 'recent')), image(save, target(1, 'untouched')),
  ]);
  assert.ok(captures.every(result => result.ok));
  for (let capture = 0; capture < 2; capture++) assert.equal((await image(save, target(0, 'parent'))).ok, true);

  const restarted = await worker(storage, finish);
  const ranked = await restarted('targets', { allowCache: true });
  assert.deepEqual(collectionIDs(ranked.libraries[0]), ['favorite', 'parent', 'recent', 'untouched']);
  assert.deepEqual(collectionIDs(ranked.libraries[1]), ['untouched', 'parent', 'recent', 'favorite']);
  assert.equal(ranked.libraries[0].collections[0].parentId, 'parent');
  assert.deepEqual(ranked.target, target(0, null));
});

test('browser collector records only completed captures with exact confirmed destinations and deduplicates retried receipts', async () => {
  const storage = { captureToken: 'synthetic' };
  const waiting = randomUUID();
  const rejected = randomUUID();
  const awaitingStatus = Promise.withResolvers();
  const completed = Promise.withResolvers();
  const save = await worker(storage, async (operation, payload, reply) => {
    if (payload.requestId === rejected) return reply({ ok: false, message: '采集失败' }, 409);
    if (payload.requestId === waiting) {
      if (operation === 'capture') return reply({ ok: true, pending: true });
      awaitingStatus.resolve();
      await completed.promise;
      return reply({ ok: true, assetId: waiting, target: target(0, 'favorite') });
    }
    return reply({ ok: true, assetId: payload.requestId, target: target(0, null) });
  });

  await save('targets');
  assert.equal((await image(save, target(0, 'recent'), rejected)).ok, false);
  assert.equal((await image(save, target(0, null))).ok, true);
  const capture = image(save, undefined, waiting);
  await awaitingStatus.promise;
  assert.equal(storage.captureDestinationUsage, undefined);
  completed.resolve();
  assert.equal((await capture).ok, true);
  assert.equal((await image(save, undefined, waiting, true)).ok, true);
  const ranked = await save('targets', { allowCache: true });
  assert.deepEqual(collectionIDs(ranked.libraries[0]), ['favorite', 'parent', 'recent', 'untouched']);
  assert.deepEqual(storage.captureDestinationUsage.receipts, [waiting]);
  assert.equal(storage.captureDestinationUsage.destinations[0][1][0], 1);
});
