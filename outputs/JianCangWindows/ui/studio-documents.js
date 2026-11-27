'use strict';

(() => {
  const hash = /^[a-f0-9]{64}$/;
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  const kinds = new Set(['image', 'video', 'audio', 'pdf', 'document', 'link']);
  const orientations = new Set(['any', 'portrait', 'landscape', 'square']);
  const ruleFields = new Map([
    ['tagIncluded', '包含标签'], ['tagExcluded', '排除标签'], ['pixelWidth', '宽度（像素）'],
    ['pixelHeight', '高度（像素）'], ['fileSize', '文件大小（字节）'], ['importedAt', '添加日期'],
  ]);
  const documentError = () => new Error('文档无效。请核对名称、规则范围和说明长度。');
  const isText = (value, limit) => typeof value === 'string' && value.length <= limit && !value.includes('\0') && value.isWellFormed();
  const matchMode = value => value === 'all' || value === 'any';
  const encoder = new TextEncoder();

  function readBoard(payload) {
    const value = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!isText(value?.title, 80) || !value.title.trim() || !Array.isArray(value.entries) || value.entries.length > 80) throw documentError();
    const seen = new Set();
    const entries = value.entries.map(card => {
      if (typeof card?.assetID !== 'string' || !hash.test(card.assetID) || seen.has(card.assetID) ||
        !isText(card.caption, 480) || !isText(card.title, 160) || !card.title.trim()) throw documentError();
      seen.add(card.assetID);
      return { assetID: card.assetID, caption: card.caption, title: card.title };
    });
    return { title: value.title.trim(), entries };
  }

  function readRule(rule) {
    const { field, tag, min, max } = rule ?? {};
    if (!ruleFields.has(field)) throw documentError();
    if (field === 'tagIncluded' || field === 'tagExcluded') {
      if (!isText(tag, 512) || !tag.trim() || encoder.encode(tag).length > 512 || min != null || max != null) throw documentError();
      return { field, tag };
    }
    const validBound = field === 'importedAt'
      ? value => Number.isFinite(value) && Math.abs(value) <= 8_640_000_000_000
      : value => Number.isSafeInteger(value) && (field === 'fileSize' ? value >= 0 : value >= 1 && value <= 100_000_000);
    if (tag != null || (min == null && max == null) || (min != null && !validBound(min)) ||
      (max != null && !validBound(max)) || (min != null && max != null && min > max)) throw documentError();
    return { field, ...(min != null && { min }), ...(max != null && { max }) };
  }

  function readFilter(payload) {
    const value = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!isText(value?.title, 80) || !value.title.trim() || !isText(value.text, 512) ||
      (value.kind != null && !kinds.has(value.kind)) || !orientations.has(value.orientation) ||
      (value.recentDays != null && (!Number.isInteger(value.recentDays) || value.recentDays < 1 || value.recentDays > 36500)) ||
      typeof value.untagged !== 'boolean' || !Number.isInteger(value.minRating) || value.minRating < 0 || value.minRating > 5 ||
      typeof value.favoritesOnly !== 'boolean' || !matchMode(value.match) || !Array.isArray(value.groups) || value.groups.length > 8) throw documentError();
    const groups = value.groups.map(group => {
      if (!matchMode(group?.match) || !Array.isArray(group.rules) || !group.rules.length || group.rules.length > 16) throw documentError();
      return { match: group.match, rules: group.rules.map(readRule) };
    });
    if (groups.reduce((count, group) => count + group.rules.length, 0) > 64) throw documentError();
    return { title: value.title.trim(), text: value.text, kind: value.kind ?? null, orientation: value.orientation,
      recentDays: value.recentDays ?? null, untagged: value.untagged, minRating: value.minRating,
      favoritesOnly: value.favoritesOnly, match: value.match, groups };
  }

  function groupMatch(values, match, evaluate) { return match === 'all' ? values.every(evaluate) : values.some(evaluate); }
  function normalized(value) { return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('und'); }

  function prepareFilter(filter, now = Date.now() / 1000) {
    const terms = normalized(filter.text).split(/\s+/u).filter(Boolean);
    const oldest = filter.recentDays == null ? -Infinity : now - filter.recentDays * 86400;
    return (asset, recognized = () => '') => {
      const tags = asset.tags ?? [];
      const kind = asset.extension === 'livp' ? 'image' : asset.kind;
      if ((filter.kind && filter.kind !== kind) || (filter.untagged && tags.length) ||
        (filter.favoritesOnly && asset.favorite !== true) || (asset.rating ?? 0) < filter.minRating) return false;
      const importedAt = Date.parse(asset.importedAt) / 1000;
      if (filter.recentDays != null && (!Number.isFinite(importedAt) || importedAt < oldest)) return false;
      const { width, height } = asset;
      if (filter.orientation !== 'any') {
        if (!(width > 0 && height > 0)) return false;
        if (filter.orientation === 'portrait' && height <= width || filter.orientation === 'landscape' && width <= height ||
          filter.orientation === 'square' && width !== height) return false;
      }
      if (filter.groups.length && !groupMatch(filter.groups, filter.match, group => groupMatch(group.rules, group.match, rule => {
        if (rule.field === 'tagIncluded') return tags.includes(rule.tag);
        if (rule.field === 'tagExcluded') return !tags.includes(rule.tag);
        const value = rule.field === 'pixelWidth' ? width : rule.field === 'pixelHeight' ? height
          : rule.field === 'fileSize' ? asset.byteCount : importedAt;
        if (rule.field !== 'importedAt' && value < (rule.field === 'fileSize' ? 0 : 1)) return false;
        return Number.isFinite(value) && (rule.min == null || value >= rule.min) && (rule.max == null || value <= rule.max);
      }))) return false;
      if (!terms.length) return true;
      const haystack = normalized([asset.name, asset.note, asset.extension, asset.sourceURL, recognized(), ...tags].join(' '));
      return terms.every(term => haystack.includes(term));
    };
  }

  const utilities = { isID: value => typeof value === 'string' && uuid.test(value), readBoard, readFilter, prepareFilter, ruleFields };
  if (typeof module !== 'undefined' && module.exports) module.exports = utilities;
  else window.jiancangStudioDocuments = utilities;
})();
