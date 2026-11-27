'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { imageExtension, imageFilename, publicImageURL, imageURLCandidates } = require('./dropped-image.cjs');
const { webURL } = require('./local-workflow.cjs');

const ID = /^[a-f0-9-]{1,64}$/i;
const TASK_ID = /^[a-f0-9]{32}$/;
const ASSET_ID = /^[a-f0-9]{64}$/;
const EAGLE_ITEM_ID = /^[a-z0-9_-]{1,128}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const FILE_STAMP = /^(?:-?\d+:){5}-?\d+$/;
const DIRECTORY_STAMP = /^(?:-?\d+:){2}-?\d+$/;
const MAX_BATCH = 10_000;
const MAX_UNFINISHED = 20_000;
const MAX_HISTORY = 2_000;
const VISIBLE_HISTORY = 100;
const PREVIEW_LIMIT = 24;
const INLINE_CHANGE_LIMIT = 256;
const taskColumns = 'id, asset_id, batch_id, target_id, collection_id, name, status, error, result_id';
const inlineColumns = 'id, asset_id, target_id, collection_id, name, status, result_id';
const MIB = 1024 ** 2;
const MAX_SOURCE_BYTES = 96 * MIB;
const MAX_STAGED = 256 * MIB;
const maximumStagedVideoBytes = 16 * 1024 * MIB;
const dropVideoSuffix = /\.(?:mp4|m4v|mov|webm|ogv|avi|mkv|wmv|flv|mpg|mpeg|mts|m2ts|3gp)$/i;

function validID(id, pattern = ID) {
  return typeof id === 'string' && pattern.test(id);
}

function absolutePath(value) {
  return typeof value === 'string' && value.length <= 32767 &&
    !value.includes('\0') && path.isAbsolute(value);
}

function displayName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 512) || fallback;
}

function collectionPaths(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32 || value.some(segments =>
    !Array.isArray(segments) || !segments.length || segments.length > 32 ||
    segments.some(name => typeof name !== 'string' || !name.trim() || name.length > 256 || CONTROL.test(name))
  )) throw new Error('导入文件夹的层级或名称无效。');
  return value.map(segments => segments.map(name => name.trim()));
}

function validatedSource(input, persisted = false) {
  const target = validID(input?.targetLibraryId) ? { targetLibraryId: input.targetLibraryId } : {};
  if (input?.targetLibraryId !== undefined && !target.targetLibraryId) throw new Error('采集目标素材库无效。');
  switch (input?.kind) {
    case 'file': {
      if (!absolutePath(input.root) || !absolutePath(input.path)) throw new Error('导入文件路径无效。');
      const root = path.resolve(input.root);
      const file = path.resolve(input.path);
      const relative = path.relative(root, file);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('导入文件不在已选择的位置。');
      }
      const watched = input.inboxKey !== undefined || input.inboxStamp !== undefined || input.inboxRootStamp !== undefined;
      if (watched && (!validID(input.inboxKey, TASK_ID) || typeof input.inboxStamp !== 'string' ||
          input.inboxStamp.length > 192 || !FILE_STAMP.test(input.inboxStamp) ||
          typeof input.inboxRootStamp !== 'string' || input.inboxRootStamp.length > 96 || !DIRECTORY_STAMP.test(input.inboxRootStamp))) {
        throw new Error('监控文件的记录无效，请重新检查文件夹。');
      }
      return {
        kind: 'file', root, path: file, name: displayName(input.name, path.basename(file)),
        collectionPaths: collectionPaths(input.collectionPaths), ...target,
        ...(watched && { inboxKey: input.inboxKey, inboxStamp: input.inboxStamp, inboxRootStamp: input.inboxRootStamp }),
      };
    }
    case 'buffer': {
      const sourceURL = webURL(input.sourceURL);
      if (persisted) return { kind: 'buffer', name: displayName(input.name, '粘贴的图片.png'), ...target, ...(sourceURL && { sourceURL }) };
      const bytes = input.bytes;
      const extension = imageExtension(bytes);
      if (!extension) throw new Error('请导入 32 MB 内的 PNG、JPEG、GIF、WebP、BMP 或 AVIF 图片。');
      return { kind: 'buffer', name: imageFilename(input.name || '粘贴的图片', extension), bytes, ...target, ...(sourceURL && { sourceURL }) };
    }
    case 'staged-video': {
      const name = displayName(input.name, '');
      if (!dropVideoSuffix.test(name)) throw new Error('拖入的视频格式无效。');
      const sourceURL = webURL(input.sourceURL);
      const source = { kind: 'staged-video', name, ...target, ...(sourceURL && { sourceURL }) };
      if (persisted) return source;
      const { uploadId, byteCount } = input;
      if (!validID(uploadId, TASK_ID) || !Number.isSafeInteger(byteCount) ||
          byteCount <= 0 || byteCount > maximumStagedVideoBytes) throw new Error('拖入的视频数据无效。');
      return { ...source, uploadId, byteCount };
    }
    case 'image-url': {
      const url = publicImageURL(input.url);
      if (!url) throw new Error('无法读取这个图片地址，请另存为文件后再拖入。');
      const fallbackURLs = Array.isArray(input.fallbackURLs)
        ? imageURLCandidates([url.href, ...input.fallbackURLs.slice(0, 2)]).slice(1) : [];
      const sourceURL = webURL(input.sourceURL);
      return { kind: 'image-url', url: url.href, name: displayName(input.name, url.hostname),
        ...target, ...(fallbackURLs.length && { fallbackURLs }), ...(sourceURL && { sourceURL }) };
    }
    case 'url': {
      if (typeof input.url !== 'string' || input.url.length > 4096 || CONTROL.test(input.url.trim())) {
        throw new Error('粘贴的网址无效。');
      }
      let url;
      try { url = new URL(input.url); } catch { throw new Error('粘贴的网址无效。'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
        throw new Error('请选择普通网页链接。');
      }
      return { kind: 'url', url: url.href, name: displayName(input.name, url.hostname), ...target };
    }
    case 'catalog':
      if (!validID(input.registrationId) || !validID(input.assetId, ASSET_ID) ||
          (input.libraryId !== undefined && !validID(input.libraryId)) ||
          (input.eagleItemId !== undefined && !validID(input.eagleItemId, EAGLE_ITEM_ID))) {
        throw new Error('原素材库或素材无效。');
      }
      return {
        kind: 'catalog', registrationId: input.registrationId, assetId: input.assetId,
        libraryId: input.libraryId, eagleItemId: input.eagleItemId,
        preserveCollections: input.preserveCollections === true,
        name: displayName(input.name, '素材库原件'), ...target,
      };
    default:
      throw new Error('无法识别导入来源。');
  }
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error('导入队列目录无效。');
  return fs.realpath(directory);
}

async function assertQueueFile(file) {
  const stat = await fs.lstat(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (stat && !stat.isFile()) throw new Error('导入队列文件无效。');
}

function importErrorMessage(error) {
  switch (error?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return '源文件暂时找不到，请确认文件还在原位置后重试。';
    case 'EPERM':
    case 'EACCES':
      return '暂时无法访问文件，请检查权限后重试。';
    case 'ENOSPC':
    case 'EDQUOT':
      return '磁盘空间不足，请释放空间后重试。';
    default:
      if (typeof error?.message === 'string' && /\p{Script=Han}/u.test(error.message) && !error.path) {
        return displayName(error.message, '素材导入未完成。');
      }
      return '素材导入未完成，可以重试这一项。';
  }
}

class LocalImportQueue {
  #db;
  #stage;
  #enabled = false;
  #closed = false;
  #active = null;
  #kickRequested = false;
  #progress = new Map();
  #changes = new Set();
  #timer = null;
  #input = Promise.resolve();
  #inlineEpoch = randomUUID();
  #inlineChanges = new Map();

  constructor({ directory, perform, onChange, onError } = {}) {
    if (!absolutePath(directory) || typeof perform !== 'function') throw new TypeError('Import queue configuration is invalid');
    this.directory = directory;
    this.perform = perform;
    this.onChange = onChange;
    this.onError = onError;
  }

  async initialize() {
    if (this.#closed) throw new Error('导入队列已关闭。');
    if (this.#db) return;
    const root = await privateDirectory(this.directory);
    this.#stage = await privateDirectory(path.join(root, 'clipboard'));
    const file = path.join(root, 'queue.sqlite');
    await Promise.all([file, `${file}-wal`, `${file}-shm`, `${file}-journal`].map(assertQueueFile));
    const db = new DatabaseSync(file);
    try {
      if (db.prepare('PRAGMA user_version').get().user_version > 1) throw new Error('导入队列需要更高版本的见藏。');
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 1000;
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY NOT NULL,
          asset_id TEXT NOT NULL UNIQUE,
          batch_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          collection_id TEXT,
          name TEXT NOT NULL,
          source_json TEXT NOT NULL,
          staged_bytes INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'failed', 'done')),
          error TEXT,
          result_id TEXT,
          position INTEGER NOT NULL,
          updated INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS queue_state ON tasks(status, position);
        CREATE INDEX IF NOT EXISTS history_order ON tasks(status, updated DESC, position DESC);
        CREATE INDEX IF NOT EXISTS target_state ON tasks(target_id, status, updated);
        CREATE TABLE IF NOT EXISTS paused_targets (
          target_id TEXT PRIMARY KEY NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS cancelled_inbox (
          id TEXT PRIMARY KEY NOT NULL,
          target_id TEXT NOT NULL,
          collection_id TEXT
        ) STRICT;
        PRAGMA user_version = 1;
        UPDATE tasks SET status = 'pending' WHERE status = 'running';
      `);
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!db.prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'result_id'").get()) {
          db.exec('ALTER TABLE tasks ADD COLUMN result_id TEXT');
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      const referenced = new Set(db.prepare('SELECT id FROM tasks WHERE staged_bytes > 0').all().map(row => row.id));
      for (const entry of await fs.readdir(this.#stage, { withFileTypes: true })) {
        const match = /^([a-f0-9]{32})\.(png|video|upload)$/.exec(entry.name);
        if (match && !entry.isDirectory() && (match[2] === 'upload' || !referenced.has(match[1]))) {
          await fs.unlink(path.join(this.#stage, entry.name));
        }
      }
      this.#db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  start() {
    if (!this.#db || this.#closed) return;
    this.#enabled = true;
    this.#kick();
  }

  async close() {
    this.#closed = true;
    this.#enabled = false;
    await this.#input;
    await this.#active;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#changes.clear();
    this.#db?.close();
    this.#db = undefined;
  }

  #public(row) {
    return {
      id: row.id, assetId: row.asset_id, batchId: row.batch_id,
      targetId: row.target_id, collectionId: row.collection_id, name: row.name,
      status: row.status, progress: row.status === 'done' ? 1 : this.#progress.get(row.id) ?? 0,
      error: row.error,
      ...(validID(row.result_id, ASSET_ID) && { resultId: row.result_id }),
    };
  }

  snapshot(targetId) {
    if (!this.#db || !validID(targetId)) return [];
    const current = this.#db.prepare(`
      SELECT ${taskColumns} FROM tasks WHERE target_id = ? AND status <> 'done' ORDER BY position
    `).all(targetId);
    const complete = this.#db.prepare(`
      SELECT ${taskColumns} FROM tasks WHERE target_id = ? AND status = 'done' ORDER BY updated DESC, position DESC LIMIT ?
    `).all(targetId, VISIBLE_HISTORY);
    return [...current, ...complete].map(row => this.#public(row));
  }

  previewSnapshot(targetId, collectionIds) {
    if (!this.#db || !validID(targetId)) return { tasks: [], previewCount: 0 };
    if (collectionIds !== undefined && (!Array.isArray(collectionIds) || collectionIds.length > MAX_BATCH ||
      collectionIds.some(id => typeof id !== 'string' || !id || id.length > 256 || CONTROL.test(id)))) {
      throw new Error('请选择有效的目标集合。');
    }
    const scope = collectionIds === undefined ? '' : 'AND collection_id IN (SELECT value FROM json_each(?))';
    const bindings = collectionIds === undefined ? [targetId] : [targetId, JSON.stringify(collectionIds)];
    const current = this.#db.prepare(`
      SELECT ${taskColumns}, count(*) OVER () AS preview_count FROM tasks
      WHERE target_id = ? AND status <> 'done' ${scope}
      ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, position LIMIT ?
    `).all(...bindings, PREVIEW_LIMIT);
    const complete = this.#db.prepare(`
      SELECT ${taskColumns} FROM tasks WHERE target_id = ? AND status = 'done' ${scope}
      ORDER BY updated DESC, position DESC LIMIT ?
    `).all(...bindings, VISIBLE_HISTORY);
    return { tasks: [...current, ...complete].map(row => this.#public(row)), previewCount: current[0]?.preview_count ?? 0 };
  }

  inlineSnapshot(targetId, collectionIds, knownRevision) {
    if (!this.#db || !validID(targetId)) return { tasks: [] };
    if (collectionIds !== undefined && (!Array.isArray(collectionIds) || collectionIds.length > MAX_BATCH ||
        collectionIds.some(id => typeof id !== 'string' || !id || id.length > 256 || CONTROL.test(id)))) {
      throw new Error('请选择有效的目标集合。');
    }
    const changes = this.#inlineChanges.get(targetId);
    const revision = changes?.revision ?? 0;
    const scopeKey = collectionIds === undefined ? 'all' : createHash('sha256').update(JSON.stringify(collectionIds)).digest('hex');
    const prefix = `${this.#inlineEpoch}:${targetId}:${scopeKey}:`;
    const inlineRevision = prefix + revision;
    if (knownRevision === inlineRevision) return { inlineRevision };
    const cursor = typeof knownRevision === 'string' && knownRevision.startsWith(prefix)
      ? Number(knownRevision.slice(prefix.length)) : -1;
    const incremental = Number.isSafeInteger(cursor) && cursor >= (changes?.floor ?? 0) && cursor < revision;
    const changed = incremental ? [...new Set(changes.events.filter(event => event.revision > cursor).map(event => event.id))] : [];
    const scope = collectionIds === undefined ? '' : 'AND collection_id IN (SELECT value FROM json_each(?))';
    const bindings = collectionIds === undefined ? [targetId] : [targetId, JSON.stringify(collectionIds)];
    if (incremental) bindings.push(JSON.stringify(changed));
    const rows = this.#db.prepare(`
      SELECT ${inlineColumns} FROM tasks
      WHERE target_id = ? AND (status IN ('pending', 'running') OR status = 'done' AND result_id IS NOT NULL)
      ${scope} ${incremental ? 'AND id IN (SELECT value FROM json_each(?))' : ''}
      ORDER BY position
    `).all(...bindings);
    const tasks = rows.map(row => ({
      id: row.id, assetId: row.asset_id, targetId: row.target_id, collectionId: row.collection_id, name: row.name,
      ...(row.status === 'done' && { resultId: row.result_id }),
    }));
    const returned = incremental && new Set(tasks.map(task => task.id));
    return { inlineRevision, tasks, ...(incremental && { removed: changed.filter(id => !returned.has(id)) }) };
  }

  #recordInlineChange(targetId, id) {
    let changes = this.#inlineChanges.get(targetId);
    if (!changes) {
      changes = { revision: 0, floor: 0, events: [] };
      this.#inlineChanges.set(targetId, changes);
    }
    const revision = ++changes.revision;
    if (!id) {
      changes.floor = revision;
      changes.events.length = 0;
    } else {
      changes.events.push({ id, revision });
      if (changes.events.length > INLINE_CHANGE_LIMIT) changes.floor = changes.events.shift().revision;
    }
  }

  summary(targetId) {
    const counts = { pending: 0, running: 0, done: 0, failed: 0 };
    if (!this.#db || !validID(targetId)) return counts;
    const rows = this.#db.prepare('SELECT status, count(*) AS total FROM tasks WHERE target_id = ? GROUP BY status').all(targetId);
    for (const { status, total } of rows) counts[status] = total;
    return counts;
  }

  hasPending(targetId) {
    return Boolean(this.#db && validID(targetId) && this.#db.prepare(`
      SELECT 1 FROM tasks WHERE target_id = ? AND status = 'pending' LIMIT 1
    `).get(targetId));
  }

  isPaused(targetId) {
    if (!this.#db || !validID(targetId)) return false;
    return Boolean(this.#db.prepare('SELECT 1 FROM paused_targets WHERE target_id = ?').get(targetId));
  }

  setPaused(targetId, paused) {
    if (!this.#db || this.#closed || !validID(targetId) || typeof paused !== 'boolean') {
      throw new Error('未找到要设置的导入队列。');
    }
    if (paused) this.#db.prepare('INSERT OR IGNORE INTO paused_targets (target_id) VALUES (?)').run(targetId);
    else this.#db.prepare('DELETE FROM paused_targets WHERE target_id = ?').run(targetId);
    this.#notify(targetId);
    if (!paused) this.#kick();
    return paused;
  }

  enqueue(request) {
    const operation = this.#input.then(() => this.#enqueue(request));
    this.#input = operation.catch(() => {});
    return operation;
  }

  async openVideoUpload() {
    if (!this.#db || this.#closed) throw new Error('导入队列尚未准备好。');
    const uploadId = randomBytes(16).toString('hex');
    const handle = await fs.open(this.#videoUploadFile(uploadId), 'wx', 0o600);
    return { uploadId, handle };
  }

  async discardVideoUpload(uploadId) {
    await fs.unlink(this.#videoUploadFile(uploadId)).catch(() => {});
  }

  async #enqueue({ targetId, collectionId = null, sources } = {}) {
    if (!this.#db || this.#closed) throw new Error('导入队列尚未准备好。');
    if (!validID(targetId) || (collectionId !== null && (typeof collectionId !== 'string' ||
        !collectionId.trim() || collectionId.length > 256 || CONTROL.test(collectionId)))) {
      throw new Error('请选择有效的目标素材库与集合。');
    }
    if (!Array.isArray(sources) || !sources.length || sources.length > MAX_BATCH) {
      throw new Error('一次可导入 1 至 10000 项素材。');
    }
    const priorInbox = this.#db.prepare(`
      SELECT target_id, collection_id FROM tasks WHERE id = ?
      UNION ALL
      SELECT target_id, collection_id FROM cancelled_inbox WHERE id = ?
    `);
    const watchKeys = new Set();
    const items = sources.map(source => validatedSource(source)).filter(source => {
      if (!source.inboxKey) return true;
      const previous = priorInbox.get(source.inboxKey, source.inboxKey);
      if (previous && (previous.target_id !== targetId || previous.collection_id !== collectionId)) {
        throw new Error('监控文件的目标素材库已变化，请重新设置监控。');
      }
      if (previous || watchKeys.has(source.inboxKey)) return false;
      watchKeys.add(source.inboxKey);
      return true;
    });
    if (!items.length) return { queued: 0, tasks: [] };
    const queued = this.#db.prepare(`
      SELECT count(*) AS taskCount, coalesce(sum(staged_bytes), 0) AS staged,
        coalesce(sum(CASE WHEN json_valid(source_json)
          THEN CASE WHEN json_extract(source_json, '$.kind') = 'staged-video' THEN staged_bytes ELSE 0 END
          ELSE 0 END), 0) AS stagedVideo,
        coalesce(sum(length(CAST(source_json AS BLOB))), 0) AS sourceBytes
      FROM tasks WHERE status <> 'done'
    `).get();
    if (queued.taskCount + items.length > MAX_UNFINISHED) {
      throw new Error('导入队列已满，请先完成或重试现有任务。');
    }
    const batchId = randomUUID();
    const rows = items.map(({ bytes, uploadId, byteCount, ...source }) => ({
      id: source.inboxKey ?? randomBytes(16).toString('hex'), asset_id: randomBytes(32).toString('hex'),
      batch_id: batchId, target_id: targetId, collection_id: collectionId, status: 'pending',
      error: null, name: source.name, source_json: JSON.stringify(source),
      staged_bytes: bytes?.length ?? byteCount ?? 0, bytes, uploadId,
    }));
    const awaitingStage = rows.reduce((sum, row) => sum + (row.bytes?.length ?? 0), queued.staged - queued.stagedVideo);
    const awaitingVideo = rows.reduce((sum, row) => sum + (row.uploadId ? row.staged_bytes : 0), queued.stagedVideo);
    const pathData = rows.reduce((sum, row) => sum + Buffer.byteLength(row.source_json), queued.sourceBytes);
    if (awaitingStage > MAX_STAGED) throw new Error('粘贴图片占用过多临时空间，请先完成已有任务。');
    if (awaitingVideo > maximumStagedVideoBytes) throw new Error('拖入视频占用过多临时空间，请先完成已有任务。');
    if (pathData > MAX_SOURCE_BYTES) throw new Error('待导入的路径太多，请分批导入。');
    const staged = [];
    try {
      for (const row of rows) {
        if (row.uploadId) {
          const uploaded = this.#videoUploadFile(row.uploadId);
          const stat = await fs.lstat(uploaded);
          if (!stat.isFile() || stat.size !== row.staged_bytes) throw new Error('拖入的视频尚未传完，请重新拖入。');
          const file = this.#stageFile(row.id, 'staged-video');
          await fs.rename(uploaded, file);
          staged.push(file);
          continue;
        }
        if (!row.bytes) continue;
        const file = this.#stageFile(row.id);
        const handle = await fs.open(file, 'wx', 0o600);
        staged.push(file);
        try {
          await handle.writeFile(row.bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        let { end } = this.#db.prepare('SELECT coalesce(max(position), 0) AS end FROM tasks').get();
        const now = Date.now();
        const insert = this.#db.prepare(`
          INSERT INTO tasks (id, asset_id, batch_id, target_id, collection_id, name, source_json, staged_bytes, status, position, updated)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of rows) {
          insert.run(row.id, row.asset_id, batchId, targetId, collectionId, row.name, row.source_json,
            row.staged_bytes, row.status, ++end, now);
        }
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      await Promise.allSettled(staged.map(file => fs.unlink(file)));
      throw error;
    }
    this.#recordInlineChange(targetId);
    this.#notify(targetId);
    this.#kick();
    return { queued: rows.length, tasks: rows.map(row => this.#public(row)) };
  }

  async retry(targetId, taskId) {
    if (!this.#db || this.#closed || !validID(targetId) || !validID(taskId, TASK_ID)) {
      throw new Error('未找到可重试的导入任务。');
    }
    const row = this.#db.prepare(`
      UPDATE tasks
      SET status = 'pending', error = NULL, updated = ?, position = (SELECT coalesce(max(position), 0) + 1 FROM tasks)
      WHERE id = ? AND target_id = ? AND status = 'failed'
      RETURNING id, asset_id, batch_id, target_id, collection_id, name, status, error
    `).get(Date.now(), taskId, targetId);
    if (!row) throw new Error('未找到可重试的导入任务。');
    this.#recordInlineChange(targetId, row.id);
    this.#notify(targetId);
    this.#kick();
    return this.#public(row);
  }

  retryFailed(targetId) {
    if (!this.#db || this.#closed || !validID(targetId)) throw new Error('未找到可重试的导入任务。');
    const { changes } = this.#db.prepare(`
      WITH next_attempts AS MATERIALIZED (
        SELECT id, row_number() OVER (ORDER BY position) + (
          SELECT coalesce(max(position), 0) FROM tasks
        ) AS next_position
        FROM tasks WHERE target_id = ? AND status = 'failed'
      )
      UPDATE tasks
      SET status = 'pending', error = NULL, updated = ?, position = next_attempts.next_position
      FROM next_attempts
      WHERE tasks.id = next_attempts.id
    `).run(targetId, Date.now());
    if (changes) {
      this.#recordInlineChange(targetId);
      this.#notify(targetId);
      this.#kick();
    }
    return changes;
  }

  async cancel(targetId, taskId) {
    if (!validID(taskId, TASK_ID)) throw new Error('未找到要取消的导入任务。');
    await this.#cancelTasks(targetId, taskId);
  }

  cancelPending(targetId) {
    return this.#cancelTasks(targetId, null);
  }

  async #cancelTasks(targetId, taskId) {
    if (!this.#db || this.#closed || !validID(targetId)) {
      throw new Error('未找到要取消的导入任务。');
    }
    const allPending = taskId === null;
    const selection = allPending ? "status = 'pending'" : "id = ? AND status IN ('pending', 'failed')";
    const bindings = allPending ? [targetId] : [targetId, taskId];
    let rows;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      rows = this.#db.prepare(`
        DELETE FROM tasks WHERE target_id = ? AND ${selection}
        RETURNING id, collection_id, staged_bytes,
          CASE WHEN json_valid(source_json) THEN json_extract(source_json, '$.kind') END AS source_kind,
          CASE WHEN json_valid(source_json) THEN json_extract(source_json, '$.inboxKey') END AS inbox_key
      `).all(...bindings);
      if (!allPending && !rows.length) {
        const active = this.#db.prepare("SELECT 1 FROM tasks WHERE id = ? AND target_id = ? AND status = 'running'")
          .get(taskId, targetId);
        throw new Error(active ? '这项任务已经开始，将继续完成导入。' : '这项任务已更新，请刷新导入队列。');
      }
      const receipt = this.#db.prepare('INSERT INTO cancelled_inbox (id, target_id, collection_id) VALUES (?, ?, ?)');
      for (const row of rows) {
        if (row.inbox_key === row.id) receipt.run(row.id, targetId, row.collection_id);
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    if (!rows.length) return 0;
    this.#recordInlineChange(targetId, rows.length === 1 ? rows[0].id : undefined);
    this.#notify(targetId);
    for (const row of rows) {
      if (row.staged_bytes && validID(row.id, TASK_ID)) await fs.unlink(this.#stageFile(row.id, row.source_kind)).catch(() => {});
    }
    return rows.length;
  }

  #stageFile(id, kind = 'buffer') {
    if (!validID(id, TASK_ID)) throw new Error('暂存文件的任务标识无效。');
    return path.join(this.#stage, `${id}.${kind === 'staged-video' ? 'video' : 'png'}`);
  }

  #videoUploadFile(id) {
    if (!validID(id, TASK_ID)) throw new Error('拖入视频的任务标识无效。');
    return path.join(this.#stage, `${id}.upload`);
  }

  #notify(targetId) {
    if (!this.onChange || this.#closed) return;
    this.#changes.add(targetId);
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const targets = [...this.#changes];
      this.#changes.clear();
      for (const id of targets) {
        try { this.onChange(id); } catch (error) { this.onError?.(error); }
      }
    }, 100);
    this.#timer.unref?.();
  }

  #kick() {
    if (!this.#enabled) return;
    if (this.#active) {
      this.#kickRequested = true;
      return;
    }
    this.#active = new Promise(resolve => setImmediate(resolve)).then(() => this.#drain()).catch(error => {
      this.#enabled = false;
      this.onError?.(error);
    }).finally(() => {
      this.#active = null;
      if (!this.#kickRequested) return;
      this.#kickRequested = false;
      this.#kick();
    });
  }

  async #drain() {
    const next = this.#db.prepare(`
      SELECT * FROM tasks WHERE status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM paused_targets WHERE target_id = tasks.target_id)
      ORDER BY position LIMIT 1
    `);
    const running = this.#db.prepare("UPDATE tasks SET status = 'running', updated = ? WHERE id = ?");
    const fail = this.#db.prepare("UPDATE tasks SET status = 'failed', error = ?, updated = ? WHERE id = ?");
    const done = this.#db.prepare(`
      UPDATE tasks SET status = 'done', source_json = '', staged_bytes = 0, error = NULL, result_id = ?, updated = ? WHERE id = ?
    `);
    const prune = this.#db.prepare(`
      DELETE FROM tasks WHERE id IN (
        SELECT id FROM tasks WHERE status = 'done' ORDER BY updated DESC, position DESC LIMIT -1 OFFSET ?
      )
    `);

    while (this.#enabled) {
      const row = next.get();
      if (!row) return;
      row.status = 'running';
      running.run(Date.now(), row.id);
      this.#notify(row.target_id);
      let acceptingProgress = true;
      let failure = null;
      let resultId = null;
      let stagedFile;
      try {
        let source = validatedSource(JSON.parse(row.source_json), true);
        if (source.kind === 'buffer' || source.kind === 'staged-video') {
          stagedFile = this.#stageFile(row.id, source.kind);
          source = { ...source, kind: 'file', root: this.#stage, path: stagedFile };
        }
        const reportProgress = value => {
          if (!acceptingProgress || !Number.isFinite(value)) return;
          const last = this.#progress.get(row.id) ?? 0;
          const fraction = Math.min(0.99, value);
          if (fraction <= last || (fraction < 0.99 && fraction - last < 0.01)) return;
          this.#progress.set(row.id, fraction);
          this.#notify(row.target_id);
        };
        const result = await this.perform({ ...this.#public(row), source }, reportProgress);
        if (validID(result?.id, ASSET_ID)) resultId = result.id;
      } catch (error) {
        failure = importErrorMessage(error);
      } finally {
        acceptingProgress = false;
      }
      if (failure) {
        fail.run(failure, Date.now(), row.id);
      } else {
        done.run(resultId, Date.now(), row.id);
        prune.run(MAX_HISTORY);
      }
      this.#progress.delete(row.id);
      this.#recordInlineChange(row.target_id, row.id);
      this.#notify(row.target_id);
      if (!failure && stagedFile) await fs.unlink(stagedFile).catch(() => {});
      // Give native input and IPC an opportunity to run for large URL batches.
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}

module.exports = { LocalImportQueue, importErrorMessage, maximumStagedVideoBytes, dropVideoSuffix };
