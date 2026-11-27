'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { LibraryService } = require('./library-service.cjs');
const { mediaHandler } = require('./media.cjs');
const { CaptureService } = require('./capture-service.cjs');
const { VideoService } = require('./video-service.cjs');
const { readVideoMetadata } = require('./video-metadata.cjs');
const { VisualService } = require('./visual-service.cjs');
const { ExportService } = require('./export-service.cjs');
const { OrganizeService } = require('./organize-service.cjs');
const { AIService } = require('./ai-service.cjs');
const { IntakeService } = require('./intake-service.cjs');
const { CloudService } = require('./cloud-service.cjs');
const { EditService } = require('./edit-service.cjs');
const { TransferService } = require('./transfer-service.cjs');
const { UpdateService } = require('./update-service.cjs');
const { OfflineService } = require('./offline-service.cjs');
const { migrateLegacyProfile } = require('./profile-migration.cjs');
const { readLegacyPresets } = require('./legacy-presets.cjs');
const { listStudio, writeStudio } = require('../../studio-sync.cjs');

const maximumCommandBytes = 4 * 1024 * 1024;
const matchesMedia = /^\/media\/([a-z-]+)\/([a-f0-9-]{1,64})\/([a-f0-9]{64})$/;

function respond(response, status, result) {
  const bytes = Buffer.from(JSON.stringify(result), 'utf8');
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(bytes);
}

function libraryStateRevision(state) {
  // Catalog revisions represent the asset data. Track status and acknowledged
  // conflicts separately because they can change without replacing a catalog.
  const parts = [state.activeLibraryId, state.message, state.libraryOpening, state.libraries,
    state.catalogs.map(({ libraryId, revision, library }) => [libraryId, revision, library.syncConflicts])];
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
}

function libraryResponse(value, name, args) {
  if (Array.isArray(value?.catalogs) && 'library' in value) {
    const libraryRevision = libraryStateRevision(value);
    if (name === 'library:state' && args[0]?.compact === true) {
      if (args[0].knownRevision === libraryRevision) return { notModified: true };
      // The current catalog is already in catalogs. Restore the legacy
      // renderer shape in the Tauri bridge without serializing it a second time.
      const { library, ...compact } = value;
      return { ...compact, libraryRevision };
    }
    return { ...value, libraryRevision };
  }
  if (Array.isArray(value?.state?.catalogs) && 'library' in value.state) {
    return { ...value, state: { ...value.state, libraryRevision: libraryStateRevision(value.state) } };
  }
  return value;
}

async function commandBody(request) {
  if (!/^application\/json\s*(?:;|$)/i.test(request.headers['content-type'] || '')) throw new Error('请求应为 JSON。');
  if (Number(request.headers['content-length']) > maximumCommandBytes) throw new Error('请求过大，请分批操作。');
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximumCommandBytes) throw new Error('请求过大，请分批操作。');
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks, length)); }
  catch { throw new Error('无法读取操作请求。'); }
  if (!data || typeof data.name !== 'string' || data.name.length > 64 ||
      !Array.isArray(data.args) || data.args.length > 16) throw new Error('操作请求格式无效。');
  return data;
}

async function start(profile, version, installed, downloads) {
  const marker = await fs.readFile(path.join(__dirname, '../../release-mode.json'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '{}';
  });
  const production = JSON.parse(marker).production === true;
  if (installed && production && process.platform === 'win32') {
    try {
      await migrateLegacyProfile(profile);
    } catch {
      // A temporarily unavailable old profile should not hide libraries
      // already registered in Tauri. Retry on the next launch.
      process.stderr.write('暂时无法接续旧版设置，将在下次启动时重试。\n');
    }
  }
  let capture;
  const service = new LibraryService(profile, { onStateChange: () => {
    void capture?.enableDefault().catch(() => {});
  } });
  await service.initialize();
  capture = new CaptureService({ profile: service.profile, library: service, production: production && installed });
  const video = new VideoService(service);
  const visual = new VisualService(service);
  const organizer = new OrganizeService(service, visual);
  const exporter = new ExportService(service);
  const intake = new IntakeService(service);
  const editor = new EditService(service);
  const transfer = new TransferService(service, downloads);
  const offline = new OfflineService(service, { production });
  const serveMedia = mediaHandler(service);
  const cloudRevisions = new Map();
  let cloudRevision = 0;
  const cloud = new CloudService(service, { thumbnailCache: serveMedia,
    onChange: id => cloudRevisions.set(id, ++cloudRevision) });
  const updates = new UpdateService(service.profile, { version, installed, production });
  let suggestionsRevision = 0;
  let searchRevision = 0;
  const ai = new AIService(service, visual, { onChange: channel => {
    if (channel === 'suggestion:changed') suggestionsRevision++;
    if (channel === 'natural-search:changed') searchRevision++;
  } });
  await Promise.all([
    capture.initialize().catch(error => process.stderr.write(`采集设置读取失败：${error.message}\n`)),
    visual.initialize().catch(error => process.stderr.write(`视觉索引读取失败：${error.message}\n`)),
    organizer.initialize().catch(error => process.stderr.write(`监视文件夹设置读取失败：${error.message}\n`)),
    exporter.initialize().catch(error => process.stderr.write(`增量备份计划读取失败：${error.message}\n`)),
    ai.initialize().catch(error => process.stderr.write(`AI 设置读取失败：${error.message}\n`)),
    cloud.initialize().catch(error => process.stderr.write(`原件队列读取失败：${error.message}\n`)),
    transfer.initialize().catch(error => process.stderr.write(`拖出缓存读取失败：${error.message}\n`)),
    updates.initialize().catch(error => process.stderr.write(`更新设置读取失败：${error.message}\n`)),
  ]);

  let presetMigration;
  async function dispatch(name, args) {
    if (name === 'presets:import-legacy') {
      return presetMigration ??= readLegacyPresets().finally(() => { presetMigration = undefined; });
    }
    if (name === 'desktop:status') {
      const { historyRevision } = await capture.command('browser-capture:worker-state');
      return { libraryRevision: libraryStateRevision(service.state()), historyRevision, suggestionsRevision, searchRevision,
        inboxRevision: organizer.inboxRevision, duplicates: organizer.duplicateProgress(),
        cloudRevisions: Object.fromEntries(cloudRevisions), update: updates.status() };
    }
    if (CaptureService.handles(name)) return capture.command(name, args);
    if (name.startsWith('video-trim:')) return video.command(name, args);
    if (name === 'asset:video-metadata') return readVideoMetadata(service, args[0]);
    if (name === 'studio:list' || name === 'studio:write') {
      return service.serial(async () => {
        const [registrationId, kind, scope = null, id, payload, expected] = args;
        const entry = service.syncEntry(registrationId);
        if (kind === 'video-note') {
          const { asset } = service.asset(scope, registrationId);
          if (asset.kind !== 'video' || (asset.trashed && name === 'studio:write')) throw new Error('请选择可用的视频素材。');
        }
        if (name === 'studio:list') return listStudio(entry, kind, scope);
        service.writable(registrationId);
        const writer = service.syncWriter.studioDeviceID(entry.libraryId);
        return writeStudio(entry, writer, kind, scope, id, payload, expected);
      });
    }
    if (name.startsWith('visual:')) return visual.command(name, args);
    if (name.startsWith('inbox:') || name.startsWith('duplicates:')) return organizer.command(name, args);
    if (ExportService.handles(name)) return exporter.command(name, args);
    if (AIService.handles(name)) return ai.command(name, args);
    if (IntakeService.handles(name)) return intake.command(name, args);
    if (CloudService.handles(name)) return cloud.command(name, args);
    if (EditService.handles(name)) return editor.command(name, args);
    if (UpdateService.handles(name)) return updates.command(name, args);
    if (OfflineService.handles(name)) return offline.command(name, args);
    if (name === 'asset:reference-info') {
      const [id, registrationId] = args;
      if (typeof id !== 'string' || typeof registrationId !== 'string') throw new Error('参考图已变化，请刷新后重试。');
      const { asset, library, file } = service.asset(id, registrationId);
      if (asset.kind !== 'image' && asset.extension !== 'livp') throw new Error('参考窗可打开图片。');
      return { assetId: asset.id, registrationId: library.registrationId, name: asset.name, originalAvailable: Boolean(file) };
    }
    if (name === 'asset:prepare-drag') return transfer.prepare(...args);
    if (name === 'file-transfer:drag-path') return transfer.use(args[0]);
    if (name === 'file-transfer:drag-finished') return transfer.finish(args[0]);
    if (name === 'file-transfer:clipboard-path') return transfer.forClipboard(...args);
    if (name === 'library:remove' || name === 'library:relocate') {
      const id = args[0];
      const before = service.registry.entries.find(entry => entry.id === id);
      const result = await service.command(name, args);
      const after = service.registry.entries.find(entry => entry.id === id);
      if (before && before.libraryId !== after?.libraryId) {
        cloud.discard(id);
        cloudRevisions.delete(id);
      }
      return result;
    }
    return service.command(name, args);
  }
  const token = randomBytes(32).toString('base64url');
  const required = Buffer.from(`Bearer ${token}`);
  let port;
  let closing = false;
  const server = http.createServer({ requestTimeout: 150_000, headersTimeout: 10_000, keepAliveTimeout: 3000 }, async (request, response) => {
    if (closing) { respond(response, 503, { ok: false, error: '见藏正在退出。' }); return; }
    const supplied = Buffer.from(request.headers.authorization || '');
    if (request.headers.host !== `127.0.0.1:${port}` || supplied.length !== required.length || !timingSafeEqual(supplied, required)) {
      respond(response, 401, { ok: false, error: '本机服务连接无效。' });
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, service.shutdown.signal]);
    response.once('close', () => {
      if (!response.writableEnded) controller.abort(new Error('连接已关闭。'));
    });
    let pathname;
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new Error();
      pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    } catch {
      respond(response, 400, { ok: false, error: '请求路径无效。' });
      return;
    }
    const command = request.method === 'POST' && pathname === '/command';
    try {
      if (command) {
        const { name, args } = await commandBody(request);
        const value = await dispatch(name, args);
        respond(response, 200, { ok: true, value: libraryResponse(value, name, args) ?? null });
      } else {
        const media = ['GET', 'HEAD'].includes(request.method) && matchesMedia.exec(pathname);
        if (!media) { respond(response, 404, { ok: false, error: '此资源不存在。' }); return; }
        const [role, library, asset] = media.slice(1);
        if (role === 'trim-preview') await video.servePreview(request, response, role, library, asset, signal);
        else await serveMedia(request, response, role, library, asset, signal);
      }
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      const localized = typeof error.code === 'string' && /^(EAGLE_|SYNC_)/.test(error.code);
      const message = error.code && !localized ? '无法读取或写入该位置，请检查位置、权限或可用空间。' : error.message;
      respond(response, command ? 200 : 404, { ok: false, error: message || '操作未完成，请重试。' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  process.stdout.write(`${JSON.stringify({ port, token })}\n`);

  async function close() {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(0), 7000);
    server.close();
    server.closeAllConnections();
    try { await Promise.allSettled([service.close(), capture.close(), video.close(), visual.close(),
      organizer.close(), exporter.close(), ai.close(), cloud.close(), editor.close(), updates.close(), offline.close(),
      transfer.close(), intake.close()]); }
    finally { clearTimeout(deadline); process.exit(0); }
  }
  process.stdin.resume();
  process.stdin.once('end', () => void close());
  process.stdin.once('error', () => void close());
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
}

start(process.argv[2], process.argv[3] || '0.0.0', process.argv[4] === 'installed', process.argv[5]).catch(error => {
  process.stderr.write(`无法启动见藏素材库服务：${error?.message || '未知错误'}\n`);
  process.exit(1);
});
