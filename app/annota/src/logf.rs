//! P2-O：最小可观测——本地滚动日志 + panic 落盘。无遥测：一切只写本机。
//! 位置：macOS `~/Library/Logs/annota/annota.log`；Windows `%LOCALAPPDATA%\Annota\logs`；其余 temp。

use std::io::Write;
use std::path::PathBuf;

pub fn log_dir() -> PathBuf {
    // OCR-fix：目录只解析一次并缓存（每次 log() 重复 env 查询/拼接是纯浪费）
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
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
        // OCR-fix：其它平台不再回落到共享可写的 /tmp（可被预建符号链接转向/读取）——
        // 改用每用户 state 目录（$XDG_STATE_HOME 或 ~/.local/state）并收紧权限。
        let dir = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))
            .unwrap_or_else(std::env::temp_dir)
            .join("annota/logs");
        dir
    })
    .clone()
}

/// 创建日志目录并（unix）收紧到 0700。
fn ensure_log_dir(dir: &std::path::Path) {
    let _ = std::fs::create_dir_all(dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
}

const ROTATE_BYTES: u64 = 5 * 1024 * 1024;

/// 追加一行日志（`level msg`）。写失败静默——日志永远不能拖垮业务。
pub fn log(level: &str, msg: &str) {
    // OCR-fix：unwind 过程中不再做任何 I/O/分配（panic hook 内调用 log 时防二次 panic）
    if IN_UNWIND.with(|f| f.get()) {
        return;
    }
    let dir = log_dir();
    ensure_log_dir(&dir);
    let path = dir.join("annota.log");
    // OCR-fix：轮转 check-then-rename 加进程锁，避免并发 log() 丢轮转/互相覆盖 .1
    {
        static ROTATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = ROTATE_LOCK.lock();
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > ROTATE_BYTES {
                let _ = std::fs::rename(&path, dir.join("annota.log.1"));
            }
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        // OCR-fix：整行一次 write_all，避免多片写入在并发下交错出半行
        let line = format!("{ts} [{level}] {msg}\n");
        let _ = f.write_all(line.as_bytes());
    }
}

thread_local! {
    static IN_UNWIND: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[macro_export]
macro_rules! alog {
    ($lvl:expr, $($arg:tt)*) => { $crate::logf::log($lvl, &format!($($arg)*)) };
}

/// P2-O2：panic 落盘（panic-<ts>.log 含 backtrace；同时保留 stderr）。
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // 先置 unwind 标志：此后任何 alog! 调用直接短路（防 unwind 中 I/O 再 panic）
        IN_UNWIND.with(|f| f.set(true));
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
        // hook 自身不 panic：log 内部全 unwrap-free，但保险起见 catch
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            log("PANIC", &trace);
        }));
        eprintln!("[annota][panic] {msg} ({where_})");
        // OCR-fix：链式调用先前的 hook（测试框架/其他库的诊断不丢失）
        prev(info);
        IN_UNWIND.with(|f| f.set(false));
    }));
}
