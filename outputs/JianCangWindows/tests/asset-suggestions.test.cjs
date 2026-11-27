'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createServer } = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { test } = require('node:test');
const { AssetSuggestions } = require('../asset-suggestions.cjs');

const sampleKey = 'fixture-only-API-token';
const encrypted = Buffer.from('opaque-fixture-ciphertext');
const id = index => index.toString(16).padStart(64, '0');
const refs = (...indexes) => indexes.map(index => ({ registrationId: '012abc', id: id(index) }));
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a05sAAAAASUVORK5CYII=', 'base64');

function visionResponse(title = '暖光下的工作台') {
  return { choices: [{ message: { content: `\`\`\`json\n${JSON.stringify({ title, tags: ['木桌', '斜射光', '木桌'], note: '一束光从侧边照到桌面，桌角在画面右下方。' })}\n\`\`\`` } }] };
}

async function fixture(t, respond) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-ai-test-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const item = { method: request.method, url: request.url, headers: request.headers,
      payload: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null };
    requests.push(item);
    await respond(response, item, requests.length);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const settingsFile = path.join(directory, 'private.json');
  const snapshots = [];
  const writes = [];
  const revisions = new Map();
  const writeBlocks = new Map([[id(3), 'eagle']]);
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const params = {
    settingsFile, safeStorage: {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async key => { assert.equal(key, sampleKey); return encrypted; },
      decryptStringAsync: async bytes => { assert.deepEqual(bytes, encrypted); return { result: sampleKey }; },
    },
    getAsset: async reference => ({ name: '私人文件名', tags: ['本机标签'], note: '未上传的私人备注',
      revision: revisions.get(reference.id) ?? 'original', writable: !writeBlocks.has(reference.id), writeBlock: writeBlocks.get(reference.id) }),
    getImage: async () => ({ bytes: image, type: 'image/png' }),
    apply: async (reference, patch) => { writes.push({ reference, patch }); return { ok: true }; },
    onChange: value => snapshots.push(value),
  };
  const service = new AssetSuggestions(params);
  await service.initialize();
  return { directory, settingsFile, endpoint, requests, snapshots, writes, revisions, writeBlocks, params, service };
}

async function waitUntil(check, limit = 150) {
  for (let tries = 0; tries < limit; tries++) {
    const result = check();
    if (result) return result;
    await pause(10);
  }
  assert.fail('Timed out waiting for suggestion state');
}

function finished(service) {
  const batch = service.getBatch();
  return batch && batch.tasks.every(task => task.state !== 'running' && task.state !== 'waiting') ? batch : null;
}

test('uses only re-encoded image bytes in vision requests and applies checked fields after permission and revision checks', async t => {
  const setup = await fixture(t, response => response.end(JSON.stringify(visionResponse())));
  const { service, endpoint, settingsFile, params, requests, writes, revisions, snapshots } = setup;
  assert.equal(service.getSettings().configured, false);
  await service.saveSettings({ endpoint, model: 'vision-fixture', key: sampleKey });
  const persisted = await fs.readFile(settingsFile, 'utf8');
  assert.equal(persisted.includes(sampleKey), false);
  assert.equal(persisted.includes(encrypted.toString('base64')), true);
  const reopened = new AssetSuggestions(params);
  await reopened.initialize();
  assert.deepEqual(reopened.getSettings(), service.getSettings());
  await reopened.start(refs(1, 2, 3));
  const complete = await waitUntil(() => finished(reopened));
  assert.equal(requests.length, 3);
  for (const item of requests) {
    assert.equal(item.url, '/v1/chat/completions');
    assert.equal(item.headers.authorization, `Bearer ${sampleKey}`);
    assert.equal(item.payload.model, 'vision-fixture');
    const [instructions, imageRequest] = item.payload.messages;
    assert.match(instructions.content, /备注从摄影师视角.*光线方向与质感.*主体和背景的关系/);
    assert.match(instructions.content, /标签优先从构图.*光线.*氛围.*类型/);
    assert.match(instructions.content, /跨素材复用/);
    assert.deepEqual(imageRequest.content[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } });
    assert.equal(JSON.stringify(item.payload).includes('私人文件名'), false);
    assert.equal(JSON.stringify(item.payload).includes('未上传的私人备注'), false);
    assert.equal(JSON.stringify(item.payload).includes('本机标签'), false);
  }
  assert.equal(JSON.stringify(snapshots).includes(sampleKey), false);
  assert.equal(writes.length, 0);
  const [first, second, readonly] = complete.tasks;
  assert.deepEqual(first.suggestion.tags, ['木桌', '斜射光']);
  revisions.set(second.id, 'changed');
  const result = await reopened.applySelected([{ taskId: first.taskId, fields: ['tags'] }, { taskId: second.taskId, fields: ['note'] },
    { taskId: readonly.taskId, fields: ['title'] }]);
  assert.equal(result.applied, 1);
  assert.equal(result.failed, 2);
  assert.deepEqual(writes[0].patch, { tags: ['木桌', '斜射光'] });
  assert.deepEqual(writes[0].reference.expected, { name: '私人文件名', note: '未上传的私人备注', tags: ['本机标签'] });
  assert.match(writes[0].reference.undoGroup, /^suggestions:[a-f0-9-]{36}$/);
  assert.match(result.batch.tasks[1].applyError, /图片已变化/);
  assert.match(result.batch.tasks[2].applyError, /Eagle.*双向同步/);
});

test('rechecks write permissions without regenerating suggestions and discards only the matching batch', async t => {
  const { service, endpoint, requests, writeBlocks, writes } = await fixture(t, response => response.end(JSON.stringify(visionResponse())));
  writeBlocks.set(id(1), 'sync-disabled');
  await service.saveSettings({ endpoint, model: 'vision' });
  await service.start(refs(1));
  const original = await waitUntil(() => finished(service));
  const task = original.tasks[0];
  assert.equal(task.writable, false);
  assert.equal(task.writeBlock, 'sync-disabled');
  writeBlocks.delete(id(1));
  const reopened = await service.review();
  assert.equal(reopened.tasks[0].writable, true);
  assert.equal(reopened.tasks[0].taskId, task.taskId);
  assert.deepEqual(reopened.tasks[0].suggestion, task.suggestion);
  assert.equal(requests.length, 1);
  assert.equal((await service.applySelected([{ taskId: task.taskId, fields: ['title'] }])).applied, 1);
  await service.discard('stale-batch');
  assert.equal(service.getBatch().id, original.id);
  await service.discard(original.id);
  assert.equal(service.getBatch(), null);
  assert.equal(writes.length, 1);
});

test('bulk selections do not overwrite metadata filled after generation and manual selections still apply', async t => {
  const { params, endpoint, writes } = await fixture(t, response => response.end(JSON.stringify(visionResponse())));
  const current = { name: '原文件名', tags: [], note: ' \n ' };
  const getAsset = params.getAsset;
  const service = new AssetSuggestions({ ...params, getAsset: async reference => ({ ...await getAsset(reference), ...current }) });
  await service.initialize();
  await service.saveSettings({ endpoint, model: 'vision' });
  await service.start(refs(1));
  const { tasks: [{ taskId }] } = await waitUntil(() => finished(service));
  current.tags = ['另一个应用写入'];
  const blocked = await service.applySelected([{ taskId, fields: ['tags'], fillMissing: ['tags'] }]);
  assert.equal(blocked.failed, 1);
  assert.match(blocked.batch.tasks[0].applyError, /资料已填写/);
  assert.equal(writes.length, 0);
  const done = await service.applySelected([{ taskId, fields: ['title', 'note'], fillMissing: ['note'] }]);
  assert.equal(done.applied, 1);
  assert.equal(done.failed, 0);
  assert.deepEqual(writes[0].reference.fillMissing, ['note']);
  assert.deepEqual(done.batch.tasks[0].applied, ['title', 'note']);
});

test('bulk title eligibility repairs clearly opaque names and keeps readable filenames across languages', async t => {
  const fixtures = [
    ['   ', true],
    ['海边�', true],
    ['锟斤拷锟斤拷', true],
    ['ä¸­æ–‡.jpg', true],
    ['MontrÃ©al.webp', true],
    ['ogB2Ai2ApIVfyiDAICWfDAmOdvAWC9gD8qEiAA~tplv-dy-aweme-images-ds-rs-v1:1920:1280:q80', true],
    ['1040g3k0327n67o02701g5pdst5bjthrt3uuj08!nd_dft_wlten_jpg_3', true],
    ['1040g3kabcdefghxmtfghxy27n67o02pl43uu38.webp', true],
    ['HXq33OFbkAAHFQG', true],
    ['XabcAxyLMpVi25s', true, 'https://pbs.twimg.com/media/XabcAxyLMpVi25s?format=jpg&name=orig'],
    ['0cc175b9c0f1b6a831c399e269772661.jpg', true],
    ['d90d73c6-d614-4d76-a143-ade6e6c742f9', true],
    ['1844267695743357327', true],
    ['IMG_4512 (4).HEIC', true],
    ['PXL_20251110_123605030', true],
    ['FullSizeRender', true],
    ['a3z8d71jfke2p0q6gjsak51v', true],
    ['周末去海边', false],
    ['Summer Campaign 2026', false],
    ['Illustrations-v2_2026-Final-A13.png', false],
    ['SummerArt2026v2', false, 'https://x.com/artist/status/12345'],
    ['SpringPortrait2026GoldenHourFinal.jpg', false],
    ['Café Almería', false],
    ['Зимний Лес.jpg', false],
    ['休日の写真', false],
    ['CanonEOSR5MarkIIProductShots2026', false],
    ['20261122', false],
    ['IMG_4512 草稿', false],
  ];
  const { params, endpoint } = await fixture(t, response => response.end(JSON.stringify(visionResponse())));
  const assets = new Map(fixtures.map(([name, , sourceURL], index) => [id(index + 1), { name, sourceURL }]));
  const service = new AssetSuggestions({ ...params, getAsset: async reference =>
    ({ ...await params.getAsset(reference), ...assets.get(reference.id) }) });
  await service.initialize();
  await service.saveSettings({ endpoint, model: 'vision' });
  await service.start(refs(...fixtures.map((_, index) => index + 1)));
  const { tasks } = await waitUntil(() => finished(service));
  assert.equal(tasks.length, fixtures.length);
  tasks.forEach((task, index) => {
    assert.equal(task.state, 'ready', task.error);
    assert.equal(task.original.titleNeedsSuggestion, fixtures[index][1], fixtures[index][0]);
  });
});

test('bulk title writeback requires the same eligible original name and respects manual edits', async t => {
  const { params, endpoint, writes } = await fixture(t, response => response.end(JSON.stringify(visionResponse())));
  const names = new Map([[id(1), 'IMG_6020'], [id(2), 'DSC_9897'], [id(4), 'Summer Collection']]);
  const service = new AssetSuggestions({ ...params, getAsset: async reference =>
    ({ ...await params.getAsset(reference), name: names.get(reference.id) }) });
  await service.initialize();
  await service.saveSettings({ endpoint, model: 'vision' });
  await service.start(refs(1, 2, 4));
  const { tasks: [automatic, changed, manual] } = await waitUntil(() => finished(service));
  names.set(id(2), 'DSC_9999');
  const pick = task => ({ taskId: task.taskId, fields: ['title'], fillMissing: ['title'] });
  const done = await service.applySelected([pick(automatic), pick(changed), pick(manual)]);
  assert.equal(done.applied, 1);
  assert.equal(done.failed, 2);
  assert.match(done.batch.tasks[1].applyError, /名称已变化/);
  assert.match(done.batch.tasks[2].applyError, /资料已填写/);
  assert.deepEqual(writes[0].patch, { title: '暖光下的工作台' });
  assert.deepEqual(writes[0].reference.expected, { name: 'IMG_6020', tags: ['本机标签'], note: '未上传的私人备注' });
  assert.deepEqual(writes[0].reference.fillMissing, ['title']);

  assert.equal((await service.applySelected([{ taskId: manual.taskId, fields: ['title'] }])).applied, 1);
  assert.deepEqual(writes[1].patch, writes[0].patch);
  assert.deepEqual(writes[1].reference.fillMissing, []);
});

test('advances only successfully written fields, preserves failed fields and verifies a renamed source', async t => {
  const { params, endpoint, requests } = await fixture(t, response => response.end(JSON.stringify(visionResponse())));
  const current = { name: '1040g3kabcdefghxmtfghxy27n67o02pl43uu38', tags: [], note: '', revision: 'before',
    writable: true, canRecheckRenamedImage: true };
  let source = image;
  let failTags = true;
  const service = new AssetSuggestions({ ...params,
    getAsset: () => structuredClone(current),
    getImage: () => ({ bytes: source, type: 'image/png' }),
    apply: async ({ expected, revision }, patch) => {
      assert.equal(revision, current.revision);
      assert.deepEqual(expected, { name: current.name, tags: current.tags, note: current.note });
      if (patch.title) { current.name = patch.title; current.revision = 'renamed'; }
      if (patch.note) current.note = patch.note;
      if (patch.tags) {
        if (failTags) throw new Error('模拟标签写入失败');
        current.tags = patch.tags;
      }
      return { ok: true };
    },
  });
  await service.initialize();
  await service.saveSettings({ endpoint, model: 'vision' });
  await service.start(refs(1));
  const { tasks: [{ taskId }] } = await waitUntil(() => finished(service));
  const apply = key => service.applySelected([{ taskId, fields: [key], fillMissing: [key] }]);
  assert.deepEqual((await apply('title')).batch.tasks[0].applied, ['title']);
  assert.equal((await service.review()).tasks[0].writable, true);
  await assert.rejects(apply('title'), /有些建议已经变化/);
  const failed = await apply('tags');
  assert.equal(failed.applied, 0);
  assert.equal(failed.failed, 1);
  assert.deepEqual(failed.batch.tasks[0].applied, ['title']);

  const note = await apply('note');
  assert.equal(note.applied, 1);
  assert.deepEqual(note.batch.tasks[0].applied, ['title', 'note']);
  assert.match(note.batch.tasks[0].applyError, /标签写入失败/);
  current.revision = 'replaced';
  source = Buffer.concat([image, Buffer.from('changed bytes')]);
  assert.equal((await service.review()).tasks[0].writable, false);
  assert.equal((await apply('tags')).applied, 0);
  current.revision = 'renamed';
  source = image;
  failTags = false;
  const complete = await apply('tags');
  assert.equal(complete.failed, 0);
  assert.equal(complete.batch.tasks[0].applyError, '');
  assert.deepEqual(complete.batch.tasks[0].applied, ['title', 'note', 'tags']);
  assert.equal(requests.length, 1, 'verifying a metadata rename must not send a second image');
});

test('reopens a prior AI checkpoint and fixes its previously missed download title', async t => {
  const { params, directory, endpoint } = await fixture(t, response => response.end(JSON.stringify(visionResponse())));
  const name = '1040g3kabcdefghxmtfghxy27n67o02pl43uu38';
  const getAsset = async reference => ({ ...await params.getAsset(reference), name });
  const options = { ...params, getAsset };
  const service = new AssetSuggestions(options);
  await service.initialize();
  await service.saveSettings({ endpoint, model: 'vision' });
  await service.start(refs(1));
  await waitUntil(() => finished(service));
  await service.close();
  const file = path.join(directory, 'asset-suggestions-batch-v1.json');
  const previous = JSON.parse(await fs.readFile(file, 'utf8'));
  previous.tasks[0].titleNeedsSuggestion = false;
  delete previous.tasks[0].imageDigest;
  delete previous.tasks[0].applyFailures;
  await fs.writeFile(file, JSON.stringify(previous));
  const restarted = new AssetSuggestions(options);
  await restarted.initialize();
  const { tasks: [task] } = await restarted.review();
  assert.equal(task.original.titleNeedsSuggestion, true);
  assert.equal((await restarted.applySelected([{ taskId: task.taskId, fields: ['title'], fillMissing: ['title'] }])).applied, 1);
});

test('preserves single-task retry, validates the model response, and blocks redirects without forwarding a credential', async t => {
  const { service, endpoint, requests } = await fixture(t, (response, _item, count) => {
    if (count === 1) { response.writeHead(302, { Location: '/forwarded' }); response.end(); }
    else if (count === 2) response.end(JSON.stringify(visionResponse()));
    else response.end(JSON.stringify({ choices: [{ message: { content: '{"title":"X","tags":[1],"note":"X"}' } }] }));
  });
  await assert.rejects(service.saveSettings({ endpoint: 'http://example.invalid', model: 'vision' }), /HTTP 仅支持本机/);
  await assert.rejects(service.saveSettings({ endpoint: 'https://example.invalid/v1?api_key=secret', model: 'vision' }), /HTTPS API 地址/);
  await service.saveSettings({ endpoint: `${endpoint}/compatible/v1/chat/completions`, model: 'vision', key: sampleKey });
  await service.start(refs(1));
  const failed = (await waitUntil(() => finished(service))).tasks[0];
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /重定向/);
  assert.equal(requests.length, 1);
  await service.retry(failed.taskId);
  const retried = (await waitUntil(() => finished(service))).tasks[0];
  assert.equal(retried.state, 'ready');
  assert.equal(retried.taskId, failed.taskId);
  await service.start(refs(2));
  const invalid = (await waitUntil(() => finished(service))).tasks[0];
  assert.match(invalid.error, /文字格式不正确/);
  assert.ok(requests.every(item => item.url === '/compatible/v1/chat/completions'));
  const settings = await service.saveSettings({ endpoint: 'https://different.example.invalid/v1', model: 'vision' });
  assert.equal(settings.clearedPreviousKey, true);
  assert.equal(settings.hasKey, false);
});

test('retries all failed suggestions in one action and leaves ready, applied and queued tasks alone', async t => {
  let releaseRunning;
  const finishRunning = new Promise(resolve => { releaseRunning = resolve; });
  const { params, endpoint, requests } = await fixture(t, async (response, _item, count) => {
    if (count === 5) await finishRunning;
    if ([3, 4, 7].includes(count)) response.writeHead(503);
    response.end(JSON.stringify(visionResponse()));
  });
  const imagesRead = [];
  let credentialsRead = 0;
  const service = new AssetSuggestions({ ...params, safeStorage: {
    ...params.safeStorage,
    async decryptStringAsync(cipher) {
      credentialsRead++;
      return params.safeStorage.decryptStringAsync(cipher);
    },
  }, async getImage(reference) {
    imagesRead.push(reference.id);
    return { bytes: image, type: 'image/png' };
  } });
  t.after(async () => { releaseRunning(); await service.close(); });
  await service.initialize();
  const original = { provider: 'lmstudio', endpoint, model: 'vision' };
  await service.saveSettings({ ...original, key: sampleKey });
  const { id: batchId } = await service.start(refs(1, 2, 3, 4, 5, 6));
  await waitUntil(() => requests.length === 5);
  const completeAndPending = service.getBatch();
  assert.deepEqual(completeAndPending.tasks.map(task => task.state), ['ready', 'ready', 'failed', 'failed', 'running', 'waiting']);
  const [first, second, failed] = completeAndPending.tasks;
  assert.equal((await service.applySelected([{ taskId: first.taskId, fields: ['title'] }])).applied, 1);
  await assert.rejects(service.retryFailed('outdated-batch'), /任务已变化/);

  const pending = service.retryFailed(batchId);
  await assert.rejects(service.retry(failed.taskId), /当前无法重试/);
  const requeued = await pending;
  assert.equal(credentialsRead, 2);
  assert.deepEqual(requeued.tasks.map(task => task.state), ['ready', 'ready', 'waiting', 'waiting', 'running', 'waiting']);
  assert.deepEqual(requeued.tasks[0].applied, ['title']);
  assert.deepEqual(requeued.tasks[1].suggestion, second.suggestion);
  assert.equal(requests.length, 5);

  releaseRunning();
  const after = await waitUntil(() => finished(service));
  assert.deepEqual(imagesRead, [1, 2, 3, 4, 5, 3, 4, 6].map(id));
  assert.deepEqual(after.tasks.map(task => task.state), ['ready', 'ready', 'ready', 'failed', 'ready', 'ready']);
  assert.match(after.tasks[3].error, /503/);

  await service.saveSettings({ ...original, model: 'changed-model' });
  await assert.rejects(service.retryFailed(batchId), /AI 服务配置已变化/);
  assert.equal(requests.length, 8);
  await service.saveSettings(original);
  await service.retryFailed(batchId);
  await waitUntil(() => finished(service));
  await assert.rejects(service.retryFailed(batchId), /没有可重试/);
  assert.deepEqual(imagesRead.slice(8), [id(4)]);
});

test('stops in-flight requests and never uploads waiting assets after cancellation', async t => {
  const { service, endpoint, requests } = await fixture(t, async response => {
    await pause(1000, undefined, { ref: false });
    response.end(JSON.stringify(visionResponse()));
  });
  await service.saveSettings({ endpoint, model: 'vision' });
  await service.start(refs(1, 2, 3, 4));
  await waitUntil(() => requests.length === 2);
  service.cancel();
  const stopped = await waitUntil(() => finished(service));
  assert.ok(stopped.tasks.every(task => task.state === 'cancelled'));
  assert.equal(requests.length, 2);
});

test('restores a paused batch and uploads only unfinished assets after explicit resume', async t => {
  const { endpoint, params, requests, directory } = await fixture(t, (response, _request, count) => {
    if (count !== 2) response.end(JSON.stringify(visionResponse()));
  });
  const uploads = [];
  const options = { ...params, getImage: async reference => {
    uploads.push(reference.id);
    return { bytes: image, type: 'image/png' };
  } };
  const first = new AssetSuggestions(options);
  t.after(() => first.close());
  await first.initialize();
  const original = { provider: 'lmstudio', endpoint, model: 'vision-fixture' };
  await first.saveSettings({ ...original, key: sampleKey });
  const { id: batchId } = await first.start(refs(1, 2, 3));
  await waitUntil(() => requests.length === 2);

  // Open the saved state while the original instance is still waiting for the second response.
  const reopened = new AssetSuggestions(options);
  t.after(() => reopened.close());
  await reopened.initialize();
  const restored = await reopened.review();
  assert.equal(restored.id, batchId);
  assert.equal(restored.paused, true);
  assert.equal(restored.canResume, true);
  assert.deepEqual(restored.tasks.map(task => task.state), ['ready', 'waiting', 'waiting']);
  assert.equal(restored.tasks[0].taskId, first.getBatch().tasks[0].taskId);
  assert.ok(restored.tasks[0].writable);
  assert.equal(requests.length, 2);

  const paused = await first.pause(batchId);
  assert.deepEqual(paused.tasks.map(task => task.state), ['ready', 'waiting', 'waiting']);
  assert.equal(paused.paused, true);
  await first.close();
  const checkpoint = await fs.readFile(path.join(directory, 'asset-suggestions-batch-v1.json'), 'utf8');
  for (const forbidden of [sampleKey, encrypted.toString('base64'), image.toString('base64')]) assert.ok(!checkpoint.includes(forbidden));
  await reopened.saveSettings({ ...original, model: 'different-model' });
  assert.equal(reopened.getBatch().canResume, false);
  await assert.rejects(() => reopened.resume(batchId), /AI 服务配置已变化/);
  assert.equal(requests.length, 2);

  await reopened.saveSettings(original);
  await reopened.resume(batchId);
  const complete = await waitUntil(() => finished(reopened));
  assert.deepEqual(complete.tasks.map(task => task.state), ['ready', 'ready', 'ready']);
  assert.deepEqual(uploads, [id(1), id(2), id(2), id(3)]);
  assert.deepEqual(complete.tasks[0].suggestion, restored.tasks[0].suggestion);
  const applied = await reopened.applySelected([{ taskId: complete.tasks[0].taskId, fields: ['title'] }]);
  assert.equal(applied.applied, 1);
  await reopened.close();

  const review = new AssetSuggestions(options);
  await review.initialize();
  assert.deepEqual((await review.review()).tasks[0].applied, ['title']);
  await review.discard(batchId);
  const cleared = new AssetSuggestions(options);
  await cleared.initialize();
  assert.equal(cleared.getBatch(), null);
});

test('processes a 325-image selection across transport chunks and keeps one review and undo group after restart', async t => {
  const { endpoint, params, requests, writes, directory } = await fixture(t, (response, _request, count) => {
    if (count === 45) return;
    response.end(JSON.stringify(count === 65 ? { choices: [] } : visionResponse()));
  });
  const options = { ...params, snapshotChanges: false };
  const first = new AssetSuggestions(options);
  t.after(() => first.close());
  await first.initialize();
  await first.saveSettings({ provider: 'lmstudio', endpoint, model: 'vision-fixture', key: sampleKey });
  const references = refs(...Array.from({ length: 325 }, (_, index) => index + 1000));
  const uploadId = 'b7ddbb5a-cc27-4b99-9d78-0cee05cbf5db';
  assert.deepEqual(await first.start({ uploadId, offset: 0, items: references.slice(0, 300) }), { received: 300 });
  assert.equal(requests.length, 0);
  await assert.rejects(() => first.start({ uploadId, offset: 299, items: references.slice(300), final: true }), /列表已变化/);
  const started = await first.start({ uploadId, offset: 300, items: references.slice(300), final: true });
  assert.equal(started.tasks.length, references.length);
  await waitUntil(() => requests.length === 45, 1000);
  const paused = await first.pause(started.id);
  assert.equal(paused.tasks.filter(task => task.state === 'ready').length, 44);
  await first.close();

  const reopened = new AssetSuggestions(options);
  t.after(() => reopened.close());
  await reopened.initialize();
  const restored = await reopened.review();
  assert.equal(restored.paused, true);
  assert.deepEqual(restored.tasks.map(task => task.taskId), started.tasks.map(task => task.taskId));
  assert.deepEqual(restored.tasks.slice(0, 44).map(task => task.suggestion), paused.tasks.slice(0, 44).map(task => task.suggestion));
  await reopened.resume(started.id);
  const generated = await waitUntil(() => finished(reopened), 1000);
  assert.equal(generated.tasks.filter(task => task.state === 'failed').length, 1);
  await reopened.retryFailed(started.id);
  const complete = await waitUntil(() => finished(reopened), 1000);
  assert.equal(complete.tasks.filter(task => task.state === 'ready').length, 325);
  assert.equal(requests.length, 327);

  const operation = 'fd95fd3f-2074-4ab5-8f1b-775fb6979dc1';
  const selected = complete.tasks.map(task => ({ taskId: task.taskId, fields: ['title'], operation }));
  const appliedFirst = await reopened.applySelected(selected.slice(0, 300));
  assert.equal(appliedFirst.applied, 300);
  assert.deepEqual(appliedFirst.batch.tasks[300].applied, []);
  const appliedLast = await reopened.applySelected(selected.slice(300));
  assert.equal(appliedLast.applied, 25);
  assert.equal(writes.length, 325);
  assert.deepEqual([...new Set(writes.map(write => write.reference.undoGroup))], [`suggestions:${operation}`]);
  await reopened.close();
  const check = new AssetSuggestions(options);
  t.after(() => check.close());
  await check.initialize();
  assert.equal(check.getBatch().tasks.filter(task => task.applied.includes('title')).length, 325);
  const initialRows = JSON.parse(await fs.readFile(path.join(directory, 'asset-suggestions-batch-v1.json'), 'utf8')).tasks;
  assert.ok(initialRows.every(task => task.state === 'waiting'));
});

test('migrates a compatible profile and keeps LM Studio requests and credentials separate', async t => {
  const { endpoint, params, requests, settingsFile } = await fixture(t, (response, item) => {
    if (item.method === 'GET') {
      response.end(JSON.stringify({ data: [{ id: 'vision-local' }, { id: 'vision-local' }, { id: 'second-model' }] }));
    } else response.end(JSON.stringify(visionResponse()));
  });
  await fs.writeFile(settingsFile, JSON.stringify({ version: 1, endpoint, model: 'legacy-model', keyCipher: encrypted.toString('base64') }));
  const service = new AssetSuggestions(params);
  await service.initialize();
  assert.equal(service.getSettings().provider, 'compatible');
  assert.equal(service.getSettings().hasKey, true);
  assert.equal(service.getSettings().profiles.lmstudio.endpoint, 'http://127.0.0.1:1234/v1');
  assert.equal(service.getSettings().profiles.lmstudio.hasKey, false);
  const loopbackName = endpoint.replace('127.0.0.1', 'localhost');
  assert.deepEqual(await service.listLocalModels({ endpoint: loopbackName }), ['vision-local', 'second-model']);
  assert.equal(requests[0].url, '/v1/models');
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].payload, null);
  assert.equal(requests[0].headers.authorization, undefined);

  const saved = await service.saveSettings({ provider: 'lmstudio', endpoint: loopbackName, model: 'vision-local' });
  assert.equal(saved.provider, 'lmstudio');
  assert.equal(saved.profiles.compatible.model, 'legacy-model');
  assert.equal(saved.profiles.compatible.hasKey, true);
  const reopened = new AssetSuggestions(params);
  await reopened.initialize();
  assert.deepEqual(reopened.getSettings(), service.getSettings());
  await reopened.start(refs(1));
  assert.equal((await waitUntil(() => finished(reopened))).tasks[0].state, 'ready');
  assert.equal(requests[1].url, '/v1/chat/completions');
  assert.equal(requests[1].payload.model, 'vision-local');
  assert.equal(requests[1].headers.authorization, undefined);

  await reopened.saveSettings({ provider: 'compatible', endpoint, model: 'legacy-model' });
  assert.equal(reopened.getSettings().profiles.lmstudio.model, 'vision-local');
  await reopened.start(refs(2));
  assert.equal((await waitUntil(() => finished(reopened))).tasks[0].state, 'ready');
  assert.equal(requests[2].headers.authorization, `Bearer ${sampleKey}`);
});

test('rejects non-local addresses and never follows LM Studio redirects', async t => {
  const { service, endpoint, requests } = await fixture(t, response => {
    response.writeHead(302, { Location: 'https://not-local.invalid/forwarded' });
    response.end();
  });
  const remote = 'https://not-local.invalid/v1';
  await assert.rejects(service.listLocalModels({ endpoint: remote }), /地址必须使用/);
  await assert.rejects(service.saveSettings({ provider: 'lmstudio', endpoint: remote, model: 'vision' }), /地址必须使用/);
  assert.equal(requests.length, 0);
  await assert.rejects(service.listLocalModels({ endpoint }), /重定向/);
  await service.saveSettings({ provider: 'lmstudio', endpoint, model: 'vision', key: sampleKey });
  await service.start(refs(1));
  const failed = (await waitUntil(() => finished(service))).tasks[0];
  assert.match(failed.error, /重定向/);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers.authorization, `Bearer ${sampleKey}`);
  await service.saveSettings({ endpoint, model: 'vision' });
  await assert.rejects(service.retry(failed.taskId), /配置已变化/);
  assert.equal(requests.length, 2);
});
