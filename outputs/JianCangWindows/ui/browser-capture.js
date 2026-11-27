'use strict';

window.createJianCangBrowserCapture = function createBrowserCapture({ bridge, getLibraries, getCollections, getDefaultTarget, notify }) {
  const item = name => document.getElementById('browser-capture-' + name);
  const dialog = item('dialog');
  const library = item('library');
  const collection = item('collection');
  const error = item('error');
  const history = item('history');
  const historyStatus = item('history-status');
  const historyRows = item('history-rows');
  const rulesList = item('rules-list');
  const rulesMessage = item('rules-message');
  const ruleEditor = item('rule-editor');
  const ruleLibrary = item('rule-library');
  const ruleCollection = item('rule-collection');
  const ruleKind = item('rule-kind');
  const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
  let config;
  let busy = false;
  let generation = 0;
  let historyGeneration = 0;
  let editingRule = null;

  function message(text = '') {
    error.textContent = text;
    error.hidden = !text;
  }

  function ruleMessage(text = '') {
    rulesMessage.textContent = text;
    rulesMessage.hidden = !text;
  }

  function historyRow(record) {
    const row = document.createElement('li');
    row.className = 'browser-capture-record';
    const title = document.createElement('strong');
    title.textContent = record.title || (record.kind === 'image' ? '图片采集' : '网页采集');
    const meta = document.createElement('p');
    meta.textContent = [dateTime.format(record.capturedAt), record.destination, record.ruleName && '规则 ' + record.ruleName]
      .filter(Boolean).join(' · ');
    const fields = document.createElement('dl');
    const size = record.width && record.height ? `${record.width} × ${record.height} px` : null;
    for (const [label, value, missing, field] of [
      ['原帖地址', record.originalURL, '未识别到原帖', 'originalURL'],
      ['实际图片地址', record.imageURL, record.kind === 'image' ? '无可用的图片网址' : '网页采集', 'imageURL'],
      ['保存尺寸', size, record.kind === 'image' ? '未读取到像素尺寸' : '网页采集'],
      ...(record.tags?.length ? [['预设标签', record.tags.join('、'), '']] : []),
    ]) {
      const term = document.createElement('dt');
      term.textContent = label;
      const entry = document.createElement('dd');
      const content = document.createElement('span');
      content.textContent = value || missing;
      entry.append(content);
      if (value && field) {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'outline-button';
        copy.textContent = '复制';
        copy.setAttribute('aria-label', '复制' + label);
        copy.addEventListener('click', async () => {
          try {
            const result = await bridge.copyBrowserCaptureAddress(record.id, field);
            if (!result.ok) throw new Error(result.message);
            notify('已复制' + label);
          } catch (failure) {
            notify(failure?.message || '未能复制此地址。');
          }
        });
        entry.append(copy);
      }
      fields.append(term, entry);
    }
    row.append(title, meta, fields);
    return row;
  }

  async function refreshHistory() {
    if (!dialog.open || !history.open) return;
    const request = ++historyGeneration;
    try {
      const result = await bridge.browserCaptureHistory();
      if (!result.ok) throw new Error(result.message);
      if (!dialog.open || !history.open || request !== historyGeneration) return;
      historyRows.replaceChildren(...result.records.map(historyRow));
      historyStatus.textContent = result.message || (result.records.length
        ? `最近 ${result.records.length} 条 · 此设备保留最多 ${result.limit} 条`
        : '暂无已保存的采集记录。');
    } catch (failure) {
      if (dialog.open && history.open && request === historyGeneration) {
        historyStatus.textContent = failure?.message || '无法读取采集历史。';
      }
    }
  }

  function status() {
    item('status').textContent = config?.enabled
      ? '已启用 · 已连接 ' + config.paired + ' 个浏览器'
      : config?.awaitingDefault ? '默认开启，等待可写素材库' : '采集未启用';
    item('revoke').hidden = !config?.paired;
    item('revoke').disabled = busy;
    item('disable').hidden = !config?.target && !config?.awaitingDefault;
    item('disable').disabled = busy;
    item('save').textContent = config?.enabled ? '保存位置' : '启用采集';
    item('save').disabled = busy || !library.value;
    item('folder').disabled = busy;
    library.disabled = busy || !library.options.length;
    collection.disabled = busy || !library.value;
    item('rule-add').disabled = busy || !getLibraries().length || (config?.rules?.length ?? 0) >= (config?.maximumRules ?? 48);
    item('rule-save').disabled = busy || !ruleLibrary.value;
  }

  function loadCollections(select, libraryId, preferred) {
    const rows = libraryId ? getCollections(libraryId) : [];
    const byId = new Map(rows.map(row => [row.id, row]));
    const options = rows.map(row => {
      const names = [];
      const walked = new Set();
      for (let node = row; node && !walked.has(node.id); node = byId.get(node.parentId)) {
        names.unshift(node.name);
        walked.add(node.id);
      }
      return new Option(names.join(' / '), row.id);
    }).sort((left, right) => left.text.localeCompare(right.text, 'zh-CN', { numeric: true }));
    select.replaceChildren(new Option('库根目录', ''), ...options);
    if (byId.has(preferred)) select.value = preferred;
    return byId.has(preferred);
  }

  function libraryOption(row) {
    return new Option(row.kind === 'jiancang' ? row.name + '（同步库）' : row.name, row.id);
  }

  function renderTargets(target) {
    const libraries = getLibraries();
    library.replaceChildren(...libraries.map(libraryOption));
    if (libraries.some(row => row.id === target?.targetId)) library.value = target.targetId;
    loadCollections(collection, library.value, library.value === target?.targetId ? target.collectionId : null);
    status();
    if (!libraries.length) message('请先打开本地见藏库，或在见藏同步库中开启双向同步。');
    else if (target && (library.value !== target.targetId || collection.value !== (target.collectionId || ''))) {
      message('原采集位置当前不可用，请重新选择并保存。');
    }
  }

  async function run(operation, showError = message) {
    if (busy) return;
    busy = true;
    showError();
    status();
    try {
      const result = await operation();
      if (result?.ok === false) throw new Error(result.message);
      return result;
    } catch (failure) {
      showError(failure?.message || '浏览器采集设置未保存，请重试。');
    } finally {
      busy = false;
      status();
    }
  }

  function ruleDestination(target) {
    const library = getLibraries().find(row => row.id === target.targetId && row.libraryId === target.libraryId);
    if (!library) return '原素材库暂不可用';
    if (!target.collectionId) return library.name + ' / 库根目录';
    const collection = getCollections(library.id).find(row => row.id === target.collectionId);
    return library.name + ' / ' + (collection?.name || '原集合暂不可用');
  }

  function ruleButton(label, rule, disabled, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outline-button';
    button.textContent = label;
    button.setAttribute('aria-label', label + '规则 ' + rule.name);
    button.disabled = disabled;
    button.addEventListener('click', action);
    return button;
  }

  function renderRules() {
    const rules = config?.rules ?? [];
    if (!rules.length) {
      const empty = document.createElement('li');
      empty.className = 'browser-capture-rule-hint';
      empty.textContent = '暂无自动归档规则。';
      rulesList.replaceChildren(empty);
      return;
    }
    rulesList.replaceChildren(...rules.map((rule, index) => {
      const row = document.createElement('li');
      row.className = 'browser-capture-rule';
      const name = document.createElement('strong');
      name.textContent = rule.name + (rule.enabled ? '' : ' · 已停用');
      const criteria = document.createElement('span');
      criteria.textContent = [rule.domain, rule.keyword && '含「' + rule.keyword + '」',
        rule.kind !== 'any' && [...ruleKind.options].find(option => option.value === rule.kind)?.text]
        .filter(Boolean).join(' · ');
      const destination = document.createElement('span');
      destination.textContent = [ruleDestination(rule.target), rule.tags?.length && '标签 ' + rule.tags.join('、')]
        .filter(Boolean).join(' · ');
      const actions = document.createElement('div');
      actions.className = 'browser-capture-actions';
      actions.append(
        ruleButton('上移', rule, index === 0, () => void changeRule(rule, 'up')),
        ruleButton('下移', rule, index === rules.length - 1, () => void changeRule(rule, 'down')),
        ruleButton('编辑', rule, false, () => openRuleEditor(rule)),
        ruleButton(rule.enabled ? '停用' : '启用', rule, false, () => void changeRule(rule, 'toggle')),
        ruleButton('删除', rule, false, () => void changeRule(rule, 'remove')),
      );
      row.append(name, criteria, destination, actions);
      return row;
    }));
  }

  function openRuleEditor(rule = null) {
    if (busy) return;
    editingRule = rule;
    ruleMessage();
    item('rule-name').value = rule?.name ?? '';
    item('rule-domain').value = rule?.domain ?? '';
    item('rule-keyword').value = rule?.keyword ?? '';
    ruleKind.value = rule?.kind ?? 'any';
    item('rule-tags').value = (rule?.tags ?? []).join('、');
    const libraries = getLibraries();
    ruleLibrary.replaceChildren(...libraries.map(libraryOption));
    const target = rule?.target ?? config?.target;
    if (target && libraries.some(row => row.id === target.targetId && row.libraryId === target.libraryId)) {
      ruleLibrary.value = target.targetId;
    } else if (rule) {
      ruleLibrary.prepend(new Option('原素材库不可用，请重新选择', ''));
      ruleLibrary.value = '';
    }
    const collectionId = ruleLibrary.value === target?.targetId ? target.collectionId : null;
    if (!loadCollections(ruleCollection, ruleLibrary.value, collectionId) && collectionId && rule) {
      ruleMessage('原集合暂不可用，请选择新的保存位置。');
    }
    status();
    ruleEditor.hidden = false;
    item('rule-name').focus();
  }

  async function changeRule(rule, action) {
    const result = await run(() => bridge.changeBrowserCaptureRule(rule.id, action), ruleMessage);
    if (!result) return;
    config = result;
    if (action === 'remove' && editingRule?.id === rule.id) ruleEditor.hidden = true;
    renderRules();
    status();
  }

  async function open() {
    if (dialog.open) return;
    dialog.showModal();
    void refreshHistory();
    const fallback = getDefaultTarget();
    const result = await run(() => bridge.browserCaptureStatus());
    if (!dialog.open) return;
    config = result;
    renderTargets(config?.target || (fallback && { targetId: fallback.id, collectionId: fallback.collection }));
    ruleMessage(config?.rulesMessage);
    renderRules();
    if (config?.message) message(config.message);
  }

  async function refreshEmptyTargets() {
    if (!dialog.open || busy || library.options.length) return;
    if (!getLibraries().length) return;
    const result = await run(() => bridge.browserCaptureStatus());
    if (!dialog.open) return;
    if (result) config = result;
    const fallback = getDefaultTarget();
    renderTargets(config?.target || (fallback && { targetId: fallback.id, collectionId: fallback.collection }));
    renderRules();
    if (config?.message) message(config.message);
  }

  item('close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { generation++; historyGeneration++; ruleEditor.hidden = true; editingRule = null; });
  history.addEventListener('toggle', () => void refreshHistory());
  bridge.onBrowserCaptureHistoryChange(() => void refreshHistory());
  library.addEventListener('change', () => { loadCollections(collection, library.value, null); status(); message(); });
  ruleLibrary.addEventListener('change', () => { loadCollections(ruleCollection, ruleLibrary.value, null); status(); ruleMessage(); });
  item('rule-add').addEventListener('click', () => openRuleEditor());
  item('rule-cancel').addEventListener('click', () => { ruleEditor.hidden = true; editingRule = null; ruleMessage(); });
  ruleEditor.addEventListener('submit', async event => {
    event.preventDefault();
    const selected = getLibraries().find(row => row.id === ruleLibrary.value);
    if (!selected) return;
    const existing = config?.rules?.find(rule => rule.id === editingRule?.id);
    const result = await run(() => bridge.saveBrowserCaptureRule({
      id: editingRule?.id, name: item('rule-name').value, enabled: existing?.enabled ?? true,
      domain: item('rule-domain').value, keyword: item('rule-keyword').value, kind: ruleKind.value,
      target: { targetId: selected.id, libraryId: selected.libraryId, collectionId: ruleCollection.value || null },
      tags: item('rule-tags').value.split(/[、,，]/).map(value => value.trim()).filter(Boolean),
    }), ruleMessage);
    if (!result) return;
    config = result;
    ruleEditor.hidden = true;
    editingRule = null;
    renderRules();
    status();
  });
  item('form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!library.value) return;
    const result = await run(() => bridge.configureBrowserCapture({
      targetId: library.value, collectionId: collection.value || null,
    }));
    if (result) {
      config = result;
      status();
      renderRules();
      notify('已保存浏览器采集位置。');
    }
  });
  item('folder').addEventListener('click', () => void run(() => bridge.revealBrowserExtension()));
  async function disconnect(disable) {
    const result = await run(() => bridge.disconnectBrowserCapture(disable));
    if (!result) return;
    config = result;
    status();
    notify(disable ? '已关闭浏览器采集。' : '已解除全部浏览器连接。');
  }
  item('revoke').addEventListener('click', () => void disconnect(false));
  item('disable').addEventListener('click', () => void disconnect(true));

  window.addEventListener('focus', async () => {
    if (!dialog.open || busy) return;
    const refocus = ++generation;
    try {
      const result = await bridge.browserCaptureStatus();
      if (!dialog.open || refocus !== generation || busy || result?.ok === false) return;
      config = result;
      status();
    } catch {}
  });
  return { open, refreshEmptyTargets };
};
