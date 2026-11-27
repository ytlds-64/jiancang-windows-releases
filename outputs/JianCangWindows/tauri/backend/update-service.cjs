'use strict';

const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { candidateReleaseFormat, stableReleaseFormat, normalizeUpdateSource, updateFileName } = require('../../windows-update.cjs');
const { createWindowsUpdater } = require('../../windows-updater.cjs');
const { createWindowsUpdateRequest } = require('./update-network.cjs');

const releaseRepository = 'https://github.com/ytlds-64/jiancang-windows-releases';
const windowsRequest = process.platform === 'win32' ? createWindowsUpdateRequest() : null;

async function launchInstaller(file) {
  if (process.platform !== 'win32') throw new Error('请在 Windows 上运行见藏安装程序。');
  const child = spawn(file, [], { cwd: path.dirname(file), detached: true, stdio: 'ignore' });
  const completion = new Promise(resolve => child.once('exit', resolve));
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new Error('无法打开见藏安装程序，请重试。')));
  });
  child.unref();
  return { completion };
}

class UpdateService {
  #updater;
  #profile;
  #localOnly;
  #cacheName;
  #releaseTag;
  #officialSource;
  #ready = false;

  constructor(profile, { version, installed, production = false, onChange, publicKey, request = windowsRequest, launch = launchInstaller }) {
    const releaseFormat = production ? stableReleaseFormat : candidateReleaseFormat;
    updateFileName(version, releaseFormat);
    this.#profile = profile;
    this.#localOnly = typeof request !== 'function';
    this.#cacheName = production ? 'windows-webview2-updates' : 'windows-tauri-updates';
    this.#releaseTag = production ? 'tauri-windows-x64' : 'tauri-windows-x64-preview';
    this.#officialSource = Object.freeze({ url: `${releaseRepository}/releases/download/${this.#releaseTag}/` });
    this.#updater = createWindowsUpdater({
      cacheName: this.#cacheName, profile, version, installed: installed === true,
      publicKey: publicKey ?? require('../../update-trust.json').publicKey,
      releaseFormat, request, launch,
      defaultSource: this.#localOnly ? null : this.#officialSource,
      // Select the isolated GitHub tag explicitly until a signed release is available there.
      activateDefaultSource: false,
      normalizeSource: source => {
        const normalized = normalizeUpdateSource(source);
        if (this.#localOnly && normalized.url) throw new Error('请先选择包含已签名更新文件的文件夹。');
        if (normalized.url === `${releaseRepository}/releases/latest/download/`) return this.#officialSource;
        return normalized;
      },
      notify: status => onChange?.(this.#publicStatus(status)),
    });
  }

  static handles(name) { return name.startsWith('windows-update:'); }

  #publicStatus(status) {
    const releasePage = status.source?.url === this.#officialSource.url ? `${releaseRepository}/releases/tag/${this.#releaseTag}` : undefined;
    return { ...status, releasePage, localOnly: this.#localOnly };
  }

  async initialize() {
    if (!this.#updater.status().installed) return;
    const root = path.join(this.#profile, this.#cacheName);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(root)).isDirectory()) throw new Error('更新缓存目录不可用。');
    await this.#updater.initialize();
    this.#ready = true;
  }

  close() { this.#updater.close(); }

  status() { return this.#publicStatus(this.#updater.status()); }

  async command(name, args = []) {
    const [first, second] = args;
    try {
      if (name !== 'windows-update:status' && this.#updater.status().installed && !this.#ready) {
        throw new Error('更新缓存目录不可用。');
      }
      switch (name) {
        case 'windows-update:status': return this.status();
        case 'windows-update:choose-folder': {
          if (typeof first !== 'string' || !path.isAbsolute(first)) throw new Error('请选择更新文件夹。');
          const folder = await fs.realpath(first);
          if (!(await fs.stat(folder)).isDirectory()) throw new Error('请选择更新文件夹。');
          return this.#publicStatus(await this.#updater.configure({ folder }, second));
        }
        case 'windows-update:set-channel':
          if (first != null && typeof first !== 'string') throw new Error('更新通道地址无效。');
          return this.#publicStatus(await this.#updater.configure(first?.trim() ? { url: first } : null, second));
        case 'windows-update:set-automatic':
          return this.#publicStatus(await this.#updater.configure(this.#updater.status().source, first));
        case 'windows-update:restore-channel': {
          const { defaultSource } = this.#updater.status();
          if (!defaultSource) throw new Error('此版本暂未设置官方更新通道。');
          return this.#publicStatus(await this.#updater.configure(defaultSource, first));
        }
        case 'windows-update:open-release': {
          const status = this.status();
          if (!status.releasePage) throw new Error('当前更新通道没有 GitHub 发布页。');
          return status;
        }
        case 'windows-update:check': return this.#publicStatus(await this.#updater.check());
        case 'windows-update:install': return this.#publicStatus(await this.#updater.install());
        case 'windows-update:cancel': return this.#publicStatus(this.#updater.cancel());
        default: throw new Error('此版本暂未设置官方更新通道。');
      }
    } catch (error) {
      return { ok: false, message: error.code ? '更新文件夹不可用，请重新选择。' : error.message };
    }
  }
}

module.exports = { UpdateService };
