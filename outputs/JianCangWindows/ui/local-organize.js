'use strict';

(() => {
  function element(tag, className, content) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (content !== undefined) item.textContent = content;
    return item;
  }

  function button(text, className, type = 'button') {
    const item = element('button', className, text);
    item.type = type;
    return item;
  }

  function field(label, control, hint) {
    const item = element('label', 'organize-field');
    item.append(element('span', 'organize-label', label), control);
    if (hint) item.append(element('small', 'organize-hint', hint));
    return item;
  }

  function input(type, value = '') {
    const item = element('input');
    item.type = type;
    item.value = value;
    return item;
  }

  function textarea(value = '') {
    const item = element('textarea');
    item.value = value;
    item.rows = 3;
    return item;
  }

  function select(options, value) {
    const item = element('select');
    for (const [key, text] of options) {
      const option = element('option', '', text);
      option.value = key;
      item.append(option);
    }
    if (value !== undefined) item.value = value;
    return item;
  }

  function checkbox(label, checked = false) {
    const control = input('checkbox');
    control.checked = checked;
    const item = element('label', 'organize-check');
    item.append(control, element('span', '', label));
    return { item, control };
  }

  function tagLines(value) {
    return [...new Set(value.split(/\r?\n/).map(tag => tag.trim()).filter(Boolean))];
  }

  function assetIds(assets) {
    return [...new Set(assets.map(asset => asset.sourceAssetId ?? asset.id))];
  }

  function assetSummary(assets) {
    return assets.length === 1 ? assets[0].name : `${assets.length} 项素材`;
  }

  function acrossSummary(groups) {
    return `将处理 ${groups.reduce((sum, group) => sum + group.ids.length, 0)} 项素材 · ${groups.length} 个素材库`;
  }

  function showAcrossTargets(body, groups, skipped) {
    if (skipped) body.append(element('p', 'organize-hint', `将跳过 ${skipped} 项只读或暂不可写的素材。`));
    const targets = element('ul', 'organize-write-targets');
    targets.setAttribute('aria-label', '将更新的素材库');
    for (const group of groups) targets.append(element('li', '', `${group.name} · ${group.ids.length} 项`));
    body.append(targets);
  }

  function rawId(registrationId, id) {
    if (!id) return null;
    const prefix = `${registrationId}:`;
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
  }

  function collectionTree(registrationId, collections, excludedId = null) {
    const siblings = new Map();
    for (const item of collections) {
      const id = rawId(registrationId, item.id);
      if (!id || id.includes(':')) continue;
      const parentId = rawId(registrationId, item.parentId);
      const parent = parentId?.includes(':') ? null : parentId;
      if (!siblings.has(parent)) siblings.set(parent, []);
      siblings.get(parent).push({ id, name: item.name });
    }
    const output = [];
    const seen = new Set();
    const pending = (siblings.get(null) ?? []).map(item => ({ ...item, level: 0 })).reverse();
    while (pending.length) {
      const item = pending.pop();
      if (item.id === excludedId || seen.has(item.id)) continue;
      seen.add(item.id);
      output.push(item);
      const children = siblings.get(item.id) ?? [];
      for (let index = children.length - 1; index >= 0; index--) {
        pending.push({ ...children[index], level: item.level + 1 });
      }
    }
    return output;
  }

  function collectionChoices(registrationId, collections, selected, title, { lockSelected = false } = {}) {
    const tree = collectionTree(registrationId, collections);
    const group = element('fieldset', 'organize-collections');
    group.append(element('legend', 'organize-label', title));
    const selectedIds = new Set(selected.map(id => rawId(registrationId, id)));
    const choices = [];
    const list = element('div', 'organize-collection-list');
    for (const { id, name, level } of tree) {
      const { item, control } = checkbox(name, selectedIds.has(id));
      control.disabled = lockSelected && control.checked;
      item.style.setProperty('--collection-indent', `${Math.min(9, level) * 12}px`);
      choices.push({ id, control });
      list.append(item);
    }
    if (!choices.length) list.append(element('p', 'organize-hint', '此素材库还没有集合。'));
    group.append(list);
    return { group, value: () => choices.filter(choice => choice.control.checked).map(choice => choice.id) };
  }

  const ratingOptions = [[0, '未评分'], [1, '★'], [2, '★★'], [3, '★★★'], [4, '★★★★'], [5, '★★★★★']];
  const unchanged = ['', '保持原样'];

  function addFieldPair(container, first, second) {
    const row = element('div', 'organize-pair');
    row.append(first, second);
    container.append(row);
  }

  window.createJianCangLocalOrganizer = function createJianCangLocalOrganizer({ mutate, notify = () => {}, onBatchWrite = () => {}, onImmediateWrite = () => {} }) {
    let active = null;
    let immediatePending = false;

    async function request(registrationId, command) {
      const result = await mutate(registrationId, command);
      if (!result?.ok) throw new Error(result?.message || '操作未完成，请重试。');
      return result;
    }

    function open({ title, subtitle, submitText, mode, danger = false, build, submit }) {
      if (active?.open) return;
      const dialog = element('dialog', 'organize-dialog');
      dialog.dataset.organize = mode;
      dialog.setAttribute('aria-labelledby', 'local-organize-title');
      const form = element('form', 'organize-form');
      const header = element('header', 'dialog-head organize-head');
      const heading = element('div');
      const headingLabel = element('h2', '', title);
      headingLabel.id = 'local-organize-title';
      heading.append(headingLabel);
      if (subtitle) {
        const description = element('p', 'organize-summary', subtitle);
        description.id = 'local-organize-summary';
        description.title = subtitle;
        heading.append(description);
        dialog.setAttribute('aria-describedby', description.id);
      }
      const close = button('×', 'icon-button organize-close');
      close.setAttribute('aria-label', '关闭');
      header.append(heading, close);
      const body = element('div', 'organize-body');
      const footer = element('footer', 'organize-footer');
      const error = element('p', 'organize-error');
      error.setAttribute('role', 'alert');
      error.hidden = true;
      const actions = element('div', 'organize-actions');
      const cancel = button('取消', 'outline-button');
      const primary = button(submitText, danger ? 'primary-button organize-danger' : 'primary-button', 'submit');
      actions.append(cancel, primary);
      footer.append(error, actions);
      form.append(header, body, footer);
      dialog.append(form);

      let working = false;
      let nextFocus = null;
      const status = {
        close: () => dialog.close(),
        label: value => { primary.textContent = value; },
        clear: () => { error.hidden = true; },
        focus: element => { nextFocus = element; },
        focusSubmit: () => { nextFocus = primary; },
      };
      const content = build(body, status);
      const detail = body.querySelector('.organize-confirm-description');
      if (detail) {
        detail.id = 'local-organize-description';
        dialog.setAttribute('aria-describedby', subtitle ? `local-organize-summary ${detail.id}` : detail.id);
      }
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (working) return;
        const previousFocus = dialog.contains(document.activeElement) ? document.activeElement : primary;
        working = body.inert = primary.disabled = cancel.disabled = close.disabled = true;
        form.setAttribute('aria-busy', 'true');
        status.clear();
        try {
          await submit(content, status);
        } catch (problem) {
          error.textContent = problem?.message || '操作未完成，请重试。';
          error.hidden = false;
        } finally {
          working = body.inert = primary.disabled = cancel.disabled = close.disabled = false;
          form.removeAttribute('aria-busy');
          if (dialog.open) (nextFocus || previousFocus).focus();
          nextFocus = null;
        }
      });
      close.addEventListener('click', status.close);
      cancel.addEventListener('click', status.close);
      dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); });
      dialog.addEventListener('close', () => {
        if (active === dialog) active = null;
        dialog.remove();
      }, { once: true });
      dialog.addEventListener('keydown', event => event.stopPropagation());
      document.body.append(dialog);
      active = dialog;
      dialog.showModal();
      (body.querySelector('input:not([type=checkbox]), select, textarea') || cancel).focus();
    }

    function editAssets(registrationId, assets, collections = []) {
      if (!assets.length) return;
      const single = assets.length === 1 ? assets[0] : null;
      open({
        title: single ? '编辑素材信息' : '批量编辑素材',
        subtitle: assetSummary(assets), submitText: '保存修改', mode: 'edit',
        build(body) {
          const tags = textarea(single?.tags?.join('\n'));
          const rating = select(single ? ratingOptions : [unchanged, ...ratingOptions], single ? single.rating ?? 0 : '');
          const favorite = select(single ?
            [['yes', '已收藏'], ['no', '未收藏']] :
            [unchanged, ['yes', '加入收藏'], ['no', '取消收藏']], single ? (single.favorite ? 'yes' : 'no') : '');
          addFieldPair(body, field('评分', rating), field('收藏', favorite));
          const membership = collectionChoices(registrationId, collections, single?.collectionIds ?? [],
            single ? '所属集合' : '加入集合');
          if (single) {
            const note = textarea(single.note ?? '');
            note.maxLength = 12288;
            const sourceURL = input('url', single.sourceURL ?? '');
            sourceURL.maxLength = 16384;
            sourceURL.placeholder = 'https://';
            body.append(field('标签', tags, '每行一个标签。'), field('备注', note), field('来源网址', sourceURL), membership.group);
            return () => {
              const patch = {};
              const finalTags = tagLines(tags.value);
              const finalMembership = membership.value();
              const currentMembership = (single.collectionIds ?? []).map(id => rawId(registrationId, id));
              if (!sameMembers(finalTags, single.tags ?? [])) patch.tags = finalTags;
              if (!sameMembers(finalMembership, currentMembership)) patch.collectionIds = finalMembership;
              if (Number(rating.value) !== Number(single.rating ?? 0)) patch.rating = Number(rating.value);
              if ((favorite.value === 'yes') !== !!single.favorite) patch.favorite = favorite.value === 'yes';
              if (note.value !== (single.note ?? '')) patch.note = note.value;
              if (sourceURL.value.trim() !== (single.sourceURL ?? '')) patch.sourceURL = sourceURL.value.trim() || null;
              return patch;
            };
          }
          const removeTags = textarea();
          const changeNote = checkbox('更新备注');
          const changeURL = checkbox('更新来源网址');
          const note = textarea();
          note.maxLength = 12288;
          const sourceURL = input('url');
          sourceURL.maxLength = 16384;
          sourceURL.placeholder = 'https://';
          const noteField = field('备注', note, '留空会清除备注。');
          const sourceField = field('来源网址', sourceURL, '留空会清除来源网址。');
          revealOnCheck(changeNote.control, noteField, note);
          revealOnCheck(changeURL.control, sourceField, sourceURL);
          body.append(element('p', 'organize-hint', '留空的标签和设置为保持原样的字段会保留原值。'));
          addFieldPair(body, field('添加标签', tags, '每行一个标签。'), field('移除标签', removeTags, '每行一个标签。'));
          body.append(membership.group, changeNote.item, noteField, changeURL.item, sourceField);
          return () => {
            const patch = {};
            const additions = tagLines(tags.value);
            const removals = tagLines(removeTags.value);
            const addedCollections = membership.value();
            if (additions.length) patch.addTags = additions;
            if (removals.length) patch.removeTags = removals;
            if (addedCollections.length) patch.addCollectionIds = addedCollections;
            if (rating.value !== '') patch.rating = Number(rating.value);
            if (favorite.value !== '') patch.favorite = favorite.value === 'yes';
            if (changeNote.control.checked) patch.note = note.value;
            if (changeURL.control.checked) patch.sourceURL = sourceURL.value.trim() || null;
            return patch;
          };
        },
        async submit(read, status) {
          const patch = read();
          if (!Object.keys(patch).length) {
            status.close();
            return;
          }
          const result = await request(registrationId, { action: 'edit', ids: assetIds(assets), ...patch });
          status.close();
          notify(result.message || '素材信息已保存。');
        },
      });
    }

    function renameAssets(registrationId, assets) {
      if (!assets.length) return;
      const batch = assets.length > 1;
      async function planFor(entries) {
        const plan = await request(registrationId, { action: 'planRename', entries });
        if (!Array.isArray(plan.entries) || !plan.entries.length || !plan.revision) throw new Error('无法生成改名预览，请重试。');
        return { rows: plan.entries, apply: { entries, revision: plan.revision } };
      }
      open({
        title: assets.length === 1 ? '重命名素材' : '批量重命名', subtitle: assetSummary(assets),
        submitText: batch ? '重命名' : '预览改名', mode: 'rename',
        build(body, status) { return renameFields(body, assets, status, planFor); },
        async submit(rename, status) {
          if (!batch && !rename.plan) {
            await rename.review();
            status.label('确认改名');
            return;
          }
          const { entries, revision } = batch ? await rename.batchPlan() : rename.plan;
          try {
            const result = await request(registrationId, { action: 'rename', entries, revision });
            status.close();
            notify(result.message || `已重命名 ${entries.length} 项素材。`);
          } catch (problem) {
            rename.reset();
            throw problem;
          }
        },
      });
    }

    function collection(registrationId, collections = [], { collection: current, parentId, operation } = {}) {
      const id = rawId(registrationId, current?.id);
      const location = rawId(registrationId, current?.parentId ?? parentId) || null;
      const title = { create: '新增文件夹', 'create-child': '新增子文件夹', rename: '重命名文件夹',
        move: '移动文件夹' }[operation] || (current ? '编辑集合' : '新建集合');
      open({
        title, subtitle: operation && current?.name,
        submitText: current ? '保存' : '创建集合', mode: 'collection',
        build(body) {
          const fields = {};
          if (!current || !operation || operation === 'rename') {
            const name = input('text', current?.name ?? '');
            name.required = true;
            name.maxLength = 256;
            fields.name = name;
            body.append(field('集合名称', name));
          }
          if (!operation || operation === 'move') {
            const tree = collectionTree(registrationId, collections, id);
            const parents = [['', '顶层集合'], ...tree.map(item => [item.id,
              `${'　'.repeat(Math.min(9, item.level))}${item.name}`])];
            const parent = select(parents, location || '');
            fields.parent = parent;
            body.append(field('上级集合', parent));
          }
          return fields;
        },
        async submit({ name, parent }, status) {
          if (name && !name.value.trim()) throw new Error('请输入集合名称。');
          const command = {
            action: current ? 'editCollection' : 'createCollection', ...(current ? { id } : {}),
          };
          if (name) command.name = name.value.trim();
          if (parent || !current) command.parentId = parent ? (parent.value || null) : location;
          const result = await request(registrationId, command);
          status.close();
          notify(result.message || (current ? '集合已保存。' : '集合已创建。'));
        },
      });
    }

    function confirm(registrationId, { title, description, subtitle, label, command, message, danger = true }) {
      const moveToTrash = command.action === 'trash';
      open({
        title, subtitle, submitText: label, mode: 'confirm', danger,
        build(body) { body.append(element('p', 'organize-confirm-description', description)); },
        async submit(_content, status) {
          if (moveToTrash) status.close();
          try {
            const result = await request(registrationId, command);
            if (!moveToTrash) status.close();
            notify(result.message || message);
          } catch (error) {
            if (!moveToTrash) throw error;
            notify(error?.message || '无法移到回收站，请重试。');
          }
        },
      });
    }

    function trash(registrationId, assets) {
      if (!assets.length) return;
      confirm(registrationId, {
        title: '移到回收站？', subtitle: assetSummary(assets),
        description: '之后可以从回收站恢复原件和整理信息。', label: '移到回收站',
        command: { action: 'trash', ids: assetIds(assets) }, message: `已将 ${assets.length} 项素材移到回收站。`,
      });
    }

    function removeFromCollection(registrationId, assets, collection) {
      if (!assets.length || !collection) return;
      confirm(registrationId, {
        title: '从当前集合移出？', subtitle: assetSummary(assets),
        description: `将所选素材从「${collection.name}」移出。原件和其他集合归属会保留。`,
        label: '移出集合', danger: false,
        command: { action: 'edit', ids: assetIds(assets), removeCollectionIds: [rawId(registrationId, collection.id)] },
        message: `已从「${collection.name}」移出所选素材。`,
      });
    }

    function addToCollections(asset, collections) {
      const registrationId = asset.sourceLibraryId;
      const membership = new Set(asset.collectionIds.map(id => rawId(registrationId, id)));
      open({
        title: '加入集合', subtitle: assetSummary([asset]), submitText: '加入所选集合', mode: 'collections',
        build(body) {
          const choices = collectionChoices(registrationId, collections, asset.collectionIds, '选择集合', { lockSelected: true });
          body.append(choices.group);
          return choices.value;
        },
        async submit(read, status) {
          const addCollectionIds = read().filter(id => !membership.has(id));
          if (!addCollectionIds.length) throw new Error('请选择要加入的集合。');
          const result = await request(registrationId, { action: 'edit', ids: assetIds([asset]), addCollectionIds });
          status.close();
          notify(result.message || `已加入 ${addCollectionIds.length} 个集合。`);
        },
      });
    }

    function editAcrossLibraries(groups, { skipped, mode, favorite = false, rating: initialRating }) {
      if (!groups.length) return;
      const label = mode === 'favorite' ? favorite ? '加入收藏' : '取消收藏' : mode === 'rating' ? '设置评分' : '批量整理';
      const writer = acrossWriter();
      let jobs;
      open({
        title: label,
        subtitle: acrossSummary(groups),
        submitText: mode === 'favorite' ? label : '保存修改',
        mode: 'across',
        build(body) {
          showAcrossTargets(body, groups, skipped);
          const fields = element('fieldset', 'organize-across-fields');
          body.append(fields);
          if (mode === 'favorite') return { fields, read: () => ({ favorite }) };
          const rating = select(mode === 'rating' ? [['', '请选择评分'], ...ratingOptions] : [unchanged, ...ratingOptions], initialRating ?? '');
          rating.required = mode === 'rating';
          const readRating = () => rating.value === '' ? {} : { rating: Number(rating.value) };
          if (mode === 'rating') {
            fields.append(field('评分', rating));
            return { fields, read: readRating };
          }
          const favorites = groups.some(group => group.kind !== 'eagle');
          const keep = favorites ? select([unchanged, ['yes', '加入收藏'], ['no', '取消收藏']], '') : null;
          const addTags = textarea();
          const removeTags = textarea();
          if (keep) addFieldPair(fields, field('评分', rating), field('收藏', keep,
            groups.some(group => group.kind === 'eagle') ? '收藏只应用到见藏库。' : undefined));
          else fields.append(field('评分', rating));
          addFieldPair(fields, field('添加标签', addTags, '每行一个标签。'), field('移除标签', removeTags, '每行一个标签。'));
          const changeNote = checkbox('更新备注');
          const changeURL = checkbox('更新来源网址');
          const note = textarea();
          note.maxLength = 12288;
          const sourceURL = input('url');
          sourceURL.maxLength = groups.some(group => group.kind === 'eagle') ? 4096 : 16384;
          sourceURL.placeholder = 'https://';
          const noteField = field('备注', note, '留空会清除备注。');
          const sourceField = field('来源网址', sourceURL, '留空会清除来源网址。');
          revealOnCheck(changeNote.control, noteField, note);
          revealOnCheck(changeURL.control, sourceField, sourceURL);
          fields.append(changeNote.item, noteField, changeURL.item, sourceField);
          const memberships = new Map();
          for (const group of groups) {
            if (!group.collections?.length) continue;
            const choices = collectionChoices(group.id, group.collections, [], groups.length > 1 ? `加入「${group.name}」的集合` : '加入集合');
            memberships.set(group.id, choices.value);
            fields.append(choices.group);
          }
          return { fields, read(group) {
            const additions = tagLines(addTags.value);
            const removals = tagLines(removeTags.value);
            const chosen = memberships.get(group.id)?.() ?? [];
            return { ...readRating(), ...(keep?.value && group.kind !== 'eagle' && { favorite: keep.value === 'yes' }),
              ...(additions.length && { addTags: additions }), ...(removals.length && { removeTags: removals }),
              ...(changeNote.control.checked && { note: note.value }),
              ...(changeURL.control.checked && { sourceURL: sourceURL.value.trim() || null }),
              ...(chosen.length && { addCollectionIds: chosen }) };
          } };
        },
        async submit({ fields, read }, status) {
          if (!jobs) {
            jobs = groups.flatMap(group => {
              const patch = read(group);
              if (!Object.keys(patch).length) return [];
              return [{ group, command: { action: 'edit', ids: group.ids, ...patch,
                ...(group.expected && { expected: group.expected }) } }];
            });
            if (!jobs.length) {
              status.close();
              return;
            }
          }
          fields.disabled = true;
          await writer.write(jobs, status, remaining => {
            jobs = remaining;
            status.label(`重试 ${jobs.reduce((total, job) => total + job.command.ids.length, 0)} 项`);
          });
        },
      });
    }

    function acrossWriter(skipped = 0) {
      let processed = 0;
      let pendingPurge = 0;
      const pending = new Set();
      const summary = () => [`已处理 ${processed} 项。`,
        skipped ? `已跳过 ${skipped} 项只读或暂不可写的素材。` : '',
        pending.size ? `${pending.size} 个同步库有待提交记录。` : '',
        pendingPurge ? `${pendingPurge} 份原件等待释放磁盘空间。` : '',
      ].filter(Boolean).join(' ');
      return {
        summary,
        async write(jobs, status, onIncomplete) {
          const failures = [];
          onBatchWrite(true);
          try {
            for (const job of jobs) {
              const { group, command } = job;
              const count = command.entries?.length ?? command.ids.length;
              try {
                const result = await request(group.id, command);
                processed += result.count ?? count;
                if (result.pending > 0) pending.add(group.id);
                pendingPurge += result.pendingPurge ?? 0;
                if (result.failed?.length) {
                  const ids = new Set(result.failed.map(item => item.id));
                  const remaining = command.entries ? { ...command, entries: command.entries.filter(item => ids.has(item.id)) }
                    : { ...command, ids: command.ids.filter(id => ids.has(id)) };
                  failures.push({ job: { group, command: remaining }, message: result.failed
                    .map(item => `${group.name} · ${item.name}：${item.message}`).join('\n') });
                }
              } catch (error) {
                failures.push({ job, message: `${group.name}（${count} 项）操作失败。${error?.message || '请重试。'}` });
              }
            }
          } finally { onBatchWrite(false); }
          if (failures.length) {
            const remaining = failures.map(item => item.job);
            onIncomplete?.(remaining);
            status?.focusSubmit();
            throw new Error([`${summary()} ${failures.length} 个库未完成。`, ...failures.map(item => item.message)].join('\n'));
          }
          status?.close();
          notify(summary());
        },
      };
    }

    async function restoreAll(groups, skipped) {
      const jobs = groups.map(group => ({ group, command: { action: 'restore', ids: group.ids } }));
      try { await acrossWriter(skipped).write(jobs); }
      catch (error) { notify(error.message); }
    }

    function emptyTrash(groups, skipped) {
      const writer = acrossWriter(skipped);
      let jobs = groups.map(group => ({ group, command: { action: 'purgeTrash', ids: group.ids,
        catalogRevision: group.catalogRevision, revision: group.revision } }));
      open({
        title: '清空回收站？', subtitle: acrossSummary(groups),
        submitText: '确认清空回收站', mode: 'across', danger: true,
        build(body) {
          body.append(element('p', 'organize-confirm-description', '所列素材将永久删除，包括被搜索或筛选隐藏的素材。此操作无法撤销。'));
          if (groups.some(group => group.kind === 'local')) {
            body.append(element('p', 'organize-hint', '本地库中的原件和历史版本也会删除。'));
          }
          if (groups.some(group => group.kind === 'jiancang')) {
            body.append(element('p', 'organize-hint', '同步库会将删除同步到其他设备，云端文件由同步服务管理。'));
          }
          showAcrossTargets(body, groups, skipped);
        },
        async submit(_content, status) {
          await writer.write(jobs, status, remaining => {
            jobs = remaining;
            status.label(`重试 ${jobs.reduce((total, job) => total + job.command.ids.length, 0)} 项`);
          });
        },
      });
    }

    function changeTrashAcrossLibraries(groups, action, skipped) {
      const restoring = action === 'restore';
      const writer = acrossWriter();
      let jobs = groups.map(group => ({ group, command: { action, ids: group.ids } }));
      open({
        title: restoring ? '从回收站恢复？' : '移到回收站？', subtitle: acrossSummary(groups),
        submitText: restoring ? '恢复素材' : '移到回收站', mode: 'across', danger: !restoring,
        build(body) {
          showAcrossTargets(body, groups, skipped);
          if (!restoring) body.append(element('p', 'organize-confirm-description', '之后可以从回收站恢复原件和整理信息。'));
        },
        async submit(_content, status) {
          if (!restoring) {
            status.close();
            const outcomes = await Promise.allSettled(jobs.map(({ group, command }) => request(group.id, command)));
            let moved = 0;
            let queued = 0;
            const failures = [];
            outcomes.forEach((outcome, index) => {
              const { group, command } = jobs[index];
              if (outcome.status === 'rejected') {
                failures.push(`「${group.name}」${outcome.reason?.message || '操作失败，请重试。'}`);
                return;
              }
              const { count, pending, failed } = outcome.value;
              if (pending > 0) queued += count ?? command.ids.length;
              else moved += count ?? command.ids.length;
              if (failed?.length) failures.push(`「${group.name}」有 ${failed.length} 项未移到回收站。`);
            });
            notify([moved && `已将 ${moved} 项素材移到回收站。`,
              queued && `${queued} 项素材等待同步写入。`, ...failures].filter(Boolean).join(' ') || '已更新回收站。');
            return;
          }
          await writer.write(jobs, status, remaining => {
            jobs = remaining;
            status.label(`重试 ${jobs.length} 个库`);
          });
        },
      });
    }

    function renameAcrossLibraries(groups, assets, skipped) {
      const batch = assets.length > 1;
      const writer = acrossWriter();
      let remaining;
      async function planFor(requestedEntries, current = () => true) {
        let jobs = remaining;
        if (!jobs) {
          const requested = new Map();
          for (const { id, name, libraryId } of requestedEntries) {
            if (!requested.has(libraryId)) requested.set(libraryId, []);
            requested.get(libraryId).push({ id, name });
          }
          jobs = groups.filter(group => requested.has(group.id)).map(group => ({ group,
            command: { action: 'rename', entries: requested.get(group.id) } }));
        }
        const rows = [];
        const apply = [];
        for (const { group, command: { entries } } of jobs) {
          if (!current()) return null;
          try {
            const plan = await request(group.id, { action: 'planRename', entries });
            if (!Array.isArray(plan.entries) || !plan.entries.length || !plan.revision) throw new Error('未读取到改名预览。');
            apply.push({ group, command: { action: 'rename', entries, revision: plan.revision } });
            rows.push(...plan.entries.map(entry => ({ ...entry, libraryId: group.id, libraryName: group.name })));
          } catch (error) {
            throw new Error(`${remaining ? writer.summary() + ' ' : ''}无法预览「${group.name}」的改名。${error?.message || '请重试。'}`);
          }
        }
        return { rows, apply };
      }
      open({
        title: '批量重命名', subtitle: acrossSummary(groups), submitText: batch ? '重命名' : '预览改名', mode: 'across-rename',
        build(body, status) {
          showAcrossTargets(body, groups, skipped);
          return renameFields(body, assets, status, planFor, groups);
        },
        async submit(rename, status) {
          if (batch || rename.plan) {
            const plan = batch ? await rename.batchPlan() : rename.plan;
            await writer.write(plan, status, failures => {
              remaining = failures;
              rename.reset({ keepRuleLocked: true });
            });
            return;
          }
          await rename.review({ remaining: Boolean(remaining) });
          status.label('确认改名');
        },
      });
    }

    function purgeTrash(registrationId, assets, catalog, all = false) {
      if (!assets.length || catalog?.library.kind !== 'local' || assets.some(asset => !asset.trashed)) return;
      confirm(registrationId, {
        title: all ? '清空这个本地库的回收站？' : '永久删除素材？',
        subtitle: all ? `${catalog.library.directoryName} · ${assets.length} 项素材` : assetSummary(assets),
        description: all
          ? '此库回收站中的全部素材及其原件和历史版本都会删除，包括当前筛选隐藏的项目。此操作无法撤销。'
          : '所选素材的原件和历史版本会一起删除。此操作无法撤销。',
        label: all ? '确认清空回收站' : '确认永久删除',
        command: { action: 'purgeTrash', revision: catalog.library.revision, catalogRevision: catalog.revision,
          ...(all ? { all: true } : { ids: assetIds(assets) }) },
        message: `已永久删除 ${assets.length} 项素材。`,
      });
    }

    async function retryPurge(registrationId, catalogRevision) {
      if (immediatePending) return;
      await immediate(registrationId, { action: 'retryPurge', catalogRevision }, '回收站原件已清理。');
    }

    function deleteCollection(registrationId, item) {
      confirm(registrationId, {
        title: '删除文件夹？', subtitle: item.name,
        description: '这个文件夹和子文件夹会一起删除。素材会保留在素材库中。', label: '删除文件夹',
        command: { action: 'deleteCollection', id: rawId(registrationId, item.id) }, message: '集合已删除。',
      });
    }

    async function restore(registrationId, assets) {
      if (!assets.length || immediatePending) return;
      await immediate(registrationId, { action: 'restore', ids: assetIds(assets) }, `已恢复 ${assets.length} 项素材。`);
    }

    async function toggleFavorite(assets) {
      if (!assets.length || immediatePending) return;
      const favorite = !assets.every(asset => asset.favorite);
      await immediate(assets[0].sourceLibraryId, { action: 'edit', ids: assetIds(assets), favorite },
        favorite ? '已加入收藏。' : '已取消收藏。');
    }

    function setRating(asset, rating) {
      return setRatings([asset], rating);
    }

    function setRatings(assets, rating) {
      if (!assets.length || immediatePending || assets.every(asset => (asset.rating ?? 0) === rating)) return;
      return immediate(assets[0].sourceLibraryId, { action: 'edit', ids: assetIds(assets), rating },
        rating ? `已设为 ${rating} 星。` : '已清除评分。');
    }

    async function setCollectionColor(registrationId, item, color) {
      if (immediatePending || item.color?.toUpperCase() === color) return;
      await immediate(registrationId, { action: 'editCollection', id: rawId(registrationId, item.id), color }, '已更新文件夹颜色。');
    }

    async function undo(registrationId) {
      if (immediatePending) return;
      await immediate(registrationId, { action: 'undo' }, '已撤销上一次整理操作。');
    }

    async function redo(registrationId, { revision, redoRemoves }) {
      if (immediatePending) return;
      const command = { action: 'redo', revision };
      const message = '已重做刚撤销的整理操作。';
      if (redoRemoves) {
        confirm(registrationId, {
          title: '重做删除？', description: '此前撤销的删除会再次执行。',
          label: '重做删除', command, message,
        });
        return;
      }
      await immediate(registrationId, command, message);
    }

    async function immediate(registrationId, command, message) {
      immediatePending = true;
      onImmediateWrite();
      try {
        const result = await request(registrationId, command);
        notify(result.message || message);
        return result;
      } catch (problem) { notify(problem.message); }
      finally {
        immediatePending = false;
        onImmediateWrite();
      }
    }

    return { editAssets, renameAssets, collection, collectionChoices, deleteCollection, trash, purgeTrash, retryPurge, restore, restoreAll, emptyTrash, undo, redo,
      editAcrossLibraries, renameAcrossLibraries, changeTrashAcrossLibraries, addToCollections, removeFromCollection,
      setRating, setRatings, toggleFavorite, setCollectionColor,
      get immediatePending() { return immediatePending; } };
  };

  function sameMembers(a, b) {
    if (a.length !== b.length) return false;
    const origin = new Set(b);
    return a.every(member => origin.has(member));
  }

  function revealOnCheck(control, container, field) {
    const sync = () => { container.hidden = field.disabled = !control.checked; };
    control.addEventListener('change', sync);
    sync();
  }

  const renamePresetsKey = 'jiancang-rename-presets-v1';

  function validRenameRule(rule) {
    switch (rule?.mode) {
      case 'affixes': return typeof rule.prefix === 'string' && typeof rule.suffix === 'string' &&
        Boolean(rule.prefix || rule.suffix);
      case 'sequence': return typeof rule.base === 'string' && Boolean(rule.base.trim()) &&
        Number.isInteger(rule.start) && rule.start >= 1 && rule.start <= 999999999;
      case 'replace': return typeof rule.search === 'string' && Boolean(rule.search) &&
        typeof rule.replacement === 'string';
      default: return false;
    }
  }

  function renamePresetControls(readRule, applyRule) {
    let presets = [];
    try {
      const stored = JSON.parse(localStorage.getItem(renamePresetsKey));
      if (Array.isArray(stored)) presets = stored.filter(preset =>
        typeof preset?.name === 'string' && preset.name.trim() && validRenameRule(preset.rule));
    } catch { /* A missing or unreadable profile starts with no saved presets. */ }

    const panel = element('section', 'organize-rename-presets');
    const choices = select([]);
    const actions = element('div', 'organize-rename-preset-actions');
    const add = button('保存为新预设', 'outline-button');
    const update = button('更新预设', 'outline-button');
    const remove = button('删除预设', 'outline-button');
    actions.append(add, update, remove);

    const editor = element('div', 'organize-rename-preset-editor');
    const name = input('text');
    name.maxLength = 64;
    const save = button('保存', 'outline-button');
    const cancel = button('取消', 'outline-button');
    const editorActions = element('div', 'organize-rename-preset-actions');
    editorActions.append(save, cancel);
    editor.append(field('预设名称', name), editorActions);
    editor.hidden = true;

    const message = element('p', 'organize-hint');
    message.setAttribute('role', 'status');
    message.hidden = true;
    panel.append(field('常用改名规则', choices), actions, editor, message);

    function showMessage(text = '') {
      message.hidden = !text;
      message.textContent = text;
    }
    function syncActions() {
      update.hidden = remove.hidden = !choices.value;
      actions.hidden = !editor.hidden;
    }
    function renderChoices(selected = '') {
      const refreshed = select([['', presets.length ? '选择预设' : '暂无预设'],
        ...presets.map(preset => [preset.name, preset.name])], selected);
      choices.replaceChildren(...refreshed.options);
      choices.value = selected;
      syncActions();
    }
    function persist(next, selected, text) {
      try { localStorage.setItem(renamePresetsKey, JSON.stringify(next)); }
      catch { showMessage('无法保存改名预设，请检查应用数据目录。'); return false; }
      presets = next;
      renderChoices(selected);
      showMessage(text);
      return true;
    }
    function closeEditor() {
      editor.hidden = true;
      name.value = '';
      syncActions();
    }
    function currentRule() {
      const rule = readRule();
      if (validRenameRule(rule)) return rule;
      showMessage('请先填写有效的命名规则。');
      return null;
    }
    choices.addEventListener('change', () => {
      const preset = presets.find(item => item.name === choices.value);
      closeEditor();
      showMessage();
      if (preset) applyRule(preset.rule);
    });
    add.addEventListener('click', () => {
      if (!currentRule()) return;
      showMessage();
      editor.hidden = false;
      syncActions();
      name.focus();
    });
    cancel.addEventListener('click', () => {
      closeEditor();
      showMessage();
      add.focus();
    });
    save.addEventListener('click', () => {
      const rule = currentRule();
      if (!rule) return;
      const title = name.value.trim().normalize();
      if (!title || presets.some(preset => preset.name.toLowerCase() === title.toLowerCase())) {
        showMessage(title ? '已存在同名预设，请换一个名称。' : '请输入预设名称。');
        name.focus();
        return;
      }
      if (persist([...presets, { name: title, rule }], title, '已保存改名预设。')) {
        closeEditor();
        choices.focus();
      }
    });
    name.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        save.click();
      }
    });
    update.addEventListener('click', () => {
      const rule = currentRule();
      if (!rule) return;
      const selected = choices.value;
      persist(presets.map(preset => preset.name === selected ? { ...preset, rule } : preset), selected, '已更新改名预设。');
    });
    remove.addEventListener('click', () => {
      if (persist(presets.filter(preset => preset.name !== choices.value), '', '已删除改名预设。')) choices.focus();
    });
    renderChoices();
    return panel;
  }

  function renameFields(body, assets, status, planFor, groups) {
    const live = assets.length > 1;
    const dialog = body.closest('dialog');
    const controls = element('div', 'organize-rename-fields');
    const rules = element('div', 'organize-rename-fields');
    controls.append(rules);
    const preview = element('section', 'organize-rename-preview');
    preview.hidden = true;
    let readRule, nameForRule;
    if (assets.length === 1) {
      const value = input('text', assets[0].name);
      value.required = true;
      value.maxLength = 512;
      rules.append(field('新名称', value, '原件的格式后缀会保留。'));
      nameForRule = () => {
        const name = value.value.trim();
        return () => name;
      };
    } else {
      const mode = select([['affixes', '加前缀或后缀'], ['sequence', '按顺序编号'], ['replace', '查找并替换']]);
      rules.append(field('命名方式', mode));
      const prefix = input('text');
      const suffix = input('text');
      const affixes = element('div', 'organize-pair');
      affixes.append(field('前缀', prefix), field('后缀', suffix));
      const base = input('text');
      const start = input('number', '1');
      start.min = '1';
      start.max = '999999999';
      start.step = '1';
      const sequence = element('div', 'organize-pair');
      sequence.append(field('统一名称', base), field('起始编号', start));
      const search = input('text');
      const replacement = input('text');
      const replace = element('div', 'organize-pair');
      replace.append(field('查找文字', search), field('替换为', replacement, '留空可移除匹配的文字。'));
      const groups = { affixes, sequence, replace };
      const sync = () => {
        for (const [key, group] of Object.entries(groups)) {
          group.hidden = key !== mode.value;
          for (const control of group.querySelectorAll('input')) control.disabled = group.hidden;
        }
        base.required = !sequence.hidden;
        start.required = !sequence.hidden;
        search.required = !replace.hidden;
      };
      mode.addEventListener('change', sync);
      sync();
      rules.append(affixes, sequence, replace);
      const fields = { affixes: { prefix, suffix }, sequence: { base, start }, replace: { search, replacement } };
      readRule = () => {
        if (mode.value === 'sequence') return { mode: mode.value, base: base.value.trim(), start: start.valueAsNumber };
        if (mode.value === 'replace') return { mode: mode.value, search: search.value, replacement: replacement.value };
        return { mode: mode.value, prefix: prefix.value, suffix: suffix.value };
      };
      controls.append(renamePresetControls(readRule, rule => {
        mode.value = rule.mode;
        for (const [key, control] of Object.entries(fields[rule.mode])) control.value = rule[key];
        mode.dispatchEvent(new Event('change', { bubbles: true }));
      }));
      nameForRule = rule => {
        if (rule.mode === 'replace') return asset => asset.oldName.replaceAll(rule.search, rule.replacement).trim();
        if (rule.mode === 'sequence') {
          const digits = Math.max(2, String(rule.start + assets.length - 1).length);
          return (_asset, index) => `${rule.base} ${String(rule.start + index).padStart(digits, '0')}`.trim();
        }
        return asset => `${rule.prefix}${asset.oldName}${rule.suffix}`.trim();
      };
    }
    const libraryNames = new Map(groups?.map(group => [group.id, group.name]));
    const original = assets.map(asset => ({ id: asset.sourceAssetId ?? asset.id, oldName: asset.name, name: asset.name,
      libraryId: asset.sourceLibraryId, libraryName: libraryNames.get(asset.sourceLibraryId), extension: asset.extension }));
    const key = entry => groups ? `${entry.libraryId}:${entry.id}` : entry.id;
    const extensions = new Map(original.map(entry => [key(entry), entry.extension]));
    const tools = element('div', 'organize-rename-preview-head');
    const hint = element('p', 'organize-hint');
    hint.setAttribute('role', 'status');
    const back = button('修改规则', 'outline-button organize-edit-rule');
    tools.append(hint, back);
    const list = element('div', 'organize-rename-scroll');
    list.tabIndex = 0;
    list.setAttribute('aria-label', '改名前后列表');
    const table = element('table', 'organize-rename-table');
    table.setAttribute('aria-label', '改名前后对照');
    const header = element('thead');
    const headerRow = element('tr');
    for (const title of groups ? ['素材库', '原名称', '最终名称'] : ['原名称', '最终名称']) {
      const heading = element('th', '', title);
      heading.scope = 'col';
      headerRow.append(heading);
    }
    const finalHeading = headerRow.lastElementChild;
    header.append(headerRow);
    const rows = element('tbody');
    table.append(header, rows);
    list.append(table);
    const pagination = element('div', 'organize-rename-pages');
    const previous = button('上一页', 'outline-button');
    const pageLabel = element('span', 'organize-hint');
    const next = button('下一页', 'outline-button');
    pagination.append(previous, pageLabel, next);
    preview.append(tools, list, pagination);
    body.append(controls, preview);

    const pageSize = 80;
    let displayed = original;
    let finalNames = new Map();
    let draftName;
    let unavailableNames = false;
    let page = 0;
    let timer;
    let task;
    let running = Promise.resolve();
    let ruleLocked = false;
    function renderPage(resetScroll = true) {
      const start = page * pageSize;
      const end = Math.min(start + pageSize, displayed.length);
      while (rows.rows.length > end - start) rows.deleteRow(-1);
      for (const [index, item] of displayed.slice(start, end).entries()) {
        const entry = finalNames.get(key(item)) ?? item;
        const extension = extensions.get(key(entry));
        const ending = extension ? `.${extension}` : '';
        const name = draftName ? draftName(item, start + index) : entry.name;
        const row = rows.rows[index] ?? rows.insertRow();
        const names = [`${entry.oldName}${ending}`, unavailableNames || !name ? '—' : `${name}${ending}`];
        if (groups) names.unshift(entry.libraryName);
        for (const [column, text] of names.entries()) {
          const cell = row.cells[column] ?? row.insertCell();
          if (cell.textContent !== text) cell.textContent = text;
        }
      }
      if (resetScroll) list.scrollTop = 0;
      pagination.hidden = displayed.length <= pageSize;
      previous.disabled = start === 0;
      next.disabled = end === displayed.length;
      pageLabel.textContent = `${start + 1}–${end} / ${displayed.length}`;
    }
    function render(entries, message, { editing = true, draft, unavailable = false, allowEdit = false } = {}) {
      displayed = editing ? original : entries;
      finalNames = new Map(editing ? entries.map(entry => [key(entry), entry]) : []);
      draftName = draft;
      unavailableNames = unavailable;
      finalHeading.textContent = draft ? '待核对名称' : '最终名称';
      page = Math.min(page, Math.max(0, Math.ceil(displayed.length / pageSize) - 1));
      hint.textContent = message;
      back.hidden = !allowEdit;
      preview.hidden = false;
      renderPage(!live);
    }
    function proposedEntries(nameAt) {
      return original.flatMap((entry, index) => {
        const name = nameAt(entry, index);
        if (!name) throw new Error('新名称不能为空。');
        return name === entry.oldName ? [] : [{ id: entry.id, name, ...(groups && { libraryId: entry.libraryId }) }];
      });
    }
    function invalidate() {
      clearTimeout(timer);
      task = null;
    }
    const changedCount = plan => plan?.rows.filter(entry => entry.name !== entry.oldName).length ?? 0;
    function startPlan(pending) {
      if (pending.work) return pending.work;
      clearTimeout(timer);
      const current = () => dialog.open && task === pending;
      pending.work = running.then(async () => {
        if (!current()) return null;
        const entries = pending.draft ? proposedEntries(pending.draft) : undefined;
        const plan = entries && !entries.length ? null : await planFor(entries, current);
        if (!current()) return null;
        const count = changedCount(plan);
        render(plan?.rows ?? [], count ? `将改名 ${count} 项。` : '素材名称没有变化。', { editing: !ruleLocked });
        return count ? plan : null;
      }).catch(error => {
        if (current()) {
          invalidate();
          if (ruleLocked) hint.textContent = error?.message || '无法计算最终名称，请重试。';
          else render([], error?.message || '无法计算最终名称，请重试。', { unavailable: true });
        }
        throw error;
      });
      running = pending.work.catch(() => {});
      return pending.work;
    }
    function updateLive() {
      const rule = ruleLocked ? null : readRule();
      const signature = JSON.stringify(rule);
      if (task?.signature === signature) return task;
      invalidate();
      if (!ruleLocked && rules.querySelector(':invalid')) {
        render([], '请填写命名规则查看结果。', { unavailable: true });
        return null;
      }
      if (rule?.mode === 'affixes' && !rule.prefix && !rule.suffix) {
        render([], '素材名称没有变化。');
        return null;
      }
      const pending = task = { signature, draft: rule && nameForRule(rule) };
      if (ruleLocked) hint.textContent = '正在核对剩余素材的名称…';
      else render([], '正在核对最终名称…', { draft: pending.draft });
      timer = setTimeout(() => { void startPlan(pending).catch(() => {}); }, 90);
      return pending;
    }
    const step = {
      plan: null,
      async batchPlan() {
        const pending = updateLive();
        const plan = pending && await startPlan(pending);
        if (!plan) throw new Error('素材名称没有变化。');
        return plan.apply;
      },
      async review({ remaining = false } = {}) {
        const entries = remaining ? undefined : proposedEntries(nameForRule());
        if (entries && !entries.length) throw new Error('素材名称没有变化。');
        const plan = await planFor(entries);
        if (!dialog.open) return;
        const count = changedCount(plan);
        if (!count) throw new Error('素材名称没有变化。');
        step.plan = plan.apply;
        controls.hidden = true;
        render(plan.rows, `即将改名 ${count} 项。`, { editing: false, allowEdit: !remaining });
        status.focus(list);
      },
      reset({ keepRuleLocked = false } = {}) {
        step.plan = null;
        ruleLocked = controls.hidden = keepRuleLocked;
        invalidate();
        status.clear();
        if (live) {
          status.label(keepRuleLocked ? '重试重命名' : '重命名');
          updateLive();
        } else {
          preview.hidden = true;
          status.label(keepRuleLocked ? '重新预览剩余素材' : '预览改名');
        }
      },
    };
    back.addEventListener('click', () => {
      step.reset();
      controls.querySelector('select, input:not(:disabled)')?.focus();
    });
    previous.addEventListener('click', () => { page--; renderPage(); });
    next.addEventListener('click', () => { page++; renderPage(); });
    if (live) {
      rules.addEventListener('input', event => {
        if (event.target.tagName !== 'SELECT' && !event.isComposing) updateLive();
      });
      rules.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.target.tagName !== 'INPUT' || event.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        event.target.form.requestSubmit();
      });
      rules.addEventListener('compositionend', updateLive);
      rules.addEventListener('change', updateLive);
      dialog.addEventListener('close', invalidate, { once: true });
      render([], '素材名称没有变化。');
    }
    return step;
  }
})();
