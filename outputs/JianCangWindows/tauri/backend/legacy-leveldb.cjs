'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { openContainedFile, readStablePrefix } = require('../../original-file.cjs');

const logBlockBytes = 32 * 1024;
const maxFileBytes = 16 * 1024 ** 2;
const maxDatabaseBytes = 64 * 1024 ** 2;
const tableMagic = 0xdb4775248b80fb57n;
const maxKeyBytes = 64 * 1024;
const maxSequence = (1n << 56n) - 1n;

function invalid() {
  return Object.assign(new Error('旧版预设数据库格式不受支持或已损坏。'), { code: 'LEGACY_DB_INVALID' });
}

function changed() {
  return Object.assign(new Error('旧版设置仍在使用。请退出见藏旧版后再试。'), { code: 'LEGACY_DB_CHANGED' });
}

class Cursor {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  get remaining() { return this.bytes.length - this.offset; }

  take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) throw invalid();
    const start = this.offset;
    this.offset += length;
    return this.bytes.subarray(start, this.offset);
  }

  uint(length = 1) {
    return this.take(length).readUIntLE(0, length);
  }

  varint() {
    let value = 0;
    for (let shift = 0; shift <= 49; shift += 7) {
      const next = this.uint();
      value += (next & 127) * 2 ** shift;
      if (!Number.isSafeInteger(value)) throw invalid();
      if (next < 128) return value;
    }
    throw invalid();
  }

  slice() { return this.take(this.varint()); }
}

// LevelDB stores masked CRC-32C values for both log records and table blocks.
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  return crc >>> 0;
});

function checksum(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  crc ^= 0xffffffff;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

// https://github.com/google/leveldb/blob/main/doc/log_format.md
function* logRecords(log) {
  let fragments;
  for (let start = 0; start < log.length; start += logBlockBytes) {
    const block = log.subarray(start, start + logBlockBytes);
    const cursor = new Cursor(block);
    while (cursor.remaining >= 7) {
      const crc = cursor.uint(4);
      const bytes = cursor.uint(2);
      const typeStart = cursor.offset;
      const type = cursor.uint();
      if (!crc && !bytes && !type) break;
      const chunk = cursor.take(bytes);
      if (checksum(block.subarray(typeStart, cursor.offset)) !== crc) throw invalid();
      if (type === 1 && !fragments) {
        yield chunk;
      } else if (type === 2 && !fragments) {
        fragments = [chunk];
      } else if (type === 3 && fragments) {
        fragments.push(chunk);
      } else if (type === 4 && fragments) {
        fragments.push(chunk);
        yield Buffer.concat(fragments);
        fragments = undefined;
      } else throw invalid();
    }
    if (block.subarray(cursor.offset).some(byte => byte !== 0)) throw invalid();
  }
  if (fragments) throw invalid();
}

function liveFiles(manifest) {
  const tables = new Map();
  let logNumber;
  let formerLog = 0;
  let comparator;
  for (const record of logRecords(manifest)) {
    const input = new Cursor(record);
    while (input.remaining) {
      switch (input.varint()) {
        case 1:
          comparator = input.slice().toString('latin1');
          if (comparator !== 'leveldb.BytewiseComparator') throw invalid();
          break;
        case 2: logNumber = input.varint(); break;
        case 3:
        case 4: input.varint(); break; // Next file and last sequence numbers.
        case 5: input.varint(); input.slice(); break; // Compaction pointer.
        case 6: input.varint(); tables.delete(input.varint()); break;
        case 7: {
          input.varint(); // Level.
          const number = input.varint();
          tables.set(number, input.varint());
          input.slice(); // Smallest and largest internal keys.
          input.slice();
          break;
        }
        case 9: formerLog = input.varint(); break;
        default: throw invalid();
      }
    }
  }
  if (!comparator || logNumber === undefined) throw invalid();
  return { tables, logNumber, formerLog };
}

function readBatch(record, visit) {
  const input = new Cursor(record);
  const sequence = input.take(8).readBigUInt64LE();
  const length = input.uint(4);
  if (sequence + BigInt(length) > maxSequence + 1n) throw invalid();
  for (let index = 0; index < length; index++) {
    const kind = input.uint();
    if (kind > 1) throw invalid();
    const key = input.slice();
    visit(key, kind ? input.slice() : null, sequence + BigInt(index));
  }
  if (input.remaining) throw invalid();
}

// https://github.com/google/snappy/blob/main/format_description.txt
function uncompress(bytes) {
  const input = new Cursor(bytes);
  const length = input.varint();
  if (length > maxFileBytes) throw invalid();
  const output = Buffer.allocUnsafe(length);
  let position = 0;
  while (input.remaining) {
    const tag = input.uint();
    const type = tag & 3;
    const code = tag >>> 2;
    if (!type) {
      const count = 1 + (code < 60 ? code : input.uint(code - 59));
      if (count > length - position) throw invalid();
      input.take(count).copy(output, position);
      position += count;
      continue;
    }
    const count = type === 1 ? 4 + (code & 7) : 1 + code;
    const distance = type === 1 ? ((tag & 224) << 3) | input.uint() : input.uint(type === 2 ? 2 : 4);
    if (!distance || distance > position || count > length - position) throw invalid();
    const end = position + count;
    for (; position < end; position++) output[position] = output[position - distance];
  }
  if (position !== length) throw invalid();
  return output;
}

// https://github.com/google/leveldb/blob/main/doc/table_format.md
function blockHandle(handle) {
  const offset = handle.varint();
  const length = handle.varint();
  return { offset, trailer: offset + length };
}

function tableBlock(table, { offset, trailer }, budget) {
  if (trailer + 5 > table.length - 48) throw invalid();
  const compressed = table.subarray(offset, trailer);
  const type = table[trailer];
  if (checksum(table.subarray(offset, trailer + 1)) !== table.readUInt32LE(trailer + 1)) throw invalid();
  if (type !== 0 && type !== 1) throw invalid();
  const output = type === 0 ? compressed : uncompress(compressed);
  budget.bytes += output.length;
  if (budget.bytes > maxDatabaseBytes) throw invalid();
  return output;
}

function* blockEntries(block, key = Buffer.allocUnsafe(maxKeyBytes)) {
  if (block.length < 4) throw invalid();
  const restarts = block.readUInt32LE(block.length - 4);
  const size = block.length - 4 * (restarts + 1);
  if (size < 0 || (size && !restarts) || (restarts && block.readUInt32LE(size) !== 0)) throw invalid();
  const input = new Cursor(block.subarray(0, size));
  let keyLength = 0;
  let restart = 0;
  while (input.remaining) {
    const offset = input.offset;
    const shared = input.varint();
    const additional = input.varint();
    const length = input.varint();
    if (shared > keyLength || shared + additional > maxKeyBytes) throw invalid();
    if (restart < restarts) {
      const next = block.readUInt32LE(size + restart * 4);
      if (offset > next || (offset === next && shared)) throw invalid();
      if (offset === next) restart++;
    }
    input.take(additional).copy(key, shared);
    keyLength = shared + additional;
    yield [key.subarray(0, keyLength), input.take(length)];
  }
  if (size && restart !== restarts) throw invalid();
}

function readTable(table, budget, visit) {
  if (table.length < 48 || table.readBigUInt64LE(table.length - 8) !== tableMagic) throw invalid();
  const footer = new Cursor(table.subarray(-48, -8));
  const metadata = blockHandle(footer);
  const indexHandle = blockHandle(footer);
  if (metadata.trailer + 5 > indexHandle.offset || footer.take(footer.remaining).some(byte => byte !== 0)) throw invalid();
  tableBlock(table, metadata, budget);
  const index = tableBlock(table, indexHandle, budget);
  const dataKey = Buffer.allocUnsafe(maxKeyBytes);
  let dataEnd = 0;
  for (const [, handle] of blockEntries(index)) {
    const pointer = new Cursor(handle);
    const data = blockHandle(pointer);
    if (pointer.remaining || data.offset < dataEnd || data.trailer + 5 > metadata.offset) throw invalid();
    dataEnd = data.trailer + 5;
    for (const [internalKey, bytes] of blockEntries(tableBlock(table, data, budget), dataKey)) {
      if (internalKey.length < 8) throw invalid();
      const keyLength = internalKey.length - 8;
      const stamp = internalKey.readBigUInt64LE(keyLength);
      const kind = Number(stamp & 255n);
      if (kind > 1) throw invalid();
      visit(internalKey.subarray(0, keyLength), kind ? bytes : null, stamp >> 8n);
    }
  }
}

function stamp(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'); }

async function readLiveKeys(directory, keys) {
  if (path.relative(directory, await fs.realpath(directory)) !== '') throw invalid();
  const directoryStamp = stamp(await fs.lstat(directory, { bigint: true }));
  const physicalFiles = new Map();
  const latest = new Map();
  const uncompressed = { bytes: 0 };
  const keyLengths = new Set([...keys.keys()].map(key => key.length));
  let readBytes = 0;

  async function read(name, limit = maxFileBytes, expected) {
    const file = path.join(directory, name);
    const handle = await openContainedFile(directory, file, expected);
    try {
      const before = await handle.stat({ bigint: true });
      const oldStamp = physicalFiles.get(file);
      if (oldStamp !== undefined && oldStamp !== stamp(before)) throw changed();
      const size = Number(before.size);
      readBytes += size;
      if (size > limit || readBytes > maxDatabaseBytes) throw invalid();
      const bytes = await readStablePrefix(handle, size, Math.max(1, size));
      if (!bytes || stamp(before) !== stamp(await fs.lstat(file, { bigint: true }))) throw changed();
      physicalFiles.set(file, stamp(before));
      return bytes;
    } finally {
      await handle.close();
    }
  }

  function visit(key, value, sequence) {
    if (!keyLengths.has(key.length)) return;
    const name = keys.get(key.toString('latin1'));
    if (!name) return;
    const previous = latest.get(name);
    if (previous && previous.sequence >= sequence) {
      if (previous.sequence === sequence && !(value ? previous.value?.equals(value) : previous.value === null)) throw invalid();
      return;
    }
    if (value?.length > 512 * 1024) throw invalid();
    latest.set(name, { sequence, value: value ? Buffer.from(value) : null });
  }

  const current = (await read('CURRENT', 128)).toString('latin1');
  if (!/^MANIFEST-\d{6,16}\n$/.test(current)) throw invalid();
  const { tables, logNumber, formerLog } = liveFiles(await read(current.slice(0, -1), 4 * 1024 ** 2));
  const names = await fs.readdir(directory);
  const filenames = new Set(names);
  const activeLogs = filenames => filenames.filter(file => {
    if (!/^\d{6,16}\.log$/.test(file)) return false;
    const number = Number(file.slice(0, -4));
    return Number.isSafeInteger(number) && (number >= logNumber || number === formerLog);
  }).sort();
  const logs = activeLogs(names);
  if (logs.length + tables.size > 128) throw invalid();
  for (const number of [logNumber, formerLog]) {
    if (number && !filenames.has(String(number).padStart(6, '0') + '.log')) throw changed();
  }
  const tableFiles = [...tables].map(([number, size]) => {
    const file = String(number).padStart(6, '0');
    if (filenames.has(file + '.ldb') && filenames.has(file + '.sst')) throw invalid();
    const extension = filenames.has(file + '.ldb') ? '.ldb' : '.sst';
    return [file + extension, size];
  });
  // Keep only a consistent snapshot while never opening the database for writes.
  for (const name of [...logs, ...tableFiles.map(([name]) => name)]) {
    const file = path.join(directory, name);
    physicalFiles.set(file, stamp(await fs.lstat(file, { bigint: true })));
  }
  for (const [name, size] of tableFiles) {
    readTable(await read(name, maxFileBytes, size), uncompressed, visit);
  }
  for (const file of logs) {
    for (const record of logRecords(await read(file))) readBatch(record, visit);
  }

  // Check that compaction or an old window saving a preset did not mix snapshots.
  if (activeLogs(await fs.readdir(directory)).join('\0') !== logs.join('\0')) throw changed();
  for (const [file, expected] of physicalFiles) {
    if (stamp(await fs.lstat(file, { bigint: true })) !== expected) throw changed();
  }
  if (path.relative(directory, await fs.realpath(directory)) !== '' ||
      directoryStamp !== stamp(await fs.lstat(directory, { bigint: true }))) throw changed();
  return new Map([...latest].flatMap(([name, { value }]) => value === null ? [] : [[name, value]]));
}

module.exports = { readLiveKeys };
