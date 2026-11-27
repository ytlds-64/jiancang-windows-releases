'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { isWithin, readStableBytes } = require('./original-file.cjs');

const maxBytes = 96 * 1024 ** 2;
const pngHeader = Buffer.from('89504e470d0a1a0a', 'hex');
const pngEnd = Buffer.from('0000000049454e44ae426082', 'hex');
const projectExtension = 'jiancangboard';
const maxProjectBytes = 512 * 1024;
const boardReference = /^[a-z0-9-]{1,128}$/i;

function boardProject(value) {
  const invalid = () => new Error('灵感板工程格式有误。请选择见藏导出的工程文件。');
  const { name, entries } = value ?? {};
  if (typeof name !== 'string' || !name.trim() || name.length > 80 ||
      !Array.isArray(entries) || entries.length > 80) throw invalid();
  const keys = new Set();
  const cards = entries.map(item => {
    const { id, registrationId, libraryId, title, source, note } = item ?? {};
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) ||
        typeof registrationId !== 'string' || !boardReference.test(registrationId) ||
        (libraryId != null && (typeof libraryId !== 'string' || !boardReference.test(libraryId))) ||
        typeof title !== 'string' || !title.trim() || title.length > 160 ||
        typeof source !== 'string' || source.length > 120 || typeof note !== 'string' || note.length > 480) throw invalid();
    const key = `${registrationId}:${id}`;
    if (keys.has(key)) throw invalid();
    keys.add(key);
    return { id, registrationId, libraryId: libraryId ?? null, title, source, note };
  });
  return { format: 'jiancang-board', version: 1, name: name.trim(), entries: cards };
}

async function readBoardProject(filename) {
  const handle = await fs.open(filename, 'r');
  let contents;
  try {
    const info = await handle.stat();
    if (info.isFile()) contents = await readStableBytes(handle, info.size, maxProjectBytes);
  } finally { await handle.close(); }
  if (!contents) throw new Error('灵感板工程无法读取、文件过大或正在变化。');
  let project;
  try { project = JSON.parse(contents.toString('utf8')); } catch {}
  if (project?.format !== 'jiancang-board' || project?.version !== 1) throw new Error('此文件不是可读取的见藏灵感板工程。');
  return boardProject(project);
}

function bytesOf(data) {
  if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > maxBytes) {
    throw new Error('灵感板导出的文件超过可保存的大小。');
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function checkedPNG(data) {
  const bytes = bytesOf(data);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(pngHeader) || bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' || !bytes.subarray(-12).equals(pngEnd)) {
    throw new Error('生成的灵感板长图不完整。');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0 || width > 2400 || height > 24_000 || width * height > 24_000_000) {
    throw new Error('灵感板长图过大，请选择导出 PDF。');
  }
  return bytes;
}

function checkedJPEG(page) {
  const { width, height, data } = page ?? {};
  const bytes = bytesOf(data);
  const invalid = () => new Error('生成的灵感板页面不完整。');
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > 2400 || height > 3400 || bytes.length < 16 || bytes.readUInt16BE(0) !== 0xffd8 ||
      bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw invalid();
  let cursor = 2;
  while (cursor + 4 < bytes.length && bytes[cursor] === 0xff) {
    while (bytes[cursor] === 0xff) cursor++;
    const marker = bytes[cursor++];
    if (marker === 0xda || cursor + 1 >= bytes.length) break;
    const length = bytes.readUInt16BE(cursor);
    if (length < 2 || cursor + length > bytes.length) break;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 11 || bytes[cursor + 2] !== 8 || bytes.readUInt16BE(cursor + 3) !== height ||
          bytes.readUInt16BE(cursor + 5) !== width || bytes[cursor + 7] !== 3) break;
      return { width, height, bytes };
    }
    cursor += length;
  }
  throw invalid();
}

function makePDF(pages) {
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > 80) {
    throw new Error('此灵感板无法生成 PDF 页面。');
  }
  const images = pages.map(checkedJPEG);
  if (images.reduce((size, page) => size + page.bytes.length, 0) > maxBytes) {
    throw new Error('灵感板 PDF 文件过大，请分成多份导出。');
  }

  const chunks = [];
  const offsets = [0];
  let position = 0;
  function append(separatorOrBytes) {
    const bytes = typeof separatorOrBytes === 'string' ? Buffer.from(separatorOrBytes, 'ascii') : separatorOrBytes;
    chunks.push(bytes);
    position += bytes.length;
  }
  function object(number, ...parts) {
    offsets[number] = position;
    append(`${number} 0 obj\n`);
    for (const part of parts) append(part);
    append('\nendobj\n');
  }
  append(Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = images.map((_, index) => `${3 + index * 3} 0 R`).join(' ');
  object(2, `<< /Type /Pages /Count ${images.length} /Kids [${kids}] >>`);
  images.forEach(({ width, height, bytes }, index) => {
    const page = 3 + index * 3;
    const mediaWidth = 595.28;
    const mediaHeight = 841.89;
    const paint = `q\n${mediaWidth} 0 0 ${mediaHeight} 0 0 cm\n/Image0 Do\nQ\n`;
    object(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${mediaWidth} ${mediaHeight}] /Resources << /XObject << /Image0 ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>`);
    object(page + 1, `<< /Length ${paint.length} >>\nstream\n${paint}endstream`);
    object(page + 2, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`, bytes, '\nendstream');
  });
  const xref = position;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) append(`${String(offset).padStart(10, '0')} 00000 n \n`);
  append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return chunks;
}

async function writeBoardExport({ target, format, data, pages, project, protectedRoots = [] }) {
  if (!['png', 'pdf', projectExtension].includes(format) || typeof target !== 'string' || !path.isAbsolute(target) || path.extname(target).toLowerCase() !== `.${format}`) {
    throw new Error('请选择对应格式的文件名。');
  }
  let packed;
  if (format === projectExtension) packed = [Buffer.from(JSON.stringify(boardProject(project)) + '\n')];
  else packed = format === 'pdf' ? makePDF(pages) : [checkedPNG(data)];
  const parent = await fs.realpath(path.dirname(target));
  const canonicalRoots = await Promise.all(protectedRoots.map(root => fs.realpath(root).catch(() => root)));
  if (canonicalRoots.some(root => isWithin(root, parent))) {
    throw new Error('请选择素材库以外的文件夹保存灵感板。');
  }
  const temporary = await fs.mkdtemp(path.join(parent, '.jiancang-board-'));
  try {
    const staging = path.join(temporary, `board.${format}`);
    async function* content() { yield* packed; }
    await fs.writeFile(staging, content(), { flag: 'wx', mode: 0o600 });
    await fs.copyFile(staging, path.join(parent, path.basename(target)), constants.COPYFILE_EXCL);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

module.exports = { writeBoardExport, readBoardProject, projectExtension };
