//! Windows 平台启动前检查（只读，不改系统状态）
//!
//! 原则：**只检测，不干预**。
//! 早期版本会在启动时 `taskkill /F /IM msedgewebview2.exe` 全系统强杀 WebView2 进程，
//! 这会连带杀掉 Outlook / Teams / Widgets / 其它 Tauri 应用的后端进程，属于越权操作。
//! 现在只做只读探测：
//! 1. 查 WebView2 Runtime 是否已安装（注册表 + 磁盘路径双路探测）
//! 2. 仅在确认缺失时才弹一次原生错误对话框
//! 3. 收集诊断信息写入本地滚动日志
//!
//! 绝不在此模块里结束其它进程。

use std::process::Command;

/// WebView2 Runtime 的 EdgeUpdate 客户端 GUID。
const WEBVIEW2_CLIENT_GUID: &str =
    "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

/// 启动前预检：WebView2 Runtime 缺失才会失败。
///
/// 成功即代表环境可用，静默返回；失败时调用方负责提示并退出。
#[cfg(target_os = "windows")]
pub fn ensure_webview2_clean() -> Result<(), String> {
    crate::logf::log("INFO", "Windows 预检：检查 WebView2 Runtime");

    match probe_webview2() {
        Ok(found) => {
            crate::logf::log("INFO", &format!("WebView2 Runtime 可用：{found}"));
            Ok(())
        }
        Err(e) => {
            crate::logf::log("ERROR", &format!("WebView2 预检失败：{e}"));
            let diag = get_windows_diagnostics();
            crate::logf::log("INFO", &format!("诊断信息：\n{diag}"));
            Err(e)
        }
    }
}

/// 探测 WebView2 Runtime，返回可读的位置描述。
///
/// 两条独立路径，任一命中即认为可用：
/// - 注册表 EdgeUpdate 客户端项（含 32 位 WOW6432Node 视图）
/// - 磁盘上的 `MicrosoftEdgeWebview2.exe`
#[cfg(target_os = "windows")]
fn probe_webview2() -> Result<String, String> {
    if let Some(v) = registry_webview2_version() {
        return Ok(format!("注册表版本 {v}"));
    }
    if let Some(p) = disk_webview2_path() {
        return Ok(format!("磁盘路径 {p}"));
    }
    Err("未检测到 WebView2 Runtime".to_string())
}

/// 读注册表拿版本号。HKLM / HKCU × 64位 / WOW6432Node 四处都查。
#[cfg(target_os = "windows")]
fn registry_webview2_version() -> Option<String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let views = [
        (HKEY_LOCAL_MACHINE, WEBVIEW2_CLIENT_GUID),
        (
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        ),
        (HKEY_CURRENT_USER, WEBVIEW2_CLIENT_GUID),
    ];

    for (root, path) in views {
        if let Ok(sub) = RegKey::predef(root).open_subkey(path) {
            if let Ok(v) = sub.get_value::<String, _>("pv") {
                if !v.trim().is_empty() {
                    return Some(v.trim().to_string());
                }
            }
        }
    }
    None
}

/// 扫常见安装位置找 `MicrosoftEdgeWebview2.exe`。
#[cfg(target_os = "windows")]
fn disk_webview2_path() -> Option<String> {
    // 实测目录名是 EdgeWebView（非 EdgeWebView2），可执行文件是 msedgewebview2.exe；
    // 逐用户安装落在 %LOCALAPPDATA%\Microsoft\EdgeWebView\Application\<ver>\
    let mut patterns: Vec<String> = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        patterns.push(
            std::path::Path::new(&local)
                .join(r"Microsoft\EdgeWebView\Application\*\msedgewebview2.exe")
                .to_string_lossy()
                .into_owned(),
        );
    }
    for base in [
        r"C:\Program Files (x86)\Microsoft\EdgeWebView",
        r"C:\Program Files\Microsoft\EdgeWebView",
    ] {
        patterns.push(format!(r"{base}\*\msedgewebview2.exe"));
    }

    for pattern in patterns {
        if let Ok(entries) = glob::glob(&pattern) {
            for entry in entries.flatten() {
                if entry.is_file() {
                    return Some(entry.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

/// 收集 Windows 诊断信息（只读）。
#[cfg(target_os = "windows")]
pub fn get_windows_diagnostics() -> String {
    use std::fmt::Write as _;
    let mut diag = String::new();

    if let Ok(out) = Command::new("cmd").args(["/c", "ver"]).output() {
        let _ = writeln!(diag, "系统版本: {}", String::from_utf8_lossy(&out.stdout).trim());
    }
    match probe_webview2() {
        Ok(v) => {
            let _ = writeln!(diag, "WebView2: 可用 ({v})");
        }
        Err(e) => {
            let _ = writeln!(diag, "WebView2: 缺失 ({e})");
        }
    }
    for proc_name in ["annota.exe", "msedgewebview2.exe"] {
        if let Ok(out) = Command::new("tasklist")
            .args(["/fi", &format!("imagename eq {proc_name}"), "/nh"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            // /nh + 单进程时输出以 "annota.exe" 开头；无匹配时输出中文"信息:"，故按这个判定
            let running = text.trim_start().to_lowercase().starts_with(proc_name);
            let _ = writeln!(diag, "{proc_name}: {}", if running { "运行中" } else { "未运行" });
        }
    }
    diag
}

/// 弹出原生错误对话框（Win32 MessageBox）。
///
/// 走 PowerShell 而非写临时 .bat + `pause`——后者会留下孤儿 cmd 窗口，
/// 且 `pause` 阻塞的子进程无法被上层回收。消息文本经环境变量传递，避免命令行转义问题。
#[cfg(target_os = "windows")]
pub fn show_error_dialog(title: &str, message: &str) -> std::io::Result<()> {
    const SCRIPT: &str = "Add-Type -AssemblyName System.Windows.Forms; \
        [void][System.Windows.Forms.MessageBox]::Show(\
        $env:ANNOTA_DIALOG_MSG, $env:ANNOTA_DIALOG_TITLE, 'OK', 'Error')";

    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", SCRIPT])
        .env("ANNOTA_DIALOG_MSG", message)
        .env("ANNOTA_DIALOG_TITLE", title)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;

    // 模态对话框：等用户确认，避免留下未收割的子进程
    let _ = child.wait();
    Ok(())
}
