'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { openContainedFile } = require('./original-file.cjs');
const { imageDimensions, readImageDimensions } = require('./image-dimensions.cjs');
const { tagChangePlan } = require('./tag-actions.cjs');

const LOCAL_MANIFEST = 'jiancang-local.json';
const ORIGINALS = 'originals';
const manifestLimit = 128 * 1024 ** 2;
const maximumEntries = 100_000;
const maximumUndo = 20;
const trashRetentionMs = 30 * 24 * 60 * 60 * 1000;
const assetIdPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const extensionPattern = /^[a-z0-9]{1,16}$/;
const purgeFilenamePattern = /^(?<id>[0-9a-f]{64})(?:-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})?(?:\.[a-z0-9]{1,16})?$/;
const purgeStampPattern = /^-?\d{1,24}(?::-?\d{1,24}){4}$/;
const editedFormats = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp' };
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const editedImageLimit = 96 * 1024 ** 2;
const mediaKinds = {
  image: new Set('jpg jpeg jpe jfif png gif webp heic heif avif bmp tiff tif ico svg psd psb ai eps raw dng cr2 cr3 nef arw orf raf livp'.split(' ')),
  video: new Set('mp4 m4v mov webm ogv avi mkv wmv flv mpg mpeg mts m2ts 3gp'.split(' ')),
  audio: new Set('mp3 m4a wav aiff aif ogg flac aac ape opus wma mid midi'.split(' ')),
  pdf: new Set(['pdf']),
  link: new Set(['url', 'webloc', 'website', 'webpage']),
};
const supportedKinds = new Set([...Object.keys(mediaKinds), 'document']);
const pendingWrites = new Map();

function invalidLibrary() {
  return new Error('本地素材库的目录信息无法读取。');
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validID = (value, pattern) => typeof value === 'string' && pattern.test(value);
const key = value => value.normalize('NFC').toLowerCase();

function cleanText(value, limit, preserveLines = false) {
  if (typeof value !== 'string') return '';
  const invalid = preserveLines ? /[\u0000-\u0008\u000b-\u001f\u007f\p{Cs}]/gu : /[\p{Cc}\p{Cs}]/gu;
  return Array.from(value.replace(/\r\n?/g, '\n').replace(invalid, ' ').trim().normalize('NFC')).slice(0, limit).join('').trim();
}

function requiredName(value) {
  const name = cleanText(value, 180);
  if (!name) throw new Error('请填写名称。');
  return name;
}

function dateISO(value) {
  const time = typeof value === 'number' || typeof value === 'string' ? new Date(value) : null;
  return time && Number.isFinite(time.getTime()) ? time.toISOString() : null;
}

function normalizedTags(value) {
  if (!Array.isArray(value)) throw new Error('标签格式不正确。');
  const tags = new Map();
  for (const item of value.slice(0, 256)) {
    const tag = cleanText(item, 128);
    if (tag && !tags.has(key(tag))) tags.set(key(tag), tag);
  }
  return [...tags.values()];
}

function normalizedURL(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 16_384 || /[\r\n\u0000]/.test(value)) throw new Error('请输入有效的网页网址。');
  const url = URL.parse(value.trim());
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入 HTTP 或 HTTPS 网页网址。');
  return url.href;
}

function ratingValue(value) {
  if (!Number.isInteger(value) || value < 0 || value > 5) throw new Error('评分应在 0 到 5 之间。');
  return value;
}

function validSize(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function dimension(value) {
  return Number.isInteger(value) && value > 0 && value <= 1_000_000 ? value : 0;
}

async function directoryIdentity(directory) {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(directory, await fs.realpath(directory)) !== '') throw invalidLibrary();
  return `${stat.dev}:${stat.ino}`;
}

function validCollection(collection, id) {
  return isRecord(collection) && collection.id === id && validID(id, uuidPattern) &&
    (collection.parentId === null || validID(collection.parentId, uuidPattern)) && typeof collection.name === 'string' && collection.name.length > 0;
}

function validAsset(asset, id) {
  return isRecord(asset) && asset.id === id && validID(id, assetIdPattern) && typeof asset.name === 'string' &&
    typeof asset.extension === 'string' && (asset.extension === '' || extensionPattern.test(asset.extension)) &&
    (asset.fileVersion === undefined || validID(asset.fileVersion, uuidPattern)) &&
    supportedKinds.has(asset.kind) && validSize(asset.byteCount) && Array.isArray(asset.collectionIds) &&
    asset.collectionIds.every(collection => validID(collection, uuidPattern)) && Array.isArray(asset.tags) &&
    asset.tags.every(tag => typeof tag === 'string') && typeof asset.trashed === 'boolean' &&
    typeof asset.importedAt === 'string' && typeof asset.createdAt === 'string' &&
    typeof asset.note === 'string' && (asset.sourceURL === null || typeof asset.sourceURL === 'string') &&
    typeof asset.favorite === 'boolean' && Number.isInteger(asset.rating) && asset.rating >= 0 && asset.rating <= 5;
}

function parseManifest(content) {
  let manifest;
  try { manifest = JSON.parse(content); }
  catch { throw invalidLibrary(); }
  if (!isRecord(manifest) || manifest.version !== 1 || !validID(manifest.libraryId, uuidPattern) ||
      typeof manifest.name !== 'string' || !manifest.name || !Number.isSafeInteger(manifest.revision) || manifest.revision < 0 ||
      !isRecord(manifest.assets) || !isRecord(manifest.collections) || !Array.isArray(manifest.undo) || manifest.undo.length > maximumUndo) throw invalidLibrary();
  const assets = Object.entries(manifest.assets);
  const collections = Object.entries(manifest.collections);
  if (assets.length > maximumEntries || collections.length > maximumEntries ||
      assets.some(([id, asset]) => !validAsset(asset, id)) || collections.some(([id, item]) => !validCollection(item, id)) ||
      !manifest.undo.every(validUndoRecord) ||
      (manifest.redo !== undefined && !validRedo(manifest.redo)) ||
      redoEntries(manifest).length + manifest.undo.length > maximumUndo ||
      (manifest.pendingPurge !== undefined && (!Array.isArray(manifest.pendingPurge) ||
        !manifest.pendingPurge.every(pair => Array.isArray(pair) && pair.length === 2 &&
          validID(pair[0], purgeFilenamePattern) && validID(pair[1], purgeStampPattern))))) throw invalidLibrary();
  return manifest;
}

function validUndoRecord(item) {
  return isRecord(item) && (item.group === null || typeof item.group === 'string') &&
    Array.isArray(item.assets) && item.assets.every(pair => Array.isArray(pair) && pair.length === 2 && validAsset(pair[1], pair[0])) &&
    Array.isArray(item.collections) && item.collections.every(pair => Array.isArray(pair) && pair.length === 2 &&
      (pair[1] === null ? validID(pair[0], uuidPattern) : validCollection(pair[1], pair[0]))) &&
    Array.isArray(item.imported) && item.imported.every(id => validID(id, assetIdPattern));
}

function validRedo(value) {
  return isRecord(value) && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    Array.isArray(value.entries) && value.entries.length <= maximumUndo &&
    value.entries.every(entry => isRecord(entry) && validUndoRecord(entry.before) && validUndoRecord(entry.after));
}

function redoEntries(manifest) {
  return manifest.redo?.revision === manifest.revision ? manifest.redo.entries : [];
}

function* historyAssetRecords(manifest) {
  for (const entry of manifest.undo) yield* entry.assets;
  for (const { before, after } of redoEntries(manifest)) {
    yield* before.assets;
    yield* after.assets;
  }
}

async function readManifest(root, expectedLibraryId) {
  const identity = await directoryIdentity(root);
  const handle = await openContainedFile(root, path.join(root, LOCAL_MANIFEST));
  try {
    const before = await handle.stat({ bigint: true });
    if (before.size > BigInt(manifestLimit)) throw invalidLibrary();
    const bytes = Buffer.allocUnsafe(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== bytes.length || before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        await directoryIdentity(root) !== identity) throw invalidLibrary();
    const manifest = parseManifest(bytes.toString('utf8'));
    if (expectedLibraryId !== undefined && manifest.libraryId !== expectedLibraryId) throw new Error('本地素材库的位置已变化，请重新连接。');
    return { identity, manifest };
  } finally { await handle.close(); }
}

async function writeManifest(root, identity, manifest) {
  const text = JSON.stringify(manifest);
  if (Buffer.byteLength(text) > manifestLimit) throw new Error('本地素材库的目录信息超过大小上限。');
  if (await directoryIdentity(root) !== identity) throw invalidLibrary();
  const temporary = path.join(root, `.jiancang-${randomUUID()}.tmp`);
  let staged = false;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    staged = true;
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    if (await directoryIdentity(root) !== identity) throw invalidLibrary();
    await fs.rename(temporary, path.join(root, LOCAL_MANIFEST));
  } finally {
    if (staged && await directoryIdentity(root).catch(() => null) === identity) await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function createLocalLibrary(root, name) {
  const label = requiredName(name);
  await fs.mkdir(root);
  const originals = path.join(root, ORIGINALS);
  let identity;
  try {
    identity = await directoryIdentity(root);
    await fs.mkdir(originals);
    const manifest = { version: 1, name: label, libraryId: randomUUID(), revision: 0, assets: {}, collections: {}, undo: [] };
    await writeManifest(root, identity, manifest);
    return snapshot(root, manifest);
  } catch (error) {
    if (identity && await directoryIdentity(root).catch(() => null) === identity) {
      await fs.rmdir(originals).catch(() => {});
      await fs.rmdir(root).catch(() => {});
    }
    throw error;
  }
}

function fileForAsset(root, asset) {
  if (!validID(asset?.id, assetIdPattern) || typeof asset.extension !== 'string' ||
      (asset.fileVersion !== undefined && !validID(asset.fileVersion, uuidPattern)) ||
      (asset.extension && !extensionPattern.test(asset.extension))) throw invalidLibrary();
  const version = asset.fileVersion ? `-${asset.fileVersion}` : '';
  return path.join(root, ORIGINALS, `${asset.id}${version}${asset.extension ? `.${asset.extension}` : ''}`);
}

function openLocalOriginal(root, asset) {
  return openContainedFile(path.join(root, ORIGINALS), fileForAsset(root, asset), asset.byteCount);
}

function mediaStamp(stat) {
  return [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino].join(':');
}

async function snapshot(root, manifest) {
  const originals = new Map();
  const assets = Object.values(manifest.assets).sort((a, b) => b.importedAt.localeCompare(a.importedAt) || a.id.localeCompare(b.id));
  const originalRoot = path.join(root, ORIGINALS);
  const originalIdentity = await directoryIdentity(originalRoot).catch(() => null);
  let next = 0;
  let missing = 0;
  async function project() {
    while (next < assets.length) {
      const index = next++;
      const asset = assets[index];
      const file = fileForAsset(root, asset);
      const stat = originalIdentity ? await fs.lstat(file, { bigint: true }).catch(() => null) : null;
      const available = !!(stat?.isFile() && !stat.isSymbolicLink() && stat.size === BigInt(asset.byteCount));
      if (available) originals.set(asset.id, file);
      else if (!asset.trashed && asset.kind !== 'link') missing++;
      const mediaRevision = available ? mediaStamp(stat) : null;
      assets[index] = { ...asset, available, mediaRevision };
    }
  }
  await Promise.all(Array.from({ length: Math.min(24, assets.length) }, project));
  const warnings = missing ? [`有 ${missing} 份本地原件暂不可用。`] : [];
  const pendingPurge = manifest.pendingPurge?.length ?? 0;
  if (pendingPurge) warnings.push(`有 ${pendingPurge} 份已删除的原件等待释放磁盘空间，可在该本地库的回收站重试清理。`);
  const nextRedo = redoEntries(manifest).at(-1)?.after;
  const redoRemoves = !!nextRedo && (nextRedo.collections.some(([id, record]) => !record && !!manifest.collections[id]) ||
    nextRedo.assets.some(([id, record]) => record.trashed && !manifest.assets[id]?.trashed));
  return {
    kind: 'local', format: 1, directoryName: manifest.name, libraryId: manifest.libraryId, pathIndependentIdentity: true,
    revision: String(manifest.revision), canUndo: manifest.undo.length > 0, canRedo: !!nextRedo, redoRemoves, pendingPurge,
    assets, collections: Object.values(manifest.collections), originals, warnings, partial: missing > 0, logIncomplete: false,
  };
}

async function readLocalLibrary(root, expectedLibraryId) {
  const { manifest } = await readManifest(root, expectedLibraryId);
  return snapshot(root, manifest);
}

function queueWrite(root, action) {
  const pending = (pendingWrites.get(root) ?? Promise.resolve()).catch(() => {}).then(action);
  pendingWrites.set(root, pending);
  const release = () => { if (pendingWrites.get(root) === pending) pendingWrites.delete(root); };
  pending.then(release, release);
  return pending;
}

function undoRecord(group = null) {
  return { group, assets: [], collections: [], imported: [] };
}

function dropRedo(manifest) {
  const records = [];
  for (const { before, after } of manifest.redo?.entries ?? []) {
    for (const [, asset] of before.assets) records.push(asset);
    for (const [, asset] of after.assets) records.push(asset);
  }
  delete manifest.redo;
  return records;
}

function pushUndo(manifest, entry, expired) {
  manifest.undo.push(entry);
  if (manifest.undo.length > maximumUndo) {
    for (const [, asset] of manifest.undo.shift().assets) expired.push(asset);
  }
}

function recordUndo(manifest, changes, expired) {
  if (!changes.assets.length && !changes.collections.length && !changes.imported.length) return false;
  for (const asset of dropRedo(manifest)) expired.push(asset);
  const preceding = manifest.undo.at(-1);
  if (changes.group !== null && preceding?.group === changes.group) {
    if (changes.assets.length) {
      const recorded = new Set(preceding.assets.map(([id]) => id));
      preceding.assets.push(...changes.assets.filter(([id]) => !recorded.has(id)));
    }
    preceding.collections.push(...changes.collections);
    preceding.imported.push(...changes.imported);
  } else pushUndo(manifest, changes, expired);
  return true;
}

function withTrashDate(asset, previous, now) {
  const trashedAt = asset.trashed ? previous?.trashed ? previous.trashedAt : now : undefined;
  if (asset.trashedAt === trashedAt) return asset;
  const next = { ...asset };
  if (trashedAt === undefined) delete next.trashedAt;
  else next.trashedAt = trashedAt;
  return next;
}

function applyHistoryRecords(manifest, changes, now) {
  for (const [id, record] of changes.assets) manifest.assets[id] = withTrashDate(record, manifest.assets[id], now);
  for (const [id, record] of changes.collections) {
    if (record) manifest.collections[id] = record;
    else delete manifest.collections[id];
  }
}

function undoLatest(manifest, expired) {
  const last = manifest.undo.at(-1);
  if (!last) return false;
  const entries = redoEntries(manifest);
  if (manifest.redo && manifest.redo.entries !== entries) {
    for (const asset of dropRedo(manifest)) expired.push(asset);
  }
  const after = undoRecord(last.group);
  const collectionIds = new Set(last.collections.map(([id]) => id));
  const removed = new Set(last.collections.filter(([, record]) => record === null).map(([id]) => id));
  const affected = new Set([...last.assets.map(([id]) => id), ...last.imported]);
  if (removed.size) for (const asset of Object.values(manifest.assets)) {
    if (asset.collectionIds.some(id => removed.has(id))) affected.add(asset.id);
  }
  for (const id of affected) {
    const current = manifest.assets[id];
    if (!current) throw invalidLibrary();
    after.assets.push([id, current]);
  }
  for (const id of collectionIds) after.collections.push([id, manifest.collections[id] ?? null]);
  manifest.undo.pop();
  const now = new Date().toISOString();
  applyHistoryRecords(manifest, last, now);
  for (const id of last.imported) {
    const asset = manifest.assets[id];
    if (asset) manifest.assets[id] = withTrashDate({ ...asset, trashed: true }, asset, now);
  }
  if (removed.size) for (const id of affected) {
    const current = manifest.assets[id];
    manifest.assets[id] = { ...current, collectionIds: current.collectionIds.filter(collectionId => !removed.has(collectionId)) };
  }
  entries.push({ before: last, after });
  manifest.redo = { revision: manifest.revision, entries };
  return true;
}

async function redoLatest(root, manifest, expired) {
  const entries = redoEntries(manifest);
  const last = entries.at(-1);
  if (!last) return false;
  for (const [id, asset] of last.after.assets) {
    const current = manifest.assets[id];
    if (!current) throw invalidLibrary();
    if (current.fileVersion === asset.fileVersion && current.extension === asset.extension &&
        !(current.trashed && !asset.trashed)) continue;
    try {
      const handle = await openLocalOriginal(root, asset);
      await handle.close();
    } catch { throw new Error('重做所需的原件暂不可读，请找回原件后重试。'); }
  }
  entries.pop();
  if (!entries.length) delete manifest.redo;
  applyHistoryRecords(manifest, last.after, new Date().toISOString());
  pushUndo(manifest, last.before, expired);
  return true;
}

function requestedAssets(manifest, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > maximumEntries) throw new Error('请先选择素材。');
  return [...new Set(ids)].map(id => {
    if (!validID(id, assetIdPattern) || !manifest.assets[id]) throw new Error('素材已变化，请刷新后重试。');
    return manifest.assets[id];
  });
}

function validCollections(manifest, ids) {
  if (!Array.isArray(ids) || ids.length > maximumEntries || ids.some(id => !validID(id, uuidPattern) || !manifest.collections[id])) {
    throw new Error('集合已变化，请刷新后重试。');
  }
  return [...new Set(ids)];
}

function duplicateMergeMetadata(keeper, copies) {
  const tagKeys = new Set(keeper.tags.map(key));
  const collectionIds = new Set(keeper.collectionIds);
  const addedTags = [];
  const addedCollectionIds = [];
  for (const copy of copies) {
    for (const tag of copy.tags) {
      const normalized = key(tag);
      if (tagKeys.has(normalized)) continue;
      tagKeys.add(normalized);
      addedTags.push(tag);
    }
    for (const id of copy.collectionIds) {
      if (collectionIds.has(id)) continue;
      collectionIds.add(id);
      addedCollectionIds.push(id);
    }
  }
  if (addedTags.length && keeper.tags.length + addedTags.length > 256) {
    throw new Error('合并后会超过每项素材 256 个标签，请减少本次选中的副本。');
  }
  return { addedTags, addedCollectionIds };
}

async function mergeDuplicates(root, manifest, command, changes) {
  if (command.expectedRevision !== String(manifest.revision)) {
    throw new Error('素材资料已变化，请重新预览合并。');
  }
  const [keeper] = requestedAssets(manifest, [command.keeperId]);
  const copies = requestedAssets(manifest, command.ids);
  if (keeper.trashed || copies.some(copy => copy.id === keeper.id || copy.trashed)) {
    throw new Error('素材状态已变化，请重新扫描该组。');
  }
  const { addedTags, addedCollectionIds } = duplicateMergeMetadata(keeper, copies);
  const nextCollections = validCollections(manifest, [...keeper.collectionIds, ...addedCollectionIds]);
  for (const asset of [keeper, ...copies]) {
    try {
      const expected = command.expectedMedia?.get(asset.id);
      if (!expected) throw new Error();
      const handle = await openLocalOriginal(root, asset);
      try {
        if (mediaStamp(await handle.stat({ bigint: true })) !== expected) throw new Error();
      } finally { await handle.close(); }
    } catch { throw new Error('有原件已变化或无法读取，请重新扫描该组。'); }
  }
  if (addedTags.length || addedCollectionIds.length) {
    changes.assets.push([keeper.id, keeper]);
    manifest.assets[keeper.id] = { ...keeper, tags: [...keeper.tags, ...addedTags], collectionIds: nextCollections };
  }
  applyAssets(manifest, { action: 'trash', ids: command.ids }, changes);
  return { count: copies.length };
}

function applyAssets(manifest, command, changes) {
  const records = requestedAssets(manifest, command.ids);
  const renaming = command.action === 'edit' && 'name' in command;
  if (renaming && records.length !== 1) throw new Error('请单独选中一项素材后修改名称。');
  const patch = {};
  const now = command.action === 'trash' ? new Date().toISOString() : undefined;
  if (command.action !== 'edit') patch.trashed = command.action === 'trash';
  if (command.action === 'edit') {
    if ('tags' in command) patch.tags = normalizedTags(command.tags);
    if ('collectionIds' in command) patch.collectionIds = validCollections(manifest, command.collectionIds);
    if ('favorite' in command) {
      if (typeof command.favorite !== 'boolean') throw new Error('收藏选项不正确。');
      patch.favorite = command.favorite;
    }
    if ('rating' in command) patch.rating = ratingValue(command.rating);
    if ('note' in command) patch.note = cleanText(command.note, 12_288, true);
    if ('sourceURL' in command) patch.sourceURL = normalizedURL(command.sourceURL);
  }
  const addTags = 'addTags' in command ? normalizedTags(command.addTags) : [];
  const removeTags = new Set('removeTags' in command ? normalizedTags(command.removeTags).map(key) : []);
  const addCollections = 'addCollectionIds' in command ? validCollections(manifest, command.addCollectionIds) : [];
  const removeCollections = new Set(command.action === 'edit' && 'removeCollectionIds' in command
    ? validCollections(manifest, command.removeCollectionIds)
    : []);
  for (const asset of records) {
    const next = withTrashDate({ ...asset, ...patch }, asset, now);
    if (addTags.length || removeTags.size) next.tags = normalizedTags([...next.tags.filter(tag => !removeTags.has(key(tag))), ...addTags]);
    if (removeCollections.size) next.collectionIds = next.collectionIds.filter(id => !removeCollections.has(id));
    if (addCollections.length) next.collectionIds = [...new Set([...next.collectionIds, ...addCollections])];
    if (renaming) {
      const plan = renameAssets(manifest, { action: 'planRename', entries: [{ id: asset.id, name: command.name }] },
        changes, next.collectionIds);
      next.name = plan.entries[0].name;
    }
    if (JSON.stringify(asset) === JSON.stringify(next)) continue;
    changes.assets.push([asset.id, asset]);
    manifest.assets[asset.id] = next;
  }
  return { count: changes.assets.length };
}

function canonicalAssetName(value, extension) {
  let name = requiredName(value);
  const suffix = extension ? `.${extension}` : null;
  if (suffix && name.toLowerCase().endsWith(suffix) && name.length > suffix.length) name = requiredName(name.slice(0, -suffix.length));
  return name;
}

function renameAssets(manifest, command, changes, targetCollections) {
  if (!Array.isArray(command.entries) || !command.entries.length || command.entries.length > maximumEntries ||
      command.entries.some(entry => !isRecord(entry))) throw new Error('请选择要改名的素材。');
  const proposals = new Map(command.entries.map(entry => [entry.id, entry.name]));
  if (proposals.size !== command.entries.length) throw new Error('同一份素材只能改名一次。');
  if (command.revision !== undefined && command.revision !== String(manifest.revision)) throw new Error('素材已变化，请核对最新名称后重试。');
  const records = requestedAssets(manifest, [...proposals.keys()]);
  const occupied = new Set();
  const locations = asset => asset.collectionIds.length ? asset.collectionIds : [''];
  const filenameKey = (location, extension, name) => `${location}\0${extension}\0${key(name)}`;
  for (const asset of Object.values(manifest.assets)) {
    if (!proposals.has(asset.id) && !asset.trashed) {
      for (const location of locations(asset)) occupied.add(filenameKey(location, asset.extension, asset.name));
    }
  }
  const entries = records.map(asset => {
    const base = canonicalAssetName(proposals.get(asset.id), asset.extension);
    let name = base;
    let duplicate = 2;
    const scopes = locations(targetCollections ? { collectionIds: targetCollections } : asset);
    while (scopes.some(location => occupied.has(filenameKey(location, asset.extension, name)))) {
      name = `${Array.from(base).slice(0, 165).join('').trimEnd()}（${duplicate++}）`;
    }
    for (const location of scopes) occupied.add(filenameKey(location, asset.extension, name));
    if (command.action === 'rename' && name !== asset.name) {
      changes.assets.push([asset.id, asset]);
      manifest.assets[asset.id] = { ...asset, name };
    }
    return { id: asset.id, oldName: asset.name, name };
  });
  return { entries };
}

function applySuggestion(manifest, command, changes) {
  const [asset] = requestedAssets(manifest, [command.id]);
  const expected = command.expected;
  if (asset.trashed || (expected !== undefined && (asset.name !== expected?.name || asset.note !== expected?.note ||
      JSON.stringify([...asset.tags].sort()) !== JSON.stringify(Array.isArray(expected?.tags) ? [...expected.tags].sort() : null)))) {
    throw new Error('素材的整理信息已变化，请重新生成建议。');
  }
  const next = { ...asset };
  if ('title' in command) {
    const result = renameAssets(manifest, { action: 'planRename', entries: [{ id: asset.id, name: command.title }] }, changes);
    next.name = result.entries[0].name;
  }
  if ('tags' in command) {
    if (!Array.isArray(command.tags) || command.tags.some(tag => typeof tag !== 'string')) throw new Error('标签格式不正确。');
    next.tags = normalizedTags([...asset.tags, ...normalizedTags(command.tags)]);
  }
  if ('note' in command) {
    if (typeof command.note !== 'string') throw new Error('请输入有效文字。');
    next.note = cleanText(command.note, 12_288, true);
  }
  if (JSON.stringify(asset) === JSON.stringify(next)) return { count: 0, name: asset.name };
  changes.assets.push([asset.id, asset]);
  manifest.assets[asset.id] = next;
  return { count: 1, name: next.name };
}

function checkParent(manifest, parentId, id) {
  const visited = new Set();
  while (parentId !== null) {
    if (!validID(parentId, uuidPattern) || !manifest.collections[parentId]) throw new Error('上级集合已变化，请刷新后重试。');
    if (parentId === id || visited.has(parentId) || visited.size >= 127) throw new Error('不能将集合放入自己的子集合，或超过允许的层级。');
    visited.add(parentId);
    parentId = manifest.collections[parentId].parentId;
  }
}

function matchingCollection(manifest, name, parentId, except) {
  return Object.values(manifest.collections).find(item => item.id !== except && item.parentId === parentId && key(item.name) === key(name));
}

function createCollection(manifest, changes, name, parentId, color = '46786B') {
  if (Object.keys(manifest.collections).length >= maximumEntries) throw new Error('本地素材库的集合数量已达上限。');
  checkParent(manifest, parentId);
  const id = randomUUID();
  manifest.collections[id] = { id, parentId, name, color };
  changes.collections.push([id, null]);
  return id;
}

function deleteCollection(manifest, id, changes) {
  const children = new Map();
  for (const item of Object.values(manifest.collections)) {
    if (!children.has(item.parentId)) children.set(item.parentId, []);
    children.get(item.parentId).push(item.id);
  }
  const removed = new Set([id]);
  const queue = [id];
  for (let index = 0; index < queue.length; index++) {
    const collectionId = queue[index];
    changes.collections.push([collectionId, manifest.collections[collectionId]]);
    delete manifest.collections[collectionId];
    for (const child of children.get(collectionId) ?? []) {
      if (!removed.has(child)) { removed.add(child); queue.push(child); }
    }
  }
  for (const asset of Object.values(manifest.assets)) {
    const collectionIds = asset.collectionIds.filter(collection => !removed.has(collection));
    if (collectionIds.length === asset.collectionIds.length) continue;
    changes.assets.push([asset.id, asset]);
    manifest.assets[asset.id] = { ...asset, collectionIds };
  }
  return { id, count: removed.size };
}

function changeCollection(manifest, command, changes) {
  const { action, id } = command;
  const previous = validID(id, uuidPattern) ? manifest.collections[id] : null;
  if (action !== 'createCollection' && !previous) throw new Error('集合已变化，请刷新后重试。');
  if (action === 'deleteCollection') return deleteCollection(manifest, id, changes);
  const name = 'name' in command ? requiredName(command.name) : requiredName(previous?.name);
  const parentId = 'parentId' in command ? command.parentId ?? null : previous?.parentId ?? null;
  const color = typeof command.color === 'string' && /^[0-9a-f]{6}$/i.test(command.color) ? command.color : previous?.color ?? '46786B';
  checkParent(manifest, parentId, id);
  if (matchingCollection(manifest, name, parentId, id)) throw new Error('这个位置已有同名集合。');
  if (!previous) return { id: createCollection(manifest, changes, name, parentId, color) };
  if (name !== previous.name || parentId !== previous.parentId || color !== previous.color) {
    changes.collections.push([id, previous]);
    manifest.collections[id] = { ...previous, name, parentId, color };
  }
  return { id };
}

async function commit(root, identity, manifest, expired = []) {
  const hasRetiredFiles = await journalRetiredOriginals(root, identity, manifest, expired);
  if (manifest.redo?.revision === manifest.revision) manifest.redo.revision++;
  manifest.revision++;
  await writeManifest(root, identity, manifest);
  if (hasRetiredFiles) await finishTrashPurge(root, identity, manifest).catch(() => {});
}

function retainedOriginalNames(root, manifest, ids) {
  const names = new Set();
  for (const id of ids) {
    if (manifest.assets[id]) names.add(path.basename(fileForAsset(root, manifest.assets[id])));
  }
  for (const [id, asset] of historyAssetRecords(manifest)) {
    if (ids.has(id)) names.add(path.basename(fileForAsset(root, asset)));
  }
  return names;
}

async function journalRetiredOriginals(root, rootIdentity, manifest, previousAssets) {
  if (!previousAssets.length) return false;
  const versions = new Map();
  for (const previous of previousAssets) {
    const current = manifest.assets[previous.id];
    const candidate = fileForAsset(root, previous);
    if (!current || fileForAsset(root, current) === candidate) continue;
    versions.set(candidate, previous);
  }
  if (!versions.size || await directoryIdentity(root).catch(() => null) !== rootIdentity) return false;
  const retained = retainedOriginalNames(root, manifest, new Set([...versions.values()].map(asset => asset.id)));
  const originals = path.join(root, ORIGINALS);
  const identity = await directoryIdentity(originals).catch(() => null);
  if (!identity) return false;
  const retired = [];
  for (const [candidate, previous] of versions) {
    const name = path.basename(candidate);
    if (retained.has(name)) continue;
    const stat = await fs.lstat(candidate, { bigint: true }).catch(() => null);
    if (stat?.isFile() && !stat.isSymbolicLink() && stat.size === BigInt(previous.byteCount)) retired.push([name, sourceStamp(stat)]);
  }
  if (!retired.length || await directoryIdentity(root).catch(() => null) !== rootIdentity ||
      await directoryIdentity(originals).catch(() => null) !== identity) return false;
  manifest.pendingPurge = [...new Map([...(manifest.pendingPurge ?? []), ...retired])];
  return true;
}

async function trashPurgeFiles(root, identity, records, mediaRevisions) {
  const originalRoot = path.join(root, ORIGINALS);
  const originalIdentity = await directoryIdentity(originalRoot);
  const pending = [];
  for (const asset of records) {
    const file = fileForAsset(root, asset);
    const stat = await fs.lstat(file, { bigint: true }).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const observed = mediaRevisions?.get(asset.id);
    if (!stat && !observed) continue;
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== BigInt(asset.byteCount) ||
        (observed && observed !== mediaStamp(stat))) {
      throw new Error('原件在确认前发生变化。素材仍在回收站，请检查原件后重试。');
    }
    pending.push([path.basename(file), sourceStamp(stat)]);
  }
  if (await directoryIdentity(root) !== identity || await directoryIdentity(originalRoot) !== originalIdentity) {
    throw invalidLibrary();
  }
  return pending;
}

async function finishTrashPurge(root, identity, manifest) {
  const pending = manifest.pendingPurge ?? [];
  if (!pending.length) return 0;
  const originalRoot = path.join(root, ORIGINALS);
  const originalIdentity = await directoryIdentity(originalRoot).catch(() => null);
  if (!originalIdentity || await directoryIdentity(root).catch(() => null) !== identity) return pending.length;
  const referenced = retainedOriginalNames(root, manifest, new Set(pending.map(([name]) => purgeFilenamePattern.exec(name)?.groups.id)));
  const waiting = [];
  for (const [name, stamp] of pending) {
    // An import can reuse its previous ID, and remaining history can keep other versions.
    if (referenced.has(name)) continue;
    const file = path.join(originalRoot, name);
    try {
      const stat = await fs.lstat(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || sourceStamp(stat) !== stamp ||
          await directoryIdentity(root) !== identity || await directoryIdentity(originalRoot) !== originalIdentity) {
        waiting.push([name, stamp]);
        continue;
      }
      await fs.unlink(file);
    } catch (error) {
      if (error.code !== 'ENOENT') waiting.push([name, stamp]);
    }
  }
  if (waiting.length === pending.length) return waiting.length;
  if (waiting.length) manifest.pendingPurge = waiting;
  else delete manifest.pendingPurge;
  // If saving the shorter journal fails, the next retry can safely skip files already gone.
  try { await writeManifest(root, identity, manifest); }
  catch { return pending.length; }
  return waiting.length;
}

async function purgeTrash(root, identity, manifest, command) {
  if (command.revision !== String(manifest.revision)) throw new Error('回收站已更新，请重新确认要删除的素材。');
  const selected = command.all === true
    ? Object.values(manifest.assets).filter(asset => asset.trashed)
    : requestedAssets(manifest, command.ids);
  if (!selected.length || selected.some(asset => !asset.trashed)) {
    throw new Error('请选择仍在回收站中的素材。');
  }

  const removed = new Set(selected.map(asset => asset.id));
  const current = await trashPurgeFiles(root, identity, selected, command.mediaRevisions);
  const previous = new Map(selected.map(asset => [fileForAsset(root, asset), null]));
  const discardedRedo = dropRedo(manifest);
  for (const asset of discardedRedo) {
    if (!removed.has(asset.id)) continue;
    const file = fileForAsset(root, asset);
    if (!previous.has(file)) previous.set(file, asset);
  }
  for (const change of manifest.undo) {
    for (const [id, asset] of change.assets) {
      if (!removed.has(id)) continue;
      const file = fileForAsset(root, asset);
      if (!previous.has(file)) previous.set(file, asset);
    }
    change.assets = change.assets.filter(([id]) => !removed.has(id));
    change.imported = change.imported.filter(id => !removed.has(id));
  }
  const versions = await trashPurgeFiles(root, identity, [...previous.values()].filter(Boolean));
  manifest.undo = manifest.undo.filter(change => change.assets.length || change.collections.length || change.imported.length);
  for (const id of removed) delete manifest.assets[id];
  manifest.pendingPurge = [...new Map([...(manifest.pendingPurge ?? []), ...current, ...versions])];
  await journalRetiredOriginals(root, identity, manifest, discardedRedo);
  await commit(root, identity, manifest);
  const pendingPurge = await finishTrashPurge(root, identity, manifest);
  return { count: selected.length, pendingPurge, revision: String(manifest.revision),
    message: pendingPurge ? `已永久删除 ${selected.length} 项素材。有 ${pendingPurge} 份原件等待清理，可稍后重试。`
      : `已永久删除 ${selected.length} 项素材。` };
}

function expireLocalTrash(root, { expectedLibraryId, expectedIdentity, mediaRevisions, now = Date.now() }) {
  return queueWrite(root, async () => {
    const { identity, manifest } = await readManifest(root, expectedLibraryId);
    if (expectedIdentity !== identity) throw invalidLibrary();
    const timestamp = new Date(now).toISOString();
    const cutoff = now - trashRetentionMs;
    const expired = [];
    let dated = false;
    for (const asset of Object.values(manifest.assets)) {
      if (!asset.trashed) continue;
      const deleted = typeof asset.trashedAt === 'string' ? Date.parse(asset.trashedAt) : NaN;
      if (!Number.isFinite(deleted)) {
        // Older libraries only stored the flag. Start their retention clock on
        // this check instead of inferring the deletion date from the file.
        asset.trashedAt = timestamp;
        dated = true;
      } else if (deleted < cutoff && (!mediaRevisions || mediaRevisions.has(asset.id))) expired.push(asset.id);
    }
    if (expired.length) {
      await purgeTrash(root, identity, manifest, {
        ids: expired, revision: String(manifest.revision), mediaRevisions,
      });
      return true;
    }
    if (dated) await commit(root, identity, manifest);
    const waiting = manifest.pendingPurge?.length ?? 0;
    return (await finishTrashPurge(root, identity, manifest)) < waiting || dated;
  });
}

function mutateLocalLibrary(root, command) {
  if (!isRecord(command)) throw new Error('操作参数不正确。');
  return queueWrite(root, async () => {
    const { identity, manifest } = await readManifest(root, command.expectedLibraryId);
    if (command.purgeRootIdentity !== undefined && command.purgeRootIdentity !== identity) {
      throw new Error('素材库位置已变化，请重新打开回收站。');
    }
    if (command.action === 'purgeTrash') return purgeTrash(root, identity, manifest, command);
    if (command.action === 'retryPurge') {
      const pendingPurge = await finishTrashPurge(root, identity, manifest);
      return { pendingPurge, revision: String(manifest.revision), message: pendingPurge ?
        `仍有 ${pendingPurge} 份原件等待清理，请检查文件占用和权限后重试。` : '回收站原件已清理。' };
    }
    const group = command.action === 'applySuggestion' && typeof command.undoGroup === 'string' &&
      /^suggestions:[a-f0-9-]{36}$/.test(command.undoGroup) ? command.undoGroup : null;
    const changes = undoRecord(group);
    const expired = [];
    let result;
    switch (command.action) {
      case 'rename':
      case 'planRename': result = renameAssets(manifest, command, changes); break;
      case 'edit':
      case 'trash':
      case 'restore': result = applyAssets(manifest, command, changes); break;
      case 'mergeDuplicates': result = await mergeDuplicates(root, manifest, command, changes); break;
      case 'planTagChange':
      case 'changeTag': {
        const plan = tagChangePlan(Object.values(manifest.assets), command, String(manifest.revision));
        if (command.action === 'changeTag') {
          for (const { asset, tags } of plan.updates) {
            changes.assets.push([asset.id, asset]);
            manifest.assets[asset.id] = { ...asset, tags };
          }
        }
        result = plan.result;
        break;
      }
      case 'applySuggestion': result = applySuggestion(manifest, command, changes); break;
      case 'createCollection':
      case 'editCollection':
      case 'deleteCollection': result = changeCollection(manifest, command, changes); break;
      case 'undo': result = { undone: undoLatest(manifest, expired) }; break;
      case 'redo':
        if (command.revision !== undefined && command.revision !== String(manifest.revision)) {
          throw new Error('素材库已更新，请重新选择要重做的操作。');
        }
        result = { redone: await redoLatest(root, manifest, expired) };
        break;
      default: throw new Error('此操作未受支持。');
    }
    if (result.undone || result.redone || recordUndo(manifest, changes, expired)) {
      await commit(root, identity, manifest, expired);
    }
    return { ...result, revision: String(manifest.revision) };
  });
}

function importCollections(manifest, input, changes) {
  const ids = new Set(validCollections(manifest, input.collectionIds ?? []));
  if (!Array.isArray(input.collectionPaths)) return [...ids];
  const anchor = manifest.collections[input.collectionParentId]?.id ?? null;
  for (const segments of input.collectionPaths.slice(0, 256)) {
    if (!Array.isArray(segments) || !segments.length || segments.length > 127) continue;
    let parentId = anchor;
    for (const segment of segments) {
      const name = requiredName(segment);
      parentId = matchingCollection(manifest, name, parentId)?.id ?? createCollection(manifest, changes, name, parentId);
    }
    ids.add(parentId);
  }
  return [...ids];
}

function validateEditedImage(input) {
  const { bytes, format, width, height } = input ?? {};
  const invalid = new Error('无法保存，生成的图像格式或尺寸不正确。');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 24 || bytes.byteLength > editedImageLimit ||
      !dimension(width) || !dimension(height) || width > 16_384 || height > 16_384 || width * height > 40_000_000) throw invalid;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const png = buffer.length >= 45 && buffer.subarray(0, 8).equals(pngSignature) && buffer.readUInt32BE(8) === 13 &&
    buffer.readUInt32BE(buffer.length - 12) === 0 && buffer.toString('ascii', buffer.length - 8, buffer.length - 4) === 'IEND';
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.readUInt16BE(buffer.length - 2) === 0xffd9;
  const webp = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' &&
    buffer.readUInt32LE(4) === buffer.length - 8;
  if (!((format === 'png' && png) || (format === 'jpeg' && jpeg) || (format === 'webp' && webp))) throw invalid;
  const [actualWidth, actualHeight] = imageDimensions(buffer);
  if (actualWidth !== width || actualHeight !== height) throw invalid;
  return buffer;
}

async function hasSingleImage(handle, length, format) {
  const header = Buffer.alloc(32);
  const read = async (size, offset) => (await handle.read(header, 0, size, offset)).bytesRead === size;
  if (format === 'jpeg') {
    if (!await read(2, 0) || header.readUInt16BE(0) !== 0xffd8) return false;
    let offset = 2;
    for (let index = 0; index < 1024 && offset + 4 <= length; index++) {
      if (!await read(4, offset) || header[0] !== 0xff) return false;
      if (header[1] === 0xff) { offset++; continue; }
      const segmentSize = header.readUInt16BE(2);
      if (segmentSize < 2 || offset + 2 + segmentSize > length) return false;
      if (header[1] === 0xda) return true;
      if (header[1] === 0xe2 && segmentSize >= 6 && await read(4, offset + 4) && header.toString('ascii', 0, 4) === 'MPF\0') return false;
      offset += 2 + segmentSize;
    }
    return false;
  }
  if (format === 'webp') {
    return length >= 20 && await read(20, 0) && header.toString('ascii', 0, 4) === 'RIFF' &&
      header.readUInt32LE(4) === length - 8 && header.toString('ascii', 8, 12) === 'WEBP' &&
      (['VP8 ', 'VP8L'].includes(header.toString('ascii', 12, 16)) ||
        (header.toString('ascii', 12, 16) === 'VP8X' && header.readUInt32LE(16) === 10 &&
          await read(1, 20) && (header[0] & 2) === 0));
  }
  if (!await read(8, 0) || !header.subarray(0, 8).equals(pngSignature)) return false;
  let offset = 8;
  for (let index = 0; index < 1024 && offset + 12 <= length; index++) {
    if (!await read(8, offset)) return false;
    const kind = header.toString('ascii', 4, 8);
    offset += header.readUInt32BE(0) + 12;
    if (offset > length || kind === 'acTL' || (index === 0 && kind !== 'IHDR')) return false;
    if (kind === 'IDAT') return true;
  }
  return false;
}

function replaceLocalPicture(root, input) {
  const bytes = validateEditedImage(input);
  return queueWrite(root, async () => {
    const { identity, manifest } = await readManifest(root, input.expectedLibraryId);
    const asset = manifest.assets[input.id];
    if (!asset || asset.kind !== 'image' || asset.trashed || !Object.hasOwn(editedFormats, asset.extension) ||
        editedFormats[asset.extension] !== input.format) throw new Error('这个素材可以导出编辑副本。');
    const originalRoot = path.join(root, ORIGINALS);
    const originalIdentity = await directoryIdentity(originalRoot);
    const latest = async () => {
      const source = await openLocalOriginal(root, asset);
      try {
        const stat = await source.stat({ bigint: true });
        if (mediaStamp(stat) !== input.revision) throw new Error('原件已变化，请重新打开图片工具。');
        return source;
      } catch (error) {
        await source.close();
        throw error;
      }
    };
    const original = await latest();
    try {
      if (!await hasSingleImage(original, asset.byteCount, input.format)) {
        throw new Error('这个原件可能包含动画或其他图像，请导出静态副本。');
      }
    } finally { await original.close(); }
    const updated = { ...asset, fileVersion: randomUUID(), byteCount: bytes.length, width: input.width, height: input.height,
      modifiedAt: new Date().toISOString() };
    const target = fileForAsset(root, updated);
    let written;
    let committed = false;
    try {
      const handle = await fs.open(target, 'wx', 0o600);
      try {
        written = await handle.stat({ bigint: true });
        await handle.writeFile(bytes);
        await handle.sync();
      } finally { await handle.close(); }
      if (await directoryIdentity(originalRoot) !== originalIdentity) throw invalidLibrary();
      await (await latest()).close();
      manifest.assets[input.id] = updated;
      const changes = undoRecord();
      changes.assets.push([input.id, asset]);
      const expired = [];
      recordUndo(manifest, changes, expired);
      await commit(root, identity, manifest, expired);
      committed = true;
      return { id: input.id, revision: String(manifest.revision) };
    } finally {
      if (written && !committed && await directoryIdentity(originalRoot).catch(() => null) === originalIdentity) {
        const stat = await fs.lstat(target, { bigint: true }).catch(() => null);
        if (stat?.isFile() && stat.dev === written.dev && stat.ino === written.ino) await fs.unlink(target).catch(() => {});
      }
    }
  });
}

function sourceStamp(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function writeOriginal(target, input, linkContent, probe) {
  const bytes = linkContent ?? input.bytes;
  let source;
  let targetHandle;
  try {
    const report = typeof input.onProgress === 'function' ? input.onProgress : null;
    if (bytes === undefined) source = await input.open();
    const before = source && await source.stat({ bigint: true });
    const byteCount = before ? Number(before.size) : bytes.byteLength;
    if ((before && !before.isFile()) || !validSize(byteCount)) throw new Error('无法读取这个文件。');
    targetHandle = await fs.open(target, probe ? 'wx+' : 'wx', 0o600);
    let reported = 0;
    if (source) {
      let copied = 0;
      const chunk = Buffer.allocUnsafe(Math.min(Math.max(byteCount, 1), 256 * 1024));
      while (copied < byteCount) {
        const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.length, byteCount - copied), copied);
        if (bytesRead === 0) break;
        let written = 0;
        while (written < bytesRead) {
          const { bytesWritten } = await targetHandle.write(chunk, written, bytesRead - written, copied + written);
          if (bytesWritten === 0) throw new Error('无法写入这个文件。');
          written += bytesWritten;
        }
        copied += bytesRead;
        if (report && byteCount && copied / byteCount - reported >= 0.01) {
          reported = Math.min(1, copied / byteCount);
          report(reported);
        }
      }
      if (copied !== byteCount || sourceStamp(before) !== sourceStamp(await source.stat({ bigint: true }))) {
        throw new Error('复制时源文件发生变化，请重新导入。');
      }
    } else await targetHandle.writeFile(bytes);
    await targetHandle.sync();
    const dimensions = probe ? await readImageDimensions(targetHandle, byteCount) : [];
    await targetHandle.close();
    targetHandle = null;
    if (!source || byteCount === 0 || reported < 1) report?.(1);
    return { byteCount, dimensions, ...(input.captureThumbnailProof && before && { sourceStamp: sourceStamp(before) }) };
  } finally {
    await targetHandle?.close();
    await source?.close();
  }
}

function importLocalAsset(root, input) {
  if (!isRecord(input) || typeof input.jobId !== 'string' || input.jobId.length < 1 || input.jobId.length > 256) {
    throw new Error('导入任务标识不正确。');
  }
  return queueWrite(root, async () => {
    const { identity, manifest } = await readManifest(root, input.expectedLibraryId);
    const id = createHash('sha256').update(manifest.libraryId).update('\0').update(input.jobId).digest('hex');
    if (manifest.assets[id]) return { id, revision: String(manifest.revision), existing: true };
    if (Object.keys(manifest.assets).length >= maximumEntries) throw new Error('本地素材库的素材数量已达上限。');
    if (input.bytes !== undefined && !(input.bytes instanceof Uint8Array)) throw new Error('导入内容不正确。');
    const linkOnly = input.bytes === undefined && typeof input.open !== 'function';
    let sourceURL = null;
    if (linkOnly) sourceURL = normalizedURL(input.sourceURL);
    else {
      try { sourceURL = normalizedURL(input.sourceURL); }
      catch { /* Unsupported source schemes are not opened as web links. */ }
    }
    if (linkOnly && !sourceURL) throw new Error('找不到要导入的内容。');
    const linkContent = linkOnly ? Buffer.from(`[InternetShortcut]\r\nURL=${sourceURL}\r\n`, 'utf8') : undefined;
    const givenFile = typeof input.filename === 'string' ? path.win32.basename(input.filename) : '';
    const filename = linkOnly ? `${new URL(sourceURL).hostname}.url` : givenFile;
    const suffix = path.extname(filename).slice(1).toLowerCase();
    const extension = extensionPattern.test(suffix) ? suffix : '';
    const kind = linkOnly ? 'link' : supportedKinds.has(input.kind) ? input.kind :
      Object.keys(mediaKinds).find(type => mediaKinds[type].has(extension)) ?? 'document';
    const now = new Date().toISOString();
    const name = canonicalAssetName(input.name || path.parse(filename).name || '素材', extension);
    const group = typeof input.undoGroup === 'string' && input.undoGroup.length <= 256 ? input.undoGroup : null;
    const changes = undoRecord(group);
    const asset = {
      id, name, extension, kind, createdAt: dateISO(input.createdAt) ?? now, importedAt: now,
      tags: normalizedTags(input.tags ?? []), collectionIds: importCollections(manifest, input, changes),
      favorite: input.favorite === true, rating: ratingValue(input.rating ?? 0), note: cleanText(input.note, 12_288, true),
      sourceURL, trashed: false, duration: Number.isFinite(input.duration) && input.duration >= 0 ? input.duration : null,
    };
    const originalRoot = path.join(root, ORIGINALS);
    const originalIdentity = await directoryIdentity(originalRoot);
    const target = fileForAsset(root, asset);
    const temporary = path.join(originalRoot, `.jiancang-${randomUUID()}.tmp`);
    const probe = kind === 'image' && !(dimension(input.width) && dimension(input.height));
    let published;
    let committed = false;
    try {
      const { byteCount, dimensions, sourceStamp: copiedStamp } = await writeOriginal(temporary, input, linkContent, probe);
      if (await directoryIdentity(root) !== identity || await directoryIdentity(originalRoot) !== originalIdentity) throw invalidLibrary();
      const written = await fs.lstat(temporary, { bigint: true });
      await fs.rename(temporary, target);
      published = written;
      const destination = copiedStamp ? await fs.lstat(target, { bigint: true }).catch(() => null) : null;
      const thumbnailProof = destination?.isFile() && !destination.isSymbolicLink() && destination.dev === written.dev &&
        destination.ino === written.ino && destination.size === written.size && destination.mtimeNs === written.mtimeNs
        ? { sourceStamp: copiedStamp, destinationStamp: sourceStamp(destination), mediaRevision: mediaStamp(destination) } : null;
      manifest.assets[id] = { ...asset, byteCount, width: dimension(input.width) || dimension(dimensions[0]), height: dimension(input.height) || dimension(dimensions[1]) };
      changes.imported.push(id);
      const expired = [];
      recordUndo(manifest, changes, expired);
      await commit(root, identity, manifest, expired);
      committed = true;
      return { id, revision: String(manifest.revision), existing: false, ...(thumbnailProof && { thumbnailProof }) };
    } finally {
      if (await directoryIdentity(originalRoot).catch(() => null) === originalIdentity) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        if (published && !committed) {
          const entry = await fs.lstat(target, { bigint: true }).catch(() => null);
          if (entry?.isFile() && entry.dev === published.dev && entry.ino === published.ino) await fs.rm(target, { force: true }).catch(() => {});
        }
      }
    }
  });
}

module.exports = { LOCAL_MANIFEST, parseManifest, createLocalLibrary, readLocalLibrary, openLocalOriginal, mutateLocalLibrary, importLocalAsset,
  duplicateMergeMetadata, expireLocalTrash,
  validateEditedImage, replaceLocalPicture, historyAssetRecords };
