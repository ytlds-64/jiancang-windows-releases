'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserCapture, capturePort, extensionFiles, prepareBrowserExtension } = require('../../browser-capture.cjs');
const { newerVersion } = require('../../windows-update.cjs');

const channels = new Set([
  'browser-capture:status',
  'browser-capture:history',
  'browser-capture:copy-history-address',
  'browser-capture:configure',
  'browser-capture:rule-save',
  'browser-capture:rule-change',
  'browser-capture:disconnect',
  'browser-capture:extension',
  'browser-capture:worker-state',
  'browser-capture:worker-resolve',
]);
const coreExtensionFiles = ['background.js', 'collector.js', 'options.html', 'options.js', 'icon.png'];
const extensionVersion = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;

function originalExtensionDirectory() {
  const appData = process.env.APPDATA;
  return process.platform === 'win32' && appData && path.isAbsolute(appData)
    ? path.join(appData, '见藏', 'browser-extension') : null;
}

async function extensionManifest(directory) {
  if (!directory || !path.isAbsolute(directory)) return null;
  try {
    const folder = await fs.lstat(directory);
    if (!folder.isDirectory() || folder.isSymbolicLink()) return null;
    const file = path.join(directory, 'manifest.json');
    const item = await fs.lstat(file);
    if (!item.isFile() || item.isSymbolicLink() || item.size > 64 * 1024) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function sameExtension(manifest, bundled) {
  return Boolean(manifest?.key === bundled.key && manifest.manifest_version === bundled.manifest_version);
}

async function filesArePresent(directory, names) {
  return (await Promise.all(names.map(async name => {
    try {
      const file = await fs.lstat(path.join(directory, name));
      return file.isFile() && !file.isSymbolicLink() && file.size > 0;
    } catch {
      return false;
    }
  }))).every(Boolean);
}

class CaptureService {
  #capture;
  #port;
  #bundledExtensionDirectory;
  #legacyExtensionDirectory;
  #extensionDirectory;
  #production;
  #prepareExtension;
  #pairing;
  #historyRevision = 0;
  #closed = false;

  constructor({ profile, library, bundledExtensionDirectory = path.resolve(__dirname, '../../browser-extension'),
    legacyExtensionDirectory = originalExtensionDirectory(), port = capturePort, production = false }) {
    if (!path.isAbsolute(profile)) throw new Error('采集设置目录无效。');
    this.#port = port;
    this.#bundledExtensionDirectory = bundledExtensionDirectory;
    this.#legacyExtensionDirectory = legacyExtensionDirectory;
    this.#extensionDirectory = path.join(profile, 'browser-extension');
    this.#production = production;
    this.#capture = new BrowserCapture({
      settingsFile: path.join(profile, 'browser-capture.json'),
      port,
      resolveTarget: (selection, options) => library.captureTarget(selection, options),
      ...(production && { defaultTarget: () => {
        const available = library.captureLibraries();
        const selected = library.registry.selectedId;
        return available.find(item => item.targetId === selected)
          ?? available.find(item => library.entry(item.targetId).kind === 'local')
          ?? available[0];
      } }),
      listLibraries: () => library.captureLibraries(),
      createCollection: (selection, name) => library.createCaptureCollection(selection, name),
      approveConnection: signal => this.#requestApproval(signal),
      importAsset: task => library.importCapture(task),
      onHistoryChanged: () => { this.#historyRevision++; },
    });
  }

  static handles(name) {
    return channels.has(name);
  }

  async initialize() {
    await this.#capture.initialize();
    if (this.#production) await this.#refreshInstalledExtensions();
  }

  async enableDefault() {
    if (!this.#closed) await this.#capture.enableDefault();
  }

  async close() {
    this.#closed = true;
    this.#pairing?.settle(false);
    await this.#capture.close();
  }

  async command(name, args = []) {
    if (this.#closed) throw new Error('见藏正在退出。');
    const [first, second] = args;
    switch (name) {
      case 'browser-capture:status': {
        await this.enableDefault();
        const status = this.#capture.status();
        return { ...status, message: this.#portMessage(status.message) };
      }
      case 'browser-capture:history':
        return this.#capture.history();
      case 'browser-capture:copy-history-address': {
        const url = this.#capture.historyAddress(first, second);
        if (!url) throw new Error('此采集记录没有可复制的地址。');
        return { ok: true, url };
      }
      case 'browser-capture:configure':
        try { return await this.#capture.configure(first); }
        catch (error) {
          const message = this.#portMessage(error.message);
          if (message === error.message) throw error;
          throw new Error(message, { cause: error });
        }
      case 'browser-capture:rule-save':
        return this.#capture.saveRule(first);
      case 'browser-capture:rule-change':
        return this.#capture.changeRule(first, second);
      case 'browser-capture:disconnect':
        return this.#capture.disconnect(first === true);
      case 'browser-capture:extension':
        return { ok: true, directory: await this.#revealExtension() };
      case 'browser-capture:worker-state':
        return { pairing: this.#pairing ? { id: this.#pairing.id } : null, historyRevision: this.#historyRevision };
      case 'browser-capture:worker-resolve':
        return this.#resolveApproval(first, second);
      default:
        throw new Error('未找到此采集操作。');
    }
  }

  #portMessage(message) {
    const unavailable = `本机端口 ${this.#port} 暂不可用。`;
    return message?.startsWith(unavailable)
      ? `采集端口 ${this.#port} 暂不可用。如果还有另一个见藏正在运行，请先退出，再回到这里启用采集。`
      : message;
  }

  #requestApproval(signal) {
    if (this.#closed || signal.aborted || this.#pairing) return false;
    return new Promise(resolve => {
      const abort = () => settle(false);
      const settle = approved => {
        signal.removeEventListener('abort', abort);
        this.#pairing = undefined;
        resolve(approved === true && !signal.aborted && !this.#closed);
      };
      this.#pairing = { id: randomUUID(), settle };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  #resolveApproval(id, approved) {
    if (typeof id !== 'string' || typeof approved !== 'boolean') throw new Error('连接确认格式无效。');
    const accepted = this.#pairing?.id === id;
    if (accepted) this.#pairing.settle(approved);
    return { ok: true, settled: accepted };
  }

  async #revealExtension() {
    this.#prepareExtension ??= this.#extensionLocation().finally(() => { this.#prepareExtension = undefined; });
    return this.#prepareExtension;
  }

  async #refreshInstalledExtensions() {
    const bundled = await extensionManifest(this.#bundledExtensionDirectory);
    if (!extensionVersion.test(bundled?.version || '')) return;
    for (const directory of new Set([this.#legacyExtensionDirectory, this.#extensionDirectory])) {
      const existing = await extensionManifest(directory);
      if (!sameExtension(existing, bundled) || !extensionVersion.test(existing.version) ||
          !newerVersion(bundled.version, existing.version) || !await filesArePresent(directory, coreExtensionFiles)) continue;
      // Keep the existing unpacked extension location and browser identity.
      if (path.relative(directory, await fs.realpath(directory)) === '') {
        await prepareBrowserExtension(this.#bundledExtensionDirectory, directory);
      }
    }
  }

  async #extensionLocation() {
    const bundled = await extensionManifest(this.#bundledExtensionDirectory);
    if (typeof bundled?.key !== 'string' || !bundled.key) throw new Error('缺少浏览器采集扩展，请重新获取完整的安装包。');

    // Reuse the released version's unpacked folder when available. Its
    // manifest, scripts, and paired desktop profile stay under its ownership.
    const legacy = await extensionManifest(this.#legacyExtensionDirectory);
    if (sameExtension(legacy, bundled) && await filesArePresent(this.#legacyExtensionDirectory, coreExtensionFiles)) {
      return this.#legacyExtensionDirectory;
    }

    await fs.mkdir(this.#extensionDirectory, { recursive: true, mode: 0o700 });
    const folder = await fs.lstat(this.#extensionDirectory);
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('浏览器采集扩展文件夹位置无效。');
    const existing = await extensionManifest(this.#extensionDirectory);
    if (sameExtension(existing, bundled) && existing.version === bundled.version
        && await filesArePresent(this.#extensionDirectory, extensionFiles)) return this.#extensionDirectory;
    return prepareBrowserExtension(this.#bundledExtensionDirectory, this.#extensionDirectory);
  }
}

module.exports = { CaptureService };
