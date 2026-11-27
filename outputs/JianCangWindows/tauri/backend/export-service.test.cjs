'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { PNG } = require('../../vendor/ocr/node_modules/pngjs');
const { importLocalAsset } = require('../../local-library.cjs');
const { imageDimensions } = require('../../image-dimensions.cjs');
const { LibraryService } = require('./library-service.cjs');
const { ExportService } = require('./export-service.cjs');

async function fixture(t) {
  const work = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-export-service-'));
  const library = new LibraryService(path.join(work, 'profile'));
  const exporter = new ExportService(library);
  t.after(async () => {
    await exporter.close();
    await library.close();
    await fs.rm(work, { recursive: true, force: true });
  });
  await library.initialize();
  const catalog = await library.command('local:create', ['样本库', work]);
  const registrationId = catalog.activeLibraryId;
  const entry = library.entry(registrationId);
  const collection = await library.command('local:mutate', [registrationId, { action: 'createCollection', name: '构图' }]);
  const width = 128;
  const height = 64;
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const opaque = offset >= image.data.length / 2;
    image.data.set(opaque ? [0, 35, 220, 255] : [32, 192, 0, 0], offset);
  }
  const bytes = PNG.sync.write(image);
  const { id } = await importLocalAsset(entry.root, { expectedLibraryId: entry.libraryId, jobId: 'test-still',
    filename: '样本.png', bytes, width, height, tags: ['回归'], collectionIds: [collection.id] });
  const video = await importLocalAsset(entry.root, { expectedLibraryId: entry.libraryId, jobId: 'test-video',
    filename: '测试视频.mp4', bytes: Buffer.from('000000146674797069736f6d0000020069736f6d', 'hex'), kind: 'video' });
  await library.command('library:refresh', [registrationId]);
  const destination = path.join(work, 'saved');
  await fs.mkdir(destination);
  return { library, exporter, work, destination, root: entry.root, bytes, reference: { id, registrationId },
    video: { id: video.id, registrationId } };
}

test('exports originals and metadata with collision-safe names and stamped directory grants', async t => {
  const { library, exporter, root, bytes, reference, destination } = await fixture(t);
  await assert.rejects(exporter.command('structured-export:choose', [root]), /素材库以外/);
  const occupied = path.join(destination, '样本.png');
  await fs.writeFile(occupied, 'existing');
  const batch = await exporter.command('assets:export-batch', [[reference, { ...reference, id: 'a'.repeat(64) }], destination]);
  assert.equal(batch.written, 1);
  assert.equal(batch.failed.length, 1);
  assert.equal(await fs.readFile(occupied, 'utf8'), 'existing');
  assert.deepEqual(await fs.readFile(path.join(destination, '样本 (2).png')), bytes);

  const choice = await exporter.command('structured-export:choose', [destination]);
  const options = { layout: 'collections', includeMetadata: true };
  const plan = await exporter.command('structured-export:plan', [[reference], options, true]);
  assert.equal(plan.examples[0].folder, '样本库/构图');
  const result = await exporter.command('structured-export:start', [[reference], options, choice.token]);
  assert.equal(result.written, 1);
  assert.deepEqual(result.failedReferences, []);
  assert.deepEqual(await fs.readFile(path.join(result.directory, '样本库', '构图', '样本.png')), bytes);
  const csv = await fs.readFile(path.join(result.directory, result.manifest), 'utf8');
  assert.match(csv, /回归/u);
  assert.match(csv, /样本库\/构图\/样本\.png/u);
  await fs.rename(destination, destination + '-previous');
  await fs.mkdir(destination);
  await assert.rejects(exporter.command('structured-export:start', [[reference], options, choice.token]), /已移动/);
  assert.deepEqual(await fs.readdir(destination), []);
  assert.equal((await library.command('library:state', [])).library.assets.length, 2);
});

test('persists a daily backup plan, catches up one missed run after restart, and restores its chosen snapshot', async t => {
  const { library, exporter, root, reference, destination } = await fixture(t);
  const id = reference.registrationId;
  const command = (name, ...args) => exporter.command(`local-backup:${name}`, args);
  await exporter.initialize();
  assert.equal(command('plan', id).plan, null);
  await assert.rejects(command('configure', id, { enabled: true, time: '02:00' }, root), /素材库和备份文件夹之外/);
  const { plan } = await command('configure', id, { enabled: true, time: '02:00' }, destination);
  assert.equal(plan.time, '02:00');
  assert.ok(plan.nextAt > Date.now());
  assert.equal(new Date(plan.nextAt).getHours(), 2);
  const pending = command('run', id);
  assert.equal(command('plan', id).running, true);
  assert.throws(() => command('run', id), /正在进行/);
  const first = await pending;
  assert.equal(first.unchanged, false);
  const { plan: completed } = command('plan', id);
  assert.equal(completed.last.state, 'complete');
  await exporter.close();

  // Record a missed deadline and start a new service with the same local profile.
  const schedulePath = path.join(library.profile, 'local-backup-plans.json');
  const saved = JSON.parse(await fs.readFile(schedulePath, 'utf8'));
  saved.plans[0].nextAt = Date.now() - 1000;
  await fs.writeFile(schedulePath, JSON.stringify(saved));
  const restarted = new ExportService(library);
  t.after(() => restarted.close());
  const afterRestart = (name, ...args) => restarted.command(`local-backup:${name}`, args);
  await restarted.initialize();
  for (let attempt = 0; attempt < 80 && afterRestart('plan', id).plan.last.state !== 'unchanged'; attempt++) await delay(25);
  const { plan: caughtUp, running } = afterRestart('plan', id);
  assert.equal(running, false);
  assert.equal(caughtUp.last.state, 'unchanged');
  assert.ok(caughtUp.nextAt > Date.now());

  const group = await afterRestart('snapshots', first.directory);
  assert.deepEqual(group.snapshots, [first.snapshot]);
  assert.throws(() => afterRestart('restore-snapshot', '快照恢复库', 'wrong-token', first.snapshot.id, destination), /重新选择/);
  const restored = await afterRestart('restore-snapshot', '快照恢复库', group.token, first.snapshot.id, destination);
  assert.ok(restored.registrationId);
  assert.notEqual(restored.libraryId, plan.libraryId);
  assert.ok(restored.state.libraries.some(entry => entry.libraryId === restored.libraryId));
  const disabled = await afterRestart('configure', id, { enabled: false, time: '23:30' });
  assert.equal(disabled.plan.nextAt, null);
  assert.equal(disabled.plan.directory, first.directory);
});

test('round-trips board project, stages a PNG in chunks and publishes protected marker exports', async t => {
  const { exporter, root, bytes, reference, video, destination } = await fixture(t);
  const entries = [{ ...reference, title: '构图', source: '样本库', note: '保留原来顺序' }];
  const payload = { name: '对照板', format: 'jiancangboard', entries };
  const { defaultName } = exporter.command('board:export-name', [payload]);
  await assert.rejects(exporter.command('board:export', [payload, path.join(root, defaultName)]), /素材库以外/);
  const projectFile = path.join(destination, defaultName);
  assert.equal((await exporter.command('board:export', [payload, projectFile])).ok, true);
  assert.equal((await exporter.command('board:import-project', [projectFile])).project.entries[0].note, entries[0].note);
  await assert.rejects(exporter.command('board:export', [payload, projectFile]), /同名/);

  const { token } = exporter.command('board:export-begin', ['png']);
  assert.throws(() => exporter.command('board:export-append', ['wrong', 0, 'Ag==']), /过期/);
  assert.throws(() => exporter.command('board:export-append', [token, 1, 'Ag==']), /读取/);
  for (const part of [bytes.subarray(0, 24), bytes.subarray(24)]) {
    exporter.command('board:export-append', [token, 0, part.toString('base64')]);
  }
  await exporter.command('board:export', [{ format: 'png', name: payload.name, uploadToken: token }, path.join(destination, '长图')]);
  assert.deepEqual(await fs.readFile(path.join(destination, '长图.png')), bytes);
  assert.throws(() => exporter.command('board:export-append', [token, 0, 'Ag==']), /过期/);

  const notes = { ...video, format: 'srt', duration: 5, notes: [{ seconds: 1, text: '标记' }] };
  const markers = exporter.command('asset:save-markers-name', [notes]);
  assert.equal(markers.extension, 'srt');
  await exporter.command('asset:save-markers', [notes, path.join(destination, markers.defaultName)]);
  assert.match(await fs.readFile(path.join(destination, markers.defaultName), 'utf8'), /00:00:01,000 --> 00:00:04,000\r\n标记/u);
});

const ffmpeg = process.env.JIANCANG_TEST_FFMPEG;
test('converts three formats without upscaling and keeps transparent pixels or fills them white', { skip: !ffmpeg }, async t => {
  const { library, exporter, reference, destination } = await fixture(t);
  library.ffmpeg = ffmpeg;
  const { token } = await exporter.command('structured-export:choose', [destination]);
  for (const format of ['png', 'jpeg', 'webp']) {
    const expected = format === 'webp' ? [128, 64] : [64, 32];
    const result = await exporter.command('image-conversion:start', [[reference], { format, maximumSide: format === 'webp' ? 2048 : 64,
      quality: 90 }, token]);
    assert.equal(result.written, 1, result.failed[0]?.message);
    const file = path.join(destination, `样本.${format === 'jpeg' ? 'jpg' : format}`);
    const bytes = await fs.readFile(file);
    assert.deepEqual(imageDimensions(bytes), expected);
    if (format === 'png') assert.equal(PNG.sync.read(bytes).data[3], 0);
    if (format === 'jpeg') {
      const raw = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file,
        '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
      assert.ok(raw.subarray(0, 3).every(value => value >= 245));
      const upload = exporter.command('board:export-begin', ['pdf']);
      exporter.command('board:export-append', [upload.token, 0, bytes.toString('base64')]);
      await exporter.command('board:export', [{ format: 'pdf', name: '对照板', uploadToken: upload.token,
        pages: [{ width: 64, height: 32 }] }, path.join(destination, '对照板.pdf')]);
      assert.equal((await fs.readFile(path.join(destination, '对照板.pdf'))).subarray(0, 8).toString(), '%PDF-1.4');
    }
  }
});
