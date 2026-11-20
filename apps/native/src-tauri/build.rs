fn guard_ota_fixture() {
    use std::{env, fs, io, path::Path};
    use tauri_utils::config::FrontendDist;

    println!("cargo:rerun-if-env-changed=VITE_OTA_TEST_NO_READY");
    assert!(
        env::var("VITE_OTA_TEST_NO_READY").as_deref() != Ok("1"),
        "The OTA no-ready flag cannot be set for a native shell build."
    );
    // Use the same configuration lookup as generate_context!, including overlays.
    let (config, root) =
        tauri_codegen::get_config(Path::new("tauri.conf.json")).expect("read Tauri asset config");
    if tauri_build::is_dev() && config.build.dev_url.is_some() {
        return;
    }
    let paths = match config.build.frontend_dist {
        Some(FrontendDist::Directory(path)) => vec![path.join("schema-version.json")],
        Some(FrontendDist::Files(paths)) => paths,
        _ => return,
    };
    for path in paths {
        let path = root.join(path);
        assert!(
            !path
                .components()
                .any(|part| part.as_os_str() == "dist-native-ota-no-ready"),
            "A native shell cannot embed the OTA no-ready fixture."
        );
        let receipt = if path.is_dir() {
            path.join("schema-version.json")
        } else if path
            .file_name()
            .is_some_and(|name| name == "schema-version.json")
        {
            path
        } else {
            continue;
        };
        println!("cargo:rerun-if-changed={}", receipt.display());
        let bytes = match fs::read(receipt) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => panic!("read embedded UI schema: {error}"),
        };
        let schema: serde_json::Value =
            serde_json::from_slice(&bytes).expect("parse embedded UI schema");
        assert!(
            schema["otaTestNoReady"].as_bool() != Some(true),
            "A native shell cannot embed the OTA no-ready fixture."
        );
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=TAURI_ANDROID_PROJECT_PATH");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        if let Some(project) = std::env::var_os("TAURI_ANDROID_PROJECT_PATH") {
            let manifest =
                std::path::PathBuf::from(project).join("app/src/main/AndroidManifest.xml");
            println!("cargo:rerun-if-changed={}", manifest.display());
            const PERMISSION: &str =
                r#"<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />"#;
            if !std::fs::read_to_string(manifest).is_ok_and(|xml| xml.contains(PERMISSION)) {
                tauri_utils::build::update_android_manifest(
                    "privatebase-ota-network-state",
                    "manifest",
                    PERMISSION.into(),
                )
                .expect("failed to add the Android OTA network-state permission");
            }
        }
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "update_check",
            "update_download",
            "update_install",
            "ui_bundle_ready",
            "ui_bundle_set_channel",
            "ui_bundle_initialize_channel",
            "ui_bundle_get_channel",
            "ui_bundle_get_pending",
            "ui_bundle_restart",
            "ui_bundle_is_unmetered",
        ]),
    ))
    .expect("failed to build native application permissions");
    // Tauri sets TAURI_ENV_TARGET_TRIPLE from Cargo's TARGET during try_build.
    guard_ota_fixture();
}
