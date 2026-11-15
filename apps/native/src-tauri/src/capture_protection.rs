use std::{
    fs::{self, File},
    io::Write,
    path::PathBuf,
    sync::Mutex,
};

struct Preference {
    path: PathBuf,
    enabled: bool,
}

impl Preference {
    fn load(path: PathBuf) -> Self {
        let enabled = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|value| value.get("enabled").and_then(serde_json::Value::as_bool))
            .unwrap_or(true);
        Self { path, enabled }
    }

    fn persist(&self, enabled: bool) -> Result<(), String> {
        let write = || -> std::io::Result<()> {
            if let Some(parent) = self.path.parent() {
                fs::create_dir_all(parent)?;
            }
            // Replace in the same directory so a failed write cannot truncate
            // the last saved preference. rename replaces the file on Windows too.
            let temporary = self.path.with_extension("json.tmp");
            let result = (|| {
                let mut file = File::create(&temporary)?;
                file.write_all(if enabled {
                    b"{\"enabled\":true}\n"
                } else {
                    b"{\"enabled\":false}\n"
                })?;
                file.sync_all()?;
                drop(file);
                fs::rename(&temporary, &self.path)
            })();
            if result.is_err() {
                let _ = fs::remove_file(temporary);
            }
            result
        };
        write().map_err(|error| format!("Could not save capture protection: {error}"))
    }

    fn set(
        &mut self,
        enabled: bool,
        mut apply: impl FnMut(bool) -> Result<(), String>,
    ) -> Result<(), String> {
        // Save before touching any window. The caller holds the lock across
        // persistence and affinity updates, so get/set cannot observe a half update.
        self.persist(enabled)?;
        if let Err(mut error) = apply(enabled) {
            if let Err(rollback) = apply(self.enabled) {
                error.push_str(&format!(
                    "; could not restore window protection: {rollback}"
                ));
            }
            if let Err(rollback) = self.persist(self.enabled) {
                error.push_str(&format!("; could not restore preference: {rollback}"));
            }
            return Err(error);
        }
        self.enabled = enabled;
        Ok(())
    }
}

pub(crate) struct CaptureProtection(Mutex<Preference>);

impl CaptureProtection {
    pub(crate) fn load(path: PathBuf) -> Self {
        Self(Mutex::new(Preference::load(path)))
    }

    pub(crate) fn enabled(&self) -> Result<bool, String> {
        self.0
            .lock()
            .map(|preference| preference.enabled)
            .map_err(|error| error.to_string())
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Affinity {
    None,
    Monitor,
    ExcludeFromCapture,
}

fn affinity_for(enabled: bool, major: u32, build: u32) -> Affinity {
    if !enabled {
        Affinity::None
    } else if major > 10 || (major == 10 && build >= 19_041) {
        // Windows 10 version 2004 is the first build supporting exclusion.
        Affinity::ExcludeFromCapture
    } else {
        Affinity::Monitor
    }
}

#[cfg(windows)]
pub(crate) fn apply(window: &tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    use windows::{
        Wdk::System::SystemServices::RtlGetVersion,
        Win32::{
            System::SystemInformation::OSVERSIONINFOW,
            UI::WindowsAndMessaging::{
                SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_MONITOR, WDA_NONE,
            },
        },
    };

    let affinity = if enabled {
        let mut version = OSVERSIONINFOW {
            dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
            ..Default::default()
        };
        // SAFETY: version is writable and its size matches the supplied struct.
        unsafe { RtlGetVersion(&mut version) }
            .ok()
            .map_err(|error| error.to_string())?;
        affinity_for(true, version.dwMajorVersion, version.dwBuildNumber)
    } else {
        affinity_for(false, 0, 0)
    };
    let affinity = match affinity {
        Affinity::None => WDA_NONE,
        Affinity::Monitor => WDA_MONITOR,
        Affinity::ExcludeFromCapture => WDA_EXCLUDEFROMCAPTURE,
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    // SAFETY: Tauri owns this live, top-level HWND in the current process.
    unsafe { SetWindowDisplayAffinity(hwnd, affinity) }.map_err(|error| error.to_string())
}

// Host tests type-check command registration without calling Win32.
#[cfg(all(test, not(windows)))]
pub(crate) fn apply(_window: &tauri::WebviewWindow, _enabled: bool) -> Result<(), String> {
    Err("Capture protection requires Windows".to_owned())
}

#[tauri::command]
pub(crate) fn get_capture_protection(
    state: tauri::State<'_, CaptureProtection>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "enabled": state.enabled()? }))
}

#[tauri::command]
pub(crate) fn set_capture_protection(
    app: tauri::AppHandle,
    state: tauri::State<'_, CaptureProtection>,
    enabled: bool,
) -> Result<(), String> {
    use tauri::Manager;

    let mut preference = state.0.lock().map_err(|error| error.to_string())?;
    let windows = app.webview_windows();
    preference.set(enabled, |value| {
        let mut failure = None;
        for window in windows.values() {
            if let Err(error) = apply(window, value) {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_preference_defaults_to_enabled() {
        let directory = tempfile::tempdir().unwrap();
        let state = CaptureProtection::load(directory.path().join("missing/preference.json"));
        assert!(state.enabled().unwrap());
    }

    #[test]
    fn preference_roundtrips_across_restarts() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config/capture-protection.json");
        let mut preference = Preference::load(path.clone());
        for enabled in [false, false, true, true, false] {
            let mut window_enabled = !enabled;
            preference
                .set(enabled, |value| {
                    // Persistence must finish before a window changes.
                    assert_eq!(Preference::load(path.clone()).enabled, value);
                    window_enabled = value;
                    Ok(())
                })
                .unwrap();
            assert_eq!(window_enabled, enabled);
            assert_eq!(preference.enabled, enabled);
            assert_eq!(
                CaptureProtection::load(path.clone()).enabled().unwrap(),
                enabled
            );
        }
    }

    #[test]
    fn corrupt_or_missing_value_defaults_to_enabled() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("capture-protection.json");
        for contents in [
            "",
            "not json",
            "{}",
            "false",
            "null",
            "{\"enabled\":false",
            "{\"enabled\":null}",
            "{\"enabled\":0}",
            "{\"enabled\":\"false\"}",
        ] {
            fs::write(&path, contents).unwrap();
            assert!(
                CaptureProtection::load(path.clone()).enabled().unwrap(),
                "{contents}"
            );
        }
    }

    #[test]
    fn write_failure_leaves_window_and_saved_preference_unchanged() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("capture-protection.json");
        let mut preference = Preference::load(path.clone());
        preference.set(false, |_| Ok(())).unwrap();
        fs::create_dir(path.with_extension("json.tmp")).unwrap();
        assert!(preference
            .set(true, |_| panic!(
                "must not change any window on a save failure"
            ))
            .is_err());
        assert!(!preference.enabled);
        assert!(!Preference::load(path).enabled);
    }

    #[test]
    fn replacement_failure_leaves_window_unchanged() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("capture-protection.json");
        fs::create_dir(&path).unwrap();
        let mut preference = Preference::load(path.clone());
        assert!(preference
            .set(false, |_| panic!(
                "must not change any window on a replacement failure"
            ))
            .is_err());
        assert!(preference.enabled);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn affinity_failure_restores_window_and_saved_preference() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("capture-protection.json");
        let mut preference = Preference::load(path.clone());
        for previous in [false, true] {
            preference.set(previous, |_| Ok(())).unwrap();
            let mut window_enabled = previous;
            let result = preference.set(!previous, |value| {
                window_enabled = value;
                if value == previous {
                    Ok(())
                } else {
                    Err("affinity failed".to_owned())
                }
            });
            assert_eq!(result, Err("affinity failed".to_owned()));
            assert_eq!(window_enabled, previous);
            assert_eq!(preference.enabled, previous);
            assert_eq!(Preference::load(path.clone()).enabled, previous);
        }
    }

    #[test]
    fn uses_monitor_before_windows_10_2004() {
        for (major, build) in [(6, 7601), (6, 9600), (10, 17763), (10, 19040)] {
            assert_eq!(affinity_for(true, major, build), Affinity::Monitor);
        }
    }

    #[test]
    fn excludes_capture_from_windows_10_2004_onward() {
        for (major, build) in [(10, 19041), (10, 19045), (10, 22000), (11, 0)] {
            assert_eq!(
                affinity_for(true, major, build),
                Affinity::ExcludeFromCapture
            );
        }
    }

    #[test]
    fn disabling_always_removes_affinity() {
        for (major, build) in [(6, 7601), (10, 19040), (10, 19041), (10, 26100), (11, 0)] {
            assert_eq!(affinity_for(false, major, build), Affinity::None);
        }
    }
}
