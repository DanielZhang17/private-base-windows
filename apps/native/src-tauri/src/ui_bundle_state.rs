use std::{
    cmp::Ordering,
    collections::{BTreeSet, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use semver::Version;
use serde::{Deserialize, Serialize};
use tempfile::{Builder, NamedTempFile, TempDir};

use crate::ui_bundle_archive::{self as archive, Assets, BundleTarget};

pub const READY_TIMEOUT: Duration = Duration::from_secs(20);
pub const JOURNAL_LOCK_WAIT: Duration = Duration::from_secs(5);
const JOURNAL_FILE: &str = "state.json";

fn lock_journal(file: &File, wait: Duration) -> io::Result<()> {
    let deadline = Instant::now() + wait;
    loop {
        match file.try_lock().map_err(io::Error::from) {
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(error);
                }
                thread::sleep(remaining.min(Duration::from_millis(50)));
            }
            result => return result,
        }
    }
}

// Only the lock owner may quarantine a journal it has found corrupt.
fn quarantine_journal(directory: &Path) -> io::Result<()> {
    let backup = Builder::new().prefix("quarantine-").tempdir_in(directory)?;
    fs::rename(
        directory.join(JOURNAL_FILE),
        backup.path().join(JOURNAL_FILE),
    )?;
    let _ = backup.keep();
    Ok(())
}

fn bundle_key(version: &Version) -> String {
    use std::fmt::Write as _;

    // Lowercase hex preserves distinctions in semver prereleases and build
    // metadata even when the filesystem compares names case-insensitively.
    let mut key = String::from("bundle-");
    for byte in version.to_string().bytes() {
        write!(key, "{byte:02x}").expect("writing to String cannot fail");
    }
    key
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[default]
    Stable,
    Beta,
}

impl Channel {
    pub fn name(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub version: Version,
    pub sha256: String,
    pub signature: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    channel: Option<Channel>,
    #[serde(default)]
    good_bundles: Vec<BundleTarget>,
    pending: Option<Pending>,
    trial: Option<Version>,
    high_water: Option<Version>,
    bad: BTreeSet<Version>,
}

impl Journal {
    fn eligible(&self, version: &Version, embedded: &Version) -> bool {
        version.cmp_precedence(embedded) == Ordering::Greater
            && self
                .high_water
                .as_ref()
                .is_none_or(|last| version.cmp_precedence(last) == Ordering::Greater)
            && !self.bad.contains(version)
    }

    fn fail_trial(&mut self) -> bool {
        if let Some(trial) = self.trial.take() {
            self.bad.insert(trial);
            true
        } else {
            false
        }
    }

    fn start_trial(&mut self, version: Version) {
        self.pending = None;
        self.high_water = Some(version.clone());
        self.trial = Some(version);
    }

    fn ready(&mut self, elapsed: Duration, active: &BundleTarget) {
        if elapsed <= READY_TIMEOUT && self.trial.as_ref() == Some(&active.ui_version) {
            self.trial = None;
            // Keep earlier good bundles if they cover a different shell range.
            self.good_bundles.retain(|older| !active.covers(older));
            self.good_bundles.push(active.clone());
        }
    }

    fn referenced_versions(&self) -> impl Iterator<Item = &Version> {
        self.good_bundles
            .iter()
            .map(|target| &target.ui_version)
            .chain(self.trial.as_ref())
            .chain(self.pending.as_ref().map(|pending| &pending.version))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contract {
    pub native_contract: u32,
    pub embedded_ui_version: Version,
    pub embedded_db_schema_version: u32,
}

pub enum Boot {
    Embedded,
    Ota(BundleTarget, Assets),
}

#[derive(Debug)]
enum SaveError {
    Unchanged(io::Error),
    Uncertain(io::Error),
}

impl From<SaveError> for io::Error {
    fn from(error: SaveError) -> Self {
        match error {
            SaveError::Unchanged(error) | SaveError::Uncertain(error) => error,
        }
    }
}

pub struct Store {
    pub directory: PathBuf,
    pub contract: Contract,
    pub shell: Version,
    pub pubkey: String,
    journal: Journal,
    writes_disabled: bool,
    // A second process must never interpret a running process's trial as a failed boot.
    lock: Option<File>,
    #[cfg(test)]
    pub(crate) fail_save: bool,
    #[cfg(test)]
    sync_directory_hook: Option<fn(&mut Store) -> io::Result<()>>,
    #[cfg(test)]
    pub(crate) cached_fixture: Option<(BundleTarget, Assets)>,
    #[cfg(test)]
    cache_read_error: Option<io::ErrorKind>,
}

impl Store {
    pub fn open(
        directory: PathBuf,
        contract: Contract,
        shell: Version,
        pubkey: String,
        lock_wait: Duration,
    ) -> io::Result<Self> {
        let lock = fs::create_dir_all(&directory)
            .and_then(|()| {
                OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(directory.join("lock"))
            })
            .and_then(|lock| {
                // The macOS updater can spawn the new process before the old one exits.
                lock_journal(&lock, lock_wait)?;
                Ok(lock)
            })
            .ok();
        // State writes replace the entire file atomically. A contending process
        // can read that snapshot without taking ownership of the journal.
        let journal = match archive::read_bounded(&directory.join(JOURNAL_FILE), 1024 * 1024) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .inspect_err(|_| {
                    if lock.is_some() {
                        let _ = quarantine_journal(&directory);
                    }
                })
                .map_err(io::Error::from),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Journal::default()),
            Err(error) => Err(error),
        }?;
        Ok(Self {
            directory,
            contract,
            shell,
            pubkey,
            journal,
            writes_disabled: false,
            lock,
            #[cfg(test)]
            fail_save: false,
            #[cfg(test)]
            sync_directory_hook: None,
            #[cfg(test)]
            cached_fixture: None,
            #[cfg(test)]
            cache_read_error: None,
        })
    }

    pub fn for_launch(opened: io::Result<Self>) -> (Boot, Option<Self>) {
        let Ok(mut store) = opened else {
            return (Boot::Embedded, None);
        };
        match store.boot() {
            Ok(boot) => (boot, Some(store)),
            Err(_) => {
                store.disable_writes();
                (store.fallback(), Some(store))
            }
        }
    }

    pub fn is_read_only(&self) -> bool {
        self.writes_disabled || self.lock.is_none()
    }

    pub fn disable_writes(&mut self) {
        self.writes_disabled = true;
    }

    fn save(&mut self, journal: Journal) -> Result<(), SaveError> {
        if self.is_read_only() {
            return Err(SaveError::Unchanged(io::Error::other(
                "OTA journal is read-only",
            )));
        }
        if journal == self.journal {
            return Ok(());
        }
        let previous = self.replace(journal).map_err(SaveError::Unchanged)?;
        if let Err(error) = self.sync_directory() {
            // The new snapshot is already visible. Restore the previous one
            // when possible before returning the write error.
            if self
                .replace(previous)
                .and_then(|_| self.sync_directory())
                .is_ok()
            {
                return Err(SaveError::Unchanged(error));
            }
            self.disable_writes();
            return Err(SaveError::Uncertain(error));
        }
        Ok(())
    }

    fn replace(&mut self, journal: Journal) -> io::Result<Journal> {
        #[cfg(test)]
        if self.fail_save {
            return Err(io::Error::other("injected journal write failure"));
        }
        let mut file = NamedTempFile::new_in(&self.directory)?;
        serde_json::to_writer(&mut file, &journal)?;
        file.flush()?;
        file.as_file().sync_all()?;
        file.persist(self.directory.join(JOURNAL_FILE))?;
        Ok(std::mem::replace(&mut self.journal, journal))
    }

    fn sync_directory(&mut self) -> io::Result<()> {
        #[cfg(test)]
        if let Some(sync) = self.sync_directory_hook {
            return sync(self);
        }
        #[cfg(unix)]
        File::open(&self.directory)?.sync_all()?;
        Ok(())
    }

    pub fn compatible(&self, target: &BundleTarget) -> bool {
        target.compatible(
            self.contract.native_contract,
            &self.shell,
            &self.contract.embedded_ui_version,
            self.contract.embedded_db_schema_version,
        )
    }

    fn load(&self, version: &Version) -> io::Result<Option<(BundleTarget, Assets)>> {
        #[cfg(test)]
        if let Some((target, assets)) = &self.cached_fixture {
            if target.ui_version == *version && self.compatible(target) {
                return Ok(Some((target.clone(), assets.clone())));
            }
        }
        let path = self.directory.join(bundle_key(version));
        // Earlier caches used the raw version. The signed version below still
        // has to match exactly when a legacy path aliases another version.
        let path = if path.try_exists()? {
            path
        } else {
            self.directory.join(version.to_string())
        };
        let read = || archive::load(&path, &self.pubkey);
        #[cfg(test)]
        let read = || {
            self.cache_read_error
                .map_or_else(read, |error| Err(error.into()))
        };
        match read() {
            Ok((manifest, assets)) => Ok((manifest.target.ui_version == *version
                && self.compatible(&manifest.target))
            .then_some((manifest.target, assets))),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound
                        | io::ErrorKind::NotADirectory
                        | io::ErrorKind::InvalidData
                ) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    fn compatible_good(&self) -> impl Iterator<Item = &BundleTarget> {
        self.journal
            .good_bundles
            .iter()
            .rev()
            .filter(|target| self.compatible(target))
    }

    pub fn fallback(&self) -> Boot {
        // Good bundles are recorded in activation order. Check both the saved
        // compatibility and the verified cached contents before serving one.
        self.compatible_good()
            .find_map(|saved| {
                self.load(&saved.ui_version)
                    .ok()
                    .flatten()
                    .filter(|(target, _)| target == saved)
            })
            .map(|(target, assets)| Boot::Ota(target, assets))
            .unwrap_or(Boot::Embedded)
    }

    pub fn boot(&mut self) -> io::Result<Boot> {
        if self.is_read_only() {
            return Ok(self.fallback());
        }
        let mut journal = self.journal.clone();
        if !journal.fail_trial() {
            if let Some(pending) = journal.pending.take() {
                if self.eligible(&pending.version) {
                    if let Some((target, assets)) = self.load(&pending.version)? {
                        journal.start_trial(pending.version);
                        self.save(journal)?;
                        self.prune();
                        return Ok(Boot::Ota(target, assets));
                    }
                }
            }
        }
        self.save(journal)?;
        self.prune();
        Ok(self.fallback())
    }

    pub fn ready(&mut self, elapsed: Duration, target: &BundleTarget) -> io::Result<()> {
        let mut journal = self.journal.clone();
        journal.ready(elapsed, target);
        if journal != self.journal {
            self.save(journal)?;
            self.prune_versions();
        }
        Ok(())
    }

    pub fn eligible(&self, version: &Version) -> bool {
        self.journal
            .eligible(version, &self.contract.embedded_ui_version)
    }

    #[cfg(test)]
    fn channel(&self) -> Channel {
        self.stored_channel().unwrap_or_default()
    }

    pub fn stored_channel(&self) -> Option<Channel> {
        self.journal.channel
    }

    pub fn set_channel(&mut self, channel: Channel) -> io::Result<()> {
        if Some(channel) != self.stored_channel() {
            let mut journal = self.journal.clone();
            journal.channel = Some(channel);
            journal.pending = None;
            self.save(journal)?;
            self.prune_versions();
        }
        Ok(())
    }

    pub fn initialize_channel(&mut self, channel: Channel) -> io::Result<()> {
        if self.stored_channel().is_none() {
            self.set_channel(channel)?;
        }
        Ok(())
    }

    pub fn pending(&self) -> Option<&Pending> {
        self.journal.pending.as_ref()
    }

    #[cfg(desktop)]
    pub fn prepare_restart(&mut self) -> bool {
        if self.is_read_only() || self.journal.trial.is_some() {
            return false;
        }
        let Some(pending) = self.pending() else {
            return false;
        };
        if !self.eligible(&pending.version)
            || !self
                .load(&pending.version)
                .is_ok_and(|bundle| bundle.is_some())
        {
            return false;
        }
        // The running worker and channel commands must leave this bundle
        // pending between accepting the restart and exiting the process.
        self.disable_writes();
        true
    }

    pub fn withdraw_pending(&mut self) -> io::Result<()> {
        let mut journal = self.journal.clone();
        journal.pending = None;
        self.save(journal)?;
        self.prune_versions();
        Ok(())
    }

    pub fn promote(&mut self, stage: TempDir, pending: Pending) -> io::Result<()> {
        let path = self.directory.join(bundle_key(&pending.version));
        fs::rename(stage.path(), &path)?;
        let mut journal = self.journal.clone();
        journal.pending = Some(pending);
        match self.save(journal) {
            Ok(()) => self.prune_versions(),
            Err(SaveError::Unchanged(error)) => {
                let _ = fs::remove_dir_all(path);
                return Err(error);
            }
            // The replacement might survive a crash, so retain its bundle.
            Err(SaveError::Uncertain(error)) => return Err(error),
        }
        Ok(())
    }

    fn prune(&self) {
        self.prune_matching(true);
    }

    fn prune_versions(&self) {
        self.prune_matching(false);
    }

    fn prune_matching(&self, staging: bool) {
        let Ok(entries) = self.directory.read_dir() else {
            return;
        };
        let retained: HashSet<_> = self
            .journal
            .referenced_versions()
            .flat_map(|version| [bundle_key(version), version.to_string()])
            .collect();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let orphaned = (name.starts_with("bundle-") || Version::parse(&name).is_ok())
                && !retained.contains(name.as_ref());
            if orphaned || (staging && name.starts_with("staging-")) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(patch: u64) -> Version {
        Version::new(0, 1, patch)
    }

    fn target(patch: u64, schema: u32, max_shell: Option<Version>) -> BundleTarget {
        BundleTarget {
            ui_version: version(patch),
            native_contract: 1,
            min_shell_version: version(3),
            max_shell_version: max_shell,
            db_schema_version: schema,
        }
    }

    fn open(directory: &std::path::Path) -> io::Result<Store> {
        open_with_wait(directory, Duration::ZERO)
    }

    fn open_with_wait(directory: &std::path::Path, wait: Duration) -> io::Result<Store> {
        Store::open(
            directory.to_owned(),
            Contract {
                native_contract: 1,
                embedded_ui_version: version(3),
                embedded_db_schema_version: 9,
            },
            version(3),
            "test".into(),
            wait,
        )
    }

    #[test]
    fn updater_relaunch_waits_for_the_old_process_to_release_the_journal() {
        use std::sync::mpsc;

        let directory = tempfile::tempdir().unwrap();
        let mut old = open(directory.path()).unwrap();
        old.set_channel(Channel::Beta).unwrap();
        let path = directory.path().to_owned();
        let (started, starting) = mpsc::channel();
        let (opened, opening) = mpsc::channel();
        let relaunch = thread::spawn(move || {
            started.send(()).unwrap();
            let result = open_with_wait(&path, Duration::from_secs(2)).map(|mut store| {
                (
                    store.boot().map(|boot| matches!(boot, Boot::Embedded)),
                    store.channel(),
                )
            });
            opened.send(result).unwrap();
        });
        starting.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(matches!(
            opening.recv_timeout(Duration::from_millis(120)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        drop(old);
        let (boot, channel) = opening
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        assert!(boot.unwrap());
        assert_eq!(channel, Channel::Beta);
        relaunch.join().unwrap();
    }

    fn quarantined_journal(directory: &Path) -> PathBuf {
        let backups: Vec<_> = directory
            .read_dir()
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("quarantine-")
                    && entry.file_type().unwrap().is_dir()
            })
            .collect();
        assert_eq!(backups.len(), 1);
        backups[0].path().join(JOURNAL_FILE)
    }

    #[test]
    fn lock_timeout_reads_last_good_without_touching_a_running_trials_journal() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let mut old = open(path).unwrap();
        let good = target(4, 9, None);
        let mut journal = Journal {
            channel: Some(Channel::Beta),
            good_bundles: vec![good.clone()],
            ..Journal::default()
        };
        journal.start_trial(version(5));
        old.save(journal).unwrap();
        let cache = path.join(bundle_key(&good.ui_version));
        let orphan = path.join(bundle_key(&version(6)));
        fs::create_dir(&cache).unwrap();
        fs::create_dir(&orphan).unwrap();
        let original = fs::read(path.join(JOURNAL_FILE)).unwrap();

        let (boot, active) = Store::for_launch(open_with_wait(path, Duration::from_millis(25)));
        // Journal metadata alone cannot authorize cached assets.
        assert!(matches!(boot, Boot::Embedded));
        let mut snapshot = active.unwrap();
        assert!(snapshot.is_read_only());
        assert_eq!(snapshot.compatible_good().next(), Some(&good));
        assert_eq!(snapshot.journal.trial, Some(version(5)));
        assert!(snapshot.journal.bad.is_empty());
        let assets = Assets::from([("index.html".into(), b"last good".to_vec())]);
        snapshot.cached_fixture = Some((good.clone(), assets.clone()));
        assert!(matches!(snapshot.boot().unwrap(),
            Boot::Ota(target, cached) if target == good && cached == assets));
        assert!(snapshot.set_channel(Channel::Stable).is_err());
        assert!(cache.is_dir());
        assert!(orphan.is_dir());
        assert_eq!(path.read_dir().unwrap().count(), 4); // journal, lock and two caches
        assert_eq!(fs::read(path.join(JOURNAL_FILE)).unwrap(), original);
        assert_eq!(old.channel(), Channel::Beta);
        drop(snapshot);
        drop(old);

        // Older builds could leave this marker on contention. It carries no
        // evidence of corruption, so the new owner ignores it.
        fs::write(path.join("quarantine-requested"), []).unwrap();
        let (boot, active) = Store::for_launch(open(path));
        assert!(matches!(boot, Boot::Embedded));
        let active = active.unwrap();
        assert!(!active.is_read_only());
        assert_eq!(active.channel(), Channel::Beta);
        assert_eq!(active.compatible_good().next(), Some(&good));
        assert!(cache.is_dir());
        assert!(active.journal.bad.contains(&version(5)));
    }

    #[test]
    fn invalid_json_is_quarantined_but_an_unreadable_journal_is_left_in_place() {
        for non_file in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let directory = root.path().join("ui-bundles");
            fs::create_dir(&directory).unwrap();
            let journal = directory.join(JOURNAL_FILE);
            let orphan = directory.join(bundle_key(&version(4)));
            let profile = root.path().join("profile-fixture");
            fs::write(&profile, "outside OTA storage").unwrap();
            if non_file {
                fs::create_dir(&journal).unwrap();
                fs::write(journal.join("fixture"), "original").unwrap();
            } else {
                fs::write(&journal, "original").unwrap();
                fs::create_dir(&orphan).unwrap();
            }

            let (boot, active) = Store::for_launch(open(&directory));
            assert!(matches!(boot, Boot::Embedded));
            assert!(active.is_none());
            if non_file {
                assert_eq!(
                    fs::read_to_string(journal.join("fixture")).unwrap(),
                    "original"
                );
                assert_eq!(directory.read_dir().unwrap().count(), 2);
                fs::remove_dir_all(&journal).unwrap();
            } else {
                assert!(!journal.exists());
                assert!(orphan.is_dir());
                assert_eq!(
                    fs::read_to_string(quarantined_journal(&directory)).unwrap(),
                    "original"
                );
            }
            assert_eq!(fs::read_to_string(profile).unwrap(), "outside OTA storage");

            let (boot, active) = Store::for_launch(open(&directory));
            assert!(matches!(boot, Boot::Embedded));
            assert!(!active.unwrap().is_read_only());
            assert!(!orphan.exists());
        }
    }

    #[test]
    fn a_failed_boot_write_keeps_the_last_journal_and_never_prunes_the_cache() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let mut store = open(path).unwrap();
        let mut journal = store.journal.clone();
        journal.start_trial(version(4));
        store.save(journal).unwrap();
        let original = fs::read(path.join(JOURNAL_FILE)).unwrap();
        let cache = path.join(bundle_key(&version(4)));
        fs::create_dir(&cache).unwrap();
        store.fail_save = true;

        let (boot, active) = Store::for_launch(Ok(store));
        assert!(matches!(boot, Boot::Embedded));
        let snapshot = active.unwrap();
        assert!(snapshot.is_read_only());
        assert!(snapshot.journal.bad.is_empty());
        assert_eq!(fs::read(path.join(JOURNAL_FILE)).unwrap(), original);
        assert!(cache.is_dir());
        assert_eq!(path.read_dir().unwrap().count(), 3);
    }

    #[test]
    fn a_failed_directory_sync_restores_the_previous_channel() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let mut store = open(path).unwrap();
        store.set_channel(Channel::Beta).unwrap();
        let state = path.join(JOURNAL_FILE);
        let original = fs::read(&state).unwrap();
        store.sync_directory_hook = Some(|store| {
            let bytes = fs::read(store.directory.join(JOURNAL_FILE)).unwrap();
            assert_eq!(
                serde_json::from_slice::<Journal>(&bytes).unwrap(),
                store.journal
            );
            Err(io::Error::other("injected directory sync failure"))
        });

        assert!(store.set_channel(Channel::Stable).is_err());
        assert!(store.is_read_only());
        assert_eq!(store.channel(), Channel::Beta);
        assert_eq!(fs::read(&state).unwrap(), original);
        drop(store);

        let (boot, store) = Store::for_launch(open(path));
        assert!(matches!(boot, Boot::Embedded));
        assert_eq!(store.unwrap().channel(), Channel::Beta);
    }

    #[test]
    fn promotion_keeps_the_bundle_if_the_journal_replacement_may_survive() {
        for replacement_failed in [true, false] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path();
            let mut store = open(path).unwrap();
            store.set_channel(Channel::Beta).unwrap();
            if replacement_failed {
                store.fail_save = true;
            } else {
                store.sync_directory_hook = Some(|store| {
                    // Fail the attempt to restore the prior snapshot as well.
                    store.fail_save = true;
                    Err(io::Error::other("injected directory sync failure"))
                });
            }

            let stage = tempfile::tempdir_in(path).unwrap();
            fs::write(stage.path().join("fixture"), b"promoted content").unwrap();
            let pending = Pending {
                version: version(4),
                sha256: "test".into(),
                signature: "test".into(),
            };
            let bundle = path.join(bundle_key(&pending.version));
            assert!(store.promote(stage, pending.clone()).is_err());
            let expected = (!replacement_failed).then_some(&pending);
            let disk: Journal =
                serde_json::from_slice(&fs::read(path.join(JOURNAL_FILE)).unwrap()).unwrap();
            assert_eq!(disk.pending.as_ref(), expected);
            assert_eq!(store.pending(), expected);
            assert_eq!(store.is_read_only(), !replacement_failed);
            if replacement_failed {
                assert!(!bundle.exists());
            } else {
                assert_eq!(
                    fs::read(bundle.join("fixture")).unwrap(),
                    b"promoted content"
                );
            }
        }
    }

    #[test]
    fn promotion_can_retry_after_the_previous_journal_is_restored_and_synced() {
        let root = tempfile::tempdir().unwrap();
        let mut store = open(root.path()).unwrap();
        store.set_channel(Channel::Beta).unwrap();
        let state = root.path().join(JOURNAL_FILE);
        let original = fs::read(&state).unwrap();
        store.sync_directory_hook = Some(|store| {
            store.sync_directory_hook = None;
            Err(io::Error::other("injected directory sync failure"))
        });
        let stage = || {
            let stage = tempfile::tempdir_in(root.path()).unwrap();
            fs::write(stage.path().join("fixture"), b"verified archive").unwrap();
            stage
        };
        let pending = Pending {
            version: version(4),
            sha256: "test".into(),
            signature: "test".into(),
        };
        let bundle = root.path().join(bundle_key(&pending.version));
        assert!(store.promote(stage(), pending.clone()).is_err());
        assert!(!store.is_read_only());
        assert_eq!(fs::read(state).unwrap(), original);
        assert!(store.pending().is_none());
        assert!(!bundle.exists());

        store.promote(stage(), pending.clone()).unwrap();
        assert_eq!(store.pending(), Some(&pending));
        assert_eq!(
            fs::read(bundle.join("fixture")).unwrap(),
            b"verified archive"
        );
    }

    #[test]
    fn an_io_error_opening_the_lock_still_allows_a_read_only_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let mut store = open(path).unwrap();
        store.set_channel(Channel::Beta).unwrap();
        drop(store);
        let original = fs::read(path.join(JOURNAL_FILE)).unwrap();
        fs::remove_file(path.join("lock")).unwrap();
        fs::create_dir(path.join("lock")).unwrap();

        let (boot, active) = Store::for_launch(open(path));
        assert!(matches!(boot, Boot::Embedded));
        let snapshot = active.unwrap();
        assert!(snapshot.is_read_only());
        assert_eq!(snapshot.channel(), Channel::Beta);
        assert_eq!(fs::read(path.join(JOURNAL_FILE)).unwrap(), original);
        assert_eq!(path.read_dir().unwrap().count(), 2);
    }

    #[test]
    fn case_distinct_versions_can_be_promoted_and_pruned_independently() {
        let root = tempfile::tempdir().unwrap();
        let mut store = open(root.path()).unwrap();
        let upper = Version::parse("0.1.4-Beta.1").unwrap();
        let lower = Version::parse("0.1.4-beta.1").unwrap();
        assert_eq!(lower.cmp_precedence(&upper), Ordering::Greater);
        let mut good = target(4, 9, None);
        good.ui_version = upper.clone();
        let mut journal = store.journal.clone();
        journal.good_bundles.push(good);
        store.save(journal).unwrap();

        let previous = root.path().join(bundle_key(&upper));
        let legacy = root.path().join(upper.to_string());
        fs::create_dir(&previous).unwrap();
        fs::create_dir(legacy.clone()).unwrap();
        fs::write(previous.join("fixture"), "previous good").unwrap();
        let staging = tempfile::tempdir_in(root.path()).unwrap();
        fs::write(staging.path().join("fixture"), "new pending").unwrap();
        store
            .promote(
                staging,
                Pending {
                    version: lower.clone(),
                    sha256: "test".into(),
                    signature: "test".into(),
                },
            )
            .unwrap();
        let pending = root.path().join(bundle_key(&lower));
        assert_ne!(
            bundle_key(&upper).to_ascii_lowercase(),
            bundle_key(&lower).to_ascii_lowercase()
        );
        assert_eq!(
            fs::read_to_string(previous.join("fixture")).unwrap(),
            "previous good"
        );
        assert_eq!(
            fs::read_to_string(pending.join("fixture")).unwrap(),
            "new pending"
        );
        assert!(legacy.is_dir());

        store.withdraw_pending().unwrap();
        assert!(!pending.exists());
        assert!(previous.is_dir());
        assert!(legacy.is_dir());
    }

    #[test]
    fn an_interrupted_trial_is_marked_bad_only_after_the_owner_releases_the_lock() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = open(directory.path()).unwrap();
        let mut journal = store.journal.clone();
        journal.good_bundles.push(target(4, 9, None));
        journal.start_trial(version(5));
        store.save(journal).unwrap();
        let lock = OpenOptions::new()
            .write(true)
            .open(directory.path().join("lock"))
            .unwrap();
        assert!(lock_journal(&lock, Duration::ZERO).is_err());
        drop(store);

        let mut restarted = open(directory.path()).unwrap();
        // The cached version has no signed assets in this fixture.
        assert!(matches!(restarted.boot().unwrap(), Boot::Embedded));
        assert_eq!(
            restarted.compatible_good().next().unwrap().ui_version,
            version(4)
        );
        assert!(restarted.journal.bad.contains(&version(5)));
        drop(restarted);
        assert!(!open(directory.path()).unwrap().eligible(&version(5)));
    }

    #[test]
    fn staging_activation_and_rollback_leave_the_webview_profile_untouched() {
        let root = tempfile::tempdir().unwrap();
        let ota_dir = root.path().join("ui-bundles");
        let profile = root.path().join("app_webview");
        fs::create_dir(&profile).unwrap();
        let local_storage = profile.join("Local Storage");
        let indexed_db = profile.join("IndexedDB");
        fs::write(&local_storage, b"existing account and preferences").unwrap();
        fs::write(&indexed_db, b"existing vault and messages").unwrap();
        let assert_profile = || {
            assert_eq!(
                fs::read(&local_storage).unwrap(),
                b"existing account and preferences"
            );
            assert_eq!(
                fs::read(&indexed_db).unwrap(),
                b"existing vault and messages"
            );
        };

        let offered = target(4, 9, None);
        let mut store = open(&ota_dir).unwrap();
        store
            .promote(
                tempfile::tempdir_in(&ota_dir).unwrap(),
                Pending {
                    version: offered.ui_version.clone(),
                    sha256: "test".into(),
                    signature: "test".into(),
                },
            )
            .unwrap();
        assert_profile();
        drop(store);

        let mut trial = open(&ota_dir).unwrap();
        trial.cached_fixture = Some((offered.clone(), Assets::new()));
        assert!(matches!(trial.boot().unwrap(), Boot::Ota(active, _) if active == offered));
        assert_profile();
        drop(trial);

        let mut rollback = open(&ota_dir).unwrap();
        assert!(matches!(rollback.boot().unwrap(), Boot::Embedded));
        assert!(rollback.journal.bad.contains(&offered.ui_version));
        assert_profile();
    }

    #[test]
    fn acknowledges_only_within_boot_deadline() {
        let mut journal = Journal::default();
        journal.start_trial(version(5));
        journal.ready(READY_TIMEOUT, &target(5, 9, None));
        assert_eq!(journal.good_bundles[0].ui_version, version(5));
        assert!(!journal.fail_trial());

        journal.start_trial(version(6));
        journal.ready(
            READY_TIMEOUT + Duration::from_millis(1),
            &target(6, 9, None),
        );
        assert!(journal.fail_trial());
        assert_eq!(journal.good_bundles[0].ui_version, version(5));
        assert!(journal.bad.contains(&version(6)));
        assert!(!journal.fail_trial());
    }

    #[test]
    fn rollback_does_not_lower_the_activation_floor() {
        let mut journal = Journal::default();
        assert!(!journal.eligible(&version(3), &version(3)));
        assert!(journal.eligible(&version(4), &version(3)));
        journal.start_trial(version(6));
        assert!(journal.fail_trial());
        assert!(!journal.eligible(&version(5), &version(3)));
        assert!(!journal.eligible(&Version::parse("0.1.6+retry").unwrap(), &version(3)));
        assert!(journal.eligible(&version(7), &version(3)));
        assert!(!journal.eligible(&version(7), &version(8)));
    }

    #[test]
    fn pending_and_good_bundles_must_match_the_embedded_schema() {
        for schema in [8, 9, 10] {
            let directory = tempfile::tempdir().unwrap();
            let mut store = open(directory.path()).unwrap();
            let cached = target(4, schema, None);
            let assets = Assets::from([("index.html".into(), b"verified fixture".to_vec())]);
            store.cached_fixture = Some((cached.clone(), assets.clone()));
            let mut journal = Journal {
                good_bundles: vec![cached.clone()],
                ..Journal::default()
            };
            store.save(journal.clone()).unwrap();
            if schema == 9 {
                assert!(matches!(store.fallback(), Boot::Ota(target, bytes)
                    if target == cached && bytes == assets));
            } else {
                assert!(matches!(store.fallback(), Boot::Embedded));
            }

            journal.good_bundles.clear();
            journal.pending = Some(Pending {
                version: cached.ui_version.clone(),
                sha256: "test".into(),
                signature: "test".into(),
            });
            store.save(journal).unwrap();
            if schema == 9 {
                assert!(matches!(store.boot().unwrap(), Boot::Ota(target, _) if target == cached));
                assert_eq!(store.journal.trial, Some(cached.ui_version));
            } else {
                assert!(matches!(store.boot().unwrap(), Boot::Embedded));
                assert!(store.journal.trial.is_none());
            }
        }
    }

    #[cfg(desktop)]
    #[test]
    fn restart_requires_a_verified_pending_bundle_and_keeps_it_pending() {
        let root = tempfile::tempdir().unwrap();
        let mut store = open(root.path()).unwrap();
        assert!(!store.prepare_restart());
        store.set_channel(Channel::Beta).unwrap();
        let cached = target(4, 9, None);
        let pending = Pending {
            version: cached.ui_version.clone(),
            sha256: "test".into(),
            signature: "test".into(),
        };
        store
            .promote(tempfile::tempdir_in(root.path()).unwrap(), pending.clone())
            .unwrap();
        assert!(!store.prepare_restart());
        store.cached_fixture = Some((
            cached,
            Assets::from([("index.html".into(), b"verified fixture".to_vec())]),
        ));
        let active = target(3, 9, None);
        store.journal.trial = Some(active.ui_version.clone());
        assert!(!store.prepare_restart());
        assert_eq!(store.pending(), Some(&pending));
        store.ready(Duration::from_secs(1), &active).unwrap();
        assert!(store.prepare_restart());
        assert!(!store.prepare_restart());
        assert!(store.set_channel(Channel::Stable).is_err());
        assert_eq!(store.pending(), Some(&pending));
        assert_eq!(store.stored_channel(), Some(Channel::Beta));
    }

    #[test]
    fn a_temporarily_unreadable_pending_bundle_survives_for_the_next_launch() {
        let root = tempfile::tempdir().unwrap();
        let mut store = open(root.path()).unwrap();
        let good = target(4, 9, None);
        let pending_target = target(5, 9, None);
        let assets = Assets::from([("index.html".into(), b"verified fixture".to_vec())]);
        let mut journal = store.journal.clone();
        journal.good_bundles.push(good.clone());
        store.save(journal).unwrap();
        let stage = tempfile::tempdir_in(root.path()).unwrap();
        fs::write(stage.path().join("bundle.tar.gz"), b"staged archive").unwrap();
        let pending = Pending {
            version: pending_target.ui_version.clone(),
            sha256: "test".into(),
            signature: "test".into(),
        };
        store.promote(stage, pending.clone()).unwrap();
        store.cached_fixture = Some((good.clone(), assets.clone()));
        store.cache_read_error = Some(io::ErrorKind::PermissionDenied);
        let journal = root.path().join(JOURNAL_FILE);
        let original = fs::read(&journal).unwrap();
        let bundle = root
            .path()
            .join(bundle_key(&pending.version))
            .join("bundle.tar.gz");

        let (boot, snapshot) = Store::for_launch(Ok(store));
        assert!(matches!(boot, Boot::Ota(target, _) if target == good));
        let snapshot = snapshot.unwrap();
        assert!(snapshot.is_read_only());
        assert_eq!(snapshot.pending(), Some(&pending));
        assert_eq!(fs::read(&journal).unwrap(), original);
        assert_eq!(fs::read(bundle).unwrap(), b"staged archive");
        drop(snapshot);

        let mut reopened = open(root.path()).unwrap();
        reopened.cached_fixture = Some((pending_target.clone(), assets));
        assert!(
            matches!(reopened.boot().unwrap(), Boot::Ota(target, _) if target == pending_target)
        );
        assert!(reopened.pending().is_none());
    }

    #[test]
    fn missing_or_invalid_pending_archives_are_discarded() {
        for invalid in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let mut store = open(root.path()).unwrap();
            let stage = tempfile::tempdir_in(root.path()).unwrap();
            if invalid {
                fs::write(stage.path().join("bundle.tar.gz"), b"invalid").unwrap();
                fs::write(stage.path().join("bundle.tar.gz.sig"), b"invalid").unwrap();
            }
            let pending = Pending {
                version: version(4),
                sha256: "test".into(),
                signature: "test".into(),
            };
            let bundle = root.path().join(bundle_key(&pending.version));
            store.promote(stage, pending).unwrap();
            assert!(matches!(store.boot().unwrap(), Boot::Embedded));
            assert!(!store.is_read_only());
            assert!(store.pending().is_none());
            assert!(!bundle.exists());
        }
    }

    #[test]
    fn rollback_considers_the_newest_compatible_good_version_and_prefers_matching_embedded() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = open(directory.path()).unwrap();
        let mut journal = Journal {
            good_bundles: vec![
                target(4, 10, None),
                target(5, 9, None),
                target(6, 9, Some(version(4))),
                target(7, 9, None),
            ],
            ..Journal::default()
        };
        journal.good_bundles[3].min_shell_version = version(4);
        store.save(journal).unwrap();
        assert_eq!(
            store
                .compatible_good()
                .map(|target| target.ui_version.clone())
                .collect::<Vec<_>>(),
            vec![version(6), version(5)]
        );
        store.contract.embedded_ui_version = version(6);
        assert!(store.compatible_good().next().is_none());
        assert!(matches!(store.boot().unwrap(), Boot::Embedded));
    }

    #[test]
    fn failed_channel_save_preserves_pending_and_readiness_preserves_native_preference() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = open(directory.path()).unwrap();
        store.initialize_channel(Channel::Beta).unwrap();
        let mut journal = store.journal.clone();
        journal.pending = Some(Pending {
            version: version(4),
            sha256: "test".into(),
            signature: "test".into(),
        });
        store.save(journal).unwrap();

        let state = directory.path().join("state.json");
        let backup = directory.path().join("backup.json");
        fs::rename(&state, &backup).unwrap();
        fs::create_dir(&state).unwrap();
        assert!(store.set_channel(Channel::Stable).is_err());
        assert_eq!(store.channel(), Channel::Beta);
        assert!(store.pending().is_some());
        fs::remove_dir(&state).unwrap();
        fs::rename(&backup, &state).unwrap();

        store.set_channel(Channel::Stable).unwrap();
        store.initialize_channel(Channel::Beta).unwrap();
        drop(store);
        let restarted = open(directory.path()).unwrap();
        assert_eq!(restarted.channel(), Channel::Stable);
        assert!(restarted.pending().is_none());
    }
}
