'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { inspectVideoMetadata } = require('../../video-trim.cjs');
const { openAsset } = require('./media.cjs');

const active = new WeakMap();

async function readVideoMetadata(library, { id, registrationId, revision } = {}) {
  const current = () => typeof id === 'string' && typeof registrationId === 'string' && typeof revision === 'string' &&
    !!revision && library.catalogs.get(registrationId)?.cacheKey === revision;
  if (!current() || !library.ffmpeg) return null;
  const original = library.original(id, registrationId);
  if (original.asset.kind !== 'video' || original.asset.extension === 'livp' || !original.asset.available) return null;
  const key = JSON.stringify([registrationId, id, revision]);
  const previous = active.get(library);
  if (previous?.key === key) return previous.result;
  previous?.controller.abort();
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, library.shutdown.signal]);
  const job = { key, controller, result: null };
  job.result = (async () => {
    const ffprobe = path.join(path.dirname(library.ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    const tool = await fs.lstat(ffprobe).catch(() => null);
    if (!tool?.isFile() || tool.isSymbolicLink() || !current() || signal.aborted) return null;
    try {
      const info = await inspectVideoMetadata({ ffprobe, signal, openSource: async () => (await openAsset(original, signal)).handle });
      return current() && !signal.aborted ? info : null;
    } catch {
      return null;
    }
  })().finally(() => { if (active.get(library) === job) active.delete(library); });
  active.set(library, job);
  return job.result;
}

module.exports = { readVideoMetadata };
