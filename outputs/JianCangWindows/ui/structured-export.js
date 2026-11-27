'use strict';

(() => {
  const counts = new Intl.NumberFormat('zh-CN');

  function element(tag, className, label) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label) node.textContent = label;
    return node;
  }

  function button(label, className, action) {
    const node = element('button', className, label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function layoutChoice(value, title, detail, onChange) {
    const label = element('label', 'structured-export-choice');
    const input = element('input');
    input.type = 'radio';
    input.name = 'structured-export-layout';
    input.value = value;
    input.checked = value === 'flat';
    input.addEventListener('change', onChange);
    const description = element('div');
    description.append(element('strong', '', title), element('span', '', detail));
    label.append(input, description);
    return { label, input };
  }

  window.createJianCangExportPresets = ({ scope, title, readSettings, applySettings, normalizeSettings }) => {
    const storageKey = `jiancang-export-presets-v1:${scope}`;
    const maxPresets = 64;
    let presets = [];
    let blocked = false;

    const panel = element('fieldset', 'export-presets');
    const select = element('select');
    select.setAttribute('aria-label', title);
    const saveAs = button('保存为预设', 'outline-button', () => {
      editor.hidden = false;
      name.value = '';
      showMessage();
      name.focus();
    });
    const update = button('更新预设', 'outline-button', () => {
      const settings = normalizeSettings(readSettings());
      if (!settings || !select.value) return;
      persist(presets.map(item => item.name === select.value ? { ...item, settings } : item), select.value, '已更新预设。');
    });
    const remove = button('删除预设', 'outline-button', () => {
      if (!select.value) return;
      persist(presets.filter(item => item.name !== select.value), '', '已删除预设。');
      select.focus();
    });
    const row = element('div', 'export-presets-row');
    row.append(select, saveAs, update, remove);

    const editor = element('div', 'export-presets-row');
    const name = element('input');
    name.type = 'text';
    name.maxLength = 64;
    name.placeholder = '输入预设名称';
    name.setAttribute('aria-label', '预设名称');
    const save = button('保存', 'outline-button', savePreset);
    const cancel = button('取消', 'outline-button', () => {
      editor.hidden = true;
      showMessage();
      saveAs.focus();
    });
    editor.append(name, save, cancel);
    editor.hidden = true;
    const message = element('p', 'structured-export-secondary');
    message.setAttribute('role', 'status');
    panel.append(element('legend', '', title), row, editor, message);

    function showMessage(text = '') {
      message.textContent = text;
      message.hidden = !text;
    }

    function renderSelection(selected = '') {
      select.replaceChildren(new Option(presets.length ? '选择预设' : '暂无预设', ''),
        ...presets.map(item => new Option(item.name, item.name)));
      select.value = selected;
      setDisabled(blocked);
    }

    function setDisabled(disabled) {
      blocked = disabled;
      panel.disabled = disabled;
      const current = normalizeSettings(readSettings());
      update.hidden = remove.hidden = !select.value;
      update.disabled = save.disabled = saveAs.disabled = !current;
    }

    function persist(next, selected, text) {
      try { localStorage.setItem(storageKey, JSON.stringify(next)); }
      catch { showMessage('无法保存预设，请检查应用数据目录。'); return false; }
      presets = next;
      renderSelection(selected);
      showMessage(text);
      return true;
    }

    function savePreset() {
      if (blocked) return;
      const settings = normalizeSettings(readSettings());
      const label = name.value.trim().normalize();
      if (!settings) { showMessage('请先填写有效的导出设置。'); return; }
      if (!label || label.length > 64) { showMessage('请输入 1 到 64 个字符的预设名称。'); name.focus(); return; }
      if (presets.some(item => item.name.toLowerCase() === label.toLowerCase())) {
        showMessage('已有同名预设。可以选择该预设后点击更新。');
        name.focus();
        return;
      }
      if (presets.length >= maxPresets) { showMessage('最多保存 64 个预设，请先删除一个。'); return; }
      if (persist([...presets, { name: label, settings }], label, '已保存预设。')) {
        editor.hidden = true;
        select.focus();
      }
    }

    select.addEventListener('change', () => {
      const selected = presets.find(item => item.name === select.value);
      editor.hidden = true;
      showMessage();
      if (selected) applySettings(selected.settings);
      setDisabled(blocked);
    });
    name.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      savePreset();
    });

    return {
      panel,
      setDisabled,
      reset() {
        presets = [];
        try {
          const stored = JSON.parse(localStorage.getItem(storageKey));
          if (Array.isArray(stored)) {
            for (const item of stored.slice(0, maxPresets)) {
              const label = typeof item?.name === 'string' ? item.name.trim().normalize() : '';
              const settings = normalizeSettings(item?.settings);
              if (label && label.length <= 64 && settings &&
                !presets.some(preset => preset.name.toLowerCase() === label.toLowerCase())) {
                presets.push({ name: label, settings });
              }
            }
          }
        } catch { /* Use an empty list when no profile settings can be read. */ }
        editor.hidden = true;
        showMessage();
        renderSelection();
      },
    };
  };

  window.createJianCangStructuredExport = ({ bridge, notify = () => {} }) => {
    let references = [];
    let destination = null;
    let plan = null;
    let busy = false;
    let choosing = false;
    let rechecking = false;
    let previewGeneration = 0;
    let result = null;
    let previousDirectory = '';

    const dialog = element('dialog', 'local-intake-dialog structured-export-dialog');
    dialog.id = 'structured-export-dialog';
    dialog.setAttribute('aria-labelledby', 'structured-export-title');
    const title = element('h2', '', '结构化导出');
    title.id = 'structured-export-title';
    const header = element('div', 'dialog-head');
    const close = button('×', 'icon-button', () => dialog.close());
    close.setAttribute('aria-label', '关闭导出');
    header.append(title, close);

    const body = element('div', 'structured-export-body');
    const setup = element('div', 'structured-export-setup');
    const layout = element('fieldset', 'structured-export-layout');
    layout.append(element('legend', '', '保存方式'));
    const flat = layoutChoice('flat', '平铺', '把所选原件保存到同一个文件夹。', () => void refreshPlan());
    const collections = layoutChoice('collections', '保留集合层级', '按素材库和子集合保存。素材属于多个集合时，放入其中层级最深的一个。', () => void refreshPlan());
    layout.append(flat.label, collections.label);

    const extras = element('label', 'structured-export-choice structured-export-extras');
    const includeMetadata = element('input');
    includeMetadata.type = 'checkbox';
    includeMetadata.id = 'structured-export-metadata';
    includeMetadata.addEventListener('change', () => void refreshPlan());
    const metadataText = element('div');
    const metadataDescription = element('span');
    metadataText.append(element('strong', '', '附带素材清单 CSV'),
      metadataDescription);
    extras.append(includeMetadata, metadataText);
    const presets = window.createJianCangExportPresets({
      scope: 'originals',
      title: '原件导出预设',
      readSettings: settings,
      applySettings({ layout, includeMetadata: metadata }) {
        (layout === 'collections' ? collections : flat).input.checked = true;
        includeMetadata.checked = metadata;
        void refreshPlan();
      },
      normalizeSettings(value) {
        if (['flat', 'collections'].includes(value?.layout) && typeof value.includeMetadata === 'boolean') {
          return { layout: value.layout, includeMetadata: value.includeMetadata };
        }
      },
    });

    const output = element('section', 'structured-export-output');
    const destinationHeading = element('h3', '', '导出位置');
    const destinationPath = element('div', 'structured-export-path');
    destinationPath.id = 'structured-export-path';
    const choose = button('选择文件夹…', 'outline-button', () => void pickDirectory());
    choose.id = 'structured-export-choose';
    output.append(destinationHeading, element('div', 'structured-export-path-row'));
    output.lastElementChild.append(destinationPath, choose);
    output.append(element('p', 'structured-export-secondary', '会在所选位置新建「见藏导出」文件夹。同名文件夹会自动编号。'));

    const retryContext = element('p', 'structured-export-secondary structured-export-retry-context');
    const totals = element('p', 'structured-export-totals');
    totals.setAttribute('role', 'status');
    const recheck = button('重新核对原件', 'outline-button', () => void refreshPlan(true));
    recheck.id = 'structured-export-recheck';
    const summary = element('div', 'structured-export-summary');
    summary.append(totals, recheck);
    const examples = element('ul', 'structured-export-examples');
    examples.setAttribute('aria-label', '预计目录');
    const notice = element('p', 'local-intake-error structured-export-notice');
    notice.setAttribute('role', 'alert');
    const progress = element('div', 'structured-export-progress');
    const progressText = element('p');
    progressText.setAttribute('role', 'status');
    const progressBar = element('progress');
    progressBar.setAttribute('aria-label', '原件导出进度');
    progress.append(progressText, progressBar);

    const complete = element('section', 'structured-export-result');
    complete.id = 'structured-export-result';
    complete.setAttribute('aria-label', '导出结果');
    setup.append(retryContext, presets.panel, layout, extras, output, summary, examples);
    body.append(setup, progress, complete, notice);
    const footer = element('footer', 'structured-export-footer');
    const dismiss = button('取消', 'outline-button', () => dialog.close());
    const retry = button('重试未导出项', 'primary-button', retryFailures);
    retry.id = 'structured-export-retry';
    const start = button('导出原件', 'primary-button', () => void exportSelection());
    start.id = 'structured-export-start';
    footer.append(dismiss, retry, start);
    dialog.append(header, body, footer);
    document.body.append(dialog);
    dialog.addEventListener('cancel', event => { if (busy || choosing) event.preventDefault(); });

    function settings() { return { layout: collections.input.checked ? 'collections' : 'flat', includeMetadata: includeMetadata.checked }; }

    function showError(value = '') {
      notice.textContent = value;
      notice.hidden = !value;
    }

    function renderControls() {
      flat.input.disabled = collections.input.disabled = includeMetadata.disabled = busy || rechecking || !!result;
      presets.setDisabled(busy || choosing || rechecking || !!result);
      choose.disabled = busy || choosing || !!result;
      close.disabled = dismiss.disabled = busy || choosing;
      start.hidden = !!result;
      start.disabled = busy || choosing || rechecking || !destination || !plan?.available;
      retry.hidden = !result?.failedReferences?.length;
      retry.disabled = busy;
      recheck.hidden = !rechecking && plan?.unavailable === 0;
      recheck.disabled = rechecking || busy || choosing;
      start.textContent = includeMetadata.checked ? '导出原件和清单' : '导出原件';
      dismiss.textContent = result ? '完成' : '取消';
      destinationPath.textContent = destination?.path || '请选择写入位置';
      destinationPath.title = destination?.path || '';
      setup.hidden = !!result;
      complete.hidden = !result;
      progress.hidden = !busy;
    }

    async function refreshPlan(checkAgain = false) {
      if (busy || result || rechecking) return;
      const generation = ++previewGeneration;
      rechecking = checkAgain;
      plan = null;
      examples.replaceChildren();
      totals.textContent = `已选 ${counts.format(references.length)} 份素材，正在核对。`;
      showError();
      renderControls();
      try {
        const info = await bridge.planStructuredExport(references, settings(), checkAgain);
        if (generation !== previewGeneration || !dialog.open) return;
        if (!info || info.ok === false || !Number.isFinite(info.available)) {
          throw new Error(info?.message || '无法读取导出计划。');
        }
        plan = info;
        const parts = [`${counts.format(info.available)} 份可导出`];
        if (info.unavailable) parts.push(`${counts.format(info.unavailable)} 份原件暂不可用`);
        if (info.folderCount > 1) parts.push(`${counts.format(info.folderCount)} 个目录`);
        totals.textContent = parts.join(' · ');
        if (collections.input.checked) {
          examples.append(...(info.examples || []).map(row => {
            const li = element('li', '', row.folder);
            li.title = row.folder;
            return li;
          }));
        }
      } catch (error) {
        if (generation !== previewGeneration || !dialog.open) return;
        totals.textContent = '';
        showError(error.message || '无法读取导出计划。');
      } finally {
        if (generation === previewGeneration) {
          rechecking = false;
          renderControls();
          if (checkAgain && dialog.open && !choosing && !dialog.contains(document.activeElement)) {
            [start, recheck, choose].find(control => !control.disabled && !control.hidden)?.focus();
          }
        }
      }
    }

    async function pickDirectory() {
      if (busy || choosing || result) return;
      choosing = true;
      renderControls();
      try {
        const choice = await bridge.chooseStructuredExportDestination();
        if (choice?.cancelled) return;
        if (!choice?.path || !choice?.token) throw new Error(choice?.message || '未能选中导出位置。');
        destination = choice;
        showError();
      } catch (error) { showError(error.message || '未能选中导出位置。'); }
      finally { choosing = false; renderControls(); }
    }

    function showResult(value) {
      result = value;
      const failed = Array.isArray(value.failed) ? value.failed : [];
      const rows = [element('h3', '', `已导出 ${counts.format(value.written || 0)} 份原件` )];
      if (value.directory) rows.push(element('p', 'structured-export-result-path', value.directory));
      if (previousDirectory) rows.push(element('p', 'structured-export-secondary', `上次导出位置 ${previousDirectory}`));
      if (value.manifest) rows.push(element('p', 'structured-export-secondary', `已写入 ${value.manifest}`));
      if (value.manifestError) rows.push(element('p', 'local-intake-error', `素材清单未写入。${value.manifestError}`));
      if (failed.length) {
        const details = element('details', 'structured-export-failures');
        details.open = true;
        details.append(element('summary', '', `${counts.format(failed.length)} 份素材未导出`));
        const list = element('ul');
        for (const file of failed.slice(0, 80)) {
          const row = element('li');
          row.append(element('strong', '', file.name), element('span', '', file.message));
          list.append(row);
        }
        if (failed.length > 80) list.append(element('li', '', `另外 ${counts.format(failed.length - 80)} 份未显示。`));
        details.append(list);
        rows.push(details);
      }
      complete.replaceChildren(...rows);
    }

    function retryFailures() {
      if (retry.disabled || !result?.failedReferences?.length) return;
      references = result.failedReferences;
      previousDirectory = result.directory || previousDirectory;
      retryContext.hidden = false;
      retryContext.textContent = `本次将重试 ${counts.format(references.length)} 份未导出素材。`;
      if (previousDirectory) retryContext.textContent += `上次导出位置 ${previousDirectory}`;
      result = null;
      void refreshPlan(true);
    }

    async function exportSelection() {
      if (start.disabled) return;
      busy = true;
      showError();
      progressText.textContent = '正在准备导出位置…';
      progressBar.removeAttribute('value');
      renderControls();
      try {
        const completed = await bridge.startStructuredExport(references, settings(), destination.token);
        if (completed?.cancelled) return;
        if (!completed || completed.ok === false && !Array.isArray(completed.failed)) {
          throw new Error(completed?.message || '无法完成导出。');
        }
        showResult(completed);
      } catch (error) { showError(error.message || '无法完成导出。'); }
      finally {
        busy = false;
        renderControls();
        if (result && dialog.open) (retry.hidden ? dismiss : retry).focus();
      }
    }

    bridge.onStructuredExportProgress?.(value => {
      if (!busy || !dialog.open || !Number.isFinite(value?.total)) return;
      if (value.phase === 'manifest') {
        progressText.textContent = '正在写入素材清单…';
        progressBar.removeAttribute('value');
        return;
      }
      progressBar.max = value.total;
      progressBar.value = value.processed;
      progressText.textContent = `已处理 ${counts.format(value.processed)} / ${counts.format(value.total)} 份` +
        ` · 已导出 ${counts.format(value.written)} · 未导出 ${counts.format(value.failed)}`;
    });

    function openReferences(items, board = false) {
      if (busy || choosing || dialog.open) return;
      references = [...new Map(items.map(item => [`${item.registrationId}:${item.id}`, item])).values()];
      if (!references.length) { notify('请先选择要导出的素材。'); return; }
      title.textContent = board ? '导出灵感板原件' : '结构化导出';
      metadataDescription.textContent = board ? '清单包含板内顺序、灵感板备注、素材资料和导出后的相对路径。'
        : '清单包含素材名称、标签、评分、备注、来源网址和导出后的相对路径。';
      flat.input.checked = true;
      includeMetadata.checked = board;
      presets.reset();
      destination = null;
      result = null;
      plan = null;
      rechecking = false;
      previousDirectory = '';
      retryContext.hidden = true;
      complete.replaceChildren();
      showError();
      renderControls();
      dialog.showModal();
      void refreshPlan();
    }

    return {
      open(assets) {
        openReferences(assets.filter(asset => asset?.sourceAssetId && asset?.sourceLibraryId)
          .map(asset => ({ id: asset.sourceAssetId, registrationId: asset.sourceLibraryId })));
      },
      openBoard(board) {
        openReferences(board.entries.map(({ id, registrationId, title, source, note }, index) =>
          ({ id, registrationId, board: { order: index + 1, title, source, note } })), true);
      },
    };
  };
})();
