'use strict';

(() => {
  const counts = new Intl.NumberFormat('zh-CN');
  const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className, click) {
    const node = element('button', className, label);
    node.type = 'button';
    node.addEventListener('click', click);
    return node;
  }

  function fieldName(conflict) {
    if (conflict.field.startsWith('tag:')) return `标签 · ${conflict.fieldLabel}`;
    if (conflict.field.startsWith('member:')) return `所属集合 · ${conflict.fieldLabel}`;
    return conflict.fieldLabel;
  }

  function dateValue(value) {
    const time = new Date(value * 1000);
    return Number.isFinite(time.valueOf()) ? date.format(time) : '日期不可用';
  }

  function valueText(conflict, candidate) {
    const { field } = conflict;
    const { value } = candidate;
    if (field === 'life') return value ? '保留' : '永久删除';
    if (field === 'deletedAt') return value === null ? '保留在素材库' : `已移至回收站 · ${dateValue(value)}`;
    if (field === 'createdAt') return dateValue(value);
    if (field === 'parentID') {
      const parent = candidate.displayValue ?? '顶层集合';
      return candidate.sourceEntityName ? `${candidate.sourceEntityName} → ${parent}` : parent;
    }
    if (field === 'favorite') return value ? '已收藏' : '未收藏';
    if (field === 'rating') return value === 0 ? '未评分' : `${value} 星`;
    if (field === 'colorHex') return '#' + value;
    if (typeof value === 'boolean') return value ? '添加' : '移除';
    return value === null || value === '' ? '空' : value + (candidate.valueTruncated ? '…' : '');
  }

  function candidateCard(conflict, candidate, canChoose, choose) {
    const row = element('label', 'sync-candidate');
    if (canChoose) {
      const option = element('input');
      option.type = 'radio';
      option.name = 'sync-conflict-choice';
      option.value = candidate.choiceId;
      option.addEventListener('change', () => choose(candidate.choiceId));
      row.append(option);
    }
    const body = element('span', 'sync-candidate-body');
    const value = element('span', 'sync-candidate-value', valueText(conflict, candidate));
    if (conflict.field === 'colorHex' && /^[0-9a-f]{6}$/i.test(candidate.value)) {
      const color = element('span', 'sync-candidate-color');
      color.style.backgroundColor = '#' + candidate.value;
      value.prepend(color);
    }
    const origin = element('span', 'sync-candidate-origin',
      `设备 ${candidate.deviceId.slice(-8)} · 记录 ${counts.format(candidate.counter)}`);
    origin.title = `设备 ${candidate.deviceId}\n操作 ${candidate.operationId}`;
    body.append(value, origin);
    if (candidate.valueTruncated) body.append(element('span', 'sync-candidate-origin', '仅显示前 2048 个字符'));
    row.append(body);
    return row;
  }

  window.createJianCangSyncConflicts = function createJianCangSyncConflicts({ bridge, notify }) {
    const dialog = element('dialog', 'sync-conflicts-dialog');
    const header = element('header', 'dialog-head');
    const title = element('h2', '', '同步冲突');
    title.id = 'sync-conflicts-title';
    dialog.setAttribute('aria-labelledby', title.id);
    const close = button('×', 'icon-button sync-conflicts-close', () => dialog.close());
    close.setAttribute('aria-label', '关闭同步冲突');
    header.append(title, close);
    const overview = element('div', 'sync-conflicts-overview');
    const summary = element('p', 'sync-conflicts-summary');
    summary.setAttribute('role', 'status');
    const refresh = button('刷新', 'outline-button', () => void load());
    overview.append(summary, refresh);
    const layout = element('div', 'sync-conflicts-layout');
    const list = element('nav', 'sync-conflicts-list');
    list.setAttribute('aria-label', '冲突记录');
    const detail = element('section', 'sync-conflicts-detail');
    layout.append(list, detail);
    const footer = element('footer', 'sync-conflicts-footer');
    const message = element('p', 'sync-conflicts-message');
    message.setAttribute('role', 'status');
    const apply = button('确认选择', 'primary-button', () => void resolve());
    footer.append(message, apply);
    dialog.append(header, overview, layout, footer);
    document.body.append(dialog);

    let entry;
    let view;
    let active;
    let choiceId;
    let guidance = '';
    let working = false;
    let committed = false;
    let request = 0;

    function setWorking(value) {
      working = value;
      refresh.disabled = value;
      dialog.setAttribute('aria-busy', String(value));
      updateApply();
    }

    function updateApply() {
      const canEdit = entry?.writable && active?.resolvable;
      apply.hidden = !canEdit || committed;
      apply.disabled = working || !(choiceId || active?.moveToRoot || active?.acknowledgeDeletion);
      apply.textContent = active?.moveToRoot ? '移至顶层并解决'
        : active?.acknowledgeDeletion ? '确认已查看'
          : !choiceId ? '确认选择' : choiceId === active.winnerId ? '保留当前值' : '采用所选值';
    }

    function render() {
      const conflicts = view?.conflicts ?? [];
      const focused = list.contains(document.activeElement);
      if (view) summary.textContent = `${entry.name || '见藏同步库'} · ${counts.format(view.total)} 条冲突`;
      const entries = conflicts.map(conflict => {
        const item = button('', 'sync-conflicts-record', () => {
          if (working) return;
          active = conflict;
          choiceId = undefined;
          committed = false;
          message.textContent = guidance;
          render();
        });
        if (conflict === active) item.setAttribute('aria-current', 'true');
        item.title = `${fieldName(conflict)} · ${conflict.entityName}`;
        item.append(element('strong', '', fieldName(conflict)), element('span', '', conflict.entityName));
        return item;
      });
      list.replaceChildren(...entries);
      if (focused) list.querySelector('[aria-current="true"]')?.focus({ preventScroll: true });
      layout.classList.toggle('has-conflicts', conflicts.length > 0);
      detail.replaceChildren();
      if (!active) {
        if (view) detail.append(element('p', 'sync-conflicts-empty', view.logIncomplete
          ? '已读到的记录中暂无冲突，等待其他同步记录取回。' : '这份素材库没有待处理的同步冲突。'));
        updateApply();
        return;
      }
      detail.scrollTop = 0;
      const current = active.candidates.find(candidate => candidate.choiceId === active.winnerId);
      const compare = element('div', 'sync-conflict-comparison');
      const currentColumn = element('div', 'sync-conflict-column');
      const alternatives = element('div', 'sync-conflict-column');
      const choose = id => { if (!working) { choiceId = id; updateApply(); } };
      const allow = candidate => entry.writable && candidate.selectable && !committed;
      const cycle = active.reason === 'collection-cycle';
      currentColumn.append(element('h4', '', cycle ? '当前显示' : active.displayedParent ? '当前记录' : '当前值'));
      if (cycle) currentColumn.append(element('div', 'sync-candidate', '顶层集合'));
      else currentColumn.append(candidateCard(active, current, allow(current), choose));
      alternatives.append(element('h4', '', cycle ? '冲突中的层级记录' : '其他版本'));
      for (const candidate of active.candidates) {
        if (cycle || candidate !== current) alternatives.append(candidateCard(active, candidate, allow(candidate), choose));
      }
      if (active.candidateCount > active.candidates.length) alternatives.append(element('p', 'sync-candidate-origin',
        `显示 ${active.candidates.length} 条记录，共 ${active.candidateCount} 条。`));
      compare.append(currentColumn, alternatives);
      const subject = element('p', 'sync-conflicts-subject', `${active.kind === 'collection' ? '集合' : '素材'} · ${active.entityName}`);
      detail.append(element('h3', '', fieldName(active)), subject);
      if (cycle) detail.append(element('p', 'sync-conflicts-note',
        active.moveToRoot && entry.writable ? '集合层级形成循环。将此集合移至顶层可解除循环，并将新层级同步到其他设备。'
          : '集合层级形成循环，当前将其中一项暂时显示在顶层。'));
      else if (active.acknowledgeDeletion) detail.append(element('p', 'sync-conflicts-note',
        '永久移除已生效。确认后仅在这台电脑上隐藏这条冲突记录。'));
      else if (active.displayedParent) detail.append(element('p', 'sync-conflicts-note',
        `当前集合显示在「${active.displayedParent}」。`));
      else if (entry.writable && !view.logIncomplete && !active.resolvable) detail.append(element('p', 'sync-conflicts-note',
        '可查看这条记录，请在 iPhone 或 iPad 处理。'));
      detail.append(compare);
      updateApply();
    }

    async function load({ afterWrite = false } = {}) {
      const ownRequest = ++request;
      const previous = active;
      setWorking(true);
      if (!afterWrite) message.textContent = '';
      if (!view) summary.textContent = '正在读取同步冲突…';
      try {
        const result = await bridge.listSyncConflicts(entry.id);
        if (ownRequest !== request || !dialog.open) return;
        if (result?.ok === false || !Array.isArray(result?.conflicts)) throw new Error(result?.message || '无法读取同步冲突。');
        view = result;
        active = view.conflicts.find(conflict => conflict.signature === previous?.signature) ?? view.conflicts[0];
        choiceId = undefined;
        committed = false;
        const readOnly = view.logIncomplete ? '等待 iCloud 取回完整的记录，取回后点击刷新。'
          : view.format < 6 ? '在 iPhone 或 iPad 升级同步库后，可在 Windows 处理冲突。'
            : !entry.writable ? '可查看冲突。在同步状态中开启 Windows 写入，即可选择保留的值。' : '';
        guidance = [readOnly, view.truncated ? `当前显示前 ${view.conflicts.length} 条冲突。` : ''].filter(Boolean).join(' ');
        if (!afterWrite) message.textContent = guidance;
        render();
      } catch (error) {
        if (ownRequest === request) {
          if (!view) summary.textContent = '同步冲突读取失败';
          message.textContent = error.message || '暂时无法读取同步冲突，请刷新重试。';
        }
      } finally { if (ownRequest === request) setWorking(false); }
    }

    async function resolve() {
      if (working || committed || !(choiceId || active?.moveToRoot || active?.acknowledgeDeletion) || !active?.resolvable || !entry?.writable) return;
      const { kind, entityId, field, signature, moveToRoot, acknowledgeDeletion } = active;
      setWorking(true);
      message.textContent = '正在提交所选值…';
      close.disabled = true;
      try {
        const result = await bridge.resolveSyncConflict(entry.id, { action: 'resolveConflict', kind, entityId, field, signature,
          choiceId, moveToRoot, acknowledgeDeletion });
        if (result?.ok === false) throw new Error(result.message);
        if (result?.pending) {
          choiceId = undefined;
          committed = true;
          message.textContent = result.error || '选择已保存到本机，可在同步状态中重试提交。';
          render();
        } else {
          message.textContent = acknowledgeDeletion ? '已在这台电脑确认。' : '已提交所选值。';
          notify?.(acknowledgeDeletion ? '已确认永久移除记录。' : '已处理同步冲突。');
          await load({ afterWrite: true });
        }
      } catch (error) {
        choiceId = undefined;
        message.textContent = error.message || '暂时无法提交所选值，请刷新后重新选择。';
        render();
      } finally {
        close.disabled = false;
        setWorking(false);
      }
    }

    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('cancel', event => { if (close.disabled) event.preventDefault(); });
    dialog.addEventListener('close', () => { request++; });
    return {
      open(nextEntry) {
        if (!nextEntry?.id || close.disabled) return;
        entry = nextEntry;
        view = active = choiceId = undefined;
        guidance = '';
        committed = false;
        render();
        if (!dialog.open) dialog.showModal();
        void load();
      },
    };
  };
})();
