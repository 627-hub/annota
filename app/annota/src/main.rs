#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use serde_json::{json, Value};
use std::{fs, io::Cursor, path::PathBuf, sync::OnceLock};
use tauri::{
  AppHandle, Listener, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
};
use tauri::window::WindowBuilder;
use tauri::webview::WebviewBuilder;
use tauri_plugin_clipboard_manager::ClipboardExt;

mod sync_server;

// 全局 AppHandle，供 MCP tool handler 使用（clipboard 等需要后端状态）
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

// 工具栏高度（逻辑像素）
const TOOLBAR_HEIGHT: f64 = 56.0;
// 本地同步服务地址（va_fetch 只允许它，防 SSRF）
const SYNC_HOSTS: &[&str] = &["127.0.0.1", "localhost", "::1"];
const SYNC_PORT: u16 = 8793;

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
    copyToClipboard: function (opts) { return invoke('write_clipboard', opts || {}); }
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

  // 自检：延迟 2s 验证 __ANNOTA__.captureFrame 与 vaFetch 在 webview 中可用
  setTimeout(function () {
    function badge(text, color) {
      try {
        var d = document.createElement('div');
        d.textContent = text;
        d.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483600;padding:6px 10px;background:' + (color || '#c00') + ';color:#fff;font:14px sans-serif;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.4);';
        document.body.appendChild(d);
      } catch (e) {}
    }
    try {
      window.__ANNOTA__.captureFrame().then(function (res) {
        window.__TAURI_INTERNALS__.invoke('bridge_probe_reply', {
          keys: ['capture-smoke', location.hostname, res.width + 'x' + res.height]
        });
        badge('captureFrame OK ' + res.width + 'x' + res.height, '#2a8');
      }).catch(function (e) {
        window.__TAURI_INTERNALS__.invoke('bridge_probe_reply', {
          keys: ['capture-smoke-err', String(e.message)]
        });
        badge('captureFrame ERR ' + e.message, '#c00');
      });
      window.vaFetch('GET', 'http://127.0.0.1:8793/api/health').then(function (r) {
        var statusStr = String((r && r.status) !== undefined ? r.status : (r && r.ok ? 'ok' : JSON.stringify(r)));
        window.__TAURI_INTERNALS__.invoke('bridge_probe_reply', {
          keys: ['vaFetch-smoke', location.hostname, statusStr]
        });
        badge('vaFetch OK ' + statusStr, '#28c');
      }).catch(function (e) {
        var info = (e && (e.message || e.stack)) ? (String(e.message) + ' | ' + String(e.stack)) : String(e);
        window.__TAURI_INTERNALS__.invoke('bridge_probe_reply', {
          keys: ['vaFetch-smoke-err', location.hostname, info.slice(0, 200)]
        });
        badge('vaFetch ERR ' + info.slice(0, 120), '#c00');
      });
    } catch (e) {
      badge('SMOKE ERR ' + e.message, '#c00');
    }
  }, 2000);

  emit('annota-bridge-ready', {});
})();
"#;

// 注入已有的 userscript（geometry / adapter / vocab / core）
const ANNOTATE_JS: &str = include_str!("../../../dist/annotate.user.js");

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
async fn capture_frame(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
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
    image: Option<String>,
    text: Option<String>,
    html: Option<String>,
) -> Result<serde_json::Value, String> {
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
    // 其余默认加 https://（支持 youtube.com/watch?v=... 等省略写法）
    Ok(format!("https://{raw}"))
}

#[tauri::command]
async fn navigate_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let target = resolve_nav_url(&url)?;
    let parsed = url::Url::parse(&target).map_err(|e| e.to_string())?;
    let webview = app
        .get_webview("browser")
        .ok_or_else(|| "未找到 browser webview".to_string())?;
    webview.navigate(parsed).map_err(|e| e.to_string())?;
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
    let toolbar_h = (TOOLBAR_HEIGHT * sf) as u32;

    if let Some(toolbar) = app.get_webview("toolbar") {
        toolbar
            .set_position(PhysicalPosition::new(0, 0))
            .map_err(|e| e.to_string())?;
        toolbar
            .set_size(PhysicalSize::new(size.width, toolbar_h))
            .map_err(|e| e.to_string())?;
    }
    if let Some(browser) = app.get_webview("browser") {
        browser
            .set_position(PhysicalPosition::new(0, toolbar_h))
            .map_err(|e| e.to_string())?;
        browser
            .set_size(PhysicalSize::new(
                size.width,
                size.height.saturating_sub(toolbar_h),
            ))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn setup_webviews(window: &tauri::Window) -> Result<(), String> {
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let sf = window.scale_factor().map_err(|e| e.to_string())?;
    let toolbar_h = (TOOLBAR_HEIGHT * sf) as u32;

    // 工具栏 webview：加载本地 index.html（地址栏）
    let toolbar = WebviewBuilder::new("toolbar", WebviewUrl::App("index.html".into()))
        .initialization_script(BRIDGE_JS)
        .auto_resize();
    window
        .add_child(
            toolbar,
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(size.width, toolbar_h),
        )
        .map_err(|e| e.to_string())?;

    // 浏览器 webview：默认打开本机 demo 页，注入桥 + annotate.user.js
    let start_url = url::Url::parse("http://127.0.0.1:8793/dev/demo.html")
        .map_err(|e| e.to_string())?;
    let browser = WebviewBuilder::new("browser", WebviewUrl::External(start_url))
        .initialization_script(BRIDGE_JS)
        .initialization_script(ANNOTATE_JS)
        .auto_resize()
        .on_navigation(|url| {
            println!("[annota] browser navigation request: {}", url);
            true
        })
        .on_page_load(|_webview, payload| {
            println!("[annota] browser page load: {:?} - {}", payload.event(), payload.url());
        });
    let browser_wv = window
        .add_child(
            browser,
            PhysicalPosition::new(0, toolbar_h),
            PhysicalSize::new(size.width, size.height.saturating_sub(toolbar_h)),
        )
        .map_err(|e| e.to_string())?;
    println!("[annota] browser webview created, url={}", browser_wv.url().map(|u| u.to_string()).unwrap_or_default());

    Ok(())
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
            |_params: serde_json::Value| -> Result<String, String> {
                let (w, h, buf) = capture_annota_window()?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
                Ok(json!({
                    "format": "png",
                    "width": w,
                    "height": h,
                    "bytes": buf.len(),
                    "base64": b64,
                })
                .to_string())
            },
        )
        .tool(
            "copy_to_clipboard",
            "将图片（PNG base64）、纯文本、HTML 写入系统剪贴板",
            clipboard_schema,
            |params: serde_json::Value| -> Result<String, String> {
                let app = APP_HANDLE.get().ok_or("AppHandle 尚未初始化")?;
                let image = params.get("image").and_then(|v| v.as_str()).map(String::from);
                let text = params.get("text").and_then(|v| v.as_str()).map(String::from);
                let html = params.get("html").and_then(|v| v.as_str()).map(String::from);
                let res = do_write_clipboard(app, image, text, html)?;
                Ok(res.to_string())
            },
        )
        .tool(
            "navigate",
            "让 Annota 浏览器跳转到指定 URL（agent 操作能力）",
            serde_json::json!({
                "type": "object",
                "properties": { "url": { "type": "string", "description": "目标 URL" } },
                "required": ["url"]
            }),
            |params: serde_json::Value| -> Result<String, String> {
                let app = APP_HANDLE.get().ok_or("AppHandle 尚未初始化")?;
                let raw = params.get("url").and_then(|v| v.as_str()).ok_or("缺少 url 参数")?;
                let target = resolve_nav_url(raw)?;
                let parsed = url::Url::parse(&target).map_err(|e| e.to_string())?;
                let webview = app.get_webview("browser").ok_or("browser webview 不存在")?;
                webview.navigate(parsed).map_err(|e| e.to_string())?;
                Ok(format!("navigating to {target}"))
            },
        )
        .tool(
            "probe_bridge",
            "探测 browser webview 中 window.__ANNOTA__ 是否注入成功",
            serde_json::json!({"type":"object","properties":{}}),
            |_params: serde_json::Value| -> Result<String, String> {
                let app = APP_HANDLE.get().ok_or("AppHandle 尚未初始化")?;
                let webview = app.get_webview("browser").ok_or("browser webview 不存在")?;
                webview
                    .eval(r#"(function(){ try { window.__TAURI_INTERNALS__.invoke('bridge_probe_reply', {keys: ['probe-smoke', typeof window.__ANNOTA__, typeof window.vaFetch]}); } catch(e) { window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke('bridge_probe_reply', {keys: ['err', String(e.message)]}); } })()"#)
                    .map_err(|e| e.to_string())?;
                Ok("probe sent".to_string())
            },
        )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_screenshots::init())
        .plugin(make_mcp_tools().build())
        .invoke_handler(tauri::generate_handler![
            capture_frame,
            write_clipboard,
            bridge_probe_reply,
            navigate_browser,
            va_fetch
        ])
        .setup(|app| {
            let _ = APP_HANDLE.set(app.handle().clone());

            // 启动本地同步服务（Python sync_server.py 的 Rust 移植）
            let store_path = sync_server::resolve_store_path();
            let root_path = sync_server::resolve_project_root();
            let notes_dir = sync_server::resolve_notes_dir();
            tauri::async_runtime::spawn(sync_server::run_server(store_path, root_path, notes_dir));

            let window = WindowBuilder::new(app, "main")
                .title("Annota")
                .inner_size(1200.0, 800.0)
                .center()
                .build()
                .map_err(|e| e.to_string())?;

            setup_webviews(&window)?;
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

            let _ = window;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
