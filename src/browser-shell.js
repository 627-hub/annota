/* video-annotate · browser-shell（M5：常驻编辑抽屉）
 * 「Annota 浏览器」（Tauri 壳）专用壳：通过 window.VA_BROWSER_SHELL 接管 core 的
 * dock/panel 容器与「观看/编辑」态，**不改**标注状态机、popover 与数据层。
 *
 * 三态：
 *   观看（默认）—— 零干扰：隐藏 dock，编辑抽屉关闭；热力框照常渲染。
 *   编辑        —— 右侧常驻抽屉（复用 core 的 .va-panel）：头部=对象信息 + 标注/选对象/同步/来源，
 *                 主体=复用 core 的 renderPanel（时间轴/词汇/来源/助手）。
 *   框选进行中  —— 复用 core 的 toggleAnnotate 流程（popover 原样）。
 *
 * 契约（勿破）：只操作 adopt() 交出的 dock/panel/uiRoot 与 api；禁止直连 core 内部状态。
 */
(function (root) {
  'use strict';

  const IN_BROWSER = !!(root.__ANNOTA__ || root.__TAURI_INTERNALS__ || root.__TAURI__);
  const SHELL_MODE_KEY = 'va:shellMode';   // 'view' | 'edit'

  let ctx = null;        // adopt() 交出的 { dock, panel, overlay, toast, uiRoot, api }
  let editbar = null;
  let refreshTimer = null;

  function mode() {
    try { return localStorage.getItem(SHELL_MODE_KEY) === 'edit' ? 'edit' : 'view'; } catch (e) { return 'view'; }
  }
  function setModeStored(next) {
    try { localStorage.setItem(SHELL_MODE_KEY, next === 'edit' ? 'edit' : 'view'); } catch (e) {}
  }

  function mkBtn(label, opts = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'va-shell-btn' + (opts.primary ? ' is-primary' : '');
    b.textContent = label;
    b.setAttribute('aria-pressed', 'false');
    b.onclick = (e) => { e.stopPropagation(); opts.onClick && opts.onClick(b); };
    return b;
  }

  function updateEditBar() {
    if (!ctx || !editbar) return;
    const snap = ctx.api.getState();
    const binding = snap && snap.binding;
    const meta = binding && typeof binding.mediaMeta === 'function' ? binding.mediaMeta() : null;
    const title = String((meta && (meta.title || meta.videoTitle)) || document.title || '当前页面').trim();
    const annotate = !!(snap && snap.annotate);
    const picking = !!(snap && snap.picking);
    editbar.el.classList.toggle('is-active', annotate || picking);
    editbar.objectTitle.textContent = title || '当前页面';
    editbar.objectTitle.title = title || '当前页面';
    editbar.objectType.textContent = binding ? (meta && meta.type === 'article' ? '正文标注' : '视频 / 图片标注') : '尚未选择标注对象';
    editbar.btnAnno.textContent = annotate ? '结束标注' : '开始标注';
    editbar.btnAnno.classList.toggle('is-active', annotate);
    editbar.btnAnno.setAttribute('aria-pressed', String(annotate));
    editbar.btnAnno.setAttribute('aria-label', annotate ? '结束标注模式' : '开始标注');
    editbar.btnPick.classList.toggle('is-active', picking);
    editbar.btnPick.setAttribute('aria-pressed', String(picking));
    editbar.btnPick.textContent = picking ? '取消选对象' : '选对象';
    editbar.btnPick.setAttribute('aria-label', picking ? '取消选择对象' : '选择标注对象');
    editbar.hint.textContent = picking
      ? '点选页面中的视频、图片或正文'
      : annotate ? '拖动框选画面，松开后创建标注' : binding ? '准备就绪 · 可开始框选或切换内容' : '选择页面对象后即可开始标注';
  }

  // 仅在编辑态轮询刷新顶栏（观看态不写 DOM、不空转）
  function setPolling(on) {
    if (!IN_BROWSER) return;
    if (on) {
      if (!refreshTimer) refreshTimer = root.setInterval(updateEditBar, 250);
    } else if (refreshTimer) {
      root.clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // 构建抽屉顶部的编辑操作条（对象信息 + 标注/选对象/同步/来源）
  function buildEditBar() {
    if (!ctx) return null;
    const bar = document.createElement('div');
    bar.className = 'va-shell-editbar';
    const api = ctx.api;

    const object = document.createElement('div');
    object.className = 'va-shell-object';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'va-shell-eyebrow';
    eyebrow.textContent = '当前内容';
    const objectTitle = document.createElement('strong');
    objectTitle.className = 'va-shell-object-title';
    const objectType = document.createElement('span');
    objectType.className = 'va-shell-object-type';
    object.append(eyebrow, objectTitle, objectType);

    const hint = document.createElement('div');
    hint.className = 'va-shell-hint';
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');

    const btnAnno = mkBtn('开始标注', { primary: true, onClick: () => api.toggleAnnotate(!api.getState().annotate) });
    const btnPick = mkBtn('选对象', { onClick: () => api.togglePicker(!api.getState().picking) });
    const btnSync = mkBtn('同步', { onClick: () => api.syncNow() });
    const btnSrc = mkBtn('来源', { onClick: () => api.toggleSources() });
    btnAnno.title = '开始或结束框选标注';
    btnPick.title = '从当前页面选择视频、图片或正文';
    btnSync.title = '立即同步标注';
    btnSrc.title = '管理标注来源';
    const actions = document.createElement('div');
    actions.className = 'va-shell-actions';
    actions.append(btnAnno, btnPick, btnSync, btnSrc);
    bar.append(object, hint, actions);
    return { el: bar, objectTitle, objectType, hint, btnAnno, btnPick, btnSync, btnSrc };
  }

  function applyShellMode() {
    // 非 Annota/Tauri 浏览器必须是完全 pass-through：core 仍按原方式控制 dock/panel。
    if (!IN_BROWSER || !ctx) return;
    const m = mode();
    const editing = m === 'edit';
    setPolling(editing);
    try { document.documentElement.setAttribute('data-va-mode', editing ? 'edit' : 'view'); } catch (e) {}

    // core 每帧会重设 dock 的 inline display；类选择器 + !important 稳定隐藏它。
    ctx.dock.classList.add('va-shell-hidden-dock');

    // 抽屉：编辑态 = docked 常驻；观看态 = 关闭并移除 docked
    if (editing) {
      ctx.panel.classList.add('va-panel--docked');
      if (!editbar) editbar = buildEditBar();
      if (editbar && editbar.el.parentElement !== ctx.panel) ctx.panel.insertBefore(editbar.el, ctx.panel.firstChild);
      ctx.api.togglePanel(true);
      try { ctx.uiRoot.dataset.vaDocked = '1'; } catch (e) {}
      const close = ctx.panel.querySelector('.va-close');
      if (close) {
        close.setAttribute('aria-label', '退出编辑模式');
        close.title = '退出编辑模式（E）';
      }
      updateEditBar();
    } else {
      const snap = ctx.api.getState();
      if (snap && snap.annotate) ctx.api.toggleAnnotate(false);
      if (snap && snap.picking) ctx.api.togglePicker(false);
      ctx.panel.classList.remove('va-panel--docked');
      ctx.api.togglePanel(false);
      try { delete ctx.uiRoot.dataset.vaDocked; } catch (e) {}
      const close = ctx.panel.querySelector('.va-close');
      if (close) {
        close.setAttribute('aria-label', '关闭标注面板');
        close.removeAttribute('title');
      }
    }
  }

  function editableTarget(event) {
    const target = event.composedPath ? event.composedPath()[0] : event.target;
    const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
    return tag === 'input' || tag === 'textarea' || tag === 'select' || !!(target && target.isContentEditable);
  }

  function onKeyDown(event) {
    if (!IN_BROWSER || editableTarget(event) || event.altKey) return;
    const key = String(event.key || '').toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === 'e') {
      event.preventDefault();
      event.stopImmediatePropagation();
      root.VA_BROWSER_SHELL.setMode(mode() === 'edit' ? 'view' : 'edit');
    } else if (!event.metaKey && !event.ctrlKey && key === 'e' && mode() === 'edit') {
      event.preventDefault();
      event.stopImmediatePropagation();
      root.VA_BROWSER_SHELL.setMode('view');
    }
  }

  root.VA_BROWSER_SHELL = {
    adopt(c) {
      if (!IN_BROWSER) return; // userscript/viewer: no DOM writes and no core UI takeover
      ctx = c;
      try { document.documentElement.setAttribute('data-va-shell', 'browser'); } catch (e) {}
      try { applyShellMode(); } catch (e) { console.log('[annota][shell] applyShellMode failed', e); }
      setPolling(mode() === 'edit');
      const close = ctx.panel.querySelector('.va-close');
      if (close) close.addEventListener('click', () => root.VA_BROWSER_SHELL.setMode('view'), true);
      console.log('[annota][shell] adopted (M5 drawer), browser=%s mode=%s', IN_BROWSER, mode());
    },
    // core 在 applyMode 时调用
    onModeChange(m) {
      if (!IN_BROWSER) return;
      // core 的 view/edit 与壳模式独立；这里只记属性，避免与 core 互相覆盖。
      try { document.documentElement.setAttribute('data-va-core-mode', m); } catch (e) {}
    },
    // 工具栏「编辑」按钮 → set_shell_mode 命令 → 此处切换
    setMode(next) {
      if (!IN_BROWSER) return;
      setModeStored(next);
      try { applyShellMode(); } catch (e) {}
      // 通知工具栏同步「编辑」按钮态（跨 webview 广播）
      try {
        const t = root.__TAURI__;
        if (t && t.event && t.event.emit) t.event.emit('annota://shell-mode-changed', { mode: mode() });
      } catch (e) {}
    },
    getMode: mode,
    _inBrowser: () => IN_BROWSER,
  };
  if (IN_BROWSER) {
    root.addEventListener('keydown', onKeyDown, true);
    root.addEventListener('storage', (event) => {
      if (event.key === SHELL_MODE_KEY && ctx) applyShellMode();
    });
  }
})(typeof self !== 'undefined' ? self : this);
