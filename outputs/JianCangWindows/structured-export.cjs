'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { exportBatch } = require('./batch-export.cjs');
const { exportFilename, isWithin } = require('./original-file.cjs');

const manifestName = '素材清单.csv';
const maximumSelection = 20_000;
const maximumComponentBytes = 92;
const reservedDevice = /^(?:CONIN\$|CONOUT\$)(?:\.|$)/i;
const headers = ['素材名称', '素材库', '所属集合', '格式', '大小（字节）', '尺寸', '创建时间', '导入时间',
  '标签', '评分', '收藏', '备注', '来源网址', '相对文件路径', '导出结果'];

const text = value => typeof value === 'string' ? value : '';
const keyOf = value => value.normalize('NFC').toLowerCase();
const samePath = (left, right) => path.relative(left, right) === '';
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function safeComponent(name, suffix = '') {
  const budget = maximumComponentBytes - Buffer.byteLength(suffix);
  const safe = exportFilename(text(name).normalize('NFC'), '');
  const reserved = reservedDevice.test(safe) ? `_${safe}` : safe;
  let output = '';
  let bytes = 0;
  for (const character of reserved) {
    const length = Buffer.byteLength(character);
    if (bytes + length > budget) break;
    output += character;
    bytes += length;
  }
  return (output.replace(/[ .]+$/u, '') || '素材') + suffix;
}

function collectionPaths(asset, collections) {
  const paths = [];
  for (const id of asset?.collectionIds ?? []) {
    let current = collections.get(id);
    const lineage = [];
    const seen = new Set();
    while (current && !seen.has(current.id) && lineage.length < 128) {
      seen.add(current.id);
      lineage.push(current);
      current = collections.get(current.parentId);
    }
    if (lineage.length) paths.push(lineage.reverse());
  }
  return paths.sort((left, right) => right.length - left.length || compare(left.at(-1).id, right.at(-1).id));
}

function allocateFolder(parent, logicalID, label) {
  if (parent.children.has(logicalID)) return parent.children.get(logicalID);
  let sequence = 1;
  let name;
  do { name = safeComponent(label, sequence === 1 ? '' : ` (${sequence})`); sequence++; }
  while (parent.usedNames.has(keyOf(name)));
  parent.usedNames.add(keyOf(name));
  const node = { parts: [...parent.parts, name], children: new Map(), usedNames: new Set() };
  parent.children.set(logicalID, node);
  return node;
}

function buildPlan(items, options = {}) {
  if (!Array.isArray(items) || !items.length) throw new Error('请先选择要导出的素材。');
  if (items.length > maximumSelection) throw new Error('每批最多可导出 20,000 份素材，请缩小选择范围。');
  const { layout = 'flat', includeMetadata = false } = options;
  if (!['flat', 'collections'].includes(layout) || typeof includeMetadata !== 'boolean') throw new Error('导出选项不正确。');
  const folderTree = { parts: [], children: new Map(), usedNames: new Set(includeMetadata ? [keyOf(manifestName)] : []) };
  const foldersByLibrary = new Map();
  const records = items.map(item => {
    const { library, asset } = item.original ?? {};
    const name = text(item.name || asset?.name) || '未命名素材';
    const libraryID = text(library?.registrationId) || 'unknown';
    if (!foldersByLibrary.has(libraryID)) {
      foldersByLibrary.set(libraryID, new Map((library?.publicLibrary?.collections ?? []).map(folder => [folder.id, folder])));
    }
    const memberships = layout === 'collections' || includeMetadata ? collectionPaths(asset, foldersByLibrary.get(libraryID)) : [];
    return { item, asset, name, libraryID, memberships,
      libraryName: text(library?.publicLibrary?.directoryName || item.reference?.board?.source) || '素材库', available: item.available !== false,
      parts: [], relativePath: '', failure: '' };
  });

  if (layout === 'collections') {
    // Assign aliases by stable IDs before copying, regardless of the gallery's sort order.
    const ordered = records.filter(record => record.available).sort((left, right) =>
      compare(left.libraryID, right.libraryID) || compare(left.memberships[0]?.map(folder => folder.id).join('/') || '',
        right.memberships[0]?.map(folder => folder.id).join('/') || ''));
    for (const record of ordered) {
      let folder = allocateFolder(folderTree, record.libraryID, record.libraryName);
      const chain = record.memberships[0];
      if (!chain) folder = allocateFolder(folder, 'unfiled', '未分类');
      else for (const part of chain) folder = allocateFolder(folder, `collection:${part.id}`, part.name);
      record.parts = folder.parts;
    }
  }

  const byFolder = new Map();
  for (const record of records) {
    if (!record.available) continue;
    const folder = record.parts.join('/');
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(record);
  }
  return { records, byFolder, includeMetadata };
}

function planStructuredExport(items, options) {
  const { records, byFolder } = buildPlan(items, options);
  const available = records.filter(record => record.available).length;
  return { total: records.length, available, unavailable: records.length - available, folderCount: byFolder.size,
    examples: [...byFolder].slice(0, 4).map(([folder, rows]) => ({ name: rows[0].name, folder })) };
}

function filesystemMessage(error) {
  if (error.code === 'ENOSPC') return '目标磁盘空间不足。';
  if (error.code === 'ENAMETOOLONG') return '导出路径过长，请选择更短的目标路径。';
  return error.code ? '无法创建或写入导出文件夹，请检查权限。' : error.message || '无法导出素材。';
}

async function directoryState(directory, protectedRoots) {
  const status = await fs.lstat(directory, { bigint: true });
  const real = await fs.realpath(directory);
  if (!status.isDirectory() || status.isSymbolicLink() || !samePath(directory, real) ||
      protectedRoots.some(root => isWithin(root, directory) || isWithin(root, real))) {
    throw new Error('请选择素材库以外的文件夹保存副本。');
  }
  return { directory, device: status.dev, inode: status.ino };
}

async function checkDirectory(entry, protectedRoots) {
  const current = await directoryState(entry.directory, protectedRoots);
  if (current.device !== entry.device || current.inode !== entry.inode) throw new Error('导出文件夹的位置已变化。');
}

async function newExportRoot(parent, protectedRoots) {
  const occupied = new Set((await fs.readdir(parent.directory)).map(keyOf));
  for (let number = 1; ; number++) {
    const name = number === 1 ? '见藏导出' : `见藏导出 (${number})`;
    if (occupied.has(keyOf(name))) continue;
    await checkDirectory(parent, protectedRoots);
    const target = path.join(parent.directory, name);
    if (protectedRoots.some(root => isWithin(root, target))) continue;
    try { await fs.mkdir(target); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    return directoryState(target, protectedRoots);
  }
}

async function prepareFolders(exportRoot, groups, protectedRoots) {
  const created = new Map([['', exportRoot]]);
  const failures = new Map();
  for (const [folder, rows] of groups) {
    let parent = exportRoot;
    let prefix = '';
    try {
      for (const part of rows[0].parts) {
        const directory = path.join(parent.directory, part);
        prefix += `${part}/`;
        if (!created.has(prefix)) {
          await checkDirectory(parent, protectedRoots);
          if (protectedRoots.some(root => isWithin(root, directory))) throw new Error('供导出的路径已经属于素材库。');
          await fs.mkdir(directory);
          created.set(prefix, await directoryState(directory, protectedRoots));
        }
        parent = created.get(prefix);
      }
      created.set(folder, parent);
    } catch (error) { failures.set(folder, filesystemMessage(error)); }
  }
  return { created, failures };
}

function csvCell(value) {
  let field = String(value ?? '');
  // A visible typographic apostrophe stays data if spreadsheet software saves the CSV again.
  // Quote every cell, including multiline notes, and account for leading whitespace and full-width punctuation.
  if (/^[\s\p{Cf}]*[=+\-@]/u.test(field.normalize('NFKC')) || /^[\r\n\t]/u.test(field)) field = `’${field}`;
  return `"${field.replaceAll('"', '""')}"`;
}

function csvRow(fields) { return fields.map(csvCell).join(',') + '\r\n'; }

function manifestFields(record) {
  const asset = record.asset ?? {};
  const size = Number.isSafeInteger(asset.byteCount) ? asset.byteCount : '';
  const dimensions = asset.width > 0 && asset.height > 0 ? `${asset.width} × ${asset.height}` : '';
  const collections = record.memberships.map(group => group.map(folder => folder.name).join(' / ')).join(' | ');
  return [record.name, record.libraryName, collections, record.item.extension || asset.extension || '', size, dimensions,
    asset.createdAt, asset.importedAt, (asset.tags ?? []).join(' | '), asset.rating, asset.favorite ? '是' : '否',
    asset.note, asset.sourceURL, record.relativePath, record.failure || '已导出'];
}

async function writeManifest(handle, records) {
  const board = records.some(record => record.item.reference?.board);
  let chunk = `\ufeff${csvRow(board ? [...headers, '灵感板顺序', '灵感板备注'] : headers)}`;
  for (const record of records) {
    const fields = manifestFields(record);
    if (board) fields.push(record.item.reference?.board?.order, record.item.reference?.board?.note);
    chunk += csvRow(fields);
    if (chunk.length >= 65_536) { await handle.writeFile(chunk, 'utf8'); chunk = ''; }
  }
  if (chunk) await handle.writeFile(chunk, 'utf8');
  await handle.sync();
}

async function runStructuredExport({ items, options, destination, libraryRoots = [], copy, onProgress } = {}) {
  const { records, byFolder, includeMetadata } = buildPlan(items, options);
  const unavailable = '原件暂不可用，请检查文件是否已下载。';
  for (const record of records) if (!record.available) record.failure = unavailable;
  if (!byFolder.size) return { ok: false, written: 0,
    failed: records.map(({ name, failure }) => ({ name, message: failure })), failedIndices: records.map((_, index) => index),
    directory: null, manifest: null };

  const lexical = path.resolve(destination);
  const real = await fs.realpath(lexical);
  const lexicalRoots = libraryRoots.map(root => path.resolve(root));
  const canonicalRoots = await Promise.all(lexicalRoots.map(root => fs.realpath(root).catch(() => root)));
  const protectedRoots = [...new Set([...lexicalRoots, ...canonicalRoots])];
  if (protectedRoots.some(root => isWithin(root, lexical))) throw new Error('请选择素材库以外的文件夹保存副本。');
  const parent = await directoryState(real, protectedRoots);
  const exportRoot = await newExportRoot(parent, protectedRoots);
  const { created, failures } = await prepareFolders(exportRoot, byFolder, protectedRoots);
  let manifest = null;
  let manifestError;
  let manifestHandle;
  let stamp;
  const metadataPath = path.join(exportRoot.directory, manifestName);
  if (includeMetadata) {
    try {
      await checkDirectory(exportRoot, protectedRoots);
      manifestHandle = await fs.open(metadataPath, 'wx', 0o600);
      stamp = await manifestHandle.stat({ bigint: true });
    } catch (error) { manifestError = filesystemMessage(error); }
  }

  let written = 0;
  let processed = records.filter(record => !record.available).length;
  function updateProgress(phase = 'copying') {
    try { onProgress?.({ total: records.length, processed, written, failed: processed - written, phase }); }
    catch { /* Export is independent of UI feedback. */ }
  }

  try {
    updateProgress();
    for (const [folder, group] of byFolder) {
      const entry = created.get(folder);
      const previousProcessed = processed;
      const previousWritten = written;
      try {
        if (failures.has(folder)) throw new Error(failures.get(folder));
        await checkDirectory(entry, protectedRoots);
        const copies = group.map(record => ({ name: reservedDevice.test(record.name) ? `_${record.name}` : record.name,
          extension: text(record.item.extension).toLowerCase(), record }));
        const exported = await exportBatch({ items: copies, destination: entry.directory, libraryRoots: protectedRoots,
          onProgress(progress) {
            const nextProcessed = previousProcessed + progress.processed;
            if (nextProcessed === processed) return;
            processed = nextProcessed;
            written = previousWritten + progress.written;
            updateProgress();
          },
          async copy(candidate, target, roots) {
            await checkDirectory(entry, roots);
            await copy(candidate.record.item, target, roots);
            candidate.record.relativePath = path.relative(exportRoot.directory, target).split(path.sep).join('/');
          },
        });
        let failedIndex = 0;
        for (const record of group) if (!record.relativePath) record.failure = exported.failed[failedIndex++]?.message || '无法导出原件。';
      } catch (error) {
        for (const record of group) if (!record.relativePath) record.failure = filesystemMessage(error);
      }
      if (processed < previousProcessed + group.length) {
        processed = previousProcessed + group.length;
        updateProgress();
      }
    }
    if (manifestHandle && !manifestError) {
      updateProgress('manifest');
      try {
        await checkDirectory(exportRoot, protectedRoots);
        await writeManifest(manifestHandle, records);
        const current = await fs.lstat(metadataPath, { bigint: true });
        if (current.dev !== stamp.dev || current.ino !== stamp.ino || !current.isFile()) throw new Error('清单位置已变化。');
        manifest = manifestName;
      } catch (error) { manifestError = filesystemMessage(error); }
    }
  } finally {
    await manifestHandle?.close().catch(() => {});
    if (stamp && !manifest) {
      await checkDirectory(exportRoot, protectedRoots).then(async () => {
        const current = await fs.lstat(metadataPath, { bigint: true });
        if (current.dev === stamp.dev && current.ino === stamp.ino) await fs.unlink(metadataPath);
      }).catch(() => {});
    }
  }
  const failed = [];
  const failedIndices = [];
  records.forEach(({ name, failure }, index) => {
    if (!failure) return;
    failed.push({ name, message: failure });
    failedIndices.push(index);
  });
  return { ok: written > 0, written, failed, failedIndices, directory: exportRoot.directory, manifest,
    ...(manifestError && { manifestError }) };
}

module.exports = { planStructuredExport, runStructuredExport };
