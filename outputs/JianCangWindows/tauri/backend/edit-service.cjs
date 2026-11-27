'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { imageDimensions } = require('../../image-dimensions.cjs');
const { validateEditedImage, replaceLocalPicture } = require('../../local-library.cjs');
const { exportCapturedFrame, exportFilename, validateExportTarget } = require('../../original-file.cjs');
const { sourceStamp, thumbnailSourceRevision } = require('../../thumbnail-cache.cjs');
const { openAsset } = require('./media.cjs');

const commands = new Set(['edit:upload-begin', 'edit:upload-append', 'edit:upload-discard', 'edit:destination', 'edit:save']);
const editableExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif']);
const outputFormats = new Set(['png', 'jpeg', 'webp']);
const maxImageBytes = 96 * 1024 ** 2;
const maxFrameBytes = 128 * 1024 ** 2;
const maxChunkBytes = 768 * 1024;
const uploadLifetime = 10 * 60_000;

function extensionFor(format) { return format === 'jpeg' ? 'jpg' : format; }

function outputPath(filename, extension) {
  if (typeof filename !== 'string' || filename.length > 32_767 || !path.isAbsolute(filename) || filename.includes('\0')) {
    throw new Error('请选择有效的保存位置。');
  }
  const name = path.basename(filename);
  if (!name || /[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(name) ||
      /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) {
    throw new Error('请选择有效的保存文件名。');
  }
  const suffix = path.extname(filename).slice(1).toLowerCase();
  return suffix === extension || (extension === 'jpg' && suffix === 'jpeg') ? filename : `${filename}.${extension}`;
}

function mediaRevision(asset) {
  return JSON.stringify([asset.mediaRevision || asset.id, asset.byteCount, asset.width, asset.height]);
}

async function verifySource(original, signal) {
  const { library, asset, sourceThumbnail } = original;
  const { file, handle } = await openAsset(original, signal);
  try {
    const stat = await handle.stat({ bigint: true });
    const stamp = sourceStamp(stat);
    if ((library.publicLibrary.kind === 'local' &&
        asset.mediaRevision !== [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino].join(':')) ||
        (library.publicLibrary.kind === 'eagle' &&
        asset.mediaRevision !== thumbnailSourceRevision(stamp, sourceThumbnail?.stamp))) {
      throw new Error('原件已变化，请重新打开素材后再保存。');
    }
    return { file, stamp };
  } finally { await handle.close(); }
}

async function saveImageCopy(bytes, target, roots) {
  const destination = await validateExportTarget(target, roots, '请选择素材库以外的位置保存图片。');
  const staging = await fs.mkdtemp(path.join(path.dirname(destination), '.jiancang-image-'));
  try {
    const file = path.join(staging, 'image');
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    await fs.copyFile(file, destination, constants.COPYFILE_EXCL);
  } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
}

class EditService {
  constructor(library) {
    this.library = library;
    this.upload = null;
    this.closed = false;
  }

  static handles(name) { return commands.has(name); }

  async close() {
    this.closed = true;
    if (this.upload?.saving) await this.upload.saving.catch(() => {});
    this.discard(this.upload?.token);
  }

  current(job) {
    const original = this.library.original(job.id, job.registrationId);
    const { asset, library } = original;
    if (asset.trashed || asset.kind !== (job.kind === 'frame' ? 'video' : 'image') ||
        mediaRevision(asset) !== job.contentRevision ||
        (job.root && (job.root !== library.root || job.identity !== library.identity ||
          job.libraryId !== library.publicLibrary.libraryId))) {
      throw new Error('素材已变化，请重新打开素材后再保存。');
    }
    if (job.kind === 'image' && (!editableExtensions.has(asset.extension) || asset.byteCount > maxImageBytes)) {
      throw new Error('这张图的格式或大小超出图片工具支持范围。');
    }
    if (job.mode !== 'export') {
      const entry = this.library.writable(job.registrationId);
      if ((job.mode === 'replace' && (entry.kind !== 'local' || job.revision !== asset.mediaRevision ||
            (asset.extension === 'jpg' ? 'jpeg' : asset.extension) !== job.format)) ||
          (job.mode === 'sync-copy' && (entry.kind !== 'jiancang' || entry.libraryId !== job.expectedLibraryId))) {
        throw new Error('素材或写入权限已变化，请重新打开图片工具。');
      }
    }
    return original;
  }

  async begin(kind, input) {
    if (this.upload) throw new Error('正在准备另一项编辑导出。');
    const { id, registrationId, contentRevision, revision, expectedLibraryId, width, height, byteCount, seconds } = input ?? {};
    const mode = kind === 'frame' ? 'export' : input?.mode;
    const format = kind === 'frame' ? 'png' : input?.format;
    if (!['image', 'frame'].includes(kind) || !['export', 'replace', 'sync-copy'].includes(mode) ||
        !outputFormats.has(format) || typeof registrationId !== 'string' || typeof contentRevision !== 'string' ||
        !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
        width > 16_384 || height > 16_384 || (kind === 'image' && width * height > 40_000_000) ||
        !Number.isSafeInteger(byteCount) || byteCount < 24 || byteCount > (kind === 'frame' ? maxFrameBytes : maxImageBytes)) {
      throw new Error('生成的图片格式、尺寸或大小不正确。');
    }
    const job = { token: randomUUID(), kind, id, registrationId, contentRevision, revision, expectedLibraryId,
      mode, format, width, height, byteCount, seconds, size: 0, chunks: [] };
    const original = this.current(job);
    const { library } = original;
    job.root = library.root;
    job.identity = library.identity;
    job.libraryId = library.publicLibrary.libraryId;
    this.upload = job;
    this.keepAlive(job);
    try {
      job.source = await verifySource(original, this.library.shutdown.signal);
      if (this.closed || this.upload !== job) throw new Error('图片保存已取消。');
      return { token: job.token };
    } catch (error) {
      this.discard(job.token);
      throw error;
    }
  }

  keepAlive(job) {
    clearTimeout(job.expiry);
    job.expiry = setTimeout(() => this.discard(job.token), uploadLifetime);
    job.expiry.unref();
  }

  discard(token) {
    if (this.upload?.token === token && !this.upload?.saving) {
      clearTimeout(this.upload?.expiry);
      this.upload = null;
    }
    return { ok: true };
  }

  ready(token) {
    const job = this.upload;
    if (!job?.source || job.token !== token || job.saving) throw new Error('导出准备已过期，请重新生成图片。');
    return job;
  }

  append(token, data) {
    const job = this.ready(token);
    if (typeof data !== 'string' || data.length < 4 || data.length > maxChunkBytes * 4 / 3 ||
        data.length % 4 !== 0 || job.chunks.length >= 256) throw new Error('无法读取生成的图片数据。');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.toString('base64') !== data || job.size + bytes.length > job.byteCount) {
      throw new Error('无法读取生成的图片数据。');
    }
    job.chunks.push(bytes);
    job.size += bytes.length;
    this.keepAlive(job);
    return { ok: true };
  }

  complete(token) {
    const job = this.ready(token);
    if (job.size !== job.byteCount) throw new Error('生成的图片还未传输完毕，请重试。');
    return job;
  }

  destination(token) {
    const job = this.complete(token);
    const { asset } = this.current(job);
    if (job.mode !== 'export') return null;
    const extension = extensionFor(job.format);
    const time = job.kind === 'frame' && Number.isFinite(job.seconds) && job.seconds >= 0
      ? ` - ${job.seconds.toFixed(3)}秒` : '';
    const label = job.kind === 'frame' ? '视频帧' : '编辑';
    return { defaultName: exportFilename(`${asset.name}${time} - ${label}`, extension), extension };
  }

  async commit(job, filename) {
    const signal = this.library.shutdown.signal;
    const original = this.current(job);
    const source = await verifySource(original, signal);
    if (source.stamp !== job.source.stamp || source.file !== job.source.file) {
      throw new Error('原件已变化，请重新打开素材后再保存。');
    }
    signal.throwIfAborted();
    const bytes = Buffer.concat(job.chunks, job.size);
    job.chunks = [];
    if (job.kind === 'image') validateEditedImage({ ...job, bytes });
    if (job.mode === 'export') {
      const target = outputPath(filename, extensionFor(job.format));
      const roots = await Promise.all(this.library.protectedRoots().map(root => fs.realpath(root).catch(() => root)));
      signal.throwIfAborted();
      if (job.kind === 'frame') {
        const [width, height] = imageDimensions(bytes);
        if (width !== job.width || height !== job.height) throw new Error('生成的视频帧尺寸不正确。');
        await exportCapturedFrame(bytes, target, roots);
        return { ok: true, message: '已导出当前帧。' };
      }
      await saveImageCopy(bytes, target, roots);
      return { ok: true };
    }
    if (filename != null) throw new Error('此操作不使用外部保存位置。');
    const entry = this.library.writable(job.registrationId);
    const result = job.mode === 'replace'
      ? await replaceLocalPicture(entry.root, { id: job.id, width: job.width, height: job.height, format: job.format,
        revision: job.revision, bytes, expectedLibraryId: entry.libraryId })
      : await this.library.syncWriter.upload(entry, { jobId: randomUUID(), editedSourceId: job.id,
        filename: exportFilename(original.asset.name, extensionFor(job.format)), kind: 'image', bytes,
        width: job.width, height: job.height });
    await this.library.refreshEntry(entry);
    return { ok: true, ...result, state: this.library.state(), ...(job.mode === 'sync-copy' && {
      message: result.pending ? '同步副本已加入本机待提交队列。' : '已将编辑副本写入同步库。',
    }) };
  }

  async save(token, filename) {
    const job = this.complete(token);
    clearTimeout(job.expiry);
    job.saving = this.library.serial(() => this.commit(job, filename));
    try { return await job.saving; }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('已有同名文件，请换一个保存名称。');
      if (error.code === 'ENOSPC') throw new Error('磁盘空间不足，请释放空间后再试。');
      throw error;
    } finally {
      job.saving = null;
      this.discard(token);
    }
  }

  command(name, args = []) {
    if (this.closed) throw new Error('见藏正在退出。');
    switch (name) {
      case 'edit:upload-begin': return this.begin(...args);
      case 'edit:upload-append': return this.append(...args);
      case 'edit:upload-discard': return this.discard(args[0]);
      case 'edit:destination': return this.destination(args[0]);
      case 'edit:save': return this.save(...args);
      default: throw new Error('此图片保存操作不可用。');
    }
  }
}

module.exports = { EditService };
