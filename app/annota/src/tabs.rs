/* video-annotate · tabs（标签页管理，M3）
 * 多 child webview 单窗口叠放：每个 tab 一个 webview，激活 show+focus、其余 hide。
 * 所有「当前页」操作（navigate/browser_action/run_tool）经 TabManager::active_webview 寻址。
 *
 * 约定：
 * - tab webview 的 label 即 Tab.id；首个 tab 用 "browser"（兼容既有 MCP/工具），其后 "tab-<n>"。
 * - TabManager 存于 tauri::State(Mutex<TabManager>)。
 */
use serde_json::json;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Webview, WebviewUrl};
use tauri::webview::{DownloadEvent, WebviewBuilder};

use crate::store::DbState;

pub const FIRST_TAB_ID: &str = "browser";

pub struct Tab {
    pub id: String,
}

pub struct TabManager {
    pub tabs: Vec<Tab>,
    pub active: usize,
    pub seq: u32,   // 用于生成 tab-<n>
}

impl TabManager {
    pub fn new() -> Self {
        TabManager { tabs: Vec::new(), active: 0, seq: 1 }
    }

    pub fn active_id(&self) -> Option<String> {
        self.tabs.get(self.active).map(|t| t.id.clone())
    }

    pub fn index_of(&self, id: &str) -> Option<usize> {
        self.tabs.iter().position(|t| t.id == id)
    }
}

// 全局状态：由 main.rs 用 .manage(Mutex::new(TabManager::new())) 注入。
pub type TabState = Mutex<TabManager>;

/// 取激活 tab 的 webview（所有「当前页」操作的唯一入口）。
pub fn active_webview(app: &AppHandle) -> Result<Webview, String> {
    let state = app.state::<TabState>();
    let id = state
        .lock()
        .map_err(|_| "标签状态锁中毒".to_string())?
        .active_id()
        .ok_or_else(|| "没有活动标签页".to_string())?;
    app.get_webview(&id)
        .ok_or_else(|| format!("活动标签 webview 不存在（{id}）"))
}

/// 新建一个 tab webview，加入状态并激活它。`init_script` 为注入脚本（桥 + 标注层）。
/// `position/size` 由调用方按当前窗口布局给出（新 tab 覆盖浏览器区域）。
#[allow(clippy::too_many_arguments)]
pub fn create_tab(
    app: &AppHandle,
    window: &tauri::Window,
    url: String,
    init_scripts: Vec<String>,
    bridge_js: &str,
    annotate_js: &str,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) -> Result<String, String> {
    let (id, _seq) = {
        let state = app.state::<TabState>();
        let mut mgr = state.lock().map_err(|_| "标签状态锁中毒".to_string())?;
        let id = if mgr.tabs.is_empty() {
            FIRST_TAB_ID.to_string()
        } else {
            mgr.seq += 1;
            format!("tab-{}", mgr.seq)
        };
        mgr.tabs.push(Tab { id: id.clone() });
        mgr.active = mgr.tabs.len() - 1;
        let seq = mgr.seq;
        (id, seq)
    };

    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    let app_evt = app.clone();
    let id_for_nav = id.clone();
    let id_for_events = id.clone();
    let mut builder = WebviewBuilder::new(&id, WebviewUrl::External(parsed))
        .initialization_script(bridge_js)
        .initialization_script(annotate_js)
        .auto_resize()
        .on_navigation(move |u| {
            println!("[annota] tab {id_for_nav} navigation: {u}");
            true
        })
        .on_page_load(move |_wv, payload| {
            let url = payload.url().to_string();
            let started = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            // M6：页面加载完成时记一条历史（仅 http(s)）。
            if !started && (url.starts_with("http://") || url.starts_with("https://")) {
                if let Some(st) = app_evt.try_state::<DbState>() {
                    let _ = st.0.add_history(&url, "", Some(id_for_events.as_str()));
                }
            }
            // 供工具栏判断是否回显到 omnibox：该 tab 是否当前激活。
            let is_active = app_evt
                .try_state::<TabState>()
                .map(|st| {
                    st.lock()
                        .map(|m| m.active_id().as_deref() == Some(id_for_events.as_str()))
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            let _ = app_evt.emit("annota://tab-updated", json!({
                "id": id_for_events,
                "url": url,
                "loading": started,
                "active": is_active,
            }));
        })
        // M6：下载钩子 —— 落到 ~/Downloads/Annota/，记入本地库并向工具栏广播。
        .on_download(|wv, event| {
            let app = wv.app_handle();
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let dir = app
                        .path()
                        .download_dir()
                        .unwrap_or_else(|_| std::env::temp_dir())
                        .join("Annota");
                    if let Err(e) = std::fs::create_dir_all(&dir) {
                        eprintln!("[annota] 创建下载目录失败 {dir:?}: {e}");
                    }
                    let filename = filename_from_url(&url);
                    // 目标已存在时自动去重，避免同名 URL 静默覆盖。
                    let target = unique_path(&dir, &filename);
                    *destination = target.clone();
                    let saved_name = target
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| filename.clone());
                    if let Some(st) = app.try_state::<DbState>() {
                        let _ = st
                            .0
                            .add_download(url.as_str(), &saved_name, Some(&target.to_string_lossy()));
                    }
                    let _ = app.emit("annota://download-started", json!({
                        "url": url.as_str(),
                        "filename": saved_name,
                        "path": target.to_string_lossy(),
                    }));
                    true
                }
                DownloadEvent::Finished { url, path, success } => {
                    let size = path
                        .as_ref()
                        .and_then(|p| std::fs::metadata(p).ok())
                        .map(|m| m.len() as i64)
                        .unwrap_or(0);
                    let status = if success { "done" } else { "failed" };
                    let path_str = path.as_ref().map(|p| p.to_string_lossy().to_string());
                    if let Some(st) = app.try_state::<DbState>() {
                        let _ = st.0.finish_download(
                            url.as_str(),
                            path_str.as_deref(),
                            size,
                            status,
                        );
                    }
                    let _ = app.emit("annota://download-finished", json!({
                        "url": url.as_str(),
                        "path": path_str,
                        "success": success,
                        "size": size,
                        "status": status,
                    }));
                    true
                }
                _ => true,
            }
        });
    // 允许调用方追加初始化脚本（目前未用，保留扩展位）
    for s in init_scripts {
        builder = builder.initialization_script(s);
    }

    let new_wv = window
        .add_child(builder, position, size)
        .map_err(|e| e.to_string())?;

    // 与 activate_tab 行为一致：新 tab 置前并获焦点，其余隐藏（否则旧 tab 仍可见/持焦点）。
    let ids: Vec<String> = {
        let state = app.state::<TabState>();
        let mgr = state.lock().map_err(|_| "标签状态锁中毒".to_string())?;
        mgr.tabs.iter().map(|t| t.id.clone()).collect()
    };
    for tid in &ids {
        if tid == &id {
            continue;
        }
        if let Some(wv) = app.get_webview(tid) {
            let _ = wv.hide();
        }
    }
    let _ = new_wv.show();
    let _ = new_wv.set_focus();

    emit_tabs(app);
    Ok(id)
}

/// 切换激活 tab：目标 show+focus，其余 hide；并通知工具栏。
pub fn activate_tab(app: &AppHandle, id: &str) -> Result<(), String> {
    let ids: Vec<String> = {
        let state = app.state::<TabState>();
        let mut mgr = state.lock().map_err(|_| "标签状态锁中毒".to_string())?;
        let idx = mgr.index_of(id).ok_or_else(|| format!("标签不存在：{id}"))?;
        mgr.active = idx;
        mgr.tabs.iter().map(|t| t.id.clone()).collect()
    };
    for tid in &ids {
        if let Some(wv) = app.get_webview(tid) {
            if tid == id {
                let _ = wv.show();
                let _ = wv.set_focus();
            } else {
                let _ = wv.hide();
            }
        }
    }
    emit_tabs(app);
    Ok(())
}

/// 关闭 tab：销毁其 webview，从状态移除；激活相邻 tab。最后一个 tab 不允许关闭。
pub fn close_tab(app: &AppHandle, id: &str) -> Result<(), String> {
    let (next_active, remaining) = {
        let state = app.state::<TabState>();
        let mut mgr = state.lock().map_err(|_| "标签状态锁中毒".to_string())?;
        if mgr.tabs.len() <= 1 {
            return Err("至少保留一个标签页".to_string());
        }
        let idx = mgr.index_of(id).ok_or_else(|| format!("标签不存在：{id}"))?;
        mgr.tabs.remove(idx);
        if mgr.active >= mgr.tabs.len() {
            mgr.active = mgr.tabs.len() - 1;
        } else if idx <= mgr.active && mgr.active > 0 {
            mgr.active -= 1;
        }
        (mgr.active_id(), mgr.tabs.iter().map(|t| t.id.clone()).collect::<Vec<_>>())
    };
    if let Some(wv) = app.get_webview(id) {
        let _ = wv.close();
    }
    for tid in &remaining {
        if let Some(wv) = app.get_webview(tid) {
            if Some(tid.clone()) == next_active {
                let _ = wv.show();
                let _ = wv.set_focus();
            } else {
                let _ = wv.hide();
            }
        }
    }
    emit_tabs(app);
    Ok(())
}

/// 移动 tab 顺序（toolbar 拖拽）。
pub fn move_tab(app: &AppHandle, id: &str, to_index: usize) -> Result<(), String> {
    {
        let state = app.state::<TabState>();
        let mut mgr = state.lock().map_err(|_| "标签状态锁中毒".to_string())?;
        let from = mgr.index_of(id).ok_or_else(|| format!("标签不存在：{id}"))?;
        let to = to_index.min(mgr.tabs.len().saturating_sub(1));
        if from != to {
            let t = mgr.tabs.remove(from);
            mgr.tabs.insert(to, t);
            // 修正激活下标：被移动的正是激活页，或激活页夹在 from..to 之间（删除/插入各引起一次位移）。
            if mgr.active == from {
                mgr.active = to;
            } else if from < mgr.active && mgr.active <= to {
                mgr.active -= 1;
            } else if to <= mgr.active && mgr.active < from {
                mgr.active += 1;
            }
        }
    }
    emit_tabs(app);
    Ok(())
}

/// 向工具栏广播标签列表（全量）。
pub fn emit_tabs(app: &AppHandle) {
    // 先在锁内取 id 列表与激活 id，释放锁后再查询各 webview 的 URL
    // （get_webview().url() 可能派发到 UI 线程，持锁调用有争用/死锁风险）。
    let (ids, active) = {
        let state = app.state::<TabState>();
        let locked = state.lock();
        match locked {
            Ok(mgr) => (
                mgr.tabs.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
                mgr.active_id(),
            ),
            Err(_) => (Vec::new(), None),
        }
    };
    let list: Vec<serde_json::Value> = ids
        .iter()
        .map(|id| {
            let url = app
                .get_webview(id)
                .and_then(|w| w.url().ok())
                .map(|u| u.to_string())
                .unwrap_or_default();
            json!({
                "id": id,
                "url": url,
                "title": "",
                "active": active.as_deref() == Some(id.as_str()),
            })
        })
        .collect();
    let _ = app.emit("annota://tabs-changed", json!({ "tabs": list }));
}

/// 从下载 URL 推导文件名（去查询串、清洗路径非法字符、避开 Windows 保留名）。
fn filename_from_url(u: &url::Url) -> String {
    let last = u
        .path_segments()
        .and_then(|s| s.last())
        .unwrap_or("")
        .to_string();
    let raw = if last.is_empty() { "download" } else { last.as_str() };
    let cleaned: String = raw
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    // 去首尾点/空格/控制符（避免隐藏文件与不可写名）。
    let cleaned = cleaned
        .trim_matches(|c: char| c == '.' || c == ' ' || c.is_control())
        .to_string();
    if cleaned.is_empty() {
        return format!("download-{}", chrono::Utc::now().timestamp());
    }
    // Windows 保留设备名（大小写不敏感，含带扩展名情形）→ 加前缀规避。
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return format!("_{cleaned}");
    }
    cleaned
}

/// 目标已存在时生成不冲突的路径：`name.ext` → `name (1).ext`。
fn unique_path(dir: &std::path::Path, filename: &str) -> std::path::PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match filename.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (filename.to_string(), String::new()),
    };
    for n in 1..10_000 {
        let c = dir.join(format!("{stem} ({n}){ext}"));
        if !c.exists() {
            return c;
        }
    }
    candidate
}
