'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Readable } = require('node:stream');
const { setTimeout: wait } = require('node:timers/promises');
const { test } = require('node:test');
const { LocalImportQueue } = require('../local-import-queue.cjs');
const { downloadDroppedImage } = require('../dropped-image.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+WQAAAAASUVORK5CYII=', 'base64');
const firstLibrary = 'ab1';
const secondLibrary = 'ac1';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-import-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function until(check) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const result = check();
    if (result) return result;
    await wait(10);
  }
  assert.fail('Timed out waiting for the import queue state');
}

test('a browser image offer retains valid fallback URLs through restart and imports exactly one image', async t => {
  const root = await workspace(t);
  const primary = 'https://images.example.test/expired.png';
  const fallback = 'https://cdn.example.test/available.png';
  const requests = [];
  const imports = [];
  const config = {
    directory: path.join(root, 'queue'),
    async perform({ source }) {
      assert.deepEqual(source.fallbackURLs, [fallback]);
      const image = await downloadDroppedImage([source.url, ...source.fallbackURLs], {
        async open(url) {
          requests.push(url.href);
          const available = url.href === fallback;
          return Object.assign(Readable.from([available ? png : Buffer.from('expired')]), {
            statusCode: available ? 200 : 404,
            headers: { 'content-type': available ? 'image/png' : 'text/plain' },
          });
        },
      });
      imports.push(image);
    },
  };
  const original = new LocalImportQueue(config);
  await original.initialize();
  try {
    const { queued } = await original.enqueue({ targetId: firstLibrary, sources: [
      { kind: 'image-url', url: primary, fallbackURLs: ['file:///image.png', `${fallback}#preview`] },
    ] });
    assert.equal(queued, 1);
  } finally { await original.close(); }
  const reopened = new LocalImportQueue(config);
  await reopened.initialize();
  try {
    reopened.start();
    await until(() => reopened.summary(firstLibrary).done === 1);
    assert.deepEqual(requests, [primary, fallback]);
    assert.deepEqual(imports, [{ kind: 'buffer', bytes: png, name: 'available.png', sourceURL: fallback }]);
  } finally { await reopened.close(); }
});

test('desktop image download distinguishes the final response URL from the requested image', async () => {
  const requested = 'https://images.example.test/preview.png';
  const resolved = 'https://images.example.test/saved.png?size=4096';
  const image = await downloadDroppedImage(requested, {
    async open(url) {
      if (url.href === requested) {
        return Object.assign(Readable.from([]), { statusCode: 302, headers: { location: resolved } });
      }
      assert.equal(url.href, resolved);
      return Object.assign(Readable.from([png]), { statusCode: 200, headers: { 'content-type': 'image/png' } });
    },
  });
  assert.equal(image.sourceURL, requested);
  assert.equal(image.resolvedImageURL, resolved);
  assert.deepEqual(image.bytes, png);
});

test('serially processes isolated target libraries and can retry a failed file on its own', async t => {
  const root = await workspace(t);
  const source = path.join(root, '尚未下载.png');
  const calls = [];
  const notices = new Set();
  const queue = new LocalImportQueue({
    directory: path.join(root, 'queue'),
    onChange: target => notices.add(target),
    perform: async (task, progress) => {
      calls.push(task);
      if (task.source.kind === 'file') await fs.readFile(task.source.path);
      progress(0.4);
    },
  });
  await queue.initialize();
  try {
    const first = await queue.enqueue({ targetId: firstLibrary, collectionId: 'target-folder', sources: [
      { kind: 'file', root, path: source, collectionPaths: [['拍摄', '样片']] },
      { kind: 'catalog', registrationId: 'e1', assetId: 'a'.repeat(64), name: 'Eagle', preserveCollections: true },
    ] });
    await queue.enqueue({ targetId: secondLibrary, sources: [{ kind: 'url', url: 'https://example.test/read' }] });
    assert.equal(first.queued, 2);
    assert.equal(first.tasks[0].batchId, first.tasks[1].batchId);
    assert.match(first.tasks[0].assetId, /^[a-f0-9]{64}$/);
    assert.equal(first.tasks[0].source, undefined);
    assert.equal(first.tasks[0].collectionId, 'target-folder');
    assert.deepEqual(queue.summary(firstLibrary), { pending: 2, running: 0, done: 0, failed: 0 });
    assert.equal(calls.length, 0, 'Queue must wait for registry startup');

    queue.start();
    await until(() => queue.summary(secondLibrary).done === 1);
    assert.deepEqual(queue.summary(firstLibrary), { pending: 0, running: 0, done: 1, failed: 1 });
    const [failure] = queue.snapshot(firstLibrary);
    assert.equal(failure.id, first.tasks[0].id);
    assert.match(failure.error, /找不到/);
    assert.ok(!JSON.stringify(failure).includes(source));
    assert.deepEqual(calls[0].source.collectionPaths, [['拍摄', '样片']]);
    assert.equal(calls[1].source.preserveCollections, true);
    assert.equal(calls[2].source.url, 'https://example.test/read');
    await assert.rejects(queue.retry(secondLibrary, failure.id), /未找到/);
    assert.equal(queue.summary(secondLibrary).done, 1);
    await fs.writeFile(source, 'restore fixture source');
    await queue.retry(firstLibrary, failure.id);
    await until(() => queue.summary(firstLibrary).done === 2);
    assert.equal(calls.at(-1).assetId, failure.assetId);
    assert.equal(calls.at(-1).batchId, failure.batchId);
    assert.equal(calls.filter(task => task.id === first.tasks[1].id).length, 1);
    await until(() => notices.has(firstLibrary) && notices.has(secondLibrary));
  } finally {
    await queue.close();
  }
});

test('a process interrupted after source commit can replay the same stable asset and clipboard bytes', async t => {
  const root = await workspace(t);
  const directory = path.join(root, 'queue');
  const acceptedPath = path.join(root, 'accepted.json');
  const commitPath = path.join(root, 'asset-commit.json');
  const module = require.resolve('../local-import-queue.cjs');
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs/promises');
    const { LocalImportQueue } = require(process.env.JIANCANG_QUEUE_MODULE);
    (async () => {
      const queue = new LocalImportQueue({
        directory: process.env.JIANCANG_QUEUE_DIRECTORY,
        async perform(task) {
          const bytes = await fs.readFile(task.source.path);
          await fs.writeFile(process.env.JIANCANG_QUEUE_COMMIT, JSON.stringify({id: task.assetId, bytes}));
          process.exit(81);
        },
      });
      await queue.initialize();
      const accepted = await queue.enqueue({
        targetId: '${firstLibrary}', sources: [
          { kind: 'buffer', bytes: Buffer.from(process.env.JIANCANG_QUEUE_PNG, 'base64') },
          { kind: 'url', url: 'https://example.test/queued-while-exiting' },
        ],
      });
      await fs.writeFile(process.env.JIANCANG_QUEUE_ACCEPTED, JSON.stringify(accepted));
      queue.start();
    })().catch(error => { console.error(error); process.exit(1); });
  `], {
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', JIANCANG_QUEUE_MODULE: module, JIANCANG_QUEUE_DIRECTORY: directory,
      JIANCANG_QUEUE_COMMIT: commitPath, JIANCANG_QUEUE_ACCEPTED: acceptedPath, JIANCANG_QUEUE_PNG: png.toString('base64'),
    },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(child.status, 81, child.error ?? child.stderr);
  const accepted = JSON.parse(await fs.readFile(acceptedPath, 'utf8'));
  const commit = JSON.parse(await fs.readFile(commitPath, 'utf8'));
  assert.equal(commit.id, accepted.tasks[0].assetId);
  assert.deepEqual(Buffer.from(commit.bytes.data), png);

  const calls = [];
  const queue = new LocalImportQueue({
    directory,
    perform: async task => {
      calls.push(task.assetId);
      if (task.source.kind === 'file') {
        assert.equal(task.assetId, commit.id);
        assert.deepEqual(await fs.readFile(task.source.path), png);
      }
    },
  });
  await queue.initialize();
  try {
    assert.deepEqual(queue.snapshot(firstLibrary).map(task => task.status), ['pending', 'pending']);
    assert.deepEqual(queue.snapshot(firstLibrary).map(task => task.id), accepted.tasks.map(task => task.id));
    queue.start();
    await until(() => queue.summary(firstLibrary).done === 2);
    assert.deepEqual(calls, accepted.tasks.map(task => task.assetId));
    assert.deepEqual(await fs.readdir(path.join(directory, 'clipboard')), []);
  } finally {
    await queue.close();
  }
});

test('validates every source before accepting a batch and publishes current progress without source paths', async t => {
  const root = await workspace(t);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const queue = new LocalImportQueue({
    directory: path.join(root, 'queue'),
    perform: async (_task, progress) => {
      progress(0.6);
      progress(0.4);
      await blocked;
    },
  });
  await queue.initialize();
  const source = { kind: 'file', root, path: path.join(root, 'image.png') };
  try {
    await assert.rejects(queue.enqueue({ targetId: firstLibrary, sources: [
      source, { kind: 'file', root, path: path.join(root, '..', 'outside.png') },
    ] }), /不在已选择/);
    await assert.rejects(queue.enqueue({ targetId: firstLibrary, sources: [{ kind: 'url', url: 'file:///etc/passwd' }] }), /网页链接/);
    await assert.rejects(queue.enqueue({ targetId: firstLibrary, sources: [{ kind: 'buffer', bytes: Buffer.alloc(35) }] }), /PNG/);
    assert.deepEqual(queue.snapshot(firstLibrary), []);
    const { tasks } = await queue.enqueue({ targetId: firstLibrary, sources: [source] });
    queue.start();
    const running = await until(() => queue.snapshot(firstLibrary).find(task => task.status === 'running'));
    assert.equal(running.id, tasks[0].id);
    assert.equal(running.progress, 0.6);
    assert.ok(!JSON.stringify(running).includes(root));
    release();
    await until(() => queue.summary(firstLibrary).done === 1);
    assert.equal(queue.snapshot(firstLibrary)[0].progress, 1);
  } finally {
    release();
    await queue.close();
  }
});

test('upgrades queued imports with bounded collection previews and retains committed IDs on restart', async t => {
  const root = await workspace(t);
  const resultId = '1'.repeat(64);
  const config = {
    directory: path.join(root, 'queue'),
    async perform() { return { id: resultId }; },
  };
  const first = new LocalImportQueue(config);
  await first.initialize();
  const source = { kind: 'url', url: 'https://example.com/one' };
  const { tasks } = await first.enqueue({
    targetId: firstLibrary, collectionId: 'clips', sources: Array.from({ length: 26 }, () => source),
  });
  await first.enqueue({ targetId: firstLibrary, collectionId: 'other', sources: [source] });
  await first.close();
  const legacy = new DatabaseSync(path.join(config.directory, 'queue.sqlite'));
  try {
    legacy.exec('ALTER TABLE tasks DROP COLUMN result_id');
  } finally { legacy.close(); }

  const upgraded = new LocalImportQueue(config);
  await upgraded.initialize();
  try {
    const preview = upgraded.previewSnapshot(firstLibrary, ['clips']);
    assert.equal(preview.previewCount, 26);
    assert.equal(preview.tasks.length, 24);
    assert.deepEqual(preview.tasks.map(task => task.id), tasks.slice(0, 24).map(task => task.id));
    assert.deepEqual(upgraded.previewSnapshot(firstLibrary, []), { tasks: [], previewCount: 0 });
    upgraded.start();
    await until(() => upgraded.summary(firstLibrary).done === 27);
  } finally { await upgraded.close(); }

  const reopened = new LocalImportQueue(config);
  await reopened.initialize();
  try {
    const preview = reopened.previewSnapshot(firstLibrary, ['clips']);
    assert.equal(preview.previewCount, 0);
    assert.equal(preview.tasks.length, 26);
    assert.ok(preview.tasks.every(task => task.status === 'done' && task.resultId === resultId));
    assert.equal(reopened.snapshot(firstLibrary).length, 27);
  } finally { await reopened.close(); }
});

test('a paused library finishes the running job, leaves other libraries moving, and waits after restart', async t => {
  const root = await workspace(t);
  const directory = path.join(root, 'queue');
  const calls = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const config = {
    directory,
    async perform(task) {
      calls.push(task.name);
      if (task.name === 'held') await held;
    },
  };
  const first = new LocalImportQueue(config);
  await first.initialize();
  const source = name => ({ kind: 'url', name, url: `https://example.test/${name}` });
  try {
    const { tasks } = await first.enqueue({ targetId: firstLibrary, sources: [source('held'), source('later')] });
    await first.enqueue({ targetId: secondLibrary, sources: [source('other')] });
    first.start();
    await until(() => first.summary(firstLibrary).running === 1);
    assert.equal(first.setPaused(firstLibrary, true), true);
    assert.equal(first.isPaused(firstLibrary), true);
    assert.equal(first.isPaused(secondLibrary), false);
    await assert.rejects(first.cancel(firstLibrary, tasks[0].id), /已经开始/);
    await assert.rejects(first.cancel(secondLibrary, tasks[1].id), /任务已更新/);
    release();
    await until(() => first.summary(secondLibrary).done === 1);
    assert.equal(first.summary(firstLibrary).pending, 1);
    assert.deepEqual(calls, ['held', 'other']);
  } finally {
    release();
    await first.close();
  }
  const reopened = new LocalImportQueue(config);
  await reopened.initialize();
  try {
    reopened.start();
    assert.equal(reopened.isPaused(firstLibrary), true);
    await reopened.enqueue({ targetId: secondLibrary, sources: [source('other-after-restart')] });
    await until(() => reopened.summary(secondLibrary).done === 2);
    assert.equal(reopened.summary(firstLibrary).pending, 1);
    assert.equal(reopened.setPaused(firstLibrary, false), false);
    await until(() => reopened.summary(firstLibrary).done === 2);
    assert.deepEqual(calls, ['held', 'other', 'other-after-restart', 'later']);
  } finally { await reopened.close(); }
});

test('cancel removes queued clipboard data and failed jobs while preserving originals and the canceled watched version', async t => {
  const root = await workspace(t);
  const directory = path.join(root, 'queue');
  const file = path.join(root, 'watch.png');
  await fs.writeFile(file, png);
  const watched = { kind: 'file', root, path: file, inboxKey: 'c'.repeat(32), inboxStamp: '1:2:3:4:5:6', inboxRootStamp: '1:2:3' };
  const config = { directory, async perform() { throw new Error('测试：暂时不可用'); } };
  const first = new LocalImportQueue(config);
  await first.initialize();
  try {
    first.setPaused(firstLibrary, true);
    const { tasks } = await first.enqueue({ targetId: firstLibrary, collectionId: 'photos',
      sources: [watched, { kind: 'buffer', name: 'Queued clip', bytes: png }] });
    await first.cancel(firstLibrary, tasks[1].id);
    assert.deepEqual(await fs.readdir(path.join(directory, 'clipboard')), []);
    first.start();
    first.setPaused(firstLibrary, false);
    await until(() => first.summary(firstLibrary).failed === 1);
    await first.cancel(firstLibrary, tasks[0].id);
    assert.deepEqual(first.snapshot(firstLibrary), []);
    assert.deepEqual(await fs.readFile(file), png);
    assert.equal((await first.enqueue({ targetId: firstLibrary, collectionId: 'photos', sources: [watched] })).queued, 0);
  } finally { await first.close(); }
  const reopened = new LocalImportQueue(config);
  await reopened.initialize();
  try {
    assert.equal((await reopened.enqueue({ targetId: firstLibrary, collectionId: 'photos', sources: [watched] })).queued, 0);
    const changed = { ...watched, inboxKey: 'd'.repeat(32), inboxStamp: '1:2:3:4:5:7' };
    assert.equal((await reopened.enqueue({ targetId: firstLibrary, collectionId: 'photos', sources: [changed] })).queued, 1);
  } finally { await reopened.close(); }
});

test('bulk cancel removes only the requested library’s pending jobs and preserves watched receipts', async t => {
  const root = await workspace(t);
  const directory = path.join(root, 'queue');
  const file = path.join(root, 'watch.png');
  await fs.writeFile(file, png);
  const watched = { kind: 'file', root, path: file, inboxKey: 'c'.repeat(32), inboxStamp: '1:2:3:4:5:6', inboxRootStamp: '1:2:3' };
  const source = name => ({ kind: 'url', name, url: `https://example.test/${name}` });
  const clipboard = name => ({ kind: 'buffer', name, bytes: png });
  const { promise: held, resolve: release } = Promise.withResolvers();
  const calls = [];
  const config = {
    directory,
    async perform(task) {
      calls.push(task.name);
      if (task.name === 'failed') throw new Error('测试：导入失败');
      if (task.name === 'held.png') {
        await held;
        assert.deepEqual(await fs.readFile(task.source.path), png);
      }
    },
  };
  const queue = new LocalImportQueue(config);
  await queue.initialize();
  try {
    queue.setPaused(secondLibrary, true);
    const { tasks: [other] } = await queue.enqueue({ targetId: secondLibrary, sources: [clipboard('other')] });
    const { tasks: [done, failed, running] } = await queue.enqueue({
      targetId: firstLibrary, sources: [source('done'), source('failed'), clipboard('held')],
    });
    const sources = [watched, clipboard('discard'), ...Array.from({ length: 80 }, (_, index) => source(`waiting-${index}`))];
    await queue.enqueue({ targetId: firstLibrary, collectionId: 'photos', sources });
    queue.start();
    await until(() => queue.summary(firstLibrary).running === 1);
    queue.setPaused(firstLibrary, true);

    assert.equal(await queue.cancelPending(firstLibrary), sources.length);
    assert.equal(await queue.cancelPending(firstLibrary), 0);
    assert.equal(queue.isPaused(firstLibrary), true);
    assert.deepEqual(queue.snapshot(firstLibrary).map(({ id, status }) => [id, status]),
      [[failed.id, 'failed'], [running.id, 'running'], [done.id, 'done']]);
    assert.deepEqual(queue.snapshot(secondLibrary), [other]);
    assert.deepEqual((await fs.readdir(path.join(directory, 'clipboard'))).sort(),
      [`${running.id}.png`, `${other.id}.png`].sort());
    assert.deepEqual(await fs.readFile(file), png);
    release();
    await until(() => queue.summary(firstLibrary).done === 2);
    assert.deepEqual(calls, ['done', 'failed', 'held.png']);
  } finally {
    release();
    await queue.close();
  }
  const reopened = new LocalImportQueue(config);
  await reopened.initialize();
  try {
    assert.equal(reopened.isPaused(firstLibrary), true);
    assert.equal((await reopened.enqueue({ targetId: firstLibrary, collectionId: 'photos', sources: [watched] })).queued, 0);
    const changed = { ...watched, inboxKey: 'd'.repeat(32), inboxStamp: '1:2:3:4:5:7' };
    assert.equal((await reopened.enqueue({ targetId: firstLibrary, collectionId: 'photos', sources: [changed] })).queued, 1);
  } finally { await reopened.close(); }
});

test('bulk retry requeues only failed jobs of the requested library in their original order', async t => {
  const root = await workspace(t);
  let fail = true;
  const calls = [];
  const queue = new LocalImportQueue({
    directory: path.join(root, 'queue'),
    async perform(task) {
      calls.push(task.name);
      if (fail) throw new Error('测试：导入失败');
    },
  });
  await queue.initialize();
  const source = name => ({ kind: 'url', name, url: `https://example.test/${name}` });
  try {
    const { tasks } = await queue.enqueue({ targetId: firstLibrary, sources: [source('first'), source('second')] });
    await queue.enqueue({ targetId: secondLibrary, sources: [source('another-library')] });
    queue.start();
    await until(() => queue.summary(secondLibrary).failed === 1);
    queue.setPaused(firstLibrary, true);
    await queue.enqueue({ targetId: firstLibrary, sources: [source('already-pending')] });
    assert.equal(queue.retryFailed(firstLibrary), 2);
    assert.equal(queue.retryFailed(firstLibrary), 0);
    assert.equal(queue.summary(secondLibrary).failed, 1);
    assert.deepEqual(queue.snapshot(firstLibrary).slice(1).map(task => [task.id, task.assetId, task.error]),
      tasks.map(task => [task.id, task.assetId, null]));
    fail = false;
    queue.setPaused(firstLibrary, false);
    await until(() => queue.summary(firstLibrary).done === 3);
    assert.deepEqual(calls, ['first', 'second', 'another-library', 'already-pending', 'first', 'second']);
  } finally { await queue.close(); }
});
