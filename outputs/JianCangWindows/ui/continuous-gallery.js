'use strict';

(() => {
  const gap = 12;
  const captionHeight = 43;
  const listRowHeight = 54;
  const motionDuration = 190;

  const bound = (value, min, max) => Math.min(max, Math.max(min, value));
  const validRatio = value => Number.isFinite(value) && value > 0;

  function firstRowAt(lane, y) {
    let start = 0;
    let end = lane.length;
    while (start < end) {
      const middle = (start + end) >>> 1;
      if (lane[middle].bottom < y) start = middle + 1;
      else end = middle;
    }
    return start;
  }

  function layoutCatalog(assets, width, preferences, knownRatios) {
    const tiles = new Map();
    const lanes = [];
    const rows = [];
    const labelHeight = preferences.captions ? captionHeight : 0;
    let height = 0;

    function ratioOf(asset) {
      const measured = asset.width > 0 && asset.height > 0 ? asset.width / asset.height : knownRatios.get(asset.id);
      return bound(validRatio(measured) ? measured : 4 / 3, 0.21, 5.5);
    }

    function place(lane, asset, index, x, y, tileWidth, imageHeight) {
      const tile = { asset, index, x, y, width: tileWidth, imageHeight, bottom: y + imageHeight + labelHeight };
      lane.push(tile);
      tiles.set(asset.id, tile);
      height = Math.max(height, tile.bottom);
      return tile;
    }

    if (preferences.layout === 'list') {
      const rows = assets.map((asset, index) => {
        const y = index * listRowHeight;
        const tile = { asset, index, x: 0, y, width, imageHeight: listRowHeight, bottom: y + listRowHeight };
        tiles.set(asset.id, tile);
        return tile;
      });
      return { tiles, lanes: [rows], height: rows.length * listRowHeight, isList: true };
    }

    if (preferences.layout === 'rows') {
      const lane = [];
      lanes.push(lane);
      let first = 0;
      let ratios = [];
      let sum = 0;
      let y = 0;

      function placeRow(fill) {
        const available = width - gap * (ratios.length - 1);
        const fitted = available / sum;
        const imageHeight = fill ? fitted : Math.min(fitted, preferences.tileSize);
        let x = 0;
        const row = ratios.map((ratio, offset) => {
          const index = first + offset;
          const tileWidth = imageHeight * ratio;
          const tile = place(lane, assets[index], index, x, y, tileWidth, imageHeight);
          tile.row = rows.length;
          x += tileWidth + gap;
          return tile;
        });
        rows.push(row);
        y += imageHeight + labelHeight + gap;
        first += ratios.length;
        ratios = [];
        sum = 0;
      }

      for (const asset of assets) {
        const ratio = ratioOf(asset);
        ratios.push(ratio);
        sum += ratio;
        if (sum * preferences.tileSize + gap * (ratios.length - 1) >= width) placeRow(true);
      }
      if (ratios.length) placeRow(false);
    } else {
      const columns = Math.max(1, Math.floor((width + gap) / (preferences.tileSize + gap)));
      const tileWidth = (width - gap * (columns - 1)) / columns;
      const nextTops = Array(columns).fill(0);
      for (let i = 0; i < columns; i += 1) lanes.push([]);
      for (let index = 0; index < assets.length; index += 1) {
        const asset = assets[index];
        const minimum = Math.min(...nextTops);
        const column = nextTops.findIndex(top => top <= minimum + 1);
        // Fit exceptionally tall thumbnails into a usable card. The image
        // still retains its complete composition via object-fit: contain.
        const imageHeight = Math.min(tileWidth / ratioOf(asset), Math.max(440, tileWidth * 2.65));
        const lane = lanes[column];
        const tile = place(lane, asset, index, column * (tileWidth + gap), nextTops[column], tileWidth, imageHeight);
        tile.column = column;
        tile.columnOffset = lane.length - 1;
        nextTops[column] = tile.bottom + gap;
      }
    }
    return { tiles, lanes, rows, height, isList: false };
  }

  function inRange(lanes, firstY, lastY) {
    const tiles = [];
    for (const lane of lanes) {
      for (let index = firstRowAt(lane, firstY); index < lane.length && lane[index].y <= lastY; index += 1) {
        tiles.push(lane[index]);
      }
    }
    return tiles;
  }

  window.createContinuousGallery = function createContinuousGallery({ gallery, scroller, listHeader, makeCard, cardKey, updateCard }) {
    let assets = [];
    let options = { layout: 'masonry', tileSize: 170, captions: true, selectedId: null };
    let layout = layoutCatalog([], 1, options, new Map());
    let width = 0;
    let frame = 0;
    let dirtyLayout = false;
    let pendingLayout = false;
    let pendingAnimation = false;
    const ratios = new Map();
    const cards = new Map();
    const departing = new Set();
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    // The renderer preserves its own viewport anchor during size changes.
    scroller.style.overflowAnchor = 'none';
    scroller.style.setProperty('--asset-list-row-height', `${listRowHeight}px`);

    function viewport() {
      const scrollerBox = scroller.getBoundingClientRect();
      const scrollerTop = scrollerBox.top + scroller.clientTop;
      const galleryTop = gallery.getBoundingClientRect().top;
      const contentTop = listHeader && !listHeader.hidden ? Math.max(scrollerTop, listHeader.getBoundingClientRect().bottom) : scrollerTop;
      return { top: contentTop - galleryTop, bottom: scrollerTop + scroller.clientHeight - galleryTop };
    }

    function placeCard(element, tile) {
      element.style.left = `${tile.x}px`;
      element.style.top = `${tile.y}px`;
      element.style.width = `${tile.width}px`;
      element.style.setProperty('--picture-height', `${tile.imageHeight}px`);
    }

    function exit(element) {
      element.inert = true;
      element.tabIndex = -1;
      delete element.dataset.assetId;
      element.setAttribute('aria-hidden', 'true');
      element.classList.add('asset-card-departing');
      element.style.zIndex = '1';
      element.style.pointerEvents = 'none';
      departing.add(element);
      const animation = element.animate([
        { opacity: 1 },
        { opacity: 0, transform: 'scale(.94)' },
      ], { duration: 145, easing: 'ease-in', fill: 'forwards' });
      const cleanup = () => {
        departing.delete(element);
        element.remove();
      };
      animation.onfinish = cleanup;
      animation.oncancel = cleanup;
    }

    function updateViewport(previousBoxes = null, replacing = false, switchingMode = false) {
      const current = viewport();
      const margin = bound(scroller.clientHeight * 0.65, 280, 820);
      const required = inRange(layout.lanes, current.top - margin, current.bottom + margin);
      const focusedID = document.activeElement?.dataset?.assetId;
      const focusedTile = layout.tiles.get(focusedID);
      if (focusedTile && !required.includes(focusedTile)) required.push(focusedTile);
      required.sort((a, b) => a.index - b.index);
      const keep = new Set(required.map(tile => tile.asset.id));

      for (const [id, card] of cards) {
        if (keep.has(id)) continue;
        cards.delete(id);
        if (previousBoxes?.has(id) && !layout.tiles.has(id)) exit(card.element);
        else card.element.remove();
      }

      // Walk in catalog order so tab traversal follows the actual list.
      // Keep live nodes in place when scrolling; moving them loses focus.
      let insertionPoint = gallery.firstElementChild;
      for (const tile of required) {
        while (departing.has(insertionPoint)) insertionPoint = insertionPoint.nextElementSibling;
        const id = tile.asset.id;
        let card = cards.get(id);
        const key = cardKey(tile.asset, layout.isList);
        if (card && (card.isList !== layout.isList || card.key !== key)) {
          if (card.element === insertionPoint) insertionPoint = insertionPoint.nextElementSibling;
          card.element.remove();
          cards.delete(id);
          card = null;
        }
        if (!card) {
          const element = makeCard(tile.asset, layout.isList);
          card = { key, asset: tile.asset, element, motion: null, isList: layout.isList };
          cards.set(id, card);
        } else if (card.asset !== tile.asset) {
          updateCard(card.element, tile.asset, card.asset);
          card.asset = tile.asset;
        }
        const { element } = card;
        if (!tile.asset.importing) {
          const pressed = String(options.batchIds ? options.batchIds.has(id) : id === options.selectedId);
          if (element.getAttribute('aria-pressed') !== pressed) element.setAttribute('aria-pressed', pressed);
        }
        if (previousBoxes || card.tile !== tile) placeCard(element, tile);
        card.tile = tile;
        if (element !== insertionPoint) gallery.insertBefore(element, insertionPoint);
        insertionPoint = element.nextElementSibling;
      }

      if (focusedID && document.activeElement?.dataset?.assetId !== focusedID) {
        cards.get(focusedID)?.element.focus({ preventScroll: true });
      }
      if (!previousBoxes) return;
      const visible = required.filter(tile => tile.bottom >= current.top && tile.y <= current.bottom);
      // All final layouts are committed above. Measure in a single pass
      // before starting motion, including cards resized by the slider.
      const finalBoxes = visible.map(tile => ({
        id: tile.asset.id, box: cards.get(tile.asset.id).element.getBoundingClientRect(),
      }));
      for (const { id, box } of finalBoxes) {
        const card = cards.get(id);
        const previous = previousBoxes.get(id);
        if (!previous || switchingMode) {
          if (replacing || switchingMode) {
            card.motion?.cancel();
            card.motion = card.element.animate([{ opacity: 0 }, { opacity: 1 }], {
              duration: motionDuration - 30, easing: 'ease-out',
            });
          }
          continue;
        }
        // The prior motion was canceled after taking the current frame,
        // allowing rapid slider input to continue smoothly from that frame.
        const dx = previous.left - box.left;
        const dy = previous.top - box.top;
        if (Math.abs(dx) < 0.65 && Math.abs(dy) < 0.65 &&
            Math.abs(previous.width - box.width) < 0.65 && Math.abs(previous.height - box.height) < 0.65) continue;
        card.motion = card.element.animate([
          {
            transformOrigin: 'top left',
            transform: `translate(${dx}px, ${dy}px) scale(${previous.width / box.width}, ${previous.height / box.height})`,
          },
          { transformOrigin: 'top left', transform: 'none' },
        ], { duration: motionDuration, easing: 'cubic-bezier(.2,.75,.3,1)' });
      }
    }

    function recalculate({ animate = false, replacing = false, preserveViewport = false } = {}) {
      const nextWidth = gallery.clientWidth;
      if (nextWidth < 1) {
        dirtyLayout = true;
        return;
      }
      const previous = viewport();
      const useMotion = animate && !reducedMotion.matches && scroller.clientHeight > 0 &&
        getComputedStyle(scroller).visibility === 'visible';
      const boxes = useMotion ? new Map() : null;
      if (boxes) {
        for (const [id, card] of cards) {
          if (card.tile.bottom >= previous.top && card.tile.y <= previous.bottom) {
            const box = card.element.getBoundingClientRect();
            if (box.width > 0 && box.height > 0) boxes.set(id, box);
          }
        }
      }
      const canAnchor = (!replacing || preserveViewport) && scroller.scrollTop > 16;
      const anchors = canAnchor ? inRange(layout.lanes, previous.top, preserveViewport ? previous.bottom : previous.top + 4)
        .filter(tile => tile.bottom > previous.top) : [];
      if (preserveViewport) {
        anchors.sort((a, b) => Math.max(a.y, previous.top) - Math.max(b.y, previous.top) || a.x - b.x);
      }
      for (const card of cards.values()) card.motion?.cancel();
      if (!useMotion) {
        for (const element of departing) element.remove();
        departing.clear();
      }

      width = nextWidth;
      dirtyLayout = false;
      const switchingMode = layout.isList !== (options.layout === 'list');
      layout = layoutCatalog(assets, width, options, ratios);
      scroller.dataset.layout = options.layout;
      if (listHeader) listHeader.hidden = !layout.isList;
      gallery.classList.toggle('hide-captions', !options.captions);
      gallery.style.height = `${layout.height}px`;
      for (const anchor of anchors) {
        const target = layout.tiles.get(anchor.asset.id);
        if (!target) continue;
        const offset = previous.top - anchor.y;
        const lastPixel = target.bottom - target.y - 1;
        const safeOffset = switchingMode ? bound(offset, 0, lastPixel) : preserveViewport ? Math.min(offset, lastPixel) : offset;
        scroller.scrollTop += target.y + safeOffset - viewport().top;
        break;
      }
      updateViewport(boxes, replacing, switchingMode);
    }

    function schedule(needsLayout = false, animate = false) {
      pendingLayout ||= needsLayout;
      pendingAnimation ||= animate;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const doLayout = pendingLayout;
        const doAnimate = pendingAnimation;
        pendingLayout = pendingAnimation = false;
        if (doLayout) recalculate({ animate: doAnimate });
        else updateViewport();
      });
    }

    scroller.addEventListener('scroll', () => schedule(), { passive: true });
    new ResizeObserver(() => {
      const nextWidth = gallery.clientWidth;
      if ((dirtyLayout || nextWidth !== width) && nextWidth > 0) schedule(true);
      else if (nextWidth > 0) schedule();
    }).observe(scroller);

    function nearest(id, key) {
      const tile = layout.tiles.get(id);
      if (!tile || tile.asset.importing) return null;
      if (layout.isList) {
        const first = assets.findIndex(asset => !asset.importing);
        if (key === 'Home') return assets[first]?.id ?? null;
        if (key === 'End') return assets.findLast(asset => !asset.importing)?.id ?? null;
        const visible = viewport();
        const step = Math.max(1, Math.floor((visible.bottom - visible.top) / listRowHeight) - 1);
        const offsets = { ArrowUp: -1, ArrowDown: 1, PageUp: -step, PageDown: step };
        return Object.hasOwn(offsets, key) ? assets[bound(tile.index + offsets[key], first, assets.length - 1)]?.id ?? null : null;
      }
      // Left and right follow the visible sort order, even when a row ends
      // or the next masonry card is placed in a different column.
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const offset = key === 'ArrowLeft' ? -1 : 1;
        for (let index = tile.index + offset; assets[index]; index += offset) {
          if (!assets[index].importing) return assets[index].id;
        }
        return null;
      }
      if (key !== 'ArrowUp' && key !== 'ArrowDown') return null;

      const offset = key === 'ArrowUp' ? -1 : 1;
      if (tile.column !== undefined) {
        const lane = layout.lanes[tile.column];
        for (let index = tile.columnOffset + offset; lane[index]; index += offset) {
          if (!lane[index].asset.importing) return lane[index].asset.id;
        }
        return null;
      }

      const centerX = tile.x + tile.width / 2;
      for (let index = tile.row + offset; layout.rows[index]; index += offset) {
        let best = Infinity;
        let chosen = null;
        for (const candidate of layout.rows[index]) {
          if (candidate.asset.importing) continue;
          const distance = Math.max(0, candidate.x - centerX, centerX - candidate.x - candidate.width);
          if (distance < best) {
            best = distance;
            chosen = candidate.asset.id;
          }
        }
        if (chosen) return chosen;
      }
      return null;
    }

    function setBatchSelection(ids) {
      options.batchIds = ids;
      for (const [id, card] of cards) {
        if (card.asset.importing) continue;
        const pressed = String(ids ? ids.has(id) : id === options.selectedId);
        if (card.element.getAttribute('aria-pressed') !== pressed) card.element.setAttribute('aria-pressed', pressed);
      }
    }

    return {
      render(nextAssets, nextOptions = {}) {
        const { animate = false, preserveViewport = false, ...rest } = nextOptions;
        const sameLayout = !dirtyLayout && width === gallery.clientWidth && layout.tiles.size === nextAssets.length &&
          (rest.layout ?? options.layout) === options.layout && (rest.tileSize ?? options.tileSize) === options.tileSize &&
          (rest.captions ?? options.captions) === options.captions && assets.length === nextAssets.length &&
          nextAssets.every((asset, index) => {
            const previous = assets[index];
            return previous.id === asset.id && previous.width === asset.width && previous.height === asset.height;
          });
        assets = nextAssets;
        options = { ...options, ...rest };
        if (sameLayout) {
          for (const asset of assets) layout.tiles.get(asset.id).asset = asset;
          updateViewport();
          return;
        }
        recalculate({ animate, replacing: true, preserveViewport });
      },
      setSelection(id) {
        if (options.selectedId === id) return;
        const previous = cards.get(options.selectedId);
        const next = cards.get(id);
        previous?.element.setAttribute('aria-pressed', 'false');
        options.selectedId = id;
        next?.element.setAttribute('aria-pressed', 'true');
      },
      setBatchSelection,
      selectMarquee({ onSelect, onPreview, onCancel, getSelection }) {
        const rectangle = document.createElement('div');
        rectangle.className = 'selection-marquee';
        rectangle.setAttribute('aria-hidden', 'true');
        rectangle.hidden = true;
        document.body.append(rectangle);
        let gesture;
        let frame = 0;
        let matches;

        function viewportBox() {
          const box = scroller.getBoundingClientRect();
          const left = box.left + scroller.clientLeft;
          const top = box.top + scroller.clientTop;
          return {
            left, right: left + scroller.clientWidth,
            top: listHeader && !listHeader.hidden ? Math.max(top, listHeader.getBoundingClientRect().bottom) : top,
            bottom: top + scroller.clientHeight,
          };
        }

        function update(scroll = false) {
          if (!gesture?.dragging) return;
          const box = viewportBox();
          const margin = 34;
          const dy = gesture.y < box.top + margin ? -Math.ceil((box.top + margin - gesture.y) / 4) :
            gesture.y > box.bottom - margin ? Math.ceil((gesture.y - box.bottom + margin) / 4) : 0;
          const previous = scroller.scrollTop;
          if (scroll && dy) scroller.scrollTop += bound(dy, -22, 22);
          const origin = gallery.getBoundingClientRect();
          const x = bound(gesture.x, box.left, box.right) - origin.left;
          const y = bound(gesture.y, box.top, box.bottom) - origin.top;
          const left = Math.min(x, gesture.startX);
          const right = Math.max(x, gesture.startX);
          const top = Math.min(y, gesture.startY);
          const bottom = Math.max(y, gesture.startY);
          const visibleTop = Math.max(top + origin.top, box.top);
          rectangle.hidden = false;
          rectangle.style.left = `${left + origin.left}px`;
          rectangle.style.top = `${visibleTop}px`;
          rectangle.style.width = `${right - left}px`;
          rectangle.style.height = `${Math.max(0, Math.min(bottom + origin.top, box.bottom) - visibleTop)}px`;
          const hits = inRange(layout.lanes, top, bottom)
            .filter(tile => !tile.asset.importing && tile.x < right && tile.x + tile.width > left && tile.y < bottom && tile.bottom > top)
            .sort((a, b) => a.index - b.index);
          const hitIds = new Set(gesture.initial);
          for (const tile of hits) hitIds.add(tile.asset.id);
          if (!matches || hitIds.size !== matches.size || [...hitIds].some(id => !matches.has(id))) {
            // Keep surviving covers in order and append only those that just entered the box.
            const ordered = new Set();
            for (const id of matches ?? gesture.initial) if (hitIds.has(id)) ordered.add(id);
            for (const id of hitIds) ordered.add(id);
            matches = ordered;
            setBatchSelection(matches);
            onPreview(matches);
          }
          if (scroller.scrollTop !== previous) scheduleUpdate();
        }

        function scheduleUpdate() {
          if (!gesture?.dragging || frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            update(true);
          });
        }

        function finish(commit = false) {
          if (!gesture) return false;
          if (commit && gesture.dragging) update();
          const { id, dragging, additive } = gesture;
          gesture = null;
          if (frame) cancelAnimationFrame(frame);
          frame = 0;
          rectangle.hidden = true;
          if (scroller.hasPointerCapture(id)) scroller.releasePointerCapture(id);
          if (commit && (dragging || !additive)) onSelect(dragging ? matches : new Set());
          else if (dragging) {
            const selected = getSelection();
            setBatchSelection(selected.size > 1 ? selected : null);
            onCancel();
          }
          matches = null;
          return true;
        }

        scroller.addEventListener('pointerdown', event => {
          if (!event.isPrimary || event.button !== 0 || event.pointerType !== 'mouse' || !assets.length ||
              event.target.closest('.asset-card, #asset-list-header, #empty-results, button, a, input, select, textarea')) return;
          if (gesture) finish();
          const { clientX: x, clientY: y, pointerId: id } = event;
          const box = viewportBox();
          if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) return;
          const origin = gallery.getBoundingClientRect();
          const additive = event.ctrlKey || event.metaKey || event.shiftKey;
          gesture = { id, x, y, downX: x, downY: y, startX: x - origin.left, startY: y - origin.top,
            additive, initial: additive ? getSelection() : [] };
          scroller.setPointerCapture(id);
          event.preventDefault();
        });
        scroller.addEventListener('pointermove', event => {
          if (gesture?.id !== event.pointerId) return;
          if (!(event.buttons & 1)) { finish(); return; }
          gesture.x = event.clientX;
          gesture.y = event.clientY;
          gesture.dragging ||= Math.hypot(gesture.x - gesture.downX, gesture.y - gesture.downY) >= 4;
          scheduleUpdate();
        });
        scroller.addEventListener('pointerup', event => {
          if (gesture?.id !== event.pointerId) return;
          gesture.x = event.clientX;
          gesture.y = event.clientY;
          finish(true);
        });
        for (const eventName of ['pointercancel', 'lostpointercapture']) {
          scroller.addEventListener(eventName, event => { if (gesture?.id === event.pointerId) finish(); });
        }
        scroller.addEventListener('scroll', scheduleUpdate, { passive: true });
        window.addEventListener('blur', () => finish());
        return () => finish();
      },
      setRatio(id, ratio) {
        if (!validRatio(ratio) || !layout.tiles.has(id) || ratios.get(id) === ratio) return;
        if (ratios.size >= 4096) ratios.delete(ratios.keys().next().value);
        ratios.set(id, ratio);
        if (!layout.isList) schedule(true, true);
      },
      relayout(nextOptions = {}) {
        const { animate = false, ...rest } = nextOptions;
        options = { ...options, ...rest };
        schedule(true, animate);
      },
      renderedCard(id) { return cards.get(id)?.element; },
      renderedCards() { return Array.from(cards.values(), card => card.element); },
      bookmark() {
        const top = scroller.scrollTop;
        if (top <= 16) return { top };
        const visibleTop = viewport().top;
        const tile = inRange(layout.lanes, visibleTop, visibleTop + 4).find(item => item.y <= visibleTop && item.bottom > visibleTop);
        return tile ? { top, id: tile.asset.id, offset: visibleTop - tile.y } : { top };
      },
      restoreBookmark(bookmark) {
        if (!bookmark) return;
        const tile = layout.tiles.get(bookmark.id);
        scroller.scrollTop = tile
          ? scroller.scrollTop + tile.y + bound(bookmark.offset, 0, tile.bottom - tile.y - 1) - viewport().top
          : bookmark.top;
        updateViewport();
      },
      focus(id, { scroll = true, focus = true } = {}) {
        const tile = layout.tiles.get(id);
        if (!tile || tile.asset.importing) return null;
        if (scroll) {
          const current = viewport();
          if (tile.y < current.top || tile.bottom - tile.y > scroller.clientHeight) {
            scroller.scrollTop += tile.y - current.top - gap;
          } else if (tile.bottom > current.bottom) {
            scroller.scrollTop += tile.bottom - current.bottom + gap;
          }
        }
        updateViewport();
        const element = cards.get(id)?.element;
        if (focus) element?.focus({ preventScroll: true });
        return element ?? null;
      },
      neighbor: nearest,
    };
  };
})();
