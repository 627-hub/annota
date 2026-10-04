/* video-annotate · browser-shell（M2 接缝骨架）
 * 仅「Annota 浏览器」（Tauri 壳）注入的浏览器专用壳。通过 window.VA_BROWSER_SHELL
 * 接管 core 的 dock/panel 容器与「观看/编辑」态，**不改**标注状态机、popover 与数据层。
 *
 * M2 阶段：只做最小 pass-through（接管时不改变任何默认行为），用于验证接缝稳定。
 * 真正的常驻右侧编辑抽屉在 M5 实现（docs/progress-2026-10-04-shell-plan.md §4）。
 *
 * 契约（勿破）：本文件只能操作 core 通过 adopt() 交出的 dock/panel/uiRoot 与其 api；
 * 禁止直接调用 core 内部函数或改标注数据。
 */
(function (root) {
  'use strict';

  // 判定「浏览器壳模式」：Tauri 注入桥（window.__ANNOTA__）存在时启用。
  const IN_BROWSER = !!(root.__ANNOTA__ || root.__TAURI_INTERNALS__ || root.__TAURI__);

  let adopted = null;   // { dock, panel, overlay, toast, uiRoot, api }

  const SHELL_MODE_KEY = 'va:shellMode';   // 'view' | 'edit'（仅浏览器壳用；与 userscript 的 va:viewOnly 语义分开）

  function mode() {
    try { return localStorage.getItem(SHELL_MODE_KEY) === 'edit' ? 'edit' : 'view'; } catch (e) { return 'view'; }
  }
  function setMode(next) {
    try { localStorage.setItem(SHELL_MODE_KEY, next === 'edit' ? 'edit' : 'view'); } catch (e) {}
  }

  root.VA_BROWSER_SHELL = {
    // core 在 mountShell 时调用：交出容器与受控 api。
    adopt(ctx) {
      adopted = ctx;
      // M2：不改行为。仅在 body 上打标，供后续（M5）样式/逻辑区分浏览器壳。
      try { document.documentElement.setAttribute('data-va-shell', IN_BROWSER ? 'browser' : 'none'); } catch (e) {}
      console.log('[annota][shell] adopted (M2 pass-through), browser=%s', IN_BROWSER);
    },
    // core 在 applyMode 时调用：通知观看/编辑态变化。
    onModeChange(m) {
      try { document.documentElement.setAttribute('data-va-mode', m); } catch (e) {}
    },
    // 供工具栏（Tauri 侧）调用：切换观看/编辑态。M2 仅记录；M5 接抽屉。
    setMode(next) { setMode(next); if (adopted) adopted.api.applyMode(); },
    getMode: mode,
    _inBrowser: () => IN_BROWSER,
  };
})(typeof self !== 'undefined' ? self : this);
