// 每个网页（webview）的 preload：把 vaFetch/vaCapture/vaCopy 暴露给 core。
// 注意：这里运行在所有远程页面里，因此能力本身受主进程校验约束——
//   va-fetch 仅放行本机/局域网/隧道目标；va-capture 仅截当前页；va-copy 限大小/类型。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vaFetch', (method, url, body) =>
  ipcRenderer.invoke('va-fetch', { method, url, body }));

contextBridge.exposeInMainWorld('vaCapture', (rect) => ipcRenderer.invoke('va-capture', rect));

contextBridge.exposeInMainWorld('vaCopy', (payload) => ipcRenderer.invoke('va-copy', payload));

