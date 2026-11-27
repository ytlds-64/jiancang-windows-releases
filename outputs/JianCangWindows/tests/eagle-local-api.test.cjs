'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createEagleLocalApi, planEagleRename } = require('../eagle-local-api.cjs');

const item = {
  id: 'ITEM01', name: '原图', tags: ['摄影', '光影'], annotation: '原备注',
  url: 'https://example.com/original', folders: ['FIRST'], star: 4, isDeleted: false,
};
const json = data => Response.json({ status: 'success', data });
const items = (...values) => json({ data: values, total: values.length, offset: 0, limit: 1 });

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-eagle-api-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, '灵感.library');
  const other = path.join(temporary, '另一份', '灵感.library');
  await fs.mkdir(root);
  await fs.mkdir(other, { recursive: true });
  return { temporary, root, other };
}

function server(handle) {
  const calls = [];
  const api = createEagleLocalApi({ fetchImpl: async (url, options) => {
    const { origin, pathname, searchParams } = new URL(url);
    calls.push({ origin, pathname, searchParams, options });
    return handle(pathname, options);
  } });
  return { api, calls };
}

test('patches only changed, confirmed fields in the matching active Eagle library', async t => {
  const { root, temporary } = await fixture(t);
  const alias = path.join(temporary, '快捷方式.library');
  await fs.symlink(root, alias, 'junction');
  const { api, calls } = server((endpoint, options) => {
    if (endpoint.endsWith('/info')) return json({ path: alias, folders: [{ id: 'TOP', children: [{ id: 'SECOND' }] }] });
    if (endpoint.endsWith('/get')) return items(item);
    return json({ ...item, ...JSON.parse(options.body) });
  });
  const result = await api.updateItem({ root, id: item.id,
    changes: { name: '新名称', tags: ['光影', '摄影'], note: '第一行\n第二行', sourceURL: null,
      collectionIds: ['SECOND'], rating: 0 },
    expected: { name: item.name, tags: item.tags, note: item.annotation, sourceURL: item.url,
      collectionIds: item.folders, rating: item.star },
  });
  assert.deepEqual(result, { ok: true, changed: true });
  assert.deepEqual(calls.map(call => call.pathname), [
    '/api/v2/library/info', '/api/v2/item/get', '/api/v2/library/info', '/api/v2/item/update',
  ]);
  assert.equal(calls[1].searchParams.get('id'), item.id);
  assert.ok(calls.every(call => call.origin === 'http://127.0.0.1:41595' &&
    call.options.redirect === 'error' && call.options.signal instanceof AbortSignal));
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    id: item.id, name: '新名称', annotation: '第一行\n第二行', url: '', folders: ['SECOND'], star: 0,
  });
});

test('rejects a different path even when both libraries have the same name, including a switch during editing', async t => {
  const { root, other } = await fixture(t);
  let checks = 0;
  const { api, calls } = server(endpoint => {
    if (endpoint.endsWith('/info')) return json({ name: '灵感', path: ++checks === 1 ? root : other });
    return items(item);
  });
  await assert.rejects(api.updateItem({ root, id: item.id, changes: { rating: 3 }, expected: { rating: 4 } }), /当前打开的素材库/);
  await assert.rejects(api.checkLibrary(root), /当前打开的素材库/);
  assert.ok(calls.every(call => call.options.method !== 'POST'));
});

test('does not overwrite stale fields or assign a collection that is now missing', async t => {
  const { root } = await fixture(t);
  const { api, calls } = server(endpoint => endpoint.endsWith('/info') ? json({ path: root, folders: [] }) : items(item));
  await assert.rejects(api.updateItem({ root, id: item.id, changes: { tags: [] }, expected: { tags: ['摄影'] } }), /已在 Eagle 中修改/);
  await assert.rejects(api.updateItem({ root, id: item.id, changes: { collectionIds: ['MISSING'] },
    expected: { collectionIds: item.folders } }), /集合已移动或删除/);
  assert.ok(calls.every(call => call.options.method !== 'POST'));
});

test('rejects unsupported fields, malformed arrays, or missing baselines before connecting', async t => {
  const { root } = await fixture(t);
  const { api, calls } = server(() => json(item));
  await assert.rejects(api.updateItem({ root, id: item.id, changes: { favorite: true }, expected: {} }), /不支持修改/);
  await assert.rejects(api.updateItem({ root, id: item.id, changes: { rating: 3 }, expected: {} }), /已在 Eagle 中修改/);
  await assert.rejects(api.updateItem({ root, id: item.id, changes: { tags: null }, expected: { tags: [] } }), /标签格式/);
  assert.equal(calls.length, 0);
});

test('does not report success or retry when Eagle returns an unexpected write result', async t => {
  const { root } = await fixture(t);
  const { api, calls } = server(endpoint => {
    if (endpoint.endsWith('/info')) return json({ path: root });
    if (endpoint.endsWith('/get')) return items(item);
    return json(item);
  });
  await assert.rejects(api.updateItem({ root, id: item.id, changes: { note: '新备注' }, expected: { note: item.annotation } }), /未确认保存结果/);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
});

test('serializes writes so conflicting edits cannot both apply against the same old value', async t => {
  const { root } = await fixture(t);
  let current = item;
  const { api, calls } = server((endpoint, options) => {
    if (endpoint.endsWith('/info')) return json({ path: root });
    if (endpoint.endsWith('/get')) return items(current);
    if (options.method === 'POST') current = { ...current, ...JSON.parse(options.body) };
    return json(current);
  });
  const apply = rating => api.updateItem({ root, id: item.id, changes: { rating }, expected: { rating: 4 } });
  const [first, second] = await Promise.allSettled([apply(3), apply(2)]);
  assert.deepEqual(first, { status: 'fulfilled', value: { ok: true, changed: true } });
  assert.equal(second.status, 'rejected');
  assert.match(second.reason.message, /已在 Eagle 中修改/);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(current.star, 3);
});

test('reports missing support and refuses to operate with an older API response', async t => {
  const { root } = await fixture(t);
  const { api, calls } = server(() => new Response(null, { status: 404 }));
  await assert.rejects(api.checkLibrary(root), /Eagle 4\.0 Build 21/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/api/v2/library/info');
});

test('uses the Eagle reader display normalization for notes and keeps the original URL spelling', async t => {
  const { root } = await fixture(t);
  const current = { ...item, annotation: '  多行\r\n备注  ', url: '  https://EXAMPLE.COM  ' };
  const { api, calls } = server(endpoint => endpoint.endsWith('/info') ? json({ path: root }) : items(current));
  assert.deepEqual(await api.updateItem({ root, id: item.id,
    changes: { note: '多行\r\n备注', sourceURL: 'https://EXAMPLE.COM' },
    expected: { note: '多行\r\n备注', sourceURL: 'https://EXAMPLE.COM' },
  }), { ok: true, changed: false });
  assert.equal(calls.length, 2);
});

test('applies batch and AI additions against live Eagle metadata without replacing unrelated values', async t => {
  const { root } = await fixture(t);
  let current = { ...item, tags: ['摄影', '光影', 'peer', 'PEER'], folders: ['FIRST', 'PEER'] };
  const { api, calls } = server((endpoint, options) => {
    if (endpoint.endsWith('/info')) return json({ path: root, folders: [{ id: 'PEER' }, { id: 'SECOND' }] });
    if (endpoint.endsWith('/get')) return items(current);
    current = { ...current, ...JSON.parse(options.body) };
    return json(current);
  });
  const changes = { note: 'AI 建议' };
  const expected = { note: '原备注' };
  const edits = { tags: { add: ['Peer', '构图'], remove: ['光影'] }, collectionIds: { add: ['SECOND'], remove: ['FIRST'] } };
  const task = { root, id: item.id, changes, expected, edits };
  assert.deepEqual(await api.updateItem(task), { ok: true, changed: true });
  assert.deepEqual(await api.updateItem(task), { ok: true, changed: false });
  assert.deepEqual(calls.filter(call => call.options.method === 'POST').map(call => JSON.parse(call.options.body)), [{
    id: item.id, annotation: 'AI 建议', tags: ['摄影', 'peer', 'PEER', '构图'], folders: ['PEER', 'SECOND'],
  }]);
  await assert.rejects(api.updateItem({ ...task, changes: { note: '另一个备注' } }), /已在 Eagle 中修改/);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
});

test('previews Eagle batch rename with duplicate suffixes, stale plans and Windows filename validation', () => {
  const assets = new Map(['ONE', 'TWO', 'THREE'].map((id, index) => [id,
    { id, eagleItemId: id, name: ['片头', '片尾', '样片'][index], extension: 'png' }]));
  const proposals = [{ id: 'ONE', name: '样片.png' }, { id: 'TWO', name: '样片' }];
  const first = planEagleRename(assets, proposals);
  assert.deepEqual(first.entries, [
    { id: 'ONE', oldName: '片头', name: '样片（2）' }, { id: 'TWO', oldName: '片尾', name: '样片（3）' },
  ]);
  assets.get('TWO').name = '外部改名';
  assert.notEqual(planEagleRename(assets, proposals).revision, first.revision);
  assert.throws(() => planEagleRename(assets, [{ id: 'ONE', name: 'invalid:file' }]), /保留字符/);
});
