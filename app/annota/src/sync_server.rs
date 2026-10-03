use axum::{
    body::Bytes,
    extract::{Path as AxumPath, Query, State},
    http::{header::CONTENT_TYPE, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use chrono::Local;
use dashmap::DashMap;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::fs;
use tokio::sync::Mutex;
use tower_http::services::ServeDir;

use crate::apkg;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 8793;
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const SERVICE_INDEX: &str = include_str!("../../service/index.html");
const APP_TOKENS_CSS: &str = include_str!("../public/tokens.css");

#[derive(Clone)]
pub struct AppState {
    store: PathBuf,
    root: PathBuf,
    notes_dir: PathBuf,
    settings: PathBuf,
    exports: PathBuf,
    locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
    settings_lock: Arc<Mutex<()>>,
}

impl AppState {
    fn new(store: PathBuf, root: PathBuf, notes_dir: PathBuf, settings: PathBuf, exports: PathBuf) -> Self {
        Self {
            store,
            root,
            notes_dir,
            settings,
            exports,
            locks: Arc::new(DashMap::new()),
            settings_lock: Arc::new(Mutex::new(())),
        }
    }
}

pub fn resolve_store_path(app: &AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("ANNOTA_STORE") {
        return PathBuf::from(p);
    }
    if cfg!(debug_assertions) {
        if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
            let manifest = PathBuf::from(manifest);
            if let Some(root) = manifest.parent().and_then(|p| p.parent()) {
                return root.join("app/service/store");
            }
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("Annota"))
        .join("store")
}

pub fn resolve_project_root() -> PathBuf {
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let manifest = PathBuf::from(manifest);
        if let Some(root) = manifest.parent().and_then(|p| p.parent()) {
            return root.to_path_buf();
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors() {
            if ancestor.join("dev").is_dir() && ancestor.join("dist").is_dir() {
                return ancestor.to_path_buf();
            }
        }
    }
    std::env::current_dir().unwrap_or_default()
}

pub fn resolve_notes_dir(app: &AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("NOTES_DIR") {
        return PathBuf::from(p);
    }
    if cfg!(debug_assertions) {
        if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
            let manifest = PathBuf::from(manifest);
            if let Some(root) = manifest.parent().and_then(|p| p.parent()) {
                return root.join("app/service/notes");
            }
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("Annota"))
        .join("notes")
}

pub fn resolve_settings_path(app: &AppHandle) -> PathBuf {
    if let Ok(path) = std::env::var("ANNOTA_SETTINGS") {
        return PathBuf::from(path);
    }
    if cfg!(debug_assertions) {
        if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
            let manifest = PathBuf::from(manifest);
            if let Some(root) = manifest.parent().and_then(|p| p.parent()) {
                return root.join("app/service/settings.json");
            }
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("Annota"))
        .join("settings.json")
}

pub async fn run_server(store: PathBuf, root: PathBuf, notes_dir: PathBuf, settings: PathBuf) {
    let exports = store
        .parent()
        .map(|p| p.join("exports"))
        .unwrap_or_else(|| store.join("exports"));
    let state = AppState::new(store, root, notes_dir, settings, exports);

    let mut app = Router::new()
        .route("/", get(root_handler))
        .route("/app/annota/public/tokens.css", get(tokens_css))
        .route("/console", get(console_page))
        // 工作区页面态依赖的模块脚本（release 无 ServeDir，必须内嵌路由）
        .route("/src/identity.js", get(identity_js))
        .route("/src/group.js", get(group_js))
        .route("/api/health", get(health))
        .route("/api/list", get(list))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/ai", get(ai_status))
        .route("/api/note", post(note))
        .route("/api/export/card", post(export_card))
        .route("/api/export/finalize", post(export_finalize))
        .route("/exports/:file", get(serve_export))
        .route(
            "/api/anno/:media_id",
            get(get_anno).put(put_anno).post(put_anno),
        );
    if cfg!(debug_assertions) {
        app = app.fallback_service(ServeDir::new(state.root.clone()));
    }
    let app = app.with_state(state);

    let addr = format!("{}:{}", HOST, PORT);
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[annota] sync server failed to bind {}: {}", addr, e);
            return;
        }
    };
    println!("[annota] sync server listening on http://{}", addr);
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[annota] sync server error: {}", e);
    }
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn json_ok(value: Value) -> Response {
    (StatusCode::OK, Json(value)).into_response()
}

async fn health(State(state): State<AppState>) -> Response {
    let store = state.store.to_string_lossy().to_string();
    json_ok(json!({
        "ok": true,
        "store": store,
        "host": HOST,
        "port": PORT,
    }))
}

fn default_settings() -> Value {
    json!({
        "sync": { "address": "", "auto": false },
        "shortcuts": { "annotate": "alt+d", "panel": "alt+l", "overlay": "alt+s" },
        "dictUrlTemplate": "",
        "ai": { "baseUrl": "", "model": "" }
    })
}

fn normalized_shortcut(value: Option<&Value>, default: &str) -> Result<String, String> {
    let raw = value.and_then(Value::as_str).unwrap_or(default).trim().to_ascii_lowercase();
    if raw.is_empty() {
        return Ok(String::new());
    }
    if raw.len() > 32 {
        return Err("快捷键长度不能超过 32 个字符".to_string());
    }
    let parts: Vec<&str> = raw.split('+').collect();
    let key = parts.last().copied().unwrap_or("");
    let valid_key = key.len() == 1 && key.chars().all(|c| c.is_ascii_alphanumeric())
        || (key.starts_with('f') && key[1..].parse::<u8>().map(|n| (1..=12).contains(&n)).unwrap_or(false));
    if !valid_key {
        return Err(format!("不支持的快捷键：{raw}"));
    }
    let mut seen = std::collections::HashSet::new();
    for modifier in parts.iter().take(parts.len().saturating_sub(1)) {
        if !matches!(*modifier, "alt" | "ctrl" | "meta" | "shift") || !seen.insert(*modifier) {
            return Err(format!("快捷键修饰键无效：{raw}"));
        }
    }
    Ok(raw)
}

fn normalize_settings(input: &Value) -> Result<Value, String> {
    let defaults = default_settings();
    let sync = input.get("sync").unwrap_or(&defaults["sync"]);
    let address = sync.get("address").and_then(Value::as_str).unwrap_or("").trim();
    if !address.is_empty() {
        let parsed = url::Url::parse(address).map_err(|_| "同步地址必须是 http(s) URL".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err("同步地址必须是 http(s) URL".to_string());
        }
    }
    let shortcuts = input.get("shortcuts").unwrap_or(&defaults["shortcuts"]);
    let dict_template = input
        .get("dictUrlTemplate")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !dict_template.is_empty() {
        if !dict_template.contains("{word}") {
            return Err("词典链接模板必须包含 {word}".to_string());
        }
        let sample = dict_template.replace("{word}", "annota");
        let parsed = url::Url::parse(&sample).map_err(|_| "词典模板必须是有效的 http(s) URL".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err("词典模板必须是有效的 http(s) URL".to_string());
        }
    }
    let ai = input.get("ai").unwrap_or(&defaults["ai"]);
    let ai_base = ai.get("baseUrl").and_then(Value::as_str).unwrap_or("").trim();
    if !ai_base.is_empty() {
        let parsed = url::Url::parse(ai_base).map_err(|_| "AI Base URL 必须是 http(s) URL".to_string())?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err("AI Base URL 必须是 http(s) URL".to_string());
        }
    }
    let ai_model = ai.get("model").and_then(Value::as_str).unwrap_or("").trim();
    if ai_model.len() > 160 {
        return Err("AI 模型名过长".to_string());
    }
    Ok(json!({
        "sync": {
            "address": address,
            "auto": sync.get("auto").and_then(Value::as_bool).unwrap_or(false)
        },
        "shortcuts": {
            "annotate": normalized_shortcut(shortcuts.get("annotate"), "alt+d")?,
            "panel": normalized_shortcut(shortcuts.get("panel"), "alt+l")?,
            "overlay": normalized_shortcut(shortcuts.get("overlay"), "alt+s")?
        },
        "dictUrlTemplate": dict_template,
        "ai": { "baseUrl": ai_base, "model": ai_model }
    }))
}

async fn get_settings(State(state): State<AppState>) -> Response {
    let settings = match fs::read_to_string(&state.settings).await {
        Ok(text) => match serde_json::from_str::<Value>(&text).ok().and_then(|v| normalize_settings(&v).ok()) {
            Some(settings) => settings,
            None => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "invalid settings file"),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => default_settings(),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("read settings: {e}")),
    };
    json_ok(json!({ "ok": true, "settings": settings }))
}

async fn put_settings(State(state): State<AppState>, body: Bytes) -> Response {
    if body.len() > 64 * 1024 {
        return json_error(StatusCode::PAYLOAD_TOO_LARGE, "settings body too large");
    }
    let incoming: Value = match serde_json::from_slice::<Value>(&body) {
        Ok(v) if v.is_object() => v,
        Ok(_) => return json_error(StatusCode::BAD_REQUEST, "settings must be an object"),
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &format!("bad json: {e}")),
    };
    let settings = match normalize_settings(&incoming) {
        Ok(v) => v,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &e),
    };
    let _guard = state.settings_lock.lock().await;
    if let Some(parent) = state.settings.parent() {
        if let Err(e) = fs::create_dir_all(parent).await {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("create settings dir: {e}"));
        }
    }
    let serialized = match serde_json::to_vec_pretty(&settings) {
        Ok(v) => v,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("serialize settings: {e}")),
    };
    if let Err(e) = fs::write(&state.settings, serialized).await {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("write settings: {e}"));
    }
    json_ok(json!({ "ok": true, "settings": settings }))
}

async fn list(State(state): State<AppState>) -> Response {
    let mut files = Vec::new();
    if let Ok(mut entries) = fs::read_dir(&state.store).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".json") {
                files.push(name);
            }
        }
    }
    files.sort();
    json_ok(json!({ "files": files }))
}

async fn get_anno(State(state): State<AppState>, AxumPath(media_id): AxumPath<String>) -> Response {
    let pack = read_pack(&state.store, &media_id).await;
    json_ok(pack)
}

async fn put_anno(
    State(state): State<AppState>,
    AxumPath(media_id): AxumPath<String>,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    if body.len() > MAX_BODY_BYTES {
        return json_error(StatusCode::PAYLOAD_TOO_LARGE, "body too large");
    }

    let incoming: Value = match serde_json::from_slice::<Value>(&body) {
        Ok(v) if v.is_object() => v,
        Ok(_) => return json_error(StatusCode::BAD_REQUEST, "bad body"),
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &format!("bad json: {e}")),
    };

    let lock = state
        .locks
        .entry(media_id.clone())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone();

    // 整包替换：请求体 "replace": true 或 ?replace=1
    let replace = incoming
        .get("replace")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || matches!(query.get("replace").map(String::as_str), Some("1") | Some("true"));

    let pack = {
        let _guard = lock.lock().await;
        let cur = read_pack(&state.store, &media_id).await;
        let existing = cur.get("entries").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let incoming_entries = incoming
            .get("entries")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let merged = if replace {
            merge_entries(&[], &incoming_entries)
        } else {
            merge_entries(&existing, &incoming_entries)
        };
        let media = incoming
            .get("media")
            .cloned()
            .or_else(|| cur.get("media").cloned())
            .unwrap_or_else(|| json!({ "videoId": media_id }));
        let format = incoming
            .get("format")
            .and_then(|v| v.as_str())
            .or_else(|| cur.get("format").and_then(|v| v.as_str()))
            .unwrap_or("video-annotate/0.1");
        let pack = json!({
            "format": format,
            "media": media,
            "entries": merged,
        });
        if let Err(e) = write_pack(&state.store, &media_id, &pack).await {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("merge failed: {e}"));
        }
        pack
    };

    json_ok(pack)
}

async fn ai_status(State(state): State<AppState>) -> Response {
    let saved = fs::read_to_string(&state.settings)
        .await
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| default_settings());
    let saved_ai = saved.get("ai").cloned().unwrap_or(Value::Null);
    let base = std::env::var("LLM_BASE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| std::env::var("ARK_BASE_URL").ok().filter(|v| !v.trim().is_empty()))
        .or_else(|| saved_ai.get("baseUrl").and_then(Value::as_str).filter(|v| !v.trim().is_empty()).map(String::from))
        .unwrap_or_else(|| "https://ark.cn-beijing.volces.com/api/v3".to_string());
    let key = std::env::var("LLM_API_KEY")
        .or_else(|_| std::env::var("ARK_API_KEY"))
        .unwrap_or_default();
    let model = std::env::var("LLM_MODEL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| std::env::var("ARK_MODEL").ok().filter(|v| !v.trim().is_empty()))
        .or_else(|| saved_ai.get("model").and_then(Value::as_str).filter(|v| !v.trim().is_empty()).map(String::from))
        .unwrap_or_else(|| "doubao-pro-32k".to_string());
    json_ok(json!({
        "ok": true,
        "configured": !key.is_empty(),
        "model": model,
        "base": base,
        "baseUrl": base,
    }))
}

async fn note(State(state): State<AppState>, body: Bytes) -> Response {
    if body.len() > MAX_BODY_BYTES {
        return json_error(StatusCode::PAYLOAD_TOO_LARGE, "body too large");
    }
    let rec: Value = match serde_json::from_slice::<Value>(&body) {
        Ok(v) => v,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &format!("bad json: {e}")),
    };
    match save_note(&state.notes_dir, &rec).await {
        Ok(path) => json_ok(json!({
            "ok": true,
            "path": path.to_string_lossy(),
            "dir": state.notes_dir.to_string_lossy(),
        })),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

// ---------- 批量导出：截图卡 → Anki（本地个人导出；共享 Pack 不含截图，ADR-6）----------
fn shot_name(idx: i64) -> String {
    format!("annota_{}.png", sanitize_key(&idx.to_string()))
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn card_html(entry: &Value, media: &Value, t: f64, idx: i64, has_shot: bool) -> (String, String) {
    let raw_word = entry.get("word").and_then(|v| v.as_str()).unwrap_or("");
    let word = if raw_word.trim().is_empty() {
        entry
            .get("tags")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
            .unwrap_or("标注")
    } else {
        raw_word
    };
    let word = esc(word);
    let label = esc(entry.get("label").and_then(|v| v.as_str()).unwrap_or(""));
    let pos = esc(entry.get("pos").and_then(|v| v.as_str()).unwrap_or(""));
    let tagstr = esc(&entry
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(|x| format!("#{x}")).collect::<Vec<_>>().join(" "))
        .unwrap_or_default());
    let plat = esc(media.get("platform").and_then(|v| v.as_str()).unwrap_or(""));
    let title = esc(media.get("title").and_then(|v| v.as_str()).unwrap_or(""));
    let url = esc(media.get("url").and_then(|v| v.as_str()).unwrap_or(""));
    // 正面 = 只看单词；背面 = 词 + 截图 + 释义/词性 + 来源
    let front = format!("<div class=\"va-word\">{word}</div>");
    let shot = if has_shot { format!("<img src=\"{}\">", shot_name(idx)) } else { String::new() };
    let back = format!(
        "<div class=\"va-word\">{word}</div>{shot}<div class=\"va-meta\">{label} {pos} {tagstr}</div>\
         <div class=\"va-src\">{plat} · {title} · {t}s<br>{url}</div>"
    );
    (front, back)
}

async fn count_cards(dir: &Path) -> i64 {
    let mut n = 0i64;
    if let Ok(mut entries) = fs::read_dir(dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry.file_name().to_string_lossy().ends_with(".json") {
                n += 1;
            }
        }
    }
    n
}

async fn export_card(State(state): State<AppState>, body: Bytes) -> Response {
    if body.len() > MAX_BODY_BYTES {
        return json_error(StatusCode::PAYLOAD_TOO_LARGE, "body too large");
    }
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &format!("bad json: {e}")),
    };
    let deck_id = payload.get("deck_id").and_then(|v| v.as_str()).unwrap_or("deck");
    let idx = match payload.get("idx").and_then(|v| v.as_i64()) {
        Some(i) => i,
        None => return json_error(StatusCode::BAD_REQUEST, "idx 必填"),
    };
    let base = state.exports.join(".tmp").join(sanitize_key(deck_id));
    let cards_dir = base.join("cards");
    // 每次导出是新一批：首卡到来时清空上一批的 cards/media，避免残留旧卡（按 idx 命名会串数据）
    if idx == 0 {
        let _ = fs::remove_dir_all(base.join("cards")).await;
        let _ = fs::remove_dir_all(base.join("media")).await;
    }
    if let Err(e) = fs::create_dir_all(&cards_dir).await {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("create cards dir: {e}"));
    }
    let mut has_shot = false;
    if let Some(shot) = payload.get("screenshot").and_then(|v| v.as_str()) {
        if shot.starts_with("data:image") {
            if let Some(b64) = shot.split(',').nth(1) {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                    let media_dir = base.join("media");
                    if fs::create_dir_all(&media_dir).await.is_ok()
                        && fs::write(media_dir.join(shot_name(idx)), &bytes).await.is_ok()
                    {
                        has_shot = true;
                    }
                }
            }
        }
    }
    let rec = json!({
        "idx": idx,
        "entry": payload.get("entry").cloned().unwrap_or(json!({})),
        "media": payload.get("media").cloned().unwrap_or(json!({})),
        "has_shot": has_shot,
        "t": payload.get("entry").and_then(|e| e.get("t")).and_then(|v| v.as_f64()).unwrap_or(0.0),
    });
    let path = cards_dir.join(format!("{}.json", sanitize_key(&idx.to_string())));
    let bytes = match serde_json::to_vec(&rec) {
        Ok(b) => b,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("serialize: {e}")),
    };
    if let Err(e) = fs::write(&path, bytes).await {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("write card: {e}"));
    }
    let done = count_cards(&cards_dir).await;
    json_ok(json!({ "ok": true, "has_shot": has_shot, "done": done }))
}

async fn export_finalize(State(state): State<AppState>, body: Bytes) -> Response {
    if body.len() > MAX_BODY_BYTES {
        return json_error(StatusCode::PAYLOAD_TOO_LARGE, "body too large");
    }
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &format!("bad json: {e}")),
    };
    let deck_id = payload.get("deck_id").and_then(|v| v.as_str()).unwrap_or("deck");
    let deck_name = payload.get("deck_name").and_then(|v| v.as_str()).unwrap_or("Annota").trim();
    let deck_name = if deck_name.is_empty() { "Annota" } else { deck_name };

    let base = state.exports.join(".tmp").join(sanitize_key(deck_id));
    let cards_dir = base.join("cards");
    let media_dir = base.join("media");

    let mut recs: Vec<Value> = Vec::new();
    match fs::read_dir(&cards_dir).await {
        Ok(mut entries) => {
            while let Ok(Some(entry)) = entries.next_entry().await {
                if !entry.file_name().to_string_lossy().ends_with(".json") {
                    continue;
                }
                if let Ok(bytes) = fs::read(entry.path()).await {
                    if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                        recs.push(v);
                    }
                }
            }
        }
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "没有可导出的卡片（先调 /api/export/card）"),
    }
    recs.sort_by(|a, b| {
        let ai = a.get("idx").and_then(|v| v.as_i64()).unwrap_or(0);
        let bi = b.get("idx").and_then(|v| v.as_i64()).unwrap_or(0);
        ai.cmp(&bi)
    });

    let mut notes: Vec<apkg::Note> = Vec::new();
    let mut media_files: Vec<apkg::Media> = Vec::new();
    for r in &recs {
        let entry = r.get("entry").cloned().unwrap_or(json!({}));
        let media = r.get("media").cloned().unwrap_or(json!({}));
        let idx = r.get("idx").and_then(|v| v.as_i64()).unwrap_or(0);
        let t = r.get("t").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let has_shot = r.get("has_shot").and_then(|v| v.as_bool()).unwrap_or(false);
        // 只有截图文件确实可读时才算有图，避免 note 里 <img> 指向不存在的媒体
        let shot_bytes = if has_shot {
            fs::read(media_dir.join(shot_name(idx))).await.ok()
        } else {
            None
        };
        let (front, back) = card_html(&entry, &media, t, idx, shot_bytes.is_some());
        if let Some(bytes) = shot_bytes {
            media_files.push(apkg::Media { name: shot_name(idx), bytes });
        }
        // 标签：固定 annota + 只保留用户选的语言学习类 tag（英语学习/雅思…）
        let mut tags: Vec<String> = vec!["annota".to_string()];
        if let Some(list) = entry.get("tags").and_then(|v| v.as_array()) {
            for tag in list.iter().filter_map(|x| x.as_str()) {
                if is_lang_tag(tag) {
                    tags.push(tag.to_string());
                }
            }
        }
        let mid = media
            .get("mediaId")
            .and_then(|v| v.as_str())
            .or_else(|| media.get("videoId").and_then(|v| v.as_str()))
            .unwrap_or("");
        let eid = entry
            .get("id")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| idx.to_string());
        notes.push(apkg::Note {
            guid: apkg::guid_for(&[mid, &eid]),
            front,
            back,
            tags,
            sort: entry.get("word").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        });
    }

    if let Err(e) = fs::create_dir_all(&state.exports).await {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("create exports: {e}"));
    }
    // 文件名：annota_<视频号>.apkg（不掺中文 deck 名）
    let mid_raw = recs
        .first()
        .and_then(|r| r.get("media"))
        .and_then(|m| m.get("mediaId").or_else(|| m.get("videoId")))
        .and_then(|v| v.as_str())
        .map(|s| s.replace(':', "_"))
        .unwrap_or_else(|| deck_id.to_string());
    let mid = sanitize_key(&mid_raw);
    let file_name = format!("annota_{}.apkg", mid);
    let out = state.exports.join(&file_name);
    if let Err(e) = apkg::build_apkg(&out, deck_name, &notes, &media_files, None) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("build apkg: {e}"));
    }
    json_ok(json!({
        "ok": true,
        "path": out.to_string_lossy(),
        "url": format!("/exports/{}", file_name),
        "cards": notes.len(),
        "media": media_files.len(),
    }))
}

async fn serve_export(State(state): State<AppState>, AxumPath(file): AxumPath<String>) -> Response {
    let name = Path::new(&file)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if name.is_empty() || name.contains("..") {
        return json_error(StatusCode::NOT_FOUND, "not found");
    }
    match fs::read(state.exports.join(name)).await {
        Ok(bytes) => {
            let mut resp = bytes.into_response();
            resp.headers_mut().insert(
                CONTENT_TYPE,
                "application/octet-stream".parse().unwrap(),
            );
            resp.headers_mut().insert(
                axum::http::header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\"").parse().unwrap(),
            );
            resp
        }
        Err(_) => json_error(StatusCode::NOT_FOUND, "not found"),
    }
}

async fn root_handler(State(state): State<AppState>) -> Response {
    #[cfg(not(debug_assertions))]
    let _ = &state;
    #[cfg(debug_assertions)]
    {
        let index = state.root.join("app/service/index.html");
        if index.is_file() {
            match fs::read_to_string(&index).await {
                Ok(html) => return Html(html).into_response(),
                Err(e) => {
                    return json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &format!("read index: {e}"),
                    )
                }
            }
        }
    }
    Html(SERVICE_INDEX).into_response()
}

async fn tokens_css() -> Response {
    ([(CONTENT_TYPE, "text/css; charset=utf-8")], APP_TOKENS_CSS).into_response()
}

const CONSOLE_HTML: &str = include_str!("../../service/console.html");
const IDENTITY_JS: &str = include_str!("../../../src/identity.js");
const GROUP_JS: &str = include_str!("../../../src/group.js");

async fn console_page() -> Response {
    Html(CONSOLE_HTML).into_response()
}

async fn identity_js() -> Response {
    ([(CONTENT_TYPE, "application/javascript; charset=utf-8")], IDENTITY_JS).into_response()
}

async fn group_js() -> Response {
    ([(CONTENT_TYPE, "application/javascript; charset=utf-8")], GROUP_JS).into_response()
}

fn key_to_file(store: &Path, key: &str) -> PathBuf {
    store.join(format!("{}.json", sanitize_key(key)))
}

pub fn sanitize_key(key: &str) -> String {
    let mut out: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if out.is_empty() {
        out = "_".to_string();
    }
    out.truncate(120);
    out
}

fn valid_box(b: &Value) -> bool {
    let obj = match b.as_object() {
        Some(o) => o,
        None => return false,
    };
    for k in ["x", "y", "w", "h"] {
        match obj.get(k) {
            Some(v) if v.is_f64() || v.is_i64() || v.is_u64() => {}
            _ => return false,
        }
    }
    true
}

fn valid_quote(q: &Value) -> bool {
    q.get("exact")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

// box 与 quote 二选一即可（文章 = quote，视频/图片 = box）
fn valid_anchor(e: &Value) -> bool {
    valid_box(e.get("box").unwrap_or(&Value::Null))
        || valid_quote(e.get("quote").unwrap_or(&Value::Null))
}

// 通用批注：word 可空，标签/备注至少一个（§8.3 A）
fn entry_has_content(e: &Value) -> bool {
    let word = e.get("word").and_then(|v| v.as_str()).unwrap_or("").trim();
    let label = e.get("label").and_then(|v| v.as_str()).unwrap_or("").trim();
    let tags = e.get("tags").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    !word.is_empty() || !label.is_empty() || tags > 0
}

fn to_float(v: &Value, default: f64) -> f64 {
    v.as_f64().unwrap_or(default)
}

fn iou(a: &Value, b: &Value) -> f64 {
    if !valid_box(a) || !valid_box(b) {
        return 0.0;
    }
    let (ax, ay, aw, ah) = box_dims(a);
    let (bx, by, bw, bh) = box_dims(b);
    let ax2 = ax + aw;
    let ay2 = ay + ah;
    let bx2 = bx + bw;
    let by2 = by + bh;
    let ix = (ax2.min(bx2) - ax.max(bx)).max(0.0);
    let iy = (ay2.min(by2) - ay.max(by)).max(0.0);
    let inter = ix * iy;
    let un = aw * ah + bw * bh - inter;
    if un > 0.0 {
        inter / un
    } else {
        0.0
    }
}

fn box_dims(b: &Value) -> (f64, f64, f64, f64) {
    let obj = b.as_object().unwrap();
    (
        to_float(obj.get("x").unwrap(), 0.0),
        to_float(obj.get("y").unwrap(), 0.0),
        to_float(obj.get("w").unwrap(), 0.0),
        to_float(obj.get("h").unwrap(), 0.0),
    )
}

fn is_lang_tag(t: &str) -> bool {
    const EXACT: &[&str] = &["英语", "英文", "日语", "法语", "德语", "西班牙语", "韩语", "俄语",
                             "雅思", "托福", "考研", "四六级", "专四", "专八", "英语学习", "语言学习"];
    const PREFIX: &[&str] = &["英语", "日语", "法语", "德语", "韩语", "西班牙", "俄语", "葡萄牙"];
    EXACT.contains(&t) || t.ends_with('语') || PREFIX.iter().any(|p| t.starts_with(p))
}

fn tag_key(e: &Value) -> String {
    let mut tags: Vec<String> = e
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.to_lowercase()).collect())
        .unwrap_or_default();
    tags.sort();
    tags.join(",")
}

fn same(e: &Value, o: &Value) -> bool {
    let e_word = e.get("word").and_then(|v| v.as_str()).unwrap_or("");
    let o_word = o.get("word").and_then(|v| v.as_str()).unwrap_or("");
    if e_word != o_word {
        return false;
    }
    if e_word.is_empty() && o_word.is_empty() {
        let el = e.get("label").and_then(|v| v.as_str()).unwrap_or("");
        let ol = o.get("label").and_then(|v| v.as_str()).unwrap_or("");
        if el != ol {
            return false; // 无词时用标签/备注区分
        }
        if tag_key(e) != tag_key(o) {
            return false;
        }
    }
    let eb = valid_box(e.get("box").unwrap_or(&Value::Null));
    let ob = valid_box(o.get("box").unwrap_or(&Value::Null));
    if eb && ob {
        let e_t = to_float(e.get("t").unwrap_or(&Value::Null), 0.0);
        let o_t = to_float(o.get("t").unwrap_or(&Value::Null), 0.0);
        if (e_t - o_t).abs() >= 0.4 {
            return false;
        }
        return iou(e.get("box").unwrap_or(&Value::Null), o.get("box").unwrap_or(&Value::Null)) > 0.6;
    }
    let eq = valid_quote(e.get("quote").unwrap_or(&Value::Null));
    let oq = valid_quote(o.get("quote").unwrap_or(&Value::Null));
    if eq && oq {
        let e_exact = e.get("quote").and_then(|q| q.get("exact")).and_then(|v| v.as_str()).unwrap_or("");
        let o_exact = o.get("quote").and_then(|q| q.get("exact")).and_then(|v| v.as_str()).unwrap_or("");
        return e_exact == o_exact;   // 文本锚点：同一段文字即同一标注
    }
    false
}

fn merge_entries(a: &[Value], b: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for e in a.iter().chain(b.iter()) {
        if !e.is_object() {
            continue;
        }
        if !valid_anchor(e) || !entry_has_content(e) {
            continue;
        }
        if out.iter().any(|o| same(e, o)) {
            continue;
        }
        out.push(e.clone());
    }
    out
}

async fn read_pack(store: &Path, key: &str) -> Value {
    let p = key_to_file(store, key);
    if p.is_file() {
        if let Ok(bytes) = fs::read(&p).await {
            if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                return v;
            }
        }
    }
    json!({
        "format": "video-annotate/0.1",
        "media": { "videoId": key },
        "entries": [],
    })
}

async fn write_pack(store: &Path, key: &str, pack: &Value) -> Result<PathBuf, String> {
    fs::create_dir_all(store)
        .await
        .map_err(|e| format!("create store: {e}"))?;
    let path = key_to_file(store, key);
    let tmp_name = format!("{}.{}.part", sanitize_key(key), uuid::Uuid::new_v4());
    let tmp = store.join(tmp_name);
    let json = serde_json::to_vec_pretty(pack).map_err(|e| e.to_string())?;
    fs::write(&tmp, json)
        .await
        .map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("rename tmp: {e}"))?;
    let _ = fs::remove_file(&tmp).await;
    Ok(path)
}

async fn save_note(notes_dir: &Path, rec: &Value) -> Result<PathBuf, String> {
    fs::create_dir_all(notes_dir)
        .await
        .map_err(|e| format!("create notes dir: {e}"))?;

    let media = rec.get("media").cloned().unwrap_or(json!({}));
    let title = rec
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("未命名")
        .trim();
    let title = if title.is_empty() { "未命名" } else { title };
    let entries = rec.get("entries").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let chat = rec.get("chat").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let shot = rec.get("screenshot").and_then(|v| v.as_str()).unwrap_or("");
    let mid = media
        .get("videoId")
        .and_then(|v| v.as_str())
        .or_else(|| rec.get("mediaId").and_then(|v| v.as_str()))
        .unwrap_or("video");
    let key = sanitize_note_key(mid);
    let date = Local::now().format("%Y-%m-%d").to_string();
    let sub = format!("{}_{}", date, key);

    let mut img_rel = String::new();
    if shot.starts_with("data:image") {
        let asset_dir = notes_dir.join(&sub);
        fs::create_dir_all(&asset_dir)
            .await
            .map_err(|e| format!("create asset dir: {e}"))?;
        if let Some(b64) = shot.split(',').nth(1) {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|e| format!("base64 decode: {e}"))?;
            fs::write(asset_dir.join("shot.png"), bytes)
                .await
                .map_err(|e| format!("write shot: {e}"))?;
            img_rel = format!("{}/shot.png", sub);
        }
    }

    let created = rec
        .get("created")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| Local::now().format("%Y-%m-%dT%H:%M:%S").to_string());

    let md = render_note(title, &media, &entries, &chat, &img_rel, &created);
    let npath = notes_dir.join(format!("{}.md", sub));
    fs::write(&npath, md)
        .await
        .map_err(|e| format!("write note: {e}"))?;

    let line = json!({
        "created": created,
        "media": media,
        "entries": entries,
        "chat": chat,
        "note": npath.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
    });
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(notes_dir.join("data.jsonl"))
        .await
        .map_err(|e| format!("open data.jsonl: {e}"))?;
    use tokio::io::AsyncWriteExt;
    file.write_all(serde_json::to_string(&line).map_err(|e| e.to_string())?.as_bytes())
        .await
        .map_err(|e| format!("append data.jsonl: {e}"))?;
    file.write_all(b"\n").await.map_err(|e| e.to_string())?;

    Ok(npath)
}

fn sanitize_note_key(key: &str) -> String {
    let out: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let out = if out.is_empty() { "video".to_string() } else { out };
    out.chars().take(80).collect()
}

fn render_note(
    title: &str,
    media: &Value,
    entries: &[Value],
    chat: &[Value],
    img_rel: &str,
    created: &str,
) -> String {
    let mut lines = vec![
        "---".to_string(),
        format!("title: {}", title.replace('\n', " ")),
        format!("source: {}", media.get("url").and_then(|v| v.as_str()).unwrap_or("")),
        format!("media: {}", media.get("mediaId").and_then(|v| v.as_str()).or_else(|| media.get("videoId").and_then(|v| v.as_str())).unwrap_or("")),
        format!("platform: {}", media.get("platform").and_then(|v| v.as_str()).unwrap_or("")),
        format!("type: {}", media.get("type").and_then(|v| v.as_str()).unwrap_or("video")),
        format!("created: {}", created),
        format!(
            "tags: [video-annotate, language, {}]",
            media.get("platform").and_then(|v| v.as_str()).unwrap_or("video")
        ),
        "---".to_string(),
        "".to_string(),
        format!("# {}", title),
        "".to_string(),
    ];
    if !img_rel.is_empty() {
        lines.push(format!("![{}]({})", title, img_rel));
        lines.push("".to_string());
    }
    let timed = media.get("type").and_then(|v| v.as_str()).map(|s| s == "video").unwrap_or(true);
    if !entries.is_empty() {
        lines.push("## 生词（标注）".to_string());
        lines.push("".to_string());
        if timed {
            lines.push("| 词 | 释义 | 词性 | 时刻(s) | 时长(s) |".to_string());
            lines.push("|---|---|---|---|---|".to_string());
        } else {
            lines.push("| 词 | 释义 | 词性 | 锚点 |".to_string());
            lines.push("|---|---|---|---|".to_string());
        }
        for e in entries {
            let word = e.get("word").and_then(|v| v.as_str()).unwrap_or("");
            let label = e
                .get("label")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .replace('|', "/");
            let pos = e.get("pos").and_then(|v| v.as_str()).unwrap_or("");
            if timed {
                let t = e.get("t").and_then(|v| v.as_str()).unwrap_or("");
                let dur = e.get("dur").and_then(|v| v.as_str()).unwrap_or("");
                lines.push(format!("| {} | {} | {} | {} | {} |", word, label, pos, t, dur));
            } else {
                let anchor = e
                    .get("quote")
                    .and_then(|q| q.get("exact"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("区域标注")
                    .replace('|', "/")
                    .replace('\n', " ");
                lines.push(format!("| {} | {} | {} | {} |", word, label, pos, anchor));
            }
        }
        lines.push("".to_string());
    }
    if !chat.is_empty() {
        lines.push("## 与豆包对话".to_string());
        lines.push("".to_string());
        for m in chat {
            let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");
            let who = match role {
                "user" => "我",
                "assistant" => "豆包",
                "system" => "系统",
                _ => role,
            };
            let mut content = m.get("content").cloned().unwrap_or(Value::Null);
            if !content.is_string() {
                content = Value::String(serde_json::to_string(&content).unwrap_or_default());
            }
            let c = content.as_str().unwrap_or("").replace('\n', "\n  ");
            lines.push(format!("**{}**：{}", who, c));
            lines.push("".to_string());
        }
    }
    lines.join("\n") + "\n"
}

#[cfg(test)]
mod r2_merge_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_quote_without_box() {
        let e = json!({ "id": "q1", "word": "agriculture", "quote": { "exact": "the tea was planted" } });
        let out = merge_entries(&[], &[e]);
        assert_eq!(out.len(), 1, "quote 条目应被保留");
    }

    #[test]
    fn accepts_box_without_quote() {
        let e = json!({ "id": "b1", "word": "tractor", "box": { "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4 }, "t": 3.0 });
        let out = merge_entries(&[], &[e]);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn rejects_entry_without_any_anchor() {
        let e = json!({ "id": "x", "word": "noanchor" });
        assert!(merge_entries(&[], &[e]).is_empty());
    }

    #[test]
    fn rejects_empty_quote_exact() {
        let e = json!({ "id": "x", "word": "w", "quote": { "exact": "   " } });
        assert!(merge_entries(&[], &[e]).is_empty());
    }

    #[test]
    fn dedupes_quotes_by_exact() {
        let a = json!({ "id": "q1", "word": "w", "quote": { "exact": "same text", "prefix": "a" } });
        let b = json!({ "id": "q2", "word": "w", "quote": { "exact": "same text", "prefix": "b" } });
        assert_eq!(merge_entries(&[a], &[b]).len(), 1);
    }

    #[test]
    fn keeps_distinct_quotes_and_boxes() {
        let q = json!({ "id": "q", "word": "w", "quote": { "exact": "one" } });
        let b = json!({ "id": "b", "word": "w", "box": { "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2 }, "t": 1.0 });
        assert_eq!(merge_entries(&[q], &[b]).len(), 2, "quote 与 box 是不同锚点");
    }
}
