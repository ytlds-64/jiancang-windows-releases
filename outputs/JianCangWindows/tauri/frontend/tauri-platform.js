'use strict';

(() => {
  const nativeInvoke = window.__TAURI__.core.invoke;
  const listeners = new Map();
  const monitoredImports = new Map();
  const connectedImports = new Set();
  const libraryChanges = new Set(['library:choose', 'library:switch', 'library:refresh',
    'library:refresh-all', 'library:relocate', 'library:remove', 'local:create']);
  const importChanges = new Set(['local-import:choose', 'local-import:retry',
    'local-import:retry-failed', 'local-import:cancel', 'local-import:cancel-pending', 'local-import:set-paused', 'local-import:native-drop',
    'local-import:paste', 'local-import:drop-items', 'local-import:copy-assets', 'local-import:copy-eagle']);
  const clipboardCommands = new Set(['browser-capture:copy-history-address',
    'visual:copy-text', 'visual:copy-color', 'visual:copy-palette', 'assets:write-clipboard',
    'assets:copy-preview-text', 'cloud-originals:copy-failures']);
  const operationProgress = {
    'video-trim:export': 'video-trim',
    'video-trim:preview': 'video-trim',
    'structured-export:start': 'structured-export',
    'image-conversion:start': 'image-conversion',
    'local-backup:create': 'local-backup',
    'local-backup:restore': 'local-backup',
    'local-backup:run': 'local-backup',
    'local-backup:restore-snapshot': 'local-backup',
  };
  const defaultApplicationExtensions = new Set([
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'psd',
    'mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'mpeg', 'mpg',
    'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aif', 'aiff',
    'pdf', 'txt', 'md', 'csv', 'tsv', 'json', 'log', 'docx', 'xlsx', 'pptx',
  ]);
  const textPreviewExtensions = new Set(['txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log']);
  const editorImageTypes = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif']);
  const uploadChunkBytes = 768 * 1024;
  let snapshot;
  let readingSnapshot;
  let sequence = 0;
  let lastState = 0;
  let desktopStatus;
  let pollingVisual = false;
  let transferringFile = false;

  const origin = location.hostname === 'tauri.localhost'
    ? 'https://jiancangmedia.localhost' : 'jiancangmedia://localhost';
  const mediaURL = (role, library, asset) => `${origin}/${[role, library, asset].map(encodeURIComponent).join('/')}`;
  function playbackURL(value) {
    const url = typeof value === 'string' && URL.parse(value);
    return url && !url.username && !url.password && `${url.protocol}//${url.host}` === origin ? url.href : '';
  }
  async function call(name, args = []) {
    try { return await nativeInvoke('library_command', { name, args }); }
    catch (error) { throw error instanceof Error ? error : new Error(String(error || '操作未完成。')); }
  }

  async function readSuggestionPages(batch) {
    if (!batch?.totalTasks || batch.totalTasks <= batch.tasks.length) return batch;
    const size = batch.tasks.length;
    const tasks = [...batch.tasks];
    for (let offset = size; offset < batch.totalTasks; offset += 4 * size) {
      const pages = [];
      for (let index = offset; index < Math.min(offset + 4 * size, batch.totalTasks); index += size) {
        pages.push(call('suggestion:batch', [{ batchId: batch.id, offset: index }]));
      }
      for (const page of await Promise.all(pages)) tasks.push(...page);
    }
    return { ...batch, tasks };
  }

  function publish(channel, value) {
    for (const listener of listeners.get(channel) ?? []) listener(null, value);
  }

  function remember(next, order) {
    if (!next?.libraries || order < lastState) return;
    lastState = order;
    snapshot = next;
    const localIds = new Set(next.libraries.filter(library => library.kind === 'local' || library.syncWritable)
      .map(library => library.id));
    for (const id of connectedImports) if (!localIds.has(id)) connectedImports.delete(id);
    for (const id of localIds) {
      if (connectedImports.has(id)) continue;
      connectedImports.add(id);
      monitorImport(id);
    }
    publish('library:state-changed', next);
  }

  function readSnapshot() {
    if (readingSnapshot) return readingSnapshot;
    const order = ++sequence;
    const knownRevision = snapshot?.libraryRevision;
    readingSnapshot = call('library:state', [{ compact: true, knownRevision }]).then(next => {
      if (next?.notModified || order < lastState) return snapshot;
      if (Array.isArray(next?.catalogs) && !('library' in next)) {
        next.library = next.catalogs.find(catalog => catalog.libraryId === next.activeLibraryId)?.library ?? null;
      }
      remember(next, order);
      return next;
    }).finally(() => { readingSnapshot = undefined; });
    return readingSnapshot;
  }

  function monitorImport(id) {
    if (!id) return;
    const current = monitoredImports.get(id);
    if (current) {
      current.requested = true;
      return;
    }
    const monitor = { requested: false };
    monitoredImports.set(id, monitor);
    async function tick() {
      monitor.requested = false;
      let pending = false;
      try {
        if (!connectedImports.has(id)) return;
        const queue = await call('local-import:list', [id, false]);
        if (!queue?.ok) return;
        publish('local-import:changed', [id]);
        pending = queue.refreshPending || queue.summary?.running > 0 || (!queue.paused && queue.summary?.pending > 0);
        const displayedRevision = snapshot?.catalogs.find(item => item.libraryId === id)?.revision;
        if (queue.catalogRevision != null && queue.catalogRevision !== displayedRevision) {
          await readSnapshot();
        }
      } catch { /* A disconnected library is reported by the regular refresh. */ }
      finally {
        if ((pending || monitor.requested) && connectedImports.has(id)) setTimeout(() => void tick(), 400);
        else monitoredImports.delete(id);
      }
    }
    setTimeout(() => void tick(), 120);
  }

  function assetAt(library, id) {
    return snapshot?.catalogs.find(item => item.libraryId === library)?.library.assets.find(asset => asset.id === id);
  }

  async function writeText(text) {
    if (!text) return { ok: false, message: '没有可复制的内容。' };
    await navigator.clipboard.writeText(text);
    return { ok: true };
  }

  async function copyResult(result) {
    if (!result?.ok) return result;
    if (result.count === 0 && !result.text) return result;
    if (result.png) {
      const bytes = Uint8Array.from(atob(result.png), char => char.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
      return { ok: true };
    }
    const copied = await writeText(result.text ?? result.url);
    if (!copied.ok) return copied;
    const { text, url, ...metadata } = result;
    return metadata;
  }

  async function pollDesktop() {
    try {
      if (snapshot) {
        const current = await call('desktop:status');
        const previous = desktopStatus;
        const displayedRevision = snapshot.libraryRevision ?? previous?.libraryRevision;
        if (current.libraryRevision !== displayedRevision) await readSnapshot();
        if (current.historyRevision !== previous?.historyRevision) publish('browser-capture:history-changed');
        if (current.inboxRevision !== previous?.inboxRevision) publish('inbox:changed', true);
        if (JSON.stringify(current.duplicates) !== JSON.stringify(previous?.duplicates)) publish('duplicates:changed', current.duplicates);
        if (current.suggestionsRevision !== previous?.suggestionsRevision) {
          publish('suggestion:changed', await readSuggestionPages(await call('suggestion:batch', ['snapshot'])));
        }
        if (current.searchRevision !== previous?.searchRevision) {
          publish('natural-search:changed', await call('natural-search:status'));
        }
        for (const [id, revision] of Object.entries(current.cloudRevisions ?? {})) {
          if (revision !== previous?.cloudRevisions?.[id]) publish('cloud-originals:changed', id);
        }
        if (JSON.stringify(current.update) !== JSON.stringify(previous?.update)) publish('windows-update:changed', current.update);
        desktopStatus = current;
      }
    } catch { /* A manual refresh can report a stopped service. */ }
    finally { setTimeout(() => void pollDesktop(), 1200); }
  }

  function watchVisual(job) {
    if (pollingVisual || job?.status !== 'running') return;
    pollingVisual = true;
    async function tick() {
      try {
        const progress = await call('visual:status');
        publish('visual:changed', progress);
        if (progress?.status === 'running') {
          setTimeout(() => void tick(), 500);
          return;
        }
      } catch { /* The panel also reports errors from its explicit commands. */ }
      pollingVisual = false;
    }
    setTimeout(() => void tick(), 500);
  }

  async function withProgress(name, args, channel) {
    let running = true;
    let timer;
    async function tick() {
      if (!running) return;
      try {
        const progress = await call(`${channel}:status`);
        if (running && progress) publish(`${channel}:progress`, progress);
      } catch { /* Operations report errors when they complete. */ }
      if (running) timer = setTimeout(() => void tick(), 400);
    }
    timer = setTimeout(() => void tick(), 400);
    try { return await call(name, args); }
    finally { running = false; clearTimeout(timer); }
  }

  function base64(data) {
    let binary = '';
    for (let start = 0; start < data.length; start += 16_384) {
      binary += String.fromCharCode(...data.subarray(start, start + 16_384));
    }
    return btoa(binary);
  }

  function inlineDropImage(value) {
    const prefix = /^data:image\/(?:png|jpe?g|gif|webp|bmp|x-ms-bmp|avif);base64,/i.exec(value);
    if (!prefix) return null;
    const encoded = value.slice(prefix[0].length);
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
    const padding = encoded.endsWith('==') ? 2 : Number(encoded.endsWith('='));
    return { name: '拖入的图片', byteCount: encoded.length * 3 / 4 - padding,
      readChunk: async (start, end) => encoded.slice(start * 4 / 3, Math.ceil(end / 3) * 4) };
  }

  function postNativeDrop(webview, objects) {
    const request = crypto.randomUUID();
    return new Promise(resolve => {
      function finish(result) {
        clearTimeout(timer);
        webview.removeEventListener('message', reply);
        resolve(result);
      }
      function reply({ data }) {
        if (data?.jiancangNativeDrop === request) finish(data);
      }
      const timer = setTimeout(() => finish(null), 1500);
      webview.addEventListener('message', reply);
      // Wry's IPC listener also receives this event and requires a string message.
      try { webview.postMessageWithAdditionalObjects(`jiancang-native-drop:${request}`, objects); }
      catch { finish(null); }
    });
  }

  async function resolveNativeDrop(webview, files, handles = []) {
    if (transferringFile) return { ignored: true };
    if (files.length > 10_000) return { tooMany: true };
    const result = files.some(Boolean) ? await postNativeDrop(webview, files) : null;
    if (result?.token || result?.ignored || result?.tooMany || result?.busy || !handles.length) return result;
    // A web-backed File can prevent the whole message from being posted.
    // Use the drop handles to identify original filesystem-backed File objects.
    const filesystem = await Promise.all(handles);
    const nativeFiles = files.map((file, index) => filesystem[index] ? file : null);
    return nativeFiles.some(Boolean) && nativeFiles.some((file, index) => file !== files[index])
      ? postNativeDrop(webview, nativeFiles) : result;
  }

  async function submitWebDrop(id, collectionId, { files = [], videoFiles = [], images = [], imageURL = [],
    link, sourceURL, skipped, nativeToken }) {
    const uploads = [
      ...[...files, ...videoFiles].map((file, index) => ({ name: file.name, byteCount: file.size,
        ...(index >= files.length && { kind: 'video' }),
        readChunk: async (start, end) => base64(new Uint8Array(await file.slice(start, end).arrayBuffer())) })),
      ...images.filter(image => image.bytes).map(({ name, bytes }) => ({ name, byteCount: bytes.length,
        readChunk: async (start, end) => base64(bytes.subarray(start, end)) })),
    ];
    const urls = imageURL.filter(value => /^https?:\/\//i.test(value) && value.length <= 4096).slice(0, 3);
    if (!uploads.length) {
      const inline = imageURL.map(inlineDropImage).find(Boolean);
      if (inline) uploads.push(inline);
    }
    const metadata = { imageURL: urls, link, sourceURL, skipped, nativeToken };
    if (!uploads.length && nativeToken) return call('local-import:native-drop', [id, collectionId, nativeToken]);
    if (!uploads.length) return call('local-import:drop-items', [id, collectionId, metadata]);
    const { token } = await call('local-import:drop-begin', [id, collectionId,
      { ...metadata, images: uploads.map(({ name, byteCount, kind }) => ({ name, byteCount, kind })) }]);
    try {
      for (const [index, upload] of uploads.entries()) {
        for (let offset = 0; offset < upload.byteCount; offset += uploadChunkBytes) {
          const bytes = await upload.readChunk(offset, Math.min(offset + uploadChunkBytes, upload.byteCount)).catch(() => {
            throw new Error(upload.kind === 'video' ? '无法读取这个来源提供的视频原件。请先保存，再从资源管理器拖入。'
              : '无法读取这张图片。请先保存，再从资源管理器拖入。');
          });
          await call('local-import:drop-append', [token, index, offset, bytes]);
        }
      }
      return await call('local-import:drop-finish', [token]);
    } finally { await call('local-import:drop-discard', [token]).catch(() => {}); }
  }

  async function saveEditedAsset(kind, payload) {
    const { png, bytes, ...metadata } = payload;
    const data = kind === 'frame' ? png : bytes;
    let token;
    try {
      if (!(data instanceof Uint8Array)) throw new Error('生成的图片暂不可用。');
      ({ token } = await call('edit:upload-begin', [kind, { ...metadata, byteCount: data.length }]));
      for (let start = 0; start < data.length; start += uploadChunkBytes) {
        await call('edit:upload-append', [token, base64(data.subarray(start, start + uploadChunkBytes))]);
      }
      const order = ++sequence;
      const result = await call('edit:save', [token]);
      if (result?.state) remember(result.state, order);
      return result;
    } catch (error) { return { ok: false, message: error.message }; }
    finally { if (token) await call('edit:upload-discard', [token]).catch(() => {}); }
  }

  async function exportBoard(payload) {
    const { data, pages, ...metadata } = payload;
    if (!['png', 'pdf'].includes(metadata.format)) return call('board:export', [metadata]);
    const { token } = await call('board:export-begin', [metadata.format]);
    try {
      const images = pages || [{ data }];
      for (const [index, page] of images.entries()) {
        const bytes = page.data;
        for (let start = 0; start < bytes.length; start += uploadChunkBytes) {
          await call('board:export-append', [token, index, base64(bytes.subarray(start, start + uploadChunkBytes))]);
        }
      }
      const dimensions = pages?.map(({ width, height }) => ({ width, height }));
      return await call('board:export', [{ ...metadata, uploadToken: token, pages: dimensions }]);
    } finally { await call('board:export-discard', [token]).catch(() => {}); }
  }

  async function captureOfflineWeb(reference) {
    const staged = await call('offline-web:capture-start', [reference]);
    if (staged.snapshot) return staged.snapshot;
    try {
      const extraction = window.extractJianCangOfflineWeb(staged.html, staged.finalURL);
      return await call('offline-web:capture-finish', [staged.token, extraction]);
    } catch (error) {
      await call('offline-web:capture-cancel', [staged.token]).catch(() => {});
      throw error;
    }
  }

  document.addEventListener('contextmenu', event => {
    if (!event.target.closest('input, textarea, [contenteditable]')) event.preventDefault();
  });

  const menuItem = (label, action, enabled = true) => ({ label, action, enabled });
  const menuGroup = (label, children) => ({ label, children });

  function assetMenu(id, library, options) {
    const asset = assetAt(library, id);
    if (!asset) return null;
    const entry = snapshot.libraries.find(item => item.id === library);
    const catalog = snapshot.catalogs.find(item => item.libraryId === library)?.library;
    const canWrite = !!entry && entry.status !== 'unavailable' &&
      (entry.kind === 'local' || entry.syncWritable && entry.format === 6 &&
        !entry.syncLogIncomplete && !catalog?.logIncomplete && Number.isInteger(entry.writeStatus?.pending));
    const destinations = snapshot.libraries.filter(other =>
      other.id !== library && other.libraryId !== entry?.libraryId && other.root !== entry?.root &&
      other.status !== 'unavailable' && (other.kind === 'local' || other.syncWritable && other.format === 6));
    const { available, kind, extension, trashed, byteCount } = asset;
    const image = kind === 'image' || extension === 'livp';
    const textPreview = kind === 'document' && textPreviewExtensions.has(extension);
    const previewable = image || (kind === 'video' && asset.thumbnailAvailable) ||
      (available && (['video', 'audio', 'pdf'].includes(kind) || textPreview));
    const hasURL = window.jiancangAssetContextMenu.assetHasWebURL(asset);
    const canRetrieve = ['jiancang', 'eagle'].includes(entry?.kind) && !trashed && kind !== 'link' &&
      Number.isSafeInteger(byteCount) && byteCount >= 0;
    const canEditImage = kind === 'image' && !trashed && editorImageTypes.has(extension) &&
      byteCount > 0 && byteCount <= 96 * 1024 ** 2;
    const copyToLocal = entry?.kind === 'eagle' && destinations.every(other => other.kind === 'local');
    const actions = [
      menuItem('打开预览', 'preview', !!previewable),
      ...(available && !trashed && defaultApplicationExtensions.has(extension)
        ? [menuItem('用默认应用打开', 'open-default')] : []),
      menuItem('打开置顶参考窗', 'reference', image),
      ...(extension === 'livp' && available && typeof options?.liveLoop === 'boolean'
        ? [{ ...menuItem('循环播放实况', 'live-loop'), check: 'checkbox', checked: options.liveLoop }] : []),
      menuItem('重新读取预览', 'retry'),
      ...(canRetrieve ? [menuItem('取回原件…', 'cloud-original')] : []),
      ...(canEditImage ? [menuItem('图片工具…', 'image-tools', available)] : []),
      ...(kind === 'video' && !trashed && byteCount > 0 ? [menuItem('裁剪视频…', 'video-trim', available)] : []),
      null,
      ...(available && !trashed ? [menuItem('复制文件', 'copy-file')] : []),
      menuItem('在资源管理器中显示', 'reveal', available),
      menuGroup('复制素材信息', window.jiancangAssetContextMenu.clipboardItems([asset], 'clipboard-')),
      ...(kind === 'link' && hasURL ? [menuItem('打开网址', 'link'), menuItem('网页离线阅读…', 'offline-web')] : []),
      ...(!trashed && hasURL ? [menuItem('查找同来源网站', 'find-source-site')] : []),
      ...(image && !trashed ? [
        null, menuItem('加入灵感板…', 'board-add'), menuItem('查找相似图片', 'find-similar', available),
        menuItem('AI 整理建议…', 'suggest-asset', available),
      ] : []),
      ...(copyToLocal || destinations.length ? [
        null, menuItem(copyToLocal ? '复制到见藏本地库…' : '复制到其他库…', 'copy-local', !trashed),
      ] : []),
    ];
    if (!trashed && ['add', 'remove'].includes(options?.stash)) {
      actions.push(null, options.stash === 'add' ? menuItem('加入暂存选片', 'stash-add')
        : menuItem('移出暂存选片', 'stash-remove'));
    }
    if (canWrite && trashed) {
      actions.push(null, menuItem('恢复素材', 'restore-local'));
      if (entry.kind === 'local') actions.push({ ...menuItem('永久删除…', 'purge-local'), danger: true });
    }
    if (canWrite && !trashed) {
      const rating = [1, 2, 3, 4, 5, 0].map(value => ({
        ...menuItem(value ? `${value} 星` : '清除评分', `rate-local-${value}`),
        check: 'radio', checked: (asset.rating || 0) === value,
      }));
      actions.push(null, menuItem(asset.favorite ? '取消收藏' : '加入收藏', 'favorite-local'), menuGroup('评分', rating));
      if (catalog?.collections.some(collection => !asset.collectionIds.includes(collection.id))) {
        actions.push(menuItem('加入集合…', 'add-collections-local'));
      }
      actions.push(null, { ...menuItem('删除…', 'trash-local'), danger: true });
    }
    return window.jiancangAssetContextMenu.showMenu(actions, options?.anchor, '素材操作');
  }

  const renderer = {
    async invoke(name, ...args) {
      if (name === 'library:state') return readSnapshot();
      if (name === 'asset:context-menu') return assetMenu(...args);
      if (name === 'assets:clipboard-menu') {
        const assets = args[0].map(({ id, registrationId }) => assetAt(registrationId, id)).filter(Boolean);
        if (!assets.length) return { ok: false, message: '素材已变化，请刷新后重试。' };
        const { clipboardItems, showMenu } = window.jiancangAssetContextMenu;
        const mode = await showMenu(clipboardItems(assets), undefined, '复制素材信息');
        return mode ? { ok: true, mode } : { cancelled: true };
      }
      if (name === 'collection:copy-name') {
        const [library, id] = args;
        const collection = snapshot?.catalogs.find(item => item.libraryId === library)?.library.collections
          .find(item => item.id === id);
        return writeText(collection?.name);
      }
      if (clipboardCommands.has(name)) return copyResult(await call(name, args));
      if (name === 'offline-web:capture') return captureOfflineWeb(args[0]);
      if (name === 'board:export') return exportBoard(args[0]);
      if (name === 'asset:save-video-frame') return saveEditedAsset('frame', args[0]);
      if (name === 'asset:save-edited-image') return saveEditedAsset('image', args[0]);
      const order = ++sequence;
      const result = name === 'local-import:drop-items' ? await submitWebDrop(...args)
        : operationProgress[name] ? await withProgress(name, args, operationProgress[name]) : await call(name, args);
      if (name === 'suggestion:apply') return { ...result, batch: await readSuggestionPages(result.batch) };
      if (name.startsWith('suggestion:')) return readSuggestionPages(result);
      if (name === 'visual:start' || name === 'visual:status') watchVisual(result);
      if (libraryChanges.has(name)) remember(result, order);
      else if (result?.state) remember(result.state, order);
      if (importChanges.has(name) && result?.ok) {
        publish('local-import:changed', [args[0]]);
        monitorImport(args[0]);
      }
      return result;
    },
    on(channel, listener) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(listener);
    },
    removeListener(channel, listener) { listeners.get(channel)?.delete(listener); },
    send(name, token, thumbnail) {
      if (name !== 'asset:start-drag' || transferringFile) return;
      transferringFile = true;
      void call(name, [token, thumbnail ?? null]).catch(() => publish('asset:drag-unavailable', token)).finally(() => {
        transferringFile = false;
        publish('asset:drag-concluded', token);
      });
    },
  };
  const contextBridge = {
    exposeInMainWorld(name, contract) {
      contract.dropWebImages = (id, collection, files, details) => renderer.invoke('local-import:drop-items', id, collection, { ...details, files });
      const webview = window.chrome?.webview;
      if (typeof webview?.postMessageWithAdditionalObjects === 'function') {
        contract.resolveNativeDrop = (files, handles) => resolveNativeDrop(webview, files, handles);
      }
      contract.onNativeFileDrop = listener => window.addEventListener('jiancang-native-drop', event => {
        if (!transferringFile) listener(event.detail);
      });
      contract.importNativeFiles = (id, collection, token) => renderer.invoke('local-import:native-drop', id, collection, token);
      contract.importLegacyPresets = () => call('presets:import-legacy');
      Object.defineProperty(window, name, { value: Object.freeze(contract) });
    },
  };
  Object.defineProperty(window, 'jiancangTauriPlatform', {
    value: Object.freeze({
      contextBridge, ipcRenderer: renderer, mediaURL, playbackURL,
      webUtils: Object.freeze({ getPathForFile: () => '' }),
    }),
  });
  setTimeout(() => void pollDesktop(), 1200);
})();
