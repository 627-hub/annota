# video-annotate 浏览器（自建浏览器壳）

> **DEPRECATED（2026-10-09，M8-1）**：Electron 壳已冻结，不再投入开发；主线是 Tauri 壳 `app/annota/`。
> 本目录保留末版供考古；`build.py` 不再生成其 `core.js`（末版已在库）。勿在此目录新开功能。

「下载即用」的品牌载体：打开就是浏览器，**内置标注**，无需管理器、无需配置。

## 运行
```bash
cd app/browser
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install   # 首次
npm start
```
或一键（由仓库根）：
```bash
bash dev/app.sh
```

## 结构
```
app/browser/
├── package.json        # electron
├── main.js             # 主进程：窗口 + 代发同步请求(net.fetch，无 CORS/混合内容)
├── shell-preload.js    # 壳 UI 的 IPC（取 core、webview preload 路径）
├── webview-preload.js  # 每个网页暴露 window.vaFetch 给 core
├── index.html          # 浏览器界面（地址栏 + 快捷入口 + 首页说明）
├── renderer.js         # 导航 + 把 core 注入每个页面
└── core.js             # ← build.py 从 src/ 生成（与扩展/userscript 共用）
```

## 为什么是「自建浏览器」
- **用户认知**：这是一个**标注浏览器**，不是「又要装个插件」。
- **零配置**：同步地址烧进 `core.js`（`window.VA_SYNC_URLS`），打开即用。
- **无 CORS/混合内容**：同步走主进程 `net.fetch`（页面里用 `window.vaFetch`）。
- **可换场景**：英语/小语种情境学习、通用视频数据标注，都是同一套 core。

## 打包分发（下一步）
```bash
npm i -D electron-builder
npx electron-builder --mac --win --linux   # 产出 .dmg/.exe，用户下载即装即用
```
