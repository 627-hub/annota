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
use tauri::webview::WebviewBuilder;

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
            let _ = app_evt.emit("annota://tab-updated", json!({
                "id": id_for_events,
                "url": url,
                "loading": matches!(payload.event(), tauri::webview::PageLoadEvent::Started),
            }));
        });
    // 允许调用方追加初始化脚本（目前未用，保留扩展位）
    for s in init_scripts {
        builder = builder.initialization_script(s);
    }

    window
        .add_child(builder, position, size)
        .map_err(|e| e.to_string())?;

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
            if mgr.active == from { mgr.active = to; }
        }
    }
    emit_tabs(app);
    Ok(())
}

/// 向工具栏广播标签列表（全量）。
pub fn emit_tabs(app: &AppHandle) {
    let (list, active) = {
        let state = app.state::<TabState>();
        let result = match state.lock() {
            Ok(mgr) => {
                let list = mgr
                    .tabs
                    .iter()
                    .map(|t| {
                        let (url, title) = app
                            .get_webview(&t.id)
                            .and_then(|w| w.url().ok())
                            .map(|u| (u.to_string(), String::new()))
                            .unwrap_or_default();
                        json!({ "id": t.id, "url": url, "title": title, "active": false })
                    })
                    .collect::<Vec<_>>();
                (list, mgr.active_id())
            }
            Err(_) => (Vec::new(), None),
        };
        result
    };
    let list: Vec<_> = list
        .into_iter()
        .map(|mut t| {
            let is_active = t.get("id").and_then(|v| v.as_str()) == active.as_deref();
            if let Some(obj) = t.as_object_mut() {
                obj.insert("active".into(), json!(is_active));
            }
            t
        })
        .collect();
    let _ = app.emit("annota://tabs-changed", json!({ "tabs": list }));
}
