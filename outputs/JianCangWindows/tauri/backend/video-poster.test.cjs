'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { folderIdentity } = require('../../library-watcher.cjs');
const { canGenerateThumbnail, mediaHandler } = require('./media.cjs');

const ffmpeg = process.env.JIANCANG_TEST_FFMPEG || process.env.JIANCANG_FFMPEG_PATH;

test('a large available MP4 can request a poster', () => {
  const asset = { byteCount: 3.5 * 1024 ** 3, extension: 'mp4', kind: 'video', available: true };
  assert.ok(canGenerateThumbnail(asset, 'ffmpeg'));
  assert.equal(canGenerateThumbnail({ ...asset, available: false }, 'ffmpeg'), false);
  assert.equal(canGenerateThumbnail({ ...asset, extension: 'png', kind: 'image' }, 'ffmpeg'), false);
});

async function posterFixture(t, blackFrames, redFrame, duration) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-poster-test-')));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const originals = path.join(temp, 'originals');
  const file = path.join(originals, 'fixture.mp4');
  await fs.mkdir(originals);
  // Every undecorated frame is blue so the tests distinguish an exact
  // frame from any earlier, later, or merely nonblack frame.
  const fill = (color, frames) => `drawbox=x=0:y=0:w=iw:h=ih:color=${color}:t=fill:enable='${
    frames.map(frame => `eq(n,${frame})`).join('+')}'`;
  const filters = [];
  if (blackFrames.length) filters.push(fill('black', blackFrames));
  if (redFrame !== null) filters.push(fill('red', [redFrame]));
  execFileSync(ffmpeg, ['-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=12:d=10', '-vf', filters.join(','),
    '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { windowsHide: true });
  const asset = { id: 'fixture', extension: 'mp4', kind: 'video', available: true,
    duration, byteCount: (await fs.stat(file)).size };
  const library = { root: temp, registrationId: 'local', publicLibrary: { kind: 'local', libraryId: 'test' },
    identity: folderIdentity(await fs.lstat(temp, { bigint: true })) };
  const signal = new AbortController().signal;
  const service = {
    profile: path.join(temp, 'profile'), ffmpeg, shutdown: { signal },
    asset: () => ({ asset, library, file }),
    importThumbnailSource: () => ({ assetId: asset.id, name: path.basename(file), path: file, root: temp,
      open: () => fs.open(file, 'r') }),
  };
  const handler = mediaHandler(service);
  async function thumbnail(serve = handler, pending = false) {
    let status, headers, bytes;
    const response = {
      writeHead(code, values) { status = code; headers = values; },
      end(buffer) { bytes = buffer; },
    };
    const request = { headers: {}, method: 'GET' };
    if (pending) await serve.importThumbnail(request, response, 'local', 'pending', signal);
    else await serve(request, response, 'thumbnail', 'local', asset.id, signal);
    assert.equal(status, 200);
    assert.equal(headers['Content-Type'], 'image/jpeg');
    return bytes;
  }
  return { thumbnail, cachedThumbnail: () => thumbnail(mediaHandler({ ...service, ffmpeg: path.join(temp, 'no-decoder') })),
    pendingThumbnail: () => thumbnail(handler, true) };
}

function assertPosterColor(bytes, color) {
  const pixel = execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-i', 'pipe:0', '-vf', 'scale=1:1',
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: bytes, windowsHide: true });
  assert.equal(pixel.length, 3);
  assert.ok((color === 'red' ? pixel[0] > 200 : pixel[0] < 45) && pixel[1] < 45 && pixel[2] < 45,
    `Expected ${color}, got ${[...pixel]}`);
}

test('a nonblack first frame is kept even when the very next frame differs', { skip: !ffmpeg }, async t => {
  const { thumbnail, cachedThumbnail } = await posterFixture(t, [], 0, 10);
  const [grid, details] = await Promise.all([thumbnail(), thumbnail()]);
  assert.deepEqual(grid, details);
  assert.deepEqual(grid, await cachedThumbnail());
  assertPosterColor(grid, 'red');
});

test('a black opening frame selects the exact midpoint from a known duration', { skip: !ffmpeg }, async t => {
  const { thumbnail } = await posterFixture(t, [0], 60, 10);
  assertPosterColor(await thumbnail(), 'red');
});

test('a black opening frame selects the exact midpoint even if that frame is black', { skip: !ffmpeg }, async t => {
  const { thumbnail } = await posterFixture(t, [0, 60], null, 10);
  assertPosterColor(await thumbnail(), 'black');
});

test('missing catalog duration and pending imports both use the midpoint from the video header', { skip: !ffmpeg }, async t => {
  const { thumbnail, pendingThumbnail } = await posterFixture(t, [0], 60, null);
  assertPosterColor(await thumbnail(), 'red');
  assertPosterColor(await pendingThumbnail(), 'red');
});
