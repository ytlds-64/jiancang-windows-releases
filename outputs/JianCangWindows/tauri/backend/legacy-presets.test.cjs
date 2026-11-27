'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readLegacyPresets } = require('./legacy-presets.cjs');

const rename = 'jiancang-rename-presets-v1';
const originals = 'jiancang-export-presets-v1:originals';
const conversion = 'jiancang-export-presets-v1:conversion';
const join = (...items) => Buffer.concat(items);

function number(value) {
  const parts = [];
  while (value >= 128) { parts.push(value % 128 + 128); value = Math.floor(value / 128); }
  return Buffer.from([...parts, value]);
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function slice(bytes) { return join(number(bytes.length), bytes); }
function key(name, origin = 'jiancang://app') { return Buffer.from(`_${origin}\0\x01${name}`, 'latin1'); }
function value(rows, utf16 = false) { return join(Buffer.of(utf16 ? 0 : 1), Buffer.from(JSON.stringify(rows), utf16 ? 'utf16le' : 'latin1')); }

function maskedChecksum(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  crc = ~crc;
  return u32((((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0);
}

function record(body, tag = 1) {
  const size = Buffer.alloc(2);
  size.writeUInt16LE(body.length);
  const encoded = join(Buffer.of(tag), body);
  return join(maskedChecksum(encoded), size, encoded);
}

function journal(sequence, entries) {
  const body = join(u64(sequence), u32(entries.length), ...entries.map(([name, data]) =>
    data ? join(Buffer.of(1), slice(name), slice(data)) : join(Buffer.of(0), slice(name))));
  const capacity = 32768 - 7;
  return body.length <= capacity ? record(body) : join(record(body.subarray(0, capacity), 2), record(body.subarray(capacity), 4));
}

function table(entries) {
  function block(rows) {
    return join(...rows.map(([key, value]) => join(Buffer.of(0), number(key.length), number(value.length), key, value)), u32(0), u32(1));
  }
  const data = block(entries);
  const length = Buffer.alloc(2);
  length.writeUInt16LE(data.length - 1);
  assert.ok(data.length > 256 && data.length < 65535);
  const compressed = join(number(data.length), Buffer.of(61 << 2), length, data);
  const parts = [];
  function append(body, tag) {
    const offset = parts.reduce((size, bytes) => size + bytes.length, 0);
    const checksumInput = join(body, Buffer.of(tag));
    parts.push(checksumInput, maskedChecksum(checksumInput));
    return join(number(offset), number(body.length));
  }
  const pointer = append(compressed, 1);
  const metaindex = append(block([]), 0);
  const index = append(block([[entries.at(-1)[0], pointer]]), 0);
  return join(...parts, metaindex, index, Buffer.alloc(40 - metaindex.length - index.length), u64(0xdb4775248b80fb57n));
}

async function fixture(t) {
  const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-legacy-presets-'));
  t.after(() => fs.rm(appData, { recursive: true, force: true }));
  const directory = path.join(appData, '见藏', 'Local Storage', 'leveldb');
  await fs.mkdir(directory, { recursive: true });

  const originalPreset = { name: 'Café', settings: { layout: 'collections', includeMetadata: true } };
  const replace = [{ name: '人像', rule: { mode: 'sequence', base: '人像', start: 7, extra: 'discard me' } }];
  const older = [{ name: 'Older', settings: { format: 'jpeg', maximumSide: 4096, quality: 80 } }];
  const entries = [
    [join(key(conversion), u64(1 << 8 | 1)), value(older)],
    [join(key(originals), u64(2 << 8 | 1)), value([{ ...originalPreset, extra: 'discard me' }])],
  ];
  const compacted = table(entries);
  const manifest = record(join(Buffer.of(1), slice(Buffer.from('leveldb.BytewiseComparator')), Buffer.of(2, 4, 3, 5, 4, 2, 7, 0, 2),
    number(compacted.length), slice(entries[0][0]), slice(entries[1][0])));
  const log = path.join(directory, '000004.log');
  await Promise.all([
    fs.writeFile(path.join(directory, 'CURRENT'), 'MANIFEST-000001\n'),
    fs.writeFile(path.join(directory, 'MANIFEST-000001'), manifest),
    fs.writeFile(path.join(directory, '000002.ldb'), compacted),
    fs.writeFile(path.join(directory, '000003.log'), journal(50, [[key(conversion), value(older)]])),
    fs.writeFile(log, journal(3, [
      [key(rename), value([...replace, { name: '', rule: replace[0].rule }], true)],
      [key(conversion), null],
      [key(originals, 'https://example.test'), value([{ name: 'Another origin', settings: originalPreset.settings }])],
      [key('unrelated-storage-data'), Buffer.alloc(33000, 3)],
    ])),
  ]);
  return { appData, log, originalPreset };
}

test('imports only live Jiancang presets from a compressed table and a fragmented journal', async t => {
  const { appData, log, originalPreset } = await fixture(t);
  const before = await fs.readFile(log);
  assert.deepEqual(await readLegacyPresets({ appData }), { presets: {
    [originals]: [originalPreset], [rename]: [{ name: '人像', rule: { mode: 'sequence', base: '人像', start: 7 } }],
  }, skipped: 1 });
  assert.deepEqual(await fs.readFile(log), before);
});

test('rejects a bad checksum or an ambiguous sequence', async t => {
  const { appData, log } = await fixture(t);
  const corrupted = await fs.readFile(log);
  corrupted[0] ^= 1;
  await fs.writeFile(log, corrupted);
  await assert.rejects(readLegacyPresets({ appData }), /数据库格式不受支持或已损坏/);
  const first = journal(10, [[key(rename), value([])]]);
  const second = journal(10, [[key(rename), null]]);
  await fs.writeFile(log, join(first, second));
  await assert.rejects(readLegacyPresets({ appData }), /数据库格式不受支持或已损坏/);
});

test('requires a consistent snapshot and handles a missing profile', async t => {
  const { appData, log } = await fixture(t);
  assert.deepEqual(await readLegacyPresets({ appData: path.join(appData, 'missing') }), { presets: {}, skipped: 0 });
  const target = await fs.realpath(log);
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    if (args[0] === target) await fs.appendFile(log, Buffer.of(0));
    return open(...args);
  });
  await assert.rejects(readLegacyPresets({ appData }), /退出见藏旧版后再试/);
});
