'use strict';

(() => {
  const bridge = window.jiancang;
  if (typeof bridge?.windowsUpdateStatus !== 'function') return;
  const fields = Object.fromEntries(['dialog', 'dismiss', 'done', 'retry', 'version', 'status', 'progress', 'package-size',
    'transfer', 'percentage', 'bytes', 'speed', 'settings', 'source', 'form', 'url', 'folder', 'clear', 'restore',
    'automatic', 'install', 'cancel', 'open-release'].map(name =>
    [name, document.getElementById(`windows-update-${name}`)]));
  const setup = Object.fromEntries(['label', 'path', 'location', 'install', 'uninstall', 'status'].map(name =>
    [name, document.getElementById(`windows-installation-${name}`)]));
  const menu = document.getElementById('app-menu');
  const installation = document.getElementById('windows-installation');
  const help = document.getElementById('shortcut-dialog');
  const versionLabels = [document.getElementById('help-app-version'), fields.version];
  const entry = document.getElementById('open-windows-update');
  const urlControls = [fields.url, fields.form.querySelector('label[for="windows-update-url"]'),
    fields.form.querySelector('button[type="submit"]')];
  const busyPhases = new Set(['checking', 'downloading', 'launching']);
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const decimal = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1, useGrouping: false });
  let snapshot;
  let inFlight = false;
  let cancelling = false;
  let actionError = '';
  let changingInstallation = false;
  let installedCopy = false;

  function formatTransferBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    const unit = bytes < 1024 ? 0 : Math.min(sizes.length - 1, Math.floor(Math.log2(bytes) / 10));
    return `${decimal.format(bytes / 1024 ** unit)} ${sizes[unit]}`;
  }

  function showStatus(message) {
    if (fields.status.textContent !== message) fields.status.textContent = message;
    fields.status.hidden = !message;
  }

  function showVersion(version) {
    const label = version ? `当前版本 ${version}` : '暂时无法读取版本';
    for (const field of versionLabels) if (field.textContent !== label) field.textContent = label;
  }

  function showInstallationStatus(message) {
    setup.status.textContent = message;
    setup.status.hidden = !message;
  }

  function syncControls() {
    const busy = inFlight || changingInstallation || busyPhases.has(snapshot?.phase);
    for (const control of fields.form.elements) control.disabled = busy;
    fields.automatic.disabled = fields.install.disabled = fields.retry.disabled = setup.install.disabled = setup.uninstall.disabled = busy;
    fields.cancel.disabled = cancelling;
    fields['open-release'].disabled = busy;
  }

  function renderTransfer(next) {
    const hasTotal = Number.isFinite(next.totalBytes) && next.totalBytes > 0;
    const received = next.bytes ?? 0;
    const showingProgress = next.phase === 'downloading' || next.phase === 'launching' ||
      (hasTotal && received > 0 && ['available', 'error'].includes(next.phase));
    fields['package-size'].hidden = showingProgress || !hasTotal;
    fields['package-size'].textContent = hasTotal ? `安装包 ${formatTransferBytes(next.totalBytes)}` : '';
    fields.progress.hidden = fields.transfer.hidden = !showingProgress;
    fields.progress.max = hasTotal ? next.totalBytes : 1;
    if (hasTotal) fields.progress.value = received;
    else fields.progress.removeAttribute('value');
    fields.percentage.textContent = hasTotal ? `${Math.min(100, Math.floor(received * 100 / next.totalBytes))}%` : '';
    fields.bytes.textContent = `${next.source?.folder ? '已复制' : '已下载'} ${formatTransferBytes(received)} / ${formatTransferBytes(next.totalBytes)}`;
    fields.speed.hidden = next.phase !== 'downloading';
    fields.speed.textContent = `${formatTransferBytes(next.bytesPerSecond ?? 0)}/s`;
  }

  function render(next, syncInputs = false) {
    snapshot = next;
    const transfer = next.source?.folder ? '复制' : '下载';
    if (next.phase !== 'downloading') cancelling = false;
    const labels = {
      checking: '正在检查更新…', current: '已是最新版本。', available: `见藏 ${next.updateVersion} 可以更新。`,
      downloading: next.totalBytes && next.bytes >= next.totalBytes ? '正在校验更新包…' : `正在${transfer} ${next.updateVersion}…`,
      launching: '正在安装更新。安装完成后可选择是否启动见藏。',
    };
    showVersion(next.version);
    const status = next.installed
      ? actionError || (cancelling ? '正在取消…' : next.message || labels[next.phase]) ||
        (next.source ? '' : next.localOnly ? '请选择含见藏 Tauri 签名更新包的文件夹。' : '请输入 GitHub 发布仓库，或选择更新目录。')
      : '当前使用便携版。安装见藏后即可在这里更新。';
    showStatus(status);
    fields.settings.hidden = !next.installed;
    for (const control of urlControls) control.hidden = next.localOnly === true;
    fields.source.textContent = next.source?.folder || next.source?.url || '尚未设置更新通道';
    fields.clear.hidden = !next.source;
    fields.restore.hidden = !next.defaultSource || next.source?.url === next.defaultSource.url;
    fields.install.hidden = !next.updateVersion || ['downloading', 'launching'].includes(next.phase);
    fields.install.textContent = next.bytes > 0 ? `继续${transfer}` : next.phase === 'error' ? `重试${transfer}` : `${transfer}并安装`;
    fields.cancel.hidden = next.phase !== 'downloading';
    fields.cancel.textContent = `取消${transfer}`;
    fields['open-release'].hidden = !next.releasePage || next.phase !== 'error';
    fields.retry.hidden = !next.installed || !next.source || Boolean(next.updateVersion) || !(next.phase === 'error' || actionError);
    fields.done.textContent = next.phase === 'current' ? '确定' : '关闭';
    fields.done.classList.toggle('primary-button', fields.install.hidden);
    fields.done.classList.toggle('outline-button', !fields.install.hidden);
    renderTransfer(next);
    syncControls();
    if (syncInputs) {
      fields.url.value = next.source?.url || '';
      fields.automatic.checked = next.automatic;
    }
  }

  async function run(action, syncInputs = false, checking = false) {
    if (inFlight || changingInstallation) return;
    inFlight = true;
    actionError = '';
    if (snapshot) render(snapshot);
    else syncControls();
    if (checking) {
      showStatus('正在检查更新…');
      fields.retry.hidden = true;
    }
    let value;
    try { value = await action(); }
    catch { value = { ok: false, message: '软件更新未完成，请重试。' }; }
    finally { inFlight = false; }
    if (value?.ok) render(value, syncInputs);
    else {
      if (!value?.cancelled) actionError = value?.message || '软件更新未完成，请重试。';
      if (snapshot) render(snapshot, syncInputs);
      else { showStatus(actionError); syncControls(); }
    }
    return value;
  }

  async function saveSource(action) {
    const next = await run(action, true);
    if (next?.ok && next.source && next.automatic) await run(() => bridge.checkWindowsUpdate());
  }

  async function readUpdateStatus() {
    const earlier = snapshot;
    const state = await bridge.windowsUpdateStatus().catch(() => null);
    if (state?.ok && snapshot === earlier && !inFlight) render(state, true);
    else if (!state && !snapshot && !inFlight) showVersion();
  }

  async function readInstallation() {
    if (!bridge.windowsInstallationStatus) return;
    const state = await bridge.windowsInstallationStatus().catch(() => null);
    installation.hidden = !state?.supported;
    if (installation.hidden) return;
    installedCopy = state.installed;
    setup.label.textContent = state.installed ? '安装位置' : '将安装到';
    setup.path.textContent = state.installed ? state.directory : state.destination;
    setup.location.textContent = state.installed ? '打开安装位置' : '打开程序位置';
    setup.install.textContent = state.installed ? '修复快捷方式' : '安装';
    setup.install.hidden = !state.canManage || state.canRepair === false;
    setup.uninstall.hidden = !state.canManage || !state.installed;
    syncControls();
  }

  async function changeInstallation(action) {
    if (changingInstallation || inFlight || busyPhases.has(snapshot?.phase)) return;
    changingInstallation = true;
    syncControls();
    const uninstalling = action === 'uninstall';
    const operation = uninstalling ? '卸载' : installedCopy ? '修复快捷方式' : '安装';
    showInstallationStatus(uninstalling ? '等待确认卸载…' : `正在启动${operation}…`);
    const result = await bridge.manageWindowsInstallation(action).catch(() => null);
    if (result?.ok) {
      showInstallationStatus(uninstalling ? '见藏将关闭并开始卸载。' : `见藏将关闭并开始${operation}。`);
      return;
    }
    changingInstallation = false;
    syncControls();
    showInstallationStatus(result?.cancelled ? '' : result?.message || '无法启动安装程序，请重试。');
  }

  help.addEventListener('toggle', event => {
    if (event.newState === 'open') void readUpdateStatus();
  });
  menu.addEventListener('toggle', event => {
    if (event.newState === 'closed') {
      installation.open = false;
      return;
    }
    if (event.newState !== 'open') return;
    void readUpdateStatus();
    void readInstallation();
  });
  function checkForUpdate() {
    void run(async () => {
      const state = await bridge.windowsUpdateStatus();
      if (state?.version) showVersion(state.version);
      if (!state?.ok || !state.installed || !state.source || busyPhases.has(state.phase)) return state;
      return bridge.checkWindowsUpdate();
    }, true, true);
  }

  entry.addEventListener('click', () => {
    if (fields.dialog.open) return;
    menu.hidePopover();
    fields.dialog.showModal();
    if (!busyPhases.has(snapshot?.phase) && !snapshot?.updateVersion) checkForUpdate();
  });
  fields.dismiss.addEventListener('click', () => fields.dialog.close());
  fields.done.addEventListener('click', () => fields.dialog.close());
  fields.dialog.addEventListener('close', () => { fields.settings.open = false; });
  fields.retry.addEventListener('click', checkForUpdate);
  fields.form.addEventListener('submit', event => {
    event.preventDefault();
    if (!fields.url.value.trim()) { fields.url.focus(); return; }
    void saveSource(() => bridge.setWindowsUpdateChannel(fields.url.value, fields.automatic.checked));
  });
  fields.folder.addEventListener('click', () => void saveSource(() => bridge.chooseWindowsUpdateFolder(fields.automatic.checked)));
  fields.clear.addEventListener('click', () => void run(() => bridge.setWindowsUpdateChannel('', fields.automatic.checked), true));
  fields.restore.addEventListener('click', () => void saveSource(() => bridge.restoreWindowsUpdateChannel(fields.automatic.checked)));
  fields.automatic.addEventListener('change', () => void saveSource(() => bridge.setWindowsUpdateAutomatic(fields.automatic.checked)));
  fields.install.addEventListener('click', () => void run(() => bridge.installWindowsUpdate()));
  fields['open-release'].addEventListener('click', () => void run(() => bridge.openWindowsUpdateRelease()));
  fields.cancel.addEventListener('click', async () => {
    if (cancelling || snapshot?.phase !== 'downloading') return;
    cancelling = true;
    actionError = '';
    render(snapshot);
    const result = await bridge.cancelWindowsUpdate().catch(() => null);
    if (result?.ok || !cancelling) return;
    cancelling = false;
    actionError = result?.message || '未能取消下载，请重试。';
    render(snapshot);
  });
  setup.location.addEventListener('click', async () => {
    const result = await bridge.openWindowsInstallationLocation().catch(() => null);
    showInstallationStatus(result?.ok ? '' : result?.message || '无法打开程序所在的文件夹。');
  });
  setup.install.addEventListener('click', () => void changeInstallation('install'));
  setup.uninstall.addEventListener('click', () => void changeInstallation('uninstall'));
  bridge.onWindowsUpdateChange(next => {
    if (snapshot?.phase !== next.phase) actionError = '';
    render(next);
  });
  void readUpdateStatus();
})();
