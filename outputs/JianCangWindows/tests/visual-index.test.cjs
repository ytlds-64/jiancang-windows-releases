'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: sleep } = require('node:timers/promises');
const { PNG } = require('../vendor/ocr/node_modules/pngjs');
const { VisualIndex } = require('../visual-index.cjs');

function image(color, { width = 96, height = 72, shade = 0, layout = 0 } = {}) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = layout ? (x > width * 0.20 && x < width * 0.47 && y > height * 0.23 && y < height * 0.65) : false;
      const point = (y * width + x) * 4;
      const channels = inside ? [30, 50, 110, 255] : color;
      png.data.set(channels.map((value, index) => index === 3 ? value : Math.max(0, Math.min(255, value + shade))), point);
    }
  }
  return PNG.sync.write(png);
}

function reference(number, extra = {}) {
  return { registrationId: 'abba', assetId: number.toString(16).padStart(64, '0'), revision: 'first', ...extra };
}

async function fixture(t, options) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-index-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const index = new VisualIndex({ directory, ...options });
  await index.initialize();
  return { index, directory };
}

async function complete(index) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const status = index.status();
    if (status?.status !== 'running') return status;
    await sleep(10);
  }
  assert.fail('Timed out waiting for visual indexing.');
}

test('primary color and cached results remain scoped to source, ID and unchanged media revision', async t => {
  let opened = 0;
  const getImage = async () => {
    opened++;
    return image([210, 69, 35, 255], { layout: 1 });
  };
  const ref = reference(1);
  const twin = { ...ref, registrationId: 'feeb' };
  const revised = { ...ref, revision: 'second' };
  const { index, directory } = await fixture(t, { getImage });
  try {
    index.start([ref, ref]);
    assert.equal((await complete(index)).indexed, 1);
    const [result] = index.lookup([ref, twin, revised]);
    assert.equal(result.primaryColor, '#d24523');
    assert.deepEqual(result.palette, ['#d24523', '#1e326e']);
    assert.equal(result.ocrStatus, 'none');
    assert.equal(index.lookup([twin, revised]).length, 0);
  } finally { await index.close(); }

  const reopened = new VisualIndex({ directory, getImage });
  await reopened.initialize();
  try {
    reopened.start([ref]);
    assert.equal((await complete(reopened)).skipped, 1);
    assert.equal(opened, 1);
    reopened.start([revised, twin]);
    assert.equal((await complete(reopened)).indexed, 2);
    assert.equal(reopened.lookup([ref]).length, 0);
    assert.equal(reopened.lookup([revised, twin]).length, 2);
  } finally { await reopened.close(); }
});

test('similarity ranks exact originals and keeps visually different solid colors out of the results', async t => {
  const exactHash = 'a'.repeat(64);
  const red = reference(2, { contentHash: exactHash });
  const sameRaw = reference(3, { contentHash: exactHash });
  const resized = reference(4);
  const similarRed = reference(5);
  const blue = reference(6);
  const refs = [red, sameRaw, resized, similarRed, blue];
  const bytes = [image([218, 44, 61, 255]), image([218, 44, 61, 255]), image([218, 44, 61, 255], { width: 64, height: 48 }),
    image([218, 44, 61, 255], { shade: -4 }), image([35, 72, 220, 255])];
  const inputs = new Map(refs.map((ref, index) => [ref.assetId, bytes[index]]));
  const { index } = await fixture(t, { getImage: async ref => inputs.get(ref.assetId) });
  try {
    index.start(refs);
    assert.equal((await complete(index)).indexed, 5);
    const matches = index.similar(red, refs, { threshold: 12 });
    assert.equal(matches[0].assetId, sameRaw.assetId);
    assert.equal(matches[0].exact, true);
    assert.equal(matches[0].score, 1);
    assert.ok(matches.some(match => match.assetId === resized.assetId));
    assert.ok(matches.some(match => match.assetId === similarRed.assetId));
    assert.ok(!matches.some(match => match.assetId === blue.assetId));
    assert.deepEqual(index.similar(red, refs, { exactOnly: true }).map(match => match.assetId), [sameRaw.assetId]);
  } finally { await index.close(); }
});

test('interrupted and failed image scans preserve completed updates and can be retried per revision', async t => {
  const first = reference(7);
  const blocked = reference(8);
  const rest = reference(9);
  let canRead = false;
  const { index } = await fixture(t, { getImage: async (ref, { signal }) => {
    if (ref.assetId === blocked.assetId && !canRead) {
      await sleep(5_000, undefined, { signal });
      throw new Error('unreachable');
    }
    return ref.assetId === rest.assetId && !canRead ? Buffer.alloc(15) : image([32, 80, 128, 255]);
  } });
  try {
    const { jobId } = index.start([first, blocked, rest]);
    while (index.status().processed === 0) await sleep(5);
    index.cancel(jobId);
    assert.equal((await complete(index)).status, 'cancelled');
    assert.equal(index.lookup([first, blocked]).length, 1);
    index.start([first, rest]);
    assert.equal((await complete(index)).failed, 1);
    assert.equal(index.lookup([rest]).length, 0);
    canRead = true;
    index.start([first, blocked, rest]);
    const rerun = await complete(index);
    assert.equal(rerun.skipped, 1);
    assert.equal(rerun.indexed, 2);
  } finally { await index.close(); }
});

test('skips known raster failures after restart until the media, input availability or retry changes', async t => {
  const refs = [10, 11, 12].map(number => reference(number, { inputState: 'original' }));
  let readable = false;
  let attempts = 0;
  const getImage = async () => {
    attempts++;
    return readable ? image([32, 80, 128, 255]) : Buffer.alloc(15);
  };
  const { index, directory } = await fixture(t, { getImage });
  try {
    index.start(refs, { retryFailures: false });
    assert.equal((await complete(index)).failed, 3);
    assert.deepEqual(index.lookup(refs), []);
  } finally { await index.close(); }

  readable = true;
  const reopened = new VisualIndex({ directory, getImage });
  await reopened.initialize();
  try {
    assert.equal(reopened.lookup(refs, { includeFailures: true }).filter(row => row.analysisStatus === 'failed').length, 3);
    reopened.start(refs, { retryFailures: false });
    const skipped = await complete(reopened);
    assert.equal(skipped.skipped, 3);
    assert.equal(skipped.failed, 0);
    assert.equal(attempts, 3);

    const changed = [{ ...refs[0], inputState: 'thumbnail' }, { ...refs[1], revision: 'second' }];
    assert.deepEqual(reopened.lookup(changed, { includeFailures: true }), []);
    reopened.start(changed, { retryFailures: false });
    assert.equal((await complete(reopened)).indexed, 2);
    reopened.start([refs[2]], { retryFailures: true });
    assert.equal((await complete(reopened)).indexed, 1);
    assert.equal(attempts, 6);
    const recovered = reopened.lookup([...changed, refs[2]], { includeFailures: true });
    assert.equal(recovered.length, 3);
    assert.ok(recovered.every(row => row.primaryColor === '#205080' && !row.analysisStatus));
  } finally { await reopened.close(); }
});

test('cached OCR errors do not destroy color or automatically retry recognition', async t => {
  const ref = reference(13);
  let recognitionAttempts = 0;
  const { index } = await fixture(t, { getImage: async (_reference, { ocr }) => {
    if (!ocr) return image([32, 80, 128, 255]);
    recognitionAttempts++;
    return Buffer.alloc(15);
  } });
  try {
    index.start([ref], { ocr: true, retryFailures: false });
    assert.equal((await complete(index)).ocrFailed, 1);
    const [record] = index.lookup([ref], { includeFailures: true });
    assert.equal(record.primaryColor, '#205080');
    assert.equal(record.ocrStatus, 'failed');
    index.start([ref], { ocr: true, retryFailures: false });
    assert.equal((await complete(index)).skipped, 1);
    assert.equal(recognitionAttempts, 1);
    index.start([ref], { ocr: true, retryFailures: true });
    assert.equal((await complete(index)).ocrFailed, 1);
    assert.equal(recognitionAttempts, 2);
    assert.deepEqual(index.lookup([ref], { includeFailures: true }), [record]);
  } finally { await index.close(); }
});
