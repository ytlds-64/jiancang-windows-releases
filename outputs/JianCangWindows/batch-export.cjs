'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { exportFilename, isWithin } = require('./original-file.cjs');

function nameKey(name) {
  return name.normalize('NFC').toLowerCase();
}

function shortenFilename(stem, extension, suffix) {
  // Leave room for numbering even for filenames composed of four-byte characters.
  const budget = 240 - Buffer.byteLength(extension + suffix);
  let result = '';
  let bytes = 0;
  for (const character of stem) {
    bytes += Buffer.byteLength(character);
    if (bytes > budget) break;
    result += character;
  }
  return (result.replace(/[ .]+$/u, '') || '素材') + suffix + extension;
}

function failureMessage(error) {
  const code = error?.code;
  if (code === 'ENOSPC') return '目标磁盘空间不足。';
  if (['EACCES', 'EPERM', 'EROFS'].includes(code)) return '无法读取原件或写入目标文件夹，请检查权限。';
  if (['ENOENT', 'ENOTDIR'].includes(code)) return '找不到原件或目标文件夹，请刷新后重新导出。';
  return code ? '无法导出原件，请检查原件和目标文件夹。' : error?.message || '无法导出原件。';
}

async function exportBatch({ items, destination, libraryRoots, copy, signal, onProgress }) {
  const lexicalDestination = path.resolve(destination);
  const directory = await fs.realpath(lexicalDestination);
  const lexicalRoots = [...new Set(libraryRoots.map(root => path.resolve(root)))];
  const canonicalRoots = await Promise.all(lexicalRoots.map(root => fs.realpath(root).catch(() => root)));
  const protectedRoots = [...new Set([...lexicalRoots, ...canonicalRoots])];
  if (protectedRoots.some(root => isWithin(root, lexicalDestination) || isWithin(root, directory))) {
    throw new Error('请选择素材库以外的文件夹保存副本。');
  }
  const occupied = new Set((await fs.readdir(directory)).map(nameKey));
  const nextNumbers = new Map();
  const failed = [];
  let written = 0;
  const report = name => onProgress?.({ current: name, processed: written + failed.length, total: items.length, written });

  for (const item of items) {
    if (signal?.aborted) break;
    const name = item.name || '未命名素材';
    report(name);
    if (item.available === false) {
      failed.push({ name, message: item.failure || '原件暂不可用，请检查文件是否已下载。' });
      continue;
    }
    const suggested = exportFilename(name, item.extension || '');
    const ending = path.extname(suggested);
    const extension = Buffer.byteLength(ending) <= 32 ? ending : '';
    const stem = path.basename(suggested, extension);
    const suggestedKey = nameKey(shortenFilename(stem, extension, ''));
    let number = nextNumbers.get(suggestedKey) || 1;
    try {
      while (true) {
        const suffix = number === 1 ? '' : ` (${number})`;
        number += 1;
        const filename = shortenFilename(stem, extension, suffix);
        const key = nameKey(filename);
        if (occupied.has(key)) continue;
        try {
          await copy(item, path.join(directory, filename), protectedRoots);
          occupied.add(key);
          nextNumbers.set(suggestedKey, number);
          written += 1;
          break;
        } catch (error) {
          // Original exporters reserve each destination exclusively. A new
          // file can still arrive after the initial directory listing.
          if (error?.code !== 'EEXIST') throw error;
          occupied.add(key);
        }
      }
    } catch (error) {
      if (signal?.aborted) break;
      failed.push({ name, message: failureMessage(error) });
    }
  }
  report('');
  return { written, failed };
}

module.exports = { exportBatch };
