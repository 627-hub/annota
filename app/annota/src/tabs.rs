/* video-annotate · tabs（标签页管理，M3；会话恢复 M6a）
 * 多 child webview 单窗口叠放：每个 tab 一个 webview，激活 show+focus、其余 hide。
 * 所有「当前页」操作（navigate/browser_action/run_tool）经 TabManager::active_webview 寻址。
 *
 * 约定：
 * - tab webview 的 label 即 Tab.id；首个 tab 用 "browser"（兼容既有 MCP/工具），其后 "tab-<n>"。
 * - TabManager 存于 tauri::State(Mutex<TabManager>)。
 * - M6a 会话恢复：emit_tabs 每次全量快照后标脏，后台线程防抖 400ms 落盘 tabs.json；
 *   启动时 restore_tabs 按快照重建（仅 http/https），失败/无记录则回落到单个工作区 tab。
 */
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Webview, WebviewUrl};
use tauri::webview::{DownloadEvent, WebviewBuilder};

use crate::store::DbState;

pub const FIRST_TAB_ID: &str = "browser";
/// 单次会话最多恢复的 tab 数（与前端 12 tab 上限对齐）。
pub const MAX_RESTORE: usize = 12;

pub struct Tab {
    pub id: String,
    /// P1-a#4：页面标题（由桥接脚本上报；会话恢复时不持久化，加载后重新上报）。
    pub title: String,
    /// P2-fix：当前 URL 缓存（on_navigation/on_page_load 写入，会话恢复时=初始目标）。
    /// snapshot/origin 判定全部读这里——**绝不回调 Webview::url()**：wry 对初始化
    /// 中间态 webview 会 unwrap(None) panic，且 panic 会毒化 tauri runtime 锁 →
    /// 连锁 PoisonError 杀死进程（真实崩溃 ×4，见 2026-10-09 日志）。
    pub url: String,
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
    // 后建的 webview 盖在先建的上面：新 tab 会遮住已打开的浮层（菜单/面板）。
    // 代数 +1，让 overlay 下次打开时重建；这里同时把浮层关掉，避免它悬在旧位置。
    crate::bump_tab_gen();
    let _ = app.get_webview(crate::OVERLAY_ID).map(|w| w.close());
    // OCR-fix：先校验 URL——在任何共享状态变更之前失败即退出，
    // 避免旧实现「先 push 再 parse」失败时留下幽灵 Tab（snapshot 会报、active_webview 会选中）。
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    // 预留 id：只推进 seq、不 push；真正的状态提交放在 webview 构建成功之后。
    // （并发首个 tab 的 id 冲突窗口仅存在于启动瞬间——彼时无页面可触发并发创建，可接受。）
    let id = {
        let state = app.state::<TabState>();
        let mut mgr = state.lock().map_err(|_| "标签状态锁中毒".to_string())?;
        if mgr.tabs.is_empty() {
            FIRST_TAB_ID.to_string()
        } else {
            mgr.seq += 1;
            format!("tab-{}", mgr.seq)
        }
    };
    let app_evt = app.clone();
    let id_for_nav = id.clone();
    let id_for_nav2 = id.clone();
    let id_for_events = id.clone();
    let app_nav = app.clone();
    let mut builder = WebviewBuilder::new(&id, WebviewUrl::External(parsed))
        // UA 修正：WKWebView 默认 UA 不含 Safari/WebKit 版本号，B 站等站点按 UA 判「浏览器版本过低」拒访。
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15")
        .initialization_script(bridge_js)
        .initialization_script(annotate_js)
        // P1-a#4：桥接脚本用它把 document.title 归属到本 tab（emit annota://page-title）
        .initialization_script(&format!("window.__ANNOTA_TAB_ID__='{}';", id))
        .auto_resize()
        // P2-fix：页面内 window.open / target=_blank（如词典外链、UGC 弹窗）原本被默认
        // Deny 掉 → 点击毫无反应；改为拒绝原生新窗、改开一个新标签（仅 http/https）。
        // 去重：WKWebView 对一次点击可能回调两次（navigation-action + new-window），
        // 600ms 内同 URL 只开一个标签（实测有道/欧路各双开一次）。
        .on_new_window({
            let app_popup = app.clone();
            move |url, _features| {
                let scheme = url.scheme();
                if scheme == "http" || scheme == "https" {
                    let target = url.to_string();
                    if popup_dedup(&target) {
                        let app = app_popup.clone();
                        tauri::async_runtime::spawn(async move {
                            // 避开当前页面导航回调的重入窗口（url_scheme_handler 泵内
                            // 同步建 webview 会撞 wry 中间态）
                            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                            let _ = crate::open_tab(app, Some(target));
                        });
                    }
                }
                tauri::webview::NewWindowResponse::Deny
            }
        })
        .on_navigation(move |u| {
            crate::alog!("INFO", "[annota] tab {id_for_nav} navigation: {u}");
            // 更新 url 缓存（snapshot/origin 判定的数据源；回调在事件循环线程、
            // 只做短锁字段写、不发任何 wry 消息——无死锁/毒化风险）
            if let Some(st) = app_nav.try_state::<TabState>() {
                if let Ok(mut mgr) = st.lock() {
                    if let Some(t) = mgr.tabs.iter_mut().find(|t| t.id == id_for_nav2) {
                        t.url = u.to_string();
                    }
                }
            }
            true
        })
        .on_page_load(move |wv, payload| {
            let url = payload.url().to_string();
            let started = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            // 同步 url 缓存（兜底 on_navigation 未覆盖的形态，如首载）
            if let Some(st) = app_evt.try_state::<TabState>() {
                if let Ok(mut mgr) = st.lock() {
                    if let Some(t) = mgr.tabs.iter_mut().find(|t| t.id == id_for_events) {
                        t.url = url.clone();
                    }
                }
            }
            // P1-a#6：页面每完成一次加载就重放全局缩放（reload / 站内跳转后不打回 100%）
            if !started {
                let _ = wv.eval(&crate::page_zoom_script());
            }
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
                        crate::alog!("ERROR", "[annota] 创建下载目录失败 {dir:?}: {e}");
                    }
                    let filename = filename_from_url(&url);
                    // 目标已存在时自动去重，避免同名 URL 静默覆盖。
                    let target = reserve_unique_path(&dir, &filename);   // OCR-fix：create_new 原子占名，防并发下载同名互覆
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

    // webview 构建成功后才提交状态（失败路径不留幽灵条目）
    {
        let state = app.state::<TabState>();
        let mut mgr = state.lock().map_err(|_| "标签状态锁中毒".to_string())?;
        mgr.tabs.push(Tab { id: id.clone(), title: String::new(), url: url.clone() });
        mgr.active = mgr.tabs.len() - 1;
    }

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
// P1-a#7：move_tab 已随 main.rs 的 tab_move 死命令一并移除（前端无拖拽排序；
// 将来接拖拽时再恢复，恢复点见 git 历史 5311043 之前的实现）。

/// 弹窗去重：同一 URL 在 600ms 内只允许开一次标签（返回 true 表示应开）。
fn popup_dedup(url: &str) -> bool {
    static LAST: std::sync::Mutex<(u128, String)> = std::sync::Mutex::new((0, String::new()));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    match LAST.lock() {
        Ok(mut g) => {
            if g.1 == url && now.saturating_sub(g.0) < 600 {
                return false;
            }
            *g = (now, url.to_string());
            true
        }
        Err(_) => true,
    }
}

/// 向工具栏广播标签列表（全量）。
pub fn emit_tabs(app: &AppHandle) {
    let (list, _active) = snapshot(app);
    let _ = app.emit("annota://tabs-changed", json!({ "tabs": list }));
    // M6a：任何 tab 变更都标脏，防抖线程稍后落盘会话。
    mark_session_dirty();
}

/// tab 快照：`(列表, 激活下标)`。取 URL 会派发到 UI 线程，故必须先释放锁再查。
/// tab 快照：`(列表, 激活下标)`。
/// P2-fix：**纯内存读 TabState**——不回调 Webview::url()（wry 中间态 unwrap None →
/// panic 毒化 runtime 锁 → 连锁崩溃 ×4）。url/title 全部来自缓存。
pub fn snapshot(app: &AppHandle) -> (Vec<Value>, Option<usize>) {
    let state = app.state::<TabState>();
    let locked = state.lock();
    let Ok(mgr) = locked else { return (Vec::new(), None) };
    let active_id = mgr.active_id();
    let active = active_id
        .as_deref()
        .and_then(|id| mgr.tabs.iter().position(|t| t.id == id));
    let list: Vec<Value> = mgr
        .tabs
        .iter()
        .map(|t| {
            json!({
                "id": t.id,
                "url": t.url,
                "title": t.title,
                "active": active_id.as_deref() == Some(t.id.as_str()),
            })
        })
        .collect();
    (list, active)
}

/// 当前激活 tab 的 URL（缓存）。供 origin 判定 / agent 上下文 / 词典媒体推导使用。
pub fn active_tab_url(app: &AppHandle) -> String {
    let state = app.state::<TabState>();
    let Ok(mgr) = state.lock() else { return String::new() };
    mgr.active_id()
        .and_then(|id| mgr.tabs.iter().find(|t| t.id == id).map(|t| t.url.clone()))
        .unwrap_or_default()
}

/// 按 label（=tab id）取缓存 URL。
pub fn tab_url_by_label(app: &AppHandle, label: &str) -> Option<String> {
    let state = app.try_state::<TabState>()?;
    let mgr = state.lock().ok()?;
    mgr.tabs.iter().find(|t| t.id == label).map(|t| t.url.clone())
}

/// P1-a#4：写入 tab 标题并广播（由桥接脚本的 annota://page-title 事件驱动）。
pub fn set_tab_title(app: &AppHandle, id: &str, title: &str) {
    let changed = {
        let state = app.state::<TabState>();
        let mut mgr = match state.lock() { Ok(m) => m, Err(_) => return };
        match mgr.tabs.iter_mut().find(|t| t.id == id) {
            Some(t) if t.title != title => {
                t.title = title.to_string();
                true
            }
            _ => false,
        }
    };
    if changed {
        emit_tabs(app);
    }
}

// ---------- M6a · 会话恢复 ----------

/// 会话文件路径（与 store.rs 的 db 路径规则一致：env 优先 → debug 落项目内 → app data dir）。
fn session_path(app: &AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("ANNOTA_SESSION") {
        return PathBuf::from(p);
    }
    if cfg!(debug_assertions) {
        if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
            let manifest = PathBuf::from(manifest);
            if let Some(root) = manifest.parent().and_then(|p| p.parent()) {
                return root.join("app/service/tabs.json");
            }
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("Annota"))
        .join("tabs.json")
}

/// 标脏时间戳（ms，0 = 干净）。emit_tabs 每次调用都会置值。
static SESSION_DIRTY_AT: AtomicI64 = AtomicI64::new(0);
/// 用户主动选择「不恢复上次会话」：内存标志让防抖线程停写，文件里的 disabled 让下次启动也不恢复。
/// OCR-fix：会话文件写入（完整快照 vs disabled 标记）的互斥——防防抖线程在 clear 间隙用快照覆盖标记。
static SESSION_FILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

static SESSION_DISABLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn mark_session_dirty() {
    if SESSION_DISABLED.load(Ordering::Relaxed) {
        return;
    }
    SESSION_DIRTY_AT.store(now_millis(), Ordering::Relaxed);
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把当前 tab 快照写到会话文件（同步、best-effort；失败只记日志）。
fn persist_session(app: &AppHandle) {
    // 与 clear_session 串行化整个「复查+写盘」段（OCR-fix：仅复查仍有竞态窗口）
    let _file_guard = SESSION_FILE_LOCK.lock();
    // 写盘前必须再查一次 DISABLED：用户点「不恢复上次会话」后，防抖线程可能刚好已通过
    // dirty 检查进入这里，若不复查会用完整快照覆盖 disabled 标记，导致下次启动又恢复。
    if SESSION_DISABLED.load(Ordering::Relaxed) {
        return;
    }
    let (list, active) = snapshot(app);
    // 只持久化 id + url；title 每次加载后才有，存了也是陈旧值。
    let tabs: Vec<Value> = list
        .iter()
        .map(|t| {
            json!({
                "id": t.get("id").cloned().unwrap_or(Value::Null),
                "url": t.get("url").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    let payload = json!({ "version": 1, "active": active, "tabs": tabs });

    let path = session_path(app);
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            crate::alog!("ERROR", "[annota] 创建会话目录失败 {parent:?}: {e}");
            return;
        }
    }
    // 先写临时文件再 rename：断电/崩溃时不留半个 JSON（下次启动解析失败会回落单 tab）。
    let tmp = path.with_extension("json.tmp");
    let write = || -> std::io::Result<()> {
        std::fs::write(&tmp, serde_json::to_vec_pretty(&payload).map_err(std::io::Error::other)?)?;
        std::fs::rename(&tmp, &path)
    };
    if let Err(e) = write() {
        crate::alog!("ERROR", "[annota] 写会话文件失败 {path:?}: {e}");
        let _ = std::fs::remove_file(&tmp);
    }
}

/// 启动后台防抖落盘线程：`emit_tabs` 标脏后静默 400ms 再写，连续操作只落一次。
/// 在 setup 里启动一次即可（线程随进程退出）。
pub fn spawn_session_persister(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(400));
        let dirty_at = SESSION_DIRTY_AT.load(Ordering::Relaxed);
        if dirty_at == 0 {
            continue;
        }
        if now_millis().saturating_sub(dirty_at) < 400 {   // OCR-fix：时钟回拨不再永久卡住落盘
            continue; // 距上次变更不足，继续等
        }
        SESSION_DIRTY_AT.store(0, Ordering::Relaxed);
        persist_session(&app);
    });
}

/// 会话文件读取结果。
enum Session {
    /// 有效会话：tab URL 列表（按原顺序）+ 激活下标。
    Restore(Vec<String>, Option<usize>),
    /// 用户此前一次性作废过本次会话：本次跳过恢复，随后清除标记。
    SkipOnce,
    /// 无会话 / 解析失败 / 全部 URL 非法。
    None,
}

/// 读取会话文件。任何异常都视为「无会话」。
fn read_session(app: &AppHandle) -> Session {
    match std::fs::read_to_string(session_path(app)) {
        Ok(raw) => parse_session(&raw),
        Err(_) => Session::None,
    }
}

/// 解析会话 JSON（与文件 IO 分离，便于单测）。
fn parse_session(raw: &str) -> Session {
    let Ok(v) = serde_json::from_str::<Value>(raw) else {
        return Session::None;
    };
    // 用户此前选过「不恢复上次会话」→ 本次跳过，并让标记失效（一次性语义）。
    if v.get("disabled").and_then(Value::as_bool).unwrap_or(false) {
        return Session::SkipOnce;
    }
    let Some(arr) = v.get("tabs").and_then(Value::as_array) else {
        return Session::None;
    };
    let mut urls: Vec<String> = Vec::new();
    // 原始下标 → 过滤后下标。跳过非 http(s) 条目会让下标错位，
    // 必须记录映射再把 active 翻译过去，否则激活的可能是另一个 tab。
    let mut index_map: Vec<usize> = Vec::new();
    for (orig, t) in arr.iter().take(MAX_RESTORE).enumerate() {
        let url = t.get("url").and_then(Value::as_str).unwrap_or("").trim().to_string();
        // 只恢复 http(s)；其余（about:blank / 空 / file:）跳过。
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            continue;
        }
        index_map.push(orig);
        urls.push(url);
    }
    if urls.is_empty() {
        return Session::None;
    }
    let active = v
        .get("active")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .and_then(|orig| index_map.iter().position(|o| *o == orig));
    Session::Restore(urls, active)
}

/// 启动时恢复上次会话。返回恢复的 tab 数（0 = 无会话/全部失效，调用方应回落）。
#[allow(clippy::too_many_arguments)]
pub fn restore_tabs(
    app: &AppHandle,
    window: &tauri::Window,
    bridge_js: &str,
    annotate_js: &str,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) -> Result<usize, String> {
    let (entries, active) = match read_session(app) {
        Session::Restore(entries, active) => (entries, active),
        Session::SkipOnce => {
            // 一次性作废：本次跳过恢复，删掉标记文件，之后恢复常规持久化。
            SESSION_DISABLED.store(false, Ordering::Relaxed);
            let path = session_path(app);
            let _ = std::fs::remove_file(&path);
            crate::alog!("INFO", "[annota] 会话：已按上次请求跳过恢复（此后重新启用）");
            return Ok(0);
        }
        Session::None => return Ok(0),
    };
    let mut restored = 0usize;
    for url in entries {
        // 单个 tab 恢复失败（如 URL 已失效）不阻断其余 tab。
        match create_tab(app, window, url, Vec::new(), bridge_js, annotate_js, position, size) {
            Ok(_) => restored += 1,
            Err(e) => crate::alog!("ERROR", "[annota] 恢复 tab 失败（跳过）：{e}"),
        }
    }
    if restored == 0 {
        return Ok(0);
    }
    // create_tab 会把每个新 tab 都置为激活；最后切回原来激活的那个。
    if let Some(idx) = active {
        let target = {
            let state = app.state::<TabState>();
            let mgr = state.lock().map_err(|_| "标签状态锁中毒".to_string())?;
            mgr.tabs.get(idx.min(mgr.tabs.len().saturating_sub(1))).map(|t| t.id.clone())
        };
        if let Some(id) = target {
            let _ = activate_tab(app, &id);
        }
    }
    crate::alog!("INFO", "[annota] 会话恢复：{restored} 个 tab（来自 {}）", session_path(app).display());
    Ok(restored)
}

/// 一次性作废当前会话（「⋯更多 → 不恢复上次会话」用）。
///
/// 语义是「下次启动干净开场」，不是永久关闭：写入 `disabled` 标记后，本次运行内防抖线程停止落盘；
/// 下次启动 `restore_tabs` 消费掉该标记并清除，此后恢复常规持久化（避免用户被永久卡在「无法恢复」）。
pub fn clear_session(app: &AppHandle) {
    let _file_guard = SESSION_FILE_LOCK.lock();
    SESSION_DIRTY_AT.store(0, Ordering::Relaxed);
    SESSION_DISABLED.store(true, Ordering::Relaxed);
    let path = session_path(app);
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            crate::alog!("ERROR", "[annota] 创建会话目录失败 {parent:?}: {e}");
            return;
        }
    }
    let payload = json!({ "version": 1, "disabled": true });
    let bytes = match serde_json::to_vec_pretty(&payload) {
        Ok(b) => b,
        Err(e) => {
            crate::alog!("ERROR", "[annota] 序列化会话禁用标记失败: {e}");
            return;
        }
    };
    if let Err(e) = std::fs::write(&path, bytes) {
        crate::alog!("ERROR", "[annota] 写会话禁用标记失败 {path:?}: {e}");
    }
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
/// OCR-fix：以 create_new 原子预留下载目标名（exists() 探测+另建存在 TOCTOU，并发同名互覆）。
/// 预留出的空文件由后续下载内容覆写；WKWebView 下载流程接受已存在路径。
fn reserve_unique_path(dir: &std::path::Path, filename: &str) -> std::path::PathBuf {
    let try_create = |name: &str| -> Option<std::path::PathBuf> {
        let p = dir.join(name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(_) => Some(p),
            Err(_) => None,
        }
    };
    if let Some(p) = try_create(filename) {
        return p;
    }
    let (stem, ext) = match filename.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (filename.to_string(), String::new()),
    };
    for n in 1..10_000 {
        if let Some(p) = try_create(&format!("{stem} ({n}){ext}")) {
            return p;
        }
    }
    dir.join(filename)
}

#[cfg(test)]
mod session_tests {
    use super::*;

    #[test]
    fn parses_valid_session_in_order_with_active() {
        let raw = r#"{"version":1,"active":1,"tabs":[
            {"id":"browser","url":"https://a.com/"},
            {"id":"tab-2","url":"http://127.0.0.1:8793/"},
            {"id":"tab-3","url":"https://c.com/x"}
        ]}"#;
        match parse_session(raw) {
            Session::Restore(urls, active) => {
                assert_eq!(urls, vec!["https://a.com/", "http://127.0.0.1:8793/", "https://c.com/x"]);
                assert_eq!(active, Some(1));
            }
            _ => panic!("应解析为 Restore"),
        }
    }

    #[test]
    fn skips_non_http_urls_but_keeps_valid_ones() {
        let raw = r#"{"active":0,"tabs":[
            {"id":"browser","url":"about:blank"},
            {"id":"tab-2","url":"file:///etc/passwd"},
            {"id":"tab-3","url":"https://ok.com/"}
        ]}"#;
        match parse_session(raw) {
            Session::Restore(urls, active) => {
                assert_eq!(urls, vec!["https://ok.com/"], "只保留 http(s)");
                // active=0 原指向 about:blank（被跳过），故无对应过滤后下标 → None。
                // 旧实现「越界回落最后一个」会误得 Some(0) 并激活 ok.com（碰巧对，但不是语义）。
                // None 时 restore_tabs 会激活最后一个 tab，即 ok.com —— 最终表现一致但语义正确。
                assert_eq!(active, None, "active 指向被跳过的条目 → None");
            }
            _ => panic!("应解析为 Restore"),
        }
    }

    #[test]
    fn all_non_http_is_no_session() {
        let raw = r#"{"active":0,"tabs":[{"id":"browser","url":"about:blank"}]}"#;
        assert!(matches!(parse_session(raw), Session::None));
    }

    #[test]
    fn disabled_flag_yields_skip_once() {
        let raw = r#"{"version":1,"disabled":true}"#;
        assert!(matches!(parse_session(raw), Session::SkipOnce));
    }

    #[test]
    fn active_index_out_of_range_is_dropped() {
        let raw = r#"{"active":99,"tabs":[{"id":"browser","url":"https://a.com/"}]}"#;
        match parse_session(raw) {
            Session::Restore(_, active) => assert_eq!(active, None, "越界激活下标应丢弃而非 panic"),
            _ => panic!("应解析为 Restore"),
        }
    }

    #[test]
    fn caps_at_max_restore() {
        let tabs: Vec<String> = (0..(MAX_RESTORE + 5))
            .map(|i| format!(r#"{{"id":"tab-{i}","url":"https://s{i}.com/"}}"#))
            .collect();
        let raw = format!(r#"{{"active":0,"tabs":[{}]}}"#, tabs.join(","));
        match parse_session(&raw) {
            Session::Restore(urls, _) => assert_eq!(urls.len(), MAX_RESTORE),
            _ => panic!("应解析为 Restore"),
        }
    }

    #[test]
    fn active_index_is_translated_when_entries_are_skipped() {
        // 原始列表：0=about:blank(跳过) 1=https 2=file:(跳过) 3=https
        // active=3 必须翻译成过滤后的下标 1，而不是沿用 3（越界）。
        let raw = r#"{"active":3,"tabs":[
            {"id":"tab-0","url":"about:blank"},
            {"id":"tab-1","url":"https://a.com/"},
            {"id":"tab-2","url":"file:///etc/passwd"},
            {"id":"tab-3","url":"https://b.com/"}
        ]}"#;
        match parse_session(raw) {
            Session::Restore(urls, active) => {
                assert_eq!(urls, vec!["https://a.com/", "https://b.com/"]);
                assert_eq!(active, Some(1), "active 应翻译为过滤后下标 1");
            }
            _ => panic!("应解析为 Restore"),
        }
    }

    #[test]
    fn active_pointing_to_skipped_entry_becomes_none() {
        // active 指向一个被跳过的条目 → 无对应下标，不应误指到别的 tab
        let raw = r#"{"active":0,"tabs":[
            {"id":"tab-0","url":"about:blank"},
            {"id":"tab-1","url":"https://a.com/"}
        ]}"#;
        match parse_session(raw) {
            Session::Restore(urls, active) => {
                assert_eq!(urls.len(), 1);
                assert_eq!(active, None, "指向被跳过条目时应为 None");
            }
            _ => panic!("应解析为 Restore"),
        }
    }

    #[test]
    fn malformed_json_is_no_session() {
        assert!(matches!(parse_session("{not json"), Session::None));
        assert!(matches!(parse_session("{}"), Session::None));
        assert!(matches!(parse_session(r#"{"tabs":"notarray"}"#), Session::None));
    }

    #[test]
    fn trims_whitespace_around_url() {
        let raw = r#"{"tabs":[{"id":"browser","url":"  https://a.com/  "}]}"#;
        match parse_session(raw) {
            Session::Restore(urls, _) => assert_eq!(urls, vec!["https://a.com/"]),
            _ => panic!("应解析为 Restore"),
        }
    }
}
