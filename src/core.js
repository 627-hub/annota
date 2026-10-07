/* video-annotate · core (P0)
 * 叠层 + 拖框 + 绑词 + 本地存储 + 导入导出。平台无关，依赖 VAGeo / VAAdapter / VAMedia。
 * 媒态差异（视频/图片/文章）由 VAMedia binding 承担，core 只面向 binding 接口。
 */
(function () {
  'use strict';
  if (window.__VA_LOADED__) return;
  window.__VA_LOADED__ = true;

  const G = window.VAGeo, A = window.VAAdapter, VAMedia = window.VAMedia;
  const ADAPTER_ERRORS = [];
  if (A) A._err = (e) => { ADAPTER_ERRORS.push(String((e && e.message) || e).slice(0, 80)); if (ADAPTER_ERRORS.length > 20) ADAPTER_ERRORS.shift(); };
  const DEFAULT_DUR = 1.0;                // 每个标注框默认时长(秒)
  const ICON_PATHS = {
    brand: '<path d="M4.5 19 12 5l7.5 14M8.2 13.2h7.6"/>',
    crosshair: '<circle cx="12" cy="12" r="7.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
    pick: '<path d="M5 3l14 8-6 1.5L11 19 5 3Z"/>',
    eye: '<path d="M2.5 12s3.2-6 9.5-6 9.5 6 9.5 6-3.2 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.6"/>',
    'eye-off': '<path d="M4 4l16 16"/><path d="M9.6 6.3A9.7 9.7 0 0 1 12 6c6.3 0 9.5 6 9.5 6a15 15 0 0 1-2.9 3.4M6.4 7.2A15 15 0 0 0 2.5 12s3.2 6 9.5 6a9.7 9.7 0 0 0 3-.5"/><path d="M9.9 10.1a2.6 2.6 0 0 0 3.7 3.7"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    sync: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.7-2L20 12M4 12l2.7 5a7 7 0 0 0 11.7-2"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m4 13 8 4.5 8-4.5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.2 4.2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.3 2"/>',
    dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
    box: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h5"/>',
    book: '<path d="M5 4.5h11a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3v-12Z"/><path d="M5 16.5a3 3 0 0 1 3-3h11"/>'
  };

  // 词库已下线（决策 A3，product-spec §16）：词必填、释义/词性手填，查词走外链词典。

  const APP_SETTINGS_KEY = 'annota:settings';
  const DEFAULT_APP_SETTINGS = {
    sync: { address: '', auto: false },
    shortcuts: { annotate: 'alt+d', panel: 'alt+l', overlay: 'alt+s' },
    dictUrlTemplate: '',
    ai: { baseUrl: '', model: '' },
    profile: { name: '匿名标注者' },
  };
  function mergeAppSettings(value) {
    value = value && typeof value === 'object' ? value : {};
    const sync = value.sync && typeof value.sync === 'object' ? value.sync : {};
    const shortcuts = value.shortcuts && typeof value.shortcuts === 'object' ? value.shortcuts : {};
    return {
      sync: {
        address: typeof sync.address === 'string' ? sync.address : DEFAULT_APP_SETTINGS.sync.address,
        auto: typeof sync.auto === 'boolean' ? sync.auto : DEFAULT_APP_SETTINGS.sync.auto,
      },
      shortcuts: {
        annotate: typeof shortcuts.annotate === 'string' ? shortcuts.annotate : DEFAULT_APP_SETTINGS.shortcuts.annotate,
        panel: typeof shortcuts.panel === 'string' ? shortcuts.panel : DEFAULT_APP_SETTINGS.shortcuts.panel,
        overlay: typeof shortcuts.overlay === 'string' ? shortcuts.overlay : DEFAULT_APP_SETTINGS.shortcuts.overlay,
      },
      dictUrlTemplate: typeof value.dictUrlTemplate === 'string' ? value.dictUrlTemplate : '',
      ai: {
        baseUrl: value.ai && typeof value.ai.baseUrl === 'string' ? value.ai.baseUrl : '',
        model: value.ai && typeof value.ai.model === 'string' ? value.ai.model : '',
      },
      profile: {
        name: value.profile && typeof value.profile.name === 'string' && value.profile.name.trim()
          ? value.profile.name.trim().slice(0, 40) : DEFAULT_APP_SETTINGS.profile.name,
      },
    };
  }
  let appSettings = (function () {
    try { return mergeAppSettings(JSON.parse(localStorage.getItem(APP_SETTINGS_KEY) || '{}')); }
    catch (e) { return mergeAppSettings(null); }
  })();

  // 观看端：只读（隐藏标注/编辑），可自动同步。构建时烧入或 ⚙ 里切换。
  const VIEW_ONLY = !!window.VA_VIEW_ONLY ||
    (function () { try { return localStorage.getItem('va:viewOnly') === '1'; } catch (e) { return false; } })();
  let AUTO_SYNC = !!window.VA_AUTO_SYNC || VIEW_ONLY || appSettings.sync.auto;
  let shortcuts = appSettings.shortcuts;
  function isView() { try { return window.VA_VIEW_ONLY || localStorage.getItem('va:viewOnly') === '1'; } catch (e) { return !!window.VA_VIEW_ONLY; } }
  function shortcutMatches(ev, spec) {
    const parts = String(spec || '').toLowerCase().split('+').map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) return false;
    const key = parts.pop();
    const mods = new Set(parts);
    return String(ev.key || '').toLowerCase() === key &&
      !!ev.altKey === mods.has('alt') && !!ev.ctrlKey === mods.has('ctrl') &&
      !!ev.metaKey === mods.has('meta') && !!ev.shiftKey === mods.has('shift');
  }

  const LS_PREFIX = 'va:entries:';
  const HIDDEN_PREFIX = 'va:hidden:';             // 本地显示状态：被隐藏（不可见）的热力框 id 列表（不进 entry、不同步、不导出）
  const SYNC_META_PREFIX = 'va:syncmeta:';       // 「已与服务端对齐到的版本」指纹 → 判定本地是否有未同步离线改动
  const OVERRIDE_PREFIX = 'va:coverpref:';        // 「服务器更新时是否覆盖本地」的记忆（用户勾选不再询问）
  const FORMAT = 'video-annotate/0.1';   // 服务端回显为准；此处是本地/新建默认

  const state = {
    binding: null, mediaId: null, platform: null,
    entries: [], showAll: false, annotate: false, picking: false,
    rect: null, cr: null, draft: null, dragging: false,
    renderLock: false, exportOnly: null,
    displayVersion: null,   // 'local' | 'server' 本次显示用的是哪版（决定同步推什么）
    hidden: new Set(),      // 本地隐藏的热力框 id（仅显示状态）
    lastActiveId: null,     // 「仅当前」用：最近定位/点击的条目
  };
  window.__VA = { get state() { return state; } };   // 调试：控制台可 __VA.state 查看

  /* ---------- 存储：本地 = 缓存/离线草稿；服务器 = 云存储（分享/公开） ---------- */
  function loadCached(mediaId) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + mediaId);
      const obj = raw ? JSON.parse(raw) : null;
      return validEntries((obj && obj.entries) || []);
    } catch (e) { return []; }
  }
  // 与顺序无关的稳定指纹：id + updated + 内容（老数据无 updated 时也能区分改动）
  function fingerprint(entries) {
    return entries.map((e) => [e.id, e.updated || e.created || '', e.word || '', e.label || '',
      (e.tags || []).join(','), e.t != null ? e.t : ''].join('@')).sort().join('|');
  }
  function syncMeta(mediaId) {
    try { return JSON.parse(localStorage.getItem(SYNC_META_PREFIX + mediaId) || 'null') || null; } catch (e) { return null; }
  }
  function setSyncMeta(mediaId, serverEntries) {
    try { localStorage.setItem(SYNC_META_PREFIX + mediaId, JSON.stringify({ fp: fingerprint(serverEntries), at: Date.now() })); } catch (e) {}
  }
  // 本地是否存在「未与服务器对齐」的离线改动
  function hasLocalDraft(mediaId, cached) {
    if (!cached.length) return false;
    const meta = syncMeta(mediaId);
    if (!meta) return true;                        // 从未同步过却有本地数据 → 视作离线改动
    return meta.fp !== fingerprint(cached);
  }

  // 可见性 = 本地显示状态（按媒体存 localStorage，不进 entry、不同步）
  function loadHidden(mediaId) {
    try {
      const arr = JSON.parse(localStorage.getItem(HIDDEN_PREFIX + mediaId) || '[]');
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch (e) { return new Set(); }
  }
  function saveHidden(mediaId, set) {
    try { localStorage.setItem(HIDDEN_PREFIX + mediaId, JSON.stringify(Array.from(set))); } catch (e) {}
  }
  function isHidden(e) { return !!(e && state.hidden && state.hidden.has(String(e.id))); }

  /* ---------- 组来源条目（分层展示，不进 state.entries） ---------- */
  const GROUP_CACHE_PREFIX = 'va:group:';    // va:group:<gid>:<mediaId> → 组内该媒体的 pack
  function groupEntries() {
    const out = [];
    const hid = hiddenSources();
    for (const g of (window.VAGroup ? window.VAGroup.listGroups() : [])) {
      if (hid[g.gid]) continue;                  // 该来源被取消勾选 → 不渲染
      let pack = null;
      try { pack = JSON.parse(localStorage.getItem(GROUP_CACHE_PREFIX + g.gid + ':' + state.mediaId) || 'null'); } catch (e) {}
      if (!pack || !Array.isArray(pack.entries)) continue;
      for (const e of pack.entries) {
        out.push(Object.assign({}, e, { __group: true, __gid: g.gid, __author: (e.creator && e.creator.name) || g.name || '成员' }));
      }
    }
    return out;
  }

  function toggleHidden(e) {
    const id = String(e.id);
    if (state.hidden.has(id)) state.hidden.delete(id); else state.hidden.add(id);
    saveHidden(state.mediaId, state.hidden);
    render(); renderPanel();
  }
  function showAllVisible() {
    state.hidden = new Set();
    saveHidden(state.mediaId, state.hidden);
    render(); renderPanel();
  }
  function onlyCurrentVisible() {
    // 当前条目：最近定位的；否则取离播放点最近的
    let cur = state.entries.find((e) => String(e.id) === String(state.lastActiveId));
    if (!cur && state.binding && state.binding.timed) {
      const t = state.binding.time();
      cur = state.entries.slice().sort((a, b) => Math.abs((Number(a.t) || 0) - t) - Math.abs((Number(b.t) || 0) - t))[0];
    }
    if (!cur) return;
    state.lastActiveId = String(cur.id);
    state.hidden = new Set(state.entries.filter((e) => e !== cur).map((e) => String(e.id)));
    saveHidden(state.mediaId, state.hidden);
    if (state.binding) state.binding.locate(cur);
    render(); renderPanel();
  }

  // 只读加载本地缓存（不联网、不询问）：打开页面先显示已有内容
  function load() {
    state.entries = loadCached(state.mediaId);
    state.hidden = loadHidden(state.mediaId);
    state.displayVersion = 'local';
  }
  function save() {
    const media = mediaMeta();
    const obj = { format: FORMAT, media, entries: state.entries };
    try { localStorage.setItem(LS_PREFIX + state.mediaId, JSON.stringify(obj)); }
    catch (e) { setSyncStatus('本地保存失败（隐私模式/空间不足？）'); }
    updateStatus();
    renderPanel();
    scheduleGroupPush();   // 组同步：去抖后把本地实线条目推到已加入的组
  }

  /* ---------- Shadow DOM UI ---------- */
  const uiHost = document.createElement('div');
  uiHost.id = 'annota-shadow-host';
  uiHost.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
  const uiShadow = typeof uiHost.attachShadow === 'function' ? uiHost.attachShadow({ mode: 'open' }) : uiHost;
  const uiStyle = document.createElement('style');
  uiStyle.textContent = window.VA_OVERLAY_CSS || window.VA_TOKENS_CSS || '';
  const uiRoot = document.createElement('div');
  uiRoot.className = 'va-ui-root';
  uiShadow.append(uiStyle, uiRoot);
  (document.body || document.documentElement).appendChild(uiHost);

  /* ---------- DOM ---------- */
  const overlay = el('div', {
    position: 'fixed', left: '0', top: '0', width: '0', height: '0',
    pointerEvents: 'none', zIndex: '1', display: 'none',
  });
  const capture = el('div', {
    position: 'absolute', left: '0', top: '0', right: '0', bottom: '0',
    pointerEvents: 'none', cursor: 'crosshair',
  });
  capture.className = 'va-capture';
  const layer = el('div', {
    position: 'absolute', left: '0', top: '0', right: '0', bottom: '0', pointerEvents: 'none',
  });
  overlay.appendChild(capture); overlay.appendChild(layer);

  const bar = el('div');
  bar.className = 'va-dock';
  const brand = el('div'); brand.className = 'va-brand';
  const brandMark = el('span'); brandMark.className = 'va-brand-mark'; brandMark.appendChild(svgIcon('brand'));
  const brandCopy = el('span', null, 'Annota'); brandCopy.className = 'va-brand-copy';
  brandCopy.appendChild(el('small', null, 'CONTENT LAYER'));
  brand.append(brandMark, brandCopy);
  const separator = el('span'); separator.className = 'va-separator';
  const btnAnno = mkAction('标注', 'crosshair', () => toggleAnnotate(), 'primary');
  const btnAll = mkAction('显示', 'eye', () => {
    state.showAll = !state.showAll;
    btnAll.classList.toggle('is-active', state.showAll);
    render();
  });
  const btnPanel = mkAction('列表', 'list', () => togglePanel());
  const btnPick = mkAction('选对象', 'pick', () => togglePicker());
  const btnSync = mkAction('同步', 'sync', syncNow);
  const btnSources = mkAction('来源', 'layers', () => toggleSources());
  const btnCfg = mkAction('更多', 'more', toggleMenu);
  const btnBridge = mkbtn('发给 AI 助手', copyContext);
  const btnDiag = mkbtn('诊断信息', toggleDiag);
  const status = el('span'); status.className = 'va-sync-indicator'; status.dataset.state = 'ready';
  const statusDot = el('i'); statusDot.className = 'va-sync-dot';
  const statusText = el('span', null, '就绪');
  status.append(statusDot, statusText);
  bar.append(brand, separator, btnAnno, btnAll, btnPanel, btnPick, btnSync, status, btnSources, btnCfg);

  const sidePanel = el('aside'); sidePanel.className = 'va-panel';
  const panelHead = el('div'); panelHead.className = 'va-panel-head';
  const panelTitle = el('div'); panelTitle.className = 'va-panel-title';
  const panelTitleMain = el('strong', null, '当前标注');
  const panelTitleSub = el('span', null, '等待视频…');
  panelTitle.append(panelTitleMain, panelTitleSub);
  const panelClose = mkIconButton('关闭标注面板', 'close', () => togglePanel(false));
  panelClose.classList.add('va-close');
  panelHead.append(panelTitle, panelClose);
  const panelTabs = el('div'); panelTabs.className = 'va-panel-tabs';
  const tabTimeline = mkTab('时间轴', true);
  const tabWords = mkTab('词汇', false);
  const tabSources = mkTab('来源', false);
  const tabAssistant = mkTab('助手', false);
  panelTabs.setAttribute('role', 'tablist');
  panelTabs.setAttribute('aria-label', '侧栏视图');
  const panelTabItems = [[tabTimeline, 'timeline'], [tabWords, 'words'], [tabSources, 'sources'], [tabAssistant, 'assistant']];
  panelTabItems.forEach(([tab, name]) => {
    tab.id = 'va-tab-' + name;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', name === 'assistant' ? 'va-assistant-panel' : 'va-entry-panel');
    tab.setAttribute('aria-selected', String(name === 'timeline'));
    tab.tabIndex = name === 'timeline' ? 0 : -1;
  });
  panelTabs.append(tabTimeline, tabWords, tabSources, tabAssistant);
  const panelSearchWrap = el('div'); panelSearchWrap.className = 'va-panel-search';
  const panelSearch = el('input'); panelSearch.className = 'va-input';
  panelSearch.type = 'search'; panelSearch.placeholder = '筛选标注…'; panelSearch.setAttribute('aria-label', '筛选标注');
  panelSearchWrap.appendChild(panelSearch);
  // 可见性快捷：全部显示 / 仅当前
  const visBar = el('div'); visBar.className = 'va-vis-bar';
  const btnVisAll = mkbtn('全部', () => showAllVisible()); btnVisAll.classList.add('va-chip'); btnVisAll.setAttribute('aria-label', '显示全部热力框');
  const btnVisOnly = mkbtn('仅当前', () => onlyCurrentVisible()); btnVisOnly.classList.add('va-chip'); btnVisOnly.setAttribute('aria-label', '只显示当前热力框');
  visBar.append(btnVisAll, btnVisOnly);
  const entryList = el('div'); entryList.className = 'va-entry-list';
  entryList.id = 'va-entry-panel';
  entryList.setAttribute('role', 'tabpanel');
  entryList.setAttribute('aria-labelledby', 'va-tab-timeline');
  const panelFoot = el('div'); panelFoot.className = 'va-panel-foot'; panelFoot.textContent = '点击词条跳转到对应画面';
  const assistantPane = el('section'); assistantPane.className = 'va-assistant';
  assistantPane.id = 'va-assistant-panel';
  assistantPane.setAttribute('role', 'tabpanel');
  assistantPane.setAttribute('aria-labelledby', 'va-tab-assistant');
  assistantPane.setAttribute('aria-label', 'Annota 助手');
  const assistantNotice = el('div'); assistantNotice.className = 'va-assistant-notice';
  assistantNotice.setAttribute('role', 'status'); assistantNotice.setAttribute('aria-live', 'polite');
  const assistantTranscript = el('div'); assistantTranscript.className = 'va-chat-transcript';
  assistantTranscript.setAttribute('role', 'log'); assistantTranscript.setAttribute('aria-label', '对话记录');
  const assistantForm = el('form'); assistantForm.className = 'va-chat-form';
  const assistantInput = el('textarea'); assistantInput.className = 'va-chat-input';
  assistantInput.rows = 2; assistantInput.maxLength = 4000;
  assistantInput.placeholder = '问问当前画面或标注…';
  assistantInput.setAttribute('aria-label', '发送给助手');
  const assistantSend = el('button', null, '发送'); assistantSend.type = 'submit';
  assistantSend.className = 'va-btn va-btn-primary';
  assistantForm.append(assistantInput, assistantSend);
  assistantPane.append(assistantNotice, assistantTranscript, assistantForm);
  sidePanel.append(panelHead, panelTabs, panelSearchWrap, visBar, entryList, panelFoot, assistantPane);
  let panelOpen = false, panelTab = 'timeline';

  tabTimeline.onclick = () => { panelTab = 'timeline'; updatePanelTabs(); renderPanel(); };
  tabWords.onclick = () => { panelTab = 'words'; updatePanelTabs(); renderPanel(); };
  tabSources.onclick = () => { panelTab = 'sources'; updatePanelTabs(); renderPanel(); };
  tabAssistant.onclick = () => { panelTab = 'assistant'; updatePanelTabs(); renderPanel(); assistantInput.focus({ preventScroll: true }); };
  panelTabs.addEventListener('keydown', (event) => {
    const currentIndex = panelTabItems.findIndex(([tab]) => tab === event.target);
    if (currentIndex < 0) return;
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % panelTabItems.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex + panelTabItems.length - 1) % panelTabItems.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = panelTabItems.length - 1;
    else return;
    event.preventDefault();
    const nextTab = panelTabItems[nextIndex][0];
    nextTab.focus();
    nextTab.click();
  });
  panelSearch.addEventListener('input', renderPanel);
  panelSearch.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') panelSearch.value = ''; renderPanel(); });

  function applyMode() {
    const v = isView();
    btnAnno.style.display = v ? 'none' : '';
    // 观看态 = 纯看：隐藏编辑/发布/进阶入口，只留 显示 / 列表 / 来源（+ 品牌小标）。
    btnPick.style.display = v ? 'none' : '';
    btnSync.style.display = v ? 'none' : '';
    btnCfg.style.display = v ? 'none' : '';
    status.style.display = v ? 'none' : '';
    separator.style.display = v ? 'none' : '';
    btnSources.style.display = v ? '' : 'none';
    bar.classList.toggle('va-dock--viewer', v);
    // Only tear down an active annotation session. Calling this during initial
    // viewer setup (before toast DOM initialization) would hit a TDZ via showToast.
    if (v && state.annotate) toggleAnnotate(false);
    updateListBadge();
    // 浏览器壳接缝（M2）：通知壳层模式变化（壳可据此在观看/编辑态间切换）。
    try {
      const shell = window.VA_BROWSER_SHELL;
      if (shell && typeof shell.onModeChange === 'function') shell.onModeChange(v ? 'view' : 'edit');
    } catch (e) {}
  }
  applyMode();

  /* ---------- 观看态：来源列表（同一视频多个标注来源，可勾选） ---------- */
  // 来源 = 本地个人标注 + 每个「当前媒体所属组」的共享标注。勾选决定哪些来源参与渲染。
  const HIDDEN_SRC_KEY = 'va:hiddenSources';   // { [sourceId]: true } 被取消勾选的来源
  function hiddenSources() {
    try { const o = JSON.parse(localStorage.getItem(HIDDEN_SRC_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
  }
  function setSourceVisible(id, visible) {
    const o = hiddenSources();
    if (visible) delete o[id]; else o[id] = true;
    try { localStorage.setItem(HIDDEN_SRC_KEY, JSON.stringify(o)); } catch (e) {}
    render();
  }
  // 当前媒体关联的来源清单：[{id:'local',name,count}, {id:'grp_xxx',name,count,meta}]
  function sourceList() {
    const list = [];
    const mine = state.entries.length;
    list.push({ id: 'local', kind: 'local', name: '我的本地标注', count: mine, meta: '本机 · ' + mine + ' 条' });
    let groups = [];
    try { groups = (window.VAGroup && window.VAGroup.groupsForMedia) ? window.VAGroup.groupsForMedia(state.mediaId) : []; } catch (e) {}
    for (const g of groups) {
      let n = 0;
      try { const pack = JSON.parse(localStorage.getItem(GROUP_CACHE_PREFIX + g.gid + ':' + state.mediaId) || 'null'); n = (pack && pack.entries && pack.entries.length) || 0; } catch (e) {}
      list.push({ id: g.gid, kind: 'group', name: g.name || g.gid || '组', count: n, meta: (g.host === 'hub' ? '云开发' : (g.host || 'git')) + ' · ' + n + ' 条' });
    }
    return list;
  }
  function visibleEntryCount() {
    const hid = hiddenSources();
    let n = 0;
    if (!hid.local) n += state.entries.length;
    for (const s of sourceList()) { if (s.kind === 'group' && !hid[s.id]) n += s.count; }
    return n;
  }
  function updateListBadge() {
    const n = visibleEntryCount();
    btnPanel.dataset.count = String(n);
    const existing = btnPanel.querySelector('.va-count-badge');
    if (n > 0) {
      const b = existing || el('span', null, String(n));
      b.className = 'va-count-badge'; b.textContent = String(n);
      if (!existing) btnPanel.appendChild(b);
    } else if (existing) { existing.remove(); }
  }
  const sourcesPanel = el('div'); sourcesPanel.className = 'va-sources';
  sourcesPanel.style.display = 'none';
  sourcesPanel.setAttribute('aria-label', '标注来源列表');
  // 收起态下 dock 只露圆钮、.va-action 隐藏，误点「来源」会看不到弹层；
  // 悬停 dock 直到展开菜单后再点。用户一旦打开过菜单就置 `1`，不再自动展开。
  async function revealDock() {
    if (!bar.classList.contains('va-dock--viewer')) return;
    if (bar.dataset.open === '1' || bar.querySelector('.va-dock-fab')) return;   // 已展开 / 无收起态
    if (bar.dataset.openAutoDone === '1') return;
    bar.dataset.openAutoDone = '1';
    bar.dataset.open = '1';
    await new Promise((r) => setTimeout(r, 260));
    document.dispatchEvent(new Event('pointermove'));   // 唤醒宿主页 hover 态（Firefox 等）
  }
  async function toggleSources(force) {
    const open = force == null ? sourcesPanel.style.display === 'none' : !!force;
    if (!open) { sourcesPanel.style.display = 'none'; btnSources.classList.remove('is-active'); sourcesPanel.remove(); return; }
    await revealDock();
    btnSources.classList.add('is-active');
    renderSources();
    if (!sourcesPanel.isConnected) uiRoot.appendChild(sourcesPanel);
    sourcesPanel.style.display = '';
  }
  function renderSources() {
    sourcesPanel.textContent = '';
    const list = sourceList();
    const head = el('div', null, '标注来源（本视频 ' + list.length + ' 个）'); head.className = 'va-sources-head';
    sourcesPanel.appendChild(head);
    const hid = hiddenSources();
    list.forEach((s) => {
      const on = !hid[s.id];
      const row = el('button'); row.type = 'button'; row.className = 'va-src-item' + (on ? ' is-on' : '');
      const chk = el('span', null, on ? '✓' : ''); chk.className = 'va-src-check';
      const t = el('span'); t.className = 'va-src-text';
      t.appendChild(el('b', null, s.name)); t.appendChild(el('small', null, s.meta));
      row.append(chk, t);
      row.addEventListener('click', () => {
        const nowHidden = !hiddenSources()[s.id];
        setSourceVisible(s.id, nowHidden ? false : true);
        renderSources(); updateListBadge();
      });
      sourcesPanel.appendChild(row);
    });
  }
  document.addEventListener('click', (ev) => {
    if (sourcesPanel.style.display === 'none') return;
    const path = ev.composedPath ? ev.composedPath() : [];
    if (path.includes(sourcesPanel) || path.includes(btnSources)) return;
    toggleSources(false);
  });

  // 诊断面板（B站等实机上排查用）
  const diagPanel = el('pre', { display: 'none' });
  diagPanel.className = 'va-diag';
  // 无法叠加时的提示条
  const toast = el('div', null, '当前为「视频元素真全屏」，浏览器限制无法叠加标注。请用播放器的「网页全屏 / 影院模式」再标注。');
  toast.className = 'va-toast';
  let toastTimer = null;
  function showToast(message, error) {
    toast.textContent = message;
    toast.classList.toggle('is-error', !!error);
    toast.classList.add('is-visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
  }

  function svgIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.innerHTML = ICON_PATHS[name] || ICON_PATHS.box;
    return svg;
  }
  function mkAction(label, iconName, fn, variant) {
    const b = el('button');
    b.type = 'button';
    b.className = 'va-action' + (variant === 'primary' ? ' va-action-primary' : '');
    b.setAttribute('aria-label', label);
    b.title = label;
    b.appendChild(svgIcon(iconName));
    const text = el('span', null, label); text.className = 'va-action-label';
    b.appendChild(text);
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  }
  function mkIconButton(label, iconName, fn) {
    const b = el('button'); b.type = 'button'; b.setAttribute('aria-label', label); b.title = label;
    b.appendChild(svgIcon(iconName));
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  }
  function mkTab(label, active) {
    const b = el('button', null, label); b.type = 'button';
    b.className = 'va-tab' + (active ? ' is-active' : '');
    return b;
  }
  let diagTimer = null;
  function toggleDiag() {
    const on = diagPanel.style.display === 'none';
    // 点菜单项后应关闭菜单（与其他菜单项一致）；否则菜单会与诊断面板同屏，
    // 既挡住内容、也让「更多」按钮变成只能关不能开。
    if (on && menuPanel.style.display !== 'none') toggleMenu();
    diagPanel.style.display = on ? 'block' : 'none';
    btnDiag.classList.toggle('va-btn-primary', on);
    if (on) { uiRoot.appendChild(diagPanel); diagTimer = setInterval(renderDiag, 800); renderDiag(); }
    else { if (diagTimer) clearInterval(diagTimer); diagTimer = null; diagPanel.remove(); }
  }
  function renderDiag() {
    const d = A.diag ? A.diag() : {};
    const v = state.binding && state.binding.el, r = state.rect, cr = state.cr, m = state.meta || {};
    const lines = [
      'platform : ' + d.platform + '   supported=' + d.supported,
      'kind     : ' + (state.binding ? state.binding.kind : '-') + '   timed=' + (state.binding ? state.binding.timed : '-'),
      'mediaId  : ' + d.mediaId,
      'href     : ' + d.href,
      'fullscreen: ' + (d.fullscreen || '-') + (m.unsupported ? '  ⚠ 视频自身全屏' : ''),
      'media    : ' + (v ? ((v.videoWidth || v.naturalWidth || 0) + 'x' + (v.videoHeight || v.naturalHeight || 0) + ' ready=' + (v.readyState == null ? 'n/a' : v.readyState)) : 'null'),
      'videos   : ' + (A.countVideos ? A.countVideos() : '?') + '（含 shadow DOM）',
      'objectFit: ' + (m.fit || '-'),
      'rect     : ' + (r ? [r.x, r.y, r.width, r.height].map(n1).join(', ') : '-'),
      'content  : ' + (cr ? [cr.x, cr.y, cr.w, cr.h].map(n1).join(', ') : '-'),
      'overlay  : host=' + (overlay.parentElement ? overlay.parentElement.tagName : '-') + ' children=' + overlay.childElementCount,
      'entries  : ' + state.entries.length + '   annotate=' + state.annotate + '  showAll=' + state.showAll,
      'errors   : ' + (ADAPTER_ERRORS.length ? ADAPTER_ERRORS.slice(-3).join(' | ') : '-'),
    ];
    diagPanel.textContent = lines.join('\n');
  }
  function n1(x) { return Math.round(x * 10) / 10; }
  function r2(x) { return Math.round((parseFloat(x) || 0) * 100) / 100; }
  function formatTime(value) {
    const s = Math.max(0, Math.floor(Number(value) || 0));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function updatePanelTabs() {
    tabTimeline.classList.toggle('is-active', panelTab === 'timeline');
    tabWords.classList.toggle('is-active', panelTab === 'words');
    tabSources.classList.toggle('is-active', panelTab === 'sources');
    tabAssistant.classList.toggle('is-active', panelTab === 'assistant');
    for (const [tab, name] of [[tabTimeline, 'timeline'], [tabWords, 'words'], [tabSources, 'sources'], [tabAssistant, 'assistant']]) {
      tab.setAttribute('aria-selected', String(panelTab === name));
      tab.tabIndex = panelTab === name ? 0 : -1;
    }
    const isAssistant = panelTab === 'assistant';
    if (!isAssistant) entryList.setAttribute('aria-labelledby', 'va-tab-' + panelTab);
    panelSearchWrap.style.display = isAssistant ? 'none' : '';
    entryList.style.display = isAssistant ? 'none' : '';
    panelFoot.style.display = isAssistant ? 'none' : '';
    assistantPane.style.display = isAssistant ? 'flex' : 'none';
    panelSearch.placeholder = panelTab === 'words' ? '筛选词汇…' : panelTab === 'sources' ? '筛选来源…' : '筛选标注…';
  }
  let agentMessages = [];
  let agentAudits = [];
  function cleanAgentValue(value) {
    if (typeof value === 'string') {
      return value
        .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi, '[截图已省略]')
        .replace(/(["']?image_url["']?\s*:\s*)\{[^}]*\}/gi, '$1[截图已省略]')
        .replace(/[A-Za-z0-9+/]{512,}={0,2}/g, '[图像数据已省略]');
    }
    if (Array.isArray(value)) return value.map(cleanAgentValue);
    if (value && typeof value === 'object') {
      const clean = Object.create(null);
      for (const key of Object.keys(value)) {
        if (/image|screenshot|base64|data_url|dataurl/i.test(key)) {
          clean[key] = '[截图已省略]';
        } else clean[key] = cleanAgentValue(value[key]);
      }
      return clean;
    }
    return value;
  }
  function agentText(value) {
    if (typeof value === 'string') return cleanAgentValue(value);
    if (Array.isArray(value)) return value.map((part) => {
      if (typeof part === 'string') return cleanAgentValue(part);
      return part && typeof part.text === 'string' ? cleanAgentValue(part.text) : '';
    }).filter(Boolean).join('\n');
    return value == null ? '' : cleanAgentValue(String(value));
  }
  function appendChatMessage(role, text) {
    const item = el('article'); item.className = 'va-chat-message va-chat-' + role;
    const label = el('span', null, role === 'user' ? '你' : role === 'assistant' ? '助手' : '提示');
    label.className = 'va-chat-role';
    const body = el('p'); body.className = 'va-chat-copy'; body.textContent = cleanAgentValue(String(text || ''));
    item.append(label, body); assistantTranscript.appendChild(item);
    assistantTranscript.scrollTop = assistantTranscript.scrollHeight;
    return item;
  }
  function renderAssistantTranscript() {
    assistantTranscript.textContent = '';
    for (const message of agentMessages) {
      if (!message || !['user', 'assistant'].includes(message.role)) continue;
      const text = agentText(message.content);
      if (text) appendChatMessage(message.role, text);
    }
    renderAgentAudit(agentAudits);
  }
  function prettyAgentValue(value) {
    try { return JSON.stringify(cleanAgentValue(value), null, 2); }
    catch (e) { return String(cleanAgentValue(value)); }
  }
  function renderAgentAudit(audit) {
    for (const entry of Array.isArray(audit) ? audit : []) {
      // Entries are sanitized before being stored in agentAudits; keep the
      // reference so confirmation results survive transcript re-renders.
      const safe = entry && typeof entry === 'object' ? entry : {};
      const card = el('details'); card.className = 'va-audit-card';
      const needsConfirmation = !!(safe.result && safe.result.needs_confirmation && safe.result.confirm_id);
      card.open = needsConfirmation;
      const summary = el('summary');
      const toolName = el('strong', null, String(safe.name || '工具调用'));
      const statusText = el('span', null, needsConfirmation ? '等待确认' : safe.result && safe.result.error ? '执行失败' : '已执行');
      statusText.className = 'va-audit-state'; summary.append(toolName, statusText);
      const args = el('pre'); args.className = 'va-audit-data'; args.textContent = prettyAgentValue(safe.arguments || {});
      const result = el('pre'); result.className = 'va-audit-data'; result.textContent = prettyAgentValue(safe.result == null ? {} : safe.result);
      const resultLabel = el('span', null, '结果'); resultLabel.className = 'va-audit-label';
      card.append(summary, el('span', null, '参数'), args, resultLabel, result);
      if (needsConfirmation) {
        const actions = el('div'); actions.className = 'va-audit-actions';
        const confirm = el('button', null, '确认'); confirm.type = 'button'; confirm.className = 'va-btn va-btn-primary';
        const cancel = el('button', null, '取消'); cancel.type = 'button'; cancel.className = 'va-btn va-btn-danger';
        async function resolveConfirmation(accept) {
          confirm.disabled = true; cancel.disabled = true; statusText.textContent = accept ? '正在确认…' : '正在取消…';
          try {
            const bridge = window.__ANNOTA__;
            if (!bridge) throw new Error('Annota 助手接口不可用');
            const outcome = accept ? await bridge.agentConfirm(safe.result.confirm_id) : await bridge.agentCancel(safe.result.confirm_id);
            safe.result = cleanAgentValue(outcome == null ? (accept ? { confirmed: true } : { cancelled: true }) : outcome);
            result.textContent = prettyAgentValue(safe.result);
            statusText.textContent = accept ? '已确认' : '已取消';
          } catch (error) {
            const failure = { error: cleanAgentValue(error && error.message || '操作失败') };
            result.textContent = prettyAgentValue(failure);
            statusText.textContent = '操作失败 · 可重试';
            confirm.disabled = false;
            cancel.disabled = false;
          }
        }
        confirm.onclick = () => resolveConfirmation(true);
        cancel.onclick = () => resolveConfirmation(false);
        actions.append(confirm, cancel); card.appendChild(actions);
      }
      assistantTranscript.appendChild(card);
    }
    assistantTranscript.scrollTop = assistantTranscript.scrollHeight;
  }
  assistantForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = assistantInput.value.trim();
    if (!text || assistantSend.disabled) return;
    const bridge = window.__ANNOTA__;
    if (!bridge || typeof bridge.agentRun !== 'function') {
      assistantNotice.textContent = '当前环境暂未配置 Annota 助手。请在 Annota 桌面端配置模型后再试。';
      assistantNotice.dataset.state = 'error';
      return;
    }
    assistantNotice.textContent = '';
    assistantNotice.dataset.state = '';
    agentMessages.push({ role: 'user', content: cleanAgentValue(text) });
    assistantInput.value = '';
    renderAssistantTranscript();
    assistantSend.disabled = true;
    assistantSend.textContent = '思考中…';
    try {
      const result = await bridge.agentRun(cleanAgentValue(agentMessages));
      const finalContent = result && result.message && typeof result.message === 'object' && 'content' in result.message
        ? result.message.content : result && result.message;
      if (result && Array.isArray(result.messages)) {
        agentMessages = cleanAgentValue(result.messages).filter((message) => message && message.role !== 'system');
      } else if (finalContent != null) {
        agentMessages.push({ role: 'assistant', content: cleanAgentValue(finalContent) });
      }
      const lastMessage = agentMessages[agentMessages.length - 1];
      if (finalContent != null && !(lastMessage && lastMessage.role === 'assistant' && agentText(lastMessage.content) === agentText(finalContent))) {
        agentMessages.push({ role: 'assistant', content: cleanAgentValue(finalContent) });
      }
      if (result && Array.isArray(result.audit)) agentAudits = agentAudits.concat(cleanAgentValue(result.audit));
      renderAssistantTranscript();
      if (finalContent == null && !(result && Array.isArray(result.audit) && result.audit.length)) {
        assistantNotice.textContent = '助手暂时没有返回可显示的内容，请重试。';
        assistantNotice.dataset.state = 'error';
      }
      if (panelTab === 'assistant') assistantTranscript.scrollTop = assistantTranscript.scrollHeight;
    } catch (error) {
      const message = String(error && error.message || error || '请求失败');
      if (/未配置模型|LLM_API_KEY|ARK_API_KEY|LLM_MODEL/i.test(message)) {
        assistantNotice.textContent = '尚未配置 AI 模型。请设置 LLM_API_KEY（或 ARK_API_KEY）与 LLM_MODEL。';
      } else assistantNotice.textContent = '助手暂时无法响应，请检查 AI 配置或本地服务后重试。';
      assistantNotice.dataset.state = 'error';
      appendChatMessage('notice', assistantNotice.textContent);
    } finally {
      assistantSend.disabled = false;
      assistantSend.textContent = '发送';
      assistantInput.focus({ preventScroll: true });
    }
  });
  assistantInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); assistantForm.requestSubmit(); }
  });
  function togglePanel(force) {
    panelOpen = force == null ? !panelOpen : !!force;
    sidePanel.classList.toggle('is-open', panelOpen);
    btnPanel.classList.toggle('is-active', panelOpen);
    if (panelOpen) {
      renderPanel();
      (panelTab === 'assistant' ? assistantInput : panelSearch).focus({ preventScroll: true });
    }
  }
  document.addEventListener('keydown', (ev) => {
    const target = ev.composedPath ? ev.composedPath()[0] : ev.target;
    const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) return;
    if (!isView() && shortcutMatches(ev, shortcuts.annotate)) {
      ev.preventDefault(); toggleAnnotate();
    } else if (shortcutMatches(ev, shortcuts.panel)) {
      ev.preventDefault(); togglePanel();
    } else if (shortcutMatches(ev, shortcuts.overlay)) {
      ev.preventDefault(); state.showAll = !state.showAll; btnAll.classList.toggle('is-active', state.showAll); render();
    } else if (ev.key === 'Escape') {
      if (state.picking) togglePicker(false);
      if (panelOpen) togglePanel(false);
      if (menuPanel.style.display !== 'none') toggleMenu();
      if (state.annotate) toggleAnnotate(false);
    }
  }, true);
  function renderPanel() {
    if (!panelOpen) return;
    panelTitleMain.textContent = panelTab === 'assistant' ? 'Annota 助手' : '当前标注';
    panelTitleSub.textContent = panelTab === 'assistant'
      ? '可询问当前画面与标注'
      : (state.binding ? document.title : '当前页面') + ' · ' + state.entries.length + ' 条';
    if (panelTab === 'assistant') { renderAssistantTranscript(); return; }
    entryList.textContent = '';
    const query = (panelSearch.value || '').trim().toLocaleLowerCase();
    if (panelTab === 'sources') {
      const timedNow = !state.binding || state.binding.timed;
      const mine = state.entries.slice().sort((a, b) => timedNow ? (a.t - b.t) : (String(a.word || '').localeCompare(String(b.word || ''))));
      const matched = query ? mine.filter((e) => (e.word + ' ' + (e.label || '') + ' ' + (e.pos || '')).toLocaleLowerCase().includes(query)) : mine;
      const words = new Set(matched.map((e) => (e.word || '').toLocaleLowerCase()).filter(Boolean)).size;
      const seg = (title) => { const g = el('div', null, title); g.className = 'va-entry-group'; return g; };
      const note = (text) => { const n = el('div', null, text); n.className = 'va-src-note'; return n; };

      entryList.appendChild(seg('我的'));
      const mineRow = el('div'); mineRow.className = 'va-src-row';
      const mineName = el('span', null, '本机标注'); mineName.className = 'va-src-name';
      const mineTag = el('span', null, '我的'); mineTag.className = 'va-src-tag';
      const mineCount = el('span', null, query ? '匹配 ' + matched.length + ' / 共 ' + mine.length + ' 条' : matched.length + ' 条 · ' + words + ' 个词');
      mineCount.className = 'va-src-count';
      mineRow.append(mineName, mineTag, mineCount);
      entryList.appendChild(mineRow);
      if (query && !matched.length) entryList.appendChild(note('没有匹配的标注，换个词试试。'));

      entryList.appendChild(seg('他人'));
      entryList.appendChild(note('共享标注将随去中心化标注交换开放：同一段内容下，他人公开的标注会自动汇入这里。'));

      entryList.appendChild(seg('AI 建议'));
      entryList.appendChild(note('AI 候选框不会直接写入：经 MCP propose_annotation 进入确认卡，你核对保存后才成为标注。'));
      panelFoot.textContent = query ? '来源筛选 · 我的匹配 ' + matched.length + ' 条' : '来源 · 我的 ' + mine.length + ' 条';
      return;
    }
    let items;
    if (panelTab === 'words') {
      const byWord = new Map();
      for (const e of state.entries.slice().sort((a, b) => a.t - b.t)) {
        const key = (e.word || '').toLocaleLowerCase();
        if (!key) continue;
        if (!byWord.has(key)) byWord.set(key, { entry: e, count: 0 });
        const item = byWord.get(key); item.count += 1; item.entry = e;
      }
      items = Array.from(byWord.values()).sort((a, b) => a.entry.word.localeCompare(b.entry.word));
      items = items.filter((item) => !query || (item.entry.word + ' ' + (item.entry.label || '')).toLocaleLowerCase().includes(query));
    } else {
      items = state.entries.slice().sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0))
        .filter((e) => !query || (e.word + ' ' + (e.label || '') + ' ' + (e.pos || '')).toLocaleLowerCase().includes(query))
        .map((entry) => ({ entry, count: 1 }));
    }

    if (!items.length) {
      const empty = el('div'); empty.className = 'va-empty';
      const mark = el('span'); mark.className = 'va-empty-mark'; mark.appendChild(svgIcon('box'));
      const copy = el('div');
      copy.append(el('strong', null, query ? '没有匹配的标注' : '这一段还没有标注'),
        el('span', null, query ? '试试换个词搜索。' : '按 D 或点「标注」，把一个词锚在画面上。'));
      empty.append(mark, copy); entryList.appendChild(empty);
      panelFoot.textContent = query ? '搜索结果为 0 条' : '点击「标注」开始建立这段内容的记忆';
      return;
    }

    let lastMinute = -1;
    const timed = !state.binding || state.binding.timed;
    for (const item of items) {
      const e = item.entry;
      if (panelTab === 'timeline' && timed) {
        const minute = Math.floor((Number(e.t) || 0) / 60);
        if (minute !== lastMinute) {
          lastMinute = minute;
          const group = el('div', null, formatTime(minute * 60)); group.className = 'va-entry-group';
          entryList.appendChild(group);
        }
      }
      const row = el('button'); row.type = 'button'; row.className = 'va-entry-row';
      const time = el('span', null, timed ? formatTime(e.t) : '🖼');
      time.className = 'va-entry-time' + (timed ? '' : ' va-entry-time--none');
      const copy = el('span'); copy.className = 'va-entry-copy';
      const tagStr = entryTags(e).map((t) => '#' + t).join(' ');
      const title = el('strong', null, entryText(e));
      const subtitle = el('span', null, panelTab === 'words'
        ? ((e.label || '未添加备注') + (item.count > 1 ? ' · 出现 ' + item.count + ' 次' : ''))
        : ([e.label, tagStr].filter(Boolean).join(' · ') || '点击定位画面'));
      copy.append(title, subtitle);
      const hiddenNow = isHidden(e);
      if (hiddenNow) row.classList.add('is-hidden');
      const eye = mkIconButton(hiddenNow ? '显示这一条' : '隐藏这一条', hiddenNow ? 'eye-off' : 'eye', () => {
        toggleHidden(e);
      });
      eye.classList.add('va-entry-eye');
      eye.setAttribute('aria-pressed', hiddenNow ? 'true' : 'false');
      const more = mkIconButton('编辑或管理词条', 'dots', () => {
        const r = more.getBoundingClientRect(); openEntryPop(e, r.left, r.bottom);
      });
      more.classList.add('va-entry-more');
      row.append(time, copy, eye, more);
      row.onclick = (ev) => {
        if (ev.target === more || more.contains(ev.target) || ev.target === eye || eye.contains(ev.target)) return;
        state.lastActiveId = String(e.id);
        if (state.binding) state.binding.locate(e);
        render();
        showToast('已定位到 ' + (timed ? formatTime(e.t) + ' · ' : '') + entryText(e));
      };
      entryList.appendChild(row);
    }
    panelFoot.textContent = items.length + (panelTab === 'words' ? ' 个词 · 按词汇聚' : ' 条标注 · 点击词条定位画面');
  }

  /* ---------- 上下文桥（发给桌面豆包/系统助手）+ 截图 + 笔记 ---------- */
  // 不做第二个豆包：只把「别人拿不到的上下文」整理好，交给桌面豆包
  function videoContext() {
    const timed = !state.binding || state.binding.timed;
    const t = timed && state.binding ? Math.floor(state.binding.time()) : 0;
    const words = state.entries.slice(-12).map((e) => e.word).filter(Boolean).join(', ');
    const ctx = state.binding && state.binding.contextText ? state.binding.contextText() : {};
    return ['平台: ' + (state.platform || location.hostname), '链接: ' + location.href,
      '标题: ' + document.title,
      timed ? '当前进度: ' + t + 's' : (ctx.intrinsic ? '图片尺寸: ' + ctx.intrinsic : ''),
      words ? '画面已标注的词: ' + words : ''].filter(Boolean).join('\n');
  }
  function videoRect() {
    const r = state.binding ? state.binding.captureRect() : state.rect;
    if (!r) return null;
    return { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.round(r.width), height: Math.round(r.height) };
  }
  function cropDataUrl(dataUrl, rect) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          // 缩放用「实际截图宽度 / 视口宽度」推算（兼容 HiDPI/缩放），rect 为 CSS 像素
          const vp = (window.innerWidth || 1);
          const sx = img.width / vp, sy = img.height / (window.innerHeight || 1);
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(rect.width * sx));
          c.height = Math.max(1, Math.round(rect.height * sy));
          const ctx = c.getContext('2d');
          if (!ctx) { resolve(null); return; }        // 闭锁：宁可不给，也不给整屏
          ctx.drawImage(img, rect.x * sx, rect.y * sy, rect.width * sx, rect.height * sy, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/png'));
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }
  // 三通道统一：截图返回整窗/整屏，一律按视频（或媒态）矩形裁剪到画面。
  // 裁剪超时（图片解码卡住等）→ 返回原图，宁可整窗也不让批量导出挂死。
  async function cropToMedia(dataUrl, rect) {
    if (!dataUrl) return null;
    if (!rect) return dataUrl;
    return await Promise.race([
      cropDataUrl(dataUrl, rect),
      // 超时宁可不给整窗（与 cropDataUrl 的闭锁策略一致）→ 退化为纯文字卡，绝不泄露整屏
      new Promise((resolve) => setTimeout(() => resolve(null), 1200)),
    ]);
  }
  // canvas 直接取媒态像素：最可靠（拿到的是纯画面，不含宿主 UI/播放器遮罩的合成层问题）
  function captureViaCanvas() {
    try {
      const m = state.binding && state.binding.el; if (!m) return null;
      const w = m.videoWidth || m.naturalWidth || 0, h = m.videoHeight || m.naturalHeight || 0;
      if (!w || !h) return null;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(m, 0, 0);
      return c.toDataURL('image/png');           // 跨域会被 taint → 抛错 → null（由上层回落）
    } catch (e) { return null; }
  }
  async function captureFrame() {
    const rect = videoRect();
    // 1) 优先 canvas：桌面端窗口截图（xcap）拿不到视频合成层会黑屏；canvas 能拿到真实像素
    const viaCanvas = captureViaCanvas();
    if (viaCanvas) return viaCanvas;
    // 2) 回落：整窗/整屏截图 + 按媒态矩形裁剪（Tauri / 扩展）
    try {
      if (typeof window.vaCapture === 'function') {                                              // 自建浏览器（Tauri）
        const raw = await window.vaCapture(rect);
        return await cropToMedia(raw, rect);
      }
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {        // 扩展
        const resp = await new Promise((res) => chrome.runtime.sendMessage({ type: 'va-capture' }, res));
        return await cropToMedia(resp && resp.dataUrl, rect);
      }
    } catch (e) {}
    return null;
  }
  function contextText() {
    const list = state.entries.slice(-20).map((e) => '  - ' + e.word + (e.label ? '（' + e.label + '）' : '') + (e.pos ? ' [' + e.pos + ']' : '') + ' @' + e.t + 's').join('\n');
    return '我在看这个视频学英语，帮我讲解/陪练：\n' + videoContext() + '\n' + (list ? '我标注过的词：\n' + list + '\n' : '') +
      '\n请：1) 结合截图解释这些词在此语境下的意思；2) 给我一个例句；3) 用英文问我一个问题。';
  }
  async function copyRich(text, dataUrl) {
    try {
      if (typeof window.vaCopy === 'function') return !!(await window.vaCopy({ text, dataUrl }));   // 自建浏览器：富剪贴板
      if (!dataUrl) {   // 无图：直接文字
        await navigator.clipboard.writeText(text);
        return true;
      }
      const items = { 'text/plain': new Blob([text], { type: 'text/plain' }) };
      items['image/png'] = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem(items)]);
      return true;
    } catch (e) { return await fallbackCopy(text, !!dataUrl); }   // 富剪贴板失败 → 至少复制文字
  }
  function fallbackCopy(text, hadImage) {
    return new Promise((resolve) => {
      const ta = el('textarea', { position: 'fixed', left: '-9999px' });
      ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      resolve(!!ok && !hadImage);   // 回退只复制到文字：有图时视为「部分成功」(false)，无图成功=true
    });
  }
  // 一键：截图 + 上下文 → 剪贴板（到桌面豆包里粘贴即问）
  async function copyContext() {
    const text = contextText();
    const dataUrl = await captureFrame();
    const ok = await copyRich(text, dataUrl);
    if (!ok) { setSyncStatus('复制失败：浏览器拦了剪贴板，请手动选择文本'); return; }
    setSyncStatus(dataUrl ? '已复制「截图+上下文」→ 粘贴到桌面豆包' : '已复制文字（本环境无截图）→ 粘贴到桌面豆包');
  }
  async function shotOnly() {
    const d = await captureFrame();
    if (!d) { setSyncStatus('截图不可用（用扩展/自建浏览器）'); return; }
    const ok = await copyRich('', d);
    setSyncStatus(ok ? '截图已复制到剪贴板' : '复制失败（浏览器拦了剪贴板）');
  }
  // 存成 Markdown 笔记（→ Obsidian/Notebook）+ 标注写进 data.jsonl
  async function saveNote() {
    const shot = await captureFrame();
    const payload = {
      title: document.title, created: new Date().toISOString(),
      media: { platform: state.platform, videoId: state.mediaId, url: location.href },
      entries: state.entries, chat: [], screenshot: shot,
    };
    setSyncStatus('保存笔记中…');
    try {
      const base = await resolveBase();
      const r = await httpJson('POST', base + '/api/note', payload);
      if (r.ok && r.json && r.json.ok) setSyncStatus('已存笔记：' + r.json.path);
      else setSyncStatus('存笔记失败：' + ((r.json && r.json.error) || ('HTTP ' + r.status)));
    } catch (e) { setSyncStatus('存笔记失败：' + e.message); }
  }


  // 找不到视频时给个诊断入口（抖音等可能把 <video> 藏在 shadow DOM，或整页无视频）
  const probe = el('div'); probe.className = 'va-probe'; probe.style.display = 'none';
  probe.append(svgIcon('box'), el('span', null, '未检测到视频 · 查看诊断'));
  probe.setAttribute('role', 'button'); probe.tabIndex = 0;
  probe.onclick = () => { probe.style.display = 'none'; toggleDiag(); };
  probe.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); probe.click(); } };
  let noVideoSince = 0, probeTimer = null;
  function startProbe() {
    if (probeTimer) return;
    probeTimer = setInterval(() => {
      const plat = A.platform ? A.platform() : 'generic';
      const watchable = plat === 'bilibili' || plat === 'douyin' || plat === 'youtube';
      if (!watchable || state.binding || A.findVideo()) { noVideoSince = 0; probe.style.display = 'none'; return; }
      if (!noVideoSince) noVideoSince = Date.now();
      else if (Date.now() - noVideoSince > 3000) {
        if (probe.parentElement !== uiRoot) uiRoot.appendChild(probe);
        probe.style.display = 'block';
      }
    }, 1500);
  }
  startProbe();

  // 设置面板：同步地址 + 文件导入导出 + 清空
  const menuPanel = el('div', { display: 'none' });
  menuPanel.className = 'va-more-menu';
  const syncBox = el('input'); syncBox.className = 'va-input';
  syncBox.setAttribute('aria-label', '同步地址');
  // 默认词典链接模板（编辑器读同一个 key；须含 {word} 且为 http(s)）
  const dictBox = el('input'); dictBox.className = 'va-input';
  dictBox.setAttribute('aria-label', '默认词典链接模板');
  dictBox.placeholder = 'https://dictionary.cambridge.org/dictionary/english/{word}';
  async function saveDictTemplate() {
    const v = dictBox.value.trim();
    if (!v) {
      appSettings.dictUrlTemplate = '';
      try { localStorage.removeItem('annota:dictUrlTemplate'); } catch (e) {}
      await persistAppSettings();
      setSyncStatus('词典已恢复默认');
      return;
    }
    try {
      if (v.indexOf('{word}') < 0 || !isHttp(v)) { setSyncStatus('词典模板需含 {word} 且为 http(s)'); return; }
      localStorage.setItem('annota:dictUrlTemplate', v);
    } catch (e) {}
    appSettings.dictUrlTemplate = v;
    await persistAppSettings();
    setSyncStatus('词典模板已保存');
  }
  // 可折叠分组（「更多」菜单用）：默认收起，把低频/调试项从首屏移走。
  // 首屏只留高频动作，避免 20+ 个平铺按钮造成的认知负担。
  function mkFold(label, hint) {
    const fold = el('div'); fold.className = 'va-fold';
    const head = el('button'); head.type = 'button';
    head.className = 'va-fold-head';
    head.setAttribute('aria-expanded', 'false');
    if (hint) head.title = hint;
    const text = el('span', null, label); text.className = 'va-fold-label';
    // 右侧 chevron：明确「这是个可展开的分组」，而不是又一个动作按钮
    const chev = svgIcon('chevronDown'); chev.classList.add('va-fold-chevron');
    head.append(text, chev);
    const body = el('div'); body.className = 'va-fold-body';
    head.onclick = (e) => {
      e.stopPropagation();
      const open = fold.dataset.open === '1';
      fold.dataset.open = open ? '0' : '1';
      head.setAttribute('aria-expanded', open ? 'false' : 'true');
    };
    fold.append(head, body);
    return { fold, body };
  }

  async function toggleMenu() {
    const on = menuPanel.style.display === 'none';
    if (!on) { menuPanel.style.display = 'none'; btnCfg.classList.remove('is-active'); menuPanel.remove(); return; }
    btnCfg.classList.add('is-active');
    syncBox.value = syncUrl();
    try { dictBox.value = appSettings.dictUrlTemplate || localStorage.getItem('annota:dictUrlTemplate') || ''; } catch (e) {}
    const viewBtn = mkbtn(isView() ? '只读模式 · 已开启' : '只读模式', () => {
      try { localStorage.setItem('va:viewOnly', isView() ? '0' : '1'); } catch (e) {}
      applyMode();
      viewBtn.textContent = isView() ? '只读模式 · 已开启' : '只读模式';
    });
    // 「仅上传」已删：它只是 syncNow 的别名（syncNow 本身就是拉取→合并→回传），
    //  留一个同功能按钮会让人误以为上传与同步是两种不同操作。
    // 「仅下载」改名并标危险色：它会用服务器版**丢弃本地改动**，属破坏性操作，
    //  原名「仅下载」看不出这个风险。
    const rowDir = el('div', { display: 'flex', gap: '5px', marginTop: '5px' }); rowDir.className = 'va-menu-row';
    const overwriteBtn = mkbtn('以服务器覆盖本地', downloadSync);
    overwriteBtn.classList.add('is-danger');
    overwriteBtn.title = '丢弃本视频的本地改动，用服务器上的版本覆盖';
    rowDir.append(overwriteBtn, viewBtn);
    const row = el('div', { display: 'flex', gap: '5px', marginTop: '5px', flexWrap: 'wrap' }); row.className = 'va-menu-row';
    const clearBtn = mkbtn('清空当前', clearAll);
    clearBtn.classList.add('is-danger');
    row.append(mkbtn('导出 Pack', exportJSON), mkbtn('导入 Pack', importJSON), clearBtn);
    const groupFold = mkFold('组管理', '加入组 / 推送到组 / 云开发登录');
    const groupPanel = groupFold.body;
    groupPanel.setAttribute('aria-label', '组管理菜单');
    const groupHeading = el('div', { color: '#9b8260', fontSize: '9px', fontWeight: '700', letterSpacing: '.1em', padding: '0 9px 3px' }, '组');
    const groupInvite = el('input'); groupInvite.className = 'va-input';
    groupInvite.type = 'text'; groupInvite.placeholder = '粘贴 annota://join 邀请链接';
    groupInvite.setAttribute('aria-label', '加入组邀请链接');
    const groupFeedback = el('div', { color: '#89919b', fontSize: '10px', padding: '4px 9px' });
    groupFeedback.setAttribute('role', 'status'); groupFeedback.setAttribute('aria-live', 'polite');
    const groupList = el('div', { display: 'flex', flexDirection: 'column', gap: '3px', padding: '2px 4px' });
    groupList.setAttribute('aria-label', '当前媒体所属组');
    const renderDockGroups = () => {
      groupList.textContent = '';
      const api = window.VAGroup;
      let groups = [];
      try { groups = api && api.groupsForMedia ? api.groupsForMedia(state.mediaId) : []; } catch (e) {}
      if (!groups || !groups.length) {
        groupList.appendChild(el('div', { color: '#66717d', fontSize: '10px', padding: '2px 9px' }, state.mediaId ? '当前媒体尚未加入组片单' : '打开媒体后显示相关组'));
        return;
      }
      groups.forEach((g) => {
        const members = Array.isArray(g.members) ? g.members.length : (g.memberCount || 0);
        let authors = [];
        try {
          const cached = JSON.parse(localStorage.getItem(GROUP_CACHE_PREFIX + g.gid + ':' + state.mediaId) || 'null');
          authors = Array.from(new Set(((cached && cached.entries) || []).map((entry) => entry && entry.creator && entry.creator.name).filter(Boolean))).slice(0, 3);
        } catch (e) {}
        const hint = authors.length ? '标注者：' + authors.join('、') : members ? members + ' 位成员' : (g.role === 'owner' ? '创建者' : '组成员');
        const item = el('div', { color: '#c3c7cc', fontSize: '10px', padding: '3px 9px', overflowWrap: 'anywhere' }, (g.name || g.gid || '组') + ' · ' + hint);
        item.setAttribute('title', g.repo || ''); groupList.appendChild(item);
      });
    };
    const joinRow = el('div', { display: 'flex', gap: '6px', marginTop: '5px' }); joinRow.className = 'va-menu-row';
    // 云开发（hub）登录：进组前需登录以便云端署名/鉴权。GitHub OAuth → 云函数签 ticket → 回本页兑换会话。
    const hubRow = el('div', { display: 'flex', gap: '6px', marginTop: '5px' }); hubRow.className = 'va-menu-row';
    async function renderHubRow() {
      hubRow.textContent = '';
      const api = window.VAGroup;
      const me = api && api.hubMe ? api.hubMe() : null;
      let signedIn = false;
      try { signedIn = !!(api && api.currentUser && (await api.currentUser())); } catch (e) {}
      if (me || signedIn) {
        hubRow.appendChild(el('span', { color: '#8bc98b', fontSize: '10px', flex: '1' }, '已登录：' + ((me && me.name) || 'GitHub 用户')));
        hubRow.appendChild(mkbtn('退出', async () => { try { await api.signOut(); } catch (e) {} renderHubRow(); }));
      } else {
        hubRow.appendChild(mkbtn('用 GitHub 登录云开发', () => { try { api.startLogin(); } catch (e) { groupFeedback.textContent = '登录不可用'; } }));
      }
    }
    // 若从 OAuth 回跳（?ticket=…）兑换会话，成功后刷新登录行
    if (window.VAGroup && typeof window.VAGroup.handleTicket === 'function') {
      try {
        const u = await window.VAGroup.handleTicket();
        if (u) { showToast('已登录云开发'); render(); }
      } catch (e) { /* 无 ticket 或兑换失败：忽略 */ }
    }
    renderHubRow();
    const joinBtn = mkbtn('加入组', async () => {
      const api = window.VAGroup;
      if (!api || typeof api.parseInvite !== 'function' || typeof api.joinGroup !== 'function') { groupFeedback.textContent = '组功能暂不可用'; return; }
      const parsed = api.parseInvite(groupInvite.value);
      if (!parsed) { groupFeedback.textContent = '邀请链接无效'; return; }
      joinBtn.disabled = true; groupFeedback.textContent = '正在读取组…';
      try {
        const result = await api.joinGroup(groupInvite.value);
        const joinedName = (result && result.doc && result.doc.name) || (result && result.rec && result.rec.name) || '组';
        groupFeedback.textContent = '已加入 ' + joinedName;
        showToast('已加入 ' + joinedName);
        groupInvite.value = ''; renderDockGroups(); render();
      } catch (error) { groupFeedback.textContent = '加入失败：' + String(error && error.message || error); }
      finally { joinBtn.disabled = false; }
    });
    joinBtn.style.width = 'auto'; joinBtn.style.flex = '1';
    joinRow.appendChild(joinBtn);
    const pushBtn = mkbtn('推送到组', async () => {
      const api = window.VAGroup;
      if (!api || typeof api.pushForMedia !== 'function') { groupFeedback.textContent = '组功能暂不可用'; return; }
      if (!state.mediaId) { groupFeedback.textContent = '请先打开一段媒体内容'; return; }
      pushBtn.disabled = true; groupFeedback.textContent = '正在推送…';
      try {
        const result = await api.pushForMedia(state.mediaId, state.entries);
        const count = result && Number(result.pushed) || 0;
        const message = result && result.groups && result.groups.length ? '已推送 ' + count + ' 条到 ' + result.groups.length + ' 个组' : '没有可推送的组';
        groupFeedback.textContent = message;
        showToast(message);
        renderDockGroups();
      } catch (error) { groupFeedback.textContent = '推送失败：' + String(error && error.message || error); }
      finally { pushBtn.disabled = false; }
    });
    pushBtn.style.width = 'auto'; pushBtn.style.flex = '1';
    joinRow.appendChild(pushBtn);
    groupInvite.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); joinBtn.click(); } });
    groupPanel.append(groupHeading, groupInvite, joinRow, hubRow, groupFeedback, groupList);
    groupFold.body.append(el('div', { color: '#89919b', fontSize: '10px', padding: '0 2px' }, '与伙伴共享标注：加入组后可在同一片单里互看。'));
    renderDockGroups();
    menuPanel.textContent = '';
    const cands = (window.VA_SYNC_URLS || []).join('  ·  ');
    const section = (label) => el('div', { color: '#9b8260', fontSize: '9px', fontWeight: '700', letterSpacing: '.1em', padding: '6px 9px 3px' }, label);
    const sep = () => el('div', { height: '1px', background: 'rgba(255,255,255,.08)', margin: '5px 3px' });

    // 首屏：只放高频动作（AI 上下文三件套 + 诊断）。其余收进折叠区。
    const toolsRow = el('div', { display: 'flex', gap: '5px', flexWrap: 'wrap' }); toolsRow.className = 'va-menu-row';
    toolsRow.append(btnBridge, mkbtn('截图', shotOnly), mkbtn('存笔记', saveNote));

    // 高级设置：同步地址（自动探测已覆盖日常，这里只是手动兜底）+ 方向控制 + 导入导出 + 词典模板
    const adv = mkFold('高级设置', '同步地址、导入导出、词典模板等低频项');
    adv.body.append(
      el('div', { color: '#89919b', fontSize: '10px', padding: '4px 9px 0' }, '同步地址（留空=自动探测）'),
      syncBox,
      el('div', { display: 'flex', gap: '6px', marginTop: '6px' },
        mkbtn('保存地址', async () => {
          const v = syncBox.value.trim();
          if (v && !isHttp(v)) { setSyncStatus('同步地址必须是 http(s)://'); return; }
          appSettings.sync.address = v;
          if (v) setSyncBase(v); else { syncBase = null; try { localStorage.removeItem(SYNC_URL_KEY); } catch (e) {} }
          await persistAppSettings();
          setSyncStatus(v ? '同步地址已保存' : '已恢复自动');
        }),
        mkbtn('清空地址', async () => {
          appSettings.sync.address = '';
          localStorage.removeItem(SYNC_URL_KEY); syncBase = null; syncBox.value = '';
          await persistAppSettings(); setSyncStatus('已恢复自动');
        }),
        mkbtn('测试', testSync)),
      rowDir,
      row,
      sep(),
      el('div', { color: '#89919b', fontSize: '10px', padding: '0 9px' }, '默认查词链接（用 {word} 占位）'),
      dictBox,
      el('div', { display: 'flex', gap: '6px', marginTop: '6px' },
        mkbtn('保存模板', saveDictTemplate),
        mkbtn('恢复默认', () => { dictBox.value = ''; try { localStorage.removeItem('annota:dictUrlTemplate'); } catch (e) {} setSyncStatus('词典已恢复默认'); })),
      el('div', { color: '#66717d', fontSize: '9px', padding: '6px 9px 0', overflowWrap: 'anywhere' }, cands ? '备选：' + cands : '默认 http://127.0.0.1:8793'),
    );

    menuPanel.append(
      section('ANNOTATION TOOLS'),
      toolsRow,
      btnDiag,
      sep(),
      adv.fold,
      sep(),
      groupFold.fold,
    );
    menuPanel.style.display = 'block';
    uiRoot.appendChild(menuPanel);
  }
  function setSyncStatus(msg) {
    const text = String(msg || '就绪');
    statusText.textContent = text;
    const error = /失败|异常|连不上|不可用/.test(text);
    const busy = /中…|测试中/.test(text);
    status.dataset.state = error ? 'error' : busy ? 'busy' : 'ready';
    if (error || /已同步|已上传|已下载|已保存|已复制/.test(text)) showToast(text, error);
  }

  function mkbtn(text, fn) {
    const b = el('button', null, text);
    b.type = 'button';
    b.className = 'va-btn';
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  }
  // el(tag, style, ...children)：children 可为字符串或节点（支持多个）
  function el(tag, style, ...kids) {
    const n = document.createElement(tag);
    if (style) for (const k in style) n.style[k] = style[k];
    for (const c of kids) {
      if (c == null || c === false) continue;
      n.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c);
    }
    return n;
  }

  /* ---------- 生命周期 ---------- */
  // 常驻 UI 外壳：即使页面没有可自动绑定的媒态，也保留 dock（含「选对象」入口）
  let shellMounted = false;
  function mountShell() {
    if (shellMounted) return;
    shellMounted = true;
    uiRoot.append(overlay, bar, sidePanel, toast);
    // 浏览器壳接缝（M2）：自建浏览器（Tauri）可接管 dock/panel 容器与「观看/编辑」态，
    // 但**不改**标注状态机 / popover / 数据层。未注入 VA_BROWSER_SHELL 时行为与现在完全一致。
    try {
      const shell = window.VA_BROWSER_SHELL;
      if (shell && typeof shell.adopt === 'function') {
        shell.adopt({
          dock: bar, panel: sidePanel, overlay, toast,
          uiRoot,
          api: {
            isView, applyMode,
            toggleAnnotate, togglePicker, togglePanel, toggleSources, toggleMenu,
            syncNow, render, renderPanel,
            // 只读快照：壳不得直接持有/篡改 core 内部 state（见 dev/check-shell-drift.mjs 契约）
            getState: () => ({ annotate: state.annotate, picking: state.picking, binding: state.binding }),
          },
        });
      }
    } catch (e) { /* 壳接管失败：保持默认 dock/panel，不影响标注 */ }
  }

  function attach(target) {
    // 兼容：adapter 回调 {kind, el}；也接受裸 <video>
    const normalized = target && target.el !== undefined ? target : { kind: 'video', el: target };
    const binding = VAMedia.create(normalized);
    if (!binding) return;
    // 同一 binding 不重复挂（article 的 el 为 null，改用 kind+rootEl 判等）
    if (state.binding && state.binding.kind === binding.kind && state.binding.el === binding.el && state.binding.rootEl === binding.rootEl) return;
    if (state.binding) detach();
    state.binding = binding;
    state.mediaId = binding.mediaId();
    state.platform = binding.mediaMeta().platform;
    load(); save(); render();
    mountShell();
    toast.classList.remove('is-visible', 'is-error');
    renderPanel();
    lastSig = null;
    applyMode();
    startProbe();
    scheduleReconcile();     // 先只读选版显示（服务器更新 → 显示服务器版；覆盖本地要用户选）
    scheduleAutoSync();      // 自动同步：仅在开启时把本地当前版推上服务器
    scheduleGroupPull();     // 组来源层：拉组内该媒体标注
    if (!raf) raf = requestAnimationFrame(loop);
  }

  // 无绑定媒态：只保留 dock 与「选对象」，隐藏画面标注层
  function detachBinding() {
    if (state.binding) state.binding.destroy();
    state.binding = null; state.meta = null; lastSig = null; autoSyncedMedia = null;
    raf = null;   // 停帧；下次 attach 会重新启动 loop
    overlay.style.display = 'none';
    if (state.picking) togglePicker(false);
    renderPanel();
  }

  let raf = null, lastSig = null, autoSyncTimer = null, autoSyncedMedia = null, reconciledMedia = null;
  let groupPullTimer = null, groupPulledMedia = null, groupPushTimer = null;
  // 打开媒体：拉一次组内该媒体的标注（组来源层，不影响个人层）
  function scheduleGroupPull() {
    if (!state.mediaId || !window.VAGroup || groupPulledMedia === state.mediaId) return;
    groupPulledMedia = state.mediaId;
    if (groupPullTimer) clearTimeout(groupPullTimer);
    groupPullTimer = setTimeout(async () => {
      groupPullTimer = null;
      try {
        const changed = await window.VAGroup.pullForMedia(state.mediaId);
        if (changed) { render(); renderPanel(); }
      } catch (e) {}
    }, 600);
  }
  // save() 后去抖：把组片单媒体上的实线条目推到各已加入的组
  function scheduleGroupPush() {
    if (!state.mediaId || !window.VAGroup || state.renderLock) return;
    if (groupPushTimer) clearTimeout(groupPushTimer);
    groupPushTimer = setTimeout(async () => {
      groupPushTimer = null;
      try { await window.VAGroup.pushForMedia(state.mediaId, state.entries); } catch (e) {}
    }, 5000);
  }
  // 打开媒体：只读选版显示（不写不对齐）；覆盖本地由用户选，可记忆
  function scheduleReconcile() {
    if (!state.mediaId || reconciledMedia === state.mediaId) return;
    reconciledMedia = state.mediaId;
    setTimeout(() => { try { reconcileOnOpen(state.mediaId); } catch (e) {} }, 400);
  }
  function scheduleAutoSync() {
    if (!AUTO_SYNC || !state.mediaId || autoSyncedMedia === state.mediaId) return;
    autoSyncedMedia = state.mediaId;
    if (autoSyncTimer) clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => { autoSyncTimer = null; try { syncNow(); } catch (e) {} }, 900);
  }
  function loop() {
    const binding = state.binding;
    if (!binding || !binding.tick()) { detachBinding(); return; }   // 无媒态：停帧，等 A.watch 再 attach
    raf = requestAnimationFrame(loop);

    // SPA 切换（视频换集 / 画廊换图）：mediaId 变了就换一份标注
    const mid = binding.mediaId();
    if (mid !== state.mediaId) { state.mediaId = mid; load(); render(); renderPanel(); autoSyncedMedia = null; reconciledMedia = null; scheduleReconcile(); scheduleAutoSync(); }

    // 全屏宿主处理：只有 fullscreen 元素的后代可见
    const fs = document.fullscreenElement;
    let host = document.body, unsupported = false;
    if (fs) { if (fs.tagName === 'VIDEO' || fs.tagName === 'IMG') unsupported = true; else host = fs; }
    if (uiHost.parentElement !== host) host.appendChild(uiHost);

    if (unsupported) {
      overlay.style.display = 'none'; bar.style.display = 'none';
      toast.textContent = '视频元素处于系统全屏，浏览器不允许叠加。请切换到网页全屏或影院模式。';
      toast.classList.add('is-visible', 'is-error');
      state.meta = { unsupported: true };
      return;
    }

    const layout = binding.layout();
    if (!layout) { detachBinding(); return; }
    toast.classList.remove('is-visible', 'is-error');
    bar.style.display = 'flex';

    const r = layout.rect;
    state.rect = r;
    state.cr = layout.cr;
    state.meta = { fit: layout.fit, host: host.tagName, unsupported: false };

    overlay.style.display = 'block';
    // overlay 始终覆盖视口；标记用视口坐标（对长图/滚动图也正确）
    overlay.style.left = '0px'; overlay.style.top = '0px';
    overlay.style.width = '100vw'; overlay.style.height = '100vh';

    if (!state.renderLock) {
      if (state.dragging && state.draft) drawDraft();
      // 重绘触发：按「当前应显示的条目集合」签名；showAll 时是全集，否则是按可见性过滤的子集。
      // 无轴媒态（图片/文章）可见性恒真 → 签名稳定，天然只渲染一次；滚动进出视口时会变化并重绘。
      const sig = (state.showAll ? state.entries : state.entries.filter((e) => binding.isVisible(e)))
        .map((e) => e.id).join(',');
      if (sig !== lastSig) { lastSig = sig; render(); }
    }
  }

  function detach() {
    if (raf) cancelAnimationFrame(raf); raf = null;
    if (diagTimer) { clearInterval(diagTimer); diagTimer = null; }
    if (autoSyncTimer) { clearTimeout(autoSyncTimer); autoSyncTimer = null; }
    if (groupPullTimer) { clearTimeout(groupPullTimer); groupPullTimer = null; }
    if (groupPushTimer) { clearTimeout(groupPushTimer); groupPushTimer = null; }
    groupPulledMedia = null;
    if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
    overlay.remove(); bar.remove(); sidePanel.remove(); diagPanel.remove(); toast.remove(); menuPanel.remove(); probe.remove();
    uiRoot.querySelectorAll('.va-popover').forEach((n) => n.remove());
    shellMounted = false;   // 关键：壳被移除，允许 mountShell 重新挂载（否则重绑时 overlay/dock 再也不出现）
    panelOpen = false;
    if (state.binding) state.binding.destroy();
    state.binding = null; state.meta = null; lastSig = null; autoSyncedMedia = null;
  }

  /* ---------- 渲染 ---------- */
  // 图片版本校验：anchored 时的图 URL / 原始尺寸与当前不符 → 标记 stale（不静默错位）
  function imgStale(e) {
    const b = state.binding;
    if (!b || b.kind !== 'image' || !b.el || !e.img) return false;
    const cur = b.el.currentSrc || b.el.src || '';
    if (e.img.key && cur && e.img.key !== cur) return true;
    const n = e.img.natural;
    return !!(n && (n.w && n.w !== b.el.naturalWidth || n.h && n.h !== b.el.naturalHeight));
  }

  function drawEntry(e) {
    const binding = state.binding, cr = state.cr;
    if (!binding || !cr || !e) return;
    const rects = binding.entryRects(e, cr);
    for (const p of rects) {
      // 视口坐标（overlay 覆盖整视口）
      const left = p.left, top = p.top;
      const box = el('div', {
        position: 'absolute', left: left + 'px', top: top + 'px',
        width: (p.width != null ? p.width : p.w) + 'px', height: (p.height != null ? p.height : p.h) + 'px',
      });
      box.className = 'va-mark';
      if (imgStale(e)) { box.classList.add('is-stale'); box.title = '图片版本已变，锚点可能需复核'; }
      if (e.__group) {                       // 组来源：虚线 + 来源色点（他人标注视觉语言）
        box.classList.add('is-group');
        box.title = '组内标注 · ' + (e.__author || '成员');
      }
      const markText = entryText(e);
      const lab = el('span', {}, markText + (e.label && e.label !== markText ? ' ' + e.label : ''));
      lab.className = 'va-mark-label';
      box.appendChild(lab);
      if (e.__group && e.__author) {
        const chip = el('span', null, e.__author); chip.className = 'va-mark-author';
        box.appendChild(chip);
      }
      box.onclick = (ev) => { ev.stopPropagation(); openEntryPop(e, ev.clientX, ev.clientY); };
      layer.appendChild(box);
    }
  }

  function render() {
    layer.textContent = '';
    state.exportOnly = null;
    const binding = state.binding; if (!binding) return;
    const cr = state.cr; if (!cr) return;
    const hid = hiddenSources();
    if (!hid.local) {
      for (const e of state.entries) {
        if (isHidden(e)) continue;                       // 本地隐藏：画面上不渲染
        if (!state.showAll && !binding.isVisible(e)) continue;
        drawEntry(e);
      }
    }
    // 组来源条目：叠加在个人条目之上（虚线 + 作者 chip），不污染 state.entries
    for (const e of groupEntries()) {
      if (isHidden(e)) continue;
      if (!state.showAll && !binding.isVisible(e)) continue;
      drawEntry(e);
    }
    updateListBadge();
  }

  function renderOnly(entry) {
    layer.textContent = '';
    state.exportOnly = entry || null;
    if (entry && state.binding && state.cr) drawEntry(entry);
  }

  function setChromeHidden(hidden) {
    const on = !!hidden;
    uiRoot.dataset.uiHidden = on ? '1' : '';
    if (on) setPageCursor('');
    else if (state.annotate && !state.picking) setPageCursor('crosshair');
  }

  function drawDraft() {
    layer.textContent = '';
    const cr = state.cr, d = state.draft;
    const b = G.dragToBox(d.x0, d.y0, d.x1, d.y1, cr);
    const p = G.boxToPixels(b, cr);
    const box = el('div', {
      position: 'absolute', left: p.left + 'px', top: p.top + 'px',
      width: p.width + 'px', height: p.height + 'px',
    });
    box.className = 'va-draft-mark';
    layer.appendChild(box);
  }

  /* ---------- 标注交互 ---------- */
  const isQuoteMode = () => !!(state.binding && state.binding.capture === 'quote');

  /* ---------- 手动选择对象（picker） ---------- */
  const pickBox = el('div'); pickBox.className = 'va-pick-box'; pickBox.style.display = 'none';
  const pickHint = el('div', null, '移动鼠标选中图片 / 视频 / 正文，点击确定；Esc 取消');
  pickHint.className = 'va-pick-hint'; pickHint.style.display = 'none';
  uiRoot.append(pickBox, pickHint);

  function pickerMove(ev) {
    let target = null;
    try { target = document.elementFromPoint(ev.clientX, ev.clientY); } catch (e) {}
    const hit = target ? A.classify(target) : null;
    if (!hit) { pickBox.style.display = 'none'; pickHint.dataset.valid = '0'; pickHint.textContent = '此处不可标注；移动到图片 / 视频 / 正文上'; pickHint.style.display = 'block'; return; }
    const r = (hit.kind === 'article' ? hit.el : hit.el).getBoundingClientRect();
    pickBox.style.display = 'block';
    pickBox.style.left = r.left + 'px'; pickBox.style.top = r.top + 'px';
    pickBox.style.width = r.width + 'px'; pickBox.style.height = r.height + 'px';
    pickHint.dataset.valid = '1';
    pickHint.textContent = ({ video: '视频', image: '图片', article: '正文' })[hit.kind] + ' · 点击选中';
    pickHint.style.display = 'block';
  }
  function pickerClick(ev) {
    let target = null;
    try { target = document.elementFromPoint(ev.clientX, ev.clientY); } catch (e) {}
    const hit = target ? A.classify(target) : null;
    if (!hit) return;
    ev.preventDefault(); ev.stopPropagation();
    togglePicker(false);
    attach({ kind: hit.kind, el: hit.el });
    showToast('已选定' + ({ video: '视频', image: '图片', article: '正文' })[hit.kind]);
    // 图片/视频：选完直接进入标注模式，用户可立即拖框
    if (hit.kind !== 'article' && !isView()) toggleAnnotate(true);
  }
  function togglePicker(force) {
    const on = force != null ? force : !state.picking;
    state.picking = on;
    btnPick.classList.toggle('is-active', on);
    pickBox.style.display = 'none';
    pickHint.style.display = on ? 'block' : 'none';
    if (on) {
      // picker 期间 UI 让出指针，便于点到页面元素；同时压过站点光标（如 pexels 的放大镜）
      capture.style.pointerEvents = 'none';
      overlay.style.pointerEvents = 'none';
      setPageCursor('crosshair');
      document.addEventListener('mousemove', pickerMove, true);
      document.addEventListener('click', pickerClick, true);
      showToast('选择一个要标注的对象');
    } else {
      document.removeEventListener('mousemove', pickerMove, true);
      document.removeEventListener('click', pickerClick, true);
      setPageCursor('');
      overlay.style.pointerEvents = 'none';   // 恢复默认（overlay 本身不拦截）
      applyMode();
    }
  }

  // 用 !important 覆盖站点自身光标（否则 pexels 图片的 zoom-in 盖过我们的 crosshair）
  let cursorStyleEl = null;
  function setPageCursor(cursor) {
    if (!cursor) { if (cursorStyleEl) { cursorStyleEl.remove(); cursorStyleEl = null; } return; }
    if (!cursorStyleEl) {
      const host = document.head || document.documentElement;
      if (!host || !host.appendChild) return;   // 罕见环境无 head/documentElement 时跳过
      cursorStyleEl = document.createElement('style');
      cursorStyleEl.id = 'annota-cursor';
      host.appendChild(cursorStyleEl);
    }
    cursorStyleEl.textContent = 'html,body,*{cursor:' + cursor + ' !important}';
  }

  function toggleAnnotate(force) {
    if (!state.binding) { showToast('先点「选对象」选定要标注的图片 / 视频 / 正文'); return; }
    state.annotate = force != null ? force : !state.annotate;
    // 文章划词：不拦截指针（要能选字），改为听 mouseup 读选区
    const quote = isQuoteMode();
    capture.style.pointerEvents = (state.annotate && !quote) ? 'auto' : 'none';
    btnAnno.classList.toggle('is-active', state.annotate);
    if (state.annotate && state.binding) state.binding.beginAnnotate();
    if (quote) {
      capture.style.display = 'none';
      if (state.annotate) showToast('选中正文里的文字即可标注');
    } else {
      capture.style.display = 'block';
      // 标注模式也用 crosshair，压过站点光标（如 pexels 的放大镜）
      if (!state.picking) setPageCursor(state.annotate ? 'crosshair' : '');
    }
    render();
  }

  // 文章划词提交
  function handleQuoteSelection() {
    const b = state.binding;
    if (!b || b.capture !== 'quote' || !b.serializeSelection) return;
    const quote = b.serializeSelection();
    if (!quote) return;
    askWord(null, { quote, suggested: false });
  }
  document.addEventListener('mouseup', () => {
    if (!state.annotate || !isQuoteMode()) return;
    setTimeout(() => {
      if (uiRoot.querySelector('.va-popover[aria-label="新建标注"]')) return;   // 已开着编辑卡
      handleQuoteSelection();
    }, 0);
  });

  capture.addEventListener('pointerdown', (e) => {
    if (!state.annotate) return;
    if (state.binding) state.binding.beginAnnotate();
    state.dragging = true;
    state.draft = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    capture.setPointerCapture(e.pointerId);
  });
  capture.addEventListener('pointermove', (e) => {
    if (!state.dragging) return;
    state.draft.x1 = e.clientX; state.draft.y1 = e.clientY;
    drawDraft();
  });
  capture.addEventListener('pointerup', (e) => {
    if (!state.dragging) return;
    state.dragging = false;
    const b = G.dragToBox(state.draft.x0, state.draft.y0, e.clientX, e.clientY, state.cr);
    state.draft = null;
    if (b.w * b.h < 0.0009) { render(); return; }   // 太小的框忽略
    askWord(b);
  });

  function askWord(box, initial) {
    initial = initial || {};
    const quoteMode = !!initial.quote;
    // 弹窗定位：框标注用框左上角；划词用选区矩形；都给不出来则居中
    let p = null;
    if (quoteMode) {
      const gs = (typeof window !== "undefined" && window.getSelection) ? window.getSelection() : null; const sel = gs;
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        p = { left: r.left, top: r.bottom };
      }
    } else if (box && state.cr) {
      p = G.boxToPixels(box, state.cr);
    }
    const width = Math.min(360, innerWidth - 24);
    const pop = el('div');
    pop.className = 'va-popover' + (initial.suggested ? ' va-ai-proposal' : '');
    pop.dataset.vaPop = '1'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', '新建标注');
    pop.style.left = Math.max(12, Math.min((p ? p.left : innerWidth / 3), innerWidth - width - 12)) + 'px';
    pop.style.top = Math.max(12, Math.min((p ? p.top + 8 : innerHeight / 3), innerHeight - 410)) + 'px';

    const head = el('div'); head.className = 'va-pop-head';
    const heading = el('div'); heading.className = 'va-pop-heading';
    const eyebrow = el('div', null, initial.suggested ? 'AI SUGGESTION · REVIEW' : (quoteMode ? 'TEXT SELECTED' : 'REGION CAPTURED')); eyebrow.className = 'va-eyebrow';
    heading.append(eyebrow, el('strong', null, initial.suggested ? '确认 AI 标注' : '新建标注'),
      el('span', null, quoteMode ? '已选中正文文字；填写标题、评论或标签。' : '标题、评论、标签至少填一个，也都能稍后补。'));
    const close = mkIconButton('关闭编辑卡', 'close', () => pop.remove()); close.classList.add('va-close');
    head.append(heading, close);

    const wordLabel = el('label', null, '标题 / 词语'); wordLabel.className = 'va-field-label';
    const wIn = el('input'); wIn.className = 'va-input'; wIn.placeholder = '词、句子或标题（可留空）'; wIn.autocomplete = 'off'; wIn.maxLength = 120;
    wIn.value = initial.word || '';
    wIn.setAttribute('aria-label', '标题或词语（选填）');
    const label = el('label', null, '评论 / 备注（选填）'); label.className = 'va-field-label';
    const lIn = el('input'); lIn.className = 'va-input'; lIn.placeholder = '写下此处语境里的意思或你的批注'; lIn.maxLength = 300; lIn.value = initial.label || '';
    lIn.setAttribute('aria-label', '评论或备注（选填）');
    const detailRow = el('div', { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '9px', alignItems: 'end' });
    const tagWrap = el('label', { display: 'block' });
    const tagLabel = el('span', null, '标签'); tagLabel.className = 'va-field-label';
    const tagBox = el('div'); tagBox.className = 'va-tag-box';
    const tagInput = el('input'); tagInput.className = 'va-tag-input'; tagInput.placeholder = '回车添加标签'; tagInput.maxLength = 40; tagInput.setAttribute('aria-label', '标签');
    const presetRow = el('div'); presetRow.className = 'va-tag-presets';
    for (const p of ['英语学习', '雅思', '日语', '校对', '情报', '待复习']) { const c = mkbtn(p, () => addTag(p)); c.className = 'va-chip'; presetRow.appendChild(c); }
    tagWrap.append(tagLabel, tagBox, presetRow);
    let tagList = entryTags(initial).slice();
    function renderTags() {
      tagBox.textContent = '';
      for (const t of tagList) {
        const chip = el('span'); chip.className = 'va-tag-chip';
        const tx = el('span', null, '#' + t);
        const x = mkIconButton('移除标签 ' + t, 'close', (ev) => { if (ev) ev.stopPropagation(); tagList = tagList.filter((v) => v !== t); renderTags(); updateDictionary(); });
        x.classList.add('va-tag-x');
        chip.append(tx, x); tagBox.appendChild(chip);
      }
      tagBox.appendChild(tagInput);
    }
    function addTag(raw) {
      const t = String(raw || '').trim().replace(/^[#\s]+/, '');
      if (t && !tagList.includes(t) && tagList.length < 12) { tagList.push(t); renderTags(); updateDictionary(); }
      tagInput.value = '';
    }
    tagInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ',' || ev.key === '，') { ev.preventDefault(); ev.stopPropagation(); addTag(tagInput.value); } });
    renderTags();

    const timeLabel = el('label', null, '出现时间'); timeLabel.className = 'va-field-label';
    const timeRow = el('div'); timeRow.className = 'va-time-row';
    const tIn = el('input'); tIn.className = 'va-input'; tIn.type = 'number'; tIn.min = '0'; tIn.step = '0.1';
    const timed = !state.binding || state.binding.timed;
    const nowTime = () => (state.binding ? state.binding.time() : 0);
    tIn.value = String(r2(initial.t == null ? nowTime() : initial.t)); tIn.setAttribute('aria-label', '出现时间（秒）');
    const nowButton = mkbtn('用当前时间', () => { tIn.value = String(r2(nowTime())); });
    timeRow.append(tIn, nowButton);
    const durationLabel = el('label', null, '显示时长'); durationLabel.className = 'va-field-label';
    const dIn = el('input'); dIn.className = 'va-input'; dIn.type = 'number'; dIn.min = '0.2'; dIn.step = '0.1'; dIn.value = String(initial.dur || DEFAULT_DUR);
    dIn.setAttribute('aria-label', '显示时长（秒）');
    const durationWrap = el('label'); durationWrap.append(durationLabel, dIn);
    if (timed && !quoteMode) detailRow.append(tagWrap, durationWrap);
    else detailRow.append(tagWrap);
    const durChips = el('div'); durChips.className = 'va-duration';
    for (const seconds of [0.5, 1, 2, 3]) {
      const chip = mkbtn(seconds + 's', () => {
        dIn.value = String(seconds);
        durChips.querySelectorAll('.va-chip').forEach((n) => n.classList.toggle('is-active', n === chip));
      });
      chip.className = 'va-chip' + (seconds === Number(dIn.value) ? ' is-active' : '');
      durChips.appendChild(chip);
    }

    const dictionary = el('div'); dictionary.className = 'va-dictionary';
    const dictionaryLabel = el('span', null, '查词'); dictionaryLabel.className = 'va-dictionary-label';
    dictionary.appendChild(dictionaryLabel);
    // 默认词典链接模板：localStorage `annota:dictUrlTemplate`（含 {word} 占位，须 http(s)）；隐私模式读取可能抛，回退剑桥
    const dictTemplate = (function () {
      try {
        const v = appSettings.dictUrlTemplate || localStorage.getItem('annota:dictUrlTemplate');
        if (v && v.indexOf('{word}') >= 0 && isHttp(v)) return v;
      } catch (e) {}
      return 'https://dictionary.cambridge.org/dictionary/english/{word}';
    })();
    const dictLinks = [
      ['查词', (word) => dictTemplate.replace('{word}', encodeURIComponent(word))],
      ['有道', (word) => 'https://www.youdao.com/result?word=' + encodeURIComponent(word) + '&lang=en'],
      ['欧路', (word) => 'https://dict.eudic.net/dicts/en/' + encodeURIComponent(word)],
    ].map(([name, href]) => {
      const a = el('a', null, name); a.href = href(''); a.target = '_blank'; a.rel = 'noopener noreferrer'; a.dataset.dict = name; a.dataset.template = '1';
      a.addEventListener('click', (ev) => { if (!wIn.value.trim()) { ev.preventDefault(); wIn.focus(); } });
      dictionary.appendChild(a); return { a, href };
    });
    function updateDictionaryLinks() { for (const d of dictLinks) d.a.href = d.href(wIn.value.trim()); }
    // 词典按标签触发：出现语言学习类标签（英语/日语/雅思…）才显示查词外链
    function updateDictionary() { updateDictionaryLinks(); dictionary.style.display = tagList.some(isLangTag) ? '' : 'none'; }
    wIn.addEventListener('input', updateDictionary);
    updateDictionary();

    const actions = el('div'); actions.className = 'va-pop-actions';
    const cancel = mkbtn('取消', () => pop.remove());
    const saveButton = mkbtn(initial.suggested ? '确认并保存' : '保存并继续播放', commit); saveButton.classList.add('va-btn-primary');
    actions.append(cancel, saveButton);
    pop.append(head, wordLabel, wIn, label, lIn);
    if (quoteMode) {
      const q = initial.quote || {};
      const qLabel = el('label', null, '锚定文字'); qLabel.className = 'va-field-label';
      const qBox = el('div', null, (q.exact || '').slice(0, 160) + ((q.exact || '').length > 160 ? '…' : ''));
      qBox.className = 'va-quote-preview';
      pop.append(qLabel, qBox);
    }
    pop.append(detailRow);
    if (timed && !quoteMode) pop.append(timeLabel, timeRow, durChips);
    pop.append(dictionary, actions);
    wIn.addEventListener('input', () => wIn.removeAttribute('aria-invalid'));

    function commit() {
      if (tagInput.value.trim()) addTag(tagInput.value);
      const word = wIn.value.trim();
      const label2 = lIn.value.trim();
      const tags = tagList.slice();
      if (!word && !label2 && !tags.length) { wIn.focus(); wIn.setAttribute('aria-invalid', 'true'); showToast('标题、评论、标签至少填一个'); return; }
      const nowIso = new Date().toISOString();
      const entry = {
        id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        word, label: label2, tags,
        created: nowIso, updated: nowIso,
      };
      // 身份署名（R4a）：本地密钥对生成的 creator（离线可用，无账号）
      if (window.VAIdentity) entry.creator = window.VAIdentity.creatorSync(appSettings.profile && appSettings.profile.name);
      if (quoteMode && initial.quote) entry.quote = initial.quote;
      else entry.box = box;
      if (timed && !quoteMode) {
        entry.t = Math.max(0, r2(parseFloat(tIn.value)));
        entry.dur = Math.max(0.2, r2(parseFloat(dIn.value) || DEFAULT_DUR));
      }
      // 图片：记录锚定证据，供跨尺寸/换图时校验（Step 6.3）
      if (state.binding && state.binding.kind === 'image' && state.binding.el) {
        const el2 = state.binding.el;
        entry.img = { key: el2.currentSrc || el2.src || '', natural: { w: el2.naturalWidth, h: el2.naturalHeight } };
      }
      state.entries.push(entry);
      state.displayVersion = 'local';   // 本地新建 → 之后同步应推本地
      save(); pop.remove(); render();
      if (state.binding) state.binding.endAnnotate();
      const s = (typeof window !== "undefined" && window.getSelection) ? window.getSelection() : null; if (s && s.removeAllRanges) s.removeAllRanges();
      showToast('已保存标注 · ' + entryText(entry));
    }
    pop.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); pop.remove(); }
      else if (ev.key === 'Enter' && ev.target !== nowButton) { ev.preventDefault(); commit(); }
    });
    uiRoot.appendChild(pop);
    if (innerWidth > 620) {
      const popRect = pop.getBoundingClientRect();
      if (popRect.bottom > innerHeight - 12) pop.style.top = Math.max(12, innerHeight - popRect.height - 12) + 'px';
    }
    wIn.focus({ preventScroll: true });
  }

  // Agent/MCP 只能把候选区域送进确认卡；用户点击保存后才写入标注。
  window.__ANNOTA_UI__ = {
    openPanel: () => togglePanel(true),
    closePanel: () => togglePanel(false),
    startAnnotating: () => toggleAnnotate(true),
    proposeAnnotation(payload) {
      if (!state.binding || !payload) return false;
      // 文章：quote 锚点
      if (payload.quote && payload.quote.exact) {
        const quote = {
          exact: String(payload.quote.exact),
          prefix: payload.quote.prefix != null ? String(payload.quote.prefix) : '',
          suffix: payload.quote.suffix != null ? String(payload.quote.suffix) : '',
        };
        state.binding.beginAnnotate(); toggleAnnotate(false);
        askWord(null, { ...payload, quote, suggested: true });
        return true;
      }
      // 视频/图片：box
      if (!payload.box) return false;
      const values = ['x', 'y', 'w', 'h'].map((k) => Number(payload.box[k]));
      if (!values.every(Number.isFinite)) return false;
      const box = G.clampBox({ x: values[0], y: values[1], w: values[2], h: values[3] });
      state.binding.beginAnnotate(); toggleAnnotate(false);
      askWord(box, { ...payload, suggested: true });
      return true;
    },
  };

  function openEntryPop(e, x, y) {
    if (state.binding) state.binding.beginAnnotate();
    const timed = !state.binding || state.binding.timed;
    const pop = el('div'); pop.className = 'va-popover'; pop.dataset.vaPop = '1';
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', '标注详情');
    pop.style.left = Math.max(12, Math.min((Number(x) || 0) + 10, innerWidth - 372)) + 'px';
    pop.style.top = Math.max(12, Math.min((Number(y) || 0) + 10, innerHeight - 430)) + 'px';
    const dur = e.dur || DEFAULT_DUR;
    const head = el('div'); head.className = 'va-pop-head';
    const heading = el('div'); heading.className = 'va-pop-heading';
    const eyebrow = el('div', null, 'ANNOTATION'); eyebrow.className = 'va-eyebrow';
    heading.append(eyebrow, el('strong', null, entryText(e)), el('span', null, (e.label || '未添加备注') + (entryTags(e).length ? ' · ' + entryTags(e).map((t) => '#' + t).join(' ') : '')));
    const close = mkIconButton('关闭词条详情', 'close', () => pop.remove()); close.classList.add('va-close');
    head.append(heading, close);
    const range = el('div'); range.className = 'va-range';
    pop.append(head, range);

    const tIn = el('input'); tIn.className = 'va-input'; tIn.type = 'number'; tIn.min = '0'; tIn.step = '0.1'; tIn.value = String(e.t); tIn.setAttribute('aria-label', '开始时间（秒）');
    const dIn = el('input'); dIn.className = 'va-input'; dIn.type = 'number'; dIn.min = '0.2'; dIn.step = '0.1'; dIn.value = String(dur); dIn.setAttribute('aria-label', '显示时长（秒）');
    const updRange = () => {
      if (timed) {
        const start = Math.max(0, parseFloat(tIn.value) || 0);
        range.textContent = formatTime(start) + ' – ' + formatTime(start + (parseFloat(dIn.value) || dur));
      } else if (e.quote && e.quote.exact) {
        range.textContent = '“' + e.quote.exact.slice(0, 80) + (e.quote.exact.length > 80 ? '…”' : '”');
      } else {
        range.textContent = state.binding && state.binding.kind === 'article' ? '整段文字' : '静态图片标注';
      }
    };
    tIn.addEventListener('input', updRange); dIn.addEventListener('input', updRange);
    const dictionary = el('div'); dictionary.className = 'va-dictionary';
    const dictLabel = el('span', null, '查词'); dictLabel.className = 'va-dictionary-label'; dictionary.appendChild(dictLabel);
    for (const [name, href] of [
      ['剑桥', 'https://dictionary.cambridge.org/dictionary/english/' + encodeURIComponent(e.word || '')],
      ['有道', 'https://www.youdao.com/result?word=' + encodeURIComponent(e.word || '') + '&lang=en'],
      ['欧路', 'https://dict.eudic.net/dicts/en/' + encodeURIComponent(e.word || '')],
    ]) {
      const a = el('a', null, name); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; dictionary.appendChild(a);
    }
    if (!entryTags(e).some(isLangTag)) dictionary.style.display = 'none';
    pop.appendChild(dictionary);

    if (isView() || e.__group) {   // 只读 / 组来源（他人标注）：不可编辑删除（组条目是拷贝，改删会假成功）
      const actions = el('div'); actions.className = 'va-pop-actions';
      if (e.__group) { const who = el('span', null, '组内标注 · ' + (e.__author || '成员')); who.className = 'va-src-name'; pop.append(who); }
      actions.append(mkbtn('跳转到画面', () => { if (state.binding) state.binding.locate(e); pop.remove(); }), mkbtn('关闭', () => pop.remove()));
      if (timed) pop.append(el('div', null, formatTime(e.t) + ' · 显示 ' + dur + ' 秒'), actions);
      else pop.append(actions);
      uiRoot.appendChild(pop);
      return;
    }

    const wordInput = el('input'); wordInput.className = 'va-input'; wordInput.value = e.word || ''; wordInput.placeholder = '词、句子或标题（可留空）'; wordInput.setAttribute('aria-label', '标题或词语');
    const labelInput = el('input'); labelInput.className = 'va-input'; labelInput.value = e.label || ''; labelInput.placeholder = '评论 / 备注（选填）'; labelInput.setAttribute('aria-label', '评论或备注');
    const tagsInput = el('input'); tagsInput.className = 'va-input'; tagsInput.value = entryTags(e).join(' '); tagsInput.placeholder = '标签，空格或逗号分隔'; tagsInput.setAttribute('aria-label', '标签');
    const timeLabel = el('label', null, '出现时间'); timeLabel.className = 'va-field-label';
    const timeRow = el('div'); timeRow.className = 'va-time-row';
    const now = mkbtn('用当前时间', () => { tIn.value = state.binding ? String(r2(state.binding.time())) : String(e.t); updRange(); });
    timeRow.append(tIn, now);
    const durationLabel = el('label', null, '显示时长'); durationLabel.className = 'va-field-label';
    const actions = el('div'); actions.className = 'va-pop-actions';
    const jump = mkbtn('跳转', () => { if (state.binding) state.binding.seek(parseFloat(tIn.value) || e.t); pop.remove(); });
    const remove = mkbtn('删除', () => { state.entries = state.entries.filter((item) => item !== e); state.displayVersion = 'local'; save(); pop.remove(); render(); showToast('已删除标注'); });
    remove.classList.add('va-btn-danger');
    const saveButton = mkbtn('保存修改', () => {
      const word = wordInput.value.trim();
      const label2 = labelInput.value.trim();
      const tags = tagsInput.value.split(/[\s,，]+/).map((t) => t.replace(/^[#\s]+/, '').trim()).filter(Boolean).slice(0, 12);
      if (!word && !label2 && !tags.length) { wordInput.focus(); showToast('标题、评论、标签至少填一个'); return; }
      e.word = word; e.label = label2; e.tags = tags;
      e.updated = new Date().toISOString();
      if (window.VAIdentity && !e.creator) e.creator = window.VAIdentity.creatorSync(appSettings.profile && appSettings.profile.name);
      state.displayVersion = 'local';   // 本地修改 → 之后同步应推本地
      if (timed) {
        e.t = Math.max(0, r2(parseFloat(tIn.value)));
        e.dur = Math.max(0.2, r2(parseFloat(dIn.value) || DEFAULT_DUR));
      }
      save(); render(); pop.remove(); showToast('标注已更新');
    });
    saveButton.classList.add('va-btn-primary');
    if (timed) actions.append(jump);
    actions.append(remove, saveButton);
    pop.append(el('label', null, '标题 / 词语（选填）'), wordInput, el('label', null, '评论 / 备注（选填）'), labelInput, el('label', null, '标签'), tagsInput);
    if (timed) pop.append(timeLabel, timeRow, durationLabel, dIn);
    pop.append(actions);
    pop.querySelectorAll('.va-popover > label').forEach((n) => { n.className = 'va-field-label'; });
    updRange();
    uiRoot.appendChild(pop);
    wordInput.focus({ preventScroll: true });
  }

  /* ---------- 同步 ---------- */
  const SYNC_URL_KEY = 'va:syncUrl';
  const DEFAULT_SYNC = 'http://127.0.0.1:8793';
  let syncBase = (function () { try { return localStorage.getItem(SYNC_URL_KEY) || null; } catch (e) { return null; } })();

  // 构建时烧入的候选地址（本机 127.0.0.1 / 局域网 IP / .local），运行期自动探测，零配置
  function syncCandidates() {
    const a = (window.VA_SYNC_URLS && window.VA_SYNC_URLS.length) ? window.VA_SYNC_URLS.slice() : [];
    if (a.indexOf(DEFAULT_SYNC) < 0) a.push(DEFAULT_SYNC);
    return a.map((u) => String(u).replace(/\/+$/, ''));
  }
  function syncUrl() { return (syncBase || syncCandidates()[0]).replace(/\/+$/, ''); }

  // 只允许 http(s)（挡掉 javascript:/data:/file: 等，防标注数据被外发到意外 scheme）
  function isHttp(u) { return /^https?:\/\//i.test(String(u || '')); }
  function setSyncBase(u) {
    u = (u || '').trim().replace(/\/+$/, '');
    if (!u) return;
    if (!isHttp(u)) { setSyncStatus('同步地址必须是 http(s)://'); return; }
    syncBase = u;
    try { localStorage.setItem(SYNC_URL_KEY, u); } catch (e) {}
  }
  async function resolveBase() {
    if (syncBase) return syncBase.replace(/\/+$/, '');
    for (const u of syncCandidates()) {
      if (!isHttp(u)) continue;
      try { const r = await httpJson('GET', u + '/api/health'); if (r.ok && r.json && r.json.ok) { syncBase = u; return u; } } catch (e) {}
    }
    return syncUrl();
  }

  function mediaMeta() {
    if (state.binding) return state.binding.mediaMeta();
    return {
      platform: state.platform, type: 'video', mediaId: state.mediaId, videoId: state.mediaId,
      url: location.href, title: document.title,
    };
  }
  function pack() { return { format: FORMAT, media: mediaMeta(), entries: state.entries }; }
  // 推送包：本地为主 → replace=true，服务器以本次推送为准（云存储/分享/公开）
  function pushPack() { return { format: FORMAT, media: mediaMeta(), entries: state.entries, replace: true }; }

  function validBox(b) {
    return b && typeof b === 'object' &&
      ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(b[k]));
  }
  function validQuote(q) {
    if (!q || typeof q !== 'object') return false;
    const exact = typeof q.exact === 'string' ? q.exact.trim() : '';
    return !!exact;   // quote 只需非空 exact；prefix/suffix 可选
  }
  // box 与 quote 二选一即可（文章 = quote，视频/图片 = box）
  function validAnchor(e) { return validBox(e && e.box) || validQuote(e && e.quote); }
  // 通用批注：word 可空，标签/备注至少一个（§8.3 A）
  function entryTags(e) { return Array.isArray(e && e.tags) ? e.tags.filter(Boolean).map(String) : []; }
  function entryHasContent(e) {
    return !!(String((e && e.word) || '').trim() || entryTags(e).length || String((e && e.label) || '').trim());
  }
  function entryText(e) {
    if (!e) return '';
    const w = String(e.word || '').trim();
    if (w) return w;
    const tags = entryTags(e);
    if (tags.length) return tags[0];
    const label = String(e.label || '').trim();
    return label ? label.slice(0, 40) : '标注';
  }
  const LANG_TAGS = ['英语', '英文', '日语', '法语', '德语', '西班牙语', '韩语', '俄语',
    '雅思', '托福', '考研', '四六级', '专四', '专八', '英语学习', '语言学习'];
  function isLangTag(t) { t = String(t || ''); return LANG_TAGS.includes(t) || /语$/.test(t) || /^(英语|日语|法语|德语|韩语|西班牙|俄语|葡萄牙)/.test(t); }
  function tagKey(e) { return entryTags(e).map((t) => String(t).toLowerCase()).sort().join(','); }
  function sameEntry(e, o) {
    if ((e.word || '') !== (o.word || '')) return false;
    // 无词条目：备注 + 标签共同区分（纯标签标注不被误并）
    if (!e.word || !o.word) {
      if (String(e.label || '') !== String(o.label || '')) return false;
      if (tagKey(e) !== tagKey(o)) return false;
    }
    const eb = validBox(e.box), ob = validBox(o.box);
    const eq = validQuote(e.quote), oq = validQuote(o.quote);
    if (eb && ob) {
      if (Math.abs((Number(e.t) || 0) - (Number(o.t) || 0)) >= 0.4) return false;
      return G.iou(e.box, o.box) > 0.6;
    }
    if (eq && oq) return e.quote.exact === o.quote.exact;   // 文本锚点：同一段文字即同一标注
    return false;
  }
  function validEntries(list) {
    return (Array.isArray(list) ? list : []).filter((e) => {
      if (!e || !validAnchor(e) || !entryHasContent(e)) return false;  // 锚点 + 至少一个要素（词/标签/备注）
      if (!e.id) e.id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      return true;
    });
  }
  function mergeLocal(a, b) {
    const out = validEntries(a);
    for (const e of validEntries(b)) {
      if (out.some((o) => sameEntry(e, o))) continue;
      out.push(e);
    }
    return out;
  }

  // 统一 HTTP：优先级 vaFetch(自建浏览器壳) > chrome(扩展) > GM_xmlhttpRequest > fetch。前两者不受页面 CORS/混合内容限制
  // 直连 fetch（最后兜底；https→http 局域网会被拦，但同源/同协议可用）
  function fetchJson(method, url, body) {
    return fetch(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json().catch(() => null) }));
  }

  function viaExtChannel(method, url, body) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
      // Safari 等「假 chrome 对象」环境：sendMessage 可能抛错或永远不回 → 3s 超时后让调用方回退
      let chromeId = '';
      try { chromeId = (chrome.runtime && chrome.runtime.id) || ''; } catch (e) { chromeId = ''; }
      try {
        chrome.runtime.sendMessage({ type: 'va-fetch', method, url, body }, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) return finish(reject, new Error('扩展通道：' + err.message));
          if (!resp) return finish(reject, new Error('扩展通道无响应（后台未响应；Safari/非本扩展环境请用 GM 变体脚本）'));
          finish(resolve, resp);
        });
      } catch (e) {
        return finish(reject, new Error('扩展通道调用异常：' + (e && e.message)));
      }
      setTimeout(() => finish(reject, new Error('扩展通道超时（id=' + (chromeId || '?') + '）')), 3000);
    });
  }

  function gmAvailable() {
    return (typeof GM_xmlhttpRequest === 'function' && GM_xmlhttpRequest) ||
      (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function' && GM.xmlHttpRequest.bind(GM));
  }

  // 有 GM 就用 GM（Safari 的 Userscripts/Stay 走这条，能绕过混合内容）；否则先试扩展通道，失败回退 fetch
  function httpJson(method, url, body) {
    if (typeof window !== 'undefined' && typeof window.vaFetch === 'function') {
      return window.vaFetch(method, url, body);
    }
    const gm = gmAvailable();
    if (gm) {
      return new Promise((resolve, reject) => {
        gm({
          method, url, headers: { 'Content-Type': 'application/json' },
          data: body ? JSON.stringify(body) : undefined, timeout: 15000,
          onload: (res) => {
            let j = null;
            try { j = res.responseText ? JSON.parse(res.responseText) : null; } catch (e) {}
            resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, json: j });
          },
          onerror: () => reject(new Error('网络错误（GM 通道）')),
          ontimeout: () => reject(new Error('超时')),
        });
      });
    }
    // 无 GM、非自建浏览器：优先扩展后台（能绕 CORS/混合内容），失败则直连 fetch
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      return viaExtChannel(method, url, body).catch(() => fetchJson(method, url, body));
    }
    return fetchJson(method, url, body);
  }

  function cacheAppSettings() {
    try { localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(appSettings)); } catch (e) {}
  }
  function applyAppSettings(value, fromService) {
    const wasAuto = AUTO_SYNC;
    appSettings = mergeAppSettings(value);
    shortcuts = appSettings.shortcuts;
    AUTO_SYNC = !!window.VA_AUTO_SYNC || VIEW_ONLY || appSettings.sync.auto;
    cacheAppSettings();
    if (fromService) {
      if (appSettings.sync.address) {
        syncBase = appSettings.sync.address;
        try { localStorage.setItem(SYNC_URL_KEY, syncBase); } catch (e) {}
      } else {
        syncBase = null;
        try { localStorage.removeItem(SYNC_URL_KEY); } catch (e) {}
      }
    }
    if (!wasAuto && AUTO_SYNC) scheduleAutoSync();
  }
  function settingsBases() {
    const bases = [];
    // Tauri's local Rust service owns global settings; don't let a previously
    // selected remote sync server shadow this endpoint.
    if (typeof window.vaFetch === 'function') bases.push(DEFAULT_SYNC);
    if (syncBase) bases.push(syncBase);
    bases.push(...syncCandidates());
    return [...new Set(bases.map((base) => String(base).replace(/\/+$/, '')))];
  }
  async function loadAppSettings() {
    for (const base of settingsBases()) {
      try {
        const response = await httpJson('GET', base + '/api/settings');
        if (response.ok && response.json && response.json.settings) {
          applyAppSettings(response.json.settings, true);
          return;
        }
      } catch (e) { /* standalone Python/third-party sync servers may not expose settings */ }
    }
  }
  async function persistAppSettings() {
    cacheAppSettings();
    for (const base of settingsBases()) {
      try {
        const response = await httpJson('PUT', base + '/api/settings', appSettings);
        if (response.ok) return true;
      } catch (e) { /* try the next configured server */ }
    }
    return false; // per-page cache remains available offline
  }

  const SYNC_HINT = '\n· 电脑上是否在跑「同步服务」？python3 dev/hub.py 会一并启动' +
    '\n· 手机在 https 页面访问 http 局域网地址会被浏览器按混合内容拦截 → 用 GM 变体脚本（一键安装页可选）';

  async function testSync() {
    setSyncStatus('测试中…');
    try {
      const base = await resolveBase();
      const r = await httpJson('GET', base + '/api/health');
      setSyncStatus((r.ok && r.json && r.json.ok) ? '同步可用 ✓ ' + base : '同步异常 HTTP ' + r.status);
    } catch (e) { setSyncStatus('连不上：' + e.message); }
  }

  // ---- 显示：只读选版（不写数据）。同步：以本地为主推到服务器（云存储/分享/公开，非双向 union） ----
  function coverPref(mediaId) {
    try { return localStorage.getItem(OVERRIDE_PREFIX + mediaId); } catch (e) { return null; }   // 'server' | 'local' | null
  }
  function setCoverPref(mediaId, v) { try { localStorage.setItem(OVERRIDE_PREFIX + mediaId, v); } catch (e) {} }

  // 弹窗骨架：带 Esc / 点击外部关闭，close() 只会 resolve 一次（默认值由调用方给）
  function makeChoiceDialog(label, buildBody, onPick) {
    return new Promise((resolve) => {
      const pop = el('div'); pop.className = 'va-popover va-sync-choice';
      pop.style.left = '50%'; pop.style.transform = 'translateX(-50%)'; pop.style.top = '18px';
      pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', label);
      let done = false;
      const close = (value) => { if (done) return; done = true; document.removeEventListener('keydown', onKey, true); uiRoot.removeEventListener('pointerdown', onOutside, true); pop.remove(); resolve(value); };
      const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(onPick.dismiss); } };
      const onOutside = (ev) => { if (!pop.contains(ev.target)) close(onPick.dismiss); };
      buildBody(pop, close);
      document.addEventListener('keydown', onKey, true);
      setTimeout(() => uiRoot.addEventListener('pointerdown', onOutside, true), 0);
      uiRoot.appendChild(pop);
    });
  }

  // 冲突弹窗：两个确定性选项。Esc/点外部 = 默认看服务器版（不改数据，最安全）
  function chooseVersion({ serverEntries, cached }) {
    return makeChoiceDialog('选择要显示的版本', (pop, close) => {
      const head = el('div'); head.className = 'va-pop-head';
      const heading = el('div'); heading.className = 'va-pop-heading';
      heading.append(el('div', null, 'SYNC'), el('strong', null, '两版不一致，先看哪一版？'),
        el('span', null, '服务器 ' + serverEntries.length + ' 条 · 本地 ' + cached.length + ' 条。选版本只影响显示，不改数据。'));
      head.append(heading);
      const acts = el('div'); acts.className = 'va-pop-actions';
      const bLocal = mkbtn('看本地版（离线修改）', () => close('local'));
      const bServer = mkbtn('看服务器版', () => close('server'));
      bLocal.classList.add('va-btn-primary');
      acts.append(bLocal, bServer);
      pop.append(head, acts);
    }, { dismiss: 'server' });
  }

  // 打开媒体时：只处理「显示」，不写不对齐。覆盖本地要用户选，可记忆。
  async function reconcileOnOpen(mediaId) {
    if (!state.mediaId || state.mediaId !== mediaId) return;   // 已切走
    let serverEntries = null;
    try {
      const base = await resolveBase();
      const g = await httpJson('GET', base + '/api/anno/' + encodeURIComponent(mediaId));
      if (g.ok) serverEntries = validEntries((g.json && g.json.entries) || []);
    } catch (e) { return; }   // 离线：维持本地缓存显示
    if (!serverEntries) return;
    if (!state.mediaId || state.mediaId !== mediaId) return;

    const cached = loadCached(mediaId);
    const fpCached = fingerprint(cached);
    const localDraft = hasLocalDraft(mediaId, cached);
    const serverNewer = fingerprint(serverEntries) !== (syncMeta(mediaId) ? syncMeta(mediaId).fp : fpCached);
    const differ = fingerprint(serverEntries) !== fpCached;

    if (!differ) {                                   // 完全一致：对齐标记即可
      setSyncMeta(mediaId, serverEntries); return;
    }
    if (localDraft) {                                // 本地有未同步离线改动 → 选显示哪版
      const choice = await chooseVersion({ serverEntries, cached });
      // 弹窗期间用户若又改了本地（缓存与快照不一致）→ 放弃本次显示覆盖，保住在途编辑
      if (loadCached(mediaId) !== cached && fingerprint(loadCached(mediaId)) !== fpCached) return;
      state.entries = choice === 'local' ? cached : serverEntries;
      state.displayVersion = choice;
      save(); render(); renderPanel();
    } else if (serverNewer) {                         // 本地没动、服务器更新
      // 快照与当前缓存一致才动；否则说明期间有本地写入
      if (fingerprint(loadCached(mediaId)) !== fpCached) return;
      state.entries = serverEntries; state.displayVersion = 'server';
      save(); render(); renderPanel();
      const pref = coverPref(mediaId);
      if (pref === 'server') { setSyncMeta(mediaId, serverEntries); }
      else if (pref !== 'local') {                    // 未记忆过 → 询问是否覆盖本地
        const cover = await confirmCover(mediaId);
        if (cover) setSyncMeta(mediaId, serverEntries);
      }
    } else {
      setSyncMeta(mediaId, serverEntries);
    }
  }

  // Esc/点外部 = 保留本地版（不覆盖，最安全）
  function confirmCover(mediaId) {
    return makeChoiceDialog('是否用服务器版覆盖本地', (pop, close) => {
      const cb = el('input'); cb.type = 'checkbox';
      const done = (cover) => { if (cb.checked) setCoverPref(mediaId, cover ? 'server' : 'local'); close(cover); };
      const head = el('div'); head.className = 'va-pop-head';
      const heading = el('div'); heading.className = 'va-pop-heading';
      heading.append(el('div', null, 'SYNC'), el('strong', null, '服务器有新版本'),
        el('span', null, '当前已显示服务器版。要把本地缓存也更新为服务器版吗？'));
      head.append(heading);
      const remember = el('label', null); remember.className = 'va-remember';
      const tx = el('span', null, '可选，以后不再询问');
      remember.append(cb, tx);
      const acts = el('div'); acts.className = 'va-pop-actions';
      const bCover = mkbtn('用服务器版覆盖本地', () => done(true)); bCover.classList.add('va-btn-primary');
      const bKeep = mkbtn('保留本地版', () => done(false));
      acts.append(bCover, bKeep);
      pop.append(head, remember, acts);
    }, { dismiss: false });
  }

  // 同步 = 把「当前显示的这版」推到服务器（本地为主）；服务器是云存储/分享/公开
  async function syncNow() {
    if (!state.mediaId) return;
    setSyncStatus('同步中…');
    try {
      const base = await resolveBase();
      const url = base + '/api/anno/' + encodeURIComponent(state.mediaId);
      const meta = syncMeta(state.mediaId);
      const aligned = !!meta && meta.fp === fingerprint(state.entries);   // 本视图是否已知与服务端一致
      if (state.displayVersion === 'server') {         // 当前显示服务器版 → 拉下来作为本地
        const g = await httpJson('GET', url);
        if (!g.ok) throw new Error('HTTP ' + g.status);
        state.entries = validEntries((g.json && g.json.entries) || []);
        setSyncMeta(state.mediaId, state.entries);
        save(); render();
        setSyncStatus('已对齐服务器版 · ' + state.entries.length + ' 条');
        return;
      }
      // 本地为主推送。未与服务器确认对齐时不能整包替换（会删掉别处写入、本机没拉到的条目）→ 只做增量合并推送。
      const payload = aligned ? pushPack() : pack();
      const p = await httpJson('PUT', url, payload);
      if (!p.ok) throw new Error('HTTP ' + p.status);
      const pushed = validEntries((p.json && p.json.entries) || state.entries);
      state.entries = pushed;
      state.displayVersion = 'local';
      setSyncMeta(state.mediaId, pushed);
      save(); render();
      setSyncStatus((aligned ? '已同步到服务器 · ' : '已合并推送到服务器 · ') + state.entries.length + ' 条');
    } catch (e) {
      setSyncStatus('同步失败：' + e.message);
      alert('同步失败：' + e.message + SYNC_HINT);
    }
  }

  async function downloadSync() {
    if (!state.mediaId) return;
    setSyncStatus('下载中…');
    try {
      const base = await resolveBase();
      const r = await httpJson('GET', base + '/api/anno/' + encodeURIComponent(state.mediaId));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      state.entries = validEntries((r.json && r.json.entries) || state.entries);
      state.displayVersion = 'server';
      save(); render();
      setSyncStatus('已载入服务器版 · ' + state.entries.length + ' 条');
    } catch (e) { setSyncStatus('下载失败：' + e.message); alert('下载失败：' + e.message + SYNC_HINT); }
  }

  /* ---------- 导入导出 ---------- */
  function exportJSON() {
    const blob = new Blob([JSON.stringify(pack(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'annotate_' + state.mediaId.replace(/[^\w.-]+/g, '_') + '.json';
    a.click();
  }

  function importJSON() {
    const f = document.createElement('input');
    f.type = 'file'; f.accept = '.json,application/json';
    f.onchange = () => {
      const file = f.files[0]; if (!file) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const obj = JSON.parse(rd.result);
          const inc = (obj && obj.entries) || (Array.isArray(obj) ? obj : []);
          const before = state.entries.length;
          state.entries = mergeLocal(state.entries, inc);
          state.displayVersion = 'local';
          save(); render();
          alert('导入完成：新增 ' + (state.entries.length - before) + ' 条（合并后 ' + state.entries.length + '）');
        } catch (err) { alert('导入失败：' + err.message); }
      };
      rd.readAsText(file);
    };
    f.click();
  }

  function clearAll() {
    if (!state.entries.length) return;
    if (!confirm('清空本视频的 ' + state.entries.length + ' 条标注？')) return;
    state.entries = []; state.displayVersion = 'local'; save(); render();
  }

  function updateStatus() {
    statusText.textContent = state.entries.length ? state.entries.length + ' 条标注' : '就绪';
    status.dataset.state = 'ready';
  }

  function decodeExportIntent(hash) {
    const match = String(hash || '').match(/(?:^#|&)annota-export=([A-Za-z0-9_-]+)/);
    if (!match) return null;
    try {
      const encoded = match[1].replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(encoded + '='.repeat((4 - encoded.length % 4) % 4));
      const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
      const intent = JSON.parse(new TextDecoder().decode(bytes));
      return intent && typeof intent === 'object' ? intent : null;
    } catch (e) { return null; }
  }

  let pendingExportIntent = decodeExportIntent(location.hash);
  if (pendingExportIntent) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }

  const coreApi = {
    state,
    binding: () => state.binding,
    entries: () => state.entries,
    mediaMeta,
    renderOnly,
    render,
    setChromeHidden,
    save,
    captureFrame,
    videoRect,
    resolveBase,
    httpJson,
    setSyncStatus,
    showToast,
    uiRoot,
    mergePack: (a, b) => mergeLocal(a, b),   // 组同步复用同一合并规则
    validEntries,
    fingerprint,
  };
  try {
    if (window.VAExport && typeof window.VAExport.install === 'function') window.VAExport.install(coreApi);
  } catch (e) { /* Export UI must never interrupt annotation startup. */ }
  try {
    if (window.VAGroup && typeof window.VAGroup.install === 'function') window.VAGroup.install(coreApi);
  } catch (e) { /* Group layer must never interrupt annotation startup. */ }

  /* ---------- 启动 ---------- */
  loadAppSettings();
  try { if (window.VAIdentity) window.VAIdentity.warmup({ name: appSettings.profile && appSettings.profile.name }); } catch (e) {}
  try { if (window.VAVersion) window.VAVersion.check(); } catch (e) {}   // 版本探测：落后则提示重装
  mountShell();   // 即使页面无可自动绑定的媒态，也保留 dock（含「选对象」）
  A.watch((v) => {
    if (v) {
      attach(v);
      if (pendingExportIntent && window.__ANNOTA_EXPORT__) {
        const intent = pendingExportIntent;
        pendingExportIntent = null;
        try { window.__ANNOTA_EXPORT__.start(intent); } catch (e) { showToast('批量导出启动失败'); }
      }
    } else detachBinding();
  });
})();
