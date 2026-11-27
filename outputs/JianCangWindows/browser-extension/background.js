'use strict';

const endpoint = 'http://127.0.0.1:47181/v1/';
const webPagePatterns = ['http://*/*', 'https://*/*'];
const defaultActionTitle = '见藏 · 打开采集面板';
const optionsPage = chrome.runtime.getURL('options.html');
const audioPage = 'capture-audio.html';
const automaticId = 'jiancang-image-drag';
const updateAlarm = 'jiancang-bundled-extension';
const usageKey = 'captureDestinationUsage';
const destinationHistoryLimit = 2048;
const captureReceiptLimit = 512;
let activeCaptures = 0;
let checkingBundledUpdate = false;
let badgeTimer;
let connectionRequest;
let automaticRegistration = Promise.resolve();
let cachedTargets;
let targetRequest;
let captureSounds = Promise.resolve();
let captureUsageWrites = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const [id, title, context] of [
      ['save-page', '采集网页到见藏', 'page'],
      ['save-image', '采集图片到见藏', 'image'],
      ['save-link', '采集链接到见藏', 'link'],
    ]) chrome.contextMenus.create({ id, title, contexts: [context], documentUrlPatterns: webPagePatterns });
    chrome.contextMenus.create({ id: 'settings', title: '见藏采集设置', contexts: ['action'] });
  });
  void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  void syncAutomaticDrag(true).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => void syncAutomaticDrag().catch(() => {}));
chrome.permissions.onAdded.addListener(() => void syncAutomaticDrag(true).catch(() => {}));
chrome.permissions.onRemoved.addListener(() => void syncAutomaticDrag(true).catch(() => {}));

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === updateAlarm) void checkBundledUpdate();
});
void chrome.alarms.get(updateAlarm).then(alarm => {
  if (!alarm) return chrome.alarms.create(updateAlarm, { periodInMinutes: 1 });
}).catch(() => {});

function isNewerVersion(candidate, current) {
  if (typeof candidate !== 'string' || !/^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(candidate)) return false;
  const incoming = candidate.split('.').map(Number);
  const loaded = current.split('.').map(Number);
  for (let i = 0; i < Math.max(incoming.length, loaded.length); i++) {
    const difference = (incoming[i] ?? 0) - (loaded[i] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
}

async function checkBundledUpdate() {
  if (checkingBundledUpdate || activeCaptures || connectionRequest) return;
  checkingBundledUpdate = true;
  try {
    const loaded = chrome.runtime.getManifest();
    // The desktop updater replaces these local files and commits the manifest last.
    const response = await fetch(chrome.runtime.getURL('manifest.json'), {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return;
    const disk = await response.json();
    if (!isNewerVersion(disk?.version, loaded.version) || !loaded.key ||
        disk.key !== loaded.key || disk.manifest_version !== loaded.manifest_version) return;

    const tabs = await chrome.tabs.query({});
    const replies = await Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id)).map(tab =>
      chrome.tabs.sendMessage(tab.id, { type: 'jiancang:reload-ready' }, { frameId: 0 })));
    if (activeCaptures || connectionRequest ||
        replies.some(reply => reply.status === 'fulfilled' && reply.value?.ready === false)) return;
    chrome.runtime.reload();
  } catch {
    // A local update can be in progress. The next alarm will retry.
  } finally {
    checkingBundledUpdate = false;
  }
}

function httpURL(value) {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

async function announce(ok, message) {
  await chrome.storage.local.set({ lastCapture: { ok, message, at: Date.now() } }).catch(() => {});
  void chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  void chrome.action.setBadgeBackgroundColor({ color: ok ? '#37684d' : '#a74531' });
  void chrome.action.setTitle({ title: message });
  clearTimeout(badgeTimer);
  if (ok) badgeTimer = setTimeout(() => {
    void chrome.action.setBadgeText({ text: '' });
    void chrome.action.setTitle({ title: defaultActionTitle });
  }, 2500);
  else void chrome.notifications.create({
    type: 'basic', iconUrl: 'icon.png', title: '见藏浏览器采集', message,
  }).catch(() => {});
}

async function announceCapture(result, requestId) {
  await announce(true, result.message);
  playCaptureSound(requestId);
}

function playCaptureSound(requestId) {
  captureSounds = captureSounds.then(async () => {
    if (!chrome.offscreen || !chrome.runtime.getContexts ||
        (await chrome.storage.local.get('captureSuccessSound')).captureSuccessSound === false) return;
    const { playedCaptureSounds = [] } = await chrome.storage.session.get('playedCaptureSounds');
    if (playedCaptureSounds.includes(requestId)) return;
    const documents = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(audioPage)],
    });
    if (!documents.length) {
      await chrome.offscreen.createDocument({
        url: audioPage, reasons: ['AUDIO_PLAYBACK'], justification: 'Plays a short tone when a capture is saved.',
      });
    }
    const played = await chrome.runtime.sendMessage({ type: 'jiancang:capture-success-sound' });
    if (played?.ok) await chrome.storage.session.set({ playedCaptureSounds: [...playedCaptureSounds.slice(-127), requestId] });
  }).catch(() => {
    // A browser or audio device may decline playback. The capture result remains available.
  });
}

async function post(operation, payload, { authenticated = true, timeout = 25_000 } = {}) {
  const token = authenticated ? (await chrome.storage.local.get('captureToken')).captureToken : undefined;
  if (authenticated && !token) {
    throw Object.assign(new Error('请先连接见藏。'), { status: 401 });
  }
  let response;
  try {
    response = await fetch(endpoint + operation, {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new Error(operation === 'connect' && error.name === 'TimeoutError'
      ? '连接请求已超时，请重试并在见藏中同意连接。'
      : '无法连接见藏。请确认见藏正在运行并已启用浏览器采集。');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    if (response.status === 401 && token && (await chrome.storage.local.get('captureToken')).captureToken === token) {
      await chrome.storage.local.remove('captureToken');
      cachedTargets = undefined;
    }
    throw Object.assign(new Error(result.message || '操作未完成，请检查见藏后重试。'), { status: response.status });
  }
  return result;
}

async function connectBrowser() {
  if ((await chrome.storage.local.get('captureToken')).captureToken) return { ok: true };
  connectionRequest ??= post('connect', {}, { authenticated: false, timeout: 120_000 })
    .then(async result => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(result.token ?? '')) throw new Error('连接未完成，请升级见藏后重试。');
      await chrome.storage.local.set({ captureToken: result.token });
      return { ok: true };
    }).finally(() => { connectionRequest = undefined; });
  return connectionRequest;
}

async function automaticDragEnabled() {
  const { automaticDragEnabled: enabled, automaticDragOrigins } = await chrome.storage.local.get([
    'automaticDragEnabled', 'automaticDragOrigins',
  ]);
  if (typeof enabled === 'boolean') return enabled;
  return !Array.isArray(automaticDragOrigins) || automaticDragOrigins.length > 0;
}

function hasSiteAccess(url) {
  if (!httpURL(url)) return Promise.resolve(false);
  const { hostname, protocol } = new URL(url);
  return chrome.permissions.contains({ origins: [protocol + '//' + hostname + '/*'] });
}

function syncAutomaticDrag(updateOpenTabs = false) {
  const operation = automaticRegistration.then(async () => {
    const enabled = await automaticDragEnabled();
    const installed = await chrome.scripting.getRegisteredContentScripts({ ids: [automaticId] });
    if (enabled) {
      if (!installed.length) {
        await chrome.scripting.registerContentScripts([{
          id: automaticId, matches: webPagePatterns, js: ['collector.js'],
          runAt: 'document_start', persistAcrossSessions: true,
        }]);
      }
    } else if (installed.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [automaticId] });
    }
    if (!updateOpenTabs) return;
    const tabs = await chrome.tabs.query({}).catch(() => []);
    tabs.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
    for (let offset = 0; offset < tabs.length; offset += 12) {
      await Promise.allSettled(tabs.slice(offset, offset + 12).map(async tab => {
        if (!Number.isInteger(tab.id)) return;
        let enabledInTab = enabled && await hasSiteAccess(tab.url);
        if (enabledInTab) {
          try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['collector.js'], injectImmediately: true });
          } catch { enabledInTab = false; }
        }
        await chrome.tabs.sendMessage(tab.id, { type: 'jiancang:auto-drag-mode', enabled: enabledInTab }, { frameId: 0 });
      }));
    }
  });
  automaticRegistration = operation.catch(() => {});
  return operation;
}

async function setAutomaticDrag(enabled) {
  await chrome.storage.local.set({ automaticDragEnabled: enabled });
  await syncAutomaticDrag(true);
  return { ok: true, enabled };
}

async function collectorTargets(connect, allowCache) {
  if (connect) await connectBrowser();
  if (allowCache && cachedTargets && cachedTargets.expires > Date.now()) return cachedTargets.result;
  if (!targetRequest) {
    targetRequest = post('targets', {}).then(result => {
      if (result.confirmedCapture !== true) throw new Error('请先将见藏升级到 0.36.9 或更新版本。');
      cachedTargets = { result, expires: Date.now() + 12_000 };
      return result;
    }).finally(() => { targetRequest = undefined; });
  }
  return targetRequest;
}

function destinationKey({ targetId, libraryId, collectionId }) {
  return JSON.stringify([targetId, libraryId, collectionId]);
}

async function readCaptureUsage() {
  const { [usageKey]: saved } = await chrome.storage.local.get(usageKey);
  const records = Array.isArray(saved?.destinations) ? saved.destinations : [];
  const destinations = new Map(records.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' &&
    Array.isArray(entry[1]) && entry[1].length === 2 && entry[1].every(Number.isSafeInteger)));
  return { destinations, receipts: Array.isArray(saved?.receipts) ? saved.receipts : [] };
}

async function rankedCollectorTargets(connect, allowCache) {
  const result = await collectorTargets(connect, allowCache);
  try {
    await captureUsageWrites;
    const { destinations } = await readCaptureUsage();
    if (!destinations.size) return result;
    const none = [0, 0];
    const libraries = result.libraries.map(library => {
      const ranked = library.collections.map(collection => ({ collection,
        usage: destinations.get(destinationKey({ ...library, collectionId: collection.id })) ?? none }));
      ranked.sort((left, right) => right.usage[0] - left.usage[0] || right.usage[1] - left.usage[1]);
      return { ...library, collections: ranked.map(({ collection }) => collection) };
    });
    return { ...result, libraries };
  } catch { return result; }
}

function rememberCaptureDestination({ target }, requestId) {
  if (!target.collectionId) return Promise.resolve();
  captureUsageWrites = captureUsageWrites.then(async () => {
    const { destinations, receipts } = await readCaptureUsage();
    if (receipts.includes(requestId)) return;
    const key = destinationKey(target);
    const count = destinations.get(key)?.[0] ?? 0;
    const recent = [...destinations.values()].at(-1)?.[1] ?? 0;
    destinations.delete(key);
    destinations.set(key, [Math.min(Number.MAX_SAFE_INTEGER, count + 1), Math.max(Date.now(), recent + 1)]);
    await chrome.storage.local.set({ [usageKey]: {
      destinations: [...destinations].slice(-destinationHistoryLimit),
      receipts: [...receipts.slice(1 - captureReceiptLimit), requestId],
    } });
  }).catch(() => {
    // The confirmed capture is still successful if local history cannot be saved.
  });
  return captureUsageWrites;
}

// Executed in the clicked document. Same-origin reads can reuse that site's login.
async function readBrowserImage(rawURL) {
  const url = new URL(rawURL, document.baseURI);
  const sameOrigin = url.origin === location.origin;
  if ((!sameOrigin && url.protocol === 'blob:') || !['http:', 'https:', 'blob:'].includes(url.protocol) ||
      url.username || url.password) return null;
  const limit = 32 * 1024 ** 2;
  const response = await fetch(url, { credentials: sameOrigin ? 'same-origin' : 'omit', cache: 'force-cache',
    mode: sameOrigin ? 'same-origin' : 'cors', redirect: sameOrigin ? 'follow' : 'error', referrerPolicy: 'same-origin',
    signal: AbortSignal.timeout(8000) });
  const contentType = response.headers.get('content-type')?.split(';')[0].trim();
  const safeRaster = /^image\/(?:png|jpe?g|gif|webp|bmp|x-ms-bmp|avif)$/i;
  if (!response.ok || !safeRaster.test(contentType ?? '') || Number(response.headers.get('content-length')) > limit) return null;
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const image = new Blob(chunks, { type: contentType });
  return new Promise((resolve, reject) => {
    const fileReader = new FileReader();
    fileReader.onload = () => resolve({ data: fileReader.result, resolvedImageURL: response.url });
    fileReader.onerror = () => reject(fileReader.error);
    fileReader.readAsDataURL(image);
  });
}

async function imageContent(clicked, url) {
  if (!Number.isInteger(clicked.tabId) || !/^(?:https?:|blob:)/.test(url)) return undefined;
  try {
    const target = clicked.documentId ? { tabId: clicked.tabId, documentIds: [clicked.documentId] } :
      { tabId: clicked.tabId, frameIds: [clicked.frameId ?? 0] };
    const [result] = await chrome.scripting.executeScript({
      target, func: readBrowserImage, args: [url],
    });
    return typeof result?.result?.data === 'string' ? result.result : undefined;
  } catch { return undefined; }
}

async function waitForCapture(result, payload) {
  const end = Date.now() + 65_000;
  let recovered = false;
  while (result.pending) {
    if (Date.now() >= end) throw new Error('见藏仍在处理。可以重试查询，重复提交不会多保存一份。');
    await new Promise(resolve => setTimeout(resolve, 900));
    try { result = await post('capture-status', { requestId: payload.requestId }, { timeout: 12_000 }); }
    catch (error) {
      if (error.status !== 404 || recovered) throw error;
      recovered = true;
      result = await post('capture', payload);
    }
  }
  if (!result.assetId || !result.target) throw new Error('见藏尚未确认保存结果，请重试查询。');
  return result;
}

async function finishCapture(result, requestId, quiet) {
  await rememberCaptureDestination(result, requestId);
  if (!quiet) await announceCapture(result, requestId);
  return result;
}

async function capture(payload, clicked, { quick = true, retry = false, quiet = false } = {}) {
  activeCaptures++;
  try {
    await connectBrowser();
    await collectorTargets(false, true);
    payload.requestId ??= crypto.randomUUID();
    if (retry) {
      const result = await post('capture-status', { requestId: payload.requestId }, { timeout: 12_000 }).catch(error => {
        if (![404, 409].includes(error.status)) throw error;
      });
      if (result?.assetId && result.target && !result.pending) {
        return await finishCapture(result, payload.requestId, quiet);
      }
    }
    if (payload.kind === 'image' && clicked) {
      if (typeof payload.url !== 'string' || !/^(?:https?:|blob:|data:image\/)/i.test(payload.url)) {
        throw new Error('无法读取这张图片，请尝试使用右键采集。');
      }
      const image = await imageContent(clicked, payload.url);
      payload.imageData = image?.data;
      payload.resolvedImageURL = httpURL(image?.resolvedImageURL);
      if (!payload.imageData && payload.url.startsWith('blob:')) throw new Error('浏览器无法读取此图片，请先另存图片。');
    } else if (!httpURL(payload.url)) {
      throw new Error('当前内容无法采集，请打开网页后重试。');
    }
    const result = await waitForCapture(await post('capture', payload), payload);
    return await finishCapture(result, payload.requestId, quiet);
  } catch (error) {
    if (quick) await announce(false, error.message || '采集未完成，请重试。');
    return { ok: false, message: error.message || '采集未完成，请重试。', status: error.status };
  } finally {
    activeCaptures--;
  }
}

async function toggleCollector(tab) {
  if (!Number.isInteger(tab.id) || !httpURL(tab.url)) {
    await announce(false, '请在普通网页里打开采集面板。');
    return;
  }
  try {
    const [page] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['collector.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'jiancang:collector-toggle' },
      page?.documentId ? { documentId: page.documentId } : { frameId: 0 });
  } catch {
    await announce(false, '此页面暂时无法打开采集面板。普通网页仍可用右键采集。');
  }
}

function browserMessage(message, sender) {
  if (sender.id !== chrome.runtime.id) return;
  if (sender.url === optionsPage) {
    if (message?.type === 'jiancang:connect') return connectBrowser();
    if (message?.type === 'jiancang:auto-drag-set') return setAutomaticDrag(message.enabled === true);
    if (message?.type === 'jiancang:auto-drag-status') {
      return automaticDragEnabled().then(enabled => ({ ok: true, enabled }));
    }
  }
  const pageURL = httpURL(sender.url);
  if (!pageURL || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0) return;
  switch (message?.type) {
    case 'jiancang:auto-drag-status':
      return automaticDragEnabled().then(async enabled => ({ ok: true, enabled: enabled && await hasSiteAccess(pageURL) }));
    case 'jiancang:collector-options':
      return chrome.runtime.openOptionsPage().then(() => ({ ok: true }));
    case 'jiancang:collector-targets':
      return rankedCollectorTargets(message.connect === true, message.allowCache === true);
    case 'jiancang:collector-route': {
      const kind = message.kind === 'image' ? 'image' : 'page';
      return post('route', { kind, url: kind === 'image' ? httpURL(message.url) : pageURL,
        pageURL, sourceLink: httpURL(message.sourceLink) }, { timeout: 5_000 });
    }
    case 'jiancang:collector-batch-tone':
      return post('capture-status', { requestId: message.requestId }, { timeout: 5_000 }).then(result => {
        if (result.assetId && result.target) playCaptureSound(message.requestId);
        return { ok: true };
      });
    case 'jiancang:collector-collection':
      return post('collection', { name: message.name, target: message.target }).then(result => {
        cachedTargets = undefined;
        return result;
      });
    case 'jiancang:collector-image':
      return capture({ kind: 'image', url: message.url, pageURL, sourceLink: httpURL(message.sourceLink),
        target: message.target, requestId: message.requestId },
        { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId },
        { quick: false, retry: message.retry === true, quiet: message.batch === true });
    case 'jiancang:collector-page':
      return capture({ kind: 'page', url: pageURL, title: sender.tab.title || message.title, target: message.target, requestId: message.requestId },
        null, { quick: false, retry: message.retry === true });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const result = browserMessage(message, sender);
  if (!result) return false;
  result.then(sendResponse, error => sendResponse({ ok: false, message: error.message, status: error.status }));
  return true;
});

chrome.action.onClicked.addListener(tab => void toggleCollector(tab));

async function captureContextImage(info, tab) {
  const clicked = { tabId: tab?.id, frameId: info.frameId ?? 0 };
  const pageURL = httpURL(info.frameUrl || info.pageUrl || tab?.url);
  const context = Number.isInteger(clicked.tabId) ? await chrome.tabs.sendMessage(clicked.tabId,
    { type: 'jiancang:context-image-source', url: info.srcUrl }, { frameId: clicked.frameId }).catch(() => null) : null;
  return capture({ kind: 'image', url: info.srcUrl, pageURL, sourceLink: httpURL(context?.sourceLink || info.linkUrl) }, clicked);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  switch (info.menuItemId) {
    case 'save-image':
      if (info.srcUrl) void captureContextImage(info, tab);
      break;
    case 'save-link':
      if (info.linkUrl) void capture({ kind: 'link', url: info.linkUrl });
      break;
    case 'save-page':
      void capture({ kind: 'page', url: info.pageUrl || tab?.url, title: tab?.title });
      break;
    case 'settings':
      void chrome.runtime.openOptionsPage();
      break;
  }
});
