'use strict';

(() => {
  const origin = location.protocol === 'https:' ? 'https://jiancangmedia.localhost' : 'jiancangmedia://localhost';
  const invoke = window.__TAURI__.core.invoke;
  let pending = Promise.resolve();
  let notifyZoom;

  function command(action, args = {}) {
    const result = pending.then(() => invoke('reference_command', { request: { action, ...args } }))
      .catch(error => { throw new Error(typeof error === 'string' ? error : error?.message || '参考窗操作未完成。'); });
    pending = result.catch(() => {});
    return result;
  }

  async function copyImage(thumbnail) {
    const image = document.getElementById('reference-image');
    if (image.hidden || !image.naturalWidth || !image.naturalHeight) return { ok: false };
    const limit = thumbnail ? 480 : 1600;
    const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('参考图暂时无法复制。'));
      }, 'image/png');
    });
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      return { ok: true };
    } catch {
      return { ok: false, message: '无法访问剪贴板，请在参考窗内按 Ctrl+C 重试。' };
    }
  }

  const controls = {
    mediaUrl: (role, registration, asset) => `${origin}/${role}/${registration}/${asset}`,
    ready: () => command('ready'),
    setImageSize: (width, height) => command('image-size', { width, height }),
    async resize(mode, multiplier, anchorX, anchorY, animate) {
      const result = await command('resize', { mode, multiplier, anchorX, anchorY, animate });
      if (result?.running) notifyZoom?.();
      return result;
    },
    onZoomFrame: callback => { notifyZoom = callback; },
    advanceZoom: () => command('advance-zoom'),
    beginMove: (gesture, x, y) => command('begin-move', { gesture, x, y }),
    move: (gesture, dx, dy) => command('move', { gesture, dx, dy }),
    endMove: gesture => command('end-move', { gesture }),
    menu: (imageVisible, canRetry, opacity) => command('menu', { imageVisible, canRetry, opacity }),
    setPinned: pinned => command('pin', { pinned }),
    close: () => command('close'),
    copyImage,
  };
  if (location.protocol === 'https:') {
    // The Windows reference host is transparent; blend only the page content.
    controls.setOpacity = async opacity => {
      if (!Number.isInteger(opacity) || opacity < 40 || opacity > 100) return { ok: false };
      document.documentElement.style.setProperty('--reference-opacity', String(opacity / 100));
      return { ok: true, opacity };
    };
  }
  window.jiancangReference = Object.freeze(controls);
})();
