'use strict';

(() => {
  const shades = [
    ['red', '红', '#cf514e'], ['orange', '橙', '#e18845'], ['yellow', '黄', '#ddba4b'], ['green', '绿', '#63a56e'],
    ['cyan', '青', '#55adb1'], ['blue', '蓝', '#517ec6'], ['purple', '紫', '#8e6eb9'], ['pink', '粉', '#ca6a9f'],
    ['white', '白', '#f2f2ee'], ['gray', '灰', '#858790'], ['black', '黑', '#242933'],
  ];
  const colorModes = [['primary', '任一主色'], ['any', '配色包含任一颜色'], ['all', '配色包含全部颜色']];
  const tolerances = [['strict', '精确', 50], ['standard', '适中', 105], ['broad', '宽松', 155]];
  const textModes = [['phrase', '包含短语'], ['terms', '包含全部搜索词'], ['present', '含文字'], ['absent', '无文字']];
  const normalize = value => (value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN');
  const refKey = ref => `${ref.registrationId}:${ref.assetId}`;

  function hexColor(value) {
    if (typeof value !== 'string') return '';
    const hex = value.trim().replace(/^#/, '');
    return /^[a-f\d]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : '';
  }

  function colorChannels(value) {
    return [1, 3, 5].map(index => Number.parseInt(value.slice(index, index + 2), 16));
  }

  function nearbyColor(sample, candidate, tolerance) {
    const [r, g, b] = sample;
    const [rr, gg, bb] = candidate;
    const averageRed = (r + rr) / 2;
    return (2 + averageRed / 256) * (r - rr) ** 2 + 4 * (g - gg) ** 2 +
      (2 + (255 - averageRed) / 256) * (b - bb) ** 2 <= tolerance ** 2;
  }

  function normalizeFilters(value = {}) {
    const reference = hexColor(value?.color);
    const originalShades = new Set(Array.isArray(value?.colors) ? value.colors : [value?.color]);
    const colors = reference ? [] : shades.flatMap(([name]) => originalShades.has(name) ? [name] : []);
    const colorMatch = colorModes.some(([mode]) => mode === value?.colorMatch) ? value.colorMatch : 'primary';
    const tolerance = tolerances.some(([option]) => option === value?.tolerance) ? value.tolerance : 'standard';
    const ocrMode = textModes.some(([mode]) => mode === value?.ocrMode) ? value.ocrMode : 'phrase';
    const ocr = typeof value?.ocr === 'string' && ocrMode !== 'present' && ocrMode !== 'absent' ? value.ocr.trim().slice(0, 256) : '';
    return { color: reference || colors[0] || '', ocr,
      ...(colors.length > 1 && { colors }),
      ...(colors.length && colorMatch !== 'primary' && { colorMatch }),
      ...(reference && tolerance !== 'standard' && { tolerance }),
      ...(ocrMode !== 'phrase' && (ocr || ocrMode === 'present' || ocrMode === 'absent') && { ocrMode }),
    };
  }

  function colorLabel(filter) {
    const reference = hexColor(filter.color);
    if (reference) {
      const tolerance = tolerances.find(([value]) => value === filter.tolerance)?.[1];
      return `相近颜色 ${reference.toUpperCase()}${tolerance ? `（${tolerance}）` : ''}`;
    }
    const colors = (filter.colors ?? [filter.color]).flatMap(color => {
      const shade = shades.find(([name]) => name === color);
      return shade ? [shade[1]] : [];
    });
    if (!colors.length) return '';
    const base = filter.colorMatch === 'all' ? '配色包含全部颜色' : filter.colorMatch === 'any' ? '配色包含任一颜色' : '主色';
    return `${base} · ${colors.join('、')}${colors.length === 1 ? '色' : ''}`;
  }

  function textLabel(filter) {
    if (filter.ocrMode === 'present') return '含文字';
    if (filter.ocrMode === 'absent') return '无文字';
    if (!filter.ocr) return '';
    return filter.ocrMode === 'terms' ? `全部搜索词 · ${filter.ocr}` : filter.ocr;
  }

  window.normalizeJianCangVisualFilters = normalizeFilters;

  function shadeOf(hex) {
    if (typeof hex !== 'string' || !/^#[a-f\d]{6}$/i.test(hex)) return '';
    const [r, g, b] = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
    const top = Math.max(r, g, b);
    const low = Math.min(r, g, b);
    const delta = top - low;
    const lightness = (top + low) / 2;
    if (lightness < 0.14) return 'black';
    if (delta < 0.105) return lightness > 0.84 ? 'white' : 'gray';
    const segment = top === r ? (g - b) / delta : top === g ? 2 + (b - r) / delta : 4 + (r - g) / delta;
    const angle = (segment * 60 + 360) % 360;
    if (angle < 16 || angle >= 347) return 'red';
    if (angle < 43) return 'orange';
    if (angle < 70) return 'yellow';
    if (angle < 151) return 'green';
    if (angle < 199) return 'cyan';
    if (angle < 257) return 'blue';
    if (angle < 290) return 'purple';
    return 'pink';
  }

  function element(tag, attrs = {}, text) {
    const result = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) result.setAttribute(name, value);
    if (text) result.textContent = text;
    return result;
  }

  const button = (text, className = 'outline-button') => element('button', { type: 'button', class: className }, text);

  function choice(title, modes, id) {
    const label = element('label', { class: 'intake-field' }, title);
    const select = element('select', { id });
    select.append(...modes.map(([value, name]) => new Option(name, value)));
    label.append(select);
    return { label, select };
  }

  window.createJianCangVisualTools = ({ bridge, getAssets, getAllAssets, refFor, notify, onChange }) => {
    let records = new Map();
    let failedRecords = new Map();
    let recordsReady = Promise.resolve();
    let recordRequest = 0;
    let filter = normalizeFilters();
    let selectedShades = new Set();
    let colorTest;
    let textTest;
    let similar = null;
    let seed = null;
    let job = null;
    let followUp = null;
    let untilStarted = false;
    let comparisonQueued = false;
    let comparisonRetry = false;
    let comparing = false;
    let dialogSession = 0;
    let copiedColor = '';

    const trigger = button('智能查找', 'tool-button visual-trigger');
    trigger.id = 'visual-search-button';
    const dialog = element('dialog', { class: 'local-intake-dialog visual-tools-dialog', 'aria-labelledby': 'visual-dialog-title' });
    const header = element('div', { class: 'dialog-head' });
    const heading = element('h2', { id: 'visual-dialog-title' }, '智能查找');
    const dismiss = button('×', 'icon-button visual-close');
    dismiss.setAttribute('aria-label', '关闭智能查找');
    const body = element('div', { class: 'local-intake-body visual-body' });
    const scope = element('p', { class: 'visual-scope' });
    const status = element('p', { class: 'visual-job-label', role: 'status' });
    const progress = element('progress', { class: 'visual-progress', max: '1', 'aria-label': '识别与分析进度', hidden: '' });
    const issue = element('p', { class: 'local-intake-error', role: 'status', hidden: '' });
    const primary = element('fieldset', { class: 'visual-palette' });
    const palette = element('div', { class: 'visual-swatches' });
    const colorMatch = choice('颜色匹配', colorModes, 'visual-color-match');
    const referenceColor = element('fieldset', { class: 'visual-palette' });
    const referenceFields = element('div', { class: 'visual-reference-fields' });
    const hexRow = element('div', { class: 'visual-hex-row' });
    const sampleDot = element('span', { class: 'visual-hex-dot', 'aria-hidden': 'true' });
    const hex = element('input', { type: 'text', 'aria-label': '参考色 HEX', placeholder: '#RRGGBB',
      autocomplete: 'off', maxlength: '7', spellcheck: 'false' });
    const copyColor = button('复制色值', 'tool-button visual-copy-color');
    const tolerance = choice('接近程度', tolerances, 'visual-color-tolerance');
    const ocrFields = element('div', { class: 'visual-text-fields' });
    const ocrMode = choice('图中文字', textModes, 'visual-ocr-mode');
    const ocrLabel = element('label', { class: 'intake-field' }, '要查找的文字');
    const ocr = element('input', { type: 'search', autocomplete: 'off', maxlength: '256', placeholder: '输入 OCR 识别出的文字' });
    const actions = element('div', { class: 'local-intake-actions visual-actions' });
    const scan = button('分析图片');
    const scanText = button('识别图中文字');
    const stop = button('停止分析');
    const apply = button('应用筛选', 'primary-button');
    const clear = button('清除', 'status-button');
    const retryComparison = button('重新查找', 'primary-button');
    const chips = element('div', { class: 'visual-filter-chips', hidden: '' });

    primary.append(element('legend', {}, '颜色（可多选）'), palette, colorMatch.label);
    hexRow.append(sampleDot, hex, copyColor);
    referenceFields.append(hexRow, tolerance.label);
    referenceColor.append(element('legend', {}, '参考色 HEX'), referenceFields);
    ocrLabel.append(ocr);
    ocrFields.append(ocrMode.label, ocrLabel);
    header.append(heading, dismiss);
    actions.append(clear, scan, scanText, stop, apply, retryComparison);
    body.append(scope, status, progress, primary, referenceColor, ocrFields, issue, actions);
    dialog.append(header, body);
    document.body.append(dialog);
    trigger.addEventListener('click', () => void open());
    dismiss.addEventListener('click', () => dialog.close());

    function errors(message) {
      issue.textContent = message || '';
      issue.hidden = !message;
    }

    function usableAssets() { return getAssets().filter(asset => asset.kind === 'image' || asset.extension === 'livp'); }

    function canAnalyze(asset) { return asset.available || asset.thumbnailAvailable; }

    function cachedRecord(asset) {
      const row = records.get(asset?.id);
      return row && row.revision === refFor(asset).revision ? row : undefined;
    }

    function hasResult(asset, needsText) {
      const row = cachedRecord(asset);
      return !!row && (!needsText || row.ocrStatus === 'done');
    }

    function missingRecords(assets, needsText = false, retryFailures = false) {
      return assets.filter(asset => {
        if (!canAnalyze(asset) || hasResult(asset, needsText)) return false;
        return retryFailures || (failedRecords.get(asset.id) !== refFor(asset).revision &&
          (!needsText || cachedRecord(asset)?.ocrStatus !== 'failed'));
      });
    }

    function showState() {
      if (!dialog.open) return;
      const assets = usableAssets();
      const available = assets.filter(canAnalyze).length;
      const indexed = assets.filter(asset => hasResult(asset, false)).length;
      const recognized = assets.filter(asset => hasResult(asset, true)).length;
      scope.textContent = seed ? `参考图片「${seed.name}」。当前范围有 ${assets.length} 张图片。`
        : `当前范围 ${assets.length} 张图片，已分析 ${indexed} 张，已识别文字 ${recognized} 张。`;
      heading.textContent = seed ? '查找相似图片' : '智能查找';
      const indexing = job?.status === 'running' || untilStarted;
      const running = indexing || comparing || comparisonQueued;
      progress.hidden = !running;
      const count = job?.processed || 0;
      if (!indexing || untilStarted) progress.removeAttribute('value');
      else progress.value = job?.total ? count / job.total : 0;
      const failed = job?.failed || job?.ocrFailed ? `，${(job.failed || 0) + (job.ocrFailed || 0)} 张未完成` : '';
      status.textContent = comparing ? '正在比较图片…' :
        comparisonQueued ? '正在准备查找…' :
        indexing ? `已处理 ${count} / ${job?.total || available} 张${failed}` :
        job?.status === 'cancelled' ? '已停止。已完成的结果会保留。' :
          job?.status === 'completed' ? `分析完成${failed}。` : job?.status === 'failed' ? '分析未完成，请重试。' : '';
      scan.disabled = scanText.disabled = running || available === 0;
      const sample = hexColor(hex.value);
      apply.textContent = sample && !textLabel(readSelection()) ? '查找相近颜色' : '应用筛选';
      apply.disabled = running;
      colorMatch.label.hidden = !selectedShades.size;
      tolerance.label.hidden = !sample;
      ocrLabel.hidden = ['present', 'absent'].includes(ocrMode.select.value);
      copyColor.disabled = !sample;
      copyColor.textContent = sample && sample === copiedColor ? '已复制色值' : '复制色值';
      sampleDot.style.backgroundColor = sample;
      stop.textContent = seed ? '取消查找' : '停止分析';
      stop.hidden = !running || (!seed && untilStarted);
      scan.hidden = scanText.hidden = clear.hidden = apply.hidden = primary.hidden = referenceColor.hidden = ocrFields.hidden = !!seed;
      retryComparison.hidden = !seed || running;
    }

    function selectColors(values) {
      selectedShades = new Set(values);
      for (const child of swatches) {
        const selected = child.dataset.color ? selectedShades.has(child.dataset.color) : selectedShades.size === 0;
        child.setAttribute('aria-pressed', String(selected));
      }
    }

    const swatches = [['', '不限', ''], ...shades].map(([key, label, previewColor]) => {
      const chip = button(label, 'visual-swatch');
      chip.dataset.color = key;
      if (previewColor) {
        const dot = element('span', { 'aria-hidden': 'true' });
        dot.style.backgroundColor = previewColor;
        chip.prepend(dot);
      }
      chip.addEventListener('click', () => {
        hex.value = '';
        const selected = new Set(key ? selectedShades : []);
        if (key && !selected.delete(key)) selected.add(key);
        selectColors(selected);
        errors('');
        showState();
      });
      return chip;
    });
    palette.append(...swatches);

    function renderChips() {
      const items = [];
      function add(label, action) {
        const chip = button(`${label} ×`, 'asset-filter-chip');
        chip.addEventListener('click', action);
        items.push(chip);
      }
      if (similar) add(`相似图片 · ${similar.name}`, () => {
        similar = null; renderChips(); onChange();
      });
      if (filter.color) add(colorLabel(filter), () => updateFilters({ ocr: filter.ocr, ocrMode: filter.ocrMode }));
      if (textLabel(filter)) add(`图片文字 · ${textLabel(filter)}`, () => updateFilters({ ...filter, ocr: '', ocrMode: 'phrase' }));
      chips.replaceChildren(...items);
      chips.hidden = items.length === 0;
    }

    async function loadRecords(assets, request) {
      const list = assets.filter(asset => asset.kind === 'image' || asset.extension === 'livp');
      const next = new Map();
      const failures = new Map();
      for (let index = 0; index < list.length; index += 260) {
        try {
          const data = await bridge.visualLookup(list.slice(index, index + 260).map(refFor));
          if (request !== recordRequest || !Array.isArray(data)) return;
          for (const row of data) {
            if (row.analysisStatus === 'failed') { failures.set(refKey(row), row.revision); continue; }
            const palette = (row.palette?.length ? row.palette : [row.primaryColor]).map(hexColor).filter(Boolean);
            next.set(refKey(row), { ...row, colors: palette.map(colorChannels), shades: new Set(palette.map(shadeOf)) });
          }
        } catch { return; }
      }
      if (request !== recordRequest) return;
      const changed = next.size !== records.size || [...next].some(([id, value]) => {
        const old = records.get(id);
        return !old || old.revision !== value.revision || old.text !== value.text ||
          old.ocrStatus !== value.ocrStatus || old.primaryColor !== value.primaryColor;
      });
      records = next;
      failedRecords = failures;
      showState();
      if (changed) onChange({ refresh: true });
    }

    function refresh(assets) {
      recordsReady = loadRecords(assets, ++recordRequest);
      return recordsReady;
    }

    async function waitForRecords() {
      let request;
      do { request = recordsReady; await request; } while (request !== recordsReady);
    }

    async function runComparison(current, references, session) {
      const isCurrent = () => dialog.open && dialogSession === session;
      if (!isCurrent()) return;
      comparing = true;
      showState();
      try {
        const results = await bridge.findSimilar(refFor(current), references);
        if (!isCurrent()) return;
        if (!Array.isArray(results)) throw new Error(results?.message || '暂时无法比较这些图片。');
        const ranks = new Map();
        ranks.set(current.id, 0);
        for (const record of results) {
          const id = refKey(record.reference || record);
          if (id !== current.id) ranks.set(id, ranks.size);
        }
        if (ranks.size === 1) { errors('当前范围内没有找到匹配的图片。'); return; }
        similar = { name: current.name, ranks };
        dialog.close();
        renderChips();
        onChange();
      } catch (error) {
        if (isCurrent()) errors(error.message);
      } finally {
        if (dialogSession === session) { comparing = false; showState(); }
      }
    }

    function startPendingComparison() {
      if (!comparisonQueued || !dialog.open || untilStarted || job?.status === 'running') return;
      comparisonQueued = false;
      const current = seed;
      const retryFailures = comparisonRetry;
      const session = dialogSession;
      const assets = usableAssets().filter(asset => canAnalyze(asset) || hasResult(asset, false));
      const candidates = assets.some(asset => asset.id === current.id) ? assets : [current, ...assets];
      if (candidates.length > 10_000 || candidates.length < 2) {
        errors(candidates.length < 2 ? '当前范围内没有其他可比较的图片。'
          : '当前范围超过 10,000 张，请进入较小的素材库或集合再查找。');
        showState();
        return;
      }
      const references = candidates.map(refFor);
      const missing = missingRecords(candidates, false, retryFailures);
      const compare = () => {
        if (hasResult(current, false)) return runComparison(current, references, session);
        if (dialog.open && dialogSession === session) {
          errors('参考图片暂无可用的分析结果。可以点击「重新查找」重试。');
          showState();
        }
      };
      if (missing.length) void analyze(false, { only: missing, complete: compare, retryFailures });
      else void compare();
    }

    function requestComparison(retryFailures = false) {
      if (!seed || !dialog.open) return;
      errors('');
      comparisonRetry = retryFailures;
      comparisonQueued = true;
      showState();
      startPendingComparison();
    }

    async function analyze(withText, { only = null, complete = null, retryFailures = true } = {}) {
      const session = dialogSession;
      await waitForRecords();
      if (!dialog.open || dialogSession !== session) return;
      if (untilStarted || job?.status === 'running') return;
      const assets = usableAssets();
      const source = only ?? missingRecords(assets, withText, retryFailures);
      if (source.length > 10_000) { errors('当前范围超过 10,000 张，请进入较小的素材库或集合再分析。'); return; }
      const list = source.map(refFor);
      if (!list.length) {
        if (assets.some(canAnalyze)) notify(withText ? '当前可读取的图片已完成文字识别。' : '当前可读取的图片已完成分析。');
        else errors('当前范围没有可分析的图片。');
        return;
      }
      errors('');
      untilStarted = true;
      showState();
      try {
        const started = await bridge.startVisual(list, withText === true, retryFailures);
        if (started?.ok === false || !started?.jobId) throw new Error(started?.message || '无法启动图片分析。');
        if (complete) followUp = { jobId: started.jobId, complete };
        await consume(await bridge.visualStatus() || started);
      } catch (error) {
        if (dialog.open && dialogSession === session) errors(error.message);
      }
      finally { untilStarted = false; showState(); startPendingComparison(); }
    }

    async function consume(next) {
      if (!next || next.ok === false) return;
      const previous = job;
      job = next;
      showState();
      if (next.status === 'running') return;
      const pending = followUp?.jobId === next.jobId ? followUp : null;
      if (pending) followUp = null;
      const changed = previous?.status === 'running' || previous?.jobId !== next.jobId;
      if (changed || pending) await refresh(getAllAssets());
      if (next.status === 'completed' && pending) await pending.complete(next);
      startPendingComparison();
    }

    async function open(asset = null, sourceColor = '') {
      const session = ++dialogSession;
      comparisonQueued = false;
      comparing = false;
      seed = asset;
      if (!dialog.open) dialog.showModal();
      errors('');
      copiedColor = '';
      hex.value = (hexColor(sourceColor) || hexColor(filter.color)).toUpperCase();
      selectColors(hex.value ? [] : filter.colors ?? [filter.color].filter(Boolean));
      colorMatch.select.value = filter.colorMatch || 'primary';
      tolerance.select.value = filter.tolerance || 'standard';
      ocrMode.select.value = filter.ocrMode || 'phrase';
      ocr.value = filter.ocr;
      showState();
      if (sourceColor) hex.focus();
      try {
        const latest = await bridge.visualStatus();
        if (!dialog.open || dialogSession !== session) return;
        if (latest?.ok === false) errors(latest.message);
        else if (latest) await consume(latest);
        await waitForRecords();
        if (seed && dialog.open && dialogSession === session) requestComparison();
      } catch {
        if (dialog.open && dialogSession === session) errors('无法读取分析状态，请重试。');
      }
    }

    function updateFilters(value, notifyChange = true) {
      filter = normalizeFilters(value);
      colorTest = compileColorTest(filter);
      textTest = compileTextTest(filter);
      renderChips();
      if (notifyChange) onChange();
    }

    function restore(value, notifyChange = true) {
      similar = null;
      updateFilters(value, notifyChange);
    }

    function readSelection() {
      return normalizeFilters({ color: hexColor(hex.value), colors: [...selectedShades], colorMatch: colorMatch.select.value,
        tolerance: tolerance.select.value, ocr: ocr.value, ocrMode: ocrMode.select.value });
    }

    function compileColorTest(rule) {
      if (!rule.color) return null;
      const reference = hexColor(rule.color);
      if (reference) {
        const channels = colorChannels(reference);
        const threshold = tolerances.find(([key]) => key === (rule.tolerance ?? 'standard'))[2];
        return row => row.colors.some(candidate => nearbyColor(channels, candidate, threshold));
      }
      const colors = rule.colors || [rule.color];
      if (rule.colorMatch === 'all') return row => colors.every(color => row.shades.has(color));
      if (rule.colorMatch === 'any') return row => colors.some(color => row.shades.has(color));
      return row => colors.includes(shadeOf(row.primaryColor));
    }

    function compileTextTest(rule) {
      if (!textLabel(rule)) return null;
      const query = normalize(rule.ocr);
      const terms = query.split(' ');
      return row => {
        if (row.ocrStatus !== 'done') return false;
        const value = normalize(row.text);
        if (rule.ocrMode === 'present') return !!value;
        if (rule.ocrMode === 'absent') return !value;
        return rule.ocrMode === 'terms' ? terms.every(term => value.includes(term)) : value.includes(query);
      };
    }

    scan.addEventListener('click', () => void analyze(false));
    scanText.addEventListener('click', () => void analyze(true));
    retryComparison.addEventListener('click', () => requestComparison(true));
    stop.addEventListener('click', () => {
      if (seed) dialog.close();
      else if (job?.jobId) void bridge.cancelVisual(job.jobId);
    });
    clear.addEventListener('click', () => { dialog.close(); restore({}); });
    async function applySelection() {
      const session = dialogSession;
      await waitForRecords();
      if (!dialog.open || dialogSession !== session) return;
      if (untilStarted || job?.status === 'running') return;
      const sample = hexColor(hex.value);
      if (hex.value.trim() && !sample) { errors('请输入六位 HEX 色值，例如 #336699。'); hex.focus(); return; }
      const selected = readSelection();
      const expected = JSON.stringify(selected);
      const needsText = !!textLabel(selected);
      const needsAnalysis = !!selected.color || needsText;
      const applyResult = () => {
        if (!dialog.open || dialogSession !== session || JSON.stringify(readSelection()) !== expected) return;
        const scoped = usableAssets();
        const incomplete = needsAnalysis ? scoped.filter(asset => !hasResult(asset, needsText)).length : 0;
        if (needsAnalysis && incomplete === scoped.length) {
          errors(!scoped.some(canAnalyze) ? '当前范围没有可读取的图片。请取回原件后再试。'
            : needsText ? '当前范围暂无文字识别结果。可以点击「识别图中文字」重试。'
              : '当前范围暂无图片分析结果。可以点击「分析图片」重试。');
          return;
        }
        dialog.close();
        restore(selected);
        if (incomplete) notify(`已用 ${scoped.length - incomplete} 张图片的已有结果筛选，${incomplete} 张暂无${needsText ? '文字识别' : '分析'}结果。`);
      };
      const scoped = usableAssets();
      if (!needsAnalysis || scoped.some(asset => hasResult(asset, needsText))) {
        applyResult();
        return;
      }
      const missing = missingRecords(scoped, needsText);
      if (missing.length) await analyze(needsText, { only: missing, complete: applyResult, retryFailures: false });
      else applyResult();
    }
    hex.addEventListener('input', () => { selectColors([]); errors(''); showState(); });
    ocr.addEventListener('input', () => { errors(''); showState(); });
    for (const menu of [colorMatch.select, tolerance.select, ocrMode.select]) {
      menu.addEventListener('change', () => { errors(''); showState(); });
    }
    copyColor.addEventListener('click', async () => {
      const sample = hexColor(hex.value);
      if (!sample) return;
      try {
        const result = await bridge.copyVisualColor(sample.toUpperCase());
        if (!result?.ok) throw new Error(result?.message || '无法复制色值。');
        copiedColor = sample;
        showState();
      } catch (error) { errors(error.message); }
    });
    apply.addEventListener('click', () => void applySelection());
    for (const input of [hex, ocr]) input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing && !apply.disabled) { event.preventDefault(); void applySelection(); }
    });
    bridge.onVisualChange?.(next => void consume(next));

    return {
      element: trigger, chips, open, refresh, restore,
      openColor: color => open(null, color),
      describe(value) {
        const rule = normalizeFilters(value);
        return [['配色', colorLabel(rule)], ['图片文字', textLabel(rule)]].filter(([, label]) => label);
      },
      snapshot: () => ({ ...filter }),
      record: cachedRecord,
      clearsSimilarity: () => { if (similar) { similar = null; renderChips(); } },
      get active() { return !!(colorTest || textTest || similar); },
      get comparison() { return similar; },
      matches(asset) {
        if (similar) return similar.ranks.has(asset.id);
        if (!colorTest && !textTest) return true;
        const row = cachedRecord(asset);
        return !!row && (!colorTest || colorTest(row)) && (!textTest || textTest(row));
      },
    };
  };
})();
