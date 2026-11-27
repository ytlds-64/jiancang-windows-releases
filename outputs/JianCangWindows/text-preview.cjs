'use strict';

const { readStablePrefix } = require('./original-file.cjs');

const formats = new Set(['txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log']);
const previewBytes = 256 * 1024;
const verifiedBytes = 32 * 1024 ** 2;

function isTextPreview(asset) {
  return asset.kind === 'document' && formats.has(asset.extension);
}

function decodeText(bytes, limited) {
  let encoding = 'UTF-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'UTF-16LE';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'UTF-16BE';
  let text;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: limited });
  } catch {
    return { ok: false, message: '无法按 UTF-8 或带 BOM 的 UTF-16 读取。可导出原件后查看。' };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    return { ok: false, message: '此文件包含非文本数据，可导出原件后查看。' };
  }
  return { ok: true, encoding, text, limited };
}

async function readTextPreview(original, openAsset, signal) {
  const { asset, library } = original;
  if (!isTextPreview(asset)) return { ok: false, message: '此文件类型暂不支持文字预览。' };
  if (library.publicLibrary.kind === 'jiancang' && asset.byteCount > verifiedBytes) {
    return { ok: false, message: '同步库中的文本原件超过 32 MB，可导出原件后查看。' };
  }
  const handle = await openAsset(original, signal, true);
  try {
    const bytes = await readStablePrefix(handle, asset.byteCount, previewBytes, signal);
    if (!bytes) throw new Error('原件读取时发生变化，请重新读取。');
    return decodeText(bytes, asset.byteCount > bytes.length);
  } finally { await handle.close(); }
}

module.exports = { isTextPreview, readTextPreview, previewBytes };
