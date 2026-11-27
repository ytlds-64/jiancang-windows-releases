'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { maximumSegments, prepareVideoTrim, validateTrimRanges } = require('../video-trim.cjs');

const ffmpeg = process.env.JIANCANG_TEST_FFMPEG;
const ffprobe = process.env.JIANCANG_TEST_FFPROBE;
const executableTest = { skip: !ffmpeg || !ffprobe };

async function videoFixture(testContext) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-video-test-'));
  testContext.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, '色彩和音轨.mp4');
  const tempRoot = path.join(directory, 'staging');
  await fs.mkdir(tempRoot);
  execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', "color=c=red:s=100x160:r=25:d=1",
    '-f', 'lavfi', '-i', "color=c=blue:s=100x160:r=25:d=1", '-f', 'lavfi', '-i', 'sine=f=440:d=1',
    '-f', 'lavfi', '-i', 'sine=f=880:d=1',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a]concat=n=2:v=0:a=1[a]', '-map', '[v]', '-map', '[a]',
    '-c:v', 'mpeg4', '-g', '200', '-c:a', 'aac', source], { windowsHide: true });
  const original = await fs.readFile(source);
  const options = { ffmpeg, ffprobe, extension: 'mp4', tempRoot, expectedBytes: original.length,
    expectedSha256: createHash('sha256').update(original).digest('hex'), openSource: () => fs.open(source, 'r') };
  return { directory, tempRoot, source, original, options };
}

function readFirstPixel(file, seconds = 0) {
  return execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1',
    '-an', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']).subarray(0, 3);
}

function countPositiveCrossings(file, seconds) {
  const audio = execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-ss', String(seconds), '-i', file, '-t', '0.2',
    '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1']);
  let count = 0;
  for (let offset = 2; offset < audio.length; offset += 2) {
    if (audio.readInt16LE(offset - 2) <= 0 && audio.readInt16LE(offset) > 0) count += 1;
  }
  return count;
}

test('refuses oversize or invalid input before starting external tools', async () => {
  const tools = { ffmpeg: path.resolve('ffmpeg'), ffprobe: path.resolve('ffprobe') };
  const basic = { ...tools, openSource() { throw new Error('Should never open'); }, expectedBytes: 40 * 1024 ** 3 };
  await assert.rejects(prepareVideoTrim(basic), { code: 'VIDEO_LIMIT' });
  await assert.rejects(prepareVideoTrim({ ...basic, expectedBytes: 1, expectedSha256: '../../bad' }), { code: 'VIDEO_SOURCE_INTEGRITY' });
  await assert.rejects(prepareVideoTrim({ ...basic, ffmpeg: 'cmd', expectedBytes: 1 }), { code: 'VIDEO_TOOL_UNAVAILABLE' });
});

test('validates all requested segments and preserves their output order', () => {
  const selection = [{ start: 1.5, end: 2 }, { start: .1, end: .35 }];
  const { ranges, length } = validateTrimRanges({ segments: selection }, 2, 25);
  assert.deepEqual(ranges.map(range => range.start), [1.5, .1]);
  assert.ok(Math.abs(length - .75) < 1e-9);
  for (const segments of [null, [], [...selection, { start: 0, end: .04 }], [...selection, { start: 3, end: 4 }],
    Array.from({ length: maximumSegments + 1 }, () => selection[0])]) {
    assert.throws(() => validateTrimRanges({ segments }, 2, 25), { code: 'VIDEO_RANGE' });
  }
});

test('merges reordered clips as one video with matching audio and cleans up a cancelled export', executableTest, async t => {
  const { directory, original, options, source } = await videoFixture(t);
  const session = await prepareVideoTrim(options);
  t.after(session.close);
  const segments = [{ start: 1.12, end: 1.64 }, { start: .12, end: .64 }, { start: 1.68, end: 1.96 }];
  const target = path.join(directory, '多段顺序.webm');
  const controller = new AbortController();
  await assert.rejects(session.export({ segments, target, format: 'webm', signal: controller.signal, onProgress: ({ phase }) => {
    if (phase === 'encoding') controller.abort();
  } }), { name: 'AbortError' });
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  assert.ok(!(await fs.readdir(directory)).some(name => name.startsWith('.jiancang-video-')));

  const output = await session.export({ segments, target, format: 'webm' });
  assert.deepEqual([output.width, output.height, output.hasAudio], [100, 160, true]);
  assert.ok(Math.abs(output.duration - 1.32) < .08);
  const colors = [0, .72, 1.16].map(time => {
    const [red, , blue] = readFirstPixel(target, time);
    return blue > red ? 'blue' : 'red';
  });
  assert.deepEqual(colors, ['blue', 'red', 'blue']);
  const tones = [.12, .68].map(time => countPositiveCrossings(target, time));
  assert.ok(tones[0] > 130 && tones[1] > 55 && tones[0] > 1.7 * tones[1], `Unexpected tones: ${tones}`);

  const format = session.formats.includes('mp4') ? 'mp4' : 'webm';
  const muted = await session.export({ segments, format, muted: true, target: path.join(directory, `多段静音.${format}`) });
  assert.equal(muted.hasAudio, false);
  assert.ok(Math.abs(muted.duration - 1.32) < .08);
  assert.deepEqual(await fs.readFile(source), original);
});

test('retains silence in a selected range beyond the source audio track', executableTest, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-short-audio-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'short-audio.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=100x160:r=25:d=2',
    '-f', 'lavfi', '-i', 'sine=f=440:d=0.45', '-c:v', 'mpeg4', '-c:a', 'aac', source], { windowsHide: true });
  const session = await prepareVideoTrim({ ffmpeg, ffprobe, extension: 'mp4', tempRoot: directory,
    expectedBytes: (await fs.stat(source)).size, openSource: () => fs.open(source, 'r') });
  t.after(session.close);
  const segments = [{ start: 1.1, end: 1.6 }, { start: .1, end: .4 }];
  const result = await session.export({ segments, target: path.join(directory, 'output.webm'), format: 'webm' });
  assert.ok(result.hasAudio && Math.abs(result.duration - .8) < .08);
  assert.equal(countPositiveCrossings(result.file, .08), 0);
  assert.ok(countPositiveCrossings(result.file, .55) > 55);
});

test('cuts to a nonzero time, preserves orientation and audio, exports muted clips and caches a seekable preview', executableTest, async t => {
  const { directory, tempRoot, source, original, options } = await videoFixture(t);
  const progress = [];
  const session = await prepareVideoTrim({ ...options, onProgress: message => progress.push(message) });
  t.after(session.close);
  assert.deepEqual([session.duration, session.width, session.height, session.hasAudio, session.frameRate], [2, 100, 160, true, 25]);
  assert.ok(session.formats.includes('webm'));
  assert.ok(session.previewAvailable);
  const preview = await session.makePreview();
  assert.deepEqual([preview.width, preview.height, preview.hasAudio], [100, 160, true]);
  assert.ok(Math.abs(preview.duration - 2) < .12);
  assert.deepEqual(await session.makePreview(), preview);

  const target = path.join(directory, '向后裁切.webm');
  const kept = await session.export({ start: 1.135, end: 1.735, target, format: 'webm', resolution: '720',
    onProgress: message => progress.push(message) });
  assert.deepEqual([kept.file, kept.format, kept.width, kept.height, kept.hasAudio], [target, 'webm', 100, 160, true]);
  assert.ok(Math.abs(kept.duration - .6) < .11);
  const [red, green, blue] = readFirstPixel(target);
  assert.ok(blue > 200 && red < 30 && green < 30, 'First frame must come from the blue section of the source');

  if (session.formats.includes('mp4')) {
    const muted = await session.export({ start: .12, end: .82, target: path.join(directory, '静音.mp4'), format: 'mp4', muted: true });
    assert.equal(muted.hasAudio, false);
    assert.ok(Math.abs(muted.duration - .7) <= .07);
    const [first, , third] = readFirstPixel(muted.file);
    assert.ok(first > 200 && third < 30);
  }
  for (const phase of ['preparing', 'probing', 'encoding', 'saving']) {
    assert.ok(progress.some(message => message.phase === phase && message.progress === 1));
  }
  assert.deepEqual(await fs.readFile(source), original);
  await session.close();
  assert.deepEqual(await fs.readdir(tempRoot), []);
  assert.ok((await fs.stat(target)).size > 0);
});

test('refuses stale digests, out-of-range times, library destinations, and overwrite, and removes cancelled work', executableTest, async t => {
  const { directory, tempRoot, original, options } = await videoFixture(t);
  await assert.rejects(prepareVideoTrim({ ...options, expectedSha256: '0'.repeat(64) }), { code: 'VIDEO_SOURCE_INTEGRITY' });
  assert.deepEqual(await fs.readdir(tempRoot), []);
  const earlyAbort = new AbortController();
  await assert.rejects(prepareVideoTrim({ ...options, signal: earlyAbort.signal, onProgress: () => earlyAbort.abort() }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(tempRoot), []);
  const session = await prepareVideoTrim(options);
  t.after(session.close);
  const target = path.join(directory, '裁切.webm');
  const valid = { start: .2, end: 1.7, target, format: 'webm' };
  await assert.rejects(session.export({ ...valid, end: 3 }), { code: 'VIDEO_RANGE' });
  await assert.rejects(session.export({ ...valid, protectedRoots: [directory] }), /请选择素材库以外/);
  await fs.writeFile(target, original);
  await assert.rejects(session.export(valid), { code: 'VIDEO_SAME_NAME' });
  assert.deepEqual(await fs.readFile(target), original);
  await fs.unlink(target);

  const controller = new AbortController();
  await assert.rejects(session.export({ ...valid, signal: controller.signal, onProgress: ({ phase, progress }) => {
    if (phase === 'encoding' && progress > 0) controller.abort();
  } }), { name: 'AbortError' });
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  assert.ok(!(await fs.readdir(directory)).some(name => name.startsWith('.jiancang-video-')));
  assert.equal((await session.export(valid)).file, target);
});

test('caps an over-4K portrait at 2160 × 3840 and keeps its orientation', executableTest, async t => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jiancang-video-4k-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, '输入.mp4');
  const target = path.join(directory, '选段.webm');
  execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=2304x4096:r=10:d=0.2',
    '-c:v', 'mpeg4', '-threads', '2', input], { windowsHide: true });
  const expectedBytes = (await fs.stat(input)).size;
  const session = await prepareVideoTrim({ ffmpeg, ffprobe, extension: 'mp4', tempRoot: directory, expectedBytes,
    openSource: () => fs.open(input, 'r') });
  t.after(session.close);
  assert.deepEqual([session.width, session.height], [2304, 4096]);
  const output = await session.export({ start: 0, end: session.duration, target, format: 'webm', quality: 'small' });
  assert.deepEqual([output.width, output.height], [2160, 3840]);
});
