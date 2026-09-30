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
      platform: state.platform, videoId: state.mediaId, url: location.href,
      intrinsic: { w: state.video ? state.video.videoWidth : 0, h: state.video ? state.video.videoHeight : 0 },
    };
    const obj = { format: 'video-annotate/0.1', media, entries: state.entries };
    try { localStorage.setItem(LS_PREFIX + state.mediaId, JSON.stringify(obj)); }
    catch (e) { setSyncStatus('本地保存失败（隐私模式/空间不足？）'); }
    updateStatus();
  }

  /* ---------- DOM ---------- */
  const overlay = el('div', {
    position: 'fixed', left: '0', top: '0', width: '0', height: '0',
    pointerEvents: 'none', zIndex: '2147483000', display: 'none',
  });
  const capture = el('div', {
    position: 'absolute', left: '0', top: '0', right: '0', bottom: '0',
    pointerEvents: 'none', cursor: 'crosshair',
  });
  const layer = el('div', {
    position: 'absolute', left: '0', top: '0', right: '0', bottom: '0', pointerEvents: 'none',
  });
  overlay.appendChild(capture); overlay.appendChild(layer);

  const bar = el('div', {
    position: 'fixed', right: '14px', bottom: '14px', zIndex: '2147483001',
    display: 'flex', gap: '6px', alignItems: 'center',
    background: 'rgba(17,22,29,.92)', border: '1px solid #2b3644', borderRadius: '10px',
    padding: '6px 8px', font: '12px/1.4 -apple-system,"PingFang SC",sans-serif', color: '#e6edf3',
    boxShadow: '0 8px 28px rgba(0,0,0,.45)',
  });
  const btnAnno = mkbtn('✎ 标注', () => toggleAnnotate());
  const btnAll = mkbtn('👁 全部', () => { state.showAll = !state.showAll; btnAll.style.borderColor = state.showAll ? '#f0b429' : ''; render(); });
  const btnSync = mkbtn('⇅ 同步', syncNow);
  const btnBridge = mkbtn('📋 发豆包', copyContext);
  const btnCfg = mkbtn('⚙', toggleMenu);
  const btnDiag = mkbtn('ⓘ', toggleDiag);
  const status = el('span', { color: '#8b949e', marginLeft: '4px' });
  [btnAnno, btnAll, btnSync, btnBridge, btnCfg, btnDiag, status].forEach((n) => bar.appendChild(n));
  function applyMode() {
    const v = isView();
    btnAnno.style.display = v ? 'none' : '';
    if (v) toggleAnnotate(false);
  }
  applyMode();

  // 诊断面板（B站等实机上排查用）
  const diagPanel = el('pre', {
    position: 'fixed', right: '14px', bottom: '56px', zIndex: '2147483001', display: 'none',
    margin: '0', maxWidth: 'min(560px, 92vw)', maxHeight: '58vh', overflow: 'auto',
    background: 'rgba(10,14,20,.97)', border: '1px solid #2b3644', borderRadius: '10px',
    padding: '12px 14px', color: '#9ecbff', font: '12.5px/1.6 ui-monospace,Menlo,monospace',
    whiteSpace: 'pre-wrap', boxShadow: '0 10px 30px rgba(0,0,0,.5)',
  });
  // 无法叠加时的提示条
  const toast = el('div', {
    position: 'fixed', left: '50%', top: '12px', transform: 'translateX(-50%)', zIndex: '2147483002',
    display: 'none', background: 'rgba(120,40,40,.95)', color: '#ffe1e1', border: '1px solid #a05252',
    borderRadius: '8px', padding: '6px 12px', font: '12px/1.4 -apple-system,"PingFang SC",sans-serif',
    boxShadow: '0 8px 24px rgba(0,0,0,.5)',
  }, '当前为「视频元素真全屏」，浏览器限制无法叠加标注。请用播放器的「网页全屏 / 影院模式」再标注。');
  let diagTimer = null;
  function toggleDiag() {
    const on = diagPanel.style.display === 'none';
    diagPanel.style.display = on ? 'block' : 'none';
    btnDiag.style.borderColor = on ? '#f0b429' : '';
    if (on) { document.body.appendChild(diagPanel); diagTimer = setInterval(renderDiag, 800); renderDiag(); }
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
  const probe = el('div', {
    position: 'fixed', right: '14px', bottom: '14px', zIndex: '2147483001', display: 'none',
    background: 'rgba(17,22,29,.96)', border: '1px solid #2b3644', color: '#ffde8a',
    borderRadius: '10px', padding: '6px 10px', cursor: 'pointer',
    font: '12px/1.5 -apple-system,"PingFang SC",sans-serif', boxShadow: '0 8px 24px rgba(0,0,0,.5)',
  }, '⚠ 未检测到视频 · 点此诊断');
  probe.onclick = () => { probe.style.display = 'none'; toggleDiag(); };
  let noVideoSince = 0, probeTimer = null;
  function startProbe() {
    if (probeTimer) return;
    probeTimer = setInterval(() => {
      const plat = A.platform ? A.platform() : 'generic';
      const watchable = plat === 'bilibili' || plat === 'douyin' || plat === 'youtube';
      if (!watchable || state.video || A.findVideo()) { noVideoSince = 0; probe.style.display = 'none'; return; }
      if (!noVideoSince) noVideoSince = Date.now();
      else if (Date.now() - noVideoSince > 3000) {
        if (probe.parentElement !== document.body) document.body.appendChild(probe);
        probe.style.display = 'block';
      }
    }, 1500);
  }
  startProbe();

  // 设置面板：同步地址 + 文件导入导出 + 清空
  const menuPanel = el('div', {
    position: 'fixed', right: '14px', bottom: '56px', zIndex: '2147483001', display: 'none',
    background: '#11161d', border: '1px solid #2b3644', borderRadius: '10px', padding: '10px',
    width: '300px', font: '12px/1.6 -apple-system,"PingFang SC",sans-serif', color: '#e6edf3',
    boxShadow: '0 10px 30px rgba(0,0,0,.5)',
  });
  const syncBox = el('input', { width: '100%', background: '#0e131a', border: '1px solid #2b3644', color: '#e6edf3', borderRadius: '6px', padding: '5px 7px', font: 'inherit', marginTop: '4px' });
  function toggleMenu() {
    const on = menuPanel.style.display === 'none';
    if (!on) { menuPanel.style.display = 'none'; btnCfg.style.borderColor = ''; menuPanel.remove(); return; }
    btnCfg.style.borderColor = '#f0b429';
    syncBox.value = syncUrl();
    const viewBtn = mkbtn(isView() ? '✅ 只读模式' : '只读模式', () => {
      try { localStorage.setItem('va:viewOnly', isView() ? '0' : '1'); } catch (e) {}
      applyMode();
      viewBtn.textContent = isView() ? '✅ 只读模式' : '只读模式';
    });
    const rowDir = el('div', { display: 'flex', gap: '6px', marginTop: '6px' });
    rowDir.append(mkbtn('⬆ 仅上传', uploadSync), mkbtn('⬇ 仅下载', downloadSync), viewBtn);
    const row = el('div', { display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' });
    row.append(mkbtn('⬇ 导出文件', exportJSON), mkbtn('⬆ 导入文件', importJSON), mkbtn('🗑 清空', clearAll));
    const rowCtx = el('div', { display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' });
    rowCtx.append(mkbtn('📋 发豆包', copyContext), mkbtn('📷 截图', shotOnly), mkbtn('📝 存笔记', saveNote));
    menuPanel.textContent = '';
    const cands = (window.VA_SYNC_URLS || []).join('  ·  ');
    menuPanel.append(
      el('div', { color: '#f0b429', fontWeight: '700' }, '同步与文件'),
      el('div', { color: '#8b949e', marginTop: '6px' }, '同步地址（留空=自动探测）'),
      syncBox,
      el('div', { display: 'flex', gap: '6px', marginTop: '6px' },
        mkbtn('保存地址', () => { const v = syncBox.value.trim(); if (v) { setSyncBase(v); } else { syncBase = null; try { localStorage.removeItem(SYNC_URL_KEY); } catch (e) {} setSyncStatus('已恢复自动'); } }),
        mkbtn('清空地址', () => { localStorage.removeItem(SYNC_URL_KEY); syncBase = null; syncBox.value = ''; setSyncStatus('已恢复自动'); }),
        mkbtn('测试', testSync)),
      rowDir,
      row,
      rowCtx,
      el('div', { color: '#5b6a7a', marginTop: '8px' }, cands ? '备选：' + cands : '默认 http://127.0.0.1:8793'),
    );
    menuPanel.style.display = 'block';
    document.body.appendChild(menuPanel);
  }
  function setSyncStatus(msg) { status.textContent = msg; }

  function mkbtn(text, fn) {
    const b = el('button', {
      background: 'rgba(20,24,30,.9)', border: '1px solid #2c3540', color: '#e6edf3',
      borderRadius: '7px', padding: '4px 9px', cursor: 'pointer', font: 'inherit',
    }, text);
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
    document.body.append(overlay, bar);
    toast.style.display = 'none';
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
    if (mid !== state.mediaId) { state.mediaId = mid; load(); render(); }

    // 全屏宿主处理：只有 fullscreen 元素的后代可见
    const fs = document.fullscreenElement;
    let host = document.body, unsupported = false;
    if (fs) { if (fs.tagName === 'VIDEO') unsupported = true; else host = fs; }
    if (!unsupported && overlay.parentElement !== host) host.appendChild(overlay);

    if (unsupported) {
      overlay.style.display = 'none'; bar.style.display = 'none';
      if (toast.parentElement !== document.body) document.body.appendChild(toast);
      toast.style.display = 'block';
      state.meta = { unsupported: true };
      return;
    }
    toast.style.display = 'none';
    bar.style.display = 'flex';
    if (diagPanel.style.display === 'block' && diagPanel.parentElement !== document.body) document.body.appendChild(diagPanel);

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
    overlay.remove(); bar.remove(); diagPanel.remove(); toast.remove(); menuPanel.remove();
    document.querySelectorAll('div[va-pop]').forEach((n) => n.remove());   // 关闭遗留弹层
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
        border: '2px solid #f0b429', borderRadius: '6px',
        background: 'rgba(240,180,41,.12)', pointerEvents: 'auto', cursor: 'pointer',
      });
      const lab = el('span', {
        position: 'absolute', left: '0', top: '-20px', whiteSpace: 'nowrap',
        background: 'rgba(10,14,20,.92)', border: '1px solid rgba(240,180,41,.6)',
        color: '#ffde8a', font: '12px/1.4 -apple-system,"PingFang SC",sans-serif',
        padding: '1px 7px', borderRadius: '10px',
      }, e.word + (e.label ? ' ' + e.label : ''));
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
      border: '2px dashed #7ee787', borderRadius: '6px', background: 'rgba(126,231,135,.15)',
    });
    layer.appendChild(box);
  }

  /* ---------- 标注交互 ---------- */
  function toggleAnnotate(force) {
    state.annotate = force != null ? force : !state.annotate;
    capture.style.pointerEvents = state.annotate ? 'auto' : 'none';
    btnAnno.style.borderColor = state.annotate ? '#f0b429' : '';
    btnAnno.style.color = state.annotate ? '#f0b429' : '';
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

  const IN_STYLE = { background: '#0e131a', border: '1px solid #2b3644', color: '#e6edf3', borderRadius: '6px', padding: '5px 7px', font: 'inherit' };

  function askWord(box) {
    const p = G.boxToPixels(box, state.cr);   // 视口坐标
    const pop = el('div', {
      'va-pop': '1', position: 'fixed',
      left: Math.max(8, Math.min(p.left, innerWidth - 600)) + 'px',
      top: Math.max(8, Math.min(p.top, innerHeight - 180)) + 'px',
      zIndex: '2147483002', background: '#11161d', border: '1px solid #2b3644',
      borderRadius: '12px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '9px',
      width: 'min(580px, 94vw)', boxShadow: '0 18px 50px rgba(0,0,0,.6)',
      font: '14px/1.5 -apple-system,"PingFang SC",sans-serif', color: '#e6edf3',
    });

    // 搜索（中英联想）
    const sWrap = el('div', { position: 'relative' });
    const sIn = el('input', { ...IN_STYLE, width: '100%' });
    sIn.placeholder = VINDEX ? '🔍 搜英文或中文，自动补全 词/义/词性' : '英文词（未加载词库）';
    const sug = el('div', {
      position: 'absolute', left: '0', top: '100%', marginTop: '4px', width: '100%', maxHeight: '220px',
      overflow: 'auto', background: '#0e131a', border: '1px solid #2b3644', borderRadius: '8px',
      display: 'none', zIndex: '2147483003',
    });
    sWrap.append(sIn, sug);

    // 字段行
    const wIn = el('input', { ...IN_STYLE, width: '108px' }); wIn.placeholder = '英文';
    const lIn = el('input', { ...IN_STYLE, flex: '1' }); lIn.placeholder = '中文';
    const sel = el('select', { ...IN_STYLE, padding: '5px' });
    for (const o of ['n', 'v', 'a', 'ad', 'prep', 'conj', 'other']) { const op = document.createElement('option'); op.value = o; op.textContent = o; sel.appendChild(op); }
    const dIn = el('input', { ...IN_STYLE, width: '58px' }); dIn.type = 'number'; dIn.min = '0.2'; dIn.step = '0.1'; dIn.value = DEFAULT_DUR.toFixed(1); dIn.title = '显示时长(秒)';
    const ok = mkbtn('确定', commit); const cancel = mkbtn('取消', () => pop.remove());
    const row2 = el('div', { display: 'flex', gap: '6px', alignItems: 'center' });
    row2.append(wIn, lIn, sel, dIn, el('span', { color: '#8b949e', fontSize: '12px' }, '秒'), ok, cancel);

    pop.append(sWrap, row2);

    function setPos(v) {
      if (!v) return;
      let has = false;
      for (const o of sel.options) if (o.value === v) has = true;
      if (!has) { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); }
      sel.value = v;
    }

    let items = [], active = -1;
    function renderSug() {
      if (!items.length) { sug.style.display = 'none'; return; }
      sug.textContent = '';
      items.forEach((r, i) => {
        const it = el('div', {
          padding: '4px 8px', cursor: 'pointer', display: 'flex', gap: '6px', alignItems: 'baseline',
          background: i === active ? 'rgba(240,180,41,.16)' : 'transparent',
        });
        it.append(
          el('b', { color: '#e6edf3' }, r[0]),
          el('span', { color: '#9aa4af', fontSize: '12px' }, (r[2] || '') + (r[3] ? ' [' + r[3] + ']' : '')),
          el('span', { color: '#5b6a7a', fontSize: '11px', marginLeft: 'auto' }, r[4] === 'it' ? '雅思/托福' : r[4] === 'i' ? '雅思' : '托福'),
        );
        it.onmousedown = (ev) => { ev.preventDefault(); pick(r); };
        sug.appendChild(it);
      });
      sug.style.display = 'block';
    }
    function doSearch() {
      items = VINDEX ? VINDEX.search(sIn.value, 8) : [];
      active = items.length ? 0 : -1;
      renderSug();
    }
    function pick(r) {
      wIn.value = r[0];
      lIn.value = (r[2] || '').split('；')[0];
      setPos(r[3]);
      sIn.value = r[0];
      sug.style.display = 'none';
      lIn.focus();
    }

    sIn.addEventListener('input', doSearch);
    sIn.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' && items.length) { active = (active + 1) % items.length; renderSug(); ev.preventDefault(); }
      else if (ev.key === 'ArrowUp' && items.length) { active = (active - 1 + items.length) % items.length; renderSug(); ev.preventDefault(); }
      else if (ev.key === 'Enter') { if (items.length && active >= 0) pick(items[active]); else commit(); ev.preventDefault(); }
      else if (ev.key === 'Escape') pop.remove();
    });
    for (const inp of [wIn, lIn, dIn]) inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(); if (ev.key === 'Escape') pop.remove(); });

    function commit() {
      const word = (wIn.value || sIn.value).trim();
      if (!word) { sIn.focus(); return; }
      state.entries.push({
        id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        t: Math.round(state.video.currentTime * 100) / 100,
        box, word, label: lIn.value.trim(), pos: sel.value,
        dur: Math.max(0.2, parseFloat(dIn.value) || DEFAULT_DUR),
        created: new Date().toISOString(),
      });
      save(); pop.remove(); render();
    }

    document.body.appendChild(pop);
    sIn.focus();
  }

  function openEntryPop(e, x, y) {
    state.video.pause();
    const pop = el('div', {
      'va-pop': '1', position: 'fixed', left: Math.max(8, Math.min(x + 8, innerWidth - 280)) + 'px', top: Math.max(8, Math.min(y + 8, innerHeight - 240)) + 'px',
      zIndex: '2147483002', background: '#11161d', border: '1px solid #2b3644', borderRadius: '10px',
      padding: '14px', minWidth: '240px', font: '14px/1.7 -apple-system,"PingFang SC",sans-serif', color: '#e6edf3',
      boxShadow: '0 10px 30px rgba(0,0,0,.5)',
    });
    const dur = e.dur || DEFAULT_DUR;
    const range = el('div', { color: '#8b949e', fontSize: '12px' }, '');
    const updRange = () => { const s0 = parseFloat(tIn.value) || e.t; range.textContent = '显示区间 ' + r2(s0 - LEAD) + 's ~ ' + r2(s0 + (parseFloat(dIn.value) || dur)) + 's'; };
    pop.append(el('div', { fontWeight: '700', color: '#f0b429' }, e.word),
      el('div', { color: '#9aa4af' }, (e.label || '') + (e.pos ? ' [' + e.pos + ']' : '')),
      range);

    if (isView()) {   // 观看端：只读
      pop.appendChild(el('div', { color: '#8b949e', fontSize: '12px' }, 't = ' + e.t + 's ~ ' + r2((e.t || 0) + dur) + 's'));
      const rowv = el('div', { display: 'flex', gap: '6px', marginTop: '8px' });
      rowv.append(mkbtn('▶ 跳转', () => { state.video.currentTime = e.t; pop.remove(); }), mkbtn('关闭', () => pop.remove()));
      pop.appendChild(rowv);
      document.body.appendChild(pop);
      return;
    }

    const tIn = el('input', { ...IN_STYLE, width: '64px' });
    tIn.type = 'number'; tIn.min = '0'; tIn.step = '0.1'; tIn.value = String(e.t); tIn.title = '开始时间(秒)';
    const dIn = el('input', { ...IN_STYLE, width: '56px' });
    dIn.type = 'number'; dIn.min = '0.2'; dIn.step = '0.1'; dIn.value = String(dur); dIn.title = '时长(秒)';
    tIn.addEventListener('input', updRange); dIn.addEventListener('input', updRange);

    const tRow = el('div', { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px' });
    tRow.append(
      el('span', { color: '#8b949e', fontSize: '12px' }, '开始(秒)'), tIn,
      mkbtn('⏱ 用当前', () => { tIn.value = String(r2(state.video.currentTime)); updRange(); }),
    );
    const dRow = el('div', { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px' });
    dRow.append(
      el('span', { color: '#8b949e', fontSize: '12px' }, '时长(秒)'), dIn,
      mkbtn('保存', () => {
        e.t = Math.max(0, r2(parseFloat(tIn.value)));
        e.dur = Math.max(0.2, r2(parseFloat(dIn.value) || DEFAULT_DUR));
        save(); pop.remove(); render();
      }),
    );
    pop.append(tRow, dRow);

    const row = el('div', { display: 'flex', gap: '6px', marginTop: '8px' });
    row.append(
      mkbtn('▶ 跳转', () => { state.video.currentTime = parseFloat(tIn.value) || e.t; pop.remove(); }),
      mkbtn('🗑 删除', () => { state.entries = state.entries.filter((x2) => x2 !== e); save(); pop.remove(); render(); }),
      mkbtn('关闭', () => pop.remove()),
    );
    pop.appendChild(row);
    updRange();
    document.body.appendChild(pop);
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
      platform: state.platform, videoId: state.mediaId, url: location.href,
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

  function updateStatus() { status.textContent = state.entries.length ? state.entries.length + ' 条' : ''; }

  /* ---------- 启动 ---------- */
  A.watch((v) => { if (v) attach(v); else detach(); });
})();
