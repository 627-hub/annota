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
//! 绝不在此模块里结束其它进程。唯一的例外见 `show_error_dialog`：
//! 超时后只结束本模块自己拉起的那个 PowerShell 子进程（按 PID 精确匹配）。

use std::path::Path;
use std::process::Command;

/// WebView2 Runtime 的 EdgeUpdate 客户端 GUID。
const WEBVIEW2_CLIENT_GUID: &str =
    "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

/// 32 位视图下的 EdgeUpdate 客户端项。EdgeUpdate 本身是 32 位程序，
/// 所以机器级安装的客户端项落在 `WOW6432Node` 下，64 位视图里查不到。
const WEBVIEW2_CLIENT_GUID_WOW: &str =
    "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

/// WebView2 可执行文件名。
const WEBVIEW2_EXE: &str = "msedgewebview2.exe";

/// 启动前预检：WebView2 Runtime 缺失才会失败。
///
/// 成功即代表环境可用，静默返回；失败时调用方负责提示并退出。
#[cfg(target_os = "windows")]
pub fn preflight_webview2() -> Result<(), String> {
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
/// - 磁盘上的 `msedgewebview2.exe`
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
        (HKEY_LOCAL_MACHINE, WEBVIEW2_CLIENT_GUID_WOW),
        (HKEY_CURRENT_USER, WEBVIEW2_CLIENT_GUID),
        (HKEY_CURRENT_USER, WEBVIEW2_CLIENT_GUID_WOW),
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

/// 读注册表拿安装目录（`location` 值）。
///
/// 这是最权威的来源——它直接指向 `...\Microsoft\EdgeWebView\Application`，
/// 免去猜版本目录层级的麻烦。
#[cfg(target_os = "windows")]
fn registry_webview2_location() -> Option<String> {
    use winreg::enums::*;
    use winreg::RegKey;

    let views = [
        (HKEY_LOCAL_MACHINE, WEBVIEW2_CLIENT_GUID),
        (HKEY_LOCAL_MACHINE, WEBVIEW2_CLIENT_GUID_WOW),
        (HKEY_CURRENT_USER, WEBVIEW2_CLIENT_GUID),
        (HKEY_CURRENT_USER, WEBVIEW2_CLIENT_GUID_WOW),
    ];

    for (root, path) in views {
        if let Ok(sub) = RegKey::predef(root).open_subkey(path) {
            if let Ok(v) = sub.get_value::<String, _>("location") {
                if !v.trim().is_empty() {
                    return Some(v.trim().to_string());
                }
            }
        }
    }
    None
}

/// 扫常见安装位置找 `msedgewebview2.exe`。
///
/// 实际磁盘布局是 `<root>\EdgeWebView\Application\<version>\msedgewebview2.exe`，
/// 版本号目录名不固定（`155.0.4283.45` / `SetupMetrics` 等），
/// 因此**不能**只写 `EdgeWebView\*\msedgewebview2.exe`——那会漏掉 `Application` 这一层。
/// 正确做法是 `<root>\EdgeWebView\**\msedgewebview2.exe`（`**` 跨任意层数）。
#[cfg(target_os = "windows")]
fn disk_webview2_path() -> Option<String> {
    // 1) 注册表 location 指向的就是 `...\EdgeWebView\Application`，最准
    if let Some(loc) = registry_webview2_location() {
        if let Some(found) = find_webview2_exe(Path::new(&loc)) {
            return Some(found);
        }
    }

    // 2) 兜底扫常见安装根目录
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        // 逐用户安装：%LOCALAPPDATA%\Microsoft\EdgeWebView\Application\<ver>\
        roots.push(
            Path::new(&local)
                .join("Microsoft")
                .join("EdgeWebView")
                .join("Application"),
        );
    }
    for base in [
        r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application",
        r"C:\Program Files\Microsoft\EdgeWebView\Application",
    ] {
        roots.push(Path::new(base).to_path_buf());
    }

    for root in roots {
        if let Some(found) = find_webview2_exe(&root) {
            return Some(found);
        }
    }
    None
}

/// 在给定根目录下找 WebView2 可执行文件，返回首个命中路径。
///
/// `<root>` 通常是 `...\EdgeWebView\Application`，其下是 `<version>\msedgewebview2.exe`。
/// 用 `**` 覆盖不固定的版本目录层级。
#[cfg(target_os = "windows")]
fn find_webview2_exe(root: &Path) -> Option<String> {
    // `**` 必须独占一个路径段；`Application\*\*\exe` 与 `Application\*\exe` 都试一遍，
    // 后者更精确（避免 `**` 展开到 SetupMetrics 之类的噪声目录）。
    let patterns = [
        root.join("*").join(WEBVIEW2_EXE),
        root.join("**").join(WEBVIEW2_EXE),
    ];

    for pattern in patterns {
        let pattern = pattern.to_string_lossy().into_owned();
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
        let _ = writeln!(
            diag,
            "系统版本: {}",
            String::from_utf8_lossy(&out.stdout).trim()
        );
    }
    match probe_webview2() {
        Ok(v) => {
            let _ = writeln!(diag, "WebView2: 可用 ({v})");
        }
        Err(e) => {
            let _ = writeln!(diag, "WebView2: 缺失 ({e})");
        }
    }
    for proc_name in ["annota.exe", WEBVIEW2_EXE] {
        let _ = writeln!(
            diag,
            "{proc_name}: {}",
            if process_running(proc_name) {
                "运行中"
            } else {
                "未运行"
            }
        );
    }
    diag
}

/// 判断某个进程是否在运行。
///
/// 用 `tasklist /fo csv` 而不是解析默认表格输出：默认输出里"没有匹配任务"
/// 那行文案是本地化的（中文系统显示"信息: ..."），而 CSV 的数据行是语言无关的。
#[cfg(target_os = "windows")]
fn process_running(image_name: &str) -> bool {
    let Ok(out) = Command::new("tasklist")
        .args([
            "/nh",
            "/fo",
            "csv",
            "/fi",
            &format!("imagename eq {image_name}"),
        ])
        .output()
    else {
        return false;
    };

    let text = String::from_utf8_lossy(&out.stdout);
    // CSV 数据行形如 "msedgewebview2.exe","4744","Console","1","68,408 K"
    text.lines()
        .any(|line| line.trim_start().starts_with('"') && line.contains(image_name))
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

    // 模态对话框：等用户确认再退出，避免留下未收割的子进程。
    // 上限 60s——无人值守场景（服务/计划任务）下弹窗没人点，不能把启动流程永久挂住。
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = tx.send(());
    });

    match rx.recv_timeout(std::time::Duration::from_secs(60)) {
        Ok(()) => Ok(()),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // 只结束本函数自己拉起的那个子进程（按 PID 精确匹配），不碰任何其它进程
            let _ = Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .output();
            crate::logf::log("WARN", "错误对话框 60s 未被确认，已关闭");
            Ok(())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归锁：磁盘探测必须能跨过 `Application\<version>\` 这层不确定的目录层级。
    /// 曾经的 bug 是只匹配 `EdgeWebView\*\msedgewebview2.exe`——漏掉 `Application` 一层，
    /// 在真实机器上一条都匹配不到，等于磁盘兜底路径完全失效。
    #[test]
    fn find_webview2_exe_crosses_version_dir() {
        let tmp = std::env::temp_dir().join("annota-webview2-probe-test");
        let ver_dir = tmp.join("Application").join("155.0.4283.45");
        std::fs::create_dir_all(&ver_dir).unwrap();
        let exe = ver_dir.join(WEBVIEW2_EXE);
        std::fs::write(&exe, b"stub").unwrap();

        let found = find_webview2_exe(&tmp.join("Application"));
        assert_eq!(
            found.as_deref().map(Path::new),
            Some(exe.as_path()),
            "应能跨过版本号目录找到 {WEBVIEW2_EXE}"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 回归锁：`location` 指向的目录层级同样要能被扫到。
    #[test]
    fn find_webview2_exe_at_location_root() {
        let tmp = std::env::temp_dir().join("annota-webview2-loc-test");
        let ver_dir = tmp.join("160.0.1.2");
        std::fs::create_dir_all(&ver_dir).unwrap();
        let exe = ver_dir.join(WEBVIEW2_EXE);
        std::fs::write(&exe, b"stub").unwrap();

        let found = find_webview2_exe(&tmp);
        assert_eq!(found.as_deref().map(Path::new), Some(exe.as_path()));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 回归锁：目录不存在时必须返回 None 而不是 panic。
    #[test]
    fn find_webview2_exe_missing_dir_returns_none() {
        let missing = std::env::temp_dir().join("annota-webview2-not-there-xyz");
        assert!(find_webview2_exe(&missing).is_none());
    }
}
