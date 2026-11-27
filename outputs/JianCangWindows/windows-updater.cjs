'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { normalizeUpdateSource, checkRelease, downloadRelease } = require('./windows-update.cjs');

const downloadLifetime = 7 * 24 * 60 * 60_000;
const partialDownloadPattern = /^download-[a-f0-9]{64}$/;
const installerStagePattern = /^download-[A-Za-z\d]{6}$/;

async function discardDownloads(root, keep, retainRecent = false) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    if (directory === keep) continue;
    if (partialDownloadPattern.test(entry.name)) {
      if (retainRecent) {
        const age = await fs.lstat(directory).then(stat => Date.now() - stat.mtimeMs, () => 0);
        if (age < downloadLifetime) continue;
      }
    } else if (!installerStagePattern.test(entry.name)) continue;
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function downloadLocation(root, source, release) {
  if (!source?.url || !release) return {};
  const identity = JSON.stringify([source.url, release.file, release.bytes, release.sha256]);
  const stage = path.join(root, `download-${createHash('sha256').update(identity).digest('hex')}`);
  return { stage, partial: path.join(stage, `${release.file}.part`) };
}

async function retainedBytes(partial, limit) {
  if (!partial) return 0;
  const stat = await fs.lstat(partial).catch(() => null);
  return stat?.isFile() && stat.nlink === 1 && stat.size <= limit ? stat.size : 0;
}

function updateErrorMessage(error, networkMessage) {
  const code = /^net::(ERR_[A-Z_]+)$/.exec(error.message)?.[1];
  if (code && /PROXY|TUNNEL/.test(code)) return '无法连接系统代理。请检查 Windows 系统代理和代理软件，再重试。';
  if (code === 'ERR_INTERNET_DISCONNECTED') return '网络已断开，重新联网后即可重试。';
  if (code || error.name === 'TimeoutError' || error instanceof TypeError) return networkMessage;
  return error.message;
}

function createWindowsUpdater({ profile, version, publicKey, installed, defaultSource: configuredDefault, notify, launch, request,
  releaseFormat, normalizeSource = normalizeUpdateSource, cacheName = 'windows-updates', activateDefaultSource = true }) {
  const root = path.join(profile, cacheName);
  const settings = path.join(root, 'channel.json');
  const defaultSource = configuredDefault ? normalizeSource(configuredDefault) : null;
  let source = installed && activateDefaultSource ? defaultSource : null;
  let automatic = true;
  let release = null;
  let phase = 'idle';
  let message = '';
  let bytes = 0;
  let bytesPerSecond = 0;
  let controller;
  let discardDownload = false;
  let startupTimer;
  let periodicTimer;
  let closed = false;

  function status() {
    const officialChannel = source?.url === defaultSource?.url &&
      /^https:\/\/github\.com\/[\w-]+\/[\w.-]+\/releases\/latest\/download\/$/.test(source?.url ?? '');
    const releasePage = officialChannel ? new URL('../../latest', source.url).href : undefined;
    return { ok: true, installed, version, source, ...(defaultSource && { defaultSource }), automatic, phase, message, bytes, releasePage,
      updateVersion: release?.version, totalBytes: release?.bytes,
      bytesPerSecond: phase === 'downloading' ? bytesPerSecond : 0 };
  }

  function report(nextPhase, detail = '') {
    phase = nextPhase;
    message = detail;
    const snapshot = status();
    notify(snapshot);
    return snapshot;
  }

  async function initialize() {
    if (!installed) return;
    try {
      const saved = JSON.parse(await fs.readFile(settings, 'utf8'));
      if (Object.hasOwn(saved, 'source')) source = saved.source === null ? null : normalizeSource(saved.source);
      automatic = saved.automatic !== false;
    } catch (error) {
      if (error.code !== 'ENOENT') report('error', '更新通道设置无法读取，请重新保存。');
    }
    await discardDownloads(root, undefined, true);
    const poll = () => { if (automatic && source && !controller && phase !== 'launching') void check(); };
    startupTimer = setTimeout(poll, 8_000);
    periodicTimer = setInterval(poll, 3 * 60 * 60_000);
    startupTimer.unref();
    periodicTimer.unref();
  }

  function checkAvailable() {
    if (!installed) throw new Error('请先通过安装包安装见藏。');
    if (closed) throw new Error('见藏正在关闭。');
    if (controller || phase === 'launching') throw new Error('更新处理中，请稍候。');
  }

  async function configure(nextSource, nextAutomatic) {
    checkAvailable();
    const normalized = nextSource === null ? null : normalizeSource(nextSource);
    controller = new AbortController();
    const temp = path.join(root, `channel-${randomUUID()}.tmp`);
    try {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(temp, JSON.stringify({ source: normalized, automatic: nextAutomatic === true }), { flag: 'wx' });
      await fs.rename(temp, settings);
      if (JSON.stringify(normalized) !== JSON.stringify(source)) await discardDownloads(root);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
      controller = undefined;
    }
    source = normalized;
    automatic = nextAutomatic === true;
    release = null;
    bytes = 0;
    return report('idle');
  }

  async function check() {
    checkAvailable();
    if (!source) throw new Error('请先设置更新通道。');
    controller = new AbortController();
    bytes = 0;
    report('checking');
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
      release = await checkRelease(source, publicKey, version, signal, request, releaseFormat);
      const { stage, partial } = downloadLocation(root, source, release);
      await discardDownloads(root, stage);
      bytes = await retainedBytes(partial, release?.bytes);
      return report(release ? 'available' : 'current');
    } catch (error) {
      release = null;
      return report('error', error.code === 'ENOENT' ? '找不到发布清单，请检查更新文件夹是否已同步。' :
        updateErrorMessage(error, '无法连接更新通道，请检查网络后重试。'));
    } finally { controller = undefined; }
  }

  async function install() {
    checkAvailable();
    if (!release) throw new Error('目前没有可安装的更新。');
    controller = new AbortController();
    discardDownload = false;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20 * 60_000)]);
    bytesPerSecond = 0;
    report('downloading');
    const location = downloadLocation(root, source, release);
    let stage = location.stage;
    let archive;
    let verified = false;
    let handedOff = false;
    let installerExit;
    let failure;
    let sampledBytes = bytes;
    let sampledAt = performance.now();
    const meter = setInterval(() => {
      if (phase !== 'downloading' || bytes === release.bytes) return;
      const now = performance.now();
      const received = bytes - sampledBytes;
      const speed = Math.round(received * 1000 / Math.max(1, now - sampledAt));
      sampledBytes = bytes;
      sampledAt = now;
      if (received === 0 && speed === bytesPerSecond) return;
      bytesPerSecond = speed;
      notify(status());
    }, 500);
    meter.unref();
    const stopMeter = () => {
      clearInterval(meter);
      bytesPerSecond = 0;
    };
    signal.addEventListener('abort', stopMeter, { once: true });
    try {
      await fs.mkdir(root, { recursive: true });
      if (stage) {
        await fs.mkdir(stage, { recursive: true });
        if (!(await fs.lstat(stage)).isDirectory()) throw new Error('更新缓存目录不可用。');
      } else stage = await fs.mkdtemp(path.join(root, 'download-'));
      archive = path.join(stage, release.file);
      await downloadRelease(source, release, archive, signal, (received, starting = false) => {
        bytes = received;
        if (starting) {
          sampledBytes = received;
          sampledAt = performance.now();
          bytesPerSecond = 0;
          notify(status());
        }
        if (bytes === release.bytes) {
          stopMeter();
          if (!starting) notify(status());
        }
      }, request, { partial: location.partial });
      verified = true;
      signal.throwIfAborted();
      report('launching');
      installerExit = (await launch(archive, release))?.completion;
      handedOff = true;
    } catch (error) {
      if (location.partial && verified && !discardDownload) {
        await fs.rename(archive, location.partial).catch(() => {});
      }
      bytes = await retainedBytes(location.partial, release.bytes);
      if (discardDownload) bytes = 0;
      failure = controller.signal.aborted ? ['available', '已取消下载。'] : ['error',
        updateErrorMessage(signal.aborted ? signal.reason : error, '更新下载未完成，请检查网络后重试。')];
    } finally {
      stopMeter();
      signal.removeEventListener('abort', stopMeter);
      if (stage && !handedOff && !bytes) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
      controller = undefined;
    }
    if (installerExit) {
      const reopen = async () => {
        await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
        if (!closed && phase === 'launching') {
          bytes = 0;
          report('available', '安装程序已关闭，可以重试。');
        }
      };
      void installerExit.then(reopen, reopen);
    }
    return failure ? report(...failure) : status();
  }

  return { initialize, status, configure, check, install,
    cancel() {
      if (phase === 'downloading' && controller) {
        discardDownload = true;
        controller.abort();
      }
      return status();
    },
    close() {
      closed = true;
      clearTimeout(startupTimer);
      clearInterval(periodicTimer);
      controller?.abort();
    },
  };
}

module.exports = { createWindowsUpdater };
