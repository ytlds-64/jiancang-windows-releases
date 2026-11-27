'use strict';

(() => {
  const fieldLabels = { title: '重命名', tags: '追加标签', note: '替换备注' };
  const maximumImages = 40;
  const localProvider = 'lmstudio';
  const selectionKey = 'jiancang-ai-suggestion-selection-v1';
  const accessMessages = {
    'sync-disabled': '当前同步库以只读方式连接。开启双向同步后可应用现有建议。',
    'sync-upgrade': '请在 iPhone 或 iPad 的见藏中将此库升级到格式 6，回到 Windows 刷新后再开启双向同步。',
    'sync-incomplete': 'iCloud 还在同步变更记录。等待读取完整后再应用建议。',
    eagle: '请在 Eagle 中打开同一份库，再开启双向同步，即可应用现有建议。',
    unavailable: '素材或素材库暂不可用。重新连接后可继续。',
    changed: '图片已变化。请重新生成建议后应用。',
  };

  function node(tag, className, text) {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  }

  function button(label, className) {
    const value = node('button', className, label);
    value.type = 'button';
    return value;
  }

  function heading(text, closeDialog, onClose = () => closeDialog.close()) {
    const head = node('div', 'dialog-head ai-head');
    const title = node('h2', '', text);
    title.id = closeDialog.id + '-title';
    const close = button('×', 'icon-button ai-close');
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', onClose);
    head.append(title, close);
    closeDialog.setAttribute('aria-labelledby', title.id);
    return { head, close };
  }

  function inputField(label, control) {
    const wrap = node('label', 'ai-input-field');
    wrap.append(node('span', '', label), control);
    return wrap;
  }

  function messageBox() {
    const element = node('p', 'ai-message');
    element.hidden = true;
    element.setAttribute('role', 'status');
    return element;
  }

  function errorAt(element, text) {
    element.textContent = text || '';
    element.hidden = !text;
  }

  function response(value) {
    if (value?.ok === false) throw new Error(value.message || '操作未完成，请重试。');
    return value;
  }

  const pending = task => task.state === 'waiting' || task.state === 'running';
  const emptyChoices = () => ({ mode: null, overrides: new Map() });

  function remainingFields(task) {
    if (task.state !== 'ready') return [];
    return Object.keys(fieldLabels).filter(key => !task.applied.includes(key) && task.suggestion[key]?.length);
  }

  function needsFill(task, key) {
    const original = task.original;
    if (key === 'tags') return !original?.tags?.some(tag => tag.trim());
    if (key === 'title') return original?.titleNeedsSuggestion ?? !original?.name?.trim();
    return !original?.note?.trim();
  }

  function fieldChoice(choices, task, key) {
    const override = choices.overrides.get(task.taskId)?.get(key);
    if (override !== undefined) return override;
    if (choices.mode === 'all') return false;
    if (choices.mode === 'blank' && needsFill(task, key)) return true;
    return null;
  }

  const chosen = (choices, task, key) => fieldChoice(choices, task, key) !== null;
  const skipped = (choices, task, key) => choices.mode === 'blank' && !needsFill(task, key) &&
    !choices.overrides.get(task.taskId)?.has(key);

  function incomplete(batch, choices) {
    return !!batch && (batch.paused || batch.checkpointFailed || batch.tasks.some(task =>
      task.state !== 'ready' || task.applyError || remainingFields(task).some(key => !skipped(choices, task, key))));
  }

  function savedChoices(batch) {
    const result = emptyChoices();
    try {
      const saved = JSON.parse(localStorage.getItem(selectionKey));
      if (!batch || saved?.id !== batch.id || !Array.isArray(saved.rows)) return result;
      if (saved.mode === 'blank' || saved.mode === 'all') result.mode = saved.mode;
      const ids = new Set(batch.tasks.map(task => task.taskId));
      for (const [taskId, entries] of saved.rows.slice(0, maximumImages)) {
        if (!ids.has(taskId) || !Array.isArray(entries)) continue;
        const choices = entries.slice(0, 3).filter(([key, fillMissing]) =>
          Object.hasOwn(fieldLabels, key) && (typeof fillMissing === 'boolean' || fillMissing === null));
        if (choices.length) result.overrides.set(taskId, new Map(choices));
      }
      return result;
    } catch { return emptyChoices(); }
  }

  function thumbnail(parent, { id, registrationId }) {
    if (!id || !registrationId) return;
    const image = node('img', 'ai-preview');
    image.alt = '';
    image.loading = 'lazy';
    image.src = `jiancang://thumbnail/${registrationId}/${id}`;
    image.addEventListener('error', () => image.remove(), { once: true });
    parent.prepend(image);
  }

  function settingsDialog(bridge, notify, onSaved) {
    const dialog = node('dialog', 'ai-dialog ai-settings');
    dialog.id = 'asset-suggestion-settings';
    const { head } = heading('AI 接口设置', dialog);
    const form = node('form', 'ai-settings-form');
    const provider = node('select');
    for (const [value, title] of [['compatible', 'OpenAI 兼容接口'], [localProvider, 'LM Studio（本机）']]) {
      const option = node('option', '', title);
      option.value = value;
      provider.append(option);
    }
    const endpoint = node('input');
    endpoint.type = 'url';
    endpoint.required = true;
    endpoint.maxLength = 2048;
    endpoint.spellcheck = false;
    const model = node('input');
    model.type = 'text';
    model.required = true;
    model.maxLength = 200;
    model.placeholder = '填写支持图片输入的模型名称';
    model.spellcheck = false;
    const key = node('input');
    key.type = 'password';
    key.autocomplete = 'new-password';
    key.maxLength = 4096;
    const clear = node('input');
    clear.type = 'checkbox';
    const clearField = node('label', 'ai-check ai-clear');
    clearField.append(clear, node('span', '', '清除已保存的密钥'));
    const description = node('p', 'ai-help');
    const keyLabel = inputField('API 密钥', key);
    const fetchModels = button('读取模型', 'outline-button');
    const selection = node('select', 'ai-model-selection');
    selection.setAttribute('aria-label', 'LM Studio 模型列表');
    selection.hidden = true;
    const modelOptions = node('div', 'ai-model-options');
    const modelsStatus = node('p', 'ai-help');
    modelsStatus.setAttribute('role', 'status');
    modelOptions.append(fetchModels, selection, modelsStatus);
    const error = messageBox();
    const footer = node('div', 'ai-footer');
    const save = button('保存', 'primary-button');
    save.type = 'submit';
    footer.append(save);
    form.append(inputField('AI 服务', provider), description, inputField('API 地址', endpoint),
      inputField('模型', model), keyLabel, clearField, modelOptions, error, footer);
    dialog.append(head, form);
    document.body.append(dialog);

    let profiles;
    let shownProvider;
    let activeLookup = 0;
    const drafts = new Map();
    const currentInput = () => ({ endpoint: endpoint.value, model: model.value, key: key.value, clearKey: clear.checked });

    function resetModels() {
      activeLookup++;
      selection.hidden = true;
      selection.replaceChildren();
      modelsStatus.textContent = '';
      fetchModels.disabled = false;
    }

    function showProfile() {
      shownProvider = provider.value;
      const local = shownProvider === localProvider;
      const saved = profiles?.[shownProvider];
      const draft = drafts.get(shownProvider);
      endpoint.value = draft?.endpoint ?? saved?.endpoint ?? '';
      endpoint.placeholder = local ? 'http://127.0.0.1:1234/v1' : 'https://example.com/v1';
      model.value = draft?.model ?? saved?.model ?? '';
      key.value = draft?.key ?? '';
      key.placeholder = saved?.hasKey ? '已保存，留空可保留' : local ? '仅在服务器要求认证时填写' : '根据服务要求填写';
      keyLabel.firstElementChild.textContent = local ? '访问令牌' : 'API 密钥';
      clear.checked = draft?.clearKey ?? false;
      clearField.hidden = !saved?.hasKey;
      description.textContent = local ?
        '在 LM Studio 的 Developer 页面启动服务器，选择支持图片输入的模型。见藏会将用于分析的缩略图交给此本机地址。' :
        '可填基础地址或完整的 /chat/completions 地址。生成建议时会把选中的缩略图发送到填入的服务。';
      modelOptions.hidden = !local;
      resetModels();
      errorAt(error, '');
    }

    function show(config) {
      profiles = config?.profiles;
      drafts.clear();
      provider.value = config?.provider || 'compatible';
      showProfile();
      if (!dialog.open) dialog.showModal();
      provider.focus();
    }

    provider.addEventListener('change', () => {
      drafts.set(shownProvider, currentInput());
      showProfile();
    });
    endpoint.addEventListener('input', resetModels);
    clear.addEventListener('change', () => { if (clear.checked) key.value = ''; resetModels(); });
    key.addEventListener('input', () => { if (key.value) clear.checked = false; resetModels(); });
    selection.addEventListener('change', () => { if (selection.value) model.value = selection.value; });
    fetchModels.addEventListener('click', async () => {
      resetModels();
      const lookup = activeLookup;
      fetchModels.disabled = true;
      modelsStatus.textContent = '正在连接 LM Studio…';
      try {
        const models = response(await bridge.listLocalSuggestionModels(currentInput()));
        if (lookup !== activeLookup || !dialog.open) return;
        modelsStatus.textContent = models.length ?
          `已读取 ${models.length} 个模型。请选择支持图片输入的模型。` : '服务器已连接。请先下载或加载支持图片输入的模型。';
        if (!models.length) return;
        const placeholder = node('option', '', '选择模型');
        placeholder.value = '';
        selection.replaceChildren(placeholder, ...models.map(name => {
          const option = node('option', '', name);
          option.value = name;
          return option;
        }));
        selection.value = models.includes(model.value) ? model.value : '';
        selection.hidden = false;
      } catch (problem) {
        if (lookup === activeLookup) modelsStatus.textContent = problem?.message || '无法读取本机模型。';
      } finally {
        if (lookup === activeLookup) fetchModels.disabled = false;
      }
    });
    dialog.addEventListener('close', () => { key.value = ''; drafts.clear(); resetModels(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (save.disabled) return;
      save.disabled = true;
      provider.disabled = true;
      errorAt(error, '');
      try {
        const config = response(await bridge.saveSuggestionSettings({ provider: provider.value, ...currentInput() }));
        dialog.close();
        onSaved(config);
        notify(config.clearedPreviousKey ? '已保存新地址。原服务的密钥已清除。' : '已保存 AI API 设置。');
      } catch (problem) { errorAt(error, problem?.message); }
      finally { save.disabled = false; provider.disabled = false; }
    });
    return { show };
  }

  window.createJianCangAssetSuggestions = function ({ bridge, openSyncStatus, openEagleWrite, copyAsset, notify = () => {} }) {
    const dialog = node('dialog', 'ai-dialog ai-review');
    dialog.id = 'asset-suggestions';
    const { head, close } = heading('AI 整理建议', dialog, closeReview);
    const setup = button('API 设置', 'outline-button');
    const collapse = button('收起', 'outline-button');
    const headerTools = node('div', 'ai-head-tools');
    headerTools.append(setup, collapse, close);
    head.append(headerTools);
    const intro = node('div', 'ai-intro');
    const statusLine = node('div', 'ai-status-line');
    const statusText = node('p', 'ai-help');
    statusText.setAttribute('role', 'status');
    const progress = node('progress', 'ai-progress');
    progress.setAttribute('aria-label', '生成进度');
    statusLine.append(statusText, progress);
    const recipient = node('p', 'ai-help ai-recipient');
    recipient.hidden = true;
    const checkpointWarning = node('p', 'ai-help ai-checkpoint-warning', '这批进度暂未写入本机，请检查存储。');
    checkpointWarning.hidden = true;
    intro.append(statusLine, recipient, checkpointWarning);
    const body = node('div', 'ai-review-body');
    const issues = messageBox();
    const footer = node('div', 'ai-footer ai-review-footer');
    const bulkControls = node('div', 'ai-bulk-controls');
    const bulkChecks = node('div', 'ai-bulk-checks');
    const bulkHelp = node('p', 'ai-help', '空白项也包含乱码或自动生成的文件名。');
    bulkHelp.id = 'asset-suggestions-blank-help';
    function bulkChoice(kind, text) {
      const control = node('input');
      control.type = 'checkbox';
      control.dataset.aiBulk = kind;
      const label = node('label', 'ai-check');
      label.append(control, node('span', '', text));
      bulkChecks.append(label);
      return control;
    }
    const chooseAll = bulkChoice('all', '勾选全部');
    const chooseBlank = bulkChoice('blank', '勾选空白项');
    chooseBlank.setAttribute('aria-describedby', bulkHelp.id);
    bulkControls.append(bulkChecks, bulkHelp);
    const generate = button('生成建议', 'primary-button');
    const suspend = button('暂停生成', 'outline-button');
    const retryFailed = button('重试失败项', 'outline-button');
    const dismiss = button('取消', 'outline-button');
    const save = button('应用建议', 'primary-button');
    const buttons = node('div', 'ai-footer-buttons');
    buttons.append(dismiss, suspend, retryFailed, generate, save);
    footer.append(bulkControls, buttons);
    dialog.append(head, intro, body, issues, footer);
    document.body.append(dialog);
    const backgroundTask = button('AI 整理', 'status-button ai-background-task');
    backgroundTask.id = 'ai-background-task';
    backgroundTask.hidden = true;
    backgroundTask.setAttribute('aria-controls', dialog.id);
    backgroundTask.setAttribute('aria-haspopup', 'dialog');
    document.querySelector('.status-tools')?.prepend(backgroundTask);

    let config;
    let staged = [];
    let batch;
    let batchId;
    let awaitingStart = false;
    let saving = false;
    let changingProgress = false;
    let dismissing = false;
    let openingAccess = false;
    let accessRefresh = 0;
    let opening = 0;
    let loading = false;
    let choices = emptyChoices();
    let backgroundRevision = 0;
    let discardedBatchId;
    const settings = settingsDialog(bridge, notify, next => { config = next; if (dialog.open) render(); });
    const isRunning = candidate => !!candidate && !candidate.paused && !candidate.stopped && candidate.tasks.some(pending);
    const busy = () => awaitingStart || saving || changingProgress || dismissing || openingAccess || !!batch?.applying;

    async function openSettings() {
      try { config = response(await bridge.suggestionSettings()); settings.show(config); }
      catch (error) { notify(error?.message || '无法读取 AI API 设置。'); }
    }

    function setBatch(next) {
      if (next?.id !== batch?.id) choices = savedChoices(next);
      batch = next;
      if (next) renderBackgroundTask(next);
      if (dialog.open) render();
    }

    function renderBackgroundTask(next) {
      const tasks = next?.tasks ?? [];
      const nextChoices = next?.id === batch?.id ? choices : savedChoices(next);
      backgroundTask.hidden = !incomplete(next, nextChoices);
      if (backgroundTask.hidden) return;
      const count = `${tasks.filter(task => !pending(task)).length}/${tasks.length}`;
      const state = next.paused ? '已暂停' : isRunning(next) ? '处理中' : '待查看';
      backgroundTask.textContent = `AI 整理 · ${state} ${count}`;
      backgroundTask.title = next.checkpointFailed ? 'AI 整理进度尚未保存' : '打开 AI 整理建议';
    }

    function saveChoices() {
      if (!batch?.id) return;
      try {
        const rows = [...choices.overrides].map(([id, fields]) => [id, [...fields]]);
        localStorage.setItem(selectionKey, JSON.stringify({ id: batch.id, mode: choices.mode, rows }));
      } catch { /* Selections remain in memory if the profile is unavailable. */ }
      renderBackgroundTask(batch);
    }

    async function refreshAccess() {
      if (!dialog.open || !batch?.tasks.some(task => remainingFields(task).length)) return;
      const expected = batch.id;
      const request = ++accessRefresh;
      try {
        const next = response(await bridge.getSuggestions());
        if (request !== accessRefresh || !dialog.open || next?.id !== expected || batch?.id !== expected) return;
        const changed = next.tasks.some((task, index) => task.writeBlock !== batch.tasks[index]?.writeBlock ||
          task.writable !== batch.tasks[index]?.writable);
        if (changed) setBatch(next);
      } catch (error) {
        if (request === accessRefresh && dialog.open) errorAt(issues, error?.message);
      }
    }

    function closeReview() {
      if (busy()) return;
      ++opening;
      ++accessRefresh;
      loading = false;
      dialog.close();
    }

    async function dismissReview() {
      if (busy()) return;
      dismissing = true;
      renderToolbar();
      try {
        if (batch?.id) {
          const id = batch.id;
          response(await bridge.discardSuggestions(id));
          discardedBatchId = id;
          renderBackgroundTask(null);
          try { localStorage.removeItem(selectionKey); } catch { /* This batch cannot be reopened. */ }
        }
        ++opening;
        ++accessRefresh;
        loading = false;
        batchId = null;
        setBatch(null);
        dialog.close();
      } catch (error) { errorAt(issues, error?.message); }
      finally { dismissing = false; renderToolbar(); }
    }

    const sameAssets = (first, second) => {
      if (first.length !== second.length) return false;
      const scoped = new Set(first.map(item => `${item.registrationId}:${item.id}`));
      return second.every(item => scoped.has(`${item.registrationId}:${item.id}`));
    };

    async function open(assets) {
      const token = ++opening;
      loading = true;
      if (!dialog.open) dialog.showModal();
      errorAt(issues, '');
      render();
      try {
        const [settingsValue, active] = await Promise.all([bridge.suggestionSettings(), bridge.getSuggestions()]);
        if (token !== opening || !dialog.open) return;
        config = response(settingsValue);
        const activeBatch = response(active);
        if (!activeBatch || activeBatch.id !== discardedBatchId) renderBackgroundTask(activeBatch);
        staged = (assets ?? []).filter(asset => !asset.trashed && (asset.kind === 'image' || asset.extension === 'livp'))
          .map(asset => ({ id: asset.sourceAssetId, registrationId: asset.sourceLibraryId, name: asset.name }));
        if (activeBatch?.id && activeBatch.id !== discardedBatchId &&
            (!staged.length || sameAssets(staged, activeBatch.tasks) || isRunning(activeBatch) || activeBatch.paused || activeBatch.applying)) {
          if (!sameAssets(staged, activeBatch.tasks)) staged = activeBatch.tasks.map(({ id, registrationId, name }) => ({ id, registrationId, name }));
          batchId = activeBatch.id;
          setBatch(activeBatch);
        } else {
          batchId = null;
          setBatch(null);
        }
      } catch (error) {
        if (token === opening) errorAt(issues, error?.message || '无法读取 AI 整理状态。');
      } finally {
        if (token === opening) { loading = false; if (dialog.open) render(); }
      }
    }

    const candidateFields = task => task.writable ? remainingFields(task) : [];

    function renderToolbar() {
      const working = isRunning(batch);
      const paused = batch?.paused === true;
      const pendingSuggestions = batch?.tasks.some(pending);
      const options = batch?.tasks.flatMap(task => candidateFields(task).map(key => [task, key])) ?? [];
      const selected = options.filter(([task, key]) => chosen(choices, task, key));
      const checked = selected.length;
      const hasMissingOnly = selected.some(([task, key]) => fieldChoice(choices, task, key) === true);
      const fillOptions = options.filter(([task, key]) => needsFill(task, key));
      const filled = fillOptions.filter(([task, key]) => fieldChoice(choices, task, key) === true).length;
      bulkControls.hidden = !options.length && !pendingSuggestions;
      chooseAll.checked = checked > 0 && checked === options.length && !hasMissingOnly || !options.length && choices.mode === 'all';
      chooseAll.indeterminate = checked > 0 && !chooseAll.checked;
      chooseAll.disabled = loading || busy() || !options.length && !pendingSuggestions;
      chooseBlank.checked = choices.mode === 'blank' && filled === fillOptions.length && checked === filled;
      chooseBlank.indeterminate = (choices.mode === 'blank' || filled > 0) && !chooseBlank.checked;
      chooseBlank.disabled = loading || busy() || !fillOptions.length && !pendingSuggestions;
      generate.hidden = working || paused;
      generate.disabled = loading || busy() || !config?.configured || !staged.length || staged.length > maximumImages;
      generate.textContent = batch?.id ? '重新生成' : '生成建议';
      generate.className = batch?.id ? 'outline-button' : 'primary-button';
      suspend.hidden = !working && !paused;
      suspend.disabled = loading || busy() || paused && !batch.canResume;
      suspend.textContent = paused ? '继续生成' : '暂停生成';
      retryFailed.hidden = !batch?.tasks.some(task => task.state === 'failed');
      retryFailed.disabled = loading || busy() || paused || batch?.stopped === true;
      collapse.hidden = !batch;
      collapse.textContent = working ? '收起到后台' : '收起';
      close.setAttribute('aria-label', batch ? '收起 AI 整理建议' : '关闭');
      dismiss.textContent = working || paused ? '取消任务' : batch ? '清除建议' : '取消';
      close.disabled = collapse.disabled = dismiss.disabled = setup.disabled = busy();
      save.hidden = !batch;
      save.disabled = loading || busy() || !checked;
      save.textContent = saving ? '正在应用…' : checked ? `应用 ${checked} 个字段` : '应用建议';
    }

    function fieldPreview(task, key) {
      const value = task.suggestion[key];
      if (!value?.length) return null;
      const row = node('div', 'ai-review-field');
      const remaining = remainingFields(task).includes(key);
      const label = node(remaining ? 'label' : 'div', 'ai-check');
      if (remaining) {
        const control = node('input');
        control.type = 'checkbox';
        control.dataset.aiChoice = `${task.taskId}:${key}`;
        control.setAttribute('aria-label', `${task.name} ${fieldLabels[key]}`);
        control.checked = task.writable && chosen(choices, task, key);
        control.disabled = !task.writable || busy();
        control.addEventListener('change', () => {
          const fields = choices.overrides.get(task.taskId) ?? new Map();
          fields.set(key, control.checked ? choices.mode === 'blank' && needsFill(task, key) : null);
          choices.overrides.set(task.taskId, fields);
          saveChoices();
          render();
        });
        label.append(control);
      }
      const suffix = task.applied.includes(key) ? ' · 已应用' : skipped(choices, task, key) ? ' · 已跳过' : '';
      label.append(node('span', '', fieldLabels[key] + suffix));
      row.append(label);
      if (key === 'tags') {
        const tags = node('div', 'ai-tags');
        const existing = new Set(task.original?.tags?.map(tag => tag.toLowerCase()) ?? []);
        for (const tag of value) {
          const chip = node('span', 'ai-tag', tag);
          if (existing.has(tag.toLowerCase())) { chip.classList.add('was-present'); chip.title = '素材已有此标签'; }
          tags.append(chip);
        }
        row.append(tags);
      } else row.append(node('p', '', value));
      if (key === 'note' && task.original?.note) {
        const note = node('details', 'ai-original-note');
        note.append(node('summary', '', '查看原备注'), node('p', '', task.original.note));
        row.append(note);
      }
      return row;
    }

    function taskPreview(task) {
      const item = node('article', 'ai-task');
      const title = node('header', 'ai-task-heading');
      thumbnail(title, task);
      const labels = node('div');
      labels.append(node('strong', '', task.name));
      if (task.state === 'ready' && !task.writable) labels.append(node('small', '', '只读素材'));
      if (task.applied.length) labels.append(node('small', '', task.pending ?
        `${task.applied.length} 个字段已加入同步队列` : `已应用 ${task.applied.length} 个字段`));
      title.append(labels);
      if (task.state === 'failed' && !batch.stopped && !batch.paused) {
        const retry = button('重试', 'outline-button');
        retry.disabled = busy();
        retry.addEventListener('click', () => void retrySuggestions(task.taskId));
        title.append(retry);
      }
      item.append(title);
      if (task.state === 'ready') {
        if (!task.writable && remainingFields(task).length) item.append(writeAccessNote(task));
        const content = node('div', 'ai-review-fields');
        for (const key of Object.keys(fieldLabels)) {
          const row = fieldPreview(task, key);
          if (row) content.append(row);
        }
        item.append(content);
      } else item.append(node('p', task.state === 'failed' ? 'ai-task-error' : 'ai-help',
        task.error || (pending(task) && batch.paused ? '等待继续' : task.state === 'waiting' ? '等待生成' : '正在分析缩略图…')));
      if (task.applyError) item.append(node('p', 'ai-task-error', task.applyError));
      return item;
    }

    function writeAccessNote(task) {
      const note = node('div', 'ai-write-access');
      note.append(node('p', 'ai-help', accessMessages[task.writeBlock] || '素材暂不可写，请检查素材库权限。'));
      const sync = task.writeBlock?.startsWith('sync-');
      const eagle = task.writeBlock === 'eagle';
      const open = sync ? openSyncStatus : eagle ? openEagleWrite : null;
      if (open) {
        const manage = button(eagle || task.writeBlock === 'sync-disabled' ? '开启双向同步' : '查看同步状态', 'outline-button');
        manage.addEventListener('click', async () => {
          if (busy()) return;
          openingAccess = true;
          manage.disabled = true;
          renderToolbar();
          try {
            await open(task.registrationId);
            await refreshAccess();
          } catch (error) { errorAt(issues, error?.message); }
          finally { openingAccess = false; render(); }
        });
        note.append(manage);
      }
      if (eagle && copyAsset) {
        const copy = button('复制到见藏库…', 'outline-button');
        copy.addEventListener('click', () => { if (!busy()) copyAsset(task); });
        note.append(copy);
      }
      return note;
    }

    function render() {
      const focusedChoice = document.activeElement?.dataset.aiChoice;
      const scrollTop = body.scrollTop;
      recipient.hidden = !batch || isRunning(batch) || loading || (!batch.paused && (!config?.configured || !staged.length));
      if (batch?.paused) recipient.textContent = batch.canResume ?
        `继续时会将未完成的缩略图发送至 ${batch.label}（${batch.model}）。` :
        `请切回本批次使用的 ${batch.label}（${batch.model}）后继续。`;
      else if (!recipient.hidden) recipient.textContent = `重新生成会将 ${staged.length} 张缩略图发送至 ${config.label}（${config.model}）。`;
      checkpointWarning.hidden = !batch?.checkpointFailed || loading;
      if (loading) {
        progress.hidden = true;
        statusText.textContent = '正在读取 AI 整理状态…';
        body.replaceChildren();
      } else if (batch) {
        const total = batch.tasks.length;
        const done = batch.tasks.filter(task => !pending(task)).length;
        const failed = batch.tasks.filter(task => task.state === 'failed').length;
        const blocked = batch.tasks.filter(task => !task.writable && remainingFields(task).length).length;
        statusText.textContent = `${done} / ${total} 项已处理${batch.paused ? '，已暂停' : ''}${failed ? `，${failed} 项${batch.stopped ? '失败' : '待重试'}` : ''}${blocked ? `，${blocked} 项暂不可写` : ''}`;
        progress.max = total || 1;
        progress.value = done;
        progress.hidden = done === total;
        const results = batch.tasks.map(taskPreview);
        body.replaceChildren(...results);
      } else {
        progress.hidden = true;
        statusText.textContent = !staged.length ? '请选择图库里的图片。' : staged.length > maximumImages ?
          `一次最多处理 ${maximumImages} 张，请缩小选择范围。` : config?.configured ?
            `点击生成后，${staged.length} 张缩略图将发送至 ${config.label}（${config.model}）。` : '先在 API 设置中配置支持图片输入的模型。';
        const picks = staged.slice(0, maximumImages).map(asset => {
          const item = node('div', 'ai-pending');
          thumbnail(item, asset);
          item.append(node('span', '', asset.name));
          return item;
        });
        body.replaceChildren(...picks);
      }
      body.scrollTop = scrollTop;
      if (focusedChoice) {
        [...body.querySelectorAll('[data-ai-choice]')].find(input => input.dataset.aiChoice === focusedChoice)?.focus({ preventScroll: true });
      }
      renderToolbar();
    }

    function applyBulkChoice(checked, mode) {
      if (!batch || busy()) return;
      choices = { ...emptyChoices(), mode: checked ? mode : null };
      saveChoices();
      render();
    }
    chooseAll.addEventListener('change', () => applyBulkChoice(chooseAll.checked, 'all'));
    chooseBlank.addEventListener('change', () => applyBulkChoice(chooseBlank.checked, 'blank'));
    async function retrySuggestions(taskId) {
      if (!batch || loading || busy() || batch.paused || batch.stopped) return;
      changingProgress = true;
      errorAt(issues, '');
      render();
      try {
        const next = taskId ? await bridge.retrySuggestion(taskId) : await bridge.retryFailedSuggestions(batch.id);
        setBatch(response(next));
      } catch (error) { errorAt(issues, error?.message); }
      finally { changingProgress = false; if (dialog.open) render(); }
    }
    retryFailed.addEventListener('click', () => void retrySuggestions());
    setup.addEventListener('click', () => void openSettings());
    generate.addEventListener('click', async () => {
      if (busy()) return;
      awaitingStart = true;
      errorAt(issues, '');
      renderToolbar();
      try {
        const next = response(await bridge.startSuggestions(staged.map(({ id, registrationId }) => ({ id, registrationId }))));
        batchId = next.id;
        setBatch(next);
      } catch (error) { errorAt(issues, error?.message); }
      finally { awaitingStart = false; if (dialog.open) render(); }
    });
    suspend.addEventListener('click', async () => {
      if (busy() || !batch) return;
      changingProgress = true;
      errorAt(issues, '');
      renderToolbar();
      try { setBatch(response(await (batch.paused ? bridge.resumeSuggestions(batch.id) : bridge.pauseSuggestions(batch.id)))); }
      catch (error) { errorAt(issues, error?.message); }
      finally { changingProgress = false; render(); }
    });
    dismiss.addEventListener('click', () => void dismissReview());
    collapse.addEventListener('click', closeReview);
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeReview(); });
    backgroundTask.addEventListener('click', () => void open());
    save.addEventListener('click', async () => {
      if (busy() || save.disabled) return;
      const selection = batch?.tasks.flatMap(task => {
        const keys = candidateFields(task).filter(key => chosen(choices, task, key));
        if (!keys.length) return [];
        return [{ taskId: task.taskId, fields: keys, fillMissing: keys.filter(key => fieldChoice(choices, task, key) === true) }];
      });
      if (!selection?.length) return;
      saving = true;
      errorAt(issues, '');
      renderToolbar();
      try {
        const result = response(await bridge.applySuggestions(selection));
        setBatch(result.batch);
        if (result.applied) notify(`已应用 ${result.applied} 项素材的建议。`);
        if (result.failed) errorAt(issues, `${result.failed} 项建议未应用，请核对对应素材的提示。`);
        else if (result.applied && !incomplete(result.batch, choices)) dialog.close();
      } catch (error) { errorAt(issues, error?.message); }
      finally { saving = false; if (dialog.open) render(); }
    });
    bridge.onSuggestionsChange?.(next => {
      backgroundRevision++;
      if (next?.id && next.id === discardedBatchId) return;
      if (next?.ok === false) return;
      renderBackgroundTask(next);
      if (awaitingStart && next?.id && sameAssets(staged, next.tasks)) batchId = next.id;
      if (next?.id && next.id === batchId) setBatch(next);
    });
    void Promise.resolve(bridge.getSuggestions?.()).then(next => {
      if (!backgroundRevision && next?.ok !== false) renderBackgroundTask(next);
    }).catch(() => {});
    return { open, settings: openSettings, refreshAccess };
  };
})();
