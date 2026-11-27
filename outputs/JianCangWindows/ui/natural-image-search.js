'use strict';

(() => {
  const maximumImages = 120;
  const active = job => ['preparing', 'analyzing', 'ranking'].includes(job?.phase);

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function button(text, className = 'outline-button') {
    const element = node('button', className, text);
    element.type = 'button';
    return element;
  }

  function checked(response) {
    if (response?.ok === false) throw new Error(response.message);
    return response;
  }

  window.createJianCangNaturalImageSearch = ({ bridge, scope, refFor, getAsset, getImage, openAsset, openSettings }) => {
    const trigger = button('按描述找图', 'tool-button visual-trigger');
    trigger.id = 'natural-search-button';
    trigger.title = '用自然语言描述图片内容';
    const dialog = node('dialog', 'local-intake-dialog visual-tools-dialog natural-search-dialog');
    dialog.id = 'natural-image-search';
    dialog.setAttribute('aria-labelledby', 'natural-search-title');

    const head = node('div', 'dialog-head');
    const title = node('h2', '', '按描述找图');
    title.id = 'natural-search-title';
    const close = button('×', 'icon-button visual-close');
    close.setAttribute('aria-label', '关闭');
    head.append(title, close);

    const form = node('form', 'local-intake-body visual-body');
    const queryLabel = node('label', 'intake-field', '想找什么画面');
    const query = node('input');
    query.type = 'search';
    query.placeholder = '例如：黄昏逆光的人像，背景有树';
    query.required = true;
    query.maxLength = 240;
    query.autocomplete = 'off';
    queryLabel.append(query);
    const rangeLabel = node('label', 'intake-field', '搜索范围');
    const range = node('select');
    rangeLabel.append(range);
    const disclosure = node('p', 'visual-scope');
    const progress = node('progress', 'visual-progress');
    progress.setAttribute('aria-label', '找图进度');
    const feedback = node('p', 'visual-scope');
    feedback.setAttribute('role', 'status');
    const issue = node('p', 'local-intake-error');
    issue.setAttribute('role', 'status');
    const results = node('div', 'natural-search-results');
    results.setAttribute('aria-label', '匹配素材');
    const actions = node('div', 'local-intake-actions visual-actions');
    const setup = button('AI 服务设置');
    const stop = button('停止找图');
    const apply = button('开始找图', 'primary-button');
    apply.type = 'submit';
    actions.append(setup, stop, apply);
    form.append(queryLabel, rangeLabel, disclosure, actions, progress, feedback, issue, results);
    dialog.append(head, form);
    document.body.append(dialog);

    let profile = null;
    let loading = false;
    let starting = false;
    let stopping = false;
    let opening = 0;
    let job = null;
    let error = '';
    let displayed = new Map();
    let scopes = new Map();

    function renderResults() {
      const previous = displayed;
      displayed = new Map();
      const cards = [];
      for (const match of job?.results || []) {
        const { reference, description } = match;
        const asset = getAsset(reference);
        if (!asset) continue;
        const key = `${reference.registrationId}:${reference.assetId}`;
        let card = previous.get(key);
        if (!card) {
          card = button('', 'natural-search-result');
          const picture = node('img');
          picture.loading = 'lazy';
          picture.alt = '';
          picture.src = getImage(asset);
          const name = node('strong', '', asset.name);
          card.title = `${asset.name}\n${description}`;
          card.append(picture, name);
          card.addEventListener('click', () => {
            if (openAsset(reference, dialog)) return;
            error = '请回到这张素材所在的库或集合，再打开预览。';
            render();
          });
        }
        cards.push(card);
        displayed.set(key, card);
      }
      if (cards.length !== results.children.length || cards.some((card, index) => card !== results.children[index])) {
        results.replaceChildren(...cards);
      }
      results.hidden = !cards.length;
    }

    function render() {
      const photos = scopes.get(range.value) || [];
      const running = active(job);
      const busy = running || starting || stopping;
      query.disabled = range.disabled = busy;
      setup.disabled = busy || loading;
      stop.hidden = !running;
      stop.disabled = stopping;
      apply.hidden = running;
      apply.disabled = busy || loading || !profile?.configured || !query.value.trim() || !photos.length || photos.length > maximumImages;
      apply.textContent = job?.phase === 'failed' || job?.phase === 'cancelled' || job?.skipped ? '重新找图' : '开始找图';
      if (loading) disclosure.textContent = '正在读取 AI 服务设置…';
      else if (!profile?.configured) disclosure.textContent = '请在 AI 服务设置中配置支持图片输入的 LM Studio 或 OpenAI 兼容模型。';
      else if (!photos.length) disclosure.textContent = '此范围没有可搜索的图片。';
      else {
        const host = new URL(profile.endpoint).hostname;
        const recipient = ['127.0.0.1', '[::1]'].includes(host) ? profile.label : `外部服务 ${profile.label}`;
        disclosure.textContent = `开始后，会向 ${recipient}（${profile.model}）发送查找描述、图片画面摘要，以及本组最多 ${photos.length} 张尚无摘要的缩略图。摘要保存在本机供下次使用。`;
      }
      progress.hidden = !running;
      progress.max = job?.total || 1;
      progress.value = job?.phase === 'ranking' ? Math.min(progress.max, job.ranked + job.skipped) : job?.processed || 0;
      const count = job?.results.length || 0;
      const cache = job?.cached ? `，复用 ${job.cached} 张摘要` : '';
      const skipped = job?.skipped ? `，跳过 ${job.skipped} 张` : '';
      const messages = {
        preparing: '正在准备图片范围…',
        analyzing: `读取画面摘要 ${job?.processed} / ${job?.total}${cache}${skipped}…`,
        ranking: `正在匹配语义，已比较 ${job?.ranked} 张${skipped}…`,
        completed: `「${job?.query}」匹配 ${count} 张，已比较 ${job?.ranked} 张${cache}${skipped}。`,
        cancelled: `已停止，已分析的图片可在下次复用${count ? `，已找到 ${count} 张` : ''}。`,
        failed: count ? `已找到 ${count} 张，剩余图片可以重试。` : '查找未完成。',
      };
      feedback.textContent = messages[job?.phase] || '';
      feedback.hidden = !feedback.textContent;
      issue.textContent = error || job?.error || '';
      issue.hidden = !issue.textContent;
      renderResults();
    }

    async function refreshProfile() {
      const attempt = ++opening;
      loading = true;
      render();
      try {
        const config = checked(await bridge.suggestionSettings());
        if (attempt === opening) profile = config;
      } catch (caught) { if (attempt === opening) error = caught.message; }
      finally {
        if (attempt === opening) {
          loading = false;
          render();
        }
      }
    }

    function setJob(snapshot) {
      if (snapshot?.id !== job?.id) displayed.clear();
      job = snapshot;
      if (dialog.open) render();
    }

    trigger.addEventListener('click', () => {
      const { current, selected } = scope();
      scopes = new Map();
      range.replaceChildren();
      for (const [key, label, assets] of [['current', '当前图库结果', current], ['selected', '所选图片', selected]]) {
        if (!assets) continue;
        for (let offset = 0; offset < Math.max(1, assets.length); offset += maximumImages) {
          const end = Math.min(offset + maximumImages, assets.length);
          const value = `${key}:${offset}`;
          const length = assets.length > maximumImages ? `${offset + 1}–${end} / ${assets.length} 张` : `${assets.length} 张`;
          range.add(new Option(`${label}（${length}）`, value));
          scopes.set(value, assets.slice(offset, end));
        }
      }
      if (selected?.length > 1) range.value = 'selected:0';
      error = '';
      void refreshProfile();
      dialog.showModal();
      void bridge.naturalSearchStatus().then(snapshot => {
        if (starting || snapshot?.ok === false) return;
        if (snapshot && !query.value) query.value = snapshot.query;
        setJob(snapshot);
      }).catch(() => {});
    });

    close.addEventListener('click', () => dialog.close());
    setup.addEventListener('click', async () => {
      setup.disabled = true;
      await openSettings();
      await refreshProfile();
    });
    range.addEventListener('change', render);
    query.addEventListener('input', render);
    stop.addEventListener('click', async () => {
      stopping = true;
      render();
      try { await bridge.cancelNaturalSearch(job.id).then(checked); }
      catch (caught) { error = caught.message; }
      finally { stopping = false; render(); }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (apply.disabled || active(job)) return;
      starting = true;
      error = '';
      const { provider, endpoint, model } = profile;
      render();
      try {
        const snapshot = checked(await bridge.startNaturalSearch(query.value.trim(), scopes.get(range.value).map(refFor), { provider, endpoint, model }));
        // Progress can arrive before the response to start the job.
        if (job?.id !== snapshot.id) setJob(snapshot);
      } catch (caught) { error = caught.message; }
      finally { starting = false; render(); }
    });
    bridge.onNaturalSearchChange(setJob);
    return trigger;
  };
})();
