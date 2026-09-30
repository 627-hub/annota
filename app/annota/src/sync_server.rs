use axum::{
    body::Bytes,
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use chrono::Local;
use dashmap::DashMap;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::fs;
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

const HOST: &str = "0.0.0.0";
const PORT: u16 = 8793;
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    store: PathBuf,
    root: PathBuf,
    notes_dir: PathBuf,
    locks: Arc<DashMap<String, Arc<Mutex<()>>>>,
}

impl AppState {
    fn new(store: PathBuf, root: PathBuf, notes_dir: PathBuf) -> Self {
        Self {
            store,
            root,
            notes_dir,
            locks: Arc::new(DashMap::new()),
        }
    }
}

pub fn resolve_store_path() -> PathBuf {
    if let Ok(p) = std::env::var("ANNOTA_STORE") {
        return PathBuf::from(p);
    }
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let manifest = PathBuf::from(manifest);
        if let Some(root) = manifest.parent().and_then(|p| p.parent()) {
            return root.join("app/service/store");
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors() {
            let candidate = ancestor.join("app/service/store");
            if candidate.exists() {
                return candidate;
            }
        }
    }
    std::env::current_dir()
        .unwrap_or_default()
        .join("app/service/store")
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

pub fn resolve_notes_dir() -> PathBuf {
    if let Ok(p) = std::env::var("NOTES_DIR") {
        return PathBuf::from(p);
    }
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let manifest = PathBuf::from(manifest);
        if let Some(root) = manifest.parent().and_then(|p| p.parent()) {
            return root.join("app/service/notes");
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors() {
            let candidate = ancestor.join("app/service/notes");
            if candidate.exists() {
                return candidate;
            }
        }
    }
    std::env::current_dir()
        .unwrap_or_default()
        .join("app/service/notes")
}

pub async fn run_server(store: PathBuf, root: PathBuf, notes_dir: PathBuf) {
    let state = AppState::new(store, root, notes_dir);

    let app = Router::new()
        .route("/", get(root_handler))
        .route("/api/health", get(health))
        .route("/api/list", get(list))
        .route("/api/ai", get(ai_status))
        .route("/api/note", post(note))
        .route(
            "/api/anno/:media_id",
            get(get_anno).put(put_anno).post(put_anno),
        )
        .fallback_service(ServeDir::new(state.root.clone()))
        .layer(CorsLayer::very_permissive())
        .with_state(state);

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

    let pack = {
        let _guard = lock.lock().await;
        let cur = read_pack(&state.store, &media_id).await;
        let existing = cur.get("entries").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let incoming_entries = incoming
            .get("entries")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let merged = merge_entries(&existing, &incoming_entries);
        let media = incoming
            .get("media")
            .cloned()
            .or_else(|| cur.get("media").cloned())
            .unwrap_or_else(|| json!({ "videoId": media_id }));
        let pack = json!({
            "format": "video-annotate/0.1",
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

async fn ai_status() -> Response {
    let base = std::env::var("LLM_BASE_URL")
        .or_else(|_| std::env::var("ARK_BASE_URL"))
        .unwrap_or_else(|_| "https://ark.cn-beijing.volces.com/api/v3".to_string());
    let key = std::env::var("LLM_API_KEY")
        .or_else(|_| std::env::var("ARK_API_KEY"))
        .unwrap_or_default();
    let model = std::env::var("LLM_MODEL")
        .or_else(|_| std::env::var("ARK_MODEL"))
        .unwrap_or_else(|_| "doubao-pro-32k".to_string());
    json_ok(json!({
        "ok": true,
        "configured": !key.is_empty(),
        "model": model,
        "base": base,
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

async fn root_handler(State(state): State<AppState>) -> Response {
    let index = state.root.join("app/service/index.html");
    if index.is_file() {
        match fs::read_to_string(&index).await {
            Ok(html) => Html(html).into_response(),
            Err(e) => json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("read index: {e}"),
            ),
        }
    } else {
        Html(landing_page(&state.store)).into_response()
    }
}

fn landing_page(store: &Path) -> String {
    let store_str = store.to_string_lossy();
    format!(
        r#"<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Annota · 同步服务</title>
<style>
body{{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;background:#0b0e13;color:#e6edf3;
margin:0;padding:28px;max-width:720px}}
h1{{font-size:19px;color:#f0b429}}
code{{color:#9ecbff;background:#161b22;padding:2px 6px;border-radius:4px}}
.k{{color:#8b949e}}
.qr{{margin-top:18px;padding:14px;background:#161b22;border-radius:10px;border:1px solid #30363d}}
</style>
<h1>Annota · 同步服务</h1>
<p>状态：<b style="color:#7ee787">运行中</b>　存储：<code>{}</code></p>
<p>API：<code>GET/PUT /api/anno/&lt;mediaId&gt;</code>，<code>GET /api/list</code>，<code>GET /api/health</code></p>
<div class="qr">
<p class="k">手机自测：同一 Wi‑Fi 下打开 <code>http://&lt;本机IP&gt;:{}/dev/demo.html</code><br>
脚本内 <code>⚙ → 同步地址</code> 填 <code>http://&lt;本机IP&gt;:{}</code></p>
</div>
</html>"#,
        store_str, PORT, PORT
    )
}

fn key_to_file(store: &Path, key: &str) -> PathBuf {
    store.join(format!("{}.json", sanitize_key(key)))
}

fn sanitize_key(key: &str) -> String {
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

fn same(e: &Value, o: &Value) -> bool {
    let e_word = e.get("word").and_then(|v| v.as_str()).unwrap_or("");
    let o_word = o.get("word").and_then(|v| v.as_str()).unwrap_or("");
    if e_word != o_word {
        return false;
    }
    let e_t = to_float(e.get("t").unwrap_or(&Value::Null), 0.0);
    let o_t = to_float(o.get("t").unwrap_or(&Value::Null), 0.0);
    if (e_t - o_t).abs() >= 0.4 {
        return false;
    }
    iou(e.get("box").unwrap_or(&Value::Null), o.get("box").unwrap_or(&Value::Null)) > 0.6
}

fn merge_entries(a: &[Value], b: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for e in a.iter().chain(b.iter()) {
        if !e.is_object() {
            continue;
        }
        if e.get("word").and_then(|v| v.as_str()).map(|s| s.is_empty()).unwrap_or(true) {
            continue;
        }
        if !valid_box(e.get("box").unwrap_or(&Value::Null)) {
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
        format!("media: {}", media.get("videoId").and_then(|v| v.as_str()).unwrap_or("")),
        format!("platform: {}", media.get("platform").and_then(|v| v.as_str()).unwrap_or("")),
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
    if !entries.is_empty() {
        lines.push("## 生词（标注）".to_string());
        lines.push("".to_string());
        lines.push("| 词 | 释义 | 词性 | 时刻(s) | 时长(s) |".to_string());
        lines.push("|---|---|---|---|---|".to_string());
        for e in entries {
            let word = e.get("word").and_then(|v| v.as_str()).unwrap_or("");
            let label = e
                .get("label")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .replace('|', "/");
            let pos = e.get("pos").and_then(|v| v.as_str()).unwrap_or("");
            let t = e.get("t").and_then(|v| v.as_str()).unwrap_or("");
            let dur = e.get("dur").and_then(|v| v.as_str()).unwrap_or("");
            lines.push(format!("| {} | {} | {} | {} | {} |", word, label, pos, t, dur));
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
