'use strict';

(() => {
  const shapes = {
    play: 'm9 5 11 7-11 7z',
    pause: 'M9 5v14m6-14v14',
    volume: 'M3 9h4l5-4v14l-5-4H3zM15 9a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10',
    muted: 'M3 9h4l5-4v14l-5-4H3zM16 9l5 6m0-6-5 6',
    repeat: 'M18 3l3 3-3 3m3-3H7a4 4 0 0 0-4 4m3 11-3-3 3-3m-3 3h14a4 4 0 0 0 4-4',
    notes: 'M4 5h16v11h-7l-4 3v-3H4zM8 9h8m-8 3h5',
    frame: 'M8 5H4v4m12-4h4v4M4 15v4h4m12-4v4h-4M9 9h6v6H9z',
    chevron: 'm6 9 6 6 6-6',
    fullscreen: 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5',
    exitFullscreen: 'M4 9h5V4m6 0v5h5M9 20v-5H4m16 0h-5v5',
    edit: 'm14 6 4 4M6 18l1-5 9-9 4 4-9 9-5 1z',
    remove: 'M5 7h14m-10 0V4h6v3m-8 0 1 13h8l1-13m-6 4v5m2-5v5',
    close: 'm6 6 12 12m0-12L6 18',
  };
  const volumeKey = 'jiancang.media.volume.v1';
  let preferredVolume = readVolume();
  const positionsByKey = new Map();
  const syncedNotesByResource = new Map();
  const noteLimit = 500;

  function readVolume() {
    try {
      const value = JSON.parse(localStorage.getItem(volumeKey));
      if (Number.isFinite(value?.volume) && value.volume >= 0 && value.volume <= 1 && typeof value.muted === 'boolean') {
        return { volume: value.volume, muted: value.muted };
      }
    } catch {}
    return { volume: 1, muted: false };
  }

  function readSetting(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      if (Array.isArray(value)) return value;
    } catch {}
    return [];
  }

  function readPositions(storageKey) {
    if (!positionsByKey.has(storageKey)) {
      positionsByKey.set(storageKey, new Map(readSetting(storageKey).filter(entry => Array.isArray(entry) &&
        typeof entry[0] === 'string' && Number.isFinite(entry[1]) && entry[1] > 0).slice(-512)));
    }
    return positionsByKey.get(storageKey);
  }

  function storePosition(storageKey, key, seconds) {
    const positions = readPositions(storageKey);
    if (positions.get(key) === seconds || (!seconds && !positions.has(key))) return;
    positions.delete(key);
    if (seconds > 0) positions.set(key, seconds);
    if (positions.size > 512) positions.delete(positions.keys().next().value);
    try { localStorage.setItem(storageKey, JSON.stringify([...positions])); } catch {}
  }

  function makeElement(tag, className) {
    const element = document.createElement(tag);
    element.className = className;
    return element;
  }

  function setIcon(button, name, label) {
    button.setAttribute('aria-label', label);
    button.title = label;
    if (button.dataset.symbol === name) return;
    button.dataset.symbol = name;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', shapes[name]);
    svg.append(path);
    button.replaceChildren(svg);
  }

  function makeButton(className) {
    const button = makeElement('button', `desktop-video-button ${className}`);
    button.type = 'button';
    return button;
  }

  function makeRange(className, label, maximum) {
    const input = makeElement('input', `desktop-video-range ${className}`);
    input.type = 'range';
    input.min = '0';
    input.max = maximum;
    input.step = '0.01';
    input.value = '0';
    input.setAttribute('aria-label', label);
    return input;
  }

  function timestamp(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor(whole / 60) % 60;
    const tail = `${String(minutes).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
    return hours ? `${hours}:${tail}` : tail;
  }

  function noteTimestamp(seconds) {
    const centiseconds = Math.floor(Math.max(0, seconds) * 100);
    return `${timestamp(centiseconds / 100)}.${String(centiseconds % 100).padStart(2, '0')}`;
  }

  function makeTextButton(text, className) {
    const button = makeElement('button', className);
    button.type = 'button';
    button.textContent = text;
    return button;
  }

  const notesKey = resourceKey => `jiancang.video.notes.v1.${resourceKey}`;
  const noteID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

  function validNote(note) {
    return Number.isFinite(note?.seconds) && note.seconds >= 0 && typeof note.text === 'string' &&
      note.text.trim().length > 0 && note.text.length <= noteLimit;
  }

  function readTimestampNotes(resourceKey) {
    return readSetting(notesKey(resourceKey)).filter(note => typeof note?.id === 'string' && validNote(note))
      .map(({ id, seconds, text }) => ({ id, seconds, text }));
  }

  function decodeSharedNote(record) {
    if (!record?.payload) return null;
    try {
      const note = JSON.parse(record.payload);
      if (validNote(note)) return { id: record.id, seconds: note.seconds, text: note.text,
        token: record.token, conflicted: record.conflicted, shared: true };
    } catch { /* A record from another client can be left untouched. */ }
    return null;
  }

  function mergeTimestampNotes(local, shared) {
    return [...local.filter(note => !shared.has(note.id.toLowerCase())), ...Array.from(shared.values(), decodeSharedNote).filter(Boolean)];
  }

  function createTimestampNotes({ resourceKey, trigger, signal, currentTime, pause, jump, saveNotes, noteSync }) {
    const key = notesKey(resourceKey);
    const draftKey = `${key}.sync-draft`;
    const previous = syncedNotesByResource.get(resourceKey);
    const shared = noteSync && previous && previous.scope === noteSync.scope ? previous.records : new Map();
    syncedNotesByResource.delete(resourceKey);
    if (noteSync) {
      syncedNotesByResource.set(resourceKey, { scope: noteSync.scope, records: shared });
      if (syncedNotesByResource.size > 64) syncedNotesByResource.delete(syncedNotesByResource.keys().next().value);
    }
    let localNotes = readTimestampNotes(resourceKey);
    let notes = mergeTimestampNotes(localNotes, shared);
    let noteTime = 0;
    let editing = null;
    let confirming = null;
    let renderedConfirm;
    let renderedActions = new Map();
    let rows;
    let savingNotes = false;
    let syncAction = '';
    let sharedLoaded = false;
    let failedDraft;

    const panel = makeElement('section', 'desktop-video-notes');
    panel.id = 'desktop-video-timestamp-notes';
    panel.hidden = true;
    panel.setAttribute('aria-label', '时间点备注');
    trigger.setAttribute('aria-controls', panel.id);
    trigger.setAttribute('aria-expanded', 'false');
    const header = makeElement('header', 'desktop-video-notes-header');
    const title = makeElement('h3', 'desktop-video-notes-title');
    title.textContent = '时间点备注';
    const close = makeButton('desktop-video-notes-close');
    setIcon(close, 'close', '关闭备注');
    const markerButtons = makeElement('div', 'desktop-video-note-exports');
    const formats = ['csv', 'srt'];
    const exports = formats.map(format => {
      const button = makeTextButton(format.toUpperCase(), 'desktop-video-note-secondary');
      button.title = `导出备注为 ${format.toUpperCase()}`;
      button.setAttribute('aria-label', button.title);
      markerButtons.append(button);
      return button;
    });
    header.append(title, markerButtons, close);
    const syncBar = makeElement('div', 'desktop-video-note-sync');
    const syncScope = makeElement('span', 'desktop-video-note-scope');
    const refresh = makeTextButton('刷新备注', 'desktop-video-note-secondary');
    const migrate = makeTextButton('同步本机备注', 'desktop-video-note-secondary');
    syncBar.append(syncScope, refresh, migrate);
    const list = makeElement('ul', 'desktop-video-notes-list');
    list.setAttribute('aria-label', '已有备注');
    const editor = makeElement('form', 'desktop-video-notes-editor');
    const time = makeElement('span', 'desktop-video-note-time');
    const label = makeElement('label', 'desktop-video-note-label');
    const input = makeElement('textarea', 'desktop-video-note-input');
    input.maxLength = noteLimit;
    input.rows = 2;
    input.placeholder = '输入备注';
    input.setAttribute('aria-label', '备注内容');
    label.append(time, input);
    const footer = makeElement('div', 'desktop-video-note-footer');
    const status = makeElement('span', 'desktop-video-note-status');
    status.setAttribute('role', 'status');
    const reset = makeTextButton('取消编辑', 'desktop-video-note-secondary');
    reset.hidden = true;
    const reselect = makeTextButton('保留草稿并继续', 'desktop-video-note-secondary');
    reselect.hidden = true;
    const save = makeTextButton('保存备注', 'desktop-video-note-primary');
    save.type = 'submit';
    save.disabled = true;
    footer.append(status, reselect, reset, save);
    editor.append(label, footer);
    panel.append(header);
    if (noteSync) { panel.classList.add('has-note-sync'); panel.append(syncBar); }
    panel.append(list, editor);

    function listen(element, event, callback) { element.addEventListener(event, callback, { signal }); }

    function updateExports() {
      markerButtons.hidden = typeof saveNotes !== 'function' || !notes.length;
      for (const button of exports) button.disabled = savingNotes;
    }

    const noteIdForSync = note => {
      const id = note.id.toLowerCase();
      return noteID.test(id) ? id : null;
    };
    const canSync = () => noteSync?.canWrite() === true;
    const localForSync = () => localNotes.filter(note => !shared.has(noteIdForSync(note)));

    function currentSyncRecord() {
      const target = editing?.shared ? editing : failedDraft;
      const record = target && shared.get(target.id);
      return record && record.token !== target.token ? record : null;
    }

    function updateEditor() {
      const busy = !!syncAction;
      const text = input.value.trim();
      const updated = currentSyncRecord();
      input.disabled = busy;
      save.disabled = busy || !!updated || !text || text.length > noteLimit ||
        (!!editing?.shared || !!failedDraft) && !canSync();
      reset.disabled = busy;
      reset.hidden = !editing && !failedDraft;
      reset.textContent = editing ? '取消编辑' : '取消草稿';
      reselect.hidden = !updated || !canSync();
      reselect.disabled = busy;
      reselect.textContent = updated?.payload === null ? '改存为新备注' : '保留草稿并继续';
    }

    function updateActions() {
      updateExports();
      updateEditor();
      if (!noteSync) return;
      const writable = canSync();
      syncScope.textContent = `${noteSync.label}${writable ? '' : ' · 只读'}`;
      syncScope.title = writable ? noteSync.label : '当前可查看共享备注，新备注保存在本机。';
      refresh.disabled = !!syncAction;
      migrate.hidden = !localForSync().length;
      migrate.disabled = !!syncAction || !writable || !sharedLoaded;
      migrate.title = writable ? '将这段视频的本机备注写入同一同步库。' : '开启 Windows 写入后可以同步本机备注。';
    }

    function setNotes() {
      notes = mergeTimestampNotes(localNotes, shared);
      updateActions();
    }

    function storeShared(record) {
      if (typeof record?.id !== 'string' || !noteID.test(record.id) || typeof record.token !== 'string' ||
          (record.payload !== null && typeof record.payload !== 'string')) return;
      const previous = shared.get(record.id);
      if (previous && (previous.revision > record.revision ||
          previous.revision === record.revision && previous.token > record.token)) return;
      shared.set(record.id, record);
    }

    function removeSharedLocalCopies() {
      const remaining = localNotes.filter(note => {
        const record = shared.get(noteIdForSync(note));
        if (record?.payload === null) return false;
        const remote = decodeSharedNote(record);
        return !remote || remote.seconds !== note.seconds || remote.text !== note.text;
      });
      if (remaining.length !== localNotes.length) commit(remaining);
    }

    async function syncTask(message, action) {
      if (!noteSync || syncAction || signal.aborted) return;
      syncAction = message;
      status.textContent = message;
      updateActions();
      renderList();
      try { await action(); }
      catch (error) { if (!signal.aborted) status.textContent = error?.message || '视频备注同步失败，请重试。'; }
      finally {
        syncAction = '';
        if (!signal.aborted) { setNotes(); renderList(); }
      }
    }

    function refreshShared() {
      return syncTask('正在读取同步备注…', async () => {
        sharedLoaded = false;
        const records = await noteSync.list();
        if (!Array.isArray(records)) throw new Error('无法读取同步库的视频备注。');
        if (signal.aborted) return;
        for (const record of records) storeShared(record);
        sharedLoaded = true;
        status.textContent = currentSyncRecord() ? '其他设备已修改这条备注，当前草稿已保留。' :
          failedDraft ? '未保存的备注草稿已保留。' : '';
        removeSharedLocalCopies();
      });
    }

    async function writeShared(id, payload, expected) {
      if (!canSync()) throw new Error('请在这份同步库中开启 Windows 写入。');
      const record = await noteSync.write(id, payload, expected);
      if (record?.id !== id || typeof record.token !== 'string' || record.payload !== payload) {
        throw new Error('未确认同步写入，请刷新备注后重试。');
      }
      storeShared(record);
    }

    function migrateLocalNotes() {
      if (!canSync() || !sharedLoaded) return;
      return syncTask('正在同步本机备注…', async () => {
        let complete = 0;
        for (const local of localForSync()) {
          if (signal.aborted) return;
          const id = noteIdForSync(local) ?? crypto.randomUUID();
          const note = { id, seconds: local.seconds, text: local.text };
          if (local.id !== id && !commit(localNotes.map(saved => saved === local ? note : saved))) return;
          try { await writeShared(id, JSON.stringify({ seconds: note.seconds, text: note.text }), null); }
          catch (error) { throw new Error(`${complete ? `已同步 ${complete} 条。` : ''}${error?.message || '同步未完成。'}`); }
          complete++;
          removeSharedLocalCopies();
        }
        status.textContent = `已同步 ${complete} 条本机备注。`;
      });
    }

    function storedDraft() {
      if (!noteSync) return null;
      try {
        const value = JSON.parse(localStorage.getItem(draftKey));
        if (value?.scope === noteSync.scope && noteID.test(value.id) && validNote(value) &&
            (value.token === null || typeof value.token === 'string')) return value;
      } catch { /* Unreadable local drafts are left in storage. */ }
      return null;
    }

    function rememberDraft(note, token) {
      failedDraft = { ...note, token, scope: noteSync.scope };
      try { localStorage.setItem(draftKey, JSON.stringify(failedDraft)); } catch { /* Keep the live editor contents. */ }
    }

    function forgetDraft() {
      const saved = failedDraft && storedDraft();
      if (saved && saved.id === failedDraft.id && saved.text === failedDraft.text &&
          saved.seconds === failedDraft.seconds && saved.token === failedDraft.token) {
        try { localStorage.removeItem(draftKey); } catch { /* The live editor can still reset. */ }
      }
      failedDraft = null;
    }

    exports.forEach((button, index) => listen(button, 'click', async () => {
      if (!notes.length || savingNotes) return;
      savingNotes = true;
      updateExports();
      status.textContent = '';
      try {
        const result = await saveNotes(formats[index], notes.map(({ seconds, text }) => ({ seconds, text })));
        if (!signal.aborted && !result?.cancelled) {
          status.textContent = result?.message || (result?.ok ? '已导出视频备注。' : '无法导出视频备注，请重试。');
        }
      } catch {
        if (!signal.aborted) status.textContent = '无法导出视频备注，请重试。';
      } finally { savingNotes = false; updateExports(); }
    }));

    function setTime(seconds) {
      noteTime = Math.max(0, seconds || 0);
      const text = `${editing ? '编辑' : '添加'} ${noteTimestamp(noteTime)}`;
      if (time.textContent !== text) time.textContent = text;
    }

    function resetEditor() {
      editing = null;
      forgetDraft();
      input.value = '';
      status.textContent = '';
      setTime(currentTime());
      updateEditor();
    }

    function commit(next) {
      try { localStorage.setItem(key, JSON.stringify(next)); }
      catch {
        status.textContent = '保存失败，请检查本机存储空间。';
        return false;
      }
      localNotes = next;
      setNotes();
      return true;
    }

    function renderList(focusAfter) {
      rows?.abort();
      rows = new AbortController();
      const rowSignal = AbortSignal.any([signal, rows.signal]);
      const listenRow = (element, callback) => element.addEventListener('click', callback, { signal: rowSignal });
      const fragment = document.createDocumentFragment();
      renderedActions = new Map();
      renderedConfirm = null;
      for (const note of [...notes].sort((a, b) => a.seconds - b.seconds)) {
        const row = makeElement('li', 'desktop-video-note-row');
        const link = makeTextButton(noteTimestamp(note.seconds), 'desktop-video-note-jump');
        link.setAttribute('aria-label', `跳到 ${link.textContent}`);
        listenRow(link, () => { jump(note.seconds); });
        const message = makeElement('div', 'desktop-video-note-content');
        const text = makeElement('p', 'desktop-video-note-text');
        text.textContent = note.text;
        message.append(text);
        if (note.conflicted || noteSync && !note.shared) {
          const origin = makeElement('span', 'desktop-video-note-origin');
          origin.textContent = note.conflicted ? '同步冲突' : '本机';
          if (note.conflicted) origin.title = '这条备注在其他设备同时被修改。';
          message.append(origin);
        }
        row.append(link, message);
        if (confirming?.id === note.id && confirming.shared === note.shared) {
          const prompt = makeElement('div', 'desktop-video-note-confirm');
          const question = makeElement('span', 'desktop-video-note-question');
          question.textContent = note.shared ? '从同步库删除这条备注？' : '删除这条备注？';
          const cancel = makeTextButton('取消', 'desktop-video-note-secondary');
          const remove = makeTextButton('确认删除', 'desktop-video-note-danger');
          remove.disabled = !!syncAction || note.shared && !canSync();
          listenRow(cancel, cancelRemoval);
          listenRow(remove, () => void deleteNote(confirming));
          prompt.append(question, cancel, remove);
          row.append(prompt);
          renderedConfirm = cancel;
        } else {
          const edit = makeButton('desktop-video-note-edit');
          setIcon(edit, 'edit', '编辑备注');
          edit.disabled = !!syncAction || note.shared && !canSync();
          listenRow(edit, () => {
            if (failedDraft) { status.textContent = '请先保存或取消当前草稿。'; return; }
            pause();
            editing = note;
            setTime(note.seconds);
            input.value = note.text;
            status.textContent = '';
            updateEditor();
            input.focus({ preventScroll: true });
          });
          const remove = makeButton('desktop-video-note-remove');
          setIcon(remove, 'remove', '删除备注');
          remove.disabled = edit.disabled;
          listenRow(remove, () => {
            confirming = note;
            renderList();
            renderedConfirm?.focus({ preventScroll: true });
          });
          const actions = makeElement('div', 'desktop-video-note-actions');
          actions.append(edit, remove);
          row.append(actions);
          renderedActions.set(note.id, remove);
        }
        fragment.append(row);
      }
      if (!notes.length) {
        const empty = makeElement('li', 'desktop-video-notes-empty');
        empty.textContent = '此视频还没有备注';
        fragment.append(empty);
      }
      list.replaceChildren(fragment);
      renderedActions.get(focusAfter)?.focus({ preventScroll: true });
    }

    function cancelRemoval() {
      const id = confirming?.id;
      confirming = null;
      renderList(id);
    }

    function deleteNote(note) {
      if (!note || syncAction) return;
      function finish() {
        confirming = null;
        if (editing?.id === note.id || failedDraft?.id === note.id) resetEditor();
        renderList();
        input.focus({ preventScroll: true });
      }
      if (!note.shared) {
        if (commit(localNotes.filter(item => item.id !== note.id))) finish();
        return;
      }
      return syncTask('正在删除同步备注…', async () => {
        await writeShared(note.id, null, note.token);
        if (signal.aborted) return;
        removeSharedLocalCopies();
        finish();
        status.textContent = '已从同步库删除备注。';
      });
    }

    function closePanel() {
      confirming = null;
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus({ preventScroll: true });
    }

    function refreshTime() {
      if (!panel.hidden && !editing && !input.value) setTime(currentTime());
    }

    listen(trigger, 'click', () => {
      if (!panel.hidden) { closePanel(); return; }
      pause();
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      refreshTime();
      renderList();
      input.focus({ preventScroll: true });
      void refreshShared();
    });
    listen(close, 'click', closePanel);
    listen(input, 'input', () => {
      status.textContent = '';
      if (failedDraft) rememberDraft({ ...failedDraft, text: input.value.trim() }, failedDraft.token);
      refreshTime();
      updateEditor();
    });
    listen(refresh, 'click', () => void refreshShared());
    listen(migrate, 'click', () => void migrateLocalNotes());
    listen(reset, 'click', () => { resetEditor(); input.focus({ preventScroll: true }); });
    listen(reselect, 'click', () => {
      const current = currentSyncRecord();
      if (!current || !canSync() || syncAction) return;
      if (current.payload === null) {
        forgetDraft();
        editing = null;
        rememberDraft({ id: crypto.randomUUID(), seconds: noteTime, text: input.value.trim() }, null);
        status.textContent = '草稿将保存为一条新备注。';
      } else {
        const remote = decodeSharedNote(current);
        if (!remote) { status.textContent = '无法读取当前版本的备注。'; return; }
        editing = remote;
        rememberDraft({ id: remote.id, seconds: noteTime, text: input.value.trim() }, remote.token);
        status.textContent = '可以将草稿保存到当前同步版本。';
      }
      setTime(noteTime);
      updateEditor();
      input.focus({ preventScroll: true });
    });
    listen(editor, 'submit', event => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || text.length > noteLimit || syncAction || currentSyncRecord()) return;
      const note = { id: editing?.id ?? failedDraft?.id ?? crypto.randomUUID(), seconds: noteTime, text };
      function finish() {
        resetEditor();
        renderList();
        list.scrollTop = list.scrollHeight;
        input.focus({ preventScroll: true });
      }
      if (editing?.shared || failedDraft || !editing && canSync()) {
        const token = editing?.token ?? failedDraft?.token ?? null;
        rememberDraft(note, token);
        void syncTask('正在保存同步备注…', async () => {
          await writeShared(note.id, JSON.stringify({ seconds: note.seconds, text }), token);
          if (signal.aborted) { forgetDraft(); return; }
          setNotes();
          finish();
          status.textContent = '已保存到同步库。';
        });
        return;
      }
      if (editing && !localNotes.some(item => item.id === editing.id)) {
        status.textContent = '这条本机备注已变化，请重新打开后再保存。';
        return;
      }
      const next = editing ? localNotes.map(item => item.id === editing.id ? note : item) : [...localNotes, note];
      if (commit(next)) finish();
    });
    listen(panel, 'keydown', event => {
      event.stopPropagation();
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (confirming) cancelRemoval();
      else closePanel();
    });
    failedDraft = storedDraft();
    if (failedDraft) {
      if (failedDraft.token !== null) editing = { ...failedDraft, shared: true };
      input.value = failedDraft.text;
      setTime(failedDraft.seconds);
      status.textContent = '已恢复未完成的备注草稿。';
    }
    updateActions();
    return { panel, refreshTime };
  }

  function createRateMenu(media, signal) {
    const button = makeButton('desktop-video-rate');
    setIcon(button, 'chevron', '播放倍速');
    const label = makeElement('span', 'desktop-video-rate-value');
    button.prepend(label);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const menu = makeElement('div', 'desktop-video-rate-menu');
    menu.popover = 'auto';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '播放倍速');
    button.popoverTargetElement = menu;
    const options = [0.5, 0.75, 1, 1.25, 1.5, 2].map(value => {
      const option = makeTextButton(`${value}×`, 'desktop-video-rate-option');
      option.setAttribute('role', 'menuitemradio');
      option.dataset.rate = value;
      option.addEventListener('click', () => {
        media.playbackRate = value;
        sync();
        dismiss();
      }, { signal });
      menu.append(option);
      return option;
    });

    function sync() {
      label.textContent = `${media.playbackRate}×`;
      button.setAttribute('aria-label', `播放倍速 ${label.textContent}`);
      for (const option of options) option.setAttribute('aria-checked', String(Number(option.dataset.rate) === media.playbackRate));
    }

    function position() {
      const rect = button.getBoundingClientRect();
      menu.style.setProperty('--rate-menu-right', `${Math.max(6, innerWidth - rect.right)}px`);
      menu.style.setProperty('--rate-menu-bottom', `${Math.max(6, innerHeight - rect.top + 5)}px`);
    }

    function dismiss() {
      if (!menu.matches(':popover-open')) return false;
      menu.hidePopover();
      button.focus({ preventScroll: true });
      return true;
    }

    menu.addEventListener('beforetoggle', event => {
      const open = event.newState === 'open';
      button.setAttribute('aria-expanded', String(open));
      if (open) position();
    }, { signal });
    menu.addEventListener('toggle', event => {
      if (event.newState === 'open') {
        const selected = options.find(option => option.getAttribute('aria-checked') === 'true') || options[0];
        selected.focus({ preventScroll: true });
      }
    }, { signal });
    menu.addEventListener('keydown', event => {
      const active = options.indexOf(document.activeElement);
      if (active >= 0 && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        event.stopPropagation();
        options[active].click();
        return;
      }
      const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
      const next = step ? options[(active + step + options.length) % options.length]
        : event.key === 'Home' ? options[0] : event.key === 'End' ? options.at(-1) : null;
      if (next || ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        next?.focus();
      }
    }, { signal });
    button.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown' || menu.matches(':popover-open')) return;
      event.preventDefault();
      menu.showPopover();
    }, { signal });
    window.addEventListener('resize', () => { if (menu.matches(':popover-open')) position(); }, { signal });
    media.addEventListener('ratechange', sync, { signal });
    sync();
    return { button, menu, dismiss };
  }

  function createMediaPlayer(media, { poster, autoplay = true, resourceKey, saveFrame, saveNotes, noteSync, audio } = {}) {
    const controller = new AbortController();
    const { signal } = controller;
    const element = makeElement('div', 'desktop-video-player');
    const picture = makeElement('div', 'desktop-video-picture');
    const controls = makeElement('div', 'desktop-video-controls');
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', audio ? '音频播放控件' : '视频播放控件');
    const playback = makeButton('desktop-video-play');
    const times = makeElement('span', 'desktop-video-times');
    const seek = makeRange('desktop-video-seek', '播放进度', 1);
    const speaker = makeButton('desktop-video-mute');
    const volume = makeRange('desktop-video-volume', '音量', 1);
    const rate = createRateMenu(media, signal);
    const repeat = makeButton('desktop-video-repeat');
    setIcon(repeat, 'repeat', '循环播放');
    repeat.setAttribute('aria-pressed', String(media.loop));
    const notesButton = resourceKey && !audio ? makeButton('desktop-video-notes-trigger') : null;
    const frameButton = typeof saveFrame === 'function' ? makeButton('desktop-video-frame') : null;
    const fullscreenButton = !audio && document.fullscreenEnabled ? makeButton('desktop-video-fullscreen') : null;
    if (notesButton) setIcon(notesButton, 'notes', '时间点备注');
    if (frameButton) setIcon(frameButton, 'frame', '导出当前帧');
    const loading = makeElement('span', 'desktop-video-loading');
    loading.hidden = true;
    loading.setAttribute('role', 'status');
    loading.textContent = '正在缓冲';
    const feedback = makeElement('span', 'desktop-video-feedback');
    feedback.setAttribute('role', 'status');
    feedback.hidden = true;
    const audioTitle = audio && makeElement('h2', 'desktop-audio-title');

    function setName(name) {
      media.setAttribute('aria-label', name);
      if (audioTitle) audioTitle.textContent = audioTitle.title = name;
    }

    media.controls = false;
    media.playsInline = true;
    media.preload = audio ? 'metadata' : 'auto';
    media.volume = preferredVolume.volume;
    media.muted = preferredVolume.muted;
    if (poster) media.poster = poster;
    if (audio) {
      element.classList.add('desktop-audio-player');
      const identity = makeElement('div', 'desktop-audio-identity');
      const mark = makeElement('span', 'desktop-audio-mark');
      if (audio.icon) mark.append(audio.icon);
      mark.setAttribute('aria-hidden', 'true');
      setName(audio.name);
      const format = makeElement('span', 'desktop-audio-format');
      format.textContent = audio.format;
      identity.append(mark, audioTitle, format);
      picture.append(identity);
    }
    picture.append(media, loading, feedback);
    controls.append(playback, times, seek, speaker, volume, rate.button, repeat);
    if (notesButton) controls.append(notesButton);
    if (frameButton) controls.append(frameButton);
    if (fullscreenButton) controls.append(fullscreenButton);
    element.append(picture, controls, rate.menu);

    let playingFrame = 0;
    let seekFrame = 0;
    let pendingSeek;
    let waitingTimer;
    let feedbackTimer;
    let lastTimelineLabel;
    let frameSaving = false;
    let lastStoredAt = 0;
    let metadataLoaded = false;
    let autoplayPending = autoplay;
    let fullscreenPending = false;
    const storageKey = audio ? 'jiancang.audio.positions.v1' : 'jiancang.video.positions.v1';
    const resumeAt = readPositions(storageKey).get(resourceKey) || 0;
    const notes = notesButton && createTimestampNotes({ resourceKey, trigger: notesButton, signal, noteSync,
      currentTime: () => pendingSeek ?? media.currentTime, pause, jump: seekTo,
      saveNotes: typeof saveNotes === 'function' ? (format, notes) => saveNotes(format, notes, duration()) : undefined });
    if (notes) picture.append(notes.panel);

    function listen(target, event, callback) {
      target.addEventListener(event, callback, { signal });
    }

    function duration() {
      return Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
    }

    function syncTimeline() {
      const length = duration();
      const seconds = Math.min(length || Infinity, pendingSeek ?? media.currentTime);
      seek.disabled = !length;
      seek.max = length || 1;
      seek.value = length ? seconds : 0;
      seek.style.setProperty('--range-filled', `${length ? seconds / length * 100 : 0}%`);
      const label = `${timestamp(seconds)} / ${length ? timestamp(length) : '–:––'}`;
      if (label !== lastTimelineLabel) {
        times.textContent = label;
        seek.setAttribute('aria-valuetext', label);
        lastTimelineLabel = label;
      }
      notes?.refreshTime();
      if (notesButton) notesButton.disabled = !length;
      if (frameButton) frameButton.disabled = !canCaptureFrame() || frameSaving;
    }

    function seekTo(seconds) {
      const length = duration();
      if (!length || signal.aborted) return;
      cancelAnimationFrame(seekFrame);
      seekFrame = 0;
      pendingSeek = undefined;
      media.currentTime = Math.min(length, Math.max(0, seconds));
      syncTimeline();
      rememberPosition();
      return true;
    }

    function rememberPosition() {
      const length = duration();
      if (!resourceKey || !metadataLoaded || !length || media.error) return;
      const seconds = pendingSeek ?? media.currentTime;
      if (!Number.isFinite(seconds)) return;
      const remaining = length - seconds;
      const next = media.ended || remaining <= Math.min(0.6, length * 0.08) ? 0 : Math.round(seconds * 20) / 20;
      storePosition(storageKey, resourceKey, next);
    }

    function restorePosition() {
      if (metadataLoaded || media.readyState < 1) return;
      metadataLoaded = true;
      const length = duration();
      if (length && resumeAt > 0 && resumeAt < length - Math.min(0.6, length * 0.08)) {
        media.currentTime = resumeAt;
      }
      syncTimeline();
    }

    function syncPlayback() {
      const playing = !media.paused && !media.ended;
      setIcon(playback, playing ? 'pause' : 'play', playing ? '暂停' : '播放');
    }

    function syncVolume() {
      const silent = media.muted || media.volume === 0;
      setIcon(speaker, silent ? 'muted' : 'volume', silent ? '开启声音' : '静音');
      speaker.setAttribute('aria-pressed', String(silent));
      volume.value = silent ? 0 : media.volume;
      volume.style.setProperty('--range-filled', `${Number(volume.value) * 100}%`);
      volume.setAttribute('aria-valuetext', `${Math.round(Number(volume.value) * 100)}%`);
    }

    function rememberVolume() {
      const { volume, muted } = media;
      if (volume !== preferredVolume.volume || muted !== preferredVolume.muted) {
        preferredVolume = { volume, muted };
        try { localStorage.setItem(volumeKey, JSON.stringify(preferredVolume)); } catch {}
      }
      syncVolume();
    }

    function stopTimelineUpdates() {
      cancelAnimationFrame(playingFrame);
      playingFrame = 0;
    }

    function refreshTimeline() {
      syncTimeline();
      if (media.paused || media.ended || signal.aborted) playingFrame = 0;
      else playingFrame = requestAnimationFrame(refreshTimeline);
    }

    function hideLoading() {
      clearTimeout(waitingTimer);
      loading.hidden = true;
    }

    function showLoadingAfterDelay() {
      hideLoading();
      waitingTimer = setTimeout(() => {
        if (!media.paused && !media.error && media.readyState < 3) loading.hidden = false;
      }, 350);
    }

    async function play() {
      if (signal.aborted || !element.isConnected) return false;
      autoplayPending = false;
      try {
        await media.play();
        return !signal.aborted;
      } catch {
        if (!signal.aborted) { syncPlayback(); hideLoading(); }
        return false;
      }
    }

    function pause() {
      autoplayPending = false;
      media.pause();
      hideLoading();
      rememberPosition();
    }

    function togglePlayback() {
      if (media.paused || media.ended) void play();
      else pause();
    }

    function canCaptureFrame() {
      return media.readyState >= 2 && !media.error && !media.seeking && pendingSeek === undefined &&
        media.videoWidth > 0 && media.videoHeight > 0;
    }

    function showFeedback(message) {
      clearTimeout(feedbackTimer);
      feedback.textContent = message;
      feedback.hidden = !message;
      if (message) feedbackTimer = setTimeout(() => { feedback.hidden = true; }, 4250);
    }

    function syncFullscreen() {
      const active = document.fullscreenElement === element;
      setIcon(fullscreenButton, active ? 'exitFullscreen' : 'fullscreen', active ? '退出全屏（Esc）' : '全屏');
      fullscreenButton.setAttribute('aria-pressed', String(active));
    }

    async function toggleFullscreen() {
      if (fullscreenPending || signal.aborted) return;
      fullscreenPending = true;
      try {
        if (document.fullscreenElement === element) await document.exitFullscreen();
        else await element.requestFullscreen();
      } catch {
        if (!signal.aborted) showFeedback('无法切换全屏，请重试。');
      } finally {
        fullscreenPending = false;
      }
    }

    function dismissOverlay() {
      if (rate.dismiss()) return true;
      if (document.fullscreenElement !== element) return false;
      void toggleFullscreen();
      return true;
    }

    async function exportFrame() {
      if (frameSaving || !canCaptureFrame()) return;
      frameSaving = true;
      syncTimeline();
      showFeedback('');
      try {
        const width = media.videoWidth;
        const height = media.videoHeight;
        const seconds = media.currentTime;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(media, 0, 0);
        const image = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!image) throw new Error('未能生成 PNG。');
        const png = new Uint8Array(await image.arrayBuffer());
        if (signal.aborted) return;
        const result = await saveFrame(png, { width, height, seconds });
        if (signal.aborted || result?.cancelled) return;
        showFeedback(result?.message || (result?.ok ? '已导出当前帧。' : '导出未完成，请重试。'));
      } catch {
        if (!signal.aborted) showFeedback('暂时无法导出当前帧，请重试。');
      } finally {
        frameSaving = false;
        if (!signal.aborted) syncTimeline();
      }
    }

    listen(playback, 'click', togglePlayback);
    listen(media, 'click', togglePlayback);
    listen(seek, 'input', () => {
      pendingSeek = seek.valueAsNumber;
      syncTimeline();
      if (seekFrame) return;
      seekFrame = requestAnimationFrame(() => {
        seekFrame = 0;
        const target = pendingSeek;
        pendingSeek = undefined;
        if (duration()) media.currentTime = target;
      });
    });
    listen(speaker, 'click', () => {
      const silent = media.muted || media.volume === 0;
      if (media.volume === 0) media.volume = 0.75;
      media.muted = !silent;
      rememberVolume();
    });
    listen(volume, 'input', () => {
      media.volume = volume.valueAsNumber;
      media.muted = media.volume === 0;
      rememberVolume();
    });
    listen(repeat, 'click', () => {
      media.loop = !media.loop;
      repeat.setAttribute('aria-pressed', String(media.loop));
    });
    if (frameButton) listen(frameButton, 'click', exportFrame);
    if (fullscreenButton) {
      syncFullscreen();
      listen(fullscreenButton, 'click', toggleFullscreen);
      listen(document, 'fullscreenchange', syncFullscreen);
    }
    listen(element, 'keydown', event => {
      if (event.key === 'Escape' && dismissOverlay()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.code === 'Space' && event.target.closest('button, input, select, textarea')) event.stopPropagation();
    });
    listen(media, 'play', () => { syncPlayback(); showLoadingAfterDelay(); });
    listen(media, 'playing', () => {
      hideLoading();
      if (!playingFrame) playingFrame = requestAnimationFrame(refreshTimeline);
    });
    for (const event of ['pause', 'ended', 'error']) {
      listen(media, event, () => { stopTimelineUpdates(); hideLoading(); syncTimeline(); syncPlayback(); });
    }
    for (const event of ['pause', 'ended']) listen(media, event, rememberPosition);
    listen(media, 'timeupdate', () => {
      const now = performance.now();
      if (now - lastStoredAt < 3500) return;
      lastStoredAt = now;
      rememberPosition();
    });
    listen(media, 'waiting', () => { stopTimelineUpdates(); showLoadingAfterDelay(); });
    function startAutoplay() {
      if (!autoplayPending || (resumeAt && !metadataLoaded)) return;
      autoplayPending = false;
      if (media.paused) void play();
    }
    listen(media, 'loadedmetadata', () => {
      restorePosition();
      startAutoplay();
    });
    for (const event of ['durationchange', 'loadeddata', 'canplay', 'seeking', 'seeked']) listen(media, event, syncTimeline);
    listen(media, 'seeked', rememberPosition);
    listen(window, 'pagehide', rememberPosition);
    listen(media, 'volumechange', rememberVolume);
    syncTimeline();
    syncPlayback();
    syncVolume();
    queueMicrotask(() => {
      if (signal.aborted) return;
      restorePosition();
      startAutoplay();
    });

    function dispose() {
      if (signal.aborted) return;
      rememberPosition();
      if (rate.menu.matches(':popover-open')) rate.menu.hidePopover();
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
      controller.abort();
      stopTimelineUpdates();
      cancelAnimationFrame(seekFrame);
      pause();
      clearTimeout(feedbackTimer);
      media.removeAttribute('src');
      media.load();
    }

    return { element, play, pause, togglePlayback, setName, dismissOverlay,
      seekBy: delta => seekTo((pendingSeek ?? media.currentTime) + delta), dispose };
  }

  window.createJianCangAudioCardPreview = ({ gallery, scroller, enabled }) => {
    let current;
    const removals = new MutationObserver(() => {
      if (current && !gallery.contains(current.card)) stop();
    });

    function stop(card) {
      if (!current || (card && current.card !== card)) return;
      const request = current;
      current = null;
      removals.disconnect();
      clearTimeout(request.delay);
      cancelAnimationFrame(request.frame);
      request.events?.abort();
      request.overlay?.remove();
      request.card.classList.remove('audio-preview-active');
      if (request.media) {
        request.media.pause();
        request.media.removeAttribute('src');
        request.media.load();
      }
    }

    function preview(card, picture, url) {
      stop();
      current = { card, picture, url, playRevision: 0 };
      removals.observe(gallery, { childList: true });
      return current;
    }

    function applySeek(request) {
      const { media, fraction } = request;
      if (fraction === undefined || !media || !Number.isFinite(media.duration) || media.duration <= 0) return;
      request.fraction = undefined;
      media.currentTime = media.duration * fraction;
    }

    function resume(request) {
      const revision = ++request.playRevision;
      void request.media.play().catch(() => {
        if (current === request && request.playRevision === revision) stop(request.card);
      });
    }

    function renderProgress(request) {
      const { picture, media, overlay, played, timeLabel, toggle } = request;
      const waveform = picture.querySelector('img.audio-waveform');
      if (waveform !== request.waveform && waveform?.complete && waveform.naturalWidth) {
        request.waveform = waveform;
        played.width = waveform.naturalWidth;
        played.height = waveform.naturalHeight;
        const context = played.getContext('2d');
        if (context) {
          context.drawImage(waveform, 0, 0);
          context.globalCompositeOperation = 'source-in';
          context.fillStyle = getComputedStyle(picture).getPropertyValue('--accent').trim();
          context.fillRect(0, 0, played.width, played.height);
        }
      }
      const duration = Number.isFinite(media.duration) ? media.duration : 0;
      const elapsed = request.fraction === undefined ? media.currentTime : request.fraction * duration;
      const progress = duration > 0 ? Math.min(1, elapsed / duration) * 100 : 0;
      overlay.style.setProperty('--audio-progress', `${progress.toFixed(2)}%`);
      const detail = duration > 0 ? `${timestamp(elapsed)} / ${timestamp(duration)}` : timestamp(elapsed);
      if (timeLabel.textContent !== detail) timeLabel.textContent = detail;
      const icon = media.paused ? 'play' : 'pause';
      if (toggle.dataset.symbol !== icon) setIcon(toggle, icon, media.paused ? '继续试听' : '暂停试听');
    }

    function start(request) {
      clearTimeout(request.delay);
      const { card, picture, url } = request;
      const media = request.media = new Audio();
      media.volume = preferredVolume.volume;
      media.muted = preferredVolume.muted;
      const overlay = request.overlay = makeElement('span', 'audio-waveform-overlay');
      const played = request.played = makeElement('canvas', 'audio-waveform-played');
      const status = makeElement('span', 'audio-waveform-status');
      const toggle = request.toggle = makeElement('span', 'audio-waveform-toggle');
      const timeLabel = request.timeLabel = makeElement('span', 'audio-waveform-time');
      const playhead = makeElement('span', 'audio-waveform-playhead');
      status.append(toggle, timeLabel);
      overlay.append(played, playhead, makeElement('span', 'audio-waveform-cursor'), status);
      overlay.setAttribute('aria-hidden', 'true');
      picture.append(overlay);
      card.classList.add('audio-preview-active');
      request.events = new AbortController();
      const options = { signal: request.events.signal };
      function tick(now) {
        if (current !== request) return;
        if (!enabled()) { stop(card); return; }
        if (now - (request.lastPaint ?? 0) >= 32) {
          request.lastPaint = now;
          renderProgress(request);
        }
        request.frame = requestAnimationFrame(tick);
      }
      function finish() { if (current === request) stop(card); }
      media.addEventListener('playing', () => {
        renderProgress(request);
        cancelAnimationFrame(request.frame);
        request.frame = requestAnimationFrame(tick);
      }, options);
      media.addEventListener('pause', () => {
        cancelAnimationFrame(request.frame);
        renderProgress(request);
      }, options);
      media.addEventListener('loadedmetadata', () => { applySeek(request); renderProgress(request); }, options);
      for (const event of ['timeupdate', 'durationchange']) media.addEventListener(event, () => renderProgress(request), options);
      media.addEventListener('ended', finish, options);
      media.addEventListener('error', finish, options);
      media.src = url;
      renderProgress(request);
      resume(request);
    }

    function attach(card, picture, url) {
      function isWaveformAction(event) {
        return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && enabled() &&
          picture.contains(event.target) && !event.target.closest('.asset-collection-grip') &&
          picture.classList.contains('audio-waveform-ready');
      }

      function waveformPosition(clientX) {
        const { left, width } = picture.getBoundingClientRect();
        return width ? Math.min(1, Math.max(0, (clientX - left) / width)) : null;
      }

      card.addEventListener('pointerenter', event => {
        if (event.pointerType !== 'mouse' || event.buttons || !enabled()) return;
        const request = preview(card, picture, url);
        request.delay = setTimeout(() => {
          if (current !== request) return;
          if (document.hidden || !gallery.contains(card) || !card.matches(':hover') || !enabled()) { stop(card); return; }
          start(request);
        }, 140);
      });
      card.addEventListener('pointerdown', event => { if (!isWaveformAction(event)) stop(card); });
      card.addEventListener('click', event => {
        if (event.detail !== 1 || !isWaveformAction(event)) return;
        const request = current?.card === card ? current : preview(card, picture, url);
        if (request.media && request.toggle.contains(event.target)) {
          if (request.media.paused) resume(request);
          else { request.playRevision++; request.media.pause(); }
          return;
        }
        const fraction = waveformPosition(event.clientX);
        if (fraction === null) return;
        request.fraction = fraction;
        if (!request.media) start(request);
        else { applySeek(request); renderProgress(request); }
      });
      picture.addEventListener('pointermove', event => {
        const overlay = current?.card === card && current.overlay;
        if (!overlay || event.pointerType !== 'mouse' || event.buttons) return;
        const fraction = waveformPosition(event.clientX);
        if (fraction !== null) overlay.style.setProperty('--audio-cursor', `${(fraction * 100).toFixed(2)}%`);
      });
      picture.addEventListener('pointerleave', () => {
        if (current?.card === card) current.overlay?.style.removeProperty('--audio-cursor');
      });
      for (const event of ['pointerleave', 'pointercancel', 'dragstart']) {
        card.addEventListener(event, () => stop(card));
      }
    }

    scroller.addEventListener('scroll', () => stop(), { passive: true });
    window.addEventListener('blur', () => stop());
    window.addEventListener('pagehide', () => stop());
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    return { attach, stop };
  };
  window.createJianCangVideoPlayer = createMediaPlayer;
  window.createJianCangAudioPlayer = (media, options) => createMediaPlayer(media, { ...options, autoplay: false });
  window.readJianCangVideoNotes = resourceKey => {
    const local = readTimestampNotes(resourceKey);
    const shared = syncedNotesByResource.get(resourceKey)?.records;
    return shared ? mergeTimestampNotes(local, shared) : local;
  };
})();
