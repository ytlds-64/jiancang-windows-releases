'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openContainedFile } = require('./original-file.cjs');

const maxEntries = 128;
const settingsBytes = 4 * 1024 ** 2;
const idPattern = /^[a-f0-9-]{1,64}$/i;
const assetIDPattern = /^[a-f0-9]{64}$/;
const kinds = new Set(['jiancang', 'eagle', 'local']);

function createRegistry() {
  return { version: 1, entries: [], selectedId: null };
}

function validRoot(value) {
  return typeof value === 'string' && value.length <= 32767 && !value.includes('\0') && path.isAbsolute(value);
}

function validLibraryID(value) {
  return typeof value === 'string' && idPattern.test(value);
}

function validEntry(entry) {
  return entry && typeof entry === 'object' && validLibraryID(entry.id) && validRoot(entry.root) &&
    kinds.has(entry.kind) && validLibraryID(entry.libraryId) &&
    typeof entry.name === 'string' && entry.name.trim().length > 0 && entry.name.length <= 1024;
}

function sameLocation(first, second) {
  return path.relative(first, second) === '';
}

function parseRegistry(raw) {
  const registry = createRegistry();
  if (raw?.version === 1 && Array.isArray(raw.entries)) {
    const seen = new Set();
    for (const entry of raw.entries.slice(0, maxEntries)) {
      if (!validEntry(entry) || seen.has(entry.id) || registry.entries.some(saved => sameLocation(saved.root, entry.root))) continue;
      const { id, root, kind, name, libraryId, pathIndependentIdentity, syncWritable, eagleWritable } = entry;
      registry.entries.push({ id, root, kind, name, libraryId, pathIndependentIdentity: pathIndependentIdentity !== false,
        ...(kind === 'jiancang' && syncWritable === true && { syncWritable: true }),
        ...(kind === 'eagle' && eagleWritable === true && { eagleWritable: true }) });
      seen.add(id);
    }
    if (seen.has(raw.selectedId)) registry.selectedId = raw.selectedId;
    return { registry, migrated: false };
  }
  // Windows 0.1.0–0.1.2 saved only the most recently used sync folder.
  const root = raw?.root ?? raw?.libraryRoot;
  if (validRoot(root) && validLibraryID(raw.libraryId)) {
    const entry = {
      id: raw.libraryId, root, kind: 'jiancang', name: (path.basename(root) || '见藏').slice(0, 1024),
      libraryId: raw.libraryId, pathIndependentIdentity: true,
    };
    registry.entries.push(entry);
    registry.selectedId = entry.id;
    return { registry, migrated: true };
  }
  throw new Error('无法读取已保存的素材库，请重新添加。');
}

async function readRegistry(file) {
  let handle;
  try {
    const parent = await fs.realpath(path.dirname(file));
    handle = await openContainedFile(parent, path.join(parent, path.basename(file)));
  }
  catch (error) {
    if (error.code === 'ENOENT') return { registry: createRegistry(), migrated: false };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size > settingsBytes) throw new Error('素材库设置过大。');
    const buffer = Buffer.allocUnsafe(size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== size) throw new Error('读取期间素材库设置发生变化。');
    return parseRegistry(JSON.parse(buffer.subarray(0, offset).toString('utf8')));
  } finally { await handle.close(); }
}

async function writeRegistry(file, registry) {
  const content = JSON.stringify(registry);
  if (Buffer.byteLength(content) > settingsBytes) throw new Error('素材库设置过大。');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  try { await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

function registerLibrary(registry, root, library, previous) {
  const atLocation = registry.entries.find(entry => sameLocation(entry.root, root));
  if (previous && atLocation && previous.id !== atLocation.id) throw new Error('这份素材库已在列表中。');
  const match = previous ?? atLocation;
  const entry = {
    id: match?.id ?? randomUUID(), root, kind: library.kind, name: library.directoryName,
    libraryId: library.libraryId, pathIndependentIdentity: library.pathIndependentIdentity !== false,
    ...(library.kind === 'jiancang' && match?.libraryId === library.libraryId && match.syncWritable === true && { syncWritable: true }),
    ...(library.kind === 'eagle' && atLocation?.id === match?.id && match?.libraryId === library.libraryId &&
      match.eagleWritable === true && { eagleWritable: true }),
  };
  if (!validEntry(entry)) throw new Error('无法保存此素材库的位置。');
  if (!match && registry.entries.length >= maxEntries) throw new Error('已达到可添加素材库的数量上限。');
  const entries = match ? registry.entries.map(saved => saved.id === match.id ? entry : saved) : [...registry.entries, entry];
  return { version: 1, entries, selectedId: entry.id };
}

function detachLibrary(registry, id) {
  const entries = registry.entries.filter(entry => entry.id !== id);
  const selectedId = registry.selectedId === id ? entries[0]?.id ?? null : registry.selectedId;
  return { version: 1, entries, selectedId };
}

function locationMatches(entry, library, relocating) {
  // Some Eagle libraries have no portable ID. A folder explicitly selected in
  // the reconnect dialog can replace that path after validating the format.
  return entry.kind === library.kind && (entry.libraryId === library.libraryId ||
    (relocating && entry.kind === 'eagle' && !entry.pathIndependentIdentity));
}

function parseAssetRoute(pathname) {
  const parts = pathname.split('/');
  if (parts[0] !== '') return null;
  if (parts.length === 2 && assetIDPattern.test(parts[1])) return { assetId: parts[1] };
  if (parts.length === 3 && validLibraryID(parts[1]) && assetIDPattern.test(parts[2])) {
    return { registrationId: parts[1], assetId: parts[2] };
  }
  return null;
}

function assetForCatalog(catalogs, selectedId, assetId, registrationId) {
  if (typeof assetId !== 'string' || !assetIDPattern.test(assetId) ||
      (registrationId !== undefined && !validLibraryID(registrationId))) {
    throw new Error('素材已经变化，请刷新素材库。');
  }
  const library = catalogs.get(registrationId ?? selectedId);
  const asset = library?.assets.get(assetId);
  if (!asset) throw new Error('素材已经变化，请刷新素材库。');
  return {
    library, asset, file: library.originals.get(assetId),
    candidates: library.originalCandidates?.get(assetId), sourceThumbnail: library.sourceThumbnails?.get(assetId),
  };
}

module.exports = { createRegistry, parseRegistry, readRegistry, writeRegistry, registerLibrary,
  detachLibrary, locationMatches, parseAssetRoute, assetForCatalog };
