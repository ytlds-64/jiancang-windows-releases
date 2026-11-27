'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/;
const operationFile = /^([1-9][0-9]*)-([0-9a-f-]{36})\.json$/i;
const stagingFile = /^\.materialshelf-publish-([0-9a-f-]{36})$/i;
const collectionDirectories = new Set(['集合', '未分类', '回收站', '历史原件']);
const assetKinds = new Set(['image', 'video', 'pdf', 'audio', 'document', 'link']);
const providerWait = new Set(['ENOENT', 'ENODATA', 'EAGAIN', 'EBUSY', 'ETIMEDOUT', 'EIO', 'EACCES', 'EPERM', 'UNKNOWN']);
const maxOperations = 100_000;
const maxBytes = 64 * 1024 * 1024;
const maxConcurrentRecordReads = 4;
const maxBlobBytes = 16 * 1024 ** 3;
const appleEpoch = 978_307_200;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUUID = text => typeof text === 'string' && uuid.test(text);

class LibraryReadError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function invalidOperation() {
  return new LibraryReadError('同步记录损坏或身份不匹配。请在手机上确认同步库状态。', 'INVALID_OPERATION');
}

function limitExceeded() {
  return new LibraryReadError('这个同步库超出当前版本可读取的大小。', 'LIBRARY_TOO_LARGE');
}

function unsafePath() {
  return new LibraryReadError('同步库包含无法安全读取的链接或路径。', 'UNSAFE_PATH');
}

function samePath(left, right) {
  const normalize = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  return normalize(left) === normalize(right);
}

async function inspect(location, kind) {
  const stat = await fs.lstat(location);
  if (stat.isSymbolicLink() || kind === 'file' && !stat.isFile() || kind === 'directory' && !stat.isDirectory()) {
    throw unsafePath();
  }
  // Reject links in ancestors and Windows junctions that resolve elsewhere.
  if (!samePath(await fs.realpath(location), location)) throw unsafePath();
  return stat;
}

async function readJSON(location, sizeLimit, badJSON) {
  const before = await inspect(location, 'file');
  if (before.size > sizeLimit) throw limitExceeded();
  const file = await fs.open(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw unsafePath();
    if (opened.size > sizeLimit) throw limitExceeded();
    const buffer = Buffer.allocUnsafe(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== opened.size) throw new LibraryReadError('文件仍在同步。', 'EAGAIN');
    let value;
    try { value = JSON.parse(utf8.decode(buffer.subarray(0, length))); }
    catch { throw badJSON(); }
    return { value, length };
  } finally {
    await file.close();
  }
}

function validText(value, sizeLimit, allowEmpty = true) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= sizeLimit && (allowEmpty || value.length > 0);
}

function validEntityID(value) {
  return validText(value, 256, false) && !value.includes('\0');
}

function unpack(value) {
  if (!isObject(value)) throw invalidOperation();
  const keys = Object.keys(value);
  if (keys.length !== 1 || !isObject(value[keys[0]])) throw invalidOperation();
  const type = keys[0];
  const body = value[type];
  if (type === 'null' && Object.keys(body).length === 0) return [type, null];
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, '_0')) throw invalidOperation();
  const item = body._0;
  if (type === 'bool' && typeof item === 'boolean' || type === 'string' && typeof item === 'string' ||
      type === 'int' && Number.isSafeInteger(item) || type === 'double' && Number.isFinite(item)) return [type, item];
  throw invalidOperation();
}

function validField(kind, field, type, value, format) {
  if (Buffer.byteLength(field, 'utf8') > 4096) return false;
  if (field === 'life') return type === 'bool';
  if (field === 'createdAt') return type === 'double';
  if (kind === 'asset') {
    if (field.startsWith('member:') || field.startsWith('tag:')) {
      const suffix = field.slice(field.indexOf(':') + 1);
      return type === 'bool' && suffix.length > 0 && !suffix.includes('\0');
    }
    switch (field) {
      case 'name': return type === 'string' && validText(value, 16_384, false) && value.trim().length > 0;
      case 'note': return type === 'string' && validText(value, 1_048_576);
      case 'favorite': return type === 'bool';
      case 'rating': return type === 'int' && value >= 0 && value <= 5;
      case 'sourceURL': case 'eagleID': return type === 'null' || type === 'string' && validText(value, 16_384);
      case 'deletedAt': return type === 'null' || type === 'double';
      default: return false;
    }
  }
  if (kind === 'collection') {
    if (field === 'parentID') return type === 'null' || type === 'string' && validEntityID(value);
    return ['name', 'colorHex', 'symbol'].includes(field) && type === 'string' && validText(value, 16_384, false);
  }
  if (field === 'name') return type === 'string' && value.trim().length > 0 && validText(value, 4096);
  if (field !== 'query' || type !== 'string' || !validText(value, format >= 3 ? 5 * 1024 ** 2 : 256 * 1024)) return false;
  try {
    const query = JSON.parse(value);
    return isObject(query) && (query.advancedRules === undefined || query.advancedRules === null);
  } catch {
    return false;
  }
}

function descriptor(value, sha256) {
  if (!isObject(value) || !isObject(value.blob) || value.blob.sha256 !== sha256 ||
      !Number.isSafeInteger(value.blob.byteCount) || value.blob.byteCount < 0 || value.blob.byteCount > maxBlobBytes ||
      typeof value.fileExtension !== 'string' || !/^[a-z0-9]{0,16}$/.test(value.fileExtension) || !assetKinds.has(value.kind) ||
      ![value.pixelWidth, value.pixelHeight].every(number => Number.isSafeInteger(number) && number >= 0 && number <= 100_000_000) ||
      value.duration != null && (!Number.isFinite(value.duration) || value.duration < 0) ||
      !Number.isFinite(value.createdAt) || !Number.isFinite(value.importedAt)) throw invalidOperation();

  // Swift uses sorted-key JSON to choose the same descriptor on all peers if
  // two imports of identical bytes reported different media metadata.
  const result = { blob: { byteCount: value.blob.byteCount, sha256 }, createdAt: value.createdAt };
  if (value.duration != null) result.duration = value.duration;
  return Object.assign(result, {
    fileExtension: value.fileExtension, importedAt: value.importedAt, kind: value.kind,
    pixelHeight: value.pixelHeight, pixelWidth: value.pixelWidth,
  });
}

const birthFields = {
  asset: ['name', 'note', 'favorite', 'rating', 'sourceURL', 'eagleID', 'createdAt', 'deletedAt'],
  collection: ['name', 'parentID', 'colorHex', 'symbol', 'createdAt'],
  smartFilter: ['name', 'query', 'createdAt'],
};

function decodeOperation(raw, libraryId, format, device, filename) {
  if (!isObject(raw) || raw.version !== 1 || raw.libraryID !== libraryId || raw.deviceID !== device ||
      !isUUID(raw.id) || !Number.isSafeInteger(raw.counter) || raw.counter < 1 ||
      filename !== `${raw.counter}-${raw.id}.json` || !Object.hasOwn(birthFields, raw.entityKind) ||
      raw.entityKind === 'smartFilter' && format === 1 || !validEntityID(raw.entityID) ||
      !isObject(raw.clock) || raw.clock[device] !== raw.counter || !isObject(raw.changes)) throw invalidOperation();

  const clockEntries = Object.entries(raw.clock);
  if (clockEntries.length > 512 || clockEntries.some(([key, value]) => !isUUID(key) || !Number.isSafeInteger(value) || value < 0)) {
    throw invalidOperation();
  }
  const changes = Object.entries(raw.changes);
  if (!changes.length || changes.length > 10_000) throw invalidOperation();
  const decoded = new Map();
  for (const [field, wrapped] of changes) {
    const [type, value] = unpack(wrapped);
    if (!validField(raw.entityKind, field, type, value, format)) throw invalidOperation();
    // Smart filters do not appear in this catalog. Keep their life/dot so
    // they can unblock later operations without retaining a large query.
    decoded.set(field, raw.entityKind === 'smartFilter' && field === 'query' ? true : value);
  }
  if (decoded.get('life') === true && birthFields[raw.entityKind].some(field => !decoded.has(field))) throw invalidOperation();
  let asset;
  if (raw.entityKind === 'asset') {
    if (!hash.test(raw.entityID)) throw invalidOperation();
    asset = descriptor(raw.asset, raw.entityID);
  } else if (raw.asset != null) {
    throw invalidOperation();
  }
  return {
    id: raw.id, device, counter: raw.counter, clock: new Map(clockEntries),
    kind: raw.entityKind, entity: raw.entityID, changes: decoded, asset, remaining: 0, next: [],
  };
}

function nuisance(name) {
  const staging = stagingFile.exec(name);
  return ['.ds_store', 'desktop.ini', 'thumbs.db'].includes(name.toLowerCase()) || staging && isUUID(staging[1]);
}

function placeholder(name) {
  return name.startsWith('.') && name.endsWith('.icloud');
}

async function readOperations(root, manifest) {
  const { libraryID, version } = manifest;
  const directory = path.join(root, 'changes');
  const operations = [];
  const byDevice = new Map();
  const identities = new Set();
  const bytesByHash = new Map();
  const perFileLimit = (version >= 3 ? 16 : 2) * 1024 ** 2;
  let total = 0;
  let pending = 0;
  let examined = 0;
  let devices;
  try {
    await inspect(directory, 'directory');
    devices = await fs.opendir(directory);
  } catch (error) {
    if (!providerWait.has(error.code)) throw error;
    return { operations, byDevice, pending: 1, bytes: 0 };
  }
  for await (const device of devices) {
    if (++examined > maxOperations * 2) throw limitExceeded();
    if (nuisance(device.name)) continue;
    if (placeholder(device.name)) { pending += 1; continue; }
    if (!isUUID(device.name)) throw invalidOperation();
    const deviceDirectory = path.join(directory, device.name);
    let files;
    try {
      await inspect(deviceDirectory, 'directory');
      files = await fs.opendir(deviceDirectory);
    } catch (error) {
      if (!providerWait.has(error.code)) throw error;
      pending += 1;
      continue;
    }
    const counters = new Map();
    byDevice.set(device.name, counters);
    const batch = [];
    const readBatch = async () => {
      const sizeLimit = Math.min(perFileLimit, maxBytes - total);
      const records = await Promise.allSettled(batch.map(async name => {
        const { value, length } = await readJSON(path.join(deviceDirectory, name), sizeLimit, invalidOperation);
        const operation = decodeOperation(value, libraryID, version, device.name, name);
        if (length > 2 * 1024 ** 2 && operation.kind !== 'smartFilter') throw limitExceeded();
        return { length, operation };
      }));
      batch.length = 0;
      // Preserve directory scan order for validation and causal replay.
      for (const record of records) {
        if (record.status === 'rejected') {
          if (!providerWait.has(record.reason.code)) throw record.reason;
          pending += 1;
          continue;
        }
        const { length, operation } = record.value;
        total += length;
        const stableId = operation.id.toLowerCase();
        if (counters.has(operation.counter) || identities.has(stableId)) throw invalidOperation();
        if (operation.asset) {
          const { sha256, byteCount } = operation.asset.blob;
          if (bytesByHash.has(sha256) && bytesByHash.get(sha256) !== byteCount) throw invalidOperation();
          bytesByHash.set(sha256, byteCount);
        }
        identities.add(stableId);
        counters.set(operation.counter, operation);
        operations.push(operation);
      }
    };
    for await (const file of files) {
      if (++examined > maxOperations * 2) {
        if (batch.length) await readBatch();
        throw limitExceeded();
      }
      if (nuisance(file.name)) continue;
      if (placeholder(file.name)) { pending += 1; continue; }
      const filename = operationFile.exec(file.name);
      if (!filename || !isUUID(filename[2]) || file.isSymbolicLink()) {
        if (batch.length) await readBatch();
        throw invalidOperation();
      }
      if (operations.length >= maxOperations) throw limitExceeded();
      // Reserve space for every in-flight record at its maximum size.
      const batchSize = Math.max(1, Math.min(maxConcurrentRecordReads, maxOperations - operations.length,
        Math.floor((maxBytes - total) / perFileLimit)));
      batch.push(file.name);
      if (batch.length === batchSize) await readBatch();
    }
    if (batch.length) await readBatch();
  }
  return { operations, byDevice, pending, bytes: total };
}

// Use a topological traversal. A delta cannot update the catalog until its
// own predecessor and the causal predecessors it names have arrived.
function readyOperations(operations, byDevice) {
  const ready = [];
  for (const operation of operations) {
    for (const [device, counter] of operation.clock) {
      const predecessor = device === operation.device ? counter - 1 : counter;
      if (predecessor === 0) continue;
      operation.remaining += 1;
      const dependency = byDevice.get(device)?.get(predecessor);
      if (dependency) dependency.next.push(operation);
    }
    if (operation.remaining === 0) ready.push(operation);
  }
  for (let position = 0; position < ready.length; position += 1) {
    for (const operation of ready[position].next) {
      operation.remaining -= 1;
      if (operation.remaining === 0) ready.push(operation);
    }
  }
  return ready;
}

function dominates(left, right) {
  for (const [device, counter] of right) if ((left.get(device) ?? 0) < counter) return false;
  return true;
}

function priority(field, value) {
  if (field === 'deletedAt') return value === null ? 0 : 1;
  if (field === 'life' || field.startsWith('member:') || field.startsWith('tag:')) return value === false ? 1 : 0;
  return 0;
}

function winner(state, field) {
  let best;
  for (const version of state?.registers.get(field) ?? []) {
    if (!best || (priority(field, version.value) - priority(field, best.value) ||
        version.operation.counter - best.operation.counter || compare(version.operation.device, best.operation.device) ||
        compare(version.operation.id, best.operation.id)) > 0) best = version;
  }
  return best;
}

function replay(operations) {
  const entities = { asset: new Map(), collection: new Map() };
  for (const operation of operations) {
    const states = entities[operation.kind];
    if (!states) continue;
    let state = states.get(operation.entity);
    if (!state) {
      state = { registers: new Map(), deletions: new Map(), births: [] };
      states.set(operation.entity, state);
    }
    if (operation.asset) {
      const key = JSON.stringify(operation.asset);
      if (!state.asset || key < state.descriptorKey) {
        state.asset = operation.asset;
        state.descriptorKey = key;
      }
      if (operation.changes.get('life') === true) state.births.push(operation);
    }
    if (operation.changes.get('life') === false) {
      for (const [device, counter] of operation.clock) {
        state.deletions.set(device, Math.max(state.deletions.get(device) ?? 0, counter));
      }
    }
    for (const [field, value] of operation.changes) {
      const frontier = state.registers.get(field) ?? [];
      if (frontier.some(version => dominates(version.operation.clock, operation.clock))) continue;
      const remaining = frontier.filter(version => !dominates(operation.clock, version.operation.clock));
      if (remaining.length >= 1024) throw limitExceeded();
      remaining.push({ operation, value });
      state.registers.set(field, remaining);
    }
  }
  return entities;
}

function projectCollections(states, recordCycle = () => {}) {
  const collections = new Map();
  const parentFor = id => winner(states.get(id), 'parentID')?.value ?? null;
  for (const [id, value] of states) {
    if (winner(value, 'life')?.value !== true) continue;
    const color = winner(value, 'colorHex')?.value;
    collections.set(id, {
      id, parentId: parentFor(id), name: winner(value, 'name')?.value ?? '未命名集合',
      color: /^[0-9a-f]{6}$/i.test(color ?? '') ? color : '46786B',
    });
  }
  // Reuse the first live ancestor for children of deleted folders.
  const resolved = new Map();
  for (const collection of collections.values()) {
    const visited = new Set();
    let parent = collection.parentId;
    while (parent !== null && !collections.has(parent) && !resolved.has(parent) && !visited.has(parent)) {
      visited.add(parent);
      parent = parentFor(parent);
    }
    if (visited.has(parent)) parent = null;
    else if (resolved.has(parent)) parent = resolved.get(parent);
    for (const id of visited) resolved.set(id, parent);
    collection.parentId = parent;
  }
  // The native client breaks a parent cycle at its greatest child ID.
  const finished = new Set();
  for (const start of collections.keys()) {
    const trail = [];
    const positions = new Map();
    let id = start;
    while (id !== null && !finished.has(id)) {
      if (positions.has(id)) {
        const cycle = trail.slice(positions.get(id)).sort(compare);
        const cut = cycle.at(-1);
        recordCycle(cut, cycle.map(member => winner(states.get(member), 'parentID')));
        collections.get(cut).parentId = null;
        break;
      }
      positions.set(id, trail.length);
      trail.push(id);
      id = collections.get(id).parentId;
    }
    for (const member of trail) finished.add(member);
  }
  return collections;
}

function dateISO(seconds) {
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function projectAssets(entities, collections, format) {
  const assets = [];
  const identities = new Map();
  for (const [id, state] of entities.asset) {
    if (winner(state, 'life')?.value !== true) continue;
    const info = state.asset;
    const valueOf = (key, fallback) => winner(state, key)?.value ?? fallback;
    const tags = [], collectionIds = [];
    for (const field of state.registers.keys()) {
      if (!field.startsWith('tag:') && !field.startsWith('member:')) continue;
      const version = winner(state, field);
      if (version?.value !== true || !dominates(version.operation.clock, state.deletions)) continue;
      if (field.startsWith('tag:')) tags.push(field.slice(4));
      else {
        const collection = field.slice(7);
        if (collections.has(collection) && dominates(version.operation.clock, entities.collection.get(collection).deletions)) collectionIds.push(collection);
      }
    }
    assets.push({
      id, name: valueOf('name', '素材').trim(), kind: info.kind, extension: info.fileExtension, byteCount: info.blob.byteCount,
      width: info.pixelWidth, height: info.pixelHeight, duration: info.duration ?? null,
      createdAt: dateISO(valueOf('createdAt', info.createdAt + appleEpoch)), importedAt: dateISO(info.importedAt + appleEpoch),
      tags: tags.sort(), collectionIds: collectionIds.sort(), favorite: valueOf('favorite', false), rating: valueOf('rating', 0),
      note: valueOf('note', ''), sourceURL: valueOf('sourceURL', null), trashed: valueOf('deletedAt', null) !== null, available: false,
    });
    const births = format >= 2 ? state.births.filter(birth => dominates(birth.clock, state.deletions)) : [];
    for (const birth of births) identities.set(`${id}.${birth.id}`, { id, byteCount: info.blob.byteCount });
    identities.set(id, { id, byteCount: info.blob.byteCount });
  }
  assets.sort((left, right) => compare(right.importedAt ?? '', left.importedAt ?? '') || compare(left.id, right.id));
  return { assets, identities };
}

function blobIdentity(filename, format) {
  if (format >= 5) {
    const shortCode = /^.+ \[([0-9a-f]{16})\](?:\.[a-z0-9]{1,32})?$/u.exec(filename);
    if (shortCode) return `@${shortCode[1]}`;
  }
  const parts = filename.split('.');
  if (!hash.test(parts[0])) return null;
  if (parts.length === 1) return parts[0];
  const suffix = /^[a-z0-9]{1,32}$/i;
  if (parts.length === 2 && format >= 2 && isUUID(parts[1])) return filename;
  if (parts.length === 2 && format >= 4 && suffix.test(parts[1])) return parts[0];
  if (parts.length === 3 && format >= 4 && isUUID(parts[1]) && suffix.test(parts[2])) return `${parts[0]}.${parts[1]}`;
  return null;
}

function safeLocationComponent(component) {
  return validText(component, 255, false) && component !== '.' && component !== '..' &&
    !/[<>:"/\\|?*\p{Cc}\p{Cs}]/u.test(component) && !/[ .]$/.test(component) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(component.normalize('NFKC').split('.')[0].trim());
}

function invalidLocation() {
  return new LibraryReadError('部分原件的位置记录无法读取。可在同步设备上刷新后重试。', 'INVALID_LOCATION');
}

async function availablePath(filename, expectedBytes) {
  try {
    const entry = await inspect(filename);
    return entry.isFile() && entry.size === expectedBytes;
  } catch (error) {
    if (!providerWait.has(error.code) && error.code !== 'ENOTDIR') throw error;
    return false;
  }
}

async function readMappedLocations(base, identities) {
  const directory = path.join(base, '.locations');
  const files = [];
  let unreadable = 0;
  let entries;
  try {
    await inspect(directory, 'directory');
    entries = await fs.opendir(directory);
  } catch (error) {
    if (!providerWait.has(error.code)) throw error;
    return { files, unreadable: error.code === 'ENOENT' ? 0 : 1 };
  }

  let examined = 0;
  let bytesRead = 0;
  for await (const entry of entries) {
    if (++examined > maxOperations * 2) throw limitExceeded();
    if (entry.isSymbolicLink()) throw unsafePath();
    if (placeholder(entry.name)) { unreadable += 1; continue; }
    if (!entry.name.endsWith('.json')) continue;
    const identity = entry.name.slice(0, -5);
    const candidate = identities.get(identity);
    if (!candidate) continue;

    let raw;
    try {
      const contents = await readJSON(path.join(directory, entry.name), Math.min(65_536, maxBytes - bytesRead), invalidLocation);
      bytesRead += contents.length;
      raw = contents.value;
    } catch (error) {
      if (error.code !== 'INVALID_LOCATION' && !providerWait.has(error.code)) throw error;
      unreadable += 1;
      continue;
    }
    if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.paths) || raw.paths.length < 1 || raw.paths.length > 8) {
      unreadable += 1;
      continue;
    }
    for (const [index, components] of raw.paths.entries()) {
      if (!Array.isArray(components) || components.length < 2 || components.length > 41 ||
          !collectionDirectories.has(components[0]) || !components.every(safeLocationComponent)) throw unsafePath();
      const filename = path.join(base, ...components);
      const available = await availablePath(filename, candidate.byteCount);
      const rating = 100 - index - (components[0] === '历史原件' ? 10 : 0);
      files.push({ id: candidate.id, filename, rating, available });
    }
  }
  return { files, unreadable };
}

async function locateOriginals(root, format, identities) {
  const foundByIdentity = new Map();
  const layoutFallbacks = new Map();
  const shortCodes = new Map();
  const ambiguous = new Set();
  const seenShortPaths = new Set();
  if (format >= 5) {
    for (const [identity, candidate] of identities) {
      const code = '@' + createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16);
      if (shortCodes.has(code)) ambiguous.add(code);
      else shortCodes.set(code, candidate);
    }
  }
  const base = path.join(root, 'blobs');
  const incomingDirectory = path.join(base, '.incoming');
  const stack = [{ directory: base, depth: 0 }];
  let count = 0;
  let unreadable = 0;
  while (stack.length) {
    const { directory, depth } = stack.pop();
    let entries;
    try {
      await inspect(directory, 'directory');
      entries = await fs.opendir(directory);
    } catch (error) {
      if (!providerWait.has(error.code)) throw error;
      unreadable += 1;
      continue;
    }
    for await (const entry of entries) {
      if (++count > maxOperations * 2 || depth > 40) throw limitExceeded();
      if (nuisance(entry.name) || placeholder(entry.name)) continue;
      if (entry.isSymbolicLink()) throw unsafePath();
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const incoming = format >= 6 && depth === 0 && entry.name === '.incoming';
        const visible = format >= 4 && directory !== incomingDirectory && (depth > 0 || collectionDirectories.has(entry.name));
        if (incoming || visible) stack.push({ directory: filename, depth: depth + 1 });
        continue;
      }
      const identity = blobIdentity(entry.name, format);
      const isShort = identity?.startsWith('@') ?? false;
      const candidate = isShort ? shortCodes.get(identity) : identities.get(identity);
      if (!candidate) continue;
      if (isShort) {
        if (seenShortPaths.has(identity)) ambiguous.add(identity);
        seenShortPaths.add(identity);
      }
      if (!await availablePath(filename, candidate.byteCount)) {
        unreadable += 1;
        continue;
      }
      const prior = foundByIdentity.get(identity);
      // Palpable collection files are a better match than history when the
      // provider briefly exposes both sides of a move. Versioned paths take
      // precedence over a legacy hash-only fallback of the same content.
      const top = path.relative(base, filename).split(path.sep)[0];
      const rating = (top === '历史原件' || top === '.incoming' ? 0 : 4) + (isShort ? 2 : identity.includes('.') ? 1 : 0);
      if (format >= 6) {
        if (!layoutFallbacks.has(identity)) layoutFallbacks.set(identity, []);
        const paths = layoutFallbacks.get(identity);
        if (paths.length < 32 || top === '.incoming') paths.push({ id: candidate.id, filename, rating });
        continue;
      }
      if (!prior || rating > prior.rating || rating === prior.rating && filename < prior.filename) {
        foundByIdentity.set(identity, { id: candidate.id, filename, rating });
      }
    }
  }
  if (format >= 6) {
    const mapped = await readMappedLocations(base, identities);
    const found = new Map();
    const hydrationPaths = new Map();
    const legacy = [...layoutFallbacks].filter(([identity]) => !ambiguous.has(identity)).flatMap(([, items]) => items);
    for (const item of [...mapped.files, ...legacy].sort((left, right) => right.rating - left.rating || compare(left.filename, right.filename))) {
      if (item.available === false) {
        if (!hydrationPaths.has(item.id)) hydrationPaths.set(item.id, new Set());
        hydrationPaths.get(item.id).add(item.filename);
        continue;
      }
      if (!found.has(item.id)) found.set(item.id, new Set());
      const candidates = found.get(item.id);
      if (candidates.size < 32) candidates.add(item.filename);
    }
    const originalCandidates = new Map([...found].map(([id, paths]) => [id, [...paths]]));
    const originals = new Map([...originalCandidates].map(([id, paths]) => [id, paths[0]]));
    const hydrationCandidates = new Map([...hydrationPaths].map(([id, candidates]) => [id, [...candidates]]));
    return { originals, originalCandidates, hydrationCandidates, unreadable: unreadable + mapped.unreadable + ambiguous.size };
  }
  const found = new Map();
  for (const [identity, item] of foundByIdentity) {
    if (ambiguous.has(identity)) continue;
    const prior = found.get(item.id);
    if (!prior || item.rating > prior.rating || item.rating === prior.rating && item.filename < prior.filename) found.set(item.id, item);
  }
  unreadable += ambiguous.size;
  return { originals: new Map([...found].map(([id, picked]) => [id, picked.filename])), unreadable };
}

async function protocolRoot(selectedDirectory) {
  const selected = path.resolve(selectedDirectory);
  const folder = await fs.lstat(selected);
  if (folder.isSymbolicLink() || !folder.isDirectory()) throw unsafePath();
  const root = await fs.realpath(selected);
  return root;
}

async function readManifest(root) {
  const badManifest = () => new LibraryReadError('请选择包含 library.json 的见藏同步文件夹。', 'INVALID_LIBRARY');
  let manifest;
  try {
    ({ value: manifest } = await readJSON(path.join(root, 'library.json'), 65_536, badManifest));
  } catch (error) {
    if (providerWait.has(error.code)) throw badManifest();
    throw error;
  }
  if (!isObject(manifest) || manifest.format !== 'com.materialshelf.directory-sync' || !isUUID(manifest.libraryID) ||
      !Number.isInteger(manifest.version) || !Number.isFinite(manifest.createdAt)) throw badManifest();
  if (manifest.version < 1 || manifest.version > 6) throw new LibraryReadError('这个同步库需要更新版本的见藏。', 'UNSUPPORTED_FORMAT');
  return manifest;
}

const fieldLabels = new Map(Object.entries({
  life: '素材是否存在', name: '名称', note: '备注', favorite: '收藏', rating: '评分',
  sourceURL: '来源', eagleID: 'Eagle 素材标识', createdAt: '创建日期', deletedAt: '回收站状态',
  parentID: '上级集合', colorHex: '集合颜色', symbol: '集合图标',
}));
const assetEditableFields = new Map(Object.entries({
  name: 'string', note: 'string', favorite: 'bool', rating: 'int', sourceURL: 'string', createdAt: 'double',
  deletedAt: 'double',
}));
const collectionEditableFields = new Map(Object.entries({
  name: 'string', colorHex: 'string', symbol: 'string', createdAt: 'double', parentID: 'string',
}));
const conflictLimit = 80;
const candidateLimit = 16;
const conflictTextLimit = 2048;

function activeConflict(state, field) {
  if (!state || field !== 'life' && winner(state, 'life')?.value !== true) return;
  const versions = state.registers.get(field);
  if (!(versions?.length > 1)) return;
  const raw = versions[0].value;
  const value = typeof raw === 'string' ? raw.normalize('NFC') : raw;
  if (versions.some(version => version.value !== raw &&
      (typeof version.value === 'string' ? version.value.normalize('NFC') : version.value) !== value)) return versions;
}

function* fieldConflicts(entities) {
  for (const [kind, states] of Object.entries(entities)) {
    for (const [entityId, state] of states) {
      for (const field of state.registers.keys()) {
        const versions = activeConflict(state, field);
        if (versions) yield { kind, entityId, state, field, versions, selected: winner(state, field) };
      }
    }
  }
}

function conflictTarget(entities, field) {
  return field.startsWith('member:') ? entities.collection.get(field.slice(7)) : undefined;
}

function conflictSignature({ kind, entityId, state, field, versions }, target) {
  const signature = createHash('sha256');
  const life = winner(state, 'life')?.operation.id ?? null;
  const targetLife = winner(target, 'life')?.operation.id ?? null;
  signature.update(JSON.stringify([kind, entityId, field, life, targetLife]));
  for (const version of versions.toSorted((left, right) => compare(left.operation.id, right.operation.id))) {
    signature.update(JSON.stringify([version.operation.id, version.value]));
  }
  return signature.digest('hex');
}

function observesMembership(state, target, field, { operation }) {
  if (!dominates(operation.clock, state.deletions)) return false;
  return !field.startsWith('member:') || winner(target, 'life')?.value === true && dominates(operation.clock, target.deletions);
}

function conflictCandidateType({ kind, entityId, state, field, selected }, target, collections, version) {
  const { value } = version;
  if (winner(state, 'life')?.value !== true) return;
  if (field.startsWith('tag:') || field.startsWith('member:')) {
    if (value === true && !observesMembership(state, target, field, version)) return;
    return 'bool';
  }
  const type = (kind === 'asset' ? assetEditableFields : collectionEditableFields).get(field);
  if (!type) return;
  if (field === 'name' && kind === 'collection') {
    if (!value.trim()) return;
    if (value !== selected.value) {
      const folded = text => text.trim().normalize('NFC').toLowerCase();
      const current = collections.get(entityId);
      if ([...collections.values()].some(item => item.id !== entityId &&
        item.parentId === current?.parentId && folded(item.name) === folded(value))) return;
    }
  }
  if ((field === 'createdAt' || field === 'deletedAt' && value !== null) && dateISO(value) === null ||
      field === 'colorHex' && !/^[0-9a-f]{6}$/i.test(value)) return;
  if (field === 'parentID') {
    const seen = new Set([entityId]);
    for (let parent = value; parent !== null; parent = collections.get(parent).parentId) {
      if (seen.has(parent) || !collections.has(parent)) return;
      seen.add(parent);
    }
  }
  if (field === 'sourceURL' && value !== null) {
    try { if (!['http:', 'https:'].includes(new URL(value).protocol)) return; } catch { return; }
  }
  return value === null ? 'null' : type;
}

function describeConflict(conflict, entities, collections, writeReady, reason = 'concurrent-field') {
  const { kind, entityId, state, field, versions, selected } = conflict;
  const target = conflictTarget(entities, field);
  const membership = field.startsWith('member:');
  const tag = field.startsWith('tag:');
  const fieldLabel = membership ? bestEntityName(target, 'collection', field.slice(7))
    : tag ? field.slice(4) : kind === 'collection' && field === 'life' ? '集合是否存在' : fieldLabels.get(field) ?? field;
  const candidates = [selected, ...versions.filter(version => version !== selected)
    .toSorted((left, right) => right.operation.counter - left.operation.counter || compare(left.operation.device, right.operation.device))]
    .slice(0, candidateLimit).map(version => {
      const { operation, value } = version;
      const valueTruncated = typeof value === 'string' && value.length > conflictTextLimit;
      return { choiceId: operation.id, deviceId: operation.device, operationId: operation.id,
        counter: operation.counter, value: valueTruncated ? value.slice(0, conflictTextLimit) : value, valueTruncated,
        displayValue: field === 'parentID' && value !== null ? bestEntityName(entities.collection.get(value), 'collection', value) : undefined,
        sourceEntityName: reason === 'collection-cycle' ? bestEntityName(entities.collection.get(operation.entity), 'collection', operation.entity) : undefined,
        selectable: writeReady && reason === 'concurrent-field' &&
          (!valueTruncated || version === selected) && Boolean(conflictCandidateType(conflict, target, collections, version)) };
    });
  const collection = field === 'parentID' ? collections.get(entityId) : undefined;
  const projectedParent = collection?.parentId;
  const moveToRoot = writeReady && reason === 'collection-cycle';
  const acknowledgeDeletion = writeReady && field === 'life' && selected.value === false;
  return {
    kind, entityId, entityName: bestEntityName(state, kind, entityId), reason, field, fieldLabel,
    displayedParent: collection && projectedParent !== selected.value
      ? projectedParent === null ? '顶层集合' : collections.get(projectedParent).name : undefined,
    signature: conflictSignature(conflict, target), winnerId: selected.operation.id,
    resolvable: moveToRoot || acknowledgeDeletion || candidates.some(candidate => candidate.selectable),
    moveToRoot, acknowledgeDeletion,
    candidates, candidateCount: versions.length,
  };
}

function bestEntityName(state, kind, id) {
  const name = winner(state, 'name')?.value?.trim();
  return name ? name.slice(0, conflictTextLimit) : `${kind === 'collection' ? '集合' : '素材'} ${id.slice(0, 12)}`;
}

function conflictChoice({ entities, collections }, { kind, entityId, field, signature, choiceId, moveToRoot }) {
  const states = Object.hasOwn(entities, kind) ? entities[kind] : null;
  const state = states?.get(entityId);
  if (moveToRoot === true && kind === 'collection' && field === 'parentID') {
    let matches = false;
    projectCollections(entities.collection, (cut, versions) => {
      if (cut === entityId) matches = conflictSignature({ kind, entityId, state, field, versions }) === signature;
    });
    if (!matches) throw new LibraryReadError('这条冲突已有新变化，请刷新后重新选择。', 'SYNC_CONFLICT_STALE');
    return { null: {} };
  }
  const versions = typeof field === 'string' ? activeConflict(state, field) : undefined;
  const conflict = { kind, entityId, state, field, versions, selected: winner(state, field) };
  const target = typeof field === 'string' ? conflictTarget(entities, field) : undefined;
  if (!versions || conflictSignature(conflict, target) !== signature) {
    throw new LibraryReadError('这条冲突已有新变化，请刷新后重新选择。', 'SYNC_CONFLICT_STALE');
  }
  const version = versions.find(candidate => candidate.operation.id === choiceId);
  const type = version && conflictCandidateType(conflict, target, collections, version);
  if (!type || (typeof version.value === 'string' && version.value.length > conflictTextLimit && version !== conflict.selected)) {
    throw new LibraryReadError('这条记录暂不支持采用所选值，请在手机端处理。', 'SYNC_CONFLICT_CHOICE');
  }
  return type === 'null' ? { null: {} } : { [type]: { _0: version.value } };
}

function confirmDeletionConflict({ entities }, { kind, entityId, field, signature }) {
  const state = Object.hasOwn(entities, kind) ? entities[kind].get(entityId) : null;
  const versions = field === 'life' ? activeConflict(state, field) : undefined;
  if (!versions || winner(state, field)?.value !== false || conflictSignature({ kind, entityId, state, field, versions }) !== signature) {
    throw new LibraryReadError('这条冲突已有新变化，请刷新后重新选择。', 'SYNC_CONFLICT_STALE');
  }
  return signature;
}

async function listSyncConflicts(selectedDirectory, expectedLibraryId, acknowledged = new Set()) {
  const root = await protocolRoot(selectedDirectory);
  const manifest = await readManifest(root);
  if (manifest.libraryID !== expectedLibraryId) throw new LibraryReadError('这个文件夹属于另一份同步库。', 'SYNC_LIBRARY_CHANGED');
  const { operations, byDevice, pending } = await readOperations(root, manifest);
  const ready = readyOperations(operations, byDevice);
  const entities = replay(ready);
  const logIncomplete = pending > 0 || ready.length < operations.length;
  const writeReady = manifest.version === 6 && isUUID(manifest.namingDeviceID) && !logIncomplete;
  const cycles = [];
  let total = 0;
  const collections = projectCollections(entities.collection, (entityId, versions) => {
    total++;
    if (cycles.length < conflictLimit) cycles.push({
      kind: 'collection', entityId, state: entities.collection.get(entityId), field: 'parentID', versions,
      selected: winner(entities.collection.get(entityId), 'parentID'),
    });
  });
  const conflicts = [];
  for (const conflict of fieldConflicts(entities)) {
    if (conflict.field === 'life' && acknowledged.has(conflictSignature(conflict))) continue;
    total++;
    if (conflicts.length < conflictLimit) conflicts.push(describeConflict(conflict, entities, collections, writeReady));
  }
  for (const cycle of cycles) {
    if (conflicts.length === conflictLimit) break;
    conflicts.push(describeConflict(cycle, entities, collections, writeReady, 'collection-cycle'));
  }
  return { format: manifest.version, total, truncated: total > conflicts.length, conflicts, logIncomplete };
}

async function readLibrary(selectedDirectory) {
  const root = await protocolRoot(selectedDirectory);
  const manifest = await readManifest(root);

  const { operations, byDevice, pending } = await readOperations(root, manifest);
  const ready = readyOperations(operations, byDevice);
  const entities = replay(ready);
  let syncConflicts = 0;
  const deletionConflictSignatures = [];
  const collections = projectCollections(entities.collection, () => syncConflicts++);
  for (const conflict of fieldConflicts(entities)) {
    syncConflicts++;
    if (conflict.field === 'life') deletionConflictSignatures.push(conflictSignature(conflict));
  }
  const { assets, identities } = projectAssets(entities, collections, manifest.version);
  const { originals, originalCandidates, hydrationCandidates, unreadable } = await locateOriginals(root, manifest.version, identities);
  for (const asset of assets) asset.available = originals.has(asset.id);
  const missing = assets.filter(asset => asset.kind !== 'link' && !asset.available).length;
  const warnings = [];
  const logIncomplete = pending > 0 || ready.length < operations.length;
  if (logIncomplete) warnings.push('部分整理记录尚未到齐，刷新后会继续读取。');
  if (missing) warnings.push(`有 ${missing} 份原件暂不可用。可打开「取回原件」查看进度或重试。`);
  if (unreadable && !missing) warnings.push('部分云盘原件路径暂不可读。');
  return {
    directoryName: path.basename(root), libraryId: manifest.libraryID, format: manifest.version,
    syncConflicts, deletionConflictSignatures,
    assets, collections: [...collections.values()].sort((left, right) => compare(left.name, right.name) || compare(left.id, right.id)),
    originals, originalCandidates, hydrationCandidates, warnings, logIncomplete, partial: warnings.length > 0,
  };
}

async function writeIdentity(directory) {
  const info = await fs.lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(directory, await fs.realpath(directory))) throw unsafePath();
  return `${info.dev}:${info.ino}`;
}

async function readWriteState(selectedDirectory, expectedLibraryId, deviceId, acknowledged = new Set()) {
  const root = await protocolRoot(selectedDirectory);
  if (!samePath(root, path.resolve(selectedDirectory))) throw unsafePath();
  const rootIdentity = await writeIdentity(root);
  const directory = path.join(root, 'changes');
  const manifest = await readManifest(root);
  if (manifest.libraryID !== expectedLibraryId) throw new LibraryReadError('这个文件夹属于另一份同步库。', 'SYNC_LIBRARY_CHANGED');
  if (manifest.version !== 6 || !isUUID(manifest.namingDeviceID)) {
    throw new LibraryReadError('请先在 iPhone 或 iPad 上将这份见藏同步库升级到格式 6。', 'SYNC_UPGRADE_REQUIRED');
  }
  const changesIdentity = await writeIdentity(directory).catch(error => {
    if (providerWait.has(error.code)) throw new LibraryReadError('同步记录尚未到齐，取回后再继续整理。', 'SYNC_LOG_PENDING');
    throw error;
  });
  const { operations, byDevice, pending, bytes } = await readOperations(root, manifest);
  const ready = readyOperations(operations, byDevice);
  if (pending || ready.length !== operations.length) {
    throw new LibraryReadError('同步记录尚未到齐，取回后再继续整理。', 'SYNC_LOG_PENDING');
  }
  const [nextManifest, endRoot, endChanges] = await Promise.all([readManifest(root), writeIdentity(root), writeIdentity(directory)]);
  if (rootIdentity !== endRoot || changesIdentity !== endChanges || nextManifest.libraryID !== expectedLibraryId || nextManifest.version !== manifest.version) {
    throw new LibraryReadError('同步文件夹已变化，请刷新后重试。', 'SYNC_LIBRARY_CHANGED');
  }
  const clock = new Map();
  const ownOperations = new Map();
  const revision = createHash('sha256');
  for (const operation of ready.toSorted((left, right) => compare(left.device, right.device) || left.counter - right.counter)) {
    clock.set(operation.device, operation.counter);
    if (operation.device === deviceId) ownOperations.set(operation.counter, operation.id);
    revision.update(operation.id).update('\0');
  }
  const entities = replay(ready);
  let conflicts = 0;
  const collections = projectCollections(entities.collection, () => conflicts++);
  for (const conflict of fieldConflicts(entities)) {
    if (conflict.field !== 'life' || !acknowledged.has(conflictSignature(conflict))) conflicts++;
  }
  const { assets } = projectAssets(entities, collections, manifest.version);
  const assetHistory = new Map();
  for (const [id, state] of entities.asset) {
    if (winner(state, 'life')?.value === false) {
      assetHistory.set(id, [...state.registers.keys()].filter(field => field.startsWith('tag:') || field.startsWith('member:')));
    }
  }
  return { root, rootIdentity, changesIdentity, clock, ownOperations, revision: revision.digest('hex'),
    remainingOperations: maxOperations - ready.length, remainingBytes: maxBytes - bytes,
    assets: new Map(assets.map(asset => [asset.id, asset])), collections, assetHistory, conflicts, entities,
    descriptors: new Map([...entities.asset].map(([id, state]) => [id, state.asset])) };
}

function validateWriteOperation(operation) {
  return decodeOperation(operation, operation.libraryID, 6, operation.deviceID, `${operation.counter}-${operation.id}.json`);
}

function historyField(state, kind, id, field) {
  const item = (kind === 'asset' ? state.assets : state.collections).get(id);
  if (!item) return null;
  const entity = state.entities[kind].get(id);
  const entry = winner(entity, field);
  const value = field.startsWith('tag:') ? item.tags.includes(field.slice(4))
    : field.startsWith('member:') ? item.collectionIds.includes(field.slice(7))
      : entry?.value ?? (field === 'name' ? item.name : historyDefaults.get(field));
  return { value, operation: entry?.operation.id ?? null, conflict: (entity.registers.get(field)?.length ?? 0) > 1 };
}

const historyDefaults = new Map([
  ['note', ''], ['sourceURL', null], ['rating', 0], ['favorite', false],
  ['deletedAt', null], ['parentID', null], ['colorHex', '46786B'],
]);

module.exports = { readLibrary, readWriteState, validateWriteOperation, listSyncConflicts, conflictChoice,
  confirmDeletionConflict, historyField, protocolRoot, readManifest, readJSON, inspect };
