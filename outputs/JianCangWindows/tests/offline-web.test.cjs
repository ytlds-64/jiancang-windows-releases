'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { OfflineWebStore } = require('../offline-web.cjs');

const reference = { registrationId: 'ac10', id: '1'.repeat(64) };
const anotherLibrary = { ...reference, registrationId: 'ac11' };

async function fixture(t, handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-offline-'));
  const hits = [];
  const site = http.createServer((req, res) => { hits.push(req); handler(req, res); });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    site.closeAllConnections();
    await new Promise(resolve => site.close(resolve));
    await fs.rm(directory, { force: true, recursive: true });
  });
  return { directory, hits, origin: `http://127.0.0.1:${site.address().port}` };
}

test('offline snapshots use a bounded explicit request and persist by registered library and current URL', async t => {
  const { directory, origin, hits } = await fixture(t, (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/article', 'set-cookie': 'session=do-not-forward' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<p>本机保存正文</p>');
  });
  let suffix = '/redirect';
  const getLink = () => ({ name: '测试素材', sourceURL: origin + suffix });
  const extract = (html, url) => {
    assert.equal(html, '<p>本机保存正文</p>');
    assert.equal(url, `${origin}/article`);
    return { title: 'Article', blocks: [{ kind: 'paragraph', text: '可信的测试段落' }], links: [
      { label: '页面详情', url: '/details' }, { label: '重复的链接', url: '/details' },
      { label: '坏链接', url: 'javascript:alert(1)' }, { label: '带凭据的链接', url: 'https://user:password@example.com' },
    ] };
  };
  const store = new OfflineWebStore({ directory, getLink, extract });
  assert.equal(await store.lookup(reference), null);
  assert.equal(hits.length, 0);
  const saved = await store.capture(reference);
  assert.equal(saved.sourceURL, `${origin}/redirect`);
  assert.equal(saved.finalURL, `${origin}/article`);
  assert.deepEqual(saved.links, [{ label: '页面详情', url: `${origin}/details` }]);
  assert.equal(hits.length, 2);
  assert.ok(hits.every(req => !req.headers.cookie && !req.headers.authorization && !req.headers.referer));

  const reopened = new OfflineWebStore({ directory, getLink, extract: () => assert.fail('offline lookup cannot invoke extractor') });
  assert.deepEqual(await reopened.lookup(reference), saved);
  assert.equal(await reopened.lookup(anotherLibrary), null);
  assert.equal(await reopened.allowsOpen(reference, `${origin}/details`), `${origin}/details`);
  await assert.rejects(reopened.allowsOpen(reference, `${origin}/unrelated`), /不在已保存的网页中/);
  suffix = '/changed';
  assert.equal(await reopened.lookup(reference), null);
  assert.equal(await reopened.allowsOpen(reference, `${origin}/changed`), `${origin}/changed`);
  await assert.rejects(reopened.allowsOpen(reference, `${origin}/details`), /不在已保存的网页中/);
  suffix = '/redirect';
  assert.deepEqual(await reopened.remove(reference), { ok: true });
  assert.equal(await store.lookup(reference), null);
  assert.equal(hits.length, 2);
});

test('failed refresh retains the old snapshot and cross-site redirects never contact the new origin', async t => {
  const blocked = await fixture(t, (_req, res) => res.end('must not be fetched'));
  let reply = 'initial';
  const { directory, origin, hits } = await fixture(t, (_req, res) => {
    if (reply === 'initial') { res.writeHead(200, { 'content-type': 'text/plain' }).end('第一行\n\n下一段'); return; }
    if (reply === 'redirect') { res.writeHead(307, { location: `${blocked.origin}/private` }).end(); return; }
    if (reply === 'large') { res.writeHead(200, { 'content-type': 'text/html', 'content-length': 4 * 1024 ** 2 + 1 }).end('too much'); return; }
    if (reply === 'fake') { res.writeHead(200, { 'content-type': 'application/pdf' }).end('not an article'); return; }
    res.writeHead(503).end();
  });
  const store = new OfflineWebStore({ directory, getLink: () => ({ name: '离线测试', sourceURL: origin }),
    extract: () => assert.fail('the HTML extractor should never run for these cases') });
  const saved = await store.capture(reference);
  assert.deepEqual(saved.blocks, [{ kind: 'paragraph', text: '第一行' }, { kind: 'paragraph', text: '下一段' }]);
  for (const [state, message] of [['redirect', /其他网站/], ['large', /网页过大/], ['fake', /没有可保存的网页正文/], ['http', /HTTP 503/]]) {
    reply = state;
    await assert.rejects(store.capture(reference), message);
    assert.deepEqual(await store.lookup(reference), saved);
  }
  await assert.rejects(store.capture({ registrationId: '../escape', id: reference.id }), /重新打开/);
  assert.equal(hits.length, 5);
  assert.equal(blocked.hits.length, 0);
});

test('concurrent captures share one request and a mid-capture source change prevents stale persistence', async t => {
  let proceed;
  const wait = new Promise(resolve => { proceed = resolve; });
  const { directory, origin, hits } = await fixture(t, async (_req, res) => {
    await wait;
    res.writeHead(200, { 'content-type': 'text/plain' }).end('Saved');
  });
  let link = `${origin}/before`;
  const store = new OfflineWebStore({ directory, getLink: () => ({ sourceURL: link }), extract: null });
  const first = store.capture(reference);
  const second = store.capture(reference);
  const pending = Promise.allSettled([first, second]);
  for (let count = 0; count < 100 && !hits.length; count++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(hits.length, 1);
  await assert.rejects(store.remove(reference), /正在保存/);
  link = `${origin}/after`;
  proceed();
  for (const outcome of await pending) assert.match(outcome.reason.message, /链接已修改/);
  assert.equal(await store.lookup(reference), null);
  assert.equal(hits.length, 1);
});
