'use strict';

(() => {
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const maxZoom = 8;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function button(text, label) {
    const action = node('button', 'comparison-control', text);
    action.type = 'button';
    if (label) action.setAttribute('aria-label', label);
    return action;
  }

  function constrain(panel) {
    if (!panel.fitWidth || !panel.fitHeight) return;
    const width = panel.fitWidth * panel.scale;
    const height = panel.fitHeight * panel.scale;
    const limitX = Math.max(0, (width - panel.width) / (2 * width));
    const limitY = Math.max(0, (height - panel.height) / (2 * height));
    panel.x = clamp(panel.x, -limitX, limitX);
    panel.y = clamp(panel.y, -limitY, limitY);
  }

  function loadImage(panel, signal, measure) {
    const { original, thumbnail } = panel.item;
    const sources = [
      { url: original, thumbnail: false }, { url: thumbnail === original ? null : thumbnail, thumbnail: true },
    ].filter(entry => entry.url);
    let source = 0;
    function failed() {
      source += 1;
      if (source < sources.length) {
        panel.image.src = sources[source].url;
        return;
      }
      panel.message.textContent = '图片无法预览';
    }
    panel.image.addEventListener('error', failed, { signal });
    panel.image.addEventListener('load', () => {
      panel.image.hidden = false;
      panel.message.hidden = !sources[source]?.thumbnail;
      if (!panel.message.hidden) panel.message.textContent = '缩略图预览';
      measure(panel);
    }, { signal });
    if (sources.length) panel.image.src = sources[0].url;
    else failed();
  }

  window.createJianCangComparison = function createJianCangComparison({ items }) {
    if (!Array.isArray(items) || items.length < 2 || items.length > 4) throw new TypeError('对照需要 2–4 张图片');
    const controller = new AbortController();
    const { signal } = controller;
    const element = node('div', 'image-comparison');
    const toolbar = node('div', 'comparison-toolbar');
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', '对照工具');
    const wipeButton = items.length === 2 ? button('滑动对照') : null;
    if (wipeButton) {
      wipeButton.classList.add('comparison-wipe-toggle');
      toolbar.append(wipeButton);
    }
    const toggle = button('联动缩放');
    toggle.classList.add('comparison-link');
    toggle.title = '联动缩放和拖动';
    const zoomOut = button('−', '缩小');
    const zoomIn = button('+', '放大');
    const zoomValue = node('span', 'comparison-zoom-value', '适应');
    zoomValue.setAttribute('aria-label', '当前缩放');
    const reset = button('适应窗口');
    const zoomTools = node('div', 'comparison-zoom-tools');
    zoomTools.append(zoomOut, zoomValue, zoomIn);
    toolbar.append(toggle, zoomTools, reset);
    const strip = node('div', 'comparison-strip');
    strip.classList.toggle('is-grid', items.length > 2);
    element.append(toolbar, strip);

    const panels = items.map(item => {
      const figure = node('figure', 'comparison-panel');
      const stage = node('div', 'comparison-stage');
      stage.tabIndex = 0;
      stage.setAttribute('role', 'region');
      stage.setAttribute('aria-label', [item.name || '图片', item.libraryName].filter(Boolean).join('，'));
      const image = node('img', 'comparison-image');
      image.alt = '';
      image.draggable = false;
      image.decoding = 'async';
      image.hidden = true;
      const message = node('span', 'comparison-message', '正在载入图片…');
      message.setAttribute('role', 'status');
      const caption = node('figcaption', 'comparison-caption');
      const name = node('span', 'comparison-name', item.name || '未命名图片');
      name.title = item.name || '';
      const source = node('span', 'comparison-source', item.libraryName);
      source.title = item.libraryName || '';
      stage.append(image, message);
      caption.append(name, source);
      figure.append(stage, caption);
      strip.append(figure);
      return { item, stage, figure, image, message, x: 0, y: 0, width: 0, height: 0,
        fitWidth: 0, fitHeight: 0, scale: 1, pointer: null };
    });
    let active = panels[0];
    let linked = true;
    let wipe = false;
    let frame = 0;

    function paint() {
      frame = 0;
      for (const panel of panels) {
        const width = panel.fitWidth * panel.scale;
        const height = panel.fitHeight * panel.scale;
        panel.image.style.transform = `translate3d(${panel.x * width}px, ${panel.y * height}px, 0) scale(${panel.scale})`;
        panel.figure.toggleAttribute('data-active', panel === active);
        panel.stage.toggleAttribute('data-pannable', width > panel.width + 1 || height > panel.height + 1);
        panel.stage.toggleAttribute('data-dragging', !!panel.pointer);
      }
      const ready = !!active.fitWidth;
      if (wipeButton) {
        wipeButton.disabled = !panels.every(panel => panel.fitWidth > 0);
        wipeButton.setAttribute('aria-pressed', String(wipe));
      }
      toggle.disabled = wipe;
      toggle.setAttribute('aria-pressed', String(wipe || linked));
      zoomValue.textContent = active.scale === 1 ? '适应' : `${Math.round(active.scale * 100)}%`;
      zoomOut.disabled = !ready || active.scale <= 1;
      zoomIn.disabled = !ready || active.scale >= maxZoom;
      reset.disabled = !ready || active.scale === 1;
    }

    function schedulePaint() {
      if (!frame) frame = requestAnimationFrame(paint);
    }

    function measure(panel) {
      const { stage, image } = panel;
      panel.width = stage.clientWidth;
      panel.height = stage.clientHeight;
      if (!image.naturalWidth || !panel.width || !panel.height) return;
      const margin = 12;
      const baseline = Math.min(Math.max(1, panel.width - margin) / image.naturalWidth,
        Math.max(1, panel.height - margin) / image.naturalHeight);
      panel.fitWidth = image.naturalWidth * baseline;
      panel.fitHeight = image.naturalHeight * baseline;
      image.style.width = `${panel.fitWidth}px`;
      image.style.height = `${panel.fitHeight}px`;
      image.style.left = `${(panel.width - panel.fitWidth) / 2}px`;
      image.style.top = `${(panel.height - panel.fitHeight) / 2}px`;
      constrain(panel);
      schedulePaint();
    }

    function position(panel, scale, x, y) {
      active = panel;
      panel.scale = scale;
      panel.x = x;
      panel.y = y;
      constrain(panel);
      if (wipe || linked) {
        for (const peer of panels) {
          if (peer === panel) continue;
          peer.scale = panel.scale;
          peer.x = panel.x;
          peer.y = panel.y;
          constrain(peer);
        }
      }
      schedulePaint();
    }

    function zoom(panel, nextScale, pointX = 0, pointY = 0) {
      if (!panel.fitWidth) return;
      const next = clamp(nextScale, 1, maxZoom);
      if (next === 1) {
        position(panel, 1, 0, 0);
        return;
      }
      const difference = 1 / next - 1 / panel.scale;
      position(panel, next, panel.x + pointX / panel.fitWidth * difference,
        panel.y + pointY / panel.fitHeight * difference);
    }

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const panel = panels.find(candidate => candidate.stage === entry.target);
        measure(panel);
      }
    });

    for (const panel of panels) {
      const { stage } = panel;
      const activate = () => { active = panel; schedulePaint(); };
      const releasePointer = () => { panel.pointer = null; schedulePaint(); };
      observer.observe(stage);
      loadImage(panel, signal, measure);
      stage.addEventListener('focus', activate, { signal });
      stage.addEventListener('wheel', event => {
        if (!panel.fitWidth) return;
        event.preventDefault();
        const rect = stage.getBoundingClientRect();
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? panel.height : 1);
        zoom(panel, panel.scale * Math.exp(-delta * 0.0022),
          event.clientX - rect.left - panel.width / 2, event.clientY - rect.top - panel.height / 2);
      }, { signal, passive: false });
      stage.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        activate();
        if (!stage.hasAttribute('data-pannable')) return;
        panel.pointer = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: panel.x, y: panel.y };
        stage.setPointerCapture(event.pointerId);
        stage.focus({ preventScroll: true });
      }, { signal });
      stage.addEventListener('pointermove', event => {
        const start = panel.pointer;
        if (!start || start.id !== event.pointerId) return;
        const x = start.x + (event.clientX - start.startX) / (panel.fitWidth * panel.scale);
        const y = start.y + (event.clientY - start.startY) / (panel.fitHeight * panel.scale);
        position(panel, panel.scale, x, y);
      }, { signal });
      stage.addEventListener('lostpointercapture', releasePointer, { signal });
      stage.addEventListener('keydown', event => {
        if (!panel.fitWidth || event.ctrlKey || event.metaKey || event.altKey) return;
        const keys = ['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        if (event.key === '0') zoom(panel, 1);
        else if (event.key === '+' || event.key === '=') zoom(panel, panel.scale * 1.25);
        else if (event.key === '-') zoom(panel, panel.scale / 1.25);
        else {
          const moves = { ArrowLeft: [36, 0], ArrowRight: [-36, 0], ArrowUp: [0, 36], ArrowDown: [0, -36] };
          const [dx, dy] = moves[event.key];
          position(panel, panel.scale, panel.x + dx / (panel.fitWidth * panel.scale),
            panel.y + dy / (panel.fitHeight * panel.scale));
        }
      }, { signal });
    }

    if (wipeButton) {
      const wipeLayer = node('div', 'comparison-wipe-layer');
      const divider = node('div', 'comparison-wipe-divider');
      divider.tabIndex = 0;
      divider.setAttribute('role', 'slider');
      divider.setAttribute('aria-label', '两张图片的分割位置');
      divider.setAttribute('aria-valuemin', '0');
      divider.setAttribute('aria-valuemax', '100');
      wipeLayer.hidden = true;
      wipeLayer.append(divider);
      strip.append(wipeLayer);
      let cut = 50;
      let dividerPointer;

      function setCut(value) {
        cut = clamp(Math.round(value), 0, 100);
        strip.style.setProperty('--comparison-cut', `${cut}%`);
        divider.setAttribute('aria-valuenow', String(cut));
        divider.setAttribute('aria-valuetext', `左图 ${cut}%，右图 ${100 - cut}%`);
      }

      wipeButton.addEventListener('click', () => {
        wipe = !wipe;
        strip.toggleAttribute('data-wipe', wipe);
        wipeLayer.hidden = !wipe;
        if (wipe) {
          setCut(cut);
          position(active, active.scale, active.x, active.y);
        }
        schedulePaint();
      }, { signal });
      divider.addEventListener('pointerdown', event => {
        if (!event.isPrimary || event.button !== 0) return;
        dividerPointer = event.pointerId;
        divider.setPointerCapture(event.pointerId);
        divider.focus({ preventScroll: true });
        event.preventDefault();
      }, { signal });
      window.addEventListener('pointermove', event => {
        if (!wipe || event.pointerId !== dividerPointer) return;
        const rect = wipeLayer.getBoundingClientRect();
        if (rect.width) setCut((event.clientX - rect.left) * 100 / rect.width);
      }, { signal });
      const endDrag = event => {
        if (event.pointerId === dividerPointer) dividerPointer = undefined;
      };
      window.addEventListener('pointerup', endDrag, { signal });
      window.addEventListener('pointercancel', endDrag, { signal });
      divider.addEventListener('lostpointercapture', endDrag, { signal });
      divider.addEventListener('keydown', event => {
        const values = { ArrowLeft: cut - 2, ArrowRight: cut + 2, ArrowDown: cut - 2, ArrowUp: cut + 2,
          PageDown: cut - 10, PageUp: cut + 10, Home: 0, End: 100 };
        if (!Object.hasOwn(values, event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        setCut(values[event.key]);
      }, { signal });
    }
    toggle.addEventListener('click', () => {
      linked = !linked;
      position(active, active.scale, active.x, active.y);
    }, { signal });
    zoomIn.addEventListener('click', () => zoom(active, active.scale * 1.25), { signal });
    zoomOut.addEventListener('click', () => zoom(active, active.scale / 1.25), { signal });
    reset.addEventListener('click', () => zoom(active, 1), { signal });
    paint();

    return {
      element,
      dispose() {
        controller.abort();
        observer.disconnect();
        cancelAnimationFrame(frame);
        for (const panel of panels) panel.image.removeAttribute('src');
        element.remove();
      },
    };
  };
})();
