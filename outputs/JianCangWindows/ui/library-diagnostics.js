'use strict';

(() => {
  const details = {
    'collection-metadata': ['集合索引缺少信息或重复', '在 Eagle 中核对这个集合，等库完成同步后再刷新。'],
    'directory-type': ['素材目录的结构不受支持', '打开素材库，确认 images 中对应的 .info 是普通文件夹。可在 Eagle 中重新导入该素材。'],
    'metadata-missing': ['找不到 metadata.json', '在资源管理器中下载这个素材文件夹后重试。若 Eagle 也打不开该条目，可从备份恢复或重新导入。'],
    'metadata-json': ['metadata.json 内容不完整或损坏', '如果库在云盘中，等文件下载完整后重试。若仍无法打开，可在 Eagle 中重新导入该素材。'],
    'metadata-id': ['素材 ID 与目录名称不一致', '在 Eagle 中核对这个条目或从原库备份恢复。刷新前请确认云盘已同步完成。'],
    'metadata-type': ['素材类型记录有误', '在 Eagle 中打开该条目，确认原件类型，必要时重新导入后刷新。'],
    'metadata-size': ['目录索引超出读取上限', '在 Eagle 中打开这个条目，重新导入原素材后刷新。'],
    'metadata-changing': ['目录索引还在写入', '等 Eagle 和云盘完成写入，再重新读取。'],
    'metadata-unreadable': ['目录索引暂时无法读取', '在资源管理器中确认目录可打开并已下载，之后重新读取。'],
    'permission': ['系统未允许读取此目录', '在资源管理器中检查当前账号对目录的访问权限，再重新读取。'],
    'unsafe-path': ['原路径指向链接或已变动', '在资源管理器中核对素材库内容，恢复普通文件和文件夹后刷新。'],
    'original-incomplete': ['原件大小与索引记录不符', '在资源管理器中将该文件设为始终保留在此设备上，等下载完成后再刷新。'],
    'original-unreadable': ['原件存在但暂时无法读取', '检查原件的访问权限及云盘下载状态，然后刷新。'],
    'original-ambiguous': ['目录中有多个候选原件', '在 Eagle 中确认该条目关联的原件，必要时重新导入，之后刷新。'],
    'original-missing': ['目录中找不到与索引对应的原件', '确认该 .info 文件夹已在资源管理器中下载。原件确实缺失时，从备份恢复或在 Eagle 中重新导入。'],
    'sync-original': ['原件暂不在本机', '打开原件取回队列，查看进度和失败原因。文件下载完成后可重新读取。'],
    'local-original': ['本地原件暂不可用', '检查原件是否仍在素材库的 originals 文件夹内。找回原件后重新读取。'],
    'unavailable': ['素材库暂时无法打开', '确认云盘或外置磁盘已连接。位置改过时可重新定位素材库。'],
    'library-warning': ['', '在资源管理器中检查素材库是否已下载并可访问，然后重新读取。'],
  };

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value) element.textContent = value;
    return element;
  }

  function collect(library, entry) {
    if (entry.status === 'unavailable') {
      return { total: 1, entries: [{ reason: 'unavailable', name: entry.message }] };
    }
    if (!library || !library.partial && !library.warnings?.length) return { total: 0, entries: [] };
    if (library.readingIssues) return library.readingIssues;
    const entries = [];
    let missing = 0;
    for (const asset of library.assets) {
      if (asset.trashed || asset.kind === 'link' || asset.available) continue;
      missing++;
      if (entries.length >= 120) continue;
      entries.push({ assetId: asset.id, reason: entry.kind === 'jiancang' ? 'sync-original' : 'local-original', name: asset.name });
    }
    const warnings = (library.warnings ?? []).filter(text => !missing || !/^有 \d+ 份(?:本地)?原件暂不可用/.test(text));
    entries.push(...warnings.map(name => ({ reason: 'library-warning', name })));
    return { total: missing + warnings.length, entries };
  }

  window.createJianCangLibraryDiagnostics = ({ dialog, refresh, reveal, revealItem, relocate, retrieve, notify }) => {
    const list = dialog.querySelector('#warnings-list');
    const summary = dialog.querySelector('#warnings-summary');
    let groups = [];

    function action(label, run) {
      const button = node('button', 'outline-button', label);
      button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = await run();
          if (result?.ok === false) notify(result.message);
        } catch (error) { notify(error.message || '操作未完成，请重新读取。'); }
        finally { button.disabled = false; }
      });
      return button;
    }

    function renderGroup({ entry, revision, report }) {
      const group = node('section', 'reading-group');
      const header = node('div', 'reading-group-head');
      const title = node('h3', '', entry.name || '素材库');
      const badge = node('span', 'reading-count', `${report.total} 项`);
      const actions = node('div', 'reading-actions');
      actions.append(action('重新读取', () => refresh(entry.id)), action('打开素材库', () => reveal(entry.id)));
      if (entry.status === 'unavailable') actions.append(action('重新定位', () => relocate(entry.id)));
      if (entry.status !== 'unavailable' && ['eagle', 'jiancang'].includes(entry.kind)) {
        actions.append(action('原件取回', () => { dialog.close(); retrieve(entry.id); }));
      }
      header.append(title, badge, actions);
      const rows = node('ul', 'reading-rows');
      for (const [index, item] of report.entries.entries()) {
        const row = node('li', 'reading-issue');
        const content = node('div', 'reading-content');
        const [reason, guidance] = details[item.reason] ?? details['library-warning'];
        const name = item.name || item.itemId || reason || '读取提示';
        content.append(node('h4', '', name));
        const location = [item.itemId && item.itemId !== name ? `ID ${item.itemId}` : '', item.path].filter(Boolean).join(' · ');
        if (location) content.append(node('code', 'reading-path', location));
        if (reason && reason !== name) content.append(node('p', 'reading-reason', reason));
        if (guidance) content.append(node('p', 'reading-guidance', guidance));
        row.append(content);
        if (item.directory && revision) {
          row.append(action('打开所在文件夹', () => revealItem(entry.id, revision, index)));
        } else if (item.reason === 'sync-original') {
          row.append(action('取回原件', () => { dialog.close(); retrieve(entry.id, [item.assetId]); }));
        }
        rows.append(row);
      }
      group.append(header, rows);
      if (report.total > report.entries.length) {
        group.append(node('p', 'reading-guidance', `已列出 ${report.entries.length} 项。处理后刷新即可继续查看剩余项目。`));
      }
      return group;
    }

    function render() {
      const count = groups.reduce((sum, group) => sum + group.report.total, 0);
      const key = JSON.stringify(groups.map(({ entry, revision, report }) => [entry.id, entry.status, revision, report]));
      if (list.dataset.report === key) return;
      list.dataset.report = key;
      summary.textContent = count ? `共 ${count} 项。可在对应条目下查看原因和处理方式。` : '当前范围的素材库已读取完成。';
      list.replaceChildren(...groups.map(renderGroup));
    }

    return {
      update(shown, loaded) {
        const catalogs = new Map(loaded.map(info => [info.libraryId, info]));
        groups = shown.map(entry => {
          const catalog = catalogs.get(entry.id);
          return { entry, revision: catalog?.revision, report: collect(catalog?.library, entry) };
        }).filter(group => group.report.total > 0);
        if (dialog.open) render();
        return groups.reduce((sum, group) => sum + group.report.total, 0);
      },
      open() { render(); if (!dialog.open) dialog.showModal(); },
    };
  };
})();
