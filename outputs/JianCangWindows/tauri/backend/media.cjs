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
const { toolInputProtocol } = require('../../video-trim.cjs');

const images = new Map(Object.entries({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon' }));
const movies = new Map(Object.entries({ mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', ogv: 'video/ogg' }));
const audio = new Map(Object.entries({ mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
  wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg',
  wma: 'audio/x-ms-wma', aif: 'audio/aiff', aiff: 'audio/aiff', ape: 'audio/ape' }));
const heifExtensions = new Set(['heic', 'heif']);
const heifBrands = new Set(['heic', 'heix', 'heim', 'heis', 'mif1']);
const posterVideoExtensions = new Set([...movies.keys(), 'mkv', 'avi', 'mts', 'm2ts', 'ts', 'wmv', 'flv', 'mpeg', 'mpg', '3gp']);
const supportedThumbnailInputs = new Set([...images.keys(), ...posterVideoExtensions, ...heifExtensions]);
const roles = new Set(['thumbnail', 'original', 'video', 'live-motion', 'board-image', 'palette-image', 'edit-image', 'pdf-original', 'text-preview']);
const imageRoles = new Set(['thumbnail', 'original', 'board-image', 'palette-image']);
const imageThumbnailLimit = 64 * 1024 ** 2;
const videoThumbnailLimit = 32 * 1024 ** 3;
const legacyVideoStagingLimit = 512 * 1024 ** 2;
const thumbnailBytes = 2 * 1024 ** 2;
const importThumbnailRequests = 64;
const importThumbnailCacheEntries = 32;
const heifDemuxers = 'mov,mp4,m4a,3gp,3g2,mj2';
const thumbnailDemuxers = `image2,${heifDemuxers},matroska,webm,ogg,avi,mpegts,jpeg_pipe,png_pipe,webp_pipe,bmp_pipe,gif,mjpeg`;
const waveformDemuxers = `aac,${heifDemuxers},mp3,wav,flac,ogg,aiff,asf,ape`;
const waveformByteLimit = 256 * 1024 ** 2;
const waveformDurationLimit = 2 * 60 * 60;
const waveformType = 'image/png';
const waveformSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
const videoThumbnailDemuxers = `${heifDemuxers},matroska,webm,ogg,avi,mpegts,mpeg,mpegvideo,m4v,asf,flv`;
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
  if (asset.kind === 'audio') {
    return Boolean(ffmpeg && asset.available && audio.has(asset.extension) &&
      asset.byteCount > 0 && asset.byteCount <= waveformByteLimit &&
      !(asset.duration > waveformDurationLimit));
  }
  // Serve ICO directly so the browser can select an embedded size and preserve transparency.
  return Boolean(ffmpeg && asset.available && asset.extension !== 'ico' &&
    ['image', 'video'].includes(asset.kind) && supportedThumbnailInputs.has(asset.extension) &&
    asset.byteCount > 0 && asset.byteCount <= (asset.kind === 'video' ? videoThumbnailLimit : imageThumbnailLimit));
}

async function audioWaveform(ffmpeg, file, signal) {
  // Limit decoded audio before the waveform filter accumulates samples.
  const bytes = await boundedToolOutput(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-protocol_whitelist', 'file', '-format_whitelist', waveformDemuxers, ...toolInputLimits,
    '-t', String(waveformDurationLimit), '-i', file, '-filter_complex_threads', '1',
    '-filter_complex', '[0:a:0]aformat=channel_layouts=mono,aresample=2000,showwavespic=s=640x320:colors=0x7d8086:scale=sqrt,format=rgba[wave]',
    '-map', '[wave]', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-threads', '1', 'pipe:1'], signal, thumbnailBytes);
  if (!bytes.subarray(0, waveformSignature.length).equals(waveformSignature)) {
    throw new Error('无法生成音频波形。');
  }
  return bytes;
}

function boundedToolOutput(tool, args, signal, limit, stdin = 'ignore') {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, {
      stdio: [stdin, 'pipe', 'ignore'], signal, windowsHide: true,
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

async function thumbnailFrame(ffmpeg, file, signal, edge, heif, stdin = 'ignore') {
  const hasProfile = heif && await inspectSingleHeif(ffmpeg, file, signal);
  const scale = heif ? `scale='min(iw,${edge})':'min(ih,${edge})':force_original_aspect_ratio=decrease`
    : 'scale=640:640:force_original_aspect_ratio=decrease';
  const bytes = await boundedToolOutput(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-protocol_whitelist', stdin === 'ignore' ? 'file' : 'fd',
    '-format_whitelist', thumbnailDemuxers, ...toolInputLimits, '-i', file, '-map', '0:v:0', '-an', '-vf', scale,
    '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-threads', '1', 'pipe:1'], signal, thumbnailBytes, stdin);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || (hasProfile && !bytes.includes('ICC_PROFILE\x00'))) {
    throw new Error('预览格式无效。');
  }
  return bytes;
}

async function sampleVideoFrame(ffmpeg, input, signal, seconds, skipBlack, stdin = 'ignore') {
  const seek = seconds > 0 ? ['-ss', seconds.toFixed(3)] : [];
  const scale = 'scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2';
  const filter = skipBlack
    ? `${scale},format=yuv420p,blackframe=amount=0:threshold=24,metadata=mode=select:key=lavfi.blackframe.pblack:function=less:value=98`
    : scale;
  const bytes = await boundedToolOutput(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-protocol_whitelist', stdin === 'ignore' ? 'file' : 'fd', '-format_whitelist', videoThumbnailDemuxers,
    ...toolInputLimits, '-filter_threads', '1', ...seek, '-t', '2', '-i', input, '-map', '0:V:0', '-an', '-vf', filter,
    '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-threads', '1', 'pipe:1'], signal, thumbnailBytes, stdin);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('视频封面格式无效。');
  return bytes;
}

async function choosePosterFrame(duration, sample, signal, fromStart = false) {
  const known = Number.isFinite(duration) && duration > 0;
  const first = known ? Math.min(8, duration * .12) : fromStart ? 0 : 2;
  const second = known ? Math.min(24, duration * .35) : fromStart ? 2 : 8;
  const positions = second > first + .75 ? [first, second] : [first];
  for (const seconds of positions) {
    try { return await sample(seconds, true); }
    catch { signal.throwIfAborted(); }
  }
  return sample(0, false);
}

async function videoPoster(ffmpeg, original, shutdown) {
  const { library, asset, file, candidates } = original;
  const signal = AbortSignal.any([shutdown, AbortSignal.timeout(18_000)]);
  if (await toolInputProtocol(ffmpeg) === 'fd') {
    return choosePosterFrame(asset.duration, async (seconds, skipBlack) => {
      // Like video metadata and playback, resolve only a contained, validated
      // original. The inherited handle also avoids staging large videos.
      const { handle } = await openAsset(original, signal);
      try {
        const before = await handle.stat({ bigint: true });
        const bytes = await sampleVideoFrame(ffmpeg, 'fd:', signal, seconds, skipBlack, handle.fd);
        const after = await handle.stat({ bigint: true });
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
          throw new Error('原件已变化，请重新读取。');
        }
        return bytes;
      } finally { await handle.close(); }
    }, signal);
  }
  // Keep old FFmpeg versions working within their original staging limit.
  if (asset.byteCount > legacyVideoStagingLimit) return null;
  const decode = input => choosePosterFrame(asset.duration,
    (seconds, skipBlack) => sampleVideoFrame(ffmpeg, input, signal, seconds, skipBlack), signal);
  const folder = fileDirectory(library);
  return folder ? withReadOnlyThumbnailFile(folder, file, asset.byteCount, signal, decode)
    : withVerifiedThumbnailFile(library.root, candidates || [file], asset, signal, decode);
}

function pendingFileStamp(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function pendingFileThumbnail(source, ffmpeg, signal, cache) {
  const extension = path.extname(source.name).slice(1).toLowerCase();
  const video = posterVideoExtensions.has(extension);
  const heif = heifExtensions.has(extension);
  if (!ffmpeg || (!video && !heif && (!images.has(extension) || extension === 'ico'))) return null;
  const handle = await source.open();
  try {
    signal.throwIfAborted();
    const stat = await handle.stat({ bigint: true });
    if (stat.size <= 0n || stat.size > BigInt(video ? videoThumbnailLimit : imageThumbnailLimit)) return null;
    const stamp = pendingFileStamp(stat);
    const cacheKey = source.assetId + ':' + stamp;
    const unchanged = async () => pendingFileStamp(await handle.stat({ bigint: true })) === stamp &&
      pendingFileStamp(await fs.lstat(source.path, { bigint: true })) === stamp;
    const cached = cache.get(cacheKey);
    if (cached) return await unchanged() ? cached : null;
    const useHandle = !heif && await toolInputProtocol(ffmpeg) === 'fd';
    if (video && !useHandle) return null;
    let bytes;
    if (video) {
      bytes = await choosePosterFrame(null, async (seconds, skipBlack) => {
        // FFmpeg advances the inherited handle's offset. Each seek starts with
        // its own fresh, independently validated descriptor.
        const sample = await source.open();
        try {
          if (pendingFileStamp(await sample.stat({ bigint: true })) !== stamp) throw new Error('源文件已变化。');
          const frame = await sampleVideoFrame(ffmpeg, 'fd:', signal, seconds, skipBlack, sample.fd);
          if (pendingFileStamp(await sample.stat({ bigint: true })) !== stamp) throw new Error('源文件已变化。');
          return frame;
        } finally { await sample.close(); }
      }, signal, true);
    } else if (useHandle) {
      bytes = await thumbnailFrame(ffmpeg, 'fd:', signal, 640, false, handle.fd);
    } else {
      bytes = await withReadOnlyThumbnailFile(source.root, source.path, Number(stat.size), signal,
        input => thumbnailFrame(ffmpeg, input, signal, 640, heif));
    }
    signal.throwIfAborted();
    if (!(await unchanged())) return null;
    if (cache.size >= importThumbnailCacheEntries) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, bytes);
    return bytes;
  } finally { await handle.close(); }
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
  const importCache = new Map();
  const importLanes = [Promise.resolve(), Promise.resolve()];
  let importLane = 0;
  let importRequests = 0;

  async function generateThumbnail(original, edge = 640, still) {
    const { library, asset, file, candidates } = original;
    if (!file || !service.ffmpeg || (!still && !canGenerateThumbnail(asset, service.ffmpeg))) return null;
    await clearing?.catch(() => {});
    const heif = Boolean(still) || heifExtensions.has(asset.extension);
    const waveform = asset.kind === 'audio';
    const rendition = waveform ? 'tauri-audio-waveform-640-v1' : heif ? `tauri-heif-jpeg-${edge}-v1`
      : asset.kind === 'video' ? 'tauri-video-jpeg-640-v2' : 'tauri-jpeg-640-v1';
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
      const decode = waveform ? input => audioWaveform(service.ffmpeg, input, signal)
        : input => thumbnailFrame(service.ffmpeg, input, signal, edge, heif);
      const folder = fileDirectory(library);
      const bytes = stored ?? (asset.kind === 'video' ? await videoPoster(service.ffmpeg, original, signal)
        : still ? await decodeHeifStill(still, signal, decode)
        : folder ? await withReadOnlyThumbnailFile(folder, file, asset.byteCount, signal, decode)
        : await withVerifiedThumbnailFile(library.root, candidates || [file], asset, signal, decode));
      if (!bytes) return null;
      if (started === generation) {
        if (cache.size >= 64) cache.delete(cache.keys().next().value);
        cache.set(key, bytes);
        if (!stored) await disk.set(key, { bytes, type: waveform ? waveformType : 'image/jpeg' });
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
      if (asset.kind === 'audio') {
        const waveform = await generateThumbnail(original);
        signal.throwIfAborted();
        if (waveform) { sendBytes(request, response, waveform, waveformType); return; }
      }
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
      if (asset.kind !== 'audio' && !heifExtensions.has(asset.extension)) {
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
  serve.importThumbnail = async (request, response, registrationId, taskId, requestSignal) => {
    const unavailable = () => new Error('这份素材暂时没有可用的导入预览。');
    if (importRequests >= importThumbnailRequests) throw unavailable();
    const lane = importLane;
    importLane = (importLane + 1) % importLanes.length;
    importRequests++;
    const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(12_000)]);
    const work = importLanes[lane].then(async () => {
      signal.throwIfAborted();
      const source = service.importThumbnailSource(registrationId, taskId);
      if (!source) throw unavailable();
      if (source.original) {
        const { library, asset, sourceThumbnail } = source.original;
        if (asset.kind !== 'video' && asset.kind !== 'image') throw unavailable();
        const type = sourceThumbnail && images.get(sourceThumbnail.extension);
        if (type && sourceThumbnail.byteCount <= thumbnailBytes) {
          await checkFolder(library);
          const handle = await openContainedFile(path.join(library.root, 'images'),
            sourceThumbnail.file, sourceThumbnail.byteCount).catch(() => null);
          if (handle) {
            try {
              signal.throwIfAborted();
              if (service.importThumbnailSource(registrationId, taskId)?.assetId !== source.assetId) throw unavailable();
              await sendFile(request, response, handle, sourceThumbnail.byteCount, type, signal);
              return;
            } finally { await handle.close(); }
          }
        }
      }
      const bytes = source.original ? await generateThumbnail(source.original)
        : await pendingFileThumbnail(source, service.ffmpeg, signal, importCache);
      signal.throwIfAborted();
      if (!bytes || service.importThumbnailSource(registrationId, taskId)?.assetId !== source.assetId) throw unavailable();
      sendBytes(request, response, bytes, 'image/jpeg');
    });
    importLanes[lane] = work.catch(() => {});
    try { await work; }
    catch { throw unavailable(); }
    finally { importRequests--; }
  };
  serve.thumbnailStatus = disk.status;
  serve.clearThumbnails = () => {
    if (clearing) return clearing;
    generation++;
    cache.clear();
    importCache.clear();
    clearing = disk.clear().finally(() => { clearing = null; });
    return clearing;
  };
  return serve;
}

module.exports = { findFfmpeg, openAsset, exportAsset, canGenerateThumbnail, mediaHandler };
