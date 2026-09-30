# 「下载即用」的几条路（开源浏览器调研）

目标：把同步地址等设置**绑进项目**，用户**下载即用**，不再装管理器、不再配置。
结论：**不必从零 fork 浏览器**。按性价比从高到低有三条路。

## 路线 1：MV3 扩展（本仓库已实现）
`app/extension/`（`manifest.json` + `background.js` + `core.js`，与 userscript **共用同一份 core**）。
- 桌面：Chrome/Edge/Brave/Chromium `chrome://extensions` → 开发者模式 → 加载已解压。或一键：
  ```bash
  bash dev/portable.sh https://www.bilibili.com/video/BVxxxx
  ```
  便携启动器用独立资料夹带上扩展，**不动你日常浏览器**。
- Android：**Firefox Android** 支持从 AMO 装扩展；把扩展发布到 AMO 即可**一键安装**（无需付费）。
- 上架即「下载即用」：Chrome Web Store（$5 一次性）/ Edge Add-ons（免费）/ AMO（免费）。
- 请求走扩展后台（`background.js`），**绕过 CORS 与混合内容**——移动端 https 页面同步直接可用。

## 路线 2：直接用「自带油猴引擎」的开源浏览器（Android，最省事）
这些浏览器**本身就内置 userscript 引擎**，用户只要装我们的脚本（扫码一次）即可：

| 项目 | 引擎 | 说明 |
|---|---|---|
| **Ezo** `xxjrq/ezo` | WebView | 轻量 Android 浏览器，内置 UserScript 引擎（33 个 GM API）、GreasyFork 安装流、<5MB |
| **GuaBrowser** `gtlx/gua` | GeckoView | 原生 WebExtension 注入，完整油猴支持（`document_start`/隔离世界/CSP 穿透/GM_xmlhttpRequest） |
| **Solipsism** `Kenneth-Cho-InfoSec/Solipsism` | WebView | 内置 userscript（仅 `@grant none`）；我们的脚本正好 `@grant none`，可直接跑 |
| **Cromite** `uazo/cromite` | Chromium | Chromium fork，**实验性 userscript 支持**（7k★） |
| **Ravix** | GeckoView | Android，扩展 + 持久后台标签 |

→ 让手机用户装 **Ezo / GuaBrowser / Solipsism / Cromite** 任一个，扫码装我们的观看端脚本即可。**零 fork**。

## 路线 3：自己做一个「标注浏览器」（最酷，成本最高）
把 core **内置**进一个自建浏览器壳，真正「下载这个 App → 打开就是」。

| 思路 | 现成参考 | 成本 |
|---|---|---|
| **Electron 壳（已实现 `app/browser/`）**：窗口 + `<webview>` + 注入 core；同步走主进程 `net.fetch` | 本仓库 | ✅ 已完成（`bash dev/app.sh`） |
| Tauri 壳：Rust + 系统 WebView，注入 core | `MauricioPerera/mcp-browser`（Tauri 浏览器，自动注入 bridge 脚本）；`aurous37-lang/tauri-plugin-extensions`（在 Tauri 里跑 MV3 扩展） | 中 |
| Chromium fork：把扩展**预装**进发行版 | Chromium 可改 `BUILD.gn` 打包 default extension，或用**策略/预装扩展**（`external_extensions.json`）；配置化工具 `4evy/browser` | 高（要编 Chromium，不建议） |

**建议**：先走路线 1（扩展 + 便携启动器 + 上架）覆盖桌面；Android 走路线 2（让用户用带油猴引擎的开源浏览器）。
只有当你要一个**独立的「标注浏览器」品牌 App** 时，才做路线 3 的 Electron/Tauri 壳。

## 现状对照
| 端 | 现在怎么用 | 之后「下载即用」 |
|---|---|---|
| 桌面 | 装管理器 + 装脚本 | **MV3 扩展**（本地加载 / portable.sh / 上架后一键） |
| Android | 装管理器 + 装脚本 | 装 **Ezo/Gua/Solipsism/Cromite** 之一 + 扫码装脚本；或 Firefox + AMO 扩展 |
| iOS | Safari + Userscripts | 需 Safari 扩展（App Store，成本高）；或维持 Userscripts |
