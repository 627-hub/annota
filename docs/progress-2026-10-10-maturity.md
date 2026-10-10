# 进展 · 2026-10-10（成熟度补齐：CI 修复 + 集成测试 + i18n + CSP/限流）

> 承接 [`product-plan.md`](product-plan.md) v0.2。本批完成成熟度评估中的三块短板：
> CI 自动化（修复 360min 超时 + 分层）、axum 路由集成测试、i18n 国际化、CSP + REST 限流。

## 已完成

| 包 | 内容 | 关键实现 |
|---|---|---|
| **CI 修复** | 根因：`agent.rs` keyring 测试在 CI runner 无 GUI 会话下阻塞 → 360min 超时。修复：`CI=true` 时跳过 keyring 测试；workflow 加 `timeout-minutes` 硬上限；分层 quick（push/PR）/ full（tag push） | `agent.rs` `llm_key_resolution_prefers_env`；`.github/workflows/ci.yml` |
| **集成测试** | 13 个 axum 路由集成测试（`src/integration.rs`，`#[cfg(test)]`）：health/list/anno CRUD/bookmark/history/settings + Host 守卫 403 + Origin 守卫 403 + content-type 门 415 + diag + CSP 头断言 + 限流 | `sync_server.rs` 抽出 `build_app()` 供测试直接构建 Router；`AppState::new` 改 pub |
| **i18n 前端** | `public/i18n.js` 加载器（XHR 3s 超时 + i18n.js 404 降级不白屏）；`index.html` 81 处 + `overlay.html` 44 处硬编码中文替换为 `__i18n.t()`；HTML 属性经 `applyI18n()` 在 init 回调设置（优雅降级保留中文） | `__i18n.init(cb)` / `__i18n.t(key, params)` / `setLocale()` |
| **i18n Rust** | `src/i18n.rs`：`t()`/`tf()`（`{param}` 占位替换）；locale 解析 env `ANNOTA_LOCALE` → sys-locale → zh-CN；locale 文件与前端共用 `public/i18n/*.json`（`include_str!` 编译期打包） | 5 个 Rust 文件共 110 处替换（89 个 `err.*`/`perm.*` key） |
| **locale 文件** | `public/i18n/zh-CN.json` + `en.json`，184 key 两端一致（CI 有 key 集合一致性单测） | — |
| **CSP 双层** | ① `tauri.conf.json`：`default-src 'self'` + `frame-src 'none'` + `object-src 'none'`（工具栏/浮层 webview）；② `sync_server.rs` `csp_header_middleware`：HTML 响应加同款 CSP，JSON API 不加 | tab webview（外部 URL）不受 tauri.conf CSP 约束（独立安全上下文） |
| **REST 限流** | `rate_limit_middleware`：固定窗口计数器（1s 窗口），GET 60/s、写 15/s，按 method 分桶，超限 429；用已有 DashMap，零新依赖 | `sync_server.rs` `rate_limit_check` |

## 真机验证（2026-10-10）

debug 构建启动后 curl 实测：

- CSP 头 on `/` 和 `/console` ✅；JSON API 无 CSP ✅
- Host 守卫 `evil.com:8793` → 403 ✅；Origin 跨站写 → 403 ✅
- 限流：30 并发 POST → 15×200 + 15×429（精准命中 15/s 写限额）✅
- 正常读 4 端点全 200 ✅
- tauri.conf.json CSP 含 `frame-src 'none'` / `object-src 'none'` ✅

## 验证汇总

cargo test 50/50（含 13 集成 + 5 i18n 单测）；JS 14/14；pw 无头双语言渲染 PASS（en/zh-CN placeholder/菜单/降级）；`node --check` 全过。

## 已知边界

- Rust 端 locale 是进程级缓存（`OnceLock`），运行时切语言需重启；前端即时生效。
- 7 处低优先级 Rust 错误消息未 i18n（`va_fetch` SSRF 拦截、setup 致命错误等，极少触发或仅日志可见）。
- 限流按 method 全局计数（回环地址固定，无需按 IP）；如未来支持远程访问需按 IP 分桶。
- tauri.conf CSP 允许 `'unsafe-inline'`（工具栏/浮层有内联 script/style，Tauri 注入方式限制）。

## 提交

`0795576` feat(security+i18n+ci): CSP 双层防护 + REST 限流 + i18n 国际化 + CI 修复（16 文件 +1931/−814）。

## 下一步（成熟度路线图剩余）

- Tauri 命令级集成测试（需官方 test harness，暂缺）。
- i18n：语言切换 UI（设置页下拉）；Rust 端 locale 跟随前端设置（需 settings.json `locale` 字段 + 热更新）。
- 结构化错误类型（当前全 `Result<T, String>`）。
- crate 内 README + 公共 API rustdoc。
