'use strict';

(() => {
  const key = 'jiancang.collection-order.v1';

  function groupKey(item) {
    if (!item || item.sourceLibraryId || !item.id.includes(':')) return null;
    const library = item.id.slice(0, item.id.indexOf(':'));
    const parent = item.parentId?.startsWith(`${library}:`) ? item.parentId : null;
    return JSON.stringify([library, parent]);
  }

  function readOrder() {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '[]');
      return new Map(Array.isArray(saved) ? saved.filter(entry => Array.isArray(entry) &&
        typeof entry[0] === 'string' && Array.isArray(entry[1]) && entry[1].every(id => typeof id === 'string')) : []);
    } catch { return new Map(); }
  }

  window.createJianCangCollectionOrder = ({ tree, getSiblings, getItem, render, announce, reduceMotion }) => {
    const saved = readOrder();
    const scroller = tree.closest('.sidebar-scroll');
    const animations = new WeakMap();
    let drag;
    let suppressClick;

    function store(group, ids) {
      saved.delete(group);
      if (ids) saved.set(group, ids);
      try { localStorage.setItem(key, JSON.stringify([...saved])); }
      catch { announce('当前窗口会保留排序，系统暂时无法保存偏好。'); }
    }

    function ordered(siblings) {
      const arranged = new Map();
      for (const item of siblings) {
        const group = groupKey(item);
        if (!saved.has(group)) continue;
        if (!arranged.has(group)) arranged.set(group, []);
        arranged.get(group).push(item);
      }
      if (!arranged.size) return siblings;
      for (const [group, items] of arranged) {
        const rank = new Map(saved.get(group).map((id, index) => [id, index]));
        const last = saved.get(group).length;
        items.sort((a, b) => (rank.get(a.id) ?? last) - (rank.get(b.id) ?? last));
        arranged.set(group, items.values());
      }
      return siblings.map(item => arranged.get(groupKey(item))?.next().value ?? item);
    }

    function siblingsFor(item) {
      const group = groupKey(item);
      return group ? ordered(getSiblings(item).filter(sibling => groupKey(sibling) === group)) : [];
    }

    function branches(items, depth) {
      const counts = new Map();
      for (const item of items) {
        const group = groupKey(item);
        if (group) counts.set(group, (counts.get(group) || 0) + 1);
      }
      return ordered(items).toReversed().map(item => {
        const group = groupKey(item);
        return [item, depth, counts.get(group) > 1, saved.has(group)];
      });
    }

    function options(item) {
      const siblings = siblingsFor(item);
      const index = siblings.indexOf(item);
      return { up: index > 0, down: index >= 0 && index < siblings.length - 1, custom: saved.has(groupKey(item)) };
    }

    function focusedHandle(id) {
      const row = Array.from(tree.children).find(element => element.dataset.collectionSortId === id);
      row?.querySelector('.collection-order-handle')?.focus({ preventScroll: true });
    }

    function update(item, action) {
      const group = groupKey(item);
      if (!group) return;
      if (action === 'reset') {
        if (!saved.has(group)) return;
        store(group);
      } else {
        const siblings = siblingsFor(item);
        const index = siblings.indexOf(item);
        if (index < 0) return;
        const target = { start: 0, end: siblings.length - 1, up: index - 1, down: index + 1 }[action];
        if (!Number.isInteger(target) || target < 0 || target >= siblings.length || target === index) return;
        siblings.splice(index, 1);
        siblings.splice(target, 0, item);
        store(group, siblings.map(sibling => sibling.id));
      }
      render();
      focusedHandle(item.id);
      announce(action === 'reset' ? '同级集合已恢复按名称排序。' : `已调整「${item.name}」的位置。`);
    }

    function collectBlocks(order) {
      const requested = new Set(order);
      const blocks = new Map();
      let current;
      for (const row of tree.children) {
        const id = row.dataset.collectionSortId;
        const level = Number(row.dataset.collectionSortLevel);
        if (requested.has(id)) {
          current = { root: row, level, rows: [row] };
          blocks.set(id, current);
        } else if (current && level > current.level) {
          current.rows.push(row);
        } else {
          current = null;
        }
      }
      return blocks;
    }

    function animateOffset(row, distance, after) {
      if (reduceMotion.matches || Math.abs(distance) < 1) {
        after?.();
        return;
      }
      const animation = row.animate([{ transform: `translateY(${distance}px)` }, { transform: 'none' }],
        { duration: 160, easing: 'cubic-bezier(.2,.7,.25,1)' });
      animations.set(row, animation);
      void animation.finished.then(() => {
        if (animations.get(row) === animation) animations.delete(row);
        after?.();
      }, () => {});
    }

    function moveBlock(active, target) {
      const from = active.order.indexOf(active.item.id);
      if (from === target) return;
      const block = active.blocks.get(active.order[target]);
      const siblingRows = active.order.slice(Math.min(from, target), Math.max(from, target) + 1)
        .flatMap(id => active.blocks.get(id).rows)
        .filter(row => row !== active.source.root);
      const before = new Map();
      if (!reduceMotion.matches) {
        const bounds = scroller.getBoundingClientRect();
        for (const row of siblingRows) {
          const rect = row.getBoundingClientRect();
          if (rect.bottom >= bounds.top - 36 && rect.top <= bounds.bottom + 36) before.set(row, rect.top);
        }
      }
      const reference = from < target ? block.rows.at(-1).nextElementSibling : block.root;
      const fragment = document.createDocumentFragment();
      for (const row of active.source.rows) fragment.append(row);
      tree.insertBefore(fragment, reference);
      active.handle.focus({ preventScroll: true });
      active.order.splice(from, 1);
      active.order.splice(target, 0, active.item.id);
      for (const [row, offset] of before) {
        animations.get(row)?.cancel();
        animateOffset(row, offset - row.getBoundingClientRect().top);
      }
    }

    function updateDrag() {
      const active = drag;
      if (!active?.moving) return;
      const treeTop = tree.getBoundingClientRect().top;
      const pointer = active.y - treeTop - active.grip + active.rowHeight / 2;
      const from = active.order.indexOf(active.item.id);
      const midpoint = index => {
        const block = active.blocks.get(active.order[index]);
        const last = block.rows.at(-1);
        return (block.root.offsetTop + last.offsetTop + last.offsetHeight) / 2;
      };
      let next = from;
      while (next > 0 && pointer < midpoint(next - 1)) next--;
      if (next === from) while (next < active.order.length - 1 && pointer > midpoint(next + 1)) next++;
      moveBlock(active, next);
      const distance = active.y - treeTop - active.grip - active.source.root.offsetTop;
      active.source.root.style.transform = `translateY(${distance}px)`;
    }

    function autoScroll(active) {
      if (drag !== active || !active.moving) return;
      const bounds = scroller.getBoundingClientRect();
      const edge = 32;
      const delta = active.y < bounds.top + edge ? Math.max(-12, (active.y - bounds.top - edge) / 3)
        : active.y > bounds.bottom - edge ? Math.min(12, (active.y - bounds.bottom + edge) / 3) : 0;
      if (delta) {
        const before = scroller.scrollTop;
        scroller.scrollTop += delta;
        if (scroller.scrollTop !== before) updateDrag();
      }
      active.frame = requestAnimationFrame(() => autoScroll(active));
    }

    function finish({ commit = false, rerender = false } = {}) {
      const active = drag;
      if (!active) return;
      drag = null;
      cancelAnimationFrame(active.frame);
      if (tree.hasPointerCapture(active.pointerId)) tree.releasePointerCapture(active.pointerId);
      if (!active.moving) return;
      suppressClick = { id: active.item.id, until: performance.now() + 500 };
      tree.classList.remove('is-collection-sorting');
      const row = active.source.root;
      const from = row.getBoundingClientRect().top;
      row.style.transform = '';
      row.classList.remove('is-collection-sort-moving');
      if (rerender) return;
      if (!commit) {
        render();
        focusedHandle(active.item.id);
        return;
      }
      if (active.order.some((id, index) => id !== active.before[index])) {
        store(groupKey(active.item), active.order);
        announce(`已调整「${active.item.name}」的位置。`);
      }
      animations.get(row)?.cancel();
      row.classList.add('is-collection-sort-moving');
      animateOffset(row, from - row.getBoundingClientRect().top, () => row.classList.remove('is-collection-sort-moving'));
      focusedHandle(active.item.id);
    }

    tree.addEventListener('pointerdown', event => {
      suppressClick = null;
      const handle = event.target.closest('.collection-order-handle');
      const source = handle?.closest('[data-collection-sort-id]');
      if (!source || event.button !== 0 || !event.isPrimary || drag) return;
      const item = getItem(source.dataset.collectionSortId);
      const order = siblingsFor(item).map(sibling => sibling.id);
      if (order.length < 2) return;
      const blocks = collectBlocks(order);
      if (blocks.size !== order.length) return;
      animations.get(source)?.cancel();
      const rect = source.getBoundingClientRect();
      drag = { item, handle, order, before: [...order], blocks, source: blocks.get(item.id), pointerId: event.pointerId,
        x: event.clientX, initialY: event.clientY, y: event.clientY, grip: event.clientY - rect.top, rowHeight: rect.height };
    });

    window.addEventListener('pointermove', event => {
      const active = drag;
      if (!active || active.pointerId !== event.pointerId) return;
      active.y = event.clientY;
      if (!active.moving) {
        if (!event.buttons) { finish(); return; }
        if (Math.hypot(event.clientX - active.x, event.clientY - active.initialY) < 5) return;
        event.preventDefault();
        active.moving = true;
        active.handle.focus({ preventScroll: true });
        tree.setPointerCapture(event.pointerId);
        tree.classList.add('is-collection-sorting');
        active.source.root.classList.add('is-collection-sort-moving');
        active.frame = requestAnimationFrame(() => autoScroll(active));
      }
      updateDrag();
    });

    window.addEventListener('pointerup', event => {
      if (drag?.pointerId === event.pointerId) finish({ commit: true });
    });
    for (const type of ['pointercancel', 'lostpointercapture']) tree.addEventListener(type, event => {
      if (drag?.pointerId === event.pointerId) finish();
    });
    window.addEventListener('blur', () => finish());

    tree.addEventListener('click', event => {
      const id = event.target.closest('[data-collection-sort-id]')?.dataset.collectionSortId;
      if (!suppressClick || suppressClick.id !== id || performance.now() > suppressClick.until) return;
      suppressClick = null;
      event.stopImmediatePropagation();
      event.preventDefault();
    }, true);

    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && drag) {
        event.preventDefault();
        event.stopPropagation();
        finish();
      }
    }, true);

    tree.addEventListener('keydown', event => {
      const handle = event.target.closest('.collection-order-handle');
      const action = { ArrowUp: 'up', ArrowDown: 'down', Home: 'start', End: 'end' }[event.key];
      if (!handle || !action || drag || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      update(getItem(handle.closest('[data-collection-sort-id]').dataset.collectionSortId), action);
    });

    return { branches, options, update, beforeRender: () => finish({ rerender: true }) };
  };
})();
