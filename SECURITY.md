# 安全策略

## 支持的版本

| 版本 | 是否维护 |
|---|---|
| 0.1.x | 是 |

## 报告漏洞

请不要用公开 issue 报告安全问题。请通过 GitHub 的私密漏洞报告提交：

<https://github.com/627-hub/annota/security/advisories/new>

报告中请尽量包含：

- 受影响的版本与形态（桌面应用 / 扩展 / userscript）
- 复现步骤或最小验证
- 影响范围（能读到什么、能改到什么）
- 如果有，附上修复建议

我们会在收到报告后尽快确认，并在修复发布后署名致谢（如果你希望署名）。

## 安全设计

**数据默认在你手里；跨设备与协作走云端社群（小组共享）。**

- **云端社群**：小组共享经 CloudBase 托管；面向用户的凭据只活在浏览器里（`localStorage`），不随发行包分发。
- **本机数据落点**：标注存本地应用数据目录；浏览器数据（收藏 / 浏览历史 / 下载记录）存本机 SQLite（`annota.db`）。**浏览历史默认开启、仅写本机、可一键清空**；下载的文件落到本机 `~/Downloads/Annota/`（文件名清洗、重名自动去重）。
- 本地页服务（工作区 / 我的库 / 本地数据 API）绑定 `127.0.0.1:8793`，仅回环；内置 MCP server 绑 `127.0.0.1:8794`。
- 密钥（AI / 翻译等）只从环境变量或本机钥匙串读取，不入发行包、不入仓库。

## 已知边界（有意为之）

- 为给任意网站加标注，桌面浏览器把桥接命令开放给已加载的页面：截图（`capture_frame`）、写剪贴板（`write_clipboard`）、导航（`navigate_browser`）、受限的本地请求（`va_fetch`），并启用了 `withGlobalTauri`（页面可拿到 `window.__TAURI__` 便捷 API，实际命令仍受 capabilities 白名单约束）。**请在可信网站使用，不要用 Annota 打开来源不明的页面。**
- `va_fetch` 只允许 `127.0.0.1` / `localhost` / `::1` 上的本地服务，页面无法用它访问任意远端地址。
- 本地 REST（`/api/bookmarks`、`/api/history`、`/api/downloads` 等）：可选、仅回环、无鉴权、未校验 `Host`/`Origin`（DNS rebinding 风险），**待加固**；仅建议在可信本机环境使用。
- 平台说明：macOS 正式发布版经 Apple 签名与公证；Windows 安装包未做代码签名，SmartScreen 可能提示。
