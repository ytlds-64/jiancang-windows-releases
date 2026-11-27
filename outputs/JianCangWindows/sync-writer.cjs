'use strict';

const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { hostname } = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { readWriteState, validateWriteOperation, conflictChoice, confirmDeletionConflict, historyField, syncDeviceMetadata } = require('./sync-library.cjs');
const { openContainedFile } = require('./original-file.cjs');
const { webURL } = require('./local-workflow.cjs');
const { tagChangePlan } = require('./tag-actions.cjs');

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const journalFile = /^[1-9]\d*-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/i;
const stagingFile = /^sync-original-[0-9a-f-]{36}\.part$/i;
const maximumBatch = 10_000;
const maximumConflictBatch = 80;
const maximumHistoryGroups = 30;
const maximumHistoryBytes = 2 * 1024 ** 2;
const maximumHistoryAliasBytes = 16 * 1024 ** 2;
const secondsSinceAppleEpoch = 978_307_200;
const emptyStatus = { pending: 0, error: null, conflicts: 0, publishedAt: null, canUndo: false, canRedo: false, redoRemoves: false, historyRevision: null };
const nullValue = () => ({ null: {} });
const encoded = (type, value) => ({ [type]: { _0: value } });
const string = value => encoded('string', value);
const flag = value => encoded('bool', value);
const double = value => encoded('double', value);
const integer = value => encoded('int', value);
const optionalString = value => value == null ? nullValue() : string(value);
const own = (object, name) => Object.hasOwn(object, name);
const folded = text => text.normalize('NFC').toLowerCase();
const safeExtension = value => /^[a-z0-9]{1,16}$/.test(value) ? value : '';
const media = new Map(Object.entries({
  image: 'jpg jpeg jpe jfif png gif webp heic heif avif bmp tiff tif ico svg psd psb ai eps raw dng cr2 cr3 nef arw orf raf livp',
  video: 'mp4 m4v mov webm ogv avi mkv wmv flv mpg mpeg mts m2ts 3gp',
  audio: 'mp3 m4a wav aiff aif ogg flac aac ape opus wma mid midi', pdf: 'pdf', link: 'url webloc website webpage',
}).flatMap(([kind, extensions]) => extensions.split(' ').map(ext => [ext, kind])));
const assetKinds = new Set([...media.values(), 'document']);

let windowsDevice;
function currentWindowsDevice() {
  if (process.platform !== 'win32') return undefined;
  if (windowsDevice) return windowsDevice;
  let name = process.env.COMPUTERNAME;
  if (!name) {
    try { name = hostname().split('.')[0]; } catch { /* The OS may not have a configured name. */ }
  }
  windowsDevice = syncDeviceMetadata({ platform: 'windows', name });
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const bios = 'HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS';
  execFile(executable, ['query', bios, '/v', 'SystemProductName'], { windowsHide: true, timeout: 1_500 }, (error, stdout) => {
    if (error) return;
    const model = /\bSystemProductName[ \t]+REG_SZ[ \t]+([^\r\n]+)/i.exec(stdout)?.[1]?.trim();
    if (!model || /^(?:system product name|default string|to be filled by o\.e\.m\.)$/i.test(model)) return;
    const details = syncDeviceMetadata({ platform: 'windows', model });
    if (details.model) windowsDevice.model = details.model;
  });
  return windowsDevice;
}

function text(value, limit, multiline = false) {
  if (typeof value !== 'string') throw new Error('请输入有效文字。');
  const invalid = multiline ? /[\u0000-\u0008\u000b-\u001f\u007f\p{Cs}]/gu : /[\p{Cc}\p{Cs}]/gu;
  return Array.from(value.replace(/\r\n?/g, '\n').replace(invalid, ' ').trim().normalize('NFC')).slice(0, limit).join('').trim();
}

function name(value) {
  const result = text(value, 180);
  if (!result) throw new Error('请填写名称。');
  return result;
}

function tags(values) {
  if (!Array.isArray(values) || values.length > 4096) throw new Error('标签格式不正确。');
  const distinct = new Map();
  for (const value of values) {
    const item = text(value, 128);
    if (item && !distinct.has(folded(item))) distinct.set(folded(item), item);
  }
  return [...distinct.values()];
}

function url(value) {
  if (value == null || value === '') return null;
  const result = webURL(value);
  if (!result) throw new Error('请输入 HTTP 或 HTTPS 网页网址。');
  return result;
}

function rating(value) {
  if (!Number.isInteger(value) || value < 0 || value > 5) throw new Error('评分应在 0 到 5 之间。');
  return value;
}

function ids(value) {
  if (!Array.isArray(value) || value.length > maximumBatch || value.some(id => typeof id !== 'string')) {
    throw new Error('选择已变化，请刷新后重试。');
  }
  return [...new Set(value)];
}

function checkedCollections(value, collections) {
  const result = ids(value);
  if (result.some(id => !collections.has(id))) throw new Error('集合已变化，请刷新后重试。');
  return result;
}

function second(value) {
  const parsed = value == null ? NaN : new Date(value).getTime();
  return (Number.isFinite(parsed) ? parsed : Date.now()) / 1000;
}

function assetChange(state, id, changes, original) {
  const asset = original ?? state.descriptors.get(id);
  if (!asset) throw new Error('素材已变化，请刷新后重试。');
  return { kind: 'asset', id, changes, asset };
}

function deltaSet(changes, field, before, next) {
  const requested = new Set(next);
  const prior = new Set(before);
  for (const item of prior) if (!requested.has(item)) changes[field + item] = flag(false);
  for (const item of requested) if (!prior.has(item)) changes[field + item] = flag(true);
}

function editAssets(state, command) {
  const selected = ids(command.ids);
  if (!selected.length) throw new Error('请先选择素材。');
  const renaming = command.action === 'edit' && own(command, 'name');
  if (renaming && selected.length !== 1) throw new Error('请单独选中一项素材后修改名称。');
  const drops = own(command, 'removeTags') ? new Set(tags(command.removeTags).map(folded)) : new Set();
  const added = own(command, 'addTags') ? tags(command.addTags) : [];
  const setTags = own(command, 'tags') ? tags(command.tags) : null;
  const setCollections = own(command, 'collectionIds') ? checkedCollections(command.collectionIds, state.collections) : null;
  const moreCollections = own(command, 'addCollectionIds') ? checkedCollections(command.addCollectionIds, state.collections) : [];
  const removedCollections = new Set(command.action === 'edit' && own(command, 'removeCollectionIds')
    ? checkedCollections(command.removeCollectionIds, state.collections)
    : []);
  const changes = [];
  for (const id of selected) {
    const asset = state.assets.get(id);
    if (!asset) throw new Error('素材已变化，请刷新后重试。');
    const delta = {};
    if (command.action === 'trash' && !asset.trashed) delta.deletedAt = double(second());
    if (command.action === 'restore' && asset.trashed) delta.deletedAt = nullValue();
    if (command.action === 'edit') {
      if (own(command, 'note') && asset.note !== command.note) delta.note = string(text(command.note, 12_288, true));
      if (own(command, 'sourceURL') && asset.sourceURL !== command.sourceURL) delta.sourceURL = optionalString(url(command.sourceURL));
      if (own(command, 'rating') && asset.rating !== command.rating) delta.rating = integer(rating(command.rating));
      if (own(command, 'favorite') && asset.favorite !== command.favorite) {
        if (typeof command.favorite !== 'boolean') throw new Error('收藏选项不正确。');
        delta.favorite = flag(command.favorite);
      }
      if (setTags || drops.size || added.length) {
        const wanted = (setTags ?? asset.tags).filter(tag => !drops.has(folded(tag)));
        deltaSet(delta, 'tag:', asset.tags, tags([...wanted, ...added]));
      }
      if (setCollections || moreCollections.length || removedCollections.size) {
        const retained = (setCollections ?? asset.collectionIds).filter(id => !removedCollections.has(id));
        deltaSet(delta, 'member:', asset.collectionIds, [...retained, ...moreCollections]);
      }
      if (renaming) {
        const retained = (setCollections ?? asset.collectionIds).filter(id => !removedCollections.has(id));
        const plan = renameAssets(state, { action: 'planRename', entries: [{ id, name: command.name }] },
          [...retained, ...moreCollections]);
        if (plan.result.entries[0].name !== asset.name) delta.name = string(plan.result.entries[0].name);
      }
    }
    if (Object.keys(delta).length) changes.push(assetChange(state, id, delta));
  }
  return { changes, result: { count: changes.length } };
}

function renameAssets(state, command, targetCollections) {
  if (!Array.isArray(command.entries) || !command.entries.length || command.entries.length > maximumBatch) throw new Error('请选择要改名的素材。');
  const selected = new Map();
  for (const entry of command.entries) {
    if (!entry || selected.has(entry.id) || !state.assets.has(entry.id)) throw new Error('选择已变化，请刷新后重试。');
    selected.set(entry.id, entry.name);
  }
  if (own(command, 'revision') && command.revision !== state.revision) throw new Error('素材已变化，请核对最新名称后重试。');
  const occupied = new Set();
  const locations = asset => asset.collectionIds.length ? asset.collectionIds : [''];
  const fileKey = (location, ext, value) => `${location}\0${ext}\0${folded(value)}`;
  for (const asset of state.assets.values()) {
    if (asset.trashed || selected.has(asset.id)) continue;
    for (const location of locations(asset)) occupied.add(fileKey(location, asset.extension, asset.name));
  }
  const entries = [], changes = [];
  for (const [id, requested] of selected) {
    const asset = state.assets.get(id);
    const extension = asset.extension ? `.${asset.extension}` : '';
    let base = name(requested);
    if (extension && base.toLowerCase().endsWith(extension) && base.length > extension.length) base = name(base.slice(0, -extension.length));
    let candidate = base;
    let number = 2;
    const places = locations(targetCollections ? { collectionIds: targetCollections } : asset);
    while (places.some(location => occupied.has(fileKey(location, asset.extension, candidate)))) {
      candidate = `${Array.from(base).slice(0, 165).join('').trimEnd()} (${number++})`;
    }
    for (const location of places) occupied.add(fileKey(location, asset.extension, candidate));
    if (command.action === 'rename' && asset.name !== candidate) changes.push(assetChange(state, id, { name: string(candidate) }));
    entries.push({ id, oldName: asset.name, name: candidate });
  }
  return { changes, result: { entries } };
}

function applySuggestion(state, command) {
  const asset = state.assets.get(command.id);
  const expected = command.expected;
  if (!asset || asset.trashed || (expected !== undefined && (asset.name !== expected?.name || asset.note !== expected?.note ||
      JSON.stringify([...asset.tags].sort()) !== JSON.stringify(Array.isArray(expected?.tags) ? [...expected.tags].sort() : null)))) {
    throw new Error('素材的整理信息已变化，请重新生成建议。');
  }
  const delta = {};
  let nextName = asset.name;
  if (own(command, 'title')) {
    const plan = renameAssets(state, { action: 'planRename', entries: [{ id: asset.id, name: command.title }] });
    nextName = plan.result.entries[0].name;
    if (nextName !== asset.name) delta.name = string(nextName);
  }
  if (own(command, 'tags')) deltaSet(delta, 'tag:', asset.tags, tags([...asset.tags, ...tags(command.tags)]));
  if (own(command, 'note')) {
    const note = text(command.note, 12_288, true);
    if (note !== asset.note) delta.note = string(note);
  }
  const changes = Object.keys(delta).length ? [assetChange(state, asset.id, delta)] : [];
  return { changes, result: { count: changes.length, name: nextName } };
}

function checkParent(collections, parent, child) {
  const visited = new Set([child]);
  for (let id = parent; id !== null; id = collections.get(id).parentId) {
    if (!collections.has(id)) throw new Error('上级集合已变化，请刷新后重试。');
    if (visited.has(id) || visited.size >= 127) throw new Error('不能将集合放入自己的子集合，或超过允许的层级。');
    visited.add(id);
  }
}

function collectionBirth(collection) {
  return { kind: 'collection', id: collection.id, changes: {
    life: flag(true), name: string(collection.name), parentID: optionalString(collection.parentId),
    colorHex: string(collection.color), symbol: string('folder'), createdAt: double(second()),
  } };
}

function changeCollection(state, command) {
  const { action, id } = command;
  const collections = state.collections;
  const previous = collections.get(id);
  if (!previous && action !== 'createCollection') throw new Error('集合已变化，请刷新后重试。');
  if (action === 'deleteCollection') {
    const children = new Map();
    for (const item of collections.values()) {
      if (!children.has(item.parentId)) children.set(item.parentId, []);
      children.get(item.parentId).push(item.id);
    }
    const removed = new Set([id]);
    for (const parent of removed) for (const child of children.get(parent) ?? []) removed.add(child);
    return { changes: [...removed].map(id => ({ kind: 'collection', id, changes: { life: flag(false) } })), result: { id, count: removed.size } };
  }
  const title = name(command.name ?? previous?.name);
  const parentId = own(command, 'parentId') ? command.parentId ?? null : previous?.parentId ?? null;
  checkParent(collections, parentId, id);
  if ([...collections.values()].some(item => item.id !== id && item.parentId === parentId && folded(item.name) === folded(title))) {
    throw new Error('这个位置已有同名集合。');
  }
  const color = typeof command.color === 'string' && /^[0-9a-f]{6}$/i.test(command.color) ? command.color : previous?.color ?? '46786B';
  if (!previous) {
    const id = randomUUID();
    return { changes: [collectionBirth({ id, name: title, parentId, color })], result: { id } };
  }
  const delta = {};
  if (title !== previous.name) delta.name = string(title);
  if (parentId !== previous.parentId) delta.parentID = optionalString(parentId);
  if (color !== previous.color) delta.colorHex = string(color);
  return { changes: Object.keys(delta).length ? [{ kind: 'collection', id, changes: delta }] : [], result: { id } };
}

function mutationFor(state, command) {
  switch (command?.action) {
    case 'edit': case 'trash': case 'restore': return editAssets(state, command);
    case 'purgeTrash': {
      if (command.trashRevision !== state.trashRevision || command.all === true) {
        throw new Error('回收站已更新，请重新确认要删除的素材。');
      }
      const selected = ids(command.ids);
      if (!selected.length || selected.some(id => !state.assets.get(id)?.trashed)) {
        throw new Error('回收站已更新，请重新确认要删除的素材。');
      }
      const changes = selected.map(id => assetChange(state, id, { life: flag(false) }));
      return { changes, result: { count: changes.length } };
    }
    case 'resolveConflict': {
      const { kind, entityId: id, field } = command;
      const delta = { [field]: conflictChoice(state, command) };
      const change = kind === 'asset' ? assetChange(state, id, delta) : { kind, id, changes: delta };
      return { changes: [change], result: { id, count: 1 } };
    }
    case 'planTagChange':
    case 'changeTag': {
      const plan = tagChangePlan(state.assets.values(), command, state.revision);
      if (plan.updates.length > maximumBatch || plan.updates.length > state.remainingOperations) {
        throw new Error('此标签涉及的素材数量超过本次同步编辑可处理的范围。');
      }
      const changes = [];
      if (command.action === 'changeTag') {
        for (const { asset, tags } of plan.updates) {
          const delta = {};
          deltaSet(delta, 'tag:', asset.tags, tags);
          if (Object.keys(delta).length) changes.push(assetChange(state, asset.id, delta));
        }
      }
      return { changes, result: plan.result };
    }
    case 'applySuggestion': return applySuggestion(state, command);
    case 'planRename': case 'rename': return renameAssets(state, command);
    case 'createCollection': case 'editCollection': case 'deleteCollection': return changeCollection(state, command);
    default: throw new Error('此操作未受支持。');
  }
}

const historyActions = new Set(['edit', 'rename', 'trash', 'restore', 'changeTag', 'applySuggestion', 'editCollection']);
const historyTypes = new Map([
  ['name', 'string'], ['note', 'string'], ['sourceURL', 'string'], ['favorite', 'bool'], ['rating', 'int'],
  ['deletedAt', 'double'], ['parentID', 'string'], ['colorHex', 'string'],
]);

function historyPayload(state, changes, versionFor) {
  const changesets = [];
  for (const { kind, id, operationId, changes: fields } of changes) {
    const deltas = [];
    for (const [field, wireValue] of Object.entries(fields)) {
      const before = historyField(state, kind, id, field);
      if (!before || before.conflict || before.value === undefined) return null;
      const after = wireValue.null ? null : Object.values(wireValue)[0]._0;
      deltas.push({ field, before: before.value, after, prior: versionFor(before.operation, field), next: operationId });
    }
    changesets.push({ kind, id, fields: deltas });
  }
  const payload = JSON.stringify(changesets);
  return Buffer.byteLength(payload) <= maximumHistoryBytes ? {
    payload,
    removes: changesets.some(change => change.fields.some(field => field.field === 'deletedAt' && field.after !== null)),
  } : null;
}

function historyMutation(state, groups, undo, versionFor) {
  const changes = [];
  for (const { kind, id, fields } of groups) {
    const delta = {};
    const historyAliases = {};
    for (const { field, before, after, prior, next } of fields) {
      const latest = historyField(state, kind, id, field);
      const expected = undo ? after : before;
      const value = undo ? before : after;
      if (!latest || latest.conflict || latest.value !== expected ||
          versionFor(latest.operation, field) !== (undo ? next : prior)) return null;
      if (value === true && field.startsWith('member:') && !state.collections.has(field.slice(7))) return null;
      const type = field.startsWith('tag:') || field.startsWith('member:') ? 'bool' : historyTypes.get(field);
      if (!type) return null;
      delta[field] = value === null ? nullValue() : encoded(type, value);
      historyAliases[field] = undo ? prior : next;
    }
    if (kind === 'collection') {
      const previous = state.collections.get(id);
      const parent = delta.parentID ? delta.parentID.string?._0 ?? null : previous.parentId;
      const title = delta.name?.string?._0 ?? previous.name;
      try { checkParent(state.collections, parent, id); }
      catch { return null; }
      if ([...state.collections.values()].some(item => item.id !== id && item.parentId === parent && folded(item.name) === folded(title))) return null;
    }
    const change = kind === 'asset' ? assetChange(state, id, delta) : { kind, id, changes: delta };
    changes.push({ ...change, historyAliases });
  }
  return changes;
}

function additionsFor(state, input, assetId) {
  const collections = new Map(state.collections);
  const changes = [];
  const memberIds = new Set(checkedCollections(input.collectionIds ?? [], collections));
  const start = input.collectionParentId ?? null;
  checkParent(collections, start, null);
  for (const trail of input.collectionPaths ?? []) {
    if (!Array.isArray(trail) || trail.length > 32) continue;
    let parentId = start;
    for (const segment of trail) {
      const title = name(segment);
      let current = [...collections.values()].find(item => item.parentId === parentId && folded(item.name) === folded(title));
      if (!current) {
        current = { id: randomUUID(), name: title, parentId, color: '46786B' };
        collections.set(current.id, current);
        changes.push(collectionBirth(current));
      }
      parentId = current.id;
    }
    if (parentId) memberIds.add(parentId);
  }
  const asset = state.assets.get(assetId);
  const incoming = tags(input.tags ?? []);
  const delta = {};
  if (asset) {
    deltaSet(delta, 'tag:', asset.tags, tags([...asset.tags, ...incoming]));
    deltaSet(delta, 'member:', asset.collectionIds, [...asset.collectionIds, ...memberIds]);
    if (asset.trashed) delta.deletedAt = nullValue();
  } else {
    for (const tag of incoming) delta[`tag:${tag}`] = flag(true);
    for (const member of memberIds) delta[`member:${member}`] = flag(true);
  }
  return { changes, delta, existing: !!asset };
}

async function directoryIdentity(location) {
  const actual = await fs.realpath(location);
  const info = await fs.lstat(location, { bigint: true });
  if (path.relative(location, actual) !== '' || info.isSymbolicLink() || !info.isDirectory()) throw new Error('同步文件夹位置已变化，请重新连接。');
  return `${info.dev}:${info.ino}`;
}

async function assertDirectory(location, identity) {
  if (await directoryIdentity(location) !== identity) throw new Error('同步文件夹位置已变化，请重新连接。');
}

async function publishOperation(state, operation) {
  const { publishSyncFileNoReplace, validateSyncWriteRoot } = require('./sync-upload.cjs');
  const base = path.join(state.root, 'changes');
  const device = path.join(base, operation.deviceID);
  if (await validateSyncWriteRoot(state.root, operation.libraryID) !== state.rootIdentity) throw new Error('同步文件夹位置已变化，请重新连接。');
  await assertDirectory(base, state.changesIdentity);
  try { await fs.mkdir(device); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const deviceIdentity = await directoryIdentity(device);
  const target = path.join(device, `${operation.counter}-${operation.id}.json`);
  const stage = path.join(device, `.materialshelf-publish-${randomUUID()}`);
  const expected = Buffer.from(JSON.stringify(operation), 'utf8');
  const output = await fs.open(stage, 'wx', 0o600);
  try {
    try { await output.writeFile(expected); await output.sync(); }
    finally { await output.close(); }
    if (await validateSyncWriteRoot(state.root, operation.libraryID) !== state.rootIdentity) throw new Error('同步文件夹位置已变化，请重新连接。');
    await assertDirectory(base, state.changesIdentity);
    await assertDirectory(device, deviceIdentity);
    try { await publishSyncFileNoReplace(stage, target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const original = await openContainedFile(device, target, expected.length);
      try {
        if (!expected.equals(await original.readFile())) throw new Error('这条同步记录已存在其他内容，已暂停写入。');
      } finally { await original.close(); }
    }
  } finally {
    if (await directoryIdentity(device).catch(() => null) === deviceIdentity) await fs.rm(stage, { force: true }).catch(() => {});
  }
  return path.basename(target);
}

function checkPredecessors(state, operation) {
  for (const [device, counter] of Object.entries(operation.clock)) {
    const dependency = device === operation.deviceID ? counter - 1 : counter;
    if ((state.clock.get(device) ?? 0) < dependency) throw new Error('同步记录尚未到齐，取回后将继续写入。');
  }
  const observed = state.ownOperations.get(operation.counter);
  if (observed && observed !== operation.id) throw new Error('同步设备序号发生冲突，已暂停写入。');
}

function queueError(error) {
  if (['ENOSPC', 'EDQUOT'].includes(error.code)) return '同步目录空间不足，腾出空间后重试。';
  if (['EPERM', 'EACCES', 'EROFS', 'EBUSY', 'ENODATA', 'EIO', 'UNKNOWN', 'ETIMEDOUT'].includes(error.code)) {
    return '暂时无法写入同步目录，确认 iCloud Drive 文件可用后重试。';
  }
  return error.code && !String(error.code).startsWith('SYNC_') ? '同步暂未完成，请在素材库中重试。' : error.message;
}

function conflictFailure(command, error) {
  return { signature: typeof command?.signature === 'string' ? command.signature : null, status: 'failed',
    message: queueError(error) || '这条冲突暂未处理，请重试。',
    ...(String(error.code).startsWith('SYNC_') && { code: error.code }) };
}

function changesCollectionStructure(command) {
  return command.kind === 'collection' && ['name', 'parentID'].includes(command.field);
}

class DirectorySyncWriter {
  #db;
  #tail = Promise.resolve();

  constructor({ directory, publishOriginal, onChange, device } = {}) {
    if (!path.isAbsolute(directory ?? '')) throw new TypeError('A private sync journal directory is required.');
    this.directory = directory;
    this.staging = path.join(directory, 'staging');
    this.publishOriginal = publishOriginal;
    this.onChange = onChange;
    this.device = device ? syncDeviceMetadata(device) : currentWindowsDevice();
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const initial = await fs.lstat(this.directory);
    if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error('无法打开本机同步队列。');
    this.directory = await fs.realpath(this.directory);
    this.staging = path.join(this.directory, 'staging');
    await directoryIdentity(this.directory);
    await fs.mkdir(this.staging, { recursive: true, mode: 0o700 });
    await directoryIdentity(this.staging);
    for (const basename of ['journal.sqlite', 'journal.sqlite-wal', 'journal.sqlite-shm']) {
      const file = await fs.lstat(path.join(this.directory, basename)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (file && (!file.isFile() || file.isSymbolicLink())) throw new Error('无法打开本机同步队列。');
    }
    this.#db = new DatabaseSync(path.join(this.directory, 'journal.sqlite'));
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS producer (
        library_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, counter INTEGER NOT NULL,
        error TEXT, conflicts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS outbound (
        library_id TEXT NOT NULL, counter INTEGER NOT NULL, payload TEXT NOT NULL, staged TEXT,
        PRIMARY KEY (library_id, counter)
      );
      CREATE TABLE IF NOT EXISTS publication (
        library_id TEXT PRIMARY KEY, filename TEXT NOT NULL, published_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS upload_jobs (
        library_id TEXT NOT NULL, job_id TEXT NOT NULL, asset_id TEXT NOT NULL, existing INTEGER NOT NULL,
        PRIMARY KEY (library_id, job_id)
      );
      CREATE TABLE IF NOT EXISTS edit_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, library_id TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0,
        removes INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS edit_history_library ON edit_history (library_id, undone, id);
      CREATE TABLE IF NOT EXISTS edit_history_aliases (
        library_id TEXT NOT NULL, operation_id TEXT NOT NULL, counter INTEGER NOT NULL, bytes INTEGER NOT NULL, fields TEXT NOT NULL,
        PRIMARY KEY (library_id, operation_id)
      );
      CREATE INDEX IF NOT EXISTS edit_history_alias_order ON edit_history_aliases (library_id, counter);
      CREATE TABLE IF NOT EXISTS acknowledged_conflicts (
        library_id TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY (library_id, signature)
      );
    `);
    const active = new Set(this.#db.prepare('SELECT staged FROM outbound WHERE staged IS NOT NULL').all().map(record => record.staged));
    for (const entry of await fs.readdir(this.staging, { withFileTypes: true })) {
      if ((entry.isFile() || entry.isSymbolicLink()) && stagingFile.test(entry.name) && !active.has(entry.name)) {
        await fs.rm(path.join(this.staging, entry.name), { force: true }).catch(() => {});
      }
    }
  }

  async close() {
    await this.#tail;
    this.#db?.close();
    this.#db = null;
  }

  studioDeviceID(libraryId) { return this.#producer(libraryId).device_id.toLowerCase(); }

  status(libraryId) {
    if (!this.#db || typeof libraryId !== 'string') return { ...emptyStatus };
    const details = this.#db.prepare(`
      SELECT error, conflicts, published_at FROM producer LEFT JOIN publication USING (library_id)
      WHERE library_id = ?
    `).get(libraryId);
    const { pending } = this.#db.prepare('SELECT COUNT(*) AS pending FROM outbound WHERE library_id = ?').get(libraryId);
    const undo = this.#db.prepare('SELECT 1 FROM edit_history WHERE library_id = ? AND undone = 0 LIMIT 1').get(libraryId);
    const redo = this.#db.prepare('SELECT id, removes FROM edit_history WHERE library_id = ? AND undone = 1 ORDER BY id LIMIT 1').get(libraryId);
    return { pending, error: details?.error ?? null, conflicts: details?.conflicts ?? 0, publishedAt: details?.published_at ?? null,
      canUndo: !!undo, canRedo: !!redo, redoRemoves: !!redo?.removes, historyRevision: redo ? String(redo.id) : null };
  }

  async lastPublishedPath(entry) {
    if (!uuid.test(entry.libraryId ?? '')) throw new Error('此同步库暂不可用。');
    const latest = this.#db?.prepare(`
      SELECT device_id, filename FROM publication JOIN producer USING (library_id) WHERE library_id = ?
    `).get(entry.libraryId);
    if (!latest || !uuid.test(latest.device_id) || !journalFile.test(latest.filename)) {
      throw new Error('这台电脑暂无可定位的同步记录。');
    }
    try {
      const { validateSyncWriteRoot } = require('./sync-upload.cjs');
      const rootIdentity = await validateSyncWriteRoot(entry.root, entry.libraryId);
      const changes = path.join(entry.root, 'changes');
      const changesIdentity = await directoryIdentity(changes);
      const device = path.join(changes, latest.device_id);
      const deviceIdentity = await directoryIdentity(device);
      const file = path.join(device, latest.filename);
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error();
      await Promise.all([assertDirectory(entry.root, rootIdentity), assertDirectory(changes, changesIdentity),
        assertDirectory(device, deviceIdentity)]);
      return file;
    } catch {
      throw new Error('最新记录在此文件夹中暂不可用。请打开同步文件夹，检查 iCloud 云盘状态。');
    }
  }

  acknowledgedConflicts(libraryId) {
    return new Set(this.#db?.prepare('SELECT signature FROM acknowledged_conflicts WHERE library_id = ?')
      .all(libraryId).map(row => row.signature));
  }

  #run(action) {
    const next = this.#tail.then(action);
    this.#tail = next.catch(() => {});
    return next;
  }

  #producer(libraryId) {
    if (!this.#db || !uuid.test(libraryId ?? '')) throw new Error('无法识别同步库。');
    let producer = this.#db.prepare('SELECT * FROM producer WHERE library_id = ?').get(libraryId);
    if (!producer) {
      producer = { library_id: libraryId, device_id: randomUUID(), counter: 0 };
      this.#db.prepare('INSERT INTO producer (library_id, device_id, counter) VALUES (?, ?, ?)')
        .run(libraryId, producer.device_id, producer.counter);
    }
    return producer;
  }

  #saveStatus(libraryId, error, conflicts) {
    this.#db.prepare('UPDATE producer SET error = ?, conflicts = COALESCE(?, conflicts) WHERE library_id = ?')
      .run(error ?? null, conflicts ?? null, libraryId);
    try { this.onChange?.(libraryId, this.status(libraryId)); } catch { /* This is a notification only. */ }
  }

  #historyVersion(libraryId) {
    const read = this.#db.prepare('SELECT fields FROM edit_history_aliases WHERE library_id = ? AND operation_id = ?');
    const decoded = new Map();
    return (operation, field) => {
      if (!operation) return null;
      if (!decoded.has(operation)) decoded.set(operation, JSON.parse(read.get(libraryId, operation)?.fields ?? '{}'));
      const aliases = decoded.get(operation);
      return own(aliases, field) ? aliases[field] : operation;
    };
  }

  #queue(producer, state, changes, { staged, job, history, replay } = {}) {
    if (changes.length > maximumBatch) throw new Error('批量项目过多，请分批操作。');
    if (changes.length > state.remainingOperations) throw new Error('这个同步库的整理记录已达上限。');
    if ((state.clock.get(producer.device_id) ?? 0) !== producer.counter) throw new Error('本机之前的同步记录尚未到齐，请取回后重试。');
    const clock = Object.fromEntries(state.clock);
    let counter = producer.counter;
    const operations = changes.map(change => {
      const operation = { version: 1, id: change.operationId ?? randomUUID(), libraryID: producer.library_id,
        deviceID: producer.device_id, counter: ++counter, clock: { ...clock, [producer.device_id]: counter },
        entityKind: change.kind, entityID: change.id, changes: change.changes,
        ...(change.asset && { asset: change.asset }), ...(this.device && { device: this.device }) };
      validateWriteOperation(operation);
      const payload = JSON.stringify(operation);
      if (Buffer.byteLength(payload) > 2 * 1024 ** 2) throw new Error('单条同步记录过大，请减少修改内容。');
      return { operation, payload, historyAliases: change.historyAliases };
    });
    const total = operations.reduce((sum, entry) => sum + Buffer.byteLength(entry.payload), 0);
    if (total > state.remainingBytes) throw new Error('这个同步库的整理记录已达大小上限。');
    if (total > 32 * 1024 ** 2) {
      throw new Error('本次同步记录过大，请分批操作。');
    }
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.#db.prepare('INSERT INTO outbound (library_id, counter, payload, staged) VALUES (?, ?, ?, ?)');
      for (const { operation, payload } of operations) {
        insert.run(producer.library_id, operation.counter, payload, operation.id === job?.id ? staged ?? null : null);
      }
      if (job) this.#db.prepare('INSERT INTO upload_jobs (library_id, job_id, asset_id, existing) VALUES (?, ?, ?, ?)')
        .run(producer.library_id, job.id, job.assetId, Number(job.existing));
      if (history !== undefined) {
        this.#db.prepare('DELETE FROM edit_history WHERE library_id = ? AND undone = 1').run(producer.library_id);
        if (history) {
          this.#db.prepare('INSERT INTO edit_history (library_id, removes, payload) VALUES (?, ?, ?)')
            .run(producer.library_id, Number(history.removes), history.payload);
          this.#db.prepare(`DELETE FROM edit_history WHERE library_id = ? AND id IN (
            SELECT id FROM edit_history WHERE library_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?
          )`).run(producer.library_id, producer.library_id, maximumHistoryGroups);
        }
      }
      if (replay) {
        this.#db.prepare('UPDATE edit_history SET undone = ? WHERE id = ?').run(replay.undone, replay.id);
        const save = this.#db.prepare('INSERT INTO edit_history_aliases VALUES (?, ?, ?, ?, ?)');
        for (const { operation, historyAliases } of operations) {
          const fields = JSON.stringify(historyAliases);
          save.run(producer.library_id, operation.id, operation.counter, Buffer.byteLength(fields), fields);
        }
        this.#db.prepare(`DELETE FROM edit_history_aliases WHERE library_id = ? AND operation_id IN (
          SELECT operation_id FROM (
            SELECT operation_id, SUM(bytes) OVER (ORDER BY counter DESC) AS retained
            FROM edit_history_aliases WHERE library_id = ?
          ) WHERE retained > ?
        )`).run(producer.library_id, producer.library_id, maximumHistoryAliasBytes);
      }
      this.#db.prepare('UPDATE producer SET counter = ? WHERE library_id = ?').run(counter, producer.library_id);
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }

  async #drain(entry, producer, observed, progress) {
    const libraryId = entry.libraryId;
    let state = observed;
    try {
      state ??= await readWriteState(entry.root, libraryId, producer.device_id, this.acknowledgedConflicts(libraryId));
      const rows = this.#db.prepare('SELECT counter, payload, staged FROM outbound WHERE library_id = ? ORDER BY counter').all(libraryId);
      const remove = this.#db.prepare('DELETE FROM outbound WHERE library_id = ? AND counter = ?');
      const savePublication = this.#db.prepare(`
        INSERT INTO publication (library_id, filename, published_at) VALUES (?, ?, ?)
        ON CONFLICT(library_id) DO UPDATE SET filename = excluded.filename, published_at = excluded.published_at
      `);
      for (const row of rows) {
        const operation = JSON.parse(row.payload);
        validateWriteOperation(operation);
        if (operation.deviceID !== producer.device_id || operation.libraryID !== libraryId || operation.counter !== row.counter) {
          throw new Error('无法读取本机同步队列。');
        }
        checkPredecessors(state, operation);
        const recorded = state.ownOperations.has(operation.counter);
        const bytes = Buffer.byteLength(row.payload);
        if (!recorded && (state.remainingOperations < 1 || state.remainingBytes < bytes)) {
          throw new Error('这个同步库的整理记录已达上限。本机待提交的内容仍在队列里。');
        }
        if (row.staged) {
          if (!stagingFile.test(row.staged) || operation.changes.life?.bool?._0 !== true) throw new Error('无法读取待上传原件。');
          const { publishSyncOriginal } = require('./sync-upload.cjs');
          const staged = path.join(this.staging, row.staged);
          await assertDirectory(state.root, state.rootIdentity);
          const onProgress = operation.id === progress?.jobId ? progress.report : undefined;
          await (this.publishOriginal ?? publishSyncOriginal)({ root: state.root, libraryId, birthId: operation.id,
            prepared: { blob: operation.asset.blob, fileExtension: operation.asset.fileExtension, file: staged }, onProgress });
        }
        const filename = await publishOperation(state, operation);
        this.#db.exec('BEGIN IMMEDIATE');
        try {
          savePublication.run(libraryId, filename, Date.now());
          remove.run(libraryId, row.counter);
          this.#db.exec('COMMIT');
        } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
        state.clock.set(operation.deviceID, Math.max(state.clock.get(operation.deviceID) ?? 0, operation.counter));
        state.ownOperations.set(operation.counter, operation.id);
        if (!recorded) { state.remainingOperations--; state.remainingBytes -= bytes; }
        if (row.staged) await fs.rm(path.join(this.staging, row.staged), { force: true }).catch(() => {});
      }
      this.#saveStatus(libraryId, null, state.conflicts);
      return true;
    } catch (error) {
      this.#saveStatus(libraryId, queueError(error), state?.conflicts);
      return false;
    }
  }

  async #latest(entry) {
    const producer = this.#producer(entry.libraryId);
    if (this.status(entry.libraryId).pending && !await this.#drain(entry, producer)) {
      throw new Error('这份素材库仍有未写入的修改，请先完成同步重试。');
    }
    try {
      const state = await readWriteState(entry.root, entry.libraryId, producer.device_id, this.acknowledgedConflicts(entry.libraryId));
      this.#saveStatus(entry.libraryId, null, state.conflicts);
      return { state, producer };
    } catch (error) {
      this.#saveStatus(entry.libraryId, queueError(error));
      throw error;
    }
  }

  #acknowledgeConflict(entry, state, command) {
    const signature = confirmDeletionConflict(state, command);
    return this.#db.prepare('INSERT OR IGNORE INTO acknowledged_conflicts VALUES (?, ?)')
      .run(entry.libraryId, signature).changes;
  }

  resolveConflicts(entry, commands) {
    return this.#run(async () => {
      if (!Array.isArray(commands) || commands.length < 1 || commands.length > maximumConflictBatch) {
        throw new Error(`请选择 1 到 ${maximumConflictBatch} 条同步冲突。`);
      }
      const results = Array(commands.length);
      const rows = [];
      const seen = new Set();
      commands.forEach((command, index) => {
        try {
          if (typeof command?.signature !== 'string' || !/^[a-f0-9]{64}$/.test(command.signature) ||
              !['asset', 'collection'].includes(command.kind) || typeof command.entityId !== 'string' ||
              typeof command.field !== 'string') throw new Error('这条冲突已有新变化，请刷新后重新选择。');
          const key = JSON.stringify([command.kind, command.entityId, command.field]);
          if (seen.has(key)) throw new Error('同一项素材资料只能选择一个值。');
          seen.add(key);
          rows.push({ command: { ...command, action: 'resolveConflict' }, index });
        } catch (error) { results[index] = conflictFailure(command, error); }
      });

      for (let start = 0; start < rows.length;) {
        let end = start + 1;
        // Independent fields can share one verified replay. Recheck the tree
        // after each rename or move so two valid-looking rows cannot form a cycle or duplicate a name.
        if (!changesCollectionStructure(rows[start].command)) {
          while (end < rows.length && !changesCollectionStructure(rows[end].command)) end++;
        }
        let latest;
        try { latest = await this.#latest(entry); }
        catch (error) {
          for (const { command, index } of rows.slice(start)) results[index] = conflictFailure(command, error);
          break;
        }
        const settled = await this.#resolveConflictGroup(entry, latest, rows.slice(start, end), results);
        if (!settled) {
          const error = new Error('前面的选择已保存到本机。请提交待写入记录后再处理这一项。');
          for (const { command, index } of rows.slice(end)) results[index] = conflictFailure(command, error);
          break;
        }
        start = end;
      }
      return { results, ...this.status(entry.libraryId) };
    });
  }

  async #resolveConflictGroup(entry, { state, producer }, rows, results) {
    let acknowledged = 0;
    const ready = [];
    for (const { command, index } of rows) {
      try {
        if (command.acknowledgeDeletion === true) {
          acknowledged += this.#acknowledgeConflict(entry, state, command);
          results[index] = { signature: command.signature, status: 'resolved', acknowledged: true };
        } else {
          const { changes: [change] } = mutationFor(state, command);
          change.operationId = randomUUID();
          ready.push({ command, index, change });
        }
      } catch (error) { results[index] = conflictFailure(command, error); }
    }

    try { if (ready.length) this.#queue(producer, state, ready.map(({ change }) => change)); }
    catch (error) {
      for (const { command, index } of ready) results[index] = conflictFailure(command, error);
      if (acknowledged) this.#saveStatus(entry.libraryId, null, Math.max(0, state.conflicts - acknowledged));
      return true;
    }
    const published = !ready.length || await this.#drain(entry, producer, state);
    const { error } = this.status(entry.libraryId);
    let resolved = acknowledged;
    ready.forEach(({ command, index, change }, offset) => {
      const written = state.ownOperations.get(producer.counter + 1 + offset) === change.operationId;
      if (written) resolved++;
      results[index] = { signature: command.signature, status: written ? 'resolved' : 'pending',
        ...(!written && { message: error || '选择已保存到本机，可在同步状态中重试提交。' }) };
    });
    if (resolved) this.#saveStatus(entry.libraryId, error, Math.max(0, state.conflicts - resolved));
    return published;
  }

  mutate(entry, command) {
    return this.#run(async () => {
      const { state, producer } = await this.#latest(entry);
      if (command?.action === 'undo' || command?.action === 'redo') {
        return this.#replayHistory(entry, state, producer, command);
      }
      if (command?.action === 'resolveConflict' && command.acknowledgeDeletion === true) {
        const saved = this.#acknowledgeConflict(entry, state, command);
        this.#saveStatus(entry.libraryId, null, Math.max(0, state.conflicts - saved));
        return { acknowledged: true, ...this.status(entry.libraryId) };
      }
      const { changes, result } = mutationFor(state, command);
      const { revision } = state;
      if (changes.length) {
        let history = null;
        if (historyActions.has(command.action)) {
          for (const change of changes) change.operationId = randomUUID();
          history = historyPayload(state, changes, this.#historyVersion(entry.libraryId));
        }
        this.#queue(producer, state, changes, { history });
        const published = await this.#drain(entry, producer, state);
        if (published && command.action === 'resolveConflict') this.#saveStatus(entry.libraryId, null, state.conflicts - 1);
      }
      return { ...result, revision, ...this.status(entry.libraryId) };
    });
  }

  async #replayHistory(entry, state, producer, command) {
    const libraryId = entry.libraryId;
    const undo = command.action === 'undo';
    const name = undo ? '撤销' : '重做';
    const result = undo ? 'undone' : 'redone';
    const record = this.#db.prepare(`SELECT id, removes, payload FROM edit_history WHERE library_id = ? AND undone = ?
      ORDER BY id ${undo ? 'DESC' : 'ASC'} LIMIT 1`).get(libraryId, undo ? 0 : 1);
    if (!record) return { [result]: false, message: `没有可以${name}的同步库整理。`, ...this.status(libraryId) };
    if (!undo && (record.removes || command.revision !== undefined) && command.revision !== String(record.id)) {
      throw new Error('同步库重做记录已变化，请重新确认。');
    }
    const changes = historyMutation(state, JSON.parse(record.payload), undo, this.#historyVersion(libraryId));
    if (!changes) {
      this.#db.prepare('DELETE FROM edit_history WHERE id = ?').run(record.id);
      this.#saveStatus(libraryId, null, state.conflicts);
      return { [result]: false, message: `相关资料已有新变化，已跳过这一条${name}记录。`, ...this.status(libraryId) };
    }
    this.#queue(producer, state, changes, { replay: { id: record.id, undone: Number(undo) } });
    await this.#drain(entry, producer, state);
    return { [result]: true, ...this.status(libraryId) };
  }

  retry(entry) {
    return this.#run(async () => {
      const producer = this.#producer(entry.libraryId);
      await this.#drain(entry, producer);
      return this.status(entry.libraryId);
    });
  }

  upload(entry, input) {
    return this.#run(async () => {
      if (!uuid.test(input?.jobId ?? '')) throw new Error('无法识别此导入任务。');
      const libraryId = entry.libraryId;
      const report = typeof input.onProgress === 'function' ? input.onProgress : undefined;
      const publication = report && { jobId: input.jobId, report: fraction => report(0.5 + fraction * 0.5) };
      const already = this.#db.prepare('SELECT asset_id, existing FROM upload_jobs WHERE library_id = ? AND job_id = ?').get(libraryId, input.jobId);
      if (already) {
        const status = this.status(libraryId);
        if (status.pending) await this.#drain(entry, this.#producer(libraryId), undefined, publication);
        return { id: already.asset_id, existing: !!already.existing, ...this.status(libraryId) };
      }
      const { state, producer } = await this.#latest(entry);
      const editing = input.editedSourceId !== undefined;
      if (editing) {
        const source = state.assets.get(input.editedSourceId);
        if (!source || source.trashed || source.kind !== 'image') throw new Error('底图已变化，请重新打开图片工具。');
        const name = `${Array.from(source.name).slice(0, 175).join('').trimEnd()} · 编辑`;
        input = { ...input, name, tags: source.tags, note: source.note, sourceURL: source.sourceURL,
          favorite: source.favorite, rating: source.rating, collectionIds: source.collectionIds, createdAt: source.createdAt };
      }
      const { prepareSyncOriginal } = require('./sync-upload.cjs');
      const linkOnly = !input.open && !input.bytes;
      const sourceURL = url(input.sourceURL);
      if (linkOnly && !sourceURL) throw new Error('找不到要导入的内容。');
      const extension = linkOnly ? 'url' : safeExtension(path.extname(input.filename ?? '').slice(1).toLowerCase());
      const prepared = await prepareSyncOriginal({ directory: this.staging, open: input.open,
        bytes: linkOnly ? Buffer.from(`[InternetShortcut]\r\nURL=${sourceURL}\r\n`, 'utf8') : input.bytes,
        fileExtension: extension, onProgress: report && (fraction => report(fraction * 0.5)),
        captureThumbnailProof: input.captureThumbnailProof });
      let retained = false;
      try {
        const id = prepared.blob.sha256;
        if (editing && state.descriptors.has(id)) {
          throw new Error(id === input.editedSourceId ? '生成的图像与原件相同，请调整后再保存。' : '同步库已经记录过相同图像，请调整后再保存。');
        }
        const { changes, delta, existing } = additionsFor(state, input, id);
        if (existing) {
          if (Object.keys(delta).length) changes.push(assetChange(state, id, delta));
        } else {
          const created = second(input.createdAt);
          const dimension = value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000 ? value : 0;
          const fallbackName = input.filename ? path.basename(input.filename, path.extname(input.filename)) : new URL(sourceURL).hostname;
          const descriptor = {
            blob: prepared.blob, fileExtension: prepared.fileExtension, kind: linkOnly ? 'link'
              : assetKinds.has(input.kind) ? input.kind : media.get(prepared.fileExtension) ?? 'document',
            pixelWidth: dimension(input.width) || dimension(prepared.width), pixelHeight: dimension(input.height) || dimension(prepared.height),
            createdAt: created - secondsSinceAppleEpoch, importedAt: second() - secondsSinceAppleEpoch,
            ...(Number.isFinite(input.duration) && input.duration >= 0 && { duration: input.duration }),
          };
          const previousFields = state.assetHistory.get(id) ?? [];
          for (const field of previousFields) if (!own(delta, field)) delta[field] = flag(false);
          Object.assign(delta, {
            life: flag(true), name: string(name(input.name || fallbackName || '素材')), note: string(text(input.note ?? '', 12_288, true)),
            favorite: flag(input.favorite === true), rating: integer(rating(input.rating ?? 0)), sourceURL: optionalString(sourceURL),
            eagleID: optionalString(input.eagleID ? text(input.eagleID, 1024) : null), createdAt: double(created), deletedAt: nullValue(),
          });
          changes.push({ ...assetChange(state, id, delta, descriptor), operationId: input.jobId });
        }
        const staged = path.basename(prepared.file);
        if (!stagingFile.test(staged) || path.relative(prepared.file, path.join(this.staging, staged)) !== '') {
          throw new Error('无法暂存待上传原件。');
        }
        this.#queue(producer, state, changes, { staged, job: { id: input.jobId, assetId: id, existing } });
        retained = !existing;
        const published = await this.#drain(entry, producer, state, publication);
        return { id, existing, ...this.status(libraryId), ...(!existing && published && prepared.sourceStamp && {
          thumbnailProof: { sourceStamp: prepared.sourceStamp, verifiedHash: id },
        }) };
      } finally { if (!retained) await prepared.discard().catch(() => {}); }
    });
  }
}

module.exports = { DirectorySyncWriter };
