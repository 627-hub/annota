# Annota

**给视频和网页内容加一层可带走的标注：在画面上框一块，记下词条，它就被钉在这一秒和这个位置。**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/627-hub/annota)](https://github.com/627-hub/annota/releases)
[![Website](https://img.shields.io/badge/website-627--hub.github.io%2Fannota-brightgreen)](https://627-hub.github.io/annota/)

![在视频画面上标注一个词](docs/assets/demo-annotation.png)

## 这是什么

看视频或文章时遇到想记的东西，通常只能在另一个 App 里记一行字，跟当时那一幕就断了。Annota 把标注直接锚定到**内容本身**：视频里的时间点和画面区域，网页里的位置。原内容仍由原平台托管，Annota 只保存你写的那一层标注。

标注默认留在本机，可以导出，也可以同步到自己的设备。数据属于标注者。

## 演示

- 在画面上框选区域，填词条、释义、词性，绑定出现时间（截图见上）。
- 从时间轴、词汇表或来源面板回看，点击跳回对应的一帧。

<details>
<summary>更多界面截图（首页 / 我的库）</summary>

![Annota 首页](docs/assets/demo-home.png)

![Annota 我的库](docs/assets/demo-library.png)

</details>

<!-- 演示视频位：录制完成后，把视频链接或 <video> 放在这里 -->

（演示视频制作中。）

## 功能

**标注**：在视频画面拖框选区域，记录词条、释义、词性、开始时间和持续时长。编辑器里可以一键外链 Cambridge、有道、欧路查词。

**回看与管理**：时间轴、词汇、来源三个视图；「我的库」汇总本机所有标注，支持搜索、按类型筛选，导出 Pack。

**同步**：本地服务把标注在设备之间同步，去重合并；局域网内手机可只读观看。

**多种用法**：独立桌面浏览器、Chrome / Edge 扩展、userscript，三端共用同一份标注数据。

**开放接口**：桌面端内置 MCP server，可被外部 AI 客户端调用截图、剪贴板、导航和标注操作。

## 安装

从 [Releases](https://github.com/627-hub/annota/releases) 下载对应版本。

### 桌面版（推荐）

- **macOS**：下载 `Annota_<版本>_aarch64.dmg`，打开后把 Annota 拖进「应用程序」。
  当前安装包没有 Apple 开发者签名，首次打开若被系统拦截，请在「访达」里右键 Annota → **打开**。
- **Windows**：下载 `Annota_<版本>_x64-setup.exe`，运行安装程序。
  安装包未做代码签名，SmartScreen 可能提示，选择「更多信息 → 仍要运行」。

打开即用：内置起始页、我的库、设置和本地同步服务，不需要额外配置。

### 浏览器扩展

1. 下载 `annota-extension-<版本>.zip` 并解压。
2. 打开 `chrome://extensions`（或 `edge://extensions`），开启「开发者模式」。
3. 点「加载已解压的扩展程序」，选中解压出的目录。

### Userscript

下载 `annotate.user.js`，装进任意用户脚本管理器（桌面 Tampermonkey / Violentmonkey；Apple 平台可用开源的 Userscripts）。观看端专用变体是 `annotate.view.user.js`。

安装细节与移动端用法见 [`docs/install.md`](docs/install.md)、[`docs/mobile.md`](docs/mobile.md)。

## 从源码运行

需要 Rust stable、系统 WebView 构建依赖，以及 Tauri CLI 2：

```bash
cargo install tauri-cli --version '^2' --locked
python3 build.py                    # 生成 userscript 与扩展 core
cd app/annota
cargo tauri dev                     # 开发运行
cargo tauri build                   # 打包 dmg / exe
```

### 开发与验证

```bash
python3 build.py
node --test dev/geometry.test.mjs
node dev/smoke.mjs
(cd app/annota && cargo check)
```

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/product-spec.md`](docs/product-spec.md) | 产品定位、界面规格、路线与决策 |
| [`docs/spec.md`](docs/spec.md) | 数据模型、共享协议、模型路线 |
| [`docs/install.md`](docs/install.md) | 各端安装与宿主选择 |
| [`docs/sync.md`](docs/sync.md) | 同步机制 |
| [`docs/mobile.md`](docs/mobile.md) | 移动端只读观看 |
| [`docs/browser.md`](docs/browser.md) | 手机自带油猴浏览器 |

## 安全

数据默认留在本机，服务只监听回环地址。报告漏洞与安全边界见 [`SECURITY.md`](SECURITY.md)。

## 许可证

[Apache-2.0](LICENSE)。
