'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { migrateLegacyProfile } = require('./profile-migration.cjs');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-profile-migration-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appData = path.join(root, 'Roaming');
  const legacy = path.join(appData, '见藏');
  const profile = path.join(appData, 'com.jiancang.desktop.tauri');
  await fs.mkdir(legacy, { recursive: true });
  return { root, appData, legacy, profile };
}

function library(root, id, libraryId, preferences) {
  return { id, libraryId, root, name: path.basename(root), kind: 'local', pathIndependentIdentity: true, ...preferences };
}

function registry(entries, selectedId) {
  return { version: 1, selectedId, entries };
}

function write(directory, name, value) { return fs.writeFile(path.join(directory, name), JSON.stringify(value)); }

async function read(directory, name) { return JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')); }

test('registers legacy libraries and retains safe AI preferences on first run without touching Electron data', async t => {
  const { root, appData, legacy, profile } = await fixture(t);
  const registered = registry([
    library(path.join(root, '摄影作品'), 'aaaa', '0001'),
    library(path.join(root, '同步库'), 'bbbb', '0002', { kind: 'jiancang', syncWritable: true }),
    library(path.join(root, 'Eagle.library'), 'cccc', '0003', { kind: 'eagle', eagleWritable: true }),
  ], 'bbbb');
  const suggestions = { version: 2, provider: 'lmstudio',
    compatible: { endpoint: 'https://example.test/v1/chat/completions', model: 'vision', keyCipher: 'SYNTHETIC' },
    lmstudio: { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local-vision', keyCipher: 'SYNTHETIC' } };
  await write(legacy, 'library.json', registered);
  await write(legacy, 'asset-suggestions.json', suggestions);
  await fs.writeFile(path.join(legacy, 'Local State'), 'placeholder');
  await fs.mkdir(path.join(legacy, 'directory-sync-write-v1'));
  await fs.writeFile(path.join(legacy, 'directory-sync-write-v1/journal.sqlite'), 'placeholder');

  const result = await migrateLegacyProfile(profile, { appData });
  assert.deepEqual(result, { imported: ['library.json', 'asset-suggestions.json'], skipped: [] });
  assert.deepEqual(await read(profile, 'library.json'), registered);
  assert.deepEqual(await read(profile, 'asset-suggestions.json'), {
    ...suggestions,
    compatible: { ...suggestions.compatible, keyCipher: null },
    lmstudio: { ...suggestions.lmstudio, keyCipher: null },
  });
  assert.deepEqual(await read(legacy, 'library.json'), registered);
  assert.deepEqual(await read(legacy, 'asset-suggestions.json'), suggestions);
  assert.deepEqual((await fs.readdir(profile)).sort(),
    ['asset-suggestions.json', 'electron-profile-migration-v1.json', 'library.json']);

  await write(profile, 'library.json', registry([registered.entries[0]], 'aaaa'));
  assert.deepEqual(await migrateLegacyProfile(profile, { appData }), { imported: [], skipped: [] });
  assert.deepEqual(await read(profile, 'library.json'), registry([registered.entries[0]], 'aaaa'));
});

test('preserves candidate settings and avoids adding a second writable location for the same sync library', async t => {
  const { root, appData, legacy, profile } = await fixture(t);
  await fs.mkdir(profile);
  const chosen = library(path.join(root, 'current'), 'aaaa', '0001', { kind: 'jiancang', syncWritable: true });
  const moved = library(path.join(root, 'another-copy'), 'cccc', '0001', { kind: 'jiancang', syncWritable: true });
  const alongside = library(path.join(root, 'new-to-candidate'), 'dddd', '0003');
  const samePath = { ...chosen, id: 'bbbb', syncWritable: false };
  const conflictingID = library(path.join(root, 'different'), 'aaaa', '0004');
  const candidateAI = { version: 2, provider: 'lmstudio', lmstudio: { model: 'candidate-choice', keyCipher: 'SYNTHETIC' } };
  await write(profile, 'library.json', registry([chosen], 'aaaa'));
  await write(profile, 'asset-suggestions.json', candidateAI);
  await write(legacy, 'library.json', registry([samePath, moved, alongside, conflictingID], 'dddd'));
  await write(legacy, 'asset-suggestions.json', { version: 1, endpoint: 'https://example.test/v1', model: 'vision' });

  assert.deepEqual(await migrateLegacyProfile(profile, { appData }), { imported: ['library.json'], skipped: [] });
  const { syncWritable, ...readOnlyCopy } = moved;
  assert.equal(syncWritable, true);
  assert.deepEqual(await read(profile, 'library.json'), registry([chosen, readOnlyCopy, alongside], 'aaaa'));
  assert.deepEqual(await read(profile, 'asset-suggestions.json'), candidateAI);
});

test('inherits existing browser approvals and repoints the target, rules and history to the candidate registration', async t => {
  const { root, appData, legacy, profile } = await fixture(t);
  await fs.mkdir(profile);
  const previous = library(path.join(root, 'captures'), 'aaaa', '0001');
  const current = { ...previous, id: 'bbbb' };
  await write(legacy, 'library.json', registry([previous], previous.id));
  await write(profile, 'library.json', registry([current], current.id));
  const target = { targetId: previous.id, libraryId: previous.libraryId, collectionId: 'work' };
  const rawToken = Buffer.alloc(32, 3).toString('base64url');
  const digest = createHash('sha256').update(rawToken).digest('hex');
  const settings = { target, tokens: [digest, rawToken, digest], unused: rawToken };
  const rule = { id: '12345678-0000-4000-8000-000000000000', name: '参考图', enabled: true,
    domain: 'example.test', kind: 'image', keyword: '', target, tags: ['参考'] };
  const record = { id: 'e'.repeat(32), assetId: 'f'.repeat(64), kind: 'image', capturedAt: 1_700_000_000_000,
    target, width: 640, height: 320, title: '参考素材', destination: '参考图',
    originalURL: 'https://example.test/page', imageURL: 'https://example.test/asset.png' };
  await write(legacy, 'browser-capture.json', settings);
  await write(legacy, 'browser-capture-rules.json', [rule, { name: 'Malformed rule' }]);
  await write(legacy, 'browser-capture-history.json', [record, { id: 'invalid-record' }]);

  assert.deepEqual(await migrateLegacyProfile(profile, { appData }), {
    imported: ['browser-capture.json', 'browser-capture-rules.json', 'browser-capture-history.json'], skipped: [],
  });
  const remapped = { ...target, targetId: current.id };
  assert.deepEqual(await read(profile, 'browser-capture.json'), { target: remapped, tokens: [digest] });
  assert.deepEqual(await read(profile, 'browser-capture-rules.json'), [{ ...rule, target: remapped }]);
  assert.deepEqual(await read(profile, 'browser-capture-history.json'), [{ ...record, target: remapped }]);
  assert.deepEqual(await read(legacy, 'browser-capture.json'), settings);
});

test('keeps candidate capture disabled and fills missing rules even when candidate capture settings exist', async t => {
  const { root, appData, legacy, profile } = await fixture(t);
  await fs.mkdir(profile);
  const entry = library(path.join(root, 'archives'), 'aaaa', '0001');
  const target = { targetId: entry.id, libraryId: entry.libraryId, collectionId: null };
  await write(legacy, 'library.json', registry([entry], entry.id));
  await write(legacy, 'browser-capture.json', { target, tokens: ['e'.repeat(64)] });
  const rule = { id: '12345678-0000-4000-8000-000000000000', name: '网页归档', enabled: true, domain: 'example.test',
    keyword: '', kind: 'page', target, tags: [] };
  await write(legacy, 'browser-capture-rules.json', [rule]);
  const disabled = { target: null, tokens: [] };
  await write(profile, 'browser-capture.json', disabled);
  await write(profile, 'browser-capture-history.json', []);

  assert.deepEqual(await migrateLegacyProfile(profile, { appData }), {
    imported: ['library.json', 'browser-capture-rules.json'], skipped: [],
  });
  assert.deepEqual(await read(profile, 'browser-capture.json'), disabled);
  assert.deepEqual(await read(profile, 'browser-capture-rules.json'), [rule]);
  assert.deepEqual(await read(profile, 'browser-capture-history.json'), []);
});

test('does not reactivate capture for a library made read-only in the candidate', async t => {
  const { root, appData, legacy, profile } = await fixture(t);
  await fs.mkdir(profile);
  const entry = library(path.join(root, 'sync'), 'aaaa', '0001', { kind: 'jiancang' });
  const target = { targetId: entry.id, libraryId: entry.libraryId, collectionId: null };
  await write(legacy, 'library.json', registry([{ ...entry, syncWritable: true }], entry.id));
  await write(legacy, 'browser-capture.json', { target, tokens: ['e'.repeat(64)] });
  await write(profile, 'library.json', registry([entry], entry.id));

  assert.deepEqual(await migrateLegacyProfile(profile, { appData }), { imported: [], skipped: ['browser-capture.json'] });
  await assert.rejects(fs.stat(path.join(profile, 'browser-capture.json')), { code: 'ENOENT' });
  assert.deepEqual(await read(profile, 'library.json'), registry([entry], entry.id));
});

test('requires a separate direct profile directory and rejects junctions on the source or destination', async t => {
  const { root, appData, legacy, profile } = await fixture(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await write(legacy, 'library.json', registry([library(outside, 'aaaa', '0001')], 'aaaa'));
  assert.deepEqual(await migrateLegacyProfile(outside, { appData }), { imported: [], skipped: [] });
  assert.deepEqual(await migrateLegacyProfile(legacy, { appData }), { imported: [], skipped: [] });
  await fs.symlink(outside, profile, 'junction');
  await assert.rejects(migrateLegacyProfile(profile, { appData }), /位置已变化/);
  await fs.rm(profile);
  await fs.rename(legacy, path.join(appData, 'previous'));
  await fs.symlink(path.join(appData, 'previous'), legacy, 'junction');
  await assert.rejects(migrateLegacyProfile(profile, { appData }), /位置已变化/);
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(fs.lstat(profile), { code: 'ENOENT' });
});

test('skips invalid legacy settings and keeps the current profile readable', async t => {
  const { root, appData, legacy, profile } = await fixture(t);
  const validRegistry = registry([library(path.join(root, 'library'), 'aaaa', '0001')], 'aaaa');
  await write(legacy, 'library.json', validRegistry);
  await fs.writeFile(path.join(legacy, 'asset-suggestions.json'), Buffer.alloc(32_769, 0x20));
  assert.deepEqual(await migrateLegacyProfile(profile, { appData }),
    { imported: ['library.json'], skipped: ['asset-suggestions.json'] });
  assert.deepEqual(await read(profile, 'library.json'), validRegistry);
  assert.equal((await fs.stat(path.join(legacy, 'asset-suggestions.json'))).size, 32_769);
});
