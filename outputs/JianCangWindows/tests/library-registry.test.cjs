'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { createRegistry, readRegistry, writeRegistry, registerLibrary, detachLibrary, locationMatches } = require('../library-registry.cjs');

const jiancang = { kind: 'jiancang', directoryName: '见藏', libraryId: '11111111-1111-1111-1111-111111111111' };
const eagle = { kind: 'eagle', directoryName: '灵感', libraryId: '9'.repeat(64) };

test('migrates the previous sync selection and reloads multiple libraries with stable registrations', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-registry-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const settings = path.join(temporary, 'settings', 'library.json');
  const original = path.join(temporary, '见藏同步');
  await fs.mkdir(path.dirname(settings));
  await fs.writeFile(settings, JSON.stringify({ root: original, libraryId: jiancang.libraryId }));
  const previous = await readRegistry(settings);
  assert.equal(previous.migrated, true);
  assert.equal(previous.registry.entries[0].root, original);
  assert.equal(previous.registry.selectedId, previous.registry.entries[0].id);

  const eagleRoot = path.join(temporary, '灵感.library');
  const added = registerLibrary(previous.registry, eagleRoot, eagle);
  assert.equal(added.entries.length, 2);
  assert.notEqual(added.selectedId, previous.registry.selectedId);
  assert.equal(registerLibrary(added, eagleRoot, eagle).entries.length, 2);
  await writeRegistry(settings, added);
  const loaded = await readRegistry(settings);
  assert.deepEqual(loaded, { registry: added, migrated: false });
  const detached = detachLibrary(loaded.registry, added.selectedId);
  assert.deepEqual(detached.entries, previous.registry.entries);
  assert.equal(detached.selectedId, previous.registry.selectedId);
});

test('allows independent copies at different paths and validates a relocated identity', () => {
  const root = path.resolve('Original.library');
  const another = path.resolve('Other.library');
  const moved = path.resolve('Moved.library');
  const first = registerLibrary(createRegistry(), root, eagle);
  const two = registerLibrary(first, another, eagle);
  assert.equal(two.entries.length, 2);
  const original = first.entries[0];
  assert.equal(locationMatches(original, eagle, true), true);
  assert.equal(locationMatches(original, { ...eagle, libraryId: '8'.repeat(64) }, true), false);
  assert.throws(() => registerLibrary(two, another, eagle, original), /已在列表中/);
  const relocated = registerLibrary(two, moved, eagle, original);
  assert.equal(relocated.selectedId, original.id);
  assert.equal(relocated.entries[0].root, moved);
  assert.equal(relocated.entries.length, 2);
  const portableIDMissing = { ...original, pathIndependentIdentity: false };
  assert.equal(locationMatches(portableIDMissing, { ...eagle, libraryId: '8'.repeat(64) }, true), true);
  assert.equal(locationMatches(portableIDMissing, jiancang, true), false);
});
