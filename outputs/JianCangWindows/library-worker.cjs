'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { readLibrary } = require('./sync-library.cjs');
const { readEagleLibrary } = require('./eagle-library.cjs');
const { LOCAL_MANIFEST, readLocalLibrary } = require('./local-library.cjs');
const { folderIdentity, libraryFingerprint } = require('./library-watcher.cjs');

async function detectedKind(root) {
  const exists = filename => fs.lstat(path.join(root, filename)).then(() => true, () => false);
  const [hasSyncManifest, hasEagleHeader, hasLocalManifest] = await Promise.all([
    exists('library.json'), exists('metadata.json'), exists(LOCAL_MANIFEST),
  ]);
  if (hasEagleHeader && /[.]library$/i.test(root)) return 'eagle';
  if (hasSyncManifest) return 'jiancang';
  if (hasLocalManifest) return 'local';
  if (hasEagleHeader || /\.library$/i.test(root)) return 'eagle';
  throw new Error('请选择见藏本地库、见藏同步文件夹或 Eagle 的 .library 文件夹。');
}

async function openLibrary({ directory, kind }) {
  let root;
  try {
    const entry = await fs.lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error();
    root = await fs.realpath(directory);
  } catch { throw new Error('无法打开素材库文件夹，请检查路径或重新定位。'); }
  const format = kind ?? await detectedKind(root);
  const start = await fs.lstat(root, { bigint: true });
  if (!start.isDirectory() || start.isSymbolicLink()) throw new Error('素材库位置已变化，请重新读取。');
  const identity = folderIdentity(start);
  let library;
  if (format === 'local') library = await readLocalLibrary(root);
  else if (format === 'eagle') library = await readEagleLibrary(root);
  else library = { ...await readLibrary(root, { rootIdentity: identity }), kind: 'jiancang', pathIndependentIdentity: true };
  const end = await fs.lstat(root, { bigint: true });
  if (!end.isDirectory() || end.isSymbolicLink() || folderIdentity(end) !== identity) {
    throw new Error('素材库位置已变化，请重新读取。');
  }
  return { root, library, identity, fingerprint: libraryFingerprint(library) };
}

async function reply(data, send) {
  try { send(await openLibrary(data)); }
  catch (error) { send({ error: error instanceof Error ? error.message : String(error) }); }
}

if (process.parentPort) {
  process.parentPort.once('message', ({ data }) => void reply(data, result => process.parentPort.postMessage(result)));
} else if (require.main === module && typeof process.send === 'function') {
  // The Tauri service uses a stock Node child instead of Electron UtilityProcess.
  process.once('message', data => void reply(data, result => process.send(result)));
}

module.exports = { openLibrary };
