'use strict';

(() => {
  const numbers = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
  const kinds = { local: '本地素材库', jiancang: '见藏同步库', eagle: 'Eagle 素材库' };

  function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let unit = 0;
    while (bytes >= 1024 && unit < units.length - 1) {
      bytes /= 1024;
      unit++;
    }
    return `${numbers.format(bytes)} ${units[unit]}`;
  }

  function element(tag, name, text) {
    const node = document.createElement(tag);
    if (name) node.className = name;
    if (text) node.textContent = text;
    return node;
  }

  function button(label, name, action) {
    const node = element('button', name, label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  window.createJianCangStorageManagement = ({ bridge, notify = () => {} }) => {
    let snapshot;
    let busy = false;
    const dialog = element('dialog', 'storage-dialog');
    dialog.id = 'storage-management-dialog';
    dialog.setAttribute('aria-labelledby', 'storage-heading');
    const title = element('h2', '', '存储管理');
    title.id = 'storage-heading';
    const close = button('×', 'icon-button', () => dialog.close());
    close.setAttribute('aria-label', '关闭存储管理');
    const header = element('div', 'dialog-head');
    header.append(title, close);

    const body = element('div', 'storage-body');
    const cache = element('section', 'storage-cache');
    const cacheInfo = element('div', 'storage-cache-info');
    const cacheTitle = element('h3', '', '缩略图缓存');
    const cacheSize = element('strong', 'storage-size');
    cacheSize.id = 'storage-cache-size';
    const cacheCount = element('p', 'storage-detail');
    cacheInfo.append(cacheTitle, cacheSize, cacheCount);
    const clear = button('清理缩略图缓存', 'outline-button', () => {
      if (!busy && snapshot?.cache?.count) {
        confirmationText.textContent = `清理本机生成的 ${numbers.format(snapshot.cache.count)} 项缩略图缓存。再次浏览素材时会重新生成。`;
        confirmation.showModal();
      }
    });
    clear.id = 'storage-cache-clear';
    cache.append(cacheInfo, clear);

    const libraries = element('section', 'storage-libraries');
    const libraryHeading = element('div', 'storage-library-heading');
    const libraryTitle = element('h3', '', '已连接的素材库');
    const sizeHeading = element('span', 'storage-detail', '素材原始大小');
    libraryHeading.append(libraryTitle, sizeHeading);
    const libraryList = element('ul', 'storage-library-list');
    const empty = element('p', 'storage-detail', '还没有已连接的素材库。');
    const hint = element('p', 'storage-detail', '按库索引中的当前素材统计。云盘原件按文件完整大小计入。');
    libraries.append(libraryHeading, libraryList, empty, hint);
    const notice = element('p', 'storage-notice');
    notice.hidden = true;
    notice.setAttribute('role', 'status');
    body.append(cache, libraries, notice);
    dialog.append(header, body);

    const confirmation = element('dialog', 'storage-confirm');
    confirmation.id = 'storage-cache-confirm';
    confirmation.setAttribute('aria-labelledby', 'storage-confirm-title');
    const confirmHeader = element('div', 'dialog-head');
    const confirmTitle = element('h2', '', '清理缩略图缓存？');
    confirmTitle.id = 'storage-confirm-title';
    confirmHeader.append(confirmTitle);
    const confirmBody = element('div', 'storage-confirm-body');
    const confirmationText = element('p', '');
    const choices = element('div', 'storage-confirm-actions');
    const cancel = button('取消', 'outline-button', () => confirmation.close());
    cancel.setAttribute('autofocus', '');
    const confirm = button('清理', 'primary-button', () => {
      confirmation.close();
      void load(true);
    });
    confirm.id = 'storage-cache-confirm-clear';
    choices.append(cancel, confirm);
    confirmBody.append(confirmationText, choices);
    confirmation.append(confirmHeader, confirmBody);
    document.body.append(dialog, confirmation);

    function render() {
      const result = snapshot?.cache;
      cacheSize.textContent = result ? formatBytes(result.bytes) : '—';
      cacheCount.textContent = result
        ? `${numbers.format(result.count)} 项缓存。再次浏览素材时会按需生成。`
        : busy ? '正在读取缓存大小。' : '缓存位置暂不可读。';
      clear.disabled = busy || !result?.count;
      close.disabled = busy && !!snapshot;
      const rows = snapshot?.libraries || [];
      libraryList.replaceChildren(...rows.map(library => {
        const row = element('li', 'storage-library-row');
        const label = element('div', 'storage-library-label');
        const name = element('strong', '', library.name);
        name.title = library.name;
        const details = library.loaded
          ? `${kinds[library.kind] || '素材库'} · ${numbers.format(library.count)} 项素材 · 已定位 ${numbers.format(library.originals)} 项原件`
          : `${kinds[library.kind] || '素材库'} · 目录暂不可读`;
        label.append(name, element('span', 'storage-detail', details));
        row.append(label, element('strong', 'storage-library-size', library.loaded ? formatBytes(library.bytes) : '—'));
        return row;
      }));
      empty.hidden = busy || rows.length > 0;
      hint.hidden = rows.length === 0;
    }

    function message(text = '', error = false) {
      notice.textContent = text;
      notice.hidden = !text;
      notice.classList.toggle('storage-error', error);
    }

    async function load(clearCache = false) {
      if (busy) return;
      busy = true;
      message(clearCache ? '正在清理缓存…' : '');
      render();
      try {
        const response = await (clearCache ? bridge.clearThumbnailStorage() : bridge.storageStatus());
        if (!response?.ok) throw new Error(response?.message || '操作未完成，请重试。');
        snapshot = response;
        if (clearCache) {
          const { removedBytes, failedCount } = response.cache;
          const text = `已清理 ${formatBytes(removedBytes)} 缓存。`;
          message(failedCount ? `${text} 仍有 ${numbers.format(failedCount)} 项暂时占用，请稍后重试。` : text, !!failedCount);
          notify(text);
        }
      } catch (error) {
        message(error.message || '无法读取存储信息，请重试。', true);
      } finally {
        busy = false;
        render();
      }
    }

    dialog.addEventListener('cancel', event => { if (busy && snapshot) event.preventDefault(); });
    return {
      open() {
        if (dialog.open) return;
        snapshot = undefined;
        dialog.showModal();
        void load();
      },
    };
  };
})();
