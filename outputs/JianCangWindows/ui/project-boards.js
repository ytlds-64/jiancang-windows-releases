'use strict';

(() => {
  const storageKey = 'jiancang.project-boards.v1';
  const maximumBoards = 24;
  const maximumEntries = 80;
  const titleLength = 80;
  const noteLength = 480;
  const opaqueId = /^[a-zA-Z0-9-]{1,128}$/;
  const assetId = /^[a-f0-9]{64}$/;
  const studio = window.jiancangStudioDocuments;
  const fonts = '"Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif';
  const imageUnavailable = '找不到原图或缩略图';
  const paper = '#f3f4f6';
  const ink = '#232a35';
  const quietInk = '#56616e';

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(label, className, action) {
    const node = element('button', className, label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function describe(node, label) {
    node.title = label;
    node.setAttribute('aria-label', label);
    return node;
  }

  function text(value, limit) {
    return typeof value === 'string' ? value.trim().slice(0, limit) : '';
  }

  function normalized(value) { return value.normalize('NFKC').toLocaleLowerCase('zh-CN'); }

  function asEntry(item) {
    const registrationId = item.sourceLibraryId ?? item.registrationId;
    const id = item.sourceAssetId ?? item.id;
    if (!opaqueId.test(registrationId ?? '') || !assetId.test(id ?? '')) return null;
    const libraryId = typeof item.libraryId === 'string' && opaqueId.test(item.libraryId) ? item.libraryId : null;
    return { registrationId, libraryId, id, key: `${registrationId}:${id}`, title: text(item.title || item.name, 160) || '无标题图片',
      source: text(item.source || item.sourceName, 120), note: typeof item.note === 'string' ? item.note.slice(0, noteLength) : '' };
  }

  function isImage(asset) {
    return asset && !asset.trashed && (asset.kind === 'image' || ['livp', 'livephoto'].includes(asset.extension));
  }

  function distinctImages(assets) {
    const result = new Map();
    for (const asset of assets ?? []) {
      if (!isImage(asset)) continue;
      const entry = asEntry(asset);
      if (entry && !result.has(entry.key)) result.set(entry.key, { ...entry, note: '', asset });
    }
    return result;
  }

  function readBoards() {
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}');
      if (parsed.version !== 1 || !Array.isArray(parsed.boards)) return { current: null, boards: [] };
      const boards = [];
      let localBoards = 0;
      for (const saved of parsed.boards) {
        const name = text(saved?.name, titleLength);
        if (!name || !opaqueId.test(saved?.id ?? '') || boards.some(board => board.id === saved.id)) continue;
        const entries = new Map();
        for (const item of (Array.isArray(saved.entries) ? saved.entries : []).slice(0, maximumEntries)) {
          const entry = item && asEntry(item);
          if (entry && !entries.has(entry.key)) entries.set(entry.key, entry);
        }
        const shared = saved.shared;
        const sync = shared && studio?.isID(saved.id) && opaqueId.test(shared.libraryId ?? '') &&
          typeof shared.token === 'string' && shared.token.length > 0 && shared.token.length <= 256
          ? { libraryId: shared.libraryId, token: shared.token, revision: shared.revision, pending: shared.pending === true } : null;
        if (!sync && localBoards >= maximumBoards) continue;
        if (!sync) localBoards++;
        boards.push({ id: saved.id, name, entries: [...entries.values()], ...(sync && { shared: sync }) });
      }
      return { boards, current: boards.some(board => board.id === parsed.current) ? parsed.current : boards[0]?.id ?? null };
    } catch { return { current: null, boards: [] }; }
  }

  function wordLines(context, value, fullWidth) {
    const lines = [];
    let line = '';
    for (const letter of String(value).replace(/\s+/gu, ' ').trim()) {
      if (line && context.measureText(line + letter).width > fullWidth) {
        lines.push(line.trimEnd());
        line = letter === ' ' ? '' : letter;
      } else line += letter;
    }
    if (line) lines.push(line.trimEnd());
    return lines;
  }

  const pageWidth = 1188;
  const pageHeight = 1680;
  const margin = 64;
  const gap = 26;
  const padding = 18;
  const coverHeight = 310;
  const cardWidth = (pageWidth - 2 * margin - gap) / 2;
  const bodyWidth = cardWidth - 2 * padding;

  function describeLayout(name, entries) {
    const meter = document.createElement('canvas').getContext('2d');
    meter.font = `650 52px ${fonts}`;
    const title = wordLines(meter, name, pageWidth - 2 * margin);
    const contentTop = 129 + title.length * 66;
    const rows = [];
    for (let index = 0; index < entries.length; index += 2) {
      const cards = entries.slice(index, index + 2).map(entry => {
        meter.font = `620 27px ${fonts}`;
        const label = wordLines(meter, entry.title, bodyWidth);
        meter.font = `24px ${fonts}`;
        const note = entry.note ? wordLines(meter, entry.note, bodyWidth) : [];
        return { ...entry, label, note, height: coverHeight + 42 + label.length * 34 + (note.length ? 12 + note.length * 32 : 0) };
      });
      rows.push({ cards, height: Math.max(...cards.map(card => card.height)) });
    }
    return { title, contentTop, rows, height: contentTop + margin + rows.reduce((height, row) => height + row.height + gap, -gap) };
  }

  function paintLines(context, lines, x, y, step) {
    lines.forEach((line, index) => context.fillText(line, x, y + step * index));
  }

  function paintHeader(context, layout, count, page) {
    context.textBaseline = 'top';
    context.fillStyle = quietInk;
    context.font = `620 22px ${fonts}`;
    context.fillText(`见藏  /  ${count} 张图片`, margin, 64);
    context.fillStyle = ink;
    context.font = `650 52px ${fonts}`;
    paintLines(context, layout.title, margin, 113, 66);
    if (page) {
      context.fillStyle = quietInk;
      context.font = `22px ${fonts}`;
      context.fillText(page, margin, pageHeight - 46);
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const fail = () => reject(new Error(imageUnavailable));
      const timer = setTimeout(fail, 14_000);
      image.onload = () => { clearTimeout(timer); resolve(image); };
      image.onerror = () => { clearTimeout(timer); fail(); };
      image.src = src;
    });
  }

  function paintCard(context, card, image, x, y) {
    context.fillStyle = '#ffffff';
    context.fillRect(x, y, cardWidth, card.height);
    context.fillStyle = '#e9ecf0';
    context.fillRect(x + padding, y + padding, bodyWidth, coverHeight);
    const scale = Math.min(bodyWidth / image.naturalWidth, coverHeight / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(image, x + padding + (bodyWidth - width) / 2, y + padding + (coverHeight - height) / 2, width, height);
    const textY = y + coverHeight + padding + 12;
    context.fillStyle = ink;
    context.font = `620 27px ${fonts}`;
    paintLines(context, card.label, x + padding, textY, 34);
    context.fillStyle = quietInk;
    context.font = `24px ${fonts}`;
    paintLines(context, card.note, x + padding, textY + card.label.length * 34 + 8, 32);
  }

  async function paintRows(context, rows, start) {
    let y = start;
    for (const row of rows) {
      const images = await Promise.all(row.cards.map(card => loadImage(card.src).catch(() => {
        throw new Error(`无法读取「${card.title}」。请取回或移出这张图片后重试。`);
      })));
      if (row.scale < 1) {
        context.save();
        context.translate(margin, y);
        context.scale(row.scale, row.scale);
        row.cards.forEach((card, index) => paintCard(context, card, images[index], index * (cardWidth + gap), 0));
        context.restore();
      } else row.cards.forEach((card, index) => paintCard(context, card, images[index], margin + index * (cardWidth + gap), y));
      y += row.height * (row.scale ?? 1) + gap;
    }
  }

  function canvasFor(height, scale = 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(pageWidth * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('暂时无法生成灵感板，请关闭其他预览后重试。');
    context.scale(scale, scale);
    context.fillStyle = paper;
    context.fillRect(0, 0, pageWidth + 1, height + 1);
    return [canvas, context];
  }

  async function encode(canvas, type) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, type, .92));
    const result = blob && { width: canvas.width, height: canvas.height, data: new Uint8Array(await blob.arrayBuffer()) };
    canvas.width = 1;
    canvas.height = 1;
    if (!result) throw new Error('生成文件失败，请尝试导出 PDF。');
    return result;
  }

  async function renderExport(format, name, entries, progress) {
    const layout = describeLayout(name, entries);
    if (format === 'png') {
      const scale = Math.min(1, 23_500 / layout.height, Math.sqrt(23_000_000 / (pageWidth * layout.height)));
      const [canvas, context] = canvasFor(layout.height, scale);
      paintHeader(context, layout, entries.length);
      await paintRows(context, layout.rows, layout.contentTop);
      return { format, name, data: (await encode(canvas, 'image/png')).data };
    }
    const pages = [];
    let used = 0;
    const room = pageHeight - layout.contentTop - margin;
    for (const row of layout.rows) {
      const height = Math.min(room, row.height);
      if (!pages.length || (used > 0 && used + height > room)) { pages.push([]); used = 0; }
      pages.at(-1).push({ ...row, scale: height / row.height });
      used += height + gap;
    }
    const output = [];
    for (const [index, rows] of pages.entries()) {
      progress(`正在生成第 ${index + 1} / ${pages.length} 页…`);
      const [canvas, context] = canvasFor(pageHeight);
      paintHeader(context, layout, entries.length, `${index + 1} / ${pages.length}`);
      await paintRows(context, rows, layout.contentTop);
      output.push(await encode(canvas, 'image/jpeg'));
    }
    return { format, name, pages: output };
  }

  window.createJianCangProjectBoards = function ({ getAssets, getAsset, getLibraries, getImage, exportBoard, importProject, exportOriginals, notify, bridge }) {
    const state = readBoards();
    const dialog = element('dialog', 'project-board-dialog');
    const header = element('header', 'dialog-head');
    const heading = element('h2', '', '项目灵感板');
    heading.id = 'project-board-heading';
    dialog.setAttribute('aria-labelledby', heading.id);
    const closeButton = describe(button('×', 'icon-button board-dismiss', () => dialog.close()), '关闭项目灵感板');
    header.append(heading, closeButton);
    const workspace = element('div', 'board-workspace');
    const rail = element('aside', 'board-rail');
    rail.setAttribute('aria-label', '灵感板列表');
    const railControls = element('div', 'board-rail-controls');
    const createButton = button('＋ 新建灵感板', 'outline-button board-create', create);
    const importButton = button('导入灵感板工程', 'outline-button board-import-project', () => { void openProject(); });
    const boardSearch = element('input', 'board-rail-search');
    boardSearch.type = 'search';
    boardSearch.placeholder = '搜索灵感板';
    boardSearch.setAttribute('aria-label', boardSearch.placeholder);
    railControls.append(createButton, importButton, boardSearch);
    importButton.hidden = typeof importProject !== 'function';
    const boardList = element('div', 'board-list');
    rail.append(railControls, boardList);
    const surface = element('main', 'board-surface');
    const boardHeader = element('div', 'board-heading');
    const feedback = element('p', 'board-feedback');
    feedback.setAttribute('role', 'status');
    feedback.hidden = true;
    const content = element('div', 'board-content');
    surface.append(boardHeader, feedback, content);
    workspace.append(rail, surface);
    dialog.append(header, workspace);
    document.body.append(dialog);

    let adding = null;
    let picker = null;
    let dragging;
    let exporting = false;
    let dirty = false;
    let polling;
    let refreshInProgress;
    const queued = new Map();
    const writing = new Map();
    const failed = new Set();

    function current() { return state.boards.find(board => board.id === state.current); }
    const localCount = () => state.boards.filter(board => !board.shared).length;

    function syncLibraries() {
      if (!studio || typeof bridge?.studioList !== 'function' || typeof bridge?.studioWrite !== 'function') return [];
      return getLibraries().filter(entry => entry.kind === 'jiancang' && entry.format === 6 && entry.status === 'available');
    }

    function syncLibrary(libraryId) {
      return syncLibraries().find(entry => entry.libraryId.toLowerCase() === libraryId.toLowerCase());
    }

    function libraryIdentity(registrationId) {
      return getLibraries?.().find(library => library.id === registrationId)?.libraryId ?? null;
    }

    function assetForEntry(entry) {
      if (!entry.libraryId || libraryIdentity(entry.registrationId)?.toLowerCase() === entry.libraryId.toLowerCase()) return getAsset?.(entry);
      const matching = getLibraries?.().filter(library => library.libraryId?.toLowerCase() === entry.libraryId.toLowerCase()) ?? [];
      if (matching.length === 1) return getAsset?.({ ...entry, registrationId: matching[0].id });
      return null;
    }

    function entryKey(entry) {
      const owner = assetForEntry(entry)?.sourceLibraryId;
      return owner ? `${owner}:${entry.id}` : entry.key;
    }

    function say(message, error = false) {
      feedback.textContent = message ?? '';
      feedback.hidden = !message;
      feedback.classList.toggle('is-error', error);
    }

    function persist() {
      dirty = true;
      try {
        localStorage.setItem(storageKey, JSON.stringify({ version: 1, ...state }));
        dirty = false;
      } catch { say('暂时无法保存灵感板。请在关闭前导出。', true); }
    }

    function boardPayload(board, library) {
      const entries = board.entries.map(entry => {
        const owner = entry.libraryId ?? libraryIdentity(entry.registrationId);
        if (owner?.toLowerCase() !== library.libraryId.toLowerCase()) throw new Error('请选择来自同一份同步库的图片。');
        return { assetID: entry.id, caption: entry.note, title: entry.title };
      });
      return JSON.stringify(studio.readBoard({ title: board.name, entries }));
    }

    function sharedBoard(record, library) {
      const value = studio.readBoard(record.payload);
      return { id: record.id, name: value.title, shared: { libraryId: library.libraryId, token: record.token, revision: record.revision, pending: false },
        entries: value.entries.map(card => asEntry({ registrationId: library.id, libraryId: library.libraryId,
          id: card.assetID, title: card.title, note: card.caption, source: library.name })) };
    }

    function updateBoard(board) {
      if (board.shared) {
        board.shared.pending = true;
        scheduleWrite(board);
        refreshSyncActions(board);
      }
      persist();
    }

    function refreshSyncActions(board) {
      if (current() !== board) return;
      const retry = boardHeader.querySelector('.board-sync-retry');
      const recover = boardHeader.querySelector('.board-sync-recover');
      if (retry) retry.hidden = !board.shared.pending;
      if (recover) recover.hidden = !failed.has(board.id);
    }

    function scheduleWrite(board) {
      clearTimeout(queued.get(board.id));
      queued.set(board.id, setTimeout(() => {
        queued.delete(board.id);
        void flushBoard(board);
      }, 450));
    }

    function flushBoard(board) {
      if (!board.shared?.pending || !state.boards.includes(board)) return;
      if (writing.has(board.id)) return writing.get(board.id);
      const write = (async () => {
        try {
          const library = syncLibrary(board.shared.libraryId);
          if (!library?.syncWritable) throw new Error('同步库暂不可写，本机已保存更改。');
          const payload = boardPayload(board, library);
          const record = await bridge.studioWrite(library.id, 'board', null, board.id, payload, board.shared.token);
          board.shared.token = record.token;
          board.shared.revision = record.revision;
          board.shared.pending = boardPayload(board, library) !== payload;
          persist();
          failed.delete(board.id);
          refreshSyncActions(board);
          if (board.shared.pending) scheduleWrite(board);
          else if (current() === board && dialog.open) say('已同步灵感板。');
        } catch (error) {
          failed.add(board.id);
          if (current() === board && dialog.open) {
            say(`同步失败，更改已保存在本机。${error.message || ''}`, true);
            refreshSyncActions(board);
          }
        }
      })().finally(() => writing.delete(board.id));
      writing.set(board.id, write);
      return write;
    }

    function isEditingBoard() {
      const focused = document.activeElement;
      return picker || dragging || (dialog.contains(focused) && (focused.matches('.board-note') ||
        focused.matches('.board-title-input') && focused.value !== current()?.name));
    }

    function refreshBoards() {
      if (refreshInProgress) return refreshInProgress;
      const previous = current();
      refreshInProgress = (async () => {
        let changed = false;
        for (const library of syncLibraries()) {
          let records;
          try { records = await bridge.studioList(library.id, 'board'); }
          catch { continue; }
          if (!Array.isArray(records)) continue;
          for (const record of records) {
            const index = state.boards.findIndex(board => board.id === record.id);
            const existing = state.boards[index];
            if (!studio.isID(record.id) || existing && (!existing.shared || existing.shared.pending ||
              existing.shared.libraryId.toLowerCase() !== library.libraryId.toLowerCase() ||
              existing.shared.token === record.token || existing.shared.revision > record.revision ||
              existing === current() && isEditingBoard())) continue;
            if (!record.payload) {
              if (index >= 0) { state.boards.splice(index, 1); changed = true; }
              continue;
            }
            try {
              const board = sharedBoard(record, library);
              if (index < 0) state.boards.push(board);
              else state.boards[index] = board;
              changed = true;
            } catch { /* A document from a newer client is left untouched. */ }
          }
        }
        if (changed) {
          if (!current()) state.current = state.boards[0]?.id ?? null;
          persist();
          if (dialog.open) {
            if (current() !== previous) render();
            else renderBoardList();
          }
        }
      })().finally(() => { refreshInProgress = null; });
      return refreshInProgress;
    }

    function chooseSyncLibrary(board) {
      const writable = syncLibraries().filter(library => library.syncWritable);
      if (!writable.length) { say('请先在素材库管理中打开见藏同步库的双向同步。', true); return; }
      const choices = writable.filter(library => board.entries.every(entry =>
        (entry.libraryId ?? libraryIdentity(entry.registrationId))?.toLowerCase() === library.libraryId.toLowerCase()));
      if (!choices.length) { say('这张灵感板的图片来自不同素材库，可继续保存在本机。', true); return; }
      const modal = element('dialog', 'board-confirm');
      modal.setAttribute('aria-label', '同步灵感板');
      const header = element('div', 'dialog-head');
      header.append(element('h2', '', '同步到资料库'));
      const description = element('p', 'board-confirm-description', '同步灵感板的标题、图片顺序和说明。');
      const actions = element('div', 'board-confirm-actions');
      const cancel = button('取消', 'outline-button', () => modal.close());
      actions.append(cancel);
      for (const library of choices) {
        actions.append(button(library.name, 'primary-button', async () => {
          for (const control of actions.children) control.disabled = true;
          try {
            const id = studio.isID(board.id) ? board.id : crypto.randomUUID();
            const record = await bridge.studioWrite(library.id, 'board', null, id, boardPayload(board, library), null);
            board.id = record.id;
            board.shared = { libraryId: library.libraryId, token: record.token, revision: record.revision, pending: false };
            modal.close();
            setBoard(board.id);
            say('已加入同步库。之后修改会自动同步。');
          } catch (error) {
            description.textContent = error.message || '保存到同步库失败，灵感板仍保存在本机。';
            for (const control of actions.children) control.disabled = false;
          }
        }));
      }
      modal.addEventListener('cancel', event => { if (cancel.disabled) event.preventDefault(); });
      modal.addEventListener('close', () => modal.remove(), { once: true });
      modal.append(header, description, actions);
      document.body.append(modal);
      modal.showModal();
    }

    function setBoard(id) {
      state.current = id;
      picker = null;
      persist();
      render();
    }

    function addBoard(board) {
      boardSearch.value = '';
      state.boards.unshift(board);
      setBoard(board.id);
      const title = boardHeader.querySelector('input');
      title?.focus();
      title?.select();
    }

    function create() {
      if (exporting || localCount() >= maximumBoards) return;
      const names = new Set(state.boards.map(board => board.name));
      let index = 1;
      while (names.has(`灵感板 ${index}`)) index++;
      addBoard({ id: crypto.randomUUID(), name: `灵感板 ${index}`, entries: [] });
    }

    function duplicate(board) {
      if (exporting || localCount() >= maximumBoards) return;
      const names = new Set(state.boards.map(item => item.name));
      let index = 1;
      let name;
      do {
        const suffix = index === 1 ? ' 副本' : ` 副本 ${index}`;
        name = board.name.slice(0, titleLength - suffix.length).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() + suffix;
        index++;
      } while (names.has(name));
      addBoard({ id: crypto.randomUUID(), name, entries: board.entries.map(entry => ({ ...entry })) });
      if (!dirty) say('已复制灵感板，可修改副本名称。');
    }

    async function openProject() {
      if (exporting || !importProject || localCount() >= maximumBoards) return;
      exporting = true;
      render();
      say('');
      try {
        const result = await importProject();
        if (result?.cancelled) return;
        if (!result?.ok) throw new Error(result?.message || '无法导入灵感板工程。');
        const { name, entries } = result.project;
        const missing = entries.filter(entry => !isImage(assetForEntry(entry))).length;
        exporting = false;
        addBoard({ id: crypto.randomUUID(), name, entries: entries.map(asEntry) });
        if (!dirty) say(missing
          ? `已导入灵感板。${missing} 张图片等待连接原素材库，顺序和说明已保留。`
          : '已导入灵感板，可以继续编辑。');
      } catch (error) { say(error.message || '无法导入灵感板工程。', true); }
      finally {
        if (exporting) { exporting = false; render(); }
      }
    }

    function open(assets) {
      if (assets !== undefined) {
        adding = distinctImages(assets);
        if (!adding.size) { notify?.('请选择要加入灵感板的图片。'); return; }
      } else adding = null;
      dragging = null;
      picker = null;
      boardSearch.value = '';
      if (!dialog.open) dialog.showModal();
      render();
      void refreshBoards();
      polling ??= setInterval(() => { if (dialog.open && !exporting) void refreshBoards(); }, 6000);
      for (const board of state.boards) if (board.shared?.pending && !failed.has(board.id)) scheduleWrite(board);
      content.scrollTop = 0;
      const working = current() ? boardHeader.querySelector('input') : createButton;
      const destination = boardSearch.hidden ? content.querySelector('.board-add-selected .primary-button') : boardSearch;
      const focusTarget = adding?.size ? destination ?? working : working;
      focusTarget?.focus({ preventScroll: true });
    }

    function confirm(title, detail, action, label) {
      const modal = element('dialog', 'board-confirm');
      const top = element('div', 'dialog-head');
      const name = element('h2', '', title);
      name.id = 'board-confirm-title';
      modal.setAttribute('aria-labelledby', name.id);
      top.append(name);
      const description = element('p', 'board-confirm-description', detail);
      const actions = element('div', 'board-confirm-actions');
      const cancel = button('取消', 'outline-button', () => modal.close());
      actions.append(cancel, button(label, 'primary-button', () => { modal.close(); action(); }));
      modal.append(top, description, actions);
      document.body.append(modal);
      modal.addEventListener('close', () => modal.remove(), { once: true });
      modal.showModal();
      cancel.focus();
    }

    function removeBoard(board) {
      const detail = board.shared ? `「${board.name}」会从同步库移除，素材仍保存在原库中。`
        : `「${board.name}」的选片顺序和说明会被删除，素材仍保存在原库中。`;
      confirm('删除灵感板？', detail, async () => {
        if (board.shared) {
          const library = syncLibrary(board.shared.libraryId);
          if (!library?.syncWritable) { say('同步库暂不可写，灵感板仍保留。', true); return; }
          exporting = true;
          render();
          clearTimeout(queued.get(board.id));
          queued.delete(board.id);
          try {
            await writing.get(board.id);
            await bridge.studioWrite(library.id, 'board', null, board.id, null, board.shared.token);
          } catch (error) { say(error.message || '无法删除同步灵感板。', true); return; }
          finally { exporting = false; render(); }
        }
        state.boards = state.boards.filter(item => item.id !== board.id);
        setBoard(state.boards[0]?.id ?? null);
      }, '删除灵感板');
    }

    function recoverRemoteBoard(board) {
      confirm('读取同步库的灵感板？', '这会放弃此板尚未同步的修改。需要保留修改时，可先复制为本机灵感板。', async () => {
        if (writing.has(board.id)) { say('正在保存，请等待本次同步完成。'); return; }
        const library = syncLibrary(board.shared.libraryId);
        if (!library) { say('同步库暂不可读。', true); return; }
        try {
          const records = await bridge.studioList(library.id, 'board');
          const record = records.find(item => item.id === board.id);
          if (!record) throw new Error('暂未读到同步记录。');
          const replacement = record.payload ? sharedBoard(record, library) : null;
          clearTimeout(queued.get(board.id));
          queued.delete(board.id);
          failed.delete(board.id);
          state.boards = state.boards.flatMap(item => item === board ? replacement ? [replacement] : [] : [item]);
          setBoard(replacement?.id ?? state.boards[0]?.id ?? null);
          say('已读取同步库的版本。');
        } catch (error) { say(error.message || '暂时无法读取灵感板。', true); }
      }, '读取同步库版本');
    }

    function append(board, candidates) {
      const known = new Set(board.entries.map(entry => board.shared ? entry.id : entryKey(entry)));
      const supported = [...candidates.values()].filter(item => acceptsImage(board, item));
      if (!supported.length && candidates.size && board.shared) {
        say('同步灵感板只能添加同一份库中的图片。', true);
        return;
      }
      const added = supported.filter(item => !known.has(board.shared ? item.id : item.key));
      const remaining = maximumEntries - board.entries.length;
      for (const item of added.slice(0, remaining)) {
        const { asset, ...entry } = item;
        entry.libraryId = libraryIdentity(entry.registrationId);
        board.entries.push(entry);
      }
      adding = null;
      picker = null;
      updateBoard(board);
      render();
      if (added.length > remaining) say(`灵感板最多保存 ${maximumEntries} 张图片。已添加 ${remaining} 张。`);
      else if (added.length) say(`已添加 ${added.length} 张图片。${supported.length < candidates.size ? '其他库的图片留在原处。' : ''}`);
      else say('所选图片已经在这张灵感板上。');
    }

    function acceptsImage(board, image) {
      return !board.shared || libraryIdentity(image.registrationId)?.toLowerCase() === board.shared.libraryId.toLowerCase();
    }

    function previewFor(entry, knownAsset) {
      const asset = knownAsset ?? assetForEntry(entry);
      return isImage(asset) ? getImage?.(asset) ?? null : null;
    }

    function imageBed(entry, asset) {
      const cover = element('div', 'board-image');
      const missing = element('span', 'board-missing', imageUnavailable);
      const src = previewFor(entry, asset);
      if (src) {
        const image = element('img');
        image.loading = 'lazy';
        image.decoding = 'async';
        image.alt = entry.title;
        image.draggable = false;
        missing.hidden = true;
        image.addEventListener('error', () => { image.hidden = true; missing.hidden = false; }, { once: true });
        image.src = src;
        cover.append(image);
      }
      cover.append(missing);
      return cover;
    }

    function reorder(board, key, index, focus) {
      const from = board.entries.findIndex(entry => entry.key === key);
      if (from < 0 || from === index || index < 0 || index >= board.entries.length || exporting) return;
      const existing = new Map([...content.querySelectorAll('.board-card')].map(card => [card.dataset.entry, card.getBoundingClientRect()]));
      const [item] = board.entries.splice(from, 1);
      board.entries.splice(index, 0, item);
      updateBoard(board);
      renderCards(board);
      for (const card of content.querySelectorAll('.board-card')) {
        const before = existing.get(card.dataset.entry);
        const after = card.getBoundingClientRect();
        if (before && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
          card.animate([{ transform: `translate(${before.x - after.x}px, ${before.y - after.y}px)` }, { transform: 'none' }],
            { duration: 165, easing: 'cubic-bezier(.21,.8,.3,1)' });
        }
        if (focus && card.dataset.entry === key) card.querySelector(`[data-board-control="${focus}"]:not(:disabled)`)?.focus({ preventScroll: true });
      }
      say(`已移到第 ${index + 1} 位。`);
    }

    function makeCard(board, entry, index) {
      const card = element('article', 'board-card');
      card.dataset.entry = entry.key;
      const details = element('div', 'board-card-details');
      const caption = element('header', 'board-card-caption');
      const title = element('h3', '', entry.title);
      title.title = entry.title;
      caption.append(title);
      caption.append(element('span', 'board-order', `${index + 1}`));
      const note = element('textarea', 'board-note');
      note.placeholder = '添加说明';
      note.setAttribute('aria-label', `${entry.title} 的说明`);
      note.maxLength = noteLength;
      note.rows = 2;
      note.value = entry.note;
      note.addEventListener('input', () => { entry.note = note.value; updateBoard(board); });
      const bottom = element('div', 'board-card-tools');
      bottom.append(element('span', 'board-source', entry.source));
      const group = element('div', 'board-card-controls');
      const grip = describe(button('⠿', 'board-mini board-grip', () => {}), '拖动排序，或按 Alt 加方向键移动');
      grip.draggable = !exporting;
      grip.dataset.boardControl = 'grip';
      const previous = describe(button('↑', 'board-mini', () => reorder(board, entry.key, index - 1, 'up')), `向前移动 ${entry.title}`);
      const next = describe(button('↓', 'board-mini', () => reorder(board, entry.key, index + 1, 'down')), `向后移动 ${entry.title}`);
      previous.dataset.boardControl = 'up';
      next.dataset.boardControl = 'down';
      previous.disabled = index === 0;
      next.disabled = index >= board.entries.length - 1;
      const remove = describe(button('×', 'board-mini board-remove', () => {
        confirm('移出图片？', `「${entry.title}」和它在板上的说明会一起移出。`, () => {
          board.entries = board.entries.filter(item => item.key !== entry.key);
          updateBoard(board);
          render();
        }, '移出图片');
      }), `移出 ${entry.title}`);
      grip.addEventListener('keydown', event => {
        if (!event.altKey || !['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        reorder(board, entry.key, index + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1), 'grip');
      });
      grip.addEventListener('dragstart', event => {
        if (exporting) { event.preventDefault(); return; }
        dragging = entry.key;
        event.dataTransfer.setData('application/x-jiancang-board-entry', entry.key);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setDragImage(card, card.offsetWidth / 2, 44);
        setTimeout(() => card.classList.add('board-dragging'), 0);
      });
      grip.addEventListener('dragend', () => { dragging = null; card.classList.remove('board-dragging'); });
      card.addEventListener('dragover', event => {
        if (!dragging || dragging === entry.key) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        card.classList.add('board-drop');
      });
      card.addEventListener('dragleave', event => { if (!card.contains(event.relatedTarget)) card.classList.remove('board-drop'); });
      card.addEventListener('drop', event => {
        if (!dragging) return;
        event.preventDefault();
        const key = dragging;
        dragging = null;
        card.classList.remove('board-drop');
        reorder(board, key, index, 'grip');
      });
      group.append(grip, previous, next, remove);
      bottom.append(group);
      details.append(caption, note, bottom);
      card.append(imageBed(entry), details);
      return card;
    }

    function renderCards(board) {
      content.classList.remove('is-board-picker');
      const scroll = content.scrollTop;
      if (!board.entries.length) {
        const empty = element('div', 'board-empty');
        empty.append(element('p', '', '这张灵感板还没有图片。'),
          button('从当前素材选图', 'outline-button', () => chooseImages(board)));
        content.replaceChildren(empty);
      } else {
        const grid = element('div', 'board-cards');
        grid.append(...board.entries.map((entry, index) => makeCard(board, entry, index)));
        content.replaceChildren(grid);
      }
      content.scrollTop = scroll;
    }

    function chooseImages(board) {
      const existing = new Set(board.entries.map(entry => board.shared ? entry.id : entryKey(entry)));
      const choices = [...distinctImages(getAssets?.()).values()].filter(item =>
        !existing.has(board.shared ? item.id : item.key) && acceptsImage(board, item));
      picker = { choices, selected: new Map(), query: '', limit: 80 };
      render();
      boardHeader.querySelector('input')?.focus();
    }

    function renderPicker(board) {
      content.classList.add('is-board-picker');
      const search = element('input', 'board-title-input board-picker-search');
      search.type = 'search';
      search.placeholder = '搜索当前素材的图片';
      search.setAttribute('aria-label', search.placeholder);
      search.value = picker.query;
      const limit = maximumEntries - board.entries.length;
      const accept = button('', 'primary-button', () => append(board, picker.selected));
      const controls = element('div', 'board-actions');
      controls.append(button('取消', 'outline-button', () => { picker = null; render(); }), accept);
      boardHeader.replaceChildren(search, controls);
      const picks = element('div', 'board-pick-grid');
      const more = button('显示更多', 'outline-button board-show-more', () => { picker.limit += 80; results(); });
      content.replaceChildren(picks, more);
      function count() {
        accept.textContent = picker.selected.size ? `添加 ${picker.selected.size} 张` : '添加图片';
        accept.disabled = picker.selected.size === 0;
      }
      function results() {
        const terms = normalized(picker.query).trim().split(/\s+/u).filter(Boolean);
        const matches = terms.length ? picker.choices.filter(item => {
          const value = normalized(`${item.title} ${item.source} ${(item.asset.tags ?? []).join(' ')}`);
          return terms.every(term => value.includes(term));
        }) : picker.choices;
        const nodes = matches.slice(0, picker.limit).map(item => {
          const tile = button('', 'board-pick-tile', () => {
            if (picker.selected.has(item.key)) picker.selected.delete(item.key);
            else if (picker.selected.size >= limit) { say(`这张灵感板还可加入 ${limit} 张图片。`); return; }
            else picker.selected.set(item.key, item);
            tile.setAttribute('aria-pressed', String(picker.selected.has(item.key)));
            count();
          });
          tile.setAttribute('aria-pressed', String(picker.selected.has(item.key)));
          tile.setAttribute('aria-label', item.title);
          tile.append(imageBed(item, item.asset), element('span', 'board-pick-name', item.title));
          return tile;
        });
        picks.replaceChildren(...(nodes.length ? nodes : [element('p', 'board-picker-empty',
          terms.length ? '没有符合搜索条件的图片。' : '当前素材中没有可添加的图片。')]));
        more.hidden = matches.length <= picker.limit;
        count();
      }
      search.addEventListener('input', () => { picker.query = search.value; picker.limit = 80; results(); });
      results();
    }

    async function exportCurrent(format) {
      const board = current();
      const isProject = format === 'jiancangboard';
      if (exporting || !board || (!isProject && !board.entries.length)) return;
      exporting = true;
      render();
      say('正在生成灵感板…');
      try {
        if (isProject) {
          const entries = board.entries.map(entry => ({ ...entry, libraryId: entry.libraryId ?? libraryIdentity(entry.registrationId) }));
          const result = await exportBoard({ format, name: board.name, entries });
          if (result?.cancelled) say('');
          else if (result?.ok) say('已导出可编辑工程。原件仍保存在各自的素材库中。');
          else throw new Error(result?.message || '无法导出灵感板工程。');
          return;
        }
        const entries = board.entries.map(entry => {
          const src = previewFor(entry);
          if (!src) throw new Error(`「${entry.title}」已不可用。请恢复或移出这张图片后重试。`);
          return { ...entry, src };
        });
        const payload = await renderExport(format, board.name, entries, say);
        const result = await exportBoard(payload);
        if (result?.ok || result === true) say(format === 'png' ? '已导出灵感板长图。' : '已导出灵感板 PDF。');
        else if (result?.cancelled) say('');
        else throw new Error(result?.message || '无法保存灵感板，请检查存放位置后重试。');
      } catch (error) { say(error?.message || '未能导出灵感板。', true); }
      finally { exporting = false; render(); }
    }

    function renderBoardList() {
      boardSearch.hidden = state.boards.length < 2 && !boardSearch.value;
      boardSearch.disabled = exporting;
      const query = normalized(boardSearch.value).trim();
      const matches = state.boards.filter(item => normalized(item.name).includes(query));
      const nodes = matches.map(item => {
        const choice = button('', 'board-rail-entry', () => {
          const focused = document.activeElement === choice;
          setBoard(item.id);
          if (focused) boardList.querySelector('[aria-current="true"]')?.focus({ preventScroll: true });
        });
        choice.disabled = exporting;
        if (item.id === state.current) choice.setAttribute('aria-current', 'true');
        if (item.shared) choice.title = `同步灵感板 · ${syncLibrary(item.shared.libraryId)?.name ?? '等待连接素材库'}`;
        choice.append(element('span', 'board-rail-name', item.name),
          element('span', 'board-rail-count', item.shared ? `☁ ${item.entries.length}` : String(item.entries.length)));
        return choice;
      });
      if (query && !matches.length) {
        const empty = element('p', 'board-search-empty', '没有匹配的灵感板');
        empty.setAttribute('role', 'status');
        nodes.push(empty);
      }
      boardList.replaceChildren(...nodes);
    }

    function render() {
      const board = current();
      renderBoardList();
      createButton.disabled = exporting || localCount() >= maximumBoards;
      importButton.disabled = createButton.disabled;
      closeButton.disabled = exporting;
      if (!board) {
        boardHeader.replaceChildren();
        const empty = element('div', 'board-empty board-empty-all');
        empty.append(element('h3', '', '还没有灵感板'),
          element('p', '', adding?.size ? `新建后可以加入已选的 ${adding.size} 张图片。` : '新建一张灵感板来选图、排序和写说明。'));
        content.replaceChildren(empty);
        return;
      }
      if (picker) { renderPicker(board); return; }
      const title = element('input', 'board-title-input');
      title.value = board.name;
      title.maxLength = titleLength;
      title.disabled = exporting;
      title.setAttribute('aria-label', '灵感板名称');
      title.addEventListener('change', () => {
        const name = text(title.value, titleLength);
        if (!name) { title.value = board.name; return; }
        board.name = name;
        title.value = name;
        updateBoard(board);
        renderBoardList();
      });
      title.addEventListener('keydown', event => { if (event.key === 'Enter') title.blur(); });
      const actions = element('div', 'board-actions');
      const select = button('选图', 'outline-button', () => chooseImages(board));
      const copy = button('复制灵感板', 'outline-button board-copy', () => duplicate(board));
      const png = button('导出长图', 'outline-button board-png', () => { void exportCurrent('png'); });
      const pdf = button('导出 PDF', 'outline-button board-pdf', () => { void exportCurrent('pdf'); });
      const project = button('导出工程', 'outline-button board-export-project', () => { void exportCurrent('jiancangboard'); });
      const originals = button('导出原件', 'outline-button board-originals', () => exportOriginals?.({ ...board,
        entries: board.entries.map(entry => ({ ...entry,
          registrationId: assetForEntry(entry)?.sourceLibraryId ?? (entry.libraryId ? 'unconnected' : entry.registrationId) })) }));
      const remove = button('删除灵感板', 'status-button board-delete', () => removeBoard(board));
      select.disabled = exporting || board.entries.length >= maximumEntries;
      copy.disabled = exporting || localCount() >= maximumBoards;
      png.disabled = pdf.disabled = exporting || !board.entries.length;
      originals.disabled = png.disabled;
      project.disabled = exporting;
      remove.disabled = exporting;
      actions.append(remove, copy, select, png, pdf, project);
      if (exportOriginals) actions.append(originals);
      if (!board.shared && syncLibraries().length) {
        const share = button('同步到资料库…', 'outline-button', () => chooseSyncLibrary(board));
        share.disabled = exporting;
        actions.append(share);
      }
      if (board.shared) {
        const retry = button('重试同步', 'outline-button board-sync-retry', () => { void flushBoard(board); });
        const recover = button('读取同步库版本…', 'outline-button board-sync-recover', () => recoverRemoteBoard(board));
        retry.disabled = recover.disabled = exporting;
        actions.append(retry, recover);
      }
      boardHeader.replaceChildren(title, actions);
      if (board.shared) refreshSyncActions(board);
      renderCards(board);
      if (adding?.size) {
        const line = element('div', 'board-add-selected');
        line.append(element('span', '', `已选 ${adding.size} 张图片`), button('取消', 'status-button', () => { adding = null; render(); }),
          button('加入当前灵感板', 'primary-button', () => append(board, adding)));
        content.prepend(line);
      }
      if (exporting) content.inert = true;
      else content.inert = false;
    }

    boardSearch.addEventListener('input', renderBoardList);
    boardSearch.addEventListener('keydown', event => {
      if (event.isComposing || event.key !== 'Enter') return;
      const choices = boardList.querySelectorAll('.board-rail-entry:not(:disabled)');
      if (choices.length !== 1) return;
      event.preventDefault();
      choices[0].click();
      (adding?.size ? content.querySelector('.board-add-selected .primary-button') : boardHeader.querySelector('input'))?.focus();
    });
    dialog.addEventListener('cancel', event => { if (exporting) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      clearInterval(polling);
      polling = undefined;
      dragging = null;
      adding = null;
      picker = null;
      if (dirty) persist();
      else say('');
    });
    return { open, add: assets => open(assets) };
  };
})();
