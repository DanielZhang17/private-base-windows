#[cfg(any(windows, test))]
mod biometric_unlock;
#[cfg(any(windows, test))]
mod capture_protection;
#[cfg(any(windows, test))]
mod files;
#[cfg(any(windows, test))]
mod passkey_handoff;
#[cfg(desktop)]
mod updater;
#[cfg(desktop)]
mod updater_policy;

#[cfg(any(windows, test))]
fn native_capabilities_script(passkey_handoff: bool, biometric_unlock: Option<&str>) -> String {
    let mut capabilities = serde_json::json!({
        "captureProtection": "full",
        "fileOpen": true,
        "fileSave": "dialog"
    });
    if passkey_handoff {
        capabilities["passkeyHandoff"] = true.into();
    }
    if let Some(capability) = biometric_unlock {
        capabilities["biometricUnlock"] = capability.into();
    }
    format!(
        "window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = Object.assign(window.__PRIVATEBASE_NATIVE_CAPABILITIES__ || {{}}, {capabilities});"
    )
}

#[cfg(any(desktop, test))]
fn native_invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    let other_commands: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
        #[cfg(any(windows, test))]
        passkey_handoff::windows::passkey_handoff_start,
        #[cfg(any(windows, test))]
        capture_protection::get_capture_protection,
        #[cfg(any(windows, test))]
        capture_protection::set_capture_protection,
        #[cfg(any(windows, test))]
        biometric_unlock::biometric_unlock_enroll,
        #[cfg(any(windows, test))]
        biometric_unlock::biometric_unlock,
        #[cfg(any(windows, test))]
        biometric_unlock::biometric_unlock_remove,
        #[cfg(desktop)]
        updater::update_check,
        #[cfg(desktop)]
        updater::update_download,
        #[cfg(desktop)]
        updater::update_install,
    ];
    move |invoke| match invoke.message.command() {
        #[cfg(any(windows, test))]
        "open_file" | "save_file" | "clear_open_cache" => files::dispatch(invoke),
        _ => other_commands(invoke),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    if passkey_handoff::ignore_startup_url(std::env::args()) {
        return;
    }

    let builder = tauri::Builder::default();

    #[cfg(windows)]
    let builder = passkey_handoff::windows::configure(builder);

    let builder = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("native-update-capability")
                .js_init_script(include_str!("update-capability.js"))
                .build(),
        )
        .manage(updater::UpdateState::default())
        .invoke_handler(native_invoke_handler());

    builder
        .run(tauri::generate_context!())
        .expect("error while running Private Base");
}

#[cfg(test)]
mod tests {
    #[test]
    fn capture_capability_is_independent_of_passkey_registration() {
        for passkey_handoff in [false, true] {
            let script = super::native_capabilities_script(passkey_handoff, None);
            assert!(script.contains(r#""captureProtection":"full""#));
            assert!(script.contains(r#""fileOpen":true"#));
            assert!(script.contains(r#""fileSave":"dialog""#));
            assert_eq!(script.contains(r#""passkeyHandoff":true"#), passkey_handoff);
            assert!(!script.contains(r#""biometricUnlock""#));
        }
    }

    #[test]
    fn supported_biometric_script_preserves_existing_native_flags() {
        let script = super::native_capabilities_script(true, Some("windows-hello"));
        for flag in [
            r#""biometricUnlock":"windows-hello""#,
            r#""captureProtection":"full""#,
            r#""fileOpen":true"#,
            r#""fileSave":"dialog""#,
            r#""passkeyHandoff":true"#,
        ] {
            assert!(script.contains(flag));
        }
        assert!(script.contains("Object.assign(window.__PRIVATEBASE_NATIVE_CAPABILITIES__ || {}"));
    }

    #[test]
    fn native_invoke_handler_type_checks_on_host() {
        let _handler = super::native_invoke_handler();
    }
}
