'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRegistry, parseRegistry } = require('../../library-registry.cjs');
const { isWithin, openContainedFile, readStableBytes } = require('../../original-file.cjs');
const { targetShape, ruleShape, historyRecord, maxBrowsers, maximumRules, captureHistoryLimit } = require('../../browser-capture.cjs');

const legacyDirectory = '见藏';
const migrationReceipt = 'electron-profile-migration-v1.json';
const registryLimit = 4 * 1024 ** 2;
const maximumRegistrations = 128;

async function lstat(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function requireDirectDirectory(directory) {
  const entry = await lstat(directory);
  if (!entry?.isDirectory() || entry.isSymbolicLink() || path.relative(directory, await fs.realpath(directory)) !== '') {
    throw new Error('应用设置目录的位置已变化。');
  }
}

async function readSettings(directory, name, limit) {
  const file = path.join(directory, name);
  if (!await lstat(file)) return null;
  const handle = await openContainedFile(directory, file);
  let bytes;
  try {
    const { size } = await handle.stat();
    bytes = await readStableBytes(handle, size, limit);
    if (!bytes) throw new Error('应用设置文件超出大小限制或正在修改。');
  } finally {
    await handle.close();
  }
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

async function writeSettings(directory, name, value, previous = null) {
  const file = path.join(directory, name);
  const temporary = path.join(directory, `.electron-profile-${randomUUID()}.tmp`);
  await requireDirectDirectory(directory);
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true });
    if (previous) {
      const current = await readSettings(directory, name, registryLimit);
      if (!current?.bytes.equals(previous)) throw new Error('迁移期间素材库设置发生变化，请重新启动见藏。');
      await fs.rename(temporary, file);
    } else {
      try { await fs.link(temporary, file); }
      catch (error) {
        if (!['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(error.code)) throw error;
        await fs.copyFile(temporary, file, constants.COPYFILE_EXCL);
      }
    }
    return true;
  } catch (error) {
    if (error.code === 'EEXIST' && !previous) return false;
    throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function mergeRegistry(current, legacy, protectedRoots) {
  const entries = [...current.entries];
  const mapped = new Map();
  for (const entry of legacy.entries) {
    if (protectedRoots.some(directory => isWithin(directory, entry.root))) continue;
    const match = entries.find(saved => saved.id === entry.id || path.relative(saved.root, entry.root) === '');
    if (match) {
      if (match.kind === entry.kind && match.libraryId === entry.libraryId) mapped.set(entry.id, match);
      continue;
    }
    if (entries.length >= maximumRegistrations) continue;
    const added = { ...entry };
    if (entry.syncWritable && entries.some(saved => saved.libraryId === entry.libraryId && saved.syncWritable)) {
      delete added.syncWritable;
    }
    entries.push(added);
    mapped.set(entry.id, added);
  }
  const selectedId = current.entries.length ? current.selectedId : mapped.get(legacy.selectedId)?.id ?? null;
  return { registry: { version: 1, selectedId, entries }, mapped };
}

function aiProfile(value, loopbackOnly) {
  const endpoint = typeof value?.endpoint === 'string' && value.endpoint.length <= 2048 && URL.parse(value.endpoint);
  const model = typeof value?.model === 'string' ? value.model.trim() : '';
  if (!endpoint || !model || Buffer.byteLength(model) > 200 || /[\p{Cc}\p{Cs}]/u.test(model) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return undefined;
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname);
  if ((loopbackOnly && !local) || !(endpoint.protocol === 'https:' || local && endpoint.protocol === 'http:')) return undefined;
  return { endpoint: endpoint.href, model, keyCipher: null };
}

function aiSettings(value) {
  if (value?.version !== 1 && value?.version !== 2) return undefined;
  const compatible = aiProfile(value.version === 1 ? value : value.compatible, false);
  const lmstudio = aiProfile(value.lmstudio, true);
  return compatible || lmstudio ? { version: 2, provider: value.provider === 'lmstudio' ? 'lmstudio' : 'compatible',
    ...(compatible && { compatible }), ...(lmstudio && { lmstudio }) } : undefined;
}

function remapCaptureTarget(target, mapped, historical = false) {
  const entry = mapped.get(target.targetId);
  const found = entry?.libraryId === target.libraryId;
  if (!historical && (!found || (entry.kind !== 'local' && !entry.syncWritable))) return undefined;
  return found ? { ...target, targetId: entry.id } : target;
}

function captureSettings(value, mapped) {
  if (!value || Array.isArray(value) || !Object.hasOwn(value, 'target')) return undefined;
  if (value.target === null) return { target: null, tokens: [] };
  const target = remapCaptureTarget(targetShape(value.target), mapped);
  if (!target) return undefined;
  // The browser keeps its original token. The desktop stores only its digest,
  // so the established approval survives the switch without copying a raw token.
  const tokens = Array.isArray(value.tokens) ?
    [...new Set(value.tokens.filter(token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)))].slice(0, maxBrowsers) : [];
  return { target, tokens };
}

function captureRules(value, mapped) {
  if (!Array.isArray(value) || value.length > maximumRules) return undefined;
  const rules = new Map();
  for (const item of value) {
    try {
      const rule = ruleShape(item);
      const target = remapCaptureTarget(rule.target, mapped);
      if (target) rules.set(rule.id, { ...rule, target });
    } catch { /* Keep valid rules when one legacy record is no longer usable. */ }
  }
  return [...rules.values()];
}

function captureHistory(value, mapped) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(-captureHistoryLimit).flatMap(item => {
    try {
      const record = historyRecord(item);
      return record ? [{ ...record, target: remapCaptureTarget(record.target, mapped, true) }] : [];
    } catch { return []; }
  });
}

// The caller runs before any profile services start, behind the installed
// application's single-instance lock. The Electron directory remains a rollback source.
async function migrateLegacyProfile(profile, { appData = process.env.APPDATA } = {}) {
  const result = { imported: [], skipped: [] };
  if (typeof profile !== 'string' || typeof appData !== 'string' || !path.isAbsolute(profile) || !path.isAbsolute(appData) ||
      path.relative(appData, path.dirname(profile)) !== '' || path.basename(profile) === legacyDirectory) return result;
  const roaming = await fs.realpath(appData);
  const source = path.join(roaming, legacyDirectory);
  if (!await lstat(source)) return result;
  await requireDirectDirectory(source);
  const destination = path.join(roaming, path.basename(profile));
  if (!await lstat(destination)) await fs.mkdir(destination, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  await requireDirectDirectory(destination);
  if (await lstat(path.join(destination, migrationReceipt))) return result;

  async function loadSource(name, limit, normalize) {
    try {
      const saved = await readSettings(source, name, limit);
      if (saved) {
        const normalized = normalize(saved.value);
        if (normalized !== undefined) return normalized;
        result.skipped.push(name);
      }
    } catch (error) {
      if (error.code && !['ELOOP', 'EISDIR', 'ENOTDIR'].includes(error.code)) throw error;
      result.skipped.push(name);
    }
    return undefined;
  }

  const existing = await readSettings(destination, 'library.json', registryLimit);
  const current = existing ? parseRegistry(existing.value).registry : createRegistry();
  const legacy = await loadSource('library.json', registryLimit, value => parseRegistry(value).registry);
  const { registry, mapped } = mergeRegistry(current, legacy ?? createRegistry(), [source, destination]);
  if (registry.entries.length > current.entries.length) {
    if (!await writeSettings(destination, 'library.json', registry, existing?.bytes)) {
      throw new Error('迁移期间素材库设置发生变化，请重新启动见藏。');
    }
    result.imported.push('library.json');
  }

  async function importSettings(name, limit, normalize) {
    if (await lstat(path.join(destination, name))) return;
    const value = await loadSource(name, limit, normalize);
    if (value !== undefined && await writeSettings(destination, name, value)) result.imported.push(name);
  }

  await importSettings('browser-capture.json', 8192, value => captureSettings(value, mapped));
  await importSettings('browser-capture-rules.json', 1024 ** 2, value => captureRules(value, mapped));
  await importSettings('browser-capture-history.json', 8 * 1024 ** 2, value => captureHistory(value, mapped));
  await importSettings('asset-suggestions.json', 32_768, aiSettings);
  await writeSettings(destination, migrationReceipt, { version: 1 });
  return result;
}

module.exports = { migrateLegacyProfile };
