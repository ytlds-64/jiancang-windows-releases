'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const libraryPattern = /^[a-f0-9-]{1,64}$/i;
const assetPattern = /^[a-f0-9]{64}$/;
const statuses = new Set(['all', 'pending', 'running', 'failed', 'done']);
const libraryLimit = 100_000;
const queueLimit = 300_000;
const pageLimit = 100;

const failureMessages = new Map([
  ['MISSING', '原件路径尚未出现。请等待 iCloud Drive 同步后重试。'],
  ['PATH_CHANGED', '原件路径在读取时发生变化。请刷新素材库后重试。'],
  ['INVALID_INPUT', '原件记录无效。请刷新素材库后重试。'],
  ['INCOMPLETE', '原件字节未取齐。请等待 iCloud Drive 后重试。'],
  ['CHECKSUM', '原件内容与库记录不一致。请等 iCloud Drive 同步完成后重试。'],
  ['ACCESS', '暂时无法访问原件。请检查素材库权限后重试。'],
  ['PROVIDER', 'iCloud Drive 暂未提供原件。请检查同步状态后重试。'],
  ['DISK_SPACE', '磁盘空间不足。请释放空间后重试。'],
  ['TIMEOUT', '取回原件耗时过长。请检查 iCloud Drive 是否在运行后重试。'],
  ['LIBRARY_CHANGED', '素材库位置或身份已变化。请重新连接正确的素材库。'],
  ['ASSET_CHANGED', '素材记录已变化。请刷新素材库后重试。'],
]);

const systemErrors = new Map([
  ['ENOENT', 'MISSING'], ['ENOTDIR', 'MISSING'],
  ['EACCES', 'ACCESS'], ['EPERM', 'ACCESS'], ['EBUSY', 'ACCESS'],
  ['ENOSPC', 'DISK_SPACE'], ['EDQUOT', 'DISK_SPACE'], ['ETIMEDOUT', 'TIMEOUT'],
  ['MISSING_ORIGINAL', 'MISSING'], ['ORIGINAL_MISSING', 'MISSING'],
  ['LIBRARY_UNAVAILABLE', 'LIBRARY_CHANGED'], ['DETACHED', 'LIBRARY_CHANGED'], ['STALE_LIBRARY', 'LIBRARY_CHANGED'],
  ['ASSET_UNAVAILABLE', 'ASSET_CHANGED'], ['STALE_ASSET', 'ASSET_CHANGED'],
]);

function validId(value, pattern = libraryPattern) {
  return typeof value === 'string' && pattern.test(value);
}

function validByteCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function taskInput(input) {
  if (!validId(input?.id, assetPattern) || !validByteCount(input.byteCount)) {
    throw new Error('素材原件记录无效，请刷新素材库后重试。');
  }
  const name = typeof input.name === 'string' ? input.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 512) : '';
  return { id: input.id, byteCount: input.byteCount, name: name || '素材原件' };
}

function failureCode(error) {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  return failureMessages.has(code) ? code : systemErrors.get(code) ?? 'PROVIDER';
}

async function openQueue(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error('原件取回队列目录无效。');
  const file = path.join(await fs.realpath(directory), 'queue.sqlite');
  for (const name of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    const stat = await fs.lstat(name).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (stat && !stat.isFile()) throw new Error('原件取回队列文件无效。');
  }
  const db = new DatabaseSync(file);
  try {
    if (db.prepare('PRAGMA user_version').get().user_version > 1) throw new Error('原件取回队列需要更高版本的见藏。');
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 1000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS libraries (
        registration_id TEXT PRIMARY KEY NOT NULL,
        library_id TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tasks (
        registration_id TEXT NOT NULL REFERENCES libraries(registration_id),
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
        status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
        code TEXT,
        position INTEGER NOT NULL,
        PRIMARY KEY (registration_id, id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS task_position ON tasks(position);
      CREATE INDEX IF NOT EXISTS task_ready ON tasks(status, position);
      CREATE INDEX IF NOT EXISTS library_task_order ON tasks(registration_id, position);
      CREATE INDEX IF NOT EXISTS library_task_status ON tasks(registration_id, status, position);
      CREATE TABLE IF NOT EXISTS totals (
        registration_id TEXT NOT NULL,
        status TEXT NOT NULL,
        items INTEGER NOT NULL,
        bytes REAL NOT NULL,
        PRIMARY KEY (registration_id, status)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS total_insert AFTER INSERT ON tasks BEGIN
        INSERT INTO totals VALUES (NEW.registration_id, NEW.status, 1, NEW.byte_count)
        ON CONFLICT (registration_id, status) DO UPDATE SET items = items + 1, bytes = bytes + NEW.byte_count;
      END;
      CREATE TRIGGER IF NOT EXISTS total_delete AFTER DELETE ON tasks BEGIN
        UPDATE totals SET items = items - 1, bytes = bytes - OLD.byte_count
        WHERE registration_id = OLD.registration_id AND status = OLD.status;
      END;
      CREATE TRIGGER IF NOT EXISTS total_update AFTER UPDATE OF status, byte_count ON tasks
      WHEN NEW.status <> OLD.status OR NEW.byte_count <> OLD.byte_count BEGIN
        UPDATE totals SET items = items - 1, bytes = bytes - OLD.byte_count
        WHERE registration_id = OLD.registration_id AND status = OLD.status;
        INSERT INTO totals VALUES (NEW.registration_id, NEW.status, 1, NEW.byte_count)
        ON CONFLICT (registration_id, status) DO UPDATE SET items = items + 1, bytes = bytes + NEW.byte_count;
      END;
      PRAGMA user_version = 1;
      UPDATE tasks SET status = 'pending' WHERE status = 'running';
      COMMIT;
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

class CloudOriginalQueue {
  #db;
  #statements;
  #initializing;
  #closing;
  #enabled = false;
  #scheduled = false;
  #active = new Map();
  #changes = new Set();
  #timer;

  constructor({ directory, resolve, readOriginal, onChange, onError, concurrency = 2 } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof resolve !== 'function' ||
        typeof readOriginal !== 'function' || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
      throw new TypeError('Cloud original queue configuration is invalid');
    }
    this.directory = directory;
    this.resolve = resolve;
    this.readOriginal = readOriginal;
    this.onChange = onChange;
    this.onError = onError;
    this.concurrency = concurrency;
  }

  async initialize() {
    if (this.#closing) throw new Error('原件取回队列已关闭。');
    if (this.#db) return;
    this.#initializing ??= openQueue(this.directory).then(db => {
      this.#db = db;
      this.#statements = {
        library: db.prepare('SELECT * FROM libraries WHERE registration_id = ?'),
        totals: db.prepare('SELECT status, items, bytes FROM totals WHERE registration_id = ?'),
        next: db.prepare(`
          SELECT tasks.*, libraries.library_id FROM tasks JOIN libraries USING (registration_id)
          WHERE tasks.status = 'pending' AND libraries.paused = 0
          ORDER BY tasks.position LIMIT 1
        `),
        another: db.prepare(`
          SELECT tasks.*, libraries.library_id FROM tasks JOIN libraries USING (registration_id)
          WHERE tasks.status = 'pending' AND libraries.paused = 0 AND tasks.registration_id <> ?
          ORDER BY tasks.position LIMIT 1
        `),
        change: db.prepare('UPDATE tasks SET status = ?, code = ? WHERE registration_id = ? AND id = ?'),
        resize: db.prepare('UPDATE tasks SET byte_count = ? WHERE registration_id = ? AND id = ?'),
        all: db.prepare('SELECT * FROM tasks WHERE registration_id = ? ORDER BY position LIMIT ? OFFSET ?'),
        filtered: db.prepare('SELECT * FROM tasks WHERE registration_id = ? AND status = ? ORDER BY position LIMIT ? OFFSET ?'),
      };
    }).finally(() => { this.#initializing = null; });
    return this.#initializing;
  }

  start() {
    if (!this.#db || this.#closing) return;
    this.#enabled = true;
    this.#schedule();
  }

  #assertReady(registrationId) {
    if (!this.#db || this.#closing || !validId(registrationId)) throw new Error('原件取回队列暂不可用。');
  }

  #transaction(perform) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = perform();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  enqueue(registrationId, libraryId, items, { recheck = false } = {}) {
    this.#assertReady(registrationId);
    if (!validId(libraryId) || !Array.isArray(items) || items.length > libraryLimit) {
      throw new Error('一次最多取回 100,000 份原件。请选择当前素材库中的有效素材。');
    }
    const unique = new Map();
    for (const input of items) {
      const item = taskInput(input);
      if (!unique.has(item.id)) unique.set(item.id, item);
    }
    if (!unique.size) return { added: 0, total: this.status(registrationId, { includeTasks: false }).total };
    const result = this.#transaction(() => {
      const library = this.#statements.library.get(registrationId);
      if (library && library.library_id !== libraryId) {
        throw new Error('素材库身份已经变化。请重新连接后取回原件。');
      }
      if (!library) this.#db.prepare('INSERT INTO libraries (registration_id, library_id) VALUES (?, ?)').run(registrationId, libraryId);
      let position = this.#db.prepare('SELECT coalesce(max(position), 0) AS value FROM tasks').get().value;
      const insert = this.#db.prepare(`
        INSERT INTO tasks (registration_id, id, name, byte_count, status, position)
        VALUES (?, ?, ?, ?, 'pending', ?)
        ON CONFLICT (registration_id, id) DO UPDATE SET name = excluded.name, byte_count = excluded.byte_count,
          status = 'pending', code = NULL, position = excluded.position
        WHERE ? = 1 AND tasks.status IN ('done', 'failed')
      `);
      let added = 0;
      for (const { id, name, byteCount } of unique.values()) {
        const accepted = insert.run(registrationId, id, name, byteCount, position + 1, Number(recheck === true)).changes;
        added += accepted;
        position += accepted;
      }
      const total = this.#statements.totals.all(registrationId).reduce((sum, row) => sum + row.items, 0);
      if (total > libraryLimit || this.#db.prepare('SELECT coalesce(sum(items), 0) AS count FROM totals').get().count > queueLimit) {
        throw new Error('原件取回队列已满，请先清理已完成记录。');
      }
      return { added, total };
    });
    if (result.added) this.#notify(registrationId);
    this.#schedule();
    return result;
  }

  status(registrationId, { offset = 0, limit = 50, filter = 'all', includeTasks = true } = {}) {
    this.#assertReady(registrationId);
    const counts = { pending: 0, running: 0, failed: 0, done: 0 };
    let totalBytes = 0;
    let downloadedBytes = 0;
    for (const row of this.#statements.totals.all(registrationId)) {
      counts[row.status] = row.items;
      totalBytes += row.bytes;
      if (row.status === 'done') downloadedBytes += row.bytes;
    }
    const progress = new Map();
    for (const task of this.#active.values()) {
      if (task.registrationId !== registrationId || task.controller.signal.aborted || task.discarded || task.finalized) continue;
      progress.set(task.id, task.downloaded);
      downloadedBytes += task.downloaded;
    }
    const total = counts.pending + counts.running + counts.failed + counts.done;
    const selected = statuses.has(filter) ? filter : 'all';
    const filteredTotal = selected === 'all' ? total : counts[selected];
    const page = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, pageLimit) : 50;
    const requested = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    const start = requested < filteredTotal ? requested : Math.floor(Math.max(0, filteredTotal - 1) / page) * page;
    const rows = !includeTasks ? [] : selected === 'all' ? this.#statements.all.all(registrationId, page, start) :
      this.#statements.filtered.all(registrationId, selected, page, start);
    const tasks = rows.map(row => ({ id: row.id, name: row.name, byteCount: row.byte_count, status: row.status,
      downloadedBytes: row.status === 'done' ? row.byte_count : progress.get(row.id) ?? 0,
      code: row.code, message: failureMessages.get(row.code) ?? null }));
    return { paused: this.#statements.library.get(registrationId)?.paused === 1, total, ...counts,
      totalBytes: Math.max(0, totalBytes), downloadedBytes: Math.max(0, Math.min(totalBytes, downloadedBytes)),
      offset: start, limit: page, filteredTotal, tasks };
  }

  retry(registrationId, id) {
    this.#assertReady(registrationId);
    if (id !== undefined && !validId(id, assetPattern)) throw new Error('未找到可重试的原件任务。');
    const { changes } = id === undefined
      ? this.#db.prepare("UPDATE tasks SET status = 'pending', code = NULL WHERE registration_id = ? AND status = 'failed'").run(registrationId)
      : this.#db.prepare("UPDATE tasks SET status = 'pending', code = NULL WHERE registration_id = ? AND id = ? AND status = 'failed'").run(registrationId, id);
    if (changes) this.#notify(registrationId);
    this.#schedule();
    return changes;
  }

  remove(registrationId, id) {
    this.#assertReady(registrationId);
    if (!validId(id, assetPattern)) throw new Error('请选择要移除的原件取回任务。');
    const removed = this.#db.prepare(`
      DELETE FROM tasks WHERE registration_id = ? AND id = ? AND status IN ('pending', 'running', 'failed')
      RETURNING status
    `).get(registrationId, id);
    if (!removed) return null;
    for (const task of this.#active.values()) {
      if (task.registrationId !== registrationId || task.id !== id || task.finalized || task.discarded) continue;
      task.discarded = true;
      task.controller.abort();
    }
    this.#notify(registrationId);
    this.#schedule();
    return removed.status;
  }

  setPaused(registrationId, paused) {
    this.#assertReady(registrationId);
    if (typeof paused !== 'boolean') throw new Error('取回队列操作无效。');
    const { changes } = this.#db.prepare('UPDATE libraries SET paused = ? WHERE registration_id = ?').run(Number(paused), registrationId);
    if (!changes) throw new Error('当前素材库还没有取回任务。');
    if (paused) {
      for (const task of this.#active.values()) {
        if (task.registrationId === registrationId) task.controller.abort();
      }
    }
    this.#notify(registrationId);
    this.#schedule();
    return paused;
  }

  clearCompleted(registrationId) {
    this.#assertReady(registrationId);
    const { changes } = this.#db.prepare("DELETE FROM tasks WHERE registration_id = ? AND status = 'done'").run(registrationId);
    if (changes) this.#notify(registrationId);
    return changes;
  }

  discard(registrationId) {
    this.#assertReady(registrationId);
    this.#transaction(() => {
      this.#db.prepare('DELETE FROM tasks WHERE registration_id = ?').run(registrationId);
      this.#db.prepare('DELETE FROM libraries WHERE registration_id = ?').run(registrationId);
      this.#db.prepare('DELETE FROM totals WHERE registration_id = ?').run(registrationId);
    });
    for (const task of this.#active.values()) {
      if (task.registrationId !== registrationId) continue;
      task.discarded = true;
      task.controller.abort();
    }
    this.#notify(registrationId);
    this.#schedule();
  }

  close() {
    return this.#closing ??= this.#finish();
  }

  async #finish() {
    this.#enabled = false;
    clearTimeout(this.#timer);
    this.#changes.clear();
    for (const task of this.#active.values()) task.controller.abort();
    await this.#initializing?.catch(() => {});
    await Promise.allSettled([...this.#active.values()].map(task => task.promise));
    this.#db?.close();
    this.#db = undefined;
  }

  #notify(registrationId) {
    if (typeof this.onChange !== 'function' || this.#closing) return;
    this.#changes.add(registrationId);
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const changes = [...this.#changes];
      this.#changes.clear();
      for (const id of changes) {
        try { Promise.resolve(this.onChange(id)).catch(error => this.#reportError(error)); }
        catch (error) { this.#reportError(error); }
      }
    }, 150);
    this.#timer.unref();
  }

  #reportError(error) {
    try { this.onError?.(error); } catch { /* A notification cannot control queue state. */ }
  }

  #schedule() {
    if (!this.#enabled || this.#closing || this.#scheduled || this.#active.size >= this.concurrency) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      if (!this.#enabled || this.#closing) return;
      try {
        while (this.#active.size < this.concurrency) {
          const active = this.#active.values().next().value;
          const row = (active && this.#statements.another.get(active.registrationId)) || this.#statements.next.get();
          if (!row) return;
          this.#launch(row);
        }
      } catch (error) {
        this.#enabled = false;
        this.#reportError(error);
      }
    });
  }

  #launch(row) {
    const task = { registrationId: row.registration_id, libraryId: row.library_id, id: row.id,
      downloaded: 0, controller: new AbortController(), discarded: false };
    this.#statements.change.run('running', null, task.registrationId, task.id);
    this.#active.set(task.controller, task);
    this.#notify(task.registrationId);
    task.promise = this.#run(task).catch(error => {
      this.#enabled = false;
      this.#reportError(error);
    }).finally(() => {
      this.#active.delete(task.controller);
      this.#notify(task.registrationId);
      this.#schedule();
    });
  }

  async #run(task) {
    const { registrationId, libraryId, id, controller } = task;
    const { signal } = controller;
    let status = 'done';
    let code = null;
    try {
      const source = await this.resolve({ registrationId, libraryId, id }, { signal });
      signal.throwIfAborted();
      if (!source || !validByteCount(source.byteCount)) throw Object.assign(new Error(), { code: 'INVALID_INPUT' });
      this.#statements.resize.run(source.byteCount, registrationId, id);
      const result = await this.readOriginal(source, {
        signal,
        onProgress: bytes => {
          if (signal.aborted || task.discarded || task.finalized || !validByteCount(bytes)) return;
          const next = Math.min(source.byteCount, bytes);
          if (next === task.downloaded) return;
          task.downloaded = next;
          this.#notify(registrationId);
        },
      });
      signal.throwIfAborted();
      if (result?.ok !== true || result.bytes !== source.byteCount) {
        throw Object.assign(new Error(), { code: result?.ok === true ? 'INCOMPLETE' : result?.code });
      }
    } catch (error) {
      status = signal.aborted ? 'pending' : 'failed';
      if (status === 'failed') code = failureCode(error);
    }
    task.finalized = true;
    if (!task.discarded) this.#statements.change.run(status, code, registrationId, id);
  }
}

module.exports = { CloudOriginalQueue };
