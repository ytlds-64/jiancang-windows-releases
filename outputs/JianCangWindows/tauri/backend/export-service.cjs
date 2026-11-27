'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { exportBatch } = require('../../batch-export.cjs');
const { planStructuredExport, runStructuredExport } = require('../../structured-export.cjs');
const { writeBoardExport, readBoardProject, projectExtension } = require('../../board-export.cjs');
const { writeVideoMarkers } = require('../../video-markers.cjs');
const { exportFilename, isWithin, validateExportTarget } = require('../../original-file.cjs');
const { folderIdentity } = require('../../library-watcher.cjs');
const { imageDimensions } = require('../../image-dimensions.cjs');
const { createLocalBackup, restoreLocalBackup, prepareLocalBackupGroup,
  createIncrementalLocalBackup, listLocalBackupSnapshots } = require('../../local-backup.cjs');
const { validateEditedImage } = require('../../local-library.cjs');
const { exportAsset } = require('./media.cjs');
const { BackupPlans } = require('./backup-plans.cjs');

const commands = new Set([
  'assets:export-batch', 'structured-export:plan', 'structured-export:choose', 'structured-export:start',
  'structured-export:status', 'board:export-name', 'board:import-project', 'board:export',
  'board:export-begin', 'board:export-append', 'board:export-discard', 'asset:save-markers-name',
  'asset:save-markers', 'image-conversion:start', 'image-conversion:status', 'image-conversion:cancel',
  'local-backup:create', 'local-backup:restore', 'local-backup:status', 'local-backup:cancel',
  'local-backup:plan', 'local-backup:configure', 'local-backup:run', 'local-backup:snapshots', 'local-backup:restore-snapshot',
]);
const boardFormats = new Set(['png', 'pdf', projectExtension]);
const rasterFormats = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif']);
const maxBoardBytes = 96 * 1024 ** 2;
const maxUploadChunk = 768 * 1024;
const maxImageInput = 96 * 1024 ** 2;
const maxImageOutput = 40 * 1024 ** 2;
const uploadLifetime = 10 * 60_000;
const runProcess = promisify(execFile);

function absolute(value) {
  return typeof value === 'string' && value.length <= 32_767 && !value.includes('\0') && path.isAbsolute(value);
}

function withExtension(filename, extension) {
  if (!absolute(filename)) throw new Error('请选择有效的保存位置。');
  const target = path.extname(filename).toLowerCase() === `.${extension}` ? filename : `${filename}.${extension}`;
  const basename = path.basename(target);
  if (!basename || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(basename) ||
      /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(basename)) {
    throw new Error('请选择有效的文件名。');
  }
  return target;
}

function boardDestination({ name, format } = {}) {
  if (!boardFormats.has(format) || typeof name !== 'string' || name.length > 80) {
    throw new Error('请选择有效的灵感板和导出格式。');
  }
  return { defaultName: exportFilename(name.trim() || '灵感板', format), extension: format };
}

function eligibleImage(asset) {
  return asset.kind === 'image' && !asset.trashed && rasterFormats.has(asset.extension) &&
    asset.byteCount > 0 && asset.byteCount <= maxImageInput;
}

function sameImage(left, right) {
  return left.library.root === right.library.root && left.library.identity === right.library.identity &&
    left.asset.id === right.asset.id && left.asset.mediaRevision === right.asset.mediaRevision &&
    left.asset.byteCount === right.asset.byteCount && left.asset.extension === right.asset.extension;
}

function imageArguments(source, destination, { maximumSide, format, quality }) {
  const scale = `scale=w='min(iw,${maximumSide})':h='min(ih,${maximumSide})':force_original_aspect_ratio=decrease:flags=lanczos`;
  let filter = `${scale},format=rgba`;
  let encoder = ['-c:v', 'png'];
  if (format === 'jpeg') {
    filter += ',split[photo][paper];[paper]drawbox=c=white:t=fill:replace=1[white];[white][photo]overlay=shortest=1:format=rgb,format=yuvj444p';
    encoder = ['-c:v', 'mjpeg', '-q:v', String(Math.round(2 + (100 - quality) * .225))];
  } else if (format === 'webp') {
    encoder = ['-c:v', 'libwebp', '-quality', String(quality), '-pix_fmt', 'bgra'];
  }
  return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n', '-max_alloc', '134217728',
    '-protocol_whitelist', 'file', '-format_whitelist', 'png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,mov,heif',
    '-max_pixels', '80000000', '-threads', '1', '-i', source, '-map', '0:v:0', '-map_metadata', '-1',
    '-an', '-sn', '-vf', filter, '-filter_complex_threads', '1', '-filter_threads', '1', '-frames:v', '1',
    '-threads', '1', ...encoder, '-fs', String(maxImageOutput + 1), '-f', 'image2', '-update', '1', destination];
}

class ExportService {
  constructor(library) {
    this.library = library;
    this.destinations = new Map();
    this.job = null;
    this.upload = null;
    this.closed = false;
    this.backupPlans = new BackupPlans(library, {
      busy: () => !!this.job,
      prepare: async ({ libraryId }, destination) => {
        if (!absolute(destination)) throw new Error('请选择有效的增量备份位置。');
        return prepareLocalBackupGroup({ destination, libraryId, protectedRoots: await this.protectedRoots(),
          signal: this.library.shutdown.signal });
      },
      perform: plan => this.incrementalBackup(plan),
    });
  }

  static handles(name) { return commands.has(name); }

  initialize() { return this.backupPlans.initialize(); }

  async close() {
    this.closed = true;
    this.clearUpload();
    this.destinations.clear();
    this.backupSource = null;
    this.job?.controller.abort();
    await Promise.allSettled([this.job?.pending, this.backupPlans.close()]);
  }

  roots() { return [this.library.profile, ...this.library.registry.entries.map(entry => entry.root)]; }

  async protectedRoots(roots = this.roots()) {
    return [...new Set([...roots, ...await Promise.all(roots.map(root => fs.realpath(root).catch(() => root)))])];
  }

  async prepareDirectory(input) {
    if (!absolute(input)) throw new Error('请选择有效的导出文件夹。');
    const directory = await fs.realpath(input);
    const roots = await this.protectedRoots();
    if (roots.some(root => isWithin(root, input) || isWithin(root, directory))) {
      throw new Error('请选择素材库以外的文件夹保存副本。');
    }
    const stat = await fs.lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('请选择有效的导出文件夹。');
    return { directory, roots, identity: folderIdentity(stat) };
  }

  async checkDirectory({ directory, identity, roots }) {
    const info = await fs.lstat(directory, { bigint: true }).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink() || folderIdentity(info) !== identity ||
        path.relative(directory, await fs.realpath(directory)) !== '') {
      throw new Error('导出目录已移动，请重新选择。');
    }
    const protectedRoots = await this.protectedRoots([...roots, ...this.roots()]);
    if (protectedRoots.some(root => isWithin(root, directory))) {
      throw new Error('请选择素材库以外的文件夹保存副本。');
    }
    return protectedRoots;
  }

  async choose(directory) {
    const chosen = await this.prepareDirectory(directory);
    const token = randomUUID();
    if (this.destinations.size >= 24) this.destinations.delete(this.destinations.keys().next().value);
    this.destinations.set(token, chosen);
    return { path: chosen.directory, token };
  }

  async checkChosen(token) {
    const target = this.destinations.get(token);
    if (!target) throw new Error('请重新选择导出目录。');
    try { await this.checkDirectory(target); }
    catch (error) { this.destinations.delete(token); throw error; }
    return target;
  }

  items(references, { limit = 10_000, board = false } = {}) {
    if (!Array.isArray(references) || !references.length || references.length > limit) {
      throw new Error(`请选择 1 至 ${limit.toLocaleString('zh-CN')} 项素材。`);
    }
    const selected = new Map();
    for (const item of references) {
      const { id, registrationId } = item ?? {};
      if (typeof id !== 'string' || typeof registrationId !== 'string' || !id || !registrationId) continue;
      const key = `${registrationId}:${id}`;
      if (selected.has(key)) continue;
      const card = board && item.board;
      const metadata = Number.isInteger(card?.order) && card.order >= 1 && card.order <= 80
        ? { order: card.order,
          title: typeof card.title === 'string' ? card.title.slice(0, 160) : '',
          source: typeof card.source === 'string' ? card.source.slice(0, 120) : '',
          note: typeof card.note === 'string' ? card.note.slice(0, 480) : '' }
        : null;
      const reference = { id, registrationId, ...(metadata && { board: metadata }) };
      try {
        const original = this.library.asset(id, registrationId);
        const { asset } = original;
        selected.set(key, { name: asset.name, extension: asset.extension,
          available: !!original.file && (!metadata || !asset.trashed), original, reference });
      } catch {
        selected.set(key, { name: metadata?.title || '已不可用的素材', available: false, reference });
      }
    }
    if (!selected.size) throw new Error('没有可导出的素材，请重新选择。');
    return [...selected.values()];
  }

  async copy(item, destination, protectedRoots, chosen, signal) {
    signal.throwIfAborted();
    // The directory grant remains valid only while the chosen folder keeps its identity.
    const currentRoots = await this.checkDirectory(chosen);
    const { library } = item.original;
    const current = this.library.catalogs.get(library.registrationId);
    if (current?.root !== library.root || current.identity !== library.identity) {
      throw new Error('素材库位置已变化，请刷新后重试。');
    }
    return exportAsset(item.original, destination, [...protectedRoots, ...currentRoots]);
  }

  async run(kind, action) {
    if (this.closed) throw new Error('见藏正在退出。');
    if (this.job) throw new Error('正在导出另一批素材，请稍后再试。');
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.library.shutdown.signal]);
    const job = { kind, controller, progress: null };
    this.job = job;
    const operation = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return action(signal, progress => { job.progress = progress; });
    });
    job.pending = operation;
    try { return await operation; }
    finally { this.job = null; }
  }

  progress(kind) { return this.job?.kind === kind ? this.job.progress : null; }

  backup(mode, value, destination, backupRoot, snapshot) {
    return this.run('backup', async (signal, onProgress) => {
      if (!absolute(destination) || (mode === 'restore' && !absolute(backupRoot))) throw new Error('请选择有效的备份位置。');
      const getOptions = async () => ({ destination, signal, onProgress, protectedRoots: await this.protectedRoots() });
      try {
        if (mode === 'create') {
          return await this.library.serial(async () => {
            signal.throwIfAborted();
            const entry = this.library.writable(value);
            if (entry.kind !== 'local') throw new Error('请选择一个见藏本地库。');
            return createLocalBackup({ ...await getOptions(), root: entry.root, expectedLibraryId: entry.libraryId });
          });
        }
        const result = await restoreLocalBackup({ ...await getOptions(), name: value, backupRoot, ...snapshot });
        const state = await this.library.command('library:choose', ['local', result.directory]).catch(() => null);
        const registration = state?.libraries.find(item => item.libraryId === result.libraryId);
        return { ...result, state, registrationId: registration?.id,
          message: registration ? undefined : '备份已恢复，请从「打开本地库」添加恢复后的文件夹。' };
      } catch (error) {
        if (signal.aborted) return { cancelled: true };
        throw error;
      }
    });
  }

  incrementalBackup(plan) {
    return this.run('backup', async (signal, onProgress) => {
      try {
        await this.library.startup;
        signal.throwIfAborted();
        const entry = this.library.writable(plan.id);
        if (entry.kind !== 'local' || entry.libraryId !== plan.libraryId) throw new Error('素材库已变化，请重新设置增量备份。');
        return await createIncrementalLocalBackup({ root: entry.root, expectedLibraryId: plan.libraryId,
          groupRoot: plan.directory, expectedGroupId: plan.groupId, protectedRoots: await this.protectedRoots(), signal, onProgress });
      } catch (error) {
        if (signal.aborted) return { cancelled: true };
        throw error;
      }
    });
  }

  backupPlan(id) {
    const status = this.backupPlans.status(id);
    return { ...status, progress: status.running ? this.progress('backup') : null };
  }

  async backupSnapshots(directory) {
    if (!absolute(directory)) throw new Error('请选择有效的增量备份文件夹。');
    const { snapshots, ...source } = await listLocalBackupSnapshots(directory, { signal: this.library.shutdown.signal });
    const token = randomUUID();
    this.backupSource = { ...source, token };
    return { ok: true, directory: source.directory, snapshots, token };
  }

  restoreSnapshot(name, token, snapshotId, destination) {
    const source = this.backupSource;
    if (!source || source.token !== token || typeof snapshotId !== 'string') {
      throw new Error('请重新选择要恢复的增量备份日期。');
    }
    return this.backup('restore', name, destination, source.directory, { snapshotId, expectedGroupId: source.groupId });
  }

  batch(references, directory) {
    return this.run('batch', async signal => {
      const items = this.items(references);
      const chosen = await this.prepareDirectory(directory);
      const result = await exportBatch({ items, signal, destination: chosen.directory, libraryRoots: chosen.roots,
        copy: (item, target, roots) => this.copy(item, target, roots, chosen, signal) });
      return { ok: result.written > 0, ...result };
    });
  }

  async plan(references, options, recheck) {
    let items = this.items(references, { board: true });
    if (recheck === true) {
      const ids = new Set(items.map(item => item.reference.registrationId));
      await this.library.serial(async () => {
        for (const entry of this.library.registry.entries) if (ids.has(entry.id)) await this.library.refreshEntry(entry);
        this.library.notify();
      });
      items = this.items(references, { board: true });
    }
    return planStructuredExport(items, options);
  }

  structured(references, options, token) {
    return this.run('structured', async (signal, report) => {
      const chosen = await this.checkChosen(token);
      const items = this.items(references, { board: true });
      const { failedIndices, ...result } = await runStructuredExport({ items, options, destination: chosen.directory,
        libraryRoots: [...chosen.roots, ...this.roots()], onProgress: report,
        copy: (item, target, roots) => this.copy(item, target, roots, chosen, signal) });
      return { ...result, failedReferences: failedIndices.map(index => items[index].reference) };
    });
  }

  clearUpload(token = this.upload?.token) {
    if (this.upload?.token === token) {
      clearTimeout(this.upload?.expiry);
      this.upload = null;
    }
    return { ok: true };
  }

  beginUpload(format) {
    if (format !== 'png' && format !== 'pdf') throw new Error('请选择图片或 PDF 导出。');
    if (this.upload) throw new Error('正在准备另一张灵感板，请稍后再试。');
    const token = randomUUID();
    this.upload = { token, format, pages: new Map(), chunks: 0, size: 0 };
    this.touchUpload();
    return { token };
  }

  touchUpload() {
    const { token, expiry } = this.upload;
    clearTimeout(expiry);
    this.upload.expiry = setTimeout(() => this.clearUpload(token), uploadLifetime);
    this.upload.expiry.unref();
  }

  appendUpload(token, index, data) {
    const state = this.upload;
    if (!state || state.token !== token) throw new Error('导出已过期，请重新生成灵感板。');
    if (!Number.isInteger(index) || index < 0 || index >= (state.format === 'png' ? 1 : 80) ||
        typeof data !== 'string' || !data.length || data.length > maxUploadChunk * 4 / 3 || data.length % 4 !== 0) {
      throw new Error('无法读取灵感板导出数据。');
    }
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.toString('base64') !== data) throw new Error('无法读取灵感板导出数据。');
    if (state.chunks >= 512 || state.size + bytes.length > maxBoardBytes) {
      this.clearUpload(token);
      throw new Error('灵感板过大，请分成多份导出。');
    }
    const page = state.pages.get(index) || { chunks: [], size: 0 };
    page.chunks.push(bytes);
    page.size += bytes.length;
    state.pages.set(index, page);
    state.chunks++;
    state.size += bytes.length;
    this.touchUpload();
    return { ok: true };
  }

  boardBytes({ format, pages, uploadToken }) {
    const state = this.upload;
    if (!state || state.token !== uploadToken || state.format !== format) throw new Error('请重新生成灵感板。');
    const count = format === 'png' ? 1 : Array.isArray(pages) ? pages.length : 0;
    if (count < 1 || count > 80 || state.pages.size !== count) throw new Error('灵感板页数不正确。');
    function pack(index) {
      const page = state.pages.get(index);
      if (!page?.size) throw new Error('灵感板导出数据不完整。');
      return Buffer.concat(page.chunks, page.size);
    }
    if (format === 'png') return { data: pack(0) };
    return { pages: pages.map(({ width, height }, index) => ({ width, height, data: pack(index) })) };
  }

  async saveBoard(input, file) {
    const { extension: format } = boardDestination(input);
    return this.run('board', async signal => {
      try {
        const target = withExtension(file, format);
        const protectedRoots = await this.protectedRoots();
        signal.throwIfAborted();
        await writeBoardExport({ target, format, protectedRoots, ...(format === projectExtension
          ? { project: { name: input.name, entries: input.entries } } : this.boardBytes(input)) });
        return { ok: true, message: '灵感板已导出。' };
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error('已有同名文件，请换一个保存名称。');
        throw error;
      } finally {
        if (format !== projectExtension && typeof input.uploadToken === 'string') this.clearUpload(input.uploadToken);
      }
    });
  }

  async importBoard(file) {
    if (!absolute(file) || path.extname(file).toLowerCase() !== `.${projectExtension}`) {
      throw new Error('请选择见藏灵感板工程文件。');
    }
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('请选择有效的灵感板工程文件。');
    return { ok: true, project: await readBoardProject(file) };
  }

  markerDestination({ id, registrationId, format, notes } = {}) {
    if (!['csv', 'srt'].includes(format) || !Array.isArray(notes) || !notes.length) {
      throw new Error('没有可导出的视频备注。');
    }
    const { asset } = this.library.asset(id, registrationId);
    if (asset.kind !== 'video' || asset.trashed) throw new Error('请选择视频素材。');
    return { defaultName: exportFilename(`${asset.name} - 时间点备注`, format), extension: format, duration: asset.duration };
  }

  saveMarkers(input, file) {
    const { extension: format, duration } = this.markerDestination(input);
    return this.run('markers', async signal => {
      const target = withExtension(file, format);
      const protectedRoots = await this.protectedRoots();
      signal.throwIfAborted();
      try {
        await writeVideoMarkers({ notes: input.notes, format, target, protectedRoots,
          duration: Number.isFinite(input.duration) && input.duration > 0 ? input.duration : duration });
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error('已有同名文件，请换一个保存名称。');
        throw error;
      }
      return { ok: true, message: `已导出 ${format.toUpperCase()} 视频备注。` };
    });
  }

  async convert(item, destination, protectedRoots, chosen, settings, signal) {
    const { original, extension } = item;
    const { asset, library } = original;
    const currentImage = () => {
      const current = this.library.original(asset.id, library.registrationId);
      if (!eligibleImage(current.asset) || !sameImage(original, current)) throw new Error('素材已变化，请重新选择。');
      return current;
    };
    const workspace = await fs.mkdtemp(path.join(this.library.profile, '.jiancang-image-'));
    try {
      const source = path.join(workspace, `source.${asset.extension}`);
      await exportAsset(currentImage(), source, [library.root]);
      signal.throwIfAborted();
      const output = path.join(workspace, `image.${extension}`);
      try {
        await runProcess(this.library.ffmpeg, imageArguments(source, output, settings),
          { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024, signal });
      } catch (error) {
        signal.throwIfAborted();
        if (error.killed) throw new Error('图片转换超时，请确认原件可用后重试。');
        throw new Error('无法读取这张图片，请确认原件可打开且尺寸未超出转换范围。');
      }
      const info = await fs.stat(output).catch(() => null);
      if (!info?.isFile() || !info.size || info.size > maxImageOutput) {
        throw new Error('图片未能生成或超过 40 MB，请缩小尺寸或改用 JPEG。');
      }
      const bytes = await fs.readFile(output, { signal });
      const [width, height] = imageDimensions(bytes);
      if (Math.max(width, height) > settings.maximumSide) throw new Error('转换后的图片尺寸不正确。');
      validateEditedImage({ bytes, width, height, format: settings.format });
      currentImage();
      const currentRoots = await this.checkDirectory(chosen);
      signal.throwIfAborted();
      const target = await validateExportTarget(destination, [...protectedRoots, ...currentRoots],
        '请选择素材库以外的位置。');
      await fs.copyFile(output, target, constants.COPYFILE_EXCL);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {});
    }
  }

  convertImages(references, settings, token) {
    const { maximumSide, format, quality } = settings ?? {};
    if (!['jpeg', 'png', 'webp'].includes(format) || !Number.isInteger(maximumSide) || maximumSide < 64 || maximumSide > 4096 ||
        !Number.isInteger(quality) || quality < 20 || quality > 100) throw new Error('请选择有效的图片格式、尺寸和画质。');
    if (!this.library.ffmpeg) throw new Error('图片转换组件不可用，请重新解压完整的见藏测试包。');
    return this.run('conversion', async (signal, report) => {
      const chosen = await this.checkChosen(token);
      const extension = format === 'jpeg' ? 'jpg' : format;
      const items = this.items(references, { limit: 1000 }).map(item => {
        const asset = item.original?.asset;
        if (asset && !eligibleImage(asset)) {
          return { ...item, available: false, failure: '原件的格式或文件大小超出图片转换支持范围。' };
        }
        const suffix = `.${asset?.extension}`;
        const name = item.name.toLowerCase().endsWith(suffix) ? item.name.slice(0, -suffix.length) : item.name;
        return { ...item, name, extension };
      });
      const result = await exportBatch({ items, signal, destination: chosen.directory,
        libraryRoots: [...chosen.roots, ...this.roots()], onProgress: report,
        copy: (item, target, roots) => this.convert(item, target, roots, chosen, settings, signal) });
      return { ...result, cancelled: signal.aborted, total: items.length };
    });
  }

  command(name, args = []) {
    if (this.closed) throw new Error('见藏正在退出。');
    switch (name) {
      case 'assets:export-batch': return this.batch(...args);
      case 'structured-export:plan': return this.plan(...args);
      case 'structured-export:choose': return this.choose(args[0]);
      case 'structured-export:start': return this.structured(...args);
      case 'structured-export:status': return this.progress('structured');
      case 'board:export-name': return boardDestination(args[0]);
      case 'board:export': return this.saveBoard(...args);
      case 'board:import-project': return this.importBoard(args[0]);
      case 'board:export-begin': return this.beginUpload(args[0]);
      case 'board:export-append': return this.appendUpload(...args);
      case 'board:export-discard': return this.clearUpload(args[0]);
      case 'asset:save-markers-name': return this.markerDestination(args[0]);
      case 'asset:save-markers': return this.saveMarkers(...args);
      case 'image-conversion:start': return this.convertImages(...args);
      case 'image-conversion:status': return this.progress('conversion');
      case 'image-conversion:cancel':
        if (this.job?.kind !== 'conversion') return { ok: false };
        this.job.controller.abort();
        return { ok: true };
      case 'local-backup:create': return this.backup('create', ...args);
      case 'local-backup:restore': return this.backup('restore', ...args);
      case 'local-backup:plan': return this.backupPlan(args[0]);
      case 'local-backup:configure': return this.backupPlans.configure(...args);
      case 'local-backup:run': return this.backupPlans.run(args[0]);
      case 'local-backup:snapshots': return this.backupSnapshots(args[0]);
      case 'local-backup:restore-snapshot': return this.restoreSnapshot(...args);
      case 'local-backup:status': return this.progress('backup');
      case 'local-backup:cancel':
        if (this.job?.kind !== 'backup') return { ok: false };
        this.job.controller.abort();
        return { ok: true };
      default: throw new Error('此导出操作不可用。');
    }
  }
}

module.exports = { ExportService };
