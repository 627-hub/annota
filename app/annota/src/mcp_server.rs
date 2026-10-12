//! 自建 MCP server：streamable HTTP @ `127.0.0.1:8794/mcp`。
//!
//! 原实现依赖 `tauri-plugin-mcp-server` 0.1.0（上游半年未发版、crates.io 仅此一版，
//! 钉死 `rmcp ^1` 导致 4 个 rmcp 安全告警无法修补）。改为直接使用官方 rmcp SDK，
//! 工具清单与行为保持不变（8 个工具，`crate::run_tool` 单一入口）。

use std::sync::Arc;

use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde_json::Value;

const MCP_ADDR: &str = "127.0.0.1:8794";

fn schema(v: Value) -> Arc<rmcp::model::JsonObject> {
    Arc::new(
        v.as_object()
            .expect("tool schema must be a JSON object")
            .clone(),
    )
}

/// 工具清单（与原 tauri-plugin-mcp-server 版本逐字一致）。
fn tool_defs() -> Vec<Tool> {
    vec![
        Tool::new(
            "capture_frame",
            "捕获当前 Annota 窗口（webview）的截图，返回 PNG base64 与元数据",
            schema(serde_json::json!({
                "type": "object",
                "properties": {
                    "media_id": { "type": "string", "description": "可选的媒体 ID（当前未使用）" }
                }
            })),
        ),
        Tool::new(
            "copy_to_clipboard",
            "将图片（PNG base64）、纯文本、HTML 写入系统剪贴板",
            schema(serde_json::json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "纯文本" },
                    "html": { "type": "string", "description": "HTML 片段" },
                    "image": { "type": "string", "description": "PNG base64（可选）" }
                }
            })),
        ),
        Tool::new(
            "navigate",
            "让 Annota 浏览器跳转到指定 URL（agent 操作能力）",
            schema(serde_json::json!({
                "type": "object",
                "properties": { "url": { "type": "string", "description": "目标 URL" } },
                "required": ["url"]
            })),
        ),
        Tool::new(
            "open_annotations",
            "打开当前网页的 Annota 标注侧栏",
            schema(serde_json::json!({"type":"object","properties":{}})),
        ),
        Tool::new(
            "start_annotation",
            "在当前视频进入框选标注模式",
            schema(serde_json::json!({"type":"object","properties":{}})),
        ),
        Tool::new(
            "propose_annotation",
            "把 AI 候选框与词语送入 Annota 确认卡；只有用户确认保存后才会写入",
            schema(serde_json::json!({
                "type": "object",
                "properties": {
                    "box": {
                        "type": "object",
                        "properties": {
                            "x": {"type":"number"}, "y": {"type":"number"},
                            "w": {"type":"number"}, "h": {"type":"number"}
                        },
                        "required": ["x", "y", "w", "h"]
                    },
                    "word": {"type":"string"},
                    "label": {"type":"string"},
                    "pos": {"type":"string"},
                    "t": {"type":"number"},
                    "dur": {"type":"number"}
                },
                "required": ["box", "word"]
            })),
        ),
        Tool::new(
            "words_at",
            "查询某个时间点（秒）出现的标注词条，返回词、释义、时间与画面区域；缺省针对当前页面",
            schema(serde_json::json!({
                "type": "object",
                "properties": {
                    "t": {"type": "number", "description": "时间点（秒）"},
                    "media_id": {"type": "string", "description": "可选；缺省用当前页面对应的标注"},
                    "radius": {"type": "number", "description": "时间容差秒数，默认 0.5"}
                },
                "required": ["t"]
            })),
        ),
        Tool::new(
            "probe_bridge",
            "探测 browser webview 中 window.__ANNOTA__ 是否注入成功",
            schema(serde_json::json!({"type":"object","properties":{}})),
        ),
    ]
}

#[derive(Clone)]
pub struct AnnotaMcp;

impl ServerHandler for AnnotaMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("annota", env!("CARGO_PKG_VERSION")))
            .with_instructions("Annota 内容标注浏览器 MCP：截图、剪贴板、导航与标注操作。")
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult {
            tools: tool_defs(),
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let name = request.name.to_string();
        let args = request
            .arguments
            .map(Value::Object)
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
        // 工具级失败走 CallToolResult::error（客户端可见错误文案），
        // 协议级 Err 只留给请求本身不可路由的情况（见 rmcp 文档）。
        match crate::run_tool(&name, &args) {
            Ok(text) => Ok(CallToolResult::success(vec![ContentBlock::text(text)]).into()),
            Err(e) => Ok(CallToolResult::error(vec![ContentBlock::text(e.to_string())]).into()),
        }
    }
}

/// 在 setup 阶段调用：绑定 127.0.0.1:8794 并常驻服务（与原插件行为一致）。
pub fn spawn() {
    let service = StreamableHttpService::new(
        || Ok(AnnotaMcp),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default(),
    );
    let router = axum::Router::new().nest_service("/mcp", service);
    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::bind(MCP_ADDR).await {
            Ok(listener) => {
                crate::alog!("INFO", "mcp server listening on http://{MCP_ADDR}/mcp");
                if let Err(e) = axum::serve(listener, router).await {
                    crate::alog!("ERROR", "mcp server exited: {e}");
                }
            }
            Err(e) => crate::alog!("ERROR", "mcp server bind {MCP_ADDR} failed: {e}"),
        }
    });
}
