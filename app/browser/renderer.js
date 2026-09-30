// 浏览器壳的渲染层：动态创建 webview（先设 preload 再挂载），把标注 core 注入每个页面
const home = document.getElementById('home');
const urlBar = document.getElementById('url');
const host = document.getElementById('viewhost');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let view = null;
let CORE = '';

function normalize(input) {
  let s = (input || '').trim();
  if (!s) return '';
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  return s;
}
function navigate(input) {
  const u = normalize(input);
  if (u && view) view.src = u;
}

function showHomeError(msg) {
  home.style.display = 'block';
  const card = home.querySelector('.card');
  card.querySelectorAll('.tip.err').forEach((n) => n.remove());   // 去重，避免累积
  const p = document.createElement('div');
  p.className = 'tip err';
  p.textContent = '⚠ ' + msg;
  card.appendChild(p);
}

async function boot() {
  if (!window.va) { showHomeError('preload 未加载（window.va 缺失）'); return; }
  let paths, core;
  try {
    paths = await window.va.getPaths();
    core = await window.va.getCore();
  } catch (e) {
    showHomeError('初始化失败：' + e.message);
    return;
  }
  CORE = core || '';

  // 关键：先设属性（preload/useragent），再挂到 DOM —— preload 才会生效
  view = document.createElement('webview');
  if (paths && paths.webviewPreload) view.setAttribute('preload', paths.webviewPreload);
  view.setAttribute('useragent', UA);
  host.appendChild(view);

  view.addEventListener('dom-ready', () => {
    let u = '';
    try { u = view.getURL() || ''; } catch (e) {}
    if (u && u !== 'about:blank') home.style.display = 'none';   // 别把首页误藏
    if (CORE) view.executeJavaScript(CORE).catch((e) => console.warn('core inject failed:', e));
  });
  const sync = () => {
    try {
      const u = view.getURL();
      if (u && u !== 'about:blank') urlBar.value = u;
      document.getElementById('back').disabled = !view.canGoBack();
      document.getElementById('fwd').disabled = !view.canGoForward();
    } catch (e) { /* 导航中 getURL 可能抛错，忽略 */ }
  };
  view.addEventListener('did-navigate', sync);
  view.addEventListener('did-navigate-in-page', sync);
  // 失败/崩溃要有反馈 + 可重试
  view.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return; // 用户中止，忽略
    showHomeError('页面加载失败：' + (e.errorDescription || e.errorCode));
  });
  view.addEventListener('render-process-gone', () => {
    showHomeError('页面进程崩溃，可点「⟳ 刷新」重试或换个链接。');
  });

  document.getElementById('back').onclick = () => view.canGoBack() && view.goBack();
  document.getElementById('fwd').onclick = () => view.canGoForward() && view.goForward();
  document.getElementById('reload').onclick = () => view.reload();
  document.getElementById('go').onclick = () => navigate(urlBar.value);
  urlBar.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(urlBar.value); });
  // 平台入口按钮/卡片在 index.html 中定义，这里只负责统一接线
  document.querySelectorAll('.q, .tile').forEach((b) => (b.onclick = () => { const u = b.dataset.u; urlBar.value = u; navigate(u); }));
}

boot();
