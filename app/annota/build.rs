use std::path::Path;

// 新鲜度守护：`dist/annotate.browser.js` 由 `python3 build.py` 生成、被 main.rs 用
// include_str! 编译期内联。若忘了先跑 build.py（产物缺失/比 src 旧），这里直接失败并提示，
// 避免打包进过期的标注引擎。
fn ensure_browser_bundle_fresh() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let bundle = Path::new(&manifest).join("../../dist/annotate.browser.js");
    let src_dir = Path::new(&manifest).join("../../src");
    if !bundle.exists() {
        panic!(
            "缺少 {}：先运行 `python3 build.py` 生成浏览器壳变体（见 docs/shell-contract.md）。",
            bundle.display()
        );
    }
    let bundle_mtime = std::fs::metadata(&bundle).and_then(|m| m.modified()).ok();
    if let (Some(bm), Ok(entries)) = (bundle_mtime, std::fs::read_dir(&src_dir)) {
        for e in entries.flatten() {
            if let Ok(m) = e.metadata().and_then(|md| md.modified()) {
                if m > bm {
                    panic!(
                        "{} 比 src/{} 旧：请重新运行 `python3 build.py`（浏览器壳变体需与 src 同步）。",
                        bundle.display(),
                        e.file_name().to_string_lossy()
                    );
                }
            }
        }
    }
    // 触发 cargo 在产物或源码变化时重跑本脚本。
    println!("cargo:rerun-if-changed={}", bundle.display());
    println!("cargo:rerun-if-changed={}", src_dir.display());
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
                    "agent_run",
                    "agent_chat",
                    "agent_cancel",
                    "install_update",
                ]),
            ),
    )
    .expect("failed to run tauri-build");
}
