'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { test } = require('node:test');
const { setTimeout: wait } = require('node:timers/promises');
const { runInNewContext } = require('node:vm');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const mp4Header = Buffer.from('000000146674797069736f6d0000020069736f6d', 'hex');
const iconDirectory = Buffer.from('00000100010001010000010020000000000016000000', 'hex');
iconDirectory.writeUInt32LE(png.length, 14);
const ico = Buffer.concat([iconDirectory, png]);

async function start(profile) {
  const processHandle = spawn(process.execPath, [path.join(__dirname, 'server.cjs'), profile], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = readline.createInterface({ input: processHandle.stdout });
  const stopped = once(processHandle, 'exit');
  let stderr = '';
  processHandle.stderr.on('data', data => { stderr += data; });
  const [line] = await Promise.race([
    once(output, 'line'),
    stopped.then(([code]) => { throw new Error(`Node 服务启动失败 (${code})：${stderr}`); }),
  ]);
  const { port, token } = JSON.parse(line);
  const url = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${token}` };
  async function request(name, ...args) {
    const response = await fetch(`${url}/command`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function command(name, ...args) {
    const result = await request(name, ...args);
    assert.equal(result.ok, true, result.error);
    return result.value;
  }
  return {
    url, headers, request, command,
    async close() {
      processHandle.stdin.end();
      const deadline = setTimeout(() => processHandle.kill(), 8000);
      try {
        const [code] = await stopped;
        assert.equal(code, 0, stderr);
      } finally { clearTimeout(deadline); }
    },
    media(role, libraryID, assetID, options = {}) {
      return fetch(`${url}/media/${role}/${libraryID}/${assetID}`, { ...options, headers: { ...headers, ...options.headers } });
    },
  };
}

function assetIn(state, id) {
  return state.library.assets.find(asset => asset.id === id);
}

test('Tauri reads one catalog at startup and polls only for a different state', { timeout: 15_000 }, async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-tauri-state-')));
  let backend;
  try {
    backend = await start(path.join(temp, 'profile'));
    const { command } = backend;
    const { activeLibraryId } = await command('local:create', '状态测试', temp);
    let stateReads = 0;
    const polls = [];
    const window = { __TAURI__: { core: { invoke(operation, { name, args }) {
      assert.equal(operation, 'library_command');
      if (name === 'library:state') stateReads++;
      return command(name, ...args);
    } } } };
    const bridge = await fs.readFile(path.join(__dirname, '../frontend/tauri-platform.js'), 'utf8');
    runInNewContext(bridge, { window, location: { hostname: 'tauri.localhost' }, document: { addEventListener() {} },
      setTimeout(callback, delay) { if (delay === 1200) polls.push(callback); } });
    const ipc = window.jiancangTauriPlatform.ipcRenderer;
    const states = [];
    ipc.on('library:state-changed', (_, state) => states.push(state));
    async function poll() {
      polls.shift()();
      await waitFor(() => polls.length);
    }

    const [initial, concurrent] = await Promise.all([ipc.invoke('library:state'), ipc.invoke('library:state')]);
    assert.equal(stateReads, 1);
    assert.equal(initial, concurrent);
    assert.equal(initial.library, initial.catalogs[0].library);
    assert.equal(initial.activeLibraryId, activeLibraryId);
    const compact = await command('library:state', { compact: true });
    assert.equal('library' in compact, false);
    assert.equal(compact.libraryRevision, initial.libraryRevision);
    assert.deepEqual(await command('library:state', { compact: true, knownRevision: compact.libraryRevision }),
      { notModified: true });
    await poll();
    assert.equal(stateReads, 1);
    assert.equal(states.length, 1);

    await command('local:mutate', activeLibraryId, { action: 'createCollection', name: '新集合' });
    await poll();
    assert.equal(stateReads, 2);
    assert.equal(states.length, 2);
    assert.notEqual(states[1].libraryRevision, initial.libraryRevision);
    assert.equal(states[1].library.collections[0].name, '新集合');
    await poll();
    assert.equal(stateReads, 2);
  } finally {
    await backend?.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

async function waitFor(work) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const result = await work();
    if (result) return result;
    await wait(40);
  }
  assert.fail('素材库操作未在测试时限内完成。');
}

async function eagleFixture(root) {
  const item = path.join(root, 'images', 'QA001.info');
  await fs.mkdir(item, { recursive: true });
  await fs.writeFile(path.join(root, 'metadata.json'), JSON.stringify({ id: 'QA-Eagle', name: 'Eagle 测试', folders: [] }));
  await fs.writeFile(path.join(item, 'metadata.json'), JSON.stringify({ id: 'QA001', name: '参考图', ext: 'png', width: 1, height: 1 }));
  await fs.writeFile(path.join(item, '参考图.png'), png);
  await fs.writeFile(path.join(item, '参考图_thumbnail.png'), png);
}

async function syncFixture(root, bytes, extension, { format = 1, kind = 'image' } = {}) {
  const libraryID = '00000000-0000-4000-a000-000000000001';
  const deviceID = '00000000-0000-4000-a000-000000000002';
  const operationID = '00000000-0000-4000-a000-000000000003';
  const hash = createHash('sha256').update(bytes).digest('hex');
  const changes = path.join(root, 'changes', deviceID);
  const blob = path.join(root, 'blobs', hash);
  await fs.mkdir(changes, { recursive: true });
  await fs.mkdir(path.dirname(blob));
  await fs.writeFile(path.join(root, 'library.json'), JSON.stringify({
    libraryID, version: format, format: 'com.materialshelf.directory-sync', createdAt: 721692800,
    ...(format >= 6 && { namingDeviceID: deviceID }),
  }));
  await fs.writeFile(path.join(changes, `1-${operationID}.json`), JSON.stringify({
    libraryID, deviceID, clock: { [deviceID]: 1 }, id: operationID, version: 1, counter: 1, entityKind: 'asset', entityID: hash,
    changes: { life: { bool: { _0: true } }, name: { string: { _0: '同步测试图' } },
      note: { string: { _0: '' } }, favorite: { bool: { _0: false } }, rating: { int: { _0: 0 } },
      sourceURL: { string: { _0: 'https://example.com/reference' } }, eagleID: { null: {} },
      createdAt: { double: { _0: 1700000000 } }, deletedAt: { null: {} } },
    asset: { blob: { sha256: hash, byteCount: bytes.length }, kind, fileExtension: extension,
      pixelWidth: 1, pixelHeight: 1, createdAt: 721692800, importedAt: 721692800 },
  }));
  await fs.writeFile(blob, bytes);
  return blob;
}

test('the Tauri bridge scopes studio records to the selected format-6 sync library and preserves revisions', { timeout: 25_000 }, async t => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-studio-')));
  const profile = path.join(temp, 'profile');
  const root = path.join(temp, 'sync');
  let backend;
  t.after(async () => {
    try { await backend?.close(); } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });
  const clip = await syncFixture(root, mp4Header, 'mp4', { format: 6, kind: 'video' });
  const scope = path.basename(clip);
  backend = await start(profile);
  const opened = await backend.command('library:choose', 'jiancang', root);
  const registration = opened.activeLibraryId;
  assert.ok(registration, opened.message);
  assert.deepEqual(await backend.command('studio:list', registration, 'video-note', scope), []);
  const note = randomUUID();
  const text = JSON.stringify({ seconds: 2.75, text: '看这里 🎬\n切换画面' });
  assert.match((await backend.request('studio:write', registration, 'video-note', scope, note, text, null)).error, /开启双向同步/);
  await backend.command('sync:configure-write', registration, true);
  const first = await backend.command('studio:write', registration, 'video-note', scope, note, text, null);
  assert.equal(first.revision, 1);
  assert.equal(first.payload, text);
  assert.match((await backend.request('studio:write', registration, 'video-note', scope, note, text, null)).error, /其他设备更改/);
  assert.equal((await backend.request('studio:list', registration, 'board', '../changes')).ok, false);
  assert.equal((await backend.request('studio:list', 'other-library', 'filter')).ok, false);
  const board = await backend.command('studio:write', registration, 'board', null, randomUUID(), '{"title":"参考","entries":[]}', null);
  assert.deepEqual(await backend.command('studio:list', registration, 'board'), [board]);
  await backend.close();
  backend = null;
  backend = await start(profile);
  assert.deepEqual(await backend.command('studio:list', registration, 'video-note', scope), [first]);
  const removed = await backend.command('studio:write', registration, 'video-note', scope, note, null, first.token);
  assert.equal(removed.writer, first.writer);
  assert.equal(removed.revision, 2);
  assert.equal(removed.payload, null);
  assert.deepEqual(await backend.command('studio:list', registration, 'video-note', scope), [removed]);
  const base = path.join(root, 'blobs', '.studio', 'v1', 'video-note', scope);
  const placeholder = path.join(base, `.${randomUUID()}.${randomUUID()}.json.icloud`);
  await fs.writeFile(placeholder, '');
  assert.match((await backend.request('studio:list', registration, 'video-note', scope)).error, /仍在同步/);
});

test('stock Node private bridge manages local libraries and reads Eagle and verified iCloud assets', { timeout: 25_000 }, async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-tauri-sidecar-')));
  const profile = path.join(temp, 'profile');
  let backend;
  try {
    backend = await start(profile);
    const { command, request, media } = backend;
    const forbidden = await fetch(`${backend.url}/command`, { method: 'POST', headers: { Origin: 'https://example.com' }, body: '{}' });
    assert.equal(forbidden.status, 401);
    assert.equal(forbidden.headers.get('access-control-allow-origin'), null);
    assert.equal((await command('library:state')).library, null);
    const created = await command('local:create', '测试库', temp);
    const localID = created.activeLibraryId;
    assert.equal(created.library.directoryName, '测试库');
    const localRoot = await command('library:reveal-path', localID);
    const { id: collection } = await command('local:mutate', localID, { action: 'createCollection', name: '收藏集合' });
    const input = path.join(temp, '采集.png');
    const output = path.join(temp, '导出.png');
    await fs.writeFile(input, png);
    const enqueue = await command('local-import:choose', localID, collection, [input]);
    assert.equal(enqueue.ok, true);
    const photo = await waitFor(async () => {
      const queue = await command('local-import:list', localID, false);
      if (queue.summary.running || queue.summary.pending) return null;
      return (await command('library:state')).library.assets[0];
    });
    assert.deepEqual(photo.collectionIds, [collection]);
    assert.equal(photo.width, 1);
    const reference = await command('asset:reference-info', photo.id, localID);
    assert.deepEqual(reference, { assetId: photo.id, registrationId: localID, name: photo.name, originalAvailable: true });
    assert.equal((await request('asset:reference-info', photo.id)).ok, false);
    assert.equal((await request('asset:reference-info', photo.id, 'wrong-library')).ok, false);
    const head = await media('thumbnail', localID, photo.id, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.match(head.headers.get('content-type'), /^image\//);
    const ranged = await media('original', localID, photo.id, { headers: { Range: 'bytes=-8' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes ${png.length - 8}-${png.length - 1}/${png.length}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), png.subarray(png.length - 8));
    assert.equal((await media('original', localID, photo.id, { headers: { Range: 'bytes=3200-' } })).status, 416);
    assert.equal((await media('unsafe', localID, photo.id)).status, 404);
    assert.equal((await media('video', localID, photo.id)).status, 404);
    const iconPath = path.join(temp, '图标.ico');
    await fs.writeFile(iconPath, ico);
    await command('local-import:choose', localID, collection, [iconPath]);
    const icon = await waitFor(async () => (await command('library:state')).library.assets.find(asset => asset.extension === 'ico'));
    assert.deepEqual(await command('asset:reference-info', icon.id, localID),
      { assetId: icon.id, registrationId: localID, name: icon.name, originalAvailable: true });
    for (const role of ['thumbnail', 'original', 'board-image', 'palette-image']) {
      const preview = await media(role, localID, icon.id);
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get('content-type'), 'image/x-icon');
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), ico);
    }
    const iconExport = path.join(temp, '导出.ico');
    await command('asset:export', icon.id, localID, iconExport);
    assert.deepEqual(await fs.readFile(iconExport), ico);
    const videoBytes = process.env.JIANCANG_QA_VIDEO ? await fs.readFile(process.env.JIANCANG_QA_VIDEO) : mp4Header;
    const clip = path.join(temp, '样片.mp4');
    await fs.writeFile(clip, videoBytes);
    await command('local-import:set-paused', localID, true);
    await command('local-import:choose', localID, collection, [clip]);
    const { tasks: [pendingClip] } = await command('local-import:list', localID);
    assert.equal(pendingClip.status, 'pending');
    const pendingPath = `${backend.url}/media/import-thumbnail/${localID}/${pendingClip.id}`;
    assert.equal((await fetch(pendingPath)).status, 401);
    assert.equal((await media('import-thumbnail', randomUUID(), pendingClip.id)).status, 404);
    assert.equal((await media('original', localID, pendingClip.id)).status, 404);
    if (process.env.JIANCANG_QA_VIDEO && process.env.JIANCANG_FFMPEG_PATH) {
      const poster = await media('import-thumbnail', localID, pendingClip.id);
      assert.equal(poster.status, 200);
      assert.equal(poster.headers.get('content-type'), 'image/jpeg');
      assert.equal(poster.headers.get('cache-control'), 'no-store');
      assert.deepEqual(Buffer.from(await poster.arrayBuffer()).subarray(0, 2), Buffer.from([0xff, 0xd8]));

      await fs.writeFile(clip, mp4Header);
      assert.equal((await media('import-thumbnail', localID, pendingClip.id)).status, 404);
      await fs.writeFile(clip, videoBytes);
    }
    const pendingRemoval = await command('library:remove', localID);
    assert.equal(pendingRemoval.activeLibraryId, localID);
    assert.match(pendingRemoval.message, /导入结束/);
    assert.deepEqual(await command('local-import:cancel-pending', localID), { ok: true, cancelled: 1 });
    const cancelledQueue = await command('local-import:list', localID, false);
    assert.equal(cancelledQueue.paused, true);
    assert.equal(cancelledQueue.summary.pending, 0);
    assert.equal((await media('import-thumbnail', localID, pendingClip.id)).status, 404);
    assert.deepEqual(await fs.readFile(clip), videoBytes);
    await command('local-import:choose', localID, collection, [clip]);
    await command('local-import:set-paused', localID, false);
    const video = await waitFor(async () => {
      const queue = await command('local-import:list', localID, false);
      if (queue.summary.running || queue.summary.pending) return null;
      return (await command('library:state')).library.assets.find(asset => asset.kind === 'video');
    });
    const clipResponse = await media('video', localID, video.id, { headers: { Range: 'bytes=4-15' } });
    assert.equal(clipResponse.status, 206);
    assert.equal(clipResponse.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await clipResponse.arrayBuffer()), videoBytes.subarray(4, 16));
    if (process.env.JIANCANG_QA_VIDEO && process.env.JIANCANG_FFMPEG_PATH) {
      const poster = await media('thumbnail', localID, video.id);
      assert.equal(poster.status, 200);
      assert.equal(poster.headers.get('content-type'), 'image/jpeg');
    }
    const textPath = path.join(temp, '备注.txt');
    const text = '测试文字预览\n第二行';
    await fs.writeFile(textPath, text);
    await command('local-import:choose', localID, collection, [textPath]);
    const textCatalog = await waitFor(async () => {
      const state = await command('library:state');
      const catalog = state.catalogs.find(item => item.libraryId === localID);
      return catalog?.library.assets.some(asset => asset.extension === 'txt') && catalog;
    });
    const document = textCatalog.library.assets.find(asset => asset.extension === 'txt');
    assert.equal((await request('asset:reference-info', document.id, localID)).ok, false);
    assert.deepEqual(await command('assets:copy-preview-text', document.id, localID, textCatalog.revision), { ok: true, text });
    assert.equal((await request('assets:copy-preview-text', document.id, localID, 'stale')).ok, false);
    assert.equal((await command('assets:copy-preview-text', photo.id, localID, textCatalog.revision)).ok, false);
    const tagEdit = command('local:mutate', localID, { action: 'edit', ids: [photo.id], addTags: ['测试'] });
    const favoriteEdit = command('local:mutate', localID, { action: 'edit', ids: [photo.id], favorite: true });
    await Promise.all([tagEdit, favoriteEdit]);
    const edited = assetIn(await command('library:state'), photo.id);
    assert.deepEqual(edited.tags, ['测试']);
    assert.equal(edited.favorite, true);
    const trashed = await command('local:mutate', localID, { action: 'trash', ids: [photo.id] });
    assert.equal(assetIn(trashed.state, photo.id).trashed, true);
    const undone = await command('local:mutate', localID, { action: 'undo' });
    assert.equal(assetIn(undone.state, photo.id).trashed, false);
    await command('local:mutate', localID, { action: 'redo' });
    const restored = await command('local:mutate', localID, { action: 'restore', ids: [photo.id] });
    assert.equal(assetIn(restored.state, photo.id).trashed, false);
    assert.equal((await request('local:mutate', localID, { action: 'purgeTrash' })).ok, false);
    assert.equal(await command('asset:export-name', photo.id, localID), '采集.png');
    assert.equal((await request('asset:export', photo.id, localID, path.join(localRoot, '跨库.png'))).ok, false);
    assert.equal((await request('asset:export', photo.id, localID, path.join(temp, 'data:stream.png'))).ok, false);
    await command('asset:export', photo.id, localID, output);
    assert.deepEqual(await fs.readFile(output), png);
    assert.equal((await request('asset:export', photo.id, localID, output)).ok, false);
    const relocated = path.join(temp, 'moved');
    await fs.rename(localRoot, relocated);
    const moved = await command('library:relocate', localID, relocated);
    assert.equal(moved.activeLibraryId, localID);
    assert.equal(assetIn(moved, photo.id).id, photo.id);

    const eagleRoot = path.join(temp, 'QA.library');
    await eagleFixture(eagleRoot);
    const missingItem = path.join(eagleRoot, 'images', 'QA002.info');
    await fs.mkdir(missingItem);
    await fs.writeFile(path.join(missingItem, 'metadata.json'),
      JSON.stringify({ id: 'QA002', name: '缺失原件', ext: 'png', width: 1, height: 1 }));
    const eagle = await command('library:choose', 'eagle', eagleRoot);
    assert.equal(eagle.library.directoryName, 'Eagle 测试');
    assert.equal(eagle.libraries.find(item => item.id === eagle.activeLibraryId).eagleWritable, false);
    assert.equal((await request('local:mutate', eagle.activeLibraryId, { action: 'createCollection', name: '跳过' })).ok, false);
    const eagleThumb = await media('thumbnail', eagle.activeLibraryId, eagle.library.assets.find(asset => asset.available).id);
    assert.equal(eagleThumb.status, 200);
    assert.deepEqual(Buffer.from(await eagleThumb.arrayBuffer()), png);
    const issueIndex = eagle.library.readingIssues.entries.findIndex(issue => issue.itemId === 'QA002');
    assert.notEqual(issueIndex, -1);
    const eagleRevision = eagle.catalogs.find(item => item.libraryId === eagle.activeLibraryId).revision;
    assert.equal(await command('library:reveal-reading-path', eagle.activeLibraryId, eagleRevision, issueIndex), missingItem);
    assert.equal((await request('library:reveal-reading-path', eagle.activeLibraryId, eagleRevision, '../..')).ok, false);
    const movedIssue = path.join(temp, 'QA002.info');
    await fs.rename(missingItem, movedIssue);
    await fs.symlink(movedIssue, missingItem, 'junction');
    assert.equal((await request('library:reveal-reading-path', eagle.activeLibraryId, eagleRevision, issueIndex)).ok, false);
    await fs.rm(missingItem);
    await fs.rename(movedIssue, missingItem);
    await fs.writeFile(path.join(missingItem, '缺失原件.png'), png);
    await command('library:refresh', eagle.activeLibraryId);
    assert.equal((await request('library:reveal-reading-path', eagle.activeLibraryId, eagleRevision, issueIndex)).ok, false);

    const syncRoot = path.join(temp, 'sync');
    const blob = await syncFixture(syncRoot, ico, 'ico');
    const sync = await command('library:choose', 'jiancang', syncRoot);
    assert.equal(sync.message, null, sync.message);
    assert.equal(sync.libraries.find(item => item.id === sync.activeLibraryId).syncWritable, false);
    assert.equal(sync.library.assets[0].name, '同步测试图');
    const syncOriginal = await media('original', sync.activeLibraryId, sync.library.assets[0].id);
    assert.equal(syncOriginal.status, 200);
    assert.equal(syncOriginal.headers.get('content-type'), 'image/x-icon');
    assert.deepEqual(Buffer.from(await syncOriginal.arrayBuffer()), ico);
    await fs.writeFile(blob, Buffer.alloc(ico.byteLength));
    assert.equal((await media('original', sync.activeLibraryId, sync.library.assets[0].id)).status, 404);
    assert.equal((await media('thumbnail', sync.activeLibraryId, sync.library.assets[0].id)).status, 404);
    assert.equal((await request('asset:export', sync.library.assets[0].id, sync.activeLibraryId, path.join(temp, 'sync-output.ico'))).ok, false);

    await command('library:switch', localID);
    await backend.close();
    backend = null;
    backend = await start(profile);
    const reopened = await backend.command('library:state');
    assert.equal(reopened.catalogs.length, 3);
    assert.equal(reopened.activeLibraryId, localID);
    assert.deepEqual(assetIn(reopened, photo.id).tags, ['测试']);
    const removed = await backend.command('library:remove', localID);
    assert.equal(removed.libraries.length, 2);
    assert.equal((await fs.stat(relocated)).isDirectory(), true);
  } finally {
    await backend?.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('browser drag imports large originals in bounded chunks and preserves the target and source URL', { timeout: 25_000 }, async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-tauri-drop-')));
  let backend;
  try {
    backend = await start(path.join(temp, 'profile'));
    const { command, request, media } = backend;
    const { activeLibraryId: id } = await command('local:create', '网页拖入库', temp);
    const { id: collection } = await command('local:mutate', id, { action: 'createCollection', name: '网页图片' });
    const pixels = 1024 * 1024 * 3;
    const image = Buffer.alloc(54 + pixels);
    image.write('BM');
    image.writeUInt32LE(image.length, 2);
    image.writeUInt32LE(54, 10);
    image.writeUInt32LE(40, 14);
    image.writeInt32LE(1024, 18);
    image.writeInt32LE(1024, 22);
    image.writeUInt16LE(1, 26);
    image.writeUInt16LE(24, 28);
    image.writeUInt32LE(pixels, 34);
    image.fill(127, 54);

    const maximumChunkBytes = 768 * 1024;
    const receivedSizes = [];
    const nativeTokens = new Map();
    const explorer = path.join(temp, '资源管理器.txt');
    await fs.writeFile(explorer, 'Explorer file');
    const webview = new EventTarget();
    webview.postMessageWithAdditionalObjects = (message, files) => {
      const [, jiancangNativeDrop] = /^jiancang-native-drop:([a-f0-9-]{36})$/.exec(message);
      if (files.some(file => file?.name === '混合拖入.bmp')) throw new TypeError('File is not on disk');
      const index = files.findIndex(file => file?.name === path.basename(explorer));
      const reply = { jiancangNativeDrop };
      if (index >= 0) {
        reply.token = 27;
        reply.indices = [index];
        nativeTokens.set(reply.token, [explorer]);
      }
      setImmediate(() => webview.dispatchEvent(new MessageEvent('message', { data: reply })));
    };
    const window = { chrome: { webview }, __TAURI__: { core: { invoke: async (operation, { name, args }) => {
      assert.equal(operation, 'library_command');
      if (name === 'local-import:drop-append') {
        assert.ok(args[3].length <= maximumChunkBytes * 4 / 3);
        receivedSizes.push(Buffer.from(args[3], 'base64').length);
      }
      if (name === 'local-import:drop-begin' && args[2].nativeToken) {
        const { nativeToken, ...metadata } = args[2];
        const paths = nativeTokens.get(nativeToken);
        assert.ok(paths);
        nativeTokens.delete(nativeToken);
        args[2] = { ...metadata, paths };
      }
      return command(name, ...args);
    } } } };
    const bridgeSource = await fs.readFile(path.join(__dirname, '../frontend/tauri-platform.js'), 'utf8');
    runInNewContext(bridgeSource, { window, location: { hostname: 'tauri.localhost' }, btoa, crypto, clearTimeout,
      document: { addEventListener() {} }, setTimeout: (callback, delay) => delay === 1500 && setTimeout(callback, delay) });
    window.jiancangTauriPlatform.contextBridge.exposeInMainWorld('bridge', {});

    const sourceURL = 'https://example.com/articles/reference-photo';
    const file = new File([image], '网页原图.bmp', { type: 'image/bmp' });
    await command('local-import:set-paused', id, true);
    const imported = await window.bridge.dropWebImages(id, collection, [file], { sourceURL });
    assert.equal(imported.ok, true);
    assert.equal(receivedSizes.length, Math.ceil(image.length / maximumChunkBytes));
    assert.equal(receivedSizes.reduce((total, size) => total + size, 0), image.length);
    const { tasks: [pendingImage] } = await command('local-import:list', id);
    assert.equal(pendingImage.status, 'pending');
    assert.deepEqual((await command('library:state')).library.assets, []);
    if (process.env.JIANCANG_FFMPEG_PATH) {
      const preview = await media('import-thumbnail', id, pendingImage.id);
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()).subarray(0, 2), Buffer.from([0xff, 0xd8]));
    }
    await command('local-import:set-paused', id, false);
    image[54] = 23;
    const inline = await window.bridge.dropWebImages(id, collection, [], {
      imageURL: [`data:image/bmp;base64,${image.toString('base64')}`], sourceURL,
    });
    assert.equal(inline.ok, true);
    const assets = await waitFor(async () => {
      const { library } = await command('library:state');
      return library.assets.length === 2 && library.assets;
    });
    assert.equal((await media('import-thumbnail', id, pendingImage.id)).status, 404);
    for (const asset of assets) {
      assert.equal(asset.byteCount, image.length);
      assert.equal(asset.sourceURL, sourceURL);
      assert.deepEqual(asset.collectionIds, [collection]);
      const original = await media('original', id, asset.id);
      assert.equal(original.status, 200);
      const originalBytes = Buffer.from(await original.arrayBuffer());
      image[54] = asset.name === '网页原图' ? 127 : 23;
      assert.deepEqual(originalBytes, image);
    }

    image[54] = 87;
    const mixedImage = new File([image], '混合拖入.bmp', { type: 'image/bmp' });
    const explorerFile = new File([], path.basename(explorer), { type: 'text/plain' });
    const [native, virtual] = await Promise.all([
      window.bridge.resolveNativeDrop([mixedImage, explorerFile], [Promise.resolve(null), Promise.resolve({ kind: 'file' })]),
      window.bridge.resolveNativeDrop([mixedImage]),
    ]);
    assert.deepEqual(native.indices, [1]);
    assert.equal(virtual?.token, undefined);
    assert.equal((await window.bridge.dropWebImages(id, collection, [mixedImage], { nativeToken: native.token, sourceURL })).queued, 2);
    const mixed = await waitFor(async () => {
      const { library } = await command('library:state');
      return library.assets.length === 4 && library.assets;
    });
    const mixedRaw = mixed.find(asset => asset.name === '混合拖入');
    assert.equal(mixedRaw.sourceURL, sourceURL);
    assert.deepEqual(mixedRaw.collectionIds, [collection]);
    assert.deepEqual(Buffer.from(await (await media('original', id, mixedRaw.id)).arrayBuffer()), image);
    const local = mixed.find(asset => asset.name === '资源管理器');
    assert.deepEqual(local.collectionIds, [collection]);
    const exported = path.join(temp, '资源管理器副本.txt');
    await command('asset:export', local.id, id, exported);
    assert.equal(await fs.readFile(exported, 'utf8'), 'Explorer file');

    const entry = { name: '边界测试.bmp', byteCount: 32 * 1024 ** 2 };
    const oversized = await request('local-import:drop-begin', id, collection, { images: [entry, { ...entry, byteCount: 1 }] });
    assert.equal(oversized.ok, false);
    assert.match(oversized.error, /32 MB/);
    const { token } = await command('local-import:drop-begin', id, collection, { images: [entry] });
    const { token: second } = await command('local-import:drop-begin', id, collection, { images: [entry] });
    assert.equal((await request('local-import:drop-begin', id, collection, { images: [entry] })).ok, false);
    const chunk = image.subarray(0, maximumChunkBytes).toString('base64');
    assert.equal((await request('local-import:drop-append', token, 0, 1, chunk)).ok, false);
    assert.equal((await request('local-import:drop-append', token, 0, 0, `${chunk}AAAA`)).ok, false);
    assert.equal((await request('local-import:drop-append', token, 0, 0, `=${chunk.slice(1)}`)).ok, false);
    await command('local-import:drop-append', token, 0, 0, chunk);
    assert.equal((await request('local-import:drop-append', token, 0, 0, chunk)).ok, false);
    assert.equal((await request('local-import:drop-finish', token)).ok, false);
    await command('local-import:drop-discard', token);
    assert.equal((await request('local-import:drop-finish', token)).ok, false);
    const { token: retry } = await command('local-import:drop-begin', id, collection, {
      images: [{ ...entry, byteCount: 64 }],
    });
    await command('local-import:drop-append', retry, 0, 0, Buffer.alloc(64).toString('base64'));
    assert.equal((await request('local-import:drop-finish', retry)).ok, false);
    await command('local-import:drop-discard', second);
    assert.equal((await command('library:state')).library.assets.length, 4);

    await command('local-import:set-paused', id, true);
    receivedSizes.length = 0;
    const videoBytes = Buffer.alloc(33 * 1024 ** 2 + 7, 123);
    mp4Header.copy(videoBytes);
    const largeVideo = new File([videoBytes], '长视频.mp4', { type: 'application/octet-stream' });
    const smallVideo = new File([mp4Header], '短视频.mov', { type: 'video/quicktime' });
    const videoDrop = await window.bridge.dropWebImages(id, collection, [], {
      videoFiles: [largeVideo, smallVideo], sourceURL,
    });
    assert.equal(videoDrop.queued, 2);
    assert.equal(receivedSizes.reduce((total, size) => total + size, 0), largeVideo.size + smallVideo.size);
    const spool = path.join(temp, 'profile', 'local-imports-v1', 'clipboard');
    assert.deepEqual((await fs.readdir(spool)).sort(), videoDrop.tasks.map(task => `${task.id}.video`).sort());
    await command('local-import:cancel', id, videoDrop.tasks[1].id);
    assert.deepEqual(await fs.readdir(spool), [`${videoDrop.tasks[0].id}.video`]);
    await command('local-import:set-paused', id, false);
    const importedVideo = await waitFor(async () => {
      const { library } = await command('library:state');
      return library.assets.find(asset => asset.name === '长视频');
    });
    assert.equal(importedVideo.kind, 'video');
    assert.equal(importedVideo.byteCount, videoBytes.length);
    assert.equal(importedVideo.sourceURL, sourceURL);
    assert.deepEqual(importedVideo.collectionIds, [collection]);
    const original = await media('original', id, importedVideo.id);
    assert.equal(original.status, 200);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), videoBytes);
    await waitFor(async () => !(await fs.readdir(spool)).length);
  } finally {
    await backend?.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
