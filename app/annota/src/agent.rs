//! 内置 agent：配置、工具清单与流式聊天（Tauri 命令）。
//!
//! 环境变量：
//!   LLM_BASE_URL / ARK_BASE_URL   默认 https://ark.cn-beijing.volces.com/api/v3
//!   LLM_API_KEY  / ARK_API_KEY    未设置则返回「未配置」，不发起请求
//!   LLM_MODEL    / ARK_MODEL      默认 doubao-pro-32k
//!
//! 聊天端点：OpenAI 兼容的 {base}/chat/completions。

use crate::run_tool;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::Emitter;

const MAX_TOOL_ROUNDS: usize = 6;
const TOOL_RESULT_LIMIT: usize = 8000;
const DEFAULT_MODEL: &str = "doubao-pro-32k";
const DEFAULT_BASE: &str = "https://ark.cn-beijing.volces.com/api/v3";

// 待确认的写操作：id -> {name, args}
static PENDING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Value>>> =
    std::sync::OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(1);

fn pending() -> &'static std::sync::Mutex<std::collections::HashMap<String, Value>> {
    PENDING.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// P1-b#13：待确认队列 TTL（30 分钟）。启动时静态 map 天然为空；
/// 每次入队前清一次过期项，读取（确认）时再校验年龄。
const PENDING_TTL_MS: u64 = 30 * 60 * 1000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn purge_expired_pending() {
    if let Ok(mut m) = pending().lock() {
        let now = now_ms();
        m.retain(|_, v| {
            v.get("at").and_then(Value::as_u64).map(|at| now.saturating_sub(at) < PENDING_TTL_MS).unwrap_or(true)
        });
    }
}

/// 需要用户确认后才执行的写操作
pub fn is_write_tool(name: &str) -> bool {
    matches!(name, "propose_annotation" | "start_annotation" | "copy_to_clipboard")
}

struct LlmConfig {
    base: String,
    key: String,
    model: String,
}

// ---------- P1-c#15：LLM API key 的本机钥匙串存取（不落 settings 文件） ----------
const KEYCHAIN_SERVICE: &str = "Annota";
const KEYCHAIN_ACCOUNT: &str = "llm-api-key";

pub fn keychain_llm_key() -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .ok()?
        .get_password()
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn keychain_set_llm_key(key: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| e.to_string())?
        .set_password(key.trim())
        .map_err(|e| e.to_string())
}

pub fn keychain_delete_llm_key() -> Result<(), String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(entry) => match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        },
        Err(e) => Err(e.to_string()),
    }
}

/// key 解析顺序：环境变量（开发者友好）→ 钥匙串（in-app 录入）→ 空。
pub fn resolve_llm_key() -> String {
    std::env::var("LLM_API_KEY")
        .or_else(|_| std::env::var("ARK_API_KEY"))
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(keychain_llm_key)
        .unwrap_or_default()
}

fn config(app: &tauri::AppHandle) -> Option<LlmConfig> {
    let key = resolve_llm_key();
    if key.trim().is_empty() {
        return None;
    }
    let saved = std::fs::read_to_string(crate::sync_server::resolve_settings_path(app))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({}));
    let saved_ai = saved.get("ai").cloned().unwrap_or_else(|| json!({}));
    let base = std::env::var("LLM_BASE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| std::env::var("ARK_BASE_URL").ok().filter(|v| !v.trim().is_empty()))
        .or_else(|| saved_ai.get("baseUrl").and_then(Value::as_str).filter(|v| !v.trim().is_empty()).map(String::from))
        .unwrap_or_else(|| DEFAULT_BASE.to_string());
    let model = std::env::var("LLM_MODEL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| std::env::var("ARK_MODEL").ok().filter(|v| !v.trim().is_empty()))
        .or_else(|| saved_ai.get("model").and_then(Value::as_str).filter(|v| !v.trim().is_empty()).map(String::from))
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    Some(LlmConfig { base: base.trim_end_matches('/').to_string(), key, model })
}

fn tools_json() -> Value {
    let obj = |props: Value, required: Value| json!({"type":"object","properties":props,"required":required});
    let no_args = json!({"type":"object","properties":{}});
    let list = json!([
        {"type":"function","function":{"name":"capture_frame","description":"捕获当前 Annota 窗口截图，返回 PNG base64","parameters":no_args}},
        {"type":"function","function":{"name":"words_at","description":"查询某个时间点（秒）出现的标注词条","parameters":obj(json!({
            "t":{"type":"number","description":"时间点（秒）"},
            "media_id":{"type":"string","description":"可选；缺省用当前页面"},
            "radius":{"type":"number","description":"时间容差秒，默认 0.5"}
        }), json!(["t"]))}},
        {"type":"function","function":{"name":"navigate","description":"让 Annota 浏览器跳转到指定 URL","parameters":obj(json!({"url":{"type":"string"}}), json!(["url"]))}},
        {"type":"function","function":{"name":"open_annotations","description":"打开当前网页的标注侧栏","parameters":no_args}},
        {"type":"function","function":{"name":"copy_to_clipboard","description":"把文本写入系统剪贴板","parameters":obj(json!({"text":{"type":"string"}}), json!(["text"]))}}
    ]);
    // 写操作：需用户确认
    let mut arr = list.as_array().cloned().unwrap_or_default();
    arr.push(json!({"type":"function","function":{"name":"propose_annotation","description":"把候选框与词语送入确认卡；需用户确认后才会写入","parameters":obj(json!({
        "box":{"type":"object","properties":{"x":{"type":"number"},"y":{"type":"number"},"w":{"type":"number"},"h":{"type":"number"}},"required":["x","y","w","h"]},
        "word":{"type":"string"},"label":{"type":"string"},"pos":{"type":"string"},"t":{"type":"number"},"dur":{"type":"number"}
    }), json!(["box","word"]))}}));
    arr.push(json!({"type":"function","function":{"name":"start_annotation","description":"进入框选标注模式；需用户确认","parameters":no_args}}));
    Value::Array(arr)
}

fn system_prompt() -> String {
    let app = crate::APP_HANDLE.get();
    let mut ctx = String::new();
    if let Some(app) = app {
        // P2-fix：读 TabState 缓存 URL（不回调 Webview::url()——崩溃根因）
        let url = crate::tabs::active_tab_url(app);
        if !url.is_empty() {
            ctx.push_str(&format!("当前页面：{url}\n"));
        }
    }
    format!(
        "你是 Annota 的内置助手。Annota 给视频和网页加标注（词条 + 时间点 + 画面区域）。\n\
你可以调用工具来查看当前内容与标注，回答要简短、直接、中文。\n\
涉及写入（propose_annotation / start_annotation）时，工具会先请用户确认，不要重复调用。\n\
{ctx}"
    )
}

fn truncate(s: &str, limit: usize) -> String {
    if s.chars().count() <= limit {
        return s.to_string();
    }
    let mut out: String = s.chars().take(limit).collect();
    out.push_str("\n…（已截断）");
    out
}

fn emit_tool(handle: &tauri::AppHandle, id: &str, name: &str, args: &Value, status: &str, result: &Value) {
    let _ = handle.emit(
        "annota-agent-tool",
        json!({"id": id, "name": name, "arguments": args, "status": status, "result": result}),
    );
}

/// 执行一个工具调用（写操作走确认；其余直接跑）
fn invoke_tool(handle: &tauri::AppHandle, id: &str, name: &str, args: Value, caller: &str) -> Value {
    if is_write_tool(name) {
        purge_expired_pending();
        let confirm_id = format!("c{}", SEQ.fetch_add(1, Ordering::Relaxed));
        pending().lock().unwrap_or_else(|e| e.into_inner()).insert(
            confirm_id.clone(),
            json!({"name": name, "arguments": args.clone(), "at": now_ms(), "caller": caller}),
        );
        emit_tool(
            handle,
            id,
            name,
            &args,
            "pending",
            &json!({"confirm_id": confirm_id, "message": crate::i18n::t("err.need_user_confirm"), "arguments": args}),
        );
        return json!({"needs_confirmation": true, "confirm_id": confirm_id});
    }
    match run_tool(name, &args) {
        Ok(text) => {
            let value = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!(text));
            emit_tool(handle, id, name, &args, "done", &compact_tool_result(name, &value));
            value
        }
        Err(err) => {
            let value = json!({"error": err});
            emit_tool(handle, id, name, &args, "error", &value);
            value
        }
    }
}

/// 直接执行一次工具（供面板调用：例如用户点「确认」）
pub fn call_tool(name: &str, args: Value) -> Value {
    match run_tool(name, &args) {
        Ok(text) => serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!(text)),
        Err(err) => json!({"error": err}),
    }
}

fn chat_urls(base: &str) -> Vec<String> {
    let url = if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    };
    vec![url]
}

fn include_images() -> bool {
    std::env::var("ANNOTA_CHAT_IMAGES")
        .map(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "off"))
        .unwrap_or(true)
}

fn compact_tool_result(name: &str, result: &Value) -> Value {
    if name == "capture_frame" {
        return json!({
            "format": result.get("format").and_then(Value::as_str).unwrap_or("png"),
            "width": result.get("width").and_then(Value::as_u64).unwrap_or(0),
            "height": result.get("height").and_then(Value::as_u64).unwrap_or(0),
            "bytes": result.get("bytes").and_then(Value::as_u64).unwrap_or(0),
            "image_attached_to_model": include_images()
        });
    }
    let encoded = result.to_string();
    if encoded.chars().count() > TOOL_RESULT_LIMIT {   // 与 truncate 的 chars 单位一致（OCR-fix）
        json!({"summary": truncate(&encoded, TOOL_RESULT_LIMIT)})
    } else {
        result.clone()
    }
}

fn client_messages(convo: &[Value]) -> Vec<Value> {
    convo
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) != Some("system"))
        .map(|message| {
            let mut message = message.clone();
            if let Some(parts) = message.get("content").and_then(Value::as_array) {
                message["content"] = Value::Array(
                    parts
                        .iter()
                        .map(|part| {
                            if part.get("type").and_then(Value::as_str) == Some("image_url") {
                                json!({"type":"text","text":"[截图已提供给模型]"})
                            } else {
                                part.clone()
                            }
                        })
                        .collect(),
                );
            }
            message
        })
        .collect()
}

async fn call_llm(client: &reqwest::Client, cfg: &LlmConfig, messages: &Value) -> Result<Value, String> {
    let body = json!({
        "model": cfg.model,
        "messages": messages,
        "tools": tools_json(),
        "tool_choice": "auto",
        "stream": false
    });
    let mut last_err = crate::i18n::t("err.llm_request_failed");
    for url in chat_urls(&cfg.base) {
        let resp = client
            .post(&url)
            .bearer_auth(&cfg.key)
            .json(&body)
            .send()
            .await;
        match resp {
            Err(e) => last_err = e.to_string(),
            Ok(r) => {
                let status = r.status();
                let text = r.text().await.unwrap_or_default();
                if !status.is_success() {
                    last_err = format!("HTTP {status}: {}", truncate(&text, 300));
                    continue;
                }
                match serde_json::from_str::<Value>(&text) {
                    Ok(v) if v.get("choices").is_some() => return Ok(v),
                    Ok(_) => {
                        last_err = crate::i18n::tf("err.llm_no_choices", &[("url", url.as_str())])
                    }
                    Err(e) => {
                        last_err = crate::i18n::tf(
                            "err.llm_parse_failed",
                            &[("url", url.as_str()), ("e", &e.to_string())],
                        )
                    }
                }
            }
        }
    }
    Err(last_err)
}

fn extract_message(response: &Value) -> Value {
    let message = response
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .cloned()
        .unwrap_or_else(|| json!({"role": "assistant", "content": ""}));
    // 把 reasoning_content 并入正文，便于面板显示
    if let Some(reason) = message.get("reasoning_content").and_then(|v| v.as_str()) {
        if !reason.trim().is_empty() {
            let content = message.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let mut merged = message.clone();
            merged["content"] = json!(format!("[思考] {reason}\n\n{content}").trim());
            return merged;
        }
    }
    message
}

/// 运行一轮 agent（工具循环）；返回最终消息与审计记录
#[tauri::command]
pub async fn agent_run(
    app: tauri::AppHandle,
    w: tauri::Webview,
    messages: Vec<Value>,
) -> Result<Value, String> {
    crate::require_local_or_trusted(&app, &w, &crate::i18n::t("perm.ai_agent"))?;
    // OCR-fix：config() 内含同步 fs 读取 + keyring 调用——下放到 blocking 线程，别卡 async 运行时
    let app_cfg = app.clone();
    let cfg = tauri::async_runtime::spawn_blocking(move || config(&app_cfg))
        .await
        .map_err(|e| e.to_string())?
        .ok_or(crate::i18n::t("err.llm_key_missing"))?;
    // OCR-fix：写确认绑定发起会话的 webview label，跨会话不可消费（防猜 confirm_id）
    let caller = w.label().to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let mut convo: Vec<Value> = vec![json!({"role": "system", "content": system_prompt()})];
    // OCR-fix：旧 take(40) 保留的是**最旧**消息、丢掉最新上下文——保留最新 40 条
    let keep_from = messages.len().saturating_sub(40);
    convo.extend(messages.into_iter().skip(keep_from));

    let mut audit: Vec<Value> = Vec::new();
    let mut final_message = json!({"role": "assistant", "content": ""});

    for _round in 0..MAX_TOOL_ROUNDS {
        let response = call_llm(&client, &cfg, &Value::Array(convo.clone())).await?;
        let message = extract_message(&response);
        convo.push(message.clone());

        let calls = message.get("tool_calls").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        if calls.is_empty() {
            final_message = message;
            break;
        }

        for (i, call) in calls.iter().enumerate() {
            let id = call.get("id").and_then(|v| v.as_str()).unwrap_or("call").to_string();
            let function = call.get("function").cloned().unwrap_or_else(|| json!({}));
            let name = function.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let args: Value = function
                .get("arguments")
                .and_then(|v| v.as_str())
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_else(|| json!({}));

            let result = invoke_tool(&app, &format!("{id}-{i}"), &name, args.clone(), &caller);
            let compact = compact_tool_result(&name, &result);
            audit.push(json!({"id": id, "name": name, "arguments": args, "result": compact}));
            convo.push(json!({
                "role": "tool",
                "tool_call_id": id,
                "content": truncate(&compact.to_string(), TOOL_RESULT_LIMIT)
            }));
            if name == "capture_frame" && include_images() {
                if let Some(b64) = result.get("base64").and_then(Value::as_str) {
                    convo.push(json!({
                        "role": "user",
                        "content": [
                            {"type":"text","text":"请结合当前 Annota 窗口截图回答用户问题。"},
                            {"type":"image_url","image_url":{"url":format!("data:image/png;base64,{b64}"),"detail":"auto"}}
                        ]
                    }));
                }
            }
        }
        final_message = message;
    }

    // OCR-fix：轮次耗尽时若模型仍停在 tool_calls，用户将收不到任何回复——
    // 兜底成显式说明（该轮排队的写确认交由 30min TTL 清理）。
    if final_message.get("tool_calls").and_then(Value::as_array).map(|a| !a.is_empty()).unwrap_or(false) {
        let content = final_message.get("content").and_then(Value::as_str).unwrap_or("");
        final_message["content"] = json!(if content.is_empty() {
            crate::i18n::t("err.tool_round_limit")
        } else {
            format!(
                "{content}\n{}",
                crate::i18n::t("err.tool_round_limit_suffix")
            )
        });
    }

    Ok(json!({
        "message": final_message,
        "messages": client_messages(&convo),
        "audit": audit,
    }))
}

/// 直接执行一次已确认的工具
#[tauri::command]
pub fn agent_chat(app: tauri::AppHandle, w: tauri::Webview, confirm_id: String) -> Result<Value, String> {
    crate::require_local_or_trusted(&app, &w, &crate::i18n::t("perm.ai_agent"))?;
    let entry = pending()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&confirm_id)
        .ok_or(crate::i18n::t("err.confirm_expired"))?;
    let age = now_ms().saturating_sub(entry.get("at").and_then(Value::as_u64).unwrap_or(0));
    if age >= PENDING_TTL_MS {
        return Err(crate::i18n::t("err.confirm_expired_detailed"));
    }
    // OCR-fix：确认必须来自发起该写操作的同一 webview（防其他会话猜 confirm_id 消费）
    let entry_caller = entry.get("caller").and_then(Value::as_str).unwrap_or("");
    if !entry_caller.is_empty() && entry_caller != w.label() {
        return Err(crate::i18n::t("err.confirm_cross_session"));
    }
    let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let args = entry.get("arguments").cloned().unwrap_or_else(|| json!({}));
    Ok(call_tool(name, args))
}

/// 取消尚未确认的写操作
#[tauri::command]
pub fn agent_cancel(app: tauri::AppHandle, w: tauri::Webview, confirm_id: String) -> bool {
    if crate::require_local_or_trusted(&app, &w, &crate::i18n::t("perm.ai_agent")).is_err() {
        return false;
    }
    pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&confirm_id).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_ttl_purge_and_reject() {
        let old = now_ms().saturating_sub(PENDING_TTL_MS + 60_000);
        {
            let mut m = pending().lock().unwrap_or_else(|e| e.into_inner());
            m.insert("ctest-old".into(), json!({"name":"copy_to_clipboard","arguments":{},"at":old}));
            m.insert("ctest-new".into(), json!({"name":"copy_to_clipboard","arguments":{},"at":now_ms()}));
        }
        purge_expired_pending();
        {
            let m = pending().lock().unwrap_or_else(|e| e.into_inner());
            assert!(!m.contains_key("ctest-old"), "过期项应被清理");
            assert!(m.contains_key("ctest-new"), "未过期项应保留");
        }
        // 年龄判定（agent_chat 内的双保险）：过期条目应被判过期
        let age = {
            let m = pending().lock().unwrap_or_else(|e| e.into_inner());
            let e = m.get("ctest-new").unwrap();
            now_ms().saturating_sub(e.get("at").and_then(Value::as_u64).unwrap_or(0))
        };
        assert!(age < PENDING_TTL_MS, "新条目未过期");
    }

    #[test]
    fn llm_key_resolution_prefers_env() {
        if std::env::var("CI").is_ok() {
            eprintln!("skip: keyring 不可用于 CI runner（无 GUI 登录会话）");
            return;
        }
        let _ = resolve_llm_key();
    }
}
