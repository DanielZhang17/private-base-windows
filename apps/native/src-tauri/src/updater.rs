use std::time::Duration;

use serde::Serialize;
use tauri::{async_runtime::Mutex, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::update_transport::{configure_update_client, install_id};
use crate::updater_policy::{endpoint, evaluate_manifest, valid_artifact_url, CheckResult};

const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct UpdateState(Mutex<Session>);

#[derive(Default)]
struct Session {
    pending: Option<PendingUpdate>,
}

struct PendingUpdate {
    update: Update,
    bytes: Option<Vec<u8>>,
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    // Zero means that the server did not send Content-Length.
    total: u64,
}

fn supported_target() -> Result<(), &'static str> {
    if cfg!(all(
        target_os = "macos",
        any(target_arch = "aarch64", target_arch = "x86_64")
    )) || cfg!(all(target_os = "windows", target_arch = "x86_64"))
    {
        Ok(())
    } else {
        Err("unsupported")
    }
}

// The mutex serializes checks, downloads and installation, so a periodic check
// cannot replace the manifest or verified bytes while another command uses them.
#[tauri::command]
pub async fn update_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
    channel: String,
) -> Result<CheckResult, &'static str> {
    supported_target()?;
    let url = endpoint(&channel)?.parse().map_err(|_| "network")?;
    let mut session = state.0.lock().await;
    let id =
        install_id(&app.path().app_config_dir().map_err(|_| "network")?).map_err(|_| "network")?;
    let update = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|_| "network")?
        .timeout(Duration::from_secs(300))
        // Both manifest and artifact requests must stay on their original HTTPS
        // URL; redirects cannot silently change the release host or protocol.
        .configure_client(|client| configure_update_client(client, DOWNLOAD_READ_TIMEOUT))
        .build()
        .map_err(|_| "network")?
        .check()
        .await
        .map_err(|_| "network")?;

    let Some(update) = update else {
        session.pending = None;
        return Ok(CheckResult::default());
    };
    let result = evaluate_manifest(&update.raw_json, &app.package_info().version, &id)?;
    if !result.available {
        session.pending = None;
        return Ok(result);
    }
    if !valid_artifact_url(&update.download_url, &update.version) {
        return Err("network");
    }

    // Preserve a ready download across routine checks only when it is exactly
    // the same release artifact. A newly blocked/ineligible version clears it.
    let bytes = session.pending.take().and_then(|pending| {
        (pending.update.version == update.version
            && pending.update.signature == update.signature
            && pending.update.download_url == update.download_url)
            .then_some(pending.bytes)
            .flatten()
    });
    session.pending = Some(PendingUpdate { update, bytes });
    Ok(result)
}

#[tauri::command]
pub async fn update_download<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, UpdateState>,
) -> Result<(), &'static str> {
    supported_target()?;
    let mut session = state.0.lock().await;
    let pending = session.pending.as_mut().ok_or("not_ready")?;
    if pending.bytes.is_some() {
        return Ok(());
    }
    let mut downloaded = 0;
    let _ = app.emit_to(
        "main",
        "update-progress",
        Progress {
            downloaded: 0,
            total: 0,
        },
    );
    let bytes = pending
        .update
        .download(
            |length, total| {
                downloaded += length as u64;
                let _ = app.emit_to(
                    "main",
                    "update-progress",
                    Progress {
                        downloaded,
                        total: total.unwrap_or(0),
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|error| match error {
            tauri_plugin_updater::Error::Reqwest(_) | tauri_plugin_updater::Error::Network(_) => {
                "network"
            }
            _ => "download_failed",
        })?;
    // download() has verified the Tauri signature before returning these bytes.
    let total = bytes.len() as u64;
    pending.bytes = Some(bytes);
    let _ = app.emit_to(
        "main",
        "update-progress",
        Progress {
            downloaded: total,
            total,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn update_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateState>,
) -> Result<(), &'static str> {
    supported_target()?;
    let mut session = state.0.lock().await;
    if !session
        .pending
        .as_ref()
        .is_some_and(|pending| pending.bytes.is_some())
    {
        return Err("not_ready");
    }
    let pending = session.pending.take().ok_or("not_ready")?;
    let (pending, result) = tauri::async_runtime::spawn_blocking(move || {
        let result = pending
            .update
            .install(pending.bytes.as_deref().expect("download checked above"));
        (pending, result)
    })
    .await
    .map_err(|_| "install_failed")?;
    if result.is_err() {
        session.pending = Some(pending);
        return Err("install_failed");
    }
    // Windows' installer exits this process and relaunches after passive NSIS
    // installation. On macOS use the same native primitive as process::relaunch
    // (the process plugin exposes no public Rust restart function).
    app.request_restart();
    Ok(())
}

#[cfg(all(
    test,
    any(
        all(
            target_os = "macos",
            any(target_arch = "aarch64", target_arch = "x86_64")
        ),
        all(target_os = "windows", target_arch = "x86_64")
    )
))]
#[path = "updater_download_tests.rs"]
mod download_tests;
