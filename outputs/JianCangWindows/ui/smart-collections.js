'use strict';

(() => {
  const key = 'jiancang.smart-collections.v1';
  const maximum = 100;
  const sections = new Set(['all', 'favorites', 'unfiled', 'untagged', 'recent', 'trash', 'collection']);
  const kinds = new Set(['all', 'image', 'video', 'audio', 'pdf', 'document', 'link']);
  const sorts = new Set(['recent', 'name', 'format', 'dimensions', 'rating', 'size', 'date']);
  const studio = window.jiancangStudioDocuments;
  const text = (value, size) => typeof value === 'string' ? value.trim().slice(0, size) : '';
  const canonicalName = value => value.normalize('NFKC').toLowerCase();

  function criteria(value) {
    if (!value || !sections.has(value.section)) return null;
    const advanced = value.advanced || {};
    return {
      section: value.section,
      scopeId: text(value.scopeId, 64) || null,
      collectionId: text(value.collectionId, 200) || null,
      query: text(value.query, 512),
      searchField: window.jiancangSearchField(value.searchField),
      kind: kinds.has(value.kind) ? value.kind : 'all',
      sort: sorts.has(value.sort) ? value.sort : 'recent',
      reverseSort: value.reverseSort === true,
      advanced: {
        format: text(advanced.format, 32), aspect: text(advanced.aspect, 32), rating: text(advanced.rating, 1),
        ...window.normalizeJianCangAssetProperties(advanced),
        from: text(advanced.from, 10), to: text(advanced.to, 10),
        tags: Array.isArray(advanced.tags) ? advanced.tags.slice(0, 100).map(tag => text(tag, 160)).filter(Boolean) : [],
      },
      visual: window.normalizeJianCangVisualFilters(value.visual),
    };
  }

  function read() {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || '[]');
      if (!Array.isArray(raw)) return [];
      const ids = new Set();
      return raw.slice(0, maximum).flatMap(item => {
        if (!/^[\da-f-]{36}$/i.test(item?.id) || ids.has(item.id)) return [];
        const name = text(item.name, 80);
        const filter = criteria(item.criteria);
        if (!name || !filter) return [];
        ids.add(item.id);
        return [{ id: item.id, name, criteria: filter }];
      });
    } catch { return []; }
  }

  function element(tag, attrs = {}, content) {
    const value = document.createElement(tag);
    for (const [name, setting] of Object.entries(attrs)) value.setAttribute(name, setting);
    if (content) value.textContent = content;
    return value;
  }

  function labeled(label, control) {
    const field = element('label', { class: 'intake-field' }, label);
    field.append(control);
    return field;
  }

  function select(options, value) {
    const control = element('select');
    for (const [key, label] of options) control.append(element('option', { value: key }, label));
    control.value = value;
    return control;
  }

  const modes = [['all', '全部满足'], ['any', '任意满足']];
  const orientations = new Map([['any', '不限'], ['portrait', '竖图'], ['landscape', '横图'], ['square', '方图']]);
  const kindNames = new Map([['', '所有素材'], ['image', '图片'], ['video', '视频'], ['audio', '音频'],
    ['pdf', 'PDF'], ['document', '其他文件'], ['link', '链接']]);

  function sharedFilterFromCriteria(filter, title = '') {
    if (!filter || !['all', 'untagged', 'favorites'].includes(filter.section) || filter.collectionId
      || filter.searchField !== 'all' || Object.values(filter.visual ?? {}).some(value => Array.isArray(value) ? value.length : !!value)
      || Object.entries(filter.advanced).some(([name, value]) => !['aspect', 'rating', 'tags'].includes(name) && !!value)
      || filter.advanced.rating === '0' || !['', 'portrait', 'landscape'].includes(filter.advanced.aspect)) return null;
    const tags = filter.advanced.tags;
    return { title, text: filter.query, kind: filter.kind === 'all' ? null : filter.kind,
      orientation: filter.advanced.aspect || 'any', recentDays: null, untagged: filter.section === 'untagged',
      minRating: Number(filter.advanced.rating || 0), favoritesOnly: filter.section === 'favorites', match: 'all',
      groups: tags.length ? [{ match: 'all', rules: tags.map(tag => ({ field: 'tagIncluded', tag })) }] : [] };
  }

  const emptyFilter = () => ({ title: '', text: '', kind: null, orientation: 'any', recentDays: null, untagged: false,
    minRating: 0, favoritesOnly: false, match: 'all', groups: [] });

  function localDateInput(value) {
    if (value == null) return '';
    const date = new Date(value * 1000);
    return new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
  }

  function dateText(value) { return value == null ? '不限' : new Date(value * 1000).toLocaleString(); }

  function describeShared(filter, library) {
    const entries = [['资料库', library.name]];
    if (filter.text) entries.push(['关键词', filter.text]);
    if (filter.kind) entries.push(['类型', kindNames.get(filter.kind)]);
    if (filter.orientation !== 'any') entries.push(['方向', orientations.get(filter.orientation)]);
    if (filter.recentDays != null) entries.push(['添加时间', `最近 ${filter.recentDays} 天`]);
    if (filter.minRating) entries.push(['评分', `${filter.minRating} 星及以上`]);
    if (filter.favoritesOnly) entries.push(['收藏', '仅收藏']);
    if (filter.untagged) entries.push(['标签', '仅未标注']);
    filter.groups.forEach((group, index) => {
      const values = group.rules.map(({ field, tag, min, max }) => {
        const format = field === 'importedAt' ? dateText : value => value == null ? '不限' : String(value);
        return `${studio.ruleFields.get(field)} ${tag ?? `${format(min)} 至 ${format(max)}`}`;
      });
      entries.push([`第 ${index + 1} 组（${group.match === 'all' ? '全部' : '任意'}）`, values.join('、')]);
    });
    return entries;
  }

  window.createJianCangSmartCollections = ({ list, capture, apply, describe, onChange, notify, makeRow, bridge, getLibraries, recognizedText }) => {
    let items = read();
    let activeId = null;
    let synced = new Map();
    let refreshing;
    let pollTimer;
    let revision = 0;
    const dialog = element('dialog', { class: 'local-intake-dialog smart-collection-dialog', 'aria-labelledby': 'smart-dialog-title' });
    const title = element('h2', { id: 'smart-dialog-title' });
    const close = element('button', { type: 'button', class: 'icon-button', 'aria-label': '关闭' }, '×');
    const header = element('div', { class: 'dialog-head' });
    const body = element('div', { class: 'local-intake-body' });
    let savingShared = false;
    header.append(title, close);
    dialog.append(header, body);
    document.body.append(dialog);
    close.addEventListener('click', () => { if (!savingShared) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (savingShared) event.preventDefault(); });

    const rows = () => [...items, ...synced.values()];

    function libraries() {
      if (!studio || typeof bridge?.studioList !== 'function' || typeof bridge?.studioWrite !== 'function') return [];
      return getLibraries().filter(entry => entry.kind === 'jiancang' && entry.format === 6 && entry.status === 'available');
    }

    function sharedItem(record, library) {
      if (!studio.isID(record.id) || !record.payload) return null;
      const filter = studio.readFilter(record.payload);
      return { id: `studio:${library.id}:${record.id}`, name: filter.title,
        criteria: criteria({ section: 'all', scopeId: library.id }), filter, record, library };
    }

    function refresh() {
      if (refreshing) return refreshing;
      const connected = libraries();
      if (connected.length && !pollTimer) {
        pollTimer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 8000);
      }
      if (!connected.length && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      const captured = revision;
      refreshing = (async () => {
        const changed = new Map();
        for (const library of connected) {
          try {
            const records = await bridge.studioList(library.id, 'filter');
            for (const record of records) {
              try {
                const item = sharedItem(record, library);
                if (item) changed.set(item.id, item);
              } catch { /* Keep unsupported documents in the library. */ }
            }
          } catch {
            for (const [id, previous] of synced) if (previous.library.id === library.id) changed.set(id, previous);
          }
        }
        if (captured !== revision) return;
        const before = synced.get(activeId);
        if (synced.size === changed.size && [...changed].every(([id, item]) => synced.get(id)?.record.token === item.record.token)) return;
        synced = changed;
        if (before && !synced.has(activeId)) activeId = null;
        render();
        if (before) onChange?.();
      })().finally(() => { refreshing = null; });
      return refreshing;
    }

    function save(next) {
      try { localStorage.setItem(key, JSON.stringify(next)); }
      catch { notify('无法保存智能集合，请检查见藏的本机存储。'); return false; }
      items = next;
      return true;
    }

    function show(label, children) {
      dialog.classList.remove('studio-filter-dialog');
      title.textContent = label;
      body.replaceChildren(...children);
      if (!dialog.open) dialog.showModal();
    }

    function activate(item) {
      if (apply(item) === false) return;
      activeId = item.id;
      render();
      onChange?.();
    }

    function duplicateName(name) {
      const names = new Set(items.map(item => canonicalName(item.name)));
      for (let index = 1; ; index++) {
        const suffix = index === 1 ? '（副本）' : `（副本 ${index}）`;
        const candidate = `${text(name, 80 - suffix.length)}${suffix}`;
        if (!names.has(canonicalName(candidate))) return candidate;
      }
    }

    function summary(filter, label) {
      const details = element('dl', { class: 'smart-summary-details' });
      for (const [key, value] of (Array.isArray(filter) ? filter : describe(filter))) details.append(element('dt', {}, key), element('dd', {}, value));
      const result = element('section', { class: 'smart-summary' });
      result.append(element('h3', {}, label), details);
      return result;
    }

    function edit(item, { copy = false } = {}) {
      const editing = item && !copy;
      if (!editing && items.length >= maximum) { notify('智能集合已满，请先移除一个。'); return; }
      const filter = item ? item.criteria : criteria(capture());
      if (!filter) { notify('请进入一个可浏览的素材页再保存。'); return; }
      const label = element('label', { class: 'intake-field' }, '集合名称');
      const input = element('input', { type: 'text', required: '', maxlength: '80', autocomplete: 'off' });
      input.value = copy ? duplicateName(item.name) : item?.name || filter.query;
      label.append(input);
      const actions = element('div', { class: 'local-intake-actions smart-actions' });
      const submit = element('button', { type: 'submit', class: 'primary-button' }, '保存');
      actions.append(submit);
      const error = element('p', { class: 'local-intake-error', role: 'status', hidden: '' });
      const form = element('form', { class: 'smart-fields' });
      form.append(label, summary(filter, item ? '已保存的条件' : '将保存的条件'), error, actions);
      if (!item && libraries().some(library => library.syncWritable)) {
        const cloud = element('button', { type: 'button', class: 'outline-button' }, '新建同步智能集合…');
        cloud.addEventListener('click', () => editShared(null, sharedFilterFromCriteria(filter, input.value)));
        actions.prepend(cloud);
      }
      form.addEventListener('submit', event => {
        event.preventDefault();
        const name = text(input.value, 80);
        if (!name || items.some(row => (!editing || row.id !== item.id) && canonicalName(row.name) === canonicalName(name))) {
          error.textContent = name ? '已有同名智能集合。' : '请输入集合名称。';
          error.hidden = false;
          return;
        }
        const updated = { id: editing ? item.id : crypto.randomUUID(), name, criteria: filter };
        const next = editing ? items.map(row => row.id === item.id ? updated : row) : [...items, updated];
        if (!save(next)) return;
        dialog.close();
        if (!item) activate(updated);
        else {
          render();
          onChange?.();
          if (copy) notify('已复制智能集合。');
          list.querySelector(`[data-smart-collection-id="${updated.id}"] .navigation-button`)?.focus({ preventScroll: true });
        }
      });
      show(copy ? '复制智能集合' : item ? '重命名智能集合' : '保存为智能集合', [form]);
      input.focus();
      input.select();
    }

    function menu(item) {
      if (item.record) { sharedMenu(item); return; }
      const rename = element('button', { type: 'button', class: 'outline-button' }, '重命名');
      rename.addEventListener('click', () => edit(item));
      const copy = element('button', { type: 'button', class: 'outline-button' }, '复制智能集合');
      copy.disabled = items.length >= maximum;
      copy.addEventListener('click', () => edit(item, { copy: true }));
      const remove = element('button', { type: 'button', class: 'outline-button is-local-action' }, '删除智能集合…');
      remove.addEventListener('click', () => {
        const description = element('p', { class: 'sync-write-description' }, '删除已保存的筛选条件。素材会保留在原处。');
        const confirm = element('button', { type: 'button', class: 'primary-button' }, '删除智能集合');
        confirm.addEventListener('click', () => {
          if (!save(items.filter(row => row.id !== item.id))) return;
          if (activeId === item.id) activeId = null;
          dialog.close();
          render();
          onChange?.();
        });
        show(`删除「${item.name}」？`, [description, confirm]);
      });
      const children = [summary(item.criteria, '已保存的条件')];
      const actions = element('div', { class: 'local-intake-actions smart-menu-actions' });
      actions.append(rename, copy);
      if (libraries().some(library => library.syncWritable)) {
        const share = element('button', { type: 'button', class: 'outline-button' }, '复制到同步库…');
        share.addEventListener('click', () => {
          const filter = sharedFilterFromCriteria(item.criteria, item.name);
          if (!filter) { notify('此集合包含当前设备独有的条件。请新建同步智能集合并设置共用条件。'); return; }
          editShared(null, filter);
        });
        actions.append(share);
      }
      const current = activeId === item.id ? criteria(capture()) : null;
      if (current && JSON.stringify(current) !== JSON.stringify(item.criteria)) {
        children.push(summary(current, '当前筛选'));
        const update = element('button', { type: 'button', class: 'outline-button' }, '用当前筛选更新');
        update.addEventListener('click', () => {
          const filter = criteria(capture());
          if (!filter || !save(items.map(row => row.id === item.id ? { ...row, criteria: filter } : row))) return;
          dialog.close();
          notify('已更新这个智能集合的筛选条件。');
        });
        const restore = element('button', { type: 'button', class: 'outline-button' }, '恢复已保存的条件');
        restore.addEventListener('click', () => {
          dialog.close();
          activate(item);
        });
        actions.append(update, restore);
      }
      actions.append(remove);
      show(item.name, [...children, actions]);
    }

    function updateShared(item, record, library) {
      revision++;
      const updated = sharedItem(record, library);
      if (updated) synced.set(updated.id, updated);
      else if (item) synced.delete(item.id);
      if (!updated && activeId === item?.id) activeId = null;
      render();
      onChange?.();
      return updated;
    }

    function sharedMenu(item) {
      const actions = element('div', { class: 'local-intake-actions smart-menu-actions' });
      const editable = libraries().find(library => library.id === item.library.id)?.syncWritable === true;
      const edit = element('button', { type: 'button', class: 'outline-button' }, '编辑同步条件');
      edit.disabled = !editable;
      edit.addEventListener('click', () => editShared(item));
      const remove = element('button', { type: 'button', class: 'outline-button is-local-action' }, '删除同步智能集合…');
      remove.disabled = !editable;
      remove.addEventListener('click', () => {
        const description = element('p', { class: 'sync-write-description' }, '这组条件会从同步库移除。素材会保留在原处。');
        const confirm = element('button', { type: 'button', class: 'primary-button' }, '删除智能集合');
        confirm.addEventListener('click', async () => {
          if (savingShared) return;
          savingShared = confirm.disabled = true;
          try {
            const record = await bridge.studioWrite(item.library.id, 'filter', null, item.record.id, null, item.record.token);
            updateShared(item, record, item.library);
            dialog.close();
          } catch (error) { description.textContent = error.message || '暂时无法删除。'; }
          finally { savingShared = confirm.disabled = false; }
        });
        show(`删除「${item.name}」？`, [description, confirm]);
      });
      actions.append(edit, remove);
      show(item.name, [summary(describeShared(item.filter, item.library), '同步条件'), actions]);
    }

    function editShared(item, initial) {
      const available = libraries().filter(library => library.syncWritable && (!item || library.id === item.library.id));
      if (!available.length) { notify('请先在素材库管理中打开见藏同步库的双向同步。'); return; }
      const draft = structuredClone(item?.filter ?? initial ?? emptyFilter());
      const form = element('form', { class: 'smart-fields' });
      const target = select(available.map(library => [library.id, library.name]), item?.library.id ?? available[0].id);
      target.disabled = !!item;
      const name = element('input', { type: 'text', required: '', maxlength: '80', autocomplete: 'off' });
      name.value = draft.title;
      const keywords = element('input', { type: 'text', maxlength: '512' });
      keywords.value = draft.text;
      const kind = select(kindNames, draft.kind ?? '');
      const orientation = select(orientations, draft.orientation);
      const days = element('input', { type: 'number', min: '1', max: '36500', step: '1', placeholder: '不限' });
      days.value = draft.recentDays ?? '';
      const rating = select([['0', '不限'], ...[1, 2, 3, 4, 5].map(value => [value, `${value} 星及以上`])], draft.minRating);
      const untagged = element('input', { type: 'checkbox' });
      untagged.checked = draft.untagged;
      const favorites = element('input', { type: 'checkbox' });
      favorites.checked = draft.favoritesOnly;
      const fields = element('div', { class: 'studio-filter-grid' });
      fields.append(labeled('类型', kind), labeled('方向', orientation), labeled('最近天数', days), labeled('最低评分', rating));
      const toggles = element('div', { class: 'studio-filter-toggles' });
      for (const [label, input] of [['仅未标注', untagged], ['仅收藏', favorites]]) {
        const wrap = element('label');
        wrap.append(input, document.createTextNode(label));
        toggles.append(wrap);
      }
      const groups = element('div', { class: 'studio-filter-groups' });
      const error = element('p', { class: 'local-intake-error', role: 'status', hidden: '' });
      const submit = element('button', { type: 'submit', class: 'primary-button' }, '保存并同步');
      const actions = element('div', { class: 'local-intake-actions smart-actions' });
      actions.append(submit);

      function ruleRow(group, rule, index) {
        const row = element('div', { class: 'studio-filter-rule' });
        const kind = select(studio.ruleFields, rule.field);
        kind.setAttribute('aria-label', `第 ${index + 1} 条条件`);
        kind.addEventListener('change', () => { group.rules[index] = { field: kind.value }; renderGroups(); });
        row.append(kind);
        if (rule.field === 'tagIncluded' || rule.field === 'tagExcluded') {
          const tag = element('input', { type: 'text', maxlength: '512', placeholder: '完整标签名', 'aria-label': '标签名称' });
          tag.value = rule.tag ?? '';
          tag.addEventListener('input', () => { rule.tag = tag.value.trim(); });
          row.append(tag);
        } else {
          for (const [field, label] of [['min', '最小值'], ['max', '最大值']]) {
            const date = rule.field === 'importedAt';
            const input = element('input', { type: date ? 'datetime-local' : 'number', 'aria-label': label,
              step: date ? '0.001' : '1', ...(!date && { min: rule.field === 'fileSize' ? '0' : '1', placeholder: label }) });
            input.value = date ? localDateInput(rule[field]) : rule[field] ?? '';
            input.addEventListener('input', () => {
              rule[field] = input.value ? (date ? Date.parse(input.value) / 1000 : input.valueAsNumber) : null;
            });
            row.append(input);
          }
        }
        const remove = element('button', { type: 'button', class: 'icon-button', 'aria-label': '移除条件' }, '×');
        remove.addEventListener('click', () => {
          group.rules.splice(index, 1);
          if (!group.rules.length) draft.groups = draft.groups.filter(item => item !== group);
          renderGroups();
        });
        row.append(remove);
        return row;
      }

      function renderGroups() {
        const entries = [];
        if (draft.groups.length > 1) {
          const mode = select(modes, draft.match);
          mode.addEventListener('change', () => { draft.match = mode.value; });
          entries.push(labeled('各条件组之间', mode));
        }
        const count = draft.groups.reduce((sum, group) => sum + group.rules.length, 0);
        draft.groups.forEach((group, index) => {
          const box = element('fieldset', { class: 'studio-filter-group' });
          const mode = select(modes, group.match);
          mode.addEventListener('change', () => { group.match = mode.value; });
          const add = element('button', { type: 'button', class: 'outline-button' }, '添加条件');
          add.disabled = group.rules.length >= 16 || count >= 64;
          add.addEventListener('click', () => { group.rules.push({ field: 'tagIncluded' }); renderGroups(); });
          box.append(element('legend', {}, `第 ${index + 1} 组`), labeled('组内条件', mode),
            ...group.rules.map((rule, index) => ruleRow(group, rule, index)), add);
          entries.push(box);
        });
        const add = element('button', { type: 'button', class: 'outline-button' }, '添加高级条件组');
        add.disabled = draft.groups.length >= 8 || count >= 64;
        add.addEventListener('click', () => {
          draft.groups.push({ match: 'all', rules: [{ field: 'tagIncluded' }] });
          renderGroups();
        });
        groups.replaceChildren(...entries, add);
      }
      renderGroups();
      form.append(labeled('同步资料库', target), labeled('集合名称', name), labeled('关键词', keywords), fields, toggles, groups, error, actions);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (savingShared) return;
        savingShared = submit.disabled = true;
        error.hidden = true;
        try {
          const library = available.find(item => item.id === target.value);
          const filter = studio.readFilter({ ...draft, title: name.value, text: keywords.value, kind: kind.value || null,
            orientation: orientation.value, recentDays: days.value ? days.valueAsNumber : null,
            minRating: Number(rating.value), untagged: untagged.checked, favoritesOnly: favorites.checked });
          const record = await bridge.studioWrite(library.id, 'filter', null, item?.record.id ?? crypto.randomUUID(),
            JSON.stringify(filter), item?.record.token ?? null);
          const updated = updateShared(item, record, library);
          dialog.close();
          if (!item && updated) activate(updated);
          notify('已保存到同步库。');
        } catch (problem) {
          error.textContent = problem.message || '暂时无法保存同步条件。';
          error.hidden = false;
        } finally { savingShared = submit.disabled = false; }
      });
      show(item ? '编辑同步智能集合' : '新建同步智能集合', [form]);
      dialog.classList.add('studio-filter-dialog');
      name.focus();
    }

    function render() {
      const all = rows();
      list.replaceChildren(...all.map(item => makeRow(item, item.id === activeId, () => activate(item), () => menu(item))));
      list.hidden = all.length === 0;
    }

    return {
      create() {
        const current = synced.get(activeId);
        if (current) editShared(null, { ...current.filter, title: '' });
        else edit();
      },
      render, refresh,
      matcher() {
        const active = synced.get(activeId);
        if (!active) return null;
        const matches = studio.prepareFilter(active.filter);
        return asset => matches(asset, () => recognizedText?.(asset) ?? '');
      },
      clear() { if (activeId) { activeId = null; render(); } },
      restoreActive(id) {
        const next = rows().some(item => item.id === id) ? id : null;
        if (next !== activeId) { activeId = next; render(); }
        return activeId !== null;
      },
      get active() { return synced.get(activeId) ?? items.find(item => item.id === activeId) ?? null; },
    };
  };
})();
