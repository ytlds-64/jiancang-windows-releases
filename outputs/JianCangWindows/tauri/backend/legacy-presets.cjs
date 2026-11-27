'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { readLiveKeys } = require('./legacy-leveldb.cjs');

const storageOrigin = Buffer.from('_jiancang://app\0', 'ascii');
const renameKey = 'jiancang-rename-presets-v1';
const originalExportKey = 'jiancang-export-presets-v1:originals';
const conversionKey = 'jiancang-export-presets-v1:conversion';
const presetLimits = new Map([[renameKey, 256], [originalExportKey, 64], [conversionKey, 64]]);

// Chromium Local Storage adds its origin and an encoding tag to every key.
// Match exact keys for the shipped Electron app, even if written as UTF-16.
const legacyKeys = new Map();
for (const key of presetLimits.keys()) {
  for (const [tag, encoding] of [[0, 'utf16le'], [1, 'latin1']]) {
    const encoded = Buffer.concat([storageOrigin, Buffer.of(tag), Buffer.from(key, encoding)]);
    legacyKeys.set(encoded.toString('latin1'), key);
  }
}

function textField(value) { return typeof value === 'string' && value.length <= 4096; }

function renameRule(rule) {
  if (rule?.mode === 'affixes') {
    const { prefix, suffix } = rule;
    if (textField(prefix) && textField(suffix) && (prefix || suffix)) return { mode: 'affixes', prefix, suffix };
  }
  if (rule?.mode === 'sequence') {
    const { base, start } = rule;
    if (textField(base) && base.trim() && Number.isInteger(start) && start >= 1 && start <= 999999999) {
      return { mode: 'sequence', base, start };
    }
  }
  if (rule?.mode === 'replace') {
    const { search, replacement } = rule;
    if (textField(search) && search && textField(replacement)) return { mode: 'replace', search, replacement };
  }
  return null;
}

function exportSettings(key, settings) {
  if (key === originalExportKey) {
    const { layout, includeMetadata } = settings ?? {};
    if (['flat', 'collections'].includes(layout) && typeof includeMetadata === 'boolean') return { layout, includeMetadata };
  } else {
    const { format, maximumSide, quality } = settings ?? {};
    if (['jpeg', 'png', 'webp'].includes(format) && Number.isInteger(maximumSide) && maximumSide >= 64 && maximumSide <= 4096 &&
        Number.isInteger(quality) && quality >= 20 && quality <= 100) return { format, maximumSide, quality };
  }
  return null;
}

function readPresetRows(bytes) {
  try {
    const tag = bytes[0];
    if (tag !== 1 && (tag !== 0 || bytes.length % 2 !== 1)) return null;
    const rows = JSON.parse(bytes.toString(tag === 0 ? 'utf16le' : 'latin1', 1));
    return Array.isArray(rows) ? rows : null;
  } catch { return null; }
}

function sanitizePresets(values) {
  let skipped = 0;
  const presets = {};
  for (const [key, bytes] of values) {
    const rows = readPresetRows(bytes);
    if (!rows) { skipped++; continue; }
    const valid = [];
    for (const row of rows) {
      const name = typeof row?.name === 'string' ? row.name.trim().normalize() : '';
      if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name) || valid.length >= presetLimits.get(key)) {
        skipped++;
        continue;
      }
      if (key === renameKey) {
        const rule = renameRule(row.rule);
        if (rule) { valid.push({ name, rule }); continue; }
      } else {
        const settings = exportSettings(key, row.settings);
        if (settings) { valid.push({ name, settings }); continue; }
      }
      skipped++;
    }
    if (valid.length) presets[key] = valid;
  }
  return { presets, skipped };
}

async function readLegacyPresets({ appData = process.env.APPDATA } = {}) {
  const empty = { presets: {}, skipped: 0 };
  if (typeof appData !== 'string' || !path.isAbsolute(appData)) return empty;
  let directory;
  try {
    directory = path.join(await fs.realpath(appData), '见藏', 'Local Storage', 'leveldb');
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error('invalid storage directory');
  } catch (error) {
    if (error.code === 'ENOENT') return empty;
    throw new Error('无法打开见藏旧版设置，请退出旧版后再试。');
  }
  try {
    return sanitizePresets(await readLiveKeys(directory, legacyKeys));
  } catch (error) {
    if (['LEGACY_DB_INVALID', 'LEGACY_DB_CHANGED'].includes(error.code)) throw new Error(error.message);
    throw new Error('无法读取见藏旧版设置，请退出旧版后再试。');
  }
}

module.exports = { readLegacyPresets };
