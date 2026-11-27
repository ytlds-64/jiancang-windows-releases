'use strict';

const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const maximumNaturalSearchImages = 120;
const rankingBatchSize = 16;
const activePhases = new Set(['preparing', 'analyzing', 'ranking']);

function captionKey(profile, reference) {
  return createHash('sha256').update(JSON.stringify([
    1, profile.provider, profile.endpoint, profile.model, reference.registrationId, reference.assetId, reference.revision,
  ])).digest('hex');
}

class NaturalImageSearch {
  #job = null;
  #db = null;

  constructor({ directory, openService, getImage, currentReference, onChange }) {
    Object.assign(this, { directory, openService, getImage, currentReference, onChange });
  }

  #openCache() {
    mkdirSync(this.directory, { recursive: true });
    const db = new DatabaseSync(path.join(this.directory, 'captions.sqlite'));
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS caption (
        key TEXT PRIMARY KEY, description TEXT NOT NULL, updated INTEGER NOT NULL
      ) STRICT`);
    } catch (error) { db.close(); throw error; }
    return db;
  }

  status() {
    if (!this.#job) return null;
    const { id, query, phase, total, processed, ranked, cached, skipped, error, results } = this.#job;
    return { id, query, phase, total, processed, ranked, cached, skipped, error, results: [...results] };
  }

  #notify(job) {
    if (job === this.#job) this.onChange?.(this.status());
  }

  start(input, references, profile) {
    if (activePhases.has(this.#job?.phase)) throw new Error('请等待当前找图任务结束，或先停止任务。');
    if (typeof input !== 'string' || input.length > 240 || /[\p{Cc}\p{Cs}]/u.test(input) || !input.trim()) {
      throw new Error('请输入 1 至 240 个字符描述要找的图片。');
    }
    if (!Array.isArray(references) || !references.length || references.length > maximumNaturalSearchImages) {
      throw new Error(`请缩小范围至 1 至 ${maximumNaturalSearchImages} 张图片。`);
    }
    const scope = [...new Map(references.map(reference => [JSON.stringify([reference.registrationId, reference.assetId]), reference])).values()];
    const job = { id: randomUUID(), query: input.trim(), phase: 'preparing', total: scope.length, processed: 0, ranked: 0,
      cached: 0, skipped: 0, error: '', results: [], controller: new AbortController() };
    this.#job = job;
    this.#notify(job);
    void this.#search(job, scope, profile);
    return this.status();
  }

  cancel(id) {
    const job = this.#job;
    if (job?.id === id && activePhases.has(job.phase)) job.controller.abort();
    return this.status();
  }

  close() {
    this.#job?.controller.abort();
    this.#db?.close();
    this.#db = null;
  }

  async #search(job, scope, profile) {
    const { signal } = job.controller;
    let serviceSignal;
    try {
      const service = await this.openService(profile);
      signal.throwIfAborted();
      this.#db ??= this.#openCache();
      const find = this.#db.prepare('SELECT description FROM caption WHERE key = ?');
      const save = this.#db.prepare('INSERT OR REPLACE INTO caption (key, description, updated) VALUES (?, ?, ?)');
      const entries = [];
      let consecutiveFailures = 0;
      job.phase = 'analyzing';
      this.#notify(job);
      for (const reference of scope) {
        signal.throwIfAborted();
        if (!this.currentReference(reference)) {
          job.skipped++;
        } else {
          const key = captionKey(profile, reference);
          let description = find.get(key)?.description;
          if (description) job.cached++;
          else if (consecutiveFailures < 3) {
            serviceSignal = AbortSignal.any([signal, AbortSignal.timeout(service.timeout)]);
            let requestedDescription = false;
            try {
              const image = await this.getImage(reference, serviceSignal);
              serviceSignal.throwIfAborted();
              if (!this.currentReference(reference)) throw new Error('图片已变更，请重新查找。');
              requestedDescription = true;
              description = await service.describe(image, serviceSignal);
              serviceSignal.throwIfAborted();
              save.run(key, description, Date.now());
              consecutiveFailures = 0;
            } catch (error) {
              signal.throwIfAborted();
              description = null;
              job.error = serviceSignal.aborted ? '图片分析超时。' : error.message || '部分图片暂时无法分析。';
              if (requestedDescription) consecutiveFailures++;
            }
          }
          if (description) entries.push({ reference, description });
          else job.skipped++;
        }
        job.processed++;
        this.#notify(job);
      }
      if (!entries.length) throw new Error(job.error || '这些图片暂时无法分析。');
      this.#db.exec('DELETE FROM caption WHERE key IN (SELECT key FROM caption ORDER BY updated DESC LIMIT -1 OFFSET 12000)');
      job.phase = 'ranking';
      this.#notify(job);
      for (let offset = 0; offset < entries.length; offset += rankingBatchSize) {
        signal.throwIfAborted();
        const batch = entries.slice(offset, offset + rankingBatchSize).filter(({ reference }) => this.currentReference(reference));
        job.skipped += Math.min(rankingBatchSize, entries.length - offset) - batch.length;
        if (!batch.length) continue;
        serviceSignal = AbortSignal.any([signal, AbortSignal.timeout(service.timeout)]);
        const matches = await service.rank(job.query, batch.map(entry => entry.description), serviceSignal);
        serviceSignal.throwIfAborted();
        job.ranked += batch.length;
        for (const { index, score } of matches) {
          const { reference, description } = batch[index];
          if (this.currentReference(reference)) job.results.push({ reference, description, score });
        }
        job.results.sort((a, b) => b.score - a.score);
        this.#notify(job);
      }
      job.phase = 'completed';
    } catch (error) {
      job.phase = signal.aborted ? 'cancelled' : 'failed';
      job.error = signal.aborted ? '' : serviceSignal?.aborted ? 'AI 响应超时，请重试。' : error.message || '找图失败，请重试。';
    } finally { this.#notify(job); }
  }
}

module.exports = { NaturalImageSearch, maximumNaturalSearchImages };
