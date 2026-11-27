'use strict';

const { webURL } = require('./local-workflow.cjs');

const clipboardModes = new Set(['names', 'paths', 'sources', 'table']);
const clipboardByteLimit = 2 * 1024 ** 2;

function oneLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
}

function spreadsheetCell(value) {
  const text = oneLine(value);
  return /^[\s\p{Cf}]*[=+\-@]/u.test(text.normalize('NFKC')) ? `'${text}` : text;
}

function clipboardText(items, mode) {
  if (!clipboardModes.has(mode)) throw new Error('请选择要复制的素材信息。');
  const output = [];
  let copied = 0;
  let bytes = 0;
  function add(line) {
    bytes += Buffer.byteLength(line) + 2;
    if (bytes > clipboardByteLimit) throw new Error('这次要复制的内容太多，请分批复制。');
    output.push(line);
  }
  if (mode === 'table') add('素材名称\t素材库\t格式\t宽度\t高度\t大小（字节）\t评分\t标签\t来源网址\t备注');
  for (const item of items) {
    const { asset, libraryName, originalPath } = item;
    const source = webURL(asset.sourceURL);
    let line;
    if (mode === 'names') line = oneLine(asset.name);
    if (mode === 'paths') line = originalPath;
    if (mode === 'sources') line = source;
    if (mode === 'table') line = [asset.name, libraryName, asset.extension,
      asset.width > 0 ? asset.width : '', asset.height > 0 ? asset.height : '',
      asset.byteCount, asset.rating || '', asset.tags?.join('、'), source, asset.note].map(spreadsheetCell).join('\t');
    if (line) { add(line); copied++; }
  }
  return { text: copied ? output.join('\r\n') : '', copied, skipped: items.length - copied };
}

module.exports = { clipboardModes, clipboardText, spreadsheetCell };
