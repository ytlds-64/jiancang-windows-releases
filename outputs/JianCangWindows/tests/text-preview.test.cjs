'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { isTextPreview, readTextPreview, previewBytes } = require('../text-preview.cjs');

async function preview(t, bytes, extension = 'txt') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-text-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'document');
  await fs.writeFile(file, bytes);
  const original = { asset: { kind: 'document', extension, byteCount: bytes.length }, library: { publicLibrary: { kind: 'local' } } };
  const signal = AbortSignal.timeout(10_000);
  return readTextPreview(original, (asset, requestSignal, verify) => {
    assert.equal(asset, original);
    assert.equal(requestSignal, signal);
    assert.equal(verify, true);
    return fs.open(file, 'r');
  }, signal);
}

test('decodes UTF-8 and BOM UTF-16 in both byte orders without processing markup', async t => {
  const text = '<script>示例</script>\t表格\r\n行 😀';
  const utf16 = Buffer.from(`\ufeff${text}`, 'utf16le');
  for (const [bytes, encoding] of [[Buffer.from(`\ufeff${text}`), 'UTF-8'], [utf16, 'UTF-16LE'],
    [Buffer.from(utf16).swap16(), 'UTF-16BE']]) {
    assert.deepEqual(await preview(t, bytes, 'md'), { ok: true, encoding, text, limited: false });
  }
  assert.deepEqual(await preview(t, Buffer.alloc(0)), { ok: true, encoding: 'UTF-8', text: '', limited: false });
});

test('bounds large previews and omits an incomplete last character', async t => {
  const prefix = 'x'.repeat(previewBytes - 1);
  const bytes = Buffer.from(prefix + '汉\n这部分只在原件里');
  assert.deepEqual(await preview(t, bytes, 'log'), { ok: true, encoding: 'UTF-8', text: prefix, limited: true });
  const utf16 = Buffer.concat([Buffer.from('\ufeff' + 'x'.repeat(previewBytes / 2 - 2), 'utf16le'), Buffer.from('😀尾', 'utf16le')]);
  assert.equal((await preview(t, utf16)).text.length, previewBytes / 2 - 2);
});

test('rejects binary, unsupported encodings and oversized cloud files before opening', async t => {
  assert.match((await preview(t, Buffer.from([65, 0, 66]))).message, /非文本/);
  assert.match((await preview(t, Buffer.from([0xfa, 0xff]))).message, /UTF-8/);
  assert.equal(isTextPreview({ kind: 'document', extension: 'html' }), false);
  assert.equal(isTextPreview({ kind: 'image', extension: 'txt' }), false);
  const original = { asset: { kind: 'document', extension: 'txt', byteCount: 40 * 1024 ** 2 }, library: { publicLibrary: { kind: 'jiancang' } } };
  const result = await readTextPreview(original, () => assert.fail('large cloud file should stay unopened'));
  assert.equal(result.ok, false);
  assert.match(result.message, /32 MB/);
});
