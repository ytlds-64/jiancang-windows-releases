'use strict';

window.createJianCangLocalIntake = ({ bridge, getLibraries, getCopyLibraries, getCollections, getTarget, getDropTarget,
  getPreviewScope, hasImportedAsset, onPreviewChange, collectionDragType, onCreated, notify }) => {
  const get = id => document.getElementById(id);
  const createDialog = get('local-create-dialog');
  const importDialog = get('local-import-dialog');
  const cancelDialog = get('local-import-cancel-dialog');
  const target = get('local-import-target');
  const collection = get('local-import-collection');
  const queueList = get('local-queue-list');
  const badge = get('local-import-count');
  const pauseQueue = get('local-queue-pause');
  const retryFailed = get('local-queue-retry-failed');
  const cancelPending = get('local-queue-cancel-pending');
  const queueStatus = get('local-queue-status');
  const queueSearch = get('local-queue-search');
  const buttons = ['local-import-files', 'local-import-folders', 'local-import-paste', 'local-copy-submit'];
  const states = { pending: '待导入', running: '正在导入', done: '已导入', failed: '失败' };
  const pageSize = 70;
  const normalize = text => text.normalize('NFKC').toLowerCase();
  let references = null;
  let pendingDrop = null;
  let fetching = 0;
  let importing = false;
  let capturingPaste = false;
  let limit = pageSize;
  let lastTarget = '';
  let rows = new Map();
  let queueState;
  let queueCommand = false;
  let pendingCancel;
  let dragDepth = 0;
  let importDropRow = null;
  let dropNotice = '';
  let previewScope;
  let nextPreparation = 0;
  let previewAssetsById = new Map();
  const preparations = new Set();
  const previews = new Map();

  function errorAt(id, message) {
    get(id).textContent = message || '';
    get(id).hidden = !message;
  }

  function pickTarget() {
    const libraries = getLibraries();
    const direct = getTarget();
    if (direct?.id && libraries.some(item => item.id === direct.id)) return direct;
    return libraries.length === 1 ? { id: libraries[0].id, collection: null } : null;
  }

  function renderQueueControls() {
    pauseQueue.textContent = queueState?.paused ? '恢复队列' : '暂停队列';
    pauseQueue.disabled = !queueState || queueCommand;
    retryFailed.disabled = !queueState?.summary.failed || queueCommand;
    cancelPending.disabled = !queueState?.summary.pending || queueCommand;
    for (const { retry, cancel } of rows.values()) retry.disabled = cancel.disabled = queueCommand;
  }

  function setStatusLabels(summary, syncTarget) {
    const total = summary && Object.values(summary).reduce((sum, count) => sum + count, 0);
    for (const option of queueStatus.options) {
      const id = option.value;
      const name = id === 'all' ? '所有任务' : id === 'done' ? (syncTarget ? '已接收' : '已完成') : states[id];
      const label = summary ? `${name}（${id === 'all' ? total : summary[id]}）` : name;
      if (option.textContent !== label) option.textContent = label;
    }
  }

  function resetQueue() {
    queueState = undefined;
    limit = pageSize;
    queueList.replaceChildren();
    queueList.scrollTop = 0;
    rows = new Map();
    get('local-queue-summary').textContent = '';
    get('local-queue-more').hidden = true;
    errorAt('local-queue-feedback', '');
    errorAt('local-queue-results', '');
    errorAt('local-queue-history', '');
    queueStatus.disabled = queueSearch.disabled = true;
    setStatusLabels();
    renderQueueControls();
  }

  async function changeQueue(id, operation, feedback) {
    if (queueCommand) return;
    const isDisplayed = () => importDialog.open && target.value === id;
    queueCommand = true;
    renderQueueControls();
    if (isDisplayed()) {
      errorAt('local-import-error', '');
      errorAt('local-queue-feedback', '');
    }
    try {
      const result = await operation();
      if (!result?.ok) throw new Error(result?.message || '导入队列操作未完成。');
      if (isDisplayed()) errorAt('local-queue-feedback', feedback(result));
    } catch (error) {
      if (isDisplayed()) errorAt('local-import-error', error.message || '导入队列操作未完成。');
    } finally {
      await updateQueue();
      queueCommand = false;
      renderQueueControls();
    }
  }

  function fillCollections(id, selected) {
    const choices = getCollections(id);
    const names = new Map(choices.map(item => [item.id, item]));
    collection.replaceChildren(new Option('库根目录', ''));
    for (const item of choices) {
      const parts = [];
      const seen = new Set();
      for (let current = item; current && !seen.has(current.id); current = names.get(current.parentId)) {
        seen.add(current.id);
        parts.unshift(current.name);
      }
      collection.add(new Option(parts.join(' / '), item.id));
    }
    if (selected && names.has(selected)) collection.value = selected;
  }

  function create() {
    if (createDialog.open) return;
    errorAt('local-create-error', '');
    get('local-create-name').value = '';
    createDialog.showModal();
    get('local-create-name').focus();
  }

  async function open({ assets, drop, libraryId } = {}) {
    const libraries = assets ? getCopyLibraries(assets) : getLibraries();
    if (!libraries.length) {
      drop?.release?.();
      notify(assets ? '请选择其他可写素材库。可以先添加同步库或新建本地库。' : '先新建本地库，再导入素材。');
      if (!assets || assets.every(asset => asset.sourceKind === 'eagle')) create();
      return;
    }
    references = assets?.map(asset => ({ id: asset.sourceAssetId, registrationId: asset.sourceLibraryId })) ?? null;
    pendingDrop?.release?.();
    pendingDrop = drop ?? null;
    const context = pickTarget();
    target.replaceChildren(...libraries.map(item => new Option(`${item.name}${item.kind === 'jiancang' ? '（同步库）' : ''}`, item.id)));
    const preferred = libraryId || context?.id || lastTarget;
    if (libraries.some(item => item.id === preferred)) target.value = preferred;
    fillCollections(target.value, context?.id === target.value ? context.collection : null);
    if (!importDialog.open) {
      queueStatus.value = 'all';
      queueSearch.value = '';
    }
    resetQueue();
    get('local-import-title').textContent = references ? '复制素材到其他库' : pendingDrop ? '选择导入位置' : '导入素材';
    get('local-copy-submit').textContent = references ? `复制 ${references.length} 项` : '开始导入';
    get('local-copy-preserve').parentElement.hidden = !references;
    get('local-copy-actions').hidden = !references && !pendingDrop;
    get('local-import-actions').hidden = !!references || !!pendingDrop;
    errorAt('local-import-error', '');
    if (!importDialog.open) importDialog.showModal();
    void updateQueue();
  }

  function promptCancel(id, detail, taskId) {
    if (queueCommand || cancelDialog.open) return;
    pendingCancel = { id, taskId };
    get('local-import-cancel-title').textContent = taskId ? '取消导入任务？' : '取消全部等待任务？';
    get('local-import-cancel-detail').textContent = detail;
    get('local-import-cancel-confirm').textContent = taskId ? '确认取消任务' : '确认取消全部等待任务';
    cancelDialog.showModal();
  }

  function taskRow(task, id) {
    const item = document.createElement('li');
    const body = document.createElement('div');
    const title = document.createElement('strong');
    const detail = document.createElement('small');
    const progress = document.createElement('progress');
    progress.max = 1;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'outline-button';
    retry.textContent = '重试';
    retry.setAttribute('aria-label', `重试 ${task.name}`);
    retry.addEventListener('click', () => {
      void changeQueue(id, () => bridge.retryImport(id, task.id), () => '已安排重试这项任务。');
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'outline-button';
    cancel.textContent = '取消任务';
    cancel.setAttribute('aria-label', `取消任务 ${task.name}`);
    cancel.addEventListener('click', () => {
      promptCancel(id, `将「${task.name}」移出导入队列。源文件和已导入的素材会保留。`, task.id);
    });
    const actions = document.createElement('div');
    actions.className = 'local-queue-row-actions';
    actions.append(retry, cancel);
    body.append(title, detail, progress);
    item.append(body, actions);
    return { item, title, detail, progress, actions, retry, cancel };
  }

  async function updateQueue() {
    const id = importDialog.open ? target.value : pickTarget()?.id || lastTarget;
    const token = ++fetching;
    if (!id || !getLibraries().some(library => library.id === id)) { badge.hidden = true; return; }
    let result;
    try { result = await bridge.importTasks(id, importDialog.open); }
    catch { return; }
    if (token !== fetching) return;
    if (!result?.ok) {
      if (importDialog.open) errorAt('local-import-error', result?.message);
      return;
    }
    const { summary, tasks, paused } = result;
    badge.textContent = String(summary.failed);
    badge.hidden = !summary.failed;
    badge.classList.toggle('has-failures', summary.failed > 0);
    badge.title = summary.failed ? '有素材导入失败' : '';
    if (!importDialog.open || target.value !== id) return;
    const syncTarget = getLibraries().find(library => library.id === id)?.kind === 'jiancang';
    queueState = { id, paused, summary, syncTarget,
      tasks: [...tasks.filter(task => task.status === 'failed'), ...tasks.filter(task => task.status !== 'failed')] };
    queueStatus.disabled = queueSearch.disabled = false;
    setStatusLabels(summary, syncTarget);
    get('local-queue-summary').textContent = [paused && '已暂停', summary.running && `${summary.running} 项导入中`,
      summary.pending && `${summary.pending} 项等待`, summary.done && `${summary.done} 项${syncTarget ? '已接收' : '完成'}`,
      summary.failed && `${summary.failed} 项失败`].filter(Boolean).join(' · ') || '暂无任务';
    renderQueue();
  }

  function renderQueue() {
    if (!queueState) return;
    const { id, paused, summary, syncTarget, tasks } = queueState;
    const status = queueStatus.value;
    const query = normalize(queueSearch.value).trim();
    const filtered = status !== 'all' || !!query;
    const matching = tasks.filter(task => (status === 'all' || task.status === status) &&
      (!query || normalize(`${task.name}\n${task.error || ''}`).includes(query)));
    const shown = matching.slice(0, limit);
    const recentDone = tasks.filter(task => task.status === 'done').length;
    errorAt('local-queue-history', (status === 'all' || status === 'done') && recentDone < summary.done
      ? `仅显示最近 ${recentDone} 项${syncTarget ? '已接收' : '已完成'}的任务。` : '');
    errorAt('local-queue-results', filtered && !matching.length ? '没有符合条件的任务。'
      : matching.length > limit ? `显示 ${shown.length} / ${matching.length} 项`
        : filtered ? `共 ${matching.length} 项` : '');
    const fresh = new Map();
    const elements = shown.map(task => {
      const row = rows.get(task.id) ?? taskRow(task, id);
      fresh.set(task.id, row);
      const running = task.status === 'running';
      row.title.textContent = task.name;
      row.title.title = task.name;
      row.detail.textContent = task.error || (paused && task.status === 'pending' ? '等待恢复队列'
        : syncTarget && task.status === 'done' ? '已交给同步队列' : states[task.status]);
      row.item.classList.toggle('is-failed', task.status === 'failed');
      row.progress.hidden = !running;
      row.progress.value = task.progress || 0;
      row.progress.setAttribute('aria-label', `导入 ${task.name}`);
      row.retry.hidden = task.status !== 'failed';
      row.cancel.hidden = task.status !== 'pending' && task.status !== 'failed';
      row.actions.hidden = row.cancel.hidden;
      return row.item;
    });
    if (elements.length !== queueList.children.length || elements.some((item, index) => queueList.children[index] !== item)) {
      queueList.replaceChildren(...elements);
    }
    rows = fresh;
    get('local-queue-more').hidden = matching.length <= limit;
    renderQueueControls();
  }

  function matchesPreview(task) {
    return previewScope?.ids.includes(task.targetId) &&
      (!previewScope.collections || previewScope.collections.has(task.collectionId));
  }

  function importPlaceholder(task, sourceName) {
    const id = `import:${task.targetId}:${task.id}`;
    const name = task.name || '未命名文件';
    const extension = /\.([a-z0-9]{1,10})$/i.exec(name)?.[1].toLowerCase();
    const kind = videoSuffix.test(name) ? 'video'
      : /^(?:jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|ico|livp)$/.test(extension) ? 'image'
        : /^(?:mp3|m4a|wav|aac|flac|ogg|opus|aiff?)$/.test(extension) ? 'audio'
          : extension === 'pdf' ? 'pdf' : 'document';
    return { id, name, sourceName, extension, kind, importing: true };
  }

  function previewItems() {
    const selected = getPreviewScope();
    const key = selected && JSON.stringify([selected.ids, selected.collectionIds]);
    if (key !== previewScope?.key) {
      previewScope = selected && { ...selected, key, collections: selected.collectionIds && new Set(selected.collectionIds) };
      previews.clear();
      for (const id of previewScope?.ids ?? []) requestPreview(id);
    }
    const next = new Map();
    const names = new Map(getLibraries().map(library => [library.id, library.name]));
    function append(task) {
      const id = `import:${task.targetId}:${task.id}`;
      next.set(id, previewAssetsById.get(id) ?? importPlaceholder(task, names.get(task.targetId)));
    }
    for (const preparation of preparations) {
      if (matchesPreview(preparation)) preparation.tasks.forEach(append);
    }
    for (const queue of previews.values()) {
      for (const task of queue.tasks.values()) {
        if (hasImportedAsset(task)) queue.tasks.delete(task.id);
        else append(task);
      }
    }
    previewAssetsById = next;
    return [...next.values()];
  }

  function previewQueue(id) {
    let queue = previews.get(id);
    if (!queue) {
      queue = { tasks: new Map(), requested: false, reading: false, receipts: 0, revision: undefined };
      previews.set(id, queue);
    }
    return queue;
  }

  function requestPreview(id) {
    if (!previewScope?.ids.includes(id)) return;
    const scope = previewScope;
    const queue = previewQueue(id);
    if (queue.reading) { queue.requested = true; return; }
    queue.reading = true;
    queue.requested = false;
    const receipts = queue.receipts;
    void (async () => {
      try {
        const result = await bridge.importTasks(id, { inline: true, collectionIds: scope.collectionIds ?? undefined, knownRevision: queue.revision });
        if (previewScope !== scope || receipts !== queue.receipts || !result?.ok || !Array.isArray(result.tasks)) return;
        const previous = queue.tasks;
        const next = Array.isArray(result.removed) ? previous : new Map();
        for (const id of result.removed ?? []) next.delete(id);
        for (const task of result.tasks) {
          if (task.status === 'failed' || (task.resultId && !previous.has(task.id))) continue;
          if (matchesPreview(task)) next.set(task.id, task);
        }
        queue.tasks = next;
        queue.revision = result.inlineRevision;
        onPreviewChange();
      } catch { /* The queue dialog can report an explicit request failure. */ }
      finally {
        queue.reading = false;
        if (previewScope === scope && queue.requested) requestPreview(id);
      }
    })();
  }

  function receivePreview(id, tasks) {
    if (!previewScope?.ids.includes(id) || !Array.isArray(tasks)) return;
    const queue = previewQueue(id);
    for (const task of tasks) {
      if (matchesPreview(task) && !queue.tasks.has(task.id)) queue.tasks.set(task.id, task);
    }
    queue.receipts++;
    requestPreview(id);
  }

  async function intake(operation, id, { direct = false, collectionId = null, files = [] } = {}) {
    if (!direct) {
      if (importing) return;
      importing = true;
      for (const button of buttons) get(button).disabled = true;
      errorAt('local-import-error', '');
    }
    const names = files.map(file => file?.name).filter(Boolean);
    const preparation = names.length ? {
      targetId: id, collectionId, tasks: names.map(name => ({
        id: `drop:${++nextPreparation}`, targetId: id, collectionId, name,
      })),
    } : null;
    if (preparation) {
      preparations.add(preparation);
      onPreviewChange();
    }
    try {
      const result = await operation();
      if (result?.cancelled) return;
      if (!result?.ok) throw new Error(result?.message || '无法加入导入队列。');
      preparations.delete(preparation);
      receivePreview(id, result.tasks);
      onPreviewChange();
      lastTarget = id;
      if (result.skipped) notify(`已跳过 ${result.skipped} 个不可用的项目。`);
      if (!direct && (references || pendingDrop) && importDialog.open) await open();
      void updateQueue();
    } catch (error) {
      if (!direct && importDialog.open) errorAt('local-import-error', error?.message);
      else notify(error?.message || '导入未完成。');
    } finally {
      if (preparations.delete(preparation)) onPreviewChange();
      if (!direct) {
        for (const button of buttons) get(button).disabled = false;
        importing = false;
      }
    }
  }

  function transfer(operation, release) {
    const context = pickTarget();
    const library = getLibraries().find(entry => entry.id === context?.id);
    if (context && (getTarget()?.id === context.id || library?.kind === 'local')) {
      return intake(() => operation(context.id, context.collection), context.id, {
        direct: true, collectionId: context.collection,
      }).finally(() => release?.());
    }
    return open({ drop: { operation, release } });
  }

  get('local-create-close').addEventListener('click', () => createDialog.close());
  get('local-import-close').addEventListener('click', () => importDialog.close());
  get('local-create-form').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = get('local-create-submit');
    if (submit.disabled) return;
    submit.disabled = true;
    errorAt('local-create-error', '');
    try {
      const before = new Set(getLibraries().map(item => item.id));
      const result = await bridge.createLocalLibrary(get('local-create-name').value);
      if (result?.ok === false) throw new Error(result.message);
      const created = result?.libraries.find(item => item.kind === 'local' && !before.has(item.id));
      if (created) {
        createDialog.close();
        lastTarget = created.id;
        onCreated(result, created.id);
      } else if (result?.message) throw new Error(result.message);
    } catch (error) { errorAt('local-create-error', error?.message || '新建素材库失败。'); }
    finally { submit.disabled = false; }
  });
  target.addEventListener('change', () => {
    resetQueue();
    lastTarget = target.value;
    fillCollections(target.value, getTarget()?.id === target.value ? getTarget().collection : null);
    errorAt('local-import-error', '');
    void updateQueue();
  });
  for (const [id, kind] of [['local-import-files', 'file'], ['local-import-folders', 'folder']]) {
    get(id).addEventListener('click', () => intake(() => bridge.chooseImport(target.value, collection.value || null, kind), target.value));
  }
  get('local-import-paste').addEventListener('click', () => intake(() => bridge.pasteImport(target.value, collection.value || null), target.value));
  get('local-copy-submit').addEventListener('click', () => {
    const id = target.value;
    const collectionId = collection.value || null;
    if (references) void intake(() => bridge.copyAssets(id, collectionId, references, get('local-copy-preserve').checked), id);
    else if (pendingDrop) void intake(() => pendingDrop.operation(id, collectionId), id);
  });
  function filterQueue() {
    limit = pageSize;
    queueList.scrollTop = 0;
    renderQueue();
  }
  queueStatus.addEventListener('change', filterQueue);
  queueSearch.addEventListener('input', filterQueue);
  get('local-queue-more').addEventListener('click', () => { limit += pageSize; renderQueue(); });
  pauseQueue.addEventListener('click', () => {
    if (!queueState) return;
    const id = target.value;
    void changeQueue(id, () => bridge.setImportPaused(id, !queueState.paused), ({ paused }) => paused
      ? '队列已暂停。正在导入的任务会继续完成。' : '队列已恢复。');
  });
  retryFailed.addEventListener('click', () => {
    const id = target.value;
    void changeQueue(id, () => bridge.retryFailedImports(id), ({ retried }) =>
      retried ? `已安排重试 ${retried} 项失败任务。` : '当前没有待重试的任务。');
  });
  cancelPending.addEventListener('click', () => {
    const count = queueState?.summary.pending;
    if (!count || queueState.id !== target.value) return;
    const name = target.selectedOptions[0].textContent;
    promptCancel(target.value, `将取消「${name}」中仍在等待的导入任务，当前有 ${count} 项。`);
  });
  get('local-import-cancel-back').addEventListener('click', () => cancelDialog.close());
  get('local-import-cancel-confirm').addEventListener('click', () => {
    const request = pendingCancel;
    cancelDialog.close();
    if (!request || !importDialog.open || target.value !== request.id) return;
    if (request.taskId) {
      void changeQueue(request.id, () => bridge.cancelImport(request.id, request.taskId), () => '任务已取消。');
    } else {
      void changeQueue(request.id, () => bridge.cancelPendingImports(request.id), ({ cancelled }) =>
        cancelled ? `已取消 ${cancelled} 项等待任务。` : '当前没有等待的任务。');
    }
  });
  cancelDialog.addEventListener('close', () => { if (!cancelDialog.open) pendingCancel = undefined; });
  importDialog.addEventListener('close', () => {
    if (!importDialog.open) {
      pendingDrop?.release?.();
      pendingDrop = null;
    }
    cancelDialog.close();
    ++fetching;
    void updateQueue();
  });
  bridge.onImportChange?.(ids => {
    if (ids.includes(importDialog.open ? target.value : pickTarget()?.id || lastTarget)) void updateQueue();
    for (const id of ids) requestPreview(id);
  });

  async function pasteTransfer() {
    if (capturingPaste) return;
    capturingPaste = true;
    try {
      const result = await bridge.capturePasteImport();
      if (!result?.token) throw new Error(result?.message || '无法读取剪贴板，请重新复制后再粘贴。');
      const release = () => { void bridge.releasePasteImport(result.token).catch(() => {}); };
      if (document.querySelector('dialog[open]')) { release(); return; }
      await transfer((id, collectionId) => bridge.pasteImport(id, collectionId, undefined, result.token), release);
    } catch (error) { notify(error?.message || '无法读取剪贴板，请重新复制后再粘贴。'); }
    finally { capturingPaste = false; }
  }

  function pasteIntoLibrary(event) {
    if (event.defaultPrevented || event.isComposing ||
        event.target?.closest?.('input, select, textarea, [contenteditable], [role="textbox"]') ||
        document.querySelector('dialog[open]') || !getLibraries().length) return;
    event.preventDefault();
    if (!event.repeat) void pasteTransfer();
  }
  document.addEventListener('paste', pasteIntoLibrary);
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'v') {
      pasteIntoLibrary(event);
    }
  });

  const dropOverlay = get('local-drop-target');
  const dropLabel = get('local-drop-label');
  const maximumDropImageBytes = bridge.maximumWebDropBytes || 32 * 1024 ** 2;
  const imageURLLimit = Math.ceil(maximumDropImageBytes / 3) * 4 + 80;
  const imageDropHelp = '请从资源管理器拖入已保存的文件，或复制图片后按 Ctrl+V。';
  const videoDropHelp = '这个来源没有提供可读取的视频文件。请先保存视频，再从资源管理器拖入。';
  const videoSuffix = /\.(?:mp4|m4v|mov|webm|ogv|avi|mkv|wmv|flv|mpg|mpeg|mts|m2ts|3gp)$/i;
  function importable(transfer) {
    const types = transfer?.types;
    return types && !types.includes(collectionDragType) &&
      !types.includes('application/x-jiancang-board-entry') &&
      (types.includes('Files') || types.includes('text/uri-list') || types.includes('text/html') || types.includes('text/plain'));
  }
  function readDrop(transfer) {
    // The data store is available only during the drop event. Keep File
    // handles for the queue, but read string representations immediately.
    let files = Array.from(transfer.files);
    let handles = [];
    const fileItems = Array.from(transfer.items ?? []).filter(item => item.kind === 'file');
    if (!files.length && fileItems.length) files = fileItems.map(item => item.getAsFile());
    if (bridge.resolveNativeDrop && fileItems.length === files.length && files.length <= 10_000) {
      // WebView2 requires calling getAsFileSystemHandle while the drop data store is still open.
      handles = fileItems.map(item => {
        try { return item.getAsFileSystemHandle?.().catch(() => null) ?? null; }
        catch { return null; }
      });
    }
    const uri = transfer.getData('text/uri-list').split(/\r?\n/).map(line => line.trim())
      .find(line => line && !line.startsWith('#')) || '';
    const plain = transfer.getData('text/plain').trim();
    const html = transfer.getData('text/html');
    const parsed = document.createElement('template');
    if (html && html.length <= 1024 ** 2) parsed.innerHTML = html;
    const image = parsed.content.querySelector('img');
    const source = image?.getAttribute('src')?.trim() || '';
    const isWebURL = value => value.length <= 4096 && /^https?:\/\/[^\s]+$/i.test(value);
    const imageURL = [...new Set([source, uri, plain].filter(value =>
      (value.length <= imageURLLimit && /^data:image\//i.test(value)) ||
      (isWebURL(value) && (image || /\.(?:jpe?g|png|webp|gif|avif|bmp)(?:[?#]|$)/i.test(value)))
    ))];
    const unsupportedVideo = !!parsed.content.querySelector('video') ||
      [uri, plain].some(value => /^data:video\//i.test(value) || videoSuffix.test(value.split(/[?#]/, 1)[0]));
    const link = !image && !imageURL.length && !unsupportedVideo ? [uri, plain].find(isWebURL) : undefined;
    const sourceURL = [image?.closest('a[href]')?.getAttribute('href')?.trim() || '', uri, plain, source].find(isWebURL);
    const unsupportedImage = !!image || [uri, plain].some(value => /^(?:file:|blob:|data:image\/)/i.test(value));
    return { files, handles, imageURL, link, sourceURL, unsupportedImage, unsupportedVideo };
  }
  async function dropItems(id, collectionId, { files, handles, imageURL, link, sourceURL, unsupportedVideo }) {
    const native = await bridge.resolveNativeDrop?.(files, handles);
    if (native?.ignored) return { cancelled: true };
    if (native?.tooMany) throw new Error('每次最多拖入 10,000 项，请分批导入。');
    if (native?.busy) throw new Error('正在处理其他拖入文件，请稍后再试。');
    const nativeIndices = new Set(native?.indices);
    const nativeFiles = [];
    const virtualFiles = [];
    const videoFiles = [];
    let videoUnavailable = unsupportedVideo;
    let bytesLeft = maximumDropImageBytes;
    for (const [index, droppedFile] of files.entries()) {
      if (nativeIndices.has(index)) continue;
      let file = droppedFile;
      if (!file && handles[index]) {
        const handle = await handles[index];
        if (handle?.kind === 'file') file = await handle.getFile().catch(() => null);
      }
      if (!file) continue;
      if (bridge.droppedFileHasPath(file)) nativeFiles.push(file);
      else if (file.type.startsWith('video/') || videoSuffix.test(file.name)) {
        if (bridge.dropWebImages && file.size > 0 && videoSuffix.test(file.name) && virtualFiles.length + videoFiles.length < 32) {
          videoFiles.push(file);
        } else videoUnavailable = true;
      } else if (file.size > 0 && file.size <= bytesLeft && virtualFiles.length + videoFiles.length < 32) {
        bytesLeft -= file.size;
        virtualFiles.push(file);
      }
    }
    const skipped = files.length - nativeIndices.size - nativeFiles.length - virtualFiles.length - videoFiles.length;
    if (native?.token && !virtualFiles.length && !videoFiles.length) {
      const result = await bridge.importNativeFiles(id, collectionId, native.token);
      return { ...result, skipped: (result?.skipped ?? 0) + skipped };
    }
    if (!nativeFiles.length && !virtualFiles.length && !videoFiles.length && !imageURL.length && !link) {
      if (videoUnavailable) throw new Error(videoDropHelp);
      throw new Error(files.some(Boolean) ? `这个来源提供的图片过大或为空。${imageDropHelp}`
        : '没有收到可导入的原件。请从资源管理器拖入已保存的文件。');
    }
    if (bridge.dropWebImages && !nativeFiles.length) {
      return bridge.dropWebImages(id, collectionId, virtualFiles, { videoFiles, imageURL, link, sourceURL,
        skipped, nativeToken: native?.token });
    }
    const images = await Promise.all(virtualFiles.map(async file => {
      const data = await file.arrayBuffer().catch(() => null);
      return { name: file.name, bytes: data ? new Uint8Array(data) : null };
    }));
    return bridge.dropItems(id, collectionId, nativeFiles, { images, imageURL, link });
  }
  function setDropRow(row) {
    if (importDropRow === row) return;
    importDropRow?.classList.remove('is-import-drop-target');
    importDropRow = row;
    importDropRow?.classList.add('is-import-drop-target');
  }
  function clearDrop() {
    dragDepth = 0;
    dropNotice = '';
    setDropRow(null);
    dropOverlay.hidden = true;
  }
  function dropIntent(event) {
    if (document.querySelector('dialog[open]')) return {};
    const row = event.target.closest?.('[data-import-library]') ?? null;
    const libraries = getLibraries();
    const context = row ? { id: row.dataset.importLibrary, collection: row.dataset.importCollection || null }
      : getDropTarget();
    const library = context ? libraries.find(entry => entry.id === context.id) :
      libraries.length === 1 ? libraries[0] : null;
    if (!library) {
      const guidance = libraries.length === 0 ? '请先添加或开启一个可写素材库。'
        : context ? '当前位置无法写入。请拖到左侧可写素材库或集合。'
          : '请拖到左侧目标库或集合，也可以先打开目标位置再拖入。';
      return { guidance };
    }
    const collectionId = context?.collection ?? null;
    const folder = collectionId && getCollections(library.id).find(entry => entry.id === collectionId);
    const name = row?.dataset.importDestinationName || folder?.name || library.name;
    return { row, destination: { id: library.id, collectionId, name } };
  }
  function announceDropGuidance(guidance) {
    if (guidance && guidance !== dropNotice) notify(guidance);
    dropNotice = guidance;
  }
  function showDropIntent(event) {
    event.preventDefault();
    const { row, destination, guidance } = dropIntent(event);
    event.dataTransfer.dropEffect = destination ? 'copy' : 'none';
    setDropRow(row ?? null);
    dropOverlay.hidden = !destination || !!row;
    if (!dropOverlay.hidden) dropLabel.textContent = `释放后导入到「${destination.name}」`;
    announceDropGuidance(guidance);
  }
  document.addEventListener('dragenter', event => {
    if (!importable(event.dataTransfer)) return;
    dragDepth++;
    showDropIntent(event);
  });
  document.addEventListener('dragover', event => {
    if (!importable(event.dataTransfer)) return;
    showDropIntent(event);
  });
  document.addEventListener('dragleave', () => {
    if (dragDepth > 0 && --dragDepth === 0) clearDrop();
  });
  document.addEventListener('drop', event => {
    const lastNotice = dropNotice;
    clearDrop();
    if (!importable(event.dataTransfer)) return;
    event.preventDefault();
    const { destination, guidance } = dropIntent(event);
    if (!destination) {
      if (guidance && guidance !== lastNotice) notify(guidance);
      return;
    }
    const dropped = readDrop(event.dataTransfer);
    if (!dropped.files.length && !dropped.imageURL.length && !dropped.link) {
      if (dropped.unsupportedVideo) notify(videoDropHelp);
      else if (dropped.unsupportedImage) notify(`这个来源只提供了图片地址。${imageDropHelp}`);
      else if (event.dataTransfer.types.includes('Files')) notify('没有收到可导入的原件。请从资源管理器拖入已保存的文件。');
      return;
    }
    const { id, collectionId } = destination;
    void intake(() => dropItems(id, collectionId, dropped), id,
      { direct: true, collectionId, files: dropped.files });
  });
  window.addEventListener('blur', clearDrop);
  bridge.onNativeFileDrop?.(event => {
    if (event.phase === 'leave') {
      clearDrop();
      if (event.tooMany) notify('每次最多拖入 10,000 项，请分批导入。');
      return;
    }
    const hovered = document.elementFromPoint(event.x / devicePixelRatio, event.y / devicePixelRatio);
    const { row, destination, guidance } = dropIntent({ target: hovered || document.body });
    if (event.phase === 'hover') {
      setDropRow(row ?? null);
      dropOverlay.hidden = !destination || !!row;
      if (!dropOverlay.hidden) dropLabel.textContent = `释放后导入到「${destination.name}」`;
      announceDropGuidance(guidance);
      return;
    }
    const lastNotice = dropNotice;
    clearDrop();
    if (!destination) {
      if (guidance && guidance !== lastNotice) notify(guidance);
      return;
    }
    const { id, collectionId } = destination;
    void intake(() => bridge.importNativeFiles(id, collectionId, event.token), id,
      { direct: true, collectionId });
  });

  return { create, open, updateQueue, previewItems };
};
