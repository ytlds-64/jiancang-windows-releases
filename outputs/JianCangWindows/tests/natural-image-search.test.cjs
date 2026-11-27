'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { setTimeout: pause } = require('node:timers/promises');
const { test } = require('node:test');
const { AssetSuggestions } = require('../asset-suggestions.cjs');
const { NaturalImageSearch } = require('../natural-image-search.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a05sAAAAASUVORK5CYII=', 'base64');
const reference = (id, revision = '1') => ({ registrationId: '012abc', assetId: id, revision });

async function finished(search) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = search.status();
    if (['completed', 'failed', 'cancelled'].includes(status.phase)) return status;
    await pause(10);
  }
  assert.fail('Timed out waiting for natural language search');
}

test('uses the confirmed AI profile, separates image and ranking payloads, and reuses only current captions', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-natural-search-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { messages } = JSON.parse(Buffer.concat(chunks).toString());
    const data = messages[1].content;
    requests.push(data);
    const value = Array.isArray(data) ? { description: '黄昏逆光，一个人站在树下。' } : { matches: [{ index: 0, score: 96 }] };
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let worker;
  t.after(async () => {
    worker?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(folder, { recursive: true, force: true });
  });
  const unused = () => assert.fail('Search must not use suggestion imports or metadata writes');
  const app = new AssetSuggestions({ settingsFile: path.join(folder, 'ai-settings.json'), getAsset: unused, getImage: unused, apply: unused });
  await app.saveSettings({ provider: 'lmstudio', endpoint: `http://127.0.0.1:${server.address().port}`, model: 'fixture-vision' });
  const profile = app.getSettings();
  const config = { directory: path.join(folder, 'cache'), openService: expected => app.openVisualSearch(expected),
    currentReference: current => current, getImage: async () => ({ type: 'image/png', bytes: png }) };
  worker = new NaturalImageSearch(config);
  assert.equal(worker.status(), null);
  assert.equal(requests.length, 0);

  worker.start('逆光下的人像', [reference('first'), reference('second')], { ...profile, model: 'changed' });
  assert.equal((await finished(worker)).phase, 'failed');
  assert.equal(requests.length, 0);

  worker.start('逆光下的人像', [reference('first'), reference('second')], profile);
  const initial = await finished(worker);
  assert.equal(initial.phase, 'completed');
  assert.equal(initial.ranked, 2);
  assert.equal(initial.cached, 0);
  assert.equal(initial.results[0].reference.assetId, 'first');
  assert.equal(requests.length, 3);
  assert.match(requests[0][1].image_url.url, /^data:image\/png;base64,/);
  assert.deepEqual(JSON.parse(requests[2]), {
    query: '逆光下的人像', descriptions: ['黄昏逆光，一个人站在树下。', '黄昏逆光，一个人站在树下。'],
  });

  worker.close();
  worker = new NaturalImageSearch(config);
  worker.start('落日剪影', [reference('first'), reference('second', '2')], profile);
  const reopened = await finished(worker);
  assert.equal(reopened.cached, 1);
  assert.equal(reopened.ranked, 2);
  assert.equal(requests.length, 5);
  assert.ok(Array.isArray(requests[3]));
  assert.equal(JSON.parse(requests[4]).query, '落日剪影');
});

test('stopping an active request cancels the signal and leaves remaining images unsubmitted', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-natural-cancel-'));
  let requested = 0;
  let notify;
  const firstRequest = new Promise(resolve => { notify = resolve; });
  const search = new NaturalImageSearch({ directory, currentReference: ref => ref, getImage: async () => png,
    openService: async () => ({ timeout: 15_000, async describe(_image, signal) {
      requested++;
      notify();
      await pause(10_000, undefined, { signal });
    }, rank() { assert.fail('A stopped search must never rank'); } }),
  });
  t.after(async () => { search.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const profile = { provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234', model: 'fixture-model' };
  const start = search.start('海边', [reference('first'), reference('second')], profile);
  await firstRequest;
  search.cancel(start.id);
  assert.equal((await finished(search)).phase, 'cancelled');
  assert.equal(requested, 1);
});
