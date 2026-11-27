'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isWithin, openContainedFile } = require('./original-file.cjs');
const { sourceStamp, thumbnailSourceRevision } = require('./thumbnail-cache.cjs');

const MiB = 1024 ** 2;
const maximumEntries = 100_000;
const diagnosticLimit = 120;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const kinds = {
  image: new Set('jpg jpeg png gif webp heic heif avif bmp tiff tif ico svg psd psb ai eps raw dng cr2 cr3 nef arw orf raf livp'.split(' ')),
  video: new Set('mp4 m4v mov webm ogv avi mkv wmv flv mpg mpeg mts m2ts 3gp'.split(' ')),
  audio: new Set('mp3 m4a wav aiff ogg flac aac ape opus wma mid midi'.split(' ')),
  pdf: new Set(['pdf']),
};
const linkTypes = new Set(['url', 'webloc', 'website', 'webpage']);
const thumbnailExtensions = new Set(['jpeg', 'jpg', 'png', 'gif', 'webp', 'bmp', 'avif']);
const folderColors = new Map(Object.entries({
  red: 'CB594E', orange: 'CF893D', yellow: 'BEA33D', green: '46786B',
  aqua: '438F9B', blue: '527FA7', purple: '886CA8', pink: 'B76E93',
}));

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = value => typeof value === 'string' && /^[a-z0-9_-]{1,128}$/i.test(value);
const canonicalName = value => value.normalize('NFC').toLowerCase();
const extensionOf = filename => path.extname(filename).slice(1).toLowerCase();

function text(value, limit) {
  if (typeof value !== 'string') return '';
  return value.slice(0, limit).trim();
}

function numeric(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return 0;
  return Number(value) || 0;
}

function dateISO(value) {
  const timestamp = numeric(value);
  return timestamp > 0 && timestamp < 253_402_300_800_000 ? new Date(timestamp).toISOString() : null;
}

function webURL(value) {
  const candidate = text(value, 4096);
  try {
    const url = new URL(candidate);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? candidate : null;
  } catch { return null; }
}

function fileIsThumbnail(name) {
  return thumbnailExtensions.has(extensionOf(name)) && path.parse(name).name.toLowerCase().endsWith('_thumbnail');
}

function invalidLibrary() {
  return new Error('请选择包含 metadata.json 和 images 文件夹的 Eagle .library 目录。');
}

function metadataFailure(code) {
  return Object.assign(new Error('无法读取 Eagle 素材目录信息。'), { code });
}

function diagnosticText(value, limit = 240) {
  return text(value, limit).replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '�');
}

function scanLimit() {
  const error = new Error('此 Eagle 素材库超出当前版本可读取的大小。');
  error.code = 'EAGLE_SCAN_LIMIT';
  return error;
}

async function openDirectory(root, directory) {
  if (!isWithin(root, directory)) throw invalidLibrary();
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      path.relative(directory, await fs.realpath(directory)) !== '') throw invalidLibrary();
  return fs.opendir(directory);
}

async function resolveEagleReadingDirectory(root, relative) {
  if (typeof relative !== 'string' || !/^images\/[a-z0-9_-]{1,128}\.info$/i.test(relative)) throw invalidLibrary();
  const directory = path.join(root, ...relative.split('/'));
  const entries = await openDirectory(root, directory);
  await entries.close();
  return directory;
}

async function readMetadata(root, file, maximumBytes, budget) {
  let handle;
  try { handle = await openContainedFile(root, file); }
  catch (error) { if (error.code) throw error; throw metadataFailure('unsafe-path'); }
  try {
    const { size } = await handle.stat();
    if (size > maximumBytes) throw metadataFailure('metadata-size');
    budget.remaining -= size;
    if (budget.remaining < 0) throw scanLimit();
    const buffer = Buffer.allocUnsafe(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== size) throw metadataFailure('metadata-changing');
    let metadata;
    try { metadata = JSON.parse(utf8.decode(buffer.subarray(0, length))); }
    catch { throw metadataFailure('metadata-json'); }
    if (!record(metadata)) throw metadataFailure('metadata-json');
    return metadata;
  } finally { await handle.close(); }
}

function projectFolders(header) {
  if (header.folders != null && !Array.isArray(header.folders)) throw invalidLibrary();
  const entries = list(header.folders).map(folder => ({ folder, parentId: null, depth: 0 })).reverse();
  const collections = new Map();
  let skipped = 0;
  const issues = [];
  let examined = 0;
  while (entries.length) {
    if (++examined > maximumEntries) throw scanLimit();
    const { folder, parentId, depth } = entries.pop();
    const name = text(folder?.name, 1024);
    if (depth >= 128 || !identity(folder?.id) || !name || collections.has(folder.id)) {
      skipped++;
      if (issues.length < diagnosticLimit) {
        issues.push({ kind: 'collection', reason: 'collection-metadata', itemId: diagnosticText(folder?.id),
          name: diagnosticText(folder?.name), path: 'metadata.json' });
      }
      continue;
    }
    collections.set(folder.id, { id: folder.id, parentId, name, color: folderColors.get(folder.iconColor) || '46786B' });
    const children = list(folder.children);
    for (let index = children.length - 1; index >= 0; index--) {
      entries.push({ folder: children[index], parentId: folder.id, depth: depth + 1 });
    }
  }
  return { collections, skipped, issues };
}

async function itemFiles(directory, name, extension, announcedSize) {
  const entries = await openDirectory(directory, directory);
  const originals = [];
  const thumbnails = [];
  const expectedNames = new Set(!name ? [] : [name + (extension ? '.' + extension : ''), name]);
  const foldedNames = new Set([...expectedNames].map(canonicalName));
  const thumbnailBase = canonicalName(path.parse(name).name + '_thumbnail');
  let examined = 0;
  let linkedOriginal = false;
  for await (const entry of entries) {
    if (++examined > 1000) throw scanLimit();
    const filename = entry.name;
    if (entry.isSymbolicLink() && (!extension || extensionOf(filename) === extension) && !fileIsThumbnail(filename)) {
      linkedOriginal = true;
    }
    if (!entry.isFile() || entry.isSymbolicLink() || filename.startsWith('.') ||
        ['metadata.json', 'mtime.json'].includes(filename.toLowerCase())) continue;
    if (fileIsThumbnail(filename) && !foldedNames.has(canonicalName(filename))) thumbnails.push(filename);
    else if (!extension || extensionOf(filename) === extension) originals.push(filename);
  }
  const exactMatches = originals.filter(candidate => expectedNames.has(candidate));
  const foldedMatches = originals.filter(candidate => foldedNames.has(canonicalName(candidate)));
  const match = (exactMatches.length === 1 ? exactMatches[0] : null) || (foldedMatches.length === 1 ? foldedMatches[0] : null) ||
    (originals.length === 1 ? originals[0] : null);
  const thumbnailName = thumbnails.find(candidate => canonicalName(path.parse(candidate).name) === thumbnailBase) ||
    (thumbnails.length === 1 ? thumbnails[0] : null);

  async function inspect(filename, maximumBytes) {
    if (!filename) return null;
    const file = path.join(directory, filename);
    try {
      const stat = await fs.lstat(file, { bigint: true });
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0n && stat.size <= BigInt(maximumBytes) &&
          path.relative(file, await fs.realpath(file)) === '') {
        return { file, byteCount: Number(stat.size), extension: extensionOf(filename),
          modified: Number(stat.mtimeMs), stamp: sourceStamp(stat) };
      }
    } catch {}
    return null;
  }
  const original = await inspect(match, 16 * 1024 * MiB);
  const available = original && (!announcedSize || original.byteCount === announcedSize);
  const reason = match ? original && !available ? 'original-incomplete' : 'original-unreadable'
    : originals.length > 1 ? 'original-ambiguous' : linkedOriginal ? 'unsafe-path' : 'original-missing';
  return {
    original: available ? original : null,
    thumbnail: await inspect(thumbnailName, 24 * MiB),
    problem: available ? null : { reason, candidate: diagnosticText(match, 255) },
  };
}

async function projectItem(root, directory, fileID, metadata, collections) {
  if (metadata.id != null && metadata.id !== fileID) throw metadataFailure('metadata-id');
  const name = text(metadata.name, 1024);
  const declaredExtension = text(metadata.ext, 64).replace(/^\./, '').toLowerCase();
  if (declaredExtension && !/^[a-z0-9_+-]{1,32}$/.test(declaredExtension)) throw metadataFailure('metadata-type');
  const trashed = metadata.isDeleted === true || metadata.isDeleted === 1 ||
    (typeof metadata.isDeleted === 'string' && /^(true|1)$/i.test(metadata.isDeleted));
  const sourceURL = webURL(metadata.url);
  const declaredSize = numeric(metadata.size);
  const announcedSize = Number.isSafeInteger(declaredSize) && declaredSize > 0 ? declaredSize : null;
  const { original, thumbnail, problem } = await itemFiles(directory, name, declaredExtension, announcedSize);
  const extension = original?.extension || declaredExtension;
  const isLink = !!sourceURL && (linkTypes.has(extension) || (!extension && !original));
  const kind = isLink ? 'link' : Object.keys(kinds).find(key => kinds[key].has(extension)) || 'document';
  const id = hash(`eagle-item\0${root}\0${fileID}`);
  const rating = Math.max(0, Math.min(5, Math.trunc(numeric(metadata.star))));
  const createdAt = dateISO(metadata.btime) || dateISO(original?.modified);
  const dimensions = ['width', 'height'].map(field => {
    const value = numeric(metadata[field]);
    return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000 ? value : 0;
  });
  const seconds = numeric(metadata.duration);
  const duration = (kind === 'audio' || kind === 'video') && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  const collectionIds = [...new Set(list(metadata.folders).filter(folder => collections.has(folder)))];
  return {
    asset: {
      id, eagleItemId: fileID, name: name || (original && path.parse(original.file).name) || fileID, kind, extension,
      mediaRevision: thumbnailSourceRevision(original?.stamp, thumbnail?.stamp),
      byteCount: original?.byteCount ?? announcedSize ?? 0, width: dimensions[0], height: dimensions[1], duration,
      createdAt, importedAt: dateISO(metadata.btime) || dateISO(metadata.mtime) || createdAt,
      tags: [...new Set(list(metadata.tags).slice(0, 256).map(tag => text(tag, 512)).filter(Boolean))],
      collectionIds, favorite: metadata.favorite === true, rating,
      note: text(metadata.annotation, 12_288), sourceURL, trashed, available: !!original, thumbnailAvailable: !!thumbnail,
    },
    original,
    thumbnail,
    problem,
  };
}

function directoryIssue(error) {
  switch (error.code) {
    case 'ENOENT': return 'metadata-missing';
    case 'EACCES': case 'EPERM': return 'permission';
    case 'unsafe-path': case 'metadata-size': case 'metadata-changing': case 'metadata-json':
    case 'metadata-id': case 'metadata-type': return error.code;
    default: return 'metadata-unreadable';
  }
}

async function readEagleLibrary(root) {
  const budget = { remaining: 128 * MiB };
  let header;
  try { header = await readMetadata(root, path.join(root, 'metadata.json'), 32 * MiB, budget); }
  catch (error) { if (error.code === 'EAGLE_SCAN_LIMIT') throw error; throw invalidLibrary(); }
  const { collections, skipped, issues: collectionIssues } = projectFolders(header);
  const directoryName = text(header.name, 1024) || path.basename(root).replace(/\.library$/i, '');
  const sourceIdentity = text(header.id, 1024);
  const libraryId = hash(`eagle-library\0${sourceIdentity || root}`);
  const originals = new Map();
  const sourceThumbnails = new Map();
  const assets = [];
  const warnings = [];
  const metadataIssues = [];
  const originalIssues = [];
  let examined = 0;
  let missing = 0;
  let unreadable = 0;
  const images = path.join(root, 'images');
  const entries = await openDirectory(root, images).catch(() => { throw invalidLibrary(); });
  for await (const entry of entries) {
    if (++examined > maximumEntries * 2) throw scanLimit();
    if (path.extname(entry.name).toLowerCase() !== '.info') continue;
    const fileID = path.parse(entry.name).name;
    const safeDirectory = identity(fileID) && !entry.isSymbolicLink() && entry.isDirectory();
    const relative = `images/${diagnosticText(entry.name, 255)}`;
    if (!safeDirectory) {
      unreadable++;
      if (metadataIssues.length < diagnosticLimit) {
        metadataIssues.push({ kind: 'metadata', itemId: diagnosticText(fileID), reason: 'directory-type', path: relative });
      }
      continue;
    }
    const directory = path.join(images, entry.name);
    let metadata;
    try {
      metadata = await readMetadata(images, path.join(directory, 'metadata.json'), 4 * MiB, budget);
      const { asset, original, thumbnail, problem } = await projectItem(root, directory, fileID, metadata, collections);
      if (original) originals.set(asset.id, original.file);
      if (thumbnail) sourceThumbnails.set(asset.id, thumbnail);
      if (!asset.available && !asset.trashed && asset.kind !== 'link') {
        missing++;
        if (originalIssues.length < diagnosticLimit) {
          originalIssues.push({ kind: 'original', itemId: fileID, name: diagnosticText(asset.name),
            assetId: asset.id, reason: problem.reason, directory: relative,
            path: problem.candidate ? `${relative}/${problem.candidate}` : relative });
        }
      }
      assets.push(asset);
      if (assets.length > maximumEntries) throw scanLimit();
    } catch (error) {
      if (error.code === 'EAGLE_SCAN_LIMIT') throw error;
      unreadable++;
      if (metadataIssues.length < diagnosticLimit) {
        metadataIssues.push({ kind: 'metadata', itemId: fileID, name: diagnosticText(metadata?.name),
          reason: directoryIssue(error), directory: relative, path: `${relative}/metadata.json` });
      }
    }
  }
  if (skipped) warnings.push(`有 ${skipped} 个 Eagle 文件夹无法读取，其他文件夹仍可浏览。`);
  if (unreadable) warnings.push(`有 ${unreadable} 份 Eagle 素材的目录信息无法读取。`);
  if (missing) warnings.push(`有 ${missing} 份 Eagle 原件暂不可用，请在资源管理器中检查文件后刷新。`);
  assets.sort((left, right) => (right.importedAt || '').localeCompare(left.importedAt || '') || left.id.localeCompare(right.id));
  const readingIssues = { total: skipped + unreadable + missing,
    entries: [metadataIssues, originalIssues, collectionIssues].flatMap(rows =>
      rows.sort((left, right) => (left.path || '').localeCompare(right.path || '') || (left.itemId || '').localeCompare(right.itemId || ''))) };
  return {
    kind: 'eagle', directoryName, libraryId, format: null, pathIndependentIdentity: !!sourceIdentity,
    assets, collections: [...collections.values()], originals, sourceThumbnails, warnings, readingIssues,
    partial: warnings.length > 0, logIncomplete: false,
  };
}

module.exports = { readEagleLibrary, resolveEagleReadingDirectory };
