// video-annotate 浏览器 · 主进程
// 自建浏览器壳：内置标注 core；同步请求走主进程 net.fetch（不受页面 CORS/混合内容限制）
const { app, BrowserWindow, ipcMain, net, shell, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const CORE_PATH = path.join(__dirname, 'core.js');
let CORE = '';
try { CORE = fs.readFileSync(CORE_PATH, 'utf8'); } catch (e) { /* core.js 由 build.py 生成 */ }

// 允许同步请求的目标：本机/局域网（与 core 的零配置候选一致），其它一律拒绝，防 SSRF
function isAllowedTarget(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const h = url.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    if (h.endsWith('.local')) return true;
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (h.endsWith('.trycloudflare.com')) return true;   // 隧道（用户自选）
    return false;
  } catch (e) { return false; }
}

const SHELL_URL = pathToFileURL(path.join(__dirname, 'index.html')).href;
// 只信任「本壳页面」发来的特权 IPC（精确匹配，不放行任意 file:// 本地页）
function fromShell(e) {
  try { return e.senderFrame && e.senderFrame.url === SHELL_URL; }
  catch (err) { return false; }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1240, height: 840,
    title: 'video-annotate 浏览器',
    backgroundColor: '#0b0e13',
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.loadFile('index.html');
  return win;
}

ipcMain.handle('get-core', (e) => (fromShell(e) ? CORE : ''));
ipcMain.handle('get-paths', (e) => (fromShell(e) ? { webviewPreload: pathToFileURL(path.join(__dirname, 'webview-preload.js')).href } : {}));

// 代发同步请求（主进程，无 CORS / 无混合内容限制）——仅放行本机/局域网目标
ipcMain.handle('va-fetch', async (e, { method, url, body }) => {
  try {
    if (!isAllowedTarget(url)) return { ok: false, status: 0, error: '目标地址不被允许（仅限本机/局域网/隧道）' };
    const r = await net.fetch(url, {
      method: method || 'GET',
      redirect: 'manual',                 // 不自动跟随跳转（防止 302 逃出允许名单 → SSRF）
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status >= 300 && r.status < 400) {
      return { ok: false, status: r.status, error: '重定向被拒绝' };
    }
    let json = null;
    try { json = await r.json(); } catch (_) {}
    return { ok: r.ok, status: r.status, json };
  } catch (err) {
    return { ok: false, status: 0, error: String((err && err.message) || err) };
  }
});

// 截图：捕获「发送方 webContents（即当前网页）」的指定区域，返回 PNG dataURL
ipcMain.handle('va-capture', async (e, rect) => {
  try {
    const r = rect && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(rect[k])) ? rect : undefined;
    const img = r ? await e.sender.capturePage(r) : await e.sender.capturePage();
    return img.isEmpty() ? null : img.toDataURL();
  } catch (err) {
    return null;
  }
});

// 富剪贴板：一次写入文本 + 图片（桌面豆包粘贴时按需取用）
const IMG_OK = /^data:image\/(png|jpe?g|webp|gif);base64,/i;
ipcMain.handle('va-copy', (e, { text, dataUrl }) => {
  try {
    let image = null;
    if (typeof dataUrl === 'string' && IMG_OK.test(dataUrl) && dataUrl.length < 20 * 1024 * 1024) {
      image = nativeImage.createFromDataURL(dataUrl);
      if (image.isEmpty()) image = null;
    }
    const t = typeof text === 'string' ? text.slice(0, 200000) : '';
    if (image) clipboard.write({ text: t, image });
    else if (t) clipboard.writeText(t);
    return true;
  } catch (err) {
    return false;
  }
});

// 仅允许 http(s)，挡掉 file://、smb://、自定义 scheme
ipcMain.handle('open-external', async (e, url) => {
  if (!fromShell(e)) return false;
  try {
    const u = new URL(String(url));
    if (u.protocol === 'http:' || u.protocol === 'https:') { await shell.openExternal(u.href); return true; }
  } catch (err) {}
  return false;
});

app.whenReady().then(() => {
  const win = createWindow();
  // 新窗口/弹窗一律用系统浏览器打开，且只放行 http(s)
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { const u = new URL(url); if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href); } catch (e) {}
    return { action: 'deny' };
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
