#[cfg(any(windows, test))]
mod capture_protection;
#[cfg(any(windows, test))]
mod passkey_handoff;

#[cfg(any(windows, test))]
fn native_capabilities_script(passkey_handoff: bool) -> String {
    let mut capabilities = serde_json::json!({ "captureProtection": "full" });
    if passkey_handoff {
        capabilities["passkeyHandoff"] = true.into();
    }
    format!(
        "window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = Object.assign(window.__PRIVATEBASE_NATIVE_CAPABILITIES__ || {{}}, {capabilities});"
    )
}

#[cfg(any(windows, test))]
fn windows_invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        passkey_handoff::windows::passkey_handoff_start,
        capture_protection::get_capture_protection,
        capture_protection::set_capture_protection
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    if passkey_handoff::ignore_startup_url(std::env::args()) {
        return;
    }

    let builder = tauri::Builder::default();

    #[cfg(windows)]
    let builder =
        passkey_handoff::windows::configure(builder).invoke_handler(windows_invoke_handler());

    builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Private Base");
}

#[cfg(test)]
mod tests {
    #[test]
    fn capture_capability_is_independent_of_passkey_registration() {
        for passkey_handoff in [false, true] {
            let script = super::native_capabilities_script(passkey_handoff);
            assert!(script.contains(r#""captureProtection":"full""#));
            assert_eq!(script.contains(r#""passkeyHandoff":true"#), passkey_handoff);
        }
    }

    #[test]
    fn windows_invoke_handler_type_checks_on_host() {
        let _handler = super::windows_invoke_handler();
    }
}
