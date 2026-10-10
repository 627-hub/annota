# Annota

Annota 是一个内容标注浏览器——给视频和网页加可分享的、时间锚定 + 区域锚定的标注。

## 架构

```
src/
├── main.rs          # Tauri 入口：窗口/webview/布局/命令注册
├── tabs.rs          # 多标签页管理（child webview 叠放 + 会话恢复）
├── store.rs         # SQLite 持久化（收藏/历史/下载）
├── sync_server.rs   # 本地 REST 服务（axum，127.0.0.1:8793）
├── agent.rs         # 内置 AI agent（OpenAI 兼容 + 工具循环）
├── apkg.rs          # Anki .apkg 导出
├── i18n.rs          # 本地化（t/tf，与前端共用 locale JSON）
├── error.rs         # 结构化错误（AppError { code, message }）
└── logf.rs          # 滚动日志 + panic hook
```

## 错误处理

所有用户可见错误使用 `AppError` 结构化类型：

```rust
use crate::error::AppError;

// 从 i18n key 构造（code 自动去前缀，message 自动本地化）
Err(AppError::key("err.tab_not_found"))
Err(AppError::keyf("err.tab_webview_missing", &[("id", &id)]))

// 内部/系统错误（不本地化，保留原始细节）
Err(AppError::internal(format!("open db: {e}")))
```

序列化形态（Tauri command 错误 / HTTP 响应）：

```json
{ "code": "tab_not_found", "message": "标签不存在：tab-3" }
```

前端按 `code` 分支处理，展示 `message`。

## i18n

- locale 文件：`public/i18n/zh-CN.json` + `en.json`（184 key，两端一致）
- Rust：`crate::i18n::t("key")` / `tf("key", &[("param", &val)])`
- 前端：`__i18n.t("key")` / `__i18n.init(callback)`
- locale 解析：env `ANNOTA_LOCALE` → 系统 locale（sys-locale）→ zh-CN

## 安全

- **CSP**：tauri.conf.json（webview）+ sync_server 响应头（HTML 页面）
- **Host/Origin 守卫**：REST API 拒绝非回环 Host / 跨站 Origin
- **限流**：固定窗口（GET 60/s，写 15/s）
- **凭据**：API key 存 OS keychain，不落 settings 文件
- **高危命令**：调用方必须是壳内页面或信任站点

## 测试

```bash
cargo test          # 55 tests（单元 + 集成）
```

集成测试（`src/integration.rs`）覆盖 axum 路由：health/CRUD/守卫/CSP/限流。

## 构建

```bash
python3 build.py    # 重建 dist 产物
cargo build         # debug
cargo tauri build   # release（需 tauri-cli）
```
