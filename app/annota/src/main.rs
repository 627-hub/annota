#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use serde_json::{json, Value};
use std::{fs, io::Cursor, path::PathBuf, sync::OnceLock, sync::Mutex};
use tauri::{
  AppHandle, Emitter, Listener, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
};
use tauri::window::WindowBuilder;
use tauri::webview::WebviewBuilder;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_updater::UpdaterExt;

mod sync_server;
mod agent;
mod apkg;
mod tabs;
mod store;
mod logf;
use agent::{agent_cancel, agent_chat, agent_run};
use tabs::{TabManager, TabState};
use store::DbState;

// 启动自动更新检查：延迟后查一次；有新版则 emit 给 toolbar（「更多」菜单出角标），
// 用户确认后由前端调 `install_update` 下载并重启安装。24h 后再查一次。
fn spawn_update_check(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // 启动后 5s 首查，避免与首屏/同步服务抢资源
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        loop {
            let h = handle.clone();
            match h.updater() {
                Ok(updater) => match updater.check().await {
                    Ok(Some(update)) => {
                        println!("[annota] update available: {} -> {}", update.current_version, update.version);
                        let payload = json!({
                            "version": update.version,
                            "currentVersion": update.current_version,
                            "notes": update.body.clone().unwrap_or_default(),
                        });
                        let _ = h.emit("annota://update-available", payload);
                    }
                    Ok(None) => println!("[annota] up to date"),
                    Err(e) => println!("[annota] update check failed: {e}"),
                },
                Err(e) => println!("[annota] updater unavailable: {e}"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(24 * 60 * 60)).await;
        }
    });
}

// 全局 AppHandle，供 MCP tool handler 使用（clipboard 等需要后端状态）
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

// 工具栏高度（逻辑像素）：由工具栏 webview 加载完成后 JS emit 实际高度，Rust 缓存。
// 初始值 96 = 标签条 40 + 导航条 56（书签栏展开时 JS 会 emit 更高值）。
// Rust 标准库无 AtomicF64，用 AtomicU64 存 f64 的 bit pattern。
static TOOLBAR_HEIGHT_BITS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(96.0f64.to_bits());
// P1-a#6：全局页面缩放（body.style.zoom）。切 tab / 页面加载完成后由 Rust 重放，
// 解决「缩放只作用当前 webview、切 tab / reload 后打回 100%」的不一致。
static PAGE_ZOOM_BITS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1.0f64.to_bits());

pub fn page_zoom() -> f64 {
    f64::from_bits(PAGE_ZOOM_BITS.load(std::sync::atomic::Ordering::Relaxed))
}

/// 重放缩放的脚本（切 tab、页面 load 完成后调用）。
pub fn page_zoom_script() -> String {
    format!(
        "(function(){{try{{document.body.style.zoom='{}';}}catch(e){{}}}})()",
        page_zoom()
    )
}

/// P1-b#11：本地库是否已降级为内存模式（文件库+临时库都打不开时）。
static DB_MEMORY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// ---------- P2-S1：高危命令的调用方来源校验（本地页 + 用户信任站点） ----------

/// 壳内页面的 origin（工具栏/浮层/工作区）。
pub(crate) fn is_local_origin(origin: &str) -> bool {
    let o = origin.trim().trim_end_matches('/');
    o.starts_with("app://") || o.starts_with("tauri://")
        || o == "http://tauri.localhost" || o == "https://tauri.localhost"
        || o == "http://127.0.0.1:8793" || o == "http://localhost:8793" || o == "http://[::1]:8793"
}

/// 调用方 webview 当前页面的 origin。
pub(crate) fn caller_origin(w: &tauri::Webview) -> String {
    w.url()
        .ok()
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_default()
}

/// 用户显式信任的站点列表（settings.trustedOrigins）。小文件，按需同步读即可。
pub(crate) fn trusted_origins(app: &AppHandle) -> Vec<String> {
    let path = sync_server::resolve_settings_path(app);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v.get("trustedOrigins").cloned())
        .and_then(|v| v.as_array().cloned())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// 高危命令守卫：调用方必须是壳内页面，或该页面 origin 在用户信任列表中。
pub(crate) fn require_local_or_trusted(
    app: &AppHandle,
    w: &tauri::Webview,
    what: &str,
) -> Result<(), String> {
    let origin = caller_origin(w);
    if origin.is_empty() {
        return Err(format!("{what} 需要可识别的页面来源，已拒绝"));
    }
    if is_local_origin(&origin) {
        return Ok(());
    }
    if trusted_origins(app).iter().any(|t| t == &origin) {
        return Ok(());
    }
    Err(format!(
        "{what} 需要先信任当前站点：请在工具栏菜单点「信任当前站点」或将 {origin} 加入设置里的信任列表"
    ))
}

// P2-S1：把当前活动标签页的 origin 加入信任列表（仅工具栏可调用）。
#[tauri::command]
fn trust_current_site(app: tauri::AppHandle, w: tauri::Webview) -> Result<String, String> {
    let caller = caller_origin(&w);
    if !is_local_origin(&caller) {
        return Err("只能从工具栏信任站点".to_string());
    }
    let target = tabs::active_webview(&app)
        .ok()
        .and_then(|v| v.url().ok())
        .ok_or_else(|| "没有可识别的活动标签页".to_string())?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err("只能信任 http(s) 站点".to_string());
    }
    let origin = target.origin().ascii_serialization();
    let path = sync_server::resolve_settings_path(&app);
    let mut v: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or_else(|| json!({}));
    {
        let obj = v.as_object_mut().ok_or_else(|| "settings 结构异常".to_string())?;
        let arr = obj
            .entry("trustedOrigins")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| "trustedOrigins 结构异常".to_string())?;
        if !arr.iter().any(|x| x.as_str() == Some(origin.as_str())) {
            if arr.len() >= 50 {
                return Err("信任列表已满（50），请先在设置中移除不用的站点".to_string());
            }
            arr.push(json!(origin.clone()));
        }
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, serde_json::to_vec_pretty(&v).unwrap_or_default())
        .map_err(|e| format!("写入设置失败：{e}"))?;
    Ok(origin)
}
// 下拉浮层（菜单 / 历史 / 下载面板）的 overlay webview。
// 它按需创建 → 永远是最后添加的子 webview → 天然盖在所有 tab 之上，
// 因此**不需要增高工具栏、也不需要移动页面**（早期方案增高工具栏会把内容整体下推 420px）。
const OVERLAY_ID: &str = "overlay";
/// 每次新建 tab 自增；overlay 记录自己创建时的值，用于判断是否被后建的 tab 盖住。
static TAB_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static OVERLAY_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// ⋯ 菜单浮层高度（逻辑像素）。菜单项固定，可静态给定。
const PANEL_MENU_H: f64 = 380.0;

fn toolbar_total_height() -> f64 {
    f64::from_bits(TOOLBAR_HEIGHT_BITS.load(std::sync::atomic::Ordering::Relaxed))
}

/// 通知浮层：tab 代数已变（被新 tab 盖住了）。
pub fn bump_tab_gen() {
    TAB_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}
// 本地同步服务地址（va_fetch 只允许它，防 SSRF）
const SYNC_HOSTS: &[&str] = &["127.0.0.1", "localhost", "::1"];
const SYNC_PORT: u16 = 8793;

fn titlebar_inset(window: &tauri::Window, scale: f64) -> u32 {
    let measured = match (window.outer_position(), window.inner_position()) {
        (Ok(outer), Ok(inner)) => inner.y.saturating_sub(outer.y).max(0) as u32,
        _ => 0,
    };
    #[cfg(target_os = "macos")]
    {
        if measured == 0 { (32.0 * scale) as u32 } else { measured }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = scale;
        measured
    }
}

// ---------- 桥接脚本：注入 window.__ANNOTA__ + vaCapture/vaCopy/vaFetch ----------
const BRIDGE_JS: &str = r#"
(function () {
  function invoke(cmd, args) {
    var t = window.__TAURI_INTERNALS__ || window.__TAURI__;
    if (!t || !t.invoke) throw new Error('Tauri invoke API not available');
    return t.invoke(cmd, args);
  }
  function emit(name, payload) {
    var t = window.__TAURI_INTERNALS__ || window.__TAURI__;
    if (t && t.event && t.event.emit) t.event.emit(name, payload);
  }

  window.__ANNOTA__ = {
    captureFrame: function () { return invoke('capture_frame'); },
    navigate: function (url) { return invoke('navigate_browser', { url: url }); },
    copyToClipboard: function (opts) { return invoke('write_clipboard', opts || {}); },
    agentRun: function (messages) { return invoke('agent_run', { messages: messages || [] }); },
    agentConfirm: function (confirmId) { return invoke('agent_chat', { confirmId: confirmId }); },
    agentCancel: function (confirmId) { return invoke('agent_cancel', { confirmId: confirmId }); }
  };

  // 与 src/core.js 的「自建浏览器壳」约定对齐
  window.vaCapture = async function (rect) {
    const res = await window.__ANNOTA__.captureFrame();
    if (!res || !res.base64) return null;
    return 'data:image/png;base64,' + res.base64;
  };
  window.vaCopy = async function (payload) {
    payload = payload || {};
    let text = payload.text || '';
    let html = payload.html;
    // 豆包等客户端粘贴时，把图内嵌到 HTML 里可一次性携带图文
    if (!html && payload.dataUrl && payload.dataUrl.indexOf(',') >= 0) {
      const b64 = payload.dataUrl.split(',')[1];
      html = '<p>' + text.replace(/</g, '&lt;') + '</p>'
           + '<p><img src="data:image/png;base64,' + b64 + '"></p>';
    }
    const res = await window.__ANNOTA__.copyToClipboard({ text, html });
    return !!(res && res.ok);
  };
  window.vaFetch = function (method, url, body) {
    return invoke('va_fetch', { method: method || 'GET', url: url, body: body });
  };

  // P1-a#4：轮询上报页面标题（SPA / 延迟改标题也能跟上），归属到本 tab。
  (function () {
    var last = null;
    function report() {
      try {
        var tid = window.__ANNOTA_TAB_ID__ || '';
        if (!tid) return;
        var t = document.title || '';
        if (t !== last) { last = t; emit('annota://page-title', { id: tid, title: t, url: location.href }); }
      } catch (e) {}
    }
    setInterval(function () { report(); }, 1200);
    document.addEventListener('DOMContentLoaded', report);
  })();

  emit('annota-bridge-ready', {});
})();
"#;

// 注入已有的浏览器壳变体（geometry / adapter / core + browser-shell 接缝）
const ANNOTATE_JS: &str = include_str!("../../../dist/annotate.browser.js");

// ---------- 截图辅助：用 xcap 直接捕获当前 Annota 窗口 ----------
fn capture_annota_window() -> Result<(u32, u32, Vec<u8>), String> {
    let windows = xcap::Window::all().map_err(|e| e.to_string())?;
    let win = windows
        .iter()
        .find(|w| {
            w.app_name().as_deref().unwrap_or("").eq_ignore_ascii_case("Annota")
                || w.title().as_deref().unwrap_or("").contains("Annota")
        })
        .ok_or_else(|| "未找到 Annota 窗口".to_string())?;

    let img = win.capture_image().map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    img.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok((img.width(), img.height(), buf))
}

// ---------- 剪贴板辅助：写 image / text / html ----------
fn do_write_clipboard(
    app: &AppHandle,
    image: Option<String>,
    text: Option<String>,
    html: Option<String>,
) -> Result<serde_json::Value, String> {
    let had_image = image.is_some();
    let had_text = text.is_some();
    let had_html = html.is_some();
    let cb = app.clipboard();

    // arboard 每次 write_* 会清空剪贴板，因此只能写一次。
    // 优先 HTML（可内嵌图片+纯文本 fallback），其次 image，最后 text。
    if let Some(html) = html {
        cb.write_html(html, text)
            .map_err(|e| format!("write_html: {e}"))?;
    } else if let Some(img_b64) = image {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(img_b64.trim())
            .map_err(|e| format!("base64 decode: {e}"))?;
        let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
        let rgba = img.to_rgba8();
        let tauri_img =
            tauri::image::Image::new_owned(rgba.into_raw(), img.width(), img.height());
        cb.write_image(&tauri_img)
            .map_err(|e| format!("write_image: {e}"))?;
    } else if let Some(text) = text {
        cb.write_text(text)
            .map_err(|e| format!("write_text: {e}"))?;
    }

    Ok(json!({
        "ok": true,
        "written": { "image": had_image, "text": had_text, "html": had_html }
    }))
}

// ---------- Tauri 命令 ----------
#[tauri::command]
async fn capture_frame(app: tauri::AppHandle, w: tauri::Webview) -> Result<serde_json::Value, String> {
    require_local_or_trusted(&app, &w, "截图")?;
    let windows = tauri_plugin_screenshots::get_screenshotable_windows()
        .await
        .map_err(|e| e.to_string())?;

    let annota_window = windows
        .into_iter()
        .find(|w| {
            w.app_name.eq_ignore_ascii_case("Annota")
                || w.title.contains("Annota")
                || w.name.contains("Annota")
        })
        .ok_or_else(|| "未找到 Annota 窗口".to_string())?;

    let path: PathBuf = tauri_plugin_screenshots::get_window_screenshot(app, annota_window.id)
        .await
        .map_err(|e| e.to_string())?;

    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    #[cfg(debug_assertions)]
    {
        let debug_path = std::env::temp_dir().join("annota_capture_test.png");
        let _ = fs::write(&debug_path, &bytes);
    }
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    Ok(json!({
        "format": "png",
        "width": img.width(),
        "height": img.height(),
        "bytes": bytes.len(),
        "path": path.to_string_lossy(),
        "base64": b64,
    }))
}

#[tauri::command]
async fn write_clipboard(
    app: tauri::AppHandle,
    w: tauri::Webview,
    image: Option<String>,
    text: Option<String>,
    html: Option<String>,
) -> Result<serde_json::Value, String> {
    require_local_or_trusted(&app, &w, "写剪贴板")?;
    do_write_clipboard(&app, image, text, html)
}

#[tauri::command]
fn bridge_probe_reply(keys: Vec<String>) {
    println!("[annota] bridge probe keys: {keys:?}");
}

fn resolve_nav_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("URL 为空".to_string());
    }
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return Ok(raw.to_string());
    }
    if raw.starts_with("dev/") || raw.starts_with("/dev/") {
        let path = raw.trim_start_matches('/');
        return Ok(format!("http://127.0.0.1:{}/{path}", SYNC_PORT));
    }
    // 含点且无空格 → 视为域名（支持 youtube.com/watch?v=... 等省略写法）
    if raw.contains('.') && !raw.contains(' ') && !raw.contains('/') {
        return Ok(format!("https://{raw}"));
    }
    // 含路径的 URL（如 bilibili.com/video/BV...）
    if raw.contains('/') && !raw.contains(' ') && raw.split('/').next().map(|s| s.contains('.')).unwrap_or(false) {
        return Ok(format!("https://{raw}"));
    }
    // 其余 → 搜索引擎回落
    let engine = std::env::var("ANNOTA_SEARCH_ENGINE")
        .unwrap_or_else(|_| "https://www.bing.com/search?q=".to_string());
    Ok(format!("{}{}", engine, urlencoding::encode(raw)))
}

#[tauri::command]
async fn navigate_browser(app: tauri::AppHandle, w: tauri::Webview, url: String) -> Result<(), String> {
    require_local_or_trusted(&app, &w, "导航")?;
    let target = resolve_nav_url(&url)?;
    let parsed = url::Url::parse(&target).map_err(|e| e.to_string())?;
    let webview = tabs::active_webview(&app)?;
    webview.navigate(parsed).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn browser_action(app: tauri::AppHandle, w: tauri::Webview, action: String) -> Result<(), String> {
    require_local_or_trusted(&app, &w, "浏览器控制")?;
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err("不支持的浏览器操作".to_string()),
    };
    let webview = tabs::active_webview(&app)?;
    webview.eval(script).map_err(|e| e.to_string())
}

// 工具栏 → 浏览器 webview 的浏览器壳：切换「观看 ↔ 编辑」态（M4）。
// 注入的 browser-shell.js 暴露 window.VA_BROWSER_SHELL.setMode；未注入时静默无操作。
#[tauri::command]
fn set_shell_mode(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    let m = if mode == "edit" { "edit" } else { "view" };
    let webview = tabs::active_webview(&app)?;
    let script = format!(
        "(function(){{try{{var s=window.VA_BROWSER_SHELL;if(s&&s.setMode)s.setMode('{m}');}}catch(e){{}}}})()"
    );
    webview.eval(script).map_err(|e| e.to_string())
}

/// 归一化浮层种类：只认三种，其余按菜单处理。
fn normalize_overlay_kind(kind: &str) -> &str {
    match kind {
        "menu" => "menu",
        "history" => "history",
        "downloads" => "downloads",
        _ => "menu",
    }
}

fn wv_set_geometry(
    w: &tauri::Webview,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
) -> Result<(), String> {
    w.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    w.set_size(PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

// ---------- 下拉浮层：独立 overlay webview（M7 重做） ----------
// 早期实现用 set_toolbar_expanded 把工具栏 webview 增高 420px，导致页面整体下移（用户报「页面被瞬间下移」）。
// 现改为：浮层是独立 child webview，按需创建 → 永远最后添加 → 盖在所有 tab 之上；
// 工具栏高度与页面布局完全不变。
fn overlay_geometry(app: &AppHandle, kind: &str) -> Result<(u32, u32, i32, i32), String> {
    let window = app.get_window("main").ok_or_else(|| "主窗口不存在".to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let sf = window.scale_factor().map_err(|e| e.to_string())?;
    let top = titlebar_inset(&window, sf) as i32;
    let bar_h = (toolbar_total_height() * sf) as i32;
    let content_h = size.height as i32 - top - bar_h;
    match kind {
        // ⋯ 菜单：锚在导航条右侧「更多」按钮下方，宽度按内容
        "menu" => {
            let w = (240.0 * sf) as u32;
            let h = (PANEL_MENU_H * sf) as u32;
            let x = size.width as i32 - (240.0 * sf) as i32 - (12.0 * sf) as i32;
            Ok((w, h.min(content_h.max(1) as u32), x.max(0), top + bar_h))
        }
        // 历史 / 下载：整行面板，从工具栏下方铺满剩余高度
        _ => Ok((size.width, content_h.max(1) as u32, 0, top + bar_h)),
    }
}

/// 打开浮层。`kind` = `menu` | `history` | `downloads`。
/// 打开浮层。`kind` = `menu` | `history` | `downloads`。
#[tauri::command]
fn overlay_open(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    let kind = normalize_overlay_kind(&kind);
    // 已有 overlay：若没有更新的 tab 盖住它就复用，否则销毁重建
    // （后建的 webview 在上层，复用会藏在页面下面看不见）。
    if let Some(wv) = app.get_webview(OVERLAY_ID) {
        let gen = TAB_GEN.load(std::sync::atomic::Ordering::Relaxed);
        if OVERLAY_GEN.load(std::sync::atomic::Ordering::Relaxed) == gen {
            // 变体不同则重新摆位：menu 是 240×380 浮层，history/downloads 是整行面板，
            // 直接换内容会留下错误的尺寸/位置（面板被压成 240 宽或浮层铺满整行）。
            let (w, h, x, y) = overlay_geometry(&app, kind)?;
            let _ = wv_set_geometry(&wv, w, h, x, y);
            let js = format!(
                "(function(){{try{{window.__vaOverlayShow && window.__vaOverlayShow({});}}catch(e){{}}}})()",
                serde_json::to_string(kind).unwrap_or_else(|_| "\"menu\"".into())
            );
            let _ = wv.eval(&js);
            let _ = wv.show();
            let _ = wv.set_focus();
            return Ok(());
        }
        let _ = wv.close();
    }
    let (w, h, x, y) = overlay_geometry(&app, kind)?;
    let url = WebviewUrl::App("overlay.html".into());
    let init = format!(
        "window.__VA_OVERLAY_KIND__ = {};",
        serde_json::to_string(kind).unwrap_or_else(|_| "\"menu\"".into())
    );
    let window = app.get_window("main").ok_or_else(|| "主窗口不存在".to_string())?;
    // 注意：不要用 on_navigation(|_| false) —— 它会连 webview 自身的初始加载一起拦掉，
    // 结果是一个 URL 为空的空白透明 webview（表现为「点了没反应/看不见」）。
    // 浮层不需要跳转能力：它是本地页面，无任何 <a href>；真要防外跳，用 tauri.conf 的
    // capability + CSP 收口，或在页面里 preventDefault。
    let builder = WebviewBuilder::new(OVERLAY_ID, url)
        .initialization_script(BRIDGE_JS)
        .initialization_script(&init)
        .transparent(true);
    window
        .add_child(builder, PhysicalPosition::new(x, y), PhysicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    // 记录创建时的 tab 代数：之后若又新建了 tab，它会盖在 overlay 之上（后加者在上），
    // 下次打开时据此决定是否重建。
    OVERLAY_GEN.store(TAB_GEN.load(std::sync::atomic::Ordering::Relaxed), std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn overlay_close(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview(OVERLAY_ID) {
        let _ = w.close();
    }
    // 焦点还给页面，否则键盘事件仍落在已关闭的浮层上。
    if let Ok(page) = tabs::active_webview(&app) {
        let _ = page.set_focus();
    }
    Ok(())
}

// 浮层里的「诊断信息」需要真实 tab 状态，但 overlay 是独立 webview，收不到 tabs-changed。
#[tauri::command]
fn tabs_snapshot(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let (ids, active_id) = {
        let state = app.state::<TabState>();
        let mgr = state.lock().map_err(|_| "标签状态锁中毒".to_string())?;
        (
            mgr.tabs.iter().map(|t| t.id.clone()).collect::<Vec<_>>(),
            mgr.active_id(),
        )
    };
    let tabs: Vec<Value> = ids
        .iter()
        .map(|id| {
            let url = app
                .get_webview(id)
                .and_then(|w| w.url().ok())
                .map(|u| u.to_string())
                .unwrap_or_default();
            let is_active = active_id.as_deref() == Some(id.as_str());
            json!({ "id": id, "url": url, "active": is_active })
        })
        .collect();
    Ok(json!({ "ok": true, "tabs": tabs }))
}

// 开发者工具（M6d）：打开当前活动标签页的 devtools（WKWebView 需 Safari 16.4+）。
#[tauri::command]
fn open_devtools(app: tauri::AppHandle, w: tauri::Webview) -> Result<(), String> {
    require_local_or_trusted(&app, &w, "开发者工具")?;
    let webview = tabs::active_webview(&app)?;
    webview.open_devtools();
    Ok(())
}

// 工具栏高度上报（M7）：工具栏 webview 加载完成后 emit 实际高度，Rust 缓存并重新布局。
#[tauri::command]
fn set_toolbar_height(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    if height > 0.0 && height < 500.0 {
        TOOLBAR_HEIGHT_BITS.store(height.to_bits(), std::sync::atomic::Ordering::Relaxed);
        apply_layout(&app)?;
    }
    Ok(())
}

// 页面内查找（M7）：在当前活动标签页执行查找，并统计总匹配数 emit 给工具栏（P1-a#5）。
#[tauri::command]
fn find_in_page(app: tauri::AppHandle, w: tauri::Webview, text: String, forward: bool) -> Result<(), String> {
    require_local_or_trusted(&app, &w, "页内查找")?;
    let webview = tabs::active_webview(&app)?;
    // window.find(text, caseSensitive, backwards, wrapAround, wholeWord, searchInFrames, showDialog)
    // 注意方向是第 3 位 backwards（要取反），且 showDialog 必须为 false ——
    // 否则点「上一个」会弹出 WebKit 原生查找对话框。
    // 窗口查找只负责「跳到下一个」；总数另用 TreeWalker 精确统计（跨节点的匹配会算作近似值）。
    let script = format!(
        r#"(function(){{
  try{{ window.find({q},false,!{fwd},true,false,false,false); }}catch(e){{}}
  try{{
    var n=0, q={q};
    if(q){{
      var lower=String(q).toLowerCase();
      var root=document.body||document.documentElement;
      var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
      var node;
      while((node=walker.nextNode())){{
        var v=node.nodeValue; if(!v) continue;
        var s=v.toLowerCase(), i=0;
        while((i=s.indexOf(lower,i))!==-1){{ n++; i+=lower.length; }}
      }}
    }}
    var t=window.__TAURI_INTERNALS__||window.__TAURI__;
    if(t&&t.event&&t.event.emit) t.event.emit('annota://find-count',{{count:n,text:q}});
  }}catch(e){{}}
}})();"#,
        q = serde_json::to_string(&text).unwrap_or_else(|_| "\"\"".to_string()),
        fwd = forward
    );
    webview.eval(&script).map_err(|e| e.to_string())
}

// 缩放控制（M7）：记入全局并设置当前活动标签页的页面缩放（P1-a#6）。
#[tauri::command]
fn set_zoom(app: tauri::AppHandle, w: tauri::Webview, factor: f64) -> Result<(), String> {
    require_local_or_trusted(&app, &w, "缩放")?;
    let factor = factor.clamp(0.25, 5.0);
    PAGE_ZOOM_BITS.store(factor.to_bits(), std::sync::atomic::Ordering::Relaxed);
    let webview = tabs::active_webview(&app)?;
    webview.eval(&page_zoom_script()).map_err(|e| e.to_string())
}

// P1-b#9 + P2-S3：本地同步服务状态 + 库降级标记 + 损坏标注包扫描。
#[tauri::command]
fn diag_status(app: tauri::AppHandle) -> serde_json::Value {
    let store = sync_server::resolve_store_path(&app);
    json!({
        "running": sync_server::server_running(),
        "error": sync_server::server_error(),
        "db_memory": DB_MEMORY.load(std::sync::atomic::Ordering::Relaxed),
        "corrupt_packs": sync_server::scan_corrupt_packs(&store),
    })
}

// P1-b#9：重试启动本地同步服务（用户在工具栏点「重试」时调用）。
#[tauri::command]
fn restart_server(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if sync_server::server_running() {
        return Ok(json!({ "running": true }));
    }
    use tauri::Manager;
    let db = app.state::<DbState>().0.clone();
    let store_path = sync_server::resolve_store_path(&app);
    let root_path = sync_server::resolve_project_root();
    let notes_dir = sync_server::resolve_notes_dir(&app);
    let settings_path = sync_server::resolve_settings_path(&app);
    sync_server::clear_server_error();
    tauri::async_runtime::spawn(sync_server::run_server(
        store_path, root_path, notes_dir, settings_path, db,
    ));
    Ok(json!({ "running": false, "retrying": true }))
}

// ---------- 标签页命令（M3） ----------
#[tauri::command]
fn tab_new(app: tauri::AppHandle, w: tauri::Webview, url: Option<String>) -> Result<String, String> {
    require_local_or_trusted(&app, &w, "新建标签")?;
    let window = app.get_window("main").ok_or_else(|| "主窗口不存在".to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let sf = window.scale_factor().map_err(|e| e.to_string())?;
    let top_inset = titlebar_inset(&window, sf);
    let browser_top = top_inset.saturating_add((toolbar_total_height() * sf) as u32);
    let target = match url.as_deref() {
        Some(u) if !u.trim().is_empty() => resolve_nav_url(u)?,
        _ => "http://127.0.0.1:8793/".to_string(),
    };
    tabs::create_tab(
        &app,
        &window,
        target,
        Vec::new(),
        BRIDGE_JS,
        ANNOTATE_JS,
        PhysicalPosition::new(0, browser_top as i32),
        PhysicalSize::new(size.width, size.height.saturating_sub(browser_top)),
    )
}

#[tauri::command]
fn tab_activate(app: tauri::AppHandle, w: tauri::Webview, id: String) -> Result<(), String> {
    require_local_or_trusted(&app, &w, "切换标签")?;
    tabs::activate_tab(&app, &id)?;
    // P1-a#6：切 tab 后把全局缩放重放到新激活的 webview（标签数字与实际一致）
    if let Ok(wv) = tabs::active_webview(&app) {
        let _ = wv.eval(&page_zoom_script());
    }
    let _ = apply_layout(&app);
    Ok(())
}

#[tauri::command]
fn tab_close(app: tauri::AppHandle, w: tauri::Webview, id: String) -> Result<(), String> {
    require_local_or_trusted(&app, &w, "关闭标签")?;
    tabs::close_tab(&app, &id)?;
    let _ = apply_layout(&app);
    Ok(())
}

// M6a：清除会话文件，下次启动不再恢复上次标签页。
#[tauri::command]
fn tab_session_clear(app: tauri::AppHandle, w: tauri::Webview) -> Result<(), String> {
    require_local_or_trusted(&app, &w, "清除会话")?;
    tabs::clear_session(&app);
    Ok(())
}

#[tauri::command]
async fn va_fetch(
    method: String,
    url: String,
    body: Option<Value>,
) -> Result<serde_json::Value, String> {
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("va_fetch 仅支持 http(s)".to_string());
    }
    let host = parsed.host_str().unwrap_or("");
    let port_ok = parsed.port_or_known_default().unwrap_or(0) == SYNC_PORT as u16;
    let host_ok = SYNC_HOSTS.iter().any(|h| host.eq_ignore_ascii_case(h));
    if !host_ok || !port_ok {
        return Err(format!(
            "va_fetch 被限制到 {SYNC_HOSTS:?}:{SYNC_PORT}，拒绝 {url}"
        ));
    }

    let client = reqwest::Client::new();
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("非法 HTTP 方法: {e}"))?;
    let mut req = client.request(method, parsed);
    if let Some(body) = body {
        req = req.json(&body);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let json: Option<Value> = resp.json().await.ok();
    Ok(json!({ "ok": status >= 200 && status < 300, "status": status, "json": json }))
}

// ---------- 布局：工具栏置顶，浏览器占剩余区域 ----------
fn apply_layout(app: &AppHandle) -> Result<(), String> {
    let window = app.get_window("main").ok_or_else(|| "主窗口不存在".to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let sf = window.scale_factor().map_err(|e| e.to_string())?;
    let top_inset = titlebar_inset(&window, sf);
    let toolbar_h = (toolbar_total_height() * sf) as u32;
    let browser_top = top_inset.saturating_add(toolbar_h);

    if let Some(toolbar) = app.get_webview("toolbar") {
        toolbar
            .set_position(PhysicalPosition::new(0, top_inset as i32))
            .map_err(|e| e.to_string())?;
        toolbar
            .set_size(PhysicalSize::new(size.width, toolbar_h))
            .map_err(|e| e.to_string())?;
    }
    // 仅摆激活 tab（隐藏的 tab 无需摆，激活前 activate_tab 会再触发一次布局）
    if let Ok(browser) = tabs::active_webview(app) {
        browser
            .set_position(PhysicalPosition::new(0, browser_top as i32))
            .map_err(|e| e.to_string())?;
        browser
            .set_size(PhysicalSize::new(
                size.width,
                size.height.saturating_sub(browser_top),
            ))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn setup_webviews(window: &tauri::Window, app: &AppHandle) -> Result<(), String> {
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let sf = window.scale_factor().map_err(|e| e.to_string())?;
    let top_inset = titlebar_inset(window, sf);
    let toolbar_h = (toolbar_total_height() * sf) as u32;
    let browser_top = top_inset.saturating_add(toolbar_h);

    // 工具栏 webview：加载本地 index.html（地址栏 + 标签条）
    let toolbar = WebviewBuilder::new("toolbar", WebviewUrl::App("index.html".into()))
        .initialization_script(BRIDGE_JS)
        .auto_resize();
    window
        .add_child(
            toolbar,
            PhysicalPosition::new(0, top_inset as i32),
            PhysicalSize::new(size.width, toolbar_h),
        )
        .map_err(|e| e.to_string())?;

    let pos = PhysicalPosition::new(0, browser_top as i32);
    let vp = PhysicalSize::new(size.width, size.height.saturating_sub(browser_top));

    // M6a 会话恢复：优先按 tabs.json 重建上次会话；无记录/全部失效才回落到单个工作区 tab。
    let restored = tabs::restore_tabs(app, window, BRIDGE_JS, ANNOTATE_JS, pos, vp)?;
    if restored == 0 {
        let start_url = "http://127.0.0.1:8793/".to_string();
        let id = tabs::create_tab(app, window, start_url, Vec::new(), BRIDGE_JS, ANNOTATE_JS, pos, vp)?;
        println!("[annota] first tab created: {id}");
    }

    // M6a：后台防抖落盘会话（emit_tabs 标脏 → 400ms 后写 tabs.json）
    tabs::spawn_session_persister(app.clone());

    Ok(())
}

// ---------- 标注查询辅助（words_at） ----------
// 从当前页 URL 推导 mediaId，与 src/adapter.js 的规则保持一致
fn media_id_from_url(raw: &str) -> String {
    let url = match url::Url::parse(raw) {
        Ok(u) => u,
        Err(_) => return raw.to_string(),
    };
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let path = url.path().to_string();
    let query = |k: &str| -> Option<String> {
        url.query_pairs()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.into_owned())
    };
    let plat = if host == "bilibili.com" || host.ends_with(".bilibili.com") {
        "bilibili"
    } else if host == "douyin.com" || host.ends_with(".douyin.com") {
        "douyin"
    } else if host == "youtube.com" || host.ends_with(".youtube.com") || host == "youtu.be" {
        "youtube"
    } else {
        "generic"
    };
    let after = |prefix: &str| -> Option<String> {
        path.strip_prefix(prefix)
            .map(|rest| rest.split(['/', '?']).next().unwrap_or("").to_string())
            .filter(|s| !s.is_empty())
    };
    match plat {
        "bilibili" => {
            if let Some(v) = after("/video/") {
                return format!("bilibili:{v}");
            }
            if let Some(v) = after("/bangumi/play/") {
                return format!("bilibili:{v}");
            }
            if let Some(v) = after("/cheese/play/") {
                return format!("bilibili:cheese:{v}");
            }
            if let Some(bv) = query("bvid") {
                return format!("bilibili:{bv}");
            }
        }
        "douyin" => {
            if let Some(mid) = query("modal_id") {
                return format!("douyin:{mid}");
            }
            if let Some(v) = after("/video/") {
                return format!("douyin:{v}");
            }
            if let Some(v) = after("/note/") {
                return format!("douyin:{v}");
            }
        }
        "youtube" => {
            if let Some(v) = query("v") {
                return format!("youtube:{v}");
            }
        }
        _ => {}
    }
    format!("{plat}:{}{}", url.origin().ascii_serialization(), path)
}

fn read_store_pack(app: &tauri::AppHandle, key: &str) -> Option<Value> {
    let store = sync_server::resolve_store_path(app);
    let path = store.join(format!("{}.json", sync_server::sanitize_key(key)));
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn store_keys(app: &tauri::AppHandle) -> Vec<String> {
    let store = sync_server::resolve_store_path(app);
    let mut keys = Vec::new();
    if let Ok(entries) = fs::read_dir(&store) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(stem) = name.strip_suffix(".json") {
                keys.push(stem.to_string());
            }
        }
    }
    keys.sort();
    keys
}

// 兜底：按页面 URL 在本地库中找回对应 pack
fn find_pack_key_by_url(app: &tauri::AppHandle, page_url: &str) -> Option<String> {
    for key in store_keys(app) {
        if let Some(pack) = read_store_pack(app, &key) {
            let url = pack
                .get("media")
                .and_then(|m| m.get("url"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if url == page_url {
                return Some(key);
            }
        }
    }
    None
}

// ---------- 工具实现（MCP 与内置 agent 共用） ----------
pub fn run_tool(name: &str, params: &Value) -> Result<String, String> {
    match name {
        "capture_frame" => {
            let (w, h, buf) = capture_annota_window()?;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
            Ok(json!({ "format": "png", "width": w, "height": h, "bytes": buf.len(), "base64": b64 }).to_string())
        }
        "copy_to_clipboard" => {
            let app = APP_HANDLE.get().ok_or("AppHandle 尚未初始化")?;
            let image = params.get("image").and_then(|v| v.as_str()).map(String::from);
            let text = params.get("text").and_then(|v| v.as_str()).map(String::from);
            let html = params.get("html").and_then(|v| v.as_str()).map(String::from);
            Ok(do_write_clipboard(app, image, text, html)?.to_string())
        }
        "navigate" => {
            let app = APP_HANDLE.get().ok_or("AppHandle 尚未初始化")?;
            let raw = params.get("url").and_then(|v| v.as_str()).ok_or("缺少 url 参数")?;
            let target = resolve_nav_url(raw)?;
            let parsed = url::Url::parse(&target).map_err(|e| e.to_string())?;
            let webview = tabs::active_webview(app)?;
            webview.navigate(parsed).map_err(|e| e.to_string())?;
            Ok(format!("navigating to {target}"))
        }
        "open_annotations" => {
            let app = APP_HANDLE.get().ok_or("AppHandle 尚未初始化")?;
            let webview = tabs::active_webview(app)?;
            webview.eval(r#"(function(){const h=document.querySelector('#annota-shadow-host');const b=h&&h.shadowRoot&&h.shadowRoot.querySelector('button[aria-label="列表"]');if(b)b.click()})()"#)
                .map_err(|e| e.to_string())?;
            Ok("标注侧栏已打开".to_string())
        }
        "start_annotation" => {
            let app = APP_HANDLE.get().ok_or("AppHandle 尚未初始化")?;
            let webview = tabs::active_webview(app)?;
            webview.eval(r#"(function(){const h=document.querySelector('#annota-shadow-host');const b=h&&h.shadowRoot&&h.shadowRoot.querySelector('button[aria-label="标注"]');if(b)b.click()})()"#)
                .map_err(|e| e.to_string())?;
            Ok("已请求进入标注模式".to_string())
        }
        "propose_annotation" => {
            let app = APP_HANDLE.get().ok_or("AppHandle 尚未初始化")?;
            let webview = tabs::active_webview(app)?;
            let payload = serde_json::to_string(params).map_err(|e| e.to_string())?;
            let script = format!(
                "(function(p){{const ui=window.__ANNOTA_UI__;const ok=!!(ui&&ui.proposeAnnotation(p));window.__TAURI_INTERNALS__.invoke('bridge_probe_reply',{{keys:['proposal',String(ok)]}})}})({payload})"
            );
            webview.eval(&script).map_err(|e| e.to_string())?;
            Ok("候选标注已送入确认卡；需要用户确认后才会保存".to_string())
        }
        "words_at" => {
            let app = APP_HANDLE.get().ok_or("AppHandle 尚未初始化")?;
            let t = params.get("t").and_then(|v| v.as_f64()).ok_or("缺少 t 参数")?;
            let radius = params.get("radius").and_then(|v| v.as_f64()).unwrap_or(0.5);
            let explicit = params.get("media_id").and_then(|v| v.as_str()).map(String::from);
            let page_url = tabs::active_webview(app)
                .ok()
                .and_then(|w| w.url().ok())
                .map(|u| u.to_string());
            let derived = page_url.as_deref().map(media_id_from_url);

            let mut pack = None;
            let mut resolved = String::new();
            if let Some(id) = explicit.or_else(|| derived.clone()) {
                if let Some(found) = read_store_pack(app, &id) {
                    resolved = id;
                    pack = Some(found);
                }
            }
            if pack.is_none() {
                if let Some(key) = page_url.as_deref().and_then(|u| find_pack_key_by_url(app, u)) {
                    if let Some(found) = read_store_pack(app, &key) {
                        resolved = key;
                        pack = Some(found);
                    }
                }
            }
            let pack = pack.ok_or_else(|| {
                format!(
                    "未找到当前内容的本地标注（media_id={:?}）；本地已有：{}",
                    derived,
                    store_keys(app).join(", ")
                )
            })?;

            let entries = pack.get("entries").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            // 图片/文章无时间维度：忽略 t 窗口，返回全部；视频按 [t-radius, t+dur+radius] 过滤
            let timed = pack
                .get("media")
                .and_then(|m| m.get("type"))
                .and_then(|v| v.as_str())
                .map(|s| s == "video")
                .unwrap_or(true);
            let words: Vec<Value> = entries
                .into_iter()
                .filter(|e| {
                    if !timed {
                        return true;
                    }
                    let start = e.get("t").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let dur = e.get("dur").and_then(|v| v.as_f64()).unwrap_or(1.0);
                    t >= start - radius && t <= start + dur + radius
                })
                .collect();

            Ok(json!({
                "media_id": resolved,
                "page_url": page_url,
                "t": t,
                "radius": radius,
                "count": words.len(),
                "words": words,
            })
            .to_string())
        }
        "probe_bridge" => {
            let app = APP_HANDLE.get().ok_or("AppHandle 尚未初始化")?;
            let webview = tabs::active_webview(app)?;
            webview
                .eval(r#"(function(){ const send=function(keys){try{window.__TAURI_INTERNALS__.invoke('bridge_probe_reply',{keys:keys})}catch(e){}};send(['bridge',typeof window.__ANNOTA__,typeof window.vaFetch]);if(typeof window.vaFetch==='function'){window.vaFetch('GET','http://127.0.0.1:8793/api/health').then(function(r){send(['va_fetch_ok',String(r.status),String(!!(r.json&&r.json.ok))])}).catch(function(e){send(['va_fetch_error',String(e&&e.message||e).slice(0,180)])})}})()"#)
                .map_err(|e| e.to_string())?;
            Ok("probe sent".to_string())
        }
        other => Err(format!("未知工具：{other}")),
    }
}

// ---------- MCP tools ----------
fn make_mcp_tools() -> tauri_plugin_mcp_server::McpBuilder {
    let capture_schema = serde_json::json!({
        "type": "object",
        "properties": {
            "media_id": { "type": "string", "description": "可选的媒体 ID（当前未使用）" }
        }
    });

    let clipboard_schema = serde_json::json!({
        "type": "object",
        "properties": {
            "text": { "type": "string", "description": "纯文本" },
            "html": { "type": "string", "description": "HTML 片段" },
            "image": { "type": "string", "description": "PNG base64（可选）" }
        }
    });

    tauri_plugin_mcp_server::McpBuilder::new()
        .tool(
            "capture_frame",
            "捕获当前 Annota 窗口（webview）的截图，返回 PNG base64 与元数据",
            capture_schema,
            |params: serde_json::Value| -> Result<String, String> { run_tool("capture_frame", &params) },
        )
        .tool(
            "copy_to_clipboard",
            "将图片（PNG base64）、纯文本、HTML 写入系统剪贴板",
            clipboard_schema,
            |params: serde_json::Value| -> Result<String, String> { run_tool("copy_to_clipboard", &params) },
        )
        .tool(
            "navigate",
            "让 Annota 浏览器跳转到指定 URL（agent 操作能力）",
            serde_json::json!({
                "type": "object",
                "properties": { "url": { "type": "string", "description": "目标 URL" } },
                "required": ["url"]
            }),
            |params: serde_json::Value| -> Result<String, String> { run_tool("navigate", &params) },
        )
        .tool(
            "open_annotations",
            "打开当前网页的 Annota 标注侧栏",
            serde_json::json!({"type":"object","properties":{}}),
            |params: serde_json::Value| -> Result<String, String> { run_tool("open_annotations", &params) },
        )
        .tool(
            "start_annotation",
            "在当前视频进入框选标注模式",
            serde_json::json!({"type":"object","properties":{}}),
            |params: serde_json::Value| -> Result<String, String> { run_tool("start_annotation", &params) },
        )
        .tool(
            "propose_annotation",
            "把 AI 候选框与词语送入 Annota 确认卡；只有用户确认保存后才会写入",
            serde_json::json!({
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
            }),
            |params: serde_json::Value| -> Result<String, String> { run_tool("propose_annotation", &params) },
        )
        .tool(
            "words_at",
            "查询某个时间点（秒）出现的标注词条，返回词、释义、时间与画面区域；缺省针对当前页面",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "t": {"type": "number", "description": "时间点（秒）"},
                    "media_id": {"type": "string", "description": "可选；缺省用当前页面对应的标注"},
                    "radius": {"type": "number", "description": "时间容差秒数，默认 0.5"}
                },
                "required": ["t"]
            }),
            |params: serde_json::Value| -> Result<String, String> { run_tool("words_at", &params) },
        )
        .tool(
            "probe_bridge",
            "探测 browser webview 中 window.__ANNOTA__ 是否注入成功",
            serde_json::json!({"type":"object","properties":{}}),
            |params: serde_json::Value| -> Result<String, String> { run_tool("probe_bridge", &params) },
        )
}

// 用户确认后：下载并安装更新，然后重启应用（由工具栏「更多」菜单触发）。
#[tauri::command]
async fn install_update(app: AppHandle, w: tauri::Webview) -> Result<String, String> {
    require_local_or_trusted(&app, &w, "安装更新")?;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "已是最新版本".to_string())?;
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    // 安装完成后重启（tauri-plugin-process 的 relaunch）
    app.restart();
}

/// P1-b#14：debug 测试钩子从 main() 抽离（ANNOTA_AGENT_TEST / ANNOTA_TABS_TEST），
/// 仅 debug 构建编译，产线 main() 不再混测试代码。
#[cfg(debug_assertions)]
fn spawn_debug_hooks(handle: AppHandle) {
    if let Ok(prompt) = std::env::var("ANNOTA_AGENT_TEST") {
        let h = handle.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            let wv = h.get_webview("toolbar").expect("toolbar webview（agent 测试钩子需要）");
            let messages = vec![json!({"role": "user", "content": prompt})];
            match agent_run(h, wv, messages).await {
                Ok(res) => println!("[annota][agent-test] OK {}", res),
                Err(e) => println!("[annota][agent-test] ERR {e}"),
            }
        });
    }
    if std::env::var("ANNOTA_TABS_TEST").is_ok() {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            // P2-S1 后命令带 Webview 守卫；测试钩子以工具栏身份直接调用底层命令。
            let wv = handle
                .get_webview("toolbar")
                .expect("toolbar webview（测试钩子需要）");
            let snap = |h: &AppHandle| {
                let st = h.state::<tabs::TabState>();
                let m = st.lock().unwrap();
                (m.tabs.iter().map(|t| t.id.clone()).collect::<Vec<_>>(), m.active_id())
            };
            println!("[annota][tabs-test] start {:?}", snap(&handle));
            for u in ["https://example.com/", "https://www.bilibili.com/"] {
                match tab_new(handle.clone(), wv.clone(), Some(u.to_string())) {
                    Ok(id) => println!("[annota][tabs-test] created {id} -> {:?}", snap(&handle)),
                    Err(e) => println!("[annota][tabs-test] tab_new ERR {e}"),
                }
            }
            if let Err(e) = tab_activate(handle.clone(), wv.clone(), tabs::FIRST_TAB_ID.to_string()) {
                println!("[annota][tabs-test] activate ERR {e}");
            } else { println!("[annota][tabs-test] activated first {:?}", snap(&handle)); }
            match tab_close(handle.clone(), wv, tabs::FIRST_TAB_ID.to_string()) {
                Ok(_) => println!("[annota][tabs-test] closed first -> {:?}", snap(&handle)),
                Err(e) => println!("[annota][tabs-test] tab_close ERR {e}"),
            }
            println!("[annota][tabs-test] done");
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn main() {
    // P2-O2：panic 落盘 + 关键事件进滚动日志（仅本机，无遥测）
    logf::install_panic_hook();
    logf::log("INFO", "annota starting");
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_screenshots::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(make_mcp_tools().build())
        .manage(Mutex::new(TabManager::new()))
        .invoke_handler(tauri::generate_handler![
            capture_frame,
            write_clipboard,
            bridge_probe_reply,
            navigate_browser,
            browser_action,
            va_fetch,
            set_shell_mode,
            overlay_open,
            overlay_close,
            tabs_snapshot,
            set_toolbar_height,
            open_devtools,
            find_in_page,
            set_zoom,
            diag_status,
            restart_server,
            trust_current_site,
            agent_run,
            agent_chat,
            agent_cancel,
            install_update,
            tab_new,
            tab_activate,
            tab_close,
            tab_session_clear
        ])
        .setup(|app| {
            let _ = APP_HANDLE.set(app.handle().clone());

            // 启动本地同步服务（Python sync_server.py 的 Rust 移植）
            let store_path = sync_server::resolve_store_path(app.handle());
            let root_path = sync_server::resolve_project_root();
            let notes_dir = sync_server::resolve_notes_dir(app.handle());
            let settings_path = sync_server::resolve_settings_path(app.handle());
            // 本地 SQLite（收藏 / 历史 / 下载，M6）
            let db_path = store::resolve_db_path(app.handle(), &store_path);
            let db = match store::Db::open(&db_path) {
                Ok(db) => db,
                Err(e) => {
                    // 可恢复场景（目录只读 / 文件损坏 / ANNOTA_DB 指向不可写处）不要拖垮整个应用：
                    // 回退到临时目录再试一次，仍失败才终止。
                    eprintln!("[annota] 打开本地库失败 {db_path:?}: {e}；回退到临时目录");
                    let fallback = std::env::temp_dir().join("Annota").join("annota.db");
                    match store::Db::open(&fallback) {
                        Ok(db) => {
                            eprintln!("[annota] 已回退到临时库 {fallback:?}");
                            db
                        }
                        Err(e2) => {
                            // P1-b#11：不再 panic——退化为内存库（本进程可用、重启为空），
                            // 并置标记供 diag_status 上报，工具栏显示启动横幅。
                            eprintln!("[annota] 临时库亦不可用 {fallback:?}: {e2}；降级为内存库");
                            crate::alog!("ERROR", "db fallback to memory: {e2}");
                            DB_MEMORY.store(true, std::sync::atomic::Ordering::Relaxed);
                            store::Db::open_in_memory().expect("内存库初始化失败")
                        }
                    }
                }
            };
            app.manage(DbState(db.clone()));
            tauri::async_runtime::spawn(sync_server::run_server(
                store_path,
                root_path,
                notes_dir,
                settings_path,
                db.clone(),
            ));

            let window = WindowBuilder::new(app, "main")
                .title("Annota")
                .inner_size(1200.0, 800.0)
                .center()
                .build()
                .map_err(|e| e.to_string())?;

            setup_webviews(&window, app.handle())?;
            apply_layout(app.handle())?;

            // 监听主窗口 resize，重新布局两个 child webview
            let app_handle = app.handle().clone();
            let _id = window.listen("tauri://resize", move |_event| {
                let _ = apply_layout(&app_handle);
            });

            // 监听桥接就绪事件，确认 JS 注入成功
            let _id2 = app.listen("annota-bridge-ready", |_event| {
                println!("[annota] __ANNOTA__ bridge ready");
            });

            // P1-a#4：桥接脚本报页面标题 → 更新 TabState + 回填历史标题
            {
                let handle = app.handle().clone();
                let _id3 = app.listen("annota://page-title", move |event| {
                    let Ok(v) = serde_json::from_str::<Value>(event.payload()) else { return };
                    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    if !id.is_empty() {
                        tabs::set_tab_title(&handle, &id, &title);
                    }
                    if url.starts_with("http://") || url.starts_with("https://") {
                        if let Some(st) = handle.try_state::<DbState>() {
                            let _ = st.0.update_history_title(&url, &title);
                        }
                    }
                });
            }

            // 自动更新：启动后延迟检查 + 24h 轮询
            spawn_update_check(app.handle());

            // 测试钩子（P1-b#14：已抽离到 spawn_debug_hooks，仅 debug 构建编译）
            #[cfg(debug_assertions)]
            spawn_debug_hooks(app.handle().clone());

            let _ = window;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
