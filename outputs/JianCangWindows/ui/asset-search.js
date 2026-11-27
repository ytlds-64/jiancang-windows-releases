'use strict';

(() => {
  const fields = new Map([
    ['all', '全部字段'], ['name', '名称'], ['tags', '标签'], ['note', '备注'], ['source', '来源网址'],
    ['site', '来源网站'], ['ocr', '图片文字'],
  ]);
  const storageKey = 'jiancang.asset-search.v1';
  const maxRecent = 12;
  const normalize = value => (value || '').normalize('NFKC').toLocaleLowerCase('zh-CN');
  const canonicalQuery = value => normalize(value).trim().replace(/\s+/gu, ' ');
  const validField = field => fields.has(field) ? field : 'all';
  const cleanQuery = value => typeof value === 'string' ? value.trim().slice(0, 512) : '';

  function sourceSite(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
      return parsed.hostname.replace(/^www\./, '').replace(/\.$/, '');
    } catch { return ''; }
  }

  function siteQuery(value) {
    const query = cleanQuery(value);
    if (!query) return '';
    return sourceSite(/^https?:\/\//i.test(query) ? query : `https://${query}`);
  }

  function searchTerms(query) {
    const tokens = /(?:^|\s)(-?)(?:"([^"]*)(?:"(?=\s|$)|$)|“([^”]*)(?:”(?=\s|$)|$)|(\S+))/gu;
    return Array.from(canonicalQuery(query).matchAll(tokens), ([, operator, phrase, chinesePhrase, word]) => ({
      text: (phrase ?? chinesePhrase ?? word).trim(),
      excluded: operator === '-',
    })).filter(term => term.text);
  }

  function readRecent() {
    try {
      const values = JSON.parse(localStorage.getItem(storageKey) || '[]');
      if (Array.isArray(values)) return values.slice(0, maxRecent)
        .map(value => ({ query: cleanQuery(value?.query), field: validField(value?.field) })).filter(value => value.query);
    } catch { /* Searches can still be recalled for this session. */ }
    return [];
  }

  function searchableText(asset, field, recognizedText) {
    // Separate fields and tags so a phrase stays within one value.
    switch (field) {
      case 'name': return asset.name;
      case 'tags': return asset.tags.join('\0');
      case 'note': return asset.note;
      case 'source': return asset.sourceURL;
      case 'ocr': return recognizedText(asset);
      default: return [asset.name, asset.note, ...asset.tags, asset.extension, asset.sourceName,
        asset.sourceURL, recognizedText(asset)].join('\0');
    }
  }

  window.jiancangSearchField = validField;
  window.jiancangSourceSite = sourceSite;
  window.createJianCangAssetSearch = ({ input, shell, onChange, recognizedText }) => {
    const trigger = shell.querySelector('#search-options-button');
    const triggerLabel = shell.querySelector('#search-field-label');
    const panel = shell.querySelector('#search-options');
    const scopes = Array.from(panel.querySelectorAll('[data-search-field]'));
    const recentList = panel.querySelector('#recent-searches');
    const recentEmpty = panel.querySelector('#recent-searches-empty');
    const clearRecent = panel.querySelector('#clear-recent-searches');
    const confirmation = panel.querySelector('#confirm-clear-searches');
    const cancelClear = panel.querySelector('#cancel-clear-searches');
    const confirmClear = panel.querySelector('#accept-clear-searches');
    const clear = shell.querySelector('#clear-search');
    const key = shell.querySelector('#search-key');
    let recent = readRecent();
    let field = 'all';
    let composing = false;
    let timer;

    function close() { if (panel.matches(':popover-open')) panel.hidePopover(); }
    function position() {
      const { left, bottom, width } = shell.getBoundingClientRect();
      const panelWidth = Math.min(Math.max(300, width), 400, Math.max(0, innerWidth - 16));
      const y = bottom + 6;
      panel.style.width = `${panelWidth}px`;
      panel.style.left = `${Math.max(8, Math.min(left, innerWidth - panelWidth - 8))}px`;
      panel.style.top = `${y}px`;
      panel.style.maxHeight = `${Math.max(0, innerHeight - y - 8)}px`;
    }

    function update() {
      const label = fields.get(field);
      triggerLabel.textContent = label;
      triggerLabel.hidden = field === 'all';
      trigger.setAttribute('aria-label', `搜索范围：${label}，查看最近搜索`);
      trigger.title = '搜索范围和最近搜索';
      trigger.dataset.scoped = String(field !== 'all');
      input.placeholder = field === 'all' ? '搜索名称、标签、备注、来源或图片文字' : `搜索${label}`;
      for (const button of scopes) button.setAttribute('aria-pressed', String(button.dataset.searchField === field));
      clear.hidden = input.value.length === 0;
      key.hidden = !clear.hidden;
    }

    function restore(query, nextField = 'all') {
      clearTimeout(timer);
      input.value = typeof query === 'string' ? query.slice(0, 512) : '';
      field = validField(nextField);
      update();
    }

    function persistRecent() {
      try { localStorage.setItem(storageKey, JSON.stringify(recent)); }
      catch { /* Keep the recent searches in memory. */ }
    }

    function rememberQuery() {
      const query = cleanQuery(input.value);
      if (!query) return;
      const value = canonicalQuery(query);
      recent = [{ query, field }, ...recent.filter(item => item.field !== field || canonicalQuery(item.query) !== value)]
        .slice(0, maxRecent);
      persistRecent();
      renderRecent();
    }

    function renderRecent() {
      clearRecent.hidden = !recent.length;
      recentEmpty.hidden = recent.length > 0;
      recentList.replaceChildren(...recent.map(item => {
        const row = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'recent-search-option';
        button.title = item.query;
        const query = document.createElement('span');
        query.textContent = item.query;
        const scope = document.createElement('small');
        scope.textContent = fields.get(item.field);
        button.append(query, scope);
        button.addEventListener('click', () => {
          restore(item.query, item.field);
          rememberQuery();
          close();
          onChange();
          input.focus();
        });
        row.append(button);
        return row;
      }));
    }

    for (const button of scopes) button.addEventListener('click', () => {
      restore(input.value, button.dataset.searchField);
      close();
      onChange();
      input.focus();
    });
    panel.addEventListener('beforetoggle', event => {
      const opening = event.newState === 'open';
      trigger.setAttribute('aria-expanded', String(opening));
      if (opening) position();
      else confirmation.hidden = true;
    });
    window.addEventListener('resize', () => { if (panel.matches(':popover-open')) position(); });
    clearRecent.addEventListener('click', () => {
      confirmation.hidden = false;
      cancelClear.focus();
    });
    cancelClear.addEventListener('click', () => {
      confirmation.hidden = true;
      clearRecent.focus();
    });
    confirmClear.addEventListener('click', () => {
      recent = [];
      persistRecent();
      confirmation.hidden = true;
      renderRecent();
      trigger.focus();
    });

    function changed() {
      update();
      clearTimeout(timer);
      timer = setTimeout(onChange, 90);
    }

    input.addEventListener('compositionstart', () => { composing = true; clearTimeout(timer); });
    input.addEventListener('compositionend', () => { composing = false; changed(); });
    input.addEventListener('input', event => { if (!composing && !event.isComposing) changed(); });
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.repeat || event.isComposing || composing || event.keyCode === 229) return;
      event.preventDefault();
      clearTimeout(timer);
      rememberQuery();
      close();
      onChange();
    });
    clear.addEventListener('click', () => {
      restore('', field);
      onChange();
      input.focus();
    });
    renderRecent();
    update();

    return {
      get field() { return field; },
      get isOpen() { return panel.matches(':popover-open'); },
      fieldLabel: value => fields.get(validField(value)),
      restore,
      close,
      matcher() {
        if (field === 'site') {
          if (!cleanQuery(input.value)) return null;
          const hostname = siteQuery(input.value);
          return asset => Boolean(hostname && sourceSite(asset.sourceURL) === hostname);
        }
        const terms = searchTerms(input.value);
        if (!terms.length) return null;
        const scope = field;
        return asset => {
          const haystack = canonicalQuery(searchableText(asset, scope, recognizedText));
          return terms.every(term => haystack.includes(term.text) !== term.excluded);
        };
      },
    };
  };
})();
