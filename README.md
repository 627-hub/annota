# Annota

给视频和网页内容加一层可带走的标注。把词条、时间点和画面区域放在一起；原内容仍由原平台托管，标注数据可导出。

Annota 提供独立桌面浏览器、Chrome/Edge 扩展和 userscript。桌面浏览器内置起始页、我的库、设置、本地同步服务与 MCP server。

## 功能

- 在视频画面框选区域，记录词条、释义、词性、时间和持续时长。
- 用时间轴、词汇和来源面板查看标注；AI 候选框以虚线显示，需人工确认后保存。
- 通过本地数据服务同步标注、浏览本机内容库、导出 Pack。
- 内置 MCP server，提供截图、剪贴板、浏览器导航与标注操作工具。
- 编辑卡提供 Cambridge、有道和欧路词典外链。内置词库已移除，查词不要求下载词表。

内置聊天 Agent 面板及工具调用审计目前搁置；现有 MCP server 可由外部 MCP 客户端连接。

## 快速开始

### Annota 桌面浏览器

需要 Rust stable、系统 WebView 构建依赖，以及 Tauri CLI 2：

```bash
cargo install tauri-cli --version '^2' --locked
python3 build.py
cd app/annota
cargo tauri dev
```

发布构建：

```bash
cd app/annota
cargo tauri build
```

桌面应用在本机启动同步服务 `127.0.0.1:8793`，并启动 MCP streamable HTTP 服务 `127.0.0.1:8794/mcp`。本地标注存储在应用数据目录；开发模式默认使用 `app/service/store/`。

### Chrome / Edge 扩展

1. 在 `chrome://extensions` 或 `edge://extensions` 打开开发者模式。
2. 选择“加载已解压的扩展程序”，选中仓库内 `app/extension/`。

### Userscript

构建后将以下任一脚本安装到兼容的用户脚本管理器：

- `dist/annotate.user.js`：编辑端
- `dist/annotate.gm.user.js`：使用 GM 请求接口的编辑端
- `dist/annotate.view.user.js`：只读观看端，自动同步

Apple 平台可使用开源 Userscripts。安装与移动端说明见 [`docs/install.md`](docs/install.md)、[`docs/mobile.md`](docs/mobile.md) 和 [`docs/browser.md`](docs/browser.md)。

## 开发与验证

```bash
python3 build.py
node --test dev/geometry.test.mjs
node dev/smoke.mjs
(cd app/annota && cargo check)
```

`build.py` 从 `src/` 生成三种 userscript，并同步生成扩展/浏览器用的 `core.js`。完整产品约定见 [`docs/product-spec.md`](docs/product-spec.md)，技术与数据模型见 [`docs/spec.md`](docs/spec.md)。

## 发行

推送 `main` 会用 GitHub Actions 部署 [`site/`](site/) 到 GitHub Pages（首次部署前，在仓库 **Settings → Pages → Build and deployment** 选择 **GitHub Actions**）。网站地址为 <https://627-hub.github.io/annota/>。为版本打上与 `tauri.conf.json` 一致的 `v*` 标签后，Actions 构建 macOS DMG、Windows 安装程序 EXE、扩展 ZIP 和 userscript 附件，并创建 GitHub Release。macOS 签名与公证需要维护者配置 Apple Developer 凭据；未配置时生成的 DMG 不带开发者签名。

## 项目结构

```text
app/annota/          Tauri v2 桌面浏览器与 MCP server
app/extension/       Chrome / Edge MV3 扩展
app/service/         本地服务页面与 Python 标准库同步服务
site/                GitHub Pages 下载与介绍页
src/                 标注核心、平台适配、几何计算和设计 tokens
dist/                可直接安装的 userscript 发行文件
dev/                 构建辅助、演示页面与测试
docs/                产品、安装、同步与技术文档
```

## 项目状态

R1 桌面 UI 与词库移除已完成，发行构建正在准备。内置 Agent 面板（R1-3）按计划搁置；图片和文章标注属于后续阶段。当前发行版本为 `0.1.0`。
