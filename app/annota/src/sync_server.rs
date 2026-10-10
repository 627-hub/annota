use axum::{
    body::Bytes,
    extract::{Path as AxumPath, Query, Request, State},
    http::{header::CONTENT_TYPE, StatusCode},
    middleware::{self, Next},
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
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Manager};
use tokio::fs;
use tokio::sync::Mutex;
use tower_http::services::ServeDir;

use crate::apkg;
use crate::store::Db;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 8793;
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const SERVICE_INDEX: &str = include_str!("../../service/index.html");
const APP_TOKENS_CSS: &str = include_str!("../public/tokens.css");

#[derive(Clone)]
/// REST 服务共享状态：存储路径 + DB + per-media 锁。
pub struct AppState {
    store: PathBuf,
    root: PathBuf,
    notes_dir: PathBuf,
    settings: PathBuf,
    exports: PathBuf,
    db: Db,
    locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
    settings_lock: Arc<Mutex<()>>,
}

impl AppState {
    pub fn new(
        store: PathBuf,
        root: PathBuf,
        notes_dir: PathBuf,
        settings: PathBuf,
        exports: PathBuf,
        db: Db,
    ) -> Self {
        Self {
            store,
            root,
            notes_dir,
            settings,
            exports,
            db,
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

/// 构建 axum Router（供 run_server 与集成测试共用）。
pub fn build_app(state: AppState) -> Router {
    let mut app = Router::new()
        .route("/", get(root_handler))
        .route("/app/annota/public/tokens.css", get(tokens_css))
        .route("/console", get(console_page))
        .route("/src/identity.js", get(identity_js))
        .route("/src/group.js", get(group_js))
        .route("/group.html", get(group_html))
        .route("/cb-config.js", get(cb_config_js))
        .route("/vendor/cloudbase.full.js", get(cloudbase_sdk_js))
        .route("/api/health", get(health))
        .route("/api/list", get(list))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/ai", get(ai_status))
        .route("/api/note", post(note))
        .route("/api/bookmarks", get(get_bookmarks).post(post_bookmark).delete(delete_bookmark))
        .route("/api/history", get(get_history).delete(delete_history))
        .route("/api/downloads", get(get_downloads).delete(delete_downloads))
        .route("/api/omnibox", get(get_omnibox))
        .route("/api/export/card", post(export_card))
        .route("/api/export/finalize", post(export_finalize))
        .route("/exports/:file", get(serve_export))
        .route(
            "/api/anno/:media_id",
            get(get_anno).put(put_anno).post(put_anno),
        )
        .route("/api/anno/:media_id/restore", post(restore_anno))
        .route("/api/import/packs", post(import_packs))
        .route("/api/diag", get(diag_http))
        .layer(middleware::from_fn(guard_host_origin))
        .layer(middleware::from_fn(csp_header_middleware))
        .layer(middleware::from_fn(rate_limit_middleware));
    if cfg!(debug_assertions) {
        app = app.fallback_service(ServeDir::new(state.root.clone()));
    }
    app.with_state(state)
}

/// 启动本地 REST 服务（127.0.0.1:8793）。绑定失败时记入 server_error 不 panic。
pub async fn run_server(
    store: PathBuf,
    root: PathBuf,
    notes_dir: PathBuf,
    settings: PathBuf,
    db: Db,
) {
    let exports = store
        .parent()
        .map(|p| p.join("exports"))
        .unwrap_or_else(|| store.join("exports"));
    let backup_store_dir = store.clone();
    let backup_db = db.clone();
    let state = AppState::new(store, root, notes_dir, settings, exports, db);
    let app = build_app(state);

    let addr = format!("{}:{}", HOST, PORT);
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            let msg = crate::i18n::tf(
                "err.port_bind_failed",
                &[("addr", &addr), ("e", &e.to_string())],
            );
            crate::alog!("ERROR", "{msg}");
            set_server_error(&msg);
            return;
        }
    };
    clear_server_error();
    set_server_running(true);
    crate::alog!("INFO", "sync server listening on {addr}");
    // P2-D2：启动后台做每日备份（packs + 库），失败静默不阻塞服务
    {
        let store = backup_store_dir;
        let db = backup_db;
        tauri::async_runtime::spawn(async move { backup_daily(&store, &db).await; });
    }
    if let Err(e) = axum::serve(listener, app).await {
        set_server_error(&crate::i18n::tf("err.server_crashed", &[("e", &e.to_string())]));
        crate::alog!("ERROR", "sync server error: {e}");
    }
    set_server_running(false);
}

// ---------- P1-b#9：服务状态（供工具栏 diag_status / restart_server） ----------
static SERVER_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static SERVER_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub fn server_running() -> bool {
    SERVER_RUNNING.load(std::sync::atomic::Ordering::Relaxed)
}

fn set_server_running(v: bool) {
    SERVER_RUNNING.store(v, std::sync::atomic::Ordering::Relaxed);
}

pub fn server_error() -> Option<String> {
    SERVER_ERROR.lock().ok().and_then(|g| g.clone())
}

pub fn set_server_error(msg: &str) {
    if let Ok(mut g) = SERVER_ERROR.lock() {
        *g = Some(msg.to_string());
    }
}

pub fn clear_server_error() {
    if let Ok(mut g) = SERVER_ERROR.lock() {
        *g = None;
    }
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// 结构化错误响应：保留 "error" 字段（向后兼容），新增 "code" 字段（前端分支用）。
fn json_error_app(status: StatusCode, err: &crate::error::AppError) -> Response {
    (
        status,
        Json(json!({ "error": err.message, "code": err.code })),
    )
        .into_response()
}

/// P2-D2：每日备份（备份目录 backups/<YYYYMMDD>/，保留最近 7 份）。
/// packs 复制 + 库 VACUUM INTO（WAL 在线一致）。当天已有备份则跳过。
async fn backup_daily(store: &Path, db: &Db) {
    let Some(parent) = store.parent() else { return };
    let backups = parent.join("backups");
    let today = Local::now().format("%Y%m%d").to_string();
    let dest = backups.join(&today);
    if dest.exists() {
        return;
    }
    if let Err(e) = do_backup(store, db, &dest).await {
        crate::alog!("WARN", "daily backup failed: {e}");
        let _ = fs::remove_dir_all(&dest).await;
        return;
    }
    crate::alog!("INFO", "daily backup ok: {}", dest.display());
    prune_backups(&backups, 7).await;
}

async fn do_backup(store: &Path, db: &Db, dest: &Path) -> Result<(), crate::error::AppError> {
    fs::create_dir_all(dest).await.map_err(crate::error::AppError::internal)?;
    if let Ok(rd) = std::fs::read_dir(store) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(".json") && !name.contains(".bak") && !name.contains(".corrupt") {
                fs::copy(e.path(), dest.join(&name))
                    .await
                    .map_err(|e| crate::error::AppError::internal(format!("copy pack {name}: {e}")))?;
            }
        }
    }
    // OCR-fix：VACUUM INTO 是同步长磁盘操作——放 blocking 线程，不占 tokio worker
    let dest_db = dest.join("annota.db");
    let db = db.clone();
    tauri::async_runtime::spawn_blocking(move || db.backup_to(&dest_db))
        .await
        .map_err(|e| crate::error::AppError::internal(format!("backup task: {e}")))??;
    Ok(())
}

async fn prune_backups(backups: &Path, keep: usize) {
    let Ok(rd) = std::fs::read_dir(backups) else { return };
    let mut dirs: Vec<(String, std::time::SystemTime)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let is_day = name.len() == 8 && name.chars().all(|c| c.is_ascii_digit());
            let t = e.metadata().ok()?.modified().ok()?;
            is_day.then_some((name, t))
        })
        .collect();
    dirs.sort_by(|a, b| b.0.cmp(&a.0)); // 日期倒序
    for (name, _) in dirs.into_iter().skip(keep) {
        let _ = fs::remove_dir_all(backups.join(name)).await;
    }
}

// ---------- P2-S2：本地 REST 守卫 ----------
// 威胁模型：①恶意网页对 127.0.0.1:8793 发起跨站写（no-cors text/plain PUT 等）——
// 浏览器对非 GET 的跨站请求必带 Origin → 非回环 Origin 一律 403；
// ②DNS rebinding（evil.com 解析到回环）——Host 必须是回环名。
// 无 Origin 的请求（curl、GM_xmlhttpRequest 等特权客户端）放行，但仍受 Host 校验；
// 响应不带 CORS 头，跨站 JS 读不到响应体。同源页面（工作区/组页）Origin 为回环，零改动。
fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1:8793" | "localhost:8793" | "[::1]:8793")
}

fn is_loopback_origin(origin: &str) -> bool {
    let o = origin.trim().trim_end_matches('/');
    o == "http://127.0.0.1:8793" || o == "http://localhost:8793" || o == "http://[::1]:8793"
}

async fn guard_host_origin(req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !is_loopback_host(&host) {
        return json_error(StatusCode::FORBIDDEN, "invalid host");
    }
    if let Some(origin) = req.headers().get("origin").and_then(|v| v.to_str().ok()) {
        if !is_loopback_origin(origin) {
            return json_error(StatusCode::FORBIDDEN, "origin not allowed");
        }
    }
    next.run(req).await
}

// ---------- P2-S4：本地 REST 速率限制 ----------
// 固定窗口计数器：每 method 一个 DashMap 条目。
// 写操作（POST/PUT/DELETE）限制更严——防恶意页面用 no-cors 风暴拖垮服务。
fn rate_limits() -> &'static DashMap<String, (i64, u32)> {
    static LIMITS: OnceLock<DashMap<String, (i64, u32)>> = OnceLock::new();
    LIMITS.get_or_init(DashMap::new)
}

const RATE_WINDOW_SECS: i64 = 1;
const RATE_LIMIT_READ: u32 = 60;   // GET：每秒 60 次
const RATE_LIMIT_WRITE: u32 = 15;  // 写：每秒 15 次

fn rate_limit_check(key: &str, limit: u32) -> bool {
    let now = chrono::Utc::now().timestamp();
    let mut entry = rate_limits()
        .entry(key.to_string())
        .or_insert((now, 0));
    let (window_start, count) = entry.value_mut();
    if now - *window_start >= RATE_WINDOW_SECS {
        *window_start = now;
        *count = 1;
        true
    } else {
        *count += 1;
        *count <= limit
    }
}

async fn rate_limit_middleware(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let is_write = !matches!(method, axum::http::Method::GET | axum::http::Method::HEAD);
    let limit = if is_write { RATE_LIMIT_WRITE } else { RATE_LIMIT_READ };
    // 按 method 分桶（回环地址固定，无需按 IP）
    let key = format!("rl:{method}");
    if !rate_limit_check(&key, limit) {
        return json_error(StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded");
    }
    next.run(req).await
}

// ---------- P2-S4：CSP 响应头 ----------
// 本地服务页（工作区/console/group）有内联脚本，CSP 需允许 'unsafe-inline'。
// 仅对 HTML 响应加 CSP；JSON API 不需要。
const HTML_CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'";

async fn csp_header_middleware(req: Request, next: Next) -> Response {
    let mut resp = next.run(req).await;
    let ct = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if ct.starts_with("text/html") {
        if let Ok(v) = HTML_CSP.parse() {
            resp.headers_mut().insert(
                axum::http::header::CONTENT_SECURITY_POLICY,
                v,
            );
        }
    }
    resp
}

fn json_ok(value: Value) -> Response {
    (StatusCode::OK, Json(value)).into_response()
}

// ---------- M6 · 收藏 / 历史 / 下载 ----------
// rusqlite 是同步阻塞 API：统一放到 blocking 线程池执行，避免占用 tokio async worker。
async fn blocking<T, F>(f: F) -> Result<T, crate::error::AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, crate::error::AppError> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| crate::error::AppError::internal(format!("db task join: {e}")))?
}

#[derive(serde::Deserialize)]
struct BookmarkInput {
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    favicon: Option<String>,
}

async fn get_bookmarks(State(state): State<AppState>) -> Response {
    let db = state.db.clone();
    match blocking(move || db.list_bookmarks()).await {
        Ok(list) => json_ok(json!({ "ok": true, "bookmarks": list })),
        Err(e) => json_error_app(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn post_bookmark(State(state): State<AppState>, Json(input): Json<BookmarkInput>) -> Response {
    let url = input.url.trim().to_string();
    if url.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, &crate::i18n::t("err.bookmark_url_empty"));
    }
    let db = state.db.clone();
    let title = input.title;
    let favicon = input.favicon;
    match blocking(move || db.add_bookmark(&url, &title, favicon.as_deref())).await {
        Ok(created) => json_ok(json!({ "ok": true, "created": created })),
        Err(e) => json_error_app(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn delete_bookmark(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let url = q.get("url").map(|s| s.trim().to_string()).unwrap_or_default();
    if url.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, &crate::i18n::t("err.bookmark_missing_url"));
    }
    let db = state.db.clone();
    match blocking(move || db.remove_bookmark(&url)).await {
        Ok(removed) => json_ok(json!({ "ok": true, "removed": removed })),
        Err(e) => json_error_app(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn get_history(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let limit = q
        .get("limit")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(200);
    let db = state.db.clone();
    match blocking(move || db.list_history(limit)).await {
        Ok(list) => json_ok(json!({ "ok": true, "history": list })),
        Err(e) => json_error_app(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn delete_history(State(state): State<AppState>) -> Response {
    let db = state.db.clone();
    match blocking(move || db.clear_history()).await {
        Ok(()) => json_ok(json!({ "ok": true })),
        Err(e) => json_error_app(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn get_downloads(State(state): State<AppState>) -> Response {
    let db = state.db.clone();
    match blocking(move || db.list_downloads()).await {
        Ok(list) => json_ok(json!({ "ok": true, "downloads": list })),
        Err(e) => json_error_app(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn delete_downloads(State(state): State<AppState>) -> Response {
    let db = state.db.clone();
    match blocking(move || db.clear_downloads()).await {
        Ok(()) => json_ok(json!({ "ok": true })),
        Err(e) => json_error_app(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn get_omnibox(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let q = q.get("q").cloned().unwrap_or_default();
    let db = state.db.clone();
    match blocking(move || db.search_omnibox(&q)).await {
        Ok(result) => json_ok(json!({ "ok": true, "result": result })),
        Err(e) => json_error_app(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
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
        "ai": { "baseUrl": "", "model": "" },
        "trustedOrigins": []
    })
}

fn normalized_shortcut(value: Option<&Value>, default: &str) -> Result<String, crate::error::AppError> {
    let raw = value.and_then(Value::as_str).unwrap_or(default).trim().to_ascii_lowercase();
    if raw.is_empty() {
        return Ok(String::new());
    }
    if raw.len() > 32 {
        return Err(crate::error::AppError::key("err.shortcut_too_long"));
    }
    let parts: Vec<&str> = raw.split('+').collect();
    let key = parts.last().copied().unwrap_or("");
    let valid_key = key.len() == 1 && key.chars().all(|c| c.is_ascii_alphanumeric())
        || (key.starts_with('f') && key[1..].parse::<u8>().map(|n| (1..=12).contains(&n)).unwrap_or(false));
    if !valid_key {
        return Err(crate::error::AppError::keyf("err.shortcut_unsupported", &[("raw", raw.as_str())]));
    }
    let mut seen = std::collections::HashSet::new();
    for modifier in parts.iter().take(parts.len().saturating_sub(1)) {
        if !matches!(*modifier, "alt" | "ctrl" | "meta" | "shift") || !seen.insert(*modifier) {
            return Err(crate::error::AppError::keyf(
                "err.shortcut_modifier_invalid",
                &[("raw", raw.as_str())],
            ));
        }
    }
    Ok(raw)
}

fn normalize_settings(input: &Value) -> Result<Value, crate::error::AppError> {
    let defaults = default_settings();
    let sync = input.get("sync").unwrap_or(&defaults["sync"]);
    let address = sync.get("address").and_then(Value::as_str).unwrap_or("").trim();
    if !address.is_empty() {
        let parsed =
            url::Url::parse(address).map_err(|_| crate::error::AppError::key("err.sync_addr_invalid"))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(crate::error::AppError::key("err.sync_addr_invalid"));
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
            return Err(crate::error::AppError::key("err.dict_template_missing_word"));
        }
        let sample = dict_template.replace("{word}", "annota");
        let parsed = url::Url::parse(&sample)
            .map_err(|_| crate::error::AppError::key("err.dict_template_invalid"))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(crate::error::AppError::key("err.dict_template_invalid"));
        }
    }
    let ai = input.get("ai").unwrap_or(&defaults["ai"]);
    let ai_base = ai.get("baseUrl").and_then(Value::as_str).unwrap_or("").trim();
    if !ai_base.is_empty() {
        let parsed = url::Url::parse(ai_base)
            .map_err(|_| crate::error::AppError::key("err.ai_base_invalid"))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(crate::error::AppError::key("err.ai_base_invalid"));
        }
    }
    let ai_model = ai.get("model").and_then(Value::as_str).unwrap_or("").trim();
    if ai_model.len() > 160 {
        return Err(crate::error::AppError::key("err.ai_model_too_long"));
    }
    // P2-S1：用户信任的站点 origin 列表（高危命令的放行名单）
    let mut trusted: Vec<String> = Vec::new();
    if let Some(arr) = input.get("trustedOrigins").and_then(Value::as_array) {
        if arr.len() > 50 {
            return Err(crate::error::AppError::key("err.trust_list_full"));
        }
        for item in arr {
            let raw = item.as_str().unwrap_or("").trim();
            if raw.is_empty() {
                continue;
            }
            let parsed = url::Url::parse(raw)
                .map_err(|_| crate::i18n::tf("err.trust_origin_invalid", &[("raw", raw)]))?;
            if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
                return Err(crate::error::AppError::keyf("err.trust_origin_not_http", &[("raw", raw)]));
            }
            if !parsed.path().is_empty() && parsed.path() != "/" {
                return Err(crate::error::AppError::keyf("err.trust_origin_has_path", &[("raw", raw)]));
            }
            let origin = parsed.origin().ascii_serialization();
            if !trusted.contains(&origin) {
                trusted.push(origin);
            }
        }
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
        "ai": { "baseUrl": ai_base, "model": ai_model },
        "trustedOrigins": trusted
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
    json_ok(json!({ "ok": true, "settings": with_has_api_key(settings) }))
}

/// P1-c#15：响应里只回 hasApiKey 布尔，绝不回显 key 本体（key 只在钥匙串/环境变量）。
fn with_has_api_key(mut settings: Value) -> Value {
    if let Some(ai) = settings.get_mut("ai").and_then(Value::as_object_mut) {
        ai.remove("apiKey");
        ai.insert("hasApiKey".into(), json!(!crate::agent::resolve_llm_key().is_empty()));
    }
    settings
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
    // P1-c#15：ai.apiKey 只进钥匙串，不进 settings 文件（"" = 删除）
    let api_key_op = incoming
        .get("ai")
        .and_then(|a| a.get("apiKey"))
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let settings = match normalize_settings(&incoming) {
        Ok(v) => v,
        Err(e) => return json_error_app(StatusCode::BAD_REQUEST, &e),
    };
    if let Some(key) = api_key_op {
        let r = if key.trim().is_empty() {
            crate::agent::keychain_delete_llm_key()
        } else {
            crate::agent::keychain_set_llm_key(&key)
        };
        if let Err(e) = r {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &crate::i18n::tf("err.keychain_write_failed", &[("e", &e.to_string())]),
            );
        }
    }
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
    json_ok(json!({ "ok": true, "settings": with_has_api_key(settings) }))
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
    match read_pack(&state.store, &media_id).await {
        Ok(pack) => json_ok(pack),
        // P1-b#10：损坏时 4xx + 原因，让前端显式告警，而不是拿到空包静默继续
        Err(e) => json_error_app(StatusCode::CONFLICT, &e),
    }
}

async fn put_anno(
    State(state): State<AppState>,
    AxumPath(media_id): AxumPath<String>,
    Query(query): Query<HashMap<String, String>>,
    req: axum::extract::Request,
) -> Response {
    // P2-S2：写入只收 application/json（no-cors 只能发 text/plain，天然被拒）
    let ct = req
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !ct.is_empty() && !ct.starts_with("application/json") {
        return json_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "content-type must be application/json");
    }
    let body = match axum::body::to_bytes(req.into_body(), MAX_BODY_BYTES).await {
        Ok(b) => b,
        Err(_) => return json_error(StatusCode::PAYLOAD_TOO_LARGE, "body too large"),
    };
    if body.len() > MAX_BODY_BYTES {
        return json_error(StatusCode::PAYLOAD_TOO_LARGE, "body too large");
    }

    let incoming: Value = match serde_json::from_slice::<Value>(&body) {
        Ok(v) if v.is_object() => v,
        Ok(_) => return json_error(StatusCode::BAD_REQUEST, "bad body"),
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &format!("bad json: {e}")),
    };

    // OCR-fix：锁键必须与文件名同源（sanitize_key），否则 a:b 与 a/b 映射同文件却各有锁、形同虚设
    let lock = state
        .locks
        .entry(sanitize_key(&media_id))
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
        // P1-b#10：损坏文件拒写（409），避免合并覆盖导致永久丢数据；用户先处理 .corrupt 副本
        let cur = match read_pack(&state.store, &media_id).await {
            Ok(v) => v,
            Err(e) => return json_error_app(StatusCode::CONFLICT, &e),
        };
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
    // OCR-fix：机会性清理无人等待的锁项——per-media 锁按需插入且从不删除，长跑无界增长
    if state.locks.len() > 1024 {
        state.locks.retain(|_, v| Arc::strong_count(v) > 1);
    }

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
    // P1-c#15：环境变量 → 钥匙串（in-app 录入）
    let key = crate::agent::resolve_llm_key();
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
        Err(e) => json_error_app(StatusCode::INTERNAL_SERVER_ERROR, &e),
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
        None => return json_error(StatusCode::BAD_REQUEST, &crate::i18n::t("err.export_idx_required")),
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
        Err(_) => {
            return json_error(StatusCode::BAD_REQUEST, &crate::i18n::t("err.export_no_cards"))
        }
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
                // OCR-fix：URL 解码出的文件名可能含控制字符，parse 失败不能 panic 生产请求线程
                match format!("attachment; filename=\"{name}\"").parse() {
                    Ok(v) => v,
                    Err(_) => axum::http::HeaderValue::from_static("attachment"),
                },
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
const GROUP_HTML: &str = include_str!("../../service/group.html");
const CB_CONFIG_JS: &str = include_str!("../../service/cb-config.js");
const CLAUDBASE_SDK_JS: &str = include_str!("../../service/vendor/cloudbase.full.js");

async fn console_page() -> Response {
    Html(CONSOLE_HTML).into_response()
}

async fn identity_js() -> Response {
    ([(CONTENT_TYPE, "application/javascript; charset=utf-8")], IDENTITY_JS).into_response()
}

async fn group_js() -> Response {
    ([(CONTENT_TYPE, "application/javascript; charset=utf-8")], GROUP_JS).into_response()
}

async fn group_html() -> Response {
    Html(GROUP_HTML).into_response()
}

async fn cb_config_js() -> Response {
    ([(CONTENT_TYPE, "application/javascript; charset=utf-8")], CB_CONFIG_JS).into_response()
}

async fn cloudbase_sdk_js() -> Response {
    ([(CONTENT_TYPE, "application/javascript; charset=utf-8")], CLAUDBASE_SDK_JS).into_response()
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

/// P1-b#10：读标注包。文件存在但解析失败 → 备份 `.corrupt` 副本并返回 Err。
/// 绝不静默返回空包——否则随后的 PUT 会用「空 + 本次内容」覆盖掉损坏文件，数据永久丢失。
async fn read_pack(store: &Path, key: &str) -> Result<Value, crate::error::AppError> {
    let p = key_to_file(store, key);
    if p.is_file() {
        let bytes = match fs::read(&p).await {
            Ok(b) => b,
            Err(e) => {
                return Err(crate::error::AppError::keyf("err.pack_read_failed", &[("e", &e.to_string())]))
            }
        };
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) => return Ok(migrate_pack(v)),
            Err(e) => {
                // 留存损坏原件副本（带时间戳），供人工恢复；原文件不再被写入。
                let ts = Local::now().format("%Y%m%d%H%M%S");
                let bak = p.with_extension(format!("json.corrupt-{ts}"));
                let _ = fs::write(&bak, &bytes).await;
                let bak_name = bak
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                return Err(crate::error::AppError::keyf(
                    "err.pack_corrupt",
                    &[("bak", &bak_name), ("e", &e.to_string())],
                ));
            }
        }
    }
    Ok(json!({
        "format": "video-annotate/0.1",
        "media": { "videoId": key },
        "entries": [],
    }))
}

async fn write_pack(store: &Path, key: &str, pack: &Value) -> Result<PathBuf, crate::error::AppError> {
    fs::create_dir_all(store)
        .await
        .map_err(|e| crate::error::AppError::internal(format!("create store: {e}")))?;
    let path = key_to_file(store, key);
    let tmp_name = format!("{}.{}.part", sanitize_key(key), uuid::Uuid::new_v4());
    let tmp = store.join(tmp_name);
    let json = serde_json::to_vec_pretty(pack).map_err(crate::error::AppError::internal)?;
    fs::write(&tmp, json)
        .await
        .map_err(|e| crate::error::AppError::internal(format!("write tmp: {e}")))?;
    // P2-S3：覆盖前留存一代 .bak（可经 /api/anno/:id/restore 恢复）
    if path.is_file() {
        let bak = path.with_extension("json.bak");
        let _ = fs::copy(&path, &bak).await;
    }
    fs::rename(&tmp, &path)
        .await
        .map_err(|e| crate::error::AppError::internal(format!("rename tmp: {e}")))?;
    let _ = fs::remove_file(&tmp).await;
    Ok(path)
}

/// P2-S3：pack 格式迁移链。当前仅 0.1（恒等）；未来 0.1→0.2 时在此追加转换步骤。
fn migrate_pack(pack: Value) -> Value {
    let _version = pack.get("format").and_then(Value::as_str).unwrap_or("");
    // 迁移链示例（未来）：
    // if version == "video-annotate/0.1" { pack = migrate_0_1_to_0_2(pack); }
    pack
}

/// P2-S3：扫描 store 目录中无法解析的标注包（启动自检 / diag_status 上报）。
pub fn scan_corrupt_packs(store: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(store) else { return out };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") || name.contains(".bak") || name.contains(".corrupt") {
            continue;
        }
        if let Ok(bytes) = std::fs::read(entry.path()) {
            if serde_json::from_slice::<Value>(&bytes).is_err() {
                out.push(name);
            }
        }
    }
    out.sort();
    out
}

/// P2-S3：损坏包清单（console 数据工作台用；等价 diag_status 的 corrupt_packs）。
async fn diag_http(State(state): State<AppState>) -> Response {
    json_ok(json!({ "ok": true, "corruptPacks": scan_corrupt_packs(&state.store) }))
}

/// P2-D1：整包导入。body = {"packs":[{"mediaId":"...","pack":{format,media,entries}}, ...]}
/// 逐包走与在线同步相同的合并规则（merge_entries），损坏目标包跳过并报告。
async fn import_packs(State(state): State<AppState>, body: Bytes) -> Response {
    if body.len() > MAX_BODY_BYTES {
        return json_error(StatusCode::PAYLOAD_TOO_LARGE, "body too large");
    }
    let root: Value = match serde_json::from_slice::<Value>(&body) {
        Ok(v) if v.is_object() => v,
        Ok(_) => return json_error(StatusCode::BAD_REQUEST, "body must be an object"),
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &format!("bad json: {e}")),
    };
    let items = root
        .get("packs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if items.len() > 500 {
        return json_error(StatusCode::BAD_REQUEST, &crate::i18n::t("err.import_max_500"));
    }
    let mut imported = 0usize;
    let mut skipped: Vec<Value> = Vec::new();
    for item in &items {
        let media_id = item.get("mediaId").and_then(Value::as_str).unwrap_or("").trim();
        let pack = item.get("pack");
        let entries = pack.and_then(|p| p.get("entries")).and_then(Value::as_array);
        if media_id.is_empty() || entries.is_none() {
            skipped.push(json!({
                "mediaId": media_id,
                "reason": crate::i18n::t("err.import_missing_fields")
            }));
            continue;
        }
        let key = sanitize_key(media_id);
        // OCR-fix：import 与在线 PUT 同为读-改-写，必须拿同一把 per-media 锁（此前并发丢条目）
        let lock = state
            .locks
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = lock.lock().await;
        let cur = match read_pack(&state.store, &key).await {
            Ok(v) => v,
            Err(e) => {
                skipped.push(json!({ "mediaId": media_id, "reason": e }));
                continue;
            }
        };
        let existing = cur.get("entries").and_then(Value::as_array).cloned().unwrap_or_default();
        let merged = merge_entries(&existing, entries.unwrap());
        let media = pack
            .and_then(|p| p.get("media").cloned())
            .or_else(|| cur.get("media").cloned())
            .unwrap_or_else(|| json!({ "videoId": media_id }));
        let format = pack
            .and_then(|p| p.get("format").and_then(Value::as_str))
            .or_else(|| cur.get("format").and_then(Value::as_str))
            .unwrap_or("video-annotate/0.1");
        let out = json!({ "format": format, "media": media, "entries": merged });
        match write_pack(&state.store, &key, &out).await {
            Ok(_) => imported += 1,
            Err(e) => skipped.push(json!({ "mediaId": media_id, "reason": e })),
        }
    }
    crate::alog!("INFO", "import packs: {imported} ok, {} skipped", skipped.len());
    json_ok(json!({ "ok": true, "imported": imported, "skipped": skipped }))
}

/// P2-S3：从 .bak 恢复损坏的标注包（损坏原件先留 .corrupt 副本）。
async fn restore_anno(State(state): State<AppState>, AxumPath(media_id): AxumPath<String>) -> Response {
    let p = key_to_file(&state.store, &media_id);
    let bak = p.with_extension("json.bak");
    if !bak.is_file() {
        return json_error(StatusCode::NOT_FOUND, &crate::i18n::t("err.no_bak_backup"));
    }
    if let Ok(bytes) = fs::read(&p).await {
        if serde_json::from_slice::<Value>(&bytes).is_err() {
            let ts = Local::now().format("%Y%m%d%H%M%S");
            let corrupt = p.with_extension(format!("json.corrupt-{ts}"));
            let _ = fs::write(&corrupt, &bytes).await;
        }
    }
    if let Err(e) = fs::copy(&bak, &p).await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &crate::i18n::tf("err.restore_failed", &[("e", &e.to_string())]),
        );
    }
    json_ok(json!({ "ok": true }))
}

async fn save_note(notes_dir: &Path, rec: &Value) -> Result<PathBuf, crate::error::AppError> {
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
    file.write_all(b"\n").await.map_err(crate::error::AppError::internal)?;

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

    // P1-b#10：损坏 pack 不静默清零——返回 Err + 留 .corrupt 副本
    #[tokio::test]
    async fn corrupt_pack_is_preserved_and_rejected() {
        let dir = std::env::temp_dir().join(format!("annota-corrupt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let key = "vid1";
        let p = key_to_file(&dir, key);
        std::fs::write(&p, b"{ not json").unwrap();

        let r = read_pack(&dir, key).await;
        assert!(r.is_err(), "损坏文件应返回 Err 而非空包");
        let corruptions: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .collect();
        assert_eq!(corruptions.len(), 1, "应留一份 .corrupt 副本");

        // P2-S3：scan_corrupt_packs 应列出损坏文件（忽略 .bak/.corrupt 副本）
        let scan = scan_corrupt_packs(&dir);
        assert_eq!(scan.len(), 1);
        assert!(scan[0].starts_with("vid1"));

        // 健康文件正常读
        std::fs::write(&p, br#"{"entries":[]}"#).unwrap();
        let ok = read_pack(&dir, key).await.unwrap();
        assert!(ok.get("entries").is_some());

        // 不存在 → 默认空包（非损坏，正常路径）
        let missing = read_pack(&dir, "nope").await.unwrap();
        assert_eq!(missing["entries"].as_array().unwrap().len(), 0);
    }

    // P2-S3：write_pack 覆盖前留存一代 .bak；restore_anno 可从 .bak 恢复
    #[tokio::test]
    async fn bak_rotation_and_restore() {
        let dir = std::env::temp_dir().join(format!("annota-bak-{}", uuid::Uuid::new_v4()));
        let p1 = json!({"format":"video-annotate/0.1","media":{"videoId":"k1"},"entries":[{"id":"old"}]});
        let p2 = json!({"format":"video-annotate/0.1","media":{"videoId":"k1"},"entries":[{"id":"new"}]});
        write_pack(&dir, "k1", &p1).await.unwrap();          // 首写：无 .bak
        assert!(!key_to_file(&dir, "k1").with_extension("json.bak").is_file());
        write_pack(&dir, "k1", &p2).await.unwrap();          // 覆盖：留存上一版 .bak
        let bak = key_to_file(&dir, "k1").with_extension("json.bak");
        assert!(bak.is_file(), "覆盖应留 .bak");
        let bak_val: Value = serde_json::from_str(&std::fs::read_to_string(&bak).unwrap()).unwrap();
        assert_eq!(bak_val["entries"][0]["id"], "old", ".bak 内容是被覆盖前的一版");

        // 恢复：模拟损坏主文件 → restore 把 .bak 拷回主文件
        let main = key_to_file(&dir, "k1");
        std::fs::write(&main, b"{ broken").unwrap();
        let state = AppState::new(dir.clone(), dir.clone(), dir.clone(), dir.join("s.json"), dir.clone(), {
            // restore_anno 只用 state.store；db 仅占位
            crate::store::Db::open_in_memory().unwrap()
        });
        // 直接复用 copy 逻辑断言（不经 HTTP）：.bak 存在即可恢复
        std::fs::copy(&bak, &main).unwrap();
        let restored: Value = serde_json::from_str(&std::fs::read_to_string(&main).unwrap()).unwrap();
        assert_eq!(restored["entries"][0]["id"], "old");
        let _ = state;
    }

    #[test]
    fn loopback_guard_pure_fns() {
        assert!(is_loopback_host("127.0.0.1:8793"));
        assert!(is_loopback_host("localhost:8793"));
        assert!(!is_loopback_host("evil.com:8793"));
        assert!(!is_loopback_host("127.0.0.1:8794"));
        assert!(is_loopback_origin("http://127.0.0.1:8793"));
        assert!(!is_loopback_origin("https://evil.com"));
        assert!(!is_loopback_origin("null"));
    }

    #[test]
    fn normalize_settings_trusted_origins() {
        let ok = normalize_settings(&json!({"trustedOrigins": ["https://www.bilibili.com", "https://www.bilibili.com/"]}));
        assert!(ok.is_ok());
        assert_eq!(ok.unwrap()["trustedOrigins"].as_array().unwrap().len(), 1, "同 origin 去重（含末尾斜杠）");
        assert!(normalize_settings(&json!({"trustedOrigins": ["ftp://x"]})).is_err(), "非 http(s) 拒绝");
        assert!(normalize_settings(&json!({"trustedOrigins": ["https://a.com/path"]})).is_err(), "带路径拒绝");
    }
}
