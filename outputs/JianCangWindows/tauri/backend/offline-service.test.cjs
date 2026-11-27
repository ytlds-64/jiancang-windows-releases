'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { OfflineWebStore } = require('../../offline-web.cjs');
const { OfflineService } = require('./offline-service.cjs');

const reference = { registrationId: 'ab01', id: 'b'.repeat(64) };
const sourceURL = 'https://example.test/article';
const html = '<article><h1>素材标题</h1><p>离线正文</p></article>';
const extracted = { title: '素材标题', blocks: [{ kind: 'paragraph', text: '离线正文' }], links: [
  { label: '来源', url: '/source' }, { label: '忽略脚本', url: 'javascript:alert(1)' },
] };

async function fixture(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-offline-service-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let url = sourceURL;
  const library = {
    profile: path.join(directory, 'com.jiancang.desktop.tauri'),
    asset(id, registrationId) {
      assert.equal(id, reference.id);
      assert.equal(registrationId, reference.registrationId);
      return { asset: { kind: 'link', name: '测试链接', sourceURL: url } };
    },
  };
  const service = new OfflineService(library, options);
  t.after(() => service.close());
  return { directory, library, service, command: (operation, ...args) => service.command('offline-web:' + operation, args),
    setURL: value => { url = value; } };
}

function htmlResponse() { return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }
function plainResponse(text) { return new Response(text, { headers: { 'Content-Type': 'text/plain' } }); }

test('receives bounded HTML, saves normalized blocks and only opens authorized link URLs', async t => {
  let requests = 0;
  const { command } = await fixture(t, { fetchPage: (url, options) => {
    requests++;
    assert.equal(url, sourceURL);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    return htmlResponse();
  } });
  assert.equal(await command('get', reference), null);
  const pending = await command('capture-start', reference);
  assert.match(pending.token, /^[a-f0-9-]{36}$/);
  assert.equal(pending.html, html);
  assert.equal(pending.finalURL, sourceURL);
  assert.equal(await command('get', reference), null);
  const stored = await command('capture-finish', pending.token, extracted);
  assert.equal(stored.sourceURL, sourceURL);
  assert.deepEqual(stored.blocks, extracted.blocks);
  assert.deepEqual(stored.links, [{ label: '来源', url: 'https://example.test/source' }]);
  assert.deepEqual(await command('get', reference), stored);
  assert.deepEqual(await command('open', reference, sourceURL), { url: sourceURL });
  assert.deepEqual(await command('open', reference, 'https://example.test/source'), { url: 'https://example.test/source' });
  await assert.rejects(command('open', reference, 'https://example.test/other'), /不在已保存的网页/);
  await assert.rejects(command('capture-finish', pending.token, extracted), /任务已结束/);
  assert.equal(requests, 1);
});

test('staged cancellation and an edited source preserve the previous successful snapshot', async t => {
  let response = () => plainResponse('初始文本');
  const { command, setURL } = await fixture(t, { fetchPage: () => response() });
  const { snapshot: original } = await command('capture-start', reference);
  assert.deepEqual(original.blocks, [{ kind: 'paragraph', text: '初始文本' }]);
  response = htmlResponse;
  const canceled = await command('capture-start', reference);
  await assert.rejects(command('remove', reference), /正在保存/);
  assert.deepEqual(await command('capture-cancel', canceled.token), { ok: true });
  assert.deepEqual(await command('get', reference), original);

  const stale = await command('capture-start', reference);
  setURL('https://example.test/redirected');
  await assert.rejects(command('capture-finish', stale.token, extracted), /链接已修改/);
  assert.equal(await command('get', reference), null);
  setURL(sourceURL);
  assert.deepEqual(await command('get', reference), original);
});

test('electron snapshots are visible on demand and local removal never rewrites the old profile', async t => {
  const { directory, command, library } = await fixture(t, { production: true, fetchPage: () => assert.fail('lookup must be offline') });
  const legacyDirectory = path.join(directory, '见藏', 'offline-web-v1');
  const old = new OfflineWebStore({ directory: legacyDirectory, getLink: () => ({ sourceURL }),
    fetchPage: () => plainResponse('旧版离线正文') });
  const saved = await old.capture(reference);
  assert.deepEqual(await command('get', reference), saved);
  assert.deepEqual(await command('remove', reference), { ok: true });
  assert.equal(await command('get', reference), null);
  const reopened = new OfflineService(library, { production: true });
  try { assert.equal(await reopened.command('offline-web:get', [reference]), null); }
  finally { await reopened.close(); }
  assert.deepEqual(await old.lookup(reference), saved);
});

test('network capture refuses a saved loopback address and cannot open it through the offline reader', async t => {
  const { command, setURL } = await fixture(t);
  const localURL = 'http://127.0.0.1:33339/private';
  setURL(localURL);
  await assert.rejects(command('capture-start', reference), /无法连接|公共网站/);
  await assert.rejects(command('open', reference, localURL), /公共网页/);
  assert.equal(await command('get', reference), null);
});
