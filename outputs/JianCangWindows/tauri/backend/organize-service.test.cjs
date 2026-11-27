'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { setTimeout: wait } = require('node:timers/promises');
const { LibraryService } = require('./library-service.cjs');
const { OrganizeService } = require('./organize-service.cjs');
const { VisualService } = require('./visual-service.cjs');
const { PNG } = require('../../vendor/ocr/node_modules/pngjs');

const png = PNG.sync.write({ width: 4, height: 3, data: Buffer.alloc(48, 255) });

async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-organizer-')));
  const profile = path.join(temporary, 'profile');
  const library = new LibraryService(profile);
  const visual = new VisualService(library);
  const organizer = new OrganizeService(library, visual, { pollMs: 0, quietMs: 0 });
  t.after(async () => {
    await organizer.close();
    await visual.close();
    await library.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await library.initialize();
  await organizer.initialize();
  const state = await library.command('local:create', ['测试库', temporary]);
  const id = state.activeLibraryId;
  return { temporary, library, visual, organizer, id };
}

async function pending(read) {
  const deadline = Date.now() + 7000;
  for (;;) {
    const complete = await read();
    if (complete) return complete;
    assert.ok(Date.now() < deadline, '整理或导入未在时限内完成。');
    await wait(40);
  }
}

function reference(asset, registrationId) {
  return { registrationId, assetId: asset.id,
    revision: JSON.stringify([asset.mediaRevision || asset.id, asset.byteCount, asset.width, asset.height]) };
}

async function importCopies({ temporary, library, id }) {
  const files = ['主图.png', '副本.png'].map(name => path.join(temporary, name));
  await Promise.all(files.map(file => fs.writeFile(file, png)));
  assert.equal((await library.command('local-import:choose', [id, null, files])).queued, 2);
  return pending(async () => {
    const state = await library.command('library:state', []);
    return state.library.assets.length === 2 && state.library.assets;
  });
}

async function scan(organizer, references, mode = 'exact') {
  const { jobId } = await organizer.command('duplicates:start', [references, mode]);
  return pending(() => {
    const status = organizer.command('duplicates:status');
    assert.equal(status.jobId, jobId);
    return status.status === 'completed' && status;
  });
}

test('Tauri duplicates preview an atomic tag and collection merge, reject a stale preview, and undo', async t => {
  const setup = await fixture(t);
  const { library, organizer, id } = setup;
  const assets = await importCopies(setup);
  const keeper = assets.find(asset => asset.name === '主图');
  const copy = assets.find(asset => asset.name === '副本');
  assert.ok(keeper && copy);
  const { id: parent } = await library.command('local:mutate', [id, { action: 'createCollection', name: '根集合' }]);
  const { id: child } = await library.command('local:mutate', [id, { action: 'createCollection', name: '分类', parentId: parent }]);
  await library.command('local:mutate', [id, { action: 'edit', ids: [keeper.id], tags: ['保留'] }]);
  await library.command('local:mutate', [id, { action: 'edit', ids: [copy.id], tags: ['保留', '新增'], collectionIds: [child] }]);
  const keeperRef = reference(keeper, id);
  const duplicateRef = reference(copy, id);
  const result = await scan(organizer, [keeperRef, duplicateRef]);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].kind, 'same-original');
  assert.equal(organizer.duplicateProgress().groups, undefined);
  const command = { jobId: result.jobId, groupId: result.groups[0].id, keeper: keeperRef, selected: [duplicateRef] };
  let preview = await organizer.command('duplicates:preview-merge', [command]);
  assert.deepEqual(preview.addedTags, ['新增']);
  assert.deepEqual(preview.addedCollections, ['根集合 / 分类']);
  await library.command('local:mutate', [id, { action: 'edit', ids: [keeper.id], note: '确认后修改了备注' }]);
  await assert.rejects(organizer.command('duplicates:merge', [{ ...command, revision: preview.revision }]), /重新预览/);
  assert.equal(library.asset(copy.id, id).asset.trashed, false);

  preview = await organizer.command('duplicates:preview-merge', [command]);
  const merged = await organizer.command('duplicates:merge', [{ ...command, revision: preview.revision }]);
  assert.equal(merged.moved.length, 1);
  assert.equal(merged.state.library.assets.find(asset => asset.id === copy.id).trashed, true);
  assert.deepEqual(library.asset(keeper.id, id).asset.tags, ['保留', '新增']);
  assert.deepEqual(library.asset(keeper.id, id).asset.collectionIds, [child]);
  assert.equal(organizer.command('duplicates:status').groups.length, 0);
  assert.equal((await library.command('local:mutate', [id, { action: 'undo' }])).undone, true);
  assert.equal(library.asset(copy.id, id).asset.trashed, false);
  assert.deepEqual(library.asset(keeper.id, id).asset.tags, ['保留']);

  const rescanned = await scan(organizer, [keeperRef, duplicateRef]);
  await fs.unlink(library.original(keeper.id, id).file);
  await assert.rejects(organizer.command('duplicates:trash', [{ jobId: rescanned.jobId, groupId: rescanned.groups[0].id,
    selected: [duplicateRef] }]), /至少需要保留一份/);
  assert.equal(library.asset(copy.id, id).asset.trashed, false);
});

test('Tauri monitored folder uses the native path, guards stable versions, and restores the watch ledger', async t => {
  const { temporary, library, organizer, id } = await fixture(t);
  const inbox = path.join(temporary, '收件');
  const watched = path.join(inbox, '素材.txt');
  await fs.mkdir(inbox);
  await fs.writeFile(watched, '旧文件');
  const settings = { targetId: id, includeExisting: false };
  await assert.rejects(organizer.command('inbox:add', [{ ...settings, sourcePath: inbox }]), /请选择监控文件夹/);
  await assert.rejects(organizer.command('inbox:add', [settings, temporary]), /与素材库或应用数据目录分开/);
  const { id: watchId } = await organizer.command('inbox:add', [settings, inbox]);
  assert.ok(organizer.inboxRevision > 0);
  assert.equal((await organizer.command('inbox:scan', [watchId])).queued, 0);
  await library.command('local-import:set-paused', [id, true]);
  await fs.writeFile(watched, '暂存件');
  assert.equal((await organizer.command('inbox:scan', [watchId])).waiting, 1);
  assert.equal((await organizer.command('inbox:scan', [watchId])).queued, 1);
  await fs.writeFile(watched, '新文件');
  await library.command('local-import:set-paused', [id, false]);
  const failed = await pending(async () => {
    const response = await library.command('local-import:list', [id, true]);
    return response.tasks.find(task => task.status === 'failed');
  });
  assert.match(failed.error, /发生了变化/);
  assert.equal(library.state().library.assets.length, 0);

  await organizer.command('inbox:scan', [watchId]);
  assert.equal((await organizer.command('inbox:scan', [watchId])).queued, 2);
  const asset = await pending(() => library.state().library.assets[0]);
  assert.equal(await fs.readFile(library.original(asset.id, id).file, 'utf8'), '新文件');
  await organizer.command('inbox:pause', [watchId, true]);
  await organizer.close();
  const restored = new OrganizeService(library, null, { pollMs: 0, quietMs: 0 });
  try {
    await restored.initialize();
    assert.equal(restored.command('inbox:list')[0].paused, true);
    assert.equal(restored.command('inbox:list')[0].sourcePath, inbox);
    await restored.command('inbox:pause', [watchId, false]);
    await restored.command('inbox:scan', [watchId]);
    assert.equal((await restored.command('inbox:scan', [watchId])).queued, 2);
    await restored.command('inbox:remove', [watchId]);
    assert.deepEqual(restored.command('inbox:list'), []);
    assert.equal(await fs.readFile(watched, 'utf8'), '新文件');
  } finally { await restored.close(); }
});

test('Tauri visual duplicate review produces a shared preview group using the local index',
  { skip: !process.env.JIANCANG_FFMPEG_PATH }, async t => {
    const setup = await fixture(t);
    await setup.visual.initialize();
    const assets = await importCopies(setup);
    const result = await scan(setup.organizer, assets.map(asset => reference(asset, setup.id)), 'visual');
    assert.equal(result.indexed, 2);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].kind, 'same-preview');
  });

test('Tauri indexes JPEG originals and Eagle thumbnail-only pictures without attempting missing files',
  { skip: !process.env.JIANCANG_FFMPEG_PATH }, async t => {
    const { temporary, library, visual, id } = await fixture(t);
    await visual.initialize();
    const source = path.join(temporary, '合成底图.png');
    const jpeg = path.join(temporary, '标准 JPEG.jpg');
    await fs.writeFile(source, png);
    await promisify(execFile)(library.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', source,
      '-vf', 'scale=64:64', '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2', '-update', '1', jpeg], { windowsHide: true });
    await library.command('local-import:choose', [id, null, [jpeg]]);
    const original = await pending(async () => (await library.command('library:state', [])).library.assets[0]);
    assert.equal(original.extension, 'jpg');

    const root = path.join(temporary, 'Test.library');
    const thumbnail = path.join(root, 'images', 'ITEM1.info');
    const missing = path.join(root, 'images', 'ITEM2.info');
    await Promise.all([thumbnail, missing].map(folder => fs.mkdir(folder, { recursive: true })));
    await fs.writeFile(path.join(root, 'metadata.json'), JSON.stringify({ id: 'visual', name: 'Eagle 测试', folders: [] }));
    await fs.writeFile(path.join(thumbnail, 'metadata.json'), JSON.stringify({ id: 'ITEM1', name: '封面', ext: 'jpg', width: 64, height: 64 }));
    await fs.writeFile(path.join(missing, 'metadata.json'), JSON.stringify({ id: 'ITEM2', name: '原件不在本机', ext: 'jpg' }));
    await fs.copyFile(jpeg, path.join(thumbnail, '封面_thumbnail.jpg'));
    const eagle = await library.command('library:choose', ['eagle', root]);
    const cover = eagle.library.assets.find(asset => asset.thumbnailAvailable);
    const skipped = eagle.library.assets.find(asset => !asset.thumbnailAvailable);
    assert.equal(cover.available, false);
    const references = [reference(original, id), reference(cover, eagle.activeLibraryId), reference(skipped, eagle.activeLibraryId)];
    const started = visual.command('visual:start', [references, false, false]);
    assert.equal(started.total, 2);
    const status = await pending(() => {
      const result = visual.command('visual:status', []);
      return result?.status !== 'running' && result;
    });
    assert.equal(status.status, 'completed');
    assert.equal(status.failed, 0);
    assert.equal(status.indexed, 2);
    assert.equal(visual.command('visual:lookup', [references]).length, 2);
  });
