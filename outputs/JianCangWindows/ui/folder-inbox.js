'use strict';

(() => {
  const statusText = { paused: '已暂停', checking: '正在检查', watching: '监控中', error: '检查未完成' };
  const counts = new Intl.NumberFormat('zh-CN');
  const times = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text) item.textContent = text;
    return item;
  }

  function button(text, style, action) {
    const item = node('button', style, text);
    item.type = 'button';
    item.addEventListener('click', action);
    return item;
  }

  function modal(title, id, style) {
    const dialog = node('dialog', style);
    const heading = node('h2', '', title);
    heading.id = `${id}-title`;
    dialog.id = id;
    dialog.setAttribute('aria-labelledby', heading.id);
    const close = button('×', 'icon-button folder-inbox-close', () => dialog.close());
    close.setAttribute('aria-label', '关闭');
    const header = node('header', 'dialog-head');
    header.append(heading, close);
    dialog.append(header);
    document.body.append(dialog);
    return dialog;
  }

  function field(title, input) {
    const label = node('label', 'folder-inbox-field', title);
    label.append(input);
    return label;
  }

  function checkbox(title) {
    const input = node('input');
    input.type = 'checkbox';
    const label = node('label', 'folder-inbox-check');
    label.append(input, document.createTextNode(title));
    return { input, label };
  }

  function targetPaths(collections) {
    const byId = new Map(collections.map(item => [item.id, item]));
    return collections.map(item => {
      const visited = new Set();
      const parts = [];
      for (let entry = item; entry && !visited.has(entry.id); entry = byId.get(entry.parentId)) {
        visited.add(entry.id);
        parts.unshift(entry.name);
      }
      return [item.id, parts.join(' / ')];
    }).sort((left, right) => left[1].localeCompare(right[1], 'zh-CN', { numeric: true }));
  }

  function checked(result) {
    if (result?.ok === false) throw new Error(result.message || '文件夹监控操作未完成。');
    return result;
  }

  window.createJianCangFolderInbox = function createJianCangFolderInbox({ bridge, getLibraries, getCollections, notify }) {
    const dialog = modal('文件夹监控', 'folder-inbox-dialog', 'folder-inbox-dialog');
    const removeDialog = modal('移除监控', 'folder-inbox-remove-dialog', 'folder-inbox-remove-dialog');
    const toolbar = node('div', 'folder-inbox-toolbar');
    const hint = node('p', '', '见藏打开时，新文件会自动进入目标本地库或已开启双向同步的见藏同步库。');
    const add = button('＋ 添加监控', 'primary-button', () => showSetup(true));
    add.id = 'folder-inbox-add';
    toolbar.append(hint, add);

    const form = node('form', 'folder-inbox-form');
    form.hidden = true;
    const library = node('select');
    library.id = 'folder-inbox-target';
    const collection = node('select');
    collection.id = 'folder-inbox-collection';
    const inputRow = node('div', 'folder-inbox-inputs');
    inputRow.append(field('目标素材库', library), field('目标集合', collection));
    const recursive = checkbox('包括子文件夹');
    const includeExisting = checkbox('同时导入已有文件');
    const choices = node('div', 'folder-inbox-choices');
    choices.append(recursive.label, includeExisting.label);
    const formActions = node('div', 'folder-inbox-actions');
    const cancel = button('取消', 'outline-button', () => showSetup(false));
    const selectSource = node('button', 'primary-button', '选择文件夹并启用');
    selectSource.type = 'submit';
    selectSource.id = 'folder-inbox-select-source';
    formActions.append(cancel, selectSource);
    form.append(inputRow, choices, formActions);
    const error = node('p', 'folder-inbox-alert');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const scroll = node('section', 'folder-inbox-scroll');
    const empty = node('p', 'folder-inbox-empty', '添加一个文件夹开始自动导入。');
    scroll.append(empty);
    const removeBody = node('div', 'folder-inbox-remove-body');
    removeDialog.append(removeBody);
    dialog.append(toolbar, form, error, scroll);

    let entries = [];
    let adding = false;
    let generation = 0;
    let refreshTimer;
    let libraryOptions = '';
    let collectionOptions = '';
    const inFlight = new Set();

    function problem(message) {
      error.textContent = message || '';
      error.hidden = !message;
    }

    function loadCollections() {
      const current = collection.value;
      const rows = targetPaths(getCollections(library.value) ?? []);
      const signature = JSON.stringify(rows);
      if (signature === collectionOptions) return;
      collectionOptions = signature;
      collection.replaceChildren(new Option('无集合', ''), ...rows.map(([id, label]) => new Option(label, id)));
      if (rows.some(entry => entry[0] === current)) collection.value = current;
    }

    function loadLibraries() {
      const choices = getLibraries();
      const current = library.value;
      const signature = JSON.stringify(choices.map(item => [item.name, item.id, item.kind]));
      if (signature !== libraryOptions) {
        libraryOptions = signature;
        library.replaceChildren(...choices.map(item =>
          new Option(item.kind === 'jiancang' ? `${item.name}（iCloud 同步库）` : item.name, item.id)));
        if (choices.some(item => item.id === current)) library.value = current;
      }
      selectSource.disabled = adding || !choices.length;
      add.disabled = adding || !choices.length;
      if (!choices.length) empty.textContent = '请打开本地素材库，或为见藏同步库开启双向同步。';
      else empty.textContent = '添加一个文件夹开始自动导入。';
      loadCollections();
    }

    function showSetup(visible) {
      if (adding) return;
      problem('');
      form.hidden = !visible;
      add.hidden = visible;
      if (visible) {
        loadLibraries();
        recursive.input.checked = false;
        includeExisting.input.checked = false;
        library.focus();
      } else add.focus();
    }

    function updateRows(next) {
      entries = next;
      const focused = document.activeElement?.dataset.folderInboxAction;
      const libraries = new Map(getLibraries().map(item => [item.id, item.name]));
      const rows = entries.map(item => {
        const row = node('article', 'folder-inbox-row');
        row.dataset.watchId = item.id;
        const heading = node('div', 'folder-inbox-row-title');
        const name = node('strong', '', item.sourcePath);
        name.title = item.sourcePath;
        const status = node('span', `folder-inbox-status ${item.status}`, statusText[item.status] || '监控中');
        heading.append(name, status);
        const collections = new Map(targetPaths(getCollections(item.targetId) ?? []));
        const target = libraries.get(item.targetId) || '素材库暂不可用';
        const destination = node('p', 'folder-inbox-target-line', `${target}${item.collectionId ? ` / ${collections.get(item.collectionId) || '集合暂不可用'}` : ''}${item.recursive ? ' · 包括子文件夹' : ''}`);
        const waiting = item.waiting ? ` · ${counts.format(item.waiting)} 项待稳定` : '';
        const last = item.lastScan ? ` · 最近检查 ${times.format(item.lastScan)}` : '';
        const metrics = node('p', 'folder-inbox-metrics', `已加入队列 ${counts.format(item.queued)} 项${waiting}${last}`);
        const actions = node('div', 'folder-inbox-actions');
        const scan = button('立即检查', 'outline-button', () => void update(item.id, () => bridge.folderInboxScan(item.id)));
        const toggle = button(item.paused ? '继续监控' : '暂停', 'outline-button', () => void update(item.id, () => bridge.folderInboxPause(item.id, !item.paused)));
        const remove = button('移除…', 'outline-button', () => confirmRemove(item));
        scan.dataset.folderInboxAction = `${item.id}:scan`;
        toggle.dataset.folderInboxAction = `${item.id}:pause`;
        remove.dataset.folderInboxAction = `${item.id}:remove`;
        scan.disabled = item.paused || item.status === 'checking' || inFlight.has(item.id);
        toggle.disabled = remove.disabled = inFlight.has(item.id);
        actions.append(scan, toggle, remove);
        row.append(heading, destination, metrics);
        if (item.error) row.append(node('p', 'folder-inbox-row-error', item.error));
        row.append(actions);
        return row;
      });
      scroll.replaceChildren(...(rows.length ? rows : [empty]));
      if (focused) [...scroll.querySelectorAll('button')].find(item => item.dataset.folderInboxAction === focused)?.focus({ preventScroll: true });
    }

    async function refresh() {
      if (!dialog.open) return;
      const request = ++generation;
      loadLibraries();
      try {
        const result = checked(await bridge.folderInboxList());
        const next = Array.isArray(result) ? result : result?.watches;
        if (request === generation && dialog.open && Array.isArray(next)) updateRows(next);
      } catch (failure) { if (request === generation) problem(failure.message); }
    }

    async function update(id, operation) {
      if (inFlight.has(id)) return false;
      inFlight.add(id);
      problem('');
      try { checked(await operation()); return true; }
      catch (failure) { problem(failure.message); return false; }
      finally { inFlight.delete(id); void refresh(); }
    }

    function confirmRemove(item) {
      const description = node('p', '', '移除后将停止自动导入。源文件和已经导入的素材都会保留。');
      const source = node('p', 'folder-inbox-remove-path', item.sourcePath);
      const actions = node('div', 'folder-inbox-actions');
      const close = button('取消', 'outline-button', () => removeDialog.close());
      const confirm = button('确认移除监控', 'primary-button', async () => {
        confirm.disabled = true;
        const removed = await update(item.id, () => bridge.folderInboxRemove(item.id));
        removeDialog.close();
        if (removed) notify('已移除监控。');
      });
      actions.append(close, confirm);
      removeBody.replaceChildren(description, source, actions);
      removeDialog.showModal();
    }

    library.addEventListener('change', loadCollections);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (adding || !library.value) return;
      adding = true;
      selectSource.disabled = cancel.disabled = true;
      problem('');
      try {
        const result = checked(await bridge.folderInboxAdd({
          targetId: library.value, collectionId: collection.value || null,
          recursive: recursive.input.checked, includeExisting: includeExisting.input.checked,
        }));
        if (result?.cancelled || result?.canceled) return;
        adding = false;
        showSetup(false);
        notify('监控已启用。');
      } catch (failure) { problem(failure.message); }
      finally { adding = false; cancel.disabled = false; void refresh(); }
    });
    dialog.addEventListener('close', () => {
      clearTimeout(refreshTimer);
      generation++;
    });
    bridge.onFolderInboxChange?.(() => {
      if (!dialog.open) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refresh(), 140);
    });

    return {
      async open() {
        if (!dialog.open) dialog.showModal();
        problem('');
        await refresh();
      },
      refresh,
    };
  };
})();
