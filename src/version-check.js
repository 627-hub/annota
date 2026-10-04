/* video-annotate · version-check
 * 轻量「版本探测」：向发布基址拉 version.json，比本地 build 号；落后则提示用户重装。
 * 这是对管理器自动更新（@updateURL）的兜底——即便管理器不自动更新，用户也能被提醒。
 * 只依赖 window，失败静默，不打扰标注主流程。
 */
(function (root) {
  'use strict';
  const CHECK_KEY = 'va:lastVersionCheck';
  const THROTTLE_MS = 6 * 60 * 60 * 1000;   // 6 小时最多探测一次

  function corsFetch(url) {
    if (root.GM_xmlhttpRequest) {
      return new Promise((resolve, reject) => {
        try {
          root.GM_xmlhttpRequest({ method: 'GET', url, timeout: 8000, onload: (r) => resolve(r.responseText), onerror: reject, ontimeout: reject });
        } catch (e) { reject(e); }
      });
    }
    return fetch(url, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))));
  }

  function nudge(latest, local) {
    try {
      if (document.getElementById('annota-version-nudge')) return;
      const host = document.createElement('div');
      host.id = 'annota-version-nudge';
      host.style.cssText = 'position:fixed;z-index:2147483600;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));transform:translateX(-50%);' +
        'max-width:calc(100vw - 32px);display:flex;gap:10px;align-items:center;padding:10px 14px;border:1px solid rgba(245,166,35,.4);' +
        'border-radius:12px;background:rgba(18,20,24,.96);color:#f3d4a2;font:13px/1.4 -apple-system,"PingFang SC",sans-serif;' +
        'box-shadow:0 12px 40px rgba(0,0,0,.5);';
      const text = document.createElement('span');
      text.textContent = 'Annota 有新版本，建议更新';
      const a = document.createElement('a');
      a.textContent = '重装';
      a.href = (root.VA_DIST_BASE || '') + '/annotate.view.user.js';
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.cssText = 'color:#f5a623;font-weight:700;text-decoration:none;white-space:nowrap;';
      const x = document.createElement('button');
      x.textContent = '×';
      x.setAttribute('aria-label', '忽略');
      x.style.cssText = 'all:unset;cursor:pointer;color:#8b949e;padding:0 2px;font-size:15px;';
      x.onclick = () => host.remove();
      host.append(text, a, x);
      (document.body || document.documentElement).appendChild(host);
    } catch (e) { /* 提示失败不影响主流程 */ }
  }

  async function check() {
    try {
      if (!root.VA_BUILD || !root.VA_DIST_BASE) return;
      const last = Number(localStorage.getItem(CHECK_KEY) || 0);
      if (Date.now() - last < THROTTLE_MS) return;
      localStorage.setItem(CHECK_KEY, String(Date.now()));
      const meta = JSON.parse(await corsFetch(root.VA_DIST_BASE + '/version.json') || '{}');
      const latest = Number(meta && meta.build) || 0;
      if (latest > Number(root.VA_BUILD)) nudge(latest, root.VA_BUILD);
    } catch (e) { /* 探测失败：静默 */ }
  }

  root.VAVersion = { check, _nudge: nudge };
})(typeof self !== 'undefined' ? self : this);
