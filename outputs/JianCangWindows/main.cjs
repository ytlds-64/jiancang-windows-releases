'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { lstatSync, realpathSync } = require('node:fs');
const { COPYFILE_EXCL } = require('node:fs').constants;
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pathToFileURL } = require('node:url');
const { setTimeout: waitDelay } = require('node:timers/promises');
const { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, safeStorage, screen, session, shell, utilityProcess } = require('electron');
const { isWithin, openContainedFile, openOriginal, openVerifiedOriginal, readStableBytes, exportVerified, exportReadOnly, exportCapturedFrame,
  withVerifiedThumbnailFile, withReadOnlyThumbnailFile, parseByteRange, exportFilename, validateExportTarget } = require('./original-file.cjs');
const { createRegistry, readRegistry, writeRegistry, registerLibrary, detachLibrary, locationMatches,
  parseAssetRoute, assetForCatalog } = require('./library-registry.cjs');
const { readLivePhotoPart } = require('./live-photo.cjs');
const { exportBatch } = require('./batch-export.cjs');
const { createThumbnailCache, sourceStamp, thumbnailSourceRevision } = require('./thumbnail-cache.cjs');
const { createLibraryWatcher, folderIdentity } = require('./library-watcher.cjs');
const { createLocalLibrary, openLocalOriginal, importLocalAsset, mutateLocalLibrary, replaceLocalPicture,
  validateEditedImage, duplicateMergeMetadata } = require('./local-library.cjs');
const { LocalImportQueue } = require('./local-import-queue.cjs');
const { BrowserCapture, prepareBrowserExtension, refreshBrowserExtension } = require('./browser-capture.cjs');
const { clipboardWebURLs, collectImportSources, inLibrary, maximumImportBatch, sourceCollectionPaths, syncUploadId, webURL } = require('./local-workflow.cjs');
const { DirectorySyncWriter } = require('./sync-writer.cjs');
const { createWindowsUpdater } = require('./windows-updater.cjs');
const { createUpdateRequest } = require('./windows-update-network.cjs');
const { listSyncConflicts } = require('./sync-library.cjs');
const { VisualIndex } = require('./visual-index.cjs');
const { AssetSuggestions } = require('./asset-suggestions.cjs');
const { NaturalImageSearch, maximumNaturalSearchImages } = require('./natural-image-search.cjs');
const { writeBoardExport, readBoardProject, projectExtension } = require('./board-export.cjs');
const { DuplicateReview } = require('./duplicate-review.cjs');
const { FolderInbox, openInboxOriginal } = require('./folder-inbox.cjs');
const { OfflineWebStore } = require('./offline-web.cjs');
const { planStructuredExport, runStructuredExport } = require('./structured-export.cjs');
const { writeVideoMarkers } = require('./video-markers.cjs');
const { inspectVideoMetadata, maximumSegments, prepareVideoTrim, validateTrimRanges } = require('./video-trim.cjs');
const { createLocalBackup, restoreLocalBackup } = require('./local-backup.cjs');
const { CloudOriginalQueue } = require('./cloud-original-queue.cjs');
const { createCloudOriginalReader } = require('./cloud-original-process.cjs');
const { clipboardModes, clipboardText } = require('./asset-clipboard.cjs');
const { isTextPreview, readTextPreview } = require('./text-preview.cjs');
const { resolveEagleReadingDirectory } = require('./eagle-library.cjs');
const { createEagleLocalApi, planEagleRename } = require('./eagle-local-api.cjs');
const eagleApi = createEagleLocalApi();
const { imageExtension, imageFilename, inlineImage, maximumImageBytes, imageURLCandidates, downloadDroppedImage }
  = require('./dropped-image.cjs');
const { imageDimensions } = require('./image-dimensions.cjs');

const appPage = 'jiancang://app/index.html';
const resources = new Map([
  ['/index.html', 'text/html; charset=utf-8'],
  ['/styles.css', 'text/css; charset=utf-8'],
  ['/renderer.js', 'text/javascript; charset=utf-8'],
  ['/asset-context-menu.js', 'text/javascript; charset=utf-8'],
  ['/asset-context-menu.css', 'text/css; charset=utf-8'],
  ['/collection-order.js', 'text/javascript; charset=utf-8'],
  ['/collection-finder.js', 'text/javascript; charset=utf-8'],
  ['/collection-finder.css', 'text/css; charset=utf-8'],
  ['/asset-search.js', 'text/javascript; charset=utf-8'],
  ['/windows-update.js', 'text/javascript; charset=utf-8'],
  ['/continuous-gallery.js', 'text/javascript; charset=utf-8'],
  ['/browse-workspace.js', 'text/javascript; charset=utf-8'],
  ['/preview-transition.js', 'text/javascript; charset=utf-8'],
  ['/image-comparison.js', 'text/javascript; charset=utf-8'],
  ['/image-comparison.css', 'text/css; charset=utf-8'],
  ['/video-player.js', 'text/javascript; charset=utf-8'],
  ['/audio-player.css', 'text/css; charset=utf-8'],
  ['/video-player.css', 'text/css; charset=utf-8'],
  ['/asset-filters.js', 'text/javascript; charset=utf-8'],
  ['/asset-filters.css', 'text/css; charset=utf-8'],
  ['/local-organize.js', 'text/javascript; charset=utf-8'],
  ['/local-organize.css', 'text/css; charset=utf-8'],
  ['/local-import.js', 'text/javascript; charset=utf-8'],
  ['/local-import.css', 'text/css; charset=utf-8'],
  ['/browser-capture.js', 'text/javascript; charset=utf-8'],
  ['/browser-capture.css', 'text/css; charset=utf-8'],
  ['/project-boards.js', 'text/javascript; charset=utf-8'],
  ['/project-boards.css', 'text/css; charset=utf-8'],
  ['/asset-suggestions.js', 'text/javascript; charset=utf-8'],
  ['/natural-image-search.js', 'text/javascript; charset=utf-8'],
  ['/asset-suggestions.css', 'text/css; charset=utf-8'],
  ['/library-diagnostics.js', 'text/javascript; charset=utf-8'],
  ['/library-diagnostics.css', 'text/css; charset=utf-8'],
  ['/smart-collections.js', 'text/javascript; charset=utf-8'],
  ['/visual-tools.js', 'text/javascript; charset=utf-8'],
  ['/smart-tools.css', 'text/css; charset=utf-8'],
  ['/asset-list.css', 'text/css; charset=utf-8'],
  ['/duplicate-review.js', 'text/javascript; charset=utf-8'],
  ['/duplicate-review.css', 'text/css; charset=utf-8'],
  ['/tag-manager.js', 'text/javascript; charset=utf-8'],
  ['/tag-manager.css', 'text/css; charset=utf-8'],
  ['/folder-inbox.js', 'text/javascript; charset=utf-8'],
  ['/folder-inbox.css', 'text/css; charset=utf-8'],
  ['/offline-web.js', 'text/javascript; charset=utf-8'],
  ['/offline-web.css', 'text/css; charset=utf-8'],
  ['/offline-web-extract.js', 'text/javascript; charset=utf-8'],
  ['/structured-export.js', 'text/javascript; charset=utf-8'],
  ['/structured-export.css', 'text/css; charset=utf-8'],
  ['/image-tools.js', 'text/javascript; charset=utf-8'],
  ['/image-tools.css', 'text/css; charset=utf-8'],
  ['/image-conversion.js', 'text/javascript; charset=utf-8'],
  ['/video-trim.js', 'text/javascript; charset=utf-8'],
  ['/video-trim.css', 'text/css; charset=utf-8'],
  ['/local-backup.js', 'text/javascript; charset=utf-8'],
  ['/local-backup.css', 'text/css; charset=utf-8'],
  ['/storage-management.js', 'text/javascript; charset=utf-8'],
  ['/storage-management.css', 'text/css; charset=utf-8'],
  ['/cloud-originals.js', 'text/javascript; charset=utf-8'],
  ['/cloud-originals.css', 'text/css; charset=utf-8'],
  ['/sync-conflicts.js', 'text/javascript; charset=utf-8'],
  ['/sync-conflicts.css', 'text/css; charset=utf-8'],
  ['/image-decoder.html', 'text/html; charset=utf-8'],
  ['/image-decoder.js', 'text/javascript; charset=utf-8'],
  ['/reference.html', 'text/html; charset=utf-8'],
  ['/reference.css', 'text/css; charset=utf-8'],
  ['/reference.js', 'text/javascript; charset=utf-8'],
  ['/pdf-preview.js', 'text/javascript; charset=utf-8'],
  ['/pdf-preview.css', 'text/css; charset=utf-8'],
  ['/text-preview.js', 'text/javascript; charset=utf-8'],
  ['/text-preview.css', 'text/css; charset=utf-8'],
  ['/icon.png', 'image/png'],
]);
const previewTypes = new Map(Object.entries({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
  opus: 'audio/ogg',
}));
const editorImageTypes = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif']);
const editorOriginalLimit = 96 * 1024 ** 2;
const thumbnailTypes = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico', 'heic', 'heif', 'tif', 'tiff']);
const browserFirstThumbnails = new Set(['webp', 'avif']);
const thumbnailBufferLimit = 8 * 1024 ** 2;
const thumbnailPixelLimit = 24_000_000;
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' jiancang:; media-src jiancang:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const browsingCsp = `${csp}; connect-src 'self'; worker-src 'self'`;
const pdfWorkerCsp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'";
const pdfResources = new Map([
  [/^build\/pdf(?:\.worker)?\.min\.mjs$/, 'text/javascript; charset=utf-8'],
  [/^cmaps\/[a-z\d_-]+\.bcmap$/i, 'application/octet-stream'],
  [/^standard_fonts\/[a-z\d_-]+\.(?:pfb|ttf)$/i, 'application/octet-stream'],
  [/^wasm\/[a-z\d_-]+\.wasm$/i, 'application/wasm'],
  [/^wasm\/(?:jbig2|openjpeg)_nowasm_fallback\.js$/, 'text/javascript; charset=utf-8'],
  [/^iccs\/[a-z\d_-]+\.icc$/i, 'application/octet-stream'],
]);
const thumbnails = new Map();
let thumbnailDisk;
let thumbnailGeneration = 0;
let thumbnailClearing;
let libraryWatcher;
const thumbnailQueue = [];
let thumbnailJobs = 0;
let window;
let activeAssetMenu;
let startup;
let libraryActions = Promise.resolve();
let registry = createRegistry();
let registryDirty = false;
const libraryStatuses = new Map();
const catalogs = new Map();
const catalogReads = new Map();
const workerQueue = [];
let workerCount = 0;
let stateEvent;
let message = null;
let libraryOpening = null;
let exporting = false;
let activeImageConversion;
let copyingAssetDetails = false;
let activeVideoTrim;
let videoTrimWork;
let backupOperation;
const referenceWindows = new Map();
const referenceContents = new WeakMap();
const preparedDrags = new Map();
let preparingDrag = false;
let localImports;
let clipboardImportSnapshot;
let localImportError;
let cloudOriginals;
let cloudOriginalError;
const refreshAfterCloudOriginals = new Set();
let localWrites = Promise.resolve();
const localRefresh = new Map();
const importEvents = new Set();
let importEvent;
let syncWriter;
let syncWriterError;
let syncTimer;
const syncingLibraries = new Map();
let visualIndex;
let suggestions;
let suggestionCatalogRefresh = Promise.resolve();
let naturalImageSearch;
let visualIndexError;
let suggestionsError;
let imageDecoder;
let exportingBoard = false;
let duplicateReview;
let folderInbox;
let folderInboxError;
let browserCapture;
let offlineWeb;
let offlineWebError;
let windowsUpdates;
let windowsInstallationBusy = false;
const exportDestinations = new Map();

app.setName('见藏');
if (process.platform === 'win32') app.setAppUserModelId('com.jiancang.desktop');
protocol.registerSchemesAsPrivileged([{
  scheme: 'jiancang', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

function catalogForRenderer(catalog) {
  if (!catalog) return null;
  const { publicLibrary, deletionConflictSignatures } = catalog;
  if (!deletionConflictSignatures?.length || !syncWriter || syncWriterError) return publicLibrary;
  const acknowledged = syncWriter.acknowledgedConflicts(publicLibrary.libraryId);
  const count = deletionConflictSignatures.filter(signature => acknowledged.has(signature)).length;
  return count ? { ...publicLibrary, syncConflicts: publicLibrary.syncConflicts - count } : publicLibrary;
}

function state() {
  const current = selectedCatalog();
  return {
    library: catalogForRenderer(current), message, activeLibraryId: current?.registrationId ?? null,
    libraryOpening: libraryOpening?.status ?? null,
    libraries: registry.entries.map(({ id, name, root, kind, libraryId, syncWritable, eagleWritable }) => ({
      id, name: catalogs.get(id)?.publicLibrary.directoryName ?? name, root, kind, libraryId,
      ...(libraryStatuses.get(id) ?? { status: 'unknown' }),
      ...(kind === 'eagle' && { eagleWritable: eagleWritable === true }),
      ...(kind === 'jiancang' && { format: catalogs.get(id)?.publicLibrary.format ?? null, syncWritable: syncWritable === true,
        writeStatus: syncWriterError ? { pending: null, error: '无法打开本机同步队列。', conflicts: 0 } : syncWriter?.status(libraryId) }),
    })),
    catalogs: registry.entries.flatMap(({ id }) => {
      const catalog = catalogs.get(id);
      return catalog ? [{ libraryId: id, library: catalogForRenderer(catalog), revision: catalog.cacheKey }] : [];
    }),
  };
}

function scheduleStateEvent() {
  if (stateEvent) return;
  stateEvent = setImmediate(() => {
    stateEvent = null;
    void browserCapture?.enableDefault();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('library:state-changed', state());
    }
  });
}

function selectedCatalog() {
  return catalogs.get(registry.selectedId);
}

function readInWorker(directory, kind, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    // A provider may leave filesystem calls pending. Keep its I/O out of
    // the main process so cancellation does not strand shared I/O threads.
    const worker = utilityProcess.fork(path.join(__dirname, 'library-worker.cjs'), [], {
      serviceName: 'JianCang Library Reader', stdio: 'ignore', execArgv: ['--max-old-space-size=512'],
    });
    const timeoutMessage = kind === 'jiancang' || kind == null
      ? '读取素材库目录超时。如果文件夹位于 iCloud 云盘，请在资源管理器中右键选择「始终保留在此设备上」，等目录下载后重试。'
      : '读取素材库目录超时。请在资源管理器中确认文件夹可以打开，目录文件已下载，再重试。';
    const timer = setTimeout(() => finish(Object.assign(new Error(timeoutMessage), { code: 'LIBRARY_READ_TIMEOUT' })), 120_000);
    let settled = false;
    function abort() { finish(signal.reason); }
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.kill();
      if (error) reject(error);
      else resolve(result);
    }
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('spawn', () => {
      if (settled) return;
      try { worker.postMessage({ directory, kind }); }
      catch { finish(new Error('暂时无法请求读取素材库，请重试。')); }
    });
    worker.once('message', (result) => {
      if (result.error) finish(new Error(result.error));
      else finish(null, result);
    });
    worker.once('error', () => finish(new Error('暂时无法读取素材库，请重试。')));
    worker.once('exit', () => finish(new Error('素材库读取已结束，请重试。')));
  });
}

function startQueuedReads() {
  while (workerCount < 3 && workerQueue.length) {
    const { directory, kind, signal, resolve, reject } = workerQueue.shift();
    workerCount++;
    readInWorker(directory, kind, signal).then(resolve, reject).finally(() => {
      workerCount--;
      startQueuedReads();
    });
  }
}

function readCatalog(directory, kind, interactive = false, signal) {
  return new Promise((resolve, reject) => {
    const request = {
      directory, kind, signal,
      resolve(value) { signal?.removeEventListener('abort', cancelQueued); resolve(value); },
      reject(error) { signal?.removeEventListener('abort', cancelQueued); reject(error); },
    };
    function cancelQueued() {
      const queued = workerQueue.indexOf(request);
      if (queued === -1) return;
      workerQueue.splice(queued, 1);
      request.reject(signal.reason);
    }
    signal?.addEventListener('abort', cancelQueued, { once: true });
    if (interactive) workerQueue.unshift(request);
    else workerQueue.push(request);
    startQueuedReads();
  });
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'library.json');
}

async function keepRegistry(next) {
  registryDirty ||= JSON.stringify(next) !== JSON.stringify(registry);
  registry = next;
  libraryWatcher?.update(next.entries);
  if (!registryDirty) return;
  try { await writeRegistry(settingsFile(), registry); registryDirty = false; }
  catch { message = '本次连接已更新，保存素材库列表失败。'; }
}

function keepCatalog(id, root, library, fingerprint, identity) {
  const previous = catalogs.get(id);
  const sameFolder = previous?.root === root && previous.identity === identity;
  if (library.logIncomplete && sameFolder &&
      previous.publicLibrary.libraryId === library.libraryId && !previous.publicLibrary.logIncomplete) {
    return 'iCloud 正在接收变更，暂时显示上次完整的素材库。';
  }
  if (sameFolder && previous.fingerprint === fingerprint) return null;
  const { originals, originalCandidates, hydrationCandidates, sourceThumbnails, pathIndependentIdentity,
    deletionConflictSignatures, ...publicLibrary } = library;
  catalogs.set(id, { root, registrationId: id, cacheKey: randomUUID(), fingerprint, identity,
    publicLibrary, originals, originalCandidates, hydrationCandidates, sourceThumbnails, deletionConflictSignatures,
    assets: new Map(library.assets.map(asset => [asset.id, asset])),
  });
  return null;
}

async function loadLibrary(directory, { entry, expectedKind, relocating = false } = {}) {
  const controller = new AbortController();
  message = null;
  libraryOpening = { status: 'reading', directory, controller };
  scheduleStateEvent();
  try {
    const { root, library, fingerprint, identity } = await readCatalog(directory, entry?.kind ?? expectedKind, true, controller.signal);
    libraryOpening = null;
    if (entry && !locationMatches(entry, library, relocating)) {
      throw new Error('这个文件夹包含另一份素材库。请为原素材库选择正确的位置。');
    }
    const next = registerLibrary(registry, root, library, entry);
    const previous = registeredLibrary(next.selectedId);
    if (previous && previous.libraryId !== library.libraryId && !cloudOriginalError) {
      await cloudOriginals?.discard(previous.id);
      refreshAfterCloudOriginals.delete(previous.id);
    }
    catalogReads.delete(next.selectedId);
    message = keepCatalog(next.selectedId, root, library, fingerprint, identity);
    libraryStatuses.set(next.selectedId, { status: 'available' });
    await keepRegistry(next);
    resumeTrashCleanup(registeredLibrary(next.selectedId));
  } catch (error) {
    libraryOpening = error.code === 'LIBRARY_READ_TIMEOUT' ? { status: 'timed-out', directory } : null;
    message = error.message || '无法打开素材库，请稍后重试。';
  }
}

function refreshCatalog(entry, interactive = false, automatic = false) {
  const { id } = entry;
  const pending = catalogReads.get(id);
  if (pending) return pending;
  const previousCatalog = catalogs.get(id);
  const previousStatus = JSON.stringify(libraryStatuses.get(id));
  if (!automatic || !previousStatus) {
    libraryStatuses.set(id, { status: 'loading' });
    scheduleStateEvent();
  }
  let identityChanged = false;
  const reading = readCatalog(entry.root, entry.kind, interactive).then(({ root, library, fingerprint, identity }) => {
    if (catalogReads.get(id) !== reading) return null;
    if (!locationMatches(entry, library, false)) {
      identityChanged = true;
      throw new Error('这个文件夹包含另一份素材库，请重新定位。');
    }
    const detail = keepCatalog(id, root, library, fingerprint, identity);
    libraryStatuses.set(id, { status: 'available', ...(library.logIncomplete && { syncLogIncomplete: true }),
      ...(detail && { message: detail }) });
    return { ok: true, message: detail };
  }).catch(async error => {
    if (catalogReads.get(id) !== reading) return null;
    const detail = error.message || '无法打开素材库，请稍后重试。';
    const previous = catalogs.get(id);
    if (automatic && previous && !identityChanged) {
      const info = await Promise.race([
        fs.lstat(entry.root, { bigint: true }).catch(() => null), waitDelay(1500, null, { ref: false }),
      ]);
      if (catalogReads.get(id) !== reading) return null;
      if (info?.isDirectory() && !info.isSymbolicLink() && folderIdentity(info) === previous.identity) {
        libraryStatuses.set(id, { status: 'available', message: `已保留上次读取的目录。${detail}`,
          ...(entry.kind === 'jiancang' && { syncLogIncomplete: true }) });
        return { ok: false, message: detail };
      }
    }
    catalogs.delete(id);
    libraryStatuses.set(id, { status: 'unavailable', message: detail });
    return { ok: false, message: detail };
  }).finally(() => {
    if (catalogReads.get(id) === reading) {
      catalogReads.delete(id);
      if (!automatic || catalogs.get(id) !== previousCatalog || JSON.stringify(libraryStatuses.get(id)) !== previousStatus) {
        scheduleStateEvent();
      }
    }
  });
  catalogReads.set(id, reading);
  return reading;
}

function registeredLibrary(id) {
  return typeof id === 'string' ? registry.entries.find(entry => entry.id === id) : null;
}

function resumeTrashCleanup(entry) {
  if (entry?.kind !== 'local') return;
  const catalog = catalogs.get(entry.id);
  if (!catalog?.publicLibrary.pendingPurge) return;
  void scheduleLocalWrite(async () => {
    if (registeredLibrary(entry.id) !== entry) return;
    const result = await mutateLocalLibrary(entry.root, { action: 'retryPurge', expectedLibraryId: entry.libraryId,
      purgeRootIdentity: catalog.identity });
    if (result.pendingPurge !== catalog.publicLibrary.pendingPurge) await refreshCatalog(entry, false, true);
  }).catch(() => {});
}

async function initializeLibraries() {
  try {
    const saved = await readRegistry(settingsFile());
    registry = saved.registry;
    libraryWatcher?.update(registry.entries);
    if (saved.migrated) {
      registryDirty = true;
      await keepRegistry(registry);
    }
    const selected = registeredLibrary(registry.selectedId);
    if (selected) {
      void refreshCatalog(selected).then(result => {
        if (result?.ok) resumeTrashCleanup(selected);
        if (registry.selectedId === selected.id && result?.message && !message) {
          message = result.message;
          scheduleStateEvent();
        }
      });
    }
    for (const entry of registry.entries) {
      if (entry !== selected) void refreshCatalog(entry).then(result => { if (result?.ok) resumeTrashCleanup(entry); });
    }
  } catch { message = '无法读取已保存的素材库，请重新添加。'; }
}

function serializeLibraryAction(action) {
  const pending = libraryActions.then(async () => {
    await startup;
    return action();
  });
  libraryActions = pending.catch(() => {});
  return pending;
}

function scheduleLibraryAction(action) {
  return serializeLibraryAction(async () => {
    libraryOpening = null;
    try { await action(); }
    catch { message = '素材库操作未完成，请重试。'; }
    scheduleStateEvent();
    return state();
  });
}

function assetFor(id, registrationId) {
  return assetForCatalog(catalogs, registry.selectedId, id, registrationId);
}

function originalFor(id, registrationId) {
  const original = assetFor(id, registrationId);
  if (!original.file) throw new Error('原件暂不可用。');
  return original;
}

function isEagle(library) {
  return library.publicLibrary.kind === 'eagle';
}

function eagleImages(library) {
  return path.join(library.root, 'images');
}

function fileDirectory(library) {
  if (isEagle(library)) return eagleImages(library);
  if (library.publicLibrary.kind === 'local') return path.join(library.root, 'originals');
  return null;
}

async function openAsset(original, signal, verify = false) {
  const { library, asset, file, candidates } = original;
  if (isEagle(library)) return openContainedFile(eagleImages(library), file, asset.byteCount);
  if (library.publicLibrary.kind === 'local') return openLocalOriginal(library.root, asset);
  if (candidates || verify) return (await openVerifiedOriginal(library.root, candidates ?? [file], asset, signal)).handle;
  return openOriginal(library.root, file, asset.byteCount);
}

async function copyOriginal(original, target, protectedRoots) {
  const { library, asset, file, candidates } = original;
  const directory = fileDirectory(library);
  if (directory) return exportReadOnly(directory, file, asset.byteCount, target, protectedRoots);
  return exportVerified(library.root, candidates ?? file, asset, target, protectedRoots);
}

function assetResponse(body, type, status = 200, moreHeaders = {}) {
  return new Response(body, { status, headers: {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...moreHeaders,
  } });
}

async function livePhotoThumbnail(original, request, size) {
  const { asset } = original;
  const handle = await openAsset(original, request.signal, true);
  try {
    const part = await readLivePhotoPart(handle, asset.byteCount, 'still', request.signal);
    const image = nativeImage.createFromBuffer(part.bytes);
    if (!image.isEmpty()) {
      const { width, height } = image.getSize();
      const scale = Math.min(1, size.width / width, size.height / height);
      return scale === 1 ? image : image.resize({ width: Math.max(1, Math.round(width * scale)), quality: 'good' });
    }
    // Let the operating system decode HEIF when it has a native codec.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiancang-live-cover-'));
    try {
      const cover = path.join(directory, `cover.${part.extension}`);
      await fs.writeFile(cover, part.bytes, { flag: 'wx', mode: 0o600 });
      request.signal.throwIfAborted();
      return await nativeImage.createThumbnailFromPath(cover, size);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  } finally { await handle.close(); }
}

function proportionalSize(asset, size) {
  if (!asset.width || !asset.height) return size;
  const scale = Math.min(size.width / asset.width, size.height / asset.height);
  return { width: Math.max(1, Math.round(asset.width * scale)), height: Math.max(1, Math.round(asset.height * scale)) };
}

function webpPixels(bytes) {
  if (bytes.length < 25 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WEBP') return 0;
  const variant = bytes.toString('ascii', 12, 16);
  if (variant === 'VP8X' && bytes.length >= 30) {
    return (bytes.readUIntLE(24, 3) + 1) * (bytes.readUIntLE(27, 3) + 1);
  }
  if (variant === 'VP8L' && bytes[20] === 0x2f) {
    const packed = bytes.readUInt32LE(21);
    return ((packed & 0x3fff) + 1) * (((packed >>> 14) & 0x3fff) + 1);
  }
  if (variant === 'VP8 ' && bytes.length >= 30 && bytes.readUIntLE(23, 3) === 0x2a019d) {
    return (bytes.readUInt16LE(26) & 0x3fff) * (bytes.readUInt16LE(28) & 0x3fff);
  }
  return 0;
}

async function browserThumbnail(extension, byteCount, open, signal, knownPixels, checksum) {
  const type = previewTypes.get(extension);
  if (!type?.startsWith('image/') || !Number.isSafeInteger(byteCount) ||
      byteCount <= 0 || byteCount > thumbnailBufferLimit ||
      (knownPixels > thumbnailPixelLimit && extension !== 'webp')) return null;
  signal.throwIfAborted();
  const handle = await open();
  try {
    const bytes = await readStableBytes(handle, byteCount, thumbnailBufferLimit, signal);
    if (!bytes) return null;
    if (checksum && createHash('sha256').update(bytes).digest('hex') !== checksum) return null;
    if (extension === 'webp') {
      const pixels = webpPixels(bytes);
      if (!pixels || pixels > thumbnailPixelLimit) return null;
    }
    return { bytes, type };
  } finally { await handle.close(); }
}

function nativeThumbnailPayload(image) {
  return image && !image.isEmpty() ? { bytes: image.toPNG(), type: 'image/png' } : null;
}

async function readSourceThumbnail(library, source, signal, size) {
  const base = eagleImages(library);
  const readForBrowser = () => browserThumbnail(source.extension, source.byteCount,
    () => openContainedFile(base, source.file, source.byteCount), signal);
  if (browserFirstThumbnails.has(source.extension)) {
    const payload = await readForBrowser();
    if (payload) return payload;
  }
  const image = await withReadOnlyThumbnailFile(base, source.file, source.byteCount, signal, async file => {
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) return nativeImage.createThumbnailFromPath(file, size);
    const dimensions = image.getSize();
    const width = Math.min(dimensions.width, size.width, Math.max(1, Math.round(dimensions.width * size.height / dimensions.height)));
    return width === dimensions.width ? image : image.resize({ width, quality: 'good' });
  }).catch(() => null);
  return nativeThumbnailPayload(image) ?? await readForBrowser();
}

async function decodeThumbnail(original, signal, size) {
  const { asset, library, file, candidates } = original;
  const browserFirst = browserFirstThumbnails.has(asset.extension);
  const readForBrowser = () => browserThumbnail(asset.extension, asset.byteCount,
    () => openAsset(original, signal), signal, asset.width * asset.height, fileDirectory(library) ? undefined : asset.id);
  if (browserFirst) {
    const payload = await readForBrowser().catch(() => null);
    if (payload) return payload;
  }
  signal.throwIfAborted();
  const decode = verified => nativeImage.createThumbnailFromPath(verified, size);
  let thumbnail;
  try {
    // Keep scratch space bounded. Native decoding uses a private copy so an
    // original being moved in a sync folder cannot substitute another file.
    if (asset.byteCount <= 128 * 1024 ** 2) {
      const directory = fileDirectory(library);
      if (directory) {
        thumbnail = await withReadOnlyThumbnailFile(directory, file, asset.byteCount, signal, decode);
      } else {
        thumbnail = await withVerifiedThumbnailFile(library.root, candidates ?? [file], asset, signal, decode);
      }
    }
  } catch {}
  return nativeThumbnailPayload(thumbnail) ?? (browserFirst ? null : await readForBrowser());
}

function claimThumbnailSlot(signal) {
  signal.throwIfAborted();
  if (thumbnailJobs < 4) {
    thumbnailJobs++;
    return true;
  }
  if (thumbnailQueue.length >= 192) return false;
  return new Promise((resolve, reject) => {
    const queued = {
      ready() {
        signal.removeEventListener('abort', abort);
        resolve(true);
      },
    };
    function abort() {
      const index = thumbnailQueue.indexOf(queued);
      if (index >= 0) thumbnailQueue.splice(index, 1);
      reject(signal.reason);
    }
    signal.addEventListener('abort', abort, { once: true });
    thumbnailQueue.push(queued);
  });
}

function releaseThumbnailSlot() {
  const next = thumbnailQueue.shift();
  if (next) next.ready();
  else thumbnailJobs--;
}

function persistentThumbnailKey(library, asset, size) {
  return JSON.stringify([library.registrationId, library.root, library.publicLibrary.libraryId,
    asset.id, asset.mediaRevision ?? asset.id, asset.extension, asset.width, asset.height, size.width, size.height]);
}

function currentThumbnailAsset(library, asset) {
  const current = catalogs.get(library.registrationId);
  if (current === library) return true;
  if (current?.root !== library.root || current?.identity !== library.identity) return false;
  const latest = current.assets.get(asset.id);
  return latest && assetPreviewRevision(latest) === assetPreviewRevision(asset);
}

async function eagleThumbnailSourceRevision(original) {
  async function getStamp(file) {
    if (!file) return null;
    const stats = await fs.lstat(file, { bigint: true }).catch(() => null);
    return stats?.isFile() && !stats.isSymbolicLink() ? sourceStamp(stats) : null;
  }
  const stamps = await Promise.all([getStamp(original.file), getStamp(original.sourceThumbnail?.file)]);
  return thumbnailSourceRevision(...stamps);
}

async function rasterize(original, request, size) {
  const { asset, library, file, sourceThumbnail } = original;
  const isLivePhoto = asset.extension === 'livp';
  const canDecodeOriginal = file && (isLivePhoto || (asset.kind === 'image' && thumbnailTypes.has(asset.extension)));
  const canReadCache = sourceThumbnail || canDecodeOriginal || (!isEagle(library) && asset.kind === 'image');
  if (!canReadCache) return new Response(null, { status: 404 });
  if (thumbnailClearing) await thumbnailClearing.catch(() => {});
  const generation = thumbnailGeneration;
  const key = persistentThumbnailKey(library, asset, size);
  const found = thumbnails.get(key);
  if (found) return assetResponse(found.bytes, found.type);
  if (!await claimThumbnailSlot(request.signal)) return new Response(null, { status: 503 });
  try {
    request.signal.throwIfAborted();
    const cached = thumbnails.get(key);
    if (cached) return assetResponse(cached.bytes, cached.type);
    if (!currentThumbnailAsset(library, asset)) return new Response(null, { status: 404 });
    let payload = await thumbnailDisk.get(key);
    request.signal.throwIfAborted();
    if (!currentThumbnailAsset(library, asset)) return new Response(null, { status: 404 });
    if (payload) {
      if (generation === thumbnailGeneration && payload.bytes.length <= 512 * 1024) rememberThumbnail(key, payload);
      return assetResponse(payload.bytes, payload.type);
    }
    if (!sourceThumbnail && !canDecodeOriginal) return new Response(null, { status: 404 });
    if (sourceThumbnail && (size.width <= 480 || !canDecodeOriginal)) {
      payload = await readSourceThumbnail(library, sourceThumbnail, request.signal, size).catch(() => null);
    }
    if (!payload && canDecodeOriginal) {
      const target = proportionalSize(asset, size);
      payload = isLivePhoto ? nativeThumbnailPayload(await livePhotoThumbnail(original, request, target))
        : await decodeThumbnail(original, request.signal, target);
    }
    request.signal.throwIfAborted();
    if (!payload || !currentThumbnailAsset(library, asset)) return new Response(null, { status: 404 });
    if ((!isEagle(library) || asset.mediaRevision === await eagleThumbnailSourceRevision(original)) &&
        generation === thumbnailGeneration) {
      if (payload.bytes.length <= 512 * 1024) rememberThumbnail(key, payload);
      await thumbnailDisk.set(key, payload);
    }
    request.signal.throwIfAborted();
    if (!currentThumbnailAsset(library, asset)) return new Response(null, { status: 404 });
    return assetResponse(payload.bytes, payload.type);
  } finally {
    releaseThumbnailSlot();
  }
}

function rememberThumbnail(key, payload) {
  if (thumbnails.size >= 160) thumbnails.delete(thumbnails.keys().next().value);
  thumbnails.set(key, payload);
}

function rangeHeaders(range, size) {
  const headers = { 'Accept-Ranges': 'bytes', 'Content-Length': String(size) };
  if (range) {
    headers['Content-Length'] = String(range.end - range.start + 1);
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
  }
  return headers;
}

function serveStream(handle, request, range, type, status, headers) {
  const stream = handle.createReadStream(range || undefined);
  const abort = () => stream.destroy();
  request.signal.addEventListener('abort', abort, { once: true });
  stream.once('close', () => request.signal.removeEventListener('abort', abort));
  if (request.signal.aborted) abort();
  return assetResponse(Readable.toWeb(stream), type, status, headers);
}

async function serveLiveMotion(request, original) {
  const { asset } = original;
  const handle = await openAsset(original, request.signal, true);
  let streaming = false;
  try {
    const part = await readLivePhotoPart(handle, asset.byteCount, 'movie', request.signal);
    const type = 'video/quicktime';
    const range = parseByteRange(request.headers.get('range'), part.size);
    if (range === false) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${part.size}` } });
    const headers = rangeHeaders(range, part.size);
    const status = range ? 206 : 200;
    if (request.method === 'HEAD') return assetResponse(null, type, status, headers);
    if (part.bytes) return assetResponse(range ? part.bytes.subarray(range.start, range.end + 1) : part.bytes, type, status, headers);
    const response = serveStream(handle, request, {
      start: part.offset + (range?.start ?? 0), end: part.offset + (range?.end ?? part.size - 1),
    }, type, status, headers);
    streaming = true;
    return response;
  } finally { if (!streaming) await handle.close(); }
}

async function serveOriginal(request, original, { verify = false, pdf = false } = {}) {
  const { asset, sourceThumbnail } = original;
  const type = pdf ? 'application/pdf' : previewTypes.get(asset.extension);
  if (!type && (asset.extension === 'livp' || (asset.kind === 'image' &&
      (thumbnailTypes.has(asset.extension) || sourceThumbnail))) && request.method === 'GET') {
    return rasterize(original, request, { width: 1600, height: 1600 });
  }
  if (!type) return new Response(null, { status: 415 });
  const range = parseByteRange(request.headers.get('range'), asset.byteCount);
  if (range === false) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${asset.byteCount}` } });
  const handle = await openAsset(original, request.signal, verify || pdf);
  const headers = rangeHeaders(range, asset.byteCount);
  if (pdf) {
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'";
    headers['Content-Disposition'] = 'attachment';
  }
  if (request.method === 'HEAD' || asset.byteCount === 0) {
    await handle.close();
    return assetResponse(null, type, range ? 206 : 200, headers);
  }
  return serveStream(handle, request, range, type, range ? 206 : 200, headers);
}

function isEditableImage(asset) {
  return asset.kind === 'image' && !asset.trashed && editorImageTypes.has(asset.extension) &&
    asset.byteCount > 0 && asset.byteCount <= editorOriginalLimit;
}

function isTrimmableVideo(asset) {
  return asset.kind === 'video' && !asset.trashed && asset.byteCount > 0;
}

async function serveTrimPreview(request, sessionId) {
  const job = activeVideoTrim;
  if (job?.id !== sessionId || !job.preview || job.closed) return new Response(null, { status: 404 });
  const { file, size } = job.preview;
  const range = parseByteRange(request.headers.get('range'), size);
  if (range === false) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const headers = rangeHeaders(range, size);
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') return assetResponse(null, 'video/webm', status, headers);
  const handle = await openContainedFile(path.dirname(file), file, size);
  return serveStream(handle, request, range, 'video/webm', status, headers);
}

async function servePdfResource(request, resource) {
  for (const [pattern, type] of pdfResources) {
    if (!pattern.test(resource)) continue;
    const body = request.method === 'HEAD' ? null : await fs.readFile(path.join(__dirname, 'vendor/pdfjs', resource));
    return assetResponse(body, type, 200, { 'Content-Security-Policy': pdfWorkerCsp });
  }
  return new Response(null, { status: 404 });
}

async function serveTextPreview(request, original) {
  const result = await readTextPreview(original, openAsset, request.signal);
  return assetResponse(JSON.stringify(result), 'application/json; charset=utf-8', 200,
    { 'Content-Security-Policy': "sandbox; default-src 'none'" });
}

async function serve(request) {
  try {
    const url = new URL(request.url);
    if (url.username || url.password || url.port || !['GET', 'HEAD'].includes(request.method)) {
      return new Response(null, { status: 400 });
    }
    if (url.hostname === 'app' && !url.search && resources.has(url.pathname)) {
      const body = request.method === 'HEAD' ? null : await fs.readFile(path.join(__dirname, 'ui', url.pathname.slice(1)));
      return assetResponse(body, resources.get(url.pathname), 200, {
        'Content-Security-Policy': url.pathname === '/index.html' ? browsingCsp : csp,
      });
    }
    if (url.hostname === 'app' && !url.search && url.pathname.startsWith('/pdfjs/')) {
      return await servePdfResource(request, url.pathname.slice('/pdfjs/'.length));
    }
    if (url.hostname === 'app' && !url.search && url.pathname.startsWith('/trim-preview/')) {
      return await serveTrimPreview(request, url.pathname.slice('/trim-preview/'.length));
    }
    const isVideoFrameSource = url.hostname === 'app' && url.pathname.startsWith('/video/');
    const isBoardImage = url.hostname === 'app' && url.pathname.startsWith('/board-image/');
    const isPaletteImage = url.hostname === 'app' && url.pathname.startsWith('/palette-image/');
    const isEditorImage = url.hostname === 'app' && url.pathname.startsWith('/edit-image/');
    const isPdfSource = url.hostname === 'app' && url.pathname.startsWith('/pdf-original/');
    const isTextSource = url.hostname === 'app' && url.pathname.startsWith('/text-preview/');
    const pathname = isVideoFrameSource ? url.pathname.slice('/video'.length)
      : isBoardImage ? url.pathname.slice('/board-image'.length)
          : isPaletteImage ? url.pathname.slice('/palette-image'.length)
        : isEditorImage ? url.pathname.slice('/edit-image'.length)
          : isPdfSource ? url.pathname.slice('/pdf-original'.length)
            : isTextSource ? url.pathname.slice('/text-preview'.length) : url.pathname;
    const route = parseAssetRoute(pathname);
    if (!route) return new Response(null, { status: 404 });
    const { assetId, registrationId } = route;
    if (url.search) {
      const parameters = [...url.searchParams.entries()];
      const [[name, value] = [], retry] = parameters;
      if (parameters.length > 2 || (retry && (retry[0] !== 'retry' || !/^\d{1,16}$/.test(retry[1])))) {
        return new Response(null, { status: 404 });
      }
      if (name === 'media' && registrationId && (isVideoFrameSource || url.hostname === 'original')) {
        const original = originalFor(assetId, registrationId);
        const kind = isVideoFrameSource ? 'video' : 'audio';
        if (original.asset.kind === kind && assetContentRevision(original.asset) === value) {
          return await serveOriginal(request, original);
        }
        return new Response(null, { status: 404 });
      }
      if (name === 'preview' && registrationId && (isPaletteImage || isPdfSource || isTextSource ||
          ['thumbnail', 'original', 'live-motion'].includes(url.hostname))) {
        if (assetPreviewRevision(assetFor(assetId, registrationId).asset) !== value) return new Response(null, { status: 404 });
      } else {
        const revision = catalogs.get(registrationId)?.cacheKey;
        if (!revision || name !== 'revision' || value !== revision) return new Response(null, { status: 404 });
      }
    }
    if (isVideoFrameSource && registrationId) {
      const original = originalFor(assetId, registrationId);
      if (original.asset.kind === 'video') return await serveOriginal(request, original);
    }
    if (isBoardImage && registrationId && request.method === 'GET') {
      const original = assetFor(assetId, registrationId);
      if (isImageAsset(original.asset)) return await rasterize(original, request, { width: 1440, height: 1440 });
    }
    if (isPaletteImage && registrationId && request.method === 'GET') {
      const original = assetFor(assetId, registrationId);
      if (isImageAsset(original.asset)) return await rasterize(original, request, { width: 64, height: 64 });
    }
    if (isEditorImage && registrationId && url.search) {
      const original = originalFor(assetId, registrationId);
      if (isEditableImage(original.asset)) return await serveOriginal(request, original, { verify: true });
    }
    if (isPdfSource && registrationId) {
      const original = originalFor(assetId, registrationId);
      if (original.asset.kind === 'pdf' && original.asset.extension === 'pdf') return await serveOriginal(request, original, { pdf: true });
    }
    if (isTextSource && registrationId && url.search && request.method === 'GET') {
      return await serveTextPreview(request, originalFor(assetId, registrationId));
    }
    if (url.hostname === 'thumbnail') {
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      return await rasterize(assetFor(assetId, registrationId), request, { width: 480, height: 480 });
    }
    if (url.hostname === 'original') return await serveOriginal(request, originalFor(assetId, registrationId));
    if (url.hostname === 'live-motion') {
      const original = originalFor(assetId, registrationId);
      if (original.asset.extension === 'livp') return await serveLiveMotion(request, original);
    }
  } catch {
    return new Response(null, { status: 404 });
  }
  return new Response(null, { status: 404 });
}

function isMainFrame(event) {
  return event.sender === window?.webContents && event.senderFrame?.url === appPage && !event.senderFrame.parent;
}

function handle(channel, action) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isMainFrame(event)) {
      throw new Error('无法访问该操作。');
    }
    return action(...args);
  });
}

function mainWindowControls(dark) {
  return { height: 50, color: '#00000000', symbolColor: dark ? '#f0ece3' : '#292722' };
}

function distinctCatalogs(first, second) {
  return first.id !== second.id && first.libraryId !== second.libraryId && path.relative(first.root, second.root) !== '';
}

function assetClipboardOptions(items, choose) {
  const plural = items.length > 1;
  return [
    { label: plural ? '复制素材名称列表' : '复制素材名称', click: () => choose('names') },
    { label: plural ? '复制可用原件路径' : '复制原件路径', enabled: items.some(item => item.file), click: () => choose('paths') },
    { label: plural ? '复制来源网址列表' : '复制来源网址', enabled: items.some(item => webURL(item.asset.sourceURL)), click: () => choose('sources') },
    { label: '复制表格清单', click: () => choose('table') },
  ];
}

const defaultApplicationExtensions = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'psd',
  'mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'mpeg', 'mpg',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aif', 'aiff',
  'pdf', 'txt', 'md', 'csv', 'tsv', 'json', 'log', 'docx', 'xlsx', 'pptx',
]);

function canOpenInDefaultApplication(asset, file) {
  if (!file || asset.trashed) return false;
  const extension = path.extname(file).slice(1).toLowerCase();
  return defaultApplicationExtensions.has(extension) && extension === asset.extension?.toLowerCase();
}

async function openInDefaultApplication(id, registrationId) {
  try {
    const original = originalFor(id, registrationId);
    const { asset, library, file } = original;
    if (!canOpenInDefaultApplication(asset, file)) {
      return { ok: false, message: '此格式无法从见藏交给默认应用打开。' };
    }
    const failure = await useOriginalLocation(original, verifiedFile => {
      if (catalogs.get(library.registrationId)?.root !== library.root || !canOpenInDefaultApplication(asset, verifiedFile)) {
        throw new Error('原件位置已变化，请刷新素材库。');
      }
      return shell.openPath(verifiedFile);
    }, AbortSignal.timeout(90_000));
    return failure ? { ok: false, message: '无法用默认应用打开。请检查 Windows 中的文件关联。' } : { ok: true };
  } catch (error) {
    return { ok: false, message: error?.message || '找不到可打开的原件。' };
  }
}

function openAssetMenu(id, registrationId, options) {
  const { library, asset, file } = assetFor(id, registrationId);
  const previewable = isImageAsset(asset) || (asset.kind === 'video' && asset.thumbnailAvailable) ||
    (!!file && (['video', 'audio', 'pdf'].includes(asset.kind) || isTextPreview(asset)));
  const donor = registeredLibrary(library.registrationId);
  const destinations = donor ? registry.entries.filter(entry => distinctCatalogs(donor, entry) &&
    libraryStatuses.get(entry.id)?.status !== 'unavailable' &&
    (entry.kind === 'local' || entry.kind === 'jiancang' && entry.syncWritable)) : [];
  const eagleOnlyLocal = isEagle(library) && destinations.every(entry => entry.kind === 'local');
  const readStatus = libraryStatuses.get(library.registrationId);
  const canOrganize = readStatus?.status !== 'unavailable' &&
    (library.publicLibrary.kind === 'local' ||
      library.publicLibrary.kind === 'jiancang' && library.publicLibrary.format === 6 && donor?.syncWritable &&
      !!syncWriter && !syncWriterError && !readStatus?.syncLogIncomplete && !library.publicLibrary.logIncomplete);
  const memberships = new Set(asset.collectionIds);
  const hasAvailableCollection = canOrganize && !asset.trashed &&
    library.publicLibrary.collections.some(collection => !memberships.has(collection.id));
  return new Promise(resolve => {
    let selected = null;
    function option(label, action, enabled = true) {
      return { label, enabled, click() { selected = action; } };
    }
    activeAssetMenu?.closePopup?.(window);
    const menu = Menu.buildFromTemplate([
      option('打开预览', 'preview', previewable),
      ...(canOpenInDefaultApplication(asset, file) ? [option('用默认应用打开', 'open-default')] : []),
      option('打开置顶参考窗', 'reference', asset.kind === 'image' || asset.extension === 'livp'),
      ...(asset.extension === 'livp' && file && typeof options?.liveLoop === 'boolean' ? [{
        ...option('循环播放实况', 'live-loop'), type: 'checkbox', checked: options.liveLoop,
      }] : []),
      option('重新读取预览', 'retry'),
      ...(['jiancang', 'eagle'].includes(library.publicLibrary.kind) && downloadableAsset(asset)
        ? [option('取回原件…', 'cloud-original')] : []),
      ...(isEditableImage(asset) ? [option('图片工具…', 'image-tools', !!file)] : []),
      ...(isTrimmableVideo(asset) ? [option('裁剪视频…', 'video-trim', !!file)] : []),
      { type: 'separator' },
      ...(file && !asset.trashed ? [option('复制文件', 'copy-file')] : []),
      option('在资源管理器中显示', 'reveal', !!file),
      { label: '复制素材信息', submenu: assetClipboardOptions([{ asset, file }], mode => { selected = `clipboard-${mode}`; }) },
      ...(asset.kind === 'link' && webURL(asset.sourceURL) ? [option('打开网址', 'link'), option('网页离线阅读…', 'offline-web')] : []),
      ...(!asset.trashed && webURL(asset.sourceURL) ? [option('查找同来源网站', 'find-source-site')] : []),
      ...(isImageAsset(asset) && !asset.trashed ? [
        { type: 'separator' }, option('加入灵感板…', 'board-add'), option('查找相似图片', 'find-similar', !!file),
        option('AI 整理建议…', 'suggest-asset', !!file),
      ] : []),
      ...(eagleOnlyLocal || destinations.length ? [{ type: 'separator' },
        option(eagleOnlyLocal ? '复制到见藏本地库…' : '复制到其他库…', 'copy-local', !asset.trashed)] : []),
      ...(!asset.trashed && ['add', 'remove'].includes(options?.stash) ? [{ type: 'separator' },
        options.stash === 'add' ? option('加入暂存选片', 'stash-add') : option('移出暂存选片', 'stash-remove')] : []),
      ...(!canOrganize ? [] : asset.trashed
        ? [{ type: 'separator' }, option('恢复素材', 'restore-local'),
          ...(library.publicLibrary.kind === 'local' ? [option('永久删除…', 'purge-local')] : [])]
        : [
          { type: 'separator' }, option(asset.favorite ? '取消收藏' : '加入收藏', 'favorite-local'),
          { label: '评分', submenu: [1, 2, 3, 4, 5, 0].map(value => ({
            ...option(value ? `${value} 星` : '清除评分', `rate-local-${value}`),
            type: 'radio', checked: (asset.rating || 0) === value,
          })) },
          ...(hasAvailableCollection ? [option('加入集合…', 'add-collections-local')] : []),
          { type: 'separator' }, option('删除…', 'trash-local'),
        ]),
    ]);
    activeAssetMenu = menu;
    menu.popup({ window, callback: () => {
      if (activeAssetMenu === menu) activeAssetMenu = null;
      setImmediate(() => resolve(selected));
    } });
  });
}

async function openReferenceWindow(id, registrationId) {
  const { asset, library } = assetFor(id, registrationId);
  if (asset.kind !== 'image' && asset.extension !== 'livp') return { ok: false, message: '参考窗可打开图片。' };
  const key = `${library.registrationId}:${asset.id}`;
  const previous = referenceWindows.get(key);
  if (previous && !previous.isDestroyed()) {
    if (referenceContents.get(previous.webContents)?.presented) {
      if (previous.isMinimized()) previous.restore();
      previous.show();
    }
    return { ok: true };
  }
  const aspect = asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 1.2;
  const height = Math.min(620, 740 / aspect);
  const transparent = process.platform === 'win32';
  const reference = new BrowserWindow({
    width: Math.max(1, Math.round(aspect * height)), height: Math.max(1, Math.round(height)),
    useContentSize: true, resizable: false, maximizable: false,
    frame: false, thickFrame: false, transparent, enableLargerThanScreen: true,
    fullscreenable: false, show: false, alwaysOnTop: true, autoHideMenuBar: true,
    title: asset.name || '见藏参考窗', backgroundColor: transparent ? '#00000000' : '#131414',
    icon: path.join(__dirname, 'ui', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'reference-preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  referenceWindows.set(key, reference);
  reference.setMenuBarVisibility(false);
  reference.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  reference.webContents.on('will-navigate', event => event.preventDefault());
  reference.webContents.on('will-attach-webview', event => event.preventDefault());
  const available = library.originals.has(asset.id) ? 'original' : 'thumbnail';
  const url = `jiancang://app/reference.html#${available}/${library.registrationId}/${asset.id}`;
  const context = { window: reference, url, id: asset.id, registrationId: library.registrationId };
  referenceContents.set(reference.webContents, context);
  reference.once('ready-to-show', () => {
    if (context.presented) return;
    context.showTimer = setTimeout(() => showReference(context), 1200);
    context.showTimer.unref();
  });
  reference.on('closed', () => {
    clearTimeout(context.showTimer);
    referenceWindows.delete(key);
  });
  try {
    await reference.loadURL(url);
    return { ok: true };
  } catch (error) {
    if (!reference.isDestroyed()) reference.close();
    throw error;
  }
}

function showReference(context) {
  if (context.presented || context.window.isDestroyed()) return;
  clearTimeout(context.showTimer);
  context.presented = true;
  context.window.showInactive();
}

function sameReferenceBounds(first, second) {
  return first.width === second.width && first.height === second.height && first.x === second.x && first.y === second.y;
}

function applyReferenceZoom(context, start, target, scale, animate) {
  const reference = context.window;
  if (!animate || !context.presented) {
    context.resize = null;
    if (!sameReferenceBounds(start, target)) reference.setContentBounds(target);
    return;
  }
  const previous = context.resize;
  if (previous && sameReferenceBounds(previous.target, target)) return;
  context.resize = sameReferenceBounds(start, target) ? null : { scale, target, current: start };
  if (context.resize) reference.webContents.send('reference:zoom-frame');
}

function paintReferenceZoom(context) {
  const transition = context.resize;
  if (!transition || context.move) return { running: false };
  const { current, target } = transition;
  const sizeChange = Math.max(Math.abs(target.width / current.width - 1), Math.abs(target.height / current.height - 1));
  // Limit the change per painted frame when several wheel events land together.
  const amount = Math.min(0.38, 0.14 / sizeChange);
  const blend = (from, to) => Math.round(from + (to - from) * amount);
  const next = {
    width: blend(current.width, target.width), height: blend(current.height, target.height),
    x: blend(current.x, target.x), y: blend(current.y, target.y),
  };
  const distance = Math.max(...['x', 'y', 'width', 'height'].map(key => Math.abs(next[key] - target[key])));
  const finished = distance <= 3 || sameReferenceBounds(current, next);
  context.window.setContentBounds(finished ? target : next);
  transition.current = finished ? target : next;
  if (finished) context.resize = null;
  const { width, height } = context.window.getContentBounds();
  return { running: !!context.resize, width, height };
}

function referenceZoomAnchor(context, content, mode, anchorX, anchorY, pointer) {
  const previous = context.anchor;
  if (previous && pointer && mode === 'step' && Math.abs(previous.pointer.x - pointer.x) < 2 &&
      Math.abs(previous.pointer.y - pointer.y) < 2) return previous;
  const next = { x: content.x + content.width * anchorX, y: content.y + content.height * anchorY,
    fractionX: anchorX, fractionY: anchorY, pointer };
  context.anchor = pointer && mode === 'step' ? next : null;
  return next;
}

function resizeReference(context, mode, multiplier = 1, anchorX = 0.5, anchorY = 0.5, animate = false, pointer) {
  if (context.move) return { ok: false, message: '请松开鼠标后再缩放参考窗。' };
  const { window: reference, imageSize } = context;
  if (!imageSize || !['fit', 'actual', 'step'].includes(mode) ||
      !Number.isFinite(multiplier) || multiplier < 1 / 16 || multiplier > 16 ||
      ![anchorX, anchorY].every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
      (pointer != null && (![pointer.x, pointer.y].every(Number.isFinite)))) {
    throw new Error('无效的参考窗尺寸。');
  }
  const bounds = reference.getBounds();
  const content = reference.getContentBounds();
  const { workArea, scaleFactor } = screen.getDisplayMatching(bounds);
  const { width: naturalWidth, height: naturalHeight } = imageSize;
  // Allow a larger-than-desktop image while bounding the backing surface in physical pixels.
  const longest = Math.max(naturalWidth, naturalHeight);
  const maximum = Math.min(8192 / longest, Math.sqrt(48 * 1024 ** 2 / (naturalWidth * naturalHeight))) / scaleFactor;
  const minimum = Math.min(maximum, 56 / longest);
  const fit = Math.min(Math.min(740, workArea.width) / naturalWidth, Math.min(620, workArea.height) / naturalHeight);
  const current = context.resize?.scale ?? Math.max(content.width, content.height) / longest;
  const target = mode === 'fit' ? fit : mode === 'actual' ? 1 : current * multiplier;
  const scale = Math.min(maximum, Math.max(minimum, target));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const leftInset = content.x - bounds.x;
  const topInset = content.y - bounds.y;
  const last = context.resize?.target ?? content;
  if (mode === 'step' && Math.abs(width - last.width) <= 1 && Math.abs(height - last.height) <= 1) return { ok: true, scale };
  const anchor = referenceZoomAnchor(context, content, mode, anchorX, anchorY, pointer);
  let x = Math.round(anchor.x - width * anchor.fractionX);
  let y = Math.round(anchor.y - height * anchor.fractionY);
  if (mode !== 'step') {
    const left = workArea.x + leftInset;
    const top = workArea.y + topInset;
    x = Math.max(left + Math.min(0, workArea.width - width), Math.min(left + Math.max(0, workArea.width - width), x));
    y = Math.max(top + Math.min(0, workArea.height - height), Math.min(top + Math.max(0, workArea.height - height), y));
  }
  applyReferenceZoom(context, content, { width, height, x, y }, scale, animate === true);
  return { ok: true, scale };
}

function openReferenceMenu(context, imageVisible, canRetry) {
  const { window: reference } = context;
  const hasImage = imageVisible === true && !!context.imageSize;
  return new Promise(resolve => {
    let action = null;
    function option(label, id, fields) {
      return { label, ...fields, click() { action = id; } };
    }
    const menu = Menu.buildFromTemplate([
      option('复制图片', 'copy', { enabled: hasImage, accelerator: 'CommandOrControl+C' }),
      ...(canRetry === true ? [option('重新读取原件', 'retry')] : []),
      { type: 'separator' },
      option('原始大小（100%）', 'actual', { enabled: hasImage }),
      option('适应窗口', 'fit', { enabled: hasImage }),
      { label: '不透明度', submenu: [100, 80, 60, 40].map(value => option(`${value}%`, `opacity-${value}`, {
        type: 'checkbox', checked: Math.round(reference.getOpacity() * 100) === value,
      })) },
      { type: 'separator' },
      option('保持置顶', 'pin', { type: 'checkbox', checked: reference.isAlwaysOnTop() }),
      option('关闭参考窗', 'close'),
    ]);
    menu.popup({ window: reference, callback: () => setImmediate(() => resolve({ ok: true, action })) });
  });
}

function handleReference(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    const context = referenceContents.get(event.sender);
    if (!context || context.window.isDestroyed() || event.senderFrame?.url !== context.url || event.senderFrame.parent) {
      return { ok: false, message: '仅可从已打开的参考窗使用此操作。' };
    }
    try { return await action(context, ...args); }
    catch (error) { return { ok: false, message: error?.message || '参考窗操作未完成。' }; }
  });
}

let fallbackDragIcon;
function nativeDragPreview(thumbnail) {
  // Chromium's desktop file drag draws a path beside the icon inside a
  // 150-DIP-wide button. A transparent bitmap using that full width leaves
  // its text region empty without changing the native file drop payload.
  const canvasWidth = 150;
  const { width, height } = thumbnail.getSize(1);
  const bitmap = thumbnail.toBitmap({ scaleFactor: 1 }).map(channel => Math.round(channel * 0.72));
  const canvas = Buffer.alloc(canvasWidth * height * 4);
  const inset = Math.floor((canvasWidth - width) / 2);
  for (let row = 0; row < height; row++) {
    bitmap.copy(canvas, (row * canvasWidth + inset) * 4, row * width * 4, (row + 1) * width * 4);
  }
  return nativeImage.createFromBitmap(canvas, { width: canvasWidth, height, scaleFactor: 1 });
}

async function nativeDragIcon(file, asset) {
  const size = { width: 80, height: 80 };
  if (isImageAsset(asset) && asset.byteCount <= 128 * 1024 ** 2) {
    const thumbnail = await Promise.race([
      nativeImage.createThumbnailFromPath(file, size).catch(() => null),
      waitDelay(550, null, { ref: false }),
    ]);
    if (thumbnail && !thumbnail.isEmpty()) {
      const { width, height } = thumbnail.getSize();
      const fitted = width <= size.width && height <= size.height ? thumbnail
        : thumbnail.resize(width >= height ? { width: size.width } : { height: size.height });
      return nativeDragPreview(fitted);
    }
  }
  fallbackDragIcon ??= nativeDragPreview(nativeImage.createFromPath(path.join(__dirname, 'ui', 'icon.png')).resize({ width: 40 }));
  return fallbackDragIcon;
}

async function copyOriginalForTransfer(original) {
  const { library, asset } = original;
  const downloads = await fs.realpath(app.getPath('downloads'));
  const roots = registry.entries.map(entry => entry.root);
  const destination = path.join(downloads, '见藏拖出');
  if (roots.some(root => isWithin(root, destination))) throw new Error('请选择素材库以外的文件夹保存副本。');
  await fs.mkdir(destination, { recursive: true });
  const info = await fs.lstat(destination);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('无法打开「见藏拖出」文件夹。');
  let prepared;
  const result = await exportBatch({ items: [asset], destination, libraryRoots: roots,
    async copy(_item, target, protectedRoots) {
      if (catalogs.get(library.registrationId)?.root !== library.root) throw new Error('素材库已变更，请重新准备。');
      const currentRoots = [...protectedRoots, ...registry.entries.map(entry => entry.root)];
      await copyOriginal(original, target, currentRoots);
      prepared = target;
    },
  });
  if (!result.written) throw new Error(result.failed[0]?.message || '文件副本准备失败。');
  return prepared;
}

async function copyFileToClipboard(id, registrationId) {
  if (copyingAssetDetails) return { ok: false, message: '正在准备另一项复制，请稍后再试。' };
  copyingAssetDetails = true;
  try {
    const original = originalFor(id, registrationId);
    if (original.asset.trashed) throw new Error('请先从回收站恢复该素材。');
    const copy = await copyOriginalForTransfer(original);
    await clipboard.write([new ClipboardItem({ 'text/uri-list': pathToFileURL(copy).href + '\r\n' })]);
    return { ok: true, message: '文件已复制。可在资源管理器或支持文件粘贴的应用中粘贴。' };
  } catch (error) { return { ok: false, message: error?.message || '无法复制文件。' }; }
  finally { copyingAssetDetails = false; }
}

async function prepareDragCopy(id, registrationId) {
  if (preparingDrag) return { ok: false, message: '正在准备另一个拖出副本。' };
  preparingDrag = true;
  try {
    const original = originalFor(id, registrationId);
    const { asset } = original;
    const prepared = await copyOriginalForTransfer(original);
    const stamp = await fs.lstat(prepared);
    const icon = await nativeDragIcon(prepared, asset);
    const token = randomUUID();
    if (preparedDrags.size >= 64) preparedDrags.delete(preparedDrags.keys().next().value);
    preparedDrags.set(token, { file: prepared, stamp, icon });
    return { ok: true, token };
  } catch (error) { return { ok: false, message: error?.message || '拖出副本准备失败。' }; }
  finally { preparingDrag = false; }
}

async function saveVideoFrame({ id, registrationId, png, seconds } = {}) {
  if (!(png instanceof Uint8Array) || png.byteLength < 33 || png.byteLength > 128 * 1024 ** 2) {
    return { ok: false, message: '未能生成有效的 PNG 视频帧。' };
  }
  if (exporting) return { ok: false, message: '正在导出素材。' };
  exporting = true;
  try {
    const { asset } = assetFor(id, registrationId);
    if (asset.kind !== 'video') return { ok: false, message: '当前素材无法导出视频帧。' };
    const roots = registry.entries.map(entry => entry.root);
    const time = Number.isFinite(seconds) && seconds >= 0 ? ` - ${seconds.toFixed(3)}秒` : '';
    const choice = await dialog.showSaveDialog(window, {
      title: '导出当前帧', defaultPath: path.join(app.getPath('downloads'), exportFilename(`${asset.name}${time} - 视频帧`, 'png')),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (choice.canceled || !choice.filePath) return { ok: false, cancelled: true };
    const target = path.extname(choice.filePath).toLowerCase() === '.png' ? choice.filePath : `${choice.filePath}.png`;
    await exportCapturedFrame(png, target, [...roots, ...registry.entries.map(entry => entry.root)]);
    return { ok: true, message: '已导出当前帧。' };
  } catch (error) {
    return { ok: false, message: error.code === 'EEXIST' ? '同名文件已存在，请换一个保存名称。'
      : error.code ? '无法保存视频帧，请检查目标文件夹。' : error.message };
  } finally { exporting = false; }
}

function isImageAsset(asset) { return asset.kind === 'image' || asset.extension === 'livp'; }

function assetContentRevision(asset) {
  return JSON.stringify([asset.mediaRevision || asset.id, asset.byteCount, asset.width, asset.height]);
}

function assetPreviewRevision(asset) {
  return JSON.stringify([assetContentRevision(asset), asset.kind, asset.extension, !!asset.available, !!asset.thumbnailAvailable]);
}

function featureReference(original) {
  const { asset, library } = original;
  return { registrationId: library.registrationId, assetId: asset.id, revision: assetContentRevision(asset),
    inputState: `electron-raster-1-${Number(!!original.file)}-${Number(!!original.sourceThumbnail)}`,
    ...(library.publicLibrary.kind === 'jiancang' && { contentHash: asset.id }) };
}

function currentFeatureReference(reference) {
  if (typeof reference?.registrationId !== 'string' || typeof reference.assetId !== 'string') return null;
  try {
    const original = assetFor(reference.assetId, reference.registrationId);
    if (!isImageAsset(original.asset) || original.asset.trashed) return null;
    const current = featureReference(original);
    return current.revision === reference.revision ? current : null;
  } catch { return null; }
}

function featureReferences(references) {
  if (!Array.isArray(references) || references.length > 10_000) throw new Error('请缩小素材范围后重试。');
  return references.map(currentFeatureReference).filter(Boolean);
}

async function getImageDecoder() {
  if (imageDecoder) return imageDecoder;
  const decoder = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, backgroundThrottling: false, nodeIntegration: false,
  } });
  decoder.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  decoder.webContents.on('will-navigate', event => event.preventDefault());
  imageDecoder = decoder.loadURL('jiancang://app/image-decoder.html').then(() => decoder).catch(error => {
    if (!decoder.isDestroyed()) decoder.destroy();
    imageDecoder = null;
    throw error;
  });
  return imageDecoder;
}

async function featurePNG(original, side, signal = new AbortController().signal) {
  signal.throwIfAborted();
  const { asset, library } = original;
  if (!isImageAsset(asset) || asset.trashed) throw new Error('此素材没有可分析的图片。');
  const response = await rasterize(original, { signal }, { width: side, height: side });
  if (!response.ok) throw new Error('图片暂不可用，请取回原件后重试。');
  const input = Buffer.from(await response.arrayBuffer());
  const decoded = nativeImage.createFromBuffer(input);
  if (!decoded.isEmpty()) {
    const { width, height } = decoded.getSize();
    const ratio = Math.min(1, side / Math.max(width, height));
    return (ratio < 1 ? decoded.resize({ width: Math.max(1, Math.round(width * ratio)),
      height: Math.max(1, Math.round(height * ratio)) }) : decoded).toPNG();
  }
  const decoder = await getImageDecoder();
  const location = `jiancang://app/board-image/${library.registrationId}/${asset.id}?revision=${library.cacheKey}`;
  const encoded = await decoder.webContents.executeJavaScript(`window.decodeJianCangImage(${JSON.stringify(location)}, ${side})`);
  signal.throwIfAborted();
  if (typeof encoded !== 'string' || !encoded.startsWith('data:image/png;base64,') || encoded.length > 13_000_000) {
    throw new Error('无法解码这张图片。');
  }
  return Buffer.from(encoded.slice('data:image/png;base64,'.length), 'base64');
}

function suggestionAsset(reference) {
  try {
    const original = assetFor(reference.id, reference.registrationId);
    if (!isImageAsset(original.asset) || original.asset.trashed) return null;
    const entry = registeredLibrary(reference.registrationId);
    const library = original.library.publicLibrary;
    let writeBlock = '';
    if (!entry || libraryStatuses.get(entry.id)?.status === 'unavailable') writeBlock = 'unavailable';
    else if (entry.kind === 'eagle' && !original.asset.eagleItemId) writeBlock = 'unavailable';
    else if (entry.kind === 'eagle' && !entry.eagleWritable) writeBlock = 'eagle';
    else if (entry.kind === 'jiancang') {
      if (library.format !== 6) writeBlock = 'sync-upgrade';
      else if (!entry.syncWritable) writeBlock = 'sync-disabled';
      else if (library.logIncomplete) writeBlock = 'sync-incomplete';
    }
    return { ...original.asset, revision: featureReference(original).revision,
      writable: !writeBlock, writeBlock, canRecheckRenamedImage: entry?.kind === 'eagle' };
  } catch { return null; }
}

async function saveProjectBoard({ name, format, data, pages, entries } = {}) {
  if (!['png', 'pdf', projectExtension].includes(format) || typeof name !== 'string') return { ok: false, message: '请选择导出格式。' };
  if (exportingBoard) return { ok: false, message: '正在导出另一张灵感板。' };
  exportingBoard = true;
  try {
    const protectedRoots = registry.entries.map(entry => entry.root);
    const label = format === projectExtension ? '见藏灵感板工程' : format.toUpperCase();
    const choice = await dialog.showSaveDialog(window, {
      title: format === 'png' ? '导出灵感板长图' : `导出${label}`,
      defaultPath: path.join(app.getPath('downloads'), exportFilename(name.trim() || '灵感板', format)),
      filters: [{ name: label, extensions: [format] }],
    });
    if (choice.canceled || !choice.filePath) return { cancelled: true };
    const target = path.extname(choice.filePath).toLowerCase() === `.${format}` ? choice.filePath : `${choice.filePath}.${format}`;
    await writeBoardExport({ target, format, data, pages, project: { name, entries },
      protectedRoots: [...protectedRoots, ...registry.entries.map(entry => entry.root)] });
    return { ok: true, message: '灵感板已导出。' };
  } catch (error) {
    const message = error.code === 'EEXIST' ? '已有同名文件，请换一个保存名称。' : error.message;
    return { ok: false, message: message || '无法导出灵感板。' };
  } finally { exportingBoard = false; }
}

async function openBoardProject() {
  const choice = await dialog.showOpenDialog(window, { title: '导入见藏灵感板工程', properties: ['openFile'],
    filters: [{ name: '见藏灵感板工程', extensions: [projectExtension] }] });
  const filename = choice.filePaths[0];
  if (choice.canceled || !filename) return { cancelled: true };
  return { ok: true, project: await readBoardProject(filename) };
}

function requireVisualIndex() {
  if (!visualIndex || visualIndexError) throw new Error('无法打开本机图片分析索引，请重启见藏。');
  return visualIndex;
}

function requireSuggestions() {
  if (!suggestions || suggestionsError) throw new Error('无法打开 AI 接口设置，请重启见藏。');
  return suggestions;
}

function requireFolderInbox() {
  if (!folderInbox || folderInboxError) throw new Error('无法打开本机监视目录设置，请重启见藏。');
  return folderInbox;
}

function requireOfflineWeb() {
  if (!offlineWeb || offlineWebError) throw new Error('无法打开本机离线网页，请重启见藏。');
  return offlineWeb;
}

function offlineLink(reference) {
  if (typeof reference?.id !== 'string' || typeof reference.registrationId !== 'string') return null;
  try {
    const { asset } = assetFor(reference.id, reference.registrationId);
    const sourceURL = asset.kind === 'link' && webURL(asset.sourceURL);
    return sourceURL ? { name: asset.name, sourceURL } : null;
  } catch { return null; }
}

async function folderInboxTarget({ targetId, collectionId } = {}, options) {
  const entry = registeredLibrary(targetId);
  if (entry?.kind !== 'local' && entry?.kind !== 'jiancang') throw new Error('请重新连接目标见藏素材库。');
  if (entry.kind === 'jiancang' && !entry.syncWritable) {
    throw new Error('请在目标同步库的「同步状态」中开启双向同步。');
  }
  if (!catalogs.has(entry.id)) await refreshCatalog(entry, false, true);
  const library = availableInboxLibrary(entry, options);
  const collection = collectionId && library.collections.find(item => item.id === collectionId);
  if (collectionId && !collection) throw new Error('目标集合暂不可用，请重新选择集合。');
  return { id: entry.id, name: library.directoryName, collectionName: collection?.name ?? null };
}

function availableInboxLibrary(entry, { allowPending = false } = {}) {
  const catalog = catalogs.get(entry.id);
  const readStatus = libraryStatuses.get(entry.id);
  if (!catalog || registeredLibrary(entry.id) !== entry || readStatus?.status !== 'available') {
    throw new Error('目标素材库暂不可用，恢复连接后会继续检查。');
  }
  if (entry.kind === 'jiancang') {
    if (catalog.publicLibrary.format !== 6) throw new Error('请先将目标同步库升级到格式 6。');
    if (!syncWriter || syncWriterError) throw new Error('无法打开本机同步队列，请重启见藏。');
    if (readStatus.syncLogIncomplete || catalog.publicLibrary.logIncomplete) {
      throw new Error('目标同步库的目录记录尚未同步完整，待 iCloud 同步后会继续检查。');
    }
    const { pending, error } = syncWriter.status(entry.libraryId);
    if (!allowPending && pending && error) throw new Error('目标同步库仍有待提交的修改，请在「同步状态」中重试。');
  }
  return catalog.publicLibrary;
}

async function browserCaptureTarget({ targetId, libraryId, collectionId } = {}, options) {
  if (typeof targetId !== 'string' || (collectionId != null && typeof collectionId !== 'string')) {
    throw new Error('请选择要接收浏览器采集的素材库。');
  }
  const previous = registeredLibrary(targetId);
  if (libraryId != null && previous?.libraryId !== libraryId) throw new Error('目标素材库已变化，请重新选择。');
  const { name, collectionName } = await folderInboxTarget({ targetId, collectionId }, options);
  const entry = writableLibrary(targetId);
  if (entry !== previous) throw new Error('目标素材库已变化，请重新选择。');
  const collections = catalogs.get(entry.id)?.publicLibrary.collections ?? [];
  const [trail] = collectionId ? sourceCollectionPaths([collectionId], collections) : [];
  const collectionPath = trail?.join(' / ') || collectionName;
  return { targetId, collectionId, libraryId: entry.libraryId, destination: collectionPath ? name + ' / ' + collectionPath : name };
}

function browserCaptureLibraries() {
  const libraries = [];
  for (const entry of registry.entries) {
    if (entry.kind !== 'local' && !(entry.kind === 'jiancang' && entry.syncWritable)) continue;
    try {
      const library = availableInboxLibrary(entry);
      libraries.push({ targetId: entry.id, libraryId: entry.libraryId,
        name: library.directoryName, collections: library.collections });
    } catch {
      // Temporarily unavailable libraries remain visible in the desktop library manager.
    }
  }
  return libraries;
}

function defaultBrowserCaptureTarget() {
  const selected = registeredLibrary(registry.selectedId);
  if ((selected?.kind === 'local' || selected?.syncWritable) && catalogReads.has(selected.id)) return null;
  const available = browserCaptureLibraries();
  return available.find(library => library.targetId === selected?.id)
    ?? available.find(library => registeredLibrary(library.targetId)?.kind === 'local')
    ?? available[0];
}

async function createBrowserCaptureCollection(selection, name) {
  return scheduleLocalWrite(async () => {
    const { targetId, collectionId: parentId } = await browserCaptureTarget(selection);
    const entry = writableLibrary(targetId);
    const command = { action: 'createCollection', name, parentId };
    const result = await commitLibraryMutation(entry, command);
    if (result.pending) throw new Error('新集合已加入同步队列，写入完成后可在浏览器中选择。');
    await catalogReads.get(targetId);
    if (registeredLibrary(targetId) !== entry) throw new Error('目标素材库已变化，请重新选择。');
    await refreshCatalog(entry, false, true);
    const collection = catalogs.get(targetId)?.publicLibrary.collections.find(item => item.id === result.id);
    if (!collection) throw new Error('集合已创建，请重新读取浏览器采集列表。');
    return collection;
  });
}

async function approveBrowserCaptureConnection(signal) {
  if (!window || window.isDestroyed() || signal.aborted) return false;
  if (window.isMinimized()) window.restore();
  const decision = await dialog.showMessageBox(window, {
    type: 'question', title: '连接浏览器扩展',
    message: '允许见藏浏览器扩展连接？',
    detail: '连接后，扩展可以查看可写素材库及集合，并采集网页图片和链接。请确认你刚刚在浏览器中发起了连接。',
    buttons: ['取消', '允许连接'], defaultId: 0, cancelId: 0, noLink: true, signal,
  });
  return decision.response === 1;
}

async function addFolderInbox(settings) {
  const inbox = requireFolderInbox();
  await folderInboxTarget(settings);
  const selection = await dialog.showOpenDialog(window, {
    title: '选择要监视的文件夹', properties: ['openDirectory'], defaultPath: app.getPath('downloads'),
  });
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  return inbox.add({ targetId: settings.targetId, collectionId: settings.collectionId,
    includeExisting: settings.includeExisting === true, recursive: settings.recursive === true, sourcePath: selection.filePaths[0] });
}

function featureEvent(channel, data) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, data);
}

function windowsInstallation() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null;
  const { version } = require('./package.json');
  const directory = path.dirname(process.execPath);
  const destination = path.join(process.env.LOCALAPPDATA, 'Programs', 'JianCang', `app-${version}`);
  const executable = path.join(destination, '见藏.exe');
  return { directory, destination, executable, script: path.join(directory, 'Install-JianCang.ps1'),
    installed: path.relative(process.execPath, executable) === '' };
}

async function checkWindowsInstallation() {
  const installation = windowsInstallation();
  if (!installation) return { ok: true, supported: false };
  const { directory, destination, installed, script } = installation;
  const hasScript = await fs.stat(script).then(stat => stat.isFile(), () => false);
  const hasFileList = await fs.stat(path.join(directory, 'install-files.json')).then(stat => stat.isFile(), () => false);
  return { ok: true, supported: true, directory, destination, installed, canManage: hasScript && hasFileList };
}

async function addDesktopShortcutAfterUpgrade() {
  const installation = windowsInstallation();
  if (!installation?.installed) return;
  const marker = path.join(app.getPath('userData'), 'desktop-shortcut-v1');
  if (await fs.access(marker).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) return;
  const desktop = app.getPath('desktop');
  const shortcuts = ['见藏.lnk', '见藏（Windows）.lnk'].map(name => path.join(desktop, name));
  let existing = false;
  for (const shortcut of shortcuts) {
    const stat = await fs.lstat(shortcut).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    let target;
    try { target = shell.readShortcutLink(shortcut).target; }
    catch { continue; }
    if (target && path.relative(target, installation.executable) === '') existing = true;
  }
  if (!existing) {
    const temporary = path.join(app.getPath('temp'), `jiancang-${randomUUID()}.lnk`);
    try {
      if (!shell.writeShortcutLink(temporary, 'create', {
        target: installation.executable, cwd: installation.directory, description: '见藏桌面快捷方式',
        icon: installation.executable, iconIndex: 0,
      })) throw new Error('无法创建桌面快捷方式。');
      for (const shortcut of shortcuts) {
        try { await fs.copyFile(temporary, shortcut, COPYFILE_EXCL); existing = true; break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
    } finally { await fs.rm(temporary, { force: true }); }
  }
  if (existing) await fs.writeFile(marker, '');
}

async function launchWindowsInstaller(args) {
  const installation = windowsInstallation();
  if (!installation || !process.env.SystemRoot) throw new Error('此操作需要 Windows 安装包。');
  await localWrites;
  if (exporting || exportingBoard || backupOperation) throw new Error('请等导出、备份或恢复完成后再继续。');
  await fs.access(installation.script);
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File',
    installation.script, ...args, '-WaitPid', String(process.pid)],
  { cwd: app.getPath('temp'), detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  setImmediate(() => app.quit());
}

async function manageWindowsInstallation(action) {
  if (!['install', 'uninstall'].includes(action)) throw new Error('无法识别此安装操作。');
  if (windowsInstallationBusy || ['checking', 'downloading', 'launching'].includes(windowsUpdates.status().phase)) {
    throw new Error('软件更新正在处理，请稍后再试。');
  }
  windowsInstallationBusy = true;
  let handedOff = false;
  try {
    const installation = await checkWindowsInstallation();
    if (!installation.canManage) throw new Error('找不到完整的安装文件，请使用见藏安装程序。');
    if (action === 'uninstall') {
      if (!installation.installed) throw new Error('请打开已安装的见藏后再卸载。');
      const decision = await dialog.showMessageBox(window, {
        type: 'warning', title: '卸载见藏', message: '卸载见藏？',
        detail: '见藏将关闭。素材库和应用资料会保留。',
        buttons: ['取消', '卸载见藏'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (decision.response !== 1) return { cancelled: true };
    }
    await launchWindowsInstaller(action === 'uninstall' ? ['-Uninstall'] : ['-ShowCompletion']);
    handedOff = true;
    return { ok: true };
  } finally { if (!handedOff) windowsInstallationBusy = false; }
}

function startWindowsUpdates() {
  const { version, windowsUpdateUrl } = require('./package.json');
  const { publicKey } = require('./update-trust.json');
  // The renderer session blocks HTTP and HTTPS. Updates use their own network session.
  const network = session.fromPartition('windows-update', { cache: false });
  const requestUpdate = createUpdateRequest(network, net.request);
  let systemProxy;
  windowsUpdates = createWindowsUpdater({ profile: app.getPath('userData'), version, publicKey,
    installed: windowsInstallation()?.installed === true,
    defaultSource: windowsUpdateUrl ? { url: windowsUpdateUrl } : null,
    notify: status => featureEvent('windows-update:changed', status),
    async request(url, options) {
      systemProxy ??= network.setProxy({ mode: 'system' }).then(() => network.forceReloadProxyConfig());
      await systemProxy;
      return requestUpdate(url, options);
    },
    launch(archive, release) {
      return launchWindowsInstaller(['-Archive', archive, '-ExpectedVersion', release.version, '-ExpectedSha256', release.sha256,
        '-ShowCompletion']);
    },
  });
  return windowsUpdates.initialize();
}

function storageLibraries() {
  return registry.entries.map(({ id, name, kind }) => {
    const library = catalogs.get(id)?.publicLibrary;
    const row = { id, name: library?.directoryName ?? name, kind, loaded: !!library };
    if (!library) return row;
    let count = 0;
    let originals = 0;
    let bytes = 0;
    for (const asset of library.assets) {
      if (asset.trashed) continue;
      count++;
      if (asset.available) originals++;
      if (Number.isSafeInteger(asset.byteCount) && asset.byteCount > 0) bytes += asset.byteCount;
    }
    return { ...row, count, originals, bytes };
  });
}

async function storageStatus() {
  const cache = await thumbnailDisk.status().catch(() => null);
  return { ok: true, cache, libraries: storageLibraries() };
}

async function clearThumbnailStorage() {
  if (thumbnailClearing) throw new Error('正在清理缩略图，请稍候。');
  thumbnailGeneration++;
  thumbnails.clear();
  thumbnailClearing = thumbnailDisk.clear();
  try {
    const cache = await thumbnailClearing;
    return { ok: true, cache, libraries: storageLibraries() };
  } catch {
    throw new Error('无法清理缩略图缓存，请检查应用文件夹权限并重试。');
  } finally {
    thumbnailClearing = undefined;
  }
}

function getCloudOriginalQueue() {
  if (!cloudOriginals || cloudOriginalError) throw new Error('无法打开原件取回队列，请重启见藏。');
  return cloudOriginals;
}

function cloudSource(id) {
  const entry = registeredLibrary(id);
  if (!entry || !['jiancang', 'eagle'].includes(entry.kind)) {
    throw Object.assign(new Error('请选择一个见藏同步库或 Eagle 库。'), { code: 'LIBRARY_CHANGED' });
  }
  return entry;
}

function downloadableAsset(asset) {
  return asset && !asset.trashed && asset.kind !== 'link' && Number.isSafeInteger(asset.byteCount) && asset.byteCount >= 0;
}

async function resolveCloudOriginal({ registrationId, libraryId, id }) {
  const entry = cloudSource(registrationId);
  if (entry.libraryId !== libraryId) throw Object.assign(new Error('素材库连接已变化。'), { code: 'LIBRARY_CHANGED' });
  if (!catalogs.has(entry.id)) await catalogReads.get(entry.id);
  const catalog = catalogs.get(entry.id);
  if (registeredLibrary(entry.id) !== entry || !catalog || catalog.publicLibrary.libraryId !== libraryId) {
    throw Object.assign(new Error('素材库暂未读到，请重新定位或刷新。'), { code: 'LIBRARY_CHANGED' });
  }
  const asset = catalog.assets.get(id);
  const candidatePaths = catalog.originalCandidates?.get(id) ?? [catalog.originals.get(id)].filter(Boolean);
  const candidates = [...new Set([...candidatePaths, ...(catalog.hydrationCandidates?.get(id) ?? [])])].slice(0, 32);
  if (!downloadableAsset(asset) || !candidates.length) {
    throw Object.assign(new Error('原件暂未同步到此文件夹，请等待 iCloud 后重试。'), { code: 'MISSING' });
  }
  return { root: catalog.root, rootIdentity: catalog.identity, kind: entry.kind, candidates,
    byteCount: asset.byteCount, ...(entry.kind === 'jiancang' && { sha256: asset.id }) };
}

async function refreshCloudSource(entry, { hadCatalog = false } = {}) {
  const refreshed = await refreshCatalog(entry, true, true);
  if (registeredLibrary(entry.id) !== entry) throw new Error('素材库连接已变化，请重新打开原件取回。');
  const catalog = catalogs.get(entry.id);
  if ((!refreshed?.ok && !hadCatalog) || !catalog || catalog.publicLibrary.libraryId !== entry.libraryId) {
    throw new Error('目前读不到素材库目录，请确认 iCloud Drive 已联网或重新定位。');
  }
  return catalog;
}

async function startCloudOriginals(id, { ids } = {}) {
  const queue = getCloudOriginalQueue();
  const entry = cloudSource(id);
  if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > 100_000 ||
      ids.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))) {
    throw new Error('请选择有效的素材。');
  }
  const catalog = await refreshCloudSource(entry, { hadCatalog: catalogs.has(id) });
  const selected = ids === undefined ? [...catalog.assets.values()] : [...new Set(ids)].map(assetId => catalog.assets.get(assetId));
  const items = selected.filter(downloadableAsset).map(({ id, name, byteCount }) => ({ id, name, byteCount }));
  if (!items.length) throw new Error('当前范围没有可取回的原件。');
  const result = await queue.enqueue(id, entry.libraryId, items, { recheck: true });
  if (result.added) refreshAfterCloudOriginals.add(id);
  return { ok: true, ...result, alreadyQueued: items.length - result.added,
    unavailable: ids === undefined ? 0 : selected.length - items.length };
}

async function retryCloudOriginal(id, { id: taskId } = {}) {
  const queue = getCloudOriginalQueue();
  const entry = cloudSource(id);
  if (taskId !== undefined && (typeof taskId !== 'string' || !/^[a-f0-9]{64}$/.test(taskId))) {
    throw new Error('请选择要重试的原件。');
  }
  await refreshCloudSource(entry, { hadCatalog: catalogs.has(id) });
  const count = await queue.retry(id, taskId);
  if (count) refreshAfterCloudOriginals.add(id);
  return { ok: true, count };
}

function notifyCloudOriginals(id) {
  featureEvent('cloud-originals:changed', id);
  const entry = registeredLibrary(id);
  if (!entry || !cloudOriginals || cloudOriginalError) return;
  const { pending, running, done } = cloudOriginals.status(id, { includeTasks: false });
  if (pending || running) refreshAfterCloudOriginals.add(id);
  else if (refreshAfterCloudOriginals.delete(id) && done) void refreshCatalog(entry, false, true).catch(() => {});
}

function copyCloudOriginalFailures(id) {
  cloudSource(id);
  const queue = getCloudOriginalQueue();
  const failureList = [];
  const clean = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ');
  let total = 0;
  for (let offset = 0; offset < 5000;) {
    const status = queue.status(id, { offset, limit: 100, filter: 'failed' });
    total = status.filteredTotal;
    if (!status.tasks.length) break;
    for (const item of status.tasks) failureList.push(`${clean(item.name)}\t${clean(item.message)}`);
    offset += status.tasks.length;
    if (offset >= total) break;
  }
  if (failureList.length) {
    if (total > failureList.length) failureList.push(`还有 ${total - failureList.length} 项失败任务，可在队列中查看。`);
    clipboard.writeText(['素材\t失败原因', ...failureList].join('\r\n'));
  }
  return { ok: true, count: Math.min(total, 5000) };
}

function selectedOriginals(references, { boardMetadata = false } = {}) {
  const unique = new Set();
  const items = [];
  for (const reference of references) {
    if (typeof reference?.id !== 'string' || typeof reference.registrationId !== 'string') continue;
    const { id, registrationId } = reference;
    const key = `${registrationId}:${id}`;
    if (unique.has(key)) continue;
    unique.add(key);
    const card = boardMetadata ? reference.board : null;
    const board = Number.isInteger(card?.order) && card.order >= 1 && card.order <= 80 ? {
      order: card.order,
      title: typeof card.title === 'string' ? card.title.slice(0, 160) : '',
      source: typeof card.source === 'string' ? card.source.slice(0, 120) : '',
      note: typeof card.note === 'string' ? card.note.slice(0, 480) : '',
    } : null;
    const selected = { id, registrationId, ...(board && { board }) };
    try {
      const original = assetFor(id, registrationId);
      items.push({ name: original.asset.name, extension: original.asset.extension,
        available: !!original.file && (!board || !original.asset.trashed), original, reference: selected });
    } catch { items.push({ name: board?.title || '已不可用的素材', available: false, reference: selected }); }
  }
  return items;
}

function clipboardItems(references) {
  if (!Array.isArray(references) || references.length === 0 || references.length > 5000) {
    throw new Error('请选择素材，每次最多复制 5,000 项。');
  }
  const items = selectedOriginals(references).map(item => item.original).filter(Boolean);
  if (!items.length) throw new Error('所选素材已变化，请重新选择。');
  return items;
}

function openAssetClipboardMenu(references) {
  const items = clipboardItems(references);
  return new Promise(resolve => {
    let mode;
    Menu.buildFromTemplate(assetClipboardOptions(items, value => { mode = value; }))
      .popup({ window, callback: () => setImmediate(() => resolve(mode ? { ok: true, mode } : { cancelled: true })) });
  });
}

async function useOriginalLocation(original, visit, signal) {
  const { library, asset, file, candidates } = original;
  const verified = candidates ? await openVerifiedOriginal(library.root, candidates, asset, signal)
    : { file, handle: await openAsset(original, signal) };
  try {
    signal?.throwIfAborted();
    return await visit(verified.file);
  } finally { await verified.handle.close(); }
}

async function copyAssetDetails(references, mode) {
  if (!clipboardModes.has(mode)) throw new Error('请选择要复制的素材信息。');
  if (copyingAssetDetails) throw new Error('正在准备另一份素材信息，请稍后再试。');
  const items = clipboardItems(references);
  if (mode === 'paths' && items.length > 128) throw new Error('每次最多复制 128 项原件路径，请分批复制。');
  copyingAssetDetails = true;
  try {
    const cells = [];
    const signal = mode === 'paths' ? AbortSignal.timeout(90_000) : undefined;
    for (const item of items) {
      let originalPath;
      if (mode === 'paths' && item.file && !signal.aborted) {
        try {
          originalPath = await useOriginalLocation(item, file => {
            const catalog = catalogs.get(item.library.registrationId);
            const paths = catalog?.originalCandidates?.get(item.asset.id) ?? [catalog?.originals.get(item.asset.id)];
            return paths.includes(file) && !/[\r\n\t]/.test(file) ? file : undefined;
          }, signal);
        } catch { /* Skip paths that cannot be verified at the selected location. */ }
      }
      cells.push({ asset: item.asset, libraryName: item.library.publicLibrary.directoryName, originalPath });
    }
    const { text, copied, skipped } = clipboardText(cells, mode);
    if (!copied) throw new Error(mode === 'paths' ? '当前找不到可复制的原件路径，请取回原件或刷新后重试。'
      : '所选素材暂无可复制的内容。');
    clipboard.writeText(text);
    return { ok: true, copied, skipped, message: skipped ? `已复制 ${copied} 项，${skipped} 项暂无可用信息。` : `已复制 ${copied} 项。` };
  } finally { copyingAssetDetails = false; }
}

function structuredItems(references) {
  if (!Array.isArray(references) || !references.length || references.length > 10_000) {
    throw new Error('请选择 1 至 10,000 项素材。');
  }
  const items = selectedOriginals(references, { boardMetadata: true });
  if (!items.length) throw new Error('没有可导出的素材，请重新选择。');
  return items;
}

async function previewStructuredExport(references, options, recheck) {
  let items = structuredItems(references);
  if (recheck === true) {
    const registrations = new Set(items.map(item => item.reference.registrationId));
    const entries = registry.entries.filter(entry => registrations.has(entry.id));
    await Promise.all(entries.map(entry => refreshCatalog(entry, false, true)));
    items = structuredItems(references);
  }
  return planStructuredExport(items, options);
}

async function chooseStructuredExportDestination() {
  const choice = await dialog.showOpenDialog(window, {
    title: '选择将新建导出目录的位置', defaultPath: app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (choice.canceled || !choice.filePaths[0]) return { cancelled: true };
  const directory = await fs.realpath(choice.filePaths[0]);
  const roots = registry.entries.map(entry => entry.root);
  if (roots.some(root => isWithin(root, directory))) throw new Error('请选择素材库以外的文件夹。');
  const status = await fs.lstat(directory, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('这个导出目录已不可用。');
  const token = randomUUID();
  if (exportDestinations.size >= 24) exportDestinations.delete(exportDestinations.keys().next().value);
  exportDestinations.set(token, { directory, roots, identity: folderIdentity(status) });
  return { path: directory, token };
}

async function checkExportDestination(target) {
  const info = await fs.lstat(target.directory, { bigint: true }).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() || folderIdentity(info) !== target.identity ||
      await fs.realpath(target.directory) !== target.directory) {
    throw new Error('导出目录已移动，请重新选择。');
  }
}

async function startStructuredExport(references, options, token) {
  const target = exportDestinations.get(token);
  if (!target) throw new Error('请重新选择导出目录。');
  if (exporting) throw new Error('正在导出另一批素材，请稍后再试。');
  exporting = true;
  try {
    try { await checkExportDestination(target); }
    catch (error) {
      exportDestinations.delete(token);
      throw error;
    }
    const items = structuredItems(references);
    const { failedIndices, ...result } = await runStructuredExport({ items, options, destination: target.directory,
      libraryRoots: [...target.roots, ...registry.entries.map(entry => entry.root)],
      async copy(item, destination, protectedRoots) {
        const { library } = item.original;
        if (catalogs.get(library.registrationId)?.root !== library.root) throw new Error('素材库位置已变化，请刷新后重试。');
        await copyOriginal(item.original, destination, [...protectedRoots, ...registry.entries.map(entry => entry.root)]);
      },
      onProgress: progress => featureEvent('structured-export:progress', progress),
    });
    return { ...result, failedReferences: failedIndices.map(index => items[index].reference) };
  } finally { exporting = false; }
}

async function saveVideoMarkers({ id, registrationId, format, notes, duration } = {}) {
  if (!['csv', 'srt'].includes(format) || !Array.isArray(notes) || !notes.length) throw new Error('没有可导出的视频备注。');
  const { asset } = assetFor(id, registrationId);
  if (asset.kind !== 'video') throw new Error('请选择视频素材。');
  if (exporting) throw new Error('正在导出其他素材，请稍后再试。');
  exporting = true;
  try {
    const roots = registry.entries.map(entry => entry.root);
    const choice = await dialog.showSaveDialog(window, {
      title: `导出视频备注为 ${format.toUpperCase()}`,
      defaultPath: path.join(app.getPath('downloads'), exportFilename(`${asset.name} - 时间点备注`, format)),
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (choice.canceled || !choice.filePath) return { cancelled: true };
    const target = path.extname(choice.filePath).toLowerCase() === `.${format}` ? choice.filePath : `${choice.filePath}.${format}`;
    await writeVideoMarkers({ notes, format, target, duration: Number.isFinite(duration) && duration > 0 ? duration : asset.duration,
      protectedRoots: [...roots, ...registry.entries.map(entry => entry.root)] });
    return { ok: true, message: `已导出 ${format.toUpperCase()} 视频备注。` };
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('已有同名文件，请换一个保存名称。');
    if (error.code) throw new Error('无法保存视频备注，请检查目标文件夹。');
    throw error;
  } finally { exporting = false; }
}

function requireVideoTrim(id) {
  if (!activeVideoTrim || activeVideoTrim.closed || activeVideoTrim.id !== id || !activeVideoTrim.engine) {
    throw new Error('请重新打开视频工具。');
  }
  return activeVideoTrim;
}

function trimProgress(job, data) {
  if (activeVideoTrim !== job || job.closed) return;
  const phase = { preparing: 'copying', previewing: 'preview', saving: 'publishing' }[data.phase] || data.phase;
  featureEvent('video-trim:progress', { phase, progress: data.progress, sessionId: job.id });
}

async function runVideoTrim(job, action) {
  if (job.closed || job.controller) throw new Error('有一个视频任务正在进行。');
  const controller = new AbortController();
  const pending = Promise.resolve().then(() => action(controller.signal));
  job.controller = controller;
  job.pending = pending;
  try { return await pending; }
  catch (error) {
    if (controller.signal.aborted) return { cancelled: true };
    throw error;
  } finally {
    job.controller = null;
    job.pending = null;
  }
}

async function closeVideoTrim(job) {
  if (!job) return { ok: true };
  if (activeVideoTrim === job) activeVideoTrim = null;
  if (job.closed) return { ok: true };
  job.closed = true;
  job.controller?.abort();
  await job.pending?.catch(() => {});
  await job.engine?.close().catch(() => {});
  return { ok: true };
}

async function prepareVideoWorkspace() {
  const folder = path.join(await fs.realpath(app.getPath('userData')), 'video-work-v1');
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('视频临时目录不可用。');
  const stale = await fs.readdir(folder, { withFileTypes: true });
  await Promise.all(stale.filter(item => item.isDirectory() && /^\.jiancang-video-[a-zA-Z0-9]{6}$/.test(item.name))
    .map(item => fs.rm(path.join(folder, item.name), { recursive: true, force: true }).catch(() => {})));
  return folder;
}

async function probeTrimVideo({ id, registrationId, revision } = {}) {
  const entry = typeof registrationId === 'string' && registeredLibrary(registrationId);
  if (!entry || !revision || catalogs.get(registrationId)?.cacheKey !== revision) {
    throw new Error('素材列表已变化，请重新打开视频工具。');
  }
  const original = originalFor(id, registrationId);
  if (!isTrimmableVideo(original.asset)) throw new Error('请选择可读取的视频素材。');
  const previous = activeVideoTrim;
  const job = { id: randomUUID(), assetId: id, registrationId, name: original.asset.name, revision };
  activeVideoTrim = job;
  let ready = false;
  try {
    return await runVideoTrim(job, async signal => {
      await closeVideoTrim(previous);
      signal.throwIfAborted();
      const tools = path.join(__dirname, 'vendor', 'media', 'bin');
      const suffix = process.platform === 'win32' ? '.exe' : '';
      const ffmpeg = path.join(tools, `ffmpeg${suffix}`);
      const ffprobe = path.join(tools, `ffprobe${suffix}`);
      try { await Promise.all([fs.access(ffmpeg), fs.access(ffprobe)]); }
      catch { throw new Error('视频引擎不可用，请重新解压完整的见藏测试包。'); }
      const workspace = await (videoTrimWork ??= prepareVideoWorkspace().catch(error => {
        videoTrimWork = undefined;
        throw error;
      }));
      signal.throwIfAborted();
      job.engine = await prepareVideoTrim({ ffmpeg, ffprobe, extension: original.asset.extension,
        expectedBytes: original.asset.byteCount,
        expectedSha256: entry.kind === 'jiancang' ? original.asset.id : undefined, tempRoot: workspace, signal,
        openSource: () => openAsset(original, signal, true), onProgress: data => trimProgress(job, data) });
      signal.throwIfAborted();
      const { duration, width, height, hasAudio, formats, frameRate, previewAvailable } = job.engine;
      ready = true;
      return { ok: true, sessionId: job.id, duration, width, height, hasAudio, formats, frameRate, previewAvailable, maximumSegments };
    });
  } finally {
    if (!ready) await closeVideoTrim(job);
  }
}

function makeTrimPreview(sessionId) {
  const job = requireVideoTrim(sessionId);
  return runVideoTrim(job, async signal => {
    if (!job.preview) job.preview = await job.engine.makePreview({ signal, onProgress: data => trimProgress(job, data) });
    return { ok: true, previewURL: `jiancang://app/trim-preview/${job.id}` };
  });
}

function exportTrimmedVideo({ sessionId, id, registrationId, revision, start, end, segments, format, quality, resolution, muted } = {}) {
  const job = requireVideoTrim(sessionId);
  if (job.assetId !== id || job.registrationId !== registrationId || job.revision !== revision ||
      !job.engine.formats.includes(format)) {
    throw new Error('裁剪范围或输出选项已变化，请重新确认。');
  }
  const selection = { segments, start, end };
  validateTrimRanges(selection, job.engine.duration, job.engine.frameRate);
  return runVideoTrim(job, async signal => {
    if (exporting) throw new Error('正在导出其他素材，请稍后再试。');
    exporting = true;
    try {
      const choice = await dialog.showSaveDialog(window, {
        title: '导出裁剪后的视频副本',
        defaultPath: path.join(app.getPath('downloads'), exportFilename(`${job.name} - 裁剪`, format)),
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      signal.throwIfAborted();
      if (choice.canceled || !choice.filePath) return { cancelled: true };
      const target = path.extname(choice.filePath).toLowerCase() === `.${format}` ? choice.filePath : `${choice.filePath}.${format}`;
      const protectedRoots = registry.entries.map(entry => entry.root);
      await job.engine.export({ ...selection, format, quality, resolution, muted, target, protectedRoots, signal,
        onProgress: data => trimProgress(job, data) });
      return { ok: true };
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('已有同名文件，请换一个保存名称。');
      if (error.code === 'ENOSPC') throw new Error('磁盘空间不足，请释放空间后再试。');
      throw error;
    } finally { exporting = false; }
  });
}

async function saveEditedImage(input) {
  const { id, registrationId, mode, format } = input ?? {};
  if (typeof id !== 'string' || typeof registrationId !== 'string' || !['replace', 'export', 'sync-copy'].includes(mode)) {
    throw new Error('图片操作参数不正确。');
  }
  const { asset } = originalFor(id, registrationId);
  if (!isEditableImage(asset)) throw new Error('暂时无法编辑这张图，请刷新后重试。');
  if (mode === 'replace') return scheduleLocalWrite(async () => {
    const entry = registeredLibrary(registrationId);
    if (entry?.kind !== 'local') throw new Error('此库的图片可以导出编辑副本。');
    const result = await replaceLocalPicture(entry.root, { ...input, expectedLibraryId: entry.libraryId });
    await catalogReads.get(entry.id);
    if (registeredLibrary(entry.id) === entry) await refreshCatalog(entry, true, true);
    return { ok: true, ...result };
  });
  const bytes = validateEditedImage(input);
  const extension = format === 'jpeg' ? 'jpg' : format;
  if (mode === 'sync-copy') return scheduleLocalWrite(async () => {
    const entry = writableLibrary(registrationId);
    const original = originalFor(id, registrationId);
    if (entry.kind !== 'jiancang' || entry.libraryId !== input.expectedLibraryId ||
        original.library.publicLibrary.libraryId !== entry.libraryId || !isEditableImage(original.asset)) {
      throw new Error('同步库连接或素材已变化，请重新打开图片工具。');
    }
    const result = await syncWriter.upload(entry, { jobId: randomUUID(), editedSourceId: id,
      filename: exportFilename(original.asset.name, extension), kind: 'image', bytes, width: input.width, height: input.height });
    await rereadSyncCatalog(entry, true);
    return { ok: true, ...result, message: result.pending ? '同步副本已加入本机待提交队列。' : '已将编辑副本写入同步库。' };
  });
  if (exporting) throw new Error('正在导出其他素材，请稍后再试。');
  exporting = true;
  try {
    const roots = registry.entries.map(entry => entry.root);
    const choice = await dialog.showSaveDialog(window, {
      title: '导出编辑后的图片',
      defaultPath: path.join(app.getPath('downloads'), exportFilename(`${asset.name} - 编辑`, extension)),
      filters: [{ name: format.toUpperCase(), extensions: format === 'jpeg' ? ['jpg', 'jpeg'] : [extension] }],
    });
    if (choice.canceled || !choice.filePath) return { cancelled: true };
    const suffix = path.extname(choice.filePath).slice(1).toLowerCase();
    const target = suffix === extension || (extension === 'jpg' && suffix === 'jpeg') ? choice.filePath : `${choice.filePath}.${extension}`;
    await writeImageCopy(bytes, target, [...roots, ...registry.entries.map(entry => entry.root)]);
    return { ok: true };
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('已有同名文件，请换一个保存名称。');
    if (error.code) throw new Error('无法保存图片，请检查目标文件夹和可用空间。');
    throw error;
  } finally { exporting = false; }
}

async function writeImageCopy(bytes, target, roots, check) {
  const targetPath = await validateExportTarget(target, roots, '请选择素材库以外的位置。');
  const temporary = await fs.mkdtemp(path.join(path.dirname(targetPath), '.jiancang-image-'));
  try {
    const file = path.join(temporary, 'image');
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    await check?.();
    await fs.copyFile(file, targetPath, COPYFILE_EXCL);
  } finally { await fs.rm(temporary, { recursive: true, force: true }).catch(() => {}); }
}

function imageConversionItems(references, extension) {
  if (!Array.isArray(references) || !references.length || references.length > 1000) {
    throw new Error('每批可处理 1 至 1,000 张图片，请调整选择范围。');
  }
  const items = selectedOriginals(references);
  if (!items.length) throw new Error('没有可转换的图片，请重新选择。');
  return items.map(item => {
    const asset = item.original?.asset;
    if (asset && !isEditableImage(asset)) {
      return { ...item, available: false, failure: '原件的格式或文件大小超出图片转换支持范围。' };
    }
    const suffix = `.${asset?.extension}`;
    const name = item.name.toLowerCase().endsWith(suffix) ? item.name.slice(0, -suffix.length) : item.name;
    return { ...item, name, extension };
  });
}

function currentConversionOriginal(original) {
  const { asset, library } = original;
  const current = originalFor(asset.id, library.registrationId);
  if (current.library.root !== library.root || !isEditableImage(current.asset) ||
      featureReference(current).revision !== featureReference(original).revision) {
    throw new Error('素材已变化，请重新选择后转换。');
  }
  return current;
}

async function convertImage(original, options, signal) {
  const { asset, library } = currentConversionOriginal(original);
  const decoder = await getImageDecoder();
  signal.throwIfAborted();
  const token = randomUUID();
  const location = `jiancang://app/edit-image/${library.registrationId}/${asset.id}?revision=${library.cacheKey}`;
  const input = { ...options, location, token };
  const cancel = () => void decoder.webContents.executeJavaScript(`window.cancelJianCangImageConversion(${JSON.stringify(token)})`).catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const result = await decoder.webContents.executeJavaScript(`window.convertJianCangImage(${JSON.stringify(input)})`);
    signal.throwIfAborted();
    if (result?.error) throw new Error(result.error);
    const prefix = `data:image/${options.format};base64,`;
    if (typeof result?.data !== 'string' || !result.data.startsWith(prefix) || result.data.length > 56_000_000 ||
        Math.max(result.width, result.height) > options.maximumSide) throw new Error('无法生成所选格式的图片。');
    currentConversionOriginal(original);
    return validateEditedImage({ format: options.format, width: result.width, height: result.height,
      bytes: Buffer.from(result.data.slice(prefix.length), 'base64') });
  } catch (error) {
    if (signal.reason?.name === 'TimeoutError') throw new Error('读取或转换超时，请确认原件已下载后重试。');
    throw error;
  } finally { signal.removeEventListener('abort', cancel); }
}

async function startImageConversion(references, settings, token) {
  const { format, maximumSide, quality } = settings ?? {};
  if (!['jpeg', 'png', 'webp'].includes(format) || !Number.isInteger(maximumSide) ||
      maximumSide < 64 || maximumSide > 4096 || !Number.isInteger(quality) || quality < 20 || quality > 100) {
    throw new Error('请选择有效的图片格式、尺寸和画质。');
  }
  const target = exportDestinations.get(token);
  if (!target) throw new Error('请重新选择导出目录。');
  if (exporting) throw new Error('正在导出另一批素材，请稍后再试。');
  const items = imageConversionItems(references, format === 'jpeg' ? 'jpg' : format);
  const abort = new AbortController();
  activeImageConversion = abort;
  exporting = true;
  try {
    await checkExportDestination(target);
    const result = await exportBatch({ items, destination: target.directory,
      libraryRoots: [...target.roots, ...registry.entries.map(entry => entry.root)], signal: abort.signal,
      async copy(item, destination, protectedRoots) {
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]);
        const bytes = await convertImage(item.original, { format, maximumSide, quality }, signal);
        await checkExportDestination(target);
        const roots = [...protectedRoots, ...registry.entries.map(entry => entry.root)];
        await writeImageCopy(bytes, destination, roots, async () => {
          abort.signal.throwIfAborted();
          await checkExportDestination(target);
        });
      },
      onProgress: value => featureEvent('image-conversion:progress', value),
    });
    return { ...result, cancelled: abort.signal.aborted, total: items.length };
  } finally {
    activeImageConversion = undefined;
    exporting = false;
  }
}

function cancelImageConversion() {
  activeImageConversion?.abort();
  return { ok: !!activeImageConversion };
}

async function runLocalBackup(operation, value) {
  if (backupOperation) throw new Error('已有备份或恢复正在进行。');
  const controller = new AbortController();
  backupOperation = controller;
  try {
    const entry = operation === 'create' && registeredLibrary(value);
    if (operation === 'create' && entry?.kind !== 'local') throw new Error('请选择一个见藏本地库。');
    const directory = async (title, buttonLabel) => {
      const choice = await dialog.showOpenDialog(window, { title, buttonLabel, defaultPath: app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory'] });
      controller.signal.throwIfAborted();
      return !choice.canceled && choice.filePaths[0];
    };
    const backupRoot = operation === 'restore' && await directory('选择见藏备份文件夹', '选择备份');
    if (operation === 'restore' && !backupRoot) return { cancelled: true };
    const destination = await directory(operation === 'create' ? '选择备份存放位置' : '选择恢复后素材库的存放位置', '使用此文件夹');
    if (!destination) return { cancelled: true };
    const options = { destination, signal: controller.signal, protectedRoots: registry.entries.map(item => item.root),
      onProgress: progress => featureEvent('local-backup:progress', progress) };
    if (operation === 'create') return await scheduleLocalWrite(async () => {
      controller.signal.throwIfAborted();
      if (registeredLibrary(value) !== entry) throw new Error('本地库连接已经变化，请重新选择。');
      return createLocalBackup({ ...options, root: entry.root, expectedLibraryId: entry.libraryId });
    });
    const restored = await restoreLocalBackup({ ...options, backupRoot, name: value });
    const next = await scheduleLibraryAction(() => loadLibrary(restored.directory, { expectedKind: 'local' }));
    const registration = next.libraries.find(item => item.libraryId === restored.libraryId);
    return { ...restored, state: next, registrationId: registration?.id, message: registration ? undefined
      : '备份已恢复，请从「打开本地库」添加恢复后的文件夹。' };
  } catch (error) {
    if (controller.signal.aborted) return { cancelled: true };
    throw error;
  } finally { backupOperation = undefined; }
}

function syncConflictLibrary(id) {
  const entry = registeredLibrary(id);
  if (entry?.kind !== 'jiancang') throw new Error('请选择一个见藏同步库。');
  return entry;
}

function resolveSyncConflict(id, command) {
  return scheduleLocalWrite(async () => {
    const entry = syncConflictLibrary(id);
    writableLibrary(id);
    const result = await syncWriter.mutate(entry, { ...command, action: 'resolveConflict' });
    await catalogReads.get(id);
    if (registeredLibrary(id) === entry) await refreshCatalog(entry, true, true);
    return { ok: true, ...result };
  });
}

function duplicateOriginal(reference, { allowRevisionChange = false } = {}) {
  if (typeof reference?.registrationId !== 'string' || typeof reference.assetId !== 'string') return null;
  try {
    const original = assetFor(reference.assetId, reference.registrationId);
    if (original.asset.trashed || (!allowRevisionChange && featureReference(original).revision !== reference.revision)) return null;
    return original;
  } catch { return null; }
}

function describeDuplicate(original) {
  const { asset, library } = original;
  return { ...featureReference(original), available: !!original.file, byteCount: asset.byteCount,
    kind: asset.kind, extension: asset.extension, name: asset.name, sourceName: library.publicLibrary.directoryName };
}

function duplicateReferences(references) {
  if (!Array.isArray(references) || references.length > 50_000) throw new Error('请选择不超过 50,000 项的素材范围。');
  return references.flatMap(reference => {
    const original = duplicateOriginal(reference);
    return original ? [describeDuplicate(original)] : [];
  });
}

async function retryDuplicateLibrary(jobId, registrationId) {
  if (duplicateReview.status()?.jobId !== jobId) throw new Error('扫描结果已变化，请重新打开重复素材整理。');
  const entry = registeredLibrary(registrationId);
  if (!entry) throw new Error('请先重新连接该素材库。');
  await catalogReads.get(entry.id);
  await refreshCatalog(entry, true, true);
  return duplicateReview.retry(jobId, registrationId, {
    refreshReference(reference) {
      const original = duplicateOriginal(reference, { allowRevisionChange: true });
      return original ? describeDuplicate(original) : null;
    },
  });
}

async function scanVisualDuplicates(references, { signal } = {}) {
  const index = requireVisualIndex();
  const images = references.map(currentFeatureReference).filter(Boolean);
  if (!images.length) return [];
  const settings = { includeSignatures: true };
  let indexed = index.lookup(images, settings);
  const keyed = ref => `${ref.registrationId}:${ref.assetId}`;
  const indexedKeys = new Set(indexed.map(keyed));
  const remaining = images.filter(ref => !indexedKeys.has(keyed(ref)) && duplicateOriginal(ref)?.file);
  if (!remaining.length) return indexed;
  while (index.status()?.status === 'running') await waitDelay(120, undefined, { signal });
  signal?.throwIfAborted();
  const job = index.start(remaining);
  try {
    while (index.status()?.jobId === job.jobId && index.status()?.status === 'running') await waitDelay(120, undefined, { signal });
    indexed = index.lookup(images, settings);
    return indexed;
  } finally { if (signal?.aborted) index.cancel(job.jobId); }
}

function duplicateMergeContext(command) {
  const plan = duplicateReview.planMerge(command);
  const entry = writableLibrary(plan.keeper.registrationId);
  if (entry.kind !== 'local') throw new Error('合并标签和集合适用于同一本地库的副本。');
  const catalog = catalogs.get(entry.id);
  if (!catalog || libraryStatuses.get(entry.id)?.status === 'unavailable') throw new Error('请重新连接本地库。');
  const assets = [plan.keeper, ...plan.selected].map(ref => {
    const original = duplicateOriginal(ref);
    if (!original?.file || !original.asset.mediaRevision) throw new Error('有原件已变化或无法读取，请重新扫描该组。');
    return original.asset;
  });
  return { entry, catalog, plan, assets };
}

async function previewDuplicateMerge(command) {
  const { keeper: ref } = duplicateReview.planMerge(command);
  const entry = registeredLibrary(ref.registrationId);
  if (entry?.kind !== 'local') throw new Error('合并标签和集合适用于同一本地库的副本。');
  await catalogReads.get(entry.id);
  const refreshed = await refreshCatalog(entry, true, true);
  if (!refreshed?.ok || registeredLibrary(entry.id) !== entry) throw new Error(refreshed?.message || '请重新连接本地库。');
  const { catalog, assets: [keeper, ...copies] } = duplicateMergeContext(command);
  const { addedTags, addedCollectionIds } = duplicateMergeMetadata(keeper, copies);
  const collections = new Map(catalog.publicLibrary.collections.map(item => [item.id, item]));
  const addedCollections = addedCollectionIds.map(id => {
    const trail = [];
    const seen = new Set();
    for (let current = id; current && !seen.has(current);) {
      const folder = collections.get(current);
      if (!folder) throw new Error('集合已变化，请重新扫描该组。');
      seen.add(current);
      trail.push(folder.name);
      current = folder.parentId;
    }
    return trail.reverse().join(' / ');
  });
  return { ok: true, revision: catalog.publicLibrary.revision, keeperName: keeper.name, addedTags, addedCollections };
}

function mergeDuplicateMembers(command) {
  return scheduleLocalWrite(async () => {
    const { entry, catalog, plan, assets } = duplicateMergeContext(command);
    if (command.revision !== catalog.publicLibrary.revision) throw new Error('素材资料已变化，请重新预览合并。');
    const expectedMedia = new Map(assets.map(asset => [asset.id, asset.mediaRevision]));
    const moved = plan.selected;
    await commitLibraryMutation(entry, { action: 'mergeDuplicates', keeperId: plan.keeper.assetId,
      ids: moved.map(ref => ref.assetId), expectedRevision: command.revision, expectedMedia });
    duplicateReview.consumeTrash({ jobId: command.jobId, groupId: command.groupId, moved });
    await catalogReads.get(entry.id);
    if (registeredLibrary(entry.id) === entry) await refreshCatalog(entry, true, true);
    return { ok: true, moved, message: `已合并标签和集合，${moved.length} 项已移到回收站。` };
  });
}

async function trashDuplicateMembers(command) {
  return scheduleLocalWrite(async () => {
    const plan = duplicateReview.planTrash(command);
    const identity = ref => `${ref.registrationId}:${ref.assetId}`;
    const removing = new Set(plan.selected.map(identity));
    let survivor = false;
    for (const member of plan.members) {
      if (removing.has(identity(member))) continue;
      const original = duplicateOriginal(member);
      if (!original?.file) continue;
      try {
        const handle = await openAsset(original);
        await handle.close();
        survivor = true;
        break;
      } catch { /* A listed original may have moved since the scan. */ }
    }
    if (!survivor) throw new Error('至少需要保留一份当前可以读取的原件。请刷新并重新核对。');
    const targets = new Map();
    const failed = [];
    const moved = [];
    let pending = 0;
    for (const reference of plan.selected) {
      try {
        const entry = writableLibrary(reference.registrationId);
        if (!duplicateOriginal(reference)?.file) throw new Error('这份素材已变化，请重新扫描。');
        if (!targets.has(entry.id)) targets.set(entry.id, { entry, assets: [] });
        targets.get(entry.id).assets.push(reference);
      } catch (error) { failed.push({ reference, message: error.message }); }
    }
    for (const { entry, assets } of targets.values()) {
      try {
        const change = { action: 'trash', ids: assets.map(asset => asset.assetId) };
        const result = entry.kind === 'local' ? await mutateLocalLibrary(entry.root, { ...change, expectedLibraryId: entry.libraryId })
          : await syncWriter.mutate(entry, change);
        moved.push(...assets);
        if (result.pending > 0) pending += assets.length;
        await catalogReads.get(entry.id);
        if (registeredLibrary(entry.id) === entry) await refreshCatalog(entry, true, true);
      } catch (error) { failed.push(...assets.map(reference => ({ reference, message: error.message }))); }
    }
    if (moved.length) duplicateReview.consumeTrash({ jobId: command.jobId, groupId: command.groupId, moved });
    const removed = moved.length - pending;
    const counts = [removed ? `${removed} 项已移到回收站` : '', pending ? `${pending} 项待提交同步` : '',
      failed.length ? `${failed.length} 项未完成` : ''].filter(Boolean);
    const message = `${counts.join('，') || '没有可移动的素材'}。`;
    return { ok: true, moved, failed, message };
  });
}

function handleFeatureActions() {
  function feature(channel, perform) {
    handle(channel, async (...values) => {
      await startup;
      try { return await perform(...values); }
      catch (error) { return { ok: false, message: error?.message || '操作未完成，请重试。' }; }
    });
  }

  feature('board:export', saveProjectBoard);
  feature('board:import-project', openBoardProject);
  handle('windows-installation:status', checkWindowsInstallation);
  feature('windows-installation:open-location', async () => {
    const installation = windowsInstallation();
    if (!installation || await shell.openPath(installation.directory)) throw new Error('无法打开见藏程序所在的文件夹。');
    return { ok: true };
  });
  feature('windows-installation:manage', manageWindowsInstallation);
  handle('windows-update:status', () => windowsUpdates.status());
  feature('windows-update:choose-folder', async automatic => {
    if (!windowsUpdates.status().installed) throw new Error('请先通过安装包安装见藏。');
    const selection = await dialog.showOpenDialog(window, { title: '选择见藏更新文件夹', properties: ['openDirectory'] });
    return selection.canceled || !selection.filePaths[0] ? { cancelled: true } :
      windowsUpdates.configure({ folder: selection.filePaths[0] }, automatic);
  });
  feature('windows-update:set-channel', (url, automatic) => windowsUpdates.configure(url ? { url } : null, automatic));
  feature('windows-update:restore-channel', automatic => {
    const { defaultSource } = windowsUpdates.status();
    if (!defaultSource) throw new Error('此版本暂未设置官方更新通道。');
    return windowsUpdates.configure(defaultSource, automatic);
  });
  feature('windows-update:set-automatic', automatic => windowsUpdates.configure(windowsUpdates.status().source, automatic));
  feature('windows-update:check', () => windowsUpdates.check());
  feature('windows-update:open-release', async () => {
    const { releasePage } = windowsUpdates.status();
    if (!releasePage) throw new Error('当前更新通道没有 GitHub 发布页。');
    await shell.openExternal(releasePage);
    return windowsUpdates.status();
  });
  feature('windows-update:install', () => {
    if (windowsInstallationBusy) throw new Error('正在处理安装或卸载，请稍后再试。');
    return windowsUpdates.install();
  });
  feature('windows-update:cancel', () => windowsUpdates.cancel());
  feature('storage:status', storageStatus);
  feature('storage:clear-thumbnails', clearThumbnailStorage);
  feature('assets:clipboard-menu', openAssetClipboardMenu);
  feature('assets:copy-preview-text', async (id, registration, revision) => {
    const original = originalFor(id, registration);
    if (typeof revision !== 'string' || original.library.cacheKey !== revision) {
      throw new Error('素材已发生变化，请重新打开预览。');
    }
    const result = await readTextPreview(original, openAsset, AbortSignal.timeout(15_000));
    if (!result.ok) return result;
    if (!result.text) return { ok: false, message: '文件中没有可复制的文本。' };
    clipboard.writeText(result.text);
    return { ok: true };
  });
  feature('assets:write-clipboard', copyAssetDetails);
  feature('cloud-originals:status', (id, query) => {
    cloudSource(id);
    return { ok: true, ...getCloudOriginalQueue().status(id, query ?? {}) };
  });
  feature('cloud-originals:start', startCloudOriginals);
  feature('cloud-originals:retry', retryCloudOriginal);
  feature('cloud-originals:remove-task', (id, taskId) => {
    cloudSource(id);
    return { ok: true, removedStatus: getCloudOriginalQueue().remove(id, taskId) };
  });
  feature('cloud-originals:pause', async (id, paused) => {
    cloudSource(id);
    if (typeof paused !== 'boolean') throw new Error('取回队列操作无效。');
    await getCloudOriginalQueue().setPaused(id, paused);
    return { ok: true, paused };
  });
  feature('cloud-originals:history-clear', async id => {
    cloudSource(id);
    return { ok: true, count: await getCloudOriginalQueue().clearCompleted(id) };
  });
  feature('cloud-originals:copy-failures', copyCloudOriginalFailures);
  feature('asset:save-markers', saveVideoMarkers);
  feature('asset:video-metadata', async (reference) => {
    const { id, registrationId, revision } = reference || {};
    const current = () => typeof id === 'string' && typeof registrationId === 'string' &&
      typeof revision === 'string' && catalogs.get(registrationId)?.cacheKey === revision;
    if (!current()) return null;
    try {
      const original = originalFor(id, registrationId);
      if (original.asset.kind !== 'video' || !original.asset.available) return null;
      const ffprobe = path.join(__dirname, 'vendor', 'media', 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
      const signal = AbortSignal.timeout(12_000);
      const info = await inspectVideoMetadata({ ffprobe, signal, openSource: () => openAsset(original, signal, true) });
      return current() ? info : null;
    } catch { return null; }
  });
  feature('video-trim:probe', probeTrimVideo);
  feature('video-trim:preview', makeTrimPreview);
  feature('video-trim:export', exportTrimmedVideo);
  feature('video-trim:cancel', id => {
    if (id === undefined || activeVideoTrim?.id === id) activeVideoTrim?.controller?.abort();
    return { ok: true };
  });
  feature('video-trim:release', id => activeVideoTrim?.id === id ? closeVideoTrim(activeVideoTrim) : { ok: true });
  feature('asset:save-edited-image', saveEditedImage);
  feature('local-backup:create', id => runLocalBackup('create', id));
  feature('local-backup:restore', name => runLocalBackup('restore', name));
  feature('local-backup:cancel', () => {
    backupOperation?.abort();
    return { ok: true };
  });
  feature('sync-conflicts:list', id => {
    const entry = syncConflictLibrary(id);
    return listSyncConflicts(entry.root, entry.libraryId,
      syncWriterError ? undefined : syncWriter?.acknowledgedConflicts(entry.libraryId));
  });
  feature('sync-conflicts:resolve', resolveSyncConflict);
  feature('structured-export:plan', previewStructuredExport);
  feature('structured-export:choose', chooseStructuredExportDestination);
  feature('structured-export:start', startStructuredExport);
  feature('image-conversion:start', startImageConversion);
  feature('image-conversion:cancel', cancelImageConversion);
  feature('inbox:list', () => requireFolderInbox().list());
  feature('inbox:add', addFolderInbox);
  feature('inbox:pause', (id, paused) => requireFolderInbox().setPaused(id, paused));
  feature('inbox:remove', id => requireFolderInbox().remove(id));
  feature('inbox:scan', id => requireFolderInbox().scan(id));
  feature('browser-capture:status', async () => {
    await browserCapture.enableDefault();
    return browserCapture.status();
  });
  feature('browser-capture:history', () => browserCapture.history());
  feature('browser-capture:copy-history-address', (id, field) => {
    const url = browserCapture.historyAddress(id, field);
    if (!url) throw new Error('此采集记录没有可复制的地址。');
    clipboard.writeText(url);
    return { ok: true };
  });
  feature('browser-capture:configure', selection => browserCapture.configure(selection));
  feature('browser-capture:rule-save', selection => browserCapture.saveRule(selection));
  feature('browser-capture:rule-change', (id, action) => browserCapture.changeRule(id, action));
  feature('browser-capture:disconnect', disable => browserCapture.disconnect(disable === true));
  feature('browser-capture:extension', async () => {
    const directory = await prepareBrowserExtension(path.join(__dirname, 'browser-extension'),
      path.join(app.getPath('userData'), 'browser-extension'));
    if (await shell.openPath(directory)) throw new Error('无法打开浏览器扩展文件夹。');
    return { ok: true, directory };
  });
  feature('offline-web:get', ref => requireOfflineWeb().lookup(ref));
  feature('offline-web:capture', ref => requireOfflineWeb().capture(ref));
  feature('offline-web:remove', ref => requireOfflineWeb().remove(ref));
  feature('offline-web:open', async (ref, url) => {
    const source = await requireOfflineWeb().allowsOpen(ref, url);
    if (!source) throw new Error('此链接已不可用。');
    await shell.openExternal(source);
    return { ok: true };
  });
  feature('duplicates:start', (references, mode) => duplicateReview.start(duplicateReferences(references), { mode }));
  feature('duplicates:status', () => duplicateReview.status({ includeGroups: true }));
  feature('duplicates:cancel', jobId => duplicateReview.cancel(jobId));
  feature('duplicates:resume', jobId => duplicateReview.resume(jobId));
  feature('duplicates:retry', retryDuplicateLibrary);
  feature('duplicates:preview-merge', previewDuplicateMerge);
  feature('duplicates:merge', mergeDuplicateMembers);
  feature('duplicates:trash', trashDuplicateMembers);
  feature('visual:lookup', references => requireVisualIndex().lookup(featureReferences(references), { includeFailures: true }));
  feature('visual:start', (references, ocr, retryFailures) =>
    requireVisualIndex().start(featureReferences(references), { ocr: ocr === true, retryFailures: retryFailures !== false }));
  feature('visual:status', () => requireVisualIndex().status());
  feature('visual:cancel', job => requireVisualIndex().cancel(job));
  feature('visual:copy-color', color => {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('无效的 HEX 色值。');
    clipboard.writeText(color.toUpperCase());
    return { ok: true };
  });
  feature('visual:copy-palette', async (colors, format) => {
    if (!Array.isArray(colors) || colors.length < 1 || colors.length > 5 ||
        !colors.every(color => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))) {
      throw new Error('没有可复制的色值。');
    }
    if (format === 'hex') {
      clipboard.writeText(colors.map(color => color.toUpperCase()).join('\n'));
    } else if (format === 'png') {
      const { PNG } = require('./vendor/ocr/node_modules/pngjs');
      const swatchWidth = 128;
      const width = colors.length * swatchWidth;
      const height = 80;
      const row = Buffer.alloc(width * 4);
      colors.forEach((color, index) => {
        const rgba = Buffer.from(`${color.slice(1)}ff`, 'hex');
        row.fill(rgba, index * swatchWidth * 4, (index + 1) * swatchWidth * 4);
      });
      const png = PNG.sync.write({ width, height, data: Buffer.alloc(row.length * height, row) });
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    } else {
      throw new Error('色板格式不支持。');
    }
    return { ok: true };
  });
  feature('visual:similar', (seed, references, options) => {
    const image = currentFeatureReference(seed);
    if (!image) throw new Error('这张图片已变化，请重新打开素材。');
    return requireVisualIndex().similar(image, featureReferences(references), { limit: 200, exactOnly: options?.exactOnly === true });
  });
  feature('visual:copy-text', reference => {
    const current = currentFeatureReference(reference);
    if (!current) throw new Error('这张图片已变化，请重新识别。');
    return Promise.resolve(requireVisualIndex().lookup([current])).then(records => {
      const text = records?.[0]?.text;
      if (typeof text !== 'string' || !text) return { ok: false, message: '没有可复制的识别文字。' };
      clipboard.writeText(text);
      return { ok: true };
    });
  });
  feature('suggestion:settings', () => requireSuggestions().getSettings());
  feature('natural-search:start', (query, references, profile) => {
    if (!Array.isArray(references) || references.length > maximumNaturalSearchImages) {
      throw new Error(`请缩小范围至 ${maximumNaturalSearchImages} 张图片以内。`);
    }
    const current = featureReferences(references);
    if (current.length !== references.length) throw new Error('搜索范围中的素材已变化，请重新打开找图。');
    return naturalImageSearch.start(query, current, profile);
  });
  feature('natural-search:cancel', id => naturalImageSearch.cancel(id));
  feature('natural-search:status', () => naturalImageSearch.status());
  feature('suggestion:local-models', values => requireSuggestions().listLocalModels(values));
  feature('suggestion:save-settings', values => requireSuggestions().saveSettings(values));
  feature('suggestion:start', async items => {
    await suggestionCatalogRefresh;
    return requireSuggestions().start(items);
  });
  feature('suggestion:batch', () => requireSuggestions().review());
  feature('suggestion:retry', task => requireSuggestions().retry(task));
  feature('suggestion:retry-failed', batchId => requireSuggestions().retryFailed(batchId));
  feature('suggestion:pause', batchId => requireSuggestions().pause(batchId));
  feature('suggestion:resume', batchId => requireSuggestions().resume(batchId));
  feature('suggestion:cancel', () => requireSuggestions().cancel());
  feature('suggestion:discard', batchId => requireSuggestions().discard(batchId));
  feature('suggestion:apply', async items => {
    const result = await requireSuggestions().applySelected(items);
    const requested = new Set(items.map(item => item.taskId));
    const affected = new Set(result.batch.tasks.filter(task => requested.has(task.taskId) &&
      (task.applied.length || registeredLibrary(task.registrationId)?.kind === 'eagle')).map(task => task.registrationId));
    suggestionCatalogRefresh = Promise.allSettled([suggestionCatalogRefresh, ...[...affected].map(async id => {
      await catalogReads.get(id);
      const entry = registeredLibrary(id);
      if (entry) await refreshCatalog(entry, false, true);
    })]).then(() => undefined);
    return result;
  });
}

function scheduleLocalWrite(operation) {
  const next = localWrites.then(operation);
  localWrites = next.catch(() => {});
  return next;
}

function writableLibrary(id) {
  const entry = registeredLibrary(id);
  if (entry?.kind === 'local') return entry;
  if (entry?.kind !== 'jiancang' || !entry.syncWritable) throw new Error('请选择可整理的见藏库。');
  if (!syncWriter || syncWriterError) throw new Error('无法打开本机同步队列，请重启见藏。');
  return entry;
}

function commitLibraryMutation(entry, command) {
  return entry.kind === 'local'
    ? mutateLocalLibrary(entry.root, { ...command, expectedLibraryId: entry.libraryId })
    : syncWriter.mutate(entry, command);
}

function eagleWritableEntry(id) {
  const entry = registeredLibrary(id);
  if (entry?.kind !== 'eagle' || !entry.eagleWritable) throw new Error('请先为这份 Eagle 库开启双向同步。');
  if (!catalogs.has(id) || libraryStatuses.get(id)?.status === 'unavailable') throw new Error('请先重新连接这份 Eagle 库。');
  return entry;
}

function eagleWritableAsset(entry, id) {
  const { asset, library } = assetFor(id, entry.id);
  if (!asset.eagleItemId || asset.trashed || library.root !== entry.root) throw new Error('请重新选择可编辑的 Eagle 素材。');
  return asset;
}

async function organizeEagleAssets(id, command) {
  const entry = eagleWritableEntry(id);
  let changes;
  let edits;
  let requests;
  if (command?.action === 'planRename' || command?.action === 'rename') {
    const plan = planEagleRename(catalogs.get(id).assets, command.entries);
    if (command.action === 'planRename') return { ok: true, ...plan };
    if (plan.revision !== command.revision) throw new Error('素材已变化，请核对最新名称后重试。');
    requests = plan.entries.map(item => ({ id: item.id, changes: { name: item.name }, expected: { name: item.oldName } }));
  } else if (command?.action === 'edit') {
    if (!Array.isArray(command.ids) || !command.ids.length || command.ids.length > 100_000) throw new Error('请先选择素材。');
    const supported = ['action', 'ids', 'expected', 'rating', 'note', 'sourceURL', 'addTags', 'removeTags', 'addCollectionIds', 'removeCollectionIds'];
    if (Object.keys(command).some(key => !supported.includes(key))) throw new Error('Eagle 批量整理不支持这项操作。');
    changes = Object.fromEntries(['rating', 'note', 'sourceURL'].filter(key => Object.hasOwn(command, key)).map(key => [key, command[key]]));
    edits = { tags: { add: command.addTags, remove: command.removeTags },
      collectionIds: { add: command.addCollectionIds, remove: command.removeCollectionIds } };
    requests = [...new Set(command.ids)].map(assetId => ({ id: assetId, changes, expected: command.expected?.[assetId], edits }));
  } else throw new Error('Eagle 批量整理不支持这项操作。');

  await eagleApi.checkLibrary(entry.root);
  let count = 0;
  let connectionError;
  const failed = [];
  for (const request of requests) {
    let asset;
    try {
      asset = eagleWritableAsset(entry, request.id);
      if (connectionError) throw connectionError;
      await eagleApi.updateItem({ ...request, root: entry.root, id: asset.eagleItemId });
      count++;
    } catch (error) {
      if (error.code === 'EAGLE_CONNECTION') connectionError = error;
      failed.push({ id: request.id, name: asset?.name || '素材已变化', message: error.message });
    }
  }
  await catalogReads.get(id);
  if (registeredLibrary(id) === entry) await refreshCatalog(entry, true, true);
  return { ok: true, count, failed };
}

async function rereadSyncCatalog(entry, interactive) {
  await catalogReads.get(entry.id);
  if (registeredLibrary(entry.id) === entry) return refreshCatalog(entry, interactive, true);
  return { ok: false, message: '素材库连接已变化，请重新打开同步状态。' };
}

async function flushDirectorySync(entry, manual = false) {
  if (entry.kind !== 'jiancang' || !entry.syncWritable || !syncWriter || syncWriterError) return null;
  const running = syncingLibraries.get(entry.libraryId);
  if (running) {
    const result = await running;
    if (!manual || result.catalogRefresh) return result;
    return { ...result, catalogRefresh: await rereadSyncCatalog(entry, true) };
  }
  const previous = syncWriter.status(entry.libraryId);
  if (!manual && !(previous?.pending > 0)) return previous;
  const pending = (async () => {
    const result = await syncWriter.retry(entry);
    if (manual || (result.pending ?? 0) < (previous?.pending ?? 0)) {
      return { ...result, catalogRefresh: await rereadSyncCatalog(entry, manual) };
    }
    return result;
  })().finally(() => {
    syncingLibraries.delete(entry.libraryId);
    scheduleStateEvent();
  });
  syncingLibraries.set(entry.libraryId, pending);
  return pending;
}

function retryPendingSync() {
  for (const entry of registry.entries) void flushDirectorySync(entry).catch(() => {});
}

function importQueue() {
  if (!localImports || localImportError) throw new Error('无法打开导入队列，请重启见藏后重试。');
  return localImports;
}

function notifyImportChange(id) {
  importEvents.add(id);
  if (importEvent) return;
  importEvent = setTimeout(() => {
    importEvent = null;
    const changes = [...importEvents];
    importEvents.clear();
    if (window && !window.isDestroyed()) window.webContents.send('local-import:changed', changes);
  }, 120);
  importEvent.unref();
}

function refreshAfterImport(id) {
  if (localRefresh.has(id)) return;
  const timer = setTimeout(async () => {
    localRefresh.delete(id);
    await catalogReads.get(id);
    const entry = registeredLibrary(id);
    if (entry) await refreshCatalog(entry, false, true);
  }, 480);
  timer.unref();
  localRefresh.set(id, timer);
}

function copyDonor(source) {
  const registration = registeredLibrary(source.registrationId);
  if (registration && (registration.libraryId === source.libraryId ||
      (registration.kind === 'eagle' && (!source.libraryId || (source.eagleItemId && !registration.pathIndependentIdentity))))) {
    return registration;
  }
  const recovered = source.libraryId ? registry.entries.filter(entry => entry.libraryId === source.libraryId) : [];
  return recovered.length === 1 ? recovered[0] : null;
}

async function copySource(source, donor) {
  const locate = () => {
    const catalog = catalogs.get(donor.id);
    if (!catalog || catalog.publicLibrary.libraryId !== donor.libraryId || path.relative(catalog.root, donor.root)) return null;
    if (catalog.assets.has(source.assetId)) return assetFor(source.assetId, donor.id);
    if (donor.kind !== 'eagle' || !source.eagleItemId) return null;
    const id = catalog.publicLibrary.assets.find(asset => asset.eagleItemId === source.eagleItemId)?.id;
    return id && assetFor(id, donor.id);
  };
  let original = locate();
  if (!original || (!original.file && original.asset.kind !== 'link')) {
    await refreshCatalog(donor, false, true);
    original = locate();
  }
  if (!original || original.asset.trashed ||
      (!original.file && (original.asset.kind !== 'link' || !webURL(original.asset.sourceURL)))) {
    throw new Error('原件暂不可用，取回原件后可以重试。');
  }
  return original;
}

async function runImportTask(task, onProgress, { direct = false } = {}) {
  const remote = task.source.kind === 'image-url'
    ? await downloadDroppedImage([task.source.url, ...(task.source.fallbackURLs ?? [])]) : null;
  const write = async () => {
    const entry = writableLibrary(task.targetId);
    const source = task.source;
    if (source.targetLibraryId && source.targetLibraryId !== entry.libraryId) {
      throw new Error('目标素材库已变化，请重新选择采集位置后再次采集。');
    }
    const input = { jobId: entry.kind === 'local' ? task.id : syncUploadId(task.id), expectedLibraryId: entry.libraryId, undoGroup: task.batchId,
      collectionIds: task.collectionId ? [task.collectionId] : [], onProgress, ...(direct && task.tags?.length && { tags: task.tags }) };
    if (remote) {
      Object.assign(input, { filename: remote.name, bytes: remote.bytes, sourceURL: source.sourceURL ?? remote.sourceURL, kind: 'image' });
    } else if (source.kind === 'buffer') {
      Object.assign(input, { filename: source.name, bytes: source.bytes, sourceURL: source.sourceURL, kind: 'image' });
    } else if (source.kind === 'file') {
      Object.assign(input, {
        filename: source.name || path.basename(source.path), collectionPaths: source.collectionPaths,
        sourceURL: source.sourceURL,
        collectionParentId: task.collectionId,
        open: () => source.inboxStamp ? openInboxOriginal(source) : openContainedFile(source.root, source.path),
      });
    } else if (source.kind === 'url') {
      Object.assign(input, { sourceURL: source.url, name: source.name });
    } else if (source.kind === 'catalog') {
      const donor = copyDonor(source);
      if (!donor) throw new Error('请重新连接原素材库后重试。');
      if (!distinctCatalogs(donor, entry)) throw new Error('请选择另一个接收素材的见藏库。');
      const original = await copySource(source, donor);
      const { library, asset } = original;
      Object.assign(input, {
        filename: exportFilename(asset.name, asset.extension), name: asset.name,
        open: original.file ? () => openAsset(original, undefined, true) : undefined,
        tags: asset.tags, note: asset.note, sourceURL: asset.sourceURL, rating: asset.rating, favorite: asset.favorite,
        collectionPaths: source.preserveCollections ? sourceCollectionPaths(asset.collectionIds, library.publicLibrary.collections) : [],
        collectionParentId: task.collectionId,
        kind: asset.kind, width: asset.width, height: asset.height, duration: asset.duration, createdAt: asset.createdAt,
      });
    } else throw new Error('无法识别此导入来源。');
    const result = entry.kind === 'local' ? await importLocalAsset(entry.root, input) : await syncWriter.upload(entry, input);
    refreshAfterImport(entry.id);
    if (direct && result.pending) {
      throw new Error(result.error || '同步素材尚未写入，请确认 iCloud Drive 可用后重试。');
    }
    if (direct && remote) {
      return { ...result, browserCapture: { filename: remote.name, resolvedImageURL: remote.resolvedImageURL ?? remote.sourceURL,
        dimensions: imageDimensions(remote.bytes) } };
    }
    return result;
  };
  return direct ? write() : scheduleLocalWrite(write);
}

async function createLibrary(name) {
  if (typeof name !== 'string' || !name.trim() || Array.from(name.trim()).length > 80) {
    throw new Error('请输入 1 到 80 个字符的素材库名称。');
  }
  return scheduleLibraryAction(async () => {
    const choice = await dialog.showOpenDialog(window, {
      title: '选择本地素材库的存放位置', defaultPath: app.getPath('documents'),
      buttonLabel: '在这里新建', properties: ['openDirectory', 'createDirectory'],
    });
    if (choice.canceled || !choice.filePaths[0]) return;
    try {
      const parent = await fs.realpath(choice.filePaths[0]);
      if (registry.entries.some(entry => isWithin(entry.root, parent)) || await inLibrary(parent)) {
        throw new Error('请选择现有素材库之外的文件夹。');
      }
      const stem = Array.from(exportFilename(name.trim(), '')).slice(0, 56).join('');
      const root = path.join(parent, stem);
      await createLocalLibrary(root, name.trim());
      await loadLibrary(root, { expectedKind: 'local' });
    } catch (error) {
      if (error.code === 'EEXIST') message = '这个位置已有同名文件夹，请换一个库名或位置。';
      else message = error.code ? '无法新建素材库，请检查文件夹权限和可用空间。' : error.message;
    }
  });
}

async function enqueuePaths(id, collectionId, selected) {
  writableLibrary(id);
  if (!Array.isArray(selected) || selected.length > maximumImportBatch) {
    throw new Error('一次最多导入 10,000 个文件，请分批添加。');
  }
  const { sources, skipped } = await collectImportSources(selected, registry.entries.map(entry => entry.root));
  if (!sources.length) throw new Error('没有可导入的文件。可在 Eagle 素材上右键复制到见藏本地库。');
  writableLibrary(id);
  return { ...await importQueue().enqueue({ targetId: id, collectionId, sources }), skipped };
}

async function enqueueDrop(id, collectionId, items) {
  writableLibrary(id);
  const { paths = [], images = [], imageURL, link } = items ?? {};
  if (!Array.isArray(paths) || paths.length > maximumImportBatch || !Array.isArray(images) || images.length > 32) {
    throw new Error('拖入的项目过多，请分批导入。');
  }
  const { sources, skipped: skippedPaths } = await collectImportSources(paths, registry.entries.map(entry => entry.root));
  let skipped = skippedPaths;
  let byteCount = 0;
  for (const item of images) {
    const extension = imageExtension(item?.bytes);
    if (!extension) { skipped++; continue; }
    byteCount += item.bytes.length;
    if (byteCount > maximumImageBytes) throw new Error('请分批拖入图片，每批最多 32 MB。');
    sources.push({ kind: 'buffer', bytes: item.bytes, name: imageFilename(item.name, extension) });
  }
  if (!paths.length && !sources.length) {
    const alternatives = Array.isArray(imageURL) ? imageURL.slice(0, 3) : imageURL ? [imageURL] : [];
    let bytes = null;
    for (const candidate of alternatives) {
      bytes = inlineImage(candidate);
      if (bytes) break;
    }
    if (bytes) sources.push({ kind: 'buffer', bytes, name: imageFilename('拖入的图片', imageExtension(bytes)) });
    else if (alternatives.length) {
      const [url, ...fallbackURLs] = imageURLCandidates(alternatives);
      if (!url) throw new Error('无法读取这个图片地址。请从资源管理器拖入已保存的文件，或复制图片后按 Ctrl+V。');
      sources.push({ kind: 'image-url', url, fallbackURLs });
    } else {
      const url = webURL(link);
      if (url) sources.push({ kind: 'url', url });
    }
  }
  if (!sources.length) throw new Error('这个来源未提供可导入的文件或图片，请另存为文件后再拖入。');
  if (sources.length > maximumImportBatch) throw new Error('一次最多导入 10,000 个文件，请分批添加。');
  writableLibrary(id);
  return { ...await importQueue().enqueue({ targetId: id, collectionId, sources }), skipped };
}

async function readClipboardImportSources() {
  const maximumMessage = '剪贴板图片超过 32 MB，请另存为文件后再导入。';
  let item, bytes;
  if (typeof clipboard.readImage === 'function') {
    const image = clipboard.readImage();
    if (!image.isEmpty()) bytes = image.toPNG();
  } else {
    [item] = await clipboard.read();
    if (item?.types.includes('image/png')) {
      const image = await item.getType('image/png');
      if (image.size > maximumImageBytes) throw new Error(maximumMessage);
      bytes = Buffer.from(await image.arrayBuffer());
    }
  }
  if (bytes?.length) {
    if (bytes.length > maximumImageBytes) throw new Error(maximumMessage);
    return [{ kind: 'buffer', bytes, name: '剪贴板图片.png' }];
  }
  const urls = clipboardWebURLs(await clipboard.readText());
  if (!urls.length) {
    const format = 'electron application/bookmark';
    const data = typeof clipboard.readBookmark === 'function' ? clipboard.readBookmark()
      : item?.types.includes(format) ? await item.getType(format) : null;
    const bookmark = webURL(data?.url);
    if (bookmark) urls.push(bookmark);
  }
  if (!urls.length) throw new Error('剪贴板里没有可导入的图片或网址。粘贴多个网址时请每行放一个 HTTP 或 HTTPS 网址。');
  return urls.map(url => ({ kind: 'url', url }));
}

function handleLocalWorkflow() {
  function localAction(channel, action) {
    handle(channel, async (...args) => {
      await startup;
      try { return await action(...args); }
      catch (error) { return { ok: false, message: error?.message || '操作未完成，请重试。' }; }
    });
  }

  localAction('local:create', createLibrary);
  localAction('eagle:configure-write', (id, enabled) => serializeLibraryAction(async () => {
    const entry = registeredLibrary(id);
    if (entry?.kind !== 'eagle' || typeof enabled !== 'boolean') throw new Error('请选择一个 Eagle 素材库。');
    if (enabled) {
      if (!catalogs.has(id) || libraryStatuses.get(id)?.status === 'unavailable') throw new Error('请先重新连接这份 Eagle 库。');
      await eagleApi.checkLibrary(entry.root);
    }
    await keepRegistry({ ...registry, entries: registry.entries.map(item =>
      item.id === id ? { ...item, eagleWritable: enabled } : item) });
    scheduleStateEvent();
    return { ok: true, state: state(), enabled };
  }));
  localAction('eagle:edit', (id, assetId, changes, expected) => serializeLibraryAction(async () => {
    const entry = eagleWritableEntry(id);
    const asset = eagleWritableAsset(entry, assetId);
    if (Array.isArray(changes?.collectionIds)) {
      const folders = new Set(catalogs.get(id).publicLibrary.collections.map(folder => folder.id));
      if (changes.collectionIds.some(folderId => !folders.has(folderId))) {
        throw new Error('集合已变化，请重新选择。');
      }
    }
    await eagleApi.updateItem({ root: entry.root, id: asset.eagleItemId, changes, expected });
    if (catalogReads.has(id)) await catalogReads.get(id);
    await refreshCatalog(entry, true, true);
    return { ok: true, state: state() };
  }));
  localAction('local:mutate', (id, command) => scheduleLocalWrite(async () => {
    if (command?.action === 'mergeDuplicates') throw new Error('请在重复素材整理中预览并确认合并。');
    if (registeredLibrary(id)?.kind === 'eagle') return serializeLibraryAction(() => organizeEagleAssets(id, command));
    const entry = writableLibrary(id);
    let localCommand = command;
    if (command?.action === 'purgeTrash' || command?.action === 'retryPurge') {
      if (entry.kind !== 'local') throw new Error('永久删除只适用于本地素材库。');
      const catalog = catalogs.get(id);
      if (!catalog || catalog.cacheKey !== command.catalogRevision) {
        throw new Error('回收站已更新，请重新确认要删除的素材。');
      }
      const mediaRevisions = new Map();
      if (command.action === 'purgeTrash') {
        const all = command.all === true;
        const ids = all ? [] : command.ids;
        if (!Array.isArray(ids) || ids.length > 100_000) throw new Error('请选择要删除的素材。');
        const records = all ? catalog.assets.values() : ids.map(assetId => catalog.assets.get(assetId));
        for (const asset of records) {
          if (asset?.trashed && asset.mediaRevision) mediaRevisions.set(asset.id, asset.mediaRevision);
        }
      }
      localCommand = { ...command, mediaRevisions, purgeRootIdentity: catalog.identity };
    }
    if (entry.kind === 'local' && (command?.action === 'undo' || command?.action === 'redo')) {
      const imports = localImportError ? null : localImports?.summary(id);
      if (imports?.pending || imports?.running) {
        throw new Error(`请等本次导入结束后再${command.action === 'undo' ? '撤销' : '重做'}。`);
      }
    }
    const result = await commitLibraryMutation(entry, localCommand);
    if (!['planRename', 'planTagChange'].includes(command?.action)) {
      await catalogReads.get(id);
      if (registeredLibrary(id) === entry) await refreshCatalog(entry, true, true);
    }
    return { ok: true, ...result, ...(result.pending > 0 && !result.message && { message: '操作已加入本机待提交队列。' }) };
  }));
  localAction('sync:configure-write', (id, enable) => scheduleLibraryAction(async () => {
    const entry = registeredLibrary(id);
    if (entry?.kind !== 'jiancang' || typeof enable !== 'boolean') { message = '此操作需要一个见藏同步库。'; return; }
    message = null;
    if (enable) {
      if (!syncWriter || syncWriterError) { message = '无法打开本机同步队列。'; return; }
      const loaded = await refreshCatalog(entry, true);
      if (!loaded?.ok || catalogs.get(entry.id)?.publicLibrary.format !== 6) {
        message = loaded?.message || '请先在 iPhone 或 iPad 上将这个库升级到同步格式 6。';
        return;
      }
      if (registry.entries.some(item => item.id !== id && item.libraryId === entry.libraryId && item.syncWritable)) {
        message = '这份同步库已在另一个文件夹开启写入，请使用该连接。';
        return;
      }
    }
    const entries = registry.entries.map(item => item.id !== id ? item : { ...item, syncWritable: enable });
    await keepRegistry({ ...registry, entries });
    const configured = registeredLibrary(id);
    if (enable && configured) void flushDirectorySync(configured).catch(() => {});
  }));
  localAction('sync:retry-write', async id => {
    const entry = writableLibrary(id);
    if (entry.kind !== 'jiancang') throw new Error('本地库无需同步。');
    const result = await flushDirectorySync(entry, true);
    if (!result) throw new Error('同步库暂不可写，请重新打开同步状态。');
    return { ok: true, ...result };
  });
  localAction('sync:reveal-latest-record', async id => {
    const entry = registeredLibrary(id);
    if (entry?.kind !== 'jiancang' || syncWriterError || !syncWriter) throw new Error('此同步库暂不可用。');
    const latest = await syncWriter.lastPublishedPath(entry);
    if (registeredLibrary(id) !== entry) throw new Error('同步文件夹已变化，请重新打开同步状态。');
    shell.showItemInFolder(latest);
    return { ok: true };
  });
  localAction('local-import:choose', async (id, collectionId, type) => {
    writableLibrary(id);
    if (type !== 'file' && type !== 'folder') throw new Error('无法识别此导入方式。');
    const folder = type === 'folder';
    const choice = await dialog.showOpenDialog(window, {
      title: folder ? '选择要导入的文件夹' : '选择要导入的文件',
      properties: [folder ? 'openDirectory' : 'openFile', 'multiSelections'],
    });
    if (choice.canceled || !choice.filePaths.length) return { cancelled: true };
    return { ok: true, ...await enqueuePaths(id, collectionId, choice.filePaths) };
  });
  localAction('local-import:drop-items', async (id, collectionId, items) =>
    ({ ok: true, ...await enqueueDrop(id, collectionId, items) }));
  localAction('local-import:capture-paste', async () => {
    importQueue();
    const token = randomUUID();
    clipboardImportSnapshot = { token, sources: await readClipboardImportSources() };
    return { ok: true, token };
  });
  localAction('local-import:release-paste', token => {
    if (clipboardImportSnapshot?.token === token) clipboardImportSnapshot = undefined;
    return { ok: true };
  });
  localAction('local-import:paste', async (id, collectionId, text, token) => {
    writableLibrary(id);
    const queue = importQueue();
    if (token !== undefined) {
      const snapshot = clipboardImportSnapshot;
      if (!snapshot || snapshot.token !== token || snapshot.enqueuing) {
        throw new Error('这次粘贴已结束，请重新按 Ctrl+V。');
      }
      snapshot.enqueuing = true;
      try {
        const result = await queue.enqueue({ targetId: id, collectionId, sources: snapshot.sources });
        if (clipboardImportSnapshot === snapshot) clipboardImportSnapshot = undefined;
        return { ok: true, ...result };
      } finally { snapshot.enqueuing = false; }
    }
    const urls = text === undefined ? null : clipboardWebURLs(text);
    if (urls && !urls.length) throw new Error('只支持 HTTP 或 HTTPS 网址，每行一个。');
    const sources = urls ? urls.map(url => ({ kind: 'url', url })) : await readClipboardImportSources();
    return { ok: true, ...await queue.enqueue({ targetId: id, collectionId, sources }) };
  });
  async function copyFromLibraries(id, collectionId, references, preserveCollections, eagleOnly = false) {
    const target = writableLibrary(id);
    if (eagleOnly && target.kind !== 'local') throw new Error('请选择要接收 Eagle 素材的见藏本地库。');
    if (!Array.isArray(references) || references.length > maximumImportBatch) throw new Error('请分批选择要复制的素材。');
    const selected = new Map();
    let skipped = 0;
    for (const reference of references) {
      const { id: assetId, registrationId } = reference ?? {};
      const donor = registeredLibrary(registrationId);
      const asset = typeof assetId === 'string' && donor && catalogs.get(donor.id)?.assets.get(assetId);
      if (!asset || asset.trashed || !distinctCatalogs(donor, target) || (eagleOnly && donor.kind !== 'eagle')) {
        skipped++;
        continue;
      }
      selected.set(`${registrationId}:${assetId}`, {
        kind: 'catalog', registrationId, assetId, libraryId: donor.libraryId, eagleItemId: asset.eagleItemId,
        name: asset.name, preserveCollections: preserveCollections === true,
      });
    }
    if (!selected.size) throw new Error('请选择其他素材库里的可复制素材。');
    return { ok: true, ...await importQueue().enqueue({ targetId: id, collectionId, sources: [...selected.values()] }), skipped };
  }
  localAction('local-import:copy-assets', copyFromLibraries);
  localAction('local-import:copy-eagle', (id, collectionId, references, preserveCollections) =>
    copyFromLibraries(id, collectionId, references, preserveCollections, true));
  localAction('local-import:list', (id, includeTasks = true) => {
    writableLibrary(id);
    const queue = importQueue();
    const details = includeTasks?.inline === true ? queue.inlineSnapshot(id, includeTasks.collectionIds, includeTasks.knownRevision)
      : includeTasks?.preview === true ? queue.previewSnapshot(id, includeTasks.collectionIds)
      : includeTasks ? { tasks: queue.snapshot(id) } : {};
    return { ok: true, ...details, summary: queue.summary(id), paused: queue.isPaused(id) };
  });
  localAction('local-import:retry', async (id, taskId) => {
    writableLibrary(id);
    await importQueue().retry(id, taskId);
    return { ok: true };
  });
  localAction('local-import:set-paused', (id, paused) => {
    writableLibrary(id);
    return { ok: true, paused: importQueue().setPaused(id, paused) };
  });
  localAction('local-import:retry-failed', id => {
    writableLibrary(id);
    return { ok: true, retried: importQueue().retryFailed(id) };
  });
  localAction('local-import:cancel', async (id, taskId) => {
    writableLibrary(id);
    await importQueue().cancel(id, taskId);
    return { ok: true };
  });
  localAction('local-import:cancel-pending', async id => {
    writableLibrary(id);
    return { ok: true, cancelled: await importQueue().cancelPending(id) };
  });
  localAction('asset:open-link', async (id, registrationId) => {
    const { asset } = assetFor(id, registrationId);
    const url = webURL(asset.sourceURL);
    if (!url) throw new Error('此素材没有有效的网址。');
    await shell.openExternal(url);
    return { ok: true };
  });
}

function handleFileActions() {
  handle('asset:context-menu', openAssetMenu);
  handle('asset:open-default', openInDefaultApplication);
  handle('asset:copy-file', copyFileToClipboard);
  handle('collection:copy-name', async (registrationId, id) => {
    const collection = catalogs.get(registrationId)?.publicLibrary.collections.find(item => item.id === id);
    if (!collection) return { ok: false, message: '集合暂不可用，请刷新素材库。' };
    await clipboard.writeText(collection.name);
    return { ok: true };
  });
  handle('window:appearance', (dark) => {
    if (process.platform !== 'win32') return;
    nativeTheme.themeSource = dark ? 'dark' : 'light';
    window.setBackgroundColor(dark ? '#171817' : '#f5f3ee');
    window.setTitleBarOverlay(mainWindowControls(dark === true));
  });
  handle('asset:reference', openReferenceWindow);
  handleReference('reference:ready', context => {
    showReference(context);
    return { ok: true };
  });
  handleReference('reference:context-menu', openReferenceMenu);
  handleReference('reference:image-size', (context, width, height) => {
    if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 1_000_000)) {
      throw new Error('图片尺寸不可用。');
    }
    context.imageSize = { width, height };
    return resizeReference(context, 'fit');
  });
  handleReference('reference:resize', resizeReference);
  handleReference('reference:advance-zoom', paintReferenceZoom);
  handleReference('reference:begin-move', (context, gesture) => {
    if (!Number.isSafeInteger(gesture) || gesture <= (context.lastMoveGesture ?? 0)) return { ok: false };
    context.resize = null;
    context.anchor = null;
    context.lastMoveGesture = gesture;
    context.move = { gesture, origin: context.window.getBounds() };
    return { ok: true };
  });
  handleReference('reference:move', (context, gesture, dx, dy) => {
    const move = context.move;
    if (!move || move.gesture !== gesture || ![dx, dy].every(value => Number.isInteger(value) && Math.abs(value) < 65_536)) return { ok: false };
    const { origin } = move;
    const bounds = { ...origin, x: origin.x + dx, y: origin.y + dy };
    // Keep the size from pointerdown even when a move crosses native display bounds.
    if (!sameReferenceBounds(context.window.getBounds(), bounds)) context.window.setBounds(bounds);
    return { ok: true };
  });
  handleReference('reference:end-move', (context, gesture) => {
    if (context.move?.gesture === gesture) context.move = null;
    return { ok: true };
  });
  handleReference('reference:pin', ({ window: reference }, pinned) => {
    if (typeof pinned !== 'boolean') throw new Error('无效的置顶设置。');
    reference.setAlwaysOnTop(pinned);
    return { ok: true, pinned: reference.isAlwaysOnTop() };
  });
  handleReference('reference:opacity', ({ window: reference }, opacity) => {
    if (!Number.isInteger(opacity) || opacity < 40 || opacity > 100) throw new Error('请选择有效的不透明度。');
    reference.setOpacity(opacity / 100);
    return { ok: true, opacity: Math.round(reference.getOpacity() * 100) };
  });
  handleReference('reference:copy-image', async ({ window: reference, id, registrationId, imageSize }, thumbnail) => {
    const original = assetFor(id, registrationId);
    const limit = thumbnail === true ? 480 : 1600;
    const side = imageSize ? Math.min(limit, Math.max(imageSize.width, imageSize.height)) : limit;
    const bytes = await featurePNG(original, side, AbortSignal.timeout(15_000));
    const image = nativeImage.createFromBuffer(bytes);
    if (reference.isDestroyed() || image.isEmpty()) throw new Error('参考图暂时无法复制。');
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([image.toPNG()], { type: 'image/png' }) })]);
    return { ok: true };
  });
  handle('asset:prepare-drag', prepareDragCopy);
  handle('asset:save-video-frame', saveVideoFrame);
  ipcMain.on('asset:start-drag', (event, token) => {
    if (!isMainFrame(event) || typeof token !== 'string') return;
    try {
      const ready = preparedDrags.get(token);
      if (!ready) throw new Error();
      const canonical = realpathSync(ready.file);
      const actual = lstatSync(ready.file);
      const before = ready.stamp;
      if (path.relative(ready.file, canonical) || registry.entries.some(entry => isWithin(entry.root, canonical)) ||
          !actual.isFile() || actual.size !== before.size || actual.mtimeMs !== before.mtimeMs ||
          actual.ctimeMs !== before.ctimeMs || actual.ino !== before.ino || actual.dev !== before.dev ||
          ready.icon.isEmpty()) throw new Error();
      event.sender.startDrag({ file: ready.file, icon: ready.icon });
    } catch {
      preparedDrags.delete(token);
      if (!event.sender.isDestroyed()) event.sender.send('asset:drag-unavailable', token);
    } finally {
      if (!event.sender.isDestroyed()) event.sender.send('asset:drag-concluded', token);
    }
  });
  handle('library:state', async () => { await startup; return state(); });
  handle('library:cancel-open', () => {
    if (libraryOpening?.status === 'reading') {
      libraryOpening.controller.abort(new Error('已取消读取素材库。'));
    }
  });
  handle('library:reveal-open-folder', async () => {
    if (libraryOpening?.status !== 'timed-out') return { ok: false, message: '请先选择要打开的素材库。' };
    const failure = await shell.openPath(libraryOpening.directory);
    return failure ? { ok: false, message: '无法在资源管理器中打开素材库文件夹。' } : { ok: true };
  });
  handle('library:choose', (kind) => scheduleLibraryAction(async () => {
    if (kind != null && !['jiancang', 'eagle', 'local'].includes(kind)) return;
    const current = selectedCatalog();
    const titles = { jiancang: '选择见藏同步文件夹', eagle: '选择 Eagle 的 .library 文件夹', local: '打开见藏本地库' };
    const choice = await dialog.showOpenDialog(window, {
      title: titles[kind] ?? '添加素材库',
      defaultPath: current ? path.dirname(current.root) : undefined,
      properties: ['openDirectory'],
    });
    if (!choice.canceled && choice.filePaths[0]) await loadLibrary(choice.filePaths[0], { expectedKind: kind });
  }));
  handle('library:switch', (id) => scheduleLibraryAction(async () => {
    const entry = registeredLibrary(id);
    if (!entry) return;
    message = null;
    if (!catalogs.has(id)) {
      const result = await refreshCatalog(entry, true);
      if (!result?.ok) { message = result?.message ?? null; return; }
    }
    await keepRegistry({ ...registry, selectedId: id });
  }));
  handle('library:relocate', (id) => scheduleLibraryAction(async () => {
    const entry = registeredLibrary(id);
    if (!entry) return;
    const choice = await dialog.showOpenDialog(window, {
      title: `重新定位「${entry.name}」`, defaultPath: path.dirname(entry.root), properties: ['openDirectory'],
    });
    if (!choice.canceled && choice.filePaths[0]) await loadLibrary(choice.filePaths[0], { entry, relocating: true });
  }));
  handle('library:remove', (id) => scheduleLibraryAction(async () => {
    const entry = registeredLibrary(id);
    if (!entry) return;
    if ((entry.kind === 'local' || entry.kind === 'jiancang') && localImports && !localImportError) {
      const imports = localImports.summary(id);
      if (imports.pending || imports.running) { message = '请等本次导入结束后再移除本地库。'; return; }
    }
    const next = detachLibrary(registry, id);
    libraryStatuses.delete(id);
    catalogReads.delete(id);
    catalogs.delete(id);
    if (!cloudOriginalError) await cloudOriginals?.discard(id);
    refreshAfterCloudOriginals.delete(id);
    message = null;
    await keepRegistry(next);
  }));
  handle('library:refresh', (registrationId) => scheduleLibraryAction(async () => {
    const entry = registeredLibrary(registrationId ?? registry.selectedId);
    if (entry) message = (await refreshCatalog(entry, true))?.message ?? null;
    if (entry?.syncWritable) void flushDirectorySync(entry, true).catch(() => {});
  }));
  handle('library:refresh-all', () => scheduleLibraryAction(async () => {
    message = null;
    const results = await Promise.all(registry.entries.map(entry => refreshCatalog(entry)));
    const unavailable = results.filter(result => result?.ok === false).length;
    if (unavailable) message = `有 ${unavailable} 个素材库暂不可用，可在素材库管理中重新定位。`;
    retryPendingSync();
  }));
  handle('library:reveal', async (registrationId) => {
    await startup;
    const entry = registeredLibrary(registrationId ?? registry.selectedId);
    if (!entry) return { ok: false, message: '请先打开素材库。' };
    const failure = await shell.openPath(catalogs.get(entry.id)?.root ?? entry.root);
    return failure ? { ok: false, message: '无法在资源管理器中打开素材库文件夹。' } : { ok: true };
  });
  handle('library:reveal-reading-item', async (registrationId, revision, index) => {
    await startup;
    const stale = { ok: false, message: '这个目录已经变化，请重新读取后再打开。' };
    try {
      const catalog = catalogs.get(registrationId);
      if (!catalog || catalog.cacheKey !== revision || !Number.isInteger(index) ||
          registeredLibrary(registrationId)?.kind !== 'eagle') return stale;
      const issue = catalog.publicLibrary.readingIssues?.entries[index];
      if (!issue?.directory) return stale;
      const root = await fs.lstat(catalog.root, { bigint: true });
      if (!root.isDirectory() || root.isSymbolicLink() || folderIdentity(root) !== catalog.identity) return stale;
      const directory = await resolveEagleReadingDirectory(catalog.root, issue.directory);
      if (catalogs.get(registrationId) !== catalog) return stale;
      const failure = await shell.openPath(directory);
      return failure ? { ok: false, message: '无法打开所在文件夹，请在资源管理器中检查权限。' } : { ok: true };
    } catch { return stale; }
  });
  handle('asset:reveal', async (id, registrationId) => {
    try {
      await useOriginalLocation(originalFor(id, registrationId), file => shell.showItemInFolder(file));
      return { ok: true };
    } catch { return { ok: false, message: '找不到原件，请检查文件是否已下载，再刷新素材库。' }; }
  });
  handle('asset:export', async (id, registrationId) => {
    if (exporting) return { ok: false, message: '正在导出另一份素材。' };
    exporting = true;
    try {
      const original = originalFor(id, registrationId);
      const { library, asset } = original;
      const protectedRoots = new Set(registry.entries.map(entry => entry.root));
      const choice = await dialog.showSaveDialog(window, {
        title: '导出原件', defaultPath: path.join(app.getPath('downloads'), exportFilename(asset.name, asset.extension)),
      });
      if (choice.canceled || !choice.filePath) return { ok: false, cancelled: true };
      if (catalogs.get(library.registrationId)?.root !== library.root) {
        return { ok: false, message: '素材库的位置已变化，请重新选择素材后导出。' };
      }
      protectedRoots.add(library.root);
      for (const entry of registry.entries) protectedRoots.add(entry.root);
      const roots = [...protectedRoots];
      await copyOriginal(original, choice.filePath, roots);
      return { ok: true, message: '已导出原件。' };
    } catch (error) {
      const detail = error.code === 'EEXIST' ? '同名文件已存在，请换一个保存名称。'
        : error.code ? '无法导出原件，请检查文件是否已下载及目标文件夹是否可写。' : error.message;
      return { ok: false, message: detail };
    } finally { exporting = false; }
  });
  handle('assets:export-batch', async references => {
    if (!Array.isArray(references) || references.length === 0) {
      return { ok: false, message: '请先选择要导出的素材。' };
    }
    if (exporting) return { ok: false, message: '正在导出另一批素材。' };
    exporting = true;
    try {
      const items = selectedOriginals(references);
      if (!items.length) return { ok: false, message: '没有可导出的素材，请重新选择。' };
      const previousRoots = registry.entries.map(entry => entry.root);
      const choice = await dialog.showOpenDialog(window, {
        title: '选择批量导出的文件夹', defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (choice.canceled || !choice.filePaths[0]) return { ok: false, cancelled: true };
      const libraryRoots = [...previousRoots, ...registry.entries.map(entry => entry.root)];
      const result = await exportBatch({
        items, destination: choice.filePaths[0], libraryRoots,
        async copy(item, destination, protectedRoots) {
          const { library } = item.original;
          if (catalogs.get(library.registrationId)?.root !== library.root) {
            throw new Error('素材库的位置已变化，请刷新后再导出。');
          }
          const roots = [...protectedRoots, ...registry.entries.map(entry => entry.root)];
          await copyOriginal(item.original, destination, roots);
        },
      });
      return { ok: result.written > 0, ...result };
    } catch (error) {
      return { ok: false, message: error.code ? '无法写入目标文件夹，请检查位置和权限。' : error.message };
    } finally { exporting = false; }
  });
}

async function createWindow() {
  if (process.platform === 'win32') nativeTheme.themeSource = 'dark';
  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 780, minHeight: 520, show: false,
    title: '见藏', backgroundColor: '#171817', icon: path.join(__dirname, 'ui', 'icon.png'),
    autoHideMenuBar: true,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: mainWindowControls(true) } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    window = null;
    for (const reference of referenceWindows.values()) reference.close();
    void imageDecoder?.then(decoder => { if (!decoder.isDestroyed()) decoder.destroy(); }).catch(() => {});
  });
  await window.loadURL(appPage);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(async () => {
    if (process.platform === 'win32') Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'file://*/*'] },
      (_details, callback) => callback({ cancel: true }));
    protocol.handle('jiancang', serve);
    thumbnailDisk = createThumbnailCache(path.join(app.getPath('userData'), 'thumbnail-cache-v1'));
    void thumbnailDisk.warm();
    libraryWatcher = createLibraryWatcher({
      async onChange(id) {
        const entry = registeredLibrary(id);
        if (entry) {
          await refreshCatalog(entry, false, true);
          if (entry.syncWritable) void flushDirectorySync(entry).catch(() => {});
        }
      },
      needsRetry(id) {
        const status = libraryStatuses.get(id);
        return status?.status !== 'available' || Boolean(status.message) || !!catalogs.get(id)?.publicLibrary.partial;
      },
    });
    localImports = new LocalImportQueue({ directory: path.join(app.getPath('userData'), 'local-imports-v1'),
      perform: runImportTask, onChange: notifyImportChange });
    browserCapture = new BrowserCapture({ settingsFile: path.join(app.getPath('userData'), 'browser-capture.json'),
      resolveTarget: browserCaptureTarget, defaultTarget: defaultBrowserCaptureTarget,
      listLibraries: browserCaptureLibraries, createCollection: createBrowserCaptureCollection,
      approveConnection: approveBrowserCaptureConnection, importAsset: task => runImportTask(task, undefined, { direct: true }),
      onHistoryChanged: () => featureEvent('browser-capture:history-changed', true) });
    cloudOriginals = new CloudOriginalQueue({ directory: path.join(app.getPath('userData'), 'cloud-originals-v1'),
      resolve: resolveCloudOriginal, readOriginal: createCloudOriginalReader(utilityProcess.fork),
      onChange: notifyCloudOriginals });
    syncWriter = new DirectorySyncWriter({ directory: path.join(app.getPath('userData'), 'directory-sync-write-v1'),
      onChange: () => scheduleStateEvent() });
    visualIndex = new VisualIndex({ directory: path.join(app.getPath('userData'), 'visual-index-v1'),
      getImage: async (reference, { ocr, signal } = {}) => {
        if (!currentFeatureReference(reference)) throw new Error('图片已变化，请重新分析。');
        return featurePNG(assetFor(reference.assetId, reference.registrationId), ocr ? 1400 : 256, signal);
      },
      onChange: progress => featureEvent('visual:changed', progress),
    });
    suggestions = new AssetSuggestions({ settingsFile: path.join(app.getPath('userData'), 'asset-suggestions.json'), safeStorage,
      getAsset: suggestionAsset,
      getImage: async (reference, signal) => ({
        bytes: await featurePNG(originalFor(reference.id, reference.registrationId), 640, signal), type: 'image/png',
      }),
      apply: (reference, patch) => scheduleLocalWrite(async () => {
        const asset = suggestionAsset(reference);
        if (!asset?.writable || asset.revision !== reference.revision) throw new Error('素材已变化，请重新生成整理建议。');
        if (registeredLibrary(reference.registrationId)?.kind === 'eagle') return serializeLibraryAction(async () => {
          const entry = eagleWritableEntry(reference.registrationId);
          const original = eagleWritableAsset(entry, reference.id);
          if (assetContentRevision(original) !== reference.revision) throw new Error('素材已变化，请重新生成整理建议。');
          const fillTags = 'tags' in patch && reference.fillMissing.includes('tags');
          const changes = { ...('title' in patch && { name: patch.title }), ...('note' in patch && { note: patch.note }),
            ...(fillTags && { tags: patch.tags }) };
          const edits = 'tags' in patch && !fillTags ? { tags: { add: patch.tags } } : {};
          return eagleApi.updateItem({ root: entry.root, id: original.eagleItemId, changes, expected: reference.expected, edits });
        });
        const entry = writableLibrary(reference.registrationId);
        const command = { action: 'applySuggestion', id: reference.id, expected: reference.expected,
          undoGroup: reference.undoGroup, ...patch };
        const result = entry.kind === 'local' ? await mutateLocalLibrary(entry.root, { ...command, expectedLibraryId: entry.libraryId })
          : await syncWriter.mutate(entry, command);
        return { ok: true, ...result };
      }),
      onChange: snapshot => featureEvent('suggestion:changed', snapshot),
    });
    naturalImageSearch = new NaturalImageSearch({ directory: path.join(app.getPath('userData'), 'natural-image-search-v1'),
      openService: profile => requireSuggestions().openVisualSearch(profile),
      getImage: async (reference, signal) => ({
        bytes: await featurePNG(assetFor(reference.assetId, reference.registrationId), 384, signal), type: 'image/png',
      }),
      currentReference: currentFeatureReference,
      onChange: snapshot => featureEvent('natural-search:changed', snapshot),
    });
    duplicateReview = new DuplicateReview({
      openOriginal(reference, { signal } = {}) {
        const original = duplicateOriginal(reference);
        if (!original?.file) throw new Error('原件暂时无法读取。');
        return openAsset(original, signal);
      },
      getVisualRecords: scanVisualDuplicates,
      onChange: snapshot => featureEvent('duplicates:changed', snapshot),
    });
    folderInbox = new FolderInbox({ directory: path.join(app.getPath('userData'), 'folder-inbox-v1'),
      async enqueue(request) {
        await folderInboxTarget(request);
        return importQueue().enqueue(request);
      },
      getTarget: folderInboxTarget,
      getProtectedRoots: () => registry.entries.map(entry => entry.root),
      onChange: () => featureEvent('inbox:changed', true),
    });
    offlineWeb = new OfflineWebStore({ directory: path.join(app.getPath('userData'), 'offline-web-v1'), getLink: offlineLink,
      async extract(html, finalURL) {
        const decoder = await getImageDecoder();
        return decoder.webContents.executeJavaScript(`window.extractJianCangOfflineWeb(${JSON.stringify(html)}, ${JSON.stringify(finalURL)})`);
      },
    });
    const featureStartup = Promise.all([
      visualIndex.initialize().catch(error => { visualIndexError = error; }),
      suggestions.initialize().catch(error => { suggestionsError = error; }),
      offlineWeb.initialize().catch(error => { offlineWebError = error; }),
      refreshBrowserExtension(path.join(__dirname, 'browser-extension'), path.join(app.getPath('userData'), 'browser-extension'))
        .catch(error => { console.error('见藏浏览器扩展未能刷新', error.message); }),
    ]);
    startup = initializeLibraries().then(async () => {
      try { await syncWriter.initialize(); }
      catch (error) { syncWriterError = error; console.error('见藏无法打开同步队列', error.message); }
      try { await localImports.initialize(); localImports.start(); }
      catch (error) { localImportError = error; console.error('见藏无法打开导入队列', error.message); }
      await browserCapture.initialize();
      try { await cloudOriginals.initialize(); cloudOriginals.start(); }
      catch (error) { cloudOriginalError = error; }
      try { await folderInbox.initialize(); }
      catch (error) { folderInboxError = error; console.error('见藏无法加载监视目录', error.message); }
      await featureStartup;
      retryPendingSync();
      syncTimer = setInterval(retryPendingSync, 30_000);
      syncTimer.unref();
    });
    handleFileActions();
    handleLocalWorkflow();
    handleFeatureActions();
    await startWindowsUpdates();
    await createWindow();
    void addDesktopShortcutAfterUpgrade().catch(error => console.warn('无法创建见藏桌面快捷方式', error.code || ''));
  }).catch((error) => { console.error('见藏启动失败', error.message); app.exit(1); });
  app.on('before-quit', () => {
    windowsUpdates?.close();
    void closeVideoTrim(activeVideoTrim);
    backupOperation?.abort();
    libraryWatcher?.close();
    clearInterval(syncTimer);
    duplicateReview?.cancel(duplicateReview.status()?.jobId);
    void cloudOriginals?.close().catch(() => {});
    void folderInbox?.close();
    void browserCapture?.close();
    void visualIndex?.close?.();
    void suggestions?.close();
    naturalImageSearch?.close();
  });
  app.on('window-all-closed', () => app.quit());
}
