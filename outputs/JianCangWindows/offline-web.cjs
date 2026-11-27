'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { openContainedFile, readStableBytes } = require('./original-file.cjs');

const maximumPageBytes = 4 * 1024 ** 2;
const maximumSnapshotBytes = 2 * 1024 ** 2;
const maximumCharacters = 180_000;
const maximumBlocks = 480;
const maximumLinks = 90;
const redirects = new Set([301, 302, 303, 307, 308]);
const blockKinds = new Set(['heading', 'paragraph', 'quote', 'item', 'code']);
const registrationPattern = /^[a-f0-9-]{1,64}$/i;
const assetPattern = /^[a-f0-9]{64}$/;
const unsafeControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function checkedReference(reference) {
  const { registrationId, id } = reference || {};
  if (typeof registrationId !== 'string' || !registrationPattern.test(registrationId) ||
      typeof id !== 'string' || !assetPattern.test(id)) throw new Error('链接素材已变化，请重新打开。');
  return { registrationId, id };
}

function checkedURL(value, base) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value, base);
    return url.href.length <= 4096 && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function boundedText(value, size) {
  return typeof value === 'string' ? value.replace(unsafeControls, '').slice(0, size).trim() : '';
}

function validRedirect(previous, next) {
  // Keep redirects on the deliberately opened site, with ordinary www and HTTPS upgrades.
  const host = url => url.hostname.replace(/^www\./i, '');
  return host(previous) === host(next) && previous.port === next.port &&
    (previous.protocol === next.protocol || previous.protocol === 'http:' && next.protocol === 'https:');
}

async function pageText(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (declaredLength > maximumPageBytes) throw new Error('网页过大，无法保存离线正文。');
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let size = 0;
  const parts = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumPageBytes) throw new Error('网页过大，无法保存离线正文。');
      parts.push(Buffer.from(result.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts, size);
}

function decodePage(bytes, type) {
  const declared = /charset\s*=\s*["']?([a-z0-9._-]+)/i.exec(type)?.[1];
  const meta = /<meta\b[^>]{0,400}\bcharset\s*=\s*["']?([a-z0-9._-]+)/i.exec(bytes.subarray(0, 8192).toString('latin1'))?.[1];
  for (const charset of [declared, meta, 'utf-8']) {
    if (!charset) continue;
    try { return new TextDecoder(charset).decode(bytes); } catch { /* Some webpages provide an unknown charset. */ }
  }
  return bytes.toString('utf8');
}

async function readPage(source, fetchPage, signal) {
  let url = new URL(source.href);
  for (let count = 0; count <= 4; count++) {
    url.hash = '';
    let response;
    try {
      response = await fetchPage(url.href, {
        method: 'GET', credentials: 'omit', redirect: 'manual', signal,
        headers: { accept: 'text/html, application/xhtml+xml, text/plain;q=0.9' },
      });
    } catch (error) {
      if (signal.aborted) throw new Error('网页响应超时，请重试。');
      throw new Error('无法连接网页，请检查链接和网络后重试。', { cause: error });
    }
    try {
      if (redirects.has(response.status)) {
        const next = checkedURL(response.headers.get('location'), url);
        if (!next) throw new Error('网页跳转地址不可用。');
        if (count === 4) throw new Error('网页跳转次数过多。');
        if (!validRedirect(url, next)) throw new Error('网页跳转到了其他网站。请在浏览器打开链接，再收藏跳转后的地址。');
        url = next;
        continue;
      }
      if (!response.ok) throw new Error(`网页返回 HTTP ${response.status}，无法保存正文。`);
      const type = response.headers.get('content-type') || '';
      const mediaType = type.split(';')[0].trim().toLowerCase();
      if (mediaType && !['text/html', 'application/xhtml+xml', 'text/plain'].includes(mediaType)) {
        throw new Error('此链接没有可保存的网页正文。');
      }
      const body = await pageText(response);
      return { body: decodePage(body, type), url: url.href, isPlain: mediaType === 'text/plain' };
    } catch (error) {
      if (signal.aborted) throw new Error('网页响应超时，请重试。');
      if (error instanceof TypeError) throw new Error('网页读取中断，请重试。');
      throw error;
    } finally { await response.body?.cancel().catch(() => {}); }
  }
  throw new Error('无法读取网页正文。');
}

function normalizedContent(content, finalURL) {
  const blocks = [];
  let characters = 0;
  let truncated = content?.truncated === true;
  for (const row of Array.isArray(content?.blocks) ? content.blocks : []) {
    if (blocks.length >= maximumBlocks || characters >= maximumCharacters) { truncated = true; break; }
    if (!blockKinds.has(row?.kind)) continue;
    const budget = Math.min(24_000, maximumCharacters - characters);
    const value = boundedText(row.text, budget);
    if (!value) continue;
    if (row.text.length > budget) truncated = true;
    characters += value.length;
    blocks.push({ kind: row.kind, text: value, ...(row.kind === 'heading' && {
      level: Number.isInteger(row.level) ? Math.min(6, Math.max(1, row.level)) : 2,
    }) });
  }
  const links = [];
  const seen = new Set();
  for (const item of Array.isArray(content?.links) ? content.links : []) {
    if (links.length >= maximumLinks) break;
    const url = checkedURL(item?.url, finalURL)?.href;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ url, label: boundedText(item?.label, 280) || url });
  }
  return { title: boundedText(content?.title, 600), byline: boundedText(content?.byline, 300), blocks, links, truncated };
}

class OfflineWebStore {
  #running = new Map();
  #startup;

  constructor({ directory, legacyDirectory, getLink, extract, onChange, fetchPage = fetch }) {
    this.directory = path.resolve(directory);
    this.legacyDirectory = legacyDirectory ? path.resolve(legacyDirectory) : null;
    this.getLink = getLink;
    this.extract = extract;
    this.onChange = onChange;
    this.fetchPage = fetchPage;
  }

  initialize() {
    if (!this.#startup) this.#startup = this.#initialize();
    return this.#startup;
  }

  async #initialize() {
    await fs.mkdir(this.directory, { recursive: true });
    if (!(await fs.lstat(this.directory)).isDirectory()) throw new Error('无法打开离线网页目录。');
    this.directory = await fs.realpath(this.directory);
  }

  #file(reference) {
    const key = createHash('sha256').update(`${reference.registrationId}\0${reference.id}`).digest('hex');
    return path.join(this.directory, `${key}.json`);
  }

  async #source(reference) {
    const link = await this.getLink(reference);
    const source = checkedURL(link?.sourceURL);
    if (!source) throw new Error('当前素材没有可读取的 HTTP 或 HTTPS 链接。');
    return { source, name: boundedText(link.name, 600) };
  }

  async lookup(input) {
    await this.initialize();
    const reference = checkedReference(input);
    const { source } = await this.#source(reference);
    const file = this.#file(reference);
    const current = await this.#readSnapshot(this.directory, file, reference, source);
    return current ?? this.#lookupLegacy(file, reference, source);
  }

  async #lookupLegacy(file, reference, source) {
    if (!this.legacyDirectory) return null;
    try {
      if (await fs.lstat(`${file}.legacy-hidden`).then(() => true, error => {
        if (error.code !== 'ENOENT') throw error;
        return false;
      })) return null;
      const entry = await fs.lstat(this.legacyDirectory);
      const canonical = await fs.realpath(this.legacyDirectory);
      if (!entry.isDirectory() || entry.isSymbolicLink() || path.relative(this.legacyDirectory, canonical) !== '') return null;
      return await this.#readSnapshot(canonical, path.join(canonical, path.basename(file)), reference, source);
    } catch { return null; }
  }

  async #readSnapshot(directory, file, reference, source) {
    let handle;
    try { handle = await openContainedFile(directory, file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const { size } = await handle.stat();
      const bytes = await readStableBytes(handle, size, maximumSnapshotBytes);
      if (!bytes) throw new Error('离线副本无法读取，请更新副本。');
      let stored;
      try { stored = JSON.parse(bytes); }
      catch { throw new Error('离线副本无法读取，请更新副本。'); }
      if (stored?.version !== 1 || stored.registrationId !== reference.registrationId || stored.id !== reference.id ||
          stored.sourceURL !== source.href) return null;
      const finalURL = checkedURL(stored.finalURL);
      if (!finalURL || !validRedirect(source, finalURL) || !Number.isSafeInteger(stored.capturedAt) ||
          !Number.isFinite(new Date(stored.capturedAt).valueOf())) return null;
      const content = normalizedContent(stored, finalURL);
      if (!content.blocks.length) return null;
      return { version: 1, ...reference, sourceURL: source.href, finalURL: finalURL.href, capturedAt: stored.capturedAt, ...content };
    } finally { await handle.close(); }
  }

  async capture(input, { extract = this.extract, signal } = {}) {
    await this.initialize();
    const reference = checkedReference(input);
    const target = this.#file(reference);
    if (this.#running.has(target)) return this.#running.get(target);
    if (this.#running.size >= 4) throw new Error('正在保存其他网页，请稍后重试。');
    const pending = this.#capture(reference, target, extract, signal).finally(() => this.#running.delete(target));
    this.#running.set(target, pending);
    return pending;
  }

  async #capture(reference, target, extract, signal) {
    signal?.throwIfAborted();
    const { source, name } = await this.#source(reference);
    const timeout = AbortSignal.timeout(17_000);
    const { body, url, isPlain } = await readPage(source, this.fetchPage, signal ? AbortSignal.any([signal, timeout]) : timeout);
    signal?.throwIfAborted();
    const extracted = isPlain ? {
      blocks: body.split(/\r?\n(?:[ \t]*\r?\n)+/).map(text => ({ kind: 'paragraph', text })),
    } : await extract(body, url);
    signal?.throwIfAborted();
    const content = normalizedContent(extracted, url);
    if (!content.blocks.length) throw new Error('网页中没有可保存的正文。部分网页需要登录或运行脚本。');
    if ((await this.#source(reference)).source.href !== source.href) throw new Error('素材链接已修改，请重新打开后再保存。');
    const snapshot = {
      version: 1, ...reference, sourceURL: source.href, finalURL: url, capturedAt: Date.now(),
      ...content, title: content.title || name || source.hostname,
    };
    const json = JSON.stringify(snapshot);
    if (Buffer.byteLength(json) > maximumSnapshotBytes) throw new Error('网页正文过长，无法保存离线副本。');
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, json, { flag: 'wx', mode: 0o600 });
      signal?.throwIfAborted();
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
    this.#notify(reference);
    return snapshot;
  }

  async remove(input) {
    await this.initialize();
    const reference = checkedReference(input);
    await this.#source(reference);
    const target = this.#file(reference);
    if (this.#running.has(target)) throw new Error('网页正在保存，完成后可移除副本。');
    if (this.legacyDirectory) {
      // Suppress any older copy without deleting or modifying the previous installation's data.
      await fs.writeFile(`${target}.legacy-hidden`, '1', { flag: 'wx', mode: 0o600 }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    await fs.rm(target, { force: true });
    this.#notify(reference);
    return { ok: true };
  }

  async allowsOpen(input, value) {
    const reference = checkedReference(input);
    const candidate = checkedURL(value);
    if (!candidate) throw new Error('此链接无法在浏览器中打开。');
    const { source } = await this.#source(reference);
    if (source.href === candidate.href) return candidate.href;
    const saved = await this.lookup(reference);
    if (saved && (saved.finalURL === candidate.href || saved.links.some(link => link.url === candidate.href))) return candidate.href;
    throw new Error('此链接不在已保存的网页中，请刷新离线副本。');
  }

  #notify(reference) {
    try { this.onChange?.(reference); } catch { /* A notification cannot change the result of an on-disk operation. */ }
  }
}

module.exports = { OfflineWebStore, checkedReference };
