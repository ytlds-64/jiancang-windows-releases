'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const baseURL = 'http://127.0.0.1:41595/api/v2/';
const maximumResponseBytes = 16 * 1024 ** 2;
const connectError = '无法连接 Eagle 本地接口。请启动 Eagle 4.0 Build 21 或更新版本并打开此素材库。';
const wrongLibrary = 'Eagle 当前打开的素材库与此处不同，请在 Eagle 中打开同一素材库后重试。';
const staleItem = '此素材已在 Eagle 中修改，请刷新后重新编辑。';
const missingItem = 'Eagle 未返回这项素材，它可能已移走或进入回收站。请刷新后重试。';
const uncertainWrite = 'Eagle 未确认保存结果，请刷新素材后核对。';
const fields = {
  name: 'name', tags: 'tags', note: 'annotation', sourceURL: 'url', collectionIds: 'folders', rating: 'star',
};
const itemId = value => typeof value === 'string' && /^[a-z0-9_-]{1,128}$/i.test(value);
const record = value => value != null && typeof value === 'object' && !Array.isArray(value);
const foldTag = value => value.normalize('NFC').toLowerCase();
const deltaFields = { tags: foldTag, collectionIds: value => value };

function libraryConnectionError(message) {
  return Object.assign(new Error(message), { code: 'EAGLE_CONNECTION' });
}

function checkedString(value, limit, message) {
  if (typeof value !== 'string' || value.length > limit || /\0/.test(value)) throw new Error(message);
  return value.trim();
}

function checkedList(value, limit, normalize, message) {
  if (!Array.isArray(value) || value.length > limit) throw new Error(message);
  return [...new Set(value.map(normalize))];
}

function fieldValue(field, value, proposed = false) {
  switch (field) {
    case 'name': {
      const message = '请输入有效的 Eagle 素材名称，名称中不能使用 Windows 文件名的保留字符。';
      const name = checkedString(value, 1024, message);
      if (!name || (proposed && /[<>:"/\\|?*\p{Cc}]/u.test(name))) throw new Error(message);
      return name;
    }
    case 'tags': {
      const message = 'Eagle 素材标签格式有误或数量过多。';
      return checkedList(proposed ? value : value ?? [], 256, tag => {
        const label = checkedString(tag, 512, message);
        if (!label) throw new Error(message);
        return label;
      }, message);
    }
    case 'note':
      return checkedString(value ?? '', 12_288, 'Eagle 素材备注格式有误或长度过长。');
    case 'sourceURL': {
      const message = '请输入有效的 HTTP 或 HTTPS 来源网址。';
      const urlText = checkedString(value ?? '', 4096, message);
      if (!urlText) return '';
      const url = URL.parse(urlText);
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(message);
      return urlText;
    }
    case 'collectionIds': {
      const message = 'Eagle 集合格式有误，请刷新后重新选择。';
      return checkedList(proposed ? value : value ?? [], 10_000, id => {
        if (!itemId(id)) throw new Error(message);
        return id;
      }, message);
    }
    case 'rating': {
      const rating = proposed ? value : value ?? 0;
      if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new Error('评分应在 0 到 5 之间。');
      return rating;
    }
  }
}

function readyFields(changes, expected, edits) {
  if (!record(changes) || !record(expected) || !record(edits)) throw new Error(staleItem);
  const rows = Object.entries(changes).map(([field, value]) => {
    if (!Object.hasOwn(fields, field)) throw new Error('Eagle 本地接口不支持修改这项资料。');
    if (!Object.hasOwn(expected, field)) throw new Error(staleItem);
    return { field, proposed: fieldValue(field, value, true), previous: fieldValue(field, expected[field]) };
  });
  for (const [field, edit] of Object.entries(edits)) {
    if (!Object.hasOwn(deltaFields, field) || Object.hasOwn(changes, field) || !record(edit)) {
      throw new Error('Eagle 批量修改格式不正确。');
    }
    const additions = fieldValue(field, edit.add ?? [], true);
    const removals = fieldValue(field, edit.remove ?? [], true);
    if (additions.length || removals.length) rows.push({ field, additions, removals });
  }
  return rows;
}

function editedList(field, current, additions, removals) {
  const key = deltaFields[field];
  const dropped = new Set(removals.map(key));
  const items = current.filter(value => !dropped.has(key(value)));
  const present = new Set(items.map(key));
  for (const value of additions) {
    if (!present.has(key(value))) {
      items.push(value);
      present.add(key(value));
    }
  }
  return fieldValue(field, items, true);
}

function sameValue(left, right) {
  if (!Array.isArray(left)) return left === right;
  const values = new Set(right);
  return left.length === values.size && left.every(value => values.has(value));
}

function planEagleRename(assets, entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 100_000 || entries.some(entry => !record(entry))) {
    throw new Error('请选择要改名的素材。');
  }
  const requested = new Set(entries.map(entry => entry.id));
  if (requested.size !== entries.length) throw new Error('同一份素材只能改名一次。');
  const filenameKey = (extension, name) => `${extension}\0${foldTag(name)}`;
  const occupied = new Set();
  for (const asset of assets.values()) {
    if (!requested.has(asset.id) && !asset.trashed) occupied.add(filenameKey(asset.extension, asset.name));
  }
  const planned = entries.map(({ id, name }) => {
    const asset = assets.get(id);
    if (!asset?.eagleItemId || asset.trashed) throw new Error('有素材已变化，请刷新后重新选择。');
    const supplied = fieldValue('name', name, true);
    const extension = asset.extension ? `.${asset.extension}` : '';
    const stem = extension && supplied.toLowerCase().endsWith(extension) && supplied.length > extension.length
      ? supplied.slice(0, -extension.length) : supplied;
    const base = fieldValue('name', stem, true);
    let next = base;
    let duplicate = 2;
    while (occupied.has(filenameKey(asset.extension, next))) {
      next = `${Array.from(base).slice(0, 165).join('').trimEnd()}（${duplicate++}）`;
    }
    occupied.add(filenameKey(asset.extension, next));
    return { id, oldName: asset.name, name: next };
  });
  const revision = createHash('sha256').update(JSON.stringify(planned)).digest('hex');
  return { entries: planned, revision };
}

async function responseDocument(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maximumResponseBytes) throw new Error('Eagle response exceeds size limit');
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
}

function verifyFolders(folders, ids) {
  if (!ids.length) return;
  const wanted = new Set(ids);
  const pending = Array.isArray(folders) ? [...folders] : [];
  while (pending.length && wanted.size) {
    const folder = pending.pop();
    wanted.delete(folder?.id);
    if (Array.isArray(folder?.children)) for (const child of folder.children) pending.push(child);
  }
  if (wanted.size) throw new Error('Eagle 中有集合已移动或删除，请刷新后重新选择。');
}

function createEagleLocalApi({ fetchImpl = globalThis.fetch } = {}) {
  let queuedWrite = Promise.resolve();

  async function request(endpoint, body) {
    const message = body ? uncertainWrite : connectError;
    try {
      const response = await fetchImpl(`${baseURL}${endpoint}`, {
        signal: AbortSignal.timeout(7000), redirect: 'error', cache: 'no-store',
        ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maximumResponseBytes) {
        await response.body?.cancel();
        throw new Error(message);
      }
      const document = await responseDocument(response);
      if (document?.status !== 'success' || !record(document.data)) throw new Error(message);
      return document.data;
    } catch { throw body ? new Error(message) : libraryConnectionError(message); }
  }

  async function activeLibrary(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw libraryConnectionError(wrongLibrary);
    const library = await request('library/info');
    const activeRoot = library.path;
    if (typeof activeRoot !== 'string' || !path.isAbsolute(activeRoot) ||
        path.relative(path.parse(root).root, path.parse(activeRoot).root) !== '') throw libraryConnectionError(wrongLibrary);
    try {
      const [requested, active] = await Promise.all([fs.realpath(root), fs.realpath(activeRoot)]);
      if (path.relative(requested, active) !== '') throw new Error(wrongLibrary);
    } catch { throw libraryConnectionError(wrongLibrary); }
    return library;
  }

  async function checkLibrary(root) {
    await activeLibrary(root);
    return { ok: true };
  }

  async function update({ root, id, changes = {}, expected = {}, edits = {} }) {
    if (!itemId(id)) throw new Error(missingItem);
    const next = readyFields(changes, expected, edits);
    if (!next.length) return { ok: true, changed: false };

    await activeLibrary(root);
    const itemFields = ['id', 'isDeleted', ...next.map(({ field }) => fields[field])];
    const query = new URLSearchParams({ id, fields: itemFields.join(','), limit: '1' });
    const result = await request(`item/get?${query}`);
    const current = Array.isArray(result.data) && result.data.length === 1 &&
      (result.total == null || result.total === 1) ? result.data[0] : null;
    if (current?.id !== id || (current.isDeleted != null && current.isDeleted !== false)) throw new Error(missingItem);

    const patch = { id };
    for (const { field, proposed, previous, additions, removals } of next) {
      const apiField = fields[field];
      let currentValue;
      try { currentValue = fieldValue(field, current[apiField]); }
      catch { throw new Error(staleItem); }
      const value = additions ? editedList(field, currentValue, additions, removals) : proposed;
      if (sameValue(currentValue, value)) continue;
      if (!additions && !sameValue(currentValue, previous)) throw new Error(staleItem);
      patch[apiField] = value;
    }
    if (Object.keys(patch).length === 1) return { ok: true, changed: false };

    // The API writes into the active library. Recheck immediately before posting the patch.
    const library = await activeLibrary(root);
    if (patch.folders) verifyFolders(library.folders, patch.folders);
    const updated = await request('item/update', patch);
    if (updated.id !== id) throw new Error(uncertainWrite);
    for (const { field } of next) {
      const apiField = fields[field];
      if (!Object.hasOwn(patch, apiField)) continue;
      try {
        if (!Object.hasOwn(updated, apiField) || !sameValue(fieldValue(field, updated[apiField]), patch[apiField])) {
          throw new Error(uncertainWrite);
        }
      } catch { throw new Error(uncertainWrite); }
    }
    return { ok: true, changed: true };
  }

  function updateItem(options) {
    const result = queuedWrite.then(() => update(options));
    queuedWrite = result.catch(() => {});
    return result;
  }

  return { checkLibrary, updateItem };
}

module.exports = { createEagleLocalApi, planEagleRename };
