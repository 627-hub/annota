use std::path::Path;

// 新鲜度守护：`dist/annotate.browser.js` 由 `python3 build.py` 生成、被 main.rs 用
// include_str! 编译期内联。若忘了先跑 build.py（产物缺失/比 src 旧），这里直接失败并提示，
// 避免打包进过期的标注引擎。
fn ensure_dir_fresh(bundle: &Path, dir: &Path) {
    // 目录不存在（如未配置插件）时静默跳过；其它 IO 错误必须暴露——否则新鲜度守卫被静默架空。
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => panic!("无法读取 {}：{e}（新鲜度守卫无法执行）", dir.display()),
    };
    let bundle_mtime = std::fs::metadata(bundle).and_then(|m| m.modified()).ok();
    if let Some(bm) = bundle_mtime {
        for e in entries.flatten() {
            if let Ok(m) = e.metadata().and_then(|md| md.modified()) {
                if m > bm {
                    panic!(
                        "{} 比 {}/{} 旧：请重新运行 `python3 build.py`（浏览器壳变体需与 src 同步）。",
                        bundle.display(),
                        dir.display(),
                        e.file_name().to_string_lossy()
                    );
                }
            }
        }
    }
}

fn ensure_browser_bundle_fresh() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let bundle = Path::new(&manifest).join("../../dist/annotate.browser.js");
    let src_dir = Path::new(&manifest).join("../../src");
    // 插件子目录：read_dir 非递归，单独扫一层，堵住「改插件不触发新鲜度检查」的空洞。
    let plugins_dir = src_dir.join("plugins");
    if !bundle.exists() {
        panic!(
            "缺少 {}：先运行 `python3 build.py` 生成浏览器壳变体（见 docs/shell-contract.md）。",
            bundle.display()
        );
    }
    ensure_dir_fresh(&bundle, &src_dir);
    ensure_dir_fresh(&bundle, &plugins_dir);
    // 触发 cargo 在产物或源码变化时重跑本脚本。
    println!("cargo:rerun-if-changed={}", bundle.display());
    println!("cargo:rerun-if-changed={}", src_dir.display());
    println!("cargo:rerun-if-changed={}", plugins_dir.display());
}

fn main() {
    ensure_browser_bundle_fresh();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(
                tauri_build::AppManifest::new().commands(&[
                    "capture_frame",
                    "write_clipboard",
                    "va_fetch",
                    "navigate_browser",
                    "bridge_probe_reply",
                    "set_shell_mode",
                    "agent_run",
                    "agent_chat",
                    "agent_cancel",
                    "install_update",
                    "tab_new",
                    "tab_activate",
                    "tab_close",
                ]),
            ),
    )
    .expect("failed to run tauri-build");
}
