# Changelog

Annota 的重要变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。更早版本见 git tag（`v0.2.0`–`v0.2.4`）。

## [Unreleased]

## [0.2.6] - 2026-10-14

### 修复

- **Windows：工具栏 webview 冻结（新建标签页 / 更多菜单 / 编辑气泡 / 标签刷新全部失效）**。根因是工具栏、每个标签页、浮层都是独立 child webview，而 `window.add_child`（创建 WebView2 子窗口）在 WebView2 上是阻塞式 Win32 调用；原先在 Tauri IPC 回调里同步执行，与 wry 的 webview 中间态重入，把**发起调用的工具栏渲染进程整个卡死**。表现是点击照常送达、`invoke` 也返回成功，但界面再无反应。现将 `tab_new` / `overlay_open` 的建 webview 推迟到 IPC 回调之外（复用 `on_new_window` 既有的延迟规避）；`apply_layout` 只给活动 tab 摆位的既有行为不受影响（实测各 webview 零重叠）。
- **编辑态抽屉永远不弹出（按钮态切换但页面无反应）**。两层根因：(1) `initialization_script` 只在 webview **首次创建**时执行一次，那时 URL 仍是 `about:blank`，导航到真实页面后标注层不重放，`core.js` 在真实页面从未初始化，`browser-shell.js` 的 `adopt()` 从未执行，`ctx` 恒为 `null`，`applyShellMode()` 第一行即静默 return；(2) 更关键的是 `core.js` 顶部的防重复守卫 `if (window.__VA_LOADED__) return` —— 该标志在 `about:blank` 阶段置位后随导航保留，导致每次重放都在第一行 return，275KB 脚本**完整执行、零报错、零效果**。现于 `on_page_load` 重放前先清除该守卫，再依次重放桥接 → 插件 → 标注层 → tab id，并补一次壳模式重放以保持跨 tab 编辑态一致。
- Windows 启动预检改为只读：删除原先在启动时 `taskkill /F /IM msedgewebview2.exe` 的全系统强杀（会连带杀掉 Outlook / Teams / 其它 Tauri 应用的后端进程）及 2 秒 sleep；改用注册表 + 磁盘双路探测，仅在确认缺失运行时才弹一次原生对话框。移除随之失效的 `shellexpand` 依赖。

### 排查方法论（值得留存）

本轮两个 bug 的定位过程暴露了一个反复出现的失误模式：**靠读代码推断根因，然后直接改代码验证**。三次这样做全部改错（误判为 webview 几何重叠、误判为 `eval` 体积上限、误判为脚本抛异常），真正的根因都是在加探针实测后才浮现。

有效的做法是**每一步都用可观测数据确认，而不是用推理替代观测**：

- **双向心跳**定位冻结：Rust 线程与工具栏 JS 各打一个 1 秒心跳。Rust 继续跳而 JS 永停，直接证明是渲染进程死亡，而非布局错位或点击被遮挡——而当时的几何测量显示各 webview 零重叠，说明「布局重叠」假设是错的。
- **探针要打在结论产生的地方**，而不是在症状处。本例中在 `setMode` 里读 `ctx` 只能证明「ctx 是 null」，继续在 `mountShell`/`adopt` 逐层加探针才找到真凶。
- **静默失败必须显式打点**。`ctx === null` 时函数第一行直接 return、外面还套着空 `catch`，任何异常都不外泄——这正是问题长期无法定位的原因。新增此类静默路径时应主动补日志。
- **排除法要逐个证伪，不能只验一个假设**。本例依次排除了「几何重叠」「点击未送达」「`invoke` 失败」「`eval` 未执行」「体积上限」「脚本抛异常」，才落到防重复守卫。
- **确认因果链闭合**：从「用户看到按钮无反应」到「某行守卫 return」，每一环都要有实测数据，而不是某一环靠推测补上。

## [0.2.5] - 2026-10-12

自 v0.2.4 起的全部变更（插件生态 + 安全/国际化批次）。

### 新增

- **插件生态（本地 zip 安装）**：插件契约 v1 + 构建期框架；运行时装载层（manifest 校验、安装 token、原子升级含失败回滚、每插件独立注入）；工作区「插件管理」页（两阶段安装 / 启停 / 卸载）+ overlay 菜单入口。
- **内置插件**：`anki_export`（apkg 导出）、`ielts`（雅思词库联动，已外移至 `annota-plugins` 插件仓，zip 可直接安装）。
- **安全与国际化**：CSP 双层防护（tauri.conf + HTML 响应头）、REST 限流（读 60/s、写 15/s）、i18n 中英双语（前端 + Rust 错误文案）。
- **测试与 CI**：13 个 axum 路由集成测试；CI 分层 quick/full + 超时硬上限。

### 变更

- 全仓 `Result<T, String>` → 结构化 `AppError`（错误文案走 i18n key）。
- 插件启停/卸载提示改为「刷新或新开标签页后生效」。

### 修复

- 编辑气泡按实测尺寸钳入视口，头部可拖拽移动——长气泡不再把「保存修改」顶出屏幕。
- OCR review 批量修复：插件升级失败回滚丢数据、CSP `connect-src`、中间件顺序、限流分桶等 20+ 项。
- smoke-export 被本机真 app 篡改 `syncUrl` 打错目标。
- 依赖安全：tauri 2.12.1→2.12.3；**rmcp 4 个告警（2 高危）已修**——弃用半年未维护的 `tauri-plugin-mcp-server`，自建 MCP server 直连官方 rmcp 3.5.1（工具与端点不变，见 [annota#1](https://github.com/627-hub/annota/issues/1)）；glib（1 中危）受阻于 tauri 的 gtk 钉版，见 [tauri#16264](https://github.com/tauri-apps/tauri/issues/16264)。
- 删除死代码（旧 Python sync_server / anki_export / Electron 壳），清零 28 条 CodeQL 告警；CI Python 单测步骤 nullglob 兜底。

[Unreleased]: https://github.com/627-hub/annota/compare/v0.2.5...HEAD
[0.2.5]: https://github.com/627-hub/annota/compare/v0.2.4...v0.2.5
