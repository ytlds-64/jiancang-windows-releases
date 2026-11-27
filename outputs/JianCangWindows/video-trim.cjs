'use strict';

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateExportTarget } = require('./original-file.cjs');

const maximumSourceBytes = 32 * 1024 ** 3;
const maximumDuration = 24 * 60 * 60;
const maximumSegments = 12;
const probeTimeout = 45_000;
const supportedDemuxers = 'mov,matroska,webm,avi,mpeg,mpegts,mpegvideo,ogg,asf,flv,rm,mxf';
const qualityOptions = {
  small: { vp9: 37, h264: 29, mf: 48, open: .055, audio: '96k' },
  standard: { vp9: 30, h264: 23, mf: 70, open: .092, audio: '128k' },
  high: { vp9: 23, h264: 17, mf: 90, open: .16, audio: '192k' },
};
const resolutions = {
  original: [3840, 2160],
  '1080': [1920, 1080],
  '720': [1280, 720],
  preview: [960, 540],
};
const encoderSupport = new Map();
const probeProtocols = new Map();

function displayError(message, code) {
  return Object.assign(new Error(message), { code });
}

function report(listener, phase, progress) {
  try { listener?.({ phase, progress }); }
  catch { /* Progress observers do not control file publication. */ }
}

function runTool(tool, args, { signal, timeout = probeTimeout, capture = true, onProgress, stdin = 'ignore' } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, {
      stdio: [stdin, 'pipe', 'pipe'],
      cwd: path.dirname(tool),
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let lineBuffer = '';
    let failure;
    let lastProgressLine;

    function stop(error) {
      if (!failure) {
        failure = error;
        child.kill();
      }
    }
    function abort() {
      stop(signal.reason);
    }
    const timer = setTimeout(() => stop(displayError('视频处理超时，请缩小裁切范围或选择较低的分辨率。', 'VIDEO_TIMEOUT')), timeout);
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', () => {
      failure ||= displayError('无法启动视频处理组件，请重新解压见藏。', 'VIDEO_TOOL_UNAVAILABLE');
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (failure) return;
      if (capture) {
        stdout += chunk;
        if (stdout.length > 1024 * 1024) stop(displayError('视频包含过多轨道或索引，无法读取。', 'VIDEO_LIMIT'));
      }
      if (!onProgress) return;
      lineBuffer += chunk;
      if (lineBuffer.length > 64 * 1024) return stop(displayError('无法读取视频导出进度。', 'VIDEO_TOOL_OUTPUT'));
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();
      for (const line of lines) {
        const match = /^out_time_us=(-?\d+)\s*$/.exec(line);
        if (match) {
          lastProgressLine = Math.max(0, Number(match[1]) / 1_000_000);
        }
        if (line.startsWith('progress=') && Number.isFinite(lastProgressLine)) onProgress(lastProgressLine);
      }
    });
    child.stderr.resume();
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(displayError('视频处理未完成。', 'VIDEO_TOOL_FAILED'));
      else resolve(stdout);
    });
  });
}

function sourceStamp(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function fileError(error) {
  if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') {
    return displayError('磁盘空间不足，请释放空间后再试。', 'VIDEO_SPACE');
  }
  if (error?.code === 'EEXIST') return displayError('已有同名文件，请更改保存名称。', 'VIDEO_SAME_NAME');
  if (['EACCES', 'EPERM', 'EROFS', 'ENAMETOOLONG', 'ENOENT', 'EBUSY'].includes(error?.code)) {
    return displayError('无法读写视频文件，请检查保存位置和可用权限。', 'VIDEO_FILE_ACCESS');
  }
  return error;
}

async function stageOriginal(openSource, target, expectedBytes, expectedSha256, signal, listener) {
  let source;
  let output;
  try {
    signal?.throwIfAborted();
    source = await openSource(signal);
    signal?.throwIfAborted();
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(expectedBytes)) {
      throw displayError('视频原件已变化，请刷新素材库后再试。', 'VIDEO_SOURCE_CHANGED');
    }
    output = await fs.open(target, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(Math.min(expectedBytes, 1024 * 1024));
    const digest = expectedSha256 && createHash('sha256');
    let position = 0;
    let lastReport = 0;
    while (position < expectedBytes) {
      signal?.throwIfAborted();
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, expectedBytes - position), position);
      if (!bytesRead) break;
      digest?.update(buffer.subarray(0, bytesRead));
      for (let written = 0; written < bytesRead;) {
        signal?.throwIfAborted();
        const { bytesWritten } = await output.write(buffer, written, bytesRead - written, position + written);
        if (!bytesWritten) throw displayError('无法暂存视频原件。', 'VIDEO_WRITE_FAILED');
        written += bytesWritten;
      }
      position += bytesRead;
      if (Date.now() - lastReport >= 100) {
        report(listener, 'preparing', position / expectedBytes);
        lastReport = Date.now();
      }
    }
    if (position !== expectedBytes || sourceStamp(before) !== sourceStamp(await source.stat({ bigint: true }))) {
      throw displayError('视频原件在读取时发生变化，请刷新素材库后再试。', 'VIDEO_SOURCE_CHANGED');
    }
    if (digest && digest.digest('hex') !== expectedSha256) {
      throw displayError('视频原件校验失败。请确认 iCloud 完成下载后再试。', 'VIDEO_SOURCE_INTEGRITY');
    }
    report(listener, 'preparing', 1);
  } finally {
    await Promise.allSettled([source?.close(), output?.close()]);
  }
}

const inputOptions = ['-protocol_whitelist', 'file', '-format_whitelist', supportedDemuxers,
  '-probesize', '16000000', '-analyzeduration', '12000000', '-max_streams', '64'];
const probeEntries = 'format=duration,bit_rate:stream=index,codec_type,width,height,duration,bit_rate,avg_frame_rate,r_frame_rate,sample_aspect_ratio' +
  ':stream_disposition=default,attached_pic:stream_side_data=rotation';

function ratio(value, separator) {
  const [numerator, denominator] = typeof value === 'string' ? value.split(separator).map(Number) : [];
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : 0;
}

async function inspectVideo(ffprobe, input, signal, header) {
  let info;
  try {
    const options = header ? ['-nofind_stream_info', '-protocol_whitelist', header.protocol, ...inputOptions.slice(2)] : inputOptions;
    const result = await runTool(ffprobe, ['-v', 'error', ...options, '-show_entries', probeEntries, '-of', 'json', input],
      header ? { signal, stdin: header.fd, timeout: 12_000 } : { signal });
    info = JSON.parse(result);
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code && error.code !== 'VIDEO_TOOL_FAILED') throw error;
    throw displayError('无法读取这个视频的时间轴。请确认原件已完整下载且格式受支持。', 'VIDEO_UNREADABLE');
  }
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const byDefault = (first, next) => Number(next.disposition?.default || 0) - Number(first.disposition?.default || 0);
  const validIndex = stream => Number.isSafeInteger(stream.index) && stream.index >= 0;
  const video = streams.filter(stream => validIndex(stream) && stream.codec_type === 'video' && !stream.disposition?.attached_pic &&
    Number.isInteger(stream.width) && stream.width >= 2 && Number.isInteger(stream.height) && stream.height >= 2).sort(byDefault)[0];
  if (!video) throw displayError('没有找到可剪辑的视频画面。', 'VIDEO_NO_TRACK');
  const frameRate = ratio(video.avg_frame_rate, '/');
  const bitrate = [video.bit_rate, info.format?.bit_rate].map(Number).find(value => Number.isFinite(value) && value > 0);
  if (header) return { frameRate: frameRate || ratio(video.r_frame_rate, '/'), bitrate };
  const audio = streams.filter(stream => validIndex(stream) && stream.codec_type === 'audio').sort(byDefault)[0];
  const seconds = [video.duration, info.format?.duration]
    .map(Number).filter(duration => Number.isFinite(duration) && duration > 0);
  const duration = seconds.length ? Math.min(...seconds) : 0;
  if (duration > maximumDuration || video.width > 16_384 || video.height > 16_384 || video.width * video.height > 80_000_000) {
    throw displayError('视频超过可处理的时长或画面尺寸。', 'VIDEO_LIMIT');
  }
  if (!duration) throw displayError('没有找到有效的视频时长。', 'VIDEO_NO_DURATION');
  const rotation = Number(video.side_data_list?.find(entry => Number.isFinite(entry.rotation))?.rotation ?? 0);
  const oriented = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const displayWidth = Math.round(video.width * (ratio(video.sample_aspect_ratio, ':') || 1));
  const [width, height] = oriented ? [video.height, displayWidth] : [displayWidth, video.height];
  return { duration, width, height, frameRate, videoIndex: video.index,
    audioIndex: audio?.index, hasAudio: !!audio };
}

async function inspectVideoMetadata({ ffprobe, openSource, signal } = {}) {
  if (typeof ffprobe !== 'string' || !path.isAbsolute(ffprobe) || typeof openSource !== 'function') {
    throw displayError('无法找到视频处理组件。', 'VIDEO_TOOL_UNAVAILABLE');
  }
  signal?.throwIfAborted();
  if (!probeProtocols.has(ffprobe)) {
    if (probeProtocols.size >= 8) probeProtocols.delete(probeProtocols.keys().next().value);
    const pending = runTool(ffprobe, ['-hide_banner', '-protocols'], { timeout: 3500 })
      .then(output => /^\s+fd\s*$/mu.test(output) ? 'fd' : 'pipe')
      .catch(error => { if (probeProtocols.get(ffprobe) === pending) probeProtocols.delete(ffprobe); throw error; });
    probeProtocols.set(ffprobe, pending);
  }
  const protocol = await probeProtocols.get(ffprobe);
  signal?.throwIfAborted();
  // Pass the already-scoped handle as stdin. A seekable fd keeps FFprobe from
  // reopening any library path or reading through the whole video to reach its header.
  const source = await openSource();
  try {
    const stamp = sourceStamp(await source.stat({ bigint: true }));
    const metadata = await inspectVideo(ffprobe, protocol === 'fd' ? 'fd:' : 'pipe:0', signal, { fd: source.fd, protocol });
    if (stamp !== sourceStamp(await source.stat({ bigint: true }))) {
      throw displayError('视频原件在读取时发生变化，请刷新素材库后再试。', 'VIDEO_SOURCE_CHANGED');
    }
    return metadata;
  } finally {
    await source.close();
  }
}

async function chooseEncoders(ffmpeg, signal) {
  if (encoderSupport.has(ffmpeg)) return encoderSupport.get(ffmpeg);
  const listing = await runTool(ffmpeg, ['-hide_banner', '-encoders'], { signal });
  const names = new Set(listing.split(/\r?\n/).map(line => /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line)?.[1]));
  const h264 = names.has('aac') && ['libx264', 'libopenh264', 'h264_mf', 'h264_videotoolbox'].find(codec => names.has(codec));
  const webm = names.has('libopus') && names.has('libvpx-vp9');
  const preview = names.has('libopus') && names.has('libvpx');
  const formats = [h264 && 'mp4', webm && 'webm'].filter(Boolean);
  if (!formats.length) throw displayError('此视频处理组件缺少导出编码器，请重新解压应用。', 'VIDEO_ENCODER_MISSING');
  const capabilities = { h264, webm, preview, formats };
  if (encoderSupport.size >= 8) encoderSupport.delete(encoderSupport.keys().next().value);
  encoderSupport.set(ffmpeg, capabilities);
  return capabilities;
}

function readRange(start, end, duration, frameRate) {
  const tolerance = Math.max(0.05, Math.min(0.15, 1 / (frameRate || 30)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration + tolerance ||
      start >= duration || end <= start || Math.min(end, duration) - start < Math.min(0.095, duration - .001)) {
    throw displayError('裁切范围无效，请重新调整入点和出点。', 'VIDEO_RANGE');
  }
  return { start, length: Math.min(end, duration) - start };
}

function validateTrimRanges({ segments, start, end }, duration, frameRate) {
  const selection = segments === undefined ? [{ start, end }] : segments;
  if (!Array.isArray(selection) || !selection.length || selection.length > maximumSegments) {
    throw displayError(`请选择 1 至 ${maximumSegments} 个裁剪片段。`, 'VIDEO_RANGE');
  }
  const ranges = Array.from(selection, segment => readRange(segment?.start, segment?.end, duration, frameRate));
  const length = ranges.reduce((total, range) => total + range.length, 0);
  if (length > maximumDuration) throw displayError('合并后的时长不能超过 24 小时。', 'VIDEO_RANGE');
  return { ranges, length };
}

function scaleFilter(resolution) {
  const [long, short] = resolutions[resolution];
  const displayWidth = 'iw*if(gt(sar,0),sar,1)';
  const landscape = `gte(${displayWidth},ih)`;
  const factor = `min(1,min(if(${landscape},${long},${short})/(${displayWidth}),if(${landscape},${short},${long})/ih))`;
  return `scale=w='max(2,trunc((${displayWidth})*(${factor})/2)*2)':h='max(2,trunc(ih*(${factor})/2)*2)',setsar=1`;
}

function videoCodec(format, h264, quality, info, resolution) {
  if (format === 'preview') return ['-c:v', 'libvpx', '-crf', '32', '-b:v', '1400k', '-deadline', 'realtime', '-cpu-used', '7'];
  if (format === 'webm') return ['-c:v', 'libvpx-vp9', '-crf', String(quality.vp9), '-b:v', '0', '-deadline', 'good',
    '-cpu-used', '5', '-row-mt', '1'];
  const codec = ['-c:v', h264];
  if (h264 === 'libx264') return [...codec, '-preset', 'veryfast', '-crf', String(quality.h264)];
  if (h264 === 'h264_mf') return [...codec, '-hw_encoding', '0', '-rate_control', 'quality', '-quality', String(quality.mf)];
  if (h264 === 'h264_videotoolbox') return [...codec, '-allow_sw', '1', '-q:v', String(quality.mf)];
  const [long, short] = resolutions[resolution];
  const pixels = Math.min(info.width * info.height, long * short);
  return [...codec, '-b:v', String(Math.round(Math.max(200_000, pixels * (info.frameRate || 30) * quality.open)))];
}

function streamArguments(source, info, ranges, audio, resolution) {
  if (ranges.length === 1) {
    const [{ start, length }] = ranges;
    return ['-filter_threads', '2', '-threads', '4', '-ss', start.toFixed(6), ...inputOptions, '-i', source,
      '-t', length.toFixed(6), '-map', `0:${info.videoIndex}`, ...(audio ? ['-map', `0:${info.audioIndex}`] : ['-an']),
      '-vf', scaleFilter(resolution)];
  }

  const inputs = [];
  const filters = [];
  const labels = [];
  for (const [index, { start, length }] of ranges.entries()) {
    const seconds = length.toFixed(6);
    inputs.push('-threads', '1', '-ss', start.toFixed(6), '-t', seconds, ...inputOptions, '-i', source);
    filters.push(`[${index}:${info.videoIndex}]setpts=PTS-STARTPTS,${scaleFilter(resolution)}[v${index}]`);
    // A bounded silent track gives each clip an exact duration even if the original audio ends early or is absent.
    filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000:d=${seconds}[silence${index}]`);
    if (audio) {
      filters.push(`[${index}:${info.audioIndex}]aresample=48000:async=1:first_pts=0[track${index}]`,
        `[silence${index}][track${index}]amix=inputs=2:duration=first:normalize=0[a${index}]`);
    }
    labels.push(`[v${index}][${audio ? 'a' : 'silence'}${index}]`);
  }
  filters.push(`${labels.join('')}concat=n=${ranges.length}:v=1:a=1[video][audio]`);
  if (!audio) filters.push('[audio]anullsink');
  return ['-filter_complex_threads', '2', ...inputs, '-filter_complex', filters.join(';'), '-map', '[video]',
    ...(audio ? ['-map', '[audio]'] : ['-an'])];
}

async function encode({ ffmpeg, source, output, info, encoders, ranges, length, format, quality, resolution, muted, signal, listener }) {
  const preview = format === 'preview';
  const phase = preview ? 'previewing' : 'encoding';
  const audio = info.hasAudio && !muted;
  const pixelFormat = format === 'mp4' && encoders.h264 === 'h264_mf' ? 'nv12' : 'yuv420p';
  report(listener, phase, 0);
  let progress = 0;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-nostats', '-progress', 'pipe:1',
    ...streamArguments(source, info, ranges, audio, resolution),
    '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn', '-pix_fmt', pixelFormat,
    '-threads:v', '4', ...videoCodec(format, encoders.h264, quality, info, resolution),
    ...(audio ? ['-c:a', format === 'mp4' ? 'aac' : 'libopus', '-b:a', preview ? '64k' : quality.audio, '-ar', '48000', '-ac', '2'] : []),
    ...(format === 'mp4' ? ['-movflags', '+faststart', '-f', 'mp4'] : ['-f', 'webm']), output];
  try {
    await runTool(ffmpeg, args, { signal, timeout: Math.min(12 * 3_600_000, Math.max(1_800_000, 15_000 * length)),
      capture: false, onProgress: seconds => {
        const fraction = Math.min(.99, seconds / length);
        if (fraction >= progress) {
          progress = fraction;
          report(listener, phase, progress);
        }
      } });
  } catch (error) {
    signal.throwIfAborted();
    if (error.code !== 'VIDEO_TOOL_FAILED') throw error;
    throw displayError(format === 'mp4' ? 'MP4 导出未完成，请尝试 WebM 或较低的分辨率。' :
      preview ? '无法生成这个视频的兼容预览。' : '无法导出这个视频的选段，请尝试较低的分辨率。', 'VIDEO_ENCODE_FAILED');
  }
  report(listener, phase, 1);
}

async function validOutput(ffprobe, output, range, info, signal) {
  const stat = await fs.lstat(output);
  if (!stat.isFile() || !stat.size) throw displayError('导出的视频没有内容。', 'VIDEO_EMPTY_OUTPUT');
  const outputInfo = await inspectVideo(ffprobe, output, signal);
  const tolerance = Math.max(.25, Math.min(1, 2 / (info.frameRate || 30)));
  if (Math.abs(range.length - outputInfo.duration) > tolerance) {
    throw displayError('导出的视频时长与选区差异过大，请调整裁切范围再试。', 'VIDEO_WRONG_DURATION');
  }
  return { size: stat.size, duration: outputInfo.duration, width: outputInfo.width, height: outputInfo.height, hasAudio: outputInfo.hasAudio };
}

async function cleanup(directory) {
  if (directory) await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {});
}

async function prepareVideoTrim({ ffmpeg, ffprobe, openSource, extension, expectedBytes, expectedSha256, tempRoot = os.tmpdir(), signal, onProgress }) {
  if (![ffmpeg, ffprobe, tempRoot].every(item => typeof item === 'string' && path.isAbsolute(item))) {
    throw displayError('无法找到视频处理组件，请重新解压见藏。', 'VIDEO_TOOL_UNAVAILABLE');
  }
  if (typeof openSource !== 'function' || !Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maximumSourceBytes) {
    throw displayError('无法读取视频，或原件超过 32 GB。', 'VIDEO_LIMIT');
  }
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256))) {
    throw displayError('视频原件校验信息无效，请刷新素材库。', 'VIDEO_SOURCE_INTEGRITY');
  }
  let directory;
  try {
    signal?.throwIfAborted();
    const encoders = await chooseEncoders(ffmpeg, signal);
    const tempLocation = await fs.realpath(tempRoot);
    directory = await fs.mkdtemp(path.join(tempLocation, '.jiancang-video-'));
    const suffix = typeof extension === 'string' && /^[a-z0-9]{1,8}$/i.test(extension) ? extension : 'media';
    const source = path.join(directory, `source.${suffix}`);
    report(onProgress, 'preparing', 0);
    await stageOriginal(openSource, source, expectedBytes, expectedSha256, signal, onProgress);
    report(onProgress, 'probing', 0);
    const info = await inspectVideo(ffprobe, source, signal);
    signal?.throwIfAborted();
    report(onProgress, 'probing', 1);
    const formats = encoders.h264 === 'libopenh264' && info.frameRate > 60 && encoders.webm
      ? ['webm'] : encoders.formats;
    const lifetime = new AbortController();
    let active;
    let closing;
    let compatiblePreview;
    const run = async (operationSignal, callback) => {
      if (closing) throw displayError('视频裁切已关闭，请重新打开。', 'VIDEO_CLOSED');
      if (active) throw displayError('这个视频正在处理，请稍候。', 'VIDEO_BUSY');
      const combined = operationSignal ? AbortSignal.any([lifetime.signal, operationSignal]) : lifetime.signal;
      combined.throwIfAborted();
      const pending = callback(combined);
      active = pending;
      try { return await pending; }
      catch (error) { throw fileError(error); }
      finally { if (active === pending) active = undefined; }
    };

    return {
      duration: info.duration, width: info.width, height: info.height, hasAudio: info.hasAudio, frameRate: info.frameRate,
      formats: [...formats], previewAvailable: encoders.preview,
      makePreview: (options = {}) => run(options.signal, async combined => {
        if (compatiblePreview) return compatiblePreview;
        if (!encoders.preview) throw displayError('此设备的组件无法生成兼容预览。', 'VIDEO_ENCODER_MISSING');
        const output = path.join(directory, 'preview.webm');
        const range = { start: 0, length: info.duration };
        try {
          await encode({ ffmpeg, source, output, info, encoders, ranges: [range], length: range.length, format: 'preview', quality: qualityOptions.small,
            resolution: 'preview', muted: false, signal: combined, listener: options.onProgress });
          const result = await validOutput(ffprobe, output, range, info, combined);
          combined.throwIfAborted();
          compatiblePreview = { ...result, file: output };
          return compatiblePreview;
        } catch (error) {
          await fs.rm(output, { force: true }).catch(() => {});
          throw error;
        }
      }),
      export: (options = {}) => run(options.signal, async combined => {
        const { target, format = formats[0], quality = 'standard', resolution = 'original', muted = false,
          protectedRoots = [], onProgress: listener } = options;
        const selection = validateTrimRanges(options, info.duration, info.frameRate);
        if (!formats.includes(format) || !Object.hasOwn(qualityOptions, quality) ||
            resolution === 'preview' || !Object.hasOwn(resolutions, resolution) || typeof muted !== 'boolean' ||
            typeof target !== 'string' || !path.isAbsolute(target) || path.extname(target).toLowerCase() !== `.${format}`) {
          throw displayError('导出选项无效，请检查格式、分辨率及保存位置。', 'VIDEO_OPTIONS');
        }
        const outsideLibrary = '请选择素材库以外的文件夹保存视频副本。';
        const destination = await validateExportTarget(target, protectedRoots, outsideLibrary);
        const targetParent = path.dirname(destination);
        const initialParent = await fs.lstat(targetParent, { bigint: true });
        try {
          await fs.lstat(destination);
          throw displayError('已有同名文件，请更改保存名称。', 'VIDEO_SAME_NAME');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const outputDirectory = await fs.mkdtemp(path.join(targetParent, '.jiancang-video-'));
        try {
          const output = path.join(outputDirectory, `clip.${format}`);
          await encode({ ffmpeg, source, output, info, encoders, ...selection, format, quality: qualityOptions[quality],
            resolution, muted, signal: combined, listener });
          const result = await validOutput(ffprobe, output, selection, info, combined);
          const verifiedDestination = await validateExportTarget(target, protectedRoots, outsideLibrary);
          const currentParent = await fs.lstat(targetParent, { bigint: true });
          if (verifiedDestination !== destination || currentParent.dev !== initialParent.dev || currentParent.ino !== initialParent.ino) {
            throw displayError('保存位置已改变，请重新选择。', 'VIDEO_DESTINATION_CHANGED');
          }
          report(listener, 'saving', 0);
          combined.throwIfAborted();
          try { await fs.link(output, destination); }
          catch (error) {
            if (!['EXDEV', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(error.code)) throw error;
            await fs.copyFile(output, destination, constants.COPYFILE_EXCL);
          }
          report(listener, 'saving', 1);
          return { ...result, file: destination, format };
        } finally { await cleanup(outputDirectory); }
      }),
      close: () => {
        closing ??= (async () => {
          lifetime.abort();
          await active?.catch(() => {});
          await cleanup(directory);
        })();
        return closing;
      },
    };
  } catch (error) {
    await cleanup(directory);
    throw fileError(error);
  }
}

module.exports = { inspectVideoMetadata, maximumSegments, prepareVideoTrim, validateTrimRanges };
