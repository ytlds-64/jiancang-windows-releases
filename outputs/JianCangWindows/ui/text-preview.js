'use strict';

(() => {
  const pending = new WeakMap();
  const formats = new Set(['txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log']);
  window.canJianCangPreviewText = asset => asset.kind === 'document' && formats.has(asset.extension);
  window.disposeJianCangTextPreview = host => {
    pending.get(host)?.abort();
    pending.delete(host);
  };

  window.mountJianCangTextPreview = (host, { url, copy, notify, showError, makeButton }) => {
    const controller = new AbortController();
    pending.set(host, controller);

    const section = document.createElement('section');
    section.className = 'text-preview';
    section.setAttribute('aria-label', '文本预览');
    const toolbar = document.createElement('div');
    toolbar.className = 'text-preview-toolbar';
    const metadata = document.createElement('span');
    metadata.className = 'text-preview-metadata';
    metadata.setAttribute('role', 'status');
    metadata.textContent = '正在读取文本…';
    const copyButton = makeButton('复制预览', 'copy', 'outline-button', async () => {
      copyButton.disabled = true;
      try {
        const outcome = await copy();
        if (!controller.signal.aborted) notify(outcome?.ok ? '已复制预览文本。' : outcome?.message || '暂时无法复制文本。');
      } catch {
        if (!controller.signal.aborted) notify('暂时无法复制文本。');
      } finally { copyButton.disabled = false; }
    });
    copyButton.hidden = true;
    const content = document.createElement('textarea');
    content.className = 'text-preview-content';
    content.setAttribute('aria-label', '原始文本');
    content.readOnly = true;
    content.spellcheck = false;
    content.hidden = true;
    content.addEventListener('contextmenu', event => event.stopPropagation());
    toolbar.append(metadata, copyButton);
    section.append(toolbar, content);
    host.replaceChildren(section);

    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    void (async () => {
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error('无法读取文本。');
        const result = await response.json();
        if (controller.signal.aborted) return;
        if (!result?.ok) { showError(result?.message || '暂时无法读取文本。', false); return; }
        metadata.textContent = result.limited ? `${result.encoding} · 显示前 256 KB` : result.encoding;
        content.value = result.text;
        content.placeholder = '文件为空';
        content.hidden = false;
        copyButton.hidden = !result.text;
      } catch {
        if (!controller.signal.aborted) showError('暂时无法读取文本。', true);
      }
    })();
  };
})();
