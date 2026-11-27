'use strict';

const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { once, EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { candidateManifestName, candidateReleaseFormat, manifestName, readManifest,
  releaseMessage, updateFileName } = require('../../windows-update.cjs');
const { UpdateService } = require('./update-service.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-tauri-update-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const folder = path.join(root, 'release');
  await fs.mkdir(folder);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const version = '0.36.28';
  const bytes = Buffer.alloc(192_000, 132);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const makeRelease = format => {
    const release = { format: 1, version, file: updateFileName(version, format), bytes: bytes.length, sha256 };
    return { ...release, signature: sign(null, releaseMessage(release, format), privateKey).toString('base64') };
  };
  const candidate = makeRelease(candidateReleaseFormat);
  const desktop = makeRelease();
  const writeManifest = (release = candidate) => fs.writeFile(path.join(folder, candidateManifestName), JSON.stringify(release));
  await writeManifest();
  await fs.writeFile(path.join(folder, candidate.file), bytes);
  await fs.writeFile(path.join(folder, manifestName), JSON.stringify(desktop));
  return { root, folder, candidate, desktop, publicKey, bytes, writeManifest };
}

test('checks only the separately signed candidate installer and preserves the channel', async t => {
  const { root, folder, candidate, desktop, publicKey, bytes, writeManifest } = await fixture(t);
  const profile = path.join(root, 'profile');
  const options = { version: '0.36.27', installed: true, publicKey, request: null };
  assert.throws(() => readManifest(JSON.stringify(candidate), publicKey), /格式/);
  const portable = new UpdateService(profile, { ...options, installed: false });
  await portable.initialize();
  assert.equal((await portable.command('windows-update:status')).installed, false);
  assert.equal((await portable.command('windows-update:choose-folder', [folder])).ok, false);
  portable.close();

  const first = new UpdateService(profile, options);
  await first.initialize();
  assert.equal(first.status().localOnly, true);
  assert.equal((await first.command('windows-update:set-channel', ['https://example.test/updates', false])).ok, false);
  assert.equal((await first.command('windows-update:choose-folder', [folder, false])).ok, true);
  first.close();

  const events = new EventEmitter();
  let handedOff;
  let installerClosed;
  const reopened = new UpdateService(profile, { ...options, onChange: event => events.emit(`update:${event.phase}`, event),
    async launch(file, descriptor) {
      assert.equal(path.basename(file), candidate.file);
      assert.deepEqual(await fs.readFile(file), bytes);
      assert.equal(descriptor.sha256, candidate.sha256);
      handedOff = file;
      return { completion: new Promise(resolve => { installerClosed = resolve; }) };
    } });
  t.after(() => reopened.close());
  await reopened.initialize();
  assert.deepEqual(reopened.status().source, { folder: await fs.realpath(folder) });
  assert.equal(reopened.status().automatic, false);
  await writeManifest(desktop);
  assert.match((await reopened.command('windows-update:check')).message, /格式/);
  await writeManifest({ ...candidate, signature: desktop.signature });
  assert.match((await reopened.command('windows-update:check')).message, /签名/);
  await writeManifest();
  assert.equal((await reopened.command('windows-update:check')).phase, 'available');
  await fs.writeFile(path.join(folder, candidate.file), Buffer.alloc(bytes.length));
  assert.equal((await reopened.command('windows-update:install')).phase, 'error');
  assert.equal(handedOff, undefined);
  await fs.writeFile(path.join(folder, candidate.file), bytes);
  assert.equal((await reopened.command('windows-update:install')).phase, 'launching');
  const readyAgain = once(events, 'update:available', { signal: AbortSignal.timeout(1000) });
  installerClosed(2);
  assert.equal((await readyAgain)[0].bytes, 0);
  await assert.rejects(fs.access(handedOff), { code: 'ENOENT' });
});

test('cancels a candidate transfer before opening the installer', async t => {
  const { root, folder, publicKey } = await fixture(t);
  let launched = false;
  const profile = path.join(root, 'profile');
  const service = new UpdateService(profile, { version: '0.36.27', installed: true, publicKey,
    async launch() { launched = true; } });
  t.after(() => service.close());
  await service.initialize();
  await service.command('windows-update:choose-folder', [folder, false]);
  assert.equal((await service.command('windows-update:check')).phase, 'available');
  const running = service.command('windows-update:install');
  await service.command('windows-update:cancel');
  const cancelled = await running;
  assert.deepEqual([cancelled.phase, cancelled.bytes, cancelled.bytesPerSecond], ['available', 0, 0]);
  assert.equal(launched, false);
  assert.deepEqual(await fs.readdir(path.join(profile, 'windows-tauri-updates')), ['channel.json']);
});

test('preserves candidate HTTPS partial download and manifest identity with injected transport', async t => {
  const { root, candidate, publicKey, bytes } = await fixture(t);
  const folder = 'https://example.test/updates/';
  const offset = 52_000;
  const ranges = [];
  const options = { version: '0.36.27', installed: true, publicKey,
    async request(endpoint, { headers }) {
      if (endpoint.href === folder + candidateManifestName) return Response.json(candidate);
      assert.equal(endpoint.href, folder + candidate.file);
      ranges.push(headers?.Range);
      if (ranges.length === 1) return new Response(bytes.subarray(0, offset));
      return new Response(bytes.subarray(offset), { status: 206, headers: {
        'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}`,
      } });
    },
    async launch(file) { assert.deepEqual(await fs.readFile(file), bytes); } };
  const profile = path.join(root, 'profile');
  const initial = new UpdateService(profile, options);
  await initial.initialize();
  await initial.command('windows-update:set-channel', [folder, false]);
  assert.equal((await initial.command('windows-update:check')).phase, 'available');
  const interrupted = await initial.command('windows-update:install');
  assert.deepEqual([interrupted.phase, interrupted.bytes], ['error', offset]);
  initial.close();

  const service = new UpdateService(profile, options);
  t.after(() => service.close());
  await service.initialize();
  assert.equal((await service.command('windows-update:check')).bytes, offset);
  assert.equal((await service.command('windows-update:install')).phase, 'launching');
  assert.deepEqual(ranges, [undefined, `bytes=${offset}-`]);
});
