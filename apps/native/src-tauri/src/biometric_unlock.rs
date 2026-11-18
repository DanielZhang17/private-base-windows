use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{mpsc, Arc},
    time::Duration,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{aead, hkdf};
use zeroize::{Zeroize, Zeroizing};

#[cfg(windows)]
mod windows_hello;
#[cfg(windows)]
use windows_hello::Keystore;

type Result<T> = std::result::Result<T, &'static str>;
type Key = Zeroizing<[u8; 32]>;
const UNSUPPORTED: &str = "unsupported";
const FAILED: &str = "failed";
const INVALIDATED: &str = "invalidated";

pub(crate) struct BiometricUnlock(Option<Arc<Keystore>>);

impl BiometricUnlock {
    pub(crate) fn probe(app_data: Option<PathBuf>) -> Self {
        Self(
            app_data
                .and_then(|root| Keystore::probe(root.join("biometric-unlock")))
                .map(Arc::new),
        )
    }

    pub(crate) fn capability(&self) -> Option<&'static str> {
        self.0
            .as_ref()
            .filter(|keystore| keystore.offer_hello())
            .map(|_| "windows-hello")
    }

    fn keystore(&self) -> Result<Arc<Keystore>> {
        self.0.as_ref().map(Arc::clone).ok_or(UNSUPPORTED)
    }
}

#[cfg(not(windows))]
enum Keystore {}

#[cfg(not(windows))]
impl Keystore {
    fn probe(_: PathBuf) -> Option<Self> {
        None
    }

    fn enroll(&self, _: String, _: Key) -> Result<()> {
        match *self {}
    }

    fn offer_hello(&self) -> bool {
        match *self {}
    }

    fn unlock(&self, _: String) -> Result<Key> {
        match *self {}
    }

    fn remove(&self, _: String) -> Result<()> {
        match *self {}
    }
}

fn validate_vault_id(id: &str) -> Result<()> {
    // The adapter sends crypto.randomUUID(). Require its canonical form so
    // paths and credential names cannot alias on case-insensitive Windows.
    if id.len() != 36
        || !id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => byte == b'4',
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'),
        })
    {
        return Err(FAILED);
    }
    Ok(())
}

fn decode_key(encoded: &str) -> Result<Key> {
    if encoded.len() != 43 {
        return Err(FAILED);
    }
    let mut key = Zeroizing::new([0; 32]);
    match URL_SAFE_NO_PAD.decode_slice(encoded, &mut key[..]) {
        Ok(32) => Ok(key),
        _ => Err(FAILED),
    }
}

fn hello_status(status: i32, credential_expected: bool) -> Result<()> {
    // KeyCredentialStatus. The SDK bindings do not name value 7.
    match status {
        0 => Ok(()),
        2 if credential_expected => Err(INVALIDATED), // NotFound
        3 | 4 => Err("cancelled"),                    // UserCanceled / UserPrefersPassword
        6 => Err("lockout"),                          // SecurityDeviceLocked
        7 => Err(UNSUPPORTED),                        // AlgorithmNotSupported
        _ => Err(FAILED),
    }
}

fn public_key_export_error(hresult: i32) -> &'static str {
    match hresult as u32 {
        0x80004001 // E_NOTIMPL
        | 0x80070032 // HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED)
        | 0x80090008 // NTE_BAD_ALGID
        | 0x8009000a // NTE_BAD_TYPE
        | 0x80090029 => UNSUPPORTED, // NTE_NOT_SUPPORTED
        _ => FAILED,
    }
}

fn offer_hello_at_startup(probe: Result<bool>, has_saved_slot: impl FnOnce() -> bool) -> bool {
    match probe {
        Ok(false) | Err(UNSUPPORTED) => has_saved_slot(),
        // An inconclusive probe must leave the action available. The command
        // performs the live operation and can be retried after a failure.
        Ok(true) | Err(_) => true,
    }
}

fn offer_hello_with_deadline(
    timeout: Duration,
    probe: impl FnOnce() -> bool + Send + 'static,
) -> bool {
    let (reply, result) = mpsc::sync_channel(1);
    // A stuck OS query must not keep setup waiting. A late result is ignored
    // and explicit commands query the live Windows state on their own workers.
    let _ = std::thread::Builder::new()
        .name("windows-hello-probe".into())
        .spawn(move || {
            let _ = reply.send(probe());
        });
    result.recv_timeout(timeout).unwrap_or(true)
}

fn copy_and_wipe_signature(source: &mut [u8]) -> Result<Zeroizing<Vec<u8>>> {
    // Bound the copy to the RSA key sizes supported by our verifier.
    let copy = (256..=1024)
        .contains(&source.len())
        .then(|| Zeroizing::new(source.to_vec()));
    source.zeroize();
    copy.ok_or(UNSUPPORTED)
}

fn with_reproducible_signature<T>(
    mut sign: impl FnMut() -> Result<Zeroizing<Vec<u8>>>,
    commit: impl FnOnce(&[u8]) -> Result<T>,
) -> Result<T> {
    let first = sign()?;
    let second = sign()?;
    if first[..] != second[..] {
        return Err(UNSUPPORTED);
    }
    drop(second);
    commit(&first)
}

fn vault_challenge(installation: &[u8; 32], vault: &str) -> String {
    let installation = URL_SAFE_NO_PAD.encode(installation);
    format!("xyz.chat718788.e2eechat.biometric.v1.{installation}.{vault}")
}

fn vault_credential(vault: &str) -> String {
    format!("xyz.chat718788.e2eechat.biometric.v2.{vault}")
}

fn pending_enrollment_path(root: &Path, vault: &str) -> PathBuf {
    root.join(format!("{vault}.pending-hello"))
}

fn current_slot_path(root: &Path, vault: &str) -> PathBuf {
    root.join(format!("{vault}.v2.dpapi"))
}

fn journal_enrollment(
    root: &Path,
    vault: &str,
    enroll: impl FnOnce() -> Result<()>,
    delete: impl FnOnce(&str) -> Result<()>,
) -> Result<()> {
    let pending = pending_enrollment_path(root, vault);
    // The filename is the only payload. Flush the marker before Hello can
    // create a credential, including when the process dies during the call.
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending)
        .and_then(|file| file.sync_all())
        .map_err(|_| FAILED)?;
    let result = enroll();
    if result.is_ok() || delete(&vault_credential(vault)).is_ok() {
        // A leftover marker is safe. Recovery checks the committed slot
        // before deleting any credential.
        let _ = remove_record(&pending);
    }
    result
}

fn retry_pending_enrollments(root: &Path, mut delete: impl FnMut(&str) -> Result<()>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let filename = entry.file_name();
        let Some(vault) = filename
            .to_str()
            .and_then(|name| name.strip_suffix(".pending-hello"))
        else {
            continue;
        };
        if validate_vault_id(vault).is_err() {
            continue;
        }
        // Do not delete a credential if the previous request committed the
        // wrapped slot before it could clear the marker.
        let resolved = match current_slot_path(root, vault).try_exists() {
            Ok(true) => true,
            Ok(false) => delete(&vault_credential(vault)).is_ok(),
            Err(_) => false,
        };
        if resolved {
            let _ = remove_record(&entry.path());
        }
    }
}

fn remove_vault_slots(
    root: &Path,
    vault: &str,
    installation: impl FnOnce() -> Result<Option<[u8; 32]>>,
    verify_legacy: impl FnOnce(&Path, &str) -> Result<()>,
    mut delete: impl FnMut(&str) -> Result<()>,
) -> Result<()> {
    let current = current_slot_path(root, vault);
    let pending = pending_enrollment_path(root, vault);
    let current_known =
        current.try_exists().map_err(|_| FAILED)? || pending.try_exists().map_err(|_| FAILED)?;
    remove_slot(&current, || delete(&vault_credential(vault)))?;
    remove_record(&pending)?;

    let legacy = root.join(format!("{vault}.dpapi"));
    let legacy_exists = legacy.try_exists().map_err(|_| FAILED)?;
    if !legacy_exists && current_known {
        return Ok(());
    }
    // Without format information, also try the legacy name if it is known.
    // A corrupt ID can only block cleanup of an existing legacy record.
    let installation = if legacy_exists {
        installation()?
    } else {
        installation().ok().flatten()
    };
    if let Some(installation) = installation {
        let name = vault_challenge(&installation, vault);
        if legacy_exists {
            // A recreated installation ID could name an entirely different
            // credential. Authenticate the old record before deleting by name.
            verify_legacy(&legacy, &name)?;
        }
        remove_slot(&legacy, || delete(&name))?;
    } else if legacy_exists {
        // Legacy records cannot identify the credential without this ID.
        // Keep the record and pending removal until it can be recovered.
        return Err(FAILED);
    }
    Ok(())
}

const RECORD_LEN: usize = 1 + 32 + aead::NONCE_LEN + 32 + aead::MAX_TAG_LEN;

fn wrapping_key(challenge: &[u8], signature: &[u8]) -> Result<aead::LessSafeKey> {
    // The credential signs a fixed, versioned, installation/vault-specific
    // challenge. Keep the deterministic signature local and treat it as secret.
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, challenge).extract(signature);
    let info = [b"Private Base Windows Hello device KEK wrap v1".as_slice()];
    let mut bytes = Zeroizing::new([0; 32]);
    prk.expand(&info, hkdf::HKDF_SHA256)
        .and_then(|key| key.fill(&mut bytes[..]))
        .map_err(|_| FAILED)?;
    let key = aead::UnboundKey::new(&aead::AES_256_GCM, &bytes[..]).map_err(|_| FAILED)?;
    Ok(aead::LessSafeKey::new(key))
}

fn seal(
    key: &Key,
    challenge: &[u8],
    signature: &[u8],
    fingerprint: &[u8; 32],
    nonce: [u8; aead::NONCE_LEN],
) -> Result<[u8; RECORD_LEN]> {
    let mut encrypted = Zeroizing::new(**key);
    let tag = wrapping_key(challenge, signature)?
        .seal_in_place_separate_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(challenge),
            &mut encrypted[..],
        )
        .map_err(|_| FAILED)?;
    let mut record = [0; RECORD_LEN];
    record[0] = 1;
    record[1..33].copy_from_slice(fingerprint);
    record[33..45].copy_from_slice(&nonce);
    record[45..77].copy_from_slice(&encrypted[..]);
    record[77..].copy_from_slice(tag.as_ref());
    Ok(record)
}

fn check_credential(record: &[u8; RECORD_LEN], fingerprint: &[u8; 32]) -> Result<()> {
    if record[0] != 1 {
        return Err(FAILED);
    }
    if record[1..33] != *fingerprint {
        return Err(INVALIDATED);
    }
    Ok(())
}

fn unseal(record: &[u8; RECORD_LEN], challenge: &[u8], signature: &[u8]) -> Result<Key> {
    let mut buffer = Zeroizing::new([0; 32 + aead::MAX_TAG_LEN]);
    buffer.copy_from_slice(&record[45..]);
    let nonce = aead::Nonce::try_assume_unique_for_key(&record[33..45]).map_err(|_| FAILED)?;
    let plaintext = wrapping_key(challenge, signature)?
        .open_in_place(nonce, aead::Aad::from(challenge), &mut buffer[..])
        .map_err(|_| FAILED)?;
    let mut key = Zeroizing::new([0; 32]);
    key.copy_from_slice(plaintext);
    Ok(key)
}

fn remove_slot(path: &Path, delete_credential: impl FnOnce() -> Result<()>) -> Result<()> {
    // Keep the record when Windows refuses to delete the key. If only the
    // file deletion fails, a retry can finish after Hello reports NotFound.
    delete_credential()?;
    remove_record(path)
}

fn remove_record(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(FAILED),
    }
}

#[tauri::command]
pub(crate) async fn biometric_unlock_enroll(
    state: tauri::State<'_, BiometricUnlock>,
    vault_id: String,
    key: String,
) -> Result<()> {
    let key = Zeroizing::new(key);
    let keystore = state.keystore()?;
    validate_vault_id(&vault_id)?;
    let decoded = decode_key(&key)?;
    drop(key);
    tauri::async_runtime::spawn_blocking(move || keystore.enroll(vault_id, decoded))
        .await
        .map_err(|_| FAILED)?
}

#[tauri::command]
pub(crate) async fn biometric_unlock(
    state: tauri::State<'_, BiometricUnlock>,
    vault_id: String,
) -> Result<String> {
    let keystore = state.keystore()?;
    validate_vault_id(&vault_id)?;
    let key = tauri::async_runtime::spawn_blocking(move || keystore.unlock(vault_id))
        .await
        .map_err(|_| FAILED)??;
    // The response itself is the contract's transient copy. The native raw
    // key is wiped on drop and never managed as application state.
    Ok(URL_SAFE_NO_PAD.encode(&key[..]))
}

#[tauri::command]
pub(crate) async fn biometric_unlock_remove(
    state: tauri::State<'_, BiometricUnlock>,
    vault_id: String,
) -> Result<()> {
    let keystore = state.keystore()?;
    validate_vault_id(&vault_id)?;
    tauri::async_runtime::spawn_blocking(move || keystore.remove(vault_id))
        .await
        .map_err(|_| FAILED)?
}

#[cfg(test)]
mod tests;
