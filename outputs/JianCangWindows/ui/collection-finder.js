'use strict';

window.createJianCangCollectionFinder = function createCollectionFinder({ dialog, getLibraries, onPick }) {
  const input = dialog.querySelector('input');
  const list = dialog.querySelector('[role="listbox"]');
  const status = dialog.querySelector('[role="status"]');
  const pin = dialog.querySelector('#collection-finder-pin');
  const limit = 80;
  const pinnedLimit = 128;
  const recentLimit = 12;
  const storageKey = 'jiancang-collection-access-v1';
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const quickAccess = readQuickAccess();
  let sources = [];
  let index = [];
  let matches = [];
  let active = -1;

  function normalized(value) { return value.normalize('NFKC').toLocaleLowerCase('zh-CN'); }

  function savedKey(library, id) { return JSON.stringify([library.kind, library.id, id]); }

  function keyForCollection(collectionId) {
    const separator = collectionId.indexOf(':');
    if (separator < 1) return null;
    const library = getLibraries().find(item => item.registrationId === collectionId.slice(0, separator));
    return library ? savedKey(library, collectionId.slice(separator + 1)) : null;
  }

  function readQuickAccess() {
    const keys = (value, maximum) => Array.isArray(value)
      ? [...new Set(value.slice(0, maximum).filter(id => typeof id === 'string' && id.length <= 2048))] : [];
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      return { pinned: keys(saved?.pinned, pinnedLimit), recent: keys(saved?.recent, recentLimit) };
    } catch { return { pinned: [], recent: [] }; }
  }

  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(quickAccess)); }
    catch { return false; }
    return true;
  }

  function collectionIndex(libraries) {
    const rows = [];
    for (const library of libraries) {
      const collections = new Map(library.collections.map(item => [item.id, item]));
      for (const item of collections.values()) {
        const parents = [];
        const seen = new Set([item.id]);
        for (let parent = collections.get(item.parentId); parent && !seen.has(parent.id) && parents.length < 128;
          parent = collections.get(parent.parentId)) {
          seen.add(parent.id);
          parents.push(parent.name);
        }
        const path = [library.name, ...parents.reverse()].join(' / ');
        rows.push({ id: `${library.registrationId}:${item.id}`, libraryId: library.registrationId,
          key: savedKey(library, item.id), name: item.name, path,
          titleKey: normalized(item.name), pathKey: normalized(path) });
      }
    }
    return rows.sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.path, b.path));
  }

  function setActive(next, scroll = false) {
    if (active >= 0) list.children[active]?.setAttribute('aria-selected', 'false');
    active = next;
    const option = list.children[active];
    const item = matches[active];
    const pinned = !!item && quickAccess.pinned.includes(item.key);
    pin.disabled = !item;
    pin.toggleAttribute('data-pinned', pinned);
    pin.textContent = pinned ? '移出常用' : '加入常用';
    pin.title = item ? `${pin.textContent}：${item.name}（Ctrl+Enter）` : '';
    if (!option) { input.removeAttribute('aria-activedescendant'); return; }
    input.setAttribute('aria-activedescendant', option.id);
    option.setAttribute('aria-selected', 'true');
    if (scroll) option.scrollIntoView({ block: 'nearest' });
  }

  function quickFirst() {
    const available = new Map(index.map(item => [item.key, item]));
    const promoted = new Set([...quickAccess.pinned, ...quickAccess.recent]);
    return [...Array.from(promoted, key => available.get(key)).filter(Boolean),
      ...index.filter(item => !promoted.has(item.key))];
  }

  function render(preferredId) {
    const query = normalized(input.value).trim();
    const words = query.split(/[\s/›>]+/u).filter(Boolean);
    const exact = [];
    const names = [];
    const paths = [];
    if (query) {
      for (const item of index) {
        if (item.titleKey === query) exact.push(item);
        else if (words.every(word => item.titleKey.includes(word))) names.push(item);
        else if (words.every(word => item.titleKey.includes(word) || item.pathKey.includes(word))) paths.push(item);
      }
    }
    const results = query ? exact.concat(names, paths) : quickFirst();
    const total = results.length;
    matches = results.slice(0, limit);
    list.replaceChildren(...matches.map((item, position) => {
      const option = document.createElement('li');
      option.id = `collection-result-${position}`;
      option.dataset.position = position;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.title = `${item.path} / ${item.name}`;
      const name = document.createElement('strong');
      const path = document.createElement('small');
      name.textContent = item.name;
      path.textContent = item.path;
      option.append(name, path);
      const category = quickAccess.pinned.includes(item.key) ? '常用' : quickAccess.recent.includes(item.key) ? '最近' : '';
      if (category) {
        const label = document.createElement('span');
        label.className = 'collection-finder-category';
        label.textContent = category;
        option.append(label);
      }
      return option;
    }));
    input.setAttribute('aria-expanded', String(total > 0));
    list.hidden = total === 0;
    status.textContent = total > limit ? `找到 ${total} 个集合，显示前 ${limit} 个。` : total ? `${total} 个集合` :
      index.length ? '没有找到匹配的集合。' : '已读取的素材库中暂无集合。';
    active = -1;
    const preferred = matches.findIndex(item => item.id === preferredId);
    list.scrollTop = 0;
    setActive(total ? Math.max(0, preferred) : -1, preferred > 0);
  }

  function updateIndex() {
    const next = getLibraries();
    if (next.length === sources.length && next.every((library, i) => library.revision === sources[i].revision &&
      library.id === sources[i].id && library.registrationId === sources[i].registrationId &&
      library.kind === sources[i].kind && library.name === sources[i].name)) return false;
    sources = next;
    index = collectionIndex(next);
    return true;
  }

  function togglePin(selected) {
    if (!selected) return '集合暂不可用，请刷新素材库。';
    const previous = quickAccess.pinned;
    const pinned = previous.includes(selected.key);
    let reusable = -1;
    if (!pinned && previous.length >= pinnedLimit) {
      const available = new Set(index.map(item => item.key));
      reusable = previous.findLastIndex(key => !available.has(key));
      if (reusable < 0) return `常用集合最多保存 ${pinnedLimit} 个。移出一项后可继续添加。`;
    }
    quickAccess.pinned = pinned ? previous.filter(key => key !== selected.key)
      : [selected.key, ...previous.filter((_key, position) => position !== reusable)];
    if (!persist()) {
      quickAccess.pinned = previous;
      return '无法保存常用集合。';
    }
    if (dialog.open) render(selected.id);
    return pinned ? `已将「${selected.name}」移出常用。` : `已将「${selected.name}」加入常用。`;
  }

  function pick(position) {
    const item = matches[position];
    if (!item) return;
    dialog.close();
    onPick(item);
  }

  input.addEventListener('input', event => { if (!event.isComposing) render(); });
  input.addEventListener('compositionend', () => render());
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || !matches.length) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.ctrlKey) status.textContent = togglePin(matches[active]);
      else pick(active);
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = active + (event.key === 'ArrowDown' ? 1 : -1);
      setActive(Math.max(0, Math.min(matches.length - 1, next)), true);
    }
  });
  list.addEventListener('click', event => {
    const option = event.target.closest('[data-position]');
    if (option) pick(Number(option.dataset.position));
  });
  list.addEventListener('pointermove', event => {
    const option = event.target.closest('[data-position]');
    if (option && Number(option.dataset.position) !== active) setActive(Number(option.dataset.position));
  });
  pin.addEventListener('click', () => { status.textContent = togglePin(matches[active]); });
  dialog.querySelector('[data-icon="close"]').addEventListener('click', () => dialog.close());
  return {
    pinned(collectionId) {
      const key = keyForCollection(collectionId);
      return key ? quickAccess.pinned.includes(key) : null;
    },
    togglePinned(collectionId) {
      updateIndex();
      return togglePin(index.find(item => item.id === collectionId));
    },
    remember(collectionId) {
      const key = keyForCollection(collectionId);
      if (!key || quickAccess.recent[0] === key) return;
      quickAccess.recent = [key, ...quickAccess.recent.filter(item => item !== key)].slice(0, recentLimit);
      persist();
    },
    refresh() { if (dialog.open && updateIndex()) render(matches[active]?.id); },
    open() {
      if (dialog.open) return;
      updateIndex();
      input.value = '';
      render();
      dialog.showModal();
      input.focus();
    },
  };
};
