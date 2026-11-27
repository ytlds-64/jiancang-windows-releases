'use strict';

(() => {
  const number = new Intl.NumberFormat('zh-CN');
  const decimal = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
  const pageSize = 24;
  const statusLabels = { pending: '等待取回', running: '正在取回', done: '已取回', failed: '取回失败' };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(text, className, click) {
    const node = element('button', className, text);
    node.type = 'button';
    node.addEventListener('click', click);
    return node;
  }

  function bytes(value) {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const unit = Math.min(4, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))));
    return `${decimal.format(value / 1024 ** unit)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function enqueueMessage({ added, alreadyQueued, unavailable }) {
    const messages = [];
    if (added) messages.push(`已安排取回 ${number.format(added)} 项`);
    if (alreadyQueued) messages.push(`${number.format(alreadyQueued)} 项已在队列中`);
    if (unavailable) messages.push(`${number.format(unavailable)} 项无可取回的原件`);
    return `${messages.join('，') || '当前没有新增取回任务'}。`;
  }

  window.createJianCangCloudOriginals = ({ bridge, getLibraries, notify = () => {}, onFinished = () => {} }) => {
    let selected = [];
    let batch = null;
    let libraryId = '';
    let snapshot = null;
    let offset = 0;
    let view = 0;
    let working = false;
    let fetching = false;
    let refreshQueued = false;
    let refreshTimer;
    let rows = new Map();

    const dialog = element('dialog', 'cloud-originals-dialog');
    dialog.id = 'cloud-originals-dialog';
    dialog.setAttribute('aria-labelledby', 'cloud-originals-title');
    const header = element('div', 'dialog-head');
    const title = element('h2', '', '取回云端原件');
    title.id = 'cloud-originals-title';
    const close = button('×', 'icon-button', () => dialog.close());
    close.setAttribute('aria-label', '关闭取回原件');
    header.append(title, close);

    const body = element('div', 'cloud-originals-body');
    const source = element('label', 'cloud-originals-scope');
    const sourceLabel = element('span', '', '素材库');
    const library = element('select', 'cloud-originals-select');
    library.id = 'cloud-originals-library';
    source.append(sourceLabel, library);
    const primary = button('取回全部原件', 'primary-button', () => {
      if (batch) startBatch();
      else start(selected);
    });
    primary.id = 'cloud-originals-start';
    const all = button('取回全部原件', 'outline-button', () => start([]));
    const startRow = element('div', 'cloud-originals-start-row');
    startRow.append(source, all, primary);
    const help = element('p', 'cloud-originals-hint', '见藏会读取并核对原件。云盘负责保留下载的文件，Windows 之后仍可能释放本机副本。');
    const summary = element('p', 'cloud-originals-hint cloud-originals-batch-summary');
    const enrollment = element('ul', 'cloud-originals-enrollment');
    enrollment.setAttribute('aria-label', '各库入队结果');
    enrollment.setAttribute('aria-live', 'polite');

    const totals = element('section', 'cloud-originals-totals');
    const overview = element('div', 'cloud-originals-overview');
    const heading = element('strong');
    const size = element('span', 'cloud-originals-size');
    overview.append(heading, size);
    const progress = element('progress', 'cloud-originals-progress');
    progress.max = 1;
    progress.setAttribute('aria-label', '原件取回进度');
    const stateLine = element('p', 'cloud-originals-states');
    stateLine.setAttribute('role', 'status');
    totals.append(overview, progress, stateLine);

    const toolbar = element('div', 'cloud-originals-toolbar');
    const taskFilter = element('select', 'cloud-originals-select');
    taskFilter.id = 'cloud-originals-filter';
    taskFilter.setAttribute('aria-label', '筛选取回任务状态');
    for (const [id, text] of [['all', '全部状态'], ...Object.entries(statusLabels)]) taskFilter.add(new Option(text, id));
    const pause = button('暂停取回', 'outline-button', () => {
      if (snapshot) void command(() => bridge.pauseCloudOriginals(libraryId, !snapshot.paused));
    });
    pause.id = 'cloud-originals-pause';
    const retryAll = button('重试全部失败项', 'outline-button', () => {
      void command(() => bridge.retryCloudOriginal(libraryId, {}), '已安排重试失败任务。');
    });
    retryAll.id = 'cloud-originals-retry-all';
    const copy = button('复制失败清单', 'outline-button', () => {
      void command(() => bridge.copyCloudOriginalFailures(libraryId), '已复制失败清单。');
    });
    toolbar.append(taskFilter, pause, retryAll, copy);

    const notice = element('p', 'cloud-originals-notice');
    notice.setAttribute('role', 'status');
    const list = element('ul', 'cloud-originals-items');
    list.id = 'cloud-originals-items';
    list.setAttribute('aria-label', '取回任务');
    const empty = element('p', 'cloud-originals-empty');
    const footer = element('footer', 'cloud-originals-footer');
    const clear = button('清理已完成记录', 'outline-button', () => {
      if (snapshot?.done && !working && !confirmation.open) confirmation.showModal();
    });
    const pager = element('div', 'cloud-originals-pager');
    const pageLabel = element('span');
    const previousPage = button('上一页', 'outline-button', () => goTo(offset - pageSize));
    const nextPage = button('下一页', 'outline-button', () => goTo(offset + pageSize));
    pager.append(previousPage, pageLabel, nextPage);
    footer.append(clear, pager);
    body.append(startRow, summary, help, enrollment, totals, toolbar, notice, list, empty, footer);
    dialog.append(header, body);

    const confirmation = element('dialog', 'cloud-originals-confirm');
    confirmation.setAttribute('aria-labelledby', 'cloud-originals-confirm-title');
    const confirmationHeader = element('div', 'dialog-head');
    const confirmationTitle = element('h2', '', '清理已完成记录？');
    confirmationTitle.id = 'cloud-originals-confirm-title';
    confirmationHeader.append(confirmationTitle);
    const confirmationBody = element('div', 'local-intake-body');
    confirmationBody.append(element('p', '', '只会清理取回队列里已完成的记录。原件仍保存在原位置。'));
    const confirmationActions = element('div', 'local-intake-actions');
    confirmationActions.append(button('取消', 'outline-button', () => confirmation.close()), button('清理', 'primary-button', () => {
      confirmation.close();
      void command(() => bridge.clearCloudOriginalHistory(libraryId), '已清理完成记录。');
    }));
    confirmationBody.append(confirmationActions);
    confirmation.append(confirmationHeader, confirmationBody);
    document.body.append(dialog, confirmation);

    function feedback(text = '', error = false, origin = '') {
      setText(notice, text);
      notice.hidden = !text;
      notice.classList.toggle('is-error', error);
      notice.dataset.origin = origin;
    }

    function controls() {
      const active = !!(snapshot?.pending || snapshot?.running);
      const canStart = !!libraryId && !!snapshot && !working;
      library.disabled = !libraryId || working;
      primary.disabled = batch ? working : !canStart || (active && !selected.length);
      all.disabled = !canStart || active;
      all.hidden = !batch && !selected.length;
      setText(all, batch ? '取回此库全部原件' : '取回全部原件');
      setText(sourceLabel, batch ? '查看素材库队列' : '素材库');
      const failed = batch?.failures.size || 0;
      const selectedCount = batch?.count ?? selected.length;
      setText(primary, failed ? `重试 ${number.format(failed)} 个库入队` : selectedCount ?
        `取回所选 ${number.format(selectedCount)} 项` : '取回全部原件');
      pause.disabled = working || !snapshot || (!active && !snapshot.paused);
      setText(pause, snapshot?.paused ? '恢复取回' : '暂停取回');
      retryAll.disabled = working || !snapshot?.failed;
      copy.hidden = typeof bridge.copyCloudOriginalFailures !== 'function' || !snapshot?.failed;
      copy.disabled = working;
      clear.hidden = typeof bridge.clearCloudOriginalHistory !== 'function' || !snapshot?.done;
      clear.disabled = working;
      taskFilter.disabled = !snapshot?.total;
      toolbar.hidden = !snapshot?.total && !snapshot?.paused;
      totals.hidden = !snapshot?.total;
      footer.hidden = clear.hidden && pager.hidden;
      for (const row of rows.values()) row.retry.disabled = row.remove.disabled = working;
    }

    function taskRow(task) {
      const item = element('li', 'cloud-originals-task');
      const rowName = element('strong', 'cloud-originals-filename');
      const detail = element('p', 'cloud-originals-task-detail');
      const rowProgress = element('progress', 'cloud-originals-progress cloud-originals-task-progress');
      rowProgress.max = 1;
      const meta = element('div', 'cloud-originals-task-meta');
      meta.append(rowName, detail, rowProgress);
      const retry = button('重试', 'outline-button', () => {
        void command(() => bridge.retryCloudOriginal(libraryId, { id: task.id }), '已安排重试这项原件。');
      });
      retry.dataset.cloudOriginalId = task.id;
      const remove = button('取消任务', 'outline-button', () => {
        void command(() => bridge.removeCloudOriginalTask(libraryId, task.id), ({ removedStatus }) => {
          if (removedStatus === 'failed') return '已移除此失败记录。';
          if (removedStatus) return '已取消见藏中的取回任务。';
          return '这项任务已完成或已移除。';
        });
      });
      remove.dataset.cloudOriginalCancelId = task.id;
      const actions = element('div', 'cloud-originals-task-actions');
      actions.append(retry, remove);
      item.append(meta, actions);
      return { item, rowName, detail, progress: rowProgress, retry, remove };
    }

    function renderTasks(tasks) {
      const incoming = new Map();
      for (const task of tasks) {
        const row = rows.get(task.id) ?? taskRow(task);
        incoming.set(task.id, row);
        const running = task.status === 'running';
        const failed = task.status === 'failed';
        const label = `${task.name}`;
        const labelStatus = snapshot.paused && task.status === 'pending' ? '等待恢复' : statusLabels[task.status];
        const amount = running && task.byteCount > 0 ? `${bytes(task.downloadedBytes)} / ${bytes(task.byteCount)}` : '';
        row.item.classList.toggle('is-failed', failed);
        setText(row.rowName, label);
        row.rowName.title = label;
        setText(row.detail, (failed && task.message) || [labelStatus, amount].filter(Boolean).join(' · '));
        row.progress.hidden = !running;
        row.progress.setAttribute('aria-label', `取回 ${label}`);
        if (running && task.byteCount > 0) row.progress.value = Math.min(1, Math.max(0, task.downloadedBytes / task.byteCount));
        else row.progress.removeAttribute('value');
        row.retry.hidden = !failed;
        row.retry.setAttribute('aria-label', `重试 ${label}`);
        const removeLabel = failed ? '移除记录' : '取消任务';
        row.remove.hidden = task.status === 'done';
        setText(row.remove, removeLabel);
        row.remove.setAttribute('aria-label', `${removeLabel} ${label}`);
      }
      for (const [id, row] of rows) if (!incoming.has(id)) row.item.remove();
      let index = 0;
      for (const row of incoming.values()) {
        const next = list.children[index++];
        if (next !== row.item) list.insertBefore(row.item, next || null);
      }
      rows = incoming;
    }

    function render() {
      const done = snapshot?.done || 0;
      const total = snapshot?.total || 0;
      const totalBytes = snapshot?.totalBytes || 0;
      const downloadedBytes = snapshot?.downloadedBytes || 0;
      setText(heading, `已取回 ${number.format(done)} / ${number.format(total)} 项`);
      setText(size, totalBytes > 0 ? `${bytes(downloadedBytes)} / ${bytes(totalBytes)}` : '');
      progress.value = Math.min(1, Math.max(0, totalBytes > 0 ? downloadedBytes / totalBytes : total ? done / total : 0));
      setText(stateLine, [snapshot?.paused && '已暂停', snapshot?.running && `${number.format(snapshot.running)} 项取回中`,
        snapshot?.pending && `${number.format(snapshot.pending)} 项等待`, snapshot?.failed && `${number.format(snapshot.failed)} 项失败`]
        .filter(Boolean).join(' · ') || '本次任务已处理完毕');
      stateLine.classList.toggle('has-failures', !!snapshot?.failed);
      const focusedAction = list.contains(document.activeElement) ? document.activeElement : null;
      const tasks = snapshot?.tasks || [];
      renderTasks(tasks);
      list.hidden = !tasks.length;
      empty.hidden = !!tasks.length;
      setText(empty, !libraryId ? '请先添加见藏同步库或 Eagle 库。' : !snapshot ? '正在读取取回记录…' : total ?
        '当前筛选范围没有任务。' : '暂无取回任务。');
      const filteredTotal = snapshot?.filteredTotal || 0;
      pager.hidden = filteredTotal <= pageSize;
      setText(pageLabel, `${number.format(Math.floor(offset / pageSize) + 1)} / ${number.format(Math.ceil(filteredTotal / pageSize))} 页`);
      previousPage.disabled = offset === 0;
      nextPage.disabled = offset + pageSize >= filteredTotal;
      controls();
      if (focusedAction && (!list.contains(focusedAction) || focusedAction.hidden)) {
        (total ? taskFilter : primary).focus();
      }
    }

    async function refresh() {
      refreshQueued = true;
      if (fetching) return;
      fetching = true;
      try {
        while (refreshQueued && dialog.open && libraryId) {
          refreshQueued = false;
          const generation = view;
          const id = libraryId;
          let result;
          try { result = await bridge.cloudOriginalStatus(id, { filter: taskFilter.value, offset, limit: pageSize }); }
          catch { result = null; }
          if (generation !== view || !dialog.open) continue;
          if (!result?.ok) {
            feedback(result?.message || '无法读取取回记录，请重新打开。', true, 'status');
            setText(empty, '取回记录暂不可用。');
            continue;
          }
          if (offset && offset >= result.filteredTotal) {
            offset = Math.max(0, Math.floor((result.filteredTotal - 1) / pageSize) * pageSize);
            refreshQueued = true;
            continue;
          }
          const wasActive = snapshot?.pending || snapshot?.running;
          const doneBefore = snapshot?.done || 0;
          snapshot = result;
          if (notice.dataset.origin === 'status') feedback();
          render();
          if (wasActive && !snapshot.pending && !snapshot.running && snapshot.done > doneBefore) onFinished(id);
        }
      } finally { fetching = false; }
    }

    function goTo(nextOffset) {
      offset = Math.max(0, nextOffset);
      view += 1;
      list.scrollTop = 0;
      void refresh();
    }

    async function command(perform, message) {
      if (working || !libraryId) return;
      const id = libraryId;
      working = true;
      feedback();
      controls();
      try {
        const result = await perform();
        if (!result?.ok) throw new Error(result?.message || '这项操作未完成，请重试。');
        if (message && dialog.open && id === libraryId) feedback(typeof message === 'function' ? message(result) : message);
      } catch (error) {
        if (dialog.open && id === libraryId) feedback(error?.message || '这项操作未完成，请重试。', true);
        else notify('取回任务操作未完成。');
      } finally {
        working = false;
        controls();
        void refresh();
      }
    }

    function start(ids) {
      void command(() => bridge.startCloudOriginals(libraryId, ids.length ? { ids } : {}), enqueueMessage);
    }

    function renderEnrollment() {
      summary.hidden = !batch;
      if (batch) {
        const skipped = batch.skipped ? `。另有 ${number.format(batch.skipped)} 项不适用取回，已跳过` : '';
        setText(summary, `已选 ${number.format(batch.count)} 项，来自 ${number.format(batch.groups.length)} 个素材库${skipped}。`);
      }
      enrollment.hidden = !batch?.results.size;
      enrollment.replaceChildren(...(batch?.groups ?? []).flatMap(({ id, name }) => {
        const result = batch.results.get(id);
        if (!result) return [];
        const row = element('li', result.ok ? '' : 'is-error');
        row.append(element('strong', '', name), element('span', '', result.ok ? enqueueMessage(result) : result.message));
        return [row];
      }));
    }

    function startBatch() {
      const plan = batch;
      if (!plan || working) return;
      const groups = plan.failures.size ? plan.groups.filter(group => plan.failures.has(group.id)) : plan.groups;
      void command(async () => {
        await Promise.all(groups.map(async ({ id, ids }) => {
          let result;
          try { result = await bridge.startCloudOriginals(id, { ids }); }
          catch { result = null; }
          if (result?.ok) {
            plan.results.set(id, result);
            plan.failures.delete(id);
          } else {
            plan.results.set(id, { ok: false, message: result?.message || '无法将所选原件加入队列，请重试。' });
            plan.failures.add(id);
          }
          if (dialog.open && plan === batch) renderEnrollment();
        }));
        if (!dialog.open || plan !== batch) {
          notify(plan.failures.size ? `${number.format(plan.failures.size)} 个库未能添加取回任务。` : '已检查所选原件的取回队列。');
        }
        return { ok: true };
      });
    }

    library.addEventListener('change', () => {
      libraryId = library.value;
      selected = [];
      snapshot = null;
      taskFilter.value = 'all';
      feedback();
      render();
      goTo(0);
    });
    taskFilter.addEventListener('change', () => goTo(0));
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      view += 1;
      clearTimeout(refreshTimer);
      refreshTimer = null;
    });
    bridge.onCloudOriginalChange(id => {
      if (id !== libraryId || !dialog.open) return;
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refresh();
      }, 65);
    });

    function open(registrationId, { ids, groups = new Map(), skipped = 0 } = {}) {
      const sources = getLibraries();
      const preferred = sources.find(item => item.id === registrationId) || sources.find(item => item.id === libraryId) || sources[0];
      library.replaceChildren(...sources.map(item => new Option(`${item.name}${item.kind === 'eagle' ? '（Eagle）' : ''}`, item.id)));
      libraryId = preferred?.id || '';
      library.value = libraryId;
      const grouped = [...groups].map(([id, ids]) => ({ id, ids: [...new Set(ids)], name: sources.find(item => item.id === id)?.name || '素材库' }));
      batch = grouped.length && (grouped.length > 1 || skipped) ? {
        groups: grouped, count: grouped.reduce((sum, group) => sum + group.ids.length, 0), skipped,
        results: new Map(), failures: new Set(),
      } : null;
      selected = batch ? [] : grouped.find(group => group.id === libraryId)?.ids ||
        (registrationId === libraryId && Array.isArray(ids) ? [...new Set(ids)] : []);
      snapshot = null;
      taskFilter.value = 'all';
      feedback();
      renderEnrollment();
      render();
      if (!dialog.open) dialog.showModal();
      goTo(0);
    }

    return { open };
  };
})();
