# Annota

**给视频、图片、文章加一层可带走的标注。** 框一块画面、划一段文字，记下你要说的话——它就被钉在这一处，下次点一下回到原位。

[![Release](https://img.shields.io/github/v/release/627-hub/annota?color=%23f5a623)](https://github.com/627-hub/annota/releases/latest)
[![Discord](https://img.shields.io/badge/Discord-加入内测-5865F2?logo=discord&logoColor=white)](https://discord.gg/xN4huYbF)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

![在视频画面上标注一个词](docs/assets/demo-annotation.png)

## 下载 / 安装

### 🖥️ 桌面版（推荐，自带自动更新）
打开即用，内置起始页、我的库、同步服务。

| 平台 | 下载 |
|---|---|
| macOS（Apple 芯片） | [下载 `.dmg`](https://github.com/627-hub/annota/releases/latest) → 拖进「应用程序」。已签名公证；若被拦，右键 → 打开。 |
| Windows | [下载 `.exe`](https://github.com/627-hub/annota/releases/latest) → 运行。未签名，SmartScreen 选「更多信息 → 仍要运行」。 |

### 🧩 浏览器扩展（Chrome / Edge）
在 [Releases](https://github.com/627-hub/annota/releases/latest) 下载 `annota-extension-*.zip` 并解压 →
打开 `chrome://extensions`（或 `edge://extensions`）→ 开启「开发者模式」→「加载已解压的扩展程序」→ 选中解压目录。

### 📱 油猴脚本（任意浏览器，含手机 · 装一次自动更新）
用 Tampermonkey / Violentmonkey（Apple 端用免费的 Userscripts）打开下面链接即安装：

- 电脑编辑端 → **[安装 annotate.user.js](https://tencentcloudtest-d2eg4lu85c76fb0-1414056833.tcloudbaseapp.com/annotate.user.js)**
- 手机观看端（只读，打开即同步）→ **[安装 annotate.view.user.js](https://tencentcloudtest-d2eg4lu85c76fb0-1414056833.tcloudbaseapp.com/annotate.view.user.js)**

## 它能做什么

- **视频** — 在画面上框选区域，绑到某个时间点，回看时点一下跳回那一帧。
- **图片** — 在图上框选；长图滚动、窗口缩放、换设备，框位都不漂。
- **文章** — 选中正文一段文字做锚点，页面改版后仍能找回。
- **我的库** — 所有标注汇总在一处，可搜索、编辑、删除、导出。
- **同步** — 本机与局域网设备间去重合并；手机只读观看，不打扰原内容。

## 为什么是它

内容不搬家，只在你看到的那一处加一层标注。原视频 / 图片 / 文章仍由原平台托管，**标注数据默认留在本机，属于你**。

<p>
<img src="docs/assets/demo-home.png" width="49%" alt="Annota 首页" />
<img src="docs/assets/demo-library.png" width="49%" alt="Annota 我的库" />
</p>

## 社区与反馈

内测、提 bug、出主意都欢迎来 **Discord** 👉 **https://discord.gg/xN4huYbF**

## 许可

[Apache-2.0](LICENSE)。
