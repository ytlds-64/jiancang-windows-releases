'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { LibraryService } = require('./library-service.cjs');
const { TransferService } = require('./transfer-service.cjs');
const { isWithin } = require('../../original-file.cjs');

const minute = 60_000;
const text = '真实文件副本';
const ownerName = '.jiancang-drag-owner';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-transfer-test-')));
  const temporary = path.join(root, 'tmp');
  const downloads = path.join(root, 'Downloads');
  await Promise.all([temporary, downloads].map(directory => fs.mkdir(directory)));
  const library = new LibraryService(path.join(root, 'profile'));
  const services = [];
  t.after(async () => {
    await Promise.all(services.map(service => service.close()));
    await library.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await library.initialize();
  const { activeLibraryId: id } = await library.command('local:create', ['测试素材库', root]);
  const source = path.join(root, '素材.txt');
  await fs.writeFile(source, text);
  await library.command('local-import:choose', [id, null, [source]]);
  let asset;
  const limit = Date.now() + 5000;
  while (!asset && Date.now() < limit) {
    [asset] = (await library.command('library:state', [])).library.assets;
    if (!asset) await delay(25);
  }
  assert.ok(asset);
  let clock = Date.now();
  const create = () => {
    const service = new TransferService(library, downloads, { temporary, now: () => clock });
    services.push(service);
    return service;
  };
  return { root, temporary, downloads, library, source, asset, id, create, now: () => clock, advance: elapsed => { clock += elapsed; } };
}

test('temporary drag copies are unique and reusable, with no Downloads output and a pinned receiving grace', async t => {
  const { temporary, downloads, source, asset, id, create, advance } = await fixture(t);
  const service = create();
  const first = await service.prepare(asset.id, id);
  const file = await service.use(first.token);
  assert.ok(isWithin(temporary, file));
  assert.equal(path.basename(file), '素材.txt');
  assert.equal(await fs.readFile(file, 'utf8'), text);
  await assert.rejects(service.use(first.token), /正在拖出/);
  await service.finish(first.token);
  assert.equal(await service.use(first.token), file);

  const second = await service.prepare(asset.id, id);
  const other = await service.use(second.token);
  await service.finish(second.token);
  assert.notEqual(file, other);
  assert.equal(path.basename(file), path.basename(other));
  assert.deepEqual(await fs.readdir(downloads), []);

  advance(16 * minute);
  await service.sweep();
  assert.equal(await fs.readFile(file, 'utf8'), text);
  await assert.rejects(fs.stat(other), { code: 'ENOENT' });
  await service.finish(first.token);
  await assert.rejects(service.use(first.token), /已失效/);
  advance(9 * minute);
  await service.sweep();
  assert.equal(await fs.readFile(file, 'utf8'), text);

  advance(2 * minute);
  await service.sweep();
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.equal(await fs.readFile(source, 'utf8'), text);
});

test('tampered temporary tickets are rejected and clipboard copies remain independent and durable', async t => {
  const { asset, id, downloads, create, advance } = await fixture(t);
  const destination = path.join(downloads, '见藏拖出');
  await fs.mkdir(destination);
  const previous = path.join(destination, '已经保存的副本.txt');
  await fs.writeFile(previous, '保留');
  const service = create();
  const drag = await service.prepare(asset.id, id);
  const staged = await service.use(drag.token);
  await service.finish(drag.token);
  await fs.writeFile(staged, '替换的内容');
  await assert.rejects(service.use(drag.token), /副本已变化/);
  const next = await service.prepare(asset.id, id);
  assert.equal(await fs.readFile(await service.use(next.token), 'utf8'), text);
  await service.finish(next.token);

  const clipboard = await service.forClipboard(asset.id, id);
  assert.ok(isWithin(destination, clipboard));
  assert.notEqual(clipboard, staged);
  assert.equal(await fs.readFile(clipboard, 'utf8'), text);
  advance(16 * minute);
  await service.close();
  await assert.rejects(fs.stat(staged), { code: 'ENOENT' });
  assert.equal(await fs.readFile(clipboard, 'utf8'), text);
  assert.equal(await fs.readFile(previous, 'utf8'), '保留');
});

test('a failed deletion keeps ticket ownership for retry after the receiving app releases the file', async t => {
  const { create, asset, id, advance } = await fixture(t);
  const service = create();
  const drag = await service.prepare(asset.id, id);
  const file = await service.use(drag.token);
  await service.finish(drag.token);
  advance(16 * minute);
  const remove = fs.rm;
  const blocked = t.mock.method(fs, 'rm', async (target, options) => {
    if (target === file) throw Object.assign(new Error('receiver has an open handle'), { code: 'EBUSY' });
    return remove(target, options);
  });
  await service.sweep();
  assert.equal(await fs.readFile(file, 'utf8'), text);
  assert.ok(await fs.stat(path.join(path.dirname(file), ownerName)));
  blocked.mock.restore();
  await service.sweep();
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('startup removes old owned tickets only, leaving recent, active, unchecked and linked files alone', async t => {
  const { source, create, asset, id, now, advance } = await fixture(t);
  const service = create();
  const receipt = await service.prepare(asset.id, id);
  const pathFromDrag = await service.use(receipt.token);
  await service.finish(receipt.token);
  const folder = path.dirname(pathFromDrag);
  const marker = path.join(folder, ownerName);
  const parent = path.dirname(folder);
  const info = JSON.parse(await fs.readFile(marker, 'utf8'));
  await service.close();

  const deadPid = 0x7ffffffd;
  await fs.writeFile(marker, JSON.stringify({ ...info, pid: deadPid }));
  await fs.utimes(marker, now() / 1000, now() / 1000);
  const makeTicket = async (pid, time) => {
    const token = randomUUID();
    const directory = path.join(parent, 'drag-' + token);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, '样片.txt'), text);
    const owner = path.join(directory, ownerName);
    await fs.writeFile(owner, JSON.stringify({ ...info, token, pid }));
    await fs.utimes(owner, time / 1000, time / 1000);
    return directory;
  };
  const active = await makeTicket(process.pid, now());
  const recent = await makeTicket(deadPid, now() + 7 * minute);
  const unexpected = await makeTicket(deadPid, now());
  await fs.mkdir(path.join(unexpected, '用户目录'));
  const unmatched = path.join(parent, 'drag-' + randomUUID());
  await fs.mkdir(unmatched);
  await fs.writeFile(path.join(unmatched, '用户文件.txt'), '保持原样');
  const symlink = path.join(parent, 'drag-' + randomUUID());
  await fs.symlink(path.dirname(source), symlink, 'junction');

  advance(16 * minute);
  const reopened = create();
  await reopened.initialize();
  await assert.rejects(fs.stat(folder), { code: 'ENOENT' });
  for (const directory of [active, recent, unexpected]) assert.equal(await fs.readFile(path.join(directory, '样片.txt'), 'utf8'), text);
  assert.equal(await fs.readFile(path.join(unmatched, '用户文件.txt'), 'utf8'), '保持原样');
  assert.equal((await fs.lstat(symlink)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(source, 'utf8'), text);
});

