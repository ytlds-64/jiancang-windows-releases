'use strict';

const image = document.getElementById('reference-image');
const status = document.getElementById('reference-status');
const canvas = document.querySelector('.reference-canvas');
const feedback = document.querySelector('.reference-feedback');
const retry = document.getElementById('reference-retry');
const actionStatus = document.getElementById('reference-action-status');
const controls = window.jiancangReference;
const source = /^(original|thumbnail)\/([a-f0-9-]{1,64})\/([a-f0-9]{64})$/iu.exec(location.hash.slice(1));
const supportsOpacity = typeof controls?.setOpacity === 'function';
if (controls && !supportsOpacity) {
  canvas.setAttribute('aria-description', '拖动图片移动窗口，滚轮缩放，双击关闭。按 1 恢复原始大小，右键打开参考窗菜单。');
}
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let showingOriginal = source?.[1] === 'original';
let imageLoad = 0;
let mode = 'fit';
let moving;
let moveGesture = 0;
let shortClicks = 0;
let moveFrame = 0;
let zoomFrame = 0;
let zoomChange = 0;
let zoomAnchor = [0.5, 0.5];
let zoomPointer;
let nativeZoomFrame = 0;
let nativeZoomInFlight = false;
let nativeZoomRequested = false;
let pendingViewport;
let opacity = 100;
let pinned = true;
let changingPin = false;
let copying = false;
let openingMenu = false;
let readinessSignaled = false;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

async function setMode(next) {
  if (image.hidden || moving || !controls) return;
  cancelAnimationFrame(zoomFrame);
  zoomFrame = zoomChange = 0;
  mode = next;
  try {
    const result = await controls.resize(mode, 1, 0.5, 0.5, !reduceMotion.matches);
    if (mode === 'actual' && result?.ok) {
      actionStatus.textContent = result.scale === 1 ? '已恢复原始大小。' : `当前比例 ${Math.round(result.scale * 100)}%。`;
    }
  } catch { /* Keep the current viewport if resizing is unavailable. */ }
}

function zoomBy(change, point) {
  if (image.hidden || moving || !controls || !change) return;
  zoomChange += change;
  zoomAnchor = point ? [
    clamp(point.clientX / canvas.clientWidth, 0, 1),
    clamp(point.clientY / canvas.clientHeight, 0, 1),
  ] : [0.5, 0.5];
  zoomPointer = point ? { x: point.screenX, y: point.screenY } : undefined;
  if (zoomFrame) return;
  zoomFrame = requestAnimationFrame(() => {
    zoomFrame = 0;
    const multiplier = Math.exp(clamp(zoomChange, -2, 2));
    zoomChange = 0;
    if (moving || image.hidden) return;
    mode = 'step';
    void controls.resize(mode, multiplier, ...zoomAnchor, !reduceMotion.matches, zoomPointer).catch(() => {});
  });
}

function scheduleNativeZoom() {
  if (!nativeZoomFrame && !nativeZoomInFlight && nativeZoomRequested && !moving) {
    nativeZoomFrame = requestAnimationFrame(paintNativeZoom);
  }
}

async function paintNativeZoom(now) {
  nativeZoomFrame = 0;
  if (!nativeZoomRequested || moving) return;
  if (pendingViewport) {
    const matches = Math.abs(canvas.clientWidth - pendingViewport.width) <= 1 &&
      Math.abs(canvas.clientHeight - pendingViewport.height) <= 1;
    if (matches || now - pendingViewport.waitSince >= 90) pendingViewport = null;
    // Give the preceding native viewport a frame to paint before resizing again.
    scheduleNativeZoom();
    return;
  }
  nativeZoomInFlight = true;
  nativeZoomRequested = false;
  try {
    const next = await controls.advanceZoom();
    if (next?.running && !moving) {
      nativeZoomRequested = true;
      pendingViewport = { width: next.width, height: next.height, waitSince: performance.now() };
    }
  } catch { /* Leave the latest painted window on screen. */ }
  finally {
    nativeZoomInFlight = false;
    scheduleNativeZoom();
  }
}

controls?.onZoomFrame(() => {
  nativeZoomRequested = true;
  scheduleNativeZoom();
});

function showAfterPaint() {
  if (readinessSignaled || !controls) return;
  readinessSignaled = true;
  requestAnimationFrame(() => requestAnimationFrame(() => void controls.ready().catch(() => {})));
}

function setImage() {
  if (!source) return;
  imageLoad++;
  mode = 'fit';
  cancelAnimationFrame(zoomFrame);
  zoomFrame = zoomChange = 0;
  image.hidden = true;
  feedback.hidden = false;
  status.textContent = '正在读取图片…';
  retry.hidden = true;
  image.removeAttribute('src');
  const role = showingOriginal ? 'original' : 'thumbnail';
  if (controls?.mediaUrl) {
    image.crossOrigin = 'anonymous';
    image.src = controls.mediaUrl(role, source[2], source[3]);
  } else {
    image.src = `jiancang://${role}/${source[2]}/${source[3]}`;
  }
}

image.addEventListener('load', async () => {
  const load = imageLoad;
  try { await controls?.setImageSize(image.naturalWidth, image.naturalHeight); } catch { /* Show the decoded image. */ }
  if (load !== imageLoad) return;
  image.hidden = false;
  feedback.hidden = true;
  showAfterPaint();
});
image.addEventListener('error', () => {
  if (showingOriginal) {
    showingOriginal = false;
    setImage();
  } else {
    image.hidden = true;
    feedback.hidden = false;
    status.textContent = '图片暂时无法读取';
    retry.hidden = false;
    showAfterPaint();
  }
});
function retryOriginal() {
  if (moving) return;
  showingOriginal = true;
  setImage();
}
retry.addEventListener('click', retryOriginal);

async function togglePinned() {
  if (!controls || changingPin) return;
  changingPin = true;
  try {
    const result = await controls.setPinned(!pinned);
    if (!result?.ok) throw new Error(result?.message || '参考窗操作未完成。');
    pinned = result.pinned;
    actionStatus.textContent = pinned ? '参考窗已置顶。' : '参考窗已取消置顶。';
  } catch (error) { actionStatus.textContent = error.message; }
  finally { changingPin = false; }
}

async function setOpacity(value) {
  if (!supportsOpacity || !Number.isFinite(value)) return;
  const requested = clamp(Math.round(value), 40, 100);
  if (requested === opacity) return;
  const previous = opacity;
  opacity = requested;
  try {
    const result = await controls.setOpacity(requested);
    if (!result?.ok) throw new Error(result?.message || '参考窗操作未完成。');
    actionStatus.textContent = `不透明度 ${result.opacity}%`;
  } catch (error) {
    if (opacity === requested) opacity = previous;
    actionStatus.textContent = error.message;
  }
}

async function copyReference() {
  if (!controls || image.hidden || copying) return;
  copying = true;
  try {
    const result = await controls.copyImage(!showingOriginal);
    if (!result?.ok) throw new Error(result?.message || '参考图暂时无法复制。');
    actionStatus.textContent = '已复制参考图。';
  } catch (error) { actionStatus.textContent = error.message; }
  finally { copying = false; }
}

function closeReference() {
  if (controls?.close) {
    void controls.close().catch(error => { actionStatus.textContent = error.message; });
  } else {
    window.close();
  }
}

canvas.addEventListener('wheel', event => {
  event.preventDefault();
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 90 : 1);
  if (event.ctrlKey) {
    if (delta) void setOpacity(opacity - Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / 20)));
    return;
  }
  if (!event.target.closest('button')) zoomBy(-delta * 0.0025, event);
}, { passive: false });
canvas.addEventListener('pointerdown', event => {
  if (moving || openingMenu || !controls || image.hidden || event.button !== 0 || !event.isPrimary || event.target.closest('button')) return;
  cancelAnimationFrame(zoomFrame);
  zoomFrame = zoomChange = 0;
  cancelAnimationFrame(nativeZoomFrame);
  nativeZoomFrame = 0;
  nativeZoomRequested = false;
  pendingViewport = null;
  canvas.focus({ preventScroll: true });
  canvas.setPointerCapture(event.pointerId);
  moving = { id: event.pointerId, gesture: ++moveGesture, pressedAt: event.timeStamp,
    x: event.screenX, y: event.screenY, dx: 0, dy: 0, started: false };
  void controls.beginMove(moving.gesture, event.clientX, event.clientY).catch(() => {});
  event.preventDefault();
});
function moveWindow() {
  moveFrame = 0;
  if (moving) void controls.move(moving.gesture, moving.dx, moving.dy).catch(() => {});
}
canvas.addEventListener('pointermove', event => {
  if (moving?.id !== event.pointerId) return;
  if (!(event.buttons & 1)) {
    finishMove();
    return;
  }
  moving.dx = Math.round(event.screenX - moving.x);
  moving.dy = Math.round(event.screenY - moving.y);
  if (!moving.started) {
    if (Math.hypot(moving.dx, moving.dy) < 4) return;
    moving.started = true;
    canvas.classList.add('is-moving');
  }
  if (!moveFrame) moveFrame = requestAnimationFrame(moveWindow);
});
function finishMove(event) {
  if (!moving || (event && moving.id !== event.pointerId)) return;
  const released = event?.type === 'pointerup';
  if (moveFrame) {
    cancelAnimationFrame(moveFrame);
    if (released) moveWindow();
    else moveFrame = 0;
  }
  const shortClick = released && !moving.started && event.timeStamp - moving.pressedAt < 350;
  shortClicks = shortClick ? Math.min(2, shortClicks + 1) : 0;
  void controls.endMove(moving.gesture).catch(() => {});
  const pointerId = moving.id;
  moving = null;
  canvas.classList.remove('is-moving');
  if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
}
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, finishMove);
window.addEventListener('blur', () => {
  shortClicks = 0;
  finishMove();
});

canvas.addEventListener('dblclick', event => {
  if (event.button !== 0 || moving || openingMenu || event.target.closest('button')) return;
  const doubleClick = image.hidden || shortClicks === 2;
  shortClicks = 0;
  if (!doubleClick) return;
  event.preventDefault();
  closeReference();
});

canvas.addEventListener('contextmenu', async event => {
  event.preventDefault();
  if (!controls || moving || openingMenu) return;
  openingMenu = true;
  try {
    const result = await controls.menu(!image.hidden, !showingOriginal || !retry.hidden, opacity);
    if (!result?.ok) throw new Error(result?.message || '无法打开参考窗菜单。');
    const action = result.action;
    if (action === 'copy') void copyReference();
    else if (action === 'retry') retryOriginal();
    else if (action === 'fit' || action === 'actual') void setMode(action);
    else if (action === 'pin') void togglePinned();
    else if (action === 'close') closeReference();
    else if (action?.startsWith('opacity-')) void setOpacity(Number(action.slice(8)));
  } catch (error) { actionStatus.textContent = error.message; }
  finally { openingMenu = false; }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeReference(); return; }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c') {
    event.preventDefault();
    void copyReference();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.toLowerCase() === 'p' && !event.repeat) {
    event.preventDefault();
    void togglePinned();
    return;
  }
  if (event.key.toLowerCase() === 'r' && !event.repeat) {
    event.preventDefault();
    retryOriginal();
    return;
  }
  if (image.hidden) return;
  switch (event.key) {
    case '0': case 'Home': setMode('fit'); break;
    case '1': setMode('actual'); break;
    case 'f': case 'F': setMode(mode === 'actual' ? 'fit' : 'actual'); break;
    case '+': case '=': zoomBy(Math.log(1.2)); break;
    case '-': zoomBy(-Math.log(1.2)); break;
    default: return;
  }
  event.preventDefault();
});
if (source) setImage();
else {
  status.textContent = '图片暂时无法读取';
  showAfterPaint();
}
