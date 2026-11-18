use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use ring::{
    digest::{digest, SHA256},
    signature::{UnparsedPublicKey, RSA_PKCS1_2048_8192_SHA256},
};
use windows::{
    core::{Array, Error, Interface, HSTRING, PCWSTR},
    Security::{
        Credentials::{
            KeyCredential, KeyCredentialAttestationStatus, KeyCredentialCreationOption,
            KeyCredentialManager,
        },
        Cryptography::{Core::CryptographicPublicKeyBlobType, CryptographicBuffer},
    },
    Storage::Streams::IBuffer,
    Win32::{
        Foundation::{LocalFree, E_NOINTERFACE, E_NOTIMPL, HLOCAL, REGDB_E_CLASSNOTREG},
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
        System::WinRT::{IBufferByteAccess, RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
    },
};
use zeroize::{Zeroize, Zeroizing};

use super::{
    check_credential, copy_and_wipe_signature, current_slot_path, hello_status, journal_enrollment,
    offer_hello_at_startup, offer_hello_with_deadline, public_key_export_error, remove_vault_slots,
    retry_pending_enrollments, seal, unseal, vault_challenge, vault_credential,
    with_reproducible_signature, Key, Result, FAILED, INVALIDATED, RECORD_LEN, UNSUPPORTED,
};

const INSTALLATION_ID_FILE: &str = "installation-id";
const MAX_DPAPI_BYTES: u64 = 4096;
const STARTUP_PROBE_TIMEOUT: Duration = Duration::from_millis(250);

pub(super) struct Keystore {
    root: PathBuf,
    operations: Mutex<()>,
    offer_hello: bool,
}

impl Keystore {
    pub(super) fn probe(root: PathBuf) -> Option<Self> {
        // Use a dedicated MTA thread for the silent readiness query. Windows
        // credentials and attestation are handled only by explicit commands.
        let probe_root = root.clone();
        let offer_hello = offer_hello_with_deadline(STARTUP_PROBE_TIMEOUT, move || {
            let readiness = (|| {
                let _apartment = Apartment::initialize()?;
                hello_supported()
            })();
            offer_hello_at_startup(readiness, || has_saved_slot(&probe_root))
        });
        Some(Self {
            root,
            operations: Mutex::new(()),
            offer_hello,
        })
    }

    pub(super) fn offer_hello(&self) -> bool {
        self.offer_hello
    }

    pub(super) fn enroll(&self, vault: String, key: Key) -> Result<()> {
        let _operation = self.operations.lock().map_err(|_| FAILED)?;
        let _apartment = Apartment::initialize()?;
        let delete = |name: &str| delete_credential(&HSTRING::from(name));
        retry_pending_enrollments(&self.root, delete);
        // RequestCreateAsync reports live availability. Repeating the startup
        // readiness query here could stall every operation behind this mutex.
        let path = self.slot_path(&vault);
        if path.try_exists().map_err(|_| FAILED)?
            || self
                .legacy_slot_path(&vault)
                .try_exists()
                .map_err(|_| FAILED)?
        {
            return Err(FAILED);
        }
        let installation = self.installation_id(true)?.ok_or(FAILED)?;
        let challenge = vault_challenge(&installation, &vault);
        let mut nonce = [0; 12];
        getrandom::fill(&mut nonce).map_err(|_| FAILED)?;
        journal_enrollment(
            &self.root,
            &vault,
            || {
                let name = HSTRING::from(vault_credential(&vault));
                let credential = create_credential(&name)?;
                require_tpm(&credential)?;
                let fingerprint = fingerprint(&credential)?;
                let rsa = credential
                    .RetrievePublicKeyWithBlobType(
                        CryptographicPublicKeyBlobType::Pkcs1RsaPublicKey,
                    )
                    .map_err(|error| public_key_export_error(error.code().0))?;
                let mut public = Array::new();
                CryptographicBuffer::CopyToByteArray(&rsa, &mut public).map_err(|_| FAILED)?;
                // The pinned KeyCredentialManager overload has no algorithm
                // selector. Verify RSA PKCS#1 v1.5 explicitly before storing.
                with_reproducible_signature(
                    || sign(&credential, challenge.as_bytes()),
                    |signature| {
                        UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, &public[..])
                            .verify(challenge.as_bytes(), signature)
                            .map_err(|_| UNSUPPORTED)?;
                        let record =
                            seal(&key, challenge.as_bytes(), signature, &fingerprint, nonce)?;
                        let protected = dpapi(&record, challenge.as_bytes(), true)?;
                        write_new(&path, &protected)
                    },
                )
            },
            delete,
        )
    }

    pub(super) fn unlock(&self, vault: String) -> Result<Key> {
        let _operation = self.operations.lock().map_err(|_| FAILED)?;
        let _apartment = Apartment::initialize()?;
        let installation = self.installation_id(false)?.ok_or(INVALIDATED)?;
        let challenge = vault_challenge(&installation, &vault);
        let (protected, name) = match read_record(&self.slot_path(&vault)) {
            Ok(record) => (record, vault_credential(&vault)),
            Err(INVALIDATED) => (
                read_record(&self.legacy_slot_path(&vault))?,
                challenge.clone(),
            ),
            Err(error) => return Err(error),
        };
        let record = dpapi(&protected, challenge.as_bytes(), false)?;
        let record = record.as_slice().try_into().map_err(|_| FAILED)?;
        let credential = open_credential(&HSTRING::from(name))?;
        check_credential(record, &fingerprint(&credential)?)?;
        let signature = sign(&credential, challenge.as_bytes())?;
        unseal(record, challenge.as_bytes(), &signature)
    }

    pub(super) fn remove(&self, vault: String) -> Result<()> {
        let _operation = self.operations.lock().map_err(|_| FAILED)?;
        let _apartment = Apartment::initialize()?;
        remove_vault_slots(
            &self.root,
            &vault,
            || self.installation_id(false),
            |path, name| {
                let record = dpapi(&read_record(path)?, name.as_bytes(), false)?;
                // DPAPI authenticated the installation and vault used in the
                // name. The payload contains only the wrapped device key.
                if record.first() != Some(&1) {
                    return Err(FAILED);
                }
                Ok(())
            },
            |name| delete_credential(&HSTRING::from(name)),
        )
    }

    fn slot_path(&self, vault: &str) -> PathBuf {
        current_slot_path(&self.root, vault)
    }

    fn legacy_slot_path(&self, vault: &str) -> PathBuf {
        self.root.join(format!("{vault}.dpapi"))
    }

    fn installation_id(&self, create: bool) -> Result<Option<[u8; 32]>> {
        let path = self.root.join(INSTALLATION_ID_FILE);
        match File::open(&path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(33).read_to_end(&mut bytes).map_err(|_| FAILED)?;
                Ok(Some(bytes.try_into().map_err(|_| FAILED)?))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound && create => {
                fs::create_dir_all(&self.root).map_err(|_| FAILED)?;
                let mut bytes = [0; 32];
                getrandom::fill(&mut bytes).map_err(|_| FAILED)?;
                write_new(&path, &bytes)?;
                Ok(Some(bytes))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(FAILED),
        }
    }
}

fn hello_supported() -> Result<bool> {
    KeyCredentialManager::IsSupportedAsync()
        .and_then(|work| work.join())
        .map_err(hello_service_error)
}

fn hello_service_error(error: Error) -> &'static str {
    match error.code() {
        REGDB_E_CLASSNOTREG | E_NOINTERFACE | E_NOTIMPL => UNSUPPORTED,
        _ => FAILED,
    }
}

fn has_saved_slot(root: &Path) -> bool {
    match fs::read_dir(root) {
        Ok(mut entries) => entries.any(|entry| {
            entry.map_or(true, |entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|ext| ext == "dpapi" || ext == "pending-hello")
            })
        }),
        Err(error) => error.kind() != io::ErrorKind::NotFound,
    }
}

fn create_credential(name: &HSTRING) -> Result<KeyCredential> {
    let created =
        KeyCredentialManager::RequestCreateAsync(name, KeyCredentialCreationOption::FailIfExists)
            .and_then(|work| work.join())
            .map_err(hello_service_error)?;
    hello_status(created.Status().map_err(|_| FAILED)?.0, false)?;
    created.Credential().map_err(|_| FAILED)
}

fn open_credential(name: &HSTRING) -> Result<KeyCredential> {
    let opened = KeyCredentialManager::OpenAsync(name)
        .and_then(|work| work.join())
        .map_err(|_| FAILED)?;
    hello_status(opened.Status().map_err(|_| FAILED)?.0, true)?;
    opened.Credential().map_err(|_| FAILED)
}

fn require_tpm(credential: &KeyCredential) -> Result<()> {
    // Hello can create a software credential. Trust the local OS to report
    // whether it can produce TPM attestation for this specific credential.
    let attestation = credential
        .GetAttestationAsync()
        .and_then(|work| work.join())
        .map_err(|_| FAILED)?;
    match attestation.Status().map_err(|_| FAILED)? {
        KeyCredentialAttestationStatus::Success => {
            let proof = attestation.AttestationBuffer().map_err(|_| FAILED)?;
            if proof.Length().map_err(|_| FAILED)? == 0 {
                return Err(UNSUPPORTED);
            }
            Ok(())
        }
        KeyCredentialAttestationStatus::NotSupported => Err(UNSUPPORTED),
        _ => Err(FAILED),
    }
}

fn delete_credential(name: &HSTRING) -> Result<()> {
    if KeyCredentialManager::DeleteAsync(name)
        .and_then(|work| work.join())
        .is_ok()
    {
        return Ok(());
    }
    // Treat an absent item as success only if Hello confirms it. Leave the
    // file in place after any other error so removal can be retried.
    match open_credential(name) {
        Err(INVALIDATED) => Ok(()),
        _ => Err(FAILED),
    }
}

fn fingerprint(credential: &KeyCredential) -> Result<[u8; 32]> {
    let public = credential
        .RetrievePublicKeyWithDefaultBlobType()
        .map_err(|_| FAILED)?;
    let mut bytes = Array::new();
    CryptographicBuffer::CopyToByteArray(&public, &mut bytes).map_err(|_| FAILED)?;
    digest(&SHA256, &bytes)
        .as_ref()
        .try_into()
        .map_err(|_| FAILED)
}

fn sign(credential: &KeyCredential, challenge: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let challenge = CryptographicBuffer::CreateFromByteArray(challenge).map_err(|_| FAILED)?;
    let signed = credential
        .RequestSignAsync(&challenge)
        .and_then(|work| work.join())
        .map_err(|_| FAILED)?;
    hello_status(signed.Status().map_err(|_| FAILED)?.0, true)?;
    take_signature(signed.Result().map_err(|_| FAILED)?)
}

fn take_signature(buffer: IBuffer) -> Result<Zeroizing<Vec<u8>>> {
    let length = buffer.Length().map_err(|_| FAILED)? as usize;
    if length == 0 {
        return Err(UNSUPPORTED);
    }
    if length > buffer.Capacity().map_err(|_| FAILED)? as usize || length > isize::MAX as usize {
        return Err(FAILED);
    }
    let access: IBufferByteAccess = buffer.cast().map_err(|_| UNSUPPORTED)?;
    // SAFETY: the interface returns the address of its backing storage.
    let pointer = unsafe { access.Buffer() }.map_err(|_| FAILED)?;
    if pointer.is_null() {
        return Err(FAILED);
    }
    // SAFETY: this invocation owns the local WinRT result. The two COM
    // handles keep its writable storage alive, and length fits its capacity.
    let source = unsafe { std::slice::from_raw_parts_mut(pointer, length) };
    copy_and_wipe_signature(source)
}

fn read_record(path: &Path) -> Result<Vec<u8>> {
    let file = File::open(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            INVALIDATED
        } else {
            FAILED
        }
    })?;
    let mut bytes = Vec::new();
    file.take(MAX_DPAPI_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| FAILED)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_DPAPI_BYTES {
        return Err(FAILED);
    }
    Ok(bytes)
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().ok_or(FAILED)?).map_err(|_| FAILED)?;
    file.write_all(bytes).map_err(|_| FAILED)?;
    file.as_file().sync_all().map_err(|_| FAILED)?;
    file.persist_noclobber(path).map_err(|_| FAILED)?;
    Ok(())
}

fn dpapi(bytes: &[u8], entropy: &[u8], protect: bool) -> Result<Vec<u8>> {
    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        // Both inputs have already been bounded. DPAPI reads these buffers.
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr().cast_mut(),
        }
    }

    let input = blob(bytes);
    let entropy = blob(entropy);
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: input and entropy are live, read-only blobs. DPAPI exclusively
    // initializes the output, which is freed with LocalFree on success.
    unsafe {
        if protect {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                None,
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
        .map_err(|_| FAILED)?;
        let len = output.cbData as usize;
        let result = if output.pbData.is_null() || len == 0 {
            Err(FAILED)
        } else {
            let output = std::slice::from_raw_parts_mut(output.pbData, len);
            let result =
                if (protect && len as u64 <= MAX_DPAPI_BYTES) || (!protect && len == RECORD_LEN) {
                    Ok(output.to_vec())
                } else {
                    Err(FAILED)
                };
            output.zeroize();
            result
        };
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        result
    }
}

struct Apartment;

impl Apartment {
    fn initialize() -> Result<Self> {
        // SAFETY: command work runs on a blocking worker. The guard unwinds
        // every successful initialization on that same thread.
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|_| FAILED)?;
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: this guard is local to the blocking worker's call stack.
        unsafe { RoUninitialize() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_a_signature_wipes_the_original_winrt_buffer() {
        let _apartment = Apartment::initialize().unwrap();
        let buffer = CryptographicBuffer::CreateFromByteArray(&[37; 256]).unwrap();
        let signature = take_signature(buffer.clone()).unwrap();
        assert_eq!(&signature[..], &[37; 256]);
        let mut original = Array::new();
        CryptographicBuffer::CopyToByteArray(&buffer, &mut original).unwrap();
        assert_eq!(&original[..], &[0; 256]);
    }
}
