'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { openContainedFile, openVerifiedOriginal, exportVerified, exportReadOnly, parseByteRange,
  withVerifiedThumbnailFile, withReadOnlyThumbnailFile } = require('../../original-file.cjs');
const { folderIdentity } = require('../../library-watcher.cjs');
const { readLivePhotoPart } = require('../../live-photo.cjs');
const { isTextPreview, readTextPreview } = require('../../text-preview.cjs');
const { createThumbnailCache } = require('../../thumbnail-cache.cjs');

const images = new Map(Object.entries({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon' }));
const movies = new Map(Object.entries({ mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', ogv: 'video/ogg' }));
const audio = new Map(Object.entries({ mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
  wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg' }));
const heifExtensions = new Set(['heic', 'heif']);
const heifBrands = new Set(['heic', 'heix', 'heim', 'heis', 'mif1']);
const supportedThumbnailInputs = new Set([...images.keys(), ...movies.keys(), ...heifExtensions, 'mkv', 'avi', 'mts', 'm2ts', 'ts']);
const roles = new Set(['thumbnail', 'original', 'video', 'live-motion', 'board-image', 'palette-image', 'edit-image', 'pdf-original', 'text-preview']);
const imageRoles = new Set(['thumbnail', 'original', 'board-image', 'palette-image']);
const imageThumbnailLimit = 64 * 1024 ** 2;
const videoThumbnailLimit = 512 * 1024 ** 2;
const thumbnailBytes = 2 * 1024 ** 2;
const heifDemuxers = 'mov,mp4,m4a,3gp,3g2,mj2';
const thumbnailDemuxers = `image2,${heifDemuxers},matroska,webm,ogg,avi,mpegts,jpeg_pipe,png_pipe,webp_pipe,bmp_pipe,gif,mjpeg`;
const toolInputLimits = ['-max_alloc', '134217728', '-probesize', '16000000', '-max_streams', '64', '-threads', '1'];

function fileDirectory(library) {
  if (library.publicLibrary.kind === 'eagle') return path.join(library.root, 'images');
  if (library.publicLibrary.kind === 'local') return path.join(library.root, 'originals');
  return null;
}

async function checkFolder(library) {
  const current = await fs.lstat(library.root, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink() || folderIdentity(current) !== library.identity) {
    throw new Error('素材库位置已变化，请重新读取。');
  }
}

async function openAsset({ library, asset, file, candidates }, signal) {
  if (!file) throw new Error('原件暂不可用。');
  signal?.throwIfAborted();
  await checkFolder(library);
  const directory = fileDirectory(library);
  if (directory) return { file, handle: await openContainedFile(directory, file, asset.byteCount) };
  return openVerifiedOriginal(library.root, candidates || [file], asset, signal);
}

async function exportAsset({ library, asset, file, candidates }, target, protectedRoots) {
  await checkFolder(library);
  const directory = fileDirectory(library);
  if (directory) return exportReadOnly(directory, file, asset.byteCount, target, protectedRoots);
  return exportVerified(library.root, candidates || file, asset, target, protectedRoots);
}

async function findFfmpeg() {
  const platformFile = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const vendor = path.resolve(__dirname, '../../vendor/media');
  for (const candidate of [process.env.JIANCANG_FFMPEG_PATH, path.join(vendor, 'bin', platformFile), path.join(vendor, platformFile)]) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    const entry = await fs.lstat(candidate).catch(() => null);
    if (entry?.isFile() && !entry.isSymbolicLink()) return candidate;
  }
  return null;
}

function canGenerateThumbnail(asset, ffmpeg) {
  // Serve ICO directly so the browser can select an embedded size and preserve transparency.
  return Boolean(ffmpeg && asset.available && asset.extension !== 'ico' &&
    ['image', 'video'].includes(asset.kind) && supportedThumbnailInputs.has(asset.extension) &&
    asset.byteCount > 0 && asset.byteCount <= (asset.kind === 'video' ? videoThumbnailLimit : imageThumbnailLimit));
}

function boundedToolOutput(tool, args, signal, limit) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, {
      stdio: ['ignore', 'pipe', 'ignore'], signal, windowsHide: true,
    });
    let count = 0;
    const chunks = [];
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on('data', chunk => {
      count += chunk.length;
      if (count > limit) child.kill();
      else chunks.push(chunk);
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 || count < 3 || count > limit) return reject(new Error('无法生成此素材的预览。'));
      resolve(Buffer.concat(chunks, count));
    });
  });
}

async function inspectSingleHeif(ffmpeg, file, signal) {
  const ffprobe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const executable = await fs.lstat(ffprobe);
  if (!executable.isFile() || executable.isSymbolicLink()) throw new Error('无法检查 HEIC 图片。');
  const output = await boundedToolOutput(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', heifDemuxers,
    ...toolInputLimits, '-show_streams', '-show_format', '-show_entries',
    'format=nb_streams,nb_stream_groups:format_tags=major_brand:stream=codec_name,width,height,nb_frames,color_transfer:stream_disposition=dependent',
    '-of', 'json', file], signal, 32 * 1024);
  const { streams, format } = JSON.parse(output.toString('utf8'));
  const image = streams?.[0];
  // The MOV demuxer exposes a HEIF tile grid as separate HEVC streams. Its
  // first stream is only a tile, so decoding it would show the wrong image.
  if (format?.nb_streams !== 1 || format.nb_stream_groups !== 0 || !heifBrands.has(format.tags?.major_brand) ||
      streams?.length !== 1 || image?.codec_name !== 'hevc' || image.disposition?.dependent !== 0 || image.nb_frames !== '1' ||
      !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0 ||
      image.width * image.height > 32 * 1024 ** 2 || ['smpte2084', 'arib-std-b67'].includes(image.color_transfer)) {
    throw new Error('此 HEIC 图片暂不支持预览。');
  }
  return image.side_data_list?.some(data => data.side_data_type === 'ICC Profile');
}

async function thumbnailFrame(ffmpeg, file, signal, edge, heif) {
  const hasProfile = heif && await inspectSingleHeif(ffmpeg, file, signal);
  const scale = heif ? `scale='min(iw,${edge})':'min(ih,${edge})':force_original_aspect_ratio=decrease`
    : 'scale=640:640:force_original_aspect_ratio=decrease';
  const bytes = await boundedToolOutput(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file',
    '-format_whitelist', thumbnailDemuxers, ...toolInputLimits, '-i', file, '-map', '0:v:0', '-an', '-vf', scale,
    '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-threads', '1', 'pipe:1'], signal, thumbnailBytes);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || (hasProfile && !bytes.includes('ICC_PROFILE\x00'))) {
    throw new Error('预览格式无效。');
  }
  return bytes;
}

async function decodeHeifStill(bytes, signal, decode) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-thumbnail-'));
  try {
    const file = path.join(directory, 'still.heic');
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600, signal });
    return await decode(file);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

function writeMediaHead(request, response, type, size, extra = {}) {
  const range = parseByteRange(request.headers.range, size);
  if (range === false) {
    response.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' });
    response.end();
    return false;
  }
  const headers = { 'Content-Type': type, 'Content-Length': range ? range.end - range.start + 1 : size,
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra };
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === 'HEAD' || size === 0) {
    response.end();
    return false;
  }
  return range || { start: 0, end: size - 1 };
}

function sendBytes(request, response, bytes, type, extra) {
  const range = writeMediaHead(request, response, type, bytes.length, extra);
  if (range) response.end(bytes.subarray(range.start, range.end + 1));
}

async function sendFile(request, response, handle, size, type, signal, offset = 0, extra) {
  const range = writeMediaHead(request, response, type, size, extra);
  if (!range) return;
  const stream = handle.createReadStream({ start: offset + range.start, end: offset + range.end, autoClose: false });
  await pipeline(stream, response, { signal });
}

function mediaHandler(service) {
  const cache = new Map();
  const jobs = new Map();
  const disk = createThumbnailCache(path.join(service.profile, 'thumbnail-cache-v1'), { maxEntryBytes: thumbnailBytes + 1 });
  let decodeQueue = Promise.resolve();
  let pendingStillBytes = 0;
  let generation = 0;
  let clearing = null;

  async function generateThumbnail(original, edge = 640, still) {
    const { library, asset, file, candidates } = original;
    if (!file || !service.ffmpeg || (!still && !canGenerateThumbnail(asset, service.ffmpeg))) return null;
    await clearing?.catch(() => {});
    const heif = Boolean(still) || heifExtensions.has(asset.extension);
    const rendition = heif ? `tauri-heif-jpeg-${edge}-v1` : 'tauri-jpeg-640-v1';
    const key = JSON.stringify([rendition, library.registrationId, library.root, library.identity,
      library.publicLibrary.libraryId, asset.id, asset.mediaRevision ?? asset.id, asset.extension, asset.byteCount]);
    if (cache.has(key)) return cache.get(key);
    if (jobs.has(key)) return jobs.get(key);
    const stillSize = still?.length ?? 0;
    if (jobs.size >= 32 || pendingStillBytes + stillSize > imageThumbnailLimit) return null;
    pendingStillBytes += stillSize;
    const started = generation;
    const job = decodeQueue.then(async () => {
      const signal = service.shutdown.signal;
      signal.throwIfAborted();
      await checkFolder(library);
      const stored = (await disk.get(key))?.bytes;
      const decode = input => thumbnailFrame(service.ffmpeg, input, signal, edge, heif);
      const folder = fileDirectory(library);
      const bytes = stored ?? (still ? await decodeHeifStill(still, signal, decode)
        : folder ? await withReadOnlyThumbnailFile(folder, file, asset.byteCount, signal, decode)
        : await withVerifiedThumbnailFile(library.root, candidates || [file], asset, signal, decode));
      if (started === generation) {
        if (cache.size >= 64) cache.delete(cache.keys().next().value);
        cache.set(key, bytes);
        if (!stored) await disk.set(key, { bytes, type: 'image/jpeg' });
      }
      return bytes;
    }).catch(() => null).finally(() => {
      pendingStillBytes -= stillSize;
      jobs.delete(key);
    });
    jobs.set(key, job);
    decodeQueue = job;
    return job;
  }

  const serve = async (request, response, role, registrationId, id, signal) => {
    if (!roles.has(role)) throw new Error('该预览类型尚不支持。');
    const original = service.asset(id, registrationId);
    const { asset, library, sourceThumbnail } = original;
    if (role === 'text-preview') {
      if (!isTextPreview(asset)) throw new Error('此文件类型不支持文字预览。');
      const preview = await readTextPreview(original, async input => (await openAsset(input, signal)).handle, signal);
      sendBytes(request, response, Buffer.from(JSON.stringify(preview)), 'application/json; charset=utf-8');
      return;
    }
    if (role === 'thumbnail') {
      const sourceType = sourceThumbnail && images.get(sourceThumbnail.extension);
      if (sourceType) {
        await checkFolder(library);
        const thumbnail = await openContainedFile(path.join(library.root, 'images'), sourceThumbnail.file, sourceThumbnail.byteCount).catch(() => null);
        if (thumbnail) {
          try { await sendFile(request, response, thumbnail, sourceThumbnail.byteCount, sourceType, signal); }
          finally { await thumbnail.close(); }
          return;
        }
      }
      if (!heifExtensions.has(asset.extension)) {
        const generated = await generateThumbnail(original);
        signal.throwIfAborted();
        if (generated) { sendBytes(request, response, generated, 'image/jpeg'); return; }
      }
    }
    if (imageRoles.has(role) && heifExtensions.has(asset.extension)) {
      const bytes = await generateThumbnail(original, role === 'thumbnail' ? 640 : 1600);
      signal.throwIfAborted();
      if (!bytes) throw new Error('此 HEIC 图片暂不支持预览。');
      sendBytes(request, response, bytes, 'image/jpeg');
      return;
    }
    if (asset.extension === 'livp' && (role === 'live-motion' || ['thumbnail', 'original', 'board-image', 'palette-image'].includes(role))) {
      const { handle } = await openAsset(original, signal);
      try {
        const motion = role === 'live-motion';
        const resource = await readLivePhotoPart(handle, asset.byteCount, motion ? 'movie' : 'still', signal);
        if (!motion && heifExtensions.has(resource.extension)) {
          const bytes = await generateThumbnail(original, role === 'thumbnail' ? 640 : 1600, resource.bytes);
          signal.throwIfAborted();
          if (!bytes) throw new Error('此实况照片的 HEIC 封面暂不支持预览。');
          sendBytes(request, response, bytes, 'image/jpeg');
          return;
        }
        const type = motion ? 'video/quicktime' : images.get(resource.extension);
        if (!type) throw new Error('此实况照片的封面格式暂不支持预览。');
        if (resource.bytes) sendBytes(request, response, resource.bytes, type);
        else await sendFile(request, response, handle, resource.size, type, signal, resource.offset);
      } finally { await handle.close(); }
      return;
    }
    const image = images.get(asset.extension);
    const type = role === 'pdf-original' && asset.kind === 'pdf' && asset.extension === 'pdf' ? 'application/pdf'
      : role === 'video' && asset.kind === 'video' ? movies.get(asset.extension)
      : role === 'original' ? image || movies.get(asset.extension) || audio.get(asset.extension)
      : ['thumbnail', 'board-image', 'palette-image', 'edit-image'].includes(role) ? image : null;
    if (!type) throw new Error('该素材暂不支持预览。');
    const { handle } = await openAsset(original, signal);
    try {
      const extra = type === 'application/pdf' ? { 'Content-Security-Policy': "sandbox; default-src 'none'", 'Content-Disposition': 'attachment' } : undefined;
      await sendFile(request, response, handle, asset.byteCount, type, signal, 0, extra);
    } finally { await handle.close(); }
  };
  serve.thumbnailStatus = disk.status;
  serve.clearThumbnails = () => {
    if (clearing) return clearing;
    generation++;
    cache.clear();
    clearing = disk.clear().finally(() => { clearing = null; });
    return clearing;
  };
  return serve;
}

module.exports = { findFfmpeg, openAsset, exportAsset, canGenerateThumbnail, mediaHandler };
