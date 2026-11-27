'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { FolderInbox, openInboxOriginal } = require('../folder-inbox.cjs');
const { LocalImportQueue } = require('../local-import-queue.cjs');

const targetId = 'a11ce';
const quietMs = 35;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jincang-inbox-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'incoming');
  const library = path.join(root, 'collection');
  const directory = path.join(root, 'profile', 'inbox');
  await Promise.all([fs.mkdir(source), fs.mkdir(library)]);
  return { root, source, library, directory };
}

function inbox(setup, enqueue, extra = {}) {
  return new FolderInbox({ directory: setup.directory, enqueue, pollMs: 0, quietMs,
    getTarget: ({ targetId: id }) => id === targetId,
    getProtectedRoots: () => [setup.library], ...extra });
}

async function settle(watch, id) {
  await watch.scan(id);
  await wait(quietMs + 10);
  return watch.scan(id);
}

test('queues only files stable across sightings while preserving sources and checking versions on read', async t => {
  const setup = await fixture(t);
  const old = path.join(setup.source, 'already here.txt');
  await fs.writeFile(old, 'existing');
  const collected = [];
  const watch = inbox(setup, request => { collected.push(...request.sources); });
  t.after(() => watch.close());
  await watch.initialize();
  const { id } = await watch.add({ sourcePath: setup.source, targetId, recursive: true });
  assert.equal((await settle(watch, id)).queued, 0);
  const nested = path.join(setup.source, 'prints');
  await fs.mkdir(nested);
  await fs.mkdir(path.join(setup.source, 'Ignored.library'));
  const awaiting = path.join(nested, 'slow.mp4');
  const hidden = path.join(setup.source, '.hidden.jpg');
  await Promise.all([
    fs.writeFile(awaiting, 'part one'), fs.writeFile(hidden, '.'),
    fs.writeFile(path.join(setup.source, 'receiving.crdownload'), 'draft'),
    fs.writeFile(path.join(setup.source, 'Ignored.library', 'unknown.png'), 'private metadata'),
    fs.symlink(old, path.join(setup.source, 'alias.txt')),
  ]);
  assert.equal((await watch.scan(id)).waiting, 1);
  await fs.appendFile(awaiting, ' and two');
  assert.equal((await watch.scan(id)).queued, 0);
  assert.equal((await settle(watch, id)).queued, 1);
  assert.equal(collected.length, 1);
  const original = await fs.readFile(awaiting);
  const handle = await openInboxOriginal(collected[0]);
  try {
    const data = Buffer.alloc(original.length);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    assert.equal(bytesRead, data.length);
    assert.deepEqual(data, original);
    await fs.appendFile(awaiting, ' appended');
    await assert.rejects(handle.stat(), /发生了变化/);
  } finally { await handle.close(); }
  await assert.rejects(openInboxOriginal(collected[0]), /发生了变化/);
  assert.equal((await settle(watch, id)).queued, 2);
  assert.notEqual(collected[0].inboxKey, collected[1].inboxKey);
  assert.equal(await fs.readFile(awaiting, 'utf8'), 'part one and two appended');
});

test('keeps one import task through a lost enqueue acknowledgement and persists pause state', async t => {
  const setup = await fixture(t);
  let applied = 0;
  let queue = new LocalImportQueue({ directory: path.join(setup.root, 'profile', 'queue'), perform: async ({ source }) => {
    const handle = await openInboxOriginal(source);
    await handle.close();
    applied++;
  } });
  t.after(() => queue.close());
  await queue.initialize();
  let firstKey;
  let watch = inbox(setup, async request => {
    firstKey = request.sources[0].inboxKey;
    await queue.enqueue(request);
    throw new Error('写入监控记录前中断。');
  });
  t.after(() => watch.close());
  await watch.initialize();
  const { id } = await watch.add({ sourcePath: setup.source, targetId, includeExisting: true });
  await fs.writeFile(path.join(setup.source, 'incoming.txt'), 'must be imported once');
  assert.equal((await settle(watch, id)).status, 'error');
  assert.equal(queue.summary(targetId).pending, 1);
  assert.equal(queue.snapshot(targetId)[0].id, firstKey);
  await watch.close();
  await queue.close();

  queue = new LocalImportQueue({ directory: path.join(setup.root, 'profile', 'queue'), perform: async ({ source }) => {
    const handle = await openInboxOriginal(source);
    await handle.close();
    applied++;
  } });
  await queue.initialize();
  watch = inbox(setup, request => queue.enqueue(request));
  await watch.initialize();
  assert.equal((await settle(watch, id)).queued, 1);
  assert.equal(queue.summary(targetId).pending, 1);
  queue.start();
  for (let turn = 0; turn < 200 && applied === 0; turn++) await wait(5);
  assert.equal(applied, 1);
  assert.equal(queue.snapshot(targetId)[0].id, firstKey);
  await watch.setPaused(id, true);
  await fs.writeFile(path.join(setup.source, 'paused.txt'), 'while paused');
  assert.equal((await settle(watch, id)).queued, 1);
  await watch.close();
  watch = inbox(setup, request => queue.enqueue(request));
  await watch.initialize();
  assert.equal(watch.list()[0].status, 'paused');
  await watch.setPaused(id, false);
  assert.equal((await settle(watch, id)).queued, 2);
  assert.equal((await settle(watch, id)).queued, 2);
  await watch.remove(id);
  assert.equal(watch.list().length, 0);
  assert.equal(await fs.readFile(path.join(setup.source, 'paused.txt'), 'utf8'), 'while paused');
});

test('refuses protected roots and a directory substituted after user selection', async t => {
  const setup = await fixture(t);
  const linked = path.join(setup.root, 'link');
  await fs.symlink(setup.source, linked);
  const watch = inbox(setup, () => assert.fail('unsafe source reached the queue'));
  t.after(() => watch.close());
  await watch.initialize();
  for (const sourcePath of [setup.root, setup.library]) await assert.rejects(watch.add({ sourcePath, targetId }), /分开/);
  await assert.rejects(watch.add({ sourcePath: linked, targetId }), /实际的文件夹/);
  const { id } = await watch.add({ sourcePath: setup.source, targetId });
  await fs.rename(setup.source, `${setup.source}-old`);
  await fs.mkdir(setup.source);
  await fs.writeFile(path.join(setup.source, 'different-root.txt'), 'not granted');
  assert.match((await watch.scan(id)).error, /位置已变化/);
});
