'use strict';

(() => {
  if (globalThis.jiancangCollectorListening) return;
  globalThis.jiancangCollectorListening = true;
  const inputListeners = new AbortController();
  const dragOpenDelay = 200;
  const douyin = /^(?:[a-z0-9-]+\.)*douyin\.com$/i.test(location.hostname);
  const socialHosts = /^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/i;
  const social = socialHosts.test(location.hostname);
  const articleSelector = 'article, [role="article"]';
  const minimumSlideSide = 150;
  const batchImageLimit = 40;
  let collector;
  let automatic = false;
  let modeAnnounced = false;
  let imageURL = '';
  let imageSourceLink;
  let lastContextImage;
  let openTimer;
  let dismissNotice;
  let lastPointer;
  let lastImagePress;
  let warmCatalog;
  let warming;
  let destinationsVersion = 0;
  let pointerDrag;

  function contextActive() {
    if (chrome.runtime?.id) return true;
    inputListeners.abort();
    cancelOpen();
    collector?.dismiss(true);
    dismissNotice?.();
    return false;
  }

  function cancelOpen() {
    clearTimeout(openTimer);
    openTimer = undefined;
  }

  function endImageDrag() {
    cancelOpen();
    pointerDrag = undefined;
    imageURL = '';
    imageSourceLink = undefined;
    collector?.endDrag();
  }

  function visibleImageURL(image) {
    const url = image?.currentSrc;
    return image?.complete && image.naturalWidth > 0 && /^(?:https?:|blob:|data:image\/)/i.test(url) ? url : '';
  }

  function findDouyinSlide(event) {
    const origin = event.composedPath()[0];
    if (!(origin instanceof Element)) return null;
    const control = origin.closest('button,input,select,textarea,[contenteditable],[role="button"]');
    const slide = control?.closest('.dySwiperSlide');
    if (control) {
      // The desktop carousel puts an empty, slide-sized button over the photo.
      if (!(control instanceof HTMLButtonElement) || !slide || control.childElementCount ||
          control.textContent.trim() || control.getAttribute('aria-label') || control.title) return null;
      const cover = control.getBoundingClientRect();
      const frame = slide.getBoundingClientRect();
      if (cover.width < frame.width * 0.9 || cover.height < frame.height * 0.9) return null;
    }
    function visibleSlide(image) {
      if (!(image instanceof HTMLImageElement) || !visibleImageURL(image) || /\/douyinDefault\.[^/]+$/i.test(URL.parse(image.currentSrc)?.pathname ?? '') ||
          image.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) return false;
      const rect = image.getBoundingClientRect();
      return rect.width >= minimumSlideSide && rect.height >= minimumSlideSide &&
        event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom &&
        !getComputedStyle(image).filter.includes('blur(');
    }
    const hit = document.elementsFromPoint(event.clientX, event.clientY).find(image => (!slide || slide.contains(image)) && visibleSlide(image));
    if (hit) return hit;
    // A carousel can put a hit surface over an image that has pointer-events:none.
    let surface = slide ?? origin;
    for (let depth = 0; depth < 5 && surface && surface !== document.body && surface !== document.documentElement; depth++) {
      const images = [...surface.querySelectorAll('img')].filter(visibleSlide);
      if (images.length) return images.every(image => image.currentSrc === images[0].currentSrc) ? images[0] : null;
      if (slide) break;
      surface = surface.parentElement;
    }
    return null;
  }

  function startImageDrag(image, anchor, native) {
    imageURL = visibleImageURL(image);
    imageSourceLink = imageURL ? captureLinkForImage(image) : undefined;
    if (!imageURL) return;
    cancelOpen();
    if (collector) collector.startDrag(anchor);
    else if (automatic) {
      openTimer = setTimeout(() => {
        openTimer = undefined;
        if (native?.defaultPrevented && pointerDrag?.native !== native) return endImageDrag();
        if (imageURL && automatic && !collector && contextActive()) {
          collector = mount(true, anchor);
          if (pointerDrag?.point) collector.movePointer(pointerDrag.point);
        }
      }, dragOpenDelay);
    }
  }

  function captureLinkForImage(image) {
    if (!image) return undefined;
    function valid(link) {
      if (!link) return undefined;
      const url = URL.parse(link.href);
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
      if (!social) return url.origin === location.origin && url.pathname !== '/' && url.href !== image.currentSrc ? url.href : undefined;
      return socialHosts.test(url.hostname) && /^\/(?:[a-z\d_]+\/status|i\/web\/status)\/\d+(?:\/|$)/i.test(url.pathname)
        ? url.href : undefined;
    }
    const enclosing = valid(image.closest('a[href]'));
    if (enclosing || !social) return enclosing;
    const post = image.closest(articleSelector);
    if (!post || image.closest('[role="link"]:not(a)')) return undefined;
    const permalinks = new Set();
    for (const time of post.querySelectorAll('a[href] time')) {
      if (time.closest(articleSelector) !== post) continue;
      const href = valid(time.closest('a[href]'));
      if (href) permalinks.add(href);
      if (permalinks.size > 1) return undefined;
    }
    return permalinks.values().next().value;
  }

  function inViewportArea(node) {
    const rect = node.getBoundingClientRect();
    return Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) *
      Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
  }

  function collectBatchImages(anchor) {
    const nearby = anchor ? document.elementsFromPoint(anchor.x, anchor.y) : [];
    const near = selector => nearby.map(node => node.closest(selector)).find(Boolean);
    let scope = near(articleSelector);
    let candidates;
    if (douyin) {
      const slides = [...document.querySelectorAll('.dySwiperSlide')];
      const slide = near('.dySwiperSlide') || slides.map(node => ({ node, area: inViewportArea(node) }))
        .filter(entry => entry.area > 0).sort((a, b) => b.area - a.area)[0]?.node;
      if (slide) candidates = [...slide.parentElement.querySelectorAll('.dySwiperSlide img')]
        .filter(image => image.closest('.dySwiperSlide').parentElement === slide.parentElement);
      else return { images: [], truncated: false };
    } else if (social) {
      const media = [...document.images].filter(image => {
        const url = URL.parse(visibleImageURL(image));
        return url?.hostname === 'pbs.twimg.com' && url.pathname.startsWith('/media/');
      });
      // On a status page, use the main post even if the pointer has moved to a reply.
      const statusId = href => URL.parse(href ?? '')?.pathname.match(/\/status\/(\d+)/)?.[1];
      const pageStatus = statusId(location.href);
      if (pageStatus) scope = media.find(image => statusId(captureLinkForImage(image)) === pageStatus)?.closest(articleSelector);
      if (!scope && !pageStatus) {
        const visible = media.map(image => ({ post: image.closest(articleSelector), area: inViewportArea(image) }));
        scope = visible.filter(entry => entry.post && entry.area > 0).sort((a, b) => b.area - a.area)[0]?.post;
      }
      candidates = scope ? media.filter(image => image.closest(articleSelector) === scope &&
        (!pageStatus || statusId(captureLinkForImage(image)) === pageStatus)) : [];
    } else {
      const articles = document.querySelectorAll(articleSelector);
      scope ??= articles.length === 1 ? articles[0] : undefined;
      candidates = scope?.querySelectorAll('img') ?? document.images;
    }
    const seen = new Set();
    const images = [];
    for (const image of candidates) {
      const url = visibleImageURL(image);
      const side = douyin ? minimumSlideSide : 60;
      if (!url || seen.has(url) || image.naturalWidth < side || image.naturalHeight < side ||
          image.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) continue;
      const rect = image.getBoundingClientRect();
      if (rect.width < side / 2 || rect.height < side / 2 || (douyin && (
          /\/douyinDefault\.[^/]+$/i.test(URL.parse(url)?.pathname ?? '') || getComputedStyle(image).filter.includes('blur(')))) continue;
      if (images.length === batchImageLimit) return { images, truncated: true };
      seen.add(url);
      images.push({ url, sourceLink: captureLinkForImage(image), name: (image.alt || '').trim().slice(0, 140),
        width: image.naturalWidth, height: image.naturalHeight });
    }
    return { images, truncated: false };
  }

  async function send(action, params) {
    const result = await chrome.runtime.sendMessage({ type: 'jiancang:collector-' + action, ...params });
    if (!result?.ok) throw Object.assign(new Error(result?.message || '无法完成采集，请重新打开面板。'), { status: result?.status });
    if (action === 'image' || action === 'page') {
      destinationsVersion++;
      warmCatalog = undefined;
    }
    return result;
  }

  function warmDestinations() {
    if (!automatic || document.visibilityState === 'hidden' || warming || warmCatalog?.expires > Date.now()) return;
    const version = destinationsVersion;
    warming = send('targets', { connect: false, allowCache: true }).then(data => {
      if (automatic && version === destinationsVersion) warmCatalog = { data, expires: Date.now() + 12_000 };
    }).catch(() => {}).finally(() => { warming = undefined; });
  }

  function setAutomatic(enabled) {
    automatic = enabled === true;
    if (!automatic) {
      warmCatalog = undefined;
      if (!collector || collector.fromDrag) endImageDrag();
    }
    collector?.updateEnableButton();
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'jiancang:context-image-source') {
      const exactClick = lastContextImage && lastContextImage.url === message.url && performance.now() - lastContextImage.time < 30_000;
      respond({ sourceLink: exactClick ? lastContextImage.sourceLink : undefined });
      return;
    }
    if (message?.type === 'jiancang:reload-ready') {
      respond({ ready: !collector && !imageURL });
      return;
    }
    if (message?.type === 'jiancang:auto-drag-mode') {
      modeAnnounced = true;
      setAutomatic(message.enabled);
      respond({ ok: true });
      return;
    }
    if (message?.type !== 'jiancang:collector-toggle') return;
    cancelOpen();
    if (collector) {
      collector.dismiss();
      respond({ opened: false });
    } else {
      const recentImage = lastImagePress && performance.now() - lastImagePress.time < 5000;
      collector = mount(false, recentImage ? lastImagePress : lastPointer);
      respond({ opened: true });
    }
  });

  chrome.runtime.sendMessage({ type: 'jiancang:auto-drag-status' }).then(result => {
    if (result?.ok && !modeAnnounced) setAutomatic(result.enabled);
  }).catch(() => {});
  window.addEventListener('pointermove', event => {
    if (!event.isTrusted || !contextActive()) return;
    lastPointer = { x: event.clientX, y: event.clientY };
    const drag = pointerDrag;
    if (!drag || drag.id !== event.pointerId || (drag.native && !drag.native.defaultPrevented)) return;
    if ((event.buttons & 1) === 0) return endImageDrag();
    drag.point = lastPointer;
    if (!drag.started && Math.hypot(event.clientX - drag.anchor.x, event.clientY - drag.anchor.y) >= 10) {
      drag.started = true;
      startImageDrag(drag.image, drag.anchor);
    }
    if (drag.started) collector?.movePointer(drag.point);
  }, { capture: true, passive: true, signal: inputListeners.signal });
  window.addEventListener('pointerdown', event => {
    if (!event.isTrusted || !contextActive()) return;
    lastPointer = { x: event.clientX, y: event.clientY };
    if (event.button !== 0 || !event.isPrimary || event.composedPath().includes(collector?.host)) return;
    if (pointerDrag) endImageDrag();
    const slide = douyin && event.pointerType === 'mouse' && (automatic || collector) ? findDouyinSlide(event) : null;
    if (slide) pointerDrag = { id: event.pointerId, image: slide, anchor: lastPointer };
    if (!slide && !event.composedPath().some(node => node instanceof HTMLImageElement)) return;
    lastImagePress = { ...lastPointer, time: performance.now() };
    if (automatic) warmDestinations();
  }, { capture: true, passive: true, signal: inputListeners.signal });
  window.addEventListener('contextmenu', event => {
    if (!event.isTrusted || !contextActive()) return;
    const image = event.composedPath().find(node => node instanceof HTMLImageElement);
    lastContextImage = image ? { url: image.currentSrc, sourceLink: captureLinkForImage(image), time: performance.now() } : undefined;
  }, { capture: true, passive: true, signal: inputListeners.signal });

  window.addEventListener('pointerup', event => {
    const drag = pointerDrag;
    if (!event.isTrusted || !drag || drag.id !== event.pointerId || event.button !== 0 || !contextActive()) return;
    if (drag.native && !drag.native.defaultPrevented) {
      pointerDrag = undefined;
      return;
    }
    if (drag.started) collector?.dropPointer({ x: event.clientX, y: event.clientY });
    endImageDrag();
  }, { capture: true, passive: true, signal: inputListeners.signal });
  window.addEventListener('pointercancel', event => {
    const drag = pointerDrag;
    if (!event.isTrusted || !drag || drag.id !== event.pointerId) return;
    if (drag.native && !drag.native.defaultPrevented) pointerDrag = undefined;
    else endImageDrag();
  }, { capture: true, passive: true, signal: inputListeners.signal });
  window.addEventListener('keydown', event => {
    if (event.isTrusted && event.key === 'Escape' && pointerDrag) endImageDrag();
  }, { capture: true, signal: inputListeners.signal });
  window.addEventListener('blur', () => { if (pointerDrag) endImageDrag(); }, { signal: inputListeners.signal });

  window.addEventListener('dragstart', event => {
    if (!contextActive() || !event.isTrusted || (!automatic && !collector) || event.composedPath().includes(collector?.host)) return;
    const underPointer = document.elementFromPoint(event.clientX, event.clientY);
    const image = event.composedPath().find(node => node instanceof HTMLImageElement) ||
      (event.target instanceof HTMLAnchorElement && event.target.contains(underPointer) && underPointer instanceof HTMLImageElement ?
        underPointer : null);
    if (pointerDrag && !visibleImageURL(image)) {
      // Draggable links around a slide must not replace the visible image gesture.
      event.preventDefault();
      if (!pointerDrag.started) {
        pointerDrag.started = true;
        startImageDrag(pointerDrag.image, pointerDrag.anchor);
      }
      return;
    }
    if (pointerDrag) Object.assign(pointerDrag, { native: event, started: true });
    startImageDrag(image, { x: event.clientX, y: event.clientY }, event);
  }, { capture: true, signal: inputListeners.signal });
  window.addEventListener('drop', event => {
    if (!event.isTrusted || !contextActive()) return;
    cancelOpen();
    if (!collector || !event.composedPath().includes(collector.host)) endImageDrag();
  }, { capture: true, signal: inputListeners.signal });
  window.addEventListener('dragend', event => {
    if (!contextActive() || !event.isTrusted) return;
    endImageDrag();
  }, { capture: true, signal: inputListeners.signal });
  window.addEventListener('pagehide', endImageDrag, { signal: inputListeners.signal });

  const css = `
    :host {
      all: initial !important; position: fixed !important; z-index: 2147483647 !important;
      inset: var(--jiancang-top) auto auto var(--jiancang-left) !important; display: block !important;
      width: var(--jiancang-width) !important; color-scheme: light dark;
    }
    *, *::before { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .panel {
      --surface: light-dark(#fffaf2, #23211e); --field: light-dark(#f8f2e8, #2e2b26);
      --ink: light-dark(#2c251d, #faf1e3); --muted: light-dark(#6f6254, #c4b7a4);
      --line: light-dark(#e2d7c8, #51483b); --accent: light-dark(#995129, #f0b480);
      --hot: light-dark(#f5e0c8, #49352a); --error: light-dark(#9c342c, #f29d90);
      display: flex; flex-direction: column; max-height: var(--jiancang-panel-height);
      overflow: auto; border: 1px solid var(--line); border-radius: 14px;
      color: var(--ink); background: var(--surface);
      box-shadow: 0 12px 36px #160e0850; font: 15px/1.45 system-ui, "Microsoft YaHei", sans-serif;
    }
    header, footer { display: flex; flex: none; gap: 10px; align-items: center; padding: 12px 15px; }
    header { border-bottom: 1px solid var(--line); }
    header strong { flex: 1; font-size: 16px; }
    .mark { display: grid; place-items: center; width: 25px; height: 25px; border-radius: 6px;
      background: #ee5635; color: #fff6e8; font-size: 13px; font-weight: 700; }
    .body { display: flex; flex-direction: column; min-height: 0; overflow: auto; gap: 10px; padding: 13px 15px; }
    .body > :not(.destinations) { flex: none; }
    .well {
      align-content: center; display: grid; gap: 3px; min-height: 66px; border: 1px dashed var(--accent);
      border-radius: 9px; color: var(--accent); background: var(--field); padding: 9px 11px;
    }
    .well span { color: var(--muted); overflow-wrap: anywhere; font-size: 12px; }
    button, input, select {
      min-width: 0; border: 1px solid var(--line); border-radius: 6px; background: var(--field);
      color: inherit; padding: 6px 8px; font: inherit;
    }
    button { cursor: pointer; }
    button:disabled { cursor: default; opacity: .55; }
    button:hover:not(:disabled), .row[aria-pressed="true"] { background: var(--hot); }
    button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .close { width: 30px; height: 30px; padding: 0; border-color: transparent; background: none; font-size: 19px; }
    .fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 7px; }
    .destinations { display: grid; align-content: start; gap: 3px; min-height: 0; max-height: min(42vh, 360px); overflow: auto; padding: 2px; }
    .row {
      display: flex; gap: 8px; align-items: center; padding: 6px 8px; border: 1px solid transparent;
      background: transparent; text-align: left; min-height: 31px;
    }
    .row[aria-pressed="true"] { border-color: var(--line); }
    .row span { overflow-wrap: anywhere; }
    .folder {
      position: relative; width: 14px; height: 10px; flex: 0 0 14px;
      border: 1px solid currentColor; border-radius: 2px; color: var(--accent);
    }
    .folder::before {
      content: ""; position: absolute; top: -4px; left: -1px; width: 7px; height: 3px;
      border: 1px solid currentColor; border-bottom: 0; border-radius: 2px 2px 0 0;
    }
    .well[data-over], .row[data-over] { background: var(--hot); border-color: var(--accent); }
    footer { flex-wrap: wrap; border-top: 1px solid var(--line); padding-top: 9px; }
    footer button { font-size: 13px; }
    .save, .create-submit { margin-left: auto; color: var(--accent); }
    .enable, .retry-save { color: var(--accent); }
    .batch-panel { display: grid; gap: 7px; padding-block: 7px; border-top: 1px solid var(--line); }
    .batch-toolbar, .batch-actions { display: flex; align-items: center; justify-content: space-between; gap: 7px; flex-wrap: wrap; }
    .batch-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(95px, 1fr)); gap: 6px;
      max-height: min(37vh, 250px); overflow: auto; padding: 2px; }
    .batch-item { display: grid; grid-template-columns: auto minmax(0, 1fr); align-content: start; align-items: start;
      gap: 4px; min-width: 0; padding: 5px; border: 1px solid var(--line); border-radius: 7px; cursor: pointer; }
    .batch-item:has(:checked) { border-color: var(--accent); background: var(--hot); }
    .batch-item input { width: 15px; height: 15px; padding: 0; margin: 2px 0; accent-color: var(--accent); }
    .batch-item img { width: 100%; height: 63px; object-fit: contain; border-radius: 4px; background: var(--field); }
    .batch-item span { grid-column: 1 / -1; overflow-wrap: anywhere; font-size: 11px; }
    .batch-item [data-error] { color: var(--error); }
    .batch-item:has(:disabled) { cursor: default; }
    .body:has(.batch-panel:not([hidden])) .destinations { max-height: min(19vh, 140px); }
    .status, .empty { margin: 0; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .status[data-error], .well [data-error] { color: var(--error); }
    .create-form { display: flex; gap: 7px; }
    .create-form input { flex: 1; }
    @media (max-height: 430px) { .body { padding-block: 7px; gap: 5px; } .well { min-height: 52px; } }
  `;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(className, text) {
    return Object.assign(element('button', className, text), { type: 'button' });
  }

  function showCaptureNotice(message, retry) {
    if (!contextActive()) return;
    dismissNotice?.();
    const host = element('div');
    host.setAttribute('data-jiancang-capture-notice', '');
    host.setAttribute('lang', 'zh-CN');
    const shadow = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host {
        all: initial !important; position: fixed !important; z-index: 2147483647 !important;
        inset: auto auto 20px 50% !important; transform: translateX(-50%) !important;
        display: block !important; max-width: calc(100vw - 32px) !important; color-scheme: light dark;
      }
      .notice {
        display: flex; align-items: center; gap: 10px; padding: 9px 12px;
        border: 1px solid light-dark(#e2d7c8, #51483b); border-radius: 10px;
        color: light-dark(#2c251d, #faf1e3); background: light-dark(#fffaf2, #23211e);
        box-shadow: 0 6px 22px #160e0840; font: 14px/1.4 system-ui, "Microsoft YaHei", sans-serif;
      }
      .notice span { overflow-wrap: anywhere; }
      button {
        padding: 3px 6px; white-space: nowrap; border: 0; border-radius: 5px; background: transparent;
        color: light-dark(#995129, #f0b480); font: inherit; cursor: pointer;
      }
      button:hover { background: light-dark(#f5e0c8, #49352a); }
    `);
    shadow.adoptedStyleSheets = [sheet];
    const notice = element('div', 'notice');
    const text = element('span', '', message);
    text.setAttribute('role', retry ? 'alert' : 'status');
    notice.append(text);
    if (retry) {
      const retryButton = button('retry-save', '重试保存');
      retryButton.addEventListener('click', event => {
        if (!event.isTrusted) return;
        dismiss();
        retry();
      });
      notice.append(retryButton);
    }
    const close = button('close', '×');
    close.setAttribute('aria-label', '关闭采集提示');
    close.addEventListener('click', event => { if (event.isTrusted) dismiss(); });
    notice.append(close);
    shadow.append(notice);
    document.documentElement.append(host);
    const timer = retry ? undefined : setTimeout(dismiss, 2500);
    dismissNotice = dismiss;

    function dismiss() {
      clearTimeout(timer);
      host.remove();
      if (dismissNotice === dismiss) dismissNotice = undefined;
    }
  }

  async function saveDroppedImage(payload, retry = false) {
    try {
      const result = await send('image', { ...payload, retry });
      showCaptureNotice(result.destination ? '已保存到「' + result.destination + '」。' : result.message || '已保存到见藏。');
    } catch (error) {
      showCaptureNotice(error.message, () => void saveDroppedImage(payload, true));
    }
  }

  function requestId() {
    // crypto.randomUUID is unavailable on plain HTTP pages, unlike getRandomValues.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  }

  function positionCollector(host, anchor) {
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const margin = Math.min(16, width / 4, height / 4);
    const leftEdge = viewportLeft + margin;
    const rightEdge = viewportLeft + width - margin;
    const topEdge = viewportTop + margin;
    const bottomEdge = viewportTop + height - margin;
    const panelWidth = Math.min(470, rightEdge - leftEdge);
    const reservedHeight = Math.min(460, bottomEdge - topEdge);
    const gap = 22;
    let left = (leftEdge + rightEdge - panelWidth) / 2;
    let top = (topEdge + bottomEdge - reservedHeight) / 2;
    if (anchor) {
      const roomRight = rightEdge - anchor.x;
      const roomLeft = anchor.x - leftEdge;
      const openRight = roomRight >= panelWidth + gap || roomRight >= roomLeft;
      left = openRight ? anchor.x + gap : anchor.x - panelWidth - gap;
      top = anchor.y - 46;
    }
    left = Math.max(leftEdge, Math.min(left, rightEdge - panelWidth));
    top = Math.max(topEdge, Math.min(top, bottomEdge - reservedHeight));
    host.style.setProperty('--jiancang-left', `${left}px`);
    host.style.setProperty('--jiancang-top', `${top}px`);
    host.style.setProperty('--jiancang-width', `${panelWidth}px`);
    host.style.setProperty('--jiancang-panel-height', `${bottomEdge - top}px`);
  }

  function mount(fromDrag, anchor) {
    const host = element('div');
    const viewportListeners = new AbortController();
    const resize = () => positionCollector(host, anchor);
    host.setAttribute('data-jiancang-collector', '');
    host.setAttribute('lang', 'zh-CN');
    const shadow = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];

    const panel = element('section', 'panel');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', '见藏采集面板');
    const head = element('header');
    const mark = element('span', 'mark', '见');
    mark.setAttribute('aria-hidden', 'true');
    const close = button('close', '×');
    close.setAttribute('aria-label', '关闭采集面板');
    head.append(mark, element('strong', '', '见藏采集'), close);
    const body = element('div', 'body');
    const well = element('div', 'well');
    const currentLabel = element('span');
    well.append(element('strong', '', fromDrag ? '松手保存图片' : '拖入网页图片'), currentLabel);
    const fields = element('div', 'fields');
    const library = element('select');
    library.setAttribute('aria-label', '素材库');
    const filter = element('input');
    filter.type = 'search';
    filter.setAttribute('aria-label', '找集合');
    filter.placeholder = '找集合';
    fields.append(library, filter);
    const destinations = element('div', 'destinations');
    const createForm = element('form', 'create-form');
    const name = element('input');
    name.required = true;
    name.maxLength = 255;
    name.setAttribute('aria-label', '新集合名称');
    const createSubmit = button('create-submit', '创建');
    createSubmit.type = 'submit';
    createForm.append(name, createSubmit);
    const status = element('p', 'status');
    status.setAttribute('role', 'status');
    const useRules = button('route-reset', '恢复自动归档');
    const batchPanel = element('section', 'batch-panel');
    batchPanel.setAttribute('aria-label', '待采集图片');
    const batchToolbar = element('div', 'batch-toolbar');
    const batchTitle = element('strong');
    const batchSelectAll = button('batch-all', '全选');
    batchToolbar.append(batchTitle, batchSelectAll);
    const batchGrid = element('div', 'batch-grid');
    const batchSummary = element('p', 'status batch-status');
    batchSummary.setAttribute('role', 'status');
    const batchActions = element('div', 'batch-actions');
    const batchRetry = button('batch-retry retry-save', '重试失败图片');
    const batchSave = button('batch-save save', '保存所选图片');
    batchActions.append(batchRetry, batchSave);
    batchPanel.append(batchToolbar, batchGrid, batchSummary, batchActions);
    body.append(well, fields, destinations, useRules, createForm, batchPanel, status);
    const foot = element('footer');
    const retry = button('', '重新连接');
    const create = button('create', '新建集合');
    const save = button('save', '保存当前网页');
    const retrySave = button('retry-save', '重试保存');
    const enable = button('enable', '启用拖图采集');
    const batchToggle = button('batch-toggle', '批量采集图片');
    batchToggle.setAttribute('aria-expanded', 'false');
    batchToggle.hidden = fromDrag;
    foot.append(retry, create, batchToggle, save, retrySave, enable);
    panel.append(head, body, foot);
    shadow.append(panel);
    resize();
    document.documentElement.append(host);
    const resizeOptions = { passive: true, signal: viewportListeners.signal };
    window.addEventListener('resize', resize, resizeOptions);
    window.visualViewport?.addEventListener('resize', resize, resizeOptions);
    window.visualViewport?.addEventListener('scroll', resize, resizeOptions);

    let catalog;
    let chosenId = null;
    let loaded = false;
    let busy = false;
    let interrupted = null;
    let manualTarget = false;
    let batchRunning = false;
    let batchEntries = null;
    let batchTruncated = false;
    let route;
    let routeVersion = 0;
    let collectionsById = new Map();
    const dropTargets = new WeakMap();
    let pointerOver;

    function report(text, error = false) {
      status.textContent = text;
      status.hidden = !text;
      status.toggleAttribute('data-error', error);
    }

    function currentLibrary() {
      return catalog?.libraries.find(row => row.targetId === library.value);
    }

    function target(collectionId = chosenId) {
      const row = currentLibrary();
      if (!row) return undefined;
      return { targetId: row.targetId, libraryId: row.libraryId, collectionId };
    }

    function usesRules() {
      return catalog?.canRouteCapture === true && !manualTarget;
    }

    function captureTarget(collectionId = chosenId, explicit = false) {
      return usesRules() && !explicit ? undefined : target(collectionId);
    }

    async function refreshRoute() {
      const version = ++routeVersion;
      route = undefined;
      if (!loaded || !usesRules()) return;
      try {
        const result = await send('route', { kind: imageURL ? 'image' : 'page', url: imageURL || location.href, sourceLink: imageSourceLink });
        if (version === routeVersion) route = result;
      } catch (error) {
        if (version === routeVersion && error.status === 409) route = { error: error.message };
      }
      if (version === routeVersion && host.isConnected) setInteractive(Boolean(currentLibrary()) && loaded);
    }

    function collectionName(collectionId) {
      const names = [];
      const traversed = new Set();
      for (let row = collectionsById.get(collectionId); row && !traversed.has(row.id); row = collectionsById.get(row.parentId)) {
        names.unshift(row.name);
        traversed.add(row.id);
      }
      return names.join(' / ') || '库根目录';
    }

    function setInteractive(enabled) {
      fields.hidden = !enabled;
      destinations.hidden = !enabled;
      create.hidden = !enabled || catalog?.canCreate !== true;
      useRules.hidden = !enabled || catalog?.canRouteCapture !== true || !manualTarget;
      useRules.disabled = busy;
      save.disabled = !enabled || busy;
      currentLabel.textContent = enabled ? (usesRules() ? (route?.error ||
        (route?.destination ? (route.ruleName ? `${route.ruleName} · ` : '') + route.destination : '按采集规则归档')) :
        collectionName(chosenId)) : fromDrag ? '见藏默认接收位置' : '连接见藏后可选择集合';
      currentLabel.toggleAttribute('data-error', enabled && usesRules() && Boolean(route?.error));
      if (!enabled) createForm.hidden = true;
      library.disabled = busy;
      filter.disabled = busy;
      create.disabled = busy;
      createSubmit.disabled = busy;
      batchToggle.disabled = busy;
      close.disabled = batchRunning;
      updateBatch();
    }

    function updateEnableButton() {
      enable.hidden = fromDrag || automatic;
    }

    function renderRows() {
      const row = currentLibrary();
      collectionsById = new Map(row?.collections.map(entry => [entry.id, entry]));
      const term = filter.value.trim().toLocaleLowerCase('zh-CN');
      const entries = row ? [{ id: null }, ...row.collections] : [];
      const matches = entries.map(entry => ({ id: entry.id, path: collectionName(entry.id) }))
        .filter(entry => entry.path.toLocaleLowerCase('zh-CN').includes(term));
      destinations.replaceChildren();
      for (const entry of matches.slice(0, 180)) {
        const choice = button('row', '');
        choice.setAttribute('aria-pressed', String(entry.id === chosenId && !usesRules()));
        choice.append(element('i', 'folder'), element('span', '', entry.path));
        choice.addEventListener('click', event => {
          if (!event.isTrusted || busy) return;
          chosenId = entry.id;
          manualTarget = true;
          createForm.hidden = true;
          destinations.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
          choice.setAttribute('aria-pressed', 'true');
          setInteractive(true);
        });
        dropArea(choice, () => entry.id);
        destinations.append(choice);
      }
      if (!matches.length) destinations.append(element('p', 'empty', '没有匹配的集合'));
      if (matches.length > 180) destinations.append(element('p', 'empty', '显示前 180 项，可输入名称缩小范围。'));
      setInteractive(Boolean(row) && loaded);
    }

    async function load(connect, preferred = manualTarget ? target() : undefined, readyCatalog) {
      loaded = false;
      retry.hidden = true;
      setInteractive(false);
      if (!busy) report(connect ? '正在连接见藏…' : '正在读取采集位置…');
      try {
        catalog = readyCatalog || await send('targets', { connect, allowCache: fromDrag });
        if (!host.isConnected) return;
        const wanted = preferred || catalog.target;
        const selected = catalog.libraries.find(row => row.targetId === wanted?.targetId && row.libraryId === wanted.libraryId);
        library.replaceChildren(...catalog.libraries.map(row => new Option(row.name, row.targetId)));
        library.value = selected?.targetId || catalog.libraries[0]?.targetId || '';
        chosenId = selected?.collections.some(row => row.id === wanted.collectionId) ? wanted.collectionId : null;
        loaded = true;
        renderRows();
        void refreshRoute();
        if (busy || interrupted) return;
        if (!catalog.libraries.length) report('见藏没有可接收的素材库。请先在见藏中选择一个可写库。', true);
        else if ((!chosenId && wanted?.collectionId) || (!selected && wanted?.targetId)) {
          report('原采集位置暂不可用，请选择当前集合。', true);
        }
        else report('');
      } catch (error) {
        if (!busy && !interrupted) {
          retry.hidden = false;
          if (fromDrag && !connect && error.status === 401) report('首次保存时，请在见藏中同意连接。');
          else report(error.message, true);
        }
      }
    }

    async function submitPage(payload, retrying = false) {
      if (busy || !loaded || !currentLibrary()) return;
      busy = true;
      interrupted = null;
      retrySave.hidden = true;
      retry.hidden = true;
      const saving = { ...payload, requestId: payload.requestId || requestId() };
      setInteractive(Boolean(currentLibrary()) && loaded);
      report('正在保存到见藏…');
      try {
        const result = await send('page', { ...saving, retry: retrying });
        report(result.destination ? '已保存到「' + result.destination + '」。' : result.message || '已保存到见藏。');
      } catch (error) {
        interrupted = saving;
        retrySave.hidden = false;
        retry.hidden = error.status !== 401;
        report(error.message, true);
      } finally {
        busy = false;
        setInteractive(Boolean(currentLibrary()) && loaded);
      }
    }

    function updateBatch() {
      if (batchEntries === null) return;
      const available = batchEntries.filter(entry => entry.state === 'new');
      const selected = available.filter(entry => entry.checkbox.checked).length;
      const saved = batchEntries.filter(entry => entry.state === 'saved').length;
      const failed = batchEntries.filter(entry => entry.state === 'failed').length;
      const pending = batchEntries.length - available.length - saved - failed;
      for (const entry of batchEntries) {
        entry.checkbox.disabled = busy || entry.state !== 'new';
        entry.detail.textContent = entry.message || `${entry.image.width} × ${entry.image.height}`;
        entry.detail.toggleAttribute('data-error', entry.state === 'failed');
      }
      batchSelectAll.textContent = available.length && selected === available.length ? '取消全选' : '全选';
      batchSelectAll.disabled = busy || !available.length;
      batchSave.textContent = selected ? `保存 ${selected} 张图片` : '保存所选图片';
      batchSave.disabled = busy || !loaded || !selected || !currentLibrary();
      batchRetry.hidden = !failed;
      batchRetry.disabled = busy || !loaded;
      const destination = usesRules() ? '按采集规则分别归档' : collectionName(chosenId);
      batchSummary.textContent = (saved || failed || pending) ?
        `已保存 ${saved} 张 · 失败 ${failed} 张${pending ? ` · 处理中 ${pending} 张` : ''}` : batchEntries.length ?
          `保存到${usesRules() ? ' ' : ' · '}${destination}${batchTruncated ? ` · 显示前 ${batchImageLimit} 张` : ''}` :
          '未发现当前范围内已加载的图片。可先翻到需要的图片。';
    }

    function openBatch() {
      const { images, truncated } = collectBatchImages(anchor);
      batchTruncated = truncated;
      batchTitle.textContent = `${social || douyin ? '当前帖子' : '当前网页'} · ${images.length} 张图片`;
      batchEntries = images.map((image, index) => {
        const card = element('label', 'batch-item');
        const checkbox = element('input');
        const name = image.name || `图片 ${index + 1}`;
        checkbox.type = 'checkbox';
        checkbox.setAttribute('aria-label', name);
        checkbox.addEventListener('change', updateBatch);
        const thumbnail = element('img');
        thumbnail.alt = '';
        thumbnail.decoding = 'async';
        thumbnail.loading = 'lazy';
        thumbnail.src = image.url;
        thumbnail.draggable = false;
        const detail = element('span');
        card.append(checkbox, thumbnail, detail);
        return { card, checkbox, detail, image, state: 'new' };
      });
      batchGrid.replaceChildren(...batchEntries.map(entry => entry.card));
      updateBatch();
    }

    async function submitBatch(retrying) {
      if (busy || !loaded || !currentLibrary()) return;
      const entries = batchEntries.filter(entry => retrying ? entry.state === 'failed' : entry.state === 'new' && entry.checkbox.checked);
      if (!entries.length) return;
      busy = batchRunning = true;
      const destination = captureTarget();
      for (const entry of entries) {
        entry.payload ??= { url: entry.image.url, sourceLink: entry.image.sourceLink, target: destination, requestId: requestId() };
        entry.state = 'pending';
        entry.message = '等待保存';
      }
      setInteractive(true);
      let next = 0;
      async function saveImages() {
        while (next < entries.length) {
          const entry = entries[next++];
          entry.message = '正在保存';
          updateBatch();
          try {
            const result = await send('image', { ...entry.payload, batch: true, retry: retrying });
            entry.state = 'saved';
            entry.message = result.destination ? `已保存 · ${result.destination}` : '已保存';
            entry.checkbox.checked = false;
          } catch (error) {
            entry.state = 'failed';
            entry.message = error.message;
          }
          updateBatch();
        }
      }
      try {
        await Promise.all([saveImages(), saveImages()]);
        const confirmed = entries.find(entry => entry.state === 'saved');
        if (confirmed) void send('batch-tone', { requestId: confirmed.payload.requestId }).catch(() => {});
      } finally {
        busy = batchRunning = false;
        setInteractive(Boolean(currentLibrary()) && loaded);
      }
    }

    function canDrop(node) {
      return dropTargets.has(node) && !!imageURL && !busy && (loaded || (fromDrag && node === well));
    }

    function commitDrop(node) {
      const payload = { url: imageURL, sourceLink: imageSourceLink, target: captureTarget(dropTargets.get(node)(), node !== well), requestId: requestId() };
      endImageDrag();
      dismiss();
      void saveDroppedImage(payload);
    }

    function pointerTarget({ x, y }) {
      if (document.elementFromPoint(x, y) !== host) return null;
      const node = shadow.elementFromPoint(x, y)?.closest('.well, .row');
      return canDrop(node) ? node : null;
    }

    function movePointer(point) {
      const node = pointerTarget(point);
      if (node === pointerOver) return;
      pointerOver?.removeAttribute('data-over');
      node?.setAttribute('data-over', '');
      pointerOver = node;
    }

    function dropPointer(point) {
      const node = pointerTarget(point);
      if (node) commitDrop(node);
    }

    function dropArea(node, collection) {
      dropTargets.set(node, collection);
      node.addEventListener('dragover', event => {
        if (!event.isTrusted || !canDrop(node)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        node.setAttribute('data-over', '');
      });
      node.addEventListener('dragleave', event => {
        if (!(event.relatedTarget instanceof Node) || !node.contains(event.relatedTarget)) node.removeAttribute('data-over');
      });
      node.addEventListener('drop', event => {
        node.removeAttribute('data-over');
        if (!event.isTrusted || !canDrop(node)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        commitDrop(node);
      });
    }

    createForm.hidden = true;
    retry.hidden = true;
    retrySave.hidden = true;
    batchPanel.hidden = true;
    batchRetry.hidden = true;
    updateEnableButton();
    dropArea(well, () => chosenId);
    for (const phase of ['dragover', 'drop']) {
      panel.addEventListener(phase, event => {
        if (event.isTrusted && imageURL) { event.preventDefault(); event.stopPropagation(); }
      });
    }
    function endDrag() {
      pointerOver = undefined;
      shadow.querySelectorAll('[data-over]').forEach(node => node.removeAttribute('data-over'));
      if (fromDrag) dismiss();
      else void refreshRoute();
    }
    function dismiss(force = false) {
      if (batchRunning && !force) return;
      viewportListeners.abort();
      host.remove();
      if (collector?.host === host) collector = undefined;
    }
    close.addEventListener('click', event => { if (event.isTrusted) dismiss(); });
    shadow.addEventListener('keydown', event => { if (event.isTrusted && event.key === 'Escape') dismiss(); });
    filter.addEventListener('input', renderRows);
    library.addEventListener('change', () => {
      chosenId = null;
      manualTarget = true;
      createForm.hidden = true;
      renderRows();
    });
    useRules.addEventListener('click', event => {
      if (!event.isTrusted || busy) return;
      manualTarget = false;
      void load(false, undefined, catalog);
    });
    batchToggle.addEventListener('click', event => {
      if (!event.isTrusted || busy) return;
      batchPanel.hidden = !batchPanel.hidden;
      batchToggle.textContent = batchPanel.hidden ? '批量采集图片' : '收起图片';
      batchToggle.setAttribute('aria-expanded', String(!batchPanel.hidden));
      if (!batchPanel.hidden && (batchEntries === null || !batchEntries.length)) openBatch();
    });
    batchSelectAll.addEventListener('click', event => {
      if (!event.isTrusted || busy) return;
      const available = batchEntries.filter(entry => entry.state === 'new');
      const check = available.some(entry => !entry.checkbox.checked);
      for (const entry of available) entry.checkbox.checked = check;
      updateBatch();
    });
    batchSave.addEventListener('click', event => { if (event.isTrusted) void submitBatch(false); });
    batchRetry.addEventListener('click', event => { if (event.isTrusted) void submitBatch(true); });
    retry.addEventListener('click', event => { if (event.isTrusted && !busy) void load(true); });
    retrySave.addEventListener('click', event => {
      if (event.isTrusted && !busy && interrupted) void submitPage(interrupted, true);
    });
    enable.addEventListener('click', event => {
      if (event.isTrusted) void send('options').catch(error => report(error.message, true));
    });
    save.addEventListener('click', event => {
      if (event.isTrusted) void submitPage({ title: document.title, target: captureTarget() });
    });
    create.addEventListener('click', event => {
      if (!event.isTrusted) return;
      createForm.hidden = !createForm.hidden;
      if (!createForm.hidden) {
        name.placeholder = chosenId ? '在所选集合下新建' : '新集合名称';
        name.focus();
      }
    });
    createForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (!event.isTrusted || busy || !name.value.trim()) return;
      const parent = target();
      if (!parent) return;
      busy = true;
      setInteractive(true);
      try {
        const { collection } = await send('collection', { name: name.value.trim(), target: parent });
        createForm.hidden = true;
        name.value = '';
        filter.value = '';
        manualTarget = true;
        await load(false, { ...parent, collectionId: collection.id });
        if (chosenId === collection.id) report('已创建集合。');
      } catch (error) {
        report(error.message, true);
      } finally {
        busy = false;
        setInteractive(Boolean(currentLibrary()) && loaded);
      }
    });
    const cached = fromDrag && warmCatalog?.expires > Date.now() ? warmCatalog.data : null;
    void load(!fromDrag, undefined, cached);
    return { host, fromDrag, dismiss, endDrag, updateEnableButton, movePointer, dropPointer, startDrag(point) {
      if (!busy) {
        anchor = point;
        resize();
        void refreshRoute();
      }
    } };
  }
})();
