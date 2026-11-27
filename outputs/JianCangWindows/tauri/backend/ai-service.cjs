'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { AssetSuggestions } = require('../../asset-suggestions.cjs');
const { NaturalImageSearch, maximumNaturalSearchImages } = require('../../natural-image-search.cjs');

function windowsCredentialStorage(signal) {
  const systemRoot = process.env.SystemRoot ?? '';
  const executable = process.platform === 'win32' && path.isAbsolute(systemRoot)
    ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
  const error = () => new Error('系统密钥存储暂不可用。');

  function transform(method, bytes) {
    if (!executable) return Promise.reject(error());
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.Security',
      '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())',
      "$entropy = [Text.Encoding]::UTF8.GetBytes('JianCang/Tauri/AssetSuggestions/v1')",
      '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
      `$result = [Security.Cryptography.ProtectedData]::${method}($bytes, $entropy, $scope)`,
      '[Console]::Write([Convert]::ToBase64String($result))',
    ].join('; ');
    return new Promise((resolve, reject) => {
      // The command is fixed. Both input and output use private process pipes.
      const child = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 8000, maxBuffer: 24_576, signal }, (failure, output) => {
          const encoded = output?.trim();
          if (failure || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded ?? '') || encoded.length % 4) reject(error());
          else resolve(Buffer.from(encoded, 'base64'));
        });
      child.stdin.on('error', () => {});
      child.stdin.end(bytes.toString('base64'));
    });
  }

  return {
    isAsyncEncryptionAvailable: async () => !!(executable && await fs.stat(executable).then(info => info.isFile(), () => false)),
    encryptStringAsync: value => transform('Protect', Buffer.from(value, 'utf8')),
    async decryptStringAsync(value) {
      const bytes = await transform('Unprotect', value);
      try { return { result: bytes.toString('utf8') }; }
      finally { bytes.fill(0); }
    },
  };
}

class AIService {
  constructor(library, visual, { onChange, safeStorage = windowsCredentialStorage(library.shutdown.signal) } = {}) {
    this.library = library;
    this.visual = visual;
    this.suggestions = new AssetSuggestions({
      settingsFile: path.join(library.profile, 'asset-suggestions.json'),
      safeStorage,
      getAsset: reference => this.suggestionAsset(reference),
      getImage: (reference, signal) => {
        const asset = this.suggestionAsset(reference);
        if (!asset) throw new Error('此素材当前无法用于图片分析。');
        return this.getImage({ registrationId: reference.registrationId, assetId: reference.id, revision: asset.revision }, 640, signal);
      },
      apply: (reference, changes) => this.apply(reference, changes),
      onChange: snapshot => onChange?.('suggestion:changed', snapshot),
    });
    this.search = new NaturalImageSearch({
      directory: path.join(library.profile, 'natural-image-search-v1'),
      openService: profile => this.suggestions.openVisualSearch(profile),
      getImage: (reference, signal) => this.getImage(reference, 384, signal),
      currentReference: reference => visual.current(reference)?.reference ?? null,
      onChange: snapshot => onChange?.('natural-search:changed', snapshot),
    });
  }

  static handles(name) {
    return name.startsWith('suggestion:') || name.startsWith('natural-search:');
  }

  initialize() {
    return this.suggestions.initialize();
  }

  close() {
    this.search.close();
    return this.suggestions.close();
  }

  async getImage(reference, side, signal) {
    try {
      const bytes = await this.visual.image(reference, { side, signal });
      return { bytes, type: 'image/png' };
    } catch {
      signal?.throwIfAborted();
      throw new Error('无法生成用于分析的缩略图，请检查原件是否可用。');
    }
  }

  suggestionAsset({ id, registrationId }) {
    if (typeof registrationId !== 'string') return null;
    try {
      const { asset, library } = this.library.asset(id, registrationId);
      if (asset.trashed || (asset.kind !== 'image' && asset.extension !== 'livp')) return null;
      const entry = this.library.entry(registrationId);
      const status = this.library.statuses.get(registrationId);
      let writeBlock = '';
      if (status?.status !== 'available' || entry.kind === 'eagle' && !asset.eagleItemId) writeBlock = 'unavailable';
      else if (entry.kind === 'eagle' && !entry.eagleWritable) writeBlock = 'eagle';
      else if (entry.kind === 'jiancang') {
        if (library.publicLibrary.format !== 6) writeBlock = 'sync-upgrade';
        else if (!entry.syncWritable) writeBlock = 'sync-disabled';
        else if (status.syncLogIncomplete || library.publicLibrary.logIncomplete) writeBlock = 'sync-incomplete';
        else if (!this.library.syncWriter || this.library.duplicateSyncWriter(entry)) writeBlock = 'unavailable';
      }
      const revision = JSON.stringify([asset.mediaRevision || asset.id, asset.byteCount, asset.width, asset.height]);
      return { ...asset, revision, writable: !writeBlock, writeBlock, canRecheckRenamedImage: entry.kind === 'eagle' };
    } catch { return null; }
  }

  async apply(reference, patch) {
    const { registrationId, id, expected, undoGroup, fillMissing, revision } = reference;
    const current = this.suggestionAsset(reference);
    if (!current?.writable || current.revision !== revision) {
      throw new Error('素材已变化，请重新生成整理建议。');
    }
    if (this.library.entry(registrationId).kind === 'eagle') {
      const entry = await this.library.eagleWritable(registrationId);
      const asset = this.library.eagleAsset(entry, id);
      const fillTags = 'tags' in patch && fillMissing.includes('tags');
      const changes = { ...('title' in patch && { name: patch.title }), ...('note' in patch && { note: patch.note }),
        ...(fillTags && { tags: patch.tags }) };
      const edits = 'tags' in patch && !fillTags ? { tags: { add: patch.tags } } : {};
      await this.library.eagleApi.updateItem({ root: entry.root, id: asset.eagleItemId, changes, expected, edits });
      return { ok: true };
    }
    const entry = this.library.writable(registrationId);
    const result = await this.library.commitMutation(entry, { action: 'applySuggestion', id, expected, undoGroup, ...patch });
    return { ok: true, ...result };
  }

  applySelected(items) {
    return this.library.serial(async () => {
      const result = await this.suggestions.applySelected(items);
      const selected = new Set(items.map(item => item.taskId));
      const eagle = new Set(this.library.registry.entries.filter(entry => entry.kind === 'eagle').map(entry => entry.id));
      const changed = new Set(result.batch.tasks.filter(task => selected.has(task.taskId) &&
        (task.applied.length || eagle.has(task.registrationId))).map(task => task.registrationId));
      for (const id of changed) await this.library.refreshEntry(this.library.entry(id));
      if (changed.size) this.library.notify();
      return result;
    });
  }

  command(name, args = []) {
    const [first, second, third] = args;
    switch (name) {
      case 'suggestion:settings': return this.suggestions.getSettings();
      case 'suggestion:local-models': return this.suggestions.listLocalModels(first);
      case 'suggestion:save-settings': return this.suggestions.saveSettings(first);
      case 'suggestion:start': return this.suggestions.start(first);
      case 'suggestion:batch': return this.suggestions.review();
      case 'suggestion:retry': return this.suggestions.retry(first);
      case 'suggestion:retry-failed': return this.suggestions.retryFailed(first);
      case 'suggestion:pause': return this.suggestions.pause(first);
      case 'suggestion:resume': return this.suggestions.resume(first);
      case 'suggestion:cancel': return this.suggestions.cancel();
      case 'suggestion:discard': return this.suggestions.discard(first);
      case 'suggestion:apply': return this.applySelected(first);
      case 'natural-search:start': {
        if (!Array.isArray(second) || second.length > maximumNaturalSearchImages) {
          throw new Error(`请缩小范围至 ${maximumNaturalSearchImages} 张图片以内。`);
        }
        const current = this.visual.refs(second);
        if (current.length !== second.length) throw new Error('搜索范围中的素材已变化，请重新打开找图。');
        return this.search.start(first, current, third);
      }
      case 'natural-search:cancel': return this.search.cancel(first);
      case 'natural-search:status': return this.search.status();
      default: throw new Error('此 AI 操作不可用。');
    }
  }
}

module.exports = { AIService };
