use std::{
    fs,
    io::{self, Write},
    path::Path,
};

#[cfg(not(target_os = "android"))]
use std::time::Duration;

use sha2::{Digest, Sha256};

pub const RELEASE_BASE: &str = "https://dist.718788.xyz/private-base/releases/";

// A fixed SHA-256 bucket is stable across runs, versions, channels and platforms.
// Use 10,000 buckets so an integer percent always selects exactly that share.
pub fn rollout_bucket(install_id: &[u8; 32]) -> u16 {
    let hash = Sha256::digest(install_id);
    let prefix = u64::from_be_bytes(hash[..8].try_into().expect("SHA-256 has eight bytes"));
    (prefix % 10_000) as u16
}

#[cfg(not(target_os = "android"))]
pub fn configure_update_client(
    client: reqwest::ClientBuilder,
    read_timeout: Duration,
) -> reqwest::ClientBuilder {
    client
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        // The plugin's builder timeout only covers checks. This callback also
        // configures artifact reads, resetting the deadline as data arrives.
        .read_timeout(read_timeout)
        .redirect(reqwest::redirect::Policy::none())
}

pub fn install_id(directory: &Path) -> io::Result<[u8; 32]> {
    fs::create_dir_all(directory)?;
    let path = directory.join("updater-install-id");
    let read = || {
        fs::read(&path)?
            .try_into()
            .map_err(|_| io::Error::other("invalid updater install id"))
    };
    match read() {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        result => return result,
    }
    // The full and UI updaters can both start a check during the first boot.
    // Publish the complete ID before either one can read it.
    let mut id = [0; 32];
    getrandom::fill(&mut id).map_err(io::Error::other)?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(&id)?;
    file.as_file().sync_all()?;
    match file.persist_noclobber(&path) {
        Ok(_) => Ok(id),
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => read(),
        Err(error) => Err(error.error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_install_id_persists_and_corruption_is_not_silently_replaced() {
        let mut suffix = [0; 8];
        getrandom::fill(&mut suffix).unwrap();
        let directory = std::env::temp_dir().join(format!(
            "privatebase-updater-test-{}",
            u64::from_be_bytes(suffix)
        ));
        let first = install_id(&directory).unwrap();
        assert_eq!(first, install_id(&directory).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(directory.join("updater-install-id"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::write(directory.join("updater-install-id"), [0; 4]).unwrap();
        assert!(install_id(&directory).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
