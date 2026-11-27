'use strict';

(() => {
  const key = 'jiancang-browse-workspaces-v1';
  const maximumWorkspaces = 48;
  const maximumExpanded = 256;
  const sections = new Set(['all', 'favorites', 'stash', 'unfiled', 'untagged', 'recent', 'trash', 'collection']);
  const validID = value => typeof value === 'string' && value.length > 0 && value.length <= 200;

  function validBookmark(bookmark) {
    if (!bookmark || !Number.isFinite(bookmark.top) || bookmark.top < 0 || bookmark.top > 300_000_000) return null;
    const id = validID(bookmark.id) ? bookmark.id : null;
    const offset = Number.isFinite(bookmark.offset) && bookmark.offset >= 0 && bookmark.offset < 4096 ? bookmark.offset : 0;
    return { top: bookmark.top, id, offset };
  }

  function clean(value) {
    if (!value || !sections.has(value.section) || (value.section === 'collection' && !validID(value.collectionId))) return null;
    const expanded = Array.isArray(value.expanded) ? value.expanded.filter(validID).slice(-maximumExpanded) : [];
    return { section: value.section, collectionId: value.section === 'collection' ? value.collectionId : null,
      expanded: [...new Set(expanded)], bookmark: validBookmark(value.bookmark) };
  }

  window.createJianCangBrowseWorkspace = function createBrowserWorkspace(storage) {
    const records = new Map();
    try {
      const payload = JSON.parse(storage.getItem(key) || '[]');
      for (const pair of Array.isArray(payload) ? payload.slice(-maximumWorkspaces) : []) {
        if (!Array.isArray(pair) || pair.length !== 2 || (pair[0] !== null && !validID(pair[0]))) continue;
        const value = clean(pair[1]);
        if (value) records.set(pair[0], value);
      }
    } catch { /* Continue with an in-memory workspace when storage is unavailable. */ }
    return {
      read(scope) { return records.get(scope); },
      remember(scope, input) {
        const value = clean(input);
        if (!value || (scope !== null && !validID(scope))) return;
        if (JSON.stringify(records.get(scope)) === JSON.stringify(value)) return;
        records.delete(scope);
        records.set(scope, value);
        if (records.size > maximumWorkspaces) records.delete(records.keys().next().value);
        try { storage.setItem(key, JSON.stringify([...records])); } catch { /* This session can still restore views. */ }
      },
    };
  };
})();
