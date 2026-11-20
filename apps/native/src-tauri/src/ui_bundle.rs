use std::{
    borrow::Cow,
    cmp::Ordering,
    io,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use semver::Version;
use serde::Deserialize;
use tauri::{
    http::header::{HeaderValue, CACHE_CONTROL},
    utils::{
        assets::{AssetKey, AssetsIter, CspHash},
        config::WindowConfig,
    },
    AppHandle, Assets, Context, Manager, Runtime, WebviewWindowBuilder, Wry,
};
use tokio::{sync::watch, time::timeout};

use crate::{
    ui_bundle_archive::{self as archive, BundleTarget},
    ui_bundle_http::Client,
    ui_bundle_state::{Boot, Contract, Pending, Store, JOURNAL_LOCK_WAIT},
    update_transport::{install_id, rollout_bucket, RELEASE_BASE},
};

pub use crate::ui_bundle_state::Channel;
pub use archive::validate_archive;

macro_rules! ota_debug {
    ($($arg:tt)*) => {
        #[cfg(all(debug_assertions, target_os = "android"))]
        $crate::ota::debug_log(format_args!($($arg)*));
    };
}

#[cfg(target_os = "android")]
pub(crate) use ota_debug;

#[cfg(all(debug_assertions, target_os = "android"))]
pub(crate) fn debug_log(message: std::fmt::Arguments<'_>) {
    use std::ffi::{c_char, c_int, CString};

    #[link(name = "log")]
    extern "C" {
        fn __android_log_write(priority: c_int, tag: *const c_char, text: *const c_char) -> c_int;
    }

    if let Ok(message) = CString::new(message.to_string()) {
        // ANDROID_LOG_DEBUG. Both pointers are valid for the duration of the call.
        unsafe { __android_log_write(3, c"PrivateBaseOTA".as_ptr(), message.as_ptr()) };
    }
}

const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const METERED_RETRY: Duration = Duration::from_secs(60);
const DISCOVERY_LIMIT: usize = 64 * 1024;

type RuntimeState = Arc<Session>;

struct Session {
    store: Mutex<Store>,
    active_ota: Option<BundleTarget>,
    started: Instant,
    preference: watch::Sender<u64>,
}

struct AssetSource {
    embedded: OnceLock<Box<dyn Assets<Wry>>>,
    active: OnceLock<archive::Assets>,
}

struct BundleAssets(Arc<AssetSource>);

impl Assets<Wry> for BundleAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        match self.0.active.get() {
            Some(assets) => assets
                .get(key.as_ref().trim_start_matches('/'))
                .map(|bytes| Cow::Borrowed(bytes.as_slice())),
            None => self.0.embedded.get()?.get(key),
        }
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        match self.0.active.get() {
            Some(assets) => Box::new(assets.iter().map(|(path, bytes)| {
                (
                    Cow::Borrowed(path.as_str()),
                    Cow::Borrowed(bytes.as_slice()),
                )
            })),
            None => self.0.embedded.get().expect("embedded asset source").iter(),
        }
    }

    fn csp_hashes(&self, key: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        match self.0.active.get() {
            // The native web build uses external scripts and styles. Tauri
            // still applies the shell's CSP to OTA HTML, including SPA routes.
            Some(_) => Box::new(std::iter::empty()),
            None => self
                .0
                .embedded
                .get()
                .expect("embedded asset source")
                .csp_hashes(key),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Discovery {
    #[serde(flatten)]
    target: BundleTarget,
    url: String,
    signature: String,
    sha256: String,
    size: usize,
    rollout_percent: u8,
    #[serde(default)]
    blocked: Vec<Version>,
}

impl Discovery {
    fn parse(bytes: &[u8], base: &str) -> io::Result<Self> {
        let feed: Self = serde_json::from_slice(bytes)?;
        if !feed.target.valid()
            || feed.url != format!("{base}ui/{}/bundle.tar.gz", feed.target.ui_version)
            || feed.rollout_percent > 100
            || !(1..=archive::MAX_BUNDLE).contains(&feed.size)
            || !(1..=archive::MAX_SIGNATURE).contains(&feed.signature.len())
            || !archive::valid_hash(&feed.sha256)
        {
            return Err(archive::invalid("invalid UI discovery manifest"));
        }
        Ok(feed)
    }

    fn candidate(&self, store: &Store, id: &[u8; 32]) -> Option<Pending> {
        (store.compatible(&self.target)
            && store.eligible(&self.target.ui_version)
            && !self.blocks(&self.target.ui_version)
            && rollout_bucket(id) < u16::from(self.rollout_percent) * 100)
            .then(|| Pending {
                version: self.target.ui_version.clone(),
                sha256: self.sha256.clone(),
                signature: self.signature.clone(),
            })
    }

    fn blocks(&self, version: &Version) -> bool {
        self.blocked
            .iter()
            .any(|blocked| blocked.cmp_precedence(version) == Ordering::Equal)
    }

    fn withdraws(&self, pending: &Pending, candidate: Option<&Pending>) -> bool {
        self.blocks(&pending.version)
            || (self.target.ui_version.cmp_precedence(&pending.version) == Ordering::Equal
                && candidate != Some(pending))
    }

    fn matches(&self, signed: &BundleTarget) -> bool {
        &self.target == signed
    }
}

#[cfg_attr(all(debug_assertions, target_os = "android"), derive(Debug))]
enum CheckFailure {
    Discovery,
    Metered,
    Transfer,
    Archive,
}

fn archive_transfer_failure(error: io::Error) -> CheckFailure {
    ota_debug!("Archive request failed: {error}");
    match error.kind() {
        io::ErrorKind::WouldBlock => CheckFailure::Metered,
        io::ErrorKind::InvalidData => CheckFailure::Archive,
        _ => CheckFailure::Transfer,
    }
}

async fn check(
    client: &Client,
    base: &str,
    session: &RuntimeState,
    revision: u64,
    id: &[u8; 32],
) -> Result<(), CheckFailure> {
    let channel = {
        let store = session.store.lock().unwrap();
        if store.is_read_only() {
            ota_debug!("Check skipped: journal is read-only");
            return Ok(());
        }
        let Some(channel) = store.stored_channel() else {
            ota_debug!("Check skipped: channel has not been initialized");
            return Ok(());
        };
        channel.name()
    };
    ota_debug!("Checking {base}{channel}/ui.json (revision {revision})");
    let discovery = client
        .get(format!("{base}{channel}/ui.json"), DISCOVERY_LIMIT)
        .await
        .inspect_err(|_error| {
            ota_debug!("Discovery request failed: {_error}");
        })
        .map_err(|_| CheckFailure::Discovery)?;
    let feed = discovery
        .as_deref()
        .map(|bytes| Discovery::parse(bytes, base))
        .transpose()
        .inspect_err(|_error| {
            ota_debug!("Discovery manifest rejected: {_error}");
        })
        .map_err(|_| CheckFailure::Discovery)?;
    ota_debug!(
        "Discovery offer: {:?}",
        feed.as_ref().map(|feed| &feed.target.ui_version)
    );

    let (pending, directory, key) = {
        let mut store = session.store.lock().unwrap();
        if store.is_read_only() || *session.preference.borrow() != revision {
            ota_debug!("Discovery discarded: journal or channel changed");
            return Ok(());
        }
        let candidate = feed.as_ref().and_then(|feed| feed.candidate(&store, id));
        if let Some(pending) = store.pending() {
            if feed
                .as_ref()
                .is_none_or(|feed| feed.withdraws(pending, candidate.as_ref()))
            {
                store
                    .withdraw_pending()
                    .inspect_err(|_error| {
                        ota_debug!("Pending withdrawal failed: {_error}");
                    })
                    .map_err(|_| CheckFailure::Archive)?;
                ota_debug!("Pending bundle withdrawn");
            } else if candidate.as_ref().is_none_or(|next| {
                next.version.cmp_precedence(&pending.version) != Ordering::Greater
            }) {
                ota_debug!("Keeping pending bundle {}", pending.version);
                return Ok(());
            }
        }
        let Some(pending) = candidate else {
            ota_debug!("No eligible bundle to stage");
            return Ok(());
        };
        (pending, store.directory.clone(), store.pubkey.clone())
    };

    let feed = feed.expect("candidate requires discovery");
    ota_debug!(
        "Downloading archive for {} ({} bytes)",
        pending.version,
        feed.size
    );
    let bytes = client
        .get_archive(feed.url.clone(), feed.size)
        .await
        .map_err(archive_transfer_failure)?
        .ok_or(CheckFailure::Transfer)?;
    ota_debug!(
        "Verifying and staging {} ({} received bytes)",
        pending.version,
        bytes.len()
    );
    let session = session.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if bytes.len() != feed.size || archive::hash(&bytes) != feed.sha256 {
            return Err(archive::invalid("bundle download hash or size mismatch"));
        }
        let (stage, manifest) = archive::stage(&directory, &bytes, &feed.signature, &key)?;
        let mut store = session.store.lock().unwrap();
        if !store.is_read_only()
            && *session.preference.borrow() == revision
            && store.eligible(&pending.version)
            && store.compatible(&manifest.target)
            && feed.matches(&manifest.target)
        {
            ota_debug!("Promoting verified bundle {} to pending", pending.version);
            store.promote(stage, pending)?;
            ota_debug!("Bundle staged successfully");
        } else {
            ota_debug!("Verified archive discarded: policy, journal, or channel no longer matches");
        }
        Ok(())
    })
    .await
    .inspect_err(|_error| {
        ota_debug!("Archive worker failed: {_error}");
    })
    .map_err(|_| CheckFailure::Archive)?
    .inspect_err(|_error| {
        ota_debug!("Archive verification or staging failed: {_error}");
    })
    .map_err(|_| CheckFailure::Archive)
}

async fn run_checks(
    session: RuntimeState,
    mut preference: watch::Receiver<u64>,
    config_dir: std::path::PathBuf,
    base: String,
) {
    ota_debug!("OTA worker waiting for a saved channel (feed {base})");
    if wait_for_channel(&session.store, &mut preference)
        .await
        .is_none()
    {
        ota_debug!("OTA worker stopped before channel initialization");
        return;
    }
    ota_debug!("Channel available, initializing OTA transport and install ID");
    let Ok(client) = Client::new(&base).inspect_err(|_error| {
        ota_debug!("OTA transport setup failed: {_error}");
    }) else {
        return;
    };
    let Some(id) = wait_for_install_id(&config_dir, &mut preference).await else {
        return;
    };
    let mut cadence = CheckCadence::Regular;
    loop {
        let revision = *preference.borrow_and_update();
        let result = check(&client, &base, &session, revision, &id).await;
        #[cfg(all(debug_assertions, target_os = "android"))]
        let local_retry = debug_feed_retry(&base, &result);
        ota_debug!("Check finished: {result:?}");
        cadence = cadence.after(result);
        let delay = cadence.delay();
        #[cfg(all(debug_assertions, target_os = "android"))]
        let delay = local_retry.unwrap_or(delay);
        ota_debug!(
            "Next check in {}s or when the channel changes",
            delay.as_secs()
        );
        match timeout(delay, preference.changed()).await {
            Ok(Ok(())) => cadence = CheckCadence::Regular,
            Ok(Err(_)) => break,
            Err(_) => {}
        }
    }
}

#[cfg(all(debug_assertions, any(target_os = "android", all(test, desktop))))]
fn debug_feed_retry(base: &str, result: &Result<(), CheckFailure>) -> Option<Duration> {
    (crate::ui_bundle_http::android_local_test_http(base)
        && matches!(
            result,
            Err(CheckFailure::Discovery | CheckFailure::Transfer)
        ))
    .then_some(Duration::from_secs(5))
}

async fn wait_for_channel(
    store: &Mutex<Store>,
    preference: &mut watch::Receiver<u64>,
) -> Option<()> {
    loop {
        {
            let store = store.lock().ok()?;
            if store.is_read_only() {
                return None;
            }
            // A new app journal has no channel until the frontend imports
            // the previous choice or the user explicitly selects a channel.
            if store.stored_channel().is_some() {
                return Some(());
            }
        }
        preference.changed().await.ok()?;
    }
}

async fn wait_for_install_id(
    config_dir: &std::path::Path,
    preference: &mut watch::Receiver<u64>,
) -> Option<[u8; 32]> {
    loop {
        let _ = preference.borrow_and_update();
        if let Ok(id) = install_id(config_dir).inspect_err(|_error| {
            ota_debug!("Install ID unavailable: {_error}");
        }) {
            return Some(id);
        }
        if let Ok(Err(_)) = timeout(CHECK_INTERVAL, preference.changed()).await {
            return None;
        }
    }
}

#[derive(Clone, Copy)]
enum CheckCadence {
    Regular,
    Metered,
    HandoffRetry,
}

impl CheckCadence {
    fn after(self, result: Result<(), CheckFailure>) -> Self {
        match (self, result) {
            (_, Err(CheckFailure::Metered)) => Self::Metered,
            (_, Err(CheckFailure::Discovery)) => self,
            // Give an unmetered transfer one short retry after a network handoff.
            (Self::Metered, Err(CheckFailure::Transfer)) => Self::HandoffRetry,
            _ => Self::Regular,
        }
    }

    fn delay(self) -> Duration {
        match self {
            Self::Regular => CHECK_INTERVAL,
            Self::Metered | Self::HandoffRetry => METERED_RETRY,
        }
    }
}

#[tauri::command]
pub fn ui_bundle_ready(app: AppHandle, channel: Channel) -> Result<(), &'static str> {
    let session = app.try_state::<RuntimeState>().ok_or("failed")?;
    let elapsed = session.started.elapsed();
    let mut store = session.store.lock().unwrap();
    if store.is_read_only() {
        return Err("failed");
    }
    if store.stored_channel().is_none() {
        store.initialize_channel(channel).map_err(|_error| {
            ota_debug!("Could not initialize the OTA channel during readiness: {_error}");
            "failed"
        })?;
        ota_debug!(
            "Saved initial OTA channel {} during readiness",
            channel.name()
        );
        session.preference.send_modify(|revision| *revision += 1);
    }
    if let Some(target) = &session.active_ota {
        store.ready(elapsed, target).map_err(|_| "failed")?;
    }
    Ok(())
}

#[tauri::command]
pub fn ui_bundle_set_channel<R: Runtime>(
    app: AppHandle<R>,
    channel: Channel,
) -> Result<(), &'static str> {
    save_channel(app, channel, false)
}

#[tauri::command]
pub fn ui_bundle_initialize_channel<R: Runtime>(
    app: AppHandle<R>,
    channel: Channel,
) -> Result<(), &'static str> {
    save_channel(app, channel, true)
}

fn save_channel<R: Runtime>(
    app: AppHandle<R>,
    channel: Channel,
    initialize: bool,
) -> Result<(), &'static str> {
    let session = app.try_state::<RuntimeState>().ok_or("failed")?;
    let mut store = session.store.lock().unwrap();
    if store.is_read_only() {
        return Err("failed");
    }
    if (!initialize || store.stored_channel().is_none()) && Some(channel) != store.stored_channel()
    {
        store.set_channel(channel).map_err(|_error| {
            ota_debug!("Could not save the OTA channel: {_error}");
            "failed"
        })?;
        ota_debug!(
            "Saved OTA channel {} (initial import: {initialize})",
            channel.name()
        );
        session.preference.send_modify(|revision| *revision += 1);
    }
    Ok(())
}

#[tauri::command]
pub fn ui_bundle_get_channel(app: AppHandle) -> Option<Channel> {
    let session = app.try_state::<RuntimeState>()?;
    let store = session.store.lock().unwrap();
    store.stored_channel()
}

#[tauri::command]
pub fn ui_bundle_get_pending<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    let session = app.try_state::<RuntimeState>()?;
    let store = session.store.try_lock().ok()?;
    if store.is_read_only() {
        return None;
    }
    store.pending().map(|pending| pending.version.to_string())
}

#[tauri::command]
pub async fn ui_bundle_restart<R: Runtime>(app: AppHandle<R>) -> Result<(), &'static str> {
    #[cfg(desktop)]
    {
        let session = app.try_state::<RuntimeState>().ok_or("not_ready")?;
        let session = Arc::clone(session.inner());
        let ready = tauri::async_runtime::spawn_blocking(move || {
            session
                .store
                .lock()
                .is_ok_and(|mut store| store.prepare_restart())
        })
        .await
        .unwrap_or(false);
        if !ready {
            return Err("not_ready");
        }
        app.request_restart();
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("unsupported")
    }
}

#[tauri::command]
pub async fn ui_bundle_is_unmetered() -> Option<bool> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(crate::ui_bundle_http::unmetered)
            .await
            .ok()
            .flatten()
    }
    #[cfg(not(target_os = "android"))]
    None
}

struct Feed {
    directory: std::path::PathBuf,
    key: String,
    base: String,
}

fn release_feed(app: &AppHandle) -> io::Result<Feed> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(io::Error::other)?
        .join("ui-bundles");
    #[cfg(all(debug_assertions, any(desktop, target_os = "android")))]
    if let Some(test) = crate::ui_bundle_test_feed::configured()? {
        let fingerprint = archive::hash(test.key.as_bytes());
        return Ok(Feed {
            directory: directory
                .with_file_name("ui-bundles-test")
                .join(fingerprint),
            key: test.key,
            base: test.base,
        });
    }
    let key = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value["pubkey"].as_str())
        .ok_or_else(|| archive::invalid("missing pinned updater public key"))?;
    Ok(Feed {
        directory,
        key: key.to_owned(),
        base: RELEASE_BASE.to_owned(),
    })
}

pub struct Launch {
    window: WindowConfig,
    source: Arc<AssetSource>,
}

pub fn prepare(context: &mut Context<Wry>) -> Option<Launch> {
    if tauri::is_dev() {
        return None;
    }
    let window = defer_main_window(&mut context.config_mut().app.windows)?;
    let source = Arc::new(AssetSource {
        embedded: OnceLock::new(),
        active: OnceLock::new(),
    });
    let previous = context.set_assets(Box::new(BundleAssets(source.clone())));
    let _ = source.embedded.set(previous);
    Some(Launch { window, source })
}

fn defer_main_window(windows: &mut [WindowConfig]) -> Option<WindowConfig> {
    let window = windows.iter_mut().find(|window| window.label == "main")?;
    // The iOS overlay already defers this window for the protected-data gate.
    // Keep its config so the owner can explicitly create the OTA window later.
    let original = window.clone();
    window.create = false;
    Some(original)
}

fn initialization_script(ota_ui: bool, info: &str) -> String {
    let mode = if ota_ui { "true" } else { r#""read-only""# };
    let restart = ota_ui && cfg!(desktop);
    format!(
        "window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = {{...window.__PRIVATEBASE_NATIVE_CAPABILITIES__, otaUi: {mode}, otaUiRestart: {restart}}}; window.__PRIVATEBASE_UI_BUNDLE__ = {info};"
    )
}

impl Launch {
    pub fn creates_main_on_setup(&self) -> bool {
        self.window.create
    }

    /// Select the process-wide assets before building the overlay's main window.
    pub fn select(self, app: &AppHandle) -> Result<SelectedUi, Box<dyn std::error::Error>> {
        let contract: Contract = serde_json::from_str(include_str!("../../ui-bundle.json"))?;
        let embedded = contract.embedded_ui_version.clone();
        let feed = release_feed(app).inspect_err(|_error| {
            ota_debug!("Could not configure OTA feed: {_error}");
        });
        let base = feed
            .as_ref()
            .map(|feed| feed.base.clone())
            .unwrap_or_default();
        let (boot, store) = Store::for_launch(feed.and_then(|feed| {
            Store::open(
                feed.directory,
                contract,
                app.package_info().version.clone(),
                feed.key,
                JOURNAL_LOCK_WAIT,
            )
            .inspect_err(|_error| {
                ota_debug!("Opening OTA journal failed: {_error}");
            })
        }));
        Ok(self.select_boot(app, boot, store, embedded, base))
    }

    fn select_boot<R: Runtime>(
        self,
        app: &AppHandle<R>,
        boot: Boot,
        store: Option<Store>,
        embedded: Version,
        base: String,
    ) -> SelectedUi {
        let ota_ui = store.as_ref().is_some_and(|store| !store.is_read_only());
        let (ui_version, source, target, assets) = match boot {
            Boot::Embedded => (embedded, "embedded", None, None),
            Boot::Ota(target, assets) => {
                (target.ui_version.clone(), "ota", Some(target), Some(assets))
            }
        };
        ota_debug!("Selected UI {ui_version} from {source} (writable OTA: {ota_ui})");
        if let Some(assets) = assets {
            self.source
                .active
                .set(assets)
                .expect("select UI once per process");
        }
        let info = serde_json::json!({
            "appVersion": app.package_info().version,
            "uiVersion": ui_version,
            "uiSource": source,
        });
        let checks = store.and_then(|store| {
            let (preference, receiver) = watch::channel(0);
            let session = Arc::new(Session {
                store: Mutex::new(store),
                active_ota: target,
                started: Instant::now(),
                preference,
            });
            app.manage(session.clone());
            if !ota_ui {
                return None;
            }
            app.path()
                .app_config_dir()
                .inspect_err(|_error| {
                    ota_debug!("OTA config directory unavailable: {_error}");
                })
                .ok()
                .map(|directory| Checks {
                    session,
                    receiver,
                    directory,
                    base,
                })
        });
        SelectedUi {
            script: initialization_script(ota_ui, &info.to_string()),
            checks: Mutex::new(checks),
        }
    }

    pub fn open_main(self, app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let window = self.window.clone();
        let selected = self.select(app)?;
        selected
            .configure_window(WebviewWindowBuilder::from_config(app, &window)?)
            .build()?;
        selected.start_checks();
        Ok(())
    }
}

pub struct SelectedUi {
    script: String,
    checks: Mutex<Option<Checks>>,
}

struct Checks {
    session: RuntimeState,
    receiver: watch::Receiver<u64>,
    directory: std::path::PathBuf,
    base: String,
}

impl SelectedUi {
    /// Attach the OTA document-start metadata and asset cache policy.
    pub fn configure_window<'a, R: Runtime, M: Manager<R>>(
        &self,
        builder: WebviewWindowBuilder<'a, R, M>,
    ) -> WebviewWindowBuilder<'a, R, M> {
        builder
            .initialization_script(&self.script)
            .on_web_resource_request(|_, response| {
                response
                    .headers_mut()
                    .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
            })
    }

    /// Start background discovery after the main window was built successfully.
    pub fn start_checks(&self) {
        if let Some(checks) = self.checks.lock().unwrap().take() {
            ota_debug!("Starting OTA worker");
            tauri::async_runtime::spawn(run_checks(
                checks.session,
                checks.receiver,
                checks.directory,
                checks.base,
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn a_channel_change_retries_install_id_initialization_in_the_same_process() {
        use std::{
            future::{poll_fn, Future},
            task::Poll,
        };

        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let config = root.path().join("config");
            std::fs::write(&config, b"temporarily unavailable").unwrap();
            let (sender, mut receiver) = watch::channel(0);
            let mut initialization = std::pin::pin!(wait_for_install_id(&config, &mut receiver));
            poll_fn(|cx| {
                assert!(initialization.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;

            std::fs::remove_file(&config).unwrap();
            sender.send(1).unwrap();
            let id = timeout(Duration::from_secs(1), initialization)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                std::fs::read(config.join("updater-install-id")).unwrap(),
                id
            );
        });
    }

    #[test]
    fn startup_waits_for_a_persisted_channel_and_skips_the_wait_when_one_exists() {
        use std::{
            future::{poll_fn, Future},
            task::Poll,
        };

        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let store = Mutex::new(store(root.path(), Version::new(0, 1, 3)));
            let (sender, mut receiver) = watch::channel(0);
            {
                let mut startup = std::pin::pin!(wait_for_channel(&store, &mut receiver));
                poll_fn(|cx| {
                    assert!(startup.as_mut().poll(cx).is_pending());
                    Poll::Ready(())
                })
                .await;
                sender.send(1).unwrap();
                poll_fn(|cx| {
                    assert!(startup.as_mut().poll(cx).is_pending());
                    Poll::Ready(())
                })
                .await;
                store
                    .lock()
                    .unwrap()
                    .initialize_channel(Channel::Beta)
                    .unwrap();
                sender.send(2).unwrap();
                assert_eq!(
                    timeout(Duration::from_secs(1), startup).await.unwrap(),
                    Some(())
                );
            }
            assert_eq!(store.lock().unwrap().stored_channel(), Some(Channel::Beta));
            let mut next_launch = sender.subscribe();
            assert_eq!(
                timeout(Duration::ZERO, wait_for_channel(&store, &mut next_launch))
                    .await
                    .unwrap(),
                Some(())
            );
        });
    }

    #[test]
    fn metered_deferral_allows_one_fast_transfer_retry_then_backs_off() {
        let regular = CheckCadence::Regular;
        let metered = regular.after(Err(archive_transfer_failure(
            io::ErrorKind::WouldBlock.into(),
        )));
        assert_eq!(metered.delay(), METERED_RETRY);
        let transitioning = metered.after(Err(CheckFailure::Discovery));
        assert_eq!(transitioning.delay(), METERED_RETRY);
        assert_eq!(transitioning.after(Ok(())).delay(), CHECK_INTERVAL);
        for error in [io::ErrorKind::TimedOut.into(), io::Error::other("HTTP 503")] {
            let failure = archive_transfer_failure(error);
            assert_eq!(transitioning.after(Err(failure)).delay(), METERED_RETRY);
        }
        let retry = transitioning.after(Err(CheckFailure::Transfer));
        assert_eq!(retry.delay(), METERED_RETRY);
        let retry = retry.after(Err(CheckFailure::Discovery));
        assert_eq!(retry.delay(), METERED_RETRY);
        assert_eq!(
            retry.after(Err(CheckFailure::Transfer)).delay(),
            CHECK_INTERVAL
        );
        let metered_again = retry.after(Err(CheckFailure::Metered));
        assert_eq!(
            metered_again.after(Err(CheckFailure::Transfer)).delay(),
            METERED_RETRY
        );
        assert_eq!(
            transitioning
                .after(Err(archive_transfer_failure(
                    io::ErrorKind::InvalidData.into()
                )))
                .delay(),
            CHECK_INTERVAL
        );
        assert_eq!(
            regular.after(Err(CheckFailure::Transfer)).delay(),
            CHECK_INTERVAL
        );
    }

    #[cfg(all(debug_assertions, any(desktop, target_os = "android")))]
    #[test]
    fn local_android_fixtures_retry_failed_requests_without_changing_release_cadence() {
        let base = "http://10.0.2.2:8789/";
        for failure in [CheckFailure::Discovery, CheckFailure::Transfer] {
            assert_eq!(
                debug_feed_retry(base, &Err(failure)),
                Some(Duration::from_secs(5))
            );
        }
        assert!(debug_feed_retry(base, &Err(CheckFailure::Archive)).is_none());
        assert!(debug_feed_retry(base, &Ok(())).is_none());
        for base in [
            RELEASE_BASE,
            "https://10.0.2.2:8789/",
            "http://10.0.2.3:8789/",
        ] {
            assert!(debug_feed_retry(base, &Err(CheckFailure::Discovery)).is_none());
        }
    }

    #[cfg(desktop)]
    #[test]
    fn channel_import_only_writes_an_unset_preference() {
        let app = tauri::test::mock_app();
        let root = tempfile::tempdir().unwrap();
        let (preference, revision) = watch::channel(0);
        let session = Arc::new(Session {
            store: Mutex::new(store(root.path(), Version::new(0, 1, 3))),
            active_ota: None,
            started: Instant::now(),
            preference,
        });
        app.manage(session.clone());
        let handle = app.handle();
        ui_bundle_initialize_channel(handle.clone(), Channel::Beta).unwrap();
        ui_bundle_initialize_channel(handle.clone(), Channel::Stable).unwrap();
        assert_eq!(
            session.store.lock().unwrap().stored_channel(),
            Some(Channel::Beta)
        );
        assert_eq!(*revision.borrow(), 1);
        ui_bundle_set_channel(handle.clone(), Channel::Stable).unwrap();
        assert_eq!(
            session.store.lock().unwrap().stored_channel(),
            Some(Channel::Stable)
        );
        assert_eq!(*revision.borrow(), 2);
    }

    fn feed() -> Value {
        json!({
            "uiVersion": "1.0.1",
            "nativeContract": 1,
            "minShellVersion": "0.1.3",
            "dbSchemaVersion": 9,
            "url": format!("{RELEASE_BASE}ui/1.0.1/bundle.tar.gz"),
            "signature": "c2ln",
            "sha256": archive::hash(b"archive"),
            "size": 7,
            "notes": "A UI release",
            "rolloutPercent": 100,
            "blocked": [],
        })
    }

    fn parse(raw: &Value) -> io::Result<Discovery> {
        Discovery::parse(&serde_json::to_vec(raw).unwrap(), RELEASE_BASE)
    }

    fn store(root: &std::path::Path, shell: Version) -> Store {
        Store::open(
            root.to_owned(),
            Contract {
                native_contract: 1,
                embedded_ui_version: Version::new(1, 0, 0),
                embedded_db_schema_version: 9,
            },
            shell,
            "test".into(),
            Duration::ZERO,
        )
        .unwrap()
    }

    #[test]
    fn restart_capability_requires_a_writable_desktop_session() {
        assert!(initialization_script(false, "null").contains("otaUiRestart: false"));
        assert!(initialization_script(true, "null")
            .contains(&format!("otaUiRestart: {}", cfg!(desktop))));
    }

    #[cfg(desktop)]
    #[test]
    fn pending_command_reads_the_snapshot_and_restart_rejects_an_unverified_cache() {
        let app = tauri::test::mock_app();
        assert_eq!(ui_bundle_get_pending(app.handle().clone()), None);
        let root = tempfile::tempdir().unwrap();
        let mut store = store(root.path(), Version::new(0, 1, 3));
        store.initialize_channel(Channel::Beta).unwrap();
        let discovery = parse(&feed()).unwrap();
        let pending = discovery.candidate(&store, &[0; 32]).unwrap();
        store.cached_fixture = Some((discovery.target, archive::Assets::new()));
        store
            .promote(tempfile::tempdir_in(root.path()).unwrap(), pending)
            .unwrap();
        let original = std::fs::read(root.path().join("state.json")).unwrap();
        let session = Arc::new(Session {
            store: Mutex::new(store),
            active_ota: None,
            started: Instant::now(),
            preference: watch::channel(0).0,
        });
        app.manage(session.clone());
        assert_eq!(
            ui_bundle_get_pending(app.handle().clone()).as_deref(),
            Some("1.0.1")
        );
        {
            let mut store = session.store.lock().unwrap();
            assert_eq!(ui_bundle_get_pending(app.handle().clone()), None);
            store.cached_fixture = None;
        }
        assert_eq!(
            tauri::async_runtime::block_on(ui_bundle_restart(app.handle().clone())),
            Err("not_ready")
        );
        assert_eq!(
            std::fs::read(root.path().join("state.json")).unwrap(),
            original
        );
        session.store.lock().unwrap().disable_writes();
        assert_eq!(ui_bundle_get_pending(app.handle().clone()), None);
    }

    #[cfg(feature = "custom-protocol")]
    #[test]
    fn preparing_an_ota_launch_keeps_the_original_main_window_config() {
        let mut context = tauri::generate_context!();
        let config = context
            .config_mut()
            .app
            .windows
            .iter_mut()
            .find(|window| window.label == "main")
            .unwrap();
        config.data_directory = Some("existing-webview-profile".into());
        let mut original = config.clone();

        let launch = prepare(&mut context).unwrap();
        assert_eq!(launch.window, original);
        original.create = false;
        let deferred = context
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .unwrap();
        assert_eq!(deferred, &original);
    }

    #[cfg(feature = "custom-protocol")]
    #[test]
    fn prepares_a_deferred_main_for_the_protected_data_callback() {
        let mut context = tauri::generate_context!();
        let windows = &mut context.config_mut().app.windows;
        let main = windows
            .iter_mut()
            .find(|window| window.label == "main")
            .unwrap();
        main.create = false; // Already deferred by the iOS overlay.
        let extra = WindowConfig {
            label: "auxiliary".into(),
            ..WindowConfig::default()
        };
        windows.push(extra);

        let launch = prepare(&mut context).expect("deferred main has an OTA launch");
        assert_eq!(launch.window.label, "main");
        assert!(!launch.creates_main_on_setup());
        assert!(launch.source.active.get().is_none());
        let windows = &context.config().app.windows;
        assert!(
            !windows
                .iter()
                .find(|window| window.label == "main")
                .unwrap()
                .create
        );
        assert!(
            windows
                .iter()
                .find(|window| window.label == "auxiliary")
                .unwrap()
                .create
        );
    }

    #[cfg(all(desktop, feature = "custom-protocol"))]
    #[test]
    fn overlay_builder_can_attach_selected_ota_assets_before_creating_main() {
        let mut context = tauri::generate_context!();
        let config = context
            .config_mut()
            .app
            .windows
            .iter_mut()
            .find(|w| w.label == "main")
            .unwrap();
        config.create = false;
        let config = config.clone();
        let launch = prepare(&mut context).unwrap();
        assert!(!launch.creates_main_on_setup());

        let app = tauri::test::mock_app();
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path(), Version::new(0, 1, 3));
        let target = parse(&feed()).unwrap().target;
        let assets = archive::Assets::from([("index.html".into(), b"overlay OTA".to_vec())]);
        let selected = launch.select_boot(
            app.handle(),
            Boot::Ota(target, assets),
            Some(store),
            Version::new(1, 0, 0),
            RELEASE_BASE.to_owned(),
        );
        assert_eq!(
            context.assets().get(&"index.html".into()).unwrap().as_ref(),
            b"overlay OTA"
        );
        assert!(selected.script.contains(r#""uiSource":"ota""#));
        assert!(selected.script.contains(r#""uiVersion":"1.0.1""#));
        assert!(selected
            .script
            .contains(&format!(r#""appVersion":"{}""#, app.package_info().version)));
        assert!(selected.checks.lock().unwrap().is_some());

        let builder = WebviewWindowBuilder::from_config(&app, &config)
            .unwrap()
            .visible(false)
            .content_protected(true)
            .initialization_script("window.overlay = true;");
        let window = selected.configure_window(builder).build().unwrap();
        assert_eq!(window.label(), "main");
    }

    #[test]
    fn a_lock_timeout_keeps_the_saved_channel_for_read_only_documents() {
        let root = tempfile::tempdir().unwrap();
        let mut owner = store(root.path(), Version::new(0, 1, 3));
        owner.set_channel(Channel::Beta).unwrap();
        let (boot, store) = Store::for_launch(Ok(store(root.path(), Version::new(0, 1, 3))));
        assert!(matches!(boot, Boot::Embedded));
        let store = store.unwrap();
        assert!(store.is_read_only());
        assert_eq!(store.stored_channel(), Some(Channel::Beta));
        assert!(initialization_script(false, "null").contains(r#"otaUi: "read-only""#));
    }

    #[test]
    fn discovery_accepts_only_the_fixed_immutable_artifact_and_bounded_policy() {
        let raw = feed();
        assert!(parse(&raw).is_ok());
        for (field, value) in [
            (
                "url",
                json!("https://dist.718788.xyz/private-base/releases/ui/1.0.1/bundle.tar.gz?a"),
            ),
            (
                "url",
                json!("https://dist.718788.xyz/private-base/releases/ui/1.0.0/bundle.tar.gz"),
            ),
            (
                "url",
                json!("https://other.test/private-base/releases/ui/1.0.1/bundle.tar.gz"),
            ),
            ("size", json!(archive::MAX_BUNDLE + 1)),
            ("rolloutPercent", json!(101)),
            ("blocked", json!(["bogus"])),
            ("signature", Value::Null),
            ("sha256", json!("abc")),
            ("maxShellVersion", json!("0.1.2")),
            ("maxShellVersion", json!("latest")),
        ] {
            let mut invalid = raw.clone();
            invalid[field] = value;
            assert!(parse(&invalid).is_err(), "{field}");
        }
    }

    #[cfg(all(debug_assertions, any(desktop, target_os = "android")))]
    #[test]
    fn test_discovery_uses_only_the_configured_artifact_base() {
        let base = "http://127.0.0.1:8789/";
        let mut raw = feed();
        let parse_test = |raw: &Value| Discovery::parse(&serde_json::to_vec(raw).unwrap(), base);
        assert!(parse_test(&raw).is_err());
        raw["url"] = json!(format!("{base}ui/1.0.1/bundle.tar.gz"));
        assert!(parse_test(&raw).is_ok());
        assert!(parse(&raw).is_err());
    }

    #[test]
    fn discovery_gates_rollout_blocking_native_contract_and_shell_minimum() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path(), Version::new(0, 1, 3));
        let mut raw = feed();
        let id = [0; 32]; // Shared full-updater cohort 9175.
        assert!(parse(&raw).unwrap().candidate(&store, &id).is_some());
        raw["rolloutPercent"] = json!(91);
        assert!(parse(&raw).unwrap().candidate(&store, &id).is_none());
        raw["rolloutPercent"] = json!(92);
        assert!(parse(&raw).unwrap().candidate(&store, &id).is_some());
        for (field, value) in [
            ("blocked", json!(["1.0.1+blocked"])),
            ("nativeContract", json!(2)),
            ("dbSchemaVersion", json!(8)),
            ("dbSchemaVersion", json!(10)),
            ("minShellVersion", json!("0.1.4")),
        ] {
            let mut denied = raw.clone();
            denied[field] = value;
            assert!(
                parse(&denied).unwrap().candidate(&store, &id).is_none(),
                "{field}"
            );
        }
    }

    #[test]
    fn discovery_uses_the_embedded_ui_version_even_when_the_shell_version_is_higher() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path(), Version::new(2, 0, 0));
        let mut raw = feed();
        assert!(parse(&raw).unwrap().candidate(&store, &[0; 32]).is_some());
        raw["uiVersion"] = json!("1.0.0");
        raw["url"] = json!(format!("{RELEASE_BASE}ui/1.0.0/bundle.tar.gz"));
        assert!(parse(&raw).unwrap().candidate(&store, &[0; 32]).is_none());
    }

    #[test]
    fn discovery_rejects_shells_above_maximum_before_download_and_binds_the_signed_maximum() {
        let root = tempfile::tempdir().unwrap();
        let at_max = store(root.path(), Version::parse("0.1.3+native-build").unwrap());
        let newer_root = tempfile::tempdir().unwrap();
        let above_max = store(newer_root.path(), Version::new(0, 1, 4));
        let mut raw = feed();
        raw["maxShellVersion"] = json!("0.1.3");
        let bounded = parse(&raw).unwrap();
        assert!(bounded.candidate(&at_max, &[0; 32]).is_some());
        assert!(bounded.candidate(&above_max, &[0; 32]).is_none());

        let mut signed = bounded.target.clone();
        assert!(bounded.matches(&signed));
        signed.max_shell_version = Some(Version::new(0, 1, 4));
        assert!(!bounded.matches(&signed));
        signed.max_shell_version = None;
        assert!(!bounded.matches(&signed));
        assert!(parse(&feed())
            .unwrap()
            .candidate(&above_max, &[0; 32])
            .is_some());
    }

    #[test]
    fn an_unverified_new_offer_keeps_the_prepared_bundle_unless_policy_withdraws_it() {
        let raw = feed();
        let current = parse(&raw).unwrap();
        let pending = Pending {
            version: current.target.ui_version.clone(),
            sha256: current.sha256.clone(),
            signature: current.signature.clone(),
        };
        assert!(!current.withdraws(&pending, Some(&pending)));
        assert!(current.withdraws(&pending, None));

        let mut newer = raw;
        newer["uiVersion"] = json!("1.0.2");
        newer["url"] = json!(format!("{RELEASE_BASE}ui/1.0.2/bundle.tar.gz"));
        assert!(!parse(&newer).unwrap().withdraws(&pending, None));
        newer["blocked"] = json!(["1.0.1+withdrawn"]);
        assert!(parse(&newer).unwrap().withdraws(&pending, None));
    }
}
