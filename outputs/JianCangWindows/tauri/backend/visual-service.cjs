'use strict';

const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const { VisualIndex } = require('../../visual-index.cjs');
const { readLivePhotoPart } = require('../../live-photo.cjs');
const { openContainedFile } = require('../../original-file.cjs');
const { folderIdentity } = require('../../library-watcher.cjs');
const { sourceStamp } = require('../../thumbnail-cache.cjs');
const { openAsset } = require('./media.cjs');

const run = promisify(execFile);
const maxRasterSourceBytes = 64 * 1024 ** 2;
const rasterFormats = 'image2,mov,heif,jpeg_pipe,png_pipe,webp_pipe,webp_anim,bmp_pipe,tiff_pipe,gif,mjpeg';
const hexColor = /^#[0-9a-f]{6}$/i;

function assetRevision(asset) {
  return JSON.stringify([asset.mediaRevision || asset.id, asset.byteCount, asset.width, asset.height]);
}

function isVisualAsset(asset) {
  return !asset.trashed && (asset.kind === 'image' || asset.extension === 'livp');
}

async function writeRasterInput(handle, part, folder, stem, signal) {
  if (!(part.size > 0) || part.size > maxRasterSourceBytes) throw new Error('图片原件或封面过大。');
  const extension = /^[a-z0-9]{1,8}$/i.test(part.extension) ? part.extension : 'media';
  const input = path.join(folder, `${stem}.${extension}`);
  if (part.bytes) {
    await fs.writeFile(input, part.bytes, { signal, flag: 'wx', mode: 0o600 });
  } else {
    const start = part.offset;
    const bytes = handle.createReadStream({ start, end: start + part.size - 1, autoClose: false });
    await pipeline(bytes, createWriteStream(input, { flags: 'wx', mode: 0o600 }), { signal });
    if ((await fs.stat(input)).size !== part.size) throw new Error('读取期间图片发生变化。');
  }
  return input;
}

async function stageRaster(original, folder, signal) {
  const { asset } = original;
  if (!(asset.byteCount > 0) || asset.byteCount > maxRasterSourceBytes) throw new Error('图片原件过大。');
  const { handle } = await openAsset(original, signal);
  try {
    const part = asset.extension === 'livp'
      ? await readLivePhotoPart(handle, asset.byteCount, 'still', signal)
      : { extension: asset.extension, offset: 0, size: asset.byteCount };
    return await writeRasterInput(handle, part, folder, 'image', signal);
  } finally { await handle.close(); }
}

async function stageThumbnail({ library, sourceThumbnail }, folder, signal) {
  signal.throwIfAborted();
  const root = await fs.lstat(library.root, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink() || folderIdentity(root) !== library.identity) {
    throw new Error('素材库位置已变化，请重新读取。');
  }
  const { file, byteCount, extension, stamp } = sourceThumbnail;
  const handle = await openContainedFile(path.join(library.root, 'images'), file, byteCount);
  try {
    if (sourceStamp(await handle.stat({ bigint: true })) !== stamp) throw new Error('图片封面已变化，请刷新素材库。');
    const input = await writeRasterInput(handle, { offset: 0, size: byteCount, extension }, folder, 'thumbnail', signal);
    if (sourceStamp(await handle.stat({ bigint: true })) !== stamp) throw new Error('图片封面已变化，请刷新素材库。');
    return input;
  } finally { await handle.close(); }
}

class VisualService {
  constructor(library) {
    this.library = library;
  }

  async initialize() {
    const work = path.join(this.library.profile, 'visual-work-v1');
    await fs.mkdir(work, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(work);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('不能打开本机图片分析目录。');
    this.work = work;
    this.index = new VisualIndex({ directory: path.join(this.library.profile, 'visual-index-v1'),
      getImage: (reference, options) => this.image(reference, options) });
    await this.index.initialize();
  }

  async close() { await this.index?.close(); }

  current(reference) {
    if (typeof reference?.registrationId !== 'string' || typeof reference.assetId !== 'string') return null;
    try {
      const original = this.library.asset(reference.assetId, reference.registrationId);
      const { asset, library } = original;
      if (!isVisualAsset(asset) || assetRevision(asset) !== reference.revision) return null;
      return { original, reference: { registrationId: library.registrationId, assetId: asset.id,
        revision: reference.revision, inputState: `tauri-raster-2-${Number(!!original.file)}-${Number(!!original.sourceThumbnail)}`,
        ...(library.publicLibrary.kind === 'jiancang' && { contentHash: asset.id }) } };
    } catch { return null; }
  }

  refs(references, readableOnly = false) {
    if (!Array.isArray(references) || references.length > 10_000) throw new Error('请缩小素材范围后重试。');
    return references.flatMap(input => {
      const current = this.current(input);
      if (!current || readableOnly && !current.original.file && !current.original.sourceThumbnail) return [];
      return [current.reference];
    });
  }

  async image(reference, { ocr = false, side = ocr ? 1400 : 256, signal } = {}) {
    if (!Number.isInteger(side) || side < 1 || side > 1400) throw new Error('图片缩放尺寸无效。');
    const current = this.current(reference);
    if (!current) throw new Error('图片已变化，请重新分析。');
    const ffmpeg = this.library.ffmpeg;
    if (!ffmpeg) throw new Error('缺少本机图片解码组件。');
    const operation = signal ? AbortSignal.any([signal, this.library.shutdown.signal]) : this.library.shutdown.signal;
    operation.throwIfAborted();
    const folder = await fs.mkdtemp(path.join(this.work, '.raster-'));
    try {
      const original = current.original;
      const decode = async input => {
        const { stdout } = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file',
          '-format_whitelist', rasterFormats, '-max_alloc', '134217728', '-probesize', '8000000', '-max_streams', '16',
          '-threads', '1', '-i', input, '-map', '0:v:0', '-an', '-vf',
          `scale='min(iw,${side})':'min(ih,${side})':force_original_aspect_ratio=decrease`,
          '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-threads', '1', 'pipe:1'],
        { windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 ** 2, encoding: 'buffer', signal: operation });
        if (!stdout.length) throw new Error('图片无法解码。');
        return stdout;
      };
      let result;
      if (original.file) {
        try { result = await decode(await stageRaster(original, folder, operation)); }
        catch (error) {
          operation.throwIfAborted();
          if (!original.sourceThumbnail) throw error;
        }
      }
      if (!result && original.sourceThumbnail) result = await decode(await stageThumbnail(original, folder, operation));
      if (!result) throw new Error('图片暂不可用，请取回原件后重试。');
      if (!this.current(reference)) throw new Error('图片已变化，请重新分析。');
      return result;
    } finally { await fs.rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {}); }
  }

  command(name, args) {
    if (name === 'visual:copy-color') {
      if (typeof args[0] !== 'string' || !hexColor.test(args[0])) throw new Error('无效的 HEX 色值。');
      return { ok: true, text: args[0].toUpperCase() };
    }
    if (name === 'visual:copy-palette') return palette(...args);
    if (!this.index) throw new Error('无法读取本机图片索引。');

    switch (name) {
      case 'visual:lookup': return this.index.lookup(this.refs(args[0]), { includeFailures: true });
      case 'visual:start':
        if (!this.library.ffmpeg) throw new Error('缺少本机图片解码组件。');
        return this.index.start(this.refs(args[0], true), { ocr: args[1] === true, retryFailures: args[2] !== false });
      case 'visual:status': return this.index.status();
      case 'visual:cancel': return this.index.cancel(args[0]);
      case 'visual:similar': {
        const seed = this.current(args[0]);
        if (!seed) throw new Error('这张图片已变化，请重新打开素材。');
        return this.index.similar(seed.reference, this.refs(args[1]), { limit: 200, exactOnly: args[2]?.exactOnly === true });
      }
      case 'visual:copy-text': {
        const image = this.current(args[0]);
        if (!image) throw new Error('这张图片已变化，请重新识别。');
        const text = this.index.lookup([image.reference])[0]?.text;
        return text ? { ok: true, text } : { ok: false, message: '没有可复制的识别文字。' };
      }
      default: throw new Error('此图片分析操作不可用。');
    }
  }
}

function palette(colors, format) {
  if (!Array.isArray(colors) || !colors.length || colors.length > 5 ||
      !colors.every(color => typeof color === 'string' && hexColor.test(color))) throw new Error('没有可复制的色值。');
  if (format === 'hex') return { ok: true, text: colors.map(color => color.toUpperCase()).join('\n') };
  if (format !== 'png') throw new Error('色板格式不支持。');
  const { PNG } = require('../../vendor/ocr/node_modules/pngjs');
  const width = colors.length * 128;
  const height = 80;
  const row = Buffer.alloc(width * 4);
  colors.forEach((color, index) => row.fill(Buffer.from(`${color.slice(1)}ff`, 'hex'), index * 512, (index + 1) * 512));
  return { ok: true, png: PNG.sync.write({ width, height, data: Buffer.alloc(row.length * height, row) }).toString('base64') };
}

module.exports = { VisualService };
