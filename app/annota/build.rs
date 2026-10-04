fn main() {
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
