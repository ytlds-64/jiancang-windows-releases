'use strict';

(() => {
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const pageSize = 120;
  const tagKey = value => value.normalize('NFKC').trim().toLowerCase();
  const tagUsage = new WeakMap();

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(label, className, click) {
    const node = element('button', className, label);
    node.type = 'button';
    node.addEventListener('click', click);
    return node;
  }

  function collectTags(assets) {
    const cached = tagUsage.get(assets);
    if (cached) return cached;
    const usage = new Map();
    for (const asset of assets) {
      const assetTags = new Set();
      for (const name of asset.tags ?? []) {
        const key = tagKey(name);
        if (!key) continue;
        if (!usage.has(key)) usage.set(key, { key, name, count: 0, trashedCount: 0 });
        const tag = usage.get(key);
        if (name < tag.name) tag.name = name;
        if (!assetTags.has(key)) {
          tag.count++;
          if (asset.trashed) tag.trashedCount++;
          assetTags.add(key);
        }
      }
    }
    const result = [...usage.values()].sort((a, b) => b.count - a.count || collator.compare(a.name, b.name));
    tagUsage.set(assets, result);
    return result;
  }

  function dialogHeader(dialog, id, label, onClose) {
    const title = element('h2', '', label);
    title.id = id;
    dialog.setAttribute('aria-labelledby', title.id);
    const close = button('×', 'icon-button tag-manager-close', onClose);
    close.setAttribute('aria-label', '关闭');
    const header = element('header', 'dialog-head');
    header.append(title, close);
    return { header, close };
  }

  window.createJianCangTagManager = function createJianCangTagManager({ getLibraries, getAssets,
    getCurrentLibraryId, mutate, onFilter, notify }) {
    const dialog = element('dialog', 'tag-manager-dialog');
    const { header } = dialogHeader(dialog, 'tag-manager-title', '标签管理', () => dialog.close());
    const controls = element('section', 'tag-manager-controls');
    const libraryLabel = element('label', 'tag-manager-field', '素材库');
    const library = element('select');
    libraryLabel.append(library);
    const searchLabel = element('label', 'tag-manager-field', '标签');
    const search = element('input');
    search.type = 'search';
    search.placeholder = '搜索标签名称';
    searchLabel.append(search);
    controls.append(libraryLabel, searchLabel);

    const scroll = element('div', 'tag-manager-scroll');
    const table = element('table', 'tag-manager-table');
    table.setAttribute('aria-label', '标签用量');
    const columns = element('thead');
    const head = element('tr');
    const actionsHeading = element('th', 'tag-action-heading', '操作');
    for (const cell of [element('th', '', '标签名称'), element('th', 'tag-count-heading', '使用份数'), actionsHeading]) {
      cell.scope = 'col';
      head.append(cell);
    }
    columns.append(head);
    const rows = element('tbody');
    table.append(columns, rows);
    const empty = element('p', 'tag-manager-empty');
    const more = button('显示更多标签', 'outline-button tag-manager-more', () => {
      limit += pageSize;
      render();
    });
    scroll.append(table, empty, more);
    const summary = element('footer', 'tag-manager-summary');
    summary.setAttribute('role', 'status');
    dialog.append(header, controls, scroll, summary);

    let libraryId = null;
    let limit = pageSize;
    let sourceAssets = null;
    let tags = [];

    function showTag(id, name) {
      dialog.close();
      Promise.resolve().then(() => onFilter(id, name)).catch(problem => notify(problem.message));
    }

    function makeRow(record, entry) {
      const row = element('tr');
      const name = element('td', 'tag-name-cell');
      const filter = button(record.name, 'tag-filter-link', () => showTag(entry.id, record.name));
      filter.title = record.trashedCount === record.count ? '这个标签只出现在回收站' : `按「${record.name}」筛选素材`;
      filter.disabled = record.trashedCount === record.count;
      name.append(filter);
      const count = element('td', 'tag-count-cell', record.count.toLocaleString('zh-CN'));
      if (record.trashedCount) count.title = `回收站中有 ${record.trashedCount} 份`;
      row.append(name, count);
      if (entry.writable) {
        const actions = element('td', 'tag-actions-cell');
        const rename = button('改名或合并', 'tag-row-action', () => edit(record.name, entry, false));
        rename.setAttribute('aria-label', `改名或合并「${record.name}」`);
        const remove = button('删除', 'tag-row-action tag-danger-text', () => edit(record.name, entry, true));
        remove.setAttribute('aria-label', `删除标签「${record.name}」`);
        actions.append(rename, remove);
        row.append(actions);
      }
      return row;
    }

    function render() {
      if (!dialog.open) return;
      const libraries = getLibraries();
      if (!libraries.some(entry => entry.id === libraryId)) libraryId = libraries[0]?.id ?? null;
      const entry = libraries.find(item => item.id === libraryId);
      const libraryOptions = libraries.map(item => new Option(item.name, item.id));
      if (library.options.length !== libraryOptions.length || libraryOptions.some((option, i) =>
        library.options[i].value !== option.value || library.options[i].text !== option.text)) {
        library.replaceChildren(...libraryOptions);
      }
      library.value = libraryId ?? '';
      library.disabled = !entry;
      search.disabled = !entry;

      const nextAssets = entry ? getAssets(entry.id) ?? [] : [];
      if (sourceAssets !== nextAssets) {
        sourceAssets = nextAssets;
        tags = collectTags(nextAssets);
      }
      const query = tagKey(search.value);
      const matching = tags.filter(tag => !query || tagKey(tag.name).includes(query));
      const nextRows = matching.slice(0, limit).map(tag => makeRow(tag, entry));
      const activeRow = rows.contains(document.activeElement) ? [...rows.querySelectorAll('button')].indexOf(document.activeElement) : -1;
      rows.replaceChildren(...nextRows);
      if (activeRow >= 0 && document.activeElement === document.body) {
        (rows.querySelectorAll('button')[activeRow] ?? search).focus({ preventScroll: true });
      }
      actionsHeading.hidden = !entry?.writable;
      table.hidden = matching.length === 0;
      empty.hidden = matching.length !== 0;
      empty.textContent = !entry ? '请先添加素材库。' : query ? '没有匹配的标签。' : '这个素材库还没有标签。';
      more.hidden = matching.length <= limit;
      summary.textContent = !entry ? '' : `${matching.length.toLocaleString('zh-CN')} 个标签${entry.writable ? '' : ' · 只读库可按标签筛选'}`;
    }

    function edit(from, entry, removing) {
      const review = element('dialog', 'tag-manager-review');
      let working = false;
      let plan = null;
      const { header: reviewHeader, close } = dialogHeader(review, 'tag-review-title', removing ? '删除标签' : '改名或合并标签', () => review.close());
      const body = element('form', 'tag-review-body');
      const original = element('p', 'tag-review-original');
      original.append(element('span', '', '当前标签'), element('strong', '', from));
      body.append(original);

      const target = element('input');
      if (!removing) {
        const field = element('label', 'tag-manager-field', '新标签名称');
        target.type = 'text';
        target.value = from;
        target.maxLength = 256;
        target.setAttribute('list', 'tag-merge-options');
        const names = element('datalist');
        names.id = 'tag-merge-options';
        names.append(...tags.filter(tag => tagKey(tag.name) !== tagKey(from)).slice(0, 120).map(tag => new Option('', tag.name)));
        field.append(target, names);
        body.append(field);
      }

      const previewMessage = element('p', 'tag-review-preview');
      previewMessage.setAttribute('role', 'status');
      const error = element('p', 'tag-review-error');
      error.setAttribute('role', 'alert');
      const footer = element('footer', 'tag-review-actions');
      const cancel = button('取消', 'outline-button', () => review.close());
      const preview = button('预览影响', 'primary-button', () => void requestPlan());
      const apply = button('确认', `primary-button${removing ? ' tag-danger-button' : ''}`, () => void commit());
      apply.hidden = true;
      preview.hidden = removing;
      footer.append(cancel, preview, apply);
      body.append(previewMessage, error, footer);
      body.addEventListener('submit', event => { event.preventDefault(); if (!removing && !plan) void requestPlan(); });
      review.append(reviewHeader, body);
      review.addEventListener('cancel', event => { if (working) event.preventDefault(); });
      review.addEventListener('close', () => review.remove(), { once: true });
      review.addEventListener('keydown', event => event.stopPropagation());
      target.addEventListener('input', () => {
        plan = null;
        error.textContent = '';
        previewMessage.textContent = '';
        apply.hidden = true;
        preview.hidden = false;
      });

      function setWorking(next) {
        working = next;
        for (const control of [close, cancel, target, preview]) control.disabled = working;
        apply.disabled = working || !plan?.count;
        review.setAttribute('aria-busy', String(working));
      }

      async function requestPlan() {
        if (working) return;
        const to = removing ? null : target.value;
        plan = null;
        apply.hidden = true;
        error.textContent = '';
        previewMessage.textContent = '正在计算影响范围…';
        setWorking(true);
        try {
          const proposal = await mutate(entry.id, { action: 'planTagChange', from, to });
          if (!proposal?.ok) throw new Error(proposal?.message ?? '无法预览标签变更。');
          plan = { ...proposal, input: to };
          const count = plan.count.toLocaleString('zh-CN');
          if (!plan.count) previewMessage.textContent = '没有需要更新的素材。';
          else if (removing) previewMessage.textContent = `会从 ${count} 份素材中移除「${from}」。素材文件会保留。`;
          else if (plan.mode === 'merge') previewMessage.textContent = `会把「${from}」合并到「${plan.to}」，影响 ${count} 份素材。`;
          else previewMessage.textContent = `会将「${from}」改为「${plan.to}」，影响 ${count} 份素材。`;
          if (plan.trashedCount) previewMessage.textContent += `其中 ${plan.trashedCount.toLocaleString('zh-CN')} 份在回收站。`;
          apply.textContent = removing ? '确认删除标签' : plan.mode === 'merge' ? '确认合并' : '确认改名';
          apply.hidden = !plan.count;
        } catch (problem) {
          error.textContent = problem.message;
          previewMessage.textContent = '';
          preview.hidden = false;
        } finally {
          setWorking(false);
          if (plan) {
            preview.hidden = true;
            if (!removing) (plan.count ? apply : target).focus();
          }
        }
      }

      async function commit() {
        if (working || !plan?.count) return;
        error.textContent = '';
        setWorking(true);
        try {
          const result = await mutate(entry.id, { action: 'changeTag', from, to: plan.input, revision: plan.revision });
          if (!result?.ok) throw new Error(result?.message ?? '无法更新标签。');
          review.close();
          render();
          notify(result.pending > 0 ? '标签变更已加入同步队列。' : `已更新 ${result.count.toLocaleString('zh-CN')} 份素材的标签。`);
        } catch (problem) {
          plan = null;
          apply.hidden = true;
          preview.hidden = false;
          previewMessage.textContent = '';
          error.textContent = problem.message;
        } finally { setWorking(false); }
      }

      document.body.append(review);
      review.showModal();
      if (removing) void requestPlan();
      else { target.focus(); target.select(); }
    }

    library.addEventListener('change', () => {
      libraryId = library.value;
      limit = pageSize;
      scroll.scrollTop = 0;
      render();
    });
    search.addEventListener('input', () => {
      limit = pageSize;
      scroll.scrollTop = 0;
      render();
    });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    document.body.append(dialog);

    return {
      open() {
        if (!dialog.open) {
          libraryId = getCurrentLibraryId();
          search.value = '';
          limit = pageSize;
          dialog.showModal();
          scroll.scrollTop = 0;
        }
        render();
        if (!search.disabled) search.focus();
      },
      refresh: render,
      suggestions(id, input, current) {
        const query = tagKey(input);
        if (!query) return [];
        const used = new Set(current.map(tagKey));
        const prefix = [];
        const substring = [];
        for (const record of collectTags(getAssets(id))) {
          if (record.count === record.trashedCount || used.has(record.key) || !record.key.includes(query)) continue;
          if (record.key.startsWith(query)) prefix.push(record.name);
          else if (substring.length < 6) substring.push(record.name);
          if (prefix.length === 6) break;
        }
        return prefix.concat(substring).slice(0, 6);
      },
    };
  };
})();
