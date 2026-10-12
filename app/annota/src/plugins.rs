//! 插件装载层（v2）：本地 zip 安装 → app_data 存储 → 内存快照 → 注入层消费。
//!
//! 契约层（coreApi/__VA_PLUGIN_DEFS__，见 core.js 与 docs/plugins.md）不变；本模块只管
//! 「包怎么进来、存在哪、哪些启用」。注入时机与方式见 tabs.rs（每插件独立
//! initialization_script，排在 ANNOTATE_JS 之前，parse 隔离由 wry 提供）。
//!
//! 安全模型：安装即信任（显式确认）+ token（挡恶意网页静默安装）+ zip 全量校验
//! （zip-slip/条目数/单文件/总量/压缩比）。残余风险（本机 GM 脚本可带 token 调用）
//! 写在 docs/plugins.md。

use axum::http::{HeaderMap, StatusCode};
use serde_json::{json, Value};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub const MAX_ZIP_BODY: usize = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 32;
const MAX_MANIFEST: u64 = 16 * 1024;
const MAX_MAIN: u64 = 512 * 1024;
const MAX_TOTAL_UNCOMPRESSED: u64 = 2 * 1024 * 1024;
const MAX_COMPRESSION_RATIO: u64 = 20;

/// 出厂内置插件 id（编译进引擎，不允许被安装覆盖）。
/// 注意：ielts 已外移到插件仓、不再是内置——它必须能被安装，故不在保留集。
pub const RESERVED_IDS: &[&str] = &["anki-export", "group"];

#[derive(Clone, Debug)]
pub struct PluginMeta {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub permissions: Vec<String>,
    pub engine: Option<String>,
    pub view_only: bool,
    /// 包根下的入口文件名（已校验为单层文件名）
    pub main: String,
}

pub struct PluginRecord {
    pub meta: PluginMeta,
    /// main.js 源码；None = 损坏（不注入，仅列表展示可卸载）
    pub source: Option<String>,
    pub enabled: bool,
    pub broken: bool,
    /// 安装来源文件名（展示用）
    pub from: String,
}

struct Inner {
    records: Vec<PluginRecord>, // 按 id 排序
}

pub struct PluginsState {
    dir: PathBuf,
    token: String,
    inner: Mutex<Inner>,
}

pub fn resolve_plugins_dir(app: &AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("ANNOTA_PLUGINS_DIR") {
        return PathBuf::from(p);
    }
    if cfg!(debug_assertions) {
        if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
            let manifest = PathBuf::from(manifest);
            if let Some(root) = manifest.parent().and_then(|p| p.parent()) {
                return root.join("app/service/plugins");
            }
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("Annota"))
        .join("plugins")
}

// ---------- 校验 ----------

fn valid_id(id: &str) -> bool {
    let len = id.len();
    if len == 0 || len > 41 {
        return false;
    }
    let mut chars = id.chars();
    let first = chars.next().unwrap();
    first.is_ascii_lowercase() && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn valid_plain(value: &str, max: usize) -> bool {
    let v = value.trim();
    !v.is_empty() && v.len() <= max && !v.chars().any(|c| c.is_control())
}

fn parse_manifest(text: &str) -> Result<PluginMeta, String> {
    let v: Value = serde_json::from_str(text).map_err(|_| "manifest 不是合法 JSON".to_string())?;
    let id = v.get("id").and_then(Value::as_str).unwrap_or("").trim();
    if !valid_id(id) {
        return Err("manifest.id 必须是小写字母开头的 kebab-case（1-41 字符）".into());
    }
    let name = v.get("name").and_then(Value::as_str).unwrap_or("").trim();
    if !valid_plain(name, 64) {
        return Err("manifest.name 缺失或非法".into());
    }
    let version = v.get("version").and_then(Value::as_str).unwrap_or("").trim();
    if !valid_plain(version, 32) {
        return Err("manifest.version 缺失或非法".into());
    }
    let description = v.get("description").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let main = v.get("main").and_then(Value::as_str).unwrap_or("main.js").trim();
    // main 必须是包根下的单层文件名（不参与路径拼接前先卡死）
    if main.is_empty() || main.len() > 64 || main.contains('/') || main.contains('\\') || main.contains("..") {
        return Err("manifest.main 必须是包根下的文件名（如 main.js）".into());
    }
    let mut permissions = Vec::new();
    if let Some(arr) = v.get("permissions").and_then(Value::as_array) {
        if arr.len() > 16 {
            return Err("manifest.permissions 最多 16 项".into());
        }
        for p in arr {
            let p = p.as_str().unwrap_or("").trim();
            if !valid_plain(p, 32) {
                return Err("manifest.permissions 含非法项".into());
            }
            permissions.push(p.to_string());
        }
    }
    let engine = v
        .get("engine")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.len() <= 64);
    let view_only = v.get("viewOnly").and_then(Value::as_bool).unwrap_or(false);
    Ok(PluginMeta {
        id: id.to_string(),
        name: name.to_string(),
        version: version.to_string(),
        description,
        permissions,
        engine,
        view_only,
        main: main.to_string(),
    })
}

pub struct ParsedZip {
    pub meta: PluginMeta,
    pub main_source: String,
}

/// 解析并全量校验 zip（不落盘）。dry-run 与 install 共用。
pub fn inspect_zip(bytes: &[u8]) -> Result<ParsedZip, String> {
    if bytes.len() > MAX_ZIP_BODY {
        return Err(format!("zip 超过 {}MB 上限", MAX_ZIP_BODY / 1024 / 1024));
    }
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|_| "不是合法的 zip 文件".to_string())?;
    if archive.len() > MAX_ENTRIES {
        return Err(format!("zip 条目最多 {MAX_ENTRIES} 个"));
    }
    let mut manifest_text: Option<String> = None;
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|_| "zip 条目损坏".to_string())?;
        if entry.is_dir() {
            continue;
        }
        // zip-slip：enclosed_name 拒绝绝对路径与 .. 穿越；v1 只接受包根单层文件。
        let enclosed = match entry.enclosed_name() {
            Some(p) => p,
            None => return Err("zip 含非法路径条目".into()),
        };
        if enclosed.components().count() != 1 {
            return Err("v1 插件包只支持根目录平铺文件（不接受子目录）".into());
        }
        let size = entry.size();
        let compressed = entry.compressed_size();
        total = total.saturating_add(size);
        if total > MAX_TOTAL_UNCOMPRESSED {
            return Err(format!("解压总量超过 {}KB 上限", MAX_TOTAL_UNCOMPRESSED / 1024));
        }
        if size > 1024 && compressed > 0 && size / compressed > MAX_COMPRESSION_RATIO {
            return Err("zip 含压缩比异常条目（疑似 zip bomb）".into());
        }
        let file_name = enclosed
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if file_name == "manifest.json" {
            if size > MAX_MANIFEST {
                return Err("manifest.json 超过 16KB".into());
            }
            let mut buf = String::new();
            entry
                .read_to_string(&mut buf)
                .map_err(|_| "manifest.json 读取失败".to_string())?;
            manifest_text = Some(buf);
        } else {
            if size > MAX_MAIN {
                return Err(format!("文件 {file_name} 超过 512KB"));
            }
            let mut buf = Vec::with_capacity(size as usize + 8);
            entry
                .read_to_end(&mut buf)
                .map_err(|_| format!("条目 {file_name} 读取失败"))?;
            files.push((file_name, buf));
        }
    }
    let manifest_text = manifest_text.ok_or_else(|| "zip 缺少 manifest.json".to_string())?;
    let meta = parse_manifest(&manifest_text)?;
    let main_source = files
        .into_iter()
        .find(|(name, _)| *name == meta.main)
        .map(|(_, bytes)| bytes)
        .ok_or_else(|| format!("zip 缺少入口文件 {}", meta.main))?;
    let main_source = String::from_utf8(main_source).map_err(|_| "入口文件不是 UTF-8 文本".to_string())?;
    Ok(ParsedZip { meta, main_source })
}

// ---------- 状态文件 ----------

fn state_path(dir: &Path) -> PathBuf {
    dir.join("plugins.json")
}

fn read_state(dir: &Path) -> Vec<(String, bool, String)> {
    // (id, enabled, from)
    let text = std::fs::read_to_string(state_path(dir)).ok();
    let parse = |t: &str| -> Option<Vec<(String, bool, String)>> {
        let v: Value = serde_json::from_str(t).ok()?;
        let arr = v.get("entries")?.as_array()?;
        Some(
            arr.iter()
                .filter_map(|e| {
                    let id = e.get("id")?.as_str()?.to_string();
                    if !valid_id(&id) {
                        return None;
                    }
                    let enabled = e.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                    let from = e.get("from").and_then(Value::as_str).unwrap_or("").to_string();
                    Some((id, enabled, from))
                })
                .collect(),
        )
    };
    if let Some(t) = text.as_deref() {
        if let Some(entries) = parse(t) {
            return entries;
        }
        crate::logf::log("WARN", "plugins.json 损坏，尝试 .bak");
        if let Ok(bak) = std::fs::read_to_string(dir.join("plugins.json.bak")) {
            if let Some(entries) = parse(&bak) {
                return entries;
            }
        }
        crate::logf::log("WARN", "plugins.json 与 .bak 均损坏，重置为空");
    }
    Vec::new()
}

fn write_state(dir: &Path, records: &[PluginRecord]) -> std::io::Result<()> {
    let entries: Vec<Value> = records
        .iter()
        .map(|r| {
            json!({
                "id": r.meta.id,
                "enabled": r.enabled,
                "from": r.from,
            })
        })
        .collect();
    let text = serde_json::to_string_pretty(&json!({ "v": 1, "entries": entries }))
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let path = state_path(dir);
    if path.exists() {
        let _ = std::fs::copy(&path, dir.join("plugins.json.bak"));
    }
    let tmp = dir.join("plugins.json.tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

// ---------- 装载状态 ----------

fn load_record(dir: &Path, id: &str, enabled: bool, from: String) -> PluginRecord {
    fn broken_record(id: &str, from: String, why: &str) -> PluginRecord {
        crate::logf::log("WARN", &format!("插件 {id} 损坏：{why}"));
        PluginRecord {
            meta: PluginMeta {
                id: id.to_string(),
                name: id.to_string(),
                version: "0.0.0".into(),
                description: String::new(),
                permissions: Vec::new(),
                engine: None,
                view_only: false,
                main: "main.js".into(),
            },
            source: None,
            enabled: false, // 损坏永不启用/注入
            broken: true,
            from,
        }
    }
    let plugin_dir = dir.join(id);
    let manifest_text = match std::fs::read_to_string(plugin_dir.join("manifest.json")) {
        Ok(t) => t,
        Err(_) => return broken_record(id, from, "缺少 manifest.json"),
    };
    let meta = match parse_manifest(&manifest_text) {
        Ok(m) => m,
        Err(e) => return broken_record(id, from, &e),
    };
    if meta.id != id {
        return broken_record(id, from, "目录名与 manifest.id 不一致");
    }
    // main 已过 parse_manifest 校验（单层文件名），此处 join 不会穿越
    match std::fs::read_to_string(plugin_dir.join(&meta.main)) {
        Ok(source) => PluginRecord {
            meta,
            source: Some(source),
            enabled,
            broken: false,
            from,
        },
        Err(_) => broken_record(id, from, "入口文件缺失"),
    }
}

impl PluginsState {
    pub fn load(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let state_entries = read_state(&dir);
        let mut records: Vec<PluginRecord> = Vec::new();
        // 磁盘目录扫描（state 有记录但目录丢失 → 丢弃该记录）
        if let Ok(read) = std::fs::read_dir(&dir) {
            for e in read.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                // 跳过 plugins.json/.tmp 等非插件条目；内置 id 目录一律不加载（防影子注入）
                if !valid_id(&name) || RESERVED_IDS.contains(&name.as_str()) || e.path().is_file() {
                    continue;
                }
                let (enabled, from) = state_entries
                    .iter()
                    .find(|(id, _, _)| *id == name)
                    .map(|(_, en, fr)| (*en, fr.clone()))
                    .unwrap_or((true, String::new()));
                records.push(load_record(&dir, &name, enabled, from));
            }
        }
        // state 里有、目录没有的孤儿记录：回写时自然清除
        records.sort_by(|a, b| a.meta.id.cmp(&b.meta.id));
        if let Err(e) = write_state(&dir, &records) {
            crate::logf::log("WARN", &format!("plugins.json 初始化写入失败：{e}"));
        }
        Self {
            dir,
            token: uuid::Uuid::new_v4().to_string(),
            inner: Mutex::new(Inner { records }),
        }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// 注入层消费：启用且未损坏的插件源码，按 id 排序。
    pub fn injection_scripts(&self) -> Vec<String> {
        let inner = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => {
                crate::logf::log("ERROR", "插件状态锁中毒：本次注入为空");
                return Vec::new();
            }
        };
        inner
            .records
            .iter()
            .filter(|r| r.enabled && !r.broken)
            .filter_map(|r| r.source.clone())
            .collect()
    }

    /// 管理页列表：内置（只读展示）+ 已安装。
    pub fn list_json(&self) -> Vec<Value> {
        let mut out: Vec<Value> = RESERVED_IDS
            .iter()
            .map(|id| {
                json!({ "id": id, "name": builtin_name(id), "builtin": true, "enabled": true })
            })
            .collect();
        if let Ok(inner) = self.inner.lock() {
            for r in &inner.records {
                out.push(json!({
                    "id": r.meta.id,
                    "name": r.meta.name,
                    "version": r.meta.version,
                    "description": r.meta.description,
                    "permissions": r.meta.permissions,
                    "engine": r.meta.engine,
                    "viewOnly": r.meta.view_only,
                    "enabled": r.enabled,
                    "broken": r.broken,
                    "from": r.from,
                    "builtin": false,
                }));
            }
        } else {
            crate::logf::log("ERROR", "插件状态锁中毒：列表缺少已安装项");
        }
        out
    }

    /// 干跑校验（不落盘），返回预览信息供安装确认框展示。
    pub fn preview(bytes: &[u8]) -> Result<Value, String> {
        let parsed = inspect_zip(bytes)?;
        if RESERVED_IDS.contains(&parsed.meta.id.as_str()) {
            return Err(format!("{} 是出厂内置插件 id，不能安装同名插件", parsed.meta.id));
        }
        Ok(json!({
            "id": parsed.meta.id,
            "name": parsed.meta.name,
            "version": parsed.meta.version,
            "description": parsed.meta.description,
            "permissions": parsed.meta.permissions,
            "engine": parsed.meta.engine,
            "viewOnly": parsed.meta.view_only,
            "size": bytes.len(),
        }))
    }

    pub fn install(&self, bytes: &[u8], from: &str) -> Result<Value, String> {
        let parsed = inspect_zip(bytes)?;
        let id = parsed.meta.id.clone();
        if RESERVED_IDS.contains(&id.as_str()) {
            return Err(format!("{id} 是出厂内置插件 id，不能安装同名插件"));
        }
        // 来源文件名净化：去控制字符、限长（唯一用户可控的入库展示串）
        let from: String = from
            .chars()
            .filter(|c| !c.is_control())
            .take(120)
            .collect::<String>()
            .trim()
            .to_string();
        let from = if from.is_empty() { "plugin.zip".to_string() } else { from };
        // 落盘：.tmp 目录写入后 rename 原子提交（同 id = 覆盖升级，保留 enabled）
        let tmp = self.dir.join(".tmp").join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&tmp).map_err(|e| format!("创建临时目录失败：{e}"))?;
        let write_result = (|| -> std::io::Result<()> {
            std::fs::write(
                tmp.join("manifest.json"),
                serde_json::to_string_pretty(&json!({
                    "id": parsed.meta.id,
                    "name": parsed.meta.name,
                    "version": parsed.meta.version,
                    "description": parsed.meta.description,
                    "permissions": parsed.meta.permissions,
                    "engine": parsed.meta.engine,
                    "viewOnly": parsed.meta.view_only,
                    "main": "main.js",
                }))
                .unwrap_or_default(),
            )?;
            std::fs::write(tmp.join("main.js"), &parsed.main_source)?;
            Ok(())
        })();
        if let Err(e) = write_result {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!("写入插件文件失败：{e}"));
        }
        let target = self.dir.join(&id);
        let commit = (|| -> std::io::Result<()> {
            if target.exists() {
                let old = self.dir.join(format!(".old-{}", uuid::Uuid::new_v4()));
                std::fs::rename(&target, &old)?;
                match std::fs::rename(&tmp, &target) {
                    Ok(()) => {
                        let _ = std::fs::remove_dir_all(&old);
                        Ok(())
                    }
                    Err(e) => {
                        // 升级失败回滚旧版本：不能让唯一可用副本被删
                        let _ = std::fs::rename(&old, &target);
                        Err(e)
                    }
                }
            } else {
                std::fs::rename(&tmp, &target)
            }
        })();
        if let Err(e) = commit {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!("提交插件目录失败：{e}"));
        }
        let mut inner = self.inner.lock().map_err(|_| "插件状态锁损坏".to_string())?;
        let prev_enabled = inner
            .records
            .iter()
            .find(|r| r.meta.id == id)
            .map(|r| r.enabled)
            .unwrap_or(true);
        let record = load_record(&self.dir, &id, prev_enabled, from.clone());
        if record.broken {
            return Err("安装后自检失败（插件损坏）".into());
        }
        inner.records.retain(|r| r.meta.id != id);
        inner.records.push(record);
        inner.records.sort_by(|a, b| a.meta.id.cmp(&b.meta.id));
        if let Err(e) = write_state(&self.dir, &inner.records) {
            crate::logf::log("WARN", &format!("plugins.json 写入失败：{e}"));
        }
        Ok(json!({ "ok": true, "id": id }))
    }

    pub fn toggle(&self, id: &str, enabled: bool) -> Result<(), StatusCode> {
        if !valid_id(id) || RESERVED_IDS.contains(&id) {
            return Err(StatusCode::BAD_REQUEST);
        }
        let mut inner = self.inner.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let rec = inner
            .records
            .iter_mut()
            .find(|r| r.meta.id == id)
            .ok_or(StatusCode::NOT_FOUND)?;
        if rec.broken {
            return Err(StatusCode::CONFLICT);
        }
        rec.enabled = enabled;
        if let Err(e) = write_state(&self.dir, &inner.records) {
            crate::logf::log("WARN", &format!("plugins.json 写入失败（toggle）：{e}"));
        }
        Ok(())
    }

    pub fn uninstall(&self, id: &str) -> Result<(), StatusCode> {
        if !valid_id(id) || RESERVED_IDS.contains(&id) {
            return Err(StatusCode::BAD_REQUEST);
        }
        {
            let mut inner = self.inner.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            inner.records.retain(|r| r.meta.id != id);
            if let Err(e) = write_state(&self.dir, &inner.records) {
                crate::logf::log("WARN", &format!("plugins.json 写入失败（uninstall）：{e}"));
            }
        }
        let target = self.dir.join(id);
        if target.exists() {
            std::fs::remove_dir_all(&target).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        Ok(())
    }
}

fn builtin_name(id: &str) -> &str {
    match id {
        "anki-export" => "Anki 导出",
        "group" => "组同步",
        _ => "内置插件",
    }
}

/// token 校验：管理页从 GET /api/plugins 拿到后随写请求回传。
pub fn check_token(state_token: &str, headers: &HeaderMap) -> bool {
    headers
        .get("x-annota-token")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == state_token)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn build_zip(files: &[(&str, &str)]) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut cursor);
            let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, content) in files {
                w.start_file(*name, opts).unwrap();
                w.write_all(content.as_bytes()).unwrap();
            }
            w.finish().unwrap();
        }
        cursor.into_inner()
    }

    const GOOD_MANIFEST: &str =
        r#"{"id":"demo","name":"示例","version":"0.1.0","main":"main.js","permissions":["local-api"]}"#;

    #[test]
    fn manifest_validation() {
        assert!(parse_manifest(GOOD_MANIFEST).is_ok());
        assert!(parse_manifest(r#"{"id":"Bad_Id","name":"x","version":"1"}"#).is_err());
        assert!(parse_manifest(r#"{"id":"ok","name":"","version":"1"}"#).is_err());
        assert!(parse_manifest(r#"{"id":"ok","name":"x","version":""}"#).is_err());
        assert!(parse_manifest(r#"{"id":"ok","name":"x","version":"1","main":"../evil.js"}"#).is_err());
        assert!(parse_manifest(r#"{"id":"ok","name":"x","version":"1","main":"a/b.js"}"#).is_err());
    }

    #[test]
    fn inspect_good_zip() {
        let zip = build_zip(&[("manifest.json", GOOD_MANIFEST), ("main.js", "// demo")]);
        let parsed = inspect_zip(&zip).unwrap();
        assert_eq!(parsed.meta.id, "demo");
        assert_eq!(parsed.main_source, "// demo");
    }

    #[test]
    fn inspect_rejects_bad_zips() {
        assert!(inspect_zip(b"not a zip").is_err());
        assert!(inspect_zip(&build_zip(&[("main.js", "//x")])).is_err(), "缺 manifest");
        assert!(
            inspect_zip(&build_zip(&[("manifest.json", GOOD_MANIFEST)])).is_err(),
            "缺入口文件"
        );
    }

    #[test]
    fn inspect_rejects_traversal_and_subdir() {
        let zip = build_zip(&[
            ("manifest.json", GOOD_MANIFEST),
            ("../evil.js", "//x"),
        ]);
        assert!(inspect_zip(&zip).is_err(), "zip-slip 条目");
        let zip = build_zip(&[
            ("manifest.json", GOOD_MANIFEST),
            ("sub/main.js", "//x"),
        ]);
        assert!(inspect_zip(&zip).is_err(), "子目录条目");
    }

    #[test]
    fn install_toggle_uninstall_roundtrip() {
        let dir = std::env::temp_dir().join(format!("annota-plugins-{}", uuid::Uuid::new_v4()));
        let state = PluginsState::load(dir.clone());
        let zip = build_zip(&[("manifest.json", GOOD_MANIFEST), ("main.js", "// demo")]);
        state.install(&zip, "demo-0.1.0.zip").unwrap();
        assert_eq!(state.injection_scripts(), vec!["// demo".to_string()]);
        let list = state.list_json();
        assert!(list.iter().any(|v| v["id"] == "demo" && v["builtin"] == false));

        // 覆盖升级保留 enabled
        state.toggle("demo", false).unwrap();
        assert!(state.injection_scripts().is_empty());
        state.install(&zip, "demo-0.1.1.zip").unwrap();
        assert!(state.injection_scripts().is_empty(), "升级后 enabled 应保留");

        state.toggle("demo", true).unwrap();
        assert_eq!(state.injection_scripts().len(), 1);
        state.uninstall("demo").unwrap();
        assert!(state.injection_scripts().is_empty());
        assert!(!dir.join("demo").exists());

        // 内置 id 拒装
        let builtin = build_zip(&[
            ("manifest.json", r#"{"id":"anki-export","name":"x","version":"1"}"#),
            ("main.js", "//x"),
        ]);
        assert!(state.install(&builtin, "x.zip").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_plugin_listed_not_injected() {
        let dir = std::env::temp_dir().join(format!("annota-plugins-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("oops")).unwrap();
        std::fs::write(dir.join("oops/manifest.json"), "not json").unwrap();
        let state = PluginsState::load(dir.clone());
        assert!(state.injection_scripts().is_empty());
        let list = state.list_json();
        let oops = list.iter().find(|v| v["id"] == "oops").expect("损坏插件应列出");
        assert_eq!(oops["broken"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reserved_dirs_skipped_and_from_sanitized() {
        let dir = std::env::temp_dir().join(format!("annota-plugins-{}", uuid::Uuid::new_v4()));
        // 模拟手工塞入内置 id 目录：不得被加载/影子注入
        std::fs::create_dir_all(dir.join("anki-export")).unwrap();
        std::fs::write(
            dir.join("anki-export/manifest.json"),
            r#"{"id":"anki-export","name":"冒充","version":"1"}"#,
        )
        .unwrap();
        std::fs::write(dir.join("anki-export/main.js"), "// shadow").unwrap();
        let state = PluginsState::load(dir.clone());
        assert!(state.injection_scripts().is_empty(), "保留 id 目录不应注入");
        let anki_entries = state
            .list_json()
            .iter()
            .filter(|v| v["id"] == "anki-export")
            .count();
        assert_eq!(anki_entries, 1, "列表里内置条目只应有一条（无影子副本）");

        // from 净化：控制字符剔除、超长截断
        let zip = build_zip(&[("manifest.json", GOOD_MANIFEST), ("main.js", "// demo")]);
        let long = format!("bad\u{0}\u{7}{}", "x".repeat(200));
        state.install(&zip, &long).unwrap();
        let demo = state
            .list_json()
            .iter()
            .find(|v| v["id"] == "demo")
            .cloned()
            .unwrap();
        let from = demo["from"].as_str().unwrap();
        assert!(!from.chars().any(|c| c.is_control()), "from 不应含控制字符");
        assert!(from.chars().count() <= 120, "from 应限长");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn real_ielts_package_if_present() {
        // 真机冒烟：插件仓打出来的真实 zip 能通过全部校验并可安装（本机无插件仓则跳过）。
        let zip_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../annota-plugins/plugins/ielts-0.1.0.zip");
        if !zip_path.exists() {
            eprintln!("skip: {} not found", zip_path.display());
            return;
        }
        let bytes = std::fs::read(&zip_path).unwrap();
        let parsed = inspect_zip(&bytes).expect("真实 ielts 包应通过校验");
        assert_eq!(parsed.meta.id, "ielts");
        assert!(parsed.main_source.contains("__VA_PLUGIN_DEFS__"));
        // ielts 不是内置（已外移），应可正常安装与注入
        let dir = std::env::temp_dir().join(format!("annota-plugins-{}", uuid::Uuid::new_v4()));
        let state = PluginsState::load(dir.clone());
        state.install(&bytes, "ielts-0.1.0.zip").expect("真实 ielts 包应可安装");
        assert_eq!(state.injection_scripts().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn route_install_flow_requires_token() {
        use axum::body::Body;
        use axum::http::{Request, StatusCode};
        use http_body_util::BodyExt;
        use tower::ServiceExt;

        let appdir = std::env::temp_dir().join(format!("annota-plugins-app-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(appdir.join("exports")).unwrap();
        let state = crate::sync_server::AppState::new(
            appdir.clone(),
            appdir.clone(),
            appdir.join("notes"),
            appdir.join("settings.json"),
            appdir.join("exports"),
            crate::store::Db::open_in_memory().unwrap(),
            std::sync::Arc::new(PluginsState::load(appdir.join("plugins"))),
        );
        let app = crate::sync_server::build_app(state.clone());

        let get = |uri: &str| {
            Request::builder()
                .method("GET")
                .uri(uri)
                .header("host", "127.0.0.1:8793")
                .body(Body::empty())
                .unwrap()
        };
        let zip = build_zip(&[("manifest.json", GOOD_MANIFEST), ("main.js", "// demo")]);
        let post_zip = |uri: &str, token: Option<&str>| {
            let mut b = Request::builder()
                .method("POST")
                .uri(uri)
                .header("host", "127.0.0.1:8793")
                .header("content-type", "application/octet-stream");
            if let Some(t) = token {
                b = b.header("x-annota-token", t);
            }
            b.body(Body::from(zip.clone())).unwrap()
        };
        async fn to_json(body: axum::body::Body) -> Value {
            let bytes = body.collect().await.unwrap().to_bytes();
            serde_json::from_slice(&bytes).unwrap()
        }

        // 列表（含内置 + token 下发）
        let resp = app.clone().oneshot(get("/api/plugins")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = to_json(resp.into_body()).await;
        let token = v["token"].as_str().unwrap().to_string();
        assert!(v["plugins"].as_array().unwrap().iter().any(|p| p["id"] == "anki-export" && p["builtin"] == true));

        // 无 token 拒装
        let resp = app.clone().oneshot(post_zip("/api/plugins/install", None)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // dry-run 预览（不落盘）
        let resp = app
            .clone()
            .oneshot(post_zip("/api/plugins/install?dry_run=1", Some(&token)))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = to_json(resp.into_body()).await;
        assert_eq!(v["preview"]["id"], "demo");
        assert!(!appdir.join("plugins/demo").exists(), "dry-run 不落盘");

        // 正式安装 + 列表可见 + 注入快照
        let resp = app
            .clone()
            .oneshot(post_zip("/api/plugins/install?name=demo.zip", Some(&token)))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(state.plugins().injection_scripts(), vec!["// demo".to_string()]);
        let resp = app.clone().oneshot(get("/api/plugins")).await.unwrap();
        let v = to_json(resp.into_body()).await;
        let demo = v["plugins"].as_array().unwrap().iter().find(|p| p["id"] == "demo").unwrap().clone();
        assert_eq!(demo["enabled"], true);
        assert_eq!(demo["from"], "demo.zip");

        // toggle 关闭 → 不注入
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/plugins/demo/toggle")
                    .header("host", "127.0.0.1:8793")
                    .header("x-annota-token", token.as_str())
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"enabled":false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(state.plugins().injection_scripts().is_empty());

        // 内置 id 拒装
        let builtin_zip = build_zip(&[
            ("manifest.json", r#"{"id":"anki-export","name":"x","version":"1"}"#),
            ("main.js", "//x"),
        ]);
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/plugins/install")
                    .header("host", "127.0.0.1:8793")
                    .header("x-annota-token", token.as_str())
                    .body(Body::from(builtin_zip))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);

        // 卸载
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/plugins/demo")
                    .header("host", "127.0.0.1:8793")
                    .header("x-annota-token", token.as_str())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(state.plugins().injection_scripts().is_empty());
        assert!(!appdir.join("plugins/demo").exists());

        let _ = std::fs::remove_dir_all(&appdir);
    }
}
