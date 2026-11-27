'use strict';

const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { OfflineWebStore, checkedReference } = require('../../offline-web.cjs');
const { publicImageURL, lookupImageHost } = require('../../dropped-image.cjs');

const channels = new Set([
  'offline-web:get', 'offline-web:remove', 'offline-web:open',
  'offline-web:capture-start', 'offline-web:capture-finish', 'offline-web:capture-cancel',
]);
const operationLifetime = 30_000;

function fetchPublicPage(address, { headers, signal }) {
  const url = publicImageURL(address);
  if (!url) throw new Error('离线阅读只保存公共网站的网页。');
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(url, {
      lookup: lookupImageHost, family: 4, agent: false, signal,
      headers: { ...headers, 'accept-encoding': 'identity' },
    }, response => {
      const encoding = response.headers['content-encoding'];
      if (encoding && encoding.toLowerCase() !== 'identity') {
        response.destroy();
        reject(new Error('无法读取此网页的压缩正文。'));
        return;
      }
      const status = response.statusCode;
      const fields = new Headers();
      for (const [name, values] of Object.entries(response.headers)) {
        if (typeof values === 'string') fields.set(name, values);
      }
      resolve({ status, ok: status >= 200 && status < 300, headers: fields, body: Readable.toWeb(response) });
    });
    request.on('error', reject);
  });
}

function linkFor(library, reference) {
  try {
    const { asset } = library.asset(reference.id, reference.registrationId);
    return asset.kind === 'link' ? { sourceURL: asset.sourceURL, name: asset.name } : null;
  } catch {
    return null;
  }
}

function captureResult(result) {
  if (result.error) throw result.error;
  return result.snapshot;
}

class OfflineService {
  #store;
  #jobs = new Map();
  #removals = new Map();
  #closed = false;

  constructor(library, {
    production = false,
    fetchPage = fetchPublicPage,
    legacyDirectory = production ? path.join(path.dirname(library.profile), '见藏', 'offline-web-v1') : null,
  } = {}) {
    this.#store = new OfflineWebStore({
      directory: path.join(library.profile, 'offline-web-v1'),
      legacyDirectory, getLink: reference => linkFor(library, reference), fetchPage,
    });
  }

  static handles(name) {
    return channels.has(name);
  }

  async command(name, args) {
    if (this.#closed) throw new Error('见藏正在退出。');
    const [first, second] = args;
    switch (name) {
      case 'offline-web:get': return this.#store.lookup(first);
      case 'offline-web:remove': return this.#remove(first);
      case 'offline-web:open': {
        const url = await this.#store.allowsOpen(first, second);
        if (!publicImageURL(url)) throw new Error('此链接不是可打开的公共网页。');
        return { url };
      }
      case 'offline-web:capture-start': return this.#start(first);
      case 'offline-web:capture-finish': return this.#finish(first, second);
      case 'offline-web:capture-cancel': return this.#cancel(first);
      default: throw new Error('未找到此离线网页操作。');
    }
  }

  #start(input) {
    const reference = checkedReference(input);
    const key = `${reference.registrationId}:${reference.id}`;
    if (this.#removals.has(key) || this.#jobs.size >= 4 || [...this.#jobs.values()].some(job => job.key === key)) {
      throw new Error('网页正在保存，请稍后重试。');
    }
    const token = randomUUID();
    const controller = new AbortController();
    const ready = Promise.withResolvers();
    const job = { key, controller, result: null, publish: null };
    this.#jobs.set(token, job);
    const expire = setTimeout(() => controller.abort(new Error('网页正文处理超时，请重试。')), operationLifetime);
    expire.unref();

    job.result = this.#store.capture(reference, {
      signal: controller.signal,
      extract: (html, finalURL) => {
        controller.signal.throwIfAborted();
        const extraction = Promise.withResolvers();
        const abandon = () => extraction.reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abandon, { once: true });
        job.publish = extraction.resolve;
        ready.resolve({ token, html, finalURL });
        return extraction.promise.finally(() => controller.signal.removeEventListener('abort', abandon));
      },
    }).then(snapshot => ({ snapshot }), error => ({ error })).finally(() => {
      clearTimeout(expire);
      this.#jobs.delete(token);
    });
    return Promise.race([ready.promise, job.result]).then(result => {
      if (result.error) throw result.error;
      return result;
    });
  }

  async #finish(token, extraction) {
    const job = this.#jobs.get(token);
    if (!job?.publish) throw new Error('网页正文保存任务已结束，请重试。');
    job.publish(extraction);
    return captureResult(await job.result);
  }

  async #cancel(token) {
    const job = this.#jobs.get(token);
    if (job) {
      job.controller.abort(new Error('已取消保存网页。'));
      await job.result;
    }
    return { ok: true };
  }

  #remove(input) {
    const reference = checkedReference(input);
    const key = `${reference.registrationId}:${reference.id}`;
    const active = this.#removals.get(key);
    if (active) return active;
    const pending = this.#store.remove(reference).finally(() => this.#removals.delete(key));
    this.#removals.set(key, pending);
    return pending;
  }

  async close() {
    this.#closed = true;
    const tasks = [...this.#jobs.values()].map(job => {
      job.controller.abort(new Error('见藏正在退出。'));
      return job.result;
    });
    await Promise.allSettled([...tasks, ...this.#removals.values()]);
  }
}

module.exports = { OfflineService };
