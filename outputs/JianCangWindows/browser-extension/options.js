'use strict';

const connect = document.getElementById('connect');
const forget = document.getElementById('forget');
const status = document.getElementById('status');
const last = document.getElementById('last');
const dragButton = document.getElementById('auto-drag');
const dragStatus = document.getElementById('auto-drag-status');
const sound = document.getElementById('capture-sound');
const soundStatus = document.getElementById('capture-sound-status');
let dragEnabled = false;

function showAutomaticDrag(enabled) {
  dragEnabled = enabled;
  dragButton.textContent = enabled ? '关闭拖图采集' : '启用拖图采集';
  dragStatus.textContent = enabled ? '已启用。可在浏览器扩展菜单管理各网站的访问权限。' : '已关闭。仍可使用工具栏和右键采集。';
}

async function refresh() {
  const { captureToken, lastCapture, captureSuccessSound } = await chrome.storage.local.get([
    'captureToken', 'lastCapture', 'captureSuccessSound',
  ]);
  forget.hidden = !captureToken;
  connect.hidden = Boolean(captureToken);
  status.textContent = captureToken ? '此浏览器已保存连接。请保持见藏运行。' : '此浏览器尚未连接见藏。';
  last.hidden = !lastCapture?.message;
  last.textContent = lastCapture?.message ? '最近一次采集 · ' + lastCapture.message : '';
  sound.checked = captureSuccessSound !== false;
  sound.disabled = false;
  try {
    const drag = await chrome.runtime.sendMessage({ type: 'jiancang:auto-drag-status' });
    showAutomaticDrag(drag?.enabled === true);
  } catch { showAutomaticDrag(false); }
}

connect.addEventListener('click', async event => {
  if (!event.isTrusted) return;
  connect.disabled = forget.disabled = true;
  status.textContent = '请在见藏中同意连接。';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'jiancang:connect' });
    if (!result?.ok) throw new Error(result?.message || '连接未完成，请重试。');
    await refresh();
    status.textContent = '已连接见藏，可以开始采集。';
  } catch (error) {
    status.textContent = error.message || '连接未完成，请重试。';
  } finally {
    connect.disabled = forget.disabled = false;
  }
});

forget.addEventListener('click', async event => {
  if (!event.isTrusted) return;
  await chrome.storage.local.remove('captureToken');
  await refresh();
});

dragButton.addEventListener('click', async event => {
  if (!event.isTrusted) return;
  const enabling = !dragEnabled;
  dragButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'jiancang:auto-drag-set', enabled: enabling });
    if (!result?.ok) throw new Error(result?.message || '无法修改拖图采集设置，请重试。');
    showAutomaticDrag(result.enabled);
  } catch (error) {
    dragStatus.textContent = error.message || '无法修改拖图采集设置，请重试。';
  } finally {
    dragButton.disabled = false;
  }
});

sound.addEventListener('change', async event => {
  if (!event.isTrusted) return;
  const enabled = sound.checked;
  sound.disabled = true;
  soundStatus.hidden = true;
  try {
    await chrome.storage.local.set({ captureSuccessSound: enabled });
  } catch {
    sound.checked = !enabled;
    soundStatus.textContent = '无法保存提示音设置，请重试。';
    soundStatus.hidden = false;
  } finally {
    sound.disabled = false;
  }
});
void refresh();
