use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::{self, Cursor, Read, Write},
    path::Path,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::bufread::GzDecoder;
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tar::{Archive, Entry};
use tempfile::{Builder, TempDir};

pub const MAX_BUNDLE: usize = 32 * 1024 * 1024;
pub const MAX_SIGNATURE: usize = 8 * 1024;
const MAX_FILE: usize = 16 * 1024 * 1024;
const MAX_TOTAL: usize = 64 * 1024 * 1024;
const MAX_FILES: usize = 2048;
const MAX_MANIFEST: usize = 512 * 1024;
const MAX_TAR_PADDING: usize = 64 * 1024;

pub type Assets = BTreeMap<String, Vec<u8>>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(flatten)]
    pub target: BundleTarget,
    created_at: String,
    files: Vec<Asset>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleTarget {
    pub ui_version: Version,
    pub native_contract: u32,
    pub min_shell_version: Version,
    pub max_shell_version: Option<Version>,
    pub db_schema_version: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Asset {
    path: String,
    sha256: String,
    size: usize,
}

impl BundleTarget {
    pub fn valid(&self) -> bool {
        self.ui_version.to_string().len() <= 64
            && self.native_contract != 0
            && self.db_schema_version != 0
            && self
                .max_shell_version
                .as_ref()
                .is_none_or(|max| max.cmp_precedence(&self.min_shell_version) != Ordering::Less)
    }

    pub fn compatible(
        &self,
        contract: u32,
        shell: &Version,
        embedded: &Version,
        embedded_db_schema_version: u32,
    ) -> bool {
        self.native_contract == contract
            && shell.cmp_precedence(&self.min_shell_version) != Ordering::Less
            && self
                .max_shell_version
                .as_ref()
                .is_none_or(|max| shell.cmp_precedence(max) != Ordering::Greater)
            && self.ui_version.cmp_precedence(embedded) == Ordering::Greater
            && self.db_schema_version == embedded_db_schema_version
    }

    // Once a newer good bundle covers the same shells and schema, it can
    // replace this rollback candidate. Keep versions that cover other shells.
    pub fn covers(&self, older: &Self) -> bool {
        self.native_contract == older.native_contract
            && self.db_schema_version == older.db_schema_version
            && self
                .min_shell_version
                .cmp_precedence(&older.min_shell_version)
                != Ordering::Greater
            && self.max_shell_version.as_ref().is_none_or(|max| {
                older
                    .max_shell_version
                    .as_ref()
                    .is_some_and(|older_max| max.cmp_precedence(older_max) != Ordering::Less)
            })
    }
}

impl Manifest {
    fn parse(bytes: &[u8]) -> io::Result<Self> {
        let manifest: Self = serde_json::from_slice(bytes)?;
        if !manifest.target.valid()
            || chrono::DateTime::parse_from_rfc3339(&manifest.created_at).is_err()
            || manifest.files.len() > MAX_FILES
        {
            return Err(invalid("invalid bundle manifest"));
        }
        let mut paths = HashSet::new();
        let mut total = 0;
        for file in &manifest.files {
            let name = file.path.to_ascii_lowercase();
            if !valid_path(&file.path)
                || name == "manifest.json"
                || !paths.insert(name)
                || !valid_hash(&file.sha256)
                || file.size > MAX_FILE
            {
                return Err(invalid("invalid bundle asset metadata"));
            }
            total += file.size;
            if total > MAX_TOTAL {
                return Err(invalid("bundle exceeds expanded size limit"));
            }
        }
        if !manifest
            .files
            .iter()
            .any(|file| file.path == "index.html" && file.size > 0)
        {
            return Err(invalid("missing bundle entry point"));
        }
        Ok(manifest)
    }
}

pub fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn valid_path(path: &str) -> bool {
    path.len() <= 192
        && path.split('/').all(|part| {
            !part.is_empty()
                && part.len() <= 100
                && !part.ends_with('.')
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
                && !windows_device_name(part)
        })
}

fn windows_device_name(part: &str) -> bool {
    let name = part
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(name.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (name.len() == 4
            && (name.starts_with("COM") || name.starts_with("LPT"))
            && name.as_bytes()[3].is_ascii_digit())
}

fn decode_signature(encoded: &str) -> io::Result<String> {
    let decoded = STANDARD
        .decode(encoded.trim())
        .map_err(|_| invalid("invalid updater signature encoding"))?;
    String::from_utf8(decoded).map_err(|_| invalid("invalid updater signature text"))
}

fn verify_signature(bytes: &[u8], signature: &str, pubkey: &str) -> io::Result<()> {
    if bytes.is_empty() || bytes.len() > MAX_BUNDLE || signature.len() > MAX_SIGNATURE {
        return Err(invalid("invalid bundle or signature size"));
    }
    let public_key = PublicKey::decode(&decode_signature(pubkey)?)
        .map_err(|_| invalid("invalid pinned updater key"))?;
    let signature = Signature::decode(&decode_signature(signature)?)
        .map_err(|_| invalid("invalid updater signature"))?;
    public_key
        .verify(bytes, &signature, true)
        .map_err(|_| invalid("bundle signature verification failed"))
}

fn entry_bytes<R: Read>(entry: &mut Entry<'_, R>, limit: usize) -> io::Result<Vec<u8>> {
    if !entry.header().entry_type().is_file() || entry.size() > limit as u64 {
        return Err(invalid("unsupported tar entry"));
    }
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes)?;
    if bytes.len() as u64 != entry.size() {
        return Err(invalid("truncated tar entry"));
    }
    Ok(bytes)
}

fn read_manifest<R: Read>(entry: Option<io::Result<Entry<'_, R>>>) -> io::Result<Manifest> {
    let mut entry = entry.ok_or_else(|| invalid("missing bundle manifest"))??;
    if entry.path_bytes().as_ref() != b"manifest.json" {
        return Err(invalid("expected manifest.json as first tar entry"));
    }
    Manifest::parse(&entry_bytes(&mut entry, MAX_MANIFEST)?)
}

fn unpack(bytes: &[u8], root: &Path) -> io::Result<Manifest> {
    let mut archive = Archive::new(GzDecoder::new(Cursor::new(bytes)));
    let mut entries = archive.entries()?.raw(true);
    let manifest = read_manifest(entries.next())?;
    let mut expected: BTreeMap<_, _> = manifest
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    for entry in entries {
        let mut entry = entry?;
        let path = entry.path_bytes();
        let path =
            std::str::from_utf8(&path).map_err(|_| invalid("invalid asset path encoding"))?;
        let file = expected
            .remove(path)
            .ok_or_else(|| invalid("unexpected tar entry"))?;
        if entry.size() != file.size as u64 {
            return Err(invalid("bundle asset size mismatch"));
        }
        let bytes = entry_bytes(&mut entry, MAX_FILE)?;
        check_asset(file, &bytes)?;
        let path = root.join(&file.path);
        fs::create_dir_all(path.parent().expect("asset has a parent"))?;
        write_new(&path, &bytes)?;
    }
    if !expected.is_empty() {
        return Err(invalid("missing tar entries"));
    }
    let mut decoder = archive.into_inner();
    // tar stops at the first zero block. Consume the remaining padding and the
    // gzip trailer, and reject extra payloads or concatenated gzip members.
    let mut padding = Vec::new();
    decoder
        .by_ref()
        .take(MAX_TAR_PADDING as u64 + 1)
        .read_to_end(&mut padding)?;
    if !(512..=MAX_TAR_PADDING).contains(&padding.len())
        || padding.iter().any(|byte| *byte != 0)
        || decoder.get_ref().position() != bytes.len() as u64
    {
        return Err(invalid("invalid tar or gzip trailer"));
    }
    Ok(manifest)
}

fn check_asset(file: &Asset, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() != file.size || hash(bytes) != file.sha256 {
        return Err(invalid("bundle asset hash or size mismatch"));
    }
    Ok(())
}

/// Validate a prepared archive with the same unpacker the native shell uses.
/// The release publisher verifies the signature before calling this check.
pub fn validate_archive(path: &Path) -> io::Result<()> {
    let bytes = read_bounded(path, MAX_BUNDLE)?;
    let directory = tempfile::tempdir()?;
    let manifest = unpack(&bytes, directory.path())?;
    if let Some(file) = manifest
        .files
        .iter()
        .find(|file| file.path == "schema-version.json")
    {
        let receipt = read_bounded(&directory.path().join(&file.path), file.size)?;
        let schema: serde_json::Value = serde_json::from_slice(&receipt)?;
        if schema["otaTestNoReady"].as_bool() == Some(true) {
            return Err(invalid(
                "an OTA release cannot contain the no-ready fixture",
            ));
        }
    }
    Ok(())
}

pub fn stage(
    directory: &Path,
    bytes: &[u8],
    signature: &str,
    pubkey: &str,
) -> io::Result<(TempDir, Manifest)> {
    verify_signature(bytes, signature, pubkey)?;
    let stage = Builder::new().prefix("staging-").tempdir_in(directory)?;
    let manifest = unpack(bytes, &stage.path().join("files"))?;
    write_new(&stage.path().join("bundle.tar.gz"), bytes)?;
    write_new(
        &stage.path().join("bundle.tar.gz.sig"),
        signature.as_bytes(),
    )?;
    Ok((stage, manifest))
}

pub fn load(directory: &Path, pubkey: &str) -> io::Result<(Manifest, Assets)> {
    let bytes = read_bounded(&directory.join("bundle.tar.gz"), MAX_BUNDLE)?;
    let signature = read_bounded(&directory.join("bundle.tar.gz.sig"), MAX_SIGNATURE)?;
    let signature =
        std::str::from_utf8(&signature).map_err(|_| invalid("invalid signature text"))?;
    verify_signature(&bytes, signature, pubkey)?;

    // The signed manifest authorizes the staged files. Serve only the exact
    // verified bytes we read here, even if files change after startup.
    let mut archive = Archive::new(GzDecoder::new(Cursor::new(bytes)));
    let manifest = archive
        .entries()
        .and_then(|entries| read_manifest(entries.raw(true).next()))
        .map_err(|_| invalid("invalid signed bundle manifest"))?;
    let mut assets = Assets::new();
    for file in &manifest.files {
        let bytes = read_bounded(&directory.join("files").join(&file.path), file.size)?;
        check_asset(file, &bytes)?;
        assets.insert(file.path.clone(), bytes);
    }
    Ok((manifest, assets))
}

pub fn read_bounded(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    if !path.symlink_metadata()?.is_file() {
        return Err(invalid("expected a regular file"));
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(invalid("file exceeds size limit"));
    }
    Ok(bytes)
}

fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = File::create_new(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
#[path = "ui_bundle_archive_tests.rs"]
mod tests;
