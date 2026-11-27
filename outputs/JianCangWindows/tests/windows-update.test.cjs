'use strict';

const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { EventEmitter, on } = require('node:events');
const { Readable } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { manifestName, updateFileName, releaseMessage, normalizeUpdateSource,
  readManifest, checkRelease, downloadRelease } = require('../windows-update.cjs');
const { createWindowsUpdater } = require('../windows-updater.cjs');
const { createUpdateRequest } = require('../windows-update-network.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-update-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const folder = path.join(root, 'channel');
  await fs.mkdir(folder);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const version = '0.30.2';
  const file = updateFileName(version);
  const archive = Buffer.alloc(192_000, 132);
  const release = { format: 1, version, file, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') };
  release.signature = sign(null, releaseMessage(release), privateKey).toString('base64');
  await fs.writeFile(path.join(folder, manifestName), JSON.stringify(release));
  await fs.writeFile(path.join(folder, file), archive);
  return { root, folder, release, archive, publicKey, privateKey };
}

test('checks only authenticated, newer x64 releases and validates channel addresses', async t => {
  const { folder, release, publicKey } = await fixture(t);
  assert.equal((await checkRelease({ folder }, publicKey, '0.9.0')).version, '0.30.2');
  assert.equal(await checkRelease({ folder }, publicKey, '0.30.2'), null);
  assert.equal(await checkRelease({ folder }, publicKey, '0.30.3'), null);
  assert.throws(() => readManifest(JSON.stringify({ ...release, bytes: release.bytes - 1 }), publicKey), /签名/);
  assert.throws(() => readManifest(JSON.stringify({ ...release, file: '../update.zip' }), publicKey), /格式/);
  assert.throws(() => readManifest(JSON.stringify(release), generateKeyPairSync('ed25519').publicKey), /签名/);
  assert.deepEqual(normalizeUpdateSource({ url: 'https://example.com/channel' }), { url: 'https://example.com/channel/' });
  for (const suffix of ['', '/', '/releases', '/releases/latest', '/releases/latest/download']) {
    assert.deepEqual(normalizeUpdateSource({ url: 'https://github.com/example/releases-repo' + suffix }), {
      url: 'https://github.com/example/releases-repo/releases/latest/download/',
    });
  }
  assert.throws(() => normalizeUpdateSource({ url: 'http://example.com/channel' }), /HTTPS/);
  assert.throws(() => normalizeUpdateSource({ url: 'https://user@example.com/channel' }), /HTTPS/);
});

test('streams a verified package and clears truncated, changed and cancelled copies', async t => {
  const { root, folder, release, archive } = await fixture(t);
  const destination = path.join(root, release.file);
  const progress = [];
  await downloadRelease({ folder }, release, destination, undefined, value => progress.push(value));
  assert.deepEqual(await fs.readFile(destination), archive);
  assert.equal(progress.at(-1), archive.length);
  await assert.rejects(downloadRelease({ folder }, release, destination), { code: 'EEXIST' });
  await fs.unlink(destination);
  const controller = new AbortController();
  await assert.rejects(downloadRelease({ folder }, release, destination, controller.signal, () => controller.abort()), { name: 'AbortError' });
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
  await fs.writeFile(path.join(folder, release.file), archive.subarray(1));
  await assert.rejects(downloadRelease({ folder }, release, destination), /校验/);
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
  await fs.writeFile(path.join(folder, release.file), Buffer.alloc(archive.length, 12));
  await assert.rejects(downloadRelease({ folder }, release, destination), /校验/);
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
});

test('persists the channel and hands off only an authenticated, complete newer package', async t => {
  const { root, folder, release, archive, publicKey } = await fixture(t);
  const profile = path.join(root, 'profile');
  const events = [];
  let handedOff;
  const launch = async (filename, descriptor) => {
    assert.equal(descriptor.version, release.version);
    assert.deepEqual(await fs.readFile(filename), archive);
    handedOff = filename;
  };
  const options = { profile, version: '0.27.0', publicKey, notify: event => events.push(event.phase), launch };
  const portable = createWindowsUpdater({ ...options, installed: false });
  await assert.rejects(portable.configure({ folder }, true), /安装包/);
  const first = createWindowsUpdater({ ...options, installed: true });
  await first.initialize();
  await first.configure({ folder }, false);
  first.close();
  const reopened = createWindowsUpdater({ ...options, installed: true });
  t.after(() => reopened.close());
  await reopened.initialize();
  assert.deepEqual(reopened.status().source, { folder });
  assert.equal(reopened.status().automatic, false);
  assert.equal((await reopened.check()).phase, 'available');
  await fs.writeFile(path.join(folder, release.file), Buffer.alloc(archive.length));
  assert.equal((await reopened.install()).phase, 'error');
  assert.equal(handedOff, undefined);
  await fs.writeFile(path.join(folder, release.file), archive);
  assert.equal((await reopened.install()).phase, 'launching');
  assert.equal(path.basename(handedOff), release.file);
  assert.ok(events.includes('checking') && events.includes('available') && events.includes('downloading'));
});

test('reports download speed and clears it on stalls, cancellation and retries', async t => {
  const { root, release, archive, publicKey } = await fixture(t);
  const url = 'https://example.com/channel/';
  const partial = archive.subarray(0, 64_000);
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async (endpoint, { signal }) => {
    if (endpoint.href === url + manifestName) return Response.json(release);
    assert.equal(endpoint.href, url + release.file);
    if (++attempts > 1) return new Response(archive);
    return new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(partial);
        signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
      },
    }));
  });
  const notifications = new EventEmitter();
  const updater = createWindowsUpdater({
    profile: path.join(root, 'profile'), version: '0.30.1', publicKey, installed: true, defaultSource: { url },
    notify: status => notifications.emit('status', status),
    launch: async filename => assert.deepEqual(await fs.readFile(filename), archive),
  });
  async function waitForDownload(predicate) {
    for await (const [status] of on(notifications, 'status', { signal: AbortSignal.timeout(4000) })) {
      if (status.phase === 'downloading' && predicate(status)) return status;
    }
  }
  let download;
  try {
    assert.equal((await updater.check()).phase, 'available');
    download = updater.install();
    assert.deepEqual([updater.status().bytes, updater.status().bytesPerSecond], [0, 0]);
    const transferring = await waitForDownload(status => status.bytesPerSecond > 0);
    assert.equal(transferring.bytes, partial.length);
    assert.equal(transferring.totalBytes, archive.length);
    const stalled = await waitForDownload(status => status.bytesPerSecond === 0);
    assert.equal(stalled.bytes, partial.length);
    updater.cancel();
    const cancelled = await download;
    assert.deepEqual([cancelled.phase, cancelled.bytes, cancelled.bytesPerSecond], ['available', 0, 0]);
    download = updater.install();
    assert.deepEqual([updater.status().bytes, updater.status().bytesPerSecond], [0, 0]);
    const complete = await download;
    assert.deepEqual([complete.phase, complete.bytes, complete.bytesPerSecond], ['launching', archive.length, 0]);
  } finally {
    updater.close();
    await download;
  }
});

test('reports system proxy and offline failures and can retry after download cleanup', async t => {
  const { root, release, archive, publicKey } = await fixture(t);
  const url = 'https://example.com/update/';
  let checkOffline = true;
  let downloadOffline = true;
  let retry;
  const updater = createWindowsUpdater({
    profile: root, version: '0.30.1', publicKey, installed: true, defaultSource: { url },
    async request(endpoint) {
      if (endpoint.href === url + manifestName) {
        if (checkOffline) throw new Error('net::ERR_PROXY_CONNECTION_FAILED');
        return Response.json(release);
      }
      assert.equal(endpoint.href, url + release.file);
      if (downloadOffline) {
        downloadOffline = false;
        throw new Error('net::ERR_INTERNET_DISCONNECTED');
      }
      return new Response(archive);
    },
    notify(status) {
      if (status.phase === 'error' && status.updateVersion) retry = updater.install();
    },
    launch: async filename => assert.deepEqual(await fs.readFile(filename), archive),
  });
  t.after(() => updater.close());
  assert.match((await updater.check()).message, /Windows 系统代理/);
  checkOffline = false;
  assert.equal((await updater.check()).phase, 'available');
  const failed = await updater.install();
  assert.deepEqual([failed.phase, failed.bytes, failed.bytesPerSecond], ['error', 0, 0]);
  assert.match(failed.message, /网络已断开/);
  assert.equal((await retry).phase, 'launching');
  assert.equal((await fs.readdir(path.join(root, 'windows-updates'))).length, 1);
});

test('resumes a partially received HTTPS package after restarting the updater', async t => {
  const { root, release, archive, publicKey } = await fixture(t);
  const url = 'https://example.com/update/';
  const offset = 64_000;
  const transfers = [];
  const progress = [];
  const options = {
    profile: root, version: '0.30.1', publicKey, installed: true, defaultSource: { url },
    async request(endpoint, { headers }) {
      if (endpoint.href === url + manifestName) return Response.json(release);
      assert.equal(endpoint.href, url + release.file);
      transfers.push(headers?.Range);
      if (transfers.length === 1) return new Response(archive.subarray(0, offset));
      return new Response(archive.subarray(offset), { status: 206,
        headers: { 'Content-Range': `bytes ${offset}-${archive.length - 1}/${archive.length}` } });
    },
    notify: status => { if (status.phase === 'downloading') progress.push(status.bytes); },
    launch: async filename => assert.deepEqual(await fs.readFile(filename), archive),
  };
  const first = createWindowsUpdater(options);
  t.after(() => first.close());
  assert.equal((await first.check()).phase, 'available');
  const interrupted = await first.install();
  assert.deepEqual([interrupted.phase, interrupted.bytes], ['error', offset]);
  first.close();

  const reopened = createWindowsUpdater(options);
  t.after(() => reopened.close());
  await reopened.initialize();
  assert.equal((await reopened.check()).bytes, offset);
  progress.length = 0;
  const complete = await reopened.install();
  assert.deepEqual([complete.phase, complete.bytes], ['launching', archive.length]);
  assert.equal(progress[0], offset);
  assert.deepEqual(transfers, [undefined, `bytes=${offset}-`]);
});

test('downloads from zero when the server ignores or cannot honor a byte range', async t => {
  const { root, release, archive } = await fixture(t);
  const url = 'https://example.com/update/';
  const offset = 1300;
  const destination = path.join(root, 'complete.zip');
  const partial = destination + '.part';
  const cases = [
    { code: 200, body: archive, headers: {} },
    { code: 416, body: null, headers: { 'Content-Range': `bytes */${archive.length}` } },
    { code: 206, body: archive.subarray(offset + 1),
      headers: { 'Content-Range': `bytes ${offset + 1}-${archive.length - 1}/${archive.length}` } },
    { code: 206, body: archive.subarray(offset), headers: {
      'Content-Range': `bytes ${offset}-${archive.length - 1}/${archive.length}`, 'Content-Encoding': 'gzip',
    } },
  ];
  for (const { code, body, headers } of cases) {
    await fs.writeFile(partial, Buffer.alloc(offset, 3));
    const requested = [];
    const progress = [];
    const request = async (_endpoint, options) => {
      requested.push(options.headers?.Range);
      if (requested.length === 1) return new Response(body, { status: code, headers });
      return new Response(archive);
    };
    await downloadRelease({ url }, release, destination, undefined, bytes => progress.push(bytes), request, { partial });
    assert.deepEqual(requested, code === 200 ? [`bytes=${offset}-`] : [`bytes=${offset}-`, undefined]);
    assert.equal(progress[0], 0);
    assert.deepEqual(await fs.readFile(destination), archive);
    await assert.rejects(fs.access(partial), { code: 'ENOENT' });
    await fs.unlink(destination);
  }
});

test('drops old partials on a signed manifest change and rejects corrupt assembled bytes', async t => {
  const { root, release, archive, publicKey, privateKey } = await fixture(t);
  const url = 'https://example.com/update/';
  const offset = 2400;
  const revisedArchive = Buffer.alloc(archive.length, 5);
  const revised = { ...release, sha256: createHash('sha256').update(revisedArchive).digest('hex') };
  revised.signature = sign(null, releaseMessage(revised), privateKey).toString('base64');
  let current = release;
  const ranges = [];
  let transfer = archive.subarray(0, offset);
  const updater = createWindowsUpdater({
    profile: root, version: '0.30.1', publicKey, installed: true, defaultSource: { url },
    async request(endpoint, options) {
      if (endpoint.href === url + manifestName) return Response.json(current);
      ranges.push(options.headers?.Range);
      if (options.headers?.Range) return new Response(transfer, { status: 206,
        headers: { 'Content-Range': `bytes ${offset}-${archive.length - 1}/${archive.length}` } });
      return new Response(transfer);
    },
    notify: () => {},
    launch: async filename => assert.deepEqual(await fs.readFile(filename), revisedArchive),
  });
  t.after(() => updater.close());
  assert.equal((await updater.check()).phase, 'available');
  assert.equal((await updater.install()).bytes, offset);
  current = revised;
  assert.equal((await updater.check()).bytes, 0);
  assert.deepEqual(await fs.readdir(path.join(root, 'windows-updates')), []);
  transfer = revisedArchive.subarray(0, offset);
  assert.equal((await updater.install()).bytes, offset);
  transfer = archive.subarray(offset);
  const rejected = await updater.install();
  assert.equal(rejected.phase, 'error');
  assert.equal(rejected.bytes, 0);
  assert.match(rejected.message, /校验/);
  assert.deepEqual(await fs.readdir(path.join(root, 'windows-updates')), []);
  transfer = revisedArchive;
  assert.equal((await updater.install()).phase, 'launching');
  assert.deepEqual(ranges, [undefined, undefined, `bytes=${offset}-`, undefined]);
});

test('pins a GitHub release to the tag discovered during its signed manifest check', async t => {
  const { root, release, archive, publicKey } = await fixture(t);
  const latest = 'https://github.com/example/releases-repo/releases/latest/download/';
  const tag = 'https://github.com/example/releases-repo/releases/download/windows-v0.30.2/';
  const manifestAsset = 'https://release-assets.githubusercontent.com/github-production-release-asset/abc?signature=temporary';
  const archiveAsset = 'https://objects.githubusercontent.com/github-production-release-asset-2e65be/def?signature=temporary';
  const replies = new Map([
    [latest + manifestName, () => new Response(null, { status: 302, headers: { Location: tag + manifestName } })],
    [tag + manifestName, () => new Response(null, { status: 302, headers: { Location: manifestAsset } })],
    [manifestAsset, () => Response.json(release)],
    [tag + release.file, () => new Response(null, { status: 302, headers: { Location: archiveAsset } })],
    [archiveAsset, () => new Response(archive)],
  ]);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push([url.href, options.redirect]);
    const reply = replies.get(url.href);
    assert.ok(reply, `Unexpected GitHub request: ${url.href}`);
    return reply();
  });
  const source = normalizeUpdateSource({ url: latest });
  const descriptor = await checkRelease(source, publicKey, '0.30.1');
  assert.equal(descriptor.version, '0.30.2');
  replies.delete(latest + manifestName);
  const destination = path.join(root, 'github-release.zip');
  await downloadRelease(source, descriptor, destination);
  assert.deepEqual(await fs.readFile(destination), archive);
  assert.deepEqual(requests, [
    [latest + manifestName, 'manual'], [tag + manifestName, 'manual'], [manifestAsset, 'error'],
    [tag + release.file, 'manual'], [archiveAsset, 'error'],
  ]);
  await fs.unlink(destination);
  replies.set(archiveAsset, () => new Response(Buffer.alloc(archive.length, 19)));
  await assert.rejects(downloadRelease(source, descriptor, destination), /校验/);
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
});

test('GitHub releases reject an off-repository or unapproved artifact redirect', async t => {
  const { root, release, publicKey } = await fixture(t);
  const source = { url: 'https://github.com/example/releases-repo/releases/latest/download/' };
  const current = source.url + manifestName;
  const tagged = 'https://github.com/example/releases-repo/releases/download/v0.30.2/';
  let redirect = current;
  let requestCount = 0;
  const responseTo = new Map([
    [current, () => new Response(null, { status: 302, headers: { Location: redirect } })],
    [tagged + manifestName, () => Response.json(release)],
    [tagged + release.file, () => new Response(null, { status: 302, headers: { Location: redirect } })],
  ]);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requestCount++;
    assert.equal(options.redirect, 'manual');
    const reply = responseTo.get(url.href);
    assert.ok(reply, `Unexpected redirect followed: ${url.href}`);
    return reply();
  });
  for (const redirectTo of [
    current,
    'https://github.com/other/releases-repo/releases/download/v0.30.2/' + manifestName,
    tagged + 'different.json',
    tagged + manifestName + '?token=unexpected',
    'https://release-assets.githubusercontent.com/cdn-path',
  ]) {
    requestCount = 0;
    redirect = redirectTo;
    await assert.rejects(checkRelease(source, publicKey, '0.30.1'), /跳转地址/);
    assert.equal(requestCount, 1);
  }
  redirect = tagged + manifestName;
  const descriptor = await checkRelease(source, publicKey, '0.30.1');
  for (const redirectTo of [
    'https://release-assets.githubusercontent.com.example.com/cdn-path',
    'https://release-assets.githubusercontent.com:1243/cdn-path',
    'http://release-assets.githubusercontent.com/cdn-path',
    'https://user@release-assets.githubusercontent.com/cdn-path',
    'https://github.com/other/releases-repo/releases/download/v0.30.2/' + release.file,
  ]) {
    requestCount = 0;
    redirect = redirectTo;
    const destination = path.join(root, 'rejected-release.zip');
    await assert.rejects(downloadRelease(source, descriptor, destination), /跳转地址/);
    assert.equal(requestCount, 1);
    await assert.rejects(fs.access(destination), { code: 'ENOENT' });
  }
});

test('refreshes an expired GitHub attachment URL while preserving a verified partial download', async t => {
  const { root, release, archive } = await fixture(t);
  const directory = 'https://github.com/example/releases-repo/releases/download/v0.30.2/';
  const asset = directory + release.file;
  const expired = 'https://release-assets.githubusercontent.com/example?signature=expired';
  const fresh = 'https://release-assets.githubusercontent.com/example?signature=fresh';
  const offset = 1400;
  const destination = path.join(root, release.file);
  const partial = path.join(root, release.file + '.part');
  await fs.writeFile(partial, archive.subarray(0, offset));
  let refreshes = 0;
  let permissionDenied = true;
  async function request(url, options) {
    if (url.origin === 'https://github.com') {
      assert.equal(options.headers.Range, undefined);
      assert.equal(options.headers['Cache-Control'], 'no-cache');
      assert.equal(url.origin + url.pathname, asset);
      if (url.searchParams.has('jiancang-refresh')) refreshes++;
      return new Response(null, { status: 302, headers: { Location: url.search ? fresh : expired } });
    }
    assert.equal(options.headers.Range, `bytes=${offset}-`);
    assert.ok([expired, fresh].includes(url.href));
    if (url.href === expired || permissionDenied) return new Response('denied', { status: 403 });
    return new Response(archive.subarray(offset), { status: 206,
      headers: { 'Content-Range': `bytes ${offset}-${archive.length - 1}/${archive.length}` } });
  }

  await assert.rejects(downloadRelease({ url: directory }, release, destination, undefined, undefined, request, { partial }),
    /GitHub 附件服务返回 HTTP 403/);
  assert.equal(refreshes, 1);
  assert.equal((await fs.stat(partial)).size, offset);
  permissionDenied = false;
  await downloadRelease({ url: directory }, release, destination, undefined, undefined, request, { partial });
  assert.equal(refreshes, 2);
  assert.deepEqual(await fs.readFile(destination), archive);
});

test('GitHub CDN 400 refreshes the download URL and retries without Range if needed', async t => {
  const { root, release, archive } = await fixture(t);
  const directory = 'https://github.com/example/releases-repo/releases/download/v0.30.2/';
  const firstURL = 'https://release-assets.githubusercontent.com/example?signature=first';
  const freshURL = 'https://release-assets.githubusercontent.com/example?signature=fresh';
  const prefixLength = 1400;
  const partial = path.join(root, 'download.part');
  const destination = path.join(root, release.file);

  for (const offset of [0, prefixLength]) {
    await fs.writeFile(partial, archive.subarray(0, offset));
    const transfers = [];
    async function request(url, options) {
      if (url.origin === 'https://github.com') {
        assert.equal(url.origin + url.pathname, directory + release.file);
        assert.equal(options.headers.Range, undefined);
        return new Response(null, { status: 302,
          headers: { Location: url.searchParams.has('jiancang-refresh') ? freshURL : firstURL } });
      }
      const range = options.headers?.Range;
      transfers.push([url.href, range]);
      if (url.href === firstURL || range) return new Response(null, { status: 400 });
      assert.equal(url.href, freshURL);
      return new Response(archive);
    }

    await downloadRelease({ url: directory }, release, destination, undefined, undefined, request, { partial });
    assert.deepEqual(transfers, [
      ...(offset ? [[firstURL, `bytes=${offset}-`], [freshURL, `bytes=${offset}-`]] : []),
      [firstURL, undefined], [freshURL, undefined],
    ]);
    assert.deepEqual(await fs.readFile(destination), archive);
    await fs.unlink(destination);
  }
});

test('continues GitHub attachment redirects on the Electron request and preserves CDN error details', async t => {
  const { release, publicKey } = await fixture(t);
  const url = 'https://github.com/example/releases-repo/releases/download/v0.30.2/';
  const signedURL = 'https://release-assets.githubusercontent.com/asset?sig=a%2Fb%2Bc';
  const followed = [];
  let failRefresh = false;
  let unrelatedRedirect = false;
  const request = createUpdateRequest({}, options => {
    const outgoing = new EventEmitter();
    const refreshed = new URL(options.url).searchParams.has('jiancang-refresh');
    outgoing.setHeader = () => {};
    outgoing.abort = () => {};
    outgoing.end = () => queueMicrotask(() => outgoing.emit('redirect', 302, 'GET', signedURL, { location: [signedURL] }));
    outgoing.followRedirect = () => {
      followed.push(refreshed);
      if (unrelatedRedirect) {
        outgoing.emit('redirect', 302, 'GET', 'https://example.com/another', { location: ['https://example.com/another'] });
        return;
      }
      const accepted = refreshed && !failRefresh;
      const response = Readable.from([Buffer.from(accepted ? JSON.stringify(release) : '')]);
      response.statusCode = accepted ? 200 : 400;
      response.headers = accepted ? {} : { 'x-ms-error-code': ['AuthenticationFailed'] };
      outgoing.emit('response', response);
    };
    return outgoing;
  });

  assert.equal((await checkRelease({ url }, publicKey, '0.30.1', undefined, request)).version, release.version);
  assert.deepEqual(followed.splice(0), [false, true]);
  failRefresh = true;
  await assert.rejects(checkRelease({ url }, publicKey, '0.30.1', undefined, request), /HTTP 400（AuthenticationFailed）/);
  assert.deepEqual(followed.splice(0), [false, true]);
  unrelatedRedirect = true;
  await assert.rejects(checkRelease({ url }, publicKey, '0.30.1', undefined, request), /跳转地址/);
  assert.deepEqual(followed, [false]);
});

test('uses the built-in channel on first installation and preserves an explicit choice', async t => {
  const { root, folder, archive, publicKey } = await fixture(t);
  const profile = path.join(root, 'default-profile');
  const options = { profile, version: '0.30.1', publicKey, installed: true,
    defaultSource: { folder }, notify: () => {}, launch: async filename => assert.deepEqual(await fs.readFile(filename), archive) };
  const first = createWindowsUpdater(options);
  t.after(() => first.close());
  await first.initialize();
  assert.deepEqual(first.status().source, { folder });
  assert.deepEqual(first.status().defaultSource, { folder });
  assert.equal(first.status().automatic, true);
  assert.equal((await first.check()).phase, 'available');
  assert.equal((await first.install()).phase, 'launching');
  first.close();

  const nextProfile = path.join(root, 'custom-profile');
  const custom = createWindowsUpdater({ ...options, profile: nextProfile });
  t.after(() => custom.close());
  await custom.initialize();
  await custom.configure(null, false);
  custom.close();
  const reopened = createWindowsUpdater({ ...options, profile: nextProfile });
  t.after(() => reopened.close());
  await reopened.initialize();
  assert.equal(reopened.status().source, null);
  assert.deepEqual(reopened.status().defaultSource, { folder });
  assert.equal(reopened.status().automatic, false);
});

test('offers the official GitHub browser download without accepting a user-provided link', async t => {
  const { root, publicKey } = await fixture(t);
  const site = 'https://github.com/example/releases-repo';
  const updater = createWindowsUpdater({ profile: root, version: '0.30.1', publicKey, installed: true,
    defaultSource: { url: site }, notify: () => {} });
  t.after(() => updater.close());
  await updater.initialize();
  assert.equal(updater.status().releasePage, site + '/releases/latest');
  await updater.configure({ url: 'https://github.com/example/other-releases' }, true);
  assert.equal(updater.status().releasePage, undefined);
});
