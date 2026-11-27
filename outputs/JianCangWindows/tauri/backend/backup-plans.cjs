'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openContainedFile, readStableBytes } = require('../../original-file.cjs');

const planFile = 'local-backup-plans.json';
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fileLimit = 1024 * 1024;
const retryDelay = 60_000;

function nextLocalTime(time, now) {
  const [hour, minute] = time.split(':').map(Number);
  const date = new Date(now);
  date.setHours(hour, minute, 0, 0);
  if (date.getTime() <= now) {
    date.setDate(date.getDate() + 1);
    date.setHours(hour, minute, 0, 0);
  }
  return date.getTime();
}

function validPlan(plan) {
  if (!plan || ![plan.id, plan.libraryId, plan.groupId].every(id => typeof id === 'string' && idPattern.test(id)) ||
      typeof plan.directory !== 'string' || !path.isAbsolute(plan.directory) || plan.directory.includes('\0') ||
      typeof plan.time !== 'string' || !timePattern.test(plan.time) || typeof plan.enabled !== 'boolean') return false;
  const validDate = value => Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());
  if (plan.enabled ? !validDate(plan.nextAt) : plan.nextAt !== null) return false;
  return plan.last == null || validDate(plan.last.at) && ['complete', 'unchanged', 'failed', 'cancelled'].includes(plan.last.state);
}

async function readPlans(profile) {
  const file = path.join(profile, planFile);
  const handle = await openContainedFile(profile, file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!handle) return new Map();
  try {
    const { size } = await handle.stat();
    const bytes = await readStableBytes(handle, size, fileLimit);
    const data = bytes && JSON.parse(bytes.toString('utf8'));
    if (data?.version !== 1 || !Array.isArray(data.plans) || data.plans.some(plan => !validPlan(plan))) {
      throw new Error('无法读取增量备份计划。');
    }
    return new Map(data.plans.map(plan => [plan.id, plan]));
  } finally { await handle.close(); }
}

async function writePlans(profile, plans) {
  const bytes = Buffer.from(JSON.stringify({ version: 1, plans: [...plans.values()] }));
  if (bytes.length > fileLimit) throw new Error('增量备份计划文件过大。');
  const temporary = path.join(profile, `${planFile}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
    await fs.rename(temporary, path.join(profile, planFile));
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

class BackupPlans {
  #plans = new Map();
  #timer;
  #changing;
  #active;
  #ready = false;
  #closed = false;

  constructor(library, { busy, perform, prepare }) {
    this.library = library;
    this.busy = busy;
    this.perform = perform;
    this.prepare = prepare;
  }

  async initialize() {
    this.#plans = await readPlans(this.library.profile);
    this.#ready = true;
    this.#arm();
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    return Promise.allSettled([this.#changing, this.#active?.work]);
  }

  status(id) {
    if (!this.#ready) throw new Error('增量备份计划不可用，请检查本机设置目录。');
    const entry = this.library.registry.entries.find(item => item.id === id && item.kind === 'local');
    const plan = this.#plans.get(id);
    return { plan: entry?.libraryId === plan?.libraryId ? plan ?? null : null, running: this.#active?.id === id };
  }

  async #save(plan) {
    const updated = new Map(this.#plans);
    updated.set(plan.id, plan);
    await writePlans(this.library.profile, updated);
    this.#plans = updated;
  }

  configure(id, settings, destination) {
    if (this.#closed || this.#active || this.#changing) throw new Error('请等本次备份操作完成再修改计划。');
    const { enabled, time } = settings ?? {};
    if (typeof enabled !== 'boolean' || typeof time !== 'string' || !timePattern.test(time)) {
      throw new Error('请选择每天执行备份的时间。');
    }
    const { plan: previous } = this.status(id);
    const entry = this.library.entry(id);
    if (entry.kind !== 'local') throw new Error('请选择一个见藏本地库。');
    clearTimeout(this.#timer);
    const work = async () => {
      const group = destination == null ? previous : await this.prepare(entry, destination);
      if (!group) throw new Error('请先选择增量备份存放位置。');
      const { groupId, directory } = group;
      const sameGroup = previous?.groupId === groupId;
      const unchanged = sameGroup && previous.enabled === enabled && previous.time === time;
      const plan = { id, libraryId: entry.libraryId, groupId, directory, enabled, time,
        nextAt: enabled ? unchanged ? previous.nextAt : nextLocalTime(time, Date.now()) : null,
        last: sameGroup ? previous.last : null };
      if (unchanged && previous.directory === directory) return this.status(id);
      await this.#save(plan);
      return this.status(id);
    };
    this.#changing = work().finally(() => { this.#changing = undefined; this.#arm(); });
    return this.#changing;
  }

  async #run(plan) {
    try {
      let result;
      let failure;
      try { result = await this.perform(plan); }
      catch (error) { failure = error; }
      if (!this.#closed && !this.library.shutdown.signal.aborted) {
        const at = Date.now();
        const last = failure ? { state: 'failed', at, message: failure.code ? '备份位置不可用，请检查文件夹和权限。' : failure.message } :
          result.cancelled ? { state: 'cancelled', at } :
          { state: result.unchanged ? 'unchanged' : 'complete', at, bytesWritten: result.bytesWritten };
        const next = { ...plan, nextAt: plan.enabled ? nextLocalTime(plan.time, at) : null, last };
        try { await this.#save(next); }
        catch {
          const message = '无法保存本次备份的执行状态，请检查设置文件夹。';
          this.#plans.set(plan.id, { ...next, last: { state: 'failed', at, message } });
          if (!failure) throw new Error(message);
        }
      }
      if (failure) throw failure;
      return result;
    } finally {
      this.#active = undefined;
      this.#arm();
    }
  }

  run(id) {
    if (this.#closed || this.#active || this.#changing || this.busy()) throw new Error('其他备份或导出正在进行，请稍后再试。');
    const { plan } = this.status(id);
    if (!plan) throw new Error('请先为这份素材库设置增量备份位置。');
    clearTimeout(this.#timer);
    const work = Promise.resolve().then(() => this.#run(plan));
    this.#active = { id, work };
    return work;
  }

  #arm(minimumDelay = 0) {
    clearTimeout(this.#timer);
    if (!this.#ready || this.#closed || this.#changing || this.#active) return;
    const plan = [...this.#plans.values()].filter(plan => plan.enabled && this.library.registry.entries.some(
      entry => entry.id === plan.id && entry.kind === 'local' && entry.libraryId === plan.libraryId,
    )).sort((left, right) => left.nextAt - right.nextAt)[0];
    if (!plan) return;
    const delay = Math.min(2 ** 31 - 1, Math.max(minimumDelay, plan.nextAt - Date.now()));
    this.#timer = setTimeout(() => {
      if (Date.now() < plan.nextAt) { this.#arm(); return; }
      if (this.busy()) { this.#arm(retryDelay); return; }
      try { void this.run(plan.id).catch(() => {}); }
      catch { this.#arm(retryDelay); }
    }, delay);
    this.#timer.unref();
  }
}

module.exports = { BackupPlans };
