'use strict';

(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const easing = 'cubic-bezier(.22,.75,.24,1)';
  let active;

  function bounds(left, top, right, bottom) {
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function intersection(a, b) {
    return bounds(Math.max(a.left, b.left), Math.max(a.top, b.top),
      Math.min(a.right, b.right), Math.min(a.bottom, b.bottom));
  }

  function viewport() {
    return bounds(0, 0, document.documentElement.clientWidth, document.documentElement.clientHeight);
  }

  function sidePosition(token, space) {
    if (token?.endsWith('%')) return space * parseFloat(token) / 100;
    if (token?.endsWith('px')) return parseFloat(token);
    if (token === 'left' || token === 'top') return 0;
    if (token === 'right' || token === 'bottom') return space;
    return space / 2;
  }

  function imageSize(image) {
    if (image instanceof HTMLCanvasElement && image.dataset.previewSeed) return { width: image.width, height: image.height };
    if (image instanceof HTMLVideoElement && image.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        image.videoWidth && image.videoHeight) {
      return { width: image.videoWidth, height: image.videoHeight };
    }
    return image?.complete && image.naturalWidth && image.naturalHeight
      ? { width: image.naturalWidth, height: image.naturalHeight } : null;
  }

  function imageBounds({ width: naturalWidth, height: naturalHeight }, frame, style) {
    let width = frame.width;
    let height = frame.height;
    const fit = style.objectFit;
    if (fit !== 'fill') {
      const horizontal = frame.width / naturalWidth;
      const vertical = frame.height / naturalHeight;
      let scale = Math.min(horizontal, vertical);
      if (fit === 'cover') scale = Math.max(horizontal, vertical);
      if (fit === 'none') scale = 1;
      if (fit === 'scale-down') scale = Math.min(1, scale);
      width = naturalWidth * scale;
      height = naturalHeight * scale;
    }
    const [x, y] = style.objectPosition.split(/\s+/u);
    const left = frame.left + sidePosition(x, frame.width - width);
    const top = frame.top + sidePosition(y, frame.height - height);
    return bounds(left, top, left + width, top + height);
  }

  function clientBounds(element) {
    const frame = element.getBoundingClientRect();
    const scaleX = frame.width / (element.offsetWidth || frame.width || 1);
    const scaleY = frame.height / (element.offsetHeight || frame.height || 1);
    const left = frame.left + element.clientLeft * scaleX;
    const top = frame.top + element.clientTop * scaleY;
    return bounds(left, top, left + element.clientWidth * scaleX, top + element.clientHeight * scaleY);
  }

  function clips(overflow) { return ['auto', 'hidden', 'scroll', 'clip', 'overlay'].includes(overflow); }

  function capture(image, { clip } = {}) {
    const size = imageSize(image);
    if (!image?.isConnected || !size) return null;
    const frame = image.getBoundingClientRect();
    if (frame.width < 1 || frame.height < 1) return null;
    const style = getComputedStyle(image);
    if (style.visibility !== 'visible') return null;
    const content = imageBounds(size, frame, style);
    const screen = viewport();
    let visible = intersection(intersection(frame, content), screen);
    let radius = parseFloat(style.borderTopLeftRadius) || 0;
    for (let ancestor = image.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      const overflow = getComputedStyle(ancestor);
      const horizontal = clips(overflow.overflowX);
      const vertical = clips(overflow.overflowY);
      if (!horizontal && !vertical) continue;
      const client = clientBounds(ancestor);
      visible = intersection(visible, bounds(horizontal ? client.left : screen.left,
        vertical ? client.top : screen.top, horizontal ? client.right : screen.right,
        vertical ? client.bottom : screen.bottom));
      if (ancestor === image.parentElement && frame.width <= client.width + 2 && frame.height <= client.height + 2) {
        radius = Math.max(radius, parseFloat(overflow.borderTopLeftRadius) || 0);
      }
    }
    if (clip) visible = intersection(visible, clip instanceof Element ? clientBounds(clip) : clip);
    if (visible.width < 4 || visible.height < 4) return null;
    // Capture the decoded frame before disposing the player on exit.
    const isVideo = image instanceof HTMLVideoElement;
    const bitmap = isVideo ? copyImage(image, 1440) : null;
    if (isVideo && !bitmap) return null;
    return { image, bitmap, size, content, visible, radius };
  }

  function fit(content, ratio) {
    const width = Math.min(content.width, content.height * ratio);
    const height = width / ratio;
    const left = content.left + (content.width - width) / 2;
    const top = content.top + (content.height - height) / 2;
    return bounds(left, top, left + width, top + height);
  }

  function destinationFor(snapshot, viewer, { clip } = {}) {
    if (!snapshot || !viewer) return null;
    const frame = clientBounds(viewer);
    const content = fit(frame, snapshot.size.width / snapshot.size.height);
    let visible = intersection(content, viewport());
    if (clip) visible = intersection(visible, clientBounds(clip));
    if (visible.width < 4 || visible.height < 4) return null;
    return { ...snapshot, content, visible, radius: 0 };
  }

  function transformFor(content, bitmap) {
    const target = fit(content, bitmap.width / bitmap.height);
    return `translate3d(${target.left}px,${target.top}px,0) scale(${target.width / bitmap.width})`;
  }

  function clipFor(snapshot, screen) {
    const { visible, radius } = snapshot;
    const insets = [visible.top, screen.right - visible.right, screen.bottom - visible.bottom, visible.left]
      .map(value => `${Math.max(0, value)}px`).join(' ');
    return `inset(${insets} round ${Math.min(radius, 18)}px)`;
  }

  function copyImage(image, maximum) {
    const size = imageSize(image);
    if (!size) return null;
    const scale = Math.min(1, maximum / Math.max(size.width, size.height));
    const bitmap = document.createElement('canvas');
    bitmap.width = Math.max(1, Math.round(size.width * scale));
    bitmap.height = Math.max(1, Math.round(size.height * scale));
    const context = bitmap.getContext('2d');
    if (!context) return null;
    try { context.drawImage(image, 0, 0, bitmap.width, bitmap.height); }
    catch { return null; }
    return bitmap;
  }

  function bitmapFor(from, to) {
    const bitmap = from.bitmap || copyImage(from.image, Math.min(1440, Math.max(to.visible.width, to.visible.height, 160) * 2));
    if (!bitmap) return null;
    Object.assign(bitmap.style, {
      display: 'block', width: `${bitmap.width}px`, height: `${bitmap.height}px`, transformOrigin: '0 0',
      willChange: 'transform',
    });
    return bitmap;
  }

  function finishAnimations(animations, layer, reveal) {
    let finished = false;
    const removeLayer = () => {
      if (finished) return;
      finished = true;
      reveal?.();
      layer?.remove();
      if (active === handle) active = null;
    };
    const handle = {
      shared: !!layer,
      finished: Promise.allSettled(animations.map(animation => animation.finished)).then(removeLayer),
      cancel() {
        for (const animation of animations) animation.cancel();
        removeLayer();
      },
    };
    active = handle;
    return handle;
  }

  function centeredFade(element, phase) {
    if (!element) return null;
    const entering = phase !== 'close';
    const shallow = { opacity: 0 };
    const full = { opacity: 1 };
    return finishAnimations([element.animate(entering ? [shallow, full] : [full, shallow],
      { duration: 145, easing })], null);
  }

  function cancel() { active?.cancel(); }

  function run({ from, to, fade, reveal, phase = 'open', duration = 215 }) {
    cancel();
    if (reduced.matches) return null;
    if (!from || !to) return centeredFade(fade, phase);
    const bitmap = bitmapFor(from, to);
    if (!bitmap) return centeredFade(fade, phase);
    const screen = viewport();
    const startClip = clipFor(from, screen);
    const endClip = clipFor(to, screen);
    const startTransform = transformFor(from.content, bitmap);
    const endTransform = transformFor(to.content, bitmap);
    const layer = document.createElement('div');
    layer.className = 'preview-transition-layer';
    layer.inert = true;
    layer.setAttribute('aria-hidden', 'true');
    Object.assign(layer.style, {
      position: 'fixed', inset: '0', zIndex: '20', pointerEvents: 'none',
      overflow: 'clip', clipPath: startClip, willChange: 'clip-path',
    });
    bitmap.style.transform = startTransform;
    layer.append(bitmap);
    document.body.append(layer);
    const timing = { duration, easing, fill: 'both' };
    return finishAnimations([
      layer.animate([{ clipPath: startClip }, { clipPath: endClip }], timing),
      bitmap.animate([{ transform: startTransform }, { transform: endTransform }], timing),
    ], layer, reveal);
  }

  window.previewTransitions = { capture, destinationFor, imageSize, copyImage, run, cancel };
})();
