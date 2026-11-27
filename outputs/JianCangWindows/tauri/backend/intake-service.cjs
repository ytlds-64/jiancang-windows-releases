'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { clipboardWebURLs, maximumImportBatch, webURL } = require('../../local-workflow.cjs');
const { imageExtension, imageFilename, imageURLCandidates, inlineImage, maximumImageBytes } = require('../../dropped-image.cjs');
const { maximumStagedVideoBytes, dropVideoSuffix } = require('../../local-import-queue.cjs');

const run = promisify(execFile);
const uploadLimit = 2 * 1024 * 1024;
const maxChunkBytes = 768 * 1024;
const maxDropImages = 32;
const dropUploadLifetime = 5 * 60_000;
const clipboardLifetime = 300_000;
const commands = new Set([
  'local-import:drop-items', 'local-import:drop-begin', 'local-import:drop-append', 'local-import:drop-finish',
  'local-import:drop-discard', 'local-import:capture-paste', 'local-import:release-paste', 'local-import:paste',
]);
const clipboardReader = `
  $ErrorActionPreference = 'Stop'
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  Add-Type -AssemblyName System.Windows.Forms
  if ([Windows.Forms.Clipboard]::ContainsFileDropList()) {
    $files = @([Windows.Forms.Clipboard]::GetFileDropList() | Select-Object -First ${maximumImportBatch + 1})
    @{ paths = $files } | ConvertTo-Json -Compress
  } elseif ([Windows.Forms.Clipboard]::ContainsImage()) {
    $image = [Windows.Forms.Clipboard]::GetImage()
    $stream = [IO.MemoryStream]::new()
    try {
      if ($image.Width * [long]$image.Height -gt 40000000) { @{ tooLarge = $true } | ConvertTo-Json -Compress; exit }
      $image.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
      if ($stream.Length -gt ${maximumImageBytes}) { @{ tooLarge = $true } | ConvertTo-Json -Compress; exit }
      @{ image = [Convert]::ToBase64String($stream.ToArray()) } | ConvertTo-Json -Compress
    } finally { $stream.Dispose(); $image.Dispose() }
  } else {
    $text = [Windows.Forms.Clipboard]::GetText()
    @{ text = $text.Substring(0, [Math]::Min($text.Length, 164001)) } | ConvertTo-Json -Compress
  }
`;

async function readWindowsClipboard(signal) {
  if (process.platform !== 'win32' || !path.isAbsolute(process.env.SystemRoot ?? '')) {
    throw new Error('当前系统无法从见藏读取剪贴板。');
  }
  const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const { stdout } = await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-Command', clipboardReader],
      { windowsHide: true, encoding: 'utf8', timeout: 12_000, maxBuffer: 46 * 1024 ** 2, signal });
    return JSON.parse(stdout);
  } catch { throw new Error('暂时无法读取剪贴板，请重新复制后再粘贴。'); }
}

function imageSource(encoded, name, limit) {
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(limit / 3) * 4) return null;
  const bytes = Buffer.from(encoded, 'base64');
  const extension = bytes.length <= limit && imageExtension(bytes);
  return extension ? { kind: 'buffer', bytes, name: imageFilename(name, extension) } : null;
}

function urlSources(text) {
  const urls = clipboardWebURLs(text);
  if (!urls.length) throw new Error('请复制图片、文件或普通网页链接。粘贴多个网址时每行放一个。');
  return urls.map(url => ({ kind: 'url', url }));
}

class IntakeService {
  constructor(library, { readClipboard = readWindowsClipboard } = {}) {
    this.library = library;
    this.readClipboard = readClipboard;
    this.clipboard = null;
    this.dropUploads = new Map();
    this.closed = false;
  }

  static handles(name) { return commands.has(name); }

  async close() {
    this.closed = true;
    this.clearClipboard();
    await Promise.allSettled([...this.dropUploads.values()].map(job => job.completion ?? this.discardDrop(job.token)));
  }

  async clipboardSources() {
    const data = await this.readClipboard(this.library.shutdown.signal);
    if (data.tooLarge) throw new Error('这张剪贴板图片过大，请保存为文件后再导入。');
    if (Array.isArray(data.paths) && data.paths.length) {
      if (data.paths.length > maximumImportBatch) throw new Error('请分批导入剪贴板中的文件。');
      const selection = await this.library.pathSources(data.paths);
      if (!selection.sources.length) throw new Error('剪贴板中没有可导入的文件。');
      return selection;
    }
    const image = imageSource(data.image, '剪贴板图片', maximumImageBytes);
    if (image) return { sources: [image], skipped: 0 };
    return { sources: urlSources(data.text), skipped: 0 };
  }

  async capturePaste() {
    this.clearClipboard();
    const selection = await this.clipboardSources();
    const token = randomUUID();
    this.clipboard = { ...selection, token, timer: setTimeout(() => this.clearClipboard(token), clipboardLifetime) };
    this.clipboard.timer.unref();
    return { ok: true, token };
  }

  clearClipboard(token) {
    if (token !== undefined && this.clipboard?.token !== token) return { ok: true };
    clearTimeout(this.clipboard?.timer);
    this.clipboard = null;
    return { ok: true };
  }

  async paste(id, collectionId, text, token) {
    const snapshot = this.clipboard;
    const captured = token != null;
    if (captured && (!snapshot || snapshot.token !== token || snapshot.enqueuing)) {
      throw new Error('这次粘贴已结束，请重新按 Ctrl+V。');
    }
    const selection = captured ? snapshot
      : typeof text === 'string' ? { sources: urlSources(text), skipped: 0 } : await this.clipboardSources();
    if (captured) snapshot.enqueuing = true;
    try {
      const result = await this.library.serial(() => this.library.enqueueSources(id, collectionId, selection.sources, selection.skipped));
      if (captured) this.clearClipboard(token);
      return result;
    } finally { if (captured) snapshot.enqueuing = false; }
  }

  enqueueDrop(id, collectionId, sources, { imageURL, link, sourceURL, skipped = 0 }, libraryId, nativeSelection) {
    const provenance = webURL(sourceURL) ?? undefined;
    if (sources.length) {
      if (provenance) for (const source of sources) source.sourceURL = provenance;
    } else {
      const [url, ...fallbackURLs] = imageURLCandidates(imageURL);
      const website = webURL(link);
      if (url) sources.push({ kind: 'image-url', url, fallbackURLs, sourceURL: provenance });
      else if (website) sources.push({ kind: 'url', url: website });
    }
    const selection = nativeSelection ? [...nativeSelection.sources, ...sources] : sources;
    if (!selection.length) throw new Error('此处没有可导入的文件。请使用浏览器采集或复制图片后粘贴。');
    return this.library.serial(() => {
      if (this.closed) throw new Error('本次拖入已取消，请重新拖入文件。');
      return this.library.enqueueSources(id, collectionId, selection, skipped + (nativeSelection?.skipped ?? 0), libraryId);
    });
  }

  drop(id, collectionId, { images = [], imageURL = [], link, sourceURL, skipped = 0 } = {}) {
    if (!Array.isArray(images) || images.length > maxDropImages || !Array.isArray(imageURL)) throw new Error('请分批拖入网页图片。');
    let remaining = uploadLimit;
    skipped = Number.isSafeInteger(skipped) && skipped >= 0 ? Math.min(skipped, maximumImportBatch) : 0;
    const sources = [];
    for (const item of images) {
      const source = imageSource(item?.bytes, item?.name || '拖入图片', remaining);
      if (!source) { skipped++; continue; }
      remaining -= source.bytes.length;
      sources.push(source);
    }
    if (!sources.length) {
      const bytes = imageURL.slice(0, 3).map(inlineImage).find(image => image && image.length <= uploadLimit);
      if (bytes) sources.push({ kind: 'buffer', bytes, name: imageFilename('拖入图片', imageExtension(bytes)) });
    }
    return this.enqueueDrop(id, collectionId, sources, { imageURL, link, sourceURL, skipped });
  }

  beginDrop(id, collectionId, { images, paths = [], imageURL, link, sourceURL, skipped } = {}) {
    if (this.closed) throw new Error('本次拖入已取消，请重新拖入文件。');
    if (this.dropUploads.size >= 2) throw new Error('正在处理其他拖入文件，请稍后再试。');
    if (!Array.isArray(images) || !images.length || images.length > maxDropImages || images.some(image =>
      typeof image?.name !== 'string' || image.name.length > 512 ||
      !Number.isSafeInteger(image.byteCount) || image.byteCount <= 0 ||
      (image.kind !== undefined && image.kind !== 'video'))) {
      throw new Error('无法读取拖入的文件，请每批最多拖入 32 个。');
    }
    const videos = images.filter(image => image.kind === 'video');
    if (videos.some(video => !dropVideoSuffix.test(video.name))) {
      throw new Error('这个来源提供的视频格式无法导入，请从资源管理器拖入原件。');
    }
    const videoBytes = videos.reduce((total, video) => total + video.byteCount, 0);
    const activeVideoBytes = [...this.dropUploads.values()].reduce((total, job) => total + job.videoBytes, 0);
    if (videoBytes + activeVideoBytes > maximumStagedVideoBytes) {
      throw new Error('拖入的视频需要暂存，视频过多或过大。请分批拖入，或从资源管理器直接拖入原件。');
    }
    if (images.reduce((total, image) => total + (image.kind === 'video' ? 0 : image.byteCount), 0) > maximumImageBytes) {
      throw new Error('请分批拖入图片，每批最多 32 张、32 MB。');
    }
    if (!Array.isArray(paths) || paths.length + images.length > maximumImportBatch) {
      throw new Error('每次最多拖入 10,000 项，请分批导入。');
    }
    const { libraryId } = this.library.captureTarget({ targetId: id, collectionId }, { allowPending: true });
    const token = randomUUID();
    const job = { token, id, collectionId, libraryId, paths, files: images.map(({ name, byteCount, kind }) => ({ name, byteCount, kind, received: 0 })),
      videoBytes, imageURL: imageURLCandidates(imageURL), link: webURL(link), sourceURL: webURL(sourceURL),
      skipped: Number.isSafeInteger(skipped) && skipped >= 0 ? Math.min(skipped, maximumImportBatch) : 0 };
    this.dropUploads.set(token, job);
    this.renewDrop(job);
    return { token };
  }

  renewDrop(job) {
    clearTimeout(job.expiry);
    job.expiry = setTimeout(() => void this.discardDrop(job.token), dropUploadLifetime);
    job.expiry.unref();
  }

  async releaseDropUploads(job) {
    await Promise.allSettled(job.files.map(async file => {
      if (!file.stage) return;
      await file.stage.handle?.close().catch(() => {});
      await this.library.queue.discardVideoUpload(file.stage.uploadId);
    }));
  }

  async discardDrop(token) {
    const job = this.dropUploads.get(token);
    if (job && !job.completion) {
      clearTimeout(job.expiry);
      this.dropUploads.delete(token);
      await job.writing?.catch(() => {});
      await this.releaseDropUploads(job);
    }
    return { ok: true };
  }

  pendingDrop(token) {
    const job = this.dropUploads.get(token);
    if (!job || job.completion) throw new Error('本次拖入已结束，请重新拖入文件。');
    return job;
  }

  async writeVideoChunk(file, offset, bytes) {
    file.stage ??= await this.library.queue.openVideoUpload();
    let written = 0;
    while (written < bytes.length) {
      const { bytesWritten } = await file.stage.handle.write(bytes, written, bytes.length - written, offset + written);
      if (!bytesWritten) throw new Error('无法暂存拖入的视频。');
      written += bytesWritten;
    }
  }

  async appendDrop(token, index, offset, data) {
    const job = this.pendingDrop(token);
    const file = Number.isSafeInteger(index) && job.files[index];
    const size = file && Math.min(maxChunkBytes, file.byteCount - file.received);
    if (job.writing || !size || file.received !== offset || typeof data !== 'string' || data.length !== Math.ceil(size / 3) * 4) {
      throw new Error('无法读取拖入的文件数据。');
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length !== size || bytes.toString('base64') !== data) throw new Error('无法读取拖入的文件数据。');
    this.renewDrop(job);
    if (file.kind === 'video') {
      job.writing = this.writeVideoChunk(file, offset, bytes);
      try { await job.writing; }
      finally { job.writing = null; }
    } else {
      file.bytes ??= Buffer.alloc(file.byteCount);
      bytes.copy(file.bytes, offset);
    }
    file.received += bytes.length;
    return { ok: true };
  }

  finishDrop(token) {
    const job = this.pendingDrop(token);
    if (job.writing || job.files.some(file => file.received !== file.byteCount)) {
      throw new Error('文件尚未传完，请重新拖入。');
    }
    clearTimeout(job.expiry);
    job.completion = this.commitDrop(job);
    return job.completion;
  }

  async commitDrop(job) {
    const sources = [];
    try {
      for (const { name, bytes, byteCount, kind, stage } of job.files) {
        if (kind === 'video') {
          await stage.handle.sync();
          await stage.handle.close();
          stage.handle = null;
          sources.push({ kind: 'staged-video', name, byteCount, uploadId: stage.uploadId });
        } else {
          const extension = imageExtension(bytes);
          if (extension) sources.push({ kind: 'buffer', bytes, name: imageFilename(name, extension) });
          else job.skipped++;
        }
      }
      const selection = job.paths.length ? await this.library.pathSources(job.paths) : undefined;
      return await this.enqueueDrop(job.id, job.collectionId, sources, job, job.libraryId, selection);
    } finally {
      await this.releaseDropUploads(job);
      this.dropUploads.delete(job.token);
    }
  }

  command(name, args) {
    switch (name) {
      case 'local-import:drop-items': return this.drop(...args);
      case 'local-import:drop-begin': return this.beginDrop(...args);
      case 'local-import:drop-append': return this.appendDrop(...args);
      case 'local-import:drop-finish': return this.finishDrop(args[0]);
      case 'local-import:drop-discard': return this.discardDrop(args[0]);
      case 'local-import:capture-paste': return this.capturePaste();
      case 'local-import:release-paste': return this.clearClipboard(args[0]);
      case 'local-import:paste': return this.paste(...args);
      default: throw new Error('未找到此导入操作。');
    }
  }
}

module.exports = { IntakeService };
