'use strict';

const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');
const { candidateManifestName, candidateReleaseFormat, stableManifestName, stableReleaseFormat,
  releaseMessage, updateFileName } = require('../../windows-update.cjs');
const { createWindowsUpdateRequest } = require('./update-network.cjs');
const { UpdateService } = require('./update-service.cjs');

const repository = 'https://github.com/ytlds-64/jiancang-windows-releases';
const channel = `${repository}/releases/download/tauri-windows-x64-preview/`;
const stableChannel = `${repository}/releases/download/tauri-windows-x64/`;
const cdn = 'https://release-assets.githubusercontent.com';

function mockWorker(respond) {
  const requests = [];
  let kills = 0;
  function start() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    const data = [];
    let exited = false;
    function close(code) {
      if (!exited) { exited = true; child.emit('close', code); }
    }
    child.stdin = new Writable({
      write(chunk, _encoding, done) { data.push(chunk); done(); },
      final(done) {
        done();
        queueMicrotask(() => {
          if (exited) return;
          try {
            const request = JSON.parse(Buffer.concat(data));
            requests.push(request);
            const { status = 200, headers = {}, error, bytes = Buffer.alloc(0), keepOpen, code = 0 } = respond(request);
            const prelude = Buffer.from(JSON.stringify(error ? { error } : { status, headers }) + '\n');
            child.stdout.write(prelude.subarray(0, 4));
            child.stdout.write(Buffer.concat([prelude.subarray(4), bytes]));
            if (keepOpen) return;
            child.stdout.end();
            close(code);
          } catch (failure) { child.stdout.destroy(failure); close(1); }
        });
      },
    });
    child.kill = () => { kills++; close(null); };
    return child;
  }
  return { request: createWindowsUpdateRequest({ start }), requests, killed: () => kills };
}

test('streams the unchanged signed CDN URL with a Range header only on the approved hop', async () => {
  const raw = `${cdn}/asset?sig=%2b%3D%2f&value=A+B`;
  const bytes = Buffer.from([0, 10, 255, 0, 123, 10]);
  const { request, requests } = mockWorker(({ url }) => url === raw
    ? { status: 206, headers: { 'content-range': 'bytes 12-17/18' }, bytes }
    : { status: 302, headers: { location: raw } });
  const result = await request(new URL(`${channel}setup.exe`), { redirect: 'manual', attachment: {
    headers: { Range: 'bytes=12-' },
    allowsRedirect: (status, method, target, location) => status === 302 && method === 'GET' && target === raw && location === raw,
  } });
  assert.equal(result.followedAttachment, true);
  assert.equal(result.status, 206);
  assert.equal(result.headers.get('content-range'), 'bytes 12-17/18');
  assert.deepEqual(Buffer.from(await new Response(result.body).arrayBuffer()), bytes);
  assert.deepEqual(requests, [{ url: `${channel}setup.exe`, offset: null }, { url: raw, offset: 12 }]);
});

test('rejects off-origin redirects and extra CDN hops without contacting them', async () => {
  const signed = `${cdn}/setup.exe?sig=%2b`;
  const offsite = 'https://example.test/untrusted';
  const update = `${channel}setup.exe`;
  const first = mockWorker(() => ({ status: 302, headers: { location: offsite } }));
  const options = { redirect: 'manual', attachment: { allowsRedirect: (_code, _method, target) => target === signed } };
  await assert.rejects(first.request(new URL(update), options), /跳转地址/);
  assert.equal(first.requests.length, 1);

  const second = mockWorker(({ url }) => ({ status: 302, headers: { location: url === update ? signed : offsite } }));
  await assert.rejects(second.request(new URL(update), options), /跳转地址/);
  assert.deepEqual(second.requests.map(({ url }) => url), [update, signed]);
});

test('preserves proxy errors and cancels a stalled child transfer', async () => {
  const url = new URL(`${channel}setup.exe`);
  const proxy = mockWorker(() => ({ error: 'proxy', code: 1 }));
  await assert.rejects(proxy.request(url), /ERR_PROXY_CONNECTION_FAILED/);
  const denied = mockWorker(() => ({ status: 407 }));
  await assert.rejects(denied.request(url), /ERR_PROXY_AUTH_REQUESTED/);

  const slow = mockWorker(() => ({ keepOpen: true, bytes: Buffer.from([7, 8]) }));
  const cancel = new AbortController();
  const response = await slow.request(url, { signal: cancel.signal });
  const streaming = response.body.getReader();
  assert.deepEqual(Buffer.from((await streaming.read()).value), Buffer.from([7, 8]));
  const pending = streaming.read();
  cancel.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(slow.killed(), 1);

  const broken = mockWorker(() => ({ bytes: Buffer.from([7, 8]), code: 1 }));
  const cut = await broken.request(url);
  await assert.rejects(new Response(cut.body).arrayBuffer(), /transport failed/);
});

for (const resume of [true, false]) {
  test(`checks the isolated signed GitHub tag and ${resume ? 'resumes' : 'falls back'} after a stale CDN response`, async t => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-tauri-network-'));
    t.after(() => fs.rm(profile, { recursive: true, force: true }));
    const version = '0.36.29';
    const archive = Buffer.alloc(196_000, 132);
    const offset = 48_000;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const release = { format: 1, version, file: updateFileName(version, candidateReleaseFormat), bytes: archive.length,
      sha256: createHash('sha256').update(archive).digest('hex') };
    release.signature = sign(null, releaseMessage(release, candidateReleaseFormat), privateKey).toString('base64');
    let attachmentGets = 0;
    const worker = mockWorker(({ url, offset: range }) => {
      const endpoint = new URL(url);
      if (endpoint.href === channel + candidateManifestName) return { status: 302,
        headers: { location: `${cdn}/manifest?sig=%2bf` } };
      if (endpoint.href === `${cdn}/manifest?sig=%2bf`) return { bytes: Buffer.from(JSON.stringify(release)) };
      if (endpoint.origin === 'https://github.com') {
        assert.equal(endpoint.pathname, new URL(release.file, channel).pathname);
        assert.equal(range, null);
        const fresh = endpoint.searchParams.has('jiancang-refresh');
        return { status: 302, headers: { location: `${cdn}/setup?sig=${fresh ? '%2Bfresh' : '%2bprevious'}` } };
      }
      assert.equal(endpoint.pathname, '/setup');
      if (++attachmentGets === 1) return { bytes: archive.subarray(0, offset), code: 1 };
      if (range === null) return { bytes: archive };
      assert.equal(range, offset);
      if (resume && endpoint.search === '?sig=%2Bfresh') return { status: 206, bytes: archive.subarray(offset),
        headers: { 'content-range': `bytes ${offset}-${archive.length - 1}/${archive.length}` } };
      return { status: 400, headers: { 'x-ms-error-code': 'InvalidQueryParameterValue' } };
    });
    let launched = 0;
    const options = { version: '0.36.28', installed: true, publicKey, request: worker.request,
      async launch(file) { launched++; assert.deepEqual(await fs.readFile(file), archive); } };
    const initial = new UpdateService(profile, options);
    t.after(() => initial.close());
    await initial.initialize();
    assert.equal(initial.status().source, null);
    assert.deepEqual(initial.status().defaultSource, { url: channel });
    assert.equal(worker.requests.length, 0);
    const selected = await initial.command('windows-update:set-channel', [repository, false]);
    assert.deepEqual(selected.source, { url: channel });
    assert.equal((await initial.command('windows-update:open-release')).releasePage, `${repository}/releases/tag/tauri-windows-x64-preview`);
    await initial.command('windows-update:restore-channel', [false]);
    assert.equal((await initial.command('windows-update:check')).phase, 'available');
    const interrupted = await initial.command('windows-update:install');
    assert.deepEqual([interrupted.phase, interrupted.bytes, launched], ['error', offset, 0]);
    initial.close();

    const restart = new UpdateService(profile, options);
    t.after(() => restart.close());
    await restart.initialize();
    assert.equal((await restart.command('windows-update:check')).bytes, offset);
    assert.equal((await restart.command('windows-update:install')).phase, 'launching');
    assert.equal(launched, 1);
    assert.deepEqual(worker.requests.filter(({ url }) => url.startsWith(`${cdn}/setup`)).map(item => item.offset),
      resume ? [null, offset, offset] : [null, offset, offset, null]);
  });
}

test('keeps stable setup and signed channel independent of the earlier preview feed', async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-tauri-stable-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const version = '0.36.30';
  const bytes = Buffer.alloc(196_000, 94);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const setup = updateFileName(version, stableReleaseFormat);
  assert.equal(setup, `JianCang-Windows-${version}-x64-Setup.exe`);
  const release = { format: 1, version, file: setup, bytes: bytes.length, sha256 };
  let signatureFormat = candidateReleaseFormat;
  const worker = mockWorker(({ url }) => {
    if (url === stableChannel + stableManifestName) return { status: 302, headers: { location: `${cdn}/manifest?sig=stable` } };
    if (url === `${cdn}/manifest?sig=stable`) return { bytes: Buffer.from(JSON.stringify({ ...release,
      signature: sign(null, releaseMessage(release, signatureFormat), privateKey).toString('base64') })) };
    if (url === stableChannel + setup) return { status: 302, headers: { location: `${cdn}/setup?sig=stable` } };
    if (url === `${cdn}/setup?sig=stable`) return { bytes };
    throw new Error(`Unexpected worker URL: ${url}`);
  });
  const options = { version: '0.36.29', installed: true, publicKey, request: worker.request,
    async launch(file) { assert.deepEqual(await fs.readFile(file), bytes); assert.equal(path.basename(file), setup); } };
  const preview = new UpdateService(profile, options);
  t.after(() => preview.close());
  await preview.initialize();
  await preview.command('windows-update:restore-channel', [false]);
  assert.deepEqual(preview.status().source, { url: channel });

  const stable = new UpdateService(profile, { ...options, production: true });
  t.after(() => stable.close());
  await stable.initialize();
  assert.equal(stable.status().source, null);
  assert.deepEqual(stable.status().defaultSource, { url: stableChannel });
  await stable.command('windows-update:restore-channel', [false]);
  assert.equal((await stable.command('windows-update:open-release')).releasePage, `${repository}/releases/tag/tauri-windows-x64`);
  assert.match((await stable.command('windows-update:check')).message, /签名无法验证/);
  signatureFormat = stableReleaseFormat;
  assert.equal((await stable.command('windows-update:check')).phase, 'available');
  assert.equal((await stable.command('windows-update:install')).phase, 'launching');
  assert.deepEqual(preview.status().source, { url: channel });
});
