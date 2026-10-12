# Changelog

Annota 的重要变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。更早版本见 git tag（`v0.2.0`–`v0.2.4`）。

## [Unreleased]

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
- 依赖安全：tauri 2.12.1→2.12.3；rmcp（4 告警，2 高危）与 glib（1 中危）升级受阻于上游，已提 [annota#1](https://github.com/627-hub/annota/issues/1) / [tauri#16264](https://github.com/tauri-apps/tauri/issues/16264) 跟踪。
- 删除死代码（旧 Python sync_server / anki_export / Electron 壳），清零 28 条 CodeQL 告警；CI Python 单测步骤 nullglob 兜底。

[Unreleased]: https://github.com/627-hub/annota/compare/v0.2.5...HEAD
[0.2.5]: https://github.com/627-hub/annota/compare/v0.2.4...v0.2.5
