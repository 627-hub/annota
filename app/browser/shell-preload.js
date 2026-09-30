// 浏览器 UI（壳）的 preload：只暴露必要的 IPC 给壳页面
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('va', {
  getCore: () => ipcRenderer.invoke('get-core'),
  getPaths: () => ipcRenderer.invoke('get-paths'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
