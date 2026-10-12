//! 雅思词库联动（ielts 插件的服务端）。
//!
//! 跨仓只读引用姐妹仓 `ielts-7.5` 的 JSONL 数据资产（它在 app/README.md 里明确把
//! video-annotate 列为下游）：
//!   - assets/vocab/.cache/雅思.jsonl   音标/释义/短语/例句（~7k 行，全量驻留内存）
//!   - assets/vocab/enrich/ielts.jsonl  词源/同反义词（~5k 行，可缺）
//! 数据目录解析：env `ANNOTA_IELTS_DIR` → settings 的 `ielts.dataDir` → debug 构建的
//! 兄弟仓默认路径；都没有 → 端点返回 501（前端插件静默停用，不刷屏）。
//!
//! 安全：word 参数只做格式校验 + HashMap 键查找，**永不参与路径拼接**；服务端只打开
//! 配置目录下的固定文件名。

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::sync_server::AppState;

const MAX_FIELD: usize = 500;
const MAX_LIST: usize = 3;
const MAX_ENRICH_LIST: usize = 5;

/// word(小写) → 原始 JSON 行；lookup 时才做单行解析。
pub struct IeltsIndex {
    vocab: HashMap<String, String>,
    enrich: HashMap<String, String>,
}

/// 进程内缓存已构建的索引；**未配置/构建失败不缓存**——settings 配好 dataDir 后
/// 下一次请求即生效，无需重启（否则 None 被永久缓存，改配置永远不生效）。
static INDEX: Mutex<Option<Arc<IeltsIndex>>> = Mutex::new(None);

fn valid_word(word: &str) -> bool {
    let len = word.chars().count();
    if len == 0 || len > 61 {
        return false;
    }
    let mut chars = word.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphabetic() {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '\'' || c == '-' || c == ' ')
}

fn resolve_data_dir(settings: &Path) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("ANNOTA_IELTS_DIR") {
        let dir = dir.trim();
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    if let Ok(text) = std::fs::read_to_string(settings) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            let dir = v
                .get("ielts")
                .and_then(|i| i.get("dataDir"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if !dir.is_empty() {
                return Some(PathBuf::from(dir));
            }
        }
    }
    #[cfg(debug_assertions)]
    {
        // 开发机默认：video-annotate 的兄弟仓（本机开箱即用；发行构建不带此回退）。
        let sibling = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../ielts-7.5");
        if sibling.join("assets/vocab/.cache/雅思.jsonl").exists() {
            return Some(sibling);
        }
    }
    None
}

fn line_word(line: &str) -> Option<String> {
    serde_json::from_str::<Value>(line)
        .ok()?
        .get("word")
        .and_then(Value::as_str)
        .map(|w| w.trim().to_lowercase())
        .filter(|w| !w.is_empty())
}

fn read_index(dir: &Path) -> Option<IeltsIndex> {
    let vocab_path = dir.join("assets/vocab/.cache/雅思.jsonl");
    let text = std::fs::read_to_string(&vocab_path).ok()?;
    let mut vocab: HashMap<String, String> = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match line_word(line) {
            Some(word) => {
                vocab.insert(word, line.to_string());
            }
            None => crate::logf::log("WARN", "雅思词库：跳过无法解析的行"),
        }
    }
    if vocab.is_empty() {
        return None; // 全部损坏 → 视为未配置
    }
    let mut enrich: HashMap<String, String> = HashMap::new();
    if let Ok(etext) = std::fs::read_to_string(dir.join("assets/vocab/enrich/ielts.jsonl")) {
        for line in etext.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Some(word) = line_word(line) {
                enrich.insert(word, line.to_string());
            }
        }
    }
    crate::logf::log(
        "INFO",
        &format!("雅思词库索引就绪：{} 词（富化 {}）", vocab.len(), enrich.len()),
    );
    Some(IeltsIndex { vocab, enrich })
}

fn index_for(settings: &Path) -> Option<Arc<IeltsIndex>> {
    if let Ok(g) = INDEX.lock() {
        if let Some(idx) = g.as_ref() {
            return Some(idx.clone());
        }
    }
    let idx = read_index(&resolve_data_dir(settings)?)?;
    let arc = Arc::new(idx);
    if let Ok(mut g) = INDEX.lock() {
        *g = Some(arc.clone());
    }
    Some(arc)
}

/// 粗粒度词形尝试（最多 6 个候选，精确匹配优先）：'s / -ing / -ed / -s。
fn candidates(word: &str) -> Vec<String> {
    let mut out = vec![word.to_string()];
    if let Some(stem) = word.strip_suffix("'s") {
        out.push(stem.to_string());
    }
    if let Some(stem) = word.strip_suffix("ing") {
        out.push(stem.to_string());
        out.push(format!("{stem}e"));
    }
    if let Some(stem) = word.strip_suffix("ed") {
        out.push(format!("{stem}e"));
        out.push(stem.to_string());
    }
    if let Some(stem) = word.strip_suffix("s") {
        if stem.len() >= 2 && !word.ends_with("ss") {
            out.push(stem.to_string());
        }
    }
    out.truncate(6);
    out.dedup();
    out
}

fn trim_str(v: &Value) -> String {
    let s = v.as_str().unwrap_or("");
    if s.chars().count() > MAX_FIELD {
        s.chars().take(MAX_FIELD).collect()
    } else {
        s.to_string()
    }
}

fn slim_list(v: &Value, take: usize) -> Vec<Value> {
    v.as_array()
        .map(|a| a.iter().take(take).cloned().collect())
        .unwrap_or_default()
}

fn lookup_in(index: &IeltsIndex, word: &str) -> Option<Value> {
    let key = word.trim().to_lowercase();
    let mut matched: Option<(String, &str)> = None;
    for candidate in candidates(&key) {
        if let Some(found) = index.vocab.get(&candidate) {
            matched = Some((candidate, found.as_str()));
            break;
        }
    }
    let (matched_key, raw) = matched?;
    let parsed = serde_json::from_str::<Value>(raw).ok()?;
    let mut out = json!({
        "word": parsed.get("word").and_then(Value::as_str).unwrap_or(&key),
        "us": parsed.get("us").map(trim_str).unwrap_or_default(),
        "uk": parsed.get("uk").map(trim_str).unwrap_or_default(),
        "translations": slim_list(parsed.get("translations").unwrap_or(&Value::Null), MAX_LIST),
        "phrases": slim_list(parsed.get("phrases").unwrap_or(&Value::Null), MAX_LIST),
        "sentences": slim_list(parsed.get("sentences").unwrap_or(&Value::Null), MAX_LIST),
    });
    // 富化数据（词源/同反义词）：按**命中的词形**查（屈折变化如 abandoned 也能合入词干富化）
    if let Some(eline) = index.enrich.get(&matched_key) {
        if let Ok(eval) = serde_json::from_str::<Value>(eline) {
            out["pos"] = eval.get("pos").cloned().unwrap_or(Value::Null);
            out["syn"] = json!(slim_list(eval.get("syn").unwrap_or(&Value::Null), MAX_ENRICH_LIST));
            out["ant"] = json!(slim_list(eval.get("ant").unwrap_or(&Value::Null), MAX_ENRICH_LIST));
            out["gloss"] = json!(slim_list(eval.get("gloss").unwrap_or(&Value::Null), 2)
                .into_iter()
                .map(|g| json!(trim_str(&g)))
                .collect::<Vec<_>>());
            out["etymo_text"] = json!(eval
                .get("etymo_text")
                .map(trim_str)
                .unwrap_or_default());
        }
    }
    Some(out)
}

/// GET /api/ielts/lookup?word=<w>
pub async fn lookup(State(state): State<AppState>, Query(params): Query<HashMap<String, String>>) -> Response {
    let word = params.get("word").map(|s| s.trim()).unwrap_or("");
    if !valid_word(word) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "invalid_word" })),
        )
            .into_response();
    }
    // 索引构建是阻塞 IO（首次 ~12k 行解析），挪出 tokio worker
    let settings = state.settings_path().to_path_buf();
    let index = match tokio::task::spawn_blocking(move || index_for(&settings)).await {
        Ok(idx) => idx,
        Err(e) => {
            crate::logf::log("ERROR", &format!("ielts index task join: {e}"));
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": "internal" })),
            )
                .into_response();
        }
    };
    match index {
        None => (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({ "ok": false, "error": "ielts-data-not-configured" })),
        )
            .into_response(),
        Some(index) => match lookup_in(&index, word) {
            Some(found) => {
                let mut resp = json!({ "ok": true, "found": true });
                if let Some(obj) = found.as_object() {
                    for (k, v) in obj {
                        resp[k] = v.clone();
                    }
                }
                Json(resp).into_response()
            }
            None => Json(json!({ "ok": true, "found": false })).into_response(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    const VOCAB_LINE: &str = r#"{"word":"abandon","us":"ə'bændən","uk":"ə'bænd(ə)n","translations":[{"translation":"离弃；放弃","type":"v"}],"phrases":[{"phrase":"with abandon","translation":"恣意地"}],"sentences":[{"sentence":"How could she abandon her own child?","translation":"她怎么能抛弃自己的孩子？"}]}"#;
    const ENRICH_LINE: &str = r#"{"word":"abandon","pos":{"v":"v"},"syn":["forsake"],"ant":[],"gloss":["to leave completely"],"etymo_text":"Old French abandoner"}"#;

    fn fixture_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("annota-ielts-{}-{}", label, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("assets/vocab/.cache")).unwrap();
        std::fs::create_dir_all(dir.join("assets/vocab/enrich")).unwrap();
        std::fs::write(dir.join("assets/vocab/.cache/雅思.jsonl"), format!("{VOCAB_LINE}\nnot-json-line\n")).unwrap();
        std::fs::write(dir.join("assets/vocab/enrich/ielts.jsonl"), format!("{ENRICH_LINE}\n")).unwrap();
        dir
    }

    #[test]
    fn valid_word_accepts_plain_english() {
        assert!(valid_word("abandon"));
        assert!(valid_word("don't stop"));
        assert!(valid_word("well-known"));
    }

    #[test]
    fn valid_word_rejects_path_and_empty() {
        assert!(!valid_word(""));
        assert!(!valid_word("../../etc/passwd"));
        assert!(!valid_word("a/b"));
        assert!(!valid_word("word?x=1"));
        assert!(!valid_word("中文"));
    }

    #[test]
    fn lookup_finds_word_and_merges_enrich() {
        let dir = fixture_dir("lookup");
        let index = read_index(&dir).unwrap();
        let hit = lookup_in(&index, "Abandon").expect("应命中");
        assert_eq!(hit["word"], "abandon");
        assert!(hit["us"].as_str().unwrap().contains("bænd"));
        assert_eq!(hit["translations"][0]["translation"], "离弃；放弃");
        assert_eq!(hit["syn"][0], "forsake");
        assert_eq!(hit["gloss"][0], "to leave completely");
    }

    #[test]
    fn lookup_tries_simple_suffixes() {
        let dir = fixture_dir("suffix");
        let index = read_index(&dir).unwrap();
        assert!(lookup_in(&index, "abandoned").is_some());
        assert!(lookup_in(&index, "abandoning").is_some());
    }

    #[test]
    fn lookup_miss_returns_none() {
        let dir = fixture_dir("miss");
        let index = read_index(&dir).unwrap();
        assert!(lookup_in(&index, "zzzznotaword").is_none());
    }

    #[test]
    fn real_sister_repo_if_present() {
        // 真实数据冒烟：本机装了姐妹仓才跑（CI/其它机器自动跳过）。
        let sibling = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../ielts-7.5");
        if !sibling.join("assets/vocab/.cache/雅思.jsonl").exists() {
            eprintln!("skip: ielts-7.5 not found at {}", sibling.display());
            return;
        }
        let index = read_index(&sibling).expect("真实词库应可构建索引");
        let hit = lookup_in(&index, "abandon").expect("abandon 应在雅思词库");
        assert!(hit["translations"]
            .as_array()
            .map(|a| !a.is_empty())
            .unwrap_or(false));
    }

    #[tokio::test]
    async fn route_lookup_end_to_end() {
        // 端到端走 build_app：settings 里写 ielts.dataDir 指向 fixture（env 优先级更高，
        // 若本机设了 ANNOTA_IELTS_DIR 则本用例跳过，避免环境串扰）。
        if std::env::var("ANNOTA_IELTS_DIR").is_ok() {
            eprintln!("skip: ANNOTA_IELTS_DIR is set");
            return;
        }
        let dir = fixture_dir("route");
        let appdir = std::env::temp_dir().join(format!("annota-ielts-app-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(appdir.join("exports")).unwrap();
        let settings = appdir.join("settings.json");
        std::fs::write(
            &settings,
            json!({ "ielts": { "dataDir": dir.to_string_lossy() } }).to_string(),
        )
        .unwrap();
        let state = crate::sync_server::AppState::new(
            appdir.clone(),
            appdir.clone(),
            appdir.join("notes"),
            settings,
            appdir.join("exports"),
            crate::store::Db::open_in_memory().unwrap(),
            std::sync::Arc::new(crate::plugins::PluginsState::load(appdir.join("plugins"))),
        );
        let app = crate::sync_server::build_app(state);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/ielts/lookup?word=abandon")
                    .header("host", "127.0.0.1:8793")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["found"], true);
        assert_eq!(v["word"], "abandon");

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/ielts/lookup?word=zzzznotaword")
                    .header("host", "127.0.0.1:8793")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["found"], false);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/ielts/lookup?word=..%2F..%2Fetc")
                    .header("host", "127.0.0.1:8793")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }
}
