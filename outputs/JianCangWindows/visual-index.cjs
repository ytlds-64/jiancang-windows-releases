'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { setImmediate: nextFrame } = require('node:timers/promises');
const { Worker } = require('node:worker_threads');

const registrar = /^[a-f0-9-]{1,64}$/i;
const identifier = /^[a-f0-9]{64}$/;
const maxScan = 50_000;
const maxRows = 60_000;
const maxImageBytes = 16 * 1024 ** 2;
const maxDimension = 1400;
const overlay = 240;
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const frequencies = Array.from({ length: 8 }, (_, k) =>
  Array.from({ length: 32 }, (_, x) => Math.cos(Math.PI * (x + 0.5) * k / 32)));

function referenceList(references, includeRevisions = false) {
  if (!Array.isArray(references) || references.length > maxScan) {
    throw new Error('一次最多分析 50,000 项，请选择单个素材库或集合。');
  }
  const unique = new Map();
  for (const reference of references) {
    const row = checkedReference(reference);
    unique.set(JSON.stringify([row.registrationId, row.assetId, includeRevisions ? row.revision : null]), row);
  }
  return [...unique.values()];
}

function checkedReference(reference) {
  if (!reference || typeof reference.registrationId !== 'string' || !registrar.test(reference.registrationId) ||
      typeof reference.assetId !== 'string' || !identifier.test(reference.assetId) ||
      typeof reference.revision !== 'string' || !reference.revision.length || reference.revision.length > 512 ||
      reference.revision.includes('\0')) {
    throw new Error('无法识别要分析的图片，请刷新素材库。');
  }
  return { registrationId: reference.registrationId, assetId: reference.assetId, revision: reference.revision,
    inputState: typeof reference.inputState === 'string' && /^[a-z0-9-]{1,48}$/.test(reference.inputState) ? reference.inputState : '',
    ...(typeof reference.contentHash === 'string' && identifier.test(reference.contentHash) && { contentHash: reference.contentHash }) };
}

function readPNG(input) {
  const png = Buffer.isBuffer(input) ? input : input?.png;
  if (!Buffer.isBuffer(png) || png.length < 33 || png.length > maxImageBytes ||
      !png.subarray(0, 8).equals(pngHeader) || png.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('无法解码该图片。');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > maxDimension || height > maxDimension) {
    throw new Error('图片分析尺寸超出限制。');
  }
  return png;
}

function readRaster(input) {
  const png = readPNG(input);
  const { PNG } = require('./vendor/ocr/node_modules/pngjs');
  const pixels = PNG.sync.read(png, { checkCRC: true });
  return { ...pixels, png };
}

const toHex = channel => Math.round(channel).toString(16).padStart(2, '0');
const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function nearestColor(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const light = (max + min) / 510;
  const saturation = delta ? delta / (255 * (1 - Math.abs(light * 2 - 1))) : 0;
  if (saturation < 0.16 || delta < 17 || light < 0.10 || light > 0.91) return Math.min(4, Math.floor(light * 5));
  let hue;
  if (r === max) hue = (g - b) / delta;
  else if (g === max) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  const sector = Math.round(hue * 2 + 12) % 12;
  return 5 + sector * 3 + Math.min(2, Math.floor(light * 3));
}

function sampleRaster(raster) {
  const { width, height, data } = raster;
  const colors = new Map();
  const sums = new Float64Array(32 * 32);
  const samples = new Uint32Array(32 * 32);
  const stride = Math.max(1, Math.ceil(Math.sqrt(width * height / 131072)));
  for (let y = 0; y < height; y += stride) {
    const row = Math.min(31, Math.floor(y * 32 / height));
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4;
      const [r, g, b, opacity] = [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
      const alpha = opacity / 255;
      const cell = row * 32 + Math.min(31, Math.floor(x * 32 / width));
      sums[cell] += luminance(r, g, b) * alpha + overlay * (1 - alpha);
      samples[cell]++;
      if (opacity < 24) continue;
      const color = nearestColor(r, g, b);
      let bucket = colors.get(color);
      if (!bucket) { bucket = [0, 0, 0, 0]; colors.set(color, bucket); }
      bucket[0] += alpha;
      bucket[1] += r * alpha;
      bucket[2] += g * alpha;
      bucket[3] += b * alpha;
    }
  }
  const grid = Float64Array.from(sums, (value, cell) => {
    if (samples[cell]) return value / samples[cell];
    const x = Math.min(width - 1, Math.floor((cell % 32 + 0.5) * width / 32));
    const y = Math.min(height - 1, Math.floor((Math.floor(cell / 32) + 0.5) * height / 32));
    const offset = (y * width + x) * 4;
    const alpha = data[offset + 3] / 255;
    return luminance(data[offset], data[offset + 1], data[offset + 2]) * alpha + overlay * (1 - alpha);
  });
  const palette = [...colors.values()].sort((a, b) => b[0] - a[0]).slice(0, 5)
    .map(([weight, r, g, b]) => `#${toHex(r / weight)}${toHex(g / weight)}${toHex(b / weight)}`);
  return { grid, palette };
}

function perceptualHash(grid) {
  const horizontal = new Float64Array(32 * 8);
  for (let y = 0; y < 32; y++) {
    for (let k = 0; k < 8; k++) {
      const wave = frequencies[k];
      for (let x = 0; x < 32; x++) horizontal[y * 8 + k] += grid[y * 32 + x] * wave[x];
    }
  }
  const coefficients = [];
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      if (v === 0 && u === 0) continue;
      let value = 0;
      for (let y = 0; y < 32; y++) value += horizontal[y * 8 + u] * frequencies[v][y];
      coefficients.push(Math.abs(value) < 0.00001 ? 0 : value);
    }
  }
  const middle = coefficients.slice().sort((a, b) => a - b)[31];
  let bits = 0n;
  for (const value of coefficients) bits = (bits << 1n) | (value > middle ? 1n : 0n);
  return bits.toString(16).padStart(16, '0');
}

function analyzeRaster(input) {
  const raster = readRaster(input);
  const { grid, palette } = sampleRaster(raster);
  const stats = grid.reduce((memo, value) => {
    memo.min = Math.min(memo.min, value);
    memo.max = Math.max(memo.max, value);
    return memo;
  }, { min: Infinity, max: -Infinity });
  return { ...raster, primaryColor: palette[0] ?? null, palette,
    visualHash: perceptualHash(grid), flat: stats.max - stats.min < 12,
    previewHash: createHash('sha256').update(raster.png).digest('hex') };
}

function hamming(left, right) {
  let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (bits > 0n) { bits &= bits - 1n; distance++; }
  return distance;
}

function rgbDistance(left, right) {
  if (!left || !right) return Number(left !== right) * 255;
  const a = Number.parseInt(left.slice(1), 16);
  const b = Number.parseInt(right.slice(1), 16);
  return Math.hypot((a >> 16) - (b >> 16), ((a >> 8) & 255) - ((b >> 8) & 255), (a & 255) - (b & 255));
}

function readableText(value) {
  return value.normalize('NFKC').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/(\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, '$1').trim().slice(0, 8192);
}

class OfflineOcr {
  #worker;
  #idle;
  #serial = 0;

  close() {
    clearTimeout(this.#idle);
    const worker = this.#worker;
    this.#worker = null;
    if (worker) void worker.terminate().catch(() => {});
  }

  recognize(png, signal) {
    signal.throwIfAborted();
    clearTimeout(this.#idle);
    if (!this.#worker) {
      this.#worker = new Worker(path.join(__dirname, 'visual-ocr-worker.cjs'), {
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      this.#worker.unref();
    }
    const worker = this.#worker;
    const id = ++this.#serial;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeListener('message', message);
        worker.removeListener('error', failed);
        worker.removeListener('exit', exited);
        signal.removeEventListener('abort', aborted);
      };
      const failed = () => {
        cleanup();
        this.close();
        reject(new Error('未能识别这张图片的文字。'));
      };
      const exited = () => failed();
      const aborted = () => {
        cleanup();
        this.close();
        reject(signal.reason);
      };
      const message = response => {
        if (response?.id !== id) return;
        if (response.error) { failed(); return; }
        cleanup();
        this.#idle = setTimeout(() => this.close(), 15_000);
        this.#idle.unref();
        resolve(readableText(response.text));
      };
      const timer = setTimeout(failed, 45_000);
      worker.on('message', message);
      worker.once('error', failed);
      worker.once('exit', exited);
      signal.addEventListener('abort', aborted, { once: true });
      try { worker.postMessage({ id, bytes: png }); } catch { failed(); }
    });
  }
}

class VisualIndex {
  #db;
  #active = null;
  #controller;
  #ocr = new OfflineOcr();
  #pending;
  #statements;
  #lastEvent = 0;
  #insertions = 0;
  #image;
  #notify;
  #directory;

  constructor({ directory, getImage, onChange } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof getImage !== 'function') {
      throw new TypeError('Visual analysis needs a private cache and image reader.');
    }
    this.#directory = directory;
    this.#image = getImage;
    this.#notify = onChange;
  }

  async initialize() {
    if (this.#db) return;
    await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const entry = await fs.lstat(this.#directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('无法打开本机图片索引。');
    const root = await fs.realpath(this.#directory);
    for (const name of ['index.sqlite', 'index.sqlite-shm', 'index.sqlite-wal']) {
      const file = await fs.lstat(path.join(root, name)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (file && (!file.isFile() || file.isSymbolicLink())) throw new Error('无法打开本机图片索引。');
    }
    const db = new DatabaseSync(path.join(root, 'index.sqlite'));
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS images (
          registration TEXT NOT NULL, asset TEXT NOT NULL, revision TEXT NOT NULL,
          color TEXT, palette TEXT NOT NULL, hash TEXT NOT NULL, preview_hash TEXT NOT NULL,
          content_hash TEXT, flat INTEGER NOT NULL, aspect REAL NOT NULL, ocr TEXT NOT NULL,
          text TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (registration,asset)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS indexed_date ON images(updated);
        CREATE TABLE IF NOT EXISTS raster_failures (
          registration TEXT NOT NULL, asset TEXT NOT NULL, revision TEXT NOT NULL,
          input_state TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (registration,asset)
        ) WITHOUT ROWID;
      `);
      this.#statements = {
        read: db.prepare('SELECT * FROM images WHERE registration = ? AND asset = ? AND revision = ?'),
        write: db.prepare(`
          INSERT INTO images(registration,asset,revision,color,palette,hash,preview_hash,content_hash,flat,aspect,ocr,text,updated)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(registration,asset) DO UPDATE SET revision=excluded.revision,color=excluded.color,
          palette=excluded.palette,hash=excluded.hash,preview_hash=excluded.preview_hash,content_hash=excluded.content_hash,
          flat=excluded.flat,aspect=excluded.aspect,ocr=excluded.ocr,text=excluded.text,updated=excluded.updated
        `),
        trim: db.prepare(`
          DELETE FROM images WHERE (registration,asset) IN (SELECT registration,asset FROM images ORDER BY updated DESC LIMIT -1 OFFSET ?)
        `),
        readFailure: db.prepare('SELECT 1 FROM raster_failures WHERE registration = ? AND asset = ? AND revision = ? AND input_state = ?'),
        writeFailure: db.prepare(`
          INSERT INTO raster_failures(registration,asset,revision,input_state,updated) VALUES(?,?,?,?,?)
          ON CONFLICT(registration,asset) DO UPDATE SET revision=excluded.revision,
          input_state=excluded.input_state,updated=excluded.updated
        `),
        clearFailure: db.prepare('DELETE FROM raster_failures WHERE registration = ? AND asset = ?'),
        trimFailures: db.prepare(`
          DELETE FROM raster_failures WHERE (registration,asset) IN (
            SELECT registration,asset FROM raster_failures ORDER BY updated DESC LIMIT -1 OFFSET ?
          )
        `),
      };
      this.#db = db;
    } catch (error) { db.close(); throw error; }
  }

  async close() {
    this.cancel();
    await this.#pending;
    this.#ocr.close();
    this.#db?.close();
    this.#db = null;
  }

  status() { return this.#active ? { ...this.#active } : null; }

  #send(force = false) {
    const now = Date.now();
    if (!force && now - this.#lastEvent < 150) return;
    this.#lastEvent = now;
    try { this.#notify?.(this.status()); } catch { /* Analysis is independent of UI feedback. */ }
  }

  start(references, { ocr = false, retryFailures = true } = {}) {
    if (!this.#db) throw new Error('无法读取本机图片索引。');
    if (this.#active?.status === 'running') return this.status();
    const items = referenceList(references);
    if (items.length === 0) throw new Error('没有可分析的图片。');
    const job = { jobId: randomUUID(), status: 'running', ocr: ocr === true, total: items.length,
      processed: 0, indexed: 0, skipped: 0, failed: 0, ocrFailed: 0 };
    this.#active = job;
    this.#controller = new AbortController();
    this.#send(true);
    this.#pending = this.#run(items, job, this.#controller.signal, retryFailures);
    return this.status();
  }

  cancel(jobId) {
    if (this.#active?.status === 'running' && (jobId == null || jobId === this.#active.jobId)) {
      this.#controller.abort();
    }
    return this.status();
  }

  #read(reference) {
    return this.#statements?.read.get(reference.registrationId, reference.assetId, reference.revision) ?? null;
  }

  #failed(reference) {
    return Boolean(this.#statements.readFailure.get(reference.registrationId, reference.assetId, reference.revision, reference.inputState));
  }

  lookup(references, { includeSignatures = false, includeFailures = false } = {}) {
    if (!this.#db) return [];
    return referenceList(references, true).flatMap(reference => {
      const row = this.#read(reference);
      if (!row && includeFailures && this.#failed(reference)) {
        return [{ registrationId: reference.registrationId, assetId: reference.assetId,
          revision: reference.revision, analysisStatus: 'failed' }];
      }
      return row ? [{ registrationId: reference.registrationId, assetId: reference.assetId,
        revision: reference.revision, primaryColor: row.color, palette: JSON.parse(row.palette),
        ...(includeSignatures ? { previewHash: row.preview_hash, visualHash: row.hash, flat: Boolean(row.flat), aspect: row.aspect }
          : { text: row.text, ocrStatus: row.ocr }) }] : [];
    });
  }

  similar(reference, references, { limit = 60, threshold = 12, exactOnly = false } = {}) {
    const origin = checkedReference(reference);
    if (!this.#db) return [];
    const source = this.#read(origin);
    if (!source) return [];
    const maxDistance = Number.isFinite(threshold) ? Math.min(24, Math.max(0, Math.floor(threshold))) : 12;
    const maxCount = Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.floor(limit))) : 60;
    const matches = [];
    for (const candidate of referenceList(references)) {
      if (candidate.registrationId === origin.registrationId && candidate.assetId === origin.assetId) continue;
      const found = this.#read(candidate);
      if (!found) continue;
      const contentHash = origin.contentHash ?? source.content_hash;
      const exact = !!(contentHash && contentHash === (candidate.contentHash ?? found.content_hash));
      const samePreview = source.preview_hash === found.preview_hash;
      if (exactOnly && !exact && !samePreview) continue;
      const distance = hamming(source.hash, found.hash);
      const color = rgbDistance(source.color, found.color);
      const aspectDelta = Math.abs(Math.log(source.aspect / found.aspect));
      if (!exact && !samePreview && (distance > maxDistance || aspectDelta > 0.5 ||
          Boolean(source.flat) !== Boolean(found.flat) || (source.flat && color > 42))) continue;
      matches.push({ registrationId: candidate.registrationId, assetId: candidate.assetId, revision: candidate.revision,
        distance, exact, samePreview, score: exact ? 1 : samePreview ? 0.999
          : Math.max(0, 1 - (distance / 64 + color / 1400 + aspectDelta / 8)) });
    }
    return matches.sort((left, right) => right.score - left.score).slice(0, maxCount);
  }

  async #run(items, job, signal, retryFailures) {
    try {
      for (const ref of items) {
        if (signal.aborted) break;
        await nextFrame();
        if (signal.aborted) break;
        const prior = this.#read(ref);
        const complete = prior && (!job.ocr || prior.ocr === 'done');
        const failed = !retryFailures && (prior ? prior.ocr === 'failed' : this.#failed(ref));
        if (complete || failed) {
          job.skipped++;
        } else {
          let raster;
          try {
            // Use the same analysis resolution regardless of the separate OCR pass.
            if (!prior) raster = analyzeRaster(await this.#image(ref, { ocr: false, signal }));
          }
          catch {
            if (signal.aborted) break;
            this.#statements.writeFailure.run(ref.registrationId, ref.assetId, ref.revision, ref.inputState, Date.now());
            job.failed++;
          }
          if ((prior || raster) && !signal.aborted) {
            let ocr = 'none';
            let text = '';
            if (job.ocr) {
              try {
                const input = readPNG(await this.#image(ref, { ocr: true, signal }));
                text = await this.#ocr.recognize(input, signal);
                ocr = 'done';
              }
              catch {
                if (signal.aborted) break;
                job.ocrFailed++;
                ocr = 'failed';
              }
            }
            // Enlarging a raster for OCR does not change an existing color or comparison result.
            const color = prior ? prior.color : raster.primaryColor;
            const palette = prior?.palette ?? JSON.stringify(raster.palette);
            this.#statements.write.run(ref.registrationId, ref.assetId, ref.revision, color, palette,
              prior?.hash ?? raster.visualHash, prior?.preview_hash ?? raster.previewHash, ref.contentHash ?? prior?.content_hash ?? null,
              prior?.flat ?? Number(raster.flat), prior?.aspect ?? (raster.width / raster.height), ocr, text, Date.now());
            if (raster) this.#statements.clearFailure.run(ref.registrationId, ref.assetId);
            job.indexed++;
            if (++this.#insertions % 500 === 0) this.#statements.trim.run(maxRows);
          }
        }
        if (signal.aborted) break;
        job.processed++;
        this.#send();
      }
      if (job.indexed) this.#statements.trim.run(maxRows);
      if (job.failed) this.#statements.trimFailures.run(maxRows);
      job.status = signal.aborted ? 'cancelled' : 'completed';
    } catch {
      job.status = signal.aborted ? 'cancelled' : 'failed';
      if (!signal.aborted) job.message = '未能保存本机图片索引，请检查可用空间。';
    } finally {
      this.#controller = null;
      this.#send(true);
    }
  }
}

module.exports = { VisualIndex };
