'use strict';

function tagKey(tag) {
  return tag.normalize('NFKC').trim().toLowerCase();
}

function validTarget(text) {
  return text.length > 0 && Array.from(text).length <= 128 && !/[\p{Cc}\p{Cs}]/u.test(text);
}

function tagChangePlan(assets, { action, from, to, revision }, currentRevision) {
  if (typeof from !== 'string' || from.length > 4096 || from.includes('\0') || !tagKey(from)) {
    throw new Error('请选择有效的标签。');
  }
  if (to !== null) {
    if (typeof to !== 'string' || to.length > 512 || !validTarget(to.trim())) {
      throw new Error('请输入 1 至 128 个字符的标签名称。');
    }
    to = to.trim().normalize('NFC');
  }
  if (action === 'changeTag' && revision !== currentRevision) {
    throw new Error('素材库已变化，请重新预览标签变更。');
  }

  const sourceKey = tagKey(from);
  const targetKey = to === null ? null : tagKey(to);
  const matching = [];
  let mergedName = null;
  for (const asset of assets) {
    let matchesSource = false;
    for (const label of asset.tags) {
      const key = tagKey(label);
      if (key === sourceKey) matchesSource = true;
      if (sourceKey !== targetKey && key === targetKey && validTarget(label) &&
          (mergedName === null || label < mergedName)) mergedName = label;
    }
    if (matchesSource) matching.push(asset);
  }

  const mode = to === null ? 'delete' : mergedName === null ? 'rename' : 'merge';
  const target = mergedName ?? to;
  const updates = [];
  let trashedCount = 0;
  for (const asset of matching) {
    const tags = [];
    let inserted = false;
    for (const label of asset.tags) {
      const key = tagKey(label);
      if (key !== sourceKey && key !== targetKey) tags.push(label);
      else if (target !== null && !inserted) {
        tags.push(target);
        inserted = true;
      }
    }
    if (tags.length === asset.tags.length && tags.every((label, index) => label === asset.tags[index])) continue;
    updates.push({ asset, tags });
    if (asset.trashed) trashedCount++;
  }

  return { updates, result: { count: updates.length, trashedCount, mode, from, to: target } };
}

module.exports = { tagChangePlan };
