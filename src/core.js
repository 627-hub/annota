/* video-annotate · core (P0)
 * 叠层 + 拖框 + 绑词 + 本地存储 + 导入导出。平台无关，依赖 VAGeo / VAAdapter。
 */
(function () {
  'use strict';
  if (window.__VA_LOADED__) return;
  window.__VA_LOADED__ = true;

  const G = window.VAGeo, A = window.VAAdapter;
  const ADAPTER_ERRORS = [];
  if (A) A._err = (e) => { ADAPTER_ERRORS.push(String((e && e.message) || e).slice(0, 80)); if (ADAPTER_ERRORS.length > 20) ADAPTER_ERRORS.shift(); };
  const DEFAULT_DUR = 1.0;                // 每个标注框默认时长(秒)
  const LEAD = 0.15;                      // 提前浮现(秒)
  const ICON_PATHS = {
    brand: '<path d="M4.5 19 12 5l7.5 14M8.2 13.2h7.6"/>',
    crosshair: '<circle cx="12" cy="12" r="7.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
    eye: '<path d="M2.5 12s3.2-6 9.5-6 9.5 6 9.5 6-3.2 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.6"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    sync: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.7-2L20 12M4 12l2.7 5a7 7 0 0 0 11.7-2"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.2 4.2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.3 2"/>',
    dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
    box: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h5"/>',
    book: '<path d="M5 4.5h11a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3v-12Z"/><path d="M5 16.5a3 3 0 0 1 3-3h11"/>'
  };

  // 词库索引（build_vocab.py 内联）与联想
  const VOCAB = window.VA_VOCAB || [];
  const VINDEX = (window.VASearch && VOCAB.length) ? window.VASearch.makeIndex(VOCAB) : null;

  // 观看端：只读（隐藏标注/编辑），可自动同步。构建时烧入或 ⚙ 里切换。
  const VIEW_ONLY = !!window.VA_VIEW_ONLY ||
    (function () { try { return localStorage.getItem('va:viewOnly') === '1'; } catch (e) { return false; } })();
  const AUTO_SYNC = !!window.VA_AUTO_SYNC || VIEW_ONLY;
  function isView() { try { return window.VA_VIEW_ONLY || localStorage.getItem('va:viewOnly') === '1'; } catch (e) { return !!window.VA_VIEW_ONLY; } }

  // 某标注在当前时刻是否可见：t 落在 [e.t-LEAD, e.t+dur]
  function visibleNow(e, t) {
    const d = e.dur || DEFAULT_DUR;
    return t >= e.t - LEAD && t <= e.t + d;
  }
  const LS_PREFIX = 'va:entries:';

  const state = {
    video: null, mediaId: null, platform: null,
    entries: [], showAll: false, annotate: false,
    rect: null, cr: null, draft: null, dragging: false,
  };
  window.__VA = { get state() { return state; } };   // 调试：控制台可 __VA.state 查看

  /* ---------- 存储 ---------- */
  function load() {
    try {
      const raw = localStorage.getItem(LS_PREFIX + state.mediaId);
      const obj = raw ? JSON.parse(raw) : null;
      state.entries = validEntries((obj && obj.entries) || []);
    } catch (e) { state.entries = []; }
  }
  function save() {
    const media = {
      platform: state.platform, videoId: state.mediaId, url: location.href, title: document.title,
      intrinsic: { w: state.video ? state.video.videoWidth : 0, h: state.video ? state.video.videoHeight : 0 },
    };
    const obj = { format: 'video-annotate/0.1', media, entries: state.entries };
    try { localStorage.setItem(LS_PREFIX + state.mediaId, JSON.stringify(obj)); }
    catch (e) { setSyncStatus('本地保存失败（隐私模式/空间不足？）'); }
    updateStatus();
    renderPanel();
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
  const btnSync = mkAction('同步', 'sync', syncNow);
  const btnCfg = mkAction('更多', 'more', toggleMenu);
  const btnBridge = mkbtn('发给 AI 助手', copyContext);
  const btnDiag = mkbtn('诊断信息', toggleDiag);
  const status = el('span'); status.className = 'va-sync-indicator'; status.dataset.state = 'ready';
  const statusDot = el('i'); statusDot.className = 'va-sync-dot';
  const statusText = el('span', null, '就绪');
  status.append(statusDot, statusText);
  bar.append(brand, separator, btnAnno, btnAll, btnPanel, btnSync, status, btnCfg);

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
  panelTabs.append(tabTimeline, tabWords);
  const panelSearchWrap = el('div'); panelSearchWrap.className = 'va-panel-search';
  const panelSearch = el('input'); panelSearch.className = 'va-input';
  panelSearch.type = 'search'; panelSearch.placeholder = '筛选标注…'; panelSearch.setAttribute('aria-label', '筛选标注');
  panelSearchWrap.appendChild(panelSearch);
  const entryList = el('div'); entryList.className = 'va-entry-list';
  const panelFoot = el('div'); panelFoot.className = 'va-panel-foot'; panelFoot.textContent = '点击词条跳转到对应画面';
  sidePanel.append(panelHead, panelTabs, panelSearchWrap, entryList, panelFoot);
  let panelOpen = false, panelTab = 'timeline';

  tabTimeline.onclick = () => { panelTab = 'timeline'; updatePanelTabs(); renderPanel(); };
  tabWords.onclick = () => { panelTab = 'words'; updatePanelTabs(); renderPanel(); };
  panelSearch.addEventListener('input', renderPanel);
  panelSearch.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') panelSearch.value = ''; renderPanel(); });

  function applyMode() {
    const v = isView();
    btnAnno.style.display = v ? 'none' : '';
    if (v) toggleAnnotate(false);
  }
  applyMode();

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
    diagPanel.style.display = on ? 'block' : 'none';
    btnDiag.classList.toggle('va-btn-primary', on);
    if (on) { uiRoot.appendChild(diagPanel); diagTimer = setInterval(renderDiag, 800); renderDiag(); }
    else { if (diagTimer) clearInterval(diagTimer); diagTimer = null; diagPanel.remove(); }
  }
  function renderDiag() {
    const d = A.diag ? A.diag() : {};
    const v = state.video, r = state.rect, cr = state.cr, m = state.meta || {};
    const lines = [
      'platform : ' + d.platform + '   supported=' + d.supported,
      'mediaId  : ' + d.mediaId,
      'href     : ' + d.href,
      'fullscreen: ' + (d.fullscreen || '-') + (m.unsupported ? '  ⚠ 视频自身全屏' : ''),
      'video    : ' + (v ? (v.videoWidth + 'x' + v.videoHeight + ' ready=' + v.readyState) : 'null'),
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
    panelSearch.placeholder = panelTab === 'words' ? '筛选词汇…' : '筛选标注…';
  }
  function togglePanel(force) {
    panelOpen = force == null ? !panelOpen : !!force;
    sidePanel.classList.toggle('is-open', panelOpen);
    btnPanel.classList.toggle('is-active', panelOpen);
    if (panelOpen) { renderPanel(); panelSearch.focus({ preventScroll: true }); }
  }
  document.addEventListener('keydown', (ev) => {
    const target = ev.composedPath ? ev.composedPath()[0] : ev.target;
    const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) return;
    if (ev.altKey && !ev.metaKey && !ev.ctrlKey) {
      const key = String(ev.key || '').toLowerCase();
      if (key === 'd') { ev.preventDefault(); toggleAnnotate(); }
      else if (key === 'l') { ev.preventDefault(); togglePanel(); }
      else if (key === 's') { ev.preventDefault(); state.showAll = !state.showAll; btnAll.classList.toggle('is-active', state.showAll); render(); }
    } else if (ev.key === 'Escape') {
      if (panelOpen) togglePanel(false);
      if (menuPanel.style.display !== 'none') toggleMenu();
      if (state.annotate) toggleAnnotate(false);
    }
  }, true);
  function renderPanel() {
    if (!panelOpen) return;
    panelTitleSub.textContent = (state.video ? document.title : '当前页面') + ' · ' + state.entries.length + ' 条';
    entryList.textContent = '';
    const query = (panelSearch.value || '').trim().toLocaleLowerCase();
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
      items = state.entries.slice().sort((a, b) => a.t - b.t)
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
    for (const item of items) {
      const e = item.entry;
      if (panelTab === 'timeline') {
        const minute = Math.floor((Number(e.t) || 0) / 60);
        if (minute !== lastMinute) {
          lastMinute = minute;
          const group = el('div', null, formatTime(minute * 60)); group.className = 'va-entry-group';
          entryList.appendChild(group);
        }
      }
      const row = el('button'); row.type = 'button'; row.className = 'va-entry-row';
      const time = el('span', null, formatTime(e.t)); time.className = 'va-entry-time';
      const copy = el('span'); copy.className = 'va-entry-copy';
      const title = el('strong', null, e.word || '未命名');
      const subtitle = el('span', null, panelTab === 'words' ? ((e.label || '未添加释义') + (item.count > 1 ? ' · 出现 ' + item.count + ' 次' : '')) : (e.label || e.pos || '点击定位画面'));
      copy.append(title, subtitle);
      const more = mkIconButton('编辑或管理词条', 'dots', () => {
        const r = more.getBoundingClientRect(); openEntryPop(e, r.left, r.bottom);
      });
      more.classList.add('va-entry-more');
      row.append(time, copy, more);
      row.onclick = (ev) => {
        if (ev.target === more || more.contains(ev.target)) return;
        if (state.video) { state.video.currentTime = Math.max(0, Number(e.t) || 0); state.video.pause(); }
        render();
        showToast('已定位到 ' + formatTime(e.t) + ' · ' + (e.word || '标注'));
      };
      entryList.appendChild(row);
    }
    panelFoot.textContent = items.length + (panelTab === 'words' ? ' 个词 · 按词汇聚' : ' 条标注 · 点击词条定位画面');
  }

  /* ---------- 上下文桥（发给桌面豆包/系统助手）+ 截图 + 笔记 ---------- */
  // 不做第二个豆包：只把「别人拿不到的上下文」整理好，交给桌面豆包
  function videoContext() {
    const t = state.video ? Math.floor(state.video.currentTime) : 0;
    const words = state.entries.slice(-12).map((e) => e.word).filter(Boolean).join(', ');
    return ['平台: ' + (state.platform || location.hostname), '链接: ' + location.href,
      '标题: ' + document.title, '当前进度: ' + t + 's', words ? '画面已标注的词: ' + words : ''].filter(Boolean).join('\n');
  }
  function videoRect() {
    const r = state.rect; if (!r) return null;
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
  async function captureFrame() {
    const rect = videoRect();
    try {
      if (typeof window.vaCapture === 'function') return await window.vaCapture(rect);           // 自建浏览器
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {        // 扩展
        const resp = await new Promise((res) => chrome.runtime.sendMessage({ type: 'va-capture' }, res));
        if (resp && resp.dataUrl) return rect ? await cropDataUrl(resp.dataUrl, rect) : resp.dataUrl;
        return null;
      }
    } catch (e) {}
    try {   // 兜底：同源视频可 drawImage（跨域会被 taint → 抛错返回 null）
      const v = state.video; if (!v || !v.videoWidth) return null;
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0); return c.toDataURL('image/png');
    } catch (e) { return null; }
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
      if (!watchable || state.video || A.findVideo()) { noVideoSince = 0; probe.style.display = 'none'; return; }
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
  function toggleMenu() {
    const on = menuPanel.style.display === 'none';
    if (!on) { menuPanel.style.display = 'none'; btnCfg.classList.remove('is-active'); menuPanel.remove(); return; }
    btnCfg.classList.add('is-active');
    syncBox.value = syncUrl();
    const viewBtn = mkbtn(isView() ? '只读模式 · 已开启' : '只读模式', () => {
      try { localStorage.setItem('va:viewOnly', isView() ? '0' : '1'); } catch (e) {}
      applyMode();
      viewBtn.textContent = isView() ? '只读模式 · 已开启' : '只读模式';
    });
    const rowDir = el('div', { display: 'flex', gap: '5px', marginTop: '5px' }); rowDir.className = 'va-menu-row';
    rowDir.append(mkbtn('仅上传', uploadSync), mkbtn('仅下载', downloadSync), viewBtn);
    const row = el('div', { display: 'flex', gap: '5px', marginTop: '5px', flexWrap: 'wrap' }); row.className = 'va-menu-row';
    row.append(mkbtn('导出 Pack', exportJSON), mkbtn('导入 Pack', importJSON), mkbtn('清空当前', clearAll));
    menuPanel.textContent = '';
    const cands = (window.VA_SYNC_URLS || []).join('  ·  ');
    menuPanel.append(
      el('div', { color: '#9b8260', fontSize: '9px', fontWeight: '700', letterSpacing: '.1em', padding: '0 9px 3px' }, 'ANNOTATION TOOLS'),
      mkbtn('查看全部标注', () => togglePanel(true)),
      btnBridge,
      mkbtn('截图到剪贴板', shotOnly),
      mkbtn('保存为笔记', saveNote),
      btnDiag,
      el('div', { height: '1px', background: 'rgba(255,255,255,.08)', margin: '5px 3px' }),
      el('div', { color: '#9b8260', fontSize: '9px', fontWeight: '700', letterSpacing: '.1em', padding: '0 9px 3px' }, 'SYNC & FILES'),
      el('div', { color: '#89919b', fontSize: '10px', padding: '0 9px' }, '同步地址（留空=自动探测）'),
      syncBox,
      el('div', { display: 'flex', gap: '6px', marginTop: '6px' },
        mkbtn('保存地址', () => { const v = syncBox.value.trim(); if (v) { setSyncBase(v); } else { syncBase = null; try { localStorage.removeItem(SYNC_URL_KEY); } catch (e) {} setSyncStatus('已恢复自动'); } }),
        mkbtn('清空地址', () => { localStorage.removeItem(SYNC_URL_KEY); syncBase = null; syncBox.value = ''; setSyncStatus('已恢复自动'); }),
        mkbtn('测试', testSync)),
      rowDir,
      row,
      el('div', { color: '#66717d', fontSize: '9px', padding: '2px 9px 0', overflowWrap: 'anywhere' }, cands ? '备选：' + cands : '默认 http://127.0.0.1:8793'),
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
  function attach(video) {
    if (state.video === video) return;
    if (state.video) detach();
    state.video = video;
    state.mediaId = A.mediaId(); state.platform = A.platform();
    load(); save(); render();
    uiRoot.append(overlay, bar, sidePanel, toast);
    toast.classList.remove('is-visible', 'is-error');
    renderPanel();
    lastSig = null;
    applyMode();
    startProbe();
    if (AUTO_SYNC) autoSyncTimer = setTimeout(() => { try { syncNow(); } catch (e) {} }, 900);
    if (!raf) raf = requestAnimationFrame(loop);
  }

  let raf = null, lastSig = null, autoSyncTimer = null;
  function loop() {
    raf = requestAnimationFrame(loop);
    const v = state.video;
    if (!v || !v.isConnected) { detach(); return; }

    // SPA 切集：URL 变了就换一份标注
    const mid = A.mediaId();
    if (mid !== state.mediaId) { state.mediaId = mid; load(); render(); renderPanel(); }

    // 全屏宿主处理：只有 fullscreen 元素的后代可见
    const fs = document.fullscreenElement;
    let host = document.body, unsupported = false;
    if (fs) { if (fs.tagName === 'VIDEO') unsupported = true; else host = fs; }
    if (uiHost.parentElement !== host) host.appendChild(uiHost);

    if (unsupported) {
      overlay.style.display = 'none'; bar.style.display = 'none';
      toast.textContent = '视频元素处于系统全屏，浏览器不允许叠加。请切换到网页全屏或影院模式。';
      toast.classList.add('is-visible', 'is-error');
      state.meta = { unsupported: true };
      return;
    }
    toast.classList.remove('is-visible', 'is-error');
    bar.style.display = 'flex';

    const r = v.getBoundingClientRect();
    state.rect = r;
    const fit = getComputedStyle(v).objectFit || 'contain';
    state.cr = G.contentRect({ w: v.videoWidth, h: v.videoHeight }, r, fit);
    state.meta = { vw: v.videoWidth, vh: v.videoHeight, ready: v.readyState, fit, host: host.tagName, unsupported: false };

    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px'; overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px'; overlay.style.height = r.height + 'px';

    if (state.dragging && state.draft) drawDraft();
    // 时间窗口驱动的可见性：仅在「可见集合」变化时重绘，避免每帧重建 DOM
    if (!state.showAll) {
      const t = v.currentTime;
      const sig = state.entries.filter((e) => visibleNow(e, t)).map((e) => e.id).join(',');
      if (sig !== lastSig) { lastSig = sig; render(); }
    } else { lastSig = null; }
  }

  function detach() {
    if (raf) cancelAnimationFrame(raf); raf = null;
    if (diagTimer) { clearInterval(diagTimer); diagTimer = null; }
    if (autoSyncTimer) { clearTimeout(autoSyncTimer); autoSyncTimer = null; }
    if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
    overlay.remove(); bar.remove(); sidePanel.remove(); diagPanel.remove(); toast.remove(); menuPanel.remove(); probe.remove();
    uiRoot.querySelectorAll('.va-popover').forEach((n) => n.remove());
    panelOpen = false;
    state.video = null; state.meta = null; lastSig = null;
  }

  /* ---------- 渲染 ---------- */
  function render() {
    layer.textContent = '';
    const t = state.video ? state.video.currentTime : 0;
    const cr = state.cr; if (!cr) return;
    const r = state.rect;
    for (const e of state.entries) {
      if (!state.showAll && !visibleNow(e, t)) continue;
      const p = G.boxToPixels(e.box, cr);
      const left = p.left - r.left, top = p.top - r.top;
      const box = el('div', {
        position: 'absolute', left: left + 'px', top: top + 'px',
        width: p.width + 'px', height: p.height + 'px',
      });
      box.className = 'va-mark';
      const lab = el('span', {
      }, e.word + (e.label ? ' ' + e.label : ''));
      lab.className = 'va-mark-label';
      box.appendChild(lab);
      box.onclick = (ev) => { ev.stopPropagation(); openEntryPop(e, ev.clientX, ev.clientY); };
      layer.appendChild(box);
    }
  }

  function drawDraft() {
    layer.textContent = '';
    const cr = state.cr, r = state.rect, d = state.draft;
    const b = G.dragToBox(d.x0, d.y0, d.x1, d.y1, cr);
    const p = G.boxToPixels(b, cr);
    const box = el('div', {
      position: 'absolute', left: (p.left - r.left) + 'px', top: (p.top - r.top) + 'px',
      width: p.width + 'px', height: p.height + 'px',
    });
    box.className = 'va-draft-mark';
    layer.appendChild(box);
  }

  /* ---------- 标注交互 ---------- */
  function toggleAnnotate(force) {
    state.annotate = force != null ? force : !state.annotate;
    capture.style.pointerEvents = state.annotate ? 'auto' : 'none';
    btnAnno.classList.toggle('is-active', state.annotate);
    if (state.annotate && state.video) state.video.pause();
    render();
  }

  capture.addEventListener('pointerdown', (e) => {
    if (!state.annotate) return;
    state.video.pause();
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
    const p = G.boxToPixels(box, state.cr);   // 视口坐标
    const width = Math.min(360, innerWidth - 24);
    const pop = el('div');
    pop.className = 'va-popover' + (initial.suggested ? ' va-ai-proposal' : '');
    pop.dataset.vaPop = '1'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', '新建标注');
    pop.style.left = Math.max(12, Math.min(p.left, innerWidth - width - 12)) + 'px';
    pop.style.top = Math.max(12, Math.min(p.top, innerHeight - 410)) + 'px';

    const head = el('div'); head.className = 'va-pop-head';
    const heading = el('div'); heading.className = 'va-pop-heading';
    const eyebrow = el('div', null, initial.suggested ? 'AI SUGGESTION · REVIEW' : 'REGION CAPTURED'); eyebrow.className = 'va-eyebrow';
    heading.append(eyebrow, el('strong', null, initial.suggested ? '确认 AI 标注' : '锚定一个词'), el('span', null, '词必填；释义和词性稍后也能补。'));
    const close = mkIconButton('关闭编辑卡', 'close', () => pop.remove()); close.classList.add('va-close');
    head.append(heading, close);

    const wordLabel = el('label', null, '词语'); wordLabel.className = 'va-field-label';
    const wIn = el('input'); wIn.className = 'va-input'; wIn.placeholder = '输入你想记住的词'; wIn.autocomplete = 'off'; wIn.maxLength = 120;
    wIn.value = initial.word || '';
    wIn.setAttribute('aria-label', '词语（必填）');
    const label = el('label', null, '释义（选填）'); label.className = 'va-field-label';
    const lIn = el('input'); lIn.className = 'va-input'; lIn.placeholder = '写下此处语境里的意思'; lIn.maxLength = 300; lIn.value = initial.label || '';
    lIn.setAttribute('aria-label', '释义（选填）');
    const detailRow = el('div', { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '9px', alignItems: 'end' });
    const posWrap = el('label', { display: 'block' });
    const posLabel = el('span', null, '词性'); posLabel.className = 'va-field-label';
    posWrap.append(posLabel);
    const sel = el('select'); sel.className = 'va-select'; sel.setAttribute('aria-label', '词性（选填）');
    const posOptions = [['', '不指定'], ['n', '名词'], ['v', '动词'], ['a', '形容词'], ['ad', '副词'], ['prep', '介词'], ['conj', '连词'], ['other', '其他']];
    for (const [value, text] of posOptions) { const op = document.createElement('option'); op.value = value; op.textContent = text; sel.appendChild(op); }
    sel.value = initial.pos || '';
    posWrap.appendChild(sel);

    const timeLabel = el('label', null, '出现时间'); timeLabel.className = 'va-field-label';
    const timeRow = el('div'); timeRow.className = 'va-time-row';
    const tIn = el('input'); tIn.className = 'va-input'; tIn.type = 'number'; tIn.min = '0'; tIn.step = '0.1';
    tIn.value = String(r2(initial.t == null ? state.video.currentTime : initial.t)); tIn.setAttribute('aria-label', '出现时间（秒）');
    const nowButton = mkbtn('用当前时间', () => { tIn.value = String(r2(state.video.currentTime)); });
    timeRow.append(tIn, nowButton);
    const durationLabel = el('label', null, '显示时长'); durationLabel.className = 'va-field-label';
    const dIn = el('input'); dIn.className = 'va-input'; dIn.type = 'number'; dIn.min = '0.2'; dIn.step = '0.1'; dIn.value = String(initial.dur || DEFAULT_DUR);
    dIn.setAttribute('aria-label', '显示时长（秒）');
    const durationWrap = el('label'); durationWrap.append(durationLabel, dIn);
    detailRow.append(posWrap, durationWrap);
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
    const dictLinks = [
      ['剑桥', (word) => 'https://dictionary.cambridge.org/dictionary/english/' + encodeURIComponent(word)],
      ['有道', (word) => 'https://www.youdao.com/result?word=' + encodeURIComponent(word) + '&lang=en'],
      ['欧路', (word) => 'https://dict.eudic.net/dicts/en/' + encodeURIComponent(word)],
    ].map(([name, href]) => {
      const a = el('a', null, name); a.href = href(''); a.target = '_blank'; a.rel = 'noopener noreferrer'; a.dataset.dict = name; a.dataset.template = '1';
      a.addEventListener('click', (ev) => { if (!wIn.value.trim()) { ev.preventDefault(); wIn.focus(); } });
      dictionary.appendChild(a); return { a, href };
    });
    function updateDictionaryLinks() { for (const d of dictLinks) d.a.href = d.href(wIn.value.trim()); }
    wIn.addEventListener('input', updateDictionaryLinks);

    const actions = el('div'); actions.className = 'va-pop-actions';
    const cancel = mkbtn('取消', () => pop.remove());
    const saveButton = mkbtn(initial.suggested ? '确认并保存' : '保存并继续播放', commit); saveButton.classList.add('va-btn-primary');
    actions.append(cancel, saveButton);
    pop.append(head, wordLabel, wIn, label, lIn, detailRow, timeLabel, timeRow, durChips, dictionary, actions);
    wIn.addEventListener('input', () => wIn.removeAttribute('aria-invalid'));

    function commit() {
      const word = wIn.value.trim();
      if (!word) { wIn.focus(); wIn.setAttribute('aria-invalid', 'true'); return; }
      state.entries.push({
        id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        t: Math.max(0, r2(parseFloat(tIn.value))), box, word, label: lIn.value.trim(), pos: sel.value,
        dur: Math.max(0.2, r2(parseFloat(dIn.value) || DEFAULT_DUR)), created: new Date().toISOString(),
      });
      save(); pop.remove(); render();
      if (state.video) state.video.play().catch(() => {});
      showToast('已保存标注 · ' + word);
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
      if (!state.video || !payload || !payload.box) return false;
      const values = ['x', 'y', 'w', 'h'].map((k) => Number(payload.box[k]));
      if (!values.every(Number.isFinite)) return false;
      const box = G.clampBox({ x: values[0], y: values[1], w: values[2], h: values[3] });
      state.video.pause(); toggleAnnotate(false);
      askWord(box, { ...payload, suggested: true });
      return true;
    },
  };

  function openEntryPop(e, x, y) {
    if (state.video) state.video.pause();
    const pop = el('div'); pop.className = 'va-popover'; pop.dataset.vaPop = '1';
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', '标注详情');
    pop.style.left = Math.max(12, Math.min((Number(x) || 0) + 10, innerWidth - 372)) + 'px';
    pop.style.top = Math.max(12, Math.min((Number(y) || 0) + 10, innerHeight - 430)) + 'px';
    const dur = e.dur || DEFAULT_DUR;
    const head = el('div'); head.className = 'va-pop-head';
    const heading = el('div'); heading.className = 'va-pop-heading';
    const eyebrow = el('div', null, 'ANNOTATION'); eyebrow.className = 'va-eyebrow';
    heading.append(eyebrow, el('strong', null, e.word || '未命名'), el('span', null, (e.label || '未添加释义') + (e.pos ? ' · ' + e.pos : '')));
    const close = mkIconButton('关闭词条详情', 'close', () => pop.remove()); close.classList.add('va-close');
    head.append(heading, close);
    const range = el('div'); range.className = 'va-range';
    pop.append(head, range);

    const tIn = el('input'); tIn.className = 'va-input'; tIn.type = 'number'; tIn.min = '0'; tIn.step = '0.1'; tIn.value = String(e.t); tIn.setAttribute('aria-label', '开始时间（秒）');
    const dIn = el('input'); dIn.className = 'va-input'; dIn.type = 'number'; dIn.min = '0.2'; dIn.step = '0.1'; dIn.value = String(dur); dIn.setAttribute('aria-label', '显示时长（秒）');
    const updRange = () => {
      const start = Math.max(0, parseFloat(tIn.value) || 0);
      range.textContent = formatTime(start) + ' – ' + formatTime(start + (parseFloat(dIn.value) || dur));
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
    pop.appendChild(dictionary);

    if (isView()) {
      const actions = el('div'); actions.className = 'va-pop-actions';
      actions.append(mkbtn('跳转到画面', () => { if (state.video) state.video.currentTime = e.t; pop.remove(); }), mkbtn('关闭', () => pop.remove()));
      pop.append(el('div', null, formatTime(e.t) + ' · 显示 ' + dur + ' 秒'), actions);
      uiRoot.appendChild(pop);
      return;
    }

    const wordInput = el('input'); wordInput.className = 'va-input'; wordInput.value = e.word || ''; wordInput.setAttribute('aria-label', '词语');
    const labelInput = el('input'); labelInput.className = 'va-input'; labelInput.value = e.label || ''; labelInput.placeholder = '释义（选填）'; labelInput.setAttribute('aria-label', '释义');
    const timeLabel = el('label', null, '出现时间'); timeLabel.className = 'va-field-label';
    const timeRow = el('div'); timeRow.className = 'va-time-row';
    const now = mkbtn('用当前时间', () => { tIn.value = state.video ? String(r2(state.video.currentTime)) : String(e.t); updRange(); });
    timeRow.append(tIn, now);
    const durationLabel = el('label', null, '显示时长'); durationLabel.className = 'va-field-label';
    const actions = el('div'); actions.className = 'va-pop-actions';
    const jump = mkbtn('跳转', () => { if (state.video) state.video.currentTime = Math.max(0, parseFloat(tIn.value) || e.t); pop.remove(); });
    const remove = mkbtn('删除', () => { state.entries = state.entries.filter((item) => item !== e); save(); pop.remove(); render(); showToast('已删除标注'); });
    remove.classList.add('va-btn-danger');
    const saveButton = mkbtn('保存修改', () => {
      const word = wordInput.value.trim();
      if (!word) { wordInput.focus(); return; }
      e.word = word; e.label = labelInput.value.trim();
      e.t = Math.max(0, r2(parseFloat(tIn.value)));
      e.dur = Math.max(0.2, r2(parseFloat(dIn.value) || DEFAULT_DUR));
      save(); render(); pop.remove(); showToast('标注已更新');
    });
    saveButton.classList.add('va-btn-primary');
    actions.append(jump, remove, saveButton);
    pop.append(el('label', null, '词语'), wordInput, el('label', null, '释义（选填）'), labelInput, timeLabel, timeRow, durationLabel, dIn, actions);
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
    return {
      platform: state.platform, videoId: state.mediaId, url: location.href, title: document.title,
      intrinsic: { w: state.video ? state.video.videoWidth : 0, h: state.video ? state.video.videoHeight : 0 },
    };
  }
  function pack() { return { format: 'video-annotate/0.1', media: mediaMeta(), entries: state.entries }; }

  function validBox(b) {
    return b && typeof b === 'object' &&
      ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(b[k]));
  }
  function sameEntry(e, o) {
    if ((e.word || '') !== (o.word || '')) return false;
    if (Math.abs((Number(e.t) || 0) - (Number(o.t) || 0)) >= 0.4) return false;
    if (!validBox(e.box) || !validBox(o.box)) return false;
    return G.iou(e.box, o.box) > 0.6;
  }
  function validEntries(list) {
    return (Array.isArray(list) ? list : []).filter((e) => {
      if (!e || !e.word || !validBox(e.box)) return false;   // 形状守卫：脏数据不进、不抛
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

  // 傻瓜式：一次「同步」= 拉取 + 本地合并 + 回传，union 双向
  async function syncNow() {
    if (!state.mediaId) return;
    setSyncStatus('同步中…');
    try {
      const base = await resolveBase();
      const url = base + '/api/anno/' + encodeURIComponent(state.mediaId);
      const g = await httpJson('GET', url);
      if (!g.ok) throw new Error('HTTP ' + g.status);
      const before = state.entries.length;
      state.entries = mergeLocal(state.entries, (g.json && g.json.entries) || []);
      const p = await httpJson('PUT', url, pack());
      if (!p.ok) throw new Error('HTTP ' + p.status);
      state.entries = (p.json && p.json.entries) || state.entries;
      save(); render();
      setSyncStatus('已同步 · ' + state.entries.length + ' 条（拉取新增 ' + Math.max(0, state.entries.length - before) + '）');
    } catch (e) {
      setSyncStatus('同步失败：' + e.message);
      alert('同步失败：' + e.message + SYNC_HINT);
    }
  }

  async function uploadSync() {
    if (!state.mediaId) return;
    setSyncStatus('上传中…');
    try {
      const base = await resolveBase();
      const r = await httpJson('PUT', base + '/api/anno/' + encodeURIComponent(state.mediaId), pack());
      if (!r.ok) throw new Error('HTTP ' + r.status);
      state.entries = validEntries((r.json && r.json.entries) || state.entries);
      save(); render();
      setSyncStatus('已上传 · 服务器 ' + state.entries.length + ' 条');
    } catch (e) { setSyncStatus('上传失败：' + e.message); alert('上传失败：' + e.message + SYNC_HINT); }
  }

  async function downloadSync() {
    if (!state.mediaId) return;
    setSyncStatus('下载中…');
    try {
      const base = await resolveBase();
      const r = await httpJson('GET', base + '/api/anno/' + encodeURIComponent(state.mediaId));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const before = state.entries.length;
      state.entries = mergeLocal(state.entries, (r.json && r.json.entries) || []);
      save(); render();
      setSyncStatus('已下载 · 合并后 ' + state.entries.length + ' 条（新增 ' + (state.entries.length - before) + '）');
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
    state.entries = []; save(); render();
  }

  function updateStatus() {
    statusText.textContent = state.entries.length ? state.entries.length + ' 条标注' : '就绪';
    status.dataset.state = 'ready';
  }

  /* ---------- 启动 ---------- */
  A.watch((v) => { if (v) attach(v); else detach(); });
})();
