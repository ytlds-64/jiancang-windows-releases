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

test('video poster uses a nonblack scene and caches the same frame for both surfaces', { skip: !ffmpeg }, async t => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-poster-test-')));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const originals = path.join(temp, 'originals');
  const file = path.join(originals, 'black-intro.mp4');
  await fs.mkdir(originals);
  execFileSync(ffmpeg, ['-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=black:s=160x90:r=12:d=3.5',
    '-f', 'lavfi', '-i', 'color=red:s=160x90:r=12:d=6.5',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { windowsHide: true });
  const asset = { id: 'fixture', extension: 'mp4', kind: 'video', available: true,
    duration: 10, byteCount: (await fs.stat(file)).size };
  const library = { root: temp, registrationId: 'local', publicLibrary: { kind: 'local', libraryId: 'test' },
    identity: folderIdentity(await fs.lstat(temp, { bigint: true })) };
  const signal = new AbortController().signal;
  const service = {
    profile: path.join(temp, 'profile'), ffmpeg, shutdown: { signal },
    asset: () => ({ asset, library, file }),
  };
  const serve = mediaHandler(service);
  async function thumbnail(handler) {
    let status, headers, bytes;
    const response = {
      writeHead(code, values) { status = code; headers = values; },
      end(buffer) { bytes = buffer; },
    };
    await handler({ headers: {}, method: 'GET' }, response, 'thumbnail', 'local', 'fixture', signal);
    assert.equal(status, 200);
    assert.equal(headers['Content-Type'], 'image/jpeg');
    return bytes;
  }
  const [grid, details] = await Promise.all([thumbnail(serve), thumbnail(serve)]);
  assert.deepEqual(grid, details);
  assert.deepEqual(grid, await thumbnail(mediaHandler(service)));
  const pixel = execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-i', 'pipe:0', '-vf', 'scale=1:1',
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: grid, windowsHide: true });
  assert.ok(pixel[0] > 200 && pixel[1] < 45 && pixel[2] < 45, `Expected the red scene, got ${[...pixel]}`);
});
