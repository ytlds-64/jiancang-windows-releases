'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { test } = require('node:test');
const { BrowserCapture, extensionFiles, extensionOrigin, prepareBrowserExtension, refreshBrowserExtension } = require('../browser-capture.cjs');
const { createLocalLibrary, importLocalAsset, mutateLocalLibrary, readLocalLibrary } = require('../local-library.cjs');

const targetId = 'a1';
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+WQAAAAASUVORK5CYII=';
const pageURL = 'https://example.org/photography';
const fakeAsset = 'a'.repeat(64);

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-browser-capture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function reservePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function client(port) {
  return (operation, body, token, headers = {}, signal) => fetch('http://127.0.0.1:' + port + '/v1/' + operation, {
    method: 'POST',
    headers: { Origin: extensionOrigin, 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }), ...headers },
    body: JSON.stringify(body), signal,
  });
}

test('capture picks its first writable target automatically and respects an explicit disable after restart', async t => {
  const root = await workspace(t);
  const settingsFile = path.join(root, 'capture.json');
  let selection;
  const options = { settingsFile, port: await reservePort(),
    defaultTarget: () => selection,
    resolveTarget: value => ({ ...value, libraryId: 'b1' }),
  };
  const bridge = new BrowserCapture(options);
  t.after(() => bridge.close());
  await bridge.initialize();
  assert.equal(bridge.status().awaitingDefault, true);
  assert.equal(bridge.status().enabled, false);
  selection = { targetId };
  await Promise.all([bridge.enableDefault(), bridge.enableDefault()]);
  assert.equal(bridge.status().enabled, true);
  assert.equal(bridge.status().awaitingDefault, false);
  assert.deepEqual(bridge.status().target, { targetId, libraryId: 'b1', collectionId: null });

  const restored = new BrowserCapture(options);
  t.after(() => restored.close());
  await bridge.close();
  await restored.initialize();
  assert.equal(restored.status().enabled, true);
  await restored.disconnect(true);

  const disabled = new BrowserCapture(options);
  t.after(() => disabled.close());
  await disabled.initialize();
  await disabled.enableDefault();
  assert.equal(disabled.status().enabled, false);
  assert.equal(disabled.status().awaitingDefault, false);
});

test('capture connects after desktop approval, keeps only token digests and checks the saved library identity', async t => {
  const root = await workspace(t);
  const settingsFile = path.join(root, 'capture.json');
  const port = await reservePort();
  const request = client(port);
  let now = 1000;
  let libraryId = 'b1';
  let finishApproval;
  const received = [];
  const config = { port, settingsFile, now: () => now,
    approveConnection() { return new Promise(resolve => { finishApproval = resolve; }); },
    resolveTarget(selection) { return { ...selection, libraryId }; },
    importAsset(task) { received.push(task); return { id: fakeAsset }; },
  };
  const bridge = new BrowserCapture(config);
  t.after(() => bridge.close());
  await bridge.initialize();
  assert.equal(bridge.status().enabled, false);
  await bridge.configure({ targetId, collectionId: '旅行参考' });
  assert.equal(bridge.status().enabled, true);

  const hostile = await request('connect', {}, undefined, { Origin: 'https://example.org' });
  assert.equal(hostile.status, 403);
  assert.equal(hostile.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(finishApproval, undefined);
  const preflight = await fetch('http://127.0.0.1:' + port + '/v1/capture', {
    method: 'OPTIONS', headers: { Origin: extensionOrigin },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), extensionOrigin);
  assert.equal((await request('connect', { tooLarge: 'a'.repeat(4096) })).status, 413);
  assert.equal((await request('pair', {})).status, 404);

  async function requestApproval(expected, verdict) {
    finishApproval = null;
    const pending = request('connect', {});
    for (let retry = 0; !finishApproval && retry < 100; retry++) await wait(10);
    assert.equal(typeof finishApproval, 'function');
    assert.equal((await request('connect', {})).status, 409);
    finishApproval(verdict);
    const response = await pending;
    assert.equal(response.status, expected);
    return response;
  }
  assert.equal((await (await requestApproval(403, false)).json()).token, undefined);
  assert.equal((await request('connect', {})).status, 429);
  now += 9000;
  const response = await requestApproval(200, true);
  assert.equal(response.status, 200);
  const { token } = await response.json();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const stored = (await fs.readFile(settingsFile, 'utf8'));
  assert(!stored.includes(token));
  assert.deepEqual(JSON.parse(stored).tokens, [createHash('sha256').update(token).digest('hex')]);

  const fixture = { kind: 'page', url: pageURL, title: '参考照片' };
  assert.equal((await request('capture', fixture)).status, 401);
  assert.equal((await request('capture', fixture, token, { Origin: 'null' })).status, 403);
  assert.equal((await request('capture', fixture, token, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request('capture', { kind: 'image', url: 'http://127.0.0.1/secret.png' }, token)).status, 400);
  assert.equal((await request('capture', { kind: 'image', url: 'file:///secret.png' }, token)).status, 400);
  assert.equal((await request('capture', { kind: 'image', url: 'data:image/svg+xml;base64,aaaa' }, token)).status, 400);
  const saved = await request('capture', fixture, token);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).assetId, fakeAsset);
  assert.deepEqual(received, [{ id: received[0].id, batchId: received[0].id, targetId, collectionId: '旅行参考',
    source: { kind: 'url', url: pageURL, name: '参考照片', targetLibraryId: 'b1' } }]);

  await bridge.close();
  const restored = new BrowserCapture(config);
  t.after(() => restored.close());
  await restored.initialize();
  assert.equal(restored.status().paired, 1);
  libraryId = 'b2';
  const changed = await request('capture', fixture, token);
  assert.equal(changed.status, 409);
  assert.match((await changed.json()).message, /目标素材库已变化/);
  assert.equal(received.length, 1);
  await restored.configure({ targetId, collectionId: null });
  assert.equal((await request('capture', fixture, token)).status, 200);
  assert.equal(received[1].collectionId, null);
  await restored.disconnect();
  assert.equal((await request('capture', fixture, token)).status, 401);
  assert.equal((await restored.disconnect(true)).enabled, false);
});

test('closing a browser request or revoking access cancels approval before a token can be issued', async t => {
  const root = await workspace(t);
  const settingsFile = path.join(root, 'capture.json');
  const port = await reservePort();
  let approve;
  let dialogSignal;
  let now = 1000;
  const bridge = new BrowserCapture({ port, settingsFile, now: () => now,
    resolveTarget: selection => ({ ...selection, libraryId: 'b1' }),
    approveConnection(signal) {
      dialogSignal = signal;
      return new Promise(resolve => { approve = resolve; });
    },
  });
  t.after(() => bridge.close());
  await bridge.configure({ targetId });
  const request = client(port);
  const controller = new AbortController();
  const abandoned = request('connect', {}, undefined, {}, controller.signal);
  for (let retry = 0; !approve && retry < 100; retry++) await wait(10);
  assert.equal(typeof approve, 'function');
  controller.abort();
  await assert.rejects(abandoned, { name: 'AbortError' });
  for (let retry = 0; !dialogSignal.aborted && retry < 100; retry++) await wait(10);
  assert.equal(dialogSignal.aborted, true);
  approve(true);
  for (let retry = 0; (await request('connect', {})).status === 409 && retry < 100; retry++) await wait(10);
  assert.equal((await request('connect', {})).status, 429);
  assert.equal(bridge.status().paired, 0);

  approve = null;
  now += 9000;
  const revoked = request('connect', {});
  for (let retry = 0; !approve && retry < 100; retry++) await wait(10);
  assert.equal(typeof approve, 'function');
  await bridge.disconnect();
  assert.equal(dialogSignal.aborted, true);
  approve(true);
  assert.equal((await revoked).status, 403);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, 'utf8')).tokens, []);
});

test('browser image bytes and validated public image URLs go directly to the importer with page source intact', async t => {
  const root = await workspace(t);
  const requests = [];
  const port = await reservePort();
  const bridge = new BrowserCapture({ port, settingsFile: path.join(root, 'capture.json'),
    resolveTarget: () => ({ targetId, libraryId: 'b2', collectionId: '旅行参考' }),
    approveConnection: () => true,
    importAsset(task) { requests.push(task); return { id: fakeAsset }; },
  });
  t.after(() => bridge.close());
  await bridge.configure({ targetId });
  const request = client(port);
  const { token } = await (await request('connect', {})).json();
  const remote = 'https://images.example.org/sunset.png';
  const data = 'data:image/png;base64,' + pngBase64;
  assert.equal((await request('capture', { kind: 'image', url: remote, imageData: data, pageURL }, token)).status, 200);
  assert.equal((await request('capture', { kind: 'image', url: remote, pageURL }, token)).status, 200);
  assert.equal(requests.length, 2);
  const [{ source: staged, collectionId }, { source: downloadable }] = requests;
  assert.equal(collectionId, '旅行参考');
  assert.equal(staged.kind, 'buffer');
  assert.deepEqual(staged.bytes, Buffer.from(pngBase64, 'base64'));
  assert.equal(staged.name, 'sunset.png');
  assert.equal(staged.sourceURL, pageURL);
  assert.equal(staged.targetLibraryId, 'b2');
  assert.equal(downloadable.url, remote);
  assert.equal(downloadable.sourceURL, pageURL);
  assert.equal(downloadable.targetLibraryId, 'b2');
  const [, history] = bridge.history().records;
  // The stored pixels are read from the imported bytes, independently of browser display size.
  assert.deepEqual([history.originalURL, history.imageURL, history.width, history.height], [pageURL, remote, 1, 1]);
  assert.equal(bridge.historyAddress(history.id, 'imageURL'), remote);
  assert.equal(bridge.historyAddress(history.id, 'assetId'), null);
  assert.equal((await request('history', {}, token)).status, 404);
});

test('preserves the exact image post URL from a timeline, with the direct image as fallback', async t => {
  const root = await workspace(t);
  const port = await reservePort();
  const captured = [];
  const bridge = new BrowserCapture({ port, settingsFile: path.join(root, 'capture.json'),
    resolveTarget: selection => ({ ...selection, libraryId: 'b2' }),
    approveConnection: () => true,
    importAsset(task) { captured.push(task.source.sourceURL); return { id: fakeAsset }; },
  });
  t.after(() => bridge.close());
  await bridge.configure({ targetId });
  const request = client(port);
  const { token } = await (await request('connect', {})).json();
  const remote = 'https://pbs.twimg.com/media/sample?format=jpg&name=orig';
  const photo = 'https://x.com/example/status/123456/photo/2?view=full';
  const timeline = { kind: 'image', url: remote, pageURL: 'https://x.com/home' };
  for (const extra of [
    { sourceLink: photo, imageData: 'data:image/png;base64,' + pngBase64 },
    { sourceLink: photo },
    { pageURL: photo },
    { sourceLink: 'https://other.example/status/123456/photo/2' },
    { pageURL: 'https://example.org/archive', sourceLink: 'https://example.org/post/title?image=2#credits' },
  ]) {
    assert.equal((await request('capture', { ...timeline, ...extra }, token)).status, 200);
  }
  assert.deepEqual(captured, [photo, photo, photo, remote, 'https://example.org/post/title?image=2#credits']);
  const [linked, unknown, ...known] = bridge.history().records;
  assert.equal(linked.originalURL, 'https://example.org/post/title?image=2#credits');
  assert.equal(unknown.originalURL, null);
  assert(known.every(record => record.originalURL === photo));
});

test('a long capture reports progress and actionable failure, retries the same import, and never reports success before commit', async t => {
  const root = await workspace(t);
  const port = await reservePort();
  const requestId = randomUUID();
  const payload = { kind: 'image', url: 'https://images.example.org/a.png', pageURL, requestId };
  const calls = [];
  let finish;
  const bridge = new BrowserCapture({ port, captureWait: 5, settingsFile: path.join(root, 'capture.json'),
    resolveTarget: selection => ({ ...selection, libraryId: 'b2', destination: '本地库 / 摄影作品' }),
    approveConnection: () => true,
    importAsset(task) {
      calls.push(task);
      return new Promise((resolve, reject) => { finish = { resolve, reject }; });
    },
  });
  t.after(() => bridge.close());
  await bridge.configure({ targetId, collectionId: '摄影作品' });
  const request = client(port);
  const { token } = await (await request('connect', {})).json();
  assert.equal((await request('capture-status', { requestId }, token)).status, 404);
  const start = await request('capture', payload, token);
  assert.equal(start.status, 202);
  assert.deepEqual(await start.json(), { ok: true, pending: true, requestId });
  assert.equal((await request('capture-status', { requestId })).status, 401);
  assert.equal((await request('capture-status', { requestId }, token)).status, 202);
  assert.deepEqual(bridge.history().records, []);
  assert.equal((await request('capture', payload, token)).status, 202);
  assert.equal(calls.length, 1);

  finish.reject(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }));
  const failed = await request('capture-status', { requestId }, token);
  assert.equal(failed.status, 409);
  assert.equal((await failed.json()).message, '磁盘空间不足，请释放空间后重试。');
  assert.deepEqual(bridge.history().records, []);
  assert.equal((await request('capture', payload, token)).status, 202);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, calls[1].id);
  const resolvedImageURL = 'https://images.example.org/saved.png?size=4096';
  finish.resolve({ id: fakeAsset, browserCapture: { filename: 'saved.png', dimensions: [3053, 3788], resolvedImageURL } });
  let done;
  for (let tries = 0; tries < 100; tries++) {
    done = await request('capture-status', { requestId }, token);
    if (done.status !== 202) break;
    await done.body.cancel();
    await wait(10);
  }
  assert.equal(done.status, 200);
  const result = await done.json();
  assert.equal(result.assetId, fakeAsset);
  assert.equal(result.destination, '本地库 / 摄影作品');
  assert.deepEqual(result.target, { targetId, libraryId: 'b2', collectionId: '摄影作品' });
  assert.deepEqual(await (await request('capture', payload, token)).json(), result);
  assert.equal(calls.length, 2);
  const [record] = bridge.history().records;
  assert.deepEqual([record.originalURL, record.imageURL, record.width, record.height], [pageURL, resolvedImageURL, 3053, 3788]);
});

test('replaying a request after desktop exit reuses the committed local asset and keeps one original', async t => {
  const root = await workspace(t);
  const library = path.join(await fs.realpath(root), 'capture-library');
  const { libraryId } = await createLocalLibrary(library, '拖入测试库');
  const port = await reservePort();
  const settingsFile = path.join(root, 'capture.json');
  const config = { port, settingsFile, resolveTarget: selection => ({ ...selection, libraryId }),
    approveConnection: () => true,
    importAsset: task => importLocalAsset(library, { jobId: task.id, expectedLibraryId: libraryId,
      filename: task.source.name, sourceURL: task.source.sourceURL, bytes: task.source.bytes }),
  };
  const bridge = new BrowserCapture(config);
  t.after(() => bridge.close());
  await bridge.configure({ targetId });
  const request = client(port);
  const { token } = await (await request('connect', {})).json();
  const requestId = randomUUID();
  const body = { kind: 'image', url: 'data:image/png;base64,' + pngBase64, pageURL, requestId };
  const first = await (await request('capture', body, token)).json();
  assert.match(first.assetId, /^[a-f0-9]{64}$/);
  const originalHistory = bridge.history();
  assert.equal(originalHistory.records.length, 1);
  const [record] = originalHistory.records;
  assert.deepEqual([record.originalURL, record.imageURL, record.width, record.height], [pageURL, null, 1, 1]);
  const persisted = await fs.readFile(bridge.historyFile, 'utf8');
  assert(!persisted.includes('data:image'));
  assert(!persisted.includes(token));
  await bridge.close();

  const reopened = new BrowserCapture(config);
  t.after(() => reopened.close());
  await reopened.initialize();
  assert.deepEqual(reopened.history(), originalHistory);
  assert.equal((await request('capture-status', { requestId }, token)).status, 404);
  const retried = await (await request('capture', body, token)).json();
  assert.deepEqual(retried, first);
  assert.deepEqual(reopened.history(), originalHistory);
  const { assets } = await readLocalLibrary(library);
  assert.equal(assets.length, 1);
  assert.deepEqual([assets[0].width, assets[0].height, assets[0].sourceURL], [1, 1, pageURL]);
});

test('paired extensions receive only public target metadata, can create a collection, and can route one drop without changing the default', async t => {
  const root = await workspace(t);
  const port = await reservePort();
  const defaultTarget = { targetId, libraryId: 'b1', collectionId: null };
  const parent = { targetId: 'a2', libraryId: 'b2', collectionId: 'folder' };
  const privatePath = '/tmp/private/sync-library';
  const libraries = [
    { ...defaultTarget, name: '默认库', root: privatePath, collections: [] },
    { ...parent, name: '旅行参考', root: privatePath,
      collections: [{ id: 'folder', name: '公园', parentId: null, privatePath }] },
  ];
  const drops = [];
  const bridge = new BrowserCapture({ port, settingsFile: path.join(root, 'capture.json'), approveConnection: () => true,
    listLibraries: () => libraries,
    resolveTarget({ targetId, collectionId }) {
      const library = libraries.find(item => item.targetId === targetId);
      if (!library || (collectionId != null && !library.collections.some(item => item.id === collectionId))) {
        throw new Error('集合已变化，请重新选择。');
      }
      return { targetId, libraryId: library.libraryId, collectionId };
    },
    createCollection(selection, name) {
      const collection = { id: 'created', name, parentId: selection.collectionId, privatePath };
      libraries.find(item => item.targetId === selection.targetId).collections.push(collection);
      return collection;
    },
    importAsset(task) { drops.push(task); return { id: fakeAsset }; },
  });
  t.after(() => bridge.close());
  await bridge.configure(defaultTarget);
  const request = client(port);
  const { token } = await (await request('connect', {})).json();
  assert.equal((await request('targets', {})).status, 401);
  assert.equal((await request('targets', {}, token, { Origin: pageURL })).status, 403);
  assert.equal((await request('collection', { target: parent, name: '黄昏' })).status, 401);
  const targets = await (await request('targets', {}, token)).json();
  assert.deepEqual(targets, { ok: true, target: defaultTarget, confirmedCapture: true, canRouteCapture: true, canCreate: true, libraries: [
    { targetId, libraryId: 'b1', name: '默认库', collections: [] },
    { targetId: 'a2', libraryId: 'b2', name: '旅行参考', collections: [{ id: 'folder', name: '公园', parentId: null }] },
  ] });
  assert.equal((await request('collection', { target: parent, name: '\n ' }, token)).status, 400);
  assert.equal((await request('collection', { target: { ...parent, libraryId: 'replacement' }, name: '黄昏' }, token)).status, 409);
  const created = await (await request('collection', { target: parent, name: ' 黄昏 ' }, token)).json();
  assert.deepEqual(created, { ok: true, collection: { id: 'created', name: '黄昏', parentId: 'folder' } });
  const drop = { kind: 'link', url: pageURL, target: { ...parent, collectionId: 'created' } };
  assert.equal((await request('capture', drop, token)).status, 200);
  assert.deepEqual(drops[0], { id: drops[0].id, batchId: drops[0].id, targetId: 'a2', collectionId: 'created',
    source: { kind: 'url', url: pageURL, name: undefined, targetLibraryId: 'b2' } });
  assert.equal((await request('capture', { ...drop, target: { ...drop.target, libraryId: 'old' } }, token)).status, 409);
  assert.equal((await request('capture', { kind: 'link', url: pageURL }, token)).status, 200);
  assert.equal(drops.length, 2);
  assert.equal(drops[1].targetId, defaultTarget.targetId);
  assert.deepEqual(bridge.status().target, defaultTarget);
  await bridge.disconnect();
  assert.equal((await request('targets', {}, token)).status, 401);
});

test('capture rules route by website, URL and type with explicit destination override, persist and keep committed retries', async t => {
  const root = await workspace(t);
  const port = await reservePort();
  const request = client(port);
  const canonical = await fs.realpath(root);
  const defaultRoot = path.join(canonical, 'default');
  const ruleRoot = path.join(canonical, 'routed');
  const defaultId = (await createLocalLibrary(defaultRoot, '见藏')).libraryId;
  const ruleLibraryId = (await createLocalLibrary(ruleRoot, '素材归档')).libraryId;
  const { id: collectionId } = await mutateLocalLibrary(ruleRoot, { expectedLibraryId: ruleLibraryId,
    action: 'createCollection', name: '摄影' });
  const defaultTarget = { targetId, libraryId: defaultId, collectionId: null };
  const ruleTarget = { targetId: 'a2', libraryId: ruleLibraryId, collectionId };
  const settingsFile = path.join(root, 'capture.json');
  let available = true;
  let imports = 0;
  const config = { settingsFile, port, approveConnection: () => true,
    resolveTarget(target) {
      if (target.targetId === defaultTarget.targetId) return { ...defaultTarget, destination: '见藏' };
      if (available && target.targetId === ruleTarget.targetId && target.collectionId === collectionId) {
        return { ...ruleTarget, destination: '素材归档 / 摄影' };
      }
      throw new Error('目标集合暂不可用，请重新选择集合。');
    },
    importAsset(task) {
      imports++;
      const routed = task.targetId === ruleTarget.targetId;
      return importLocalAsset(routed ? ruleRoot : defaultRoot, { jobId: task.id,
        expectedLibraryId: task.source.targetLibraryId, collectionIds: routed ? [collectionId] : [],
        filename: task.source.name, sourceURL: task.source.sourceURL, bytes: task.source.bytes, tags: task.tags ?? [] });
    },
  };
  const bridge = new BrowserCapture(config);
  t.after(() => bridge.close());
  await bridge.initialize();
  await bridge.configure(defaultTarget);
  const { token } = await (await request('connect', {})).json();
  const metadata = { kind: 'image', pageURL: 'https://www.example.org/%E6%91%84%E5%BD%B1', url: 'https://cdn.example.net/image?format=PNG' };
  const png = { ...metadata, imageData: 'data:image/png;base64,' + pngBase64 };
  const preview = async (extra = {}) => (await request('route', { ...metadata, ...extra }, token)).json();
  assert.equal((await request('route', metadata)).status, 401);
  assert.equal((await request('route', { kind: 'unsupported' }, token)).status, 400);
  const broad = { name: '所有站内图片', enabled: true, domain: 'example.org', keyword: '', kind: 'image',
    target: defaultTarget, tags: ['站内'] };
  await bridge.saveRule(broad);
  await assert.rejects(bridge.saveRule({ ...broad, domain: 'https://example.org' }), /只填写主机名/);
  await assert.rejects(bridge.saveRule({ ...broad, target: undefined }), /有效的采集素材库/);
  const savedRules = await bridge.saveRule({ ...broad, name: '摄影专用', domain: '*.EXAMPLE.ORG.', keyword: '摄影', kind: 'png',
    target: ruleTarget, tags: ['摄影', ' 构图 ', 'LIGHT', 'light'] });
  const [firstRule, priorityRule] = savedRules.rules;
  assert.equal(priorityRule.domain, 'example.org');
  assert.deepEqual(priorityRule.tags, ['摄影', '构图', 'LIGHT']);

  assert.deepEqual(await preview(), { ok: true, target: defaultTarget, destination: '见藏', ruleName: broad.name, tags: ['站内'] });
  await bridge.changeRule(priorityRule.id, 'up');
  assert.deepEqual(await preview(), { ok: true, target: ruleTarget, destination: '素材归档 / 摄影', ruleName: '摄影专用',
    tags: ['摄影', '构图', 'LIGHT'] });
  assert.equal((await preview({ url: 'https://cdn.example.net/image.jpeg' })).ruleName, broad.name);
  assert.equal((await preview({ kind: 'page' })).ruleName, undefined);
  assert.equal((await preview({ pageURL: 'https://example.org.evil/%E6%91%84%E5%BD%B1' })).ruleName, undefined);
  assert.equal(imports, 0, 'preview has no capture or tag side effect');

  await bridge.changeRule(priorityRule.id, 'toggle');
  assert.equal((await preview()).ruleName, broad.name);
  await bridge.changeRule(priorityRule.id, 'toggle');
  const requestId = randomUUID();
  const routed = await (await request('capture', { ...png, requestId }, token)).json();
  assert.deepEqual(routed.target, ruleTarget);
  assert.deepEqual(routed.tags, ['摄影', '构图', 'LIGHT']);
  assert.equal(routed.ruleName, '摄影专用');
  const explicit = await (await request('capture', { ...png, target: defaultTarget }, token)).json();
  assert.deepEqual(explicit.target, defaultTarget);
  assert.equal(explicit.ruleName, undefined);
  assert.deepEqual((await readLocalLibrary(ruleRoot)).assets[0].tags, ['摄影', '构图', 'LIGHT']);
  assert.deepEqual((await readLocalLibrary(ruleRoot)).assets[0].collectionIds, [collectionId]);
  assert.deepEqual((await readLocalLibrary(defaultRoot)).assets[0].tags, []);
  assert.equal(bridge.history().records[1].ruleName, '摄影专用');
  assert(!Object.hasOwn(bridge.history().records[1], 'receiptKey'));

  await bridge.changeRule(firstRule.id, 'remove');
  available = false;
  assert.equal((await request('route', metadata, token)).status, 409);
  assert.equal((await request('capture', png, token)).status, 409);
  assert.equal(imports, 2, 'a matching rule with a stale destination does not silently save elsewhere');

  await bridge.close();
  const reopened = new BrowserCapture(config);
  t.after(() => reopened.close());
  await reopened.initialize();
  assert.deepEqual(reopened.status().rules.map(({ id }) => id), [priorityRule.id]);
  await reopened.changeRule(priorityRule.id, 'toggle');
  const replay = await (await request('capture', { ...png, requestId }, token)).json();
  assert.deepEqual(replay, routed);
  assert.equal(imports, 2, 'replay after restart keeps the original rule result');
  assert.equal(reopened.history().records.length, 2);
});

test('the extension manifest pins the companion origin and deployment retains the same stable directory', async t => {
  const root = await workspace(t);
  const bundle = path.resolve(__dirname, '..', 'browser-extension');
  const directory = path.join(root, 'browser-extension');
  await refreshBrowserExtension(bundle, directory);
  await assert.rejects(fs.access(directory), { code: 'ENOENT' });
  assert.equal(await prepareBrowserExtension(bundle, directory), directory);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
    .slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  assert.equal('chrome-extension://' + extensionId, extensionOrigin);
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal(manifest.update_url, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  await fs.writeFile(path.join(directory, 'background.js'), 'old');
  await refreshBrowserExtension(bundle, directory);
  assert.equal(await fs.readFile(path.join(directory, 'background.js'), 'utf8'), 'old');
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ ...manifest, version: '0.0.1' }));
  await refreshBrowserExtension(bundle, directory);
  assert.deepEqual((await fs.readdir(directory)).sort(), [...extensionFiles].sort());
  assert.deepEqual(await fs.readFile(path.join(directory, 'background.js')), await fs.readFile(path.join(bundle, 'background.js')));
});
