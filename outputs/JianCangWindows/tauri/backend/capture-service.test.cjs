'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: wait } = require('node:timers/promises');
const { CaptureService } = require('./capture-service.cjs');
const { LibraryService } = require('./library-service.cjs');
const { extensionOrigin, prepareBrowserExtension } = require('../../browser-capture.cjs');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const extensionBundle = path.resolve(__dirname, '../../browser-extension');

function requestBrowser(port, name, value, token, signal) {
  return fetch(`http://127.0.0.1:${port}/v1/${name}`, {
    method: 'POST',
    headers: { Origin: extensionOrigin, 'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(value),
    signal,
  });
}

async function waitForPairing(capture) {
  for (let index = 0; index < 100; index++) {
    const { pairing } = await capture.command('browser-capture:worker-state');
    if (pairing) return pairing.id;
    await wait(20);
  }
  assert.fail('No native pairing request was queued.');
}

async function reservePort() {
  const server = http.createServer((request, response) => response.end('original'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    port,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}

test('candidate capture waits for port release, pairs through the main window, and persists saved assets and history',
  { timeout: 20_000 }, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-candidate-capture-')));
    const blocker = await reservePort();
    const profile = path.join(root, 'profile');
    const library = new LibraryService(profile);
    const options = { profile, library, port: blocker.port, legacyExtensionDirectory: null };
    let capture = new CaptureService(options);
    try {
      await library.initialize();
      const state = await library.command('local:create', ['采集测试库', root]);
      const target = { targetId: state.activeLibraryId };
      await capture.initialize();
      assert.equal((await capture.command('browser-capture:status')).enabled, false);
      await assert.rejects(capture.command('browser-capture:configure', [target]), new RegExp(`采集端口 ${blocker.port}`));
      assert.equal(await (await fetch(`http://127.0.0.1:${blocker.port}`)).text(), 'original');
      await blocker.close();

      const enabled = await capture.command('browser-capture:configure', [target]);
      assert.equal(enabled.enabled, true);
      const selection = enabled.target;
      assert.equal((await requestBrowser(blocker.port, 'targets', {})).status, 401);
      const connection = requestBrowser(blocker.port, 'connect', {});
      const id = await waitForPairing(capture);
      assert.equal((await capture.command('browser-capture:worker-resolve', [randomUUID(), true])).settled, false);
      assert.equal((await capture.command('browser-capture:worker-resolve', [id, true])).settled, true);
      const response = await connection;
      assert.equal(response.status, 200);
      const { token } = await response.json();
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal((await capture.command('browser-capture:worker-state')).pairing, null);
      assert.doesNotMatch(await fs.readFile(path.join(profile, 'browser-capture.json'), 'utf8'), new RegExp(token));

      const collected = await requestBrowser(blocker.port, 'collection', { target: selection, name: '摄影资料' }, token);
      assert.equal(collected.status, 200);
      const { collection } = await collected.json();
      const rule = { enabled: true, name: '摄影图片', domain: 'example.org', keyword: 'photography', kind: 'image',
        target: { ...selection, collectionId: collection.id }, tags: ['来自浏览器'] };
      assert.equal((await capture.command('browser-capture:rule-save', [rule])).rules.length, 1);
      const originalURL = 'https://example.org/photography/post-22';
      const imageURL = 'https://cdn.example.org/gallery/example.png';
      const payload = { requestId: randomUUID(), kind: 'image', pageURL: originalURL, url: imageURL,
        imageData: `data:image/png;base64,${png}` };
      const routeResponse = await requestBrowser(blocker.port, 'route', payload, token);
      assert.equal(routeResponse.status, 200);
      assert.equal((await routeResponse.json()).ruleName, rule.name);
      const imported = await requestBrowser(blocker.port, 'capture', payload, token);
      let saved = await imported.json();
      for (let index = 0; saved.pending && index < 80; index++) {
        await wait(30);
        const progress = await requestBrowser(blocker.port, 'capture-status', { requestId: payload.requestId }, token);
        saved = await progress.json();
      }
      assert.match(saved.assetId, /^[a-f0-9]{64}$/, saved.message);
      assert.equal(saved.target.collectionId, collection.id);
      const after = await library.command('library:state', []);
      const asset = after.library.assets.find(item => item.id === saved.assetId);
      assert.deepEqual(asset.tags, rule.tags);
      assert.deepEqual(asset.collectionIds, [collection.id]);
      assert.equal(asset.sourceURL, originalURL);
      const { records } = await capture.command('browser-capture:history');
      assert.equal(records.length, 1);
      assert.deepEqual([records[0].originalURL, records[0].imageURL, records[0].width, records[0].height], [
        originalURL, imageURL, 1, 1,
      ]);
      assert.equal((await capture.command('browser-capture:worker-state')).historyRevision, 1);
      assert.deepEqual(await capture.command('browser-capture:copy-history-address', [records[0].id, 'imageURL']),
        { ok: true, url: imageURL });

      await capture.close();
      capture = new CaptureService(options);
      await capture.initialize();
      const existing = await requestBrowser(blocker.port, 'capture', payload, token);
      assert.equal((await existing.json()).assetId, saved.assetId);
      assert.equal((await capture.command('browser-capture:history')).records.length, 1);
      assert.equal((await capture.command('browser-capture:disconnect', [false])).paired, 0);
      assert.equal((await requestBrowser(blocker.port, 'targets', {}, token)).status, 401);

      const stopped = new AbortController();
      const pending = requestBrowser(blocker.port, 'connect', {}, undefined, stopped.signal);
      const settled = assert.rejects(pending, { name: 'AbortError' });
      const cancelledId = await waitForPairing(capture);
      stopped.abort();
      await settled;
      for (let attempt = 0; attempt < 100 && (await capture.command('browser-capture:worker-state')).pairing; attempt++) await wait(20);
      assert.equal((await capture.command('browser-capture:worker-state')).pairing, null);
      assert.equal((await capture.command('browser-capture:worker-resolve', [cancelledId, true])).settled, false);
      assert.equal((await capture.command('browser-capture:disconnect', [true])).enabled, false);
    } finally {
      await capture.close();
      await blocker.close();
      await library.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('candidate opens the installed extension folder untouched, and otherwise keeps its own stable folder', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-candidate-extension-')));
  const profile = path.join(root, 'candidate');
  const legacy = path.join(root, 'original', 'browser-extension');
  const capture = new CaptureService({ profile, library: {}, legacyExtensionDirectory: legacy });
  try {
    await prepareBrowserExtension(extensionBundle, legacy);
    const originalFile = path.join(legacy, 'background.js');
    const installed = Buffer.concat([await fs.readFile(originalFile), Buffer.from('\n// Installed QA copy.\n')]);
    await fs.writeFile(originalFile, installed);
    const existing = await capture.command('browser-capture:extension');
    assert.deepEqual(existing, { ok: true, directory: legacy });
    assert.deepEqual(await fs.readFile(originalFile), installed);
    await assert.rejects(fs.access(path.join(profile, 'browser-extension')), { code: 'ENOENT' });

    await fs.rename(legacy, path.join(root, 'disconnected-extension'));
    const directory = path.join(profile, 'browser-extension');
    const locations = await Promise.all([capture.command('browser-capture:extension'), capture.command('browser-capture:extension')]);
    assert.deepEqual(locations, [{ ok: true, directory }, { ok: true, directory }]);
    assert.deepEqual(await fs.readFile(path.join(directory, 'manifest.json')), await fs.readFile(path.join(extensionBundle, 'manifest.json')));
  } finally {
    await capture.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('installed production enables capture for the first available library and updates its managed extension in place', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-production-capture-')));
  const blocker = await reservePort();
  await blocker.close();
  const profile = path.join(root, 'profile');
  const legacy = path.join(root, 'legacy', 'browser-extension');
  const target = { targetId: 'local-fixture', libraryId: 'capture-fixture', collectionId: null };
  let available = [];
  const library = {
    registry: { selectedId: target.targetId },
    captureLibraries: () => available,
    captureTarget: selection => selection,
  };
  const options = { profile, library, port: blocker.port, legacyExtensionDirectory: legacy, production: true };
  let capture = new CaptureService(options);
  try {
    await prepareBrowserExtension(extensionBundle, legacy);
    const manifest = path.join(legacy, 'manifest.json');
    const bundled = await fs.readFile(path.join(extensionBundle, 'manifest.json'), 'utf8');
    await fs.writeFile(manifest, JSON.stringify({ ...JSON.parse(bundled), version: '0.0.1' }));
    await capture.initialize();
    assert.equal(await fs.readFile(manifest, 'utf8'), bundled);
    assert.equal((await capture.command('browser-capture:status')).awaitingDefault, true);
    available = [target];
    await capture.enableDefault();
    assert.equal((await capture.command('browser-capture:status')).enabled, true);
    assert.equal((await capture.command('browser-capture:extension')).directory, legacy);

    await capture.command('browser-capture:disconnect', [true]);
    await capture.close();
    capture = new CaptureService(options);
    await capture.initialize();
    assert.equal((await capture.command('browser-capture:status')).enabled, false);
  } finally {
    await capture.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
