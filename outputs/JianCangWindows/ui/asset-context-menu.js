'use strict';

(() => {
  let dismissMenu;
  const menuItem = (label, action, enabled = true) => ({ label, action, enabled });

  function assetHasWebURL(asset) {
    const value = asset?.sourceURL;
    const url = typeof value === 'string' && value.length <= 4096 && URL.parse(value.trim());
    return !!url && /^https?:$/.test(url.protocol) && !url.username && !url.password;
  }

  function clipboardItems(assets, actionPrefix = '') {
    const plural = assets.length > 1;
    return [
      menuItem(plural ? '复制素材名称列表' : '复制素材名称', actionPrefix + 'names'),
      menuItem(plural ? '复制可用原件路径' : '复制原件路径', actionPrefix + 'paths', assets.some(asset => asset.available)),
      menuItem(plural ? '复制来源网址列表' : '复制来源网址', actionPrefix + 'sources', assets.some(assetHasWebURL)),
      menuItem('复制表格清单', actionPrefix + 'table'),
    ];
  }

  function anchorAt(element) {
    if (!element || element === document.body) return { x: innerWidth / 2, y: innerHeight / 2 };
    const { top, right, bottom } = element.getBoundingClientRect();
    return { top, right, bottom };
  }

  function placeMenu(panel, x, y) {
    const { width, height } = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(4, Math.min(x, innerWidth - width - 4))}px`;
    panel.style.top = `${Math.max(4, Math.min(y, innerHeight - height - 4))}px`;
  }

  function showMenu(actions, anchor, label, { heading, invoker = document.activeElement } = {}) {
    dismissMenu?.();
    return new Promise(resolve => {
      const position = anchor ?? anchorAt(invoker);
      const layer = document.createElement('div');
      layer.className = 'tauri-menu-layer';
      layer.popover = 'auto';
      const root = document.createElement('div');
      const submenu = document.createElement('div');
      for (const panel of [root, submenu]) {
        panel.className = 'tauri-context-menu';
        panel.setAttribute('role', 'menu');
      }
      root.setAttribute('aria-label', label);
      submenu.hidden = true;
      layer.append(root, submenu);
      const submenus = new WeakMap();
      const events = new AbortController();
      let parentRow;
      let hoverTimer;

      function close(value = null) {
        if (dismissMenu !== close) return;
        dismissMenu = null;
        clearTimeout(hoverTimer);
        events.abort();
        const returnFocus = layer.contains(document.activeElement);
        if (layer.matches(':popover-open')) layer.hidePopover();
        layer.remove();
        if (returnFocus && invoker?.isConnected) invoker.focus({ preventScroll: true });
        resolve(value);
      }

      function focusRow(row) {
        if (!row) return;
        row.focus({ preventScroll: true });
        row.scrollIntoView({ block: 'nearest' });
      }

      function hideSubmenu(returnFocus = false) {
        if (!parentRow) return;
        const restore = returnFocus || submenu.contains(document.activeElement);
        parentRow.setAttribute('aria-expanded', 'false');
        submenu.hidden = true;
        if (restore) focusRow(parentRow);
        parentRow = null;
      }

      function positionSubmenu() {
        if (!parentRow) return;
        const bounds = root.getBoundingClientRect();
        const row = parentRow.getBoundingClientRect();
        if (row.bottom <= bounds.top || row.top >= bounds.bottom) {
          hideSubmenu();
          return;
        }
        const width = submenu.getBoundingClientRect().width;
        const rightFits = bounds.right + width + 4 <= innerWidth;
        const x = rightFits || innerWidth - bounds.right >= bounds.left ? bounds.right : bounds.left - width;
        const rowTop = root.offsetTop + row.top - bounds.top;
        placeMenu(submenu, x, rowTop - 4);
      }

      function openSubmenu(row, item, moveFocus) {
        clearTimeout(hoverTimer);
        if (parentRow !== row) {
          hideSubmenu();
          parentRow = row;
          row.setAttribute('aria-expanded', 'true');
          submenu.setAttribute('aria-label', item.label);
          renderRows(submenu, item.children);
          submenu.hidden = false;
          positionSubmenu();
        }
        if (moveFocus && !submenu.hidden) focusRow(submenu.querySelector('button:not(:disabled)'));
      }

      function renderRows(panel, items) {
        panel.replaceChildren(...items.map(item => {
          if (!item) {
            const divider = document.createElement('div');
            divider.setAttribute('role', 'separator');
            return divider;
          }
          const button = document.createElement('button');
          button.type = 'button';
          button.tabIndex = -1;
          button.disabled = item.enabled === false;
          button.textContent = item.label;
          button.setAttribute('role', item.check ? `menuitem${item.check}` : 'menuitem');
          if (item.check) button.setAttribute('aria-checked', String(item.checked));
          if (item.danger) button.classList.add('tauri-menu-danger');
          if (item.children) {
            button.setAttribute('aria-haspopup', 'menu');
            button.setAttribute('aria-expanded', 'false');
            submenus.set(button, item);
          }
          button.addEventListener('click', () => item.children ? openSubmenu(button, item, true) : close(item.action));
          if (panel === root) button.addEventListener('pointerenter', event => {
            if (event.pointerType === 'touch') return;
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => {
              if (item.children) openSubmenu(button, item, false);
              else hideSubmenu();
            }, 130);
          });
          return button;
        }));
      }

      function leavePanel(event) {
        if (layer.contains(event.relatedTarget)) return;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(hideSubmenu, 180);
      }
      root.addEventListener('pointerleave', leavePanel);
      submenu.addEventListener('pointerleave', leavePanel);
      submenu.addEventListener('pointerenter', () => clearTimeout(hoverTimer));
      root.addEventListener('scroll', positionSubmenu);
      layer.addEventListener('toggle', event => { if (event.newState === 'closed') close(); });
      layer.addEventListener('keydown', event => {
        const { key } = event;
        if (key === 'Tab') { close(); return; }
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape', 'Enter', ' '].includes(key)) return;
        event.preventDefault();
        event.stopPropagation();
        const focused = document.activeElement;
        if (key === 'Escape') { if (parentRow) hideSubmenu(true); else close(); return; }
        if (key === 'ArrowLeft') { hideSubmenu(true); return; }
        if (key === 'ArrowRight') {
          const item = submenus.get(focused);
          if (item) openSubmenu(focused, item, true);
          return;
        }
        if (key === 'Enter' || key === ' ') {
          if (!event.repeat) focused?.click();
          return;
        }
        const panel = submenu.contains(focused) ? submenu : root;
        const rows = [...panel.querySelectorAll('button:not(:disabled)')];
        const index = rows.indexOf(focused);
        const next = key === 'Home' ? 0 : key === 'End' ? rows.length - 1
          : (index + (key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length;
        if (panel === root && parentRow !== rows[next]) hideSubmenu();
        focusRow(rows[next]);
      });
      window.addEventListener('resize', () => close(), { signal: events.signal });
      dismissMenu = close;
      renderRows(root, actions);
      if (heading) {
        const caption = document.createElement('div');
        caption.className = 'asset-context-menu-heading';
        caption.textContent = heading;
        root.prepend(caption);
      }
      document.body.append(layer);
      layer.showPopover();
      const bounds = root.getBoundingClientRect();
      const x = position.x ?? position.right - bounds.width;
      const y = position.y ?? position.bottom + 4;
      const above = (position.top ?? y) - bounds.height - 4;
      placeMenu(root, x, y + bounds.height + 4 > innerHeight && above >= 4 ? above : y);
      focusRow(root.querySelector('button:not(:disabled)'));
    });
  }

  window.jiancangAssetContextMenu = Object.freeze({ assetHasWebURL, clipboardItems, showMenu });
})();
