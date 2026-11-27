'use strict';

const headerLimit = 512 * 1024;
const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'bmp', 'avif']);

function jpegDimensions(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return [];
  let index = 2;
  while (index + 9 <= bytes.length && bytes[index++] === 0xff) {
    while (bytes[index] === 0xff) index++;
    if (index + 8 > bytes.length) break;
    const marker = bytes[index++];
    if (marker === 0xda || marker === 0xd9) break;
    const length = bytes.readUInt16BE(index);
    if (length < 2 || index + length > bytes.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 7) {
      return [bytes.readUInt16BE(index + 5), bytes.readUInt16BE(index + 3)];
    }
    index += length;
  }
  return [];
}

function* boxes(bytes, offset, end) {
  while (offset + 8 <= end) {
    let size = bytes.readUInt32BE(offset);
    let start = offset + 8;
    if (size === 1) {
      if (start + 8 > end) return;
      const largeSize = bytes.readBigUInt64BE(start);
      if (largeSize > BigInt(end - offset)) return;
      size = Number(largeSize);
      start += 8;
    } else if (!size) size = end - offset;
    const next = offset + size;
    if (next < start || next > end) return;
    yield { type: bytes.toString('ascii', offset + 4, offset + 8), start, end: next };
    offset = next;
  }
}

function primaryProperties(bytes, box, primaryId) {
  let cursor = box.start;
  if (box.end - cursor < 8 || bytes[cursor] > 1) return [];
  const idSize = bytes[cursor] === 0 ? 2 : 4;
  const propertySize = bytes[cursor + 3] & 1 ? 2 : 1;
  const indexMask = propertySize === 2 ? 0x7fff : 0x7f;
  const entries = bytes.readUInt32BE(cursor + 4);
  cursor += 8;
  for (let index = 0; index < entries && cursor + idSize + 1 <= box.end; index++) {
    const itemId = bytes.readUIntBE(cursor, idSize);
    const count = bytes[cursor + idSize];
    cursor += idSize + 1;
    if (cursor + count * propertySize > box.end) return [];
    if (itemId === primaryId) {
      return Array.from({ length: count }, (_, i) => bytes.readUIntBE(cursor + i * propertySize, propertySize) & indexMask);
    }
    cursor += count * propertySize;
  }
  return [];
}

function avifDimensions(bytes) {
  const meta = [...boxes(bytes, 0, bytes.length)].find(box => box.type === 'meta');
  if (!meta) return [];
  const children = [...boxes(bytes, meta.start + 4, meta.end)];
  const primary = children.find(box => box.type === 'pitm');
  const properties = children.find(box => box.type === 'iprp');
  if (!primary || !properties) return [];
  const idSize = bytes[primary.start] === 0 ? 2 : 4;
  if (primary.start + 4 + idSize > primary.end) return [];
  const id = bytes.readUIntBE(primary.start + 4, idSize);
  const entries = [...boxes(bytes, properties.start, properties.end)];
  const container = entries.find(box => box.type === 'ipco');
  if (!container) return [];
  const indexed = [...boxes(bytes, container.start, container.end)];
  const attached = entries.filter(box => box.type === 'ipma')
    .flatMap(box => primaryProperties(bytes, box, id)).map(index => indexed[index - 1]).filter(Boolean);
  const spatial = attached.find(box => box.type === 'ispe');
  if (!spatial || spatial.start + 12 > spatial.end) return [];
  let width = bytes.readUInt32BE(spatial.start + 4);
  let height = bytes.readUInt32BE(spatial.start + 8);
  const aperture = attached.find(box => box.type === 'clap' && box.start + 32 <= box.end);
  if (aperture) {
    const start = aperture.start;
    const cropWidth = bytes.readUInt32BE(start) / bytes.readUInt32BE(start + 4);
    const cropHeight = bytes.readUInt32BE(start + 8) / bytes.readUInt32BE(start + 12);
    if (Number.isInteger(cropWidth) && Number.isInteger(cropHeight) && cropWidth > 0 && cropWidth <= width &&
        cropHeight > 0 && cropHeight <= height) {
      width = cropWidth;
      height = cropHeight;
    }
  }
  const rotation = attached.find(box => box.type === 'irot' && box.start < box.end);
  return rotation && (bytes[rotation.start] & 1) ? [height, width] : [width, height];
}

function imageDimensions(bytes) {
  if (bytes.length >= 24 && bytes.readBigUInt64BE(0) === 0x89504e470d0a1a0an && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
  if (bytes.length >= 26 && bytes.toString('ascii', 0, 2) === 'BM') {
    const header = bytes.readUInt32LE(14);
    if (header === 12) return [bytes.readUInt16LE(18), bytes.readUInt16LE(20)];
    if (header >= 40) return [bytes.readInt32LE(18), Math.abs(bytes.readInt32LE(22))];
  }
  if (bytes.length >= 26 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const encoding = bytes.toString('ascii', 12, 16);
    if (encoding === 'VP8L' && bytes[20] === 0x2f) {
      const data = bytes.readUInt32LE(21);
      return [(data & 0x3fff) + 1, ((data >>> 14) & 0x3fff) + 1];
    }
    if (bytes.length >= 30 && encoding === 'VP8X') return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
    if (bytes.length >= 30 && encoding === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    }
  }
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return avifDimensions(bytes);
  return jpegDimensions(bytes);
}

async function readImageDimensions(handle, byteCount) {
  if (byteCount < 10) return [];
  const header = Buffer.allocUnsafe(Math.min(byteCount, headerLimit));
  const { bytesRead } = await handle.read(header, 0, header.length, 0);
  return imageDimensions(header.subarray(0, bytesRead));
}

module.exports = { imageDimensions, imageExtensions, readImageDimensions };
