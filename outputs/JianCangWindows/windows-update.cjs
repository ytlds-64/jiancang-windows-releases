'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID, verify } = require('node:crypto');

const manifestName = 'jiancang-windows-x64-update.json';
const candidateManifestName = 'jiancang-windows-tauri-x64-update.json';
const stableManifestName = 'jiancang-windows-webview2-x64-update.json';
const electronReleaseFormat = Object.freeze({ manifestName, prefix: 'JianCang-Windows-', suffix: '-x64.zip' });
const candidateReleaseFormat = Object.freeze({ manifestName: candidateManifestName, prefix: 'JianCang-Windows-',
  suffix: '-Tauri-Candidate-x64-Local-Setup.exe' });
const stableReleaseFormat = Object.freeze({ manifestName: stableManifestName, prefix: 'JianCang-Windows-', suffix: '-x64-Setup.exe' });
const versionPattern = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
const manifestLimit = 32 * 1024;
const archiveLimit = 1024 ** 3;
const githubOrigin = 'https://github.com';
const githubAssetOrigins = new Set(['https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com']);
const githubRedirects = new Set([301, 302, 303, 307, 308]);
const pinnedDirectories = new WeakMap();
const sourceError = '无法从更新通道读取文件，请检查通道地址和网络。';
const redirectError = 'GitHub 更新文件的跳转地址有误，请检查发布附件。';
const refreshableAssetStatuses = new Set([400, 401, 403, 410]);

function httpUpdateError(file, response, fromAssets = false) {
  const host = fromAssets ? 'GitHub 附件服务' : '更新通道';
  const operation = file.endsWith('.json') ? '读取发布清单' : '下载更新包';
  const reason = fromAssets ? response.headers.get('x-ms-error-code') : undefined;
  const detail = typeof reason === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(reason) ? `（${reason}）` : '';
  return Number.isInteger(response.status) ? new Error(`${host}返回 HTTP ${response.status}${detail}，无法${operation}。`)
    : new Error(sourceError);
}

function updateFileName(version, format = electronReleaseFormat) {
  if (!versionPattern.test(version)) throw new Error('无效的见藏版本。');
  return `${format.prefix}${version}${format.suffix}`;
}

function newerVersion(version, installed) {
  if (!versionPattern.test(version) || !versionPattern.test(installed)) return false;
  const current = installed.split('.').map(Number);
  const next = version.split('.').map(Number);
  const difference = next.findIndex((part, index) => part !== current[index]);
  return difference !== -1 && next[difference] > current[difference];
}

function releaseMessage({ version, sha256, bytes }, format = electronReleaseFormat) {
  return Buffer.from(JSON.stringify([format.manifestName, version, updateFileName(version, format), bytes, sha256]), 'utf8');
}

function readManifest(json, publicKey, format = electronReleaseFormat) {
  let release;
  try { release = JSON.parse(json); }
  catch { throw new Error('更新通道的发布清单无法读取。'); }
  if (release?.format !== 1 || typeof release.version !== 'string' || !versionPattern.test(release.version) ||
      release.file !== updateFileName(release.version, format) || !Number.isSafeInteger(release.bytes) ||
      release.bytes <= 0 || release.bytes > archiveLimit || !/^[a-f0-9]{64}$/.test(release.sha256) ||
      typeof release.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(release.signature)) {
    throw new Error('更新通道的发布清单格式有误。');
  }
  if (!verify(null, releaseMessage(release, format), publicKey, Buffer.from(release.signature, 'base64'))) {
    throw new Error('更新清单签名无法验证。');
  }
  return { version: release.version, file: release.file, bytes: release.bytes, sha256: release.sha256 };
}

function normalizeUpdateSource({ folder, url } = {}) {
  if (typeof folder === 'string' && path.isAbsolute(folder) && folder.length <= 4096 && !folder.includes('\0')) {
    return { folder: path.normalize(folder) };
  }
  if (typeof url === 'string' && url.length <= 2048) {
    let parsed;
    try { parsed = new URL(url.trim()); } catch {}
    if (parsed?.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
      const githubRepository = parsed.origin === githubOrigin &&
        /^\/(\w[\w-]*\/[\w.-]+)(?:\/releases(?:\/latest)?)?\/?$/.exec(parsed.pathname);
      if (githubRepository) parsed.pathname = `/${githubRepository[1]}/releases/latest/download/`;
      if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
      return { url: parsed.href };
    }
  }
  throw new Error('请选择更新文件夹，或填写 HTTPS 更新目录。');
}

function githubReleaseDirectory(url) {
  if (url.origin !== githubOrigin || url.username || url.password || url.search || url.hash) return null;
  const route = /^\/([\w-]+\/[\w.-]+)\/releases\/(?:latest\/download|download\/([\w.-]+))\/$/.exec(url.pathname);
  return route && { repository: route[1].toLowerCase(), tagged: !!route[2] };
}

function redirectTarget(location, from) {
  if (!location) return null;
  try {
    const target = new URL(location, from);
    if (target.protocol === 'https:' && !target.username && !target.password && !target.hash) return target;
  } catch {}
  return null;
}

async function readRedirect(response, from) {
  await response.body?.cancel();
  const target = redirectTarget(response.headers.get('location'), from);
  if (!target) throw new Error(redirectError);
  return target;
}

async function requestGithubAttachment(asset, options, request) {
  const attachment = {
    headers: options.headers,
    allowsRedirect(status, method, destination, location) {
      if (!githubRedirects.has(status) || method !== 'GET') return false;
      const target = redirectTarget(location, asset);
      return !!target && githubAssetOrigins.has(target.origin) && target.href === destination;
    },
  };
  const response = await request(asset, { ...options, redirect: 'manual', headers: { 'Cache-Control': 'no-cache' }, attachment });
  if (response.followedAttachment) return { response, fromAssets: true };
  if (!githubRedirects.has(response.status)) return { response, fromAssets: false };
  // Fetch-compatible callers expose the redirect rather than keeping the request alive.
  const download = await readRedirect(response, asset);
  if (!githubAssetOrigins.has(download.origin)) throw new Error(redirectError);
  return { response: await request(download, { ...options, redirect: 'error' }), fromAssets: true };
}

async function githubReleaseAsset(directory, route, file, options, request) {
  let asset = new URL(file, directory);
  let taggedDirectory = directory;
  if (!route.tagged) {
    const response = await request(asset, { ...options, redirect: 'manual', headers: { 'Cache-Control': 'no-cache' } });
    if (!githubRedirects.has(response.status)) {
      await response.body?.cancel();
      throw httpUpdateError(file, response);
    }
    asset = await readRedirect(response, asset);
    taggedDirectory = new URL('./', asset);
    const tagged = githubReleaseDirectory(taggedDirectory);
    if (!tagged?.tagged || tagged.repository !== route.repository || asset.search ||
        asset.href !== new URL(file, taggedDirectory).href) throw new Error(redirectError);
  }
  let transfer = await requestGithubAttachment(asset, options, request);
  if (transfer.fromAssets && refreshableAssetStatuses.has(transfer.response.status)) {
    await transfer.response.body?.cancel();
    const refresh = new URL(asset);
    refresh.searchParams.set('jiancang-refresh', randomUUID());
    transfer = await requestGithubAttachment(refresh, options, request);
  }
  return { ...transfer, taggedDirectory: taggedDirectory.href };
}

async function remoteAsset(source, file, signal, request, offset) {
  const directory = new URL(source.url);
  const route = githubReleaseDirectory(directory);
  const options = { redirect: 'error', cache: 'no-store', signal };
  if (offset) options.headers = { Range: `bytes=${offset}-`, 'Accept-Encoding': 'identity' };
  return route ? githubReleaseAsset(directory, route, file, options, request) :
    { response: await request(new URL(file, directory), options) };
}

function matchesRange(response, offset, total) {
  const encoding = response.headers.get('content-encoding');
  return response.status === 206 &&
    response.headers.get('content-range') === `bytes ${offset}-${total - 1}/${total}` &&
    (!encoding || encoding.toLowerCase() === 'identity');
}

async function consume(source, file, signal, request, consumeChunks, offset = 0, total = 0) {
  signal?.throwIfAborted();
  if (source.folder) {
    const handle = await fs.open(path.join(source.folder, file), 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('更新文件不可用。');
      await consumeChunks(handle.createReadStream({ autoClose: false }), 0);
    } finally { await handle.close(); }
  } else {
    let { response, taggedDirectory, fromAssets } = await remoteAsset(source, file, signal, request, offset);
    let resumed = offset > 0 && matchesRange(response, offset, total);
    if (offset && (response.status === 416 || (response.status === 206 && !resumed) ||
        (fromAssets && response.status === 400))) {
      await response.body?.cancel();
      ({ response, taggedDirectory, fromAssets } = await remoteAsset(source, file, signal, request, 0));
      resumed = false;
    }
    try {
      if (response.status !== 200 && !resumed) throw httpUpdateError(file, response, fromAssets);
      if (!response.body) throw new Error(sourceError);
      await consumeChunks(response.body, resumed ? offset : 0);
      return taggedDirectory;
    } finally { await response.body?.cancel().catch(() => {}); }
  }
}

async function checkRelease(source, publicKey, installed, signal, request = fetch, format = electronReleaseFormat) {
  let length = 0;
  const chunks = [];
  const taggedDirectory = await consume(source, format.manifestName, signal, request, async stream => {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      length += chunk.length;
      if (length > manifestLimit) throw new Error('更新清单大小异常。');
      chunks.push(chunk);
    }
  });
  const release = readManifest(Buffer.concat(chunks, length).toString('utf8'), publicKey, format);
  if (!newerVersion(release.version, installed)) return null;
  if (taggedDirectory) pinnedDirectories.set(release, { channel: source.url, url: taggedDirectory });
  return release;
}

async function openPartial(filename) {
  const existing = await fs.lstat(filename).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!existing) return fs.open(filename, 'wx+', 0o600);
  if (!existing.isFile() || existing.nlink !== 1) throw new Error('更新缓存文件不可用。');
  // Windows append-only handles cannot truncate a partial after a full response.
  const handle = await fs.open(filename, 'r+');
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || current.dev !== existing.dev || current.ino !== existing.ino) {
      throw new Error('更新缓存文件已变更，请重试。');
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function downloadRelease(source, release, destination, signal, onProgress = () => {}, request = fetch, { partial } = {}) {
  const filename = partial || destination;
  const handle = partial ? await openPartial(filename) : await fs.open(filename, 'wx', 0o600);
  let length = 0;
  const hash = createHash('sha256');
  let complete = false;
  let discard = !partial;
  try {
    let offset = partial ? (await handle.stat()).size : 0;
    if (offset > release.bytes) {
      await handle.truncate(0);
      offset = 0;
    }
    async function hashExisting(end) {
      if (!end) return;
      for await (const chunk of handle.createReadStream({ start: 0, end: end - 1, autoClose: false })) {
        signal?.throwIfAborted();
        hash.update(chunk);
      }
    }
    if (offset === release.bytes) {
      onProgress(offset, true);
      await hashExisting(offset);
      length = offset;
    } else {
      const pinned = pinnedDirectories.get(release);
      const origin = pinned && pinned.channel === source.url ? { url: pinned.url } : source;
      await consume(origin, release.file, signal, request, async (stream, start) => {
        if (start !== offset) await handle.truncate(start);
        length = start;
        if (partial) onProgress(start, true);
        await hashExisting(start);
        for await (const chunk of stream) {
          signal?.throwIfAborted();
          if (length + chunk.length > release.bytes) {
            discard = true;
            throw new Error('更新包大小与发布清单不一致。');
          }
          let written = 0;
          while (written < chunk.length) {
            const { bytesWritten } = await handle.write(chunk, written, chunk.length - written, length + written);
            if (!bytesWritten) throw new Error('无法写入更新包。');
            written += bytesWritten;
          }
          hash.update(chunk);
          length += chunk.length;
          onProgress(length);
        }
      }, offset, release.bytes);
    }
    signal?.throwIfAborted();
    if (length === release.bytes && hash.digest('hex') !== release.sha256) {
      discard = true;
      throw new Error('更新包校验失败，请等文件同步完成后重试。');
    }
    if (length !== release.bytes) throw new Error('更新包校验失败，下载尚未完成，请重试。');
    await handle.sync();
    complete = true;
  } finally {
    await handle.close();
    if (!complete && discard) await fs.rm(filename, { force: true });
  }
  if (partial) await fs.rename(partial, destination);
}

module.exports = { manifestName, candidateManifestName, candidateReleaseFormat, stableManifestName, stableReleaseFormat,
  updateFileName, releaseMessage, newerVersion, readManifest, normalizeUpdateSource, checkRelease, downloadRelease };
