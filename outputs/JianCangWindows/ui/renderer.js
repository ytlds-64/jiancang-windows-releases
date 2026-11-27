'use strict';

const byId = id => document.getElementById(id);
const bridge = window.jiancang;
const labels = Object.freeze({ image: '图片', video: '视频', audio: '音频', pdf: 'PDF', document: '文件', link: '链接' });
const directlyPreviewableVideo = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv']);
const originalImageFormats = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico']);
const icons = Object.freeze({
  all: 'M4 6h16v13H4zM8 3h8M7 15l3-3 3 3 2-2 2 2',
  star: 'm12 3 2.8 5.6 6.2.9-4.5 4.4 1.1 6.1-5.6-2.9-5.6 2.9 1.1-6.1-4.5-4.4 6.2-.9z',
  tray: 'M4 8h16l2 8v3H2v-3zM2 16h6l2 2h4l2-2h6',
  trash: 'M4 6h16M9 6V4h6v2m3 0-1 14H7L6 6m4 4v6m4-6v6',
  folder: 'M3 7h7l2 2h9v11H3z',
  folderOpen: 'M3 19V6h7l2 2h8v4M3 19l3-8h16l-3 8z',
  search: 'M16.6 16.6 21 21M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0z',
  refresh: 'M20.5 9A8.5 8.5 0 0 0 6 5.2L3.5 8M3.5 8V3M3.5 8H9m-5.5 7A8.5 8.5 0 0 0 18 18.8l2.5-2.8m0 0v5m0-5H15',
  close: 'm6 6 12 12M18 6 6 18',
  chevronLeft: 'm15 5-7 7 7 7',
  chevronRight: 'm9 5 7 7-7 7',
  chevronDown: 'm5 9 7 7 7-7',
  external: 'M13 4h7v7m0-7-9 9m0-8H5v14h14v-6',
  export: 'M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4',
  expand: 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5',
  image: 'M3 5h18v14H3zM3 16l5-5 5 5 3-3 5 4M15 9h.1',
  video: 'M3 6h13v12H3zm13 4 5-3v10l-5-3',
  livePhoto: 'M12 3v.1m6.4 2.5.1.1M21 12h.1m-2.7 6.4.1.1M12 21v.1m-6.4-2.7-.1.1M3 12h.1m2.5-6.4.1-.1M17.5 12a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Zm-3.5 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  audio: 'M9 18V6l11-2v12m-11 2a3 2 0 1 1-6 0 3 2 0 1 1 6 0zm11-2a3 2 0 1 1-6 0 3 2 0 1 1 6 0z',
  link: 'm9 15 6-6m-4 9-2 2a3.6 3.6 0 0 1-5-5l4-4a3.6 3.6 0 0 1 5 0m0-5 2-2a3.6 3.6 0 0 1 5 5l-4 4a3.6 3.6 0 0 1-5 0',
  document: 'M5 3h9l5 5v13H5zm9 0v6h5M8 13h8m-8 4h8',
  cloud: 'M7 18h11a4 4 0 0 0 0-8h-.5a6 6 0 0 0-11.6 1 3.5 3.5 0 0 0 1.1 7z',
  cloudDownload: 'M18 17a4 4 0 0 0 0-8h-.5a6 6 0 0 0-11.5 1.2A3.5 3.5 0 0 0 6 17m6-4v9m-3-3 3 3 3-3',
  plus: 'M12 5v14M5 12h14',
  back: 'M20 12H4m7-7-7 7 7 7',
  inspector: 'M3 5h18v14H3zM15 5v14',
  layout: 'M3 4h7v10H3zM14 4h7v6h-7zM3 17h7v3H3zM14 13h7v7h-7z',
  captions: 'M4 5h16v10H4zM8 19h8',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
  eagle: 'M3 7h18v12H3zM6 7V4h12v3M8 13h8m-6 3h4',
  warning: 'M12 3 2 20h20L12 3zm0 6v5m0 3h.01',
  moon: 'M20.4 15.1A8.7 8.7 0 0 1 8.9 3.6a8.8 8.8 0 1 0 11.5 11.5Z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4',
  libraries: 'M3 5h18v14H3zM8 5v14m5-10h5m-5 4h5',
  check: 'm5 12 4 4 10-10',
  multiselect: 'M5 4h14v16H5zM8 12l3 3 5-6',
  compare: 'M3 5h18v14H3zM12 5v14m-7-4 2-3 2 3m6 0 2-3 2 3',
  untagged: 'M3 4h8l9 9-7 7-9-9V4Zm4 3h.01M4 21 20 5',
  history: 'M3 5v6h6M3.8 10.4A8.5 8.5 0 1 1 5 17m7-9v4l3 2',
  pin: 'm9 4 9 9m-8-8 6-2 5 5-2 6m-9-9L8 9l-4 1 10 10 1-4 4-2M9 15l-6 6',
  drag: 'M4 4h10v10H4zm10 3h6v13H7v-6m7 0 6 6',
  copy: 'M8 8h12v12H8zM16 5V4H4v12h1',
  undo: 'M8 4 3 9l5 5M3 9h11a5 5 0 0 1 0 10h-3',
  redo: 'M16 4l5 5-5 5m5-5H10a5 5 0 0 0 0 10h3',
  edit: 'M13 7l4 4M4 20l4.5-1L20 7l-4-4L4.5 15z',
  trim: 'M7 4H4v16h3m10-16h3v16h-3M9 12h6',
  help: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M9.5 9a2.5 2.5 0 1 1 4 2c-1.1.8-1.5 1.3-1.5 2.5m0 3h.01',
});

const sections = [
  { id: 'all', title: '全部素材', icon: 'all' },
  { id: 'favorites', title: '收藏', icon: 'star' },
  { id: 'stash', title: '暂存选片', icon: 'multiselect' },
  { id: 'unfiled', title: '未分类', icon: 'tray' },
  { id: 'untagged', title: '未标注', icon: 'untagged' },
  { id: 'recent', title: '最近查看', icon: 'history' },
  { id: 'trash', title: '回收站', icon: 'trash' },
];
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' });
const listDateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
const syncDateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' });
const counts = new Intl.NumberFormat('zh-CN');
const searchInput = byId('search-input');
const gallery = byId('asset-grid');
const scrollingGallery = byId('gallery-scroll');
const workspace = byId('workspace');
const startupPage = byId('workspace-startup');
const startupMessage = byId('workspace-startup-message');
const retryStartup = byId('retry-workspace-startup');
const preview = byId('preview-panel');
const browser = byId('browser');
const viewerElement = byId('viewer');
const viewerToolbar = viewerElement.querySelector('.viewer-toolbar');
const windowsCaption = window.jiancang.windowsCaption === true;
document.body.toggleAttribute('data-windows-caption', windowsCaption);
if (windowsCaption) workspace.before(viewerToolbar);
const viewerViewport = byId('viewer-viewport');
const viewerMedia = byId('viewer-media');
const librariesDialog = byId('libraries-dialog');
const warningsDialog = byId('warnings-dialog');
const exportDialog = byId('export-results-dialog');
const compareDialog = byId('compare-dialog');
const shortcutDialog = byId('shortcut-dialog');
const appMenu = byId('app-menu');
let comparison;
const directories = new Map();
const children = new Map();
const totals = new Map();
const openedCollections = new Set();
const assetById = new Map();
const favoriteWrites = new Map();
const trashWrites = new Map();
let trashPreviewScheduled = false;
const collectionDragType = 'application/x-jiancang-collection-asset';
let collectionDrag = null;
let collectionDropRow = null;

let state = { library: null, libraries: [], catalogs: [], activeLibraryId: null, message: null };
let browseCatalog = null;
let lastCatalogKey;
let libraryRowsKey;
let navigationShapeKey;
let section = 'all';
let collectionId = null;
let selectedId = null;
let selectionKey = '';
let restoreFocus = null;
let busy = false;
let toastTimer;
let visibleAssets = [];
let visibleImports = [];
let previewableAssets = [];
const previewIndices = new Map();
let viewer = null;
let viewerRemoval = null;
let viewerMotion;
let zoomFrame = 0;
let batchMode = false;
let batchWorking = false;
let crossLibraryWrite = false;
let keyboardRatingPending = false;
let deferredLibraryState = null;
let batchAnchor;
const batchIds = new Set();
let marqueeSelection = null;
let batchInspectorDraft;
const catalogProjection = new Map();
const mediaLoads = new WeakMap();
const livePhotoPlayers = new WeakMap();
const livePhotoLoops = new Set();
const pdfPreviews = new WeakMap();
const pdfPages = new Map();
const retryKeys = new Map();
const preparedDragCopies = new Map();
let preparingCopy;
let nativeDragToken;
let syncPanelId = null;
let syncPanelBusy = false;
let syncPanelError = null;
let beforeSmart = null;
const navigationHistory = { back: [], forward: [] };
const navigationHistoryLimit = 80;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const collectionOrder = window.createJianCangCollectionOrder({ tree: byId('collection-tree'), reduceMotion,
  getItem: id => directories.get(id),
  getSiblings: item => children.get(directories.has(item.parentId) ? item.parentId : null) || [],
  render: renderNavigation, announce: showToast });
const collectionFinder = window.createJianCangCollectionFinder({ dialog: byId('collection-finder'),
  getLibraries: () => catalogEntries().map(entry => {
    const { libraryId: registrationId, library } = entry;
    return { registrationId, id: library.libraryId, kind: library.kind, name: library.directoryName,
      collections: library.collections, revision: catalogKey(entry) };
  }), onPick: openFoundCollection });
const listHeader = byId('asset-list-header');
const sortSelect = byId('sort-select');
const continuous = window.createContinuousGallery({ gallery, scroller: scrollingGallery, listHeader, makeCard, cardKey, updateCard });
const audioCardPreview = window.createJianCangAudioCardPreview({ gallery, scroller: scrollingGallery,
  enabled: () => !viewer && !batchMode && !document.querySelector('dialog[open]') });
const cancelMarquee = continuous.selectMarquee({
  getSelection: currentSelectionIds,
  onPreview(ids) {
    marqueeSelection = ids;
    if (!preview.hidden) renderBatchInspector();
  },
  onCancel() {
    marqueeSelection = null;
    renderInspector();
  },
  onSelect(ids) {
    marqueeSelection = null;
    applyAssetSelection(ids, null);
    batchAnchor = selectedId;
  },
});
const assetFilters = window.createJianCangFilters({ kind: byId('kind-filter'), onChange: resetGallery });
const boards = window.createJianCangProjectBoards({ getAssets: () => visibleAssets, getAsset: boardAsset,
  getImage: asset => assetURL('board-image', asset), exportBoard: bridge.exportBoard,
  getLibraries: () => state.libraries, importProject: bridge.importBoardProject, bridge,
  exportOriginals: board => exportTools.openBoard(board), notify: showToast });
const suggestionTools = window.createJianCangAssetSuggestions({ bridge, notify: showToast,
  openEagleWrite: id => configureEagleWrite(id, true),
  openSyncStatus(id) {
    openSyncPanel(id);
    const panel = byId('sync-write-dialog');
    if (!panel.open) throw new Error('此同步库已断开，请重新连接后检查。');
    return new Promise(resolve => panel.addEventListener('close', resolve, { once: true }));
  },
  copyAsset({ registrationId, id }) {
    const catalog = catalogEntries().find(entry => entry.libraryId === registrationId);
    const asset = catalog && projectedCatalog(catalog).assets.find(item => item.sourceAssetId === id);
    if (!asset || asset.trashed) { showToast('此素材已不可用。'); return; }
    void intake.open({ assets: [asset] });
  },
});
const readingDiagnostics = window.createJianCangLibraryDiagnostics({ dialog: warningsDialog, notify: showToast,
  refresh: id => requestState('refresh', id),
  relocate: id => requestState('relocateLibrary', id),
  reveal: id => bridge.revealLibrary(id),
  revealItem: (id, revision, index) => bridge.revealReadingItem(id, revision, index),
  retrieve: (id, ids) => cloudTools.open(id, ids ? { ids } : undefined),
  locate: locateReadingAsset,
});
const visual = window.createJianCangVisualTools({ bridge, getAssets: visualScopeAssets,
  getAllAssets: () => browseCatalog?.assets || [], refFor: visualReference, notify: showToast,
  onChange({ refresh = false } = {}) {
    selectionKey = '';
    if (!refresh) resetGallery();
    else if (visual.active || searchInput.value.trim()) renderGallery({ animate: false, preserveViewport: true });
    else renderInspector();
  },
});
const naturalSearch = window.createJianCangNaturalImageSearch({ bridge, refFor: visualReference,
  scope() {
    const selection = currentSelectionIds();
    const current = visibleAssets.filter(asset => !asset.trashed && (asset.kind === 'image' || asset.extension === 'livp'));
    const selected = current.filter(asset => selection.has(asset.id));
    return { current, ...(selected.length > 0 && { selected }) };
  },
  getAsset: naturalSearchAsset,
  getImage: asset => assetURL('board-image', asset),
  openAsset(reference, dialog) {
    const asset = naturalSearchAsset(reference);
    if (!asset || !canPreview(asset) || !visibleAssets.some(item => item.id === asset.id)) return false;
    dialog.close();
    if (batchMode) selectAsset(asset.id);
    openViewer(asset, continuous.renderedCard(asset.id));
    return true;
  },
  async openSettings() {
    await suggestionTools.settings();
    const settings = byId('asset-suggestion-settings');
    if (settings?.open) await new Promise(resolve => settings.addEventListener('close', resolve, { once: true }));
  },
});
const assetSearch = window.createJianCangAssetSearch({ input: searchInput, shell: byId('search-shell'),
  onChange: resetGallery, recognizedText: asset => visual.record(asset)?.text });
const smart = window.createJianCangSmartCollections({ list: byId('smart-collection-list'),
  capture: captureView, apply: applySmartCollection, describe: describeSmartCollection,
  onChange: () => { renderNavigation(); renderGallery({ animate: false }); },
  notify: showToast, bridge, getLibraries: () => state.libraries,
  recognizedText: asset => visual.record(asset)?.text,
  getCountScope: smartCollectionCountScope,
  favorite: asset => favoriteWrites.get(asset.id)?.listed ?? asset.favorite,
  makeRow(item, selected, onSelect, onMenu) {
    const { row, button } = makeNavRow(item.name, item.record ? 'cloud' : 'search', 0, selected, onSelect);
    if (item.record) button.title = `${item.name} · ${item.library.name}同步库`;
    button.querySelector('.navigation-number').remove();
    row.classList.add('collection-row');
    row.dataset.smartCollectionId = item.id;
    const more = makeButton('', 'more', 'icon-button collection-menu-button', onMenu);
    more.setAttribute('aria-label', `管理智能集合 ${item.name}`);
    row.append(more);
    row.addEventListener('contextmenu', event => { event.preventDefault(); onMenu(); });
    return row;
  },
});
const organizer = window.createJianCangLocalOrganizer({ mutate: mutateLocal, notify: showToast,
  onBatchWrite: setCrossLibraryWrite, onImmediateWrite: renderLocalControls });
const tags = window.createJianCangTagManager({
  getLibraries: () => state.libraries.filter(entry => catalogEntries().some(loaded => loaded.libraryId === entry.id))
    .map(entry => ({ id: entry.id, name: libraryName(entry), writable: isWritable(entry) })),
  getAssets: id => catalogEntries().find(entry => entry.libraryId === id)?.library.assets || [],
  getCurrentLibraryId: () => scopeId || directories.get(collectionId)?.sourceLibraryId || collectionId?.split(':')[0] || null,
  mutate: mutateLocal, onFilter: filterByManagedTag, notify: showToast,
});
const duplicates = window.createJianCangDuplicateReview({ bridge,
  getScope: () => ({ title: byId('gallery-title').textContent, assets: visibleAssets }),
  getAsset: boardAsset, getImage: asset => assetURL('board-image', asset),
  canTrash: asset => asset.available && !asset.trashed && writableAsset(asset),
  canMerge: asset => !!asset?.available && !asset.trashed && state.libraries.some(entry =>
    entry.id === asset.sourceLibraryId && entry.kind === 'local' && entry.status !== 'unavailable'),
  compare: openImageComparison, notify: showToast,
});
const inboxTools = window.createJianCangFolderInbox({ bridge, getCollections: localCollections, notify: showToast,
  getLibraries: () => state.libraries.filter(entry => entry.status === 'available' &&
    (entry.kind === 'local' || entry.kind === 'jiancang' && isWritable(entry) && !entry.syncLogIncomplete)),
});
const browserCaptureTools = window.createJianCangBrowserCapture({ bridge, getCollections: localCollections,
  getDefaultTarget: localTarget, notify: showToast,
  getLibraries: () => state.libraries.filter(entry => entry.status === 'available' && isWritable(entry) && !entry.syncLogIncomplete),
});
const offlineReader = window.createJianCangOfflineWeb({ bridge, notify: showToast });
const exportTools = window.createJianCangStructuredExport({ bridge, notify: showToast });
const imageConversion = window.createJianCangImageConversion({ bridge });
const imageTools = window.createJianCangImageTools({ bridge, getImage: asset => assetURL('edit-image', asset),
  getContentRevision: assetContentRevision,
  convertLargeImage: asset => imageConversion.open([asset]),
  canReplace: asset => asset.sourceKind === 'local' && Boolean(asset.mediaRevision) && writableAsset(asset),
  getSyncLibraryId: asset => state.libraries.find(entry => entry.id === asset.sourceLibraryId && entry.kind === 'jiancang' && isWritable(entry))?.libraryId,
  notify: showToast });
const videoTrim = window.createJianCangVideoTrim({ bridge,
  getVideo: asset => directlyPreviewableVideo.has(asset.extension) ? assetURL('video', asset) : '',
  getPoster: asset => asset.thumbnailAvailable ? assetURL('thumbnail', asset) : '', notify: showToast });
const backupTools = window.createJianCangLocalBackup({ bridge, notify: showToast,
  getLibraries: () => state.libraries.filter(entry => entry.kind === 'local'),
  onRestored: async result => {
    if (result.state) setState(result.state);
    if (result.registrationId) selectScope(result.registrationId);
    if (result.message) showToast(result.message);
  } });
const cloudTools = window.createJianCangCloudOriginals({ bridge, getLibraries: cloudLibraries, notify: showToast });
const storageTools = window.createJianCangStorageManagement({ bridge, notify: showToast });
const syncConflicts = window.createJianCangSyncConflicts({ bridge, notify: showToast });
const intake = window.createJianCangLocalIntake({ bridge, getLibraries: writableLibraries, getCopyLibraries: copyDestinations, getCollections: localCollections,
  getTarget: localTarget, getDropTarget: currentLibraryTarget, getPreviewScope: importPreviewScope,
  hasImportedAsset: hasImportPreviewResult, onPreviewChange: () => renderGalleryGrid({ importsOnly: true, preserveViewport: true }),
  collectionDragType, onCreated(next, id) {
    if (librariesDialog.open) librariesDialog.close();
    state = next;
    void selectScope(id);
    showToast('已新建本地素材库。');
  }, notify: showToast });
const preferredSize = byId('thumbnail-size');
const layoutSelect = byId('layout-select');
const inspectorHandle = byId('inspector-resize');
const sidebarHandle = byId('sidebar-resize');
const librarySidebar = byId('library-sidebar');
const preferencesKey = 'jiancang.workspace.v1';
const preferences = loadPreferences();
const selectionStashKey = 'jiancang.selection-stash.v1';
const selectionStash = readSelectionStash();
const savedWorkspaces = window.createJianCangBrowseWorkspace(localStorage);
let scopeId = preferences.scopeId;
let workspaceRestorePending = true;
let workspaceSaveTimer;
let reverseSort = false;
const recentlyViewed = new Map(preferences.recent);
let lastViewTime = Math.max(0, ...recentlyViewed.values());

function loadPreferences() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(preferencesKey) || '{}') || {}; }
  catch { /* Workspace preferences are optional. */ }
  const recent = Array.isArray(saved.recent) ? saved.recent.filter(entry => Array.isArray(entry) &&
    typeof entry[0] === 'string' && Number.isFinite(entry[1])).slice(-200) : [];
  return {
    layout: ['rows', 'list'].includes(saved.layout) ? saved.layout : 'masonry',
    tileSize: clamp(Number(saved.tileSize) || 170, 108, 310),
    captions: saved.captions !== false,
    inspector: saved.inspector !== false,
    inspectorWidth: clamp(Number(saved.inspectorWidth) || 310, 228, 520),
    sidebarWidth: Number.isFinite(saved.sidebarWidth) ? clamp(saved.sidebarWidth, 152, 420) : null,
    theme: saved.theme === 'light' ? 'light' : 'dark',
    autoAdvanceRating: saved.autoAdvanceRating === true,
    scopeId: typeof saved.scopeId === 'string' ? saved.scopeId : null,
    recent,
  };
}

function savePreferences() {
  try { localStorage.setItem(preferencesKey, JSON.stringify(preferences)); }
  catch { /* A read-only profile can still use the current settings. */ }
}

function readSelectionStash() {
  try {
    const saved = JSON.parse(localStorage.getItem(selectionStashKey) || '[]');
    if (Array.isArray(saved)) return new Set(saved.filter(id => typeof id === 'string' && id));
  } catch { /* A malformed local record is treated as an empty list. */ }
  return new Set();
}

function updateSelectionStash(assets, action) {
  const next = action === 'clear' ? new Set() : new Set(selectionStash);
  for (const asset of assets) {
    if (action === 'remove') next.delete(asset.id);
    if (action === 'add' && !asset.trashed) next.add(asset.id);
  }
  const changed = Math.abs(next.size - selectionStash.size);
  if (!changed) return;
  try { localStorage.setItem(selectionStashKey, JSON.stringify([...next])); }
  catch { showToast('暂存清单未能保存，请重试。'); return; }
  selectionStash.clear();
  for (const id of next) selectionStash.add(id);
  refreshNavigationCounts();
  if (section === 'stash') renderGallery({ animate: false, preserveViewport: true });
  const quantity = counts.format(changed);
  showToast(action === 'clear' ? '已清空暂存选片。'
    : action === 'add' ? `已暂存 ${quantity} 项素材。` : `已移出 ${quantity} 项暂存素材。`);
}

function rememberView(asset) {
  if (asset.trashed) return;
  const isNew = !recentlyViewed.has(asset.id);
  recentlyViewed.delete(asset.id);
  lastViewTime = Math.max(lastViewTime + 1, Date.now());
  recentlyViewed.set(asset.id, lastViewTime);
  const evicted = recentlyViewed.size > 200 ? recentlyViewed.keys().next().value : null;
  if (evicted) recentlyViewed.delete(evicted);
  preferences.recent = [...recentlyViewed];
  savePreferences();
  if (isNew) {
    const expired = assetById.get(evicted);
    const count = (totals.get('recent') || 0) + 1 - (expired && !expired.trashed ? 1 : 0);
    totals.set('recent', count);
    const counter = byId('library-views').querySelector('[data-section="recent"] .navigation-number');
    if (counter) counter.textContent = counts.format(count);
  }
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== '') element.textContent = text;
  return element;
}

function glyph(name) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', icons[name] || icons.document);
  svg.append(path);
  return svg;
}

for (const element of document.querySelectorAll('[data-icon]')) element.append(glyph(element.dataset.icon));

function makeButton(label, icon, className, listener) {
  const button = node('button', className);
  button.type = 'button';
  if (icon) button.append(glyph(icon));
  if (label) button.append(document.createTextNode(label));
  button.addEventListener('click', listener);
  return button;
}

function motion(element, frames, duration = 170) {
  if (!element || reduceMotion.matches) return;
  return element.animate(frames, { duration, easing: 'cubic-bezier(.2,.72,.3,1)' });
}

function catalogEntries() {
  return state.catalogs?.length ? state.catalogs : state.library && state.activeLibraryId
    ? [{ libraryId: state.activeLibraryId, library: state.library }] : [];
}

function isWritable(entry) {
  return entry?.status !== 'unavailable' && (entry?.kind === 'local' || entry?.syncWritable === true && entry.format === 6);
}

function writableLibraries() { return state.libraries.filter(isWritable); }

function writableAsset(asset) {
  return !!asset && (!trashWrites.has(asset.id) || asset.trashed) &&
    isWritable(state.libraries.find(entry => entry.id === asset.sourceLibraryId));
}

function eagleMetadataWritable(entry) {
  return entry?.kind === 'eagle' && entry.eagleWritable === true && entry.status === 'available';
}

function copyDestinations(assets) {
  const registrations = new Set(assets.map(asset => asset.sourceLibraryId));
  const donors = state.libraries.filter(entry => registrations.has(entry.id));
  const libraryIds = new Set(donors.map(entry => entry.libraryId));
  const roots = new Set(donors.map(entry => entry.root));
  return writableLibraries().filter(entry => !registrations.has(entry.id) &&
    !(entry.libraryId && libraryIds.has(entry.libraryId)) && !(entry.root && roots.has(entry.root)));
}

function canCopyAssets(assets) {
  return assets.length > 0 && assets.every(asset => !asset.trashed) &&
    (assets.every(asset => asset.sourceKind === 'eagle') || copyDestinations(assets).length > 0);
}

function localCollections(id) { return catalogEntries().find(entry => entry.libraryId === id)?.library.collections ?? []; }

function currentLibraryTarget() {
  const folder = directories.get(collectionId);
  const id = folder?.sourceLibraryId || (folder && collectionId.split(':')[0]) || scopeId;
  if (!id) return null;
  return { id, collection: folder && !folder.sourceLibraryId ? collectionId.slice(id.length + 1) : null };
}

function localTarget() {
  const context = currentLibraryTarget();
  return context && isWritable(state.libraries.find(entry => entry.id === context.id)) ? context : null;
}

function importPreviewScope() {
  if (!browseCatalog || !plainBrowseView() || smart.active) return undefined;
  if (section === 'all') {
    return { ids: writableLibraries().map(entry => entry.id).filter(id => scopeId === null || id === scopeId) };
  }
  const target = section === 'collection' && localTarget();
  if (!target) return undefined;
  if (!target.collection) return { ids: [target.id] };
  const descendants = new Set();
  const pending = [collectionId];
  while (pending.length) {
    const id = pending.pop();
    if (descendants.has(id)) continue;
    descendants.add(id);
    for (const child of children.get(id) ?? []) pending.push(child.id);
  }
  return { ids: [target.id], collectionIds: [...descendants].map(id => id.slice(target.id.length + 1)).sort() };
}

function hasImportPreviewResult(task) {
  const id = task.resultId ?? task.assetId;
  if (!id) return false;
  const asset = assetById.get(collectionKey(task.targetId, id));
  return !!asset && !asset.trashed && (!task.collectionId ||
    membershipIncludes(asset, collectionKey(task.targetId, task.collectionId)));
}

function visibleLocalTrash() {
  if (section !== 'trash') return null;
  const scope = scopeId ?? (state.libraries.length === 1 ? state.libraries[0].id : null);
  return catalogEntries().find(entry => entry.libraryId === scope && entry.library.kind === 'local');
}

function localHistory() {
  const id = localTarget()?.id ?? (!scopeId && state.libraries.length === 1 ? state.libraries[0].id : null);
  const target = state.libraries.find(entry => entry.id === id);
  const loaded = catalogEntries().find(entry => entry.libraryId === id);
  if (!isWritable(target) || !loaded) return null;
  if (target.kind === 'jiancang') return { libraryId: id, library: { ...target.writeStatus, revision: target.writeStatus?.historyRevision } };
  return loaded;
}

function runLocalHistory(action) {
  const entry = localHistory();
  if (entry && trashWriteInProgress(entry.libraryId)) {
    showToast('正在写入回收站，请稍后重试。');
    return true;
  }
  if (action === 'undo' && entry?.library.canUndo) {
    void organizer.undo(entry.libraryId);
    return true;
  }
  if (action === 'redo' && entry?.library.canRedo) {
    void organizer.redo(entry.libraryId, entry.library);
    return true;
  }
  return false;
}

function renderLocalControls() {
  const target = localTarget();
  const loaded = target && catalogEntries().find(entry => entry.libraryId === target.id);
  const historyEntry = localHistory();
  const history = historyEntry?.library;
  const writing = organizer.immediatePending || trashWriteInProgress(historyEntry?.libraryId);
  byId('local-import-button').hidden = writableLibraries().length === 0;
  byId('new-local-collection').hidden = !loaded;
  byId('local-undo-button').hidden = byId('local-redo-button').hidden = !history;
  byId('local-undo-button').disabled = writing || !history?.canUndo;
  byId('local-redo-button').disabled = writing || !history?.canRedo;
  const trash = visibleLocalTrash();
  byId('empty-local-trash').hidden = !trash?.library.assets.some(asset => asset.trashed);
  byId('retry-local-trash').hidden = !trash?.library.pendingPurge;
  if (appMenu.matches(':popover-open')) refreshAppMenu();
}

async function mutateLocal(id, command) {
  const write = command.action === 'trash' ? startTrashWrite(id, command.ids) : null;
  const current = currentViewerAsset();
  const affected = current?.sourceLibraryId === id && viewerAssetLeavesView(current, command);
  if (affected) viewerRemoval = { id: current.id, index: previewIndices.get(current.id) };
  try {
    const result = await bridge.mutateLocalLibrary(id, command);
    if (write) {
      if (!result?.ok) finishTrashWrite(write);
      else {
        const acknowledged = result.state && trashCatalog(write, result.state);
        if (!(result.pending > 0) && acknowledged?.hasLiveAsset === true) {
          throw new Error('回收站状态已变化，请刷新后重试。');
        }
        write.status = result.pending > 0 ? 'queued' : 'committed';
        write.queuedRevision = acknowledged?.revision ?? trashCatalog(write).revision;
        reconcileTrashWrites();
      }
    }
    if (!result?.ok && affected && viewerRemoval?.id === current.id) viewerRemoval = null;
    return result;
  } catch (error) {
    if (write) finishTrashWrite(write);
    if (affected && viewerRemoval?.id === current.id) viewerRemoval = null;
    throw error;
  }
}

function trashWriteInProgress(id) {
  return Boolean(id && [...trashWrites.values()].some(write => write.registrationId === id));
}

function renderTrashPreview() {
  if (trashPreviewScheduled) return;
  trashPreviewScheduled = true;
  queueMicrotask(() => {
    trashPreviewScheduled = false;
    if (!browseCatalog) return;
    rebuildNavigation();
    refreshNavigationCounts();
    renderGallery({ animate: false, preserveViewport: true });
    renderLocalControls();
  });
}

function startTrashWrite(registrationId, ids) {
  const entry = state.libraries.find(library => library.id === registrationId);
  const items = new Set(ids);
  const keys = [...items].map(id => collectionKey(registrationId, id));
  if (keys.some(key => trashWrites.has(key))) throw new Error('所选素材正在移到回收站。');
  const write = { registrationId, libraryIdentity: entry?.libraryId, items, keys, status: 'writing' };
  for (const key of keys) trashWrites.set(key, write);
  renderTrashPreview();
  showToast('正在移到回收站…');
  return write;
}

function finishTrashWrite(write) {
  for (const key of write.keys) if (trashWrites.get(key) === write) trashWrites.delete(key);
  renderTrashPreview();
}

function trashCatalog(write, snapshot = state) {
  const catalog = inspectorCatalog({ sourceLibraryId: write.registrationId }, snapshot);
  return {
    revision: catalogKey(catalog),
    hasLiveAsset: catalog.library?.assets.some(asset => write.items.has(asset.id) && !asset.trashed),
  };
}

function reconcileTrashWrites() {
  for (const write of new Set(trashWrites.values())) {
    const entry = state.libraries.find(library => library.id === write.registrationId);
    if (!entry || entry.libraryId !== write.libraryIdentity) { finishTrashWrite(write); continue; }
    if (write.status === 'writing') continue;
    const observed = trashCatalog(write);
    if (observed.hasLiveAsset === false) finishTrashWrite(write);
    else if (observed.hasLiveAsset && write.status === 'queued' && entry.writeStatus?.pending === 0 &&
      !entry.syncLogIncomplete && observed.revision !== write.queuedRevision) {
      finishTrashWrite(write);
      showToast('同步后的回收站状态已变化，请重试。');
    }
  }
}

function viewerAssetLeavesView(asset, command) {
  if (command.action === 'purgeTrash') return asset.trashed && (command.all || command.ids.includes(asset.sourceAssetId));
  if (!command.ids?.includes(asset.sourceAssetId)) return false;
  if (command.action === 'trash') return true;
  if (command.action !== 'edit') return false;
  if (section === 'favorites' && asset.favorite && command.favorite === false) return true;
  if (!command.removeCollectionIds?.includes(collectionId?.slice(asset.sourceLibraryId.length + 1)) ||
    !removableCollection([asset])) return false;
  return !membershipIncludes({ collectionIds: asset.collectionIds.filter(folder => folder !== collectionId) }, collectionId);
}

function catalogKey(entry) { return entry.revision ?? entry.library; }
function collectionKey(libraryId, id) { return `${libraryId}:${id}`; }
function groupKey(id) { return `library:${id}`; }

function projectedCatalog(entry) {
  const { libraryId, library } = entry;
  const key = catalogKey(entry);
  const previous = catalogProjection.get(libraryId);
  if (previous?.key === key) return previous;
  const projected = {
    key,
    libraryId,
    name: library.directoryName,
    assets: library.assets.map(asset => ({
      ...asset, id: collectionKey(libraryId, asset.id), sourceAssetId: asset.id,
      sourceLibraryId: libraryId, sourceName: library.directoryName, sourceKind: library.kind,
      sourceRevision: entry.revision,
      collectionIds: asset.collectionIds.map(id => collectionKey(libraryId, id)),
    })),
    collections: library.collections.map(collection => ({
      ...collection, id: collectionKey(libraryId, collection.id),
      parentId: collection.parentId ? collectionKey(libraryId, collection.parentId) : null,
    })),
  };
  catalogProjection.set(libraryId, projected);
  return projected;
}

function boardAsset(reference) {
  const { id, assetId, registrationId, sourceAssetId, sourceLibraryId } = reference || {};
  const owner = registrationId || sourceLibraryId;
  const source = sourceAssetId || assetId || id;
  if (!source || !owner) return null;
  const existing = assetById.get(collectionKey(owner, source));
  if (existing) return existing.trashed ? null : existing;
  const entry = catalogEntries().find(row => row.libraryId === owner);
  const match = entry && projectedCatalog(entry).assets.find(item => item.sourceAssetId === source);
  return match && !match.trashed ? match : null;
}

function assetContentRevision(asset) {
  return JSON.stringify([asset.mediaRevision || asset.sourceAssetId, asset.byteCount, asset.width, asset.height]);
}

function assetPreviewRevision(asset) {
  return JSON.stringify([assetContentRevision(asset), asset.kind, asset.extension, !!asset.available, !!asset.thumbnailAvailable]);
}

function previewKey(asset) { return JSON.stringify([asset.id, assetPreviewRevision(asset), retryKeys.get(asset.id)]); }

function visualReference(asset) {
  return { registrationId: asset.sourceLibraryId, assetId: asset.sourceAssetId,
    revision: assetContentRevision(asset) };
}

function naturalSearchAsset(reference) {
  const asset = assetById.get(collectionKey(reference.registrationId, reference.assetId));
  return asset && !asset.trashed && assetContentRevision(asset) === reference.revision ? asset : null;
}

function captureView() {
  if (!browseCatalog) return null;
  return { scopeId, section, collectionId, query: searchInput.value,
    searchField: assetSearch.field,
    kind: assetFilters.kind, sort: sortSelect.value, reverseSort,
    advanced: assetFilters.snapshot(), visual: visual.snapshot() };
}

function describeSmartCollection(saved) {
  const knownName = id => {
    const library = state.libraries.find(entry => entry.id === id);
    return library ? libraryName(library) : '暂不可用的素材库';
  };
  const location = saved.scopeId ? knownName(saved.scopeId) : '所有素材库';
  let view = sections.find(item => item.id === saved.section)?.title;
  if (saved.section === 'collection' && saved.collectionId) {
    const [owner] = saved.collectionId.split(':');
    const id = saved.collectionId.slice(owner.length + 1);
    if (owner === 'library') view = knownName(id);
    else {
      const catalog = catalogEntries().find(entry => entry.libraryId === owner);
      const folder = catalog?.library.collections.find(item => item.id === id);
      view = folder ? `集合 · ${saved.scopeId ? '' : `${knownName(owner)} / `}${folder.name}` : '暂不可用的集合';
    }
  }
  const fields = [['范围', view ? `${location} / ${view}` : location]];
  if (saved.query) fields.push(['关键词', `${assetSearch.fieldLabel(saved.searchField)} · ${saved.query}`]);
  fields.push(...assetFilters.describe(saved));
  fields.push(...visual.describe(saved.visual));
  const sort = saved.sort === 'recent' ? (saved.section === 'recent' ? '最近查看' : '最近添加') :
    Array.from(sortSelect.options).find(option => option.value === saved.sort)?.label;
  if (sort) fields.push(['排序', saved.reverseSort ? `${sort}（反向）` : sort]);
  return fields;
}

function useFilterValues(value) {
  assetSearch.restore(value.query, value.searchField);
  assetFilters.kind = value.kind;
  sortSelect.value = value.sort;
  reverseSort = value.reverseSort === true;
  assetFilters.restore(value.advanced, { notify: false });
  visual.restore(value.visual, false);
}

function captureNavigation() {
  const view = captureView();
  if (!view) return null;
  return { view, smartId: smart.active?.id ?? null, beforeSmart, selectedId,
    expanded: [...openedCollections].slice(-256), bookmark: continuous.bookmark() };
}

function pushNavigation(stack, snapshot) {
  if (!snapshot) return;
  if (stack.length >= navigationHistoryLimit) stack.shift();
  stack.push(snapshot);
}

function recordNavigation() {
  const snapshot = captureNavigation();
  if (!snapshot) return;
  pushNavigation(navigationHistory.back, snapshot);
  navigationHistory.forward.length = 0;
  renderNavigationHistory();
}

function availableNavigationIndex(direction) {
  const loaded = new Map(catalogEntries().map(entry => [entry.libraryId, entry]));
  return navigationHistory[direction].findLastIndex(({ view }) => {
    if (!loaded.size || (view.scopeId !== null && !loaded.has(view.scopeId))) return false;
    if (view.section !== 'collection') return true;
    if (!view.collectionId) return false;
    if (view.collectionId.startsWith('library:')) {
      return view.scopeId === null && loaded.size > 1 && loaded.has(view.collectionId.slice('library:'.length));
    }
    const owner = view.collectionId.split(':', 1)[0];
    const entry = loaded.get(owner);
    return !!entry && (view.scopeId === null || view.scopeId === owner) &&
      projectedCatalog(entry).collections.some(item => item.id === view.collectionId);
  });
}

function renderNavigationHistory() {
  for (const direction of ['back', 'forward']) byId(`browse-${direction}`).disabled = availableNavigationIndex(direction) < 0;
}

function goFromNavigationHistory(direction) {
  const index = availableNavigationIndex(direction);
  if (index < 0) return;
  const [next] = navigationHistory[direction].splice(index);
  const opposite = direction === 'back' ? 'forward' : 'back';
  pushNavigation(navigationHistory[opposite], captureNavigation());
  rememberWorkspace();
  assetFilters.close();
  assetSearch.close();
  const scopeChanged = scopeId !== next.view.scopeId;
  const focusWasInViewer = viewerElement.contains(document.activeElement);
  const button = byId(`browse-${direction}`);
  const focusWasOnButton = document.activeElement === button;
  resetScopeNavigation();
  workspaceRestorePending = false;
  scopeId = preferences.scopeId = next.view.scopeId;
  savePreferences();
  section = next.view.section;
  collectionId = next.view.collectionId;
  selectedId = next.selectedId;
  restoreFocus = null;
  for (const id of next.expanded) openedCollections.add(id);
  beforeSmart = smart.restoreActive(next.smartId) ? next.beforeSmart : null;
  useFilterValues(next.view);
  setState({ ...state, message: null }, { scopeChanged, navigationBookmark: next.bookmark });
  rememberWorkspace();
  if (focusWasInViewer || (focusWasOnButton && button.disabled)) {
    const fallback = byId(`browse-${opposite}`);
    (fallback.disabled ? byId('gallery-title') : fallback).focus({ preventScroll: true });
  }
}

function applySmartCollection(item) {
  const saved = item.criteria;
  const entries = catalogEntries();
  if (saved.scopeId && !entries.some(entry => entry.libraryId === saved.scopeId)) {
    showToast('这个智能集合的素材库暂不可用。');
    return false;
  }
  if (saved.section === 'collection' && !buildBrowseCatalog(entries, saved.scopeId).collections.some(folder => folder.id === saved.collectionId)) {
    showToast('这个智能集合引用的集合暂不可用。');
    return false;
  }
  if (smart.active?.id !== item.id) recordNavigation();
  if (!smart.active) {
    rememberWorkspace();
    beforeSmart = captureView();
  }
  workspaceRestorePending = false;
  const scopeChanged = scopeId !== saved.scopeId;
  resetScopeNavigation({ clearExpanded: scopeChanged });
  scopeId = preferences.scopeId = saved.scopeId;
  savePreferences();
  section = saved.section;
  collectionId = saved.collectionId;
  useFilterValues(saved);
  setState({ ...state, message: null }, { scopeChanged });
  revealCollectionAncestors(collectionId);
  return true;
}

function leaveSmartCollection() {
  if (beforeSmart) useFilterValues(beforeSmart);
  beforeSmart = null;
  smart.clear();
}

async function filterByManagedTag(id, tag) {
  recordNavigation();
  await selectScope(id, { record: false });
  selectView('all', null, { record: false });
  assetSearch.restore('');
  assetFilters.kind = 'all';
  visual.restore({}, false);
  assetFilters.restore({ tags: [tag] }, { notify: false });
  resetGallery();
}

function findSourceSite(asset) {
  const hostname = window.jiancangSourceSite(asset.sourceURL);
  if (!hostname) return;
  recordNavigation();
  selectView('all', null, { record: false });
  assetSearch.restore(hostname, 'site');
  assetFilters.kind = 'all';
  assetFilters.restore({}, { notify: false });
  visual.restore({}, false);
  resetGallery();
}

function buildBrowseCatalog(entries, scope = scopeId) {
  const scoped = scope === null ? entries : entries.filter(entry => entry.libraryId === scope);
  const projected = scoped.map(projectedCatalog);
  const needsGroups = scope === null && projected.length > 1;
  const collections = projected.flatMap(part => {
    if (!needsGroups) return part.collections;
    const groupId = groupKey(part.libraryId);
    return [{ id: groupId, name: part.name, parentId: null, sourceLibraryId: part.libraryId },
      ...part.collections.map(item => item.parentId ? item : { ...item, parentId: groupId })];
  });
  return {
    assets: projected.flatMap(part => part.assets),
    collections,
    partial: scoped.some(({ library }) => library.partial === true),
  };
}

function assetURL(host, asset, { playback = false } = {}) {
  const namespace = ['video', 'board-image', 'palette-image', 'edit-image', 'pdf-original', 'text-preview'].includes(host) ? `app/${host}` : host;
  const location = `jiancang://${namespace}/${asset.sourceLibraryId}/${asset.sourceAssetId}`;
  const preview = ['thumbnail', 'original', 'live-motion', 'palette-image', 'pdf-original', 'text-preview'].includes(host);
  if (!playback && !preview && !asset.sourceRevision) return location;
  const query = new URLSearchParams(playback ? { media: assetContentRevision(asset) }
    : preview ? { preview: assetPreviewRevision(asset) } : { revision: asset.sourceRevision });
  const retry = retryKeys.get(asset.id);
  if (retry) query.set('retry', retry);
  return `${location}?${query}`;
}

function canEditImage(asset) {
  return !!asset?.available && !asset.trashed && asset.kind === 'image' &&
    ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif'].includes(asset.extension) && asset.byteCount > 0 && asset.byteCount <= 96 * 1024 ** 2;
}

function canTrimVideo(asset) {
  return !!asset?.available && !asset.trashed && asset.kind === 'video' && asset.byteCount > 0;
}

function openVideoTrim(asset) {
  if (!canTrimVideo(asset)) return;
  const media = viewer?.assetId === asset.id ? viewerMedia.querySelector('video') : undefined;
  media?.pause();
  void videoTrim.open(asset, { startAt: media?.currentTime, notes: window.readJianCangVideoNotes(asset.id) });
}

function showToast(text) {
  if (!text) return;
  const toast = byId('toast');
  toast.textContent = text;
  toast.hidden = false;
  motion(toast, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1 }], 140);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4800);
}

function setBusy(active) {
  busy = active;
  for (const id of ['connect-button', 'refresh-button', 'add-sync-library', 'add-eagle-library', 'open-local-library']) {
    byId(id).disabled = active;
  }
  for (const button of document.querySelectorAll('[data-library-action="relocate"], [data-library-action="remove"]')) button.disabled = active;
  if (appMenu.matches(':popover-open')) refreshAppMenu();
  renderStatus();
}

function renderStatus() {
  const library = browseCatalog;
  const message = busy ? '正在读取素材库…' : state.message;
  const connection = byId('connection-message');
  connection.hidden = !message || !!library;
  connection.textContent = message || '';
  const managementMessage = byId('library-management-message');
  managementMessage.hidden = !message;
  managementMessage.textContent = message || '';
  const reading = state.libraryOpening === 'reading';
  const timedOut = !busy && state.libraryOpening === 'timed-out';
  for (const actions of document.querySelectorAll('.library-open-actions')) {
    actions.hidden = !reading && !timedOut;
    actions.querySelector('[data-library-open-action="cancel"]').hidden = !reading;
    actions.querySelector('[data-library-open-action="reveal"]').hidden = !timedOut;
  }
  if (!library) return;
  const shown = scopeId === null ? state.libraries : state.libraries.filter(entry => entry.id === scopeId);
  const loaded = catalogEntries().filter(entry => scopeId === null || entry.libraryId === scopeId);
  const warnings = readingDiagnostics.update(shown, loaded);
  const warningsButton = byId('warnings-button');
  warningsButton.hidden = warnings === 0;
  warningsButton.textContent = `${counts.format(warnings)} 项读取问题`;
  const active = scopeId && shown[0];
  const syncButton = byId('sync-status-button');
  syncButton.hidden = active?.kind !== 'jiancang';
  if (active?.kind === 'jiancang') {
    const pending = active.writeStatus?.pending || 0;
    const conflicts = loaded[0]?.library.syncConflicts || 0;
    syncButton.textContent = pending ? `${counts.format(pending)} 条待提交` : conflicts ? `${counts.format(conflicts)} 条同步冲突` : '同步状态';
  }
  const scopeName = scopeId === null ? `已读取 ${loaded.length} / ${shown.length} 个库` : libraryName(shown[0]);
  const pendingText = warnings ? '部分项目待处理' : '';
  byId('status-text').textContent = message || [scopeName, pendingText].filter(Boolean).join(' · ');
  document.querySelector('.status-bar').classList.toggle('has-warnings', !!library.partial || warnings > 0);
}

function rebuildNavigation() {
  directories.clear();
  children.clear();
  totals.clear();
  assetById.clear();
  const library = browseCatalog;
  if (!library) return;
  for (const item of library.collections) directories.set(item.id, item);
  for (const item of library.collections) {
    const parent = item.id !== item.parentId && directories.has(item.parentId) ? item.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(item);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
  for (const view of sections) totals.set(view.id, 0);
  const sourceTotals = new Map();
  for (const asset of library.assets) {
    assetById.set(asset.id, asset);
    if (asset.trashed) {
      totals.set('trash', totals.get('trash') + 1);
      continue;
    }
    if (trashWrites.has(asset.id)) continue;
    totals.set('all', totals.get('all') + 1);
    sourceTotals.set(asset.sourceLibraryId, (sourceTotals.get(asset.sourceLibraryId) || 0) + 1);
    if (asset.favorite) totals.set('favorites', totals.get('favorites') + 1);
    if (asset.tags.length === 0) totals.set('untagged', totals.get('untagged') + 1);
    if (recentlyViewed.has(asset.id)) totals.set('recent', totals.get('recent') + 1);
    const membership = new Set();
    for (const id of asset.collectionIds) {
      for (let current = id; directories.has(current) && !membership.has(current); current = directories.get(current).parentId) {
        membership.add(current);
      }
    }
    if (membership.size === 0) totals.set('unfiled', totals.get('unfiled') + 1);
    for (const id of membership) {
      const key = `folder:${id}`;
      totals.set(key, (totals.get(key) || 0) + 1);
    }
  }
  for (const item of library.collections) {
    if (item.sourceLibraryId) totals.set(`folder:${item.id}`, sourceTotals.get(item.sourceLibraryId) || 0);
  }
}

function plainBrowseView() {
  return !searchInput.value.trim() && assetFilters.activeCount === 0 && !visual.active;
}

function rememberWorkspace() {
  clearTimeout(workspaceSaveTimer);
  if (!browseCatalog || workspaceRestorePending || smart.active || workspace.hidden) return;
  const old = savedWorkspaces.read(scopeId);
  const sameLocation = old?.section === section && old.collectionId === collectionId;
  const bookmark = !viewer && plainBrowseView() ? continuous.bookmark() : sameLocation ? old.bookmark : null;
  savedWorkspaces.remember(scopeId, { section, collectionId, expanded: [...openedCollections], bookmark });
}

function restoreWorkspace(entries, registered) {
  if (!workspaceRestorePending) return null;
  const saved = savedWorkspaces.read(scopeId);
  if (!saved) { workspaceRestorePending = false; return null; }
  const owner = saved.collectionId?.startsWith('library:') ? saved.collectionId.slice('library:'.length) :
    saved.collectionId?.split(':', 1)[0];
  const required = owner ?? scopeId;
  if (required && registered.has(required) && !entries.some(entry => entry.libraryId === required)) return null;
  workspaceRestorePending = false;
  for (const id of saved.expanded) openedCollections.add(id);
  if (saved.section === 'collection' && !directories.has(saved.collectionId)) return null;
  section = saved.section;
  collectionId = saved.collectionId;
  revealCollectionAncestors(collectionId);
  return plainBrowseView() ? saved.bookmark : null;
}

function revealCollectionAncestors(id) {
  const visited = new Set([id]);
  for (let parent = directories.get(id)?.parentId; parent && !visited.has(parent); parent = directories.get(parent)?.parentId) {
    visited.add(parent);
    openedCollections.add(parent);
  }
}

function setState(next, { scopeChanged = false, navigationBookmark = null } = {}) {
  state = next;
  reconcileTrashWrites();
  reconcileInspectorWrites();
  browserCaptureTools.refreshEmptyTargets();
  const registered = new Set(next.libraries.map(entry => entry.id));
  if (scopeId !== null && !registered.has(scopeId)) {
    scopeId = preferences.scopeId = null;
    savePreferences();
    scopeChanged = true;
    resetScopeNavigation();
    workspaceRestorePending = true;
  }
  const connected = registered.size > 0;
  for (const id of catalogProjection.keys()) if (!registered.has(id)) catalogProjection.delete(id);
  workspace.hidden = !connected;
  startupPage.hidden = true;
  byId('connection-page').hidden = connected;
  for (const id of ['search-shell', 'refresh-button', 'toggle-inspector', 'project-boards-button']) byId(id).hidden = !connected;
  if (!connected) assetSearch.close();
  byId('recover-libraries-button').hidden = !connected;
  byId('cloud-originals-button').hidden = cloudLibraries().length === 0;
  renderLibraries();
  const entries = catalogEntries();
  const writable = writableLibraries().map(entry => entry.id);
  const key = JSON.stringify([scopeId, writable, entries.filter(entry => scopeId === null || entry.libraryId === scopeId)
    .map(entry => [entry.libraryId, entry.revision ?? entry.library.assets.length])]);
  if (connected) {
    if (key !== lastCatalogKey || scopeChanged || navigationBookmark) {
      browseCatalog = buildBrowseCatalog(entries);
      assetFilters.updateAssets(browseCatalog.assets);
      void visual.refresh(browseCatalog.assets);
      rebuildNavigation();
      const previousCollection = collectionId;
      const bookmark = restoreWorkspace(entries, registered);
      if (collectionId !== null && !directories.has(collectionId)) {
        collectionId = null;
        section = 'all';
      }
      if (navigationBookmark) revealCollectionAncestors(collectionId);
      const restore = navigationBookmark ?? bookmark;
      const sameView = !!lastCatalogKey && !scopeChanged && !restore && collectionId === previousCollection;
      const shape = JSON.stringify([writable, browseCatalog.collections]);
      if (sameView && shape === navigationShapeKey) refreshNavigationCounts();
      else renderNavigation();
      navigationShapeKey = shape;
      renderGallery({ animate: sameView, preserveViewport: sameView });
      continuous.restoreBookmark(restore);
      if (scopeChanged) motion(scrollingGallery, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1 }]);
    } else renderGalleryGrid({ importsOnly: true, preserveViewport: true });
  } else {
    browseCatalog = null;
    workspaceRestorePending = true;
    navigationHistory.back.length = navigationHistory.forward.length = 0;
    closeViewer({ restore: false });
    endBatchSelection();
    void visual.refresh([]);
    visibleImports = intake.previewItems();
  }
  lastCatalogKey = connected ? key : null;
  renderNavigationHistory();
  renderLocalControls();
  void intake.updateQueue();
  tags.refresh();
  if (byId('sync-write-dialog').open) renderSyncPanel();
  void suggestionTools.refreshAccess();
  void smart.refresh();
  collectionFinder.refresh();
  renderStatus();
  reconcileFavoriteWrites();
}

function setCrossLibraryWrite(active) {
  crossLibraryWrite = active;
  flushDeferredLibraryState();
}

function flushDeferredLibraryState() {
  if (crossLibraryWrite || keyboardRatingPending || !deferredLibraryState) return;
  const latest = deferredLibraryState;
  deferredLibraryState = null;
  setState(latest);
}

function resetScopeNavigation({ clearExpanded = true } = {}) {
  closeViewer({ restore: false });
  endBatchSelection();
  section = 'all';
  collectionId = null;
  selectedId = null;
  if (clearExpanded) openedCollections.clear();
  scrollingGallery.scrollTop = 0;
}

function selectScope(id, { record = true } = {}) {
  const leavingSmart = !!smart.active;
  if (record && (scopeId !== id || leavingSmart)) recordNavigation();
  if (scopeId !== id && !leavingSmart) rememberWorkspace();
  if (leavingSmart) leaveSmartCollection();
  if (scopeId !== id || leavingSmart) {
    scopeId = preferences.scopeId = id;
    savePreferences();
    resetScopeNavigation();
    workspaceRestorePending = true;
    setState({ ...state, message: null }, { scopeChanged: true });
  }
  else { visual.clearsSimilarity(); renderNavigation(); renderGallery({ animate: false }); }
  if (id && !catalogEntries().some(entry => entry.libraryId === id) && !busy) {
    return requestState('switchLibrary', id);
  }
  return Promise.resolve(state);
}

async function requestState(action, ...args) {
  if (busy) return;
  const restoring = action === 'getState' && !startupPage.hidden;
  if (restoring) {
    startupMessage.textContent = '正在读取素材库…';
    retryStartup.hidden = true;
  }
  setBusy(true);
  try {
    if (typeof bridge?.[action] !== 'function') throw new Error('请从见藏客户端打开素材库。');
    const next = await bridge[action](...args);
    if (restoring && startupPage.hidden) return state;
    if (!Array.isArray(next?.libraries) || !('library' in next)) throw new Error('未能读取素材库状态。');
    setState(next);
    if (next.message && next.library && action !== 'getState' && !librariesDialog.open) showToast(next.message);
    return next;
  } catch (error) {
    const message = error?.message || '无法读取素材库。请检查文件夹位置并重试。';
    if (restoring) {
      if (!startupPage.hidden) {
        startupMessage.textContent = message;
        retryStartup.hidden = false;
      }
    } else state = { ...state, message };
  } finally {
    setBusy(false);
  }
}

function libraryName(entry) { return entry?.name || entry?.root || '素材库'; }
function libraryKind(kind) { return { eagle: 'Eagle', local: '见藏本地库', jiancang: '见藏同步库' }[kind] || ''; }

const eagleConfigurations = new Set();

async function configureEagleWrite(id, enabled) {
  if (eagleConfigurations.has(id)) return false;
  eagleConfigurations.add(id);
  try {
    const result = await bridge.configureEagleWrite(id, enabled);
    if (!result?.ok) throw new Error(result?.message || '无法更新 Eagle 同步设置。');
    setState(result.state);
    renderInspector();
    showToast(enabled ? '已开启 Eagle 双向同步。' : '已暂停 Eagle 双向同步。');
    return true;
  } catch (error) {
    showToast(error.message || '无法更新 Eagle 同步设置。');
    return false;
  } finally {
    eagleConfigurations.delete(id);
  }
}

function cloudLibraries() {
  return state.libraries.filter(entry => entry.kind === 'jiancang' || entry.kind === 'eagle');
}

function canRetrieveOriginal(asset) {
  return asset && !asset.trashed && asset.kind !== 'link' && ['jiancang', 'eagle'].includes(asset.sourceKind);
}

function openCloudOriginals(assets) {
  const groups = new Map();
  let skipped = 0;
  for (const asset of assets) {
    if (!canRetrieveOriginal(asset)) { skipped++; continue; }
    const id = asset.sourceLibraryId;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(asset.sourceAssetId);
  }
  const first = groups.keys().next().value;
  if (first) cloudTools.open(first, { groups, skipped });
}

function openSyncPanel(id) {
  if (!state.libraries.some(entry => entry.id === id && entry.kind === 'jiancang')) return;
  syncPanelId = id;
  syncPanelError = null;
  renderSyncPanel();
  if (!byId('sync-write-dialog').open) byId('sync-write-dialog').showModal();
}

function renderSyncPanel() {
  const entry = state.libraries.find(item => item.id === syncPanelId && item.kind === 'jiancang');
  if (!entry) { byId('sync-write-dialog').close(); return; }
  const library = catalogEntries().find(item => item.libraryId === entry.id)?.library;
  const status = entry.writeStatus;
  const hasPublication = entry.format === 6 && Number.isFinite(status?.publishedAt);
  const toggle = byId('sync-write-toggle');
  const retry = byId('sync-write-retry');
  byId('sync-write-title').textContent = `同步状态 · ${libraryName(entry)}`;
  byId('sync-write-description').textContent = entry.format === 6
    ? 'Windows 将原件和整理变更写入此同步文件夹，其他设备由 iCloud 云盘接收。'
    : entry.format ? '在 iPhone 或 iPad 的见藏中打开「多端同步 → 原件与云端空间」，点「升级到格式 6」，再回到 Windows 刷新素材库。'
      : '等待同步库重新连接后核对格式与状态。';
  const lines = [
    ['同步格式', entry.format || '等待读取'],
    ['Windows 写入', entry.syncWritable ? '已开启' : '已暂停'],
    ['本机待写入', Number.isFinite(status?.pending) ? counts.format(status.pending) : '暂不可查'],
  ];
  if (entry.format === 6) lines.push(['本机最近确认写入', hasPublication ? syncDateFormat.format(status.publishedAt) : '暂无记录']);
  if (library) {
    lines.push(['等待取回的原件', counts.format(library.assets.filter(asset => !asset.trashed && !asset.available).length)],
      ['待核对的冲突', counts.format(library.syncConflicts ?? status?.conflicts ?? 0)]);
    if (library.logIncomplete) lines.push(['变更读取', '等待 iCloud 同步完整记录']);
  }
  byId('sync-write-details').replaceChildren(...lines.flatMap(([name, value]) => [node('dt', '', name), node('dd', '', value)]));
  byId('sync-write-cloud-help').textContent = hasPublication
    ? '其他设备还没看到这次修改时，可定位最新记录，查看它在资源管理器中的 iCloud 状态。再确认其他设备打开了同一份同步库。'
    : '打开同步文件夹可在资源管理器检查 iCloud 状态，并核对其他设备连接的素材库。';
  byId('sync-write-reveal-latest').hidden = !hasPublication;
  const error = syncPanelError || status?.error || entry.message;
  byId('sync-write-error').textContent = error || '';
  byId('sync-write-error').hidden = !error;
  toggle.textContent = entry.syncWritable ? '暂停 Windows 写入' : '开启双向同步';
  toggle.disabled = syncPanelBusy || (!entry.syncWritable && entry.format !== 6);
  retry.hidden = !entry.syncWritable;
  retry.disabled = syncPanelBusy;
  byId('sync-write-conflicts').hidden = !entry.format;
}

async function revealSyncLocation(bridgeAction) {
  const entry = state.libraries.find(item => item.id === syncPanelId && item.kind === 'jiancang');
  if (!entry) return;
  syncPanelError = null;
  renderSyncPanel();
  try {
    const result = await bridge[bridgeAction](entry.id);
    if (!result?.ok) throw new Error(result?.message);
  } catch (error) {
    if (syncPanelId !== entry.id || !byId('sync-write-dialog').open) return;
    syncPanelError = error?.message || '暂时无法在资源管理器中查看，请重试。';
    renderSyncPanel();
  }
}

async function applySyncAction(action) {
  const entry = state.libraries.find(item => item.id === syncPanelId);
  if (!entry || syncPanelBusy) return;
  syncPanelBusy = true;
  syncPanelError = null;
  renderSyncPanel();
  try {
    const result = await (action === 'toggle' ? bridge.configureSyncWrite(entry.id, !entry.syncWritable) : bridge.retrySyncWrite(entry.id));
    if (!result || result.ok === false) throw new Error(result?.message || '同步操作未完成，请重试。');
    const next = result.state ?? (Array.isArray(result.libraries) ? result : null);
    if (next) setState(next);
    if (action === 'toggle') {
      if (!next) throw new Error('无法读取更新后的同步状态，请刷新素材库。');
      const message = result.message || next.message;
      if (message) throw new Error(message);
    } else if (!result.error && result.pending === 0 && result.catalogRefresh?.ok && !result.catalogRefresh.message) {
      showToast('素材库已重新读取，本机无待提交变更。已写入的内容由 iCloud 云盘继续同步。');
    }
  } catch (error) {
    if (syncPanelId === entry.id) syncPanelError = error?.message || '同步操作未完成，请重试。';
  }
  finally {
    syncPanelBusy = false;
    if (byId('sync-write-dialog').open) renderSyncPanel();
  }
}

function renderLibraries() {
  const entries = state.libraries || [];
  const key = JSON.stringify([scopeId, busy, entries.map(entry =>
    [entry.id, entry.kind, libraryName(entry), entry.root, entry.message, entry.status, entry.syncWritable, entry.eagleWritable])]);
  if (key === libraryRowsKey) return;
  libraryRowsKey = key;
  const list = byId('library-management-list');
  const saved = byId('saved-libraries');
  const focused = document.activeElement;
  const focusedLibrary = focused?.dataset?.libraryId;
  const focusedAction = focused?.dataset?.libraryAction;
  const all = node('div', `library-entry aggregate-entry${scopeId === null ? ' is-current' : ''}`);
  const allButton = makeButton('', 'libraries', 'library-entry-open', () => selectScope(null));
  const allLabels = node('span', 'library-entry-labels');
  allLabels.append(node('span', 'library-entry-name', '所有素材库'));
  allButton.append(allLabels);
  allButton.id = 'all-libraries';
  if (scopeId === null) allButton.setAttribute('aria-current', 'true');
  all.append(allButton);
  replaceLibraryRows(saved, [all, ...entries.map(entry => makeLibraryRow(entry, false))]);
  replaceLibraryRows(list, entries.length > 0
    ? entries.map(entry => makeLibraryRow(entry, true))
    : [node('p', 'sidebar-empty', '尚未添加素材库')]);
  if (focusedLibrary && focusedAction && !busy) {
    const replacement = [...document.querySelectorAll('[data-library-action]')].find(button =>
      button.dataset.libraryId === focusedLibrary && button.dataset.libraryAction === focusedAction);
    if (replacement && (!librariesDialog.open || librariesDialog.contains(replacement))) replacement.focus({ preventScroll: true });
  }
}

function replaceLibraryRows(container, rows) {
  const identify = row => row.querySelector('.library-entry-open')?.dataset.libraryId;
  const previous = new Map([...container.children].filter(row => identify(row))
    .map(row => [identify(row), { row, rect: row.getBoundingClientRect() }]));
  const remaining = new Set(rows.map(identify));
  container.replaceChildren(...rows);
  if (reduceMotion.matches || !container.clientHeight) return;
  const origin = container.getBoundingClientRect();
  for (const [id, { row, rect }] of previous) {
    if (remaining.has(id) || rect.height === 0) continue;
    const ghost = row.cloneNode(true);
    ghost.querySelectorAll('[data-library-id]').forEach(button => button.removeAttribute('data-library-id'));
    ghost.inert = true;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.classList.add('library-exiting');
    ghost.style.width = `${rect.width}px`;
    ghost.style.top = `${rect.top - origin.top + container.scrollTop}px`;
    ghost.style.left = `${rect.left - origin.left}px`;
    container.append(ghost);
    const animation = motion(ghost, [{ opacity: 1 }, { opacity: 0, transform: 'translateX(-12px)' }], 150);
    animation?.finished.then(() => ghost.remove(), () => ghost.remove());
  }
  for (const row of rows) {
    const prior = previous.get(identify(row));
    if (!prior?.rect.height) continue;
    const delta = prior.rect.top - row.getBoundingClientRect().top;
    if (Math.abs(delta) > 2) motion(row, [{ transform: `translateY(${delta}px)` }, { transform: 'none' }]);
  }
}

function makeLibraryRow(entry, managed) {
  const active = entry.id === scopeId;
  const unavailable = entry.status === 'unavailable';
  const row = node('div', `library-entry${active ? ' is-current' : ''}`);
  const open = makeButton('', ({ eagle: 'eagle', local: 'folder', jiancang: 'cloud' })[entry.kind], 'library-entry-open', async () => {
    await selectScope(entry.id);
    if (managed && catalogEntries().some(item => item.libraryId === entry.id) && librariesDialog.open) librariesDialog.close();
  });
  open.dataset.libraryId = entry.id;
  open.dataset.libraryAction = managed ? 'open-managed' : 'open';
  if (active) open.setAttribute('aria-current', 'true');
  const name = libraryName(entry);
  const labels = node('span', 'library-entry-labels');
  labels.append(node('span', 'library-entry-name', name));
  const kind = libraryKind(entry.kind);
  const status = unavailable ? '暂不可用' : entry.status === 'loading' ? '正在读取' : '';
  const access = entry.eagleWritable || entry.syncWritable ? '双向同步' : entry.kind === 'eagle' ? '只读' : '';
  labels.append(node('small', 'library-entry-kind', [kind, access, status].filter(Boolean).join(' · ')));
  if (managed && entry.root) {
    const location = node('small', 'library-entry-path', entry.root);
    location.title = entry.root;
    labels.append(location);
  }
  open.append(labels);
  open.title = entry.message || entry.root || name;
  if (unavailable) open.append(glyph('warning'));
  row.append(open);
  if (!managed) {
    labelImportDestination(row, entry.id, name);
    return row;
  }

  const relocate = makeButton('', 'folderOpen', 'icon-button', () => requestState('relocateLibrary', entry.id));
  relocate.title = '重新定位文件夹';
  relocate.setAttribute('aria-label', `重新定位 ${name}`);
  relocate.dataset.libraryId = entry.id;
  relocate.dataset.libraryAction = 'relocate';
  relocate.disabled = busy;
  const remove = makeButton('', 'close', 'icon-button', () => requestState('removeLibrary', entry.id));
  remove.title = '从列表移除';
  remove.setAttribute('aria-label', `从列表移除 ${name}`);
  remove.dataset.libraryId = entry.id;
  remove.dataset.libraryAction = 'remove';
  remove.disabled = busy;
  if (entry.kind === 'jiancang') {
    const sync = makeButton('', 'cloud', 'icon-button', () => openSyncPanel(entry.id));
    sync.title = '同步状态与设置';
    sync.setAttribute('aria-label', `同步状态 ${name}`);
    sync.dataset.syncLibraryId = entry.id;
    row.append(sync);
  }
  if (entry.kind === 'eagle') {
    const label = entry.eagleWritable ? '暂停双向同步' : '开启双向同步';
    const sync = makeButton(label, 'cloud', 'status-button', () => void configureEagleWrite(entry.id, !entry.eagleWritable));
    sync.title = `${label}（${name}）`;
    sync.dataset.libraryId = entry.id;
    sync.dataset.libraryAction = 'eagle-write';
    sync.disabled = unavailable && !entry.eagleWritable;
    row.append(sync);
  }
  const reveal = makeButton('', 'external', 'icon-button', async () => {
    try {
      const result = await bridge.revealLibrary(entry.id);
      if (!result?.ok) showToast(result?.message || '暂时无法打开素材库文件夹。');
    } catch { showToast('暂时无法打开素材库文件夹。'); }
  });
  reveal.title = '在资源管理器中打开库文件夹';
  reveal.setAttribute('aria-label', `打开 ${name} 的文件夹`);
  reveal.disabled = unavailable;
  row.append(reveal, relocate, remove);
  return row;
}

async function perform(action, asset, successText, button) {
  if (button) button.disabled = true;
  try {
    const args = asset ? [asset.sourceAssetId, asset.sourceLibraryId] : scopeId ? [scopeId] : [];
    const result = await bridge[action](...args);
    if (!result?.cancelled) showToast(result?.message || (result?.ok ? successText : '操作未完成，请刷新后重试。'));
  } catch (error) {
    showToast(error?.message || '操作未完成，请刷新后重试。');
  } finally {
    if (button) button.disabled = false;
  }
}

async function copyAssetInformation(assets, mode, button) {
  if (!assets.length) return;
  if (button) button.disabled = true;
  try {
    const references = assets.map(asset => ({ id: asset.sourceAssetId, registrationId: asset.sourceLibraryId }));
    if (!mode) {
      const choice = await bridge.assetClipboardMenu(references);
      if (choice?.cancelled) return;
      if (!choice?.ok) throw new Error(choice?.message || '无法打开素材复制菜单。');
      mode = choice.mode;
    }
    if (mode === 'paths') showToast('正在核对原件路径…');
    const result = await bridge.copyAssetDetails(references, mode);
    showToast(result?.message || '未能复制素材信息，请重试。');
  } catch (error) { showToast(error?.message || '未能复制素材信息，请重试。'); }
  finally { if (button) button.disabled = false; }
}

function setCollectionDropRow(row) {
  if (collectionDropRow === row) return;
  collectionDropRow?.classList.remove('is-collection-drop-target');
  collectionDropRow = row;
  collectionDropRow?.classList.add('is-collection-drop-target');
}

function clearCollectionDrag() {
  collectionDrag = null;
  setCollectionDropRow(null);
}

function labelImportDestination(row, libraryId, name, collection = '') {
  row.dataset.importLibrary = libraryId;
  row.dataset.importCollection = collection;
  row.dataset.importDestinationName = name;
}

async function addAssetsToCollection(registrationId, item, ids) {
  try {
    const collectionId = item.id.slice(registrationId.length + 1);
    const result = await mutateLocal(registrationId, { action: 'edit', ids, addCollectionIds: [collectionId] });
    if (!result?.ok) throw new Error(result?.message || '无法加入集合。');
    showToast(result.message || (result.count ? `已将 ${result.count} 项素材加入「${item.name}」。` : `所选素材已在「${item.name}」。`));
  } catch (error) { showToast(error?.message || '无法加入集合，请刷新后重试。'); }
}

function bindCollectionDrop(row, item, registrationId) {
  const canDrop = event => collectionDrag?.registrationId === registrationId &&
    event.dataTransfer?.types.includes(collectionDragType);
  const highlight = event => {
    if (!canDrop(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setCollectionDropRow(row);
  };
  row.addEventListener('dragenter', highlight);
  row.addEventListener('dragover', highlight);
  row.addEventListener('dragleave', event => {
    const to = event.relatedTarget;
    if (collectionDropRow === row && (!(to instanceof Node) || !row.contains(to))) setCollectionDropRow(null);
  });
  row.addEventListener('drop', event => {
    if (!canDrop(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const ids = collectionDrag.ids;
    clearCollectionDrag();
    void addAssetsToCollection(registrationId, item, ids);
  });
}

function setCompactDragImage(event, element) {
  const image = element.querySelector('.asset-picture img');
  const canvas = node('canvas');
  const hasImage = image?.naturalWidth && image?.naturalHeight;
  const scale = hasImage ? Math.min(1, 56 / image.naturalWidth, 56 / image.naturalHeight) : 1;
  canvas.width = hasImage ? Math.max(1, Math.round(image.naturalWidth * scale)) : 32;
  canvas.height = hasImage ? Math.max(1, Math.round(image.naturalHeight * scale)) : 38;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.globalAlpha = 0.72;
  if (hasImage) context.drawImage(image, 0, 0, canvas.width, canvas.height);
  else {
    context.fillStyle = '#38404b';
    context.beginPath();
    context.roundRect(0, 0, canvas.width, canvas.height, 4);
    context.fill();
    context.fillStyle = '#bac3cf';
    for (const top of [12, 18, 24]) context.fillRect(8, top, 16, 2);
  }
  event.dataTransfer.setDragImage(canvas, Math.floor(canvas.width / 2), Math.floor(canvas.height / 2));
}

function canDragInspectorPreview(asset) {
  return asset.kind === 'image' || asset.extension === 'livp';
}

function nativeDragThumbnail(element, asset) {
  if (!window.jiancangTauriPlatform) return null;
  const image = element.querySelector('.asset-picture img, .live-photo > img:not([hidden])') ??
    displayedPhoto(element) ?? cardImage(asset.id);
  const size = window.previewTransitions.imageSize(image);
  if (!size || image.dataset.previewPhotoId && image.dataset.previewPhotoId !== asset.id) return null;
  const edge = Math.round(80 * clamp(window.devicePixelRatio || 1, 1, 3));
  const scale = Math.min(1, edge / size.width, edge / size.height);
  const canvas = node('canvas');
  const width = canvas.width = Math.max(1, Math.round(size.width * scale));
  const height = canvas.height = Math.max(1, Math.round(size.height * scale));
  const context = canvas.getContext('2d');
  if (!context) return null;
  try {
    context.globalAlpha = 0.72;
    context.drawImage(image, 0, 0, width, height);
    return { width, height, rgba: Array.from(context.getImageData(0, 0, width, height).data) };
  } catch { return null; }
}

function dispatchNativeDrag(token, thumbnail) {
  if (nativeDragToken) return;
  nativeDragToken = token;
  bridge.startDrag(token, thumbnail);
}

async function startPreparedAssetDrag(element, asset, pointerId) {
  const ready = preparedDragCopies.get(asset.id);
  const thumbnail = nativeDragThumbnail(element, asset);
  if (ready?.revision === asset.sourceRevision && (ready.expiresAt == null || ready.expiresAt > Date.now())) {
    dispatchNativeDrag(ready.token, thumbnail);
    return;
  }

  // If the pointer remains down, continue the same gesture as soon as the
  // verified file becomes available. A released gesture may only prepare it.
  const gesture = new AbortController();
  const { signal } = gesture;
  const finish = () => {
    gesture.abort();
    if (pointerId !== null && element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  };
  if (pointerId !== null) {
    try { element.setPointerCapture(pointerId); } catch { /* The pointer may already be gone. */ }
    const end = event => { if (event.pointerId === pointerId) finish(); };
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      document.addEventListener(name, end, { capture: true, signal });
    }
    document.addEventListener('pointermove', event => {
      if ((event.buttons & 1) === 0) end(event);
    }, { capture: true, signal });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') finish();
    }, { capture: true, signal });
    window.addEventListener('blur', finish, { signal });
  }

  const prepared = await prepareAssetDrag(asset, { announceReady: false });
  const stillDragging = pointerId !== null && !signal.aborted && element.isConnected && element.hasPointerCapture(pointerId);
  finish();
  if (!prepared || assetById.get(asset.id)?.sourceRevision !== asset.sourceRevision) return;
  if (stillDragging) {
    const toast = byId('toast');
    if (toast.textContent === '正在准备拖出副本…') toast.hidden = true;
    dispatchNativeDrag(prepared.token, thumbnail);
  } else showToast(dragReadyMessage(asset));
}

function bindAssetDrag(element, asset, { toCollection = false, collectionGrip = null, getAsset = () => assetById.get(asset.id) } = {}) {
  const canOrganize = current => toCollection && !current.trashed && writableAsset(current);
  element.draggable = asset.available || canOrganize(asset);
  if (collectionGrip) collectionGrip.draggable = true;
  let pointerId = null;
  element.addEventListener('pointerdown', event => {
    const current = getAsset();
    element.draggable = !!current && (current.available || canOrganize(current));
    pointerId = event.isTrusted && event.pointerType === 'mouse' && event.button === 0 ? event.pointerId : null;
  });
  element.addEventListener('dragend', clearCollectionDrag);
  element.addEventListener('dragstart', event => {
    const current = getAsset();
    if (!current) { event.preventDefault(); return; }
    const organize = canOrganize(current) && (batchMode || !current.available || collectionGrip?.contains(event.target));
    if (organize && !event.altKey && event.dataTransfer) {
      const assets = batchMode && batchIds.has(current.id) ? selectedBatchAssets() : [current];
      if (!assets.length || assets.some(item => item.trashed || item.sourceLibraryId !== current.sourceLibraryId)) {
        event.preventDefault();
        showToast('请选中同一个素材库里的素材，再拖到该库的集合。');
        return;
      }
      collectionDrag = { registrationId: current.sourceLibraryId, ids: assets.map(item => item.sourceAssetId) };
      event.dataTransfer.setData(collectionDragType, current.sourceLibraryId);
      event.dataTransfer.effectAllowed = 'copy';
      setCompactDragImage(event, element);
      return;
    }
    event.preventDefault();
    if (!current.available || batchMode) return;
    void startPreparedAssetDrag(element, current, event.isTrusted ? pointerId : null);
  });
}

function dragReadyMessage(asset) {
  return `拖出副本已就绪。拖动素材卡片${canDragInspectorPreview(asset) ? '或右侧预览' : ''}即可拖出。`;
}

async function prepareAssetDrag(asset, { announceReady = true } = {}) {
  if (!asset.available) return null;
  const ready = preparedDragCopies.get(asset.id);
  if (ready?.revision === asset.sourceRevision && (ready.expiresAt == null || ready.expiresAt > Date.now())) {
    if (announceReady) showToast(dragReadyMessage(asset));
    return ready;
  }
  if (preparingCopy) return null;
  preparingCopy = asset.id;
  showToast('正在准备拖出副本…');
  try {
    const result = await bridge.prepareDrag(asset.sourceAssetId, asset.sourceLibraryId);
    if (!result.ok) {
      showToast(result.message);
      return null;
    }
    const prepared = { revision: asset.sourceRevision, token: result.token, expiresAt: result.expiresAt };
    if (preparedDragCopies.size >= 64) preparedDragCopies.delete(preparedDragCopies.keys().next().value);
    preparedDragCopies.set(asset.id, prepared);
    if (announceReady) showToast(dragReadyMessage(asset));
    return prepared;
  } catch { showToast('无法准备拖出副本，请刷新后重试。'); }
  finally { preparingCopy = null; }
}

async function retryAssetPreview(asset) {
  if (!asset.available) await requestState('refresh', asset.sourceLibraryId);
  const current = assetById.get(asset.id);
  if (!current) return;
  if (retryKeys.size >= 512) retryKeys.delete(retryKeys.keys().next().value);
  retryKeys.set(current.id, String(Date.now()));
  const card = continuous.focus(current.id, { scroll: false, focus: false });
  const picture = card?.querySelector('.asset-picture');
  if (picture && (current.kind === 'image' || current.extension === 'livp' || current.thumbnailAvailable)) {
    mountCardThumbnail(picture, current, card);
  }
  if (viewer?.assetId === current.id) {
    viewer.key = null;
    if (current.kind === 'pdf') selectionKey = '';
    updateViewer();
  } else if (selectedId === current.id) {
    selectionKey = '';
    renderInspector();
  }
}

function canOrganizeFromMenu(registrationId) {
  const entry = state.libraries.find(item => item.id === registrationId);
  if (!isWritable(entry)) return false;
  if (entry.kind !== 'jiancang') return true;
  const catalog = catalogEntries().find(item => item.libraryId === registrationId)?.library;
  return !!catalog && !catalog.logIncomplete && !entry.syncLogIncomplete && Number.isInteger(entry.writeStatus?.pending);
}

function closeWorkspaceMenus() {
  for (const menu of document.querySelectorAll('[popover]:popover-open')) menu.hidePopover();
}

function assetMenuAnchor(event, target) {
  if (event?.type === 'contextmenu' && (event.button === 2 || event.pointerType)) {
    return { x: event.clientX, y: event.clientY };
  }
  if (!target) return undefined;
  const { top, right, bottom } = target.getBoundingClientRect();
  return { top, right, bottom };
}

async function showAssetMenu(asset, card, media, event) {
  const anchor = assetMenuAnchor(event, event?.currentTarget ?? card ?? media);
  closeWorkspaceMenus();
  try {
    const player = media && livePhotoPlayers.get(media);
    const live = player?.assetId === asset.id ? player : null;
    const action = await bridge.assetMenu(asset.sourceAssetId, asset.sourceLibraryId, {
      anchor, ...(live && { liveLoop: livePhotoLoops.has(asset.id) }),
      ...(asset.trashed && { purgeBusy: trashActionBusy() || trashWriteInProgress(asset.sourceLibraryId) }),
      ...(!asset.trashed && { stash: selectionStash.has(asset.id) ? 'remove' : 'add' }),
    });
    const current = assetById.get(asset.id);
    if (!current) return;
    if (action === 'stash-add' || action === 'stash-remove') {
      updateSelectionStash([current], action === 'stash-add' ? 'add' : 'remove');
      return;
    }
    if (action === 'live-loop' && live && livePhotoPlayers.get(media) === live) live.toggleLoop();
    if (action?.startsWith('clipboard-')) { void copyAssetInformation([current], action.slice('clipboard-'.length)); return; }
    if (action === 'preview') openViewer(current, card);
    if (action === 'open-default') void perform('openDefaultAsset', current);
    if (action === 'reference') void perform('openReference', current);
    if (action === 'copy-file') {
      showToast('正在复制文件…');
      void perform('copyAssetFile', current);
    }
    if (action === 'retry') void retryAssetPreview(current);
    if (action === 'cloud-original') openCloudOriginals([current]);
    if (action === 'reveal') void perform('revealAsset', current);
    if (action === 'link') void perform('openLink', current);
    if (action === 'offline-web') void offlineReader.open(current);
    if (action === 'image-tools' && canEditImage(current)) void imageTools.open(current);
    if (action === 'video-trim') openVideoTrim(current);
    if (action === 'board-add') boards.add([current]);
    if (action === 'find-similar') void visual.open(current);
    if (action === 'find-source-site') findSourceSite(current);
    if (action === 'suggest-asset') suggestionTools.open([current]);
    if (action === 'copy-local') void intake.open({ assets: [current] });
    if (canOrganizeFromMenu(current.sourceLibraryId)) {
      if (current.trashed) {
        if (action === 'restore-local') void organizer.restore(current.sourceLibraryId, [current]);
        if (action === 'purge-trash') purgeSelectedTrash([current]);
      } else {
        if (action === 'favorite-local') toggleFavoriteAsset(current);
        if (action === 'add-collections-local') organizer.addToCollections(current, localCollections(current.sourceLibraryId));
        if (action === 'trash-local') organizer.trash(current.sourceLibraryId, [current]);
        const rating = /^rate-local-([0-5])$/.exec(action);
        if (rating) void organizer.setRating(current, Number(rating[1]));
      }
    }
  } catch { showToast('素材已变化，请刷新后重试。'); }
}

function makeNavRow(title, icon, count, current, handler) {
  const row = node('div', `navigation-row${current ? ' is-current' : ''}`);
  const button = makeButton('', icon, 'navigation-button', handler);
  if (current) button.setAttribute('aria-current', 'page');
  const label = node('span', 'navigation-name', title);
  label.title = title;
  button.append(label, node('span', 'navigation-number', counts.format(count || 0)));
  row.append(button);
  return { row, button };
}

function selectView(nextSection, nextCollection = null, { record = true } = {}) {
  const openingStash = nextSection === 'stash' && section !== 'stash';
  const scopeChanged = nextSection === 'stash' && scopeId !== null;
  if (record && (nextSection !== section || nextCollection !== collectionId || scopeChanged || smart.active)) recordNavigation();
  if (scopeChanged) rememberWorkspace();
  leaveSmartCollection();
  if (openingStash || scopeChanged) {
    assetSearch.close();
    assetSearch.restore('');
    assetFilters.reset({ notify: false });
    visual.restore({}, false);
  } else visual.clearsSimilarity();
  closeViewer({ restore: false });
  endBatchSelection();
  workspaceRestorePending = false;
  section = nextSection;
  collectionId = nextCollection;
  if (section === 'collection' && collectionId) collectionFinder.remember(collectionId);
  if (collectionId !== null && children.has(collectionId)) openedCollections.add(collectionId);
  selectedId = null;
  restoreFocus = null;
  scrollingGallery.scrollTop = 0;
  if (scopeChanged) {
    scopeId = preferences.scopeId = null;
    savePreferences();
    setState({ ...state, message: null }, { scopeChanged: true });
  } else {
    renderNavigation();
    renderGallery();
    renderLocalControls();
    void intake.updateQueue();
  }
  rememberWorkspace();
  document.querySelector('.navigation-row.is-current .navigation-button')?.focus({ preventScroll: true });
}

function openFoundCollection(item) {
  const entry = catalogEntries().find(source => source.libraryId === item.libraryId);
  if (!entry || !projectedCatalog(entry).collections.some(collection => collection.id === item.id)) {
    showToast('这个集合暂不可用，请刷新素材库。');
    return;
  }
  if (section !== 'collection' || collectionId !== item.id || smart.active) recordNavigation();
  if (scopeId !== null && scopeId !== item.libraryId) void selectScope(item.libraryId, { record: false });
  revealCollectionAncestors(item.id);
  selectView('collection', item.id, { record: false });
  byId('collection-tree').querySelector('.is-current')?.scrollIntoView({ block: 'nearest' });
}

function locateReadingAsset(libraryId, sourceId) {
  const catalog = catalogEntries().find(entry => entry.libraryId === libraryId);
  const asset = catalog?.library.assets.find(item => item.id === sourceId);
  if (!asset) return { ok: false, message: '这个素材暂不可定位，请重新读取素材库。' };
  warningsDialog.close();
  recordNavigation();
  if (scopeId !== libraryId) void selectScope(libraryId, { record: false });
  assetSearch.close();
  assetSearch.restore('');
  assetFilters.reset({ notify: false });
  visual.restore({}, false);
  selectView(asset.trashed ? 'trash' : 'all', null, { record: false });
  const id = collectionKey(libraryId, sourceId);
  const card = continuous.focus(id);
  if (!card) return { ok: false, message: '这个素材暂不可定位，请重新读取素材库。' };
  selectAsset(id, card);
  return { ok: true };
}

const collectionColors = [
  ['46786B', '默认颜色', 'var(--muted)'], ['E45949', '红色'], ['E89834', '橙色'], ['E5C445', '黄色'],
  ['56A66E', '绿色'], ['46ACBC', '青色'], ['5087CD', '蓝色'], ['976ECC', '紫色'], ['DC80AE', '粉色'],
];

function showCollectionMenu(id, item, anchor, position) {
  closeWorkspaceMenus();
  const menu = byId('collection-menu');
  const registrationId = item.sourceLibraryId || id;
  const collections = localCollections(registrationId);
  const canWrite = canOrganizeFromMenu(registrationId);
  const canEdit = !item.sourceLibraryId && canWrite;
  const { up, down, custom } = collectionOrder.options(item);
  byId('collection-menu-title').textContent = item.name;
  const action = (key, callback) => {
    const button = byId(`collection-menu-${key}`);
    button.onclick = () => { menu.hidePopover(); callback(); };
    return button;
  };
  action('open', () => selectView('collection', item.id));
  const selected = batchMode ? selectedBatchAssets() : [assetById.get(selectedId)].filter(Boolean);
  const newMembers = canEdit && !batchWorking && selected.every(asset => !asset.trashed && asset.sourceLibraryId === id)
    ? selected.filter(asset => !asset.collectionIds.includes(item.id)).map(asset => asset.sourceAssetId) : [];
  const addSelection = action('add-selection', () => void addAssetsToCollection(id, item, newMembers));
  addSelection.hidden = !newMembers.length;
  addSelection.textContent = `将所选素材加入此集合（${counts.format(newMembers.length)} 项）`;
  const expanded = openedCollections.has(item.id);
  const toggle = action('toggle', () => {
    if (expanded) openedCollections.delete(item.id);
    else openedCollections.add(item.id);
    renderNavigation();
    rememberWorkspace();
  });
  toggle.hidden = !children.has(item.id);
  toggle.textContent = expanded ? '折叠子集合' : '展开子集合';
  const pinned = item.sourceLibraryId ? null : collectionFinder.pinned(item.id);
  const quickAccess = action('pin', () => showToast(collectionFinder.togglePinned(item.id)));
  quickAccess.hidden = pinned === null;
  quickAccess.textContent = pinned ? '移出常用' : '加入常用';
  action('copy-name', async () => {
    try {
      const result = await bridge.copyCollectionName(registrationId, item.id.slice(registrationId.length + 1));
      showToast(result?.ok ? '已复制集合名称。' : result?.message || '无法复制集合名称。');
    } catch { showToast('无法复制集合名称。'); }
  }).hidden = !!item.sourceLibraryId;
  action('export', () => {
    const assets = browseCatalog?.assets.filter(asset => !asset.trashed && asset.sourceLibraryId === registrationId &&
      (item.sourceLibraryId || membershipIncludes(asset, item.id))) ?? [];
    if (assets.length > 10_000) { showToast('每次可导出 10,000 项，请选择一个子集合。'); return; }
    exportTools.open(assets);
  }).hidden = !(totals.get(`folder:${item.id}`) > 0);
  action('reveal', async () => {
    try {
      const result = await bridge.revealLibrary(registrationId);
      if (!result?.ok) showToast(result?.message || '暂时无法定位素材库。');
    } catch { showToast('暂时无法定位素材库。'); }
  }).hidden = !state.libraries.some(entry => entry.id === registrationId);
  action('create', () => organizer.collection(registrationId, collections,
    { parentId: item.sourceLibraryId ? null : item.parentId, operation: 'create' })).hidden = !canWrite;
  action('child', () => organizer.collection(id, collections,
    { parentId: item.id, operation: 'create-child' })).hidden = !canEdit;
  action('edit', () => organizer.collection(id, collections,
    { collection: item, operation: 'rename' })).hidden = !canEdit;
  action('move', () => organizer.collection(id, collections,
    { collection: item, operation: 'move' })).hidden = !canEdit;
  const colorMenu = byId('collection-menu-colors');
  colorMenu.hidden = !canEdit;
  if (canEdit) {
    const selectedColor = (item.color || '46786B').toUpperCase();
    colorMenu.querySelector('.collection-menu-swatches').replaceChildren(...collectionColors.map(([color, label, fill]) => {
      const swatch = makeButton('', null, 'collection-color-swatch', () => {
        menu.hidePopover();
        const current = directories.get(item.id);
        if (current && canOrganizeFromMenu(id)) void organizer.setCollectionColor(id, current, color);
      });
      swatch.dataset.collectionColor = color;
      swatch.title = label;
      swatch.setAttribute('aria-label', label);
      swatch.setAttribute('role', 'menuitemradio');
      swatch.setAttribute('aria-checked', String(color === selectedColor));
      swatch.style.setProperty('--swatch', fill || `#${color}`);
      return swatch;
    }));
  }
  action('delete', () => organizer.deleteCollection(id, item)).hidden = !canEdit;
  for (const [action, allowed] of [['up', up], ['down', down], ['reset', custom]]) {
    const button = byId(`collection-order-${action}`);
    button.hidden = action === 'reset' ? !custom : !up && !down;
    button.disabled = !allowed;
    button.onclick = () => { menu.hidePopover(); collectionOrder.update(item, action); };
  }
  const rect = anchor.getBoundingClientRect();
  menu.showPopover();
  const menuWidth = menu.offsetWidth;
  const menuHeight = menu.offsetHeight;
  menu.style.left = `${clamp(position?.x ?? rect.right - menuWidth, 8, innerWidth - menuWidth - 8)}px`;
  menu.style.top = `${clamp(position?.y ?? rect.bottom, 8, innerHeight - menuHeight - 8)}px`;
  byId('collection-menu-open').focus({ preventScroll: true });
}

function navigationCount(id) {
  return id === 'stash' ? selectionStash.size : (totals.get(id) || 0);
}

function trashActionBusy() { return batchWorking || crossLibraryWrite || organizer.immediatePending; }

function trashTargets(scope, confirmed) {
  const groups = [];
  let skipped = 0;
  for (const { libraryId: id, library, revision: catalogRevision } of catalogEntries()) {
    if (scope !== null && scope !== id) continue;
    const entry = state.libraries.find(item => item.id === id);
    const previous = confirmed?.get(id);
    if (confirmed && (!previous || previous.root !== entry?.root || previous.libraryId !== entry?.libraryId)) continue;
    const confirmedIds = previous ? new Set(previous.ids) : null;
    const assets = library.assets.filter(asset => asset.trashed && (!confirmedIds || confirmedIds.has(asset.id)));
    if (!assets.length) continue;
    if (canOrganizeFromMenu(id) && !trashWriteInProgress(id)) {
      groups.push({ id, ids: assets.map(asset => asset.id), name: library.directoryName, kind: library.kind, catalogRevision,
        assetName: assets.length === 1 ? assets[0].name : null, revision: library.revision,
        trashRevision: library.trashRevision, root: entry.root, libraryId: entry.libraryId });
    } else {
      skipped += assets.length;
    }
  }
  const count = groups.reduce((total, group) => total + group.ids.length, 0);
  return { groups, count, skipped };
}

function confirmTrashPurge(scope, targets, { all = false } = {}) {
  if (!targets.count || trashActionBusy()) return false;
  organizer.purgeTrash(targets.groups, targets.skipped, async previous => {
    const fresh = previous.length === 1 ? await requestState('refresh', previous[0].id) : await requestState('refreshAll');
    if (!fresh) throw new Error('暂时无法重新读取回收站，请稍后重试。');
    return trashTargets(scope, new Map(previous.map(group => [group.id, group]))).groups;
  }, { all });
  return true;
}

function purgeSelectedTrash(assets) {
  if (trashActionBusy() || !assets.length) return false;
  const selected = new Map(selectedLibraryGroups(assets.filter(asset => asset.trashed)).map(group => {
    const entry = state.libraries.find(item => item.id === group.id);
    return [group.id, { ids: group.ids, root: entry?.root, libraryId: entry?.libraryId }];
  }));
  return confirmTrashPurge(scopeId, trashTargets(scopeId, selected));
}

async function showTrashMenu(event, invoker) {
  const scope = scopeId;
  const { count, skipped } = trashTargets(scope);
  const enabled = count > 0 && !trashActionBusy();
  const heading = count + skipped
    ? `${counts.format(count + skipped)} 项素材${skipped ? ` · ${counts.format(skipped)} 项暂不可操作` : ''}`
    : '回收站为空';
  closeWorkspaceMenus();
  const action = await window.jiancangAssetContextMenu.showMenu([
    { label: '还原全部', action: 'restore', enabled },
    null,
    { label: '清空回收站…', action: 'purge', enabled, danger: true },
  ], assetMenuAnchor(event, invoker), '回收站操作', { heading, invoker });
  if (!action || scopeId !== scope || trashActionBusy()) return;
  const targets = trashTargets(scope);
  if (!targets.count) { showToast('回收站已更新，没有可操作的素材。'); return; }
  if (action === 'restore') await organizer.restoreAll(targets.groups, targets.skipped);
  if (action === 'purge') confirmTrashPurge(scope, targets, { all: true });
}

function renderNavigation() {
  collectionOrder.beforeRender();
  const views = byId('library-views');
  views.replaceChildren(...sections.map(view => {
    const { row, button } = makeNavRow(view.title, view.icon, navigationCount(view.id),
      !smart.active && section === view.id, () => selectView(view.id));
    row.dataset.section = view.id;
    if (view.id === 'untagged') button.title = '查看未添加标签的素材';
    if (view.id === 'trash') {
      button.setAttribute('aria-haspopup', 'menu');
      row.addEventListener('contextmenu', event => { event.preventDefault(); void showTrashMenu(event, button); });
    }
    return row;
  }));
  const tree = byId('collection-tree');
  const writable = new Set(writableLibraries().map(entry => entry.id));
  const fragment = document.createDocumentFragment();
  const visited = new Set();
  const todo = collectionOrder.branches(children.get(null) || [], 0);
  while (todo.length > 0) {
    const [item, depth, orderable] = todo.pop();
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    const { row, button } = makeNavRow(item.name, item.sourceLibraryId ? 'libraries' : 'folder', totals.get(`folder:${item.id}`), !smart.active && collectionId === item.id,
      () => selectView('collection', item.id));
    row.classList.add('collection-row');
    if (!item.sourceLibraryId && /^[a-f\d]{6}$/i.test(item.color ?? '') && item.color.toUpperCase() !== '46786B') {
      button.querySelector('svg').style.color = `#${item.color}`;
    }
    button.dataset.collectionId = item.id;
    row.dataset.collectionSortId = item.id;
    row.dataset.collectionSortLevel = depth;
    const indent = Math.min(depth, 6);
    const hasChildren = children.has(item.id);
    const open = openedCollections.has(item.id);
    const toggle = hasChildren ? makeButton('', open ? 'chevronDown' : 'chevronRight', 'collection-toggle', () => {
      if (openedCollections.has(item.id)) openedCollections.delete(item.id);
      else openedCollections.add(item.id);
      renderNavigation();
      rememberWorkspace();
      for (const candidate of tree.querySelectorAll('button.collection-toggle')) {
        if (candidate.dataset.toggleCollection === item.id) { candidate.focus({ preventScroll: true }); break; }
      }
    }) : node('span', 'collection-toggle');
    if (hasChildren) {
      toggle.dataset.toggleCollection = item.id;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', `${open ? '折叠' : '展开'} ${item.name}`);
    }
    row.prepend(...Array.from({ length: indent }, () => node('span', 'tree-indent')), toggle);
    const origin = item.id.split(':')[0];
    if (item.sourceLibraryId) labelImportDestination(row, item.sourceLibraryId, item.name);
    else labelImportDestination(row, origin, item.name, item.id.slice(origin.length + 1));
    const canEdit = !item.sourceLibraryId && writable.has(origin);
    if (orderable) {
      const handle = makeButton('', 'grip', 'icon-button collection-order-handle', event => showCollectionMenu(origin, item, event.currentTarget));
      handle.setAttribute('aria-label', `排序集合 ${item.name}`);
      handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown Home End');
      handle.title = '拖动排序，或用方向键移动';
      row.append(handle);
    }
    if (canEdit) {
      bindCollectionDrop(row, item, origin);
    }
    const more = makeButton('', 'more', 'icon-button collection-menu-button', event => showCollectionMenu(origin, item, event.currentTarget));
    more.title = `集合操作 ${item.name}`;
    more.setAttribute('aria-label', more.title);
    more.setAttribute('aria-haspopup', 'menu');
    row.append(more);
    row.addEventListener('contextmenu', event => {
      event.preventDefault();
      const position = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : null;
      showCollectionMenu(origin, item, button, position);
    });
    fragment.append(row);
    if (open) for (const child of collectionOrder.branches(children.get(item.id) || [], depth + 1)) todo.push(child);
  }
  tree.replaceChildren(fragment.hasChildNodes() ? fragment : node('p', 'sidebar-empty', '暂无集合'));
}

function refreshNavigationCounts() {
  for (const row of byId('library-views').querySelectorAll('[data-section]')) {
    const count = row.querySelector('.navigation-number');
    const text = counts.format(navigationCount(row.dataset.section));
    if (count.textContent !== text) count.textContent = text;
  }
  for (const button of byId('collection-tree').querySelectorAll('[data-collection-id]')) {
    const count = button.querySelector('.navigation-number');
    const text = counts.format(totals.get(`folder:${button.dataset.collectionId}`) || 0);
    if (count.textContent !== text) count.textContent = text;
  }
}

function membershipIncludes(asset, folder, folders = directories) {
  const visited = new Set();
  for (const id of asset.collectionIds) {
    for (let current = id; folders.has(current) && !visited.has(current); current = folders.get(current).parentId) {
      if (current === folder) return true;
      visited.add(current);
    }
  }
  return false;
}

function insideView(asset, viewSection, folderId, folders) {
  if (!!asset.trashed !== (viewSection === 'trash')) return false;
  if (!asset.trashed && trashWrites.has(asset.id)) return false;
  if (viewSection === 'stash') return selectionStash.has(asset.id);
  if (viewSection === 'favorites') return favoriteWrites.get(asset.id)?.listed ?? asset.favorite;
  if (viewSection === 'unfiled') return !asset.collectionIds.some(id => folders.has(id));
  if (viewSection === 'untagged') return !asset.tags.length;
  if (viewSection === 'recent') return recentlyViewed.has(asset.id);
  if (viewSection !== 'collection') return true;
  const folder = folders.get(folderId);
  return folder?.sourceLibraryId ? asset.sourceLibraryId === folder.sourceLibraryId : membershipIncludes(asset, folderId, folders);
}

function smartCollectionCountScope(saved) {
  const entries = catalogEntries().filter(entry => saved.scopeId === null || entry.libraryId === saved.scopeId);
  if (!entries.length || entries.reduce((total, entry) => total + entry.library.assets.length, 0) > 10000) return null;
  const catalog = buildBrowseCatalog(entries, saved.scopeId);
  const folders = new Map(catalog.collections.map(item => [item.id, item]));
  if (saved.section === 'collection' && !folders.has(saved.collectionId)) return null;
  return catalog.assets.filter(asset => insideView(asset, saved.section, saved.collectionId, folders));
}

function visualScopeAssets() {
  return browseCatalog?.assets.filter(asset => !asset.trashed && insideView(asset, section, collectionId, directories)) || [];
}

function browseAssets() {
  const type = assetFilters.kind;
  const matchesSearch = assetSearch.matcher();
  const matchesSmart = smart.matcher();
  const comparison = visual.comparison;
  const matching = browseCatalog.assets.filter(asset => {
    if (!insideView(asset, section, collectionId, directories) || !visual.matches(asset)) return false;
    if (matchesSmart && !matchesSmart(asset)) return false;
    if (comparison) return true;
    const kind = asset.extension === 'livp' ? 'image' : asset.kind;
    if (type !== 'all' && kind !== type) return false;
    if (!assetFilters.matches(asset)) return false;
    return !matchesSearch || matchesSearch(asset);
  });
  const sort = sortSelect.value;
  if (comparison) return matching.sort((a, b) => comparison.ranks.get(a.id) - comparison.ranks.get(b.id));
  const byDate = (a, b) => (b.importedAt || '').localeCompare(a.importedAt || '');
  const byName = (a, b) => collator.compare(a.name, b.name);
  let primary = byDate;
  if (sort === 'name') primary = byName;
  else if (sort === 'format') primary = (a, b) =>
    collator.compare(a.extension || labels[a.kind] || '', b.extension || labels[b.kind] || '');
  else if (sort === 'dimensions') primary = (a, b) => imageArea(b) - imageArea(a);
  else if (sort === 'rating') primary = (a, b) => (b.rating || 0) - (a.rating || 0);
  else if (sort === 'size') primary = (a, b) => (b.byteCount || 0) - (a.byteCount || 0);
  else if (sort === 'recent' && section === 'recent') primary = (a, b) => recentlyViewed.get(b.id) - recentlyViewed.get(a.id);
  const onTie = sort === 'name' ? byDate : sort === 'rating' ? (a, b) => byDate(a, b) || byName(a, b) : byName;
  const direction = reverseSort ? -1 : 1;
  return matching.sort((a, b) => direction * primary(a, b) || onTie(a, b));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const suffixes = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (bytes >= 1024 && unit < suffixes.length - 1) { bytes /= 1024; unit += 1; }
  return `${bytes.toFixed(unit > 0 && bytes < 10 ? 1 : 0)} ${suffixes[unit]}`;
}

function formatDate(iso) {
  const date = new Date(iso);
  return iso && !Number.isNaN(date.getTime()) ? dateFormat.format(date) : '';
}

function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  const seconds = Math.floor(value);
  const minutes = Math.floor(seconds / 60);
  const tail = `${minutes % 60}`.padStart(2, '0') + ':' + `${seconds % 60}`.padStart(2, '0');
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${tail}` : tail;
}

function kindIcon(kind) { return Object.hasOwn(icons, kind) ? kind : 'document'; }

function mediaRatio(width, height) {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width / height : null;
}

function loadImageSources(image, locations, { loaded, failed, decoded = false } = {}) {
  const sources = [...new Set(locations.filter(Boolean))];
  if (window.jiancangTauriPlatform) image.crossOrigin = 'anonymous';
  let index = 0;
  function retry() {
    index += 1;
    if (index < sources.length) image.src = sources[index];
    else {
      image.removeEventListener('load', success);
      image.removeEventListener('error', retry);
      failed?.();
    }
  }
  function finish() {
    image.removeEventListener('load', success);
    image.removeEventListener('error', retry);
    loaded?.(image);
  }
  function success() {
    if (decoded) {
      const src = image.src;
      void image.decode().then(() => { if (image.src === src) finish(); }, () => { if (image.src === src) retry(); });
    } else finish();
  }
  image.addEventListener('load', success);
  image.addEventListener('error', retry);
  image.src = sources[0];
}

function loadThumbnail(image, asset, canUseOriginal, handlers) {
  if (asset.importing) {
    loadImageSources(image, [asset.previewURL], handlers);
    return;
  }
  loadImageSources(image, [assetURL('thumbnail', asset), canUseOriginal && assetURL('original', asset)], handlers);
}

function mountCardThumbnail(picture, asset, button) {
  picture.querySelector('img')?.remove();
  const thumbnail = node('img');
  const waveform = asset.kind === 'audio' && Boolean(window.jiancangTauriPlatform);
  if (waveform) {
    picture.classList.remove('audio-waveform-ready');
    thumbnail.classList.add('audio-waveform');
  }
  thumbnail.alt = '';
  thumbnail.loading = 'lazy';
  thumbnail.decoding = asset.importing ? 'async' : 'sync';
  thumbnail.draggable = false;
  loadThumbnail(thumbnail, asset, asset.available && (asset.kind === 'image' || asset.extension === 'livp'), {
    loaded: () => {
      if (waveform) picture.classList.add('audio-waveform-ready');
      if (!button.isConnected || mediaRatio(asset.width, asset.height)) return;
      const ratio = mediaRatio(thumbnail.naturalWidth, thumbnail.naturalHeight);
      if (ratio) continuous.setRatio(asset.id, ratio);
    },
    failed: () => thumbnail.remove(),
  });
  picture.append(thumbnail);
}

function cardKey(asset, isList) {
  if (asset.importing) return JSON.stringify([asset.name, asset.sourceName, asset.extension]);
  return JSON.stringify([asset.name, asset.sourceName, assetPreviewRevision(asset), asset.trashed, writableAsset(asset),
    isList ? [asset.importedAt, asset.rating] : scopeId === null && catalogEntries().length > 1]);
}

function updateCard(button, asset) {
  const picture = button.querySelector('.asset-picture');
  const badge = picture?.querySelector('.asset-favorite');
  if (!favoriteValue(asset)) { badge?.remove(); return; }
  if (!picture || badge) return;
  const favorite = node('span', 'asset-favorite');
  favorite.setAttribute('aria-label', '已收藏');
  favorite.append(glyph('star'));
  picture.append(favorite);
}

function makeCard(asset, isList) {
  if (asset.importing) {
    const card = node('span', isList ? 'asset-card asset-list-row asset-importing' : 'asset-card asset-importing');
    const picture = node('span', 'asset-picture');
    const frame = node('span', 'asset-frame');
    picture.dataset.kind = asset.kind;
    picture.append(glyph(kindIcon(asset.kind)));
    if (asset.previewURL) mountCardThumbnail(picture, asset, card);
    if (!isList && (asset.kind !== 'image' || asset.extension === 'livp')) {
      picture.append(node('span', 'asset-filetype', asset.extension === 'livp' ? 'LIVE' :
        (asset.extension || labels[asset.kind] || '文件').toUpperCase()));
    }
    frame.append(picture);
    if (isList) appendAssetListCells(card, frame, asset);
    else {
      const caption = node('span', 'asset-caption');
      caption.append(node('span', 'asset-name', asset.name));
      if (scopeId === null && catalogEntries().length > 1) caption.append(node('span', 'asset-info', asset.sourceName));
      card.append(frame, caption);
    }
    card.setAttribute('role', 'img');
    card.setAttribute('aria-label', `${asset.name}，导入中`);
    card.title = asset.name;
    return card;
  }
  const button = makeButton('', null, isList ? 'asset-card asset-list-row' : 'asset-card', event => {
    const current = assetById.get(asset.id);
    if (current) chooseCard(current, button, event);
  });
  button.dataset.assetId = asset.id;
  button.setAttribute('aria-pressed', String(asset.id === selectedId));
  button.setAttribute('aria-label', asset.name || '未命名素材');
  const canOrganize = !asset.trashed && writableAsset(asset);
  button.title = [asset.name, asset.available && '直接拖到其他应用。',
    canOrganize && (asset.available ? '从文件夹图标拖到左侧集合。' : '拖到左侧集合整理。')].filter(Boolean).join('\n');
  const picture = node('span', 'asset-picture');
  const frame = node('span', 'asset-frame');
  frame.append(picture);
  const isLivePhoto = asset.extension === 'livp';
  const kind = isLivePhoto ? 'image' : asset.kind;
  picture.dataset.kind = kind;
  picture.append(glyph(kindIcon(kind)));
  if (kind === 'image' || asset.thumbnailAvailable) mountCardThumbnail(picture, asset, button);
  if (kind === 'audio' && asset.available && window.jiancangTauriPlatform) {
    audioCardPreview.attach(button, picture, assetURL('original', asset, { playback: true }));
  }
  if (!isList && (isLivePhoto || kind !== 'image' || !asset.available)) {
    picture.append(node('span', 'asset-filetype', isLivePhoto ? 'LIVE' : (asset.extension || labels[kind] || '文件').toUpperCase()));
  }
  let collectionGrip;
  if (canOrganize && asset.available) {
    collectionGrip = node('span', 'asset-collection-grip');
    collectionGrip.title = '拖到左侧集合';
    collectionGrip.append(glyph('folder'));
    picture.append(collectionGrip);
  }
  if (isList) appendAssetListCells(button, frame, asset);
  else {
    const caption = node('span', 'asset-caption');
    const title = asset.name || '未命名素材';
    const duration = kind === 'audio' ? formatDuration(asset.duration) : '';
    const detail = asset.available ? duration || (asset.width > 0 && asset.height > 0
      ? `${asset.width} × ${asset.height}` : formatBytes(asset.byteCount)) : '原件尚未到齐';
    const captionDetail = scopeId === null && catalogEntries().length > 1
      ? [asset.sourceName, detail].filter(Boolean).join(' · ') : detail;
    caption.append(node('span', 'asset-name', title), node('span', 'asset-info', captionDetail));
    button.append(frame, caption);
  }
  updateCard(button, asset);
  bindAssetDrag(button, asset, { toCollection: true, collectionGrip });
  button.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (batchMode && batchIds.has(asset.id)) {
      const position = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : null;
      showBatchMenu(button, position);
      return;
    }
    selectAsset(asset.id, button);
    const current = assetById.get(asset.id);
    if (current) void showAssetMenu(current, button, null, event);
  });
  button.addEventListener('dblclick', () => {
    const current = assetById.get(asset.id);
    if (!batchMode && current) openViewer(current, button);
  });
  return button;
}

function imageArea(asset) { return asset.width > 0 && asset.height > 0 ? asset.width * asset.height : 0; }

function appendAssetListCells(button, frame, asset) {
  const title = asset.name || '未命名素材';
  const format = asset.extension?.toUpperCase() || labels[asset.kind] || '文件';
  const dimensions = imageArea(asset) ? `${asset.width} × ${asset.height}` : '';
  const size = formatBytes(asset.byteCount);
  const date = Date.parse(asset.importedAt);
  const added = Number.isFinite(date) ? listDateFormat.format(date) : '';
  const rating = asset.rating > 0 ? `${asset.rating} 星` : '';
  const source = asset.sourceName || '';
  const status = !asset.available && !asset.importing ? '原件尚未到齐' : '';
  const name = node('span', 'asset-list-name');
  const description = node('span', 'asset-list-description');
  const detail = node('span', 'asset-list-detail');
  const compact = [dimensions, rating].filter(Boolean).join(' · ');
  detail.append(node('span', 'asset-list-origin', [source, status].filter(Boolean).join(' · ')));
  if (compact) detail.append(node('span', 'asset-list-compact', compact));
  description.append(node('span', 'asset-name', title), detail);
  name.append(frame, description);

  const cells = [['format', format], ['dimensions', dimensions], ['size', size], ['rating', rating], ['date', added]];
  button.append(name, ...cells.map(([column, content]) => {
    const value = node('span', 'asset-list-value', content || '—');
    value.dataset.listColumn = column;
    value.setAttribute('aria-hidden', 'true');
    if (content) value.title = content;
    return value;
  }));
  button.setAttribute('aria-label', [title, format, dimensions, size, rating, added, source, status].filter(Boolean).join('，'));
  button.addEventListener('keydown', event => {
    const paging = ['Home', 'End', 'PageUp', 'PageDown'].includes(event.key);
    const extending = event.shiftKey && ['ArrowUp', 'ArrowDown'].includes(event.key);
    if (!paging && !extending) return;
    const id = continuous.neighbor(asset.id, event.key);
    if (!id) return;
    event.stopPropagation();
    event.preventDefault();
    if (id === asset.id) return;
    const next = continuous.focus(id);
    if (event.shiftKey) selectAssetRange(id, asset.id, event.ctrlKey || event.metaKey);
    else selectAsset(id, next);
  });
}

function listSortKey(key) { return key === 'date' && section !== 'recent' ? 'recent' : key; }

function updateAssetListControls() {
  const comparison = !!visual.comparison;
  sortSelect.querySelector('option[value="date"]').hidden = section !== 'recent' && sortSelect.value !== 'date';
  for (const column of listHeader.children) {
    const key = column.dataset.listSort;
    const active = !comparison && (listSortKey(key) === sortSelect.value || key === 'date' && sortSelect.value === 'date');
    const ascending = ['format', 'name'].includes(key) !== reverseSort;
    const hint = ['name', 'format'].includes(key) ? ascending ? '正序' : '倒序' :
      key === 'date' ? ascending ? '由旧到新' : '由新到旧' : ascending ? '由小到大' : '由大到小';
    column.dataset.direction = active ? ascending ? 'ascending' : 'descending' : '';
    column.disabled = comparison;
    column.setAttribute('aria-pressed', String(active));
    column.setAttribute('aria-label', active ? `按${column.textContent}排序，当前${hint}` : `按${column.textContent}排序`);
    column.title = comparison ? '当前按相似度排列' : column.getAttribute('aria-label');
  }
}

function galleryTitle() {
  const title = byId('gallery-title');
  const breadcrumbs = byId('collection-parents');
  const parentNames = [];
  const visited = new Set();
  const folder = directories.get(collectionId);
  for (let parent = folder?.parentId; directories.has(parent) && !visited.has(parent); parent = directories.get(parent).parentId) {
    visited.add(parent);
    parentNames.push(directories.get(parent).name);
  }
  breadcrumbs.hidden = parentNames.length === 0;
  breadcrumbs.textContent = parentNames.reverse().join(' / ');
  title.textContent = visual.comparison ? '相似图片'
    : smart.active?.name || folder?.name || sections.find(view => view.id === section)?.title || '全部素材';
}

function renderGallery({ animate = true, preserveViewport = false } = {}) {
  if (!browseCatalog) return;
  cancelMarquee();
  galleryTitle();
  byId('sort-select').querySelector('option[value="recent"]').textContent = section === 'recent' ? '最近查看' : '最近添加';
  visibleAssets = browseAssets();
  if (batchMode) {
    const visible = new Set(visibleAssets.map(asset => asset.id));
    const remaining = new Set([...batchIds].filter(id => visible.has(id)));
    storeAssetSelection(remaining, remaining.has(selectedId) ? selectedId : remaining.values().next().value);
    if (!visible.has(batchAnchor)) batchAnchor = selectedId;
  }
  previewableAssets = visibleAssets.filter(canPreview);
  previewIndices.clear();
  previewableAssets.forEach((asset, index) => previewIndices.set(asset.id, index));
  if (viewer && !previewIndices.has(viewer.assetId)) {
    if (viewerRemoval?.id === viewer.assetId) {
      const replacementIndex = Math.min(viewerRemoval.index, previewableAssets.length - 1);
      const next = previewableAssets[replacementIndex];
      const direction = replacementIndex < viewerRemoval.index ? -1 : 1;
      viewerRemoval = null;
      animate = false;
      if (next) {
        prepareViewerPageMotion(direction);
        viewer.assetId = viewer.entryId = selectedId = next.id;
        rememberView(next);
      } else closeViewer({ restore: false });
    } else closeViewer({ restore: false });
  }
  if (selectedId && !visibleAssets.some(asset => asset.id === selectedId)) selectedId = null;
  renderGalleryGrid({ animate, preserveViewport });
  updateAssetListControls();
  updateBatchActions();
  const inStash = section === 'stash';
  byId('clear-selection-stash').hidden = !inStash || !selectionStash.size;
  byId('save-smart-collection').disabled = inStash;
  renderInspector();
  if (viewer) {
    if (preserveViewport) viewer.scrollTop = scrollingGallery.scrollTop;
    updateViewer();
  }
}

function renderGalleryGrid({ animate = false, preserveViewport = false, importsOnly = false } = {}) {
  if (!browseCatalog) return;
  const importing = intake.previewItems();
  if (importsOnly && importing.length === visibleImports.length &&
      importing.every((asset, index) => asset === visibleImports[index])) return;
  visibleImports = importing;
  const presented = importing.length ? [...importing, ...visibleAssets] : visibleAssets;
  continuous.render(presented, { layout: preferences.layout, tileSize: preferences.tileSize,
    captions: preferences.captions, selectedId, batchIds: batchMode ? batchIds : null, animate, preserveViewport });
  const inStash = section === 'stash';
  const unavailable = inStash ? [...selectionStash].filter(id => {
    const asset = assetById.get(id);
    return !asset || asset.trashed || trashWrites.has(id);
  }).length : 0;
  const unavailableText = unavailable ? ` · ${counts.format(unavailable)} 项暂不可用` : '';
  const retentionText = section === 'trash' && state.libraries.some(entry =>
    entry.kind === 'local' && (scopeId === null || scopeId === entry.id)) ? ' · 本地库保留 30 天' : '';
  byId('gallery-count').textContent = `${counts.format(presented.length)} 份${unavailableText}${retentionText}`;
  renderEmptyResults(presented.length === 0);
}

function renderEmptyResults(empty) {
  const element = byId('empty-results');
  element.hidden = !empty;
  if (!empty) return;
  const filtered = searchInput.value.trim().length > 0 || assetFilters.activeCount > 0 || visual.active;
  const title = filtered ? '没有匹配的素材' :
    section === 'stash' ? selectionStash.size ? '暂存素材暂不可用' : '暂存选片为空' :
      section === 'recent' ? '还没有查看记录' : section === 'untagged' ? '没有未标注素材' : '这里还没有素材';
  element.replaceChildren(glyph(filtered ? 'search' : 'tray'), node('h2', '', title));
  if (filtered) element.append(node('p', '', '试试其他关键词，或清除文件类型筛选。'), makeButton('清除筛选', null, 'outline-button', () => {
    assetSearch.restore('');
    assetFilters.reset({ notify: false });
    visual.restore({}, false);
    resetGallery();
    searchInput.focus();
  }));
  if (!filtered && section === 'stash' && !selectionStash.size) {
    element.append(node('p', '', '在素材右键菜单中选择「加入暂存选片」。'));
  }
  if (!filtered && (section === 'all' || section === 'collection') && localTarget()) {
    element.append(makeButton('导入素材', 'tray', 'outline-button', () => void intake.open()));
  }
}

function storeAssetSelection(ids, primary) {
  selectedId = ids.has(primary) ? primary : (ids.values().next().value ?? null);
  batchMode = ids.size > 1;
  batchIds.clear();
  if (batchMode) for (const id of ids) batchIds.add(id);
}

function currentSelectionIds() {
  return new Set(batchMode ? batchIds : selectedId ? [selectedId] : []);
}

function applyAssetSelection(ids, primary) {
  storeAssetSelection(ids, primary);
  continuous.setSelection(selectedId);
  continuous.setBatchSelection(batchMode ? batchIds : null);
  updateBatchActions();
  renderInspector();
}

function selectAsset(id, focusFrom) {
  if (focusFrom) restoreFocus = id;
  batchAnchor = id;
  applyAssetSelection(new Set(id ? [id] : []), id);
}

function chooseCard(asset, button, event) {
  const additive = event.ctrlKey || event.metaKey;
  if (event.shiftKey) selectAssetRange(asset.id, selectedId, additive);
  else if (additive) toggleBatchItem(asset.id);
  else selectAsset(asset.id, button);
}

function endBatchSelection() {
  if (batchMode) selectAsset(null);
}

function selectAssetRange(id, from, additive) {
  const anchor = batchAnchor ?? from ?? id;
  const start = visibleAssets.findIndex(asset => asset.id === anchor);
  const end = visibleAssets.findIndex(asset => asset.id === id);
  if (start < 0 || end < 0) { selectAsset(id); return; }
  const ids = additive ? currentSelectionIds() : new Set();
  for (let i = Math.min(start, end); i <= Math.max(start, end); i++) ids.add(visibleAssets[i].id);
  batchAnchor = anchor;
  applyAssetSelection(ids, id);
}

function toggleBatchItem(id) {
  const ids = currentSelectionIds();
  if (!ids.delete(id)) ids.add(id);
  batchAnchor = id;
  applyAssetSelection(ids, id);
}

function updateBatchActions() {
  if (!batchMode) {
    document.querySelector('.tauri-menu-layer:popover-open:has(> [aria-label="所选素材操作"])')?.hidePopover();
  }
  const inspectorExport = byId('inspector-batch-export');
  if (inspectorExport) inspectorExport.disabled = batchWorking || batchIds.size === 0;
}

async function showBatchMenu(anchor, position) {
  closeWorkspaceMenus();
  const selected = selectedBatchAssets();
  if (!batchMode || !selected.length) return;
  const local = selectedLocalAssets(selected);
  const trash = section === 'trash';
  const editable = selectedWritableAssets(selected);
  const metadata = selectedMetadataAssets(selected);
  const canOrganize = !trash && editable.length > 0;
  const canEditMetadata = !trash && metadata.length > 0;
  const canRestore = trash && selectedWritableAssets(selected, true).length > 0;
  const canPurge = trash && selected.some(asset => asset.trashed && canOrganizeFromMenu(asset.sourceLibraryId) &&
    !trashWriteInProgress(asset.sourceLibraryId));
  const images = selected.filter(isProjectImage);
  const alreadyStashed = selected.every(asset => selectionStash.has(asset.id));
  const { showMenu, clipboardItems } = window.jiancangAssetContextMenu;
  const item = (label, action, options) => ({ label, action, enabled: !batchWorking, ...options });
  const copyFields = clipboardItems(selected).map(field => ({
    ...field,
    action: assets => copyAssetInformation(assets, field.action),
  }));
  const rating = [1, 2, 3, 4, 5, 0].map(value => item(value ? `${value} 星` : '清除评分',
    () => batchOrganize('rating', value), { check: 'radio', checked: metadata.every(asset => (asset.rating ?? 0) === value) }));
  const groups = [
    [
      canCompareImages(selected) && item('对照', compareSelectedImages, { enabled: true }),
      selected.some(canRetrieveOriginal) && item('取回原件…', openCloudOriginals),
      selected.some(imageConversion.canConvert) && item('转换图片…', assets => imageConversion.open(assets)),
      item('导出原件…', exportSelectedAssets),
      item('导出选项…', assets => exportTools.open(assets)),
    ],
    [
      item('复制素材信息', undefined, { children: copyFields }),
      !trash && canCopyAssets(selected) && item('复制到其他库…', assets => intake.open({ assets })),
    ],
    [
      images.length > 0 && item('加入灵感板…', assets => boards.add(assets.filter(isProjectImage))),
      images.some(asset => asset.available) && item('AI 整理建议…', assets => suggestionTools.open(
        assets.filter(asset => isProjectImage(asset) && asset.available))),
    ],
    [
      canEditMetadata && item(local.length ? '编辑信息…' : '批量整理…', () => batchOrganize('edit')),
      canEditMetadata && item('重命名…', () => batchAssetAction('renameAssets')),
      canOrganize && item(editable.every(asset => asset.favorite) ? '取消收藏' : '加入收藏', () => batchOrganize('favorite')),
      canEditMetadata && item('评分', undefined, { children: rating }),
      !trash && item(alreadyStashed ? '移出暂存选片' : '加入暂存选片',
        assets => updateSelectionStash(assets, alreadyStashed ? 'remove' : 'add')),
      removableCollection(local) && item('移出集合…', assets => removeCollectionMembership(selectedLocalAssets(assets))),
    ],
    [
      item('全选当前结果', selectAllVisibleAssets, { enabled: !batchWorking && visibleAssets.length > 0 }),
      item('取消选择', clearSelection, { enabled: true }),
    ],
    [
      canRestore && item('恢复素材', () => batchAssetAction('restore')),
      canOrganize && item('删除…', () => batchAssetAction('trash'), { danger: true }),
      canPurge && item('永久删除…', purgeSelectedTrash, { danger: true, enabled: !trashActionBusy() }),
    ],
  ].map(group => group.filter(Boolean)).filter(group => group.length);
  const items = groups.flatMap((group, index) => index ? [null, ...group] : group);

  try {
    const action = await showMenu(items, position ?? assetMenuAnchor(undefined, anchor), '所选素材操作', {
      heading: `已选 ${counts.format(selected.length)} 项`, invoker: anchor,
    });
    if (!action || !batchMode || selected.length !== batchIds.size || selected.some(asset => !batchIds.has(asset.id))) return;
    await action(selectedBatchAssets());
  } catch (error) {
    showToast(error?.message || '无法执行所选素材操作。');
  }
}

function selectedBatchAssets() { return [...batchIds].map(id => assetById.get(id)).filter(Boolean); }
function isProjectImage(asset) { return !asset.trashed && (asset.kind === 'image' || asset.extension === 'livp'); }

function selectedLocalAssets(assets = selectedBatchAssets()) {
  const id = assets[0]?.sourceLibraryId;
  return writableAsset(assets[0]) && assets.every(asset => asset.sourceLibraryId === id) ? assets : [];
}

function selectedWritableAssets(assets, trashed = false) {
  const writable = new Set(writableLibraries().map(entry => entry.id));
  return assets.filter(asset => !!asset.trashed === trashed && writable.has(asset.sourceLibraryId));
}

function selectedMetadataAssets(assets) {
  const writable = new Set(state.libraries.filter(entry => isWritable(entry) || eagleMetadataWritable(entry)).map(entry => entry.id));
  return assets.filter(asset => !asset.trashed && writable.has(asset.sourceLibraryId));
}

function selectedLibraryGroups(assets) {
  const groups = new Map();
  for (const asset of assets) {
    const id = asset.sourceLibraryId;
    let group = groups.get(id);
    if (!group) {
      group = { id, kind: asset.sourceKind, name: asset.sourceName || '未命名素材库', ids: [],
        ...(asset.sourceKind === 'eagle' && { expected: Object.create(null) }) };
      groups.set(id, group);
    }
    group.ids.push(asset.sourceAssetId);
    if (group.expected) group.expected[asset.sourceAssetId] = {
      rating: asset.rating ?? 0, note: asset.note ?? '', sourceURL: asset.sourceURL ?? null,
    };
  }
  return [...groups.values()];
}

function batchOrganize(mode, rating) {
  if (batchWorking || section === 'trash') return;
  const selected = selectedBatchAssets();
  const local = selectedLocalAssets(selected);
  if (local.length) {
    if (mode === 'favorite') void organizer.toggleFavorite(local);
    else if (mode === 'rating') void organizer.setRatings(local, rating);
    else batchLocal('editAssets');
    return;
  }
  const editable = mode === 'favorite' ? selectedWritableAssets(selected) : selectedMetadataAssets(selected);
  organizer.editAcrossLibraries(selectedLibraryGroups(editable).map(group => ({ ...group, collections: localCollections(group.id) })), {
    mode, skipped: selected.length - editable.length, favorite: !editable.every(asset => asset.favorite), rating,
  });
}

function batchAssetAction(action) {
  if (batchWorking || (action === 'restore') !== (section === 'trash')) return false;
  const selected = selectedBatchAssets();
  const writable = action === 'renameAssets' ? selectedMetadataAssets(selected) : selectedWritableAssets(selected, action === 'restore');
  if (!writable.length) return false;
  if (writable.length === selected.length && selectedLocalAssets(selected).length) {
    batchLocal(action);
    return true;
  }
  const groups = selectedLibraryGroups(writable);
  const skipped = selected.length - writable.length;
  if (action === 'renameAssets') organizer.renameAcrossLibraries(groups, writable, skipped);
  else organizer.changeTrashAcrossLibraries(groups, action, skipped);
  return true;
}

function batchLocal(action) {
  const assets = selectedLocalAssets();
  if (assets.length) void organizer[action](assets[0].sourceLibraryId, assets, localCollections(assets[0].sourceLibraryId));
}

function removableCollection(assets) {
  const folder = section === 'collection' && !smart.active ? directories.get(collectionId) : null;
  if (!folder || folder.sourceLibraryId || !assets.length) return null;
  const registration = folder.id.split(':')[0];
  if (!assets.every(asset => writableAsset(asset) && !asset.trashed && asset.sourceLibraryId === registration &&
    asset.collectionIds.includes(folder.id))) return null;
  return folder;
}

function removeCollectionMembership(assets) {
  const folder = removableCollection(assets);
  if (folder) organizer.removeFromCollection(assets[0].sourceLibraryId, assets, folder);
}

function updateFavoriteButton(button, asset) {
  button.hidden = !writableAsset(asset) || asset.trashed;
  const favorite = favoriteValue(asset);
  const write = favoriteWrites.get(asset.id);
  button.setAttribute('aria-pressed', String(favorite));
  button.setAttribute('aria-busy', String(Boolean(write)));
  button.title = write?.queued ? (write.desired === write.sent ? '已加入 iCloud 同步队列' : '等待 iCloud 同步后保存')
    : favorite ? '取消收藏' : '加入收藏';
}

function favoriteValue(asset) {
  return favoriteWrites.get(asset.id)?.desired ?? Boolean(asset.favorite);
}

function refreshFavoriteControls(asset) {
  const current = inspectorObserved(asset) ?? assetById.get(asset.id) ?? asset;
  if (viewer?.assetId === asset.id) updateFavoriteButton(byId('viewer-quick-favorite'), current);
  if (preview.dataset.inspectedAsset === asset.id) {
    const button = byId('inspector-quick-favorite');
    if (button) updateFavoriteButton(button, current);
  }
  const card = continuous.renderedCard(asset.id);
  if (card) updateCard(card, current);
}

function completeFavorite(write, current, error) {
  favoriteWrites.delete(write.asset.id);
  if (error) showToast(error);
  if (section === 'favorites' && write.listed !== Boolean(current?.favorite) && browseCatalog) {
    if (viewer?.assetId === write.asset.id && !current?.favorite) {
      viewerRemoval = { id: write.asset.id, index: previewIndices.get(write.asset.id) ?? 0 };
    }
    renderGallery({ animate: false, preserveViewport: true });
  }
  refreshFavoriteControls(current ?? write.asset);
}

function toggleFavoriteAsset(asset) {
  if (!writableAsset(asset) || asset.trashed) return;
  let write = favoriteWrites.get(asset.id);
  if (!write) {
    const entry = state.libraries.find(item => item.id === asset.sourceLibraryId);
    write = { asset, libraryIdentity: entry.libraryId, listed: Boolean(asset.favorite), desired: Boolean(asset.favorite) };
    favoriteWrites.set(asset.id, write);
  }
  write.desired = !write.desired;
  refreshFavoriteControls(asset);
  if (!write.running && !write.queued) void saveFavorite(write);
}

async function saveFavorite(write) {
  const { asset } = write;
  const entry = state.libraries.find(item => item.id === asset.sourceLibraryId);
  const current = inspectorObserved(asset);
  if (!current || current.trashed || !isWritable(entry) || entry.libraryId !== write.libraryIdentity) {
    completeFavorite(write, current, '素材库已变化，收藏暂未保存。');
    return;
  }
  const favorite = write.desired;
  write.running = true;
  write.awaitingCatalog = false;
  write.sent = favorite;
  const previousRevision = inspectorCatalog(asset).revision;
  try {
    const result = await bridge.mutateLocalLibrary(asset.sourceLibraryId,
      { action: 'edit', ids: [asset.sourceAssetId], favorite });
    if (!result?.ok) throw new Error(result?.message || '收藏保存失败，请重试。');
    write.running = false;
    if (result.pending > 0) {
      write.queued = true;
      write.queuedRevision = result.state ? inspectorCatalog(asset, result.state).revision : previousRevision;
      refreshFavoriteControls(asset);
      reconcileFavoriteWrites();
    } else if (write.desired !== favorite) void saveFavorite(write);
    else {
      // The Electron bridge acknowledges separately from its catalogue event.
      const observed = inspectorObserved(asset);
      const confirmed = result.state && inspectorObserved(asset, result.state);
      if (observed && Boolean(observed.favorite) === favorite) completeFavorite(write, observed);
      else if (confirmed && Boolean(confirmed.favorite) !== favorite) {
        completeFavorite(write, observed, '收藏状态已变化，请重试。');
      } else {
        write.awaitingCatalog = true;
        refreshFavoriteControls(asset);
      }
    }
  } catch (error) {
    completeFavorite(write, inspectorObserved(asset), error?.message || '收藏保存失败，请重试。');
  }
}

function reconcileFavoriteWrites() {
  for (const write of favoriteWrites.values()) {
    if (write.running) continue;
    const entry = state.libraries.find(item => item.id === write.asset.sourceLibraryId);
    const current = inspectorObserved(write.asset);
    if (!entry || entry.libraryId !== write.libraryIdentity) {
      completeFavorite(write, current, '素材库已变化，收藏暂未保存。');
    } else if (!current || entry.status === 'unavailable' || entry.syncLogIncomplete) continue;
    else if (write.queued && entry.writeStatus?.pending === 0 &&
        (Boolean(current.favorite) === write.sent || inspectorCatalog(write.asset).revision !== write.queuedRevision)) {
      write.queued = false;
      if (write.desired !== write.sent) void saveFavorite(write);
      else if (Boolean(current.favorite) === write.desired) completeFavorite(write, current);
      else completeFavorite(write, current, '同步后的收藏状态已变化，请重试。');
    } else if (write.awaitingCatalog && Boolean(current.favorite) === write.desired) completeFavorite(write, current);
  }
}

function compareSelectedImages() {
  openImageComparison(selectedBatchAssets());
}

function openImageComparison(assets) {
  if (compareDialog.open || !canCompareImages(assets)) return;
  preview.querySelector('video, audio')?.pause();
  comparison?.dispose();
  comparison = window.createJianCangComparison({ items: assets.map(asset => ({
    name: asset.name, libraryName: asset.sourceName,
    original: asset.available ? assetURL('original', asset) : null, thumbnail: assetURL('thumbnail', asset),
  })) });
  byId('compare-content').replaceChildren(comparison.element);
  compareDialog.showModal();
}

function canCompareImages(assets) {
  return Array.isArray(assets) && assets.length >= 2 && assets.length <= 4 &&
    assets.every(asset => asset && (asset.available || asset.thumbnailAvailable) && isProjectImage(asset));
}

function selectAllVisibleAssets() {
  applyAssetSelection(new Set(visibleAssets.map(asset => asset.id)), selectedId);
  batchAnchor = selectedId;
}

async function exportSelectedAssets() {
  if (!batchIds.size || batchWorking) return;
  const references = [...batchIds].map(id => assetById.get(id)).filter(Boolean)
    .map(asset => ({ id: asset.sourceAssetId, registrationId: asset.sourceLibraryId }));
  batchWorking = true;
  updateBatchActions();
  try {
    const result = await bridge.exportBatch(references);
    if (result?.cancelled) return;
    if (result?.failed?.length) {
      byId('export-results-summary').textContent = `已导出 ${result.written} 项，${result.failed.length} 项未完成。`;
      byId('export-results-list').replaceChildren(...result.failed.map(item => node('li', '', `${item.name} · ${item.message}`)));
      if (!exportDialog.open) exportDialog.showModal();
    } else showToast(result?.message || `已导出 ${result?.written || 0} 项原件。`);
  } catch { showToast('批量导出未完成，请重试。'); }
  finally {
    batchWorking = false;
    updateBatchActions();
  }
}

function clearSelection() {
  selectAsset(null);
  continuous.focus(restoreFocus, { scroll: false });
  restoreFocus = null;
}

function mediaMessage(icon, message) {
  const box = node('div', 'media-message');
  box.append(glyph(icon), document.createTextNode(message));
  return box;
}

function retryMessage(icon, message, asset) {
  const box = mediaMessage(icon, message);
  const retry = makeButton('重新读取', 'refresh', 'outline-button retry-preview', event => {
    const button = event.currentTarget;
    button.disabled = true;
    void retryAssetPreview(asset).finally(() => { button.disabled = false; });
  });
  box.append(retry);
  if (icon === 'cloud' && canRetrieveOriginal(asset)) {
    box.append(makeButton('取回原件', 'cloudDownload', 'outline-button retry-preview', () => openCloudOriginals([asset])));
  }
  return box;
}

function canPreview(asset) {
  return asset.extension === 'livp' || asset.kind === 'image' || (asset.kind === 'video' && asset.thumbnailAvailable) ||
    (asset.available && (['video', 'audio', 'pdf'].includes(asset.kind) || window.canJianCangPreviewText(asset)));
}

function mountLivePhoto(element, asset, onMediaChange, ticket) {
  const frame = node('div', 'live-photo');
  const still = makePhoto(asset.name);
  let cover = photoSeed(asset, element === viewerMedia) || still;
  still.hidden = true;
  let movie = null;
  let entering;
  let leaving;
  let coverFailed = false;
  const unavailable = retryMessage('image', '暂时无法显示封面。', asset);
  unavailable.hidden = true;
  const current = () => mediaLoads.get(element) === ticket && frame.parentNode === element;
  loadImageSources(still, [assetURL('original', asset), assetURL('thumbnail', asset)], {
    decoded: true,
    loaded: () => {
      if (!current()) return;
      const visibility = cover.style.visibility;
      if (cover !== still) cover.replaceWith(still);
      cover = still;
      still.hidden = false;
      still.style.visibility = visibility;
      onMediaChange?.(still);
    },
    failed: () => {
      if (!current() || cover !== still) return;
      coverFailed = true;
      unavailable.hidden = !!movie && !movie.hidden;
      if (!movie || movie.hidden) onMediaChange?.(null);
    },
  });

  const status = node('p', 'live-photo-status');
  status.setAttribute('role', 'status');
  const play = makeButton('实况', 'livePhoto', 'live-photo-play', () => movie ? stop() : start());
  function syncControl() {
    const label = movie ? '停止实况照片' : '播放实况照片';
    play.title = label;
    play.setAttribute('aria-label', label);
    play.setAttribute('aria-pressed', String(!!movie));
  }

  function disposeMovie(video) {
    video.removeAttribute('src');
    video.remove();
    video.load();
  }

  function clearLeaving() {
    if (!leaving) return;
    const previous = leaving;
    leaving = null;
    previous.animation.cancel();
    disposeMovie(previous.video);
  }

  function stop({ failed = false, quiet = false } = {}) {
    clearLeaving();
    if (!movie) return;
    const previous = movie;
    movie = null;
    const opacity = Number(getComputedStyle(previous).opacity);
    previous.pause();
    entering?.cancel();
    entering = null;
    const hasCover = !cover.hidden;
    cover.style.visibility = '';
    unavailable.hidden = !coverFailed;
    const fade = hasCover && !previous.hidden && !failed && !quiet && motion(previous, [{ opacity }, { opacity: 0 }], 155);
    if (fade) {
      leaving = { video: previous, animation: fade };
      void fade.finished.then(() => { if (leaving?.video === previous) clearLeaving(); }, () => {});
    } else disposeMovie(previous);
    status.textContent = failed ? '实况暂时无法播放。' : '';
    syncControl();
    if (!quiet && current()) onMediaChange?.(hasCover ? cover : null);
  }

  function start() {
    if (!current() || movie) return;
    clearLeaving();
    status.textContent = '';
    const active = node('video', 'live-photo-motion');
    movie = active;
    active.hidden = true;
    active.loop = livePhotoLoops.has(asset.id);
    active.playsInline = true;
    active.disablePictureInPicture = true;
    active.setAttribute('aria-label', asset.name);
    const fail = () => { if (movie === active) stop({ failed: true }); };
    active.addEventListener('playing', () => {
      if (movie !== active || !current()) return;
      active.hidden = false;
      unavailable.hidden = true;
      onMediaChange?.(active);
      const hideCover = () => { if (movie === active) cover.style.visibility = 'hidden'; };
      entering = motion(active, [{ opacity: 0 }, { opacity: 1 }], 175);
      if (entering) void entering.finished.then(hideCover, () => {});
      else hideCover();
    }, { once: true });
    active.addEventListener('error', fail, { once: true });
    active.addEventListener('ended', () => { if (movie === active) stop(); }, { once: true });
    frame.append(active);
    active.src = assetURL('live-motion', asset);
    syncControl();
    void active.play().catch(fail);
  }

  livePhotoPlayers.set(element, {
    assetId: asset.id, stop,
    toggleLoop() {
      if (livePhotoLoops.delete(asset.id)) {
        if (movie) movie.loop = false;
      } else {
        livePhotoLoops.add(asset.id);
        if (movie) movie.loop = true;
        else start();
      }
    },
  });
  syncControl();
  frame.append(cover, unavailable, play, status);
  element.replaceChildren(frame);
  if (cover !== still) onMediaChange?.(cover);
}

function makePhoto(name) {
  const image = node('img');
  image.alt = name;
  image.decoding = 'async';
  image.draggable = false;
  return image;
}

function cardImage(id) {
  return continuous.renderedCard(id)?.querySelector('.asset-picture img');
}

function photoSeedSource(asset, useInspector) {
  const image = cardImage(asset.id);
  if (window.previewTransitions.imageSize(image)) return image;
  if (!useInspector || preview.dataset.inspectedAsset !== asset.id) return null;
  const stage = preview.querySelector('.preview-stage');
  if (mediaLoads.get(stage)?.loadingPrevious) return null;
  return stage?.querySelector(':is(img, canvas[data-preview-seed]):not([hidden])');
}

function photoSeed(asset, useInspector) {
  const seed = window.previewTransitions.copyImage(photoSeedSource(asset, useInspector), 1200);
  if (seed) {
    seed.dataset.previewSeed = 'true';
    seed.dataset.previewPhotoId = asset.id;
    seed.setAttribute('aria-hidden', 'true');
  }
  return seed;
}

function displayedPhoto(element) {
  const stills = [...element.querySelectorAll(':is(:scope, .offline-preview) > :is(img, canvas[data-preview-seed])')]
    .filter(image => !image.hidden && window.previewTransitions.imageSize(image));
  return stills.find(image => Number(getComputedStyle(image).opacity) >= 1) ?? null;
}

function isStillPhoto(asset) { return asset.kind === 'image' && asset.extension !== 'livp'; }

function mountPhoto(element, asset, onMediaChange, ticket, displayed) {
  const originalURL = assetURL('original', asset);
  const thumbnailURL = assetURL('thumbnail', asset);
  const image = makePhoto(asset.name);
  image.dataset.previewPhotoId = asset.id;
  const isViewer = element === viewerMedia;
  const changingPage = isViewer && viewer?.pageDirection;
  const seed = displayed?.dataset.previewPhotoId === asset.id ? displayed : photoSeed(asset, isViewer) || displayed;
  const loadingPrevious = seed && seed.dataset.previewPhotoId !== asset.id;
  const underlay = isViewer ? 'viewer-photo-underlay' : 'inspector-photo-underlay';
  const loading = loadingPrevious ? node('div', 'inspector-photo-loading', '正在读取图片…') : null;
  ticket.loadingPrevious = !!loading;
  if (seed) {
    for (const animation of seed.getAnimations()) animation.cancel();
    seed.classList.remove(underlay);
  }
  if (element.firstElementChild !== seed || element.childElementCount !== 1) {
    element.replaceChildren(seed || mediaMessage('image', '正在读取图片…'));
  }
  if (loading) {
    loading.setAttribute('role', 'status');
    element.append(loading);
  }
  if (seed) onMediaChange?.(seed);
  loadImageSources(image, [originalURL, thumbnailURL], {
    decoded: true,
    loaded: () => {
      if (mediaLoads.get(element) !== ticket) return;
      if (!mediaRatio(asset.width, asset.height) && originalImageFormats.has(asset.extension) && image.currentSrc === originalURL) {
        image.dataset.previewOriginal = 'true';
        updateInspectorDimensions(asset, image);
      }
      ticket.loadingPrevious = false;
      loading?.remove();
      if (seed && !reduceMotion.matches) {
        seed.classList.add(underlay);
        image.style.opacity = '0';
        element.prepend(image);
        onMediaChange?.(image);
        const handoff = motion(image, [{ opacity: 0 }, { opacity: 1 }], 125);
        image.style.removeProperty('opacity');
        const removeSeed = () => { if (mediaLoads.get(element) === ticket) seed.remove(); };
        if (handoff) void handoff.finished.then(removeSeed, removeSeed);
        else removeSeed();
        return;
      }
      element.replaceChildren(image);
      onMediaChange?.(image);
      if (!seed && isViewer && !changingPage) motion(image, [{ opacity: 0.35 }, { opacity: 1 }], 125);
    },
    failed: () => {
      if (mediaLoads.get(element) !== ticket || (seed && !loadingPrevious)) return;
      ticket.loadingPrevious = false;
      element.replaceChildren(retryMessage('image', '暂时无法预览。可以导出原件，或在资源管理器中查看。', asset));
      onMediaChange?.(null);
    },
  });
}

function disposeDocumentPreview(element) {
  livePhotoPlayers.get(element)?.stop({ quiet: true });
  livePhotoPlayers.delete(element);
  window.disposeJianCangTextPreview(element);
  const preview = pdfPreviews.get(element);
  if (!preview) return;
  preview.dispose();
  pdfPreviews.delete(element);
}

function mountMedia(element, asset, onMediaChange) {
  const previous = mediaLoads.get(element);
  const photo = isStillPhoto(asset);
  const samePhoto = previous?.assetId === asset.id;
  const keepVisible = samePhoto || (element.classList.contains('preview-stage') && asset.available);
  const visible = photo && previous?.photo && keepVisible ? displayedPhoto(element) : null;
  const displayed = visible && (asset.available || visible.dataset.previewPhotoId === asset.id) ? visible : null;
  disposeDocumentPreview(element);
  const ticket = { assetId: asset.id, photo };
  mediaLoads.set(element, ticket);
  if (!asset.available) {
    const message = { eagle: 'Eagle 原件暂不可用。', local: '本地原件暂不可用。', jiancang: '等待 iCloud Drive 下载原件。' }[asset.sourceKind];
    const fallback = retryMessage('cloud', message, asset);
    if (asset.kind === 'image' || asset.extension === 'livp' || asset.thumbnailAvailable) {
      const seed = displayed || (element === viewerMedia && photoSeed(asset, true));
      const image = makePhoto(asset.name);
      image.dataset.previewPhotoId = asset.id;
      image.hidden = true;
      const offline = node('div', 'offline-preview');
      const hint = node('div', 'offline-hint');
      const description = node('span', '', displayed ? '原件暂未到齐，显示上次预览' : '缩略图 · 原件暂未到齐');
      hint.append(description, makeButton('重试', null, 'status-button', () => {
        void retryAssetPreview(asset);
      }));
      if (canRetrieveOriginal(asset)) {
        hint.append(makeButton('取回原件', null, 'status-button', () => openCloudOriginals([asset])));
      }
      hint.hidden = !seed;
      fallback.hidden = !!seed;
      offline.append(seed || image, hint, fallback);
      element.replaceChildren(offline);
      if (seed) onMediaChange?.(seed);
      loadThumbnail(image, asset, false, { loaded: () => {
        if (mediaLoads.get(element) !== ticket) return;
        if (seed) seed.replaceWith(image);
        description.textContent = '缩略图 · 原件暂未到齐';
        image.hidden = false;
        fallback.hidden = true;
        hint.hidden = false;
        onMediaChange?.(image);
      } });
    } else element.replaceChildren(fallback);
    return;
  }
  if (!canPreview(asset)) {
    element.replaceChildren(mediaMessage(kindIcon(asset.kind), '可导出原件，或在资源管理器中查看。'));
    return;
  }
  if (asset.extension === 'livp') {
    mountLivePhoto(element, asset, onMediaChange, ticket);
    return;
  }
  if (asset.kind === 'image') {
    mountPhoto(element, asset, onMediaChange, ticket, displayed);
    return;
  }
  if (asset.kind === 'pdf') {
    pdfPreviews.set(element, window.mountJianCangPdfPreview(element, {
      url: assetURL('pdf-original', asset), asset, makeButton, initialPage: pdfPages.get(asset.id) ?? 1,
      onPage: page => {
        pdfPages.delete(asset.id);
        pdfPages.set(asset.id, page);
        if (pdfPages.size > 64) pdfPages.delete(pdfPages.keys().next().value);
      },
      onError: message => {
        if (mediaLoads.get(element) !== ticket) return;
        element.replaceChildren(retryMessage('document', message, asset));
        onMediaChange?.(null);
      },
    }));
    return;
  }
  if (window.canJianCangPreviewText(asset)) {
    window.mountJianCangTextPreview(element, {
      url: assetURL('text-preview', asset), makeButton, notify: showToast,
      copy: () => bridge.copyTextPreview(asset.sourceAssetId, asset.sourceLibraryId, assetById.get(asset.id)?.sourceRevision),
      showError: (message, retry) => {
        if (mediaLoads.get(element) !== ticket) return;
        element.replaceChildren(retry ? retryMessage('document', message, asset) : mediaMessage('document', message));
      },
    });
    return;
  }
  const isMainVideo = element === viewerMedia && asset.kind === 'video';
  const isMainAudio = element === viewerMedia && asset.kind === 'audio';
  if (element !== viewerMedia && asset.kind === 'video' && asset.thumbnailAvailable) {
    const poster = makePhoto(`${asset.name} · 视频封面`);
    poster.addEventListener('load', () => {
      if (element.contains(poster)) onMediaChange?.(poster);
    }, { once: true });
    poster.addEventListener('error', () => {
      if (!element.contains(poster)) return;
      element.replaceChildren(retryMessage('video', '暂时无法读取封面。', asset));
      onMediaChange?.(null);
    }, { once: true });
    poster.src = assetURL('thumbnail', asset);
    element.replaceChildren(poster);
    return;
  }
  const media = node(asset.kind);
  media.controls = !isMainVideo && !isMainAudio;
  if (isMainVideo && window.jiancangTauriPlatform) media.crossOrigin = 'anonymous';
  media.preload = 'metadata';
  media.setAttribute('aria-label', asset.name);
  media.addEventListener(isMainVideo ? 'loadeddata' : 'loadedmetadata', () => {
    if (mediaLoads.get(element) === ticket && element.contains(media)) onMediaChange?.(media);
  }, { once: true });
  media.addEventListener('error', () => {
    if (element.contains(media)) {
      if (isMainVideo || isMainAudio) disposeViewerPlayer();
      const fallback = retryMessage(kindIcon(asset.kind), '暂时无法预览。可以导出原件，或在资源管理器中查看。', asset);
      if (isMainVideo && canTrimVideo(asset)) {
        fallback.append(makeButton('通过视频工具预览', 'trim', 'status-button', () => openVideoTrim(asset)));
      }
      element.replaceChildren(fallback);
      onMediaChange?.(null);
    }
  }, { once: true });
  media.src = assetURL(isMainVideo ? 'video' : 'original', asset, { playback: isMainVideo || isMainAudio });
  if (isMainVideo) {
    const poster = asset.thumbnailAvailable ? assetURL('thumbnail', asset) : undefined;
    const syncLibrary = state.libraries.find(entry => entry.id === asset.sourceLibraryId && entry.kind === 'jiancang' && entry.format === 6);
    const currentSyncLibrary = () => state.libraries.find(entry => entry.id === syncLibrary?.id &&
      entry.libraryId === syncLibrary.libraryId && entry.kind === 'jiancang' && entry.format === 6);
    const noteSync = syncLibrary && bridge.studioList && bridge.studioWrite ? {
      scope: syncLibrary.libraryId, label: `同步库「${libraryName(syncLibrary)}」`,
      canWrite: () => !(assetById.get(asset.id) ?? asset).trashed && isWritable(currentSyncLibrary()),
      list: () => {
        if (!currentSyncLibrary()) throw new Error('同步库连接已变化，请重新打开视频。');
        return bridge.studioList(syncLibrary.id, 'video-note', asset.sourceAssetId);
      },
      write: (id, payload, expected) => bridge.studioWrite(syncLibrary.id, 'video-note', asset.sourceAssetId, id, payload, expected),
    } : undefined;
    viewer.player = window.createJianCangVideoPlayer(media, {
      poster, noteSync, resourceKey: asset.id,
      saveFrame: (png, { width, height, seconds }) => bridge.saveVideoFrame({
        id: asset.sourceAssetId, registrationId: asset.sourceLibraryId,
        contentRevision: assetContentRevision(asset), png, width, height, seconds,
      }),
      saveNotes: (format, notes, duration) => bridge.saveVideoMarkers({
        id: asset.sourceAssetId, registrationId: asset.sourceLibraryId, format, notes, duration,
      }),
    });
  } else if (isMainAudio) {
    viewer.player = window.createJianCangAudioPlayer(media, {
      resourceKey: asset.id,
      audio: { name: asset.name, format: asset.extension.toUpperCase(), icon: glyph('audio') },
    });
  }
  element.replaceChildren(isMainVideo || isMainAudio ? viewer.player.element : media);
}

function disposeViewerPlayer() {
  if (!viewer?.player) return;
  viewer.player.dispose();
  viewer.player = null;
}

function cancelViewerMotion() {
  viewerMotion?.cancel();
  viewerMotion = null;
}

function cancelViewerPageMotion() {
  if (!viewer) return;
  viewer.pageDirection = 0;
  viewer.pageMotion?.cancel();
  viewer.pageMotion = null;
}

function prepareViewerPageMotion(delta) {
  cancelViewerMotion();
  cancelViewerPageMotion();
  if (!reduceMotion.matches) viewer.pageDirection = Math.sign(delta);
}

function animateViewerPage() {
  const current = viewer;
  if (!current?.pageDirection || current.closing) return;
  const distance = Math.min(24, viewerViewport.clientWidth * 0.035) * current.pageDirection;
  current.pageDirection = 0;
  const picture = viewerMedia.querySelector('.desktop-video-picture') || viewerMedia;
  const animation = motion(picture, [{ opacity: 0.76, transform: `translateX(${distance}px)` },
    { opacity: 1, transform: 'none' }], 180);
  current.pageMotion = animation;
  const clear = () => { if (current.pageMotion === animation) current.pageMotion = null; };
  void animation?.finished.then(clear, clear);
}

function animateSharedImage(from, to, phase, fade, hiddenImage) {
  const animation = window.previewTransitions.run({ from, to, phase, fade,
    reveal: () => hiddenImage?.classList.remove('hero-hidden') });
  if (!animation) return;
  if (animation.shared) hiddenImage?.classList.add('hero-hidden');
  viewerMotion = animation;
  void animation.finished.then(() => {
    if (viewerMotion === animation) viewerMotion = null;
  });
  return animation;
}

function animateViewerEntry(asset, from) {
  if (reduceMotion.matches) return;
  const picture = asset.kind === 'video' ? viewerMedia.querySelector('.desktop-video-picture') : null;
  if (!picture) {
    const to = from && window.previewTransitions.capture(zoomableImage(), { clip: viewerViewport });
    animateSharedImage(from, to, 'open', viewerMedia, viewerMedia);
    return;
  }
  const video = picture.querySelector('video');
  const to = window.previewTransitions.destinationFor(from, picture);
  if (to) {
    animateSharedImage(from, to, 'open', picture, video);
    return;
  }
  const opening = viewer;
  const reveal = () => {
    if (viewer === opening && !opening.closing && viewerMedia.contains(picture)) {
      animateSharedImage(null, null, 'open', picture);
    }
  };
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) reveal();
  else video.addEventListener('loadeddata', reveal, { once: true });
}

function openViewer(asset, card) {
  if (!canPreview(asset) || viewer || batchMode) return;
  audioCardPreview.stop();
  rememberWorkspace();
  assetFilters.close();
  cancelViewerMotion();
  let from;
  if (!reduceMotion.matches && (asset.kind === 'image' || asset.kind === 'video' || asset.extension === 'livp')) {
    const thumbnail = card?.querySelector('.asset-picture img');
    const image = window.previewTransitions.imageSize(thumbnail) ? thumbnail : photoSeedSource(asset, true);
    from = window.previewTransitions.capture(image, { clip: gallery.contains(image) ? scrollingGallery : undefined });
  }
  selectAsset(asset.id);
  rememberView(asset);
  const stage = preview.querySelector('.preview-stage');
  livePhotoPlayers.get(stage)?.stop();
  stage?.querySelector('video, audio')?.pause();
  viewer = {
    assetId: asset.id,
    entryId: asset.id,
    scrollTop: scrollingGallery.scrollTop,
    focus: false,
    key: null,
    mode: 'fit',
    scale: 1,
    x: 0,
    y: 0,
  };
  browser.classList.add('is-viewing');
  document.body.classList.add('in-viewer');
  byId('viewer-focus').setAttribute('aria-pressed', 'false');
  scrollingGallery.inert = true;
  document.querySelector('.gallery-toolbar').inert = true;
  viewerElement.hidden = false;
  updateViewer();
  if (!viewer) return;
  animateViewerEntry(asset, from);
  viewerViewport.focus({ preventScroll: true });
}

function closeViewer({ restore = true } = {}) {
  if (!viewer) return;
  if (viewer.closing && restore) return;
  cancelViewerMotion();
  cancelViewerPageMotion();
  const closing = viewer;
  const picture = restore && !reduceMotion.matches
    ? zoomableImage() || viewerMedia.querySelector('.desktop-video-picture > video')
    : null;
  const from = picture && window.previewTransitions.capture(picture, { clip: viewerViewport });
  if (restore && !from) {
    const fade = animateSharedImage(null, null, 'close', viewerMedia);
    if (fade) {
      viewer.closing = true;
      viewer.player?.pause();
      viewerMedia.querySelector('audio, video')?.pause();
      void fade.finished.then(() => {
        if (viewer === closing) finishCloseViewer(closing, restore, null);
      });
      return;
    }
  }
  finishCloseViewer(closing, restore, from);
}

function finishCloseViewer(closing, restore, from) {
  const { entryId, scrollTop, assetId } = closing;
  disposeViewerPlayer();
  mediaLoads.delete(viewerMedia);
  disposeDocumentPreview(viewerMedia);
  viewer = null;
  viewerRemoval = null;
  viewerElement.hidden = true;
  viewerMedia.replaceChildren();
  viewerViewport.classList.remove('is-panning');
  browser.classList.remove('is-viewing');
  document.body.classList.remove('in-viewer');
  workspace.classList.remove('viewer-focus');
  scrollingGallery.inert = false;
  document.querySelector('.gallery-toolbar').inert = false;
  if (!restore) return;
  selectAsset(assetById.has(entryId) ? entryId : null);
  scrollingGallery.scrollTop = scrollTop;
  if (!continuous.focus(entryId, { scroll: false })) searchInput.focus({ preventScroll: true });
  if (from) {
    const card = continuous.renderedCard(assetId);
    const cover = card?.querySelector('.asset-picture img');
    const clip = scrollingGallery;
    const thumbnail = window.previewTransitions.capture(cover, { clip });
    const to = thumbnail || (from.bitmap && window.previewTransitions.destinationFor(from, card?.querySelector('.asset-picture'), { clip }));
    animateSharedImage(from, to, 'return', to ? null : scrollingGallery, thumbnail ? cover : null);
  }
}

function updateViewer() {
  if (!viewer) return;
  const index = previewIndices.get(viewer.assetId);
  if (index === undefined) {
    closeViewer();
    return;
  }
  const asset = previewableAssets[index];
  viewerElement.setAttribute('aria-label', `预览 ${asset.name}`);
  byId('viewer-position').textContent = `${counts.format(index + 1)} / ${counts.format(previewableAssets.length)}`;
  byId('viewer-previous').disabled = index === 0;
  byId('viewer-next').disabled = index === previewableAssets.length - 1;
  byId('viewer-export').disabled = !asset.available;
  byId('viewer-image-tools').hidden = !canEditImage(asset);
  byId('viewer-video-trim').hidden = !canTrimVideo(asset);
  updateFavoriteButton(byId('viewer-quick-favorite'), asset);
  byId('viewer-reveal').disabled = !asset.available;
  byId('viewer-local-trash').hidden = !writableAsset(asset) || asset.trashed;
  const key = previewKey(asset);
  if (viewer.key !== key) {
    const sameAsset = viewer.mediaAssetId === asset.id;
    viewer.key = key;
    viewer.mediaAssetId = asset.id;
    disposeViewerPlayer();
    viewer.geometry = null;
    if (!sameAsset) {
      const pointer = viewer.pan?.id;
      if (pointer != null && viewerViewport.hasPointerCapture(pointer)) viewerViewport.releasePointerCapture(pointer);
      viewer.mode = 'fit';
      viewer.x = viewer.y = 0;
      viewer.pan = null;
      viewer.tween = null;
      viewer.imageSize = null;
    }
    mountMedia(viewerMedia, asset, () => {
      updateViewerGeometry();
      animateViewerPage();
    });
    const waitsForImage = asset.kind === 'image' || asset.extension === 'livp';
    if (!waitsForImage && (asset.kind !== 'video' || (asset.available && asset.thumbnailAvailable))) {
      animateViewerPage();
    }
  } else if (viewer.mediaName !== asset.name) {
    viewer.player?.setName?.(asset.name);
    const still = viewerMedia.querySelector('img');
    if (still) still.alt = asset.name;
  }
  viewer.mediaName = asset.name;
  renderInspector();
  updateViewerGeometry();
}

function moveViewer(delta) {
  if (!viewer || viewer.closing) return;
  const index = previewIndices.get(viewer.assetId);
  const asset = previewableAssets[index + delta];
  if (asset) showViewerAsset(asset, delta);
}

function showViewerAsset(asset, delta) {
  viewerRemoval = null;
  prepareViewerPageMotion(delta);
  viewer.assetId = asset.id;
  rememberView(asset);
  updateViewer();
  viewerViewport.focus({ preventScroll: true });
}

function zoomableImage() {
  return [...viewerMedia.querySelectorAll('img:not([hidden]), canvas[data-preview-seed]:not([hidden])')]
    .find(image => window.previewTransitions.imageSize(image)) || null;
}

function fitImageScale(rect, width, height) {
  return Math.min(Math.max(1, rect.width - 12) / width, Math.max(1, rect.height - 4) / height);
}

function zoomGeometry(image) {
  const rect = viewerViewport.getBoundingClientRect();
  const seedAsset = image.dataset.previewSeed ? currentViewerAsset() : null;
  const size = window.previewTransitions.imageSize(image);
  const imageRatio = mediaRatio(size.width, size.height);
  const assetRatio = mediaRatio(seedAsset?.width, seedAsset?.height);
  const useAssetSize = !!assetRatio && Math.abs(assetRatio / imageRatio - 1) < 0.02;
  const naturalWidth = useAssetSize ? seedAsset.width : size.width;
  const naturalHeight = useAssetSize ? seedAsset.height : size.height;
  const fit = fitImageScale(rect, naturalWidth, naturalHeight);
  return { image, rect, naturalWidth, naturalHeight, fit, minimum: Math.min(0.1, fit * 0.22), maximum: Math.max(4, fit * 2) };
}

function constrainPan(geometry) {
  const { rect, naturalWidth, naturalHeight } = geometry;
  const horizontal = Math.abs(naturalWidth * viewer.scale - rect.width) / 2;
  const vertical = Math.abs(naturalHeight * viewer.scale - rect.height) / 2;
  viewer.x = clamp(viewer.x, -horizontal, horizontal);
  viewer.y = clamp(viewer.y, -vertical, vertical);
  return horizontal > 0 || vertical > 0;
}

function queueViewerPaint() {
  if (!zoomFrame) zoomFrame = requestAnimationFrame(time => {
    zoomFrame = 0;
    if (!viewer || !viewer.geometry) return;
    const tween = viewer.tween;
    if (tween) {
      const progress = clamp((time - tween.start) / 155, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const target = tween.mode === 'fit' ? viewer.geometry.fit : 1;
      viewer.scale = tween.scale + (target - tween.scale) * eased;
      viewer.x = tween.x * (1 - eased);
      viewer.y = tween.y * (1 - eased);
      if (progress === 1) {
        viewer.mode = tween.mode;
        viewer.tween = null;
      } else queueViewerPaint();
    }
    paintViewerGeometry();
  });
}

function paintViewerGeometry() {
  const geometry = viewer?.geometry;
  if (!geometry) return;
  const { image, fit, minimum, maximum } = geometry;
  viewerViewport.classList.toggle('can-pan', constrainPan(geometry));
  image.style.transform = `translate(-50%, -50%) translate3d(${viewer.x}px,${viewer.y}px,0) scale(${viewer.scale / fit})`;
  const underlay = viewerMedia.querySelector('.viewer-photo-underlay');
  if (underlay) {
    underlay.style.width = image.style.width;
    underlay.style.height = image.style.height;
    underlay.style.transform = image.style.transform;
  }
  const live = image.closest('.live-photo')?.querySelector('.live-photo-motion:not([hidden])');
  if (live) {
    live.classList.add('viewer-image');
    live.style.width = image.style.width;
    live.style.height = image.style.height;
    live.style.transform = image.style.transform;
  }
  for (const [button, mode] of [['viewer-fit', 'fit'], ['viewer-actual', 'actual']]) {
    const control = byId(button);
    const pressed = String(viewer.mode === mode);
    if (control.getAttribute('aria-pressed') !== pressed) control.setAttribute('aria-pressed', pressed);
  }
  const slider = byId('viewer-zoom');
  const value = Math.round(100 * Math.log(viewer.scale / minimum) / Math.log(maximum / minimum));
  if (slider.valueAsNumber !== value) slider.value = value;
  const percent = `${Math.round(viewer.scale * 100)}%`;
  if (slider.getAttribute('aria-valuetext') !== percent) {
    slider.setAttribute('aria-valuetext', percent);
    byId('viewer-zoom-value').textContent = percent;
  }
}

function updateViewerGeometry() {
  if (!viewer) return;
  const image = zoomableImage();
  byId('viewer-zoom-controls').hidden = !image;
  if (!image) {
    viewer.geometry = null;
    viewerViewport.classList.remove('can-pan');
    return;
  }
  const geometry = zoomGeometry(image);
  if (geometry.rect.width < 1 || geometry.rect.height < 1) return;
  const { naturalWidth: width, naturalHeight: height, rect, fit } = geometry;
  const previous = viewer.imageSize;
  if (viewer.mode === 'manual' && previous && (previous.width !== width || previous.height !== height)) {
    const ratio = fit / fitImageScale(rect, previous.width, previous.height);
    viewer.scale *= ratio;
    if (viewer.tween) viewer.tween.scale *= ratio;
  }
  viewer.imageSize = { width, height };
  viewer.geometry = geometry;
  if (viewer.mode === 'fit') viewer.scale = geometry.fit;
  if (viewer.mode === 'actual') viewer.scale = 1;
  viewer.scale = clamp(viewer.scale, geometry.minimum, geometry.maximum);
  image.classList.add('viewer-image');
  image.style.width = `${geometry.naturalWidth * geometry.fit}px`;
  image.style.height = `${geometry.naturalHeight * geometry.fit}px`;
  paintViewerGeometry();
}

function setViewerScale(target, point) {
  const geometry = viewer?.geometry;
  if (!geometry || viewer.closing) return;
  viewer.tween = null;
  cancelViewerPageMotion();
  if (viewerMotion) cancelViewerMotion();
  const { minimum, maximum, rect } = geometry;
  const next = clamp(target, minimum, maximum);
  if (point) {
    const x = point.clientX - rect.left - rect.width / 2;
    const y = point.clientY - rect.top - rect.height / 2;
    const multiplier = next / viewer.scale;
    viewer.x = x - (x - viewer.x) * multiplier;
    viewer.y = y - (y - viewer.y) * multiplier;
  }
  viewer.mode = 'manual';
  viewer.scale = next;
  constrainPan(geometry);
  queueViewerPaint();
}

function setViewerMode(mode) {
  const geometry = viewer?.geometry;
  if (!geometry || viewer.closing) return;
  cancelViewerMotion();
  cancelViewerPageMotion();
  const target = mode === 'fit' ? geometry.fit : 1;
  if (reduceMotion.matches) {
    viewer.mode = mode;
    viewer.scale = target;
    viewer.tween = null;
    viewer.x = viewer.y = 0;
  } else {
    viewer.tween = { mode, start: performance.now(), scale: viewer.scale, x: viewer.x, y: viewer.y };
    viewer.mode = 'manual';
  }
  queueViewerPaint();
}

function toggleViewerFocus() {
  if (!viewer) return;
  viewer.focus = !viewer.focus;
  workspace.classList.toggle('viewer-focus', viewer.focus);
  byId('viewer-focus').setAttribute('aria-pressed', String(viewer.focus));
  updateInspectorVisibility();
}

new ResizeObserver(updateViewerGeometry).observe(viewerViewport);
viewerViewport.addEventListener('wheel', event => {
  if (!viewer?.geometry || viewer.closing || event.target.closest('button, video, audio')) return;
  event.preventDefault();
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 90 : 1);
  setViewerScale(viewer.scale * Math.exp(-delta * 0.0025), event);
}, { passive: false });

viewerViewport.addEventListener('pointerdown', event => {
  if (!viewer || viewer.closing || event.button !== 0 || !viewerViewport.classList.contains('can-pan') ||
      event.target.closest('button, input, video, audio')) return;
  viewer.tween = null;
  viewer.pan = { id: event.pointerId, x: event.clientX - viewer.x, y: event.clientY - viewer.y };
  viewerViewport.setPointerCapture(event.pointerId);
  viewerViewport.classList.add('is-panning');
  event.preventDefault();
});
viewerViewport.addEventListener('pointermove', event => {
  if (viewer?.pan?.id !== event.pointerId) return;
  viewer.mode = 'manual';
  viewer.x = event.clientX - viewer.pan.x;
  viewer.y = event.clientY - viewer.pan.y;
  queueViewerPaint();
});
viewerViewport.addEventListener('lostpointercapture', event => {
  if (viewer?.pan?.id === event.pointerId) viewer.pan = null;
  viewerViewport.classList.remove('is-panning');
});

async function editEagleAsset(asset, changes, expected, onSaved) {
  const result = await bridge.editEagleAsset(asset.sourceLibraryId, asset.sourceAssetId, changes, expected);
  if (result?.ok) onSaved?.();
  if (result?.state) setState(result.state);
  return result;
}

async function setAssetRating(asset, value, { field, onSaved } = {}) {
  if (asset.sourceKind !== 'eagle') {
    const result = await organizer.setRating(asset, value);
    if (result?.ok && !(result.pending > 0)) onSaved?.();
    return;
  }
  if (value === (asset.rating ?? 0) || inspectorWrites.has(asset.id)) return;
  inspectorWrites.add(asset.id);
  const controls = [...(field?.querySelectorAll('button') ?? [])];
  controls.forEach(button => { button.disabled = true; });
  try {
    const result = await editEagleAsset(asset, { rating: value }, { rating: asset.rating ?? 0 }, onSaved);
    showToast(result?.ok ? '评分已写回 Eagle。' : result?.message || '无法更新 Eagle 评分。');
  } catch { showToast('无法更新 Eagle 评分。'); }
  finally {
    inspectorWrites.delete(asset.id);
    controls.forEach(button => { button.disabled = false; });
    selectionKey = '';
    renderInspector();
  }
}

function inspectorRating(asset) {
  const field = node('dd', 'inspector-rating');
  field.setAttribute('role', 'group');
  field.setAttribute('aria-label', '评分');
  const setRating = value => setAssetRating(asset, value, { field });
  for (let value = 1; value <= 5; value++) {
    const star = makeButton('', 'star', 'icon-button inspector-star', () => void setRating(value));
    star.dataset.quickAction = `rating-${value}`;
    star.setAttribute('aria-pressed', String(asset.rating === value));
    star.setAttribute('aria-label', `设为 ${value} 星`);
    star.title = `${value} 星`;
    star.classList.toggle('is-filled', value <= asset.rating);
    field.append(star);
  }
  if (asset.rating) {
    const clear = makeButton('清除', null, 'status-button inspector-rating-clear', () => void setRating(0));
    clear.dataset.quickAction = 'rating-clear';
    clear.setAttribute('aria-label', '清除评分');
    field.append(clear);
  }
  return field;
}

function disposeInspectorAudio() {
  const audio = preview.querySelector('.preview-stage > audio');
  if (!audio) return;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

const inspectorDrafts = new Map();
const inspectorWrites = new Set();
const inspectorPalettes = new Map();
let mountedInspectorEditor;

function inspectorValues(asset) {
  const prefix = `${asset.sourceLibraryId}:`;
  return {
    name: asset.name || '', tags: asset.tags || [], note: asset.note || '', sourceURL: asset.sourceURL || '',
    collectionIds: asset.collectionIds.map(id => id.startsWith(prefix) ? id.slice(prefix.length) : id).sort(),
  };
}

function inspectorCatalog(asset, snapshot = state) {
  return snapshot.catalogs?.find(entry => entry.libraryId === asset.sourceLibraryId) ??
    (snapshot.activeLibraryId === asset.sourceLibraryId ? { library: snapshot.library } : {});
}

function inspectorObserved(asset, snapshot = state) {
  const { library } = inspectorCatalog(asset, snapshot);
  const saved = library?.assets.find(item => item.id === asset.sourceAssetId);
  return saved && { ...asset, ...saved, id: asset.id };
}

function inspectorFieldValue(editor, field) {
  return editor.fields[field] ?? editor.submitted?.[field] ?? editor.queued?.[field] ?? editor.base[field];
}

function updateInspectorDraft(editor) {
  const id = editor.asset.id;
  if (Object.keys(editor.fields).length || editor.newTag !== undefined || editor.submitted || editor.queued) {
    inspectorDrafts.set(id, editor);
  } else inspectorDrafts.delete(id);
  editor.refresh?.();
}

function changeInspectorField(editor, field, value) {
  const previous = editor.submitted?.[field] ?? editor.queued?.[field] ?? editor.base[field];
  if (JSON.stringify(previous) === JSON.stringify(value)) delete editor.fields[field];
  else editor.fields[field] = value;
  editor.error = '';
  editor.saved = false;
  updateInspectorDraft(editor);
  scheduleInspectorSave(editor);
}

function inspectorFieldError(editor, field, value) {
  const eagle = editor.asset.sourceKind === 'eagle';
  if (field === 'name' && !value.replace(/[\p{Cc}\p{Cs}]/gu, '').trim()) return '请填写素材名称。';
  if (field === 'name' && eagle && /[<>:"/\\|?*\p{Cc}]/u.test(value)) return '名称含有 Eagle 不支持的字符。';
  if (field === 'sourceURL' && (!validInspectorURL(value) || (eagle && value.length > 4096))) {
    return '请输入有效的 HTTP 或 HTTPS 网页网址。';
  }
  return '';
}

function scheduleInspectorSave(editor, immediate = false) {
  clearTimeout(editor.timer);
  if (editor.submitted || editor.queued || editor.error ||
      !Object.keys(editor.fields).some(field => !editor.composing.has(field))) return;
  if (immediate) void saveInspectorDraft(editor);
  else editor.timer = setTimeout(() => void saveInspectorDraft(editor), 500);
}

function inspectorPatch(base, values, eagle) {
  const patch = { ...values };
  if ('sourceURL' in patch) patch.sourceURL ||= null;
  if (eagle) return patch;
  for (const [field, add, remove, key] of [
    ['collectionIds', 'addCollectionIds', 'removeCollectionIds', value => value],
    ['tags', 'addTags', 'removeTags', value => value.normalize('NFC').toLowerCase()],
  ]) {
    if (!(field in values)) continue;
    const previous = new Set(base[field].map(key));
    const wanted = new Set(values[field].map(key));
    patch[add] = values[field].filter(value => !previous.has(key(value)));
    patch[remove] = base[field].filter(value => !wanted.has(key(value)));
    delete patch[field];
  }
  return patch;
}

function acknowledgeInspectorFields(editor, sent, saved) {
  for (const key of Object.keys(sent)) {
    if ((key === 'collectionIds' || key === 'tags') && key in editor.fields) {
      const identity = key === 'tags' ? value => value.normalize('NFC').toLowerCase() : value => value;
      const previous = new Set(sent[key].map(identity));
      const wanted = new Set(editor.fields[key].map(identity));
      const values = new Map(saved[key].filter(value => !previous.has(identity(value)) || wanted.has(identity(value)))
        .map(value => [identity(value), value]));
      for (const value of editor.fields[key]) {
        if (!previous.has(identity(value))) values.set(identity(value), value);
      }
      editor.fields[key] = [...values.values()];
      if (key === 'collectionIds') editor.fields[key].sort();
    }
    if (JSON.stringify(editor.fields[key]) === JSON.stringify(saved[key])) delete editor.fields[key];
    editor.base[key] = saved[key];
  }
}

async function saveInspectorDraft(editor) {
  const sent = Object.fromEntries(Object.entries(editor.fields).filter(([key, value]) =>
    !editor.composing.has(key) && !inspectorFieldError(editor, key, value)));
  if (!Object.keys(sent).length || editor.submitted || editor.queued || editor.error) return;
  const { asset } = editor;
  const current = inspectorObserved(asset);
  const entry = state.libraries.find(item => item.id === asset.sourceLibraryId);
  const gate = current && inspectorEditGate(current);
  if (!current || !entry || entry.libraryId !== editor.libraryIdentity || gate) {
    editor.error = gate?.text || '素材或素材库已变化，暂时无法保存。';
    updateInspectorDraft(editor);
    return;
  }
  const eagle = asset.sourceKind === 'eagle';
  const patch = inspectorPatch(editor.base, sent, eagle);
  const expected = eagle && Object.fromEntries(Object.keys(sent).map(key => [key, editor.base[key]]));
  const previousRevision = inspectorCatalog(asset).revision;
  editor.submitted = sent;
  for (const key of Object.keys(sent)) delete editor.fields[key];
  updateInspectorDraft(editor);
  try {
    const result = eagle ? await editEagleAsset(asset, patch, expected)
      : await mutateLocal(asset.sourceLibraryId, { action: 'edit', ids: [asset.sourceAssetId], ...patch });
    if (!result?.ok) throw new Error(result?.message || '资料保存失败，请重试。');
    if (result.pending > 0) {
      editor.queued = sent;
      editor.queuedRevision = result.state ? inspectorCatalog(asset, result.state).revision : previousRevision;
    }
    else {
      const authoritative = result.state && inspectorObserved(asset, result.state);
      const saved = authoritative ? inspectorValues(authoritative) : sent;
      acknowledgeInspectorFields(editor, sent, saved);
      editor.saved = true;
    }
  } catch (problem) {
    Object.assign(editor.fields, { ...sent, ...editor.fields });
    editor.error = problem?.message || '资料保存失败，请重试。';
    if (mountedInspectorEditor?.editor !== editor) showToast(`「${asset.name}」的资料尚未保存。`);
  } finally {
    editor.submitted = null;
    if (editor.queued) reconcileInspectorWrites();
    updateInspectorDraft(editor);
    if (mountedInspectorEditor?.editor === editor && !editor.composing.size) {
      selectionKey = '';
      renderInspector();
    }
    scheduleInspectorSave(editor);
  }
}

function reconcileInspectorWrites() {
  for (const editor of inspectorDrafts.values()) {
    if (!editor.queued) continue;
    const { asset } = editor;
    const entry = state.libraries.find(item => item.id === asset.sourceLibraryId);
    const current = inspectorObserved(asset);
    if (!current || entry?.status !== 'available' || entry.libraryId !== editor.libraryIdentity ||
        entry.syncLogIncomplete || entry.writeStatus?.pending !== 0) continue;
    const saved = inspectorValues(current);
    if (inspectorCatalog(asset).revision === editor.queuedRevision &&
        Object.entries(editor.queued).some(([key, value]) => JSON.stringify(saved[key]) !== JSON.stringify(value))) continue;
    acknowledgeInspectorFields(editor, editor.queued, saved);
    editor.queued = null;
    editor.saved = true;
    updateInspectorDraft(editor);
    scheduleInspectorSave(editor);
  }
}

function leaveInspectorEditor(assetId) {
  if (!mountedInspectorEditor || mountedInspectorEditor.editor.asset.id === assetId) return;
  const { editor, flushTag } = mountedInspectorEditor;
  mountedInspectorEditor = undefined;
  flushTag();
  scheduleInspectorSave(editor, true);
  editor.refresh = null;
}

function inspectorPalette(asset, indexed) {
  const swatches = node('div', 'inspector-palette');
  swatches.setAttribute('role', 'group');
  swatches.setAttribute('aria-label', '图片色板');
  swatches.hidden = true;
  function show(colors) {
    const valid = colors.filter(color => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)).slice(0, 5);
    if (!valid.length) return;
    swatches.replaceChildren(...valid.map(color => {
      const swatch = node('button', 'inspector-swatch');
      swatch.type = 'button';
      swatch.title = `使用参考色 ${color.toUpperCase()}`;
      swatch.setAttribute('aria-label', swatch.title);
      swatch.setAttribute('aria-haspopup', 'dialog');
      swatch.style.backgroundColor = color;
      swatch.addEventListener('click', () => void visual.openColor(color));
      return swatch;
    }));
    const menu = node('div', 'collection-menu inspector-palette-menu');
    menu.setAttribute('popover', 'auto');
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', '复制色板格式');
    const copy = makeButton('复制色板', 'copy', 'inspector-palette-copy', () => {
      if (menu.matches(':popover-open')) {
        menu.hidePopover();
        return;
      }
      closeWorkspaceMenus();
      const box = copy.getBoundingClientRect();
      menu.showPopover({ source: copy });
      menu.style.left = `${clamp(box.right - menu.offsetWidth, 8, innerWidth - menu.offsetWidth - 8)}px`;
      menu.style.top = `${clamp(box.bottom + 4, 8, innerHeight - menu.offsetHeight - 8)}px`;
      menu.firstElementChild.focus({ preventScroll: true });
    });
    copy.setAttribute('aria-expanded', 'false');
    menu.addEventListener('toggle', event => copy.setAttribute('aria-expanded', String(event.newState === 'open')));
    menu.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      menu.hidePopover();
      copy.focus({ preventScroll: true });
    });
    for (const [format, label, confirmation] of [
      ['hex', '复制全部 HEX 色值', '色值已复制'],
      ['png', '复制色板图片', '色板图片已复制'],
    ]) {
      menu.append(makeButton(label, null, '', async () => {
        menu.hidePopover();
        copy.focus({ preventScroll: true });
        try {
          const result = await bridge.copyVisualPalette(valid, format);
          showToast(result?.ok ? confirmation : (result?.message || '色板复制失败，请重试。'));
        } catch {
          showToast('色板复制失败，请重试。');
        }
      }));
    }
    swatches.append(copy, menu);
    swatches.hidden = false;
  }
  if (indexed?.length) show(indexed);
  else if ((asset.kind === 'image' || asset.extension === 'livp') && (asset.available || asset.thumbnailAvailable)) {
    const key = assetURL('palette-image', asset);
    if (!inspectorPalettes.has(key)) {
      const sample = makePhoto('');
      const colors = new Promise(resolve => {
        sample.addEventListener('load', () => {
          try { resolve(sampleInspectorColors(sample)); }
          catch { resolve([]); }
        }, { once: true });
        sample.addEventListener('error', () => resolve([]), { once: true });
        sample.src = key;
      });
      if (inspectorPalettes.size >= 64) inspectorPalettes.delete(inspectorPalettes.keys().next().value);
      inspectorPalettes.set(key, colors);
      void colors.then(value => {
        if (!value.length && inspectorPalettes.get(key) === colors) inspectorPalettes.delete(key);
      });
    }
    void inspectorPalettes.get(key).then(show);
  }
  return swatches;
}

function sampleInspectorColors(image) {
  const canvas = node('canvas');
  const scale = Math.min(1, 48 / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const buckets = new Map();
  for (let pixel = 0; pixel < data.length; pixel += 4) {
    const alpha = data[pixel + 3] / 255;
    if (alpha < .18) continue;
    const r = data[pixel], g = data[pixel + 1], b = data[pixel + 2];
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bucket = buckets.get(key) || [0, 0, 0, 0];
    bucket[0] += alpha;
    bucket[1] += r * alpha;
    bucket[2] += g * alpha;
    bucket[3] += b * alpha;
    buckets.set(key, bucket);
  }
  const colors = [];
  for (const [weight, ...sum] of [...buckets.values()].sort((a, b) => b[0] - a[0])) {
    const color = sum.map(value => Math.round(value / weight));
    if (colors.some(previous => Math.hypot(...color.map((value, channel) => value - previous[channel])) < 47)) continue;
    colors.push(color);
    if (colors.length === 5) break;
  }
  return colors.map(color => '#' + color.map(channel => channel.toString(16).padStart(2, '0')).join(''));
}

function inspectorEditGate(asset) {
  if (asset.trashed) return { text: '从回收站恢复后可编辑资料。' };
  const entry = state.libraries.find(item => item.id === asset.sourceLibraryId);
  if (!entry || entry.status === 'unavailable') return { text: '素材库暂未连接。' };
  if (entry.kind === 'eagle') return entry.eagleWritable ? null : {
    label: '开启双向同步',
    text: '请先在 Eagle 中打开同一个库，然后开启双向同步。',
    open: () => void configureEagleWrite(entry.id, true),
    enableFromTags: false,
  };
  if (entry.kind !== 'jiancang') return isWritable(entry) ? null : { text: '此素材库暂不可编辑。' };
  const sync = (label, text) => ({ label, text, open: () => openSyncPanel(entry.id) });
  if (!entry.format) return sync('查看同步状态', '等待读取同步库格式。');
  if (entry.format !== 6) return sync('查看同步状态',
    '请在 iPhone 或 iPad 的见藏中打开「多端同步 → 原件与云端空间」，点「升级到格式 6」。');
  if (!entry.syncWritable) return sync('开启双向同步', '开启 Windows 写入后可直接编辑这份同步库的资料。');
  const catalog = catalogEntries().find(item => item.libraryId === entry.id)?.library;
  if (catalog?.logIncomplete) return sync('查看同步状态', '等 iCloud 同步完整的变更记录后即可编辑。');
  return null;
}

function inspectorTagField(asset, editor, gate, saving, onChange) {
  const field = node('div', 'inspector-field inspector-field-tags');
  field.dataset.inspectorField = 'tags';
  field.setAttribute('role', 'group');
  field.setAttribute('aria-labelledby', 'inspector-tags-label');
  const label = node('span', '', '标签');
  label.id = 'inspector-tags-label';
  const chips = node('div', 'inspector-tags');
  field.append(label, chips);
  function chipFor(tag) {
    const chip = node('span', 'inspector-tag');
    chip.append(node('span', 'inspector-tag-text', tag));
    return chip;
  }
  function addButton(onClick, title = '添加标签') {
    const button = makeButton('', 'plus', 'inspector-tag-add', onClick);
    button.dataset.quickAction = 'add-tag';
    button.setAttribute('aria-label', title);
    button.title = title;
    button.disabled = saving;
    return button;
  }
  if (gate) {
    if (asset.tags.length) chips.append(...asset.tags.map(chipFor));
    else chips.append(node('span', 'inspector-empty', '未添加标签'));
    if (gate.open && gate.enableFromTags !== false) chips.append(addButton(gate.open, `${gate.label}以添加标签`));
    return { field };
  }

  const { fields } = editor;
  const autosave = !!editor.composing;
  const tagKey = tag => tag.normalize('NFC').toLowerCase();
  const base = new Set(asset.tags.map(tagKey));
  const entry = node('div', 'inspector-tag-entry');
  entry.id = 'inspector-tag-entry';
  const input = node('input', 'inspector-tag-input');
  input.id = 'inspector-tags';
  input.dataset.quickAction = 'new-tag';
  input.setAttribute('aria-label', '新标签');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('autocomplete', 'off');
  input.placeholder = '输入标签';
  input.disabled = saving;
  input.value = editor.newTag ?? '';
  const message = node('p', 'inspector-tag-error');
  message.id = 'inspector-tag-error';
  message.setAttribute('role', 'alert');
  message.hidden = true;
  input.setAttribute('aria-describedby', message.id);
  const options = node('ul', 'inspector-tag-options');
  options.id = 'inspector-tag-options';
  options.setAttribute('role', 'listbox');
  options.setAttribute('aria-label', '已有标签');
  input.setAttribute('aria-controls', options.id);
  let matches = [];
  let activeOption = -1;

  const add = addButton(() => {
    if (entry.hidden) {
      editor.newTag = '';
      updateEntry();
      onChange();
      input.focus();
    } else closeEntry(true);
  });
  add.setAttribute('aria-controls', entry.id);
  const confirm = makeButton('', 'check', 'inspector-tag-confirm', () => commit(true));
  confirm.setAttribute('aria-label', '确认添加标签');
  confirm.title = '确认添加标签';

  function updateEntry() {
    entry.hidden = editor.newTag === undefined;
    add.setAttribute('aria-expanded', String(!entry.hidden));
    confirm.disabled = saving || !input.value.trim();
    renderOptions();
  }

  function closeEntry(restoreFocus) {
    delete editor.newTag;
    input.value = '';
    message.hidden = true;
    input.removeAttribute('aria-invalid');
    updateEntry();
    onChange();
    if (restoreFocus) add.focus();
  }

  function visibleTags() {
    if (autosave) return inspectorFieldValue(editor, 'tags');
    const removed = new Set((fields.removeTags ?? []).map(tagKey));
    const tags = asset.tags.filter(tag => !removed.has(tagKey(tag)));
    const keys = new Set(tags.map(tagKey));
    return tags.concat((fields.addTags ?? []).filter(tag => !keys.has(tagKey(tag))));
  }

  function highlightOption(index) {
    activeOption = index;
    for (const [position, option] of [...options.children].entries()) option.setAttribute('aria-selected', String(position === index));
    if (index >= 0) input.setAttribute('aria-activedescendant', options.children[index].id);
    else input.removeAttribute('aria-activedescendant');
  }

  function useOption(tag) {
    if (input.disabled) return;
    input.value = editor.newTag = tag;
    commit(true);
  }

  function renderOptions() {
    matches = !entry.hidden && !input.disabled && document.activeElement === input
      ? tags.suggestions(asset.sourceLibraryId, input.value, visibleTags()) : [];
    options.replaceChildren(...matches.map((tag, index) => {
      const choice = node('li', 'inspector-tag-option', tag);
      choice.id = `inspector-tag-option-${index}`;
      choice.title = tag;
      choice.setAttribute('role', 'option');
      choice.addEventListener('pointerdown', event => event.preventDefault());
      choice.addEventListener('click', () => useOption(tag));
      return choice;
    }));
    options.hidden = matches.length === 0;
    input.setAttribute('aria-expanded', String(!options.hidden));
    highlightOption(-1);
  }

  function setTag(tag, included) {
    const key = tagKey(tag);
    if (autosave) {
      const next = visibleTags().filter(value => tagKey(value) !== key);
      if (included) next.push(tag);
      changeInspectorField(editor, 'tags', next);
      renderChips();
      return;
    }
    for (const [fieldName, keep] of [['addTags', included && !base.has(key)], ['removeTags', !included && base.has(key)]]) {
      const values = (fields[fieldName] ?? []).filter(value => tagKey(value) !== key);
      if (keep) values.push(tag);
      if (values.length) fields[fieldName] = values;
      else delete fields[fieldName];
    }
    renderChips();
    onChange();
  }

  function renderChips() {
    const tags = visibleTags().map(tag => {
      const chip = chipFor(tag);
      const remove = makeButton('', 'close', 'inspector-tag-remove', () => {
        const next = chip.nextElementSibling?.querySelector('button') ?? add;
        const action = next.dataset.quickAction;
        setTag(tag, false);
        [...chips.querySelectorAll('button')].find(button => button.dataset.quickAction === action)?.focus();
      });
      remove.dataset.quickAction = `remove-tag:${tag}`;
      remove.setAttribute('aria-label', `移除标签：${tag}`);
      remove.title = `移除标签：${tag}`;
      remove.disabled = saving;
      chip.append(remove);
      return chip;
    });
    chips.replaceChildren(...tags, add);
  }

  function commit(restoreFocus = false, focusInvalid = true) {
    if (entry.hidden || !input.value.trim()) return true;
    if (autosave && editor.composing.has('new-tag')) return false;
    const tag = input.value.replace(/[\p{Cc}\p{Cs}]/gu, ' ').trim().normalize('NFC');
    const limit = asset.sourceKind === 'local' || asset.sourceKind === 'eagle' ? 256 : 4096;
    const tags = visibleTags();
    let error = '';
    if (!tag || Array.from(tag).length > 128) error = '标签须为 1 到 128 个字符。';
    else if (tags.some(value => tagKey(value) === tagKey(tag))) error = '这个标签已存在。';
    else if (tags.length >= limit) error = `每份素材最多添加 ${limit} 个标签。`;
    if (error) {
      input.setAttribute('aria-invalid', 'true');
      message.textContent = error;
      message.hidden = false;
      if (focusInvalid) input.focus();
      return false;
    }
    setTag(tag, true);
    closeEntry(restoreFocus);
    return true;
  }

  input.addEventListener('input', () => {
    editor.newTag = input.value;
    input.removeAttribute('aria-invalid');
    message.hidden = true;
    updateEntry();
    onChange();
  });
  input.addEventListener('focus', renderOptions);
  input.addEventListener('blur', event => {
    renderOptions();
    if (autosave && !entry.contains(event.relatedTarget) && event.relatedTarget !== add) commit(false, false);
  });
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeEntry(true);
    } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (activeOption >= 0) useOption(matches[activeOption]);
      else commit(true);
    } else if (matches.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? (activeOption + 1) % matches.length :
        activeOption <= 0 ? matches.length - 1 : activeOption - 1;
      highlightOption(next);
    }
  });
  entry.append(input, confirm, options, message);
  field.append(entry);
  updateEntry();
  renderChips();
  return { field, commit };
}

function inspectorEditor(asset, collections, gate) {
  const form = node('form', 'inspector-editor');
  form.dataset.readonly = String(Boolean(gate));
  const libraryId = asset.sourceLibraryId;
  const prefix = libraryId + ':';
  const base = inspectorValues(asset);
  const existing = inspectorDrafts.get(asset.id) ?? mountedInspectorEditor?.editor;
  const editor = existing?.asset.id === asset.id ? existing : { asset, fields: {}, base, composing: new Set(),
    libraryIdentity: state.libraries.find(entry => entry.id === libraryId)?.libraryId };
  if (editor.asset.sourceRevision !== asset.sourceRevision) {
    for (const field of Object.keys(base)) {
      if (!(field in editor.fields) && !Object.hasOwn(editor.submitted ?? {}, field) && !Object.hasOwn(editor.queued ?? {}, field)) {
        editor.base[field] = base[field];
      }
    }
    editor.asset = asset;
  }
  const footer = node('div', 'inspector-editor-actions inspector-autosave');
  const status = node('p', 'inspector-save-status');
  status.setAttribute('role', 'status');
  const retry = makeButton('重试保存', null, 'status-button', () => {
    editor.error = '';
    updateInspectorDraft(editor);
    scheduleInspectorSave(editor, true);
  });
  footer.append(status, retry);
  function updateActions() {
    const invalid = Object.entries(editor.fields).map(([field, value]) => inspectorFieldError(editor, field, value)).find(Boolean);
    const statusText = editor.error || (editor.submitted ? '正在保存…' :
      editor.queued ? '已加入 iCloud 同步队列' : invalid ||
      (Object.keys(editor.fields).length ? '等待自动保存…' : editor.saved ? '已保存' : ''));
    footer.hidden = !statusText;
    retry.hidden = !editor.error || Boolean(gate);
    status.textContent = statusText;
    status.classList.toggle('is-error', Boolean(editor.error || invalid && !editor.submitted && !editor.queued));
    form.setAttribute('aria-busy', String(Boolean(editor.submitted)));
  }
  editor.refresh = updateActions;

  function addField(title, field, control, { parse = value => value, placeholder = '', limit } = {}) {
    if (limit) control.maxLength = limit;
    control.id = `inspector-${field}`;
    control.name = field;
    control.dataset.quickAction = field;
    control.readOnly = Boolean(gate);
    if (placeholder) control.placeholder = placeholder;
    control.value = gate ? base[field] : inspectorFieldValue(editor, field);
    const label = node('label', `inspector-field inspector-field-${field}`);
    label.append(node('span', '', title), control);
    control.addEventListener('input', event => {
      if (gate) return;
      if (!event.isComposing) editor.composing.delete(field);
      changeInspectorField(editor, field, parse(control.value));
    });
    control.addEventListener('blur', () => scheduleInspectorSave(editor, true));
    form.append(label);
  }
  const name = node('textarea');
  name.rows = 1;
  addField('素材名称', 'name', name, { placeholder: '未命名素材',
    limit: 180, parse: value => value.replace(/[\r\n]/g, '').trim() });
  const tags = inspectorTagField(asset, editor, gate, false, () => updateInspectorDraft(editor));
  form.append(tags.field);
  if (gate) {
    const note = node('div', 'inspector-field inspector-field-note');
    const content = node('p', asset.note ? 'inspector-note-text' : 'inspector-empty', asset.note || '暂无备注');
    content.id = 'inspector-note';
    content.dataset.inspectorField = 'note';
    note.append(node('span', '', '备注'), content);
    form.append(note);
  } else {
    const note = node('textarea', 'inspector-note-text');
    note.rows = 1;
    note.dataset.inspectorField = 'note';
    addField('备注', 'note', note, { placeholder: '添加备注', limit: 12288 });
  }
  const link = inspectorSourceField();
  addField('来源网址', 'sourceURL', link, { placeholder: gate ? '未设置网址' : 'https://',
    limit: asset.sourceKind === 'eagle' ? 4096 : 16384, parse: value => value.trim() });

  const details = node('details', 'inspector-collections');
  const summary = node('summary');
  summary.dataset.quickAction = 'collections';
  const names = new Map(collections.map(item => [item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id, item.name]));
  const membershipText = node('span', 'inspector-membership');
  function updateMembership() {
    const memberships = gate ? base.collectionIds : inspectorFieldValue(editor, 'collectionIds');
    membershipText.textContent = memberships.map(id => names.get(id)).filter(Boolean).join('、') || '未分类';
    membershipText.title = membershipText.textContent;
  }
  summary.append(node('span', 'inspector-collection-label', '集合'), membershipText);
  details.append(summary);
  details.addEventListener('toggle', () => {
    if (!details.open || details.childElementCount !== 1) return;
    if (gate) {
      details.append(node('p', 'inspector-membership-readonly', membershipText.textContent));
      return;
    }
    const choices = organizer.collectionChoices(libraryId, collections, inspectorFieldValue(editor, 'collectionIds'), '更改所属集合');
    choices.group.addEventListener('change', () => {
      changeInspectorField(editor, 'collectionIds', choices.value().sort());
      updateMembership();
    });
    details.append(choices.group);
  });
  updateMembership();
  if (gate && !base.collectionIds.length) {
    summary.setAttribute('aria-disabled', 'true');
    summary.addEventListener('click', event => event.preventDefault());
  }
  details.open = preview.dataset.inspectedAsset === asset.id &&
    preview.querySelector('.inspector-collections')?.open === true;
  form.append(details, footer);
  if (gate) {
    const notice = node('div', 'inspector-write-gate');
    notice.append(node('p', '', gate.text));
    if (gate.open) {
      const enable = makeButton(gate.label, 'cloud', 'outline-button', gate.open);
      enable.dataset.quickAction = 'enable-write';
      notice.append(enable);
    }
    form.append(notice);
  } else if (asset.sourceKind === 'eagle') {
    const notice = node('div', 'inspector-write-gate');
    notice.append(makeButton('暂停双向同步', 'cloud', 'status-button', () => {
      scheduleInspectorSave(editor, true);
      void configureEagleWrite(libraryId, false);
    }));
    form.append(notice);
  }
  mountedInspectorEditor = { editor, form, flushTag: () => tags.commit?.(false, false) };
  updateActions();

  form.addEventListener('compositionstart', event => {
    const field = event.target.dataset.quickAction;
    if (field) editor.composing.add(field);
  });
  form.addEventListener('compositionend', event => {
    editor.composing.delete(event.target.dataset.quickAction);
    scheduleInspectorSave(editor);
  });
  form.addEventListener('focusout', event => {
    if (form.contains(event.relatedTarget)) return;
    scheduleInspectorSave(editor, true);
    setTimeout(() => {
      if (mountedInspectorEditor?.form !== form || form.contains(document.activeElement) || editor.composing.size) return;
      selectionKey = '';
      renderInspector();
    }, 0);
  });
  form.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter' || event.defaultPrevented) return;
    if (event.target !== name && event.target !== link && !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    if (tags.commit?.() !== false) scheduleInspectorSave(editor, true);
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (tags.commit?.() !== false) scheduleInspectorSave(editor, true);
  });
  return form;
}

function validInspectorURL(value) {
  const url = URL.parse(value);
  return !value || (url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !/[\r\n\u0000]/u.test(value));
}

function inspectorSourceField() {
  const field = node('textarea', 'inspector-source-url');
  field.rows = 1;
  field.inputMode = 'url';
  field.spellcheck = false;
  field.addEventListener('input', () => field.setCustomValidity(validInspectorURL(field.value.trim())
    ? '' : '请输入有效的 HTTP 或 HTTPS 网页网址。'));
  return field;
}

function makeBatchInspector() {
  delete preview.dataset.inspectedAsset;
  disposeInspectorAudio();
  disposeDocumentPreview(preview.querySelector('.preview-stage'));
  const header = node('div', 'preview-head');
  const close = makeButton('', 'close', 'icon-button', toggleInspector);
  close.id = 'close-preview-button';
  close.setAttribute('aria-label', '收起详情栏');
  const actions = node('div', 'preview-head-actions');
  const menu = makeButton('', 'more', 'icon-button inspector-selection-menu', event => showBatchMenu(event.currentTarget));
  menu.setAttribute('aria-label', '所选素材操作');
  menu.setAttribute('aria-haspopup', 'menu');
  actions.append(menu, close);
  header.append(node('h2', '', '详情'), actions);

  const selection = node('div', 'inspector-body inspector-selection');
  const stack = node('div', 'inspector-selection-stack');
  stack.setAttribute('aria-hidden', 'true');
  const title = node('h3', 'inspector-selection-count');
  title.setAttribute('aria-live', 'polite');
  const size = node('p', 'inspector-selection-size');
  const details = node('div', 'inspector-batch-details');
  const tools = node('div', 'inspector-selection-actions');
  tools.append(makeButton('对照', 'compare', 'outline-button inspector-batch-compare', compareSelectedImages));
  const exportButton = makeButton('导出原件', 'export', 'outline-button', () => void exportSelectedAssets());
  exportButton.id = 'inspector-batch-export';
  tools.append(exportButton);
  selection.append(stack, title, size, details, tools);
  preview.replaceChildren(header, selection);
  preview.scrollTop = 0;
  return selection;
}

function updateBatchCovers(stack, assets) {
  const previous = new Map([...stack.children].map(cover => [cover.dataset.coverKey, cover]));
  const visible = assets.slice(-7);
  stack.hidden = !visible.length;
  stack.dataset.count = visible.length;
  const covers = visible.map((asset, index) => {
    const key = JSON.stringify([asset.id, assetContentRevision(asset), asset.thumbnailAvailable, asset.available]);
    let cover = previous.get(key);
    if (!cover) {
      cover = node('div', 'inspector-selection-card');
      cover.dataset.coverKey = key;
      const icon = glyph(kindIcon(asset.kind));
      const settle = surface => motion(surface, [
        { opacity: 0, transform: 'translate(13px,-12px) rotate(5deg) scale(.94)' },
        { opacity: 1, transform: 'none' },
      ], 210);
      cover.append(icon);
      const canUseOriginal = asset.available && (asset.kind === 'image' || asset.extension === 'livp');
      if (asset.thumbnailAvailable || canUseOriginal) {
        const image = node('img');
        image.alt = '';
        image.decoding = 'async';
        image.draggable = false;
        cover.classList.add('is-image');
        loadThumbnail(image, asset, canUseOriginal, {
          decoded: true,
          loaded() {
            const ratio = image.naturalWidth / image.naturalHeight;
            image.style.width = `${Math.min(144, 122 * ratio)}px`;
            image.style.height = `${Math.min(122, 144 / ratio)}px`;
            settle(image);
          },
          failed: () => { image.remove(); cover.classList.remove('is-image'); settle(icon); },
        });
        cover.append(image);
      } else settle(icon);
    }
    const distance = visible.length - index - 1;
    const offset = Math.ceil(distance / 2) * (distance % 2 ? -1 : 1);
    cover.style.zIndex = index;
    cover.style.setProperty('--stack-offset', `${offset * 7}px`);
    cover.style.setProperty('--stack-angle', `${offset * 3}deg`);
    return cover;
  });
  const kept = new Set(covers);
  for (const cover of previous.values()) if (!kept.has(cover)) cover.remove();
  covers.forEach((cover, index) => {
    if (stack.children[index] !== cover) stack.insertBefore(cover, stack.children[index] || null);
  });
}

function sharedItems(assets, field, key = value => value) {
  let shared = new Map((assets[0]?.[field] ?? []).map(value => [key(value), value]));
  for (const asset of assets.slice(1)) {
    if (!shared.size) break;
    const own = new Set(asset[field].map(key));
    shared = new Map([...shared].filter(([id]) => own.has(id)));
  }
  return [...shared.values()];
}

function sharedValue(assets, field, fallback) {
  const first = assets[0]?.[field] ?? fallback;
  return assets.every(asset => (asset[field] ?? fallback) === first) ? first : null;
}

function batchMetadata(assets) {
  const libraries = new Map(state.libraries.map(entry => [entry.id, entry]));
  const byLibrary = new Map();
  for (const asset of assets) {
    const registrationId = asset.sourceLibraryId;
    const library = libraries.get(registrationId);
    if (asset.trashed || !(isWritable(library) || eagleMetadataWritable(library)) || library.syncLogIncomplete ||
        library.kind === 'jiancang' && (!Number.isInteger(library.writeStatus?.pending) ||
        catalogEntries().find(entry => entry.libraryId === registrationId)?.library.logIncomplete)) continue;
    if (!byLibrary.has(registrationId)) byLibrary.set(registrationId, []);
    byLibrary.get(registrationId).push(asset);
  }
  const editable = [...byLibrary.values()].flat();
  const groups = selectedLibraryGroups(editable).map(group => {
    const members = byLibrary.get(group.id);
    const prefix = `${group.id}:`;
    return { ...group, collections: localCollections(group.id),
      memberships: sharedItems(members, 'collectionIds').map(id => id.startsWith(prefix) ? id.slice(prefix.length) : id) };
  });
  return { editable, groups, tags: sharedItems(assets, 'tags', tag => tag.normalize('NFC').toLowerCase()),
    memberships: sharedItems(assets, 'collectionIds').map(id => directories.get(id)?.name).filter(Boolean),
    note: sharedValue(assets, 'note', ''), sourceURL: sharedValue(assets, 'sourceURL', ''), rating: sharedValue(assets, 'rating', 0) };
}

function batchInspectorEditor(assets, model, editor) {
  const { editable, groups } = model;
  const readonly = !editable.length;
  const form = node('form', 'inspector-editor inspector-batch-editor');
  const fields = node('fieldset', 'inspector-batch-fields');
  const footer = node('div', 'inspector-editor-actions');
  const error = node('p', 'inspector-editor-error');
  error.setAttribute('role', 'alert');
  const submit = node('button', 'primary-button', '保存资料');
  submit.type = 'submit';
  const cancel = makeButton('取消', null, 'status-button', () => {
    batchInspectorDraft = undefined;
    form.parentElement.dataset.editorKey = '';
    renderInspector();
  });
  const feedback = node('p', 'inspector-empty');
  if (editable.length < assets.length) {
    feedback.textContent = readonly ? '所选素材为只读。' : `修改将应用到 ${counts.format(editable.length)} 项可编辑素材。`;
    fields.append(feedback);
  }
  footer.append(error, cancel, submit);

  function update() {
    const dirty = Object.keys(editor.fields).length || editor.collections.size || editor.newTag?.trim();
    submit.disabled = readonly || editor.saving || !dirty;
    cancel.hidden = readonly || !dirty;
    cancel.disabled = editor.saving;
    submit.textContent = editor.saving ? '正在保存…' : '保存资料';
    fields.disabled = editor.saving;
    error.textContent = editor.error || '';
    error.hidden = !editor.error;
    form.setAttribute('aria-busy', String(editor.saving));
  }

  function changed() {
    editor.error = '';
    editor.saved.clear();
    editor.failed.clear();
    update();
  }

  function setField(key, value) {
    if (value === model[key]) delete editor.fields[key];
    else editor.fields[key] = value;
    changed();
  }

  function textField(label, key, control, limit, placeholder) {
    control.name = key;
    control.maxLength = limit;
    control.readOnly = readonly;
    control.value = editor.fields[key] ?? model[key] ?? '';
    control.placeholder = model[key] === null ? `多种${label}` : placeholder;
    control.addEventListener('input', () => setField(key, key === 'sourceURL' ? control.value.trim() : control.value));
    const row = node('div', 'inspector-field');
    const caption = node('label', 'inspector-batch-text-label');
    caption.htmlFor = control.id = `inspector-batch-${key}`;
    caption.textContent = label;
    const head = node('div', 'inspector-batch-field-head');
    head.append(caption);
    if (!readonly && model[key] === null) head.append(makeButton('清空', null, 'status-button', () => {
      control.value = '';
      control.dispatchEvent(new Event('input'));
    }));
    row.append(head, control);
    fields.append(row);
  }

  const tags = inspectorTagField({ tags: model.tags, sourceLibraryId: groups.length === 1 ? groups[0].id : null,
    sourceKind: editable.some(asset => asset.sourceKind === 'local') ? 'local' : 'jiancang' }, editor, readonly, editor.saving, changed);
  fields.append(tags.field);

  const collections = node('details', 'inspector-collections');
  const collectionsTitle = node('summary');
  const membershipText = model.memberships.join('、') || '无共同集合';
  const membership = node('span', 'inspector-membership', membershipText);
  membership.title = membershipText;
  collectionsTitle.append(node('span', 'inspector-collection-label', '集合'), membership);
  collections.append(collectionsTitle);
  collections.addEventListener('toggle', () => {
    if (!collections.open || collections.childElementCount > 1) return;
    if (readonly) {
      collections.append(node('p', 'inspector-membership-readonly', membershipText));
      return;
    }
    for (const group of groups) {
      const base = new Set(group.memberships);
      const existing = editor.collections.get(group.id);
      const selected = group.memberships.filter(id => !existing?.removeCollectionIds.includes(id)).concat(existing?.addCollectionIds || []);
      const choices = organizer.collectionChoices(group.id, group.collections, selected, groups.length > 1 ? group.name : '更改共同集合');
      choices.group.addEventListener('change', () => {
        const next = new Set(choices.value());
        const addCollectionIds = [...next].filter(id => !base.has(id));
        const removeCollectionIds = [...base].filter(id => !next.has(id));
        if (addCollectionIds.length || removeCollectionIds.length) editor.collections.set(group.id, { addCollectionIds, removeCollectionIds });
        else editor.collections.delete(group.id);
        changed();
      });
      collections.append(choices.group);
    }
  });
  fields.append(collections);

  const rating = node('select');
  rating.name = 'rating';
  rating.disabled = readonly;
  if (model.rating === null) rating.append(new Option('多种评分', ''));
  for (let value = 0; value <= 5; value++) rating.append(new Option(value ? '★'.repeat(value) : '未评分', String(value)));
  rating.value = editor.fields.rating ?? model.rating ?? '';
  rating.addEventListener('change', () => {
    if (!rating.value) {
      delete editor.fields.rating;
      changed();
    } else setField('rating', Number(rating.value));
  });
  const ratingLabel = node('label', 'inspector-field');
  ratingLabel.append(node('span', '', '评分'), rating);
  fields.append(ratingLabel);
  const note = node('textarea', 'inspector-note-text');
  note.rows = 1;
  textField('备注', 'note', note, 12288, readonly ? '暂无备注' : '添加共同备注');
  const link = inspectorSourceField();
  textField('来源网址', 'sourceURL', link, 16384, 'https://');
  if (readonly) footer.hidden = true;
  form.append(fields, footer);
  update();

  form.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 ||
        (event.target !== link && !(event.ctrlKey || event.metaKey))) return;
    event.preventDefault();
    if (!submit.disabled) form.requestSubmit(submit);
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (readonly || editor.saving || batchWorking || crossLibraryWrite || !tags.commit()) return;
    const patch = { ...editor.fields };
    if ('sourceURL' in patch) patch.sourceURL ||= null;
    const jobs = groups.filter(group => !editor.saved.has(group.id) &&
      (Object.keys(patch).length || editor.collections.has(group.id)));
    if (!jobs.length) return;
    editor.saving = batchWorking = true;
    editor.error = '';
    update();
    updateBatchActions();
    setCrossLibraryWrite(true);
    let written = 0;
    const failures = [];
    try {
      for (const group of jobs) {
        try {
          const target = editor.failed.get(group.id) ?? group;
          const result = await mutateLocal(group.id, { action: 'edit', ids: target.ids,
            ...(target.expected && { expected: target.expected }), ...patch, ...editor.collections.get(group.id) });
          if (!result?.ok) throw new Error(result?.message || '请重试。');
          written += result.count ?? target.ids.length;
          if (result.failed?.length) {
            editor.failed.set(group.id, { ...target, ids: result.failed.map(item => item.id) });
            failures.push(...result.failed.map(item => `${group.name} · ${item.name}：${item.message}`));
            continue;
          }
          editor.saved.add(group.id);
          editor.failed.delete(group.id);
        } catch (error) { failures.push(`${group.name}：${error?.message || '保存失败。'}`); }
      }
      if (failures.length) editor.error = failures.join('\n');
      else if (batchInspectorDraft === editor) batchInspectorDraft = undefined;
      if (written || !failures.length) showToast(written ? `已保存 ${counts.format(written)} 项素材的资料。` : '资料已是最新。');
    } finally {
      editor.saving = batchWorking = false;
      const panel = form.parentElement;
      if (panel) panel.dataset.editorKey = '';
      setCrossLibraryWrite(false);
      if (panel && preview.contains(panel)) renderInspector();
      else if (failures.length) showToast(failures.join('\n'));
      updateBatchActions();
    }
  });
  return form;
}

function renderBatchInspector() {
  const provisional = marqueeSelection !== null;
  const assets = provisional ? [...marqueeSelection].map(id => assetById.get(id)).filter(Boolean) : selectedBatchAssets();
  const selection = preview.querySelector('.inspector-selection') ?? makeBatchInspector();
  selectionKey = 'batch';
  const before = selection.dataset.provisional === 'true';
  selection.dataset.provisional = String(provisional);
  if (provisional && !before) preview.scrollTop = 0;
  updateBatchCovers(selection.querySelector('.inspector-selection-stack'), assets);
  const count = selection.querySelector('.inspector-selection-count');
  count.setAttribute('aria-live', provisional ? 'off' : 'polite');
  count.textContent = `已选 ${counts.format(assets.length)} 项素材`;
  const known = assets.filter(asset => Number.isFinite(asset.byteCount) && asset.byteCount >= 0);
  const total = formatBytes(known.reduce((bytes, asset) => bytes + asset.byteCount, 0));
  const size = selection.querySelector('.inspector-selection-size');
  size.textContent = assets.length === known.length ? `总大小 ${total}` : known.length ? `已知大小 ${total}` : '素材大小暂不可用';
  size.hidden = !assets.length;
  preview.querySelector('.inspector-selection-menu').hidden = provisional;
  selection.querySelector('.inspector-selection-actions').hidden = provisional;
  const details = selection.querySelector('.inspector-batch-details');
  details.hidden = provisional;
  if (provisional) return;
  selection.querySelector('.inspector-batch-compare').hidden = !canCompareImages(assets);
  selection.querySelector('#inspector-batch-export').disabled = batchWorking;

  const selectedKey = JSON.stringify(assets.map(asset => asset.id).sort());
  if (batchInspectorDraft?.key !== selectedKey) {
    batchInspectorDraft = { key: selectedKey, fields: {}, collections: new Map(), saved: new Set(), failed: new Map(), saving: false };
  }
  const model = batchMetadata(assets);
  const { editable, ...summary } = model;
  const editorKey = JSON.stringify([selectedKey, editable.map(asset => asset.id), summary]);
  if (details.dataset.editorKey === editorKey || batchInspectorDraft.saving && details.firstChild) return;
  details.dataset.editorKey = editorKey;
  details.replaceChildren(batchInspectorEditor(assets, model, batchInspectorDraft));
}

function inspectorDimensions(asset, image) {
  if (mediaRatio(asset.width, asset.height)) return `${asset.width} × ${asset.height}`;
  if (image?.dataset.previewOriginal && image.dataset.previewPhotoId === asset.id && image.naturalWidth && image.naturalHeight) {
    return `${image.naturalWidth} × ${image.naturalHeight}`;
  }
  return '';
}

function updateInspectorDimensions(asset, image) {
  if (preview.dataset.inspectedAsset !== asset.id || mediaRatio(asset.width, asset.height)) return;
  const field = byId('inspector-dimensions');
  const value = inspectorDimensions(asset, image);
  if (!field || !value) return;
  field.textContent = value;
  field.hidden = field.previousElementSibling.hidden = false;
}

const inspectorVideoMetadata = new Map();
const videoNumbers = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2, useGrouping: false });

function updateInspectorVideoMetadata() {
  const frameRate = byId('inspector-frame-rate');
  const bitrate = byId('inspector-bitrate');
  const asset = assetById.get(viewer?.assetId ?? selectedId);
  if (preview.hidden || !frameRate || !bitrate || !asset?.sourceRevision || !asset.available ||
      asset.kind !== 'video' || asset.extension === 'livp' || !bridge.getVideoMetadata) return;
  const key = JSON.stringify([asset.id, assetContentRevision(asset), asset.sourceRevision]);
  if (frameRate.dataset.probe === key) return;
  frameRate.dataset.probe = key;
  frameRate.hidden = frameRate.previousElementSibling.hidden = true;
  bitrate.hidden = bitrate.previousElementSibling.hidden = true;

  const current = () => {
    if (!frameRate.isConnected || frameRate.dataset.probe !== key) return false;
    const active = assetById.get(viewer?.assetId ?? selectedId);
    return active?.id === asset.id && active.sourceRevision === asset.sourceRevision &&
      assetContentRevision(active) === assetContentRevision(asset);
  };
  setTimeout(async () => {
    if (preview.hidden || !current()) {
      if (frameRate.dataset.probe === key) delete frameRate.dataset.probe;
      return;
    }
    let pending = inspectorVideoMetadata.get(key);
    if (!pending) {
      pending = bridge.getVideoMetadata({ id: asset.sourceAssetId, registrationId: asset.sourceLibraryId,
        revision: asset.sourceRevision }).catch(() => null).then(info => {
        if (!info && inspectorVideoMetadata.get(key) === pending) inspectorVideoMetadata.delete(key);
        return info;
      });
      if (inspectorVideoMetadata.size >= 64) inspectorVideoMetadata.delete(inspectorVideoMetadata.keys().next().value);
      inspectorVideoMetadata.set(key, pending);
    }
    const info = await pending;
    if (!info || !current()) return;
    const set = (row, value) => {
      row.textContent = value;
      row.hidden = row.previousElementSibling.hidden = !value;
    };
    if (Number.isFinite(info.frameRate) && info.frameRate > 0) set(frameRate, `${videoNumbers.format(info.frameRate)} fps`);
    if (Number.isFinite(info.bitrate) && info.bitrate > 0) {
      const mbps = info.bitrate >= 1_000_000;
      set(bitrate, `${videoNumbers.format(info.bitrate / (mbps ? 1_000_000 : 1000))} ${mbps ? 'Mbps' : 'kbps'}`);
    }
  }, 140);
}

function fitInspectorPreview(stage, media) {
  const cover = media?.closest('.live-photo')?.querySelector('img:not([hidden]), canvas[data-preview-seed]:not([hidden])');
  const size = window.previewTransitions.imageSize(cover || media);
  const ratio = mediaRatio(size?.width ?? media?.videoWidth, size?.height ?? media?.videoHeight);
  stage.classList.toggle('is-fitted', ratio !== null);
  if (ratio === null) stage.style.removeProperty('--preview-ratio');
  else stage.style.setProperty('--preview-ratio', ratio);
}

function renderInspector() {
  const asset = assetById.get(viewer?.assetId ?? selectedId);
  updateInspectorVisibility();
  const showBatch = !viewer && (batchMode || marqueeSelection);
  leaveInspectorEditor(showBatch ? null : asset?.id);
  if (showBatch) { renderBatchInspector(); return; }
  batchInspectorDraft = undefined;
  if (!asset) {
    if (selectionKey || !preview.firstChild) {
      disposeInspectorAudio();
      disposeDocumentPreview(preview.querySelector('.preview-stage'));
      preview.replaceChildren(mediaMessage('inspector', '选择素材查看详情'));
    }
    selectionKey = '';
    delete preview.dataset.inspectedAsset;
    return;
  }
  const gate = inspectorEditGate(asset);
  const canQuickEdit = !gate;
  const collections = localCollections(asset.sourceLibraryId);
  const memberships = asset.collectionIds.map(id => directories.get(id)?.name).filter(Boolean);
  const { sourceRevision, ...metadata } = asset;
  const stageHidden = asset.kind === 'audio' && !!viewer;
  const stageKey = JSON.stringify([previewKey(asset), stageHidden]);
  const key = JSON.stringify([metadata, memberships, collections, stageKey, scopeId === null, gate?.text, gate?.label]);
  if (key === selectionKey) {
    updateInspectorVideoMetadata();
    return;
  }
  const editing = mountedInspectorEditor?.form;
  if (mountedInspectorEditor?.editor.asset.id === asset.id &&
      editing.dataset.readonly === String(Boolean(gate)) && editing.contains(document.activeElement)) return;
  const previousStage = preview.querySelector('.preview-stage');
  const previousMedia = mediaLoads.get(previousStage);
  const sameStageKey = previousStage?.dataset.previewKey === stageKey;
  const refreshPhoto = !sameStageKey && isStillPhoto(asset) && previousMedia?.photo;
  const reuseStage = sameStageKey || refreshPhoto;
  if (!reuseStage) {
    disposeInspectorAudio();
    disposeDocumentPreview(previousStage);
  }
  selectionKey = key;
  const sameAsset = preview.dataset.inspectedAsset === asset.id;
  const scrollTop = sameAsset ? preview.scrollTop : 0;
  const focusedElement = sameAsset && preview.contains(document.activeElement) ? document.activeElement : null;
  const focused = focusedElement?.dataset?.quickAction;
  const cursor = typeof focusedElement?.selectionStart === 'number' ? [focusedElement.selectionStart, focusedElement.selectionEnd] : null;
  preview.dataset.inspectedAsset = asset.id;

  const header = node('div', 'preview-head');
  const title = node('h2', '', '详情');
  if (gate) title.append(node('span', 'inspector-access-badge', '只读'));
  const close = makeButton('', 'close', 'icon-button', toggleInspector);
  close.id = 'close-preview-button';
  close.setAttribute('aria-label', '收起详情栏');
  const headerActions = node('div', 'preview-head-actions');
  if (canQuickEdit && asset.sourceKind !== 'eagle') {
    const favorite = makeButton('', 'star', 'icon-button quick-favorite', () => toggleFavoriteAsset(asset));
    favorite.id = 'inspector-quick-favorite';
    favorite.dataset.quickAction = 'favorite';
    favorite.setAttribute('aria-label', '收藏');
    updateFavoriteButton(favorite, asset);
    headerActions.append(favorite);
  }
  const openMore = event => void showAssetMenu(asset, null, null, event);
  const more = makeButton('', 'more', 'icon-button', openMore);
  more.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) openMore(event);
  });
  more.setAttribute('aria-label', '素材操作');
  more.setAttribute('aria-haspopup', 'menu');
  more.title = '素材操作';
  headerActions.append(more);
  headerActions.append(close);
  header.append(title, headerActions);
  const stage = reuseStage ? previousStage : node('div', 'preview-stage');
  stage.dataset.previewAssetId = asset.id;
  stage.dataset.previewKey = stageKey;
  if (canDragInspectorPreview(asset)) stage.title = asset.available ? '也可以从这里拖出图片副本' : '';
  if (!reuseStage) {
    stage.hidden = stageHidden;
    const getAsset = () => mediaLoads.get(stage)?.loadingPrevious ? null : assetById.get(stage.dataset.previewAssetId);
    if (canDragInspectorPreview(asset)) bindAssetDrag(stage, asset, { getAsset });
    stage.addEventListener('contextmenu', event => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const current = getAsset();
      if (current) void showAssetMenu(current, null, stage, event);
    });
    if (canDragInspectorPreview(asset)) {
      stage.addEventListener('dblclick', event => {
        if (event.target.closest('button, video')) return;
        const current = getAsset();
        if (!viewer && current && canPreview(current)) openViewer(current);
      });
    }
  }
  if (!sameStageKey && !stage.hidden) {
    fitInspectorPreview(stage, null);
    mountMedia(stage, asset, media => fitInspectorPreview(stage, media));
  }
  if (!mediaLoads.get(stage)?.loadingPrevious) {
    const image = stage.querySelector('img');
    if (image) image.alt = asset.kind === 'video' ? `${asset.name} · 视频封面` : asset.name;
  }

  const recognition = visual.record(asset);
  const body = reuseStage ? stage.parentElement : node('div', 'inspector-body');
  if (reuseStage) {
    while (stage.nextSibling) stage.nextSibling.remove();
  } else body.append(stage);
  body.append(inspectorPalette(asset, recognition?.palette ?? (recognition?.primaryColor ? [recognition.primaryColor] : [])));
  body.append(inspectorEditor(asset, collections, gate));

  const info = node('div', 'info');
  const params = node('dl');
  const addParam = (label, value) => { if (value) params.append(node('dt', '', label), node('dd', '', value)); };
  addParam('类型', asset.extension === 'livp' ? '实况照片' : (asset.extension || labels[asset.kind]));
  addParam('大小', formatBytes(asset.byteCount));
  const original = stage.querySelector('img[data-preview-original]') ||
    (viewer?.assetId === asset.id ? viewerMedia.querySelector('img[data-preview-original]') : null);
  const dimensions = inspectorDimensions(asset, original);
  if (dimensions || isStillPhoto(asset)) {
    const label = node('dt', '', '尺寸');
    const value = node('dd', '', dimensions);
    value.id = 'inspector-dimensions';
    label.hidden = value.hidden = !dimensions;
    params.append(label, value);
  }
  addParam('时长', formatDuration(asset.duration));
  if (asset.kind === 'video' && asset.extension !== 'livp') {
    for (const [name, id] of [['帧率', 'inspector-frame-rate'], ['码率', 'inspector-bitrate']]) {
      const title = node('dt', '', name);
      const value = node('dd');
      value.id = id;
      title.hidden = value.hidden = true;
      params.append(title, value);
    }
  }
  addParam('添加', formatDate(asset.importedAt));
  if (canQuickEdit) params.append(node('dt', 'inspector-rating-label', '评分'), inspectorRating(asset));
  else addParam('评分', asset.rating ? `${asset.rating} / 5` : '');
  if (scopeId === null) addParam('素材库', asset.sourceName);
  if (asset.favorite && (!canQuickEdit || asset.sourceKind === 'eagle')) addParam('收藏', '已收藏');
  info.append(node('h3', '', '素材信息'), params);
  if (recognition?.text) {
    const details = node('details', 'visual-ocr-details');
    details.append(node('summary', '', '图片文字'), node('p', '', recognition.text),
      makeButton('复制文字', null, 'outline-button', async () => {
        try {
          const result = await bridge.copyOCRText(visualReference(asset));
          showToast(result?.ok ? '已复制图片文字。' : result?.message);
        } catch { showToast('无法复制图片文字。'); }
      }));
    info.append(details);
  }
  body.append(info);
  if (reuseStage) preview.firstElementChild.replaceWith(header);
  else preview.replaceChildren(header, body);
  updateInspectorVideoMetadata();
  preview.scrollTop = scrollTop;
  if (focused) {
    const button = [...preview.querySelectorAll('[data-quick-action]')].find(control => control.dataset.quickAction === focused);
    (button ?? params.querySelector('.inspector-star'))?.focus({ preventScroll: true });
    if (cursor) button?.setSelectionRange?.(...cursor);
  }
}

function resetGallery() {
  closeViewer({ restore: false });
  scrollingGallery.scrollTop = 0;
  renderGallery();
}

function updateInspectorVisibility() {
  const showing = preferences.inspector && !viewer?.focus;
  const revealed = showing && preview.hidden;
  workspace.classList.toggle('has-preview', showing);
  preview.hidden = !showing;
  inspectorHandle.hidden = !showing;
  byId('toggle-inspector').setAttribute('aria-pressed', String(showing));
  byId('toggle-inspector').title = showing ? '收起详情栏' : '显示详情栏';
  byId('viewer-inspector').setAttribute('aria-pressed', String(showing));
  if (!showing) preview.querySelector('video, audio')?.pause();
  if (revealed) updateInspectorVideoMetadata();
  syncPanelWidths();
}

function toggleInspector() {
  const fromInspector = preview.contains(document.activeElement);
  if (viewer?.focus) {
    preferences.inspector = true;
    toggleViewerFocus();
  } else {
    preferences.inspector = !preferences.inspector;
    updateInspectorVisibility();
  }
  savePreferences();
  if (!preview.hidden) motion(preview, [{ opacity: 0, transform: 'translateX(9px)' }, { opacity: 1 }]);
  if (fromInspector) byId(viewer ? 'viewer-inspector' : 'toggle-inspector').focus();
}

function inspectorMaxWidth() {
  const available = workspace.clientWidth - librarySidebar.offsetWidth;
  return Math.round(clamp(available * 0.43, 228, 520));
}

function sidebarMaxWidth() {
  return Math.round(clamp(workspace.clientWidth * 0.34, 152, 420));
}

function syncPanelWidths() {
  if (!workspace.clientWidth) return;
  const sidebarMax = sidebarMaxWidth();
  if (preferences.sidebarWidth && workspace.clientWidth > 725) {
    workspace.style.setProperty('--rail-width', `${clamp(preferences.sidebarWidth, 152, sidebarMax)}px`);
  } else workspace.style.removeProperty('--rail-width');
  const inspectorMax = inspectorMaxWidth();
  const inspectorWidth = clamp(preferences.inspectorWidth, 228, inspectorMax);
  workspace.style.setProperty('--preview-width', `${inspectorWidth}px`);
  if (windowsCaption) viewerToolbar.style.setProperty('--viewer-sidebar-width', `${librarySidebar.offsetWidth}px`);
  for (const [handle, value, min, max] of [
    [sidebarHandle, librarySidebar.offsetWidth, 152, sidebarMax],
    [inspectorHandle, inspectorWidth, 228, inspectorMax],
  ]) {
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(clamp(Math.round(value), min, max)));
  }
}

function bindPanelResize(handle, element, preference, min, getMaximum, direction) {
  let drag;
  const resize = width => {
    preferences[preference] = clamp(width, min, getMaximum());
    syncPanelWidths();
  };
  handle.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, width: element.offsetWidth };
    handle.setPointerCapture(event.pointerId);
    workspace.classList.add('is-resizing');
    handle.classList.add('is-dragging');
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) resize(drag.width + (event.clientX - drag.x) * direction);
  });
  handle.addEventListener('lostpointercapture', event => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    workspace.classList.remove('is-resizing');
    handle.classList.remove('is-dragging');
    savePreferences();
  });
  handle.addEventListener('keydown', event => {
    const width = element.offsetWidth;
    const sizes = { ArrowLeft: width - 16 * direction, ArrowRight: width + 16 * direction, Home: min, End: getMaximum() };
    if (!Object.hasOwn(sizes, event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    resize(sizes[event.key]);
    savePreferences();
  });
}

bindPanelResize(sidebarHandle, librarySidebar, 'sidebarWidth', 152, sidebarMaxWidth, 1);
bindPanelResize(inspectorHandle, preview, 'inspectorWidth', 228, inspectorMaxWidth, -1);
new ResizeObserver(syncPanelWidths).observe(workspace);

function rateFocusedAsset(event) {
  const target = event.target;
  const activeViewer = viewer;
  const card = target.closest?.('.asset-card');
  if (activeViewer) {
    if (activeViewer.closing || !viewerViewport.contains(target) ||
        target.closest('button, .desktop-video-controls, .desktop-video-notes')) return;
  } else if (!card || !gallery.contains(card) || batchMode || selectedId !== card.dataset.assetId) return;

  const asset = assetById.get(activeViewer ? activeViewer.assetId : card.dataset.assetId);
  if (!asset) return;
  event.preventDefault();
  if (event.repeat || busy || batchWorking || crossLibraryWrite || keyboardRatingPending || organizer.immediatePending) return;
  const gate = inspectorEditGate(asset);
  if (gate) { showToast(gate.text); return; }

  const queue = activeViewer ? previewableAssets : visibleAssets;
  const index = queue.findIndex(item => item.id === asset.id);
  const nextId = preferences.autoAdvanceRating && index >= 0 ? queue[index + 1]?.id : null;
  const onSaved = () => {
    if (!nextId || !preferences.autoAdvanceRating || viewer !== activeViewer || document.activeElement !== target ||
        document.querySelector('dialog[open], [popover]:popover-open')) return;
    if (activeViewer) {
      const next = previewableAssets[previewIndices.get(nextId)];
      if (activeViewer.assetId === asset.id && !activeViewer.closing && next) showViewerAsset(next, 1);
    } else if (!batchMode && selectedId === asset.id) {
      const next = continuous.focus(nextId);
      if (next) selectAsset(nextId, next);
    }
  };
  // The bridge can publish the changed catalogue before the rating response.
  // Move within the visible order before refreshing the rating sort or filter.
  keyboardRatingPending = true;
  void setAssetRating(asset, Number(event.key), { onSaved }).finally(() => {
    keyboardRatingPending = false;
    flushDeferredLibraryState();
  });
}

gallery.addEventListener('keydown', event => {
  if (event.altKey) return;
  const target = event.target.closest('.asset-card');
  if (!target) return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    const id = continuous.neighbor(target.dataset.assetId, event.key);
    if (id || scrollingGallery.dataset.layout !== 'list') event.preventDefault();
    if (id) {
      const next = continuous.focus(id);
      if (event.shiftKey) selectAssetRange(id, target.dataset.assetId, event.ctrlKey || event.metaKey);
      else selectAsset(id, next);
    }
  }
  if (event.key === 'Home' || event.key === 'End') {
    const asset = event.key === 'Home' ? visibleAssets[0] : visibleAssets.at(-1);
    if (asset) {
      event.preventDefault();
      const next = continuous.focus(asset.id);
      if (event.shiftKey) selectAssetRange(asset.id, target.dataset.assetId, event.ctrlKey || event.metaKey);
      else selectAsset(asset.id, next);
    }
  }
  if (event.key === 'Enter' || event.code === 'Space') {
    const asset = assetById.get(target.dataset.assetId);
    if (!asset) return;
    event.preventDefault();
    if (event.repeat) return;
    if (event.code === 'Space' && (event.ctrlKey || event.metaKey)) toggleBatchItem(asset.id);
    else if (canPreview(asset)) {
      if (batchMode) selectAsset(asset.id, target);
      openViewer(asset, target);
    }
  }
});

document.addEventListener('keydown', event => {
  if (event.isComposing || document.querySelector('dialog[open]')) return;
  const shortcut = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (appMenu.matches(':popover-open')) {
    if (event.key === 'Escape') return;
    if (appMenu.contains(event.target)) {
      if (event.target.closest('input, select, textarea') ||
          !(shortcut && (key === 'l' || key === 'i') || !shortcut && !event.altKey && event.key === 'F1')) return;
      appMenu.hidePopover();
    }
  }
  if (!shortcut && !event.altKey && event.key === 'F1') { event.preventDefault(); void openHelp(); return; }
  if (shortcut && key === 'l') { event.preventDefault(); openLibraryManager(); return; }
  if (!browseCatalog || event.defaultPrevented) return;
  if (event.altKey && !shortcut && !event.shiftKey && (key === 'arrowleft' || key === 'arrowright')) {
    event.preventDefault();
    goFromNavigationHistory(key === 'arrowleft' ? 'back' : 'forward');
    return;
  }
  if (assetSearch.isOpen && event.key === 'Escape') return;
  if (assetFilters.isOpen && event.key === 'Escape') {
    assetFilters.close();
    return;
  }
  if (event.key === 'Escape' && cancelMarquee()) { event.preventDefault(); return; }
  const formFocused = event.target.closest?.('input, select, textarea, [contenteditable], audio, video, [role="separator"], .inspector-field-tags button');
  if (!formFocused && !shortcut && !event.altKey && !event.shiftKey && event.keyCode !== 229 && /^[0-5]$/.test(key) &&
      !assetSearch.isOpen && !assetFilters.isOpen && !document.fullscreenElement && !document.querySelector('[popover]:popover-open')) {
    rateFocusedAsset(event);
    return;
  }
  if (!viewer && shortcut && !event.altKey && key === 'a' && !formFocused) {
    event.preventDefault();
    selectAllVisibleAssets();
    return;
  }
  if (batchMode && event.key === 'Escape' && !formFocused) {
    event.preventDefault();
    endBatchSelection();
    return;
  }
  if (shortcut && event.shiftKey && !event.altKey && key === 'f') {
    event.preventDefault();
    collectionFinder.open();
    return;
  }
  if ((shortcut && key === 'f') || (!shortcut && !formFocused && !event.altKey && key === '/')) {
    event.preventDefault();
    closeViewer();
    assetSearch.close();
    searchInput.focus();
    searchInput.select();
    return;
  }
  if (shortcut && key === 'i' && writableLibraries().length) {
    event.preventDefault();
    void intake.open();
    return;
  }
  if (viewer && event.key === 'Escape') {
    event.preventDefault();
    if (!viewer.player?.dismissOverlay()) closeViewer();
    return;
  }
  if (!formFocused && !shortcut && !event.altKey && !event.repeat && event.key === 'F2' && section !== 'trash') {
    if (batchMode && batchAssetAction('renameAssets')) { event.preventDefault(); return; }
    if (!batchMode) {
      const asset = currentViewerAsset() || assetById.get(selectedId);
      if (writableAsset(asset)) {
        event.preventDefault();
        organizer.renameAssets(asset.sourceLibraryId, [asset]);
        return;
      }
      if (asset && selectedMetadataAssets([asset]).length) {
        event.preventDefault();
        organizer.renameAcrossLibraries(selectedLibraryGroups([asset]), [asset], 0);
        return;
      }
    }
  }
  if (!formFocused && shortcut && !event.altKey && (key === 'z' || key === 'y' && !event.shiftKey)) {
    const action = key === 'y' || event.shiftKey ? 'redo' : 'undo';
    if (runLocalHistory(action)) { event.preventDefault(); return; }
  }
  if (!formFocused && !shortcut && !event.repeat && event.key === 'Delete') {
    const preview = currentViewerAsset();
    const asset = preview || assetById.get(selectedId);
    if (section === 'trash' || preview?.trashed) {
      if (event.altKey || event.shiftKey || document.querySelector('[popover]:popover-open')) return;
      const selected = !preview && batchMode ? selectedBatchAssets() : asset ? [asset] : [];
      if (purgeSelectedTrash(selected)) event.preventDefault();
      return;
    }
    if (batchMode) {
      event.preventDefault();
      batchAssetAction('trash');
      return;
    }
    if (writableAsset(asset)) { event.preventDefault(); organizer.trash(asset.sourceLibraryId, [asset]); return; }
  }
  if (viewer && event.code === 'Space' && !event.repeat && !shortcut && !formFocused && !event.target.closest('button')) {
    event.preventDefault();
    if (viewer.player) viewer.player.togglePlayback();
    else closeViewer();
    return;
  }
  if (viewer && !shortcut && !event.altKey && !formFocused) {
    if ((key === 'j' || key === 'l') && currentViewerAsset()?.kind === 'audio' &&
        viewer.player?.seekBy(key === 'j' ? -5 : 5)) {
      event.preventDefault();
      return;
    }
    if ((event.key === 'PageUp' || event.key === 'PageDown') &&
        pdfPreviews.get(viewerMedia)?.move(event.key === 'PageUp' ? -1 : 1)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      moveViewer(event.key === 'ArrowLeft' ? -1 : 1);
    }
    if (key === 'f') { event.preventDefault(); toggleViewerFocus(); }
  }
  if (!viewer && event.code === 'Space' && !event.repeat && !shortcut && !formFocused && !event.target.closest('button')) {
    const asset = assetById.get(selectedId);
    if (asset && canPreview(asset)) {
      event.preventDefault();
      openViewer(asset);
    }
  }
  if (event.key === 'Escape') {
    if (document.activeElement === searchInput && searchInput.value) {
      assetSearch.restore('', assetSearch.field);
      resetGallery();
    } else if (selectedId !== null) clearSelection();
  }
});

function openLibraryManager() {
  renderLibraries();
  renderStatus();
  if (!librariesDialog.open) librariesDialog.showModal();
}

function openHelp() {
  if (!shortcutDialog.open) shortcutDialog.showModal();
}

function mergeLegacyPresets(storage, presets) {
  let added = 0;
  let existing = 0;
  let skipped = 0;
  const limits = {
    'jiancang-rename-presets-v1': 256,
    'jiancang-export-presets-v1:originals': 64,
    'jiancang-export-presets-v1:conversion': 64,
  };
  const nameKey = row => typeof row?.name === 'string' ? row.name.trim().normalize().toLowerCase() : '';
  for (const [key, limit] of Object.entries(limits)) {
    const incoming = presets?.[key];
    if (!Array.isArray(incoming) || !incoming.length) continue;
    let notHandled = incoming.length;
    try {
      const raw = storage.getItem(key);
      const saved = raw === null ? [] : JSON.parse(raw);
      if (!Array.isArray(saved)) throw new Error('预设格式无效。');
      const names = new Set(saved.map(nameKey));
      const additions = new Map();
      for (const row of incoming) {
        const name = nameKey(row);
        if (name && names.has(name)) {
          existing++;
          notHandled--;
        } else if (name && saved.length + additions.size < limit && !additions.has(name)) {
          additions.set(name, row);
        }
      }
      if (additions.size) {
        storage.setItem(key, JSON.stringify([...saved, ...additions.values()]));
        added += additions.size;
        notHandled -= additions.size;
      }
    } catch { /* Leave the current presets alone if storage cannot be read or written. */ }
    skipped += notHandled;
  }
  return { added, existing, skipped };
}

async function importLegacyPresets(event) {
  const button = event.currentTarget;
  const status = byId('help-preset-result');
  button.disabled = true;
  status.textContent = '正在读取见藏旧版预设…';
  try {
    const { presets, skipped: invalid = 0 } = await bridge.importLegacyPresets();
    const { added, existing, skipped } = mergeLegacyPresets(localStorage, presets);
    const messages = [];
    if (added) messages.push(`已导入 ${added} 个预设。`);
    if (existing) messages.push(`已保留 ${existing} 个同名预设。`);
    if (skipped + invalid) messages.push(`有 ${skipped + invalid} 项无法导入。`);
    status.textContent = messages.join('') || '未找到见藏旧版预设。';
  } catch (error) {
    status.textContent = error.message || '无法导入旧版预设。';
  } finally {
    button.disabled = false;
  }
}

const appMenuTriggers = [...document.querySelectorAll('[data-app-menu-trigger]')];
const appMenuCommands = [...appMenu.querySelectorAll('[data-app-command]')];
let appMenuTrigger;

function positionAppMenu() {
  const bounds = appMenuTrigger?.getBoundingClientRect();
  if (!bounds?.height) return;
  appMenu.style.setProperty('--app-menu-left', `${Math.max(8, bounds.left)}px`);
  appMenu.style.setProperty('--app-menu-top', `${bounds.bottom + 5}px`);
}

function refreshAppMenu() {
  for (const command of appMenuCommands) {
    const control = byId(command.dataset.appCommand);
    command.disabled = control.hidden || control.disabled;
    if (control.title && command.hasAttribute('data-app-command-title')) {
      command.querySelector('[data-app-command-label]').textContent = control.title;
    }
  }
}

for (const trigger of appMenuTriggers) {
  trigger.addEventListener('click', () => { appMenuTrigger = trigger; });
  trigger.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (!appMenu.matches(':popover-open')) trigger.click();
  });
}

appMenu.addEventListener('beforetoggle', event => {
  const opening = event.newState === 'open';
  if (opening) {
    appMenuTrigger = event.source || appMenuTrigger || appMenuTriggers.find(trigger => trigger.offsetHeight);
    refreshAppMenu();
    positionAppMenu();
  }
  for (const trigger of appMenuTriggers) {
    trigger.setAttribute('aria-expanded', String(opening && trigger === appMenuTrigger));
  }
});

for (const command of appMenuCommands) {
  command.addEventListener('click', () => {
    const control = byId(command.dataset.appCommand);
    if (control.disabled || control.hidden) return;
    appMenu.hidePopover();
    control.click();
  });
}

byId('open-browser-capture').addEventListener('click', () => {
  appMenu.hidePopover();
  void browserCaptureTools.open();
});

appMenu.addEventListener('keydown', event => {
  if (!event.target.matches('.app-menu-command') || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const available = [...appMenu.querySelectorAll('.app-menu-command')]
    .filter(command => !command.disabled && command.getClientRects().length);
  const current = available.indexOf(event.target);
  if (event.key === 'Home') available[0]?.focus();
  else if (event.key === 'End') available.at(-1)?.focus();
  else {
    const step = event.key === 'ArrowUp' ? -1 : 1;
    available[(current + step + available.length) % available.length]?.focus();
  }
});

document.addEventListener('focusin', event => {
  if (appMenu.matches(':popover-open') && !appMenu.contains(event.target) && !appMenuTriggers.includes(event.target)) {
    appMenu.hidePopover();
  }
});

window.addEventListener('resize', () => {
  if (appMenu.matches(':popover-open')) positionAppMenu();
});

function applyTheme() {
  const dark = preferences.theme === 'dark';
  document.documentElement.dataset.theme = preferences.theme;
  if (windowsCaption || window.jiancangTauriPlatform) void window.jiancang.setWindowAppearance(dark).catch(() => {});
  for (const id of ['theme-button', 'viewer-theme']) {
    const button = byId(id);
    button.replaceChildren(glyph(dark ? 'sun' : 'moon'));
    button.setAttribute('aria-pressed', String(dark));
    button.title = dark ? '切换到白色主题' : '切换到黑色主题';
  }
}

function toggleTheme(event) {
  preferences.theme = preferences.theme === 'light' ? 'dark' : 'light';
  applyTheme();
  savePreferences();
  motion(event.currentTarget, [{ transform: 'scale(.86)' }, { transform: 'scale(1)' }], 155);
}

function currentViewerAsset() { return assetById.get(viewer?.assetId); }

scrollingGallery.addEventListener('scroll', () => {
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = setTimeout(rememberWorkspace, 180);
}, { passive: true });
byId('collection-tree').addEventListener('click', event => {
  if (event.target.closest('button.collection-toggle')) rememberWorkspace();
});
window.addEventListener('pagehide', rememberWorkspace);
byId('shortcut-help').addEventListener('click', openHelp);
byId('shortcut-close').addEventListener('click', () => shortcutDialog.close());
const ratingAutoAdvance = byId('keyboard-rating-auto-advance');
ratingAutoAdvance.checked = preferences.autoAdvanceRating;
ratingAutoAdvance.addEventListener('change', () => {
  preferences.autoAdvanceRating = ratingAutoAdvance.checked;
  savePreferences();
});
if (typeof bridge.importLegacyPresets === 'function') {
  byId('help-preset-migration').hidden = false;
  byId('help-import-presets').addEventListener('click', importLegacyPresets);
}

byId('connect-button').addEventListener('click', () => requestState('chooseDirectory'));
for (const button of document.querySelectorAll('[data-library-open-action]')) {
  button.addEventListener('click', async () => {
    try {
      if (button.dataset.libraryOpenAction === 'cancel') await bridge.cancelLibraryOpen();
      else {
        const result = await bridge.revealLibraryOpenFolder();
        if (!result?.ok) showToast(result?.message || '暂时无法打开素材库文件夹。');
      }
    } catch { showToast('素材库操作未完成，请重试。'); }
  });
}
byId('refresh-button').addEventListener('click', () => scopeId === null ? requestState('refreshAll') : requestState('refresh', scopeId));
byId('manage-libraries-button').addEventListener('click', openLibraryManager);
byId('recover-libraries-button').addEventListener('click', openLibraryManager);
byId('close-libraries-button').addEventListener('click', () => librariesDialog.close());
byId('add-sync-library').addEventListener('click', () => requestState('chooseDirectory', 'jiancang'));
byId('open-local-library').addEventListener('click', () => requestState('chooseDirectory', 'local'));
byId('connect-create-local').addEventListener('click', intake.create);
byId('connect-restore-backup').addEventListener('click', () => backupTools.open());
byId('create-local-library').addEventListener('click', intake.create);
byId('local-backup-button').addEventListener('click', () => {
  librariesDialog.close();
  backupTools.open(scopeId);
});
byId('storage-management-button').addEventListener('click', () => {
  librariesDialog.close();
  storageTools.open();
});
byId('local-import-button').addEventListener('click', () => void intake.open());
byId('cloud-originals-button').addEventListener('click', () => {
  librariesDialog.close();
  cloudTools.open(scopeId);
});
byId('project-boards-button').addEventListener('click', () => boards.open());
byId('tag-manager-button').addEventListener('click', () => tags.open());
byId('duplicate-review-button').addEventListener('click', () => duplicates.open());
byId('folder-inbox-button').addEventListener('click', () => inboxTools.open());
byId('save-smart-collection').addEventListener('click', smart.create);
byId('suggestions-settings-button').addEventListener('click', () => suggestionTools.settings());
byId('sync-status-button').addEventListener('click', () => openSyncPanel(scopeId));
byId('sync-write-close').addEventListener('click', () => byId('sync-write-dialog').close());
byId('sync-write-toggle').addEventListener('click', () => void applySyncAction('toggle'));
byId('sync-write-retry').addEventListener('click', () => void applySyncAction('retry'));
byId('sync-write-reveal-folder').addEventListener('click', () => void revealSyncLocation('revealLibrary'));
byId('sync-write-reveal-latest').addEventListener('click', () => void revealSyncLocation('revealLatestSyncRecord'));
byId('sync-write-originals').addEventListener('click', () => {
  const id = syncPanelId;
  byId('sync-write-dialog').close();
  if (id) cloudTools.open(id);
});
byId('sync-write-conflicts').addEventListener('click', () => {
  const entry = state.libraries.find(item => item.id === syncPanelId && item.kind === 'jiancang' && item.format);
  if (entry) void syncConflicts.open({ id: entry.id, name: libraryName(entry), writable: entry.syncWritable });
});
byId('local-undo-button').addEventListener('click', () => runLocalHistory('undo'));
byId('local-redo-button').addEventListener('click', () => runLocalHistory('redo'));
byId('new-local-collection').addEventListener('click', () => {
  const target = localTarget();
  if (target) organizer.collection(target.id, localCollections(target.id), { parentId: target.collection });
});
byId('collection-menu').addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.stopPropagation();
    return;
  }
  const sideways = ['ArrowLeft', 'ArrowRight'].includes(event.key);
  if (sideways && !document.activeElement?.matches('.collection-color-swatch')) return;
  if (!sideways && !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const selector = sideways ? '.collection-color-swatch' : 'button';
  const choices = [...event.currentTarget.querySelectorAll(`${selector}:not(:disabled)`)].filter(button => !button.closest('[hidden]'));
  const index = choices.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
    : (index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1) + choices.length) % choices.length;
  choices[next]?.focus();
});
byId('add-eagle-library').addEventListener('click', () => requestState('chooseDirectory', 'eagle'));
byId('toggle-inspector').addEventListener('click', toggleInspector);
byId('viewer-inspector').addEventListener('click', toggleInspector);
byId('theme-button').addEventListener('click', toggleTheme);
byId('browse-back').addEventListener('click', () => goFromNavigationHistory('back'));
byId('browse-forward').addEventListener('click', () => goFromNavigationHistory('forward'));
byId('find-collection').addEventListener('click', () => collectionFinder.open());
byId('clear-selection-stash').addEventListener('click', () => {
  if (section !== 'stash') return;
  updateSelectionStash([], 'clear');
  byId('gallery-title').focus({ preventScroll: true });
});
byId('empty-local-trash').addEventListener('click', () => {
  const catalog = visibleLocalTrash();
  if (!catalog) return;
  confirmTrashPurge(catalog.libraryId, trashTargets(catalog.libraryId), { all: true });
});
byId('retry-local-trash').addEventListener('click', () => {
  const catalog = visibleLocalTrash();
  if (catalog?.library.pendingPurge) void organizer.retryPurge(catalog.libraryId, catalog.revision);
});
byId('viewer-local-trash').addEventListener('click', () => {
  const asset = currentViewerAsset();
  if (writableAsset(asset) && !asset.trashed) organizer.trash(asset.sourceLibraryId, [asset]);
});
byId('viewer-quick-favorite').addEventListener('click', () => {
  const asset = currentViewerAsset();
  toggleFavoriteAsset(asset);
});
byId('viewer-image-tools').addEventListener('click', () => {
  const asset = currentViewerAsset();
  if (canEditImage(asset)) void imageTools.open(asset);
});
byId('viewer-video-trim').addEventListener('click', () => openVideoTrim(currentViewerAsset()));
byId('close-export-results').addEventListener('click', () => exportDialog.close());
byId('close-compare').addEventListener('click', () => compareDialog.close());
compareDialog.addEventListener('close', () => {
  if (compareDialog.open) return;
  comparison?.dispose();
  comparison = null;
  byId('compare-content').replaceChildren();
});
byId('viewer-theme').addEventListener('click', toggleTheme);
byId('viewer-export').addEventListener('click', event => {
  const asset = currentViewerAsset();
  if (asset) perform('exportAsset', asset, '已导出原件。', event.currentTarget);
});
byId('viewer-reveal').addEventListener('click', event => {
  const asset = currentViewerAsset();
  if (asset) perform('revealAsset', asset, '', event.currentTarget);
});
byId('viewer-close').addEventListener('click', () => closeViewer());
viewerViewport.addEventListener('contextmenu', event => {
  const asset = currentViewerAsset();
  if (!asset || event.defaultPrevented || event.target.closest('input, textarea, button, select')) return;
  event.preventDefault();
  void showAssetMenu(asset, null, viewerMedia, event);
});
byId('viewer-previous').addEventListener('click', () => moveViewer(-1));
byId('viewer-next').addEventListener('click', () => moveViewer(1));
byId('viewer-fit').addEventListener('click', () => setViewerMode('fit'));
byId('viewer-actual').addEventListener('click', () => setViewerMode('actual'));
byId('viewer-focus').addEventListener('click', toggleViewerFocus);
byId('viewer-zoom').addEventListener('input', event => {
  const geometry = viewer?.geometry;
  if (!geometry) return;
  const { minimum, maximum } = geometry;
  setViewerScale(minimum * Math.pow(maximum / minimum, event.currentTarget.valueAsNumber / 100));
});
preferredSize.value = preferences.tileSize;
preferredSize.addEventListener('input', () => {
  preferences.tileSize = preferredSize.valueAsNumber;
  continuous.relayout({ tileSize: preferences.tileSize, animate: true });
});
preferredSize.addEventListener('change', savePreferences);
layoutSelect.value = preferences.layout;
layoutSelect.addEventListener('change', () => {
  preferences.layout = layoutSelect.value;
  savePreferences();
  continuous.relayout({ layout: preferences.layout, animate: true });
});
listHeader.addEventListener('click', event => {
  const column = event.target.closest('button[data-list-sort]');
  if (!column || !browseCatalog || visual.comparison) return;
  const field = listSortKey(column.dataset.listSort);
  const alreadySorted = sortSelect.value === field || column.dataset.listSort === 'date' && sortSelect.value === 'date';
  reverseSort = alreadySorted ? !reverseSort : false;
  sortSelect.value = field;
  renderGallery({ animate: false });
});
const captionsButton = byId('toggle-captions');
captionsButton.setAttribute('aria-pressed', String(preferences.captions));
captionsButton.addEventListener('click', () => {
  preferences.captions = !preferences.captions;
  captionsButton.setAttribute('aria-pressed', String(preferences.captions));
  savePreferences();
  continuous.relayout({ captions: preferences.captions, animate: true });
});
sortSelect.addEventListener('change', () => {
  reverseSort = false;
  resetGallery();
});
byId('close-warnings-button').addEventListener('click', () => warningsDialog.close());
byId('warnings-button').addEventListener('click', () => readingDiagnostics.open());

applyTheme();
byId('advanced-filter-slot').append(assetFilters.element);
visual.element.prepend(glyph('search'));
byId('visual-filter-slot').append(visual.element);
byId('visual-filter-slot').append(naturalSearch);
document.querySelector('.gallery-options').append(visual.chips);
smart.render();
bridge.onDragUnavailable?.(token => {
  for (const [id, ready] of preparedDragCopies) if (ready.token === token) preparedDragCopies.delete(id);
  showToast('拖出副本已变化，请重新准备。');
});
bridge.onDragConcluded?.(token => {
  if (nativeDragToken === token) nativeDragToken = undefined;
});
for (const name of ['dragenter', 'dragover', 'drop']) {
  document.addEventListener(name, event => {
    if (!nativeDragToken || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.dataTransfer.dropEffect = 'none';
  }, true);
}
bridge.onStateChange?.(next => {
  // A startup notification can arrive before the registered libraries have finished loading.
  if (!startupPage.hidden && (!next?.libraries?.length || (!next.library && !next.catalogs?.length))) return;
  if (crossLibraryWrite || keyboardRatingPending) deferredLibraryState = next;
  else setState(next);
});
retryStartup.addEventListener('click', () => void requestState('getState'));
requestState('getState');
