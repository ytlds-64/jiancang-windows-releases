'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { prepareVideoTrim, maximumSegments, validateTrimRanges } = require('../../video-trim.cjs');
const { exportFilename, openContainedFile, parseByteRange } = require('../../original-file.cjs');
const { openAsset } = require('./media.cjs');

const previewKey = '0'.repeat(64);
const phases = { preparing: 'copying', previewing: 'preview', saving: 'publishing' };

function trimError(error) {
  if (error.code === 'EEXIST') return new Error('已有同名文件，请换一个保存名称。');
  if (error.code === 'ENOSPC') return new Error('磁盘空间不足，请释放空间后再试。');
  if (typeof error.code === 'string' && error.code.startsWith('VIDEO_')) return new Error(error.message);
  return error;
}

class VideoService {
  constructor(library, { ffprobe } = {}) {
    this.library = library;
    this.ffprobe = ffprobe;
    this.active = null;
  }

  async close(job = this.active) {
    if (!job) return { ok: true };
    if (this.active === job) this.active = null;
    if (job.closing) return job.closing;
    job.lifetime.abort();
    job.controller?.abort();
    job.closing = (async () => {
      await job.pending?.catch(() => {});
      await job.engine?.close();
      return { ok: true };
    })();
    return job.closing;
  }

  requireJob(sessionId) {
    const job = this.active;
    if (!job?.engine || job.id !== sessionId || job.lifetime.signal.aborted) {
      throw new Error('请重新打开视频工具。');
    }
    return job;
  }

  async run(job, action) {
    if (job.controller) throw new Error('有一个视频任务正在进行。');
    this.library.shutdown.signal.throwIfAborted();
    job.lifetime.signal.throwIfAborted();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.library.shutdown.signal, job.lifetime.signal]);
    job.controller = controller;
    const pending = Promise.resolve().then(() => action(signal, data => {
      if (this.active === job && !signal.aborted) {
        job.progress = { sessionId: job.id, phase: phases[data.phase] || data.phase, progress: data.progress };
      }
    }));
    job.pending = pending;
    try { return await pending; }
    catch (error) {
      if (signal.aborted) return { cancelled: true };
      throw trimError(error);
    } finally {
      job.controller = null;
      job.pending = null;
    }
  }

  async probe({ id, registrationId, revision } = {}) {
    if (typeof registrationId !== 'string' || !revision || this.library.catalogs.get(registrationId)?.cacheKey !== revision) {
      throw new Error('素材列表已变化，请重新打开视频工具。');
    }
    const original = this.library.original(id, registrationId);
    const { asset, library } = original;
    if (asset.kind !== 'video' || asset.trashed || !(asset.byteCount > 0)) throw new Error('请选择可读取的视频素材。');
    const ffmpeg = this.library.ffmpeg;
    const ffprobe = this.ffprobe ?? (ffmpeg && path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
    const tool = ffprobe && await fs.lstat(ffprobe).catch(() => null);
    if (!ffmpeg || !tool?.isFile() || tool.isSymbolicLink()) throw new Error('视频组件不可用，请重新解压完整的见藏测试包。');

    const previous = this.active;
    const job = { id: randomUUID(), assetId: id, registrationId, name: asset.name, revision, lifetime: new AbortController() };
    this.active = job;
    let ready = false;
    try {
      return await this.run(job, async (signal, report) => {
        await this.close(previous);
        signal.throwIfAborted();
        const tempRoot = path.join(this.library.profile, 'video-work-v1');
        await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
        const folder = await fs.lstat(tempRoot);
        if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('视频临时目录不可用。');
        job.engine = await prepareVideoTrim({ ffmpeg, ffprobe, extension: asset.extension, expectedBytes: asset.byteCount,
          expectedSha256: library.publicLibrary.kind === 'jiancang' ? asset.id : undefined,
          tempRoot, signal, openSource: async () => (await openAsset(original, signal)).handle, onProgress: report });
        signal.throwIfAborted();
        const { duration, width, height, hasAudio, formats, frameRate, previewAvailable } = job.engine;
        ready = true;
        return { ok: true, sessionId: job.id, duration, width, height, hasAudio, formats, frameRate, previewAvailable, maximumSegments };
      });
    } finally {
      if (!ready) await this.close(job);
    }
  }

  exportJob(options) {
    const job = this.requireJob(options?.sessionId);
    if (job.assetId !== options.id || job.registrationId !== options.registrationId || job.revision !== options.revision ||
        !job.engine.formats.includes(options.format)) {
      throw new Error('裁剪范围或输出选项已变化，请重新确认。');
    }
    validateTrimRanges(options, job.engine.duration, job.engine.frameRate);
    return job;
  }

  destination(options) {
    const job = this.exportJob(options);
    return { defaultName: exportFilename(`${job.name} - 裁剪`, options.format), extension: options.format };
  }

  export(options, file) {
    const job = this.exportJob(options);
    if (typeof file !== 'string' || file.length > 32767 || !path.isAbsolute(file) || file.includes('\0')) {
      throw new Error('请选择有效的保存位置。');
    }
    const { format, quality, resolution, muted, segments, start, end } = options;
    const target = path.extname(file).toLowerCase() === `.${format}` ? file : `${file}.${format}`;
    return this.run(job, async (signal, report) => {
      await job.engine.export({ start, end, segments, format, quality, resolution, muted, target,
        protectedRoots: [this.library.profile, ...this.library.registry.entries.map(entry => entry.root)], signal, onProgress: report });
      return { ok: true };
    });
  }

  async preview(sessionId) {
    const job = this.requireJob(sessionId);
    return this.run(job, async (signal, report) => {
      job.preview ??= await job.engine.makePreview({ signal, onProgress: report });
      const origin = process.platform === 'win32' ? 'https://jiancangmedia.localhost' : 'jiancangmedia://localhost';
      return { ok: true, previewURL: `${origin}/trim-preview/${job.id}/${previewKey}` };
    });
  }

  async servePreview(request, response, role, sessionId, assetId, signal) {
    const job = this.active;
    if (role !== 'trim-preview' || job?.id !== sessionId || assetId !== previewKey || !job.preview) {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    const { file, size } = job.preview;
    const range = parseByteRange(request.headers.range, size);
    if (range === false) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    const lifetime = AbortSignal.any([signal, job.lifetime.signal]);
    lifetime.throwIfAborted();
    const handle = await openContainedFile(path.dirname(file), file, size);
    try {
      lifetime.throwIfAborted();
      const headers = { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Content-Length': range ? range.end - range.start + 1 : size };
      if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
      response.writeHead(range ? 206 : 200, headers);
      if (request.method === 'HEAD') { response.end(); return; }
      await pipeline(handle.createReadStream({ start: range?.start ?? 0, end: range?.end ?? size - 1, autoClose: false }),
        response, { signal: lifetime });
    } finally { await handle.close(); }
  }

  command(name, args) {
    switch (name) {
      case 'video-trim:probe': return this.probe(args[0]);
      case 'video-trim:status': return this.active?.progress ?? null;
      case 'video-trim:preview': return this.preview(args[0]);
      case 'video-trim:destination': return this.destination(args[0]);
      case 'video-trim:export': return this.export(args[0], args[1]);
      case 'video-trim:cancel':
        if (this.active && (args[0] == null || this.active.id === args[0])) this.active.controller?.abort();
        return { ok: true };
      case 'video-trim:release': return this.active?.id === args[0] ? this.close() : { ok: true };
      default: throw new Error('此视频操作不可用。');
    }
  }
}

module.exports = { VideoService };
