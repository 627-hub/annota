//! P2-O：最小可观测——本地滚动日志 + panic 落盘。无遥测：一切只写本机。
//! 位置：macOS `~/Library/Logs/annota/annota.log`；Windows `%LOCALAPPDATA%\Annota\logs`；其余 temp。

use std::io::Write;
use std::path::PathBuf;

pub fn log_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(h) = std::env::var_os("HOME") {
            return PathBuf::from(h).join("Library/Logs/annota");
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(p) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(p).join("Annota/logs");
        }
    }
    std::env::temp_dir().join("annota-logs")
}

const ROTATE_BYTES: u64 = 5 * 1024 * 1024;

/// 追加一行日志（`level msg`）。写失败静默——日志永远不能拖垮业务。
pub fn log(level: &str, msg: &str) {
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("annota.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > ROTATE_BYTES {
            let _ = std::fs::rename(&path, dir.join("annota.log.1"));
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(f, "{ts} [{level}] {msg}");
    }
}

#[macro_export]
macro_rules! alog {
    ($lvl:expr, $($arg:tt)*) => { $crate::logf::log($lvl, &format!($($arg)*)) };
}

/// P2-O2：panic 落盘（panic-<ts>.log 含 backtrace；同时保留 stderr）。
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let payload = info.payload();
        let msg = payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".to_string());
        let where_ = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();
        let trace = format!(
            "panic: {msg}\nat {where_}\n{:?}",
            std::backtrace::Backtrace::force_capture()
        );
        log("PANIC", &trace);
        eprintln!("[annota][panic] {msg} ({where_})");
    }));
}
