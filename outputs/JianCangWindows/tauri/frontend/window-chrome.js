'use strict';

(() => {
  const invoke = (name, args = []) => window.__TAURI__.core.invoke('library_command', { name, args });
  const closePreferenceKey = 'jiancang.window.close';
  const closeModes = { ask: '每次询问', tray: '最小化到托盘', exit: '退出见藏' };
  const closeCommands = { tray: 'window:hide-to-tray', exit: 'window:close' };
  let closeMode = 'ask';
  let trayAvailable = false;
  let closing = false;
  try {
    const saved = localStorage.getItem(closePreferenceKey);
    if (Object.hasOwn(closeModes, saved)) closeMode = saved;
  } catch {}

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const errorMessage = (error, fallback) => typeof error === 'string' ? error : error?.message || fallback;
  const makeButton = (label, className) => {
    const button = element('button', className, label);
    button.type = 'button';
    return button;
  };
  const checkbox = (text, className) => {
    const label = element('label', className);
    const input = element('input');
    input.type = 'checkbox';
    label.append(input, document.createTextNode(text));
    return { label, input };
  };
  const makeDialog = (id, title, className) => {
    const dialog = element('dialog', className);
    dialog.id = id;
    const head = element('header', 'dialog-head');
    const heading = element('h2', '', title);
    heading.id = id + '-title';
    head.append(heading);
    dialog.append(head);
    dialog.setAttribute('aria-labelledby', heading.id);
    return dialog;
  };

  const controls = document.createElement('div');
  controls.className = 'tauri-window-controls';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', '窗口控制');

  const addControl = (kind, label) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tauri-window-control tauri-window-${kind}`;
    button.setAttribute('aria-label', label);
    button.title = label;
    const mark = document.createElement('span');
    mark.setAttribute('aria-hidden', 'true');
    button.append(mark);
    controls.append(button);
    return button;
  };

  const minimize = addControl('minimize', '最小化');
  const maximize = addControl('maximize', '最大化');
  const close = addControl('close', '关闭');
  const closePrompt = makeDialog('tauri-close-dialog', '关闭见藏', 'tauri-close-dialog');
  close.setAttribute('aria-haspopup', 'dialog');
  close.setAttribute('aria-controls', closePrompt.id);
  const remember = checkbox('记住这次选择', 'tauri-window-check');
  const closeError = element('p', 'tauri-window-settings-status');
  closeError.setAttribute('role', 'status');
  const closeActions = element('div', 'library-dialog-actions');
  const cancel = makeButton('取消', 'outline-button');
  cancel.autofocus = true;
  cancel.addEventListener('click', () => closePrompt.close());
  const sendToTray = makeButton(closeModes.tray, 'outline-button');
  sendToTray.disabled = true;
  sendToTray.addEventListener('click', () => void completeClose('tray', remember.input.checked));
  const exit = makeButton(closeModes.exit, 'primary-button');
  exit.addEventListener('click', () => void completeClose('exit', remember.input.checked));
  closeActions.append(cancel, sendToTray, exit);
  closePrompt.append(remember.label, closeError, closeActions);

  const settings = makeDialog('tauri-window-settings', '窗口与启动设置', 'tauri-window-settings');
  const settingsBody = element('div', 'tauri-window-settings-body');
  const closeSetting = element('label', 'tauri-window-setting', '关闭主窗口时');
  const mode = element('select');
  for (const [value, label] of Object.entries(closeModes)) {
    const option = element('option', '', label);
    option.value = value;
    mode.append(option);
  }
  closeSetting.append(mode);
  mode.value = closeMode;
  mode.addEventListener('change', () => saveCloseMode(mode.value));
  const startup = checkbox('开机自启', 'tauri-window-check');
  startup.input.disabled = true;
  const startupStatus = element('p', 'tauri-window-settings-status');
  startupStatus.setAttribute('role', 'status');
  startupStatus.id = 'tauri-startup-status';
  startup.input.setAttribute('aria-describedby', startupStatus.id);
  const done = makeButton('完成', 'outline-button');
  done.addEventListener('click', () => settings.close());
  const settingsActions = element('div', 'library-dialog-actions');
  settingsActions.append(done);
  settingsBody.append(closeSetting, startup.label, startupStatus);
  settings.append(settingsBody, settingsActions);

  const menu = document.querySelector('#app-menu');
  if (menu) {
    const entry = makeButton('', 'app-menu-command tauri-window-settings-entry');
    const mark = element('span');
    mark.dataset.icon = 'inspector';
    mark.setAttribute('aria-hidden', 'true');
    entry.append(mark, element('span', '', '窗口与启动设置'));
    entry.setAttribute('aria-haspopup', 'dialog');
    entry.setAttribute('aria-controls', settings.id);
    entry.addEventListener('click', () => {
      menu.hidePopover();
      mode.value = closeMode;
      if (!settings.open) settings.showModal();
      void updateStartup();
    });
    document.querySelector('#app-menu-update')?.prepend(entry);
  }

  document.body.toggleAttribute('data-tauri-window-chrome', true);
  document.body.append(controls, closePrompt, settings);

  function saveCloseMode(value) {
    closeMode = value;
    mode.value = value;
    try { localStorage.setItem(closePreferenceKey, value); } catch {}
  }

  async function completeClose(value, rememberChoice) {
    if (closing) return;
    const previous = closeMode;
    closing = true;
    if (rememberChoice) saveCloseMode(value);
    if (closePrompt.open) closePrompt.close();
    try {
      await invoke(closeCommands[value]);
    } catch (error) {
      if (rememberChoice) saveCloseMode(previous);
      remember.input.checked = false;
      closeError.textContent = errorMessage(error, '无法完成关闭窗口操作。');
      closePrompt.showModal();
    } finally {
      closing = false;
    }
  }

  function requestClose() {
    if (closing || closePrompt.open) return;
    if (closeMode === 'exit' || (closeMode === 'tray' && trayAvailable)) {
      void completeClose(closeMode, false);
      return;
    }
    remember.input.checked = false;
    closeError.textContent = '';
    closePrompt.showModal();
  }

  let startupPending = false;
  let startupKnown = false;
  async function updateStartup(requested) {
    if (startupPending) return;
    startupPending = true;
    startup.input.disabled = true;
    startupStatus.textContent = '';
    try {
      const state = requested === undefined
        ? await invoke('window:startup-status')
        : await invoke('window:set-startup', [requested]);
      startupKnown = state?.enabled === true;
      startup.input.checked = startupKnown;
      startup.input.disabled = state?.supported !== true;
      if (startup.input.disabled) startupStatus.textContent = '安装 Windows 正式版后可用。';
    } catch (error) {
      startup.input.checked = startupKnown;
      startup.input.disabled = requested === undefined;
      startupStatus.textContent = errorMessage(error, '无法读取 Windows 启动设置。');
    } finally {
      startupPending = false;
    }
  }

  startup.input.addEventListener('change', () => void updateStartup(startup.input.checked));
  window.addEventListener('focus', () => { if (settings.open) void updateStartup(); });

  function render({ maximized, trayAvailable: canUseTray } = {}) {
    if (typeof canUseTray === 'boolean') {
      trayAvailable = canUseTray;
      sendToTray.disabled = !trayAvailable;
      mode.querySelector('[value="tray"]').disabled = !trayAvailable;
    }
    if (typeof maximized !== 'boolean') return;
    maximize.toggleAttribute('data-restorable', maximized);
    const label = maximized ? '还原窗口' : '最大化';
    maximize.setAttribute('aria-label', label);
    maximize.title = label;
  }

  const toggleMaximized = () => void invoke('window:toggle-maximize').then(render).catch(() => {});
  minimize.addEventListener('click', () => void invoke('window:minimize').catch(() => {}));
  maximize.addEventListener('click', toggleMaximized);
  close.addEventListener('click', requestClose);
  window.addEventListener('jiancang-window-close-requested', requestClose);
  document.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.defaultPrevented || !event.isTrusted || document.fullscreenElement ||
        document.querySelector('dialog:modal, #app-menu:popover-open') ||
        !event.target.closest?.('body > .app-bar, body > .viewer-toolbar') ||
        event.target.closest('button, input, select, textarea, a, label, [contenteditable], [role=button], [popover]')) return;
    if (event.detail === 2) toggleMaximized();
    else if (event.detail === 1) void invoke('window:drag').catch(() => {});
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => void invoke('window:state').then(render).catch(() => {}), 85);
  });
  void invoke('window:state').then(render).catch(() => {});
})();
