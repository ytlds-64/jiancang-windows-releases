'use strict';

(() => {
  const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

  function node(tag, className, text) {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  }

  function button(title, className, action, id) {
    const control = node('button', className, title);
    control.type = 'button';
    if (id) control.id = id;
    control.addEventListener('click', action);
    return control;
  }

  function heading(dialog, text) {
    const header = node('header', 'dialog-head offline-web-head');
    const title = node('h2', '', text);
    title.id = `${dialog.id}-title`;
    const close = button('×', 'icon-button', () => dialog.close());
    close.setAttribute('aria-label', '关闭');
    dialog.setAttribute('aria-labelledby', title.id);
    header.append(title, close);
    return header;
  }

  function outcome(value) {
    if (value?.ok === false) throw new Error(value.message || '操作未完成，请重试。');
    return value;
  }

  function sourceHost(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  }

  function snapshotDate(value) {
    try { return date.format(value); } catch { return ''; }
  }

  window.createJianCangOfflineWeb = ({ bridge, notify } = {}) => {
    const dialog = node('dialog', 'offline-web-dialog');
    dialog.id = 'offline-web-dialog';
    const removeDialog = node('dialog', 'offline-web-confirm local-intake-dialog');
    removeDialog.id = 'offline-web-remove-dialog';
    let current;
    let snapshot;
    let busy = false;
    let request = 0;

    const header = heading(dialog, '网页离线收藏');
    const toolbar = node('div', 'offline-web-toolbar');
    const identity = node('div', 'offline-web-identity');
    const domain = node('span', 'offline-web-domain');
    const stamp = node('span', 'offline-web-stamp');
    identity.append(domain, stamp);
    const actions = node('div', 'offline-web-actions');
    const capture = button('保存离线副本', 'primary-button', () => void capturePage(), 'offline-web-capture');
    const original = button('在浏览器打开', 'outline-button', () => void openLink(current?.url), 'offline-web-open-browser');
    actions.append(original, capture);
    toolbar.append(identity, actions);
    const notice = node('p', 'offline-web-message');
    notice.hidden = true;
    notice.setAttribute('role', 'status');
    const surface = node('div', 'offline-web-surface');
    const article = node('article', 'offline-web-article');
    article.setAttribute('aria-label', '网页正文');
    surface.append(article);
    dialog.append(header, toolbar, notice, surface);

    const removeHead = heading(removeDialog, '移除离线副本？');
    const removeBody = node('div', 'local-intake-body offline-web-remove-body');
    const confirmMessage = node('p', '', '移除本机保存的网页正文。素材库中的链接会保留。');
    const removeActions = node('div', 'offline-web-actions');
    removeActions.append(button('取消', 'outline-button', () => removeDialog.close()),
      button('移除离线副本', 'primary-button', () => void removePage(), 'offline-web-confirm-remove'));
    removeBody.append(confirmMessage, removeActions);
    removeDialog.append(removeHead, removeBody);
    document.body.append(dialog, removeDialog);

    function status(text, error = false) {
      notice.textContent = text;
      notice.hidden = !text;
      notice.classList.toggle('offline-web-error', error);
    }

    function controls() {
      const savedTime = snapshot && snapshotDate(snapshot.capturedAt);
      stamp.textContent = savedTime ? `保存于 ${savedTime}` : '';
      capture.textContent = snapshot ? '更新离线副本' : '保存离线副本';
      capture.disabled = busy;
      original.disabled = !current?.url;
      const discard = article.querySelector('#offline-web-remove');
      if (discard) discard.disabled = busy;
      dialog.setAttribute('aria-busy', String(busy));
    }

    function render() {
      article.replaceChildren();
      domain.textContent = sourceHost(snapshot?.finalURL || current?.url);
      if (!snapshot) {
        article.append(node('h3', 'offline-web-article-title', current?.name || '网页链接'),
          node('p', 'offline-web-empty', '保存该网页的正文与链接后，就能离线阅读。部分依赖登录或脚本的网页无法保存。'));
        controls();
        return;
      }
      article.append(node('h3', 'offline-web-article-title', snapshot.title || current?.name || '网页链接'));
      if (snapshot.byline) article.append(node('p', 'offline-web-byline', snapshot.byline));
      const content = node('section', 'offline-web-content');
      let list;
      for (const block of snapshot.blocks || []) {
        if (block.kind === 'item') {
          if (!list) { list = node('ul'); content.append(list); }
          list.append(node('li', '', block.text));
          continue;
        }
        list = null;
        if (block.kind === 'heading') content.append(node(block.level <= 2 ? 'h4' : 'h5', '', block.text));
        else content.append(node({ quote: 'blockquote', code: 'pre' }[block.kind] || 'p', '', block.text));
      }
      article.append(content);
      if (snapshot.truncated) article.append(node('p', 'offline-web-truncated', '这份副本保留了网页的前一部分。可在浏览器阅读完整网页。'));
      if (snapshot.links?.length) {
        const details = node('details', 'offline-web-links');
        const list = node('ul');
        for (const link of snapshot.links) {
          const item = node('li');
          const label = button(link.label, 'offline-web-link', () => void openLink(link.url));
          label.title = link.url;
          item.append(label, node('span', 'offline-web-link-host', sourceHost(link.url)));
          list.append(item);
        }
        details.append(node('summary', '', `正文链接（${snapshot.links.length}）`), list);
        article.append(details);
      }
      const actions = node('footer', 'offline-web-footer');
      actions.append(button('移除离线副本', 'status-button is-local-action', () => removeDialog.showModal(), 'offline-web-remove'));
      article.append(actions);
      controls();
    }

    async function capturePage() {
      if (!current || busy) return;
      const step = request;
      busy = true;
      status(snapshot ? '正在更新网页正文…' : '正在保存网页正文…');
      controls();
      try {
        const saved = outcome(await bridge.captureOfflineWeb(current.reference));
        if (step !== request) return;
        snapshot = saved;
        render();
        status('');
        notify?.('离线网页已保存。');
      } catch (error) { if (step === request) status(error.message, true); }
      finally { if (step === request) { busy = false; controls(); } }
    }

    async function removePage() {
      if (!current || busy) return;
      const step = request;
      busy = true;
      removeDialog.close();
      controls();
      try {
        outcome(await bridge.removeOfflineWeb(current.reference));
        if (step !== request) return;
        snapshot = null;
        render();
        status('');
        notify?.('离线副本已移除。');
      } catch (error) { if (step === request) status(error.message, true); }
      finally { if (step === request) { busy = false; controls(); } }
    }

    async function openLink(url) {
      if (!current || !url) return;
      try { outcome(await bridge.openOfflineLink(current.reference, url)); }
      catch (error) { status(error.message, true); }
    }

    async function open(asset) {
      if (!asset?.sourceLibraryId || !asset.sourceAssetId || !asset.sourceURL) return;
      const step = ++request;
      current = { reference: { registrationId: asset.sourceLibraryId, id: asset.sourceAssetId }, name: asset.name, url: asset.sourceURL };
      snapshot = null;
      busy = true;
      render();
      status('正在读取本机副本…');
      surface.scrollTop = 0;
      if (!dialog.open) dialog.showModal();
      try {
        const saved = outcome(await bridge.getOfflineWeb(current.reference));
        if (step !== request) return;
        snapshot = saved;
        render();
        status('');
      } catch (error) { if (step === request) status(error.message, true); }
      finally { if (step === request) { busy = false; controls(); } }
    }

    return { open };
  };
})();
