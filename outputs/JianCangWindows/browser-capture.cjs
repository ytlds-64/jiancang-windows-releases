'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { domainToASCII } = require('node:url');
const { inlineImage, imageFilename, imageExtension, maximumImageBytes, publicImageURL } = require('./dropped-image.cjs');
const { imageDimensions } = require('./image-dimensions.cjs');
const { importErrorMessage } = require('./local-import-queue.cjs');
const { webURL } = require('./local-workflow.cjs');

const capturePort = 47181;
const extensionOrigin = 'chrome-extension://ffjckdkohemfaljccoclgbonjhcpiodm';
const extensionFiles = ['manifest.json', 'background.js', 'collector.js', 'options.html', 'options.js', 'options.css', 'icon.png',
  'capture-audio.html', 'capture-audio.js', 'capture-success.wav'];
const maximumCaptureRequest = Math.ceil(maximumImageBytes / 3) * 4 + 16 * 1024;
const approvalTimeout = 90_000;
const declinedRequestDelay = 8000;
const maxBrowsers = 8;
const maxConcurrentCaptures = 4;
const captureRetention = 10 * 60_000;
const maxCaptureResults = 128;
const captureHistoryLimit = 200;
const maximumRules = 48;
const maximumRuleTags = 32;
const routeRequestLimit = 64 * 1024;
const captureRequestId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const captureKinds = new Set(['image', 'page', 'link']);
const captureImageFormats = new Set(['jpg', 'png', 'gif', 'webp', 'bmp', 'avif']);
const socialHosts = /^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/i;
const postPath = /^\/(?:[a-z\d_]+\/status|i\/web\/status)\/\d+(?:\/|$)/i;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function atomicWrite(file, data) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function prepareBrowserExtension(bundled, directory) {
  const assets = await Promise.all(extensionFiles.map(async name => [name, await fs.readFile(path.join(bundled, name))]));
  await fs.mkdir(directory, { recursive: true });
  // Update the manifest after the scripts it references are in place.
  assets.push(assets.shift());
  for (const [name, bytes] of assets) await atomicWrite(path.join(directory, name), bytes);
  return directory;
}

async function refreshBrowserExtension(bundled, directory) {
  const installed = await fs.lstat(directory).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!installed?.isDirectory()) return;
  const existing = await fs.readFile(path.join(directory, 'manifest.json')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!existing) return;
  const current = await fs.readFile(path.join(bundled, 'manifest.json'));
  if (!existing.equals(current)) await prepareBrowserExtension(bundled, directory);
}

function targetShape(value) {
  const isId = id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id);
  if (!isId(value?.targetId) || !isId(value.libraryId) || (value.collectionId != null && !isId(value.collectionId))) {
    throw new Error('请选择有效的采集素材库和集合。');
  }
  return { targetId: value.targetId, libraryId: value.libraryId, collectionId: value.collectionId ?? null };
}

function collectionShape({ id, name, parentId }) {
  return { id, name, parentId: parentId ?? null };
}

function ruleText(value, limit, message) {
  if (typeof value !== 'string' || value.length > limit * 2 || /[\p{Cc}\p{Cs}]/u.test(value)) throw new Error(message);
  const text = value.trim().normalize('NFC');
  if (Array.from(text).length > limit) throw new Error(message);
  return text;
}

function ruleDomain(value) {
  const message = '网站域名只填写主机名，例如 example.com。';
  const text = ruleText(value, 253, message).replace(/^\*\./, '').replace(/\.$/, '');
  if (!text) return '';
  if (!/^[\p{L}\p{M}\p{N}.-]+$/u.test(text)) throw new Error(message);
  const domain = domainToASCII(text);
  if (domain.length > 253 || !domain.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) {
    throw new Error(message);
  }
  return domain.toLowerCase();
}

function ruleTags(values) {
  const message = '规则最多包含 ' + maximumRuleTags + ' 个标签，每个标签最长 128 个字符。';
  if (!Array.isArray(values) || values.length > maximumRuleTags) throw new Error(message);
  const tags = new Map();
  for (const value of values) {
    const tag = ruleText(value, 128, message);
    if (tag && !tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
  }
  return [...tags.values()];
}

function ruleShape(value) {
  const name = ruleText(value?.name, 80, '请输入最多 80 个字符的规则名称。');
  if (!name || !captureRequestId.test(value.id ?? '') || typeof value.enabled !== 'boolean') {
    throw new Error('规则名称或状态无效。');
  }
  const domain = ruleDomain(value.domain ?? '');
  const keyword = ruleText(value.keyword ?? '', 256, '网址关键词最多包含 256 个字符。');
  const kind = value.kind;
  if (kind !== 'any' && !captureKinds.has(kind) && !captureImageFormats.has(kind)) throw new Error('请选择要匹配的采集类型。');
  if (!domain && !keyword && kind === 'any') throw new Error('请设置网站域名、网址关键词或采集类型。');
  return { id: value.id, name, enabled: value.enabled, domain, keyword, kind, target: targetShape(value.target),
    tags: ruleTags(value.tags ?? []) };
}

function originalImagePage(payload) {
  const page = URL.parse(webURL(payload.pageURL) ?? '');
  const link = URL.parse(webURL(payload.sourceLink) ?? '');
  const original = webURL(payload.url);
  if (!page) return null;
  if (socialHosts.test(page.hostname)) {
    if (link && socialHosts.test(link.hostname) && postPath.test(link.pathname)) return link.href;
    if (postPath.test(page.pathname)) return page.href;
    return null;
  }
  if (link?.origin === page.origin && link.pathname !== '/' && link.href !== original) return link.href;
  return page.href === original ? null : page.href;
}

function imageSourceURL(payload) {
  return originalImagePage(payload) ?? webURL(payload.url) ?? webURL(payload.pageURL) ?? undefined;
}

function browserImageAddress(payload) {
  const requested = webURL(payload.url);
  if (!requested) return null;
  const resolved = webURL(payload.resolvedImageURL);
  return resolved && new URL(resolved).origin === new URL(requested).origin ? resolved : requested;
}

function routeAddresses(payload) {
  return [...new Set([webURL(payload.pageURL), payload.kind === 'image' && originalImagePage(payload), webURL(payload.url)]
    .filter(Boolean))].map(href => {
    const host = new URL(href).hostname.replace(/\.$/, '');
    let decoded = href;
    try { decoded = decodeURIComponent(href); } catch { /* Some addresses contain literal escape characters. */ }
    return { host, urls: [href.toLowerCase(), decoded.normalize('NFC').toLowerCase()] };
  });
}

function matchingRule(rules, payload) {
  if (!rules.length) return undefined;
  const addresses = routeAddresses(payload);
  const image = payload.kind === 'image' && URL.parse(webURL(payload.url) ?? '');
  const format = [image ? image.searchParams.get('format') : null, image ? /\.([a-z\d]+)$/i.exec(image.pathname)?.[1] : null]
    .map(value => value?.toLowerCase().replace(/^jpeg$/, 'jpg')).find(value => captureImageFormats.has(value));
  return rules.find(({ enabled, domain, keyword, kind }) => enabled && (kind === 'any' || kind === payload.kind || kind === format) &&
    (!domain || addresses.some(({ host }) => host === domain || host.endsWith('.' + domain))) &&
    (!keyword || addresses.some(({ urls }) => urls.some(url => url.includes(keyword.toLowerCase())))));
}

function sameTarget(left, right) {
  return left.targetId === right.targetId && left.libraryId === right.libraryId && left.collectionId === right.collectionId;
}

function savedCapture({ assetId, target, destination, ruleName, tags }) {
  return { ok: true, assetId, target, ...(destination && { destination }), ...(ruleName && { ruleName, tags }),
    message: destination ? '已保存到「' + destination + '」。' : '已保存到见藏。' };
}

function historyRecord(value) {
  const { id, assetId, kind, capturedAt, width, height } = value ?? {};
  if (!/^[a-f0-9]{32}$/.test(id ?? '') || !/^[a-f0-9]{64}$/.test(assetId ?? '') ||
      !['image', 'page', 'link'].includes(kind) || !Number.isFinite(capturedAt) || Number.isNaN(new Date(capturedAt).valueOf())) return null;
  let target;
  try { target = targetShape(value.target); }
  catch { return null; }
  const size = kind === 'image' && [width, height].every(dimension => Number.isSafeInteger(dimension) && dimension > 0);
  const label = (text, limit) => typeof text === 'string' ? Array.from(text).slice(0, limit).join('') : '';
  const ruleName = label(value.ruleName, 80);
  let tags;
  try { tags = ruleTags(value.tags ?? []); } catch { tags = []; }
  return { id, assetId, kind, capturedAt, target, title: label(value.title, 512), destination: label(value.destination, 768),
    originalURL: webURL(value.originalURL), imageURL: kind === 'image' ? webURL(value.imageURL) : null,
    width: size ? width : null, height: size ? height : null, ...(ruleName && { ruleName, tags }),
    ...(/^[a-f0-9]{64}$/.test(value.receiptKey ?? '') && { receiptKey: value.receiptKey }) };
}

function captureSource(payload) {
  if (['page', 'link'].includes(payload?.kind)) {
    const url = webURL(payload.url);
    if (!url) throw new Error('只能采集 HTTP 或 HTTPS 网页。');
    return { kind: 'url', url, name: typeof payload.title === 'string' ? payload.title.slice(0, 512) : undefined };
  }
  if (payload?.kind === 'image') {
    const sourceURL = imageSourceURL(payload);
    const photo = payload.imageData ?? (typeof payload.url === 'string' && payload.url.startsWith('data:') ? payload.url : undefined);
    if (photo !== undefined) {
      const bytes = inlineImage(photo);
      if (!bytes) throw new Error('此图片格式暂不支持，或图片超过 32 MB。');
      const original = webURL(payload.url);
      const filename = original ? new URL(original).pathname.split('/').at(-1) : '浏览器采集';
      let name = filename;
      try { name = decodeURIComponent(filename); } catch {}
      return { kind: 'buffer', bytes, name: imageFilename(name || '浏览器采集', imageExtension(bytes)), sourceURL };
    }
    const url = publicImageURL(payload.url);
    if (!url) throw new Error('无法读取这个图片地址，请先在浏览器保存图片。');
    return { kind: 'image-url', url: url.href, sourceURL };
  }
  throw new Error('请选择网页、链接或图片。');
}

class CaptureRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readRequest(request, limit) {
  const declared = request.headers['content-length'];
  if (declared != null && Number(declared) > limit) throw new CaptureRequestError(413, '采集内容超过大小限制。');
  const chunks = [];
  let size = 0;
  // Do not destroy the connection before sending the error for an oversized body.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new CaptureRequestError(413, '采集内容超过大小限制。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new CaptureRequestError(400, '采集请求格式无效。'); }
}

class BrowserCapture {
  #target = null;
  #awaitingDefault = false;
  #tokens = [];
  #connecting = null;
  #blockedUntil = 0;
  #server;
  #error = '';
  #pending = Promise.resolve();
  #receiving = 0;
  #captures = new Map();
  #activeCaptures = 0;
  #history = new Map();
  #historyError = '';
  #rules = [];
  #rulesError = '';

  constructor({ settingsFile, resolveTarget, defaultTarget, listLibraries, createCollection, approveConnection, importAsset,
    onHistoryChanged, port = capturePort, now = Date.now, captureWait = 1500 }) {
    Object.assign(this, { settingsFile, resolveTarget, defaultTarget, listLibraries, createCollection, approveConnection, importAsset,
      onHistoryChanged, port, now, captureWait });
    this.historyFile = settingsFile.replace(/(?:\.json)?$/, '-history.json');
    this.rulesFile = settingsFile.replace(/(?:\.json)?$/, '-rules.json');
  }

  async initialize() {
    await Promise.all([this.#loadHistory(), this.#loadRules()]);
    let stored;
    try { stored = JSON.parse(await fs.readFile(this.settingsFile, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') {
        this.#awaitingDefault = Boolean(this.defaultTarget);
        await this.enableDefault();
      } else {
        this.#error = '无法读取采集设置，请重新选择目标并启用。';
      }
      return;
    }
    if (!stored?.target) return;
    try { this.#target = targetShape(stored.target); }
    catch {
      this.#error = '采集目标无效，请重新选择。';
      return;
    }
    this.#tokens = Array.isArray(stored.tokens) ? stored.tokens.filter(value =>
      typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)).slice(0, maxBrowsers) : [];
    try { await this.#listen(); } catch {}
  }

  status() {
    return { ok: true, enabled: Boolean(this.#target && this.#server), target: this.#target,
      awaitingDefault: this.#awaitingDefault, paired: this.#tokens.length, message: this.#error,
      rules: structuredClone(this.#rules), rulesMessage: this.#rulesError, maximumRules };
  }

  history() {
    const records = [...this.#history.values()].reverse().map(({ receiptKey, ...record }) => record);
    return { ok: true, records, limit: captureHistoryLimit, message: this.#historyError };
  }

  historyAddress(id, field) {
    const record = this.#history.get(id);
    if (field !== 'originalURL' && field !== 'imageURL') return null;
    return record?.[field] ?? null;
  }

  async #loadHistory() {
    try {
      const stored = JSON.parse(await fs.readFile(this.historyFile, 'utf8'));
      if (!Array.isArray(stored)) throw new Error('Invalid history');
      for (const value of stored.slice(-captureHistoryLimit)) {
        const record = historyRecord(value);
        if (record) this.#history.set(record.id, record);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.#historyError = '无法读取以前的采集历史。';
    }
  }

  async #loadRules() {
    try {
      const stored = JSON.parse(await fs.readFile(this.rulesFile, 'utf8'));
      if (!Array.isArray(stored) || stored.length > maximumRules) throw new Error('Invalid capture rules');
      this.#rules = stored.map(ruleShape);
      if (new Set(this.#rules.map(rule => rule.id)).size !== this.#rules.length) throw new Error('Duplicate capture rules');
    } catch (error) {
      this.#rules = [];
      if (error.code !== 'ENOENT') this.#rulesError = '无法读取以前的自动归档规则。';
    }
  }

  async #saveRules(rules) {
    await fs.mkdir(path.dirname(this.rulesFile), { recursive: true });
    await atomicWrite(this.rulesFile, JSON.stringify(rules));
    this.#rules = rules;
    this.#rulesError = '';
    return this.status();
  }

  saveRule(selection) {
    return this.#exclusive(async () => {
      const index = selection?.id == null ? this.#rules.length : this.#rules.findIndex(rule => rule.id === selection.id);
      if (index < 0) throw new Error('规则已变化，请重新打开设置。');
      if (index >= maximumRules) throw new Error('最多可以添加 ' + maximumRules + ' 条自动归档规则。');
      const target = await this.#currentTarget(targetShape(selection?.target));
      const rule = ruleShape({ ...selection, id: selection?.id ?? randomUUID(), target });
      const rules = [...this.#rules];
      rules[index] = rule;
      return this.#saveRules(rules);
    });
  }

  changeRule(id, action) {
    return this.#exclusive(async () => {
      const index = this.#rules.findIndex(rule => rule.id === id);
      if (index < 0) throw new Error('规则已变化，请重新打开设置。');
      const rules = [...this.#rules];
      if (action === 'remove') rules.splice(index, 1);
      else if (action === 'toggle') rules[index] = { ...rules[index], enabled: !rules[index].enabled };
      else {
        const destination = index + (action === 'up' ? -1 : action === 'down' ? 1 : 0);
        if (destination === index || destination < 0 || destination >= rules.length) throw new Error('无法移动此规则。');
        [rules[index], rules[destination]] = [rules[destination], rules[index]];
      }
      return this.#saveRules(rules);
    });
  }

  #recordCapture(value) {
    return this.#exclusive(async () => {
      const record = historyRecord(value);
      if (!record || this.#history.has(record.id)) return;
      this.#history.set(record.id, record);
      if (this.#history.size > captureHistoryLimit) this.#history.delete(this.#history.keys().next().value);
      try {
        await atomicWrite(this.historyFile, JSON.stringify([...this.#history.values()]));
        this.#historyError = '';
      } catch {
        this.#historyError = '素材已保存，但采集历史暂时无法写入磁盘。';
      }
      this.onHistoryChanged?.();
    });
  }

  #exclusive(operation) {
    const next = this.#pending.then(operation);
    this.#pending = next.catch(() => {});
    return next;
  }

  async #save(target, tokens) {
    await fs.mkdir(path.dirname(this.settingsFile), { recursive: true });
    await atomicWrite(this.settingsFile, JSON.stringify({ target, tokens }));
    this.#target = target;
    this.#tokens = tokens;
    this.#awaitingDefault = false;
  }

  async #configure(selection) {
    const target = targetShape(await this.resolveTarget(selection));
    await this.#listen();
    try { await this.#save(target, this.#tokens); }
    catch (error) {
      if (!this.#target) await this.close();
      throw error;
    }
    this.#error = '';
    return this.status();
  }

  enableDefault() {
    if (!this.#awaitingDefault) return;
    return this.#exclusive(async () => {
      if (!this.#awaitingDefault) return;
      const selection = this.defaultTarget();
      if (!selection) return;
      try { await this.#configure(selection); }
      catch (error) { this.#error = error.message; }
    });
  }

  configure(selection) {
    return this.#exclusive(() => this.#configure(selection));
  }

  disconnect(disable = false) {
    return this.#exclusive(async () => {
      await this.#save(disable ? null : this.#target, []);
      this.#connecting?.abort();
      this.#blockedUntil = 0;
      this.#captures.clear();
      this.#error = '';
      if (disable) await this.close();
      return this.status();
    });
  }

  async #listen() {
    if (this.#server) return;
    const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 15_000,
      connectionsCheckingInterval: 1000, keepAliveTimeout: 1000 }, (req, res) => void this.#request(req, res));
    server.maxConnections = 16;
    server.setTimeout(15_000, socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch {
      this.#error = `本机端口 ${this.port} 暂不可用。关闭占用该端口的程序后重试。`;
      throw new Error(this.#error);
    }
    this.#server = server;
  }

  async close() {
    this.#connecting?.abort();
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }

  async #connect(request, response) {
    if (response.destroyed) return;
    if (this.#connecting) throw new CaptureRequestError(409, '见藏正等待确认上一条浏览器连接请求。');
    if (this.#blockedUntil > this.now()) throw new CaptureRequestError(429, '请稍等几秒后重试连接。');
    if (this.#tokens.length >= maxBrowsers) {
      throw new CaptureRequestError(409, '已连接 8 个浏览器，请在见藏中解除连接后重试。');
    }
    const controller = new AbortController();
    this.#connecting = controller;
    const cancel = () => controller.abort();
    request.setTimeout(approvalTimeout + 5000);
    response.once('close', cancel);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(approvalTimeout)]);
    try {
      const approved = await this.approveConnection?.(signal);
      if (approved !== true || signal.aborted || response.destroyed) {
        throw new CaptureRequestError(403, '见藏没有批准这次浏览器连接。');
      }
      return await this.#exclusive(async () => {
        if (!this.#target || signal.aborted) throw new CaptureRequestError(403, '见藏没有批准这次浏览器连接。');
        const token = randomBytes(32).toString('base64url');
        try { await this.#save(this.#target, [...this.#tokens, digest(token)]); }
        catch { throw new CaptureRequestError(503, '见藏无法保存浏览器连接，请检查应用数据目录权限。'); }
        return { ok: true, token };
      });
    } catch (error) {
      this.#blockedUntil = this.now() + declinedRequestDelay;
      throw error;
    } finally {
      response.off('close', cancel);
      this.#connecting = null;
    }
  }

  #checkConnection(authorization) {
    if (!this.#target || !this.#authorized(authorization)) throw new CaptureRequestError(401, '请重新连接见藏。');
  }

  async #currentTarget(selection, options) {
    const configured = selection === undefined ? this.#target : targetShape(selection);
    const target = await this.resolveTarget(configured, options);
    if (target.targetId !== configured.targetId || target.libraryId !== configured.libraryId ||
        (target.collectionId ?? null) !== configured.collectionId) {
      throw new Error('目标素材库已变化，请在见藏中重新选择。');
    }
    return { ...configured, ...(target.destination && { destination: target.destination }) };
  }

  async #chooseRoute(payload) {
    if (this.#rulesError) throw new CaptureRequestError(409, this.#rulesError + '请在见藏中检查规则，或手动选择位置。');
    const rule = matchingRule(this.#rules, payload);
    try {
      const { destination, ...target } = await this.#currentTarget(rule?.target, { allowPending: true });
      return { target, destination, ...(rule && { ruleName: rule.name, tags: rule.tags }) };
    } catch (error) {
      const problem = importErrorMessage(error);
      throw new CaptureRequestError(409, rule ? '规则「' + rule.name + '」的位置不可用。' + problem : problem);
    }
  }

  #previewRoute(payload, authorization) {
    return this.#exclusive(async () => {
      this.#checkConnection(authorization);
      if (!captureKinds.has(payload?.kind)) throw new CaptureRequestError(400, '请选择有效的采集类型。');
      return { ok: true, ...await this.#chooseRoute(payload) };
    });
  }

  #targets(authorization) {
    return this.#exclusive(async () => {
      this.#checkConnection(authorization);
      const libraries = await this.listLibraries?.() ?? [];
      return { ok: true, target: this.#target, confirmedCapture: true, canRouteCapture: true, canCreate: typeof this.createCollection === 'function',
        libraries: libraries.map(({ targetId, libraryId, name, collections }) => ({
          targetId, libraryId, name, collections: collections.map(collectionShape),
        })) };
    });
  }

  #createCollection(payload, authorization) {
    return this.#exclusive(async () => {
      this.#checkConnection(authorization);
      if (typeof this.createCollection !== 'function') throw new CaptureRequestError(404, '见藏暂不支持在浏览器中创建集合。');
      const rawName = payload?.name;
      const name = typeof rawName === 'string' ? rawName.trim().normalize('NFC') : '';
      if (!name || /[\p{Cc}\p{Cs}]/u.test(name) || Array.from(name).length > 180 || !payload.target) {
        throw new CaptureRequestError(400, '请选择素材库并输入 1 到 180 个字符的集合名称。');
      }
      try {
        const target = await this.#currentTarget(payload.target);
        const collection = await this.createCollection(target, name);
        return { ok: true, collection: collectionShape(collection) };
      } catch (error) {
        const safe = error?.code ? '' : error?.message;
        throw new CaptureRequestError(409, safe || '无法新建集合，请在见藏中检查。');
      }
    });
  }

  #authorized(authorization) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    if (!match) return false;
    const provided = Buffer.from(digest(match[1]), 'hex');
    return this.#tokens.some(token => timingSafeEqual(provided, Buffer.from(token, 'hex')));
  }

  #captureKey(requestId, authorization) {
    if (typeof requestId !== 'string' || !captureRequestId.test(requestId)) {
      throw new CaptureRequestError(400, '浏览器采集标识无效，请重新拖入。');
    }
    return digest(authorization + ':' + requestId.toLowerCase());
  }

  #pruneCaptures() {
    const cutoff = this.now() - captureRetention;
    for (const [key, entry] of this.#captures) {
      if (entry.result && (entry.finished < cutoff || this.#captures.size > maxCaptureResults)) this.#captures.delete(key);
    }
  }

  #captureStatus(requestId, authorization) {
    this.#checkConnection(authorization);
    const key = this.#captureKey(requestId, authorization);
    this.#pruneCaptures();
    const entry = this.#captures.get(key);
    if (!entry) throw new CaptureRequestError(404, '未找到这次采集，可以安全重试。');
    return this.#captureResult(entry);
  }

  #captureResult(entry) {
    if (!entry.result) return { ok: true, pending: true, requestId: entry.requestId };
    if (!entry.result.ok) throw new CaptureRequestError(409, entry.result.message);
    return entry.result;
  }

  #startCapture(key, requestId, { target, destination, ruleName, tags }, source, provenance) {
    const previous = key && this.#captures.get(key);
    if (previous) {
      if (!sameTarget(previous.target, target)) {
        throw new CaptureRequestError(409, '本次采集的位置已变化。请重新拖入到新的位置。');
      }
      if (!previous.result || previous.result.ok) return previous;
    }
    if (this.#activeCaptures >= maxConcurrentCaptures) {
      throw new CaptureRequestError(429, '见藏正在保存其他图片，请稍后重试。');
    }
    const id = requestId === undefined ? randomBytes(16).toString('hex') :
      digest(JSON.stringify(['browser-capture', requestId.toLowerCase(), target.targetId, target.libraryId, target.collectionId])).slice(0, 32);
    const entry = { requestId, target, ruleName, tags, result: null, finished: null };
    this.#activeCaptures++;
    entry.operation = Promise.resolve().then(() => this.importAsset({ id, batchId: id,
      targetId: target.targetId, collectionId: target.collectionId, source: { ...source, targetLibraryId: target.libraryId },
      ...(tags?.length && { tags }),
    })).then(async ({ id: assetId, browserCapture }) => {
      if (!/^[a-f0-9]{64}$/.test(assetId ?? '')) throw new Error('无法确认素材已保存，请重试这次采集。');
      const [width, height] = browserCapture?.dimensions ?? (source.bytes ? imageDimensions(source.bytes) : []);
      await this.#recordCapture({ ...provenance, id, assetId, target, destination, ruleName, tags, receiptKey: key, capturedAt: this.now(),
        imageURL: browserCapture?.resolvedImageURL ?? provenance.imageURL,
        title: source.name ?? browserCapture?.filename ?? provenance.title, width, height });
      entry.result = savedCapture({ assetId, target, destination, ruleName, tags });
    }).catch(error => {
      const timedOut = error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT';
      entry.result = { ok: false, message: timedOut ? '读取图片超时，请在网页重新加载图片后重试。' : importErrorMessage(error) };
    }).finally(() => {
      this.#activeCaptures--;
      entry.finished = this.now();
      this.#pruneCaptures();
    });
    if (key) this.#captures.set(key, entry);
    return entry;
  }

  async #capture(payload, authorization) {
    let source;
    try { source = captureSource(payload); }
    catch (error) { throw new CaptureRequestError(400, error.message); }
    const image = payload.kind === 'image';
    const provenance = { kind: payload.kind, originalURL: image ? originalImagePage(payload) : source.url,
      imageURL: image && source.kind === 'buffer' ? browserImageAddress(payload) : null,
      title: image ? '' : new URL(source.url).hostname };
    const requestId = payload.requestId;
    const key = requestId === undefined ? null : this.#captureKey(requestId, authorization);
    const entry = await this.#exclusive(async () => {
      this.#checkConnection(authorization);
      this.#pruneCaptures();
      const previous = key && this.#captures.get(key);
      const automatic = payload.target === undefined;
      const receipt = key && !previous && [...this.#history.values()].find(record => record.receiptKey === key);
      try {
        if (receipt) {
          if (!automatic && !sameTarget(receipt.target, targetShape(payload.target))) {
            throw new Error('本次采集的位置已变化。请重新拖入到新的位置。');
          }
          return { result: savedCapture(receipt) };
        }
        if (automatic && previous && (!previous.result || previous.result.ok)) return previous;
        const selection = automatic && !previous ? await this.#chooseRoute(payload) : null;
        if (selection) return this.#startCapture(key, requestId, selection, source, provenance);
        const { destination, ...target } = await this.#currentTarget(automatic ? previous.target : payload.target, { allowPending: true });
        const route = automatic ? { ruleName: previous.ruleName, tags: previous.tags } : {};
        return this.#startCapture(key, requestId, { target, destination, ...route }, source, provenance);
      } catch (error) {
        if (error instanceof CaptureRequestError) throw error;
        throw new CaptureRequestError(409, importErrorMessage(error));
      }
    });
    if (!key || entry.result) await entry.operation;
    else {
      let timer;
      try { await Promise.race([entry.operation, new Promise(resolve => { timer = setTimeout(resolve, this.captureWait); })]); }
      finally { clearTimeout(timer); }
    }
    return this.#captureResult(entry);
  }

  async #request(request, response) {
    const respond = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        Connection: 'close', 'X-Content-Type-Options': 'nosniff' });
      response.end(body ? JSON.stringify(body) : undefined);
    };
    const port = this.#server?.address()?.port;
    if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== extensionOrigin) {
      respond(403, { ok: false, message: '请求来源无效。' });
      return;
    }
    response.setHeader('Access-Control-Allow-Origin', extensionOrigin);
    response.setHeader('Vary', 'Origin');
    const connect = request.url === '/v1/connect';
    const capture = request.url === '/v1/capture';
    const captureStatus = request.url === '/v1/capture-status';
    const targets = request.url === '/v1/targets';
    const route = request.url === '/v1/route';
    const collection = request.url === '/v1/collection';
    if (!connect && !capture && !captureStatus && !targets && !route && !collection) {
      return respond(404, { ok: false, message: '未找到此采集操作。' });
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'POST');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
      return respond(204);
    }
    if (request.method !== 'POST' || !/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) {
      return respond(415, { ok: false, message: '采集请求格式无效。' });
    }
    const authorization = request.headers.authorization;
    if (!this.#target || (!connect && !this.#authorized(authorization))) {
      return respond(401, { ok: false, message: '请先连接见藏。' });
    }
    if (this.#receiving >= 4) return respond(429, { ok: false, message: '采集请求较多，请稍后再试。' });
    this.#receiving++;
    try {
      const body = await readRequest(request, capture ? maximumCaptureRequest : route ? routeRequestLimit : 4096);
      let result;
      if (connect) result = await this.#connect(request, response);
      else if (targets) result = await this.#targets(authorization);
      else if (route) result = await this.#previewRoute(body, authorization);
      else if (collection) result = await this.#createCollection(body, authorization);
      else if (captureStatus) result = this.#captureStatus(body?.requestId, authorization);
      else {
        request.setTimeout(60_000);
        result = await this.#capture(body, authorization);
      }
      if (!response.destroyed) respond(result?.pending ? 202 : 200, result);
    } catch (error) {
      if (!response.destroyed) respond(error.status ?? 500, { ok: false,
        message: error.status ? error.message : '采集未完成，请在见藏中检查。' });
    } finally {
      this.#receiving--;
    }
  }
}

module.exports = { BrowserCapture, capturePort, extensionFiles, extensionOrigin, prepareBrowserExtension, refreshBrowserExtension,
  targetShape, ruleShape, historyRecord, maxBrowsers, maximumRules, captureHistoryLimit };
