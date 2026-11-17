fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "update_check",
            "update_download",
            "update_install",
        ]),
    ))
    .expect("failed to build native application permissions");
}
