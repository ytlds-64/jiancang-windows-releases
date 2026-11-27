'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isWithin } = require('./original-file.cjs');

const maximumImportBatch = 10_000;
const maximumPastedURLs = 40;
const libraryMarkers = ['jiancang-local.json', 'library.json', 'metadata.json'];

function webURL(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value.trim());
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function clipboardWebURLs(value) {
  if (typeof value !== 'string') return [];
  if (value.length > maximumPastedURLs * 4_098) throw new Error('剪贴板里的网址过多，请分批粘贴。');
  const lines = value.split(/\r\n|[\r\n]/).map(line => line.trim()).filter(Boolean);
  if (lines.length > maximumPastedURLs) throw new Error(`一次最多粘贴 ${maximumPastedURLs} 个网址。`);
  const urls = lines.map(line => lines.length === 1 || !/\s/u.test(line) ? webURL(line) : null);
  return urls.includes(null) ? [] : [...new Set(urls)];
}

function syncUploadId(taskId) {
  if (!/^[a-f0-9]{32}$/.test(taskId)) throw new Error('无法识别此导入任务。');
  const variant = (Number.parseInt(taskId[16], 16) & 3 | 8).toString(16);
  return `${taskId.slice(0, 8)}-${taskId.slice(8, 12)}-8${taskId.slice(13, 16)}-${variant}${taskId.slice(17, 20)}-${taskId.slice(20)}`;
}

async function looksLikeLibrary(directory) {
  if (/\.library$/i.test(directory)) return true;
  const markers = await Promise.all(libraryMarkers.map(async name => {
    const entry = await fs.lstat(path.join(directory, name)).catch(() => null);
    return entry !== null;
  }));
  return markers[0] || (markers[1] && await isDirectory(path.join(directory, 'blobs'))) ||
    (markers[2] && await isDirectory(path.join(directory, 'images')));
}

async function isDirectory(location) {
  const entry = await fs.lstat(location).catch(() => null);
  return entry?.isDirectory() && !entry.isSymbolicLink();
}

async function inLibrary(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    if (await looksLikeLibrary(current)) return true;
    if (path.dirname(current) === current) return false;
  }
}

async function collectImportSources(paths, protectedRoots) {
  const sources = [];
  const seen = new Set();
  let skipped = 0;

  async function visit(location, root, folders) {
    if (!(typeof location === 'string' && path.isAbsolute(location)) || location.includes('\0')) { skipped++; return; }
    const [canonical, entry] = await Promise.all([fs.realpath(location).catch(() => null), fs.lstat(location).catch(() => null)]);
    if (!canonical || !entry || entry.isSymbolicLink() || (root && path.relative(location, canonical) !== '') ||
        protectedRoots.some(library => isWithin(library, canonical))) { skipped++; return; }
    if (seen.has(canonical)) return;
    seen.add(canonical);
    if (entry.isFile()) {
      if (sources.length >= maximumImportBatch) throw new Error('一次最多导入 10,000 个文件，请分批添加。');
      sources.push({ kind: 'file', path: canonical, root: root || path.dirname(canonical), name: path.basename(canonical),
        ...(folders.length && { collectionPaths: [folders] }) });
      return;
    }
    if (!entry.isDirectory() || folders.length >= 32 || await looksLikeLibrary(canonical)) { skipped++; return; }
    const listing = await fs.readdir(canonical, { withFileTypes: true }).catch(() => null);
    if (!listing) { skipped++; return; }
    const nextFolders = [...folders, Array.from(path.basename(canonical)).slice(0, 120).join('')];
    listing.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    for (const file of listing) {
      if (file.name.startsWith('.') || /^thumbs\.db$/i.test(file.name)) continue;
      await visit(path.join(canonical, file.name), root || canonical, nextFolders);
    }
  }

  for (const selected of paths) await visit(selected, null, []);
  return { sources, skipped };
}

function sourceCollectionPaths(ids, collections) {
  const indexed = new Map(collections.map(collection => [collection.id, collection]));
  return ids.slice(0, 32).flatMap(id => {
    const parts = [];
    const seen = new Set();
    for (let current = indexed.get(id); current && !seen.has(current.id) && parts.length < 32; current = indexed.get(current.parentId)) {
      seen.add(current.id);
      parts.unshift(current.name);
    }
    return parts.length ? [parts] : [];
  });
}

module.exports = { clipboardWebURLs, collectImportSources, inLibrary, maximumImportBatch, sourceCollectionPaths, syncUploadId, webURL };
