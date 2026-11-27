'use strict';

(() => {
  const number = new Intl.NumberFormat('zh-CN');
  const snapshotDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' });
  const phases = {
    reading: '正在读取素材清单…',
    copying: '正在备份原件…',
    verifying: '正在校验并恢复原件…',
    finishing: '正在写入素材库信息…',
  };

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

  window.createJianCangLocalBackup = ({ bridge, getLibraries, notify = () => {}, onRestored = () => {} }) => {
    const schedulesAvailable = Boolean(window.jiancangTauriPlatform && bridge.getLocalBackupPlan);
    let operation = null;
    let cancelling = false;
    let planState = null;
    let planLoading = false;
    let settingsBusy = false;
    let planRequest = 0;
    let planTimer;
    let sourceToken;

    const dialog = element('dialog', 'local-backup-dialog');
    dialog.setAttribute('aria-labelledby', 'local-backup-title');
    const header = element('div', 'dialog-head');
    const title = element('h2', '', '本地素材库备份');
    title.id = 'local-backup-title';
    const close = button('×', 'icon-button', () => dialog.close());
    close.setAttribute('aria-label', '关闭本地素材库备份');
    header.append(title, close);

    const body = element('div', 'local-backup-body');
    const backup = element('section', 'local-backup-action');
    const backupTitle = element('h3', '', '完整备份');
    const backupDetail = element('p', '', '保存原件、集合、标签、回收站和撤销记录。可把整个备份文件夹迁移到另一台电脑。');
    const backupFields = element('div', 'local-backup-fields');
    const library = element('select');
    library.setAttribute('aria-label', '要备份的本地素材库');
    library.addEventListener('change', () => { if (schedulesAvailable) void refreshPlan(true); else renderControls(); });
    const save = button('选择位置并备份…', 'primary-button', () => void run('backup'));
    backupFields.append(library, save);
    backup.append(backupTitle, backupDetail, backupFields);

    const schedule = element('section', 'local-backup-action');
    const scheduleTitle = element('h3', '', '定时增量备份');
    const scheduleDetail = element('p', '', '首次备份全部内容，之后只保存有变化的文件。错过计划时，打开见藏后会补做一次。');
    const scheduleFields = element('div', 'local-backup-schedule');
    const enableLabel = element('label', '');
    const enabled = element('input');
    enabled.type = 'checkbox';
    enableLabel.append(enabled, '启用每日备份');
    const timeLabel = element('label', '', '执行时间');
    const time = element('input');
    time.type = 'time';
    time.value = '02:00';
    timeLabel.append(time);
    scheduleFields.append(enableLabel, timeLabel);
    const planActions = element('div', 'local-backup-buttons');
    const planFolder = button('选择存放位置…', 'outline-button', () => void configure(true));
    const savePlan = button('保存计划', 'outline-button', () => void configure(false));
    const runPlan = button('立即备份', 'primary-button', () => void run('incremental'));
    planActions.append(planFolder, savePlan, runPlan);
    const planLocation = element('p', 'local-backup-path');
    const planSummary = element('p', 'local-backup-plan-summary');
    planSummary.setAttribute('role', 'status');
    schedule.append(scheduleTitle, scheduleDetail, scheduleFields, planActions, planLocation, planSummary);

    const restore = element('section', 'local-backup-action');
    const restoreTitle = element('h3', '', '从备份恢复');
    const restoreDetail = element('p', '', '校验所有原件后，在所选位置创建一个独立的本地素材库。');
    const restoreFields = element('div', 'local-backup-fields');
    const name = element('input');
    name.type = 'text';
    name.maxLength = 160;
    name.autocomplete = 'off';
    name.setAttribute('aria-label', '新素材库名称');
    name.placeholder = '新素材库名称';
    name.addEventListener('input', renderControls);
    const recover = button('从完整备份恢复…', 'outline-button', () => void run('restore'));
    restoreFields.append(name, recover);
    restore.append(restoreTitle, restoreDetail, restoreFields);
    const snapshots = element('select');
    snapshots.setAttribute('aria-label', '要恢复的备份日期');
    snapshots.addEventListener('change', renderControls);
    const snapshotFields = element('div', 'local-backup-fields');
    const chooseSource = button('选择增量备份文件夹…', 'outline-button', () => void listSnapshots());
    const recoverSnapshot = button('恢复所选日期…', 'outline-button', () => void run('snapshot'));
    snapshotFields.append(snapshots, recoverSnapshot);
    const restorePath = element('p', 'local-backup-path');
    if (schedulesAvailable) restore.append(chooseSource, snapshotFields, restorePath);

    const task = element('section', 'local-backup-task');
    task.hidden = true;
    const taskContent = element('div', 'local-backup-task-content');
    const taskLabel = element('p', '');
    taskLabel.setAttribute('role', 'status');
    const meter = element('progress', 'local-backup-progress');
    meter.setAttribute('aria-label', '素材库操作进度');
    taskContent.append(taskLabel, meter);
    const abort = button('取消操作', 'outline-button', () => void cancel());
    task.append(taskContent, abort);

    const result = element('section', 'local-backup-result');
    result.hidden = true;
    const resultTitle = element('p', '');
    resultTitle.setAttribute('role', 'status');
    const location = element('p', 'local-backup-path');
    result.append(resultTitle, location);
    const notice = element('p', 'local-backup-error');
    notice.hidden = true;
    notice.setAttribute('role', 'alert');
    body.append(backup);
    if (schedulesAvailable) body.append(schedule);
    body.append(restore, task, result, notice);
    dialog.append(header, body);
    document.body.append(dialog);

    dialog.addEventListener('cancel', event => { if (operation || settingsBusy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      clearTimeout(planTimer);
      planRequest++;
    });
    function showProgress(update) {
      if (cancelling) return;
      const counts = update.totalFiles > 0 && update.phase !== 'finishing'
        ? ` ${number.format(update.filesDone)} / ${number.format(update.totalFiles)} 个文件` : '';
      const newLabel = `${phases[update.phase] || '正在处理…'}${counts}`;
      if (taskLabel.textContent !== newLabel) taskLabel.textContent = newLabel;
      if (update.totalBytes > 0 && update.phase !== 'finishing') {
        meter.max = update.totalBytes;
        meter.value = update.bytesDone;
      } else {
        meter.removeAttribute('value');
      }
    }

    bridge.onLocalBackupProgress?.(update => {
      const expected = operation === 'backup' || operation === 'incremental' ? 'backup' : 'restore';
      if (operation && update?.operation === expected) showProgress(update);
    });

    function renderControls() {
      const activeSchedule = planState?.running === true;
      const busy = Boolean(operation || settingsBusy || activeSchedule);
      const unavailable = library.selectedOptions[0]?.dataset.unavailable === 'true';
      close.disabled = library.disabled = Boolean(operation || settingsBusy);
      library.disabled ||= !library.value;
      name.disabled = busy;
      recover.disabled = busy || !name.value.trim();
      save.disabled = busy || !library.value || unavailable;
      enabled.disabled = time.disabled = planFolder.disabled = busy || !library.value || planLoading;
      savePlan.disabled = planFolder.disabled || !planState?.plan;
      runPlan.disabled = savePlan.disabled || unavailable;
      chooseSource.disabled = busy;
      snapshots.disabled = busy || !snapshots.value;
      recoverSnapshot.disabled = snapshots.disabled || !name.value.trim();
      abort.disabled = cancelling;
      task.hidden = !(operation || activeSchedule);
    }

    function showError(message = '') {
      notice.textContent = message;
      notice.hidden = !message;
    }

    function refreshLibraries(preferId) {
      const previous = preferId || library.value;
      library.replaceChildren();
      for (const { id, name, status } of getLibraries()) {
        const option = element('option', '', status === 'unavailable' ? `${name}（暂不可用）` : name);
        option.value = id;
        option.dataset.unavailable = String(status === 'unavailable');
        library.append(option);
      }
      if (!library.options.length) {
        const option = element('option', '', '暂无本地素材库');
        option.value = '';
        library.append(option);
      } else if (Array.from(library.options).some(option => option.value === previous)) {
        library.value = previous;
      }
      renderControls();
    }

    function showPlan(reset) {
      const plan = planState?.plan;
      if (reset) {
        enabled.checked = plan?.enabled ?? false;
        time.value = plan?.time ?? '02:00';
      }
      planFolder.textContent = plan ? '更换存放位置…' : '选择存放位置…';
      planLocation.textContent = plan?.directory ?? '';
      planLocation.hidden = !plan;
      const items = [];
      if (planLoading) items.push('正在读取备份计划…');
      else if (planState?.problem) items.push(planState.problem);
      else if (plan) {
        if (planState.running) items.push('正在增量备份。');
        else if (plan.enabled) items.push(`下次备份 ${snapshotDate.format(plan.nextAt)}`);
        else items.push('每日备份已暂停。');
        if (plan.last) {
          const states = { complete: '已完成', unchanged: '素材库没有变化', cancelled: '已取消', failed: '未完成' };
          items.push(`最近 ${snapshotDate.format(plan.last.at)} ${states[plan.last.state] ?? ''}`);
          if (plan.last.message) items.push(plan.last.message);
        }
      }
      const summary = items.join(' · ');
      if (planSummary.textContent !== summary) planSummary.textContent = summary;
      planSummary.hidden = !summary;
      if (!operation && planState?.running) showProgress(planState.progress || { phase: 'reading' });
      else if (!operation) cancelling = false;
      renderControls();
    }

    async function refreshPlan(reset = false) {
      const current = ++planRequest;
      if (reset) {
        planState = null;
        planLoading = Boolean(library.value);
        showPlan(true);
      }
      if (!library.value || settingsBusy) return;
      const runningHere = () => dialog.open && current === planRequest;
      try {
        const status = await bridge.getLocalBackupPlan(library.value);
        if (runningHere()) planState = status;
      } catch (error) {
        if (runningHere()) planState = { problem: error?.message || '无法读取增量备份计划。' };
      } finally {
        if (runningHere()) { planLoading = false; showPlan(reset); }
      }
    }

    async function pollPlan() {
      if (!dialog.open) return;
      if (!settingsBusy && !planLoading && !operation) await refreshPlan();
      if (dialog.open) planTimer = setTimeout(() => void pollPlan(), 850);
    }

    async function updateSettings(action) {
      if (settingsBusy || operation || planState?.running) return;
      planRequest++;
      settingsBusy = true;
      showError();
      renderControls();
      try { await action(); }
      catch (error) { showError(error?.message || '无法读取或保存增量备份设置。'); }
      finally { settingsBusy = false; renderControls(); }
    }

    async function configure(selectDirectory) {
      await updateSettings(async () => {
        const status = await bridge.configureLocalBackup(library.value, { enabled: enabled.checked, time: time.value }, selectDirectory);
        if (status?.cancelled) return;
        planState = status;
        showPlan(true);
        notify('已保存增量备份计划。');
      });
    }

    function renderSnapshots(receipt) {
      snapshots.replaceChildren();
      sourceToken = receipt?.token;
      restorePath.textContent = receipt?.directory ?? '';
      restorePath.hidden = !receipt?.directory;
      if (!receipt?.snapshots.length) {
        const option = element('option', '', receipt ? '还没有完成的备份' : '请选择增量备份文件夹');
        option.value = '';
        snapshots.append(option);
      }
      for (const snapshot of receipt?.snapshots ?? []) {
        const option = element('option', '', snapshotDate.format(new Date(snapshot.createdAt)));
        option.value = snapshot.id;
        snapshots.append(option);
      }
      renderControls();
    }

    async function listSnapshots() {
      await updateSettings(async () => {
        const receipt = await bridge.listLocalBackupSnapshots();
        if (receipt?.cancelled) return;
        if (!receipt?.ok) throw new Error(receipt?.message || '无法读取这份增量备份。');
        renderSnapshots(receipt);
      });
    }

    async function cancel() {
      if (!(operation || planState?.running) || cancelling) return;
      cancelling = true;
      taskLabel.textContent = '正在取消…';
      renderControls();
      try {
        const result = await bridge.cancelLocalBackup();
        if (!result?.ok) throw new Error();
      }
      catch {
        if (operation || planState?.running) taskLabel.textContent = '正在处理…';
        cancelling = false;
        renderControls();
      }
    }

    async function run(next) {
      if (operation || settingsBusy || planState?.running) return;
      const selectedId = library.value;
      const requestedName = name.value.trim();
      operation = next;
      result.hidden = true;
      showError();
      const startMessages = { backup: '请选择备份保存位置。', incremental: '正在检查素材库的变动…',
        restore: '请选择备份文件夹，再选择新库的保存位置。', snapshot: '请选择新库的保存位置。' };
      taskLabel.textContent = startMessages[next];
      meter.removeAttribute('value');
      renderControls();
      try {
        let receipt;
        switch (next) {
          case 'backup': receipt = await bridge.createLocalBackup(selectedId); break;
          case 'incremental': receipt = await bridge.runLocalBackupPlan(selectedId); break;
          case 'snapshot': receipt = await bridge.restoreLocalBackupSnapshot(requestedName, sourceToken, snapshots.value); break;
          default: receipt = await bridge.restoreLocalBackup(requestedName);
        }
        if (receipt?.cancelled) return;
        if (!receipt?.ok) throw new Error(receipt?.message || '无法完成素材库操作。');
        const originals = number.format(Math.max(0, receipt.files - 1));
        const restored = next === 'restore' || next === 'snapshot';
        const message = restored ? `「${receipt.name}」已恢复，包含 ${originals} 份原件。` :
          receipt.unchanged ? `「${receipt.name}」的内容和上次备份一致。` : `「${receipt.name}」已备份，包含 ${originals} 份原件。`;
        resultTitle.textContent = message;
        location.textContent = receipt.directory;
        result.hidden = false;
        if (restored) {
          try { await onRestored(receipt); }
          catch { showError('已恢复素材库。可在素材库菜单中手动添加这个文件夹。'); }
          refreshLibraries(receipt.registrationId);
        }
        notify(message);
      } catch (error) {
        showError(error?.message || '无法完成素材库操作。');
      } finally {
        cancelling = false;
        operation = null;
        renderControls();
        if (schedulesAvailable && dialog.open) void refreshPlan(next === 'restore' || next === 'snapshot');
      }
    }

    return {
      open(preferId) {
        if (dialog.open) return;
        name.value = '恢复的见藏库';
        refreshLibraries(preferId);
        showError();
        result.hidden = true;
        dialog.showModal();
        if (schedulesAvailable) {
          renderSnapshots();
          void refreshPlan(true);
          clearTimeout(planTimer);
          planTimer = setTimeout(() => void pollPlan(), 850);
        }
        if (!library.disabled) library.focus();
        else name.focus();
      },
    };
  };
})();
