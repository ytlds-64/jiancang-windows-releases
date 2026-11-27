'use strict';

(() => {
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const aspectOptions = [
    ['', '不限'], ['landscape', '横向'], ['portrait', '纵向'], ['square', '接近方形'],
    ['panorama', '超宽（2∶1 及以上）'], ['tall', '超长（1∶2 及以下）'],
  ];
  const aspectLabels = new Map(aspectOptions);
  const tagDisplayLimit = 100;
  const megabyte = 1024 ** 2;

  function sizeBetween(asset, from, to = Infinity) {
    const size = asset.byteCount;
    return Number.isSafeInteger(size) && (size > 0 || (size === 0 && asset.available === true)) && size >= from && size < to;
  }

  function hasDimensions({ width, height }) {
    return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
  }

  function atLeastResolution({ width, height }, long, short) {
    return Math.max(width, height) >= long && Math.min(width, height) >= short;
  }

  function durationBetween(asset, from, to = Infinity) {
    const duration = asset.duration;
    return Number.isFinite(duration) && duration > 0 && duration >= from && duration < to;
  }

  const propertyFields = [
    { key: 'size', label: '文件大小', choices: [
      ['under-1mb', '小于 1 MB', asset => sizeBetween(asset, 0, megabyte)],
      ['1-10mb', '1 MB 至不足 10 MB', asset => sizeBetween(asset, megabyte, 10 * megabyte)],
      ['10-100mb', '10 MB 至不足 100 MB', asset => sizeBetween(asset, 10 * megabyte, 100 * megabyte)],
      ['100mb-plus', '至少 100 MB', asset => sizeBetween(asset, 100 * megabyte)],
    ] },
    { key: 'resolution', label: '分辨率', fieldLabel: '分辨率（长边 × 短边）', choices: [
      ['under-720p', '低于 1280 × 720', asset => hasDimensions(asset) && !atLeastResolution(asset, 1280, 720)],
      ...[
        ['720p', 1280, 720], ['1080p', 1920, 1080], ['1440p', 2560, 1440], ['4k', 3840, 2160], ['8k', 7680, 4320],
      ].map(([id, long, short]) => [id, `至少 ${long} × ${short}`, asset => hasDimensions(asset) && atLeastResolution(asset, long, short)]),
    ] },
    { key: 'duration', label: '媒体时长', choices: [
      ['under-15s', '少于 15 秒', asset => durationBetween(asset, 0, 15)],
      ['15s-1m', '15 秒至不足 1 分钟', asset => durationBetween(asset, 15, 60)],
      ['1m-5m', '1 分钟至不足 5 分钟', asset => durationBetween(asset, 60, 300)],
      ['5m-plus', '至少 5 分钟', asset => durationBetween(asset, 300)],
    ] },
    { key: 'availability', label: '原件状态', choices: [
      ['available', '原件可用', asset => asset.kind !== 'link' && asset.available === true],
      ['unavailable', '原件暂不可用', asset => asset.kind !== 'link' && asset.available === false],
    ] },
  ];

  function activeAssetProperties(saved) {
    const entries = [];
    for (const { key, label, choices } of propertyFields) {
      const choice = choices.find(([id]) => id === saved?.[key]);
      if (choice) entries.push({ key, label, choice });
    }
    return entries;
  }

  function normalizeAssetProperties(saved) {
    return Object.fromEntries(activeAssetProperties(saved).map(({ key, choice }) => [key, choice[0]]));
  }

  function assetPropertyMatches(asset, properties) {
    return properties.every(({ choice }) => choice[2](asset));
  }

  if (typeof window === 'undefined') {
    module.exports = { activeAssetProperties, normalizeAssetProperties, assetPropertyMatches };
    return;
  }

  window.normalizeJianCangAssetProperties = normalizeAssetProperties;

  function element(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text) item.textContent = text;
    return item;
  }

  function button(className, text) {
    const item = element('button', className, text);
    item.type = 'button';
    return item;
  }

  function field(labelText, control) {
    const label = element('label', 'asset-filter-field');
    label.append(element('span', '', labelText), control);
    return label;
  }

  function formatKey(value) { return typeof value === 'string' ? value.trim().replace(/^\./, '').toLowerCase() : ''; }
  function tagKey(value) { return typeof value === 'string' ? value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN') : ''; }

  function options(select, entries, value) {
    const rows = document.createDocumentFragment();
    for (const [id, title] of entries) {
      const option = element('option', '', title);
      option.value = id;
      rows.append(option);
    }
    select.replaceChildren(rows);
    select.value = value;
  }

  function dayBoundary(value, end = false) {
    if (!value) return null;
    const date = new Date(`${value}T00:00:00`);
    if (end) date.setDate(date.getDate() + 1);
    return Number.isFinite(date.getTime()) ? date.getTime() : null;
  }

  function aspectMatches(asset, orientation) {
    const { width, height } = asset;
    if (!hasDimensions(asset)) return false;
    const ratio = width / height;
    switch (orientation) {
      case 'landscape': return ratio > 1.1;
      case 'portrait': return ratio < 1 / 1.1;
      case 'square': return ratio >= 1 / 1.1 && ratio <= 1.1;
      case 'panorama': return ratio >= 2;
      case 'tall': return ratio <= 0.5;
      default: return true;
    }
  }

  window.createJianCangFilters = function createJianCangFilters({ kind, onChange } = {}) {
    const root = element('div', 'asset-filters');
    const trigger = button('tool-button asset-filter-trigger', '筛选');
    const triggerCount = element('span', 'asset-filter-count');
    triggerCount.hidden = true;
    triggerCount.setAttribute('aria-hidden', 'true');
    const symbol = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const strokes = document.createElementNS(symbol.namespaceURI, 'path');
    symbol.setAttribute('viewBox', '0 0 16 16');
    symbol.setAttribute('aria-hidden', 'true');
    strokes.setAttribute('d', 'M2 4h12M4.5 8h7M6.5 12h3');
    strokes.setAttribute('stroke', 'currentColor');
    strokes.setAttribute('stroke-width', '1.4');
    strokes.setAttribute('stroke-linecap', 'round');
    symbol.append(strokes);
    trigger.prepend(symbol);
    trigger.append(triggerCount);

    const chips = element('div', 'asset-filter-chips');
    chips.setAttribute('aria-label', '已启用的筛选条件');
    chips.hidden = true;
    const panel = element('section', 'asset-filter-panel');
    panel.setAttribute('popover', 'auto');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', '筛选素材');
    trigger.popoverTargetElement = panel;
    trigger.setAttribute('aria-expanded', 'false');
    const header = element('div', 'asset-filter-header');
    const clear = button('asset-filter-secondary', '清除全部');
    const closeButton = button('asset-filter-close', '×');
    closeButton.setAttribute('aria-label', '关闭筛选');
    header.append(element('h2', '', '筛选素材'), clear, closeButton);

    const format = element('select');
    format.dataset.filter = 'format';
    kind.autofocus = true;
    const aspect = element('select');
    aspect.dataset.filter = 'aspect';
    const rating = element('select');
    rating.dataset.filter = 'rating';
    options(format, [['', '不限']], '');
    options(aspect, aspectOptions, '');
    options(rating, [['', '不限'], ['0', '未评分'], ['1', '至少 1 星'], ['2', '至少 2 星'],
      ['3', '至少 3 星'], ['4', '至少 4 星'], ['5', '5 星']], '');
    const dimensions = element('div', 'asset-filter-fields');
    dimensions.append(field('文件类型', kind), field('文件格式', format), field('画面比例', aspect), field('评分', rating));

    const properties = element('div', 'asset-filter-property-fields');
    const propertyControls = new Map();
    for (const { key, label, fieldLabel, choices } of propertyFields) {
      const select = element('select');
      select.dataset.filter = key;
      options(select, [['', '不限'], ...choices], '');
      propertyControls.set(key, select);
      properties.append(field(fieldLabel || label, select));
    }

    const dateGroup = element('fieldset', 'asset-filter-dates');
    const from = element('input');
    const to = element('input');
    from.type = to.type = 'date';
    from.setAttribute('aria-label', '添加日期起');
    to.setAttribute('aria-label', '添加日期止');
    from.dataset.filter = 'date-from';
    to.dataset.filter = 'date-to';
    const dateControls = element('div', 'asset-filter-date-controls');
    const dateError = element('span', 'asset-filter-date-error', '结束日期须在开始日期当日或之后。');
    dateError.hidden = true;
    dateError.setAttribute('role', 'status');
    dateControls.append(from, element('span', '', '至'), to);
    dateGroup.append(element('legend', '', '添加日期'), dateControls, dateError);

    const tagGroup = element('fieldset', 'asset-filter-tags');
    const tagSearch = element('input', 'asset-filter-tag-search');
    tagSearch.type = 'search';
    tagSearch.placeholder = '搜索标签';
    tagSearch.autocomplete = 'off';
    tagSearch.setAttribute('aria-label', '搜索可筛选的标签');
    const tagsList = element('div', 'asset-filter-tag-list');
    const tagStatus = element('p', 'asset-filter-tag-status');
    tagStatus.setAttribute('role', 'status');
    tagGroup.append(element('legend', '', '同时包含的标签'), tagSearch, tagsList, tagStatus);
    panel.append(header, dimensions, properties, dateGroup, tagGroup);
    root.append(trigger, chips, panel);

    const selectedTags = new Map();
    let tagEntries = [];
    let formats = [];
    let lastAssets;
    let values = { format: '', aspect: '', rating: '', from: '', to: '', start: null, end: null };
    let activeProperties = [];

    function layoutPanel() {
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(392, window.innerWidth - 20);
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.max(10, Math.min(rect.right - width, window.innerWidth - width - 10))}px`;
      panel.style.top = `${Math.round(rect.bottom + 7)}px`;
      panel.style.maxHeight = `${Math.max(1, window.innerHeight - rect.bottom - 17)}px`;
    }

    function renderFormats() {
      const current = format.value;
      const available = current && !formats.includes(current) ? [...formats, current].sort(collator.compare) : formats;
      options(format, [['', '不限'], ...available.map(key => [key, key.toUpperCase()])], current);
    }

    function renderTags() {
      const query = tagKey(tagSearch.value);
      const visible = new Map();
      for (const [key, name] of selectedTags) if (!query || key.includes(query)) visible.set(key, name);
      let matches = visible.size;
      for (const [key, name] of tagEntries) {
        if ((query && !key.includes(query)) || selectedTags.has(key)) continue;
        matches += 1;
        if (visible.size < tagDisplayLimit) visible.set(key, name);
      }
      const rows = document.createDocumentFragment();
      for (const [key, name] of visible) {
        const label = element('label', 'asset-filter-tag');
        const check = element('input');
        check.type = 'checkbox';
        check.checked = selectedTags.has(key);
        check.dataset.tag = key;
        check.addEventListener('change', () => {
          if (check.checked) selectedTags.set(key, name);
          else selectedTags.delete(key);
          changed();
        });
        const text = element('span', '', name);
        text.title = name;
        label.append(check, text);
        rows.append(label);
      }
      tagsList.replaceChildren(rows);
      tagStatus.hidden = matches > 0 && matches <= visible.size;
      tagStatus.textContent = matches === 0 ? (query ? '没有匹配的标签' : '当前素材库没有标签') : `共 ${matches} 个标签，可搜索缩小范围`;
    }

    function activeChips() {
      const summary = [];
      if (kind.value !== 'all') summary.push([kind.selectedOptions[0].textContent, () => { kind.value = 'all'; }]);
      if (values.format) summary.push([values.format, () => { format.value = ''; }]);
      if (values.aspect) summary.push([aspectLabels.get(values.aspect).split('（')[0], () => { aspect.value = ''; }]);
      if (values.rating) summary.push([rating.selectedOptions[0].textContent, () => { rating.value = ''; }]);
      for (const { key, label, choice } of activeProperties) {
        const title = key === 'availability' ? choice[1] : `${label} · ${choice[1]}`;
        summary.push([title, () => { propertyControls.get(key).value = ''; }]);
      }
      if (values.from || values.to) {
        const range = values.from && values.to ? `${values.from} 至 ${values.to}` :
          values.from ? `${values.from} 起` : `截至 ${values.to}`;
        summary.push([range, () => { from.value = to.value = ''; }]);
      }
      for (const [key, name] of selectedTags) summary.push([name, () => { selectedTags.delete(key); renderTags(); }]);
      return summary;
    }

    function renderChips() {
      const summary = activeChips();
      const fragment = document.createDocumentFragment();
      for (const [title, remove] of summary) {
        const chip = button('asset-filter-chip');
        chip.title = `移除筛选 ${title}`;
        const cross = element('span', '', '×');
        cross.setAttribute('aria-hidden', 'true');
        chip.setAttribute('aria-label', chip.title);
        chip.append(element('span', '', title), cross);
        chip.addEventListener('click', () => { remove(); changed(); trigger.focus({ preventScroll: true }); });
        fragment.append(chip);
      }
      chips.replaceChildren(fragment);
      chips.hidden = triggerCount.hidden = clear.disabled = summary.length === 0;
      triggerCount.textContent = String(summary.length);
      trigger.dataset.active = String(summary.length > 0);
      trigger.setAttribute('aria-label', summary.length ? `筛选，已启用 ${summary.length} 项` : '筛选');
    }

    function changed(notify = true) {
      values = { format: format.value, aspect: aspect.value, rating: rating.value, from: from.value, to: to.value,
        start: dayBoundary(from.value), end: dayBoundary(to.value, true) };
      activeProperties = activeAssetProperties(Object.fromEntries([...propertyControls].map(([key, control]) => [key, control.value])));
      const reversed = values.start != null && values.end != null && values.start >= values.end;
      dateError.hidden = !reversed;
      to.setAttribute('aria-invalid', String(reversed));
      renderChips();
      if (panel.matches(':popover-open')) layoutPanel();
      if (notify) onChange?.();
    }

    function reset({ notify = true } = {}) {
      if (!activeChips().length) return;
      kind.value = 'all';
      format.value = aspect.value = rating.value = from.value = to.value = tagSearch.value = '';
      for (const control of propertyControls.values()) control.value = '';
      selectedTags.clear();
      renderFormats();
      renderTags();
      changed(notify);
    }

    function close() { if (panel.matches(':popover-open')) panel.hidePopover(); }

    panel.addEventListener('beforetoggle', event => {
      const opening = event.newState === 'open';
      trigger.setAttribute('aria-expanded', String(opening));
      if (opening) layoutPanel();
    });
    new ResizeObserver(() => { if (panel.matches(':popover-open')) layoutPanel(); }).observe(document.documentElement);
    clear.addEventListener('click', () => {
      reset();
      kind.focus({ preventScroll: true });
    });
    closeButton.addEventListener('click', () => {
      close();
      trigger.focus({ preventScroll: true });
    });
    panel.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.focus({ preventScroll: true });
    });
    for (const input of [kind, format, aspect, rating, from, to, ...propertyControls.values()]) input.addEventListener('change', () => changed());
    tagSearch.addEventListener('input', renderTags);
    renderTags();
    changed(false);

    function matches(asset) {
      if (values.format && formatKey(asset.extension) !== values.format) return false;
      if (values.aspect && !aspectMatches(asset, values.aspect)) return false;
      if (!assetPropertyMatches(asset, activeProperties)) return false;
      if (values.rating) {
        const score = Number.isFinite(asset.rating) ? asset.rating : 0;
        if (values.rating === '0' ? score > 0 : score < Number(values.rating)) return false;
      }
      if (values.start != null || values.end != null) {
        const timestamp = Date.parse(asset.importedAt);
        if (!Number.isFinite(timestamp) || (values.start != null && timestamp < values.start) ||
            (values.end != null && timestamp >= values.end)) return false;
      }
      if (!selectedTags.size) return true;
      if (!Array.isArray(asset.tags) || asset.tags.length < selectedTags.size) return false;
      const keys = new Set(asset.tags.map(tagKey));
      return Array.from(selectedTags.keys()).every(key => keys.has(key));
    }

    function updateAssets(assets) {
      if (assets === lastAssets) return;
      lastAssets = assets;
      const nextFormats = new Set();
      const nextTags = new Map();
      for (const asset of assets || []) {
        const extension = formatKey(asset.extension);
        if (extension) nextFormats.add(extension);
        for (const name of asset.tags || []) {
          const key = tagKey(name);
          if (key && !nextTags.has(key)) nextTags.set(key, name);
        }
      }
      formats = [...nextFormats].sort(collator.compare);
      tagEntries = [...nextTags].sort((a, b) => collator.compare(a[1], b[1]));
      renderFormats();
      renderTags();
    }

    function snapshot() {
      return { format: values.format, aspect: values.aspect, rating: values.rating,
        ...Object.fromEntries(activeProperties.map(({ key, choice }) => [key, choice[0]])),
        from: values.from, to: values.to, tags: [...selectedTags.values()] };
    }

    function describe(saved) {
      const fields = [];
      const optionLabel = (select, value) => Array.from(select.options).find(option => option.value === value)?.label;
      if (saved.kind !== 'all') {
        const type = optionLabel(kind, saved.kind);
        if (type) fields.push(['文件类型', type]);
      }
      const filters = saved.advanced;
      if (filters.format) fields.push(['文件格式', filters.format.toUpperCase()]);
      if (aspectLabels.get(filters.aspect) && filters.aspect) fields.push(['画面比例', aspectLabels.get(filters.aspect)]);
      if (filters.rating && optionLabel(rating, filters.rating)) fields.push(['评分', optionLabel(rating, filters.rating)]);
      for (const { label, choice } of activeAssetProperties(filters)) fields.push([label, choice[1]]);
      if (filters.from || filters.to) {
        const range = filters.from && filters.to ? `${filters.from} 至 ${filters.to}` : filters.from ? `${filters.from} 起` : `截至 ${filters.to}`;
        fields.push(['添加日期', range]);
      }
      if (filters.tags.length) {
        const tags = filters.tags.slice(0, 4).join('、');
        fields.push(['标签', filters.tags.length > 4 ? `${tags} 等 ${filters.tags.length} 个` : tags]);
      }
      return fields;
    }

    function restore(saved = {}, { notify = true } = {}) {
      const extension = formatKey(saved.format);
      renderFormats();
      if (extension && !Array.from(format.options).some(option => option.value === extension)) {
        format.add(new Option(extension.toUpperCase(), extension));
      }
      format.value = extension;
      aspect.value = aspectLabels.has(saved.aspect) ? saved.aspect : '';
      rating.value = typeof saved.rating === 'string' && /^[0-5]$/.test(saved.rating) ? saved.rating : '';
      const selected = normalizeAssetProperties(saved);
      for (const [key, control] of propertyControls) control.value = selected[key] || '';
      from.value = typeof saved.from === 'string' ? saved.from : '';
      to.value = typeof saved.to === 'string' ? saved.to : '';
      tagSearch.value = '';
      selectedTags.clear();
      for (const label of (Array.isArray(saved.tags) ? saved.tags : []).slice(0, 100)) {
        const key = tagKey(label);
        if (key) selectedTags.set(key, label);
      }
      renderTags();
      changed(notify);
    }

    return { element: root, matches, updateAssets, reset, close, snapshot, restore, describe,
      get kind() { return kind.value; },
      set kind(value) {
        kind.value = Array.from(kind.options).some(option => option.value === value) ? value : 'all';
        renderChips();
      },
      get isOpen() { return panel.matches(':popover-open'); },
      get activeCount() {
        return Number(kind.value !== 'all') + Number(!!values.format) + Number(!!values.aspect) + Number(!!values.rating) +
          Number(!!(values.from || values.to)) + activeProperties.length + selectedTags.size;
      } };
  };
})();
