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
  const maximumRules = 24;
  const dayMs = 86400000;

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
        return [{ id: item.id, name, criteria: filter, ...storedConditions(item.conditions) }];
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
  const textOperators = [['contains', '包含'], ['equals', '等于'], ['excludes', '不包含']];
  const numberOperators = [['atLeast', '大于等于'], ['atMost', '小于等于'], ['equals', '等于']];
  const dateOperators = [['within', '最近几天'], ['atLeast', '在这天或之后'], ['before', '早于']];
  const setOperators = [['equals', '是'], ['excludes', '不是']];
  const choices = {
    name: { label: '素材名称', operators: textOperators },
    tag: { label: '标签', operators: [['equals', '包含该标签'], ['excludes', '不含该标签'], ['empty', '没有标签']] },
    kind: { label: '类型', operators: setOperators, options: [...kindNames].slice(1) },
    extension: { label: '文件格式', operators: setOperators, placeholder: '例如 mp4' },
    note: { label: '备注', operators: textOperators },
    rating: { label: '评分', operators: numberOperators, options: ['未评分', '1 星', '2 星', '3 星', '4 星', '5 星'].map((label, index) => [String(index), label]) },
    favorite: { label: '收藏', operators: [['equals', '状态为']], options: [['yes', '已收藏'], ['no', '未收藏']] },
    importedAt: { label: '添加日期', operators: dateOperators },
    duration: { label: '时长（秒）', operators: numberOperators, min: 0, max: 31536000, step: 'any' },
    byteCount: { label: '大小（MB）', operators: numberOperators, min: 0, max: 10 ** 8, step: 'any' },
    width: { label: '宽度（像素）', operators: numberOperators, min: 1, max: 100000 },
    height: { label: '高度（像素）', operators: numberOperators, min: 1, max: 100000 },
  };

  function ruleValue(field, operator) {
    const choice = choices[field];
    if (field !== 'importedAt') return choice;
    return operator === 'within' ? { min: 1, max: 36500, placeholder: '天数' } : { date: true };
  }

  function normalizeRule(rule) {
    if (!rule || !Object.hasOwn(choices, rule.field)) return null;
    const { field, operator } = rule;
    if (!choices[field].operators.some(([key]) => key === operator)) return null;
    if (operator === 'empty') return { field, operator, value: '' };
    const control = ruleValue(field, operator);
    let value = text(rule.value, 160);
    if (field === 'extension') {
      value = canonicalName(value).replace(/^\./, '');
      if (!/^[a-z\d]{1,16}$/.test(value)) return null;
    }
    if (control.options && !control.options.some(([key]) => key === value)) return null;
    if (control.min !== undefined && (!value || !Number.isFinite(Number(value)) || Number(value) < control.min ||
      Number(value) > control.max || (control.step !== 'any' && !Number.isInteger(Number(value))))) return null;
    if (control.date && (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) return null;
    return value ? { field, operator, value } : null;
  }

  function storedConditions(value) {
    if (!Array.isArray(value?.rules)) return {};
    const rules = value.rules.slice(0, maximumRules).map(normalizeRule).filter(Boolean);
    return rules.length ? { conditions: { match: value.match === 'any' ? 'any' : 'all', rules } } : {};
  }

  const stringValue = value => typeof value === 'string' ? canonicalName(value) : '';

  function conditionPredicate({ field, operator, value }, now, favorite) {
    if (field === 'tag') {
      if (operator === 'empty') return asset => !asset.tags.length;
      const expected = canonicalName(value);
      return asset => asset.tags.some(tag => stringValue(tag) === expected) !== (operator === 'excludes');
    }
    if (field === 'favorite') return asset => Boolean(favorite(asset)) === (value === 'yes');
    if (field === 'importedAt') {
      const boundary = operator === 'within' ? now - Number(value) * dayMs : Date.parse(`${value}T00:00:00`);
      return asset => {
        const time = Date.parse(asset.importedAt);
        return Number.isFinite(time) && (operator === 'before' ? time < boundary : time >= boundary);
      };
    }
    if (choices[field].operators === numberOperators) {
      const expected = Number(value) * (field === 'byteCount' ? 1024 ** 2 : 1);
      return asset => {
        const actual = field === 'rating' ? asset.rating ?? 0 : asset[field];
        return Number.isFinite(actual) && (operator === 'equals' ? actual === expected
          : operator === 'atLeast' ? actual >= expected : actual <= expected);
      };
    }
    const expected = canonicalName(value);
    return asset => {
      const actual = field === 'kind' && asset.extension === 'livp' ? 'image' : stringValue(asset[field]);
      if (operator === 'contains') return actual.includes(expected);
      if (operator === 'equals') return actual === expected;
      return choices[field].operators === textOperators ? !actual.includes(expected) : actual !== expected;
    };
  }

  function prepareConditions(conditions, favorite) {
    if (!conditions?.rules.length) return null;
    const now = Date.now();
    const predicates = conditions.rules.map(rule => conditionPredicate(rule, now, favorite));
    return conditions.match === 'any'
      ? asset => predicates.some(test => test(asset)) : asset => predicates.every(test => test(asset));
  }

  const scopeFields = ({ section, scopeId, collectionId }) => ({ section, scopeId, collectionId });

  function describeConditions(conditions) {
    if (!conditions) return [];
    return [[conditions.match === 'any' ? '任意满足' : '全部满足', conditions.rules.map(({ field, operator, value }) => {
      const choice = choices[field];
      const action = choice.operators.find(([key]) => key === operator)[1];
      const expected = choice.options?.find(([key]) => key === value)?.[1] ?? value;
      return [choice.label, action, operator === 'within' ? `${expected} 天` : expected].filter(Boolean).join(' ');
    }).join('；')]];
  }

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

  window.createJianCangSmartCollections = ({ list, capture, apply, describe, onChange, notify, makeRow, bridge, getLibraries,
    recognizedText, getCountScope, favorite = asset => asset.favorite }) => {
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
      dialog.classList.remove('studio-filter-dialog', 'smart-rules-dialog');
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
      if (label) result.append(element('h3', {}, label));
      result.append(details);
      return result;
    }

    function edit(item, { copy = false } = {}) {
      const editing = item && !copy;
      if (!editing && items.length >= maximum) { notify('智能集合已满，请先移除一个。'); return; }
      const current = criteria(capture());
      const filter = item?.criteria ?? current;
      if (!filter) { notify('请进入一个可浏览的素材页再保存。'); return; }
      const input = element('input', { type: 'text', required: '', maxlength: '80', autocomplete: 'off' });
      input.value = copy ? duplicateName(item.name) : item?.name || filter.query;
      const owner = filter.scopeId || filter.collectionId?.replace(/^library:/, '').split(':', 1)[0];
      const allSources = { section: 'all', scopeId: null, collectionId: null };
      const scopes = [...new Map([filter, current, { ...allSources, scopeId: owner || null }, allSources]
        .filter(Boolean).map(value => {
          const scope = scopeFields(value);
          return [JSON.stringify(scope), scope];
        })).values()];
      const scope = select(scopes.map((value, index) => [String(index), describe({ ...filter, ...value })[0][1]]), '0');
      const identity = element('div', { class: 'smart-identity' });
      identity.append(labeled('集合名称', input), labeled('查找范围', scope));

      const legacy = describe(filter).slice(1).filter(([label]) => label !== '排序');
      const retain = element('input', { type: 'checkbox' });
      retain.checked = true;
      const inherited = element('div', { class: 'smart-inherited' });
      const inheritedToggle = element('label', {}, '保留原筛选');
      inheritedToggle.prepend(retain);
      inherited.append(inheritedToggle, summary(legacy));
      inherited.hidden = legacy.length === 0;

      const group = element('fieldset', { class: 'smart-rules' });
      const mode = select(modes, item?.conditions?.match ?? 'all');
      const rules = (item?.conditions?.rules ?? []).map(rule => ({ ...rule }));
      const ruleList = element('div', { class: 'smart-rule-list' });
      const add = element('button', { type: 'button', class: 'outline-button' }, '添加条件');
      const result = element('output', { class: 'smart-rule-result', 'aria-live': 'polite' });
      const tools = element('div', { class: 'smart-rule-tools' });
      tools.append(add, result);
      group.append(element('legend', {}, '匹配条件'), labeled('满足方式', mode), ruleList, tools);

      const actions = element('div', { class: 'local-intake-actions smart-actions' });
      const cancel = element('button', { type: 'button', class: 'outline-button' }, '取消');
      cancel.addEventListener('click', () => dialog.close());
      const submit = element('button', { type: 'submit', class: 'primary-button' }, '保存');
      actions.append(cancel, submit);
      const error = element('p', { class: 'local-intake-error', role: 'status', hidden: '' });
      const form = element('form', { class: 'smart-fields' });
      const countScopes = new Map();
      let countTimer;
      function updateCount() {
        clearTimeout(countTimer);
        countTimer = setTimeout(() => {
          if (!dialog.open || !body.contains(form)) return;
          const normalized = rules.map(normalizeRule);
          if (normalized.includes(null)) { result.textContent = '请填写完整条件'; return; }
          if ((legacy.length && retain.checked) || !getCountScope) { result.textContent = ''; return; }
          if (!countScopes.has(scope.value)) countScopes.set(scope.value, getCountScope(scopes[scope.value]));
          const assets = countScopes.get(scope.value);
          const matches = prepareConditions({ match: mode.value, rules: normalized }, favorite);
          result.textContent = assets ? `匹配 ${(matches ? assets.filter(matches).length : assets.length).toLocaleString()} 份素材` : '';
        }, 160);
      }

      function renderRules(focusIndex = -1) {
        const fields = Object.entries(choices).map(([key, choice]) => [key, choice.label]);
        const rows = rules.map((rule, index) => {
          const row = element('div', { class: 'smart-rule' });
          const field = select(fields, rule.field);
          const operator = select(choices[rule.field].operators, rule.operator);
          const valueBox = element('div', { class: 'smart-rule-value' });
          function renderValue() {
            valueBox.replaceChildren();
            if (rule.operator === 'empty') return;
            const option = ruleValue(rule.field, rule.operator);
            const value = option.options ? select(option.options, rule.value) : element('input', option.date ? { type: 'date' }
              : option.min !== undefined ? { type: 'number', min: option.min, max: option.max, step: option.step ?? 1,
                placeholder: option.placeholder ?? '' }
                : { type: 'text', maxlength: 160, placeholder: option.placeholder ?? '', autocomplete: 'off' });
            if (!option.options) value.value = rule.value;
            else if (value.selectedIndex === -1) value.selectedIndex = 0;
            rule.value = value.value;
            value.required = true;
            value.addEventListener(option.options ? 'change' : 'input', () => { rule.value = value.value; updateCount(); });
            valueBox.append(labeled('值', value));
          }
          field.addEventListener('change', () => {
            rule.field = field.value;
            rule.operator = choices[rule.field].operators[0][0];
            rule.value = '';
            operator.replaceChildren(...choices[rule.field].operators.map(([key, label]) => element('option', { value: key }, label)));
            renderValue();
            updateCount();
          });
          operator.addEventListener('change', () => {
            if (rule.field === 'importedAt' && (rule.operator === 'within') !== (operator.value === 'within')) rule.value = '';
            rule.operator = operator.value;
            renderValue();
            updateCount();
          });
          renderValue();
          const remove = element('button', { type: 'button', class: 'icon-button', 'aria-label': `移除第 ${index + 1} 条条件` }, '×');
          remove.addEventListener('click', () => {
            rules.splice(index, 1);
            renderRules(Math.min(index, rules.length - 1));
            if (!rules.length) add.focus();
          });
          row.append(labeled('字段', field), labeled('比较', operator), valueBox, remove);
          return row;
        });
        ruleList.replaceChildren(...rows);
        add.disabled = rules.length >= maximumRules;
        mode.disabled = rules.length < 2;
        if (focusIndex >= 0) rows[focusIndex].querySelector('select').focus();
        updateCount();
      }

      add.addEventListener('click', () => {
        rules.push({ field: 'name', operator: 'contains', value: '' });
        renderRules(rules.length - 1);
      });
      mode.addEventListener('change', updateCount);
      scope.addEventListener('change', updateCount);
      retain.addEventListener('change', () => {
        inherited.lastElementChild.hidden = !retain.checked;
        updateCount();
      });
      const draftFilter = () => criteria({ ...(retain.checked ? filter : { sort: filter.sort, reverseSort: filter.reverseSort }),
        ...scopes[scope.value] });
      form.append(identity, group, inherited, error, actions);
      if (!item && libraries().some(library => library.syncWritable)) {
        const cloud = element('button', { type: 'button', class: 'outline-button' }, '新建同步智能集合…');
        cloud.addEventListener('click', () => {
          if (rules.length) { notify('请先保存本机条件。同步智能集合可单独设置共用条件。'); return; }
          editShared(null, sharedFilterFromCriteria(draftFilter(), input.value));
        });
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
        const normalized = rules.map(normalizeRule);
        if (normalized.includes(null)) {
          error.textContent = '请检查条件中的格式、数值或日期。';
          error.hidden = false;
          return;
        }
        const updated = { id: editing ? item.id : crypto.randomUUID(), name, criteria: draftFilter(),
          ...storedConditions({ match: mode.value, rules: normalized }) };
        const next = editing ? items.map(row => row.id === item.id ? updated : row) : [...items, updated];
        if (!save(next)) return;
        dialog.close();
        if (!item || (editing && activeId === item.id)) activate(updated);
        else {
          render();
          onChange?.();
          if (copy) notify('已复制智能集合。');
          list.querySelector(`[data-smart-collection-id="${updated.id}"] .navigation-button`)?.focus({ preventScroll: true });
        }
      });
      show(copy ? '复制智能集合' : item ? '编辑智能集合' : '新建智能集合', [form]);
      dialog.classList.add('smart-rules-dialog');
      renderRules();
      input.focus();
      input.select();
    }

    function menu(item) {
      if (item.record) { sharedMenu(item); return; }
      const editAction = element('button', { type: 'button', class: 'outline-button' }, '编辑条件…');
      editAction.addEventListener('click', () => edit(item));
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
      const children = [summary([...describe(item.criteria), ...describeConditions(item.conditions)], '已保存的条件')];
      const actions = element('div', { class: 'local-intake-actions smart-menu-actions' });
      actions.append(editAction, copy);
      if (libraries().some(library => library.syncWritable)) {
        const share = element('button', { type: 'button', class: 'outline-button' }, '复制到同步库…');
        share.addEventListener('click', () => {
          const filter = !item.conditions && sharedFilterFromCriteria(item.criteria, item.name);
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
        if (active) {
          const matches = studio.prepareFilter(active.filter);
          return asset => matches(asset, () => recognizedText?.(asset) ?? '');
        }
        return prepareConditions(items.find(item => item.id === activeId)?.conditions, favorite);
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
