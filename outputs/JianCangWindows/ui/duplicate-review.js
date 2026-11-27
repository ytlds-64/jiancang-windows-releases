'use strict';

(() => {
  const counts = new Intl.NumberFormat('zh-CN');
  const key = ref => `${ref.registrationId}:${ref.assetId}`;
  const titles = { 'same-original': '原件完全一致', 'same-preview': '画面一致', 'similar-image': '相似图片' };
  const explanations = {
    'same-original': '这组原件的文件内容完全一致。',
    'same-preview': '这组生成的预览画面一致。请核对原件的尺寸、格式和来源。',
    'similar-image': '这组图片的构图和颜色接近。可以对照后再勾选要移走的素材。',
  };

  function element(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }

  function button(text, className, run) {
    const control = element('button', className, text);
    control.type = 'button';
    if (run) control.addEventListener('click', run);
    return control;
  }

  function option(value, label) {
    const item = element('option', '', label);
    item.value = value;
    return item;
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    const formats = ['B', 'KB', 'MB', 'GB', 'TB'];
    let level = 0;
    while (bytes >= 1024 && level < formats.length - 1) { bytes /= 1024; level++; }
    return `${counts.format(Number(bytes.toFixed(level === 0 ? 0 : 1)))} ${formats[level]}`;
  }

  function modal(title, className) {
    const dialog = element('dialog', className);
    const head = element('header', 'dialog-head');
    const heading = element('h2', '', title);
    const close = button('×', 'icon-button', () => dialog.close());
    const labelId = `duplicate-${crypto.randomUUID()}`;
    heading.id = labelId;
    dialog.setAttribute('aria-labelledby', labelId);
    close.setAttribute('aria-label', '关闭');
    head.append(heading, close);
    dialog.append(head);
    document.body.append(dialog);
    return { dialog, heading };
  }

  window.createJianCangDuplicateReview = function createJianCangDuplicateReview({ bridge, getScope, getAsset, getImage, canTrash, canMerge, compare, notify }) {
    const { dialog } = modal('重复素材整理', 'duplicate-review-dialog');
    const { dialog: closeupDialog, heading: closeupTitle } = modal('查看图片', 'duplicate-photo-dialog');
    const { dialog: confirmDialog, heading: confirmTitle } = modal('确认移到回收站', 'duplicate-confirm-dialog local-intake-dialog');
    dialog.id = 'duplicate-review-dialog';
    const comparePreview = element('div', 'duplicate-photo-content');
    closeupDialog.append(comparePreview);
    closeupDialog.addEventListener('close', () => comparePreview.replaceChildren());

    const controls = element('div', 'duplicate-toolbar');
    const scopeText = element('span', 'duplicate-scope');
    const mode = element('select', 'duplicate-mode');
    mode.id = 'duplicate-scan-mode';
    mode.setAttribute('aria-label', '扫描方式');
    mode.append(option('exact', '按原件找重复'), option('visual', '按画面找相似'));
    const scan = button('开始扫描', 'primary-button', () => void start());
    scan.id = 'duplicate-review-scan';
    const resume = button('继续上次扫描', 'outline-button', () => void resumeScan());
    resume.id = 'duplicate-review-resume';
    const stop = button('停止扫描', 'outline-button', () => void stopScan());
    const statusText = element('span', 'duplicate-scan-status');
    statusText.setAttribute('role', 'status');
    const progress = element('progress', 'duplicate-scan-progress');
    progress.setAttribute('aria-label', '重复检查进度');
    const error = element('p', 'local-intake-error duplicate-notice');
    error.hidden = true;
    error.setAttribute('role', 'status');
    const issues = element('details', 'duplicate-issues');
    const issuesTitle = element('summary');
    const issuesList = element('div', 'duplicate-issue-list');
    issues.append(issuesTitle, issuesList);
    const layout = element('div', 'duplicate-workspace');
    const rail = element('aside', 'duplicate-groups');
    const railLabel = element('h3', 'duplicate-groups-label', '结果分组');
    railLabel.setAttribute('aria-live', 'polite');
    const filters = element('div', 'duplicate-group-filters');
    const byKind = element('select', 'duplicate-mode');
    byKind.id = 'duplicate-result-kind';
    byKind.setAttribute('aria-label', '按匹配类型筛选分组');
    byKind.append(option('', '全部匹配类型'), option('same-preview', titles['same-preview']),
      option('similar-image', titles['similar-image']));
    const byLibrary = element('select', 'duplicate-mode');
    byLibrary.id = 'duplicate-result-library';
    byLibrary.setAttribute('aria-label', '按组内素材库筛选分组');
    filters.append(byKind, byLibrary);
    const groupList = element('nav', 'duplicate-group-list');
    groupList.setAttribute('aria-label', '重复素材分组');
    const desk = element('section', 'duplicate-desk');
    desk.setAttribute('aria-label', '组内素材');
    const details = element('div', 'duplicate-group-details');
    const cards = element('div', 'duplicate-cards');
    const footer = element('footer', 'duplicate-review-footer');
    rail.append(railLabel, filters, groupList);
    desk.append(details, cards, footer);
    layout.append(rail, desk);
    controls.append(scopeText, mode, scan, resume, stop, statusText);
    dialog.append(controls, progress, error, issues, layout);
    const confirmBody = element('div', 'local-intake-body');
    confirmDialog.append(confirmBody);

    let snapshot = null;
    let scanScope = '';
    let filterJobId = null;
    let activeGroup = null;
    let groupsVisible = 120;
    let cardsVisible = 72;
    let fetchCounter = 0;
    let busy = false;
    let applying = false;
    let keeper = null;
    const chosen = new Set();
    const comparisons = new Set();

    function updateNotice(message) {
      error.textContent = message || '';
      error.hidden = !message;
    }

    function currentGroup() { return snapshot?.groups?.find(group => group.id === activeGroup) || null; }

    function groupName(group) { return titles[group.kind] || '待核对素材'; }

    function clearChoices() {
      keeper = null;
      chosen.clear();
      comparisons.clear();
      cardsVisible = 72;
    }

    function updateStatus(record = snapshot) {
      const scope = getScope();
      scopeText.textContent = `范围 · ${scope?.title || '当前素材'}`;
      const total = record?.total || 0;
      const processed = record?.processed || 0;
      const running = record?.status === 'running';
      scan.disabled = !scope?.assets?.length || running || busy || applying;
      mode.disabled = running || busy || applying;
      resume.hidden = record?.status !== 'cancelled';
      resume.disabled = busy || applying;
      stop.hidden = !running;
      progress.hidden = !running;
      byKind.disabled = byLibrary.disabled = running || busy || applying;
      if (running) {
        progress.max = Math.max(1, total);
        progress.value = Math.min(processed, total);
        const label = record.stage === 'matching' ? '正在匹配画面' : record.mode === 'visual' ? '正在读取图片索引' : '正在检查原件';
        statusText.textContent = `${label} ${counts.format(processed)} / ${counts.format(total)}`;
      } else if (record?.jobId) {
        const prefix = record.status === 'cancelled' ? '已停止' : record.status === 'failed' ? '扫描未完成' : '扫描完成';
        const count = record.groups?.length ?? record.groupCount ?? 0;
        const partial = record.status === 'cancelled' ? ` · 已检查 ${counts.format(processed)} / ${counts.format(total)}` : '';
        statusText.textContent = `${prefix}${partial} · ${counts.format(count)} 组${scanScope && scanScope !== scope?.title ? ` · ${scanScope}` : ''}`;
      } else statusText.textContent = '';
    }

    function displayIssues() {
      const entries = snapshot?.issues || [];
      const failed = entries.reduce((total, item) => total + item.failed, 0);
      const unindexed = entries.reduce((total, item) => total + item.unindexed, 0);
      issues.hidden = !entries.length;
      if (!entries.length) return;
      issuesTitle.textContent = [failed && `${counts.format(failed)} 项未能读取`, unindexed && `${counts.format(unindexed)} 张图片尚未分析`].filter(Boolean).join(' · ');
      issuesList.replaceChildren(...entries.map(issue => {
        const row = element('div', 'duplicate-issue');
        const state = [issue.failed && `未读取 ${issue.failed} 项`, issue.unindexed && `待分析 ${issue.unindexed} 张`].filter(Boolean).join('，');
        const retry = button('重试', 'outline-button', () => void retryIssue(issue.registrationId));
        retry.disabled = busy || applying || snapshot.status === 'running';
        row.append(element('span', '', issue.sourceName || '素材库'), element('span', 'duplicate-issue-count', state), retry);
        return row;
      }));
      if (unindexed) issuesList.append(element('p', '', '先确认对应图片的原件已下载、可以打开，再重试。'));
    }

    function selectGroup(group) {
      activeGroup = group.id;
      clearChoices();
      render();
      cards.scrollTop = 0;
      [...groupList.querySelectorAll('button[data-duplicate-group]')].find(row => row.dataset.duplicateGroup === group.id)?.focus({ preventScroll: true });
    }

    function refreshFilters(groups) {
      const selected = byLibrary.value;
      const libraries = new Map();
      for (const group of groups) {
        for (const ref of group.members) {
          if (!libraries.has(ref.registrationId)) libraries.set(ref.registrationId, ref.sourceName || '素材库');
        }
      }
      if (selected && !libraries.has(selected)) libraries.set(selected, byLibrary.selectedOptions[0].textContent);
      byLibrary.replaceChildren(option('', '全部素材库'), ...[...libraries].map(([id, name]) => option(id, name)));
      byLibrary.value = selected;
      byLibrary.title = byLibrary.selectedOptions[0].textContent;
      byKind.hidden = snapshot?.mode !== 'visual';
      filters.hidden = !groups.length && !byKind.value && !selected;
    }

    function filteredGroups(groups) {
      const kind = byKind.value;
      const library = byLibrary.value;
      return groups.filter(group => (!kind || group.kind === kind) &&
        (!library || group.members.some(ref => ref.registrationId === library)));
    }

    function groupNav(groups) {
      const total = snapshot?.groups?.length || 0;
      const filtering = byKind.value || byLibrary.value;
      railLabel.textContent = filtering ? `显示 ${counts.format(groups.length)} / ${counts.format(total)} 组` :
        `结果分组 · ${counts.format(total)}`;
      if (!groups.length) {
        groupList.replaceChildren(element('p', 'duplicate-group-blank', filtering ? '当前筛选无结果' : '暂无分组'));
        return;
      }
      const rows = groups.slice(0, groupsVisible).map(group => {
        const item = button('', 'duplicate-group-button', () => selectGroup(group));
        const title = element('strong', '', groupName(group));
        const member = element('span', 'duplicate-group-sample', group.members[0]?.name || '素材');
        const count = element('span', 'duplicate-group-number', counts.format(group.members.length));
        item.dataset.duplicateGroup = group.id;
        if (group.id === activeGroup) item.setAttribute('aria-current', 'true');
        item.append(title, count, member);
        return item;
      });
      if (rows.length < groups.length) rows.push(button('显示更多分组', 'status-button', () => { groupsVisible += 120; groupNav(groups); }));
      groupList.replaceChildren(...rows);
    }

    function changeFilter() {
      clearChoices();
      groupsVisible = 120;
      updateNotice('');
      render();
      groupList.scrollTop = 0;
      cards.scrollTop = 0;
    }
    byKind.addEventListener('change', changeFilter);
    byLibrary.addEventListener('change', changeFilter);

    function imageFor(asset, kind) {
      if (!asset || (asset.kind !== 'image' && asset.extension !== 'livp') || !(asset.available || asset.thumbnailAvailable)) return '';
      return getImage(asset, kind) || '';
    }

    function openPhoto(asset, title) {
      const source = imageFor(asset, 'large');
      if (!source) return;
      closeupTitle.textContent = title || '查看图片';
      const image = element('img');
      image.alt = title;
      image.src = source;
      image.addEventListener('error', () => {
        const fallback = imageFor(asset, 'thumbnail');
        if (fallback && fallback !== source) image.src = fallback;
      }, { once: true });
      comparePreview.replaceChildren(image);
      if (!closeupDialog.open) closeupDialog.showModal();
    }

    function itemCard(ref, group) {
      const asset = getAsset(ref);
      const name = asset?.name || ref.name || '素材';
      const id = key(ref);
      const card = element('article', 'duplicate-card');
      card.dataset.duplicateAsset = id;
      const preview = imageFor(asset, 'thumbnail');
      if (preview) {
        const photo = button('', 'duplicate-preview', () => openPhoto(asset, name));
        photo.setAttribute('aria-label', `查看 ${name} 大图`);
        const image = element('img');
        image.src = preview;
        image.alt = '';
        image.loading = 'lazy';
        image.addEventListener('error', () => {
          photo.disabled = true;
          photo.replaceChildren(element('span', '', '图片暂不可用'));
        }, { once: true });
        photo.append(image);
        card.append(photo);
      } else card.append(element('div', 'duplicate-preview duplicate-file-type', asset?.extension?.toUpperCase() || ref.extension?.toUpperCase() || '文件'));
      const caption = element('div', 'duplicate-caption');
      const title = element('h4', '', name);
      title.title = name;
      const source = element('p', 'duplicate-library', asset?.sourceName || ref.sourceName || '素材库');
      const dimensions = asset?.width > 0 && asset?.height > 0 ? `${asset.width} × ${asset.height}` : '';
      const meta = [formatSize(asset?.byteCount ?? ref.byteCount), dimensions, (asset?.extension || ref.extension)?.toUpperCase()].filter(Boolean).join(' · ');
      caption.append(title, source, element('p', 'duplicate-file-meta', meta));
      const actions = element('div', 'duplicate-card-actions');
      if (asset && canTrash(asset) && !asset.trashed) {
        const move = element('input');
        move.type = 'checkbox';
        move.className = 'duplicate-move';
        move.checked = chosen.has(id);
        move.disabled = applying || busy || snapshot?.status === 'running';
        const label = element('label', 'duplicate-tray-label');
        label.append(move, element('span', '', '移到回收站'));
        move.addEventListener('change', () => {
          if (move.checked && chosen.size + 1 >= group.members.length) {
            move.checked = false;
            updateNotice('每组至少保留一份素材。');
            return;
          }
          if (move.checked) {
            chosen.add(id);
            if (keeper && key(keeper) === id) markKeeper(null);
          }
          else chosen.delete(id);
          updateNotice('');
          updateFooter(group);
        });
        actions.append(label);
      } else actions.append(element('span', 'duplicate-readonly', asset ? (asset.trashed ? '已移到回收站' : '只读') : '素材暂不可用'));
      if (group.kind === 'same-original' && asset?.available && !asset.trashed) {
        const keep = button('保留这份', 'outline-button duplicate-pair duplicate-keep', () => chooseOtherCopies(group, ref));
        keep.setAttribute('aria-label', `保留 ${name}，选中其余可移动的副本`);
        keep.setAttribute('aria-pressed', String(keeper != null && key(keeper) === id));
        keep.title = '勾选其余可移动的副本';
        keep.disabled = applying || busy || snapshot?.status === 'running';
        actions.append(keep);
      }
      if (preview && typeof compare === 'function') {
        const mark = button('对照', 'outline-button duplicate-pair', () => {
          if (comparisons.has(id)) comparisons.delete(id);
          else if (comparisons.size >= 2) { updateNotice('最多选择两张图片对照。'); return; }
          else comparisons.add(id);
          mark.setAttribute('aria-pressed', String(comparisons.has(id)));
          updateNotice('');
          updateFooter(group);
        });
        mark.setAttribute('aria-pressed', String(comparisons.has(id)));
        mark.setAttribute('aria-label', `选择 ${name} 用于对照`);
        actions.append(mark);
      }
      card.append(caption, actions);
      return card;
    }

    function markKeeper(reference) {
      keeper = reference;
      for (const button of cards.querySelectorAll('.duplicate-keep')) {
        const id = button.closest('[data-duplicate-asset]').dataset.duplicateAsset;
        button.setAttribute('aria-pressed', String(keeper != null && key(keeper) === id));
      }
    }

    function chooseOtherCopies(group, reference) {
      if (applying || busy || snapshot?.status === 'running') return;
      markKeeper(reference);
      chosen.clear();
      for (const ref of group.members) {
        const asset = getAsset(ref);
        if (key(ref) !== key(keeper) && asset && !asset.trashed && canTrash(asset)) chosen.add(key(ref));
      }
      for (const checkbox of cards.querySelectorAll('.duplicate-move')) {
        checkbox.checked = chosen.has(checkbox.closest('[data-duplicate-asset]').dataset.duplicateAsset);
      }
      updateNotice(chosen.size ? '' : '这一组没有可移到回收站的其他副本。');
      updateFooter(group);
    }

    function openComparison(group) {
      const assets = group.members.filter(ref => comparisons.has(key(ref))).map(getAsset).filter(Boolean);
      if (assets.length !== 2) { updateNotice('对照图片已经变化，请重新选择。'); return; }
      compare(assets);
    }

    function updateFooter(group) {
      const summary = element('span', 'duplicate-selection');
      summary.textContent = `已选 ${counts.format(chosen.size)} 项移走 · 保留 ${counts.format(group.members.length - chosen.size)} 项`;
      summary.setAttribute('aria-live', 'polite');
      const actions = [];
      if (typeof compare === 'function') {
        const pair = button(`打开图像对照（${comparisons.size}/2）`, 'outline-button', () => openComparison(group));
        pair.disabled = comparisons.size !== 2;
        actions.push(pair);
      }
      const trash = button('移到回收站…', 'primary-button', () => confirmRemoval(group));
      trash.id = 'duplicate-review-trash';
      trash.disabled = !chosen.size || applying || busy || snapshot?.status === 'running';
      if (keeper && group.kind === 'same-original' && canMerge?.(getAsset(keeper))) {
        const sameLibrary = group.members.every(ref => !chosen.has(key(ref)) || ref.registrationId === keeper.registrationId);
        const merge = button('合并标签与集合…', 'primary-button', () => confirmRemoval(group, true));
        merge.id = 'duplicate-review-merge';
        merge.disabled = trash.disabled || !sameLibrary;
        if (!sameLibrary) summary.textContent += ' · 合并时请选择同一本地库的副本';
        trash.className = 'outline-button';
        actions.push(merge);
      }
      footer.replaceChildren(summary, ...actions, trash);
    }

    function empty() {
      const running = snapshot?.status === 'running';
      const title = running ? '正在扫描素材' : snapshot?.status === 'cancelled' ? '扫描已停止' :
        snapshot?.jobId ? '没有找到可核对的分组' : '检查当前范围内的重复素材';
      const description = running ? '' : snapshot?.jobId ?
        (snapshot.unindexed ? '原件可读取后，可以重试。' : '') :
        '按原件扫描可找到文件内容完全一致的素材。按画面扫描会分析图片并比较构图和颜色。';
      if (byKind.value || byLibrary.value) {
        const clear = button('清除筛选', 'outline-button', () => {
          byKind.value = byLibrary.value = '';
          changeFilter();
          (filters.hidden ? scan : byKind.hidden ? byLibrary : byKind).focus();
        });
        clear.disabled = busy || applying || running;
        details.replaceChildren(element('h3', '', '没有符合筛选的分组'), clear);
      } else details.replaceChildren(element('h3', '', title), ...(description ? [element('p', '', description)] : []));
      cards.replaceChildren();
      footer.replaceChildren();
    }

    function render() {
      const groups = snapshot?.groups || [];
      refreshFilters(groups);
      const visible = filteredGroups(groups);
      const group = visible.find(group => group.id === activeGroup) || visible[0] || null;
      if (activeGroup !== (group?.id ?? null)) {
        activeGroup = group?.id ?? null;
        clearChoices();
        cards.scrollTop = 0;
      }
      groupNav(visible);
      displayIssues();
      updateStatus();
      if (snapshot?.message && error.hidden) updateNotice(snapshot.message);
      desk.classList.toggle('duplicate-empty', !group);
      if (!group) { empty(); return; }
      details.replaceChildren(element('h3', '', `${groupName(group)} · ${counts.format(group.members.length)} 项`),
        element('p', '', explanations[group.kind]));
      if (group.kind === 'same-original') {
        details.append(element('p', '', '同一本地库的副本可以先合并标签和集合。请点选「保留这份」。'));
      }
      const grid = element('div', 'duplicate-card-grid');
      grid.append(...group.members.slice(0, cardsVisible).map(ref => itemCard(ref, group)));
      if (cardsVisible < group.members.length) grid.append(button('显示更多素材', 'outline-button duplicate-show-more', () => { cardsVisible += 72; render(); }));
      cards.replaceChildren(grid);
      updateFooter(group);
    }

    async function pull() {
      const request = ++fetchCounter;
      try {
        const next = await bridge.duplicateReviewStatus();
        if (request !== fetchCounter) return;
        if (next?.ok === false) throw new Error(next.message);
        snapshot = next;
        const jobId = next?.jobId ?? null;
        if (filterJobId !== jobId) {
          filterJobId = jobId;
          byKind.value = byLibrary.value = '';
          activeGroup = null;
          groupsVisible = 120;
          clearChoices();
          groupList.scrollTop = 0;
        }
        const group = currentGroup();
        if (group) {
          const ids = new Set(group.members.map(key));
          if (keeper && !ids.has(key(keeper))) keeper = null;
          for (const id of chosen) if (!ids.has(id)) chosen.delete(id);
          for (const id of comparisons) if (!ids.has(id)) comparisons.delete(id);
        }
        if (dialog.open) render();
      } catch (failure) { if (dialog.open) updateNotice(failure.message || '无法读取扫描结果。'); }
    }

    async function start() {
      if (busy || applying) return;
      const scope = getScope();
      const refs = (scope?.assets || []).map(asset => ({ registrationId: asset.sourceLibraryId || asset.registrationId,
        assetId: asset.sourceAssetId || asset.assetId, revision: asset.revision ||
          JSON.stringify([asset.mediaRevision || asset.sourceAssetId || asset.assetId, asset.byteCount, asset.width, asset.height]) }));
      if (!refs.length) return;
      busy = true;
      updateNotice('');
      render();
      try {
        const result = await bridge.startDuplicateReview(refs, mode.value);
        if (result?.ok === false) throw new Error(result.message);
        scanScope = scope.title || '';
        await pull();
      } catch (failure) { updateNotice(failure.message || '无法启动重复素材扫描。'); }
      finally { busy = false; render(); }
    }

    async function stopScan() {
      try { await bridge.cancelDuplicateReview(snapshot?.jobId); }
      catch (failure) { updateNotice(failure.message || '无法停止扫描。'); }
    }

    async function resumeScan() {
      if (busy || applying || snapshot?.status !== 'cancelled') return;
      busy = true;
      updateNotice('');
      render();
      try {
        const result = await bridge.resumeDuplicateReview(snapshot.jobId);
        if (result?.ok === false) throw new Error(result.message);
        await pull();
      } catch (failure) { updateNotice(failure.message || '无法继续扫描。'); }
      finally { busy = false; render(); }
    }

    async function retryIssue(registrationId) {
      if (busy || applying || snapshot?.status === 'running') return;
      busy = true;
      updateNotice('');
      render();
      try {
        const result = await bridge.retryDuplicateReview(snapshot.jobId, registrationId);
        if (result?.ok === false) throw new Error(result.message);
        await pull();
      } catch (failure) { updateNotice(failure.message || '无法重试这个素材库。'); }
      finally { busy = false; render(); }
    }

    async function confirmRemoval(group, merge = false) {
      const selected = group.members.filter(ref => chosen.has(key(ref)));
      if (!selected.length || selected.length >= group.members.length || busy || applying ||
        snapshot?.status === 'running' || !snapshot?.jobId) return;
      const command = { jobId: snapshot.jobId, groupId: group.id, selected: selected.map(ref => ({
        registrationId: ref.registrationId, assetId: ref.assetId, revision: ref.revision,
      })) };
      let plan = null;
      if (merge) {
        if (!keeper) return;
        command.keeper = keeper;
        busy = true;
        updateNotice('');
        updateStatus();
        updateFooter(group);
        try {
          plan = await bridge.previewDuplicateMerge(command);
          if (plan?.ok !== true) throw new Error(plan?.message || '无法预览合并。');
          command.revision = plan.revision;
        } catch (failure) {
          updateNotice(failure.message || '无法预览合并。');
          return;
        } finally {
          busy = false;
          if (dialog.open) render();
        }
        if (!dialog.open || snapshot?.jobId !== command.jobId || currentGroup()?.id !== group.id ||
          !keeper || key(keeper) !== key(command.keeper) || selected.length !== chosen.size ||
          selected.some(ref => !chosen.has(key(ref)))) return;
      }
      confirmTitle.textContent = merge ? '预览合并标签与集合' : '确认移到回收站';
      const message = element('p', 'duplicate-confirm-message', merge
        ? `将资料合并到「${plan.keeperName}」，并将 ${counts.format(selected.length)} 项副本移到回收站。可一次撤销。`
        : `将 ${counts.format(selected.length)} 项素材移到回收站，保留组内其余素材。可以从对应素材库恢复。`);
      const additions = element('div', 'duplicate-merge-preview');
      if (merge) {
        for (const [label, values] of [['追加标签', plan.addedTags], ['加入集合', plan.addedCollections]]) {
          const section = element('div', 'duplicate-merge-section');
          const contents = element('ul', 'duplicate-merge-items');
          contents.append(...values.map(value => element('li', '', value)));
          section.append(element('h3', '', label), values.length ? contents : element('p', '', '无新增'));
          additions.append(section);
        }
      }
      const actionRow = element('div', 'duplicate-confirm-actions');
      const cancel = button('取消', 'outline-button', () => confirmDialog.close());
      const confirm = button(merge ? '合并并移到回收站' : '确认移到回收站', 'primary-button', async () => {
        confirmDialog.close(); applying = true;
        updateNotice(''); render();
        try {
          const result = merge ? await bridge.mergeDuplicateReview(command) : await bridge.trashDuplicateReview(command);
          const moved = Array.isArray(result?.moved) ? result.moved.length : 0;
          const failures = Array.isArray(result?.failed) ? result.failed : [];
          if (moved) notify?.(result.message || `已将 ${counts.format(moved)} 项素材移到回收站。`);
          if (failures.length || result?.ok === false) {
            const detail = failures[0]?.message;
            updateNotice(result?.message || `${counts.format(failures.length)} 项未能移动${detail ? `。${detail}` : '，请检查后重试。'}`);
          }
          for (const ref of result?.moved || []) chosen.delete(key(ref));
          await pull();
        } catch (failure) { updateNotice(failure.message || '操作未完成，请重试。'); }
        finally { applying = false; if (dialog.open) render(); }
      });
      confirm.id = 'duplicate-review-confirm';
      actionRow.append(cancel, confirm);
      confirmBody.replaceChildren(message, ...(merge ? [additions] : []), actionRow);
      if (!confirmDialog.open) confirmDialog.showModal();
      cancel.focus();
    }

    bridge.onDuplicateReviewChanged?.(record => {
      if (!dialog.open) return;
      if (record?.status === 'running') {
        if (snapshot?.jobId === record.jobId) snapshot = { ...snapshot, ...record };
        else snapshot = record;
        updateStatus(record);
      } else void pull();
    });

    return { async open() {
      updateNotice('');
      if (!dialog.open) dialog.showModal();
      render();
      await pull();
    } };
  };
})();
