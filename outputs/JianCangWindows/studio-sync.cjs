'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { protocolRoot, readManifest, readJSON, inspect } = require('./sync-library.cjs');

const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const validID = new RegExp(`^${uuid}$`);
const recordFilename = new RegExp(`^(${uuid})\\.(${uuid})\\.json$`);
const stagingFilename = new RegExp(`^\\.materialshelf-publish-${uuid}$`, 'i');
const originalID = /^[0-9a-f]{64}$/;
const kinds = new Set(['board', 'filter', 'video-note']);
const fields = ['version', 'libraryID', 'kind', 'scope', 'id', 'writer', 'revision', 'payload'];
const maximumPayload = 384 * 1024;
const maximumFile = 768 * 1024;
const maximumTotal = 32 * 1024 * 1024;
const maximumEntries = 4096;
const waitForSync = () => new Error('跨设备记录仍在同步，请稍后重新读取。');
const invalid = () => new Error('跨设备同步记录格式无效。');
const limit = () => new Error('跨设备同步记录超出可读取的大小。');

function validPayload(payload) {
  if (payload === null) return;
  if (typeof payload !== 'string') throw invalid();
  if (Buffer.byteLength(payload) > maximumPayload) throw limit();
  let value;
  try { value = JSON.parse(payload); } catch { throw invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
}

function token({ revision, writer }) { return `${revision}:${writer}`; }

async function context(entry, kind, scope) {
  if (!kinds.has(kind) || (kind === 'video-note'
    ? typeof scope !== 'string' || !originalID.test(scope) : scope !== null)) throw invalid();
  const root = await protocolRoot(entry.root);
  const manifest = await readManifest(root);
  if (manifest.libraryID !== entry.libraryId) throw new Error('这个文件夹属于另一份同步库。');
  if (manifest.version !== 6) throw new Error('请先将同步库升级至格式 6。');
  const parts = ['blobs', '.studio', 'v1', kind];
  if (scope) parts.push(scope);
  return { root, parts, libraryID: manifest.libraryID.toLowerCase(), kind, scope };
}

async function inspectIfPresent(filename, type) {
  try { return await inspect(filename, type); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function folderFor({ root, parts }, create = false) {
  let directory = root;
  for (const [index, part] of parts.entries()) {
    const next = path.join(directory, part);
    if (!await inspectIfPresent(next, 'directory')) {
      if (await inspectIfPresent(path.join(directory, `.${part}.icloud`), 'file') || index === 0) throw waitForSync();
      if (!create) return null;
      await fs.mkdir(next, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await inspect(next, 'directory');
    }
    directory = next;
  }
  return directory;
}

function decode(record, name, { libraryID, kind, scope }) {
  const ids = recordFilename.exec(name);
  if (!record || typeof record !== 'object' || Object.keys(record).length !== fields.length ||
      !fields.every(key => Object.hasOwn(record, key)) || record.version !== 1 ||
      record.libraryID !== libraryID || record.kind !== kind || record.scope !== scope ||
      record.id !== ids[1] || record.writer !== ids[2] ||
      !Number.isSafeInteger(record.revision) || record.revision < 1) throw invalid();
  validPayload(record.payload);
  const { id, writer, revision, payload } = record;
  return { id, writer, revision, payload, token: token(record), conflicted: false };
}

async function snapshot(context) {
  const winners = new Map();
  const sizes = new Map();
  let count = 0;
  let bytes = 0;
  const directory = await folderFor(context);
  if (!directory) return { winners, sizes, count, bytes };
  const entries = await fs.opendir(directory);
  for await (const entry of entries) {
    if (++count > maximumEntries) throw limit();
    const { name } = entry;
    if (name === '.DS_Store' || stagingFilename.test(name)) continue;
    if (name.startsWith('.') && name.endsWith('.icloud') && recordFilename.test(name.slice(1, -7))) throw waitForSync();
    if (!recordFilename.test(name) || entry.isSymbolicLink()) throw invalid();
    let raw;
    try { raw = await readJSON(path.join(directory, name), Math.min(maximumFile, maximumTotal - bytes), invalid); }
    catch (error) {
      if (['EAGAIN', 'ENOENT', 'EBUSY'].includes(error.code)) throw waitForSync();
      throw error;
    }
    sizes.set(name, raw.length);
    bytes += raw.length;
    const record = decode(raw.value, name, context);
    const prior = winners.get(record.id);
    if (!prior || record.revision > prior.revision) winners.set(record.id, record);
    else if (record.revision === prior.revision) {
      const latest = record.writer > prior.writer ? record : prior;
      winners.set(record.id, { ...latest, conflicted: prior.conflicted || prior.payload !== record.payload });
    }
  }
  return { winners, sizes, count, bytes };
}

async function listStudio(entry, kind, scope = null) {
  const current = await snapshot(await context(entry, kind, scope));
  return [...current.winners.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

async function writeStudio(entry, writer, kind, scope, id, payload, expected) {
  if (typeof id !== 'string' || !validID.test(id) || typeof writer !== 'string' || !validID.test(writer)) throw invalid();
  validPayload(payload);
  const target = await context(entry, kind, scope);
  const current = await snapshot(target);
  const prior = current.winners.get(id);
  if ((prior?.token ?? null) !== expected || (expected === null && payload === null)) {
    throw new Error('这条记录已在其他设备更改，请重新打开后再保存。');
  }
  const revision = (prior?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) throw limit();
  const { libraryID } = target;
  const name = `${id}.${writer}.json`;
  const record = { version: 1, libraryID, kind, scope, id, writer, revision, payload };
  const data = Buffer.from(JSON.stringify(record), 'utf8');
  const oldSize = current.sizes.get(name);
  if (data.length > maximumFile || (oldSize === undefined && current.count >= maximumEntries) ||
      data.length > maximumTotal - current.bytes + (oldSize ?? 0)) throw limit();

  const folder = await folderFor(target, true);
  const initial = await inspect(folder, 'directory');
  const file = path.join(folder, name);
  const stage = path.join(folder, `.materialshelf-publish-${randomUUID()}`);
  let createdStage = false;
  try {
    const handle = await fs.open(stage, 'wx', 0o600);
    createdStage = true;
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    const after = await inspect(folder, 'directory');
    if (initial.dev !== after.dev || initial.ino !== after.ino) throw waitForSync();
    await inspectIfPresent(file, 'file');
    await fs.rename(stage, file);
    createdStage = false;
  } finally {
    if (createdStage) {
      const after = await inspectIfPresent(folder, 'directory').catch(() => null);
      if (after?.dev === initial.dev && after.ino === initial.ino) await fs.rm(stage, { force: true }).catch(() => {});
    }
  }
  return decode(record, name, target);
}

module.exports = { listStudio, writeStudio };
