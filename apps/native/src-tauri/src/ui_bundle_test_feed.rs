use std::{io, net::Ipv4Addr};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::PublicKey;
use reqwest::Url;

use crate::ui_bundle_archive::invalid;

pub struct TestFeed {
    pub base: String,
    pub key: String,
}

pub fn allows_http(url: &Url) -> bool {
    url.scheme() == "http"
        && (url.host_str().is_some_and(|host| {
            host.parse::<Ipv4Addr>()
                .is_ok_and(|ip| ip.is_loopback() || ip == Ipv4Addr::new(10, 0, 2, 2))
        }) || url.host_str() == Some("[::1]"))
}

fn parse(base: Option<String>, key: Option<String>) -> io::Result<Option<TestFeed>> {
    let (base, key) = match (base, key) {
        (None, None) => return Ok(None),
        (Some(base), Some(key)) => (base, key),
        _ => return Err(invalid("both OTA test-feed settings are required")),
    };
    let url = Url::parse(&base).map_err(|_| invalid("invalid OTA test URL"))?;
    if !(url.scheme() == "https" || allows_http(&url))
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().ends_with('/')
    {
        return Err(invalid("invalid OTA test URL"));
    }
    // Android properties hold at most 91 bytes. Accept the 56-character
    // minisign packet and wrap it in the updater's encoded public-key format.
    let key = key.trim();
    let key = if PublicKey::from_base64(key).is_ok() {
        STANDARD.encode(format!("untrusted comment: minisign public key\n{key}\n"))
    } else {
        let decoded = STANDARD
            .decode(key)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .ok_or_else(|| invalid("invalid OTA test public key"))?;
        PublicKey::decode(&decoded).map_err(|_| invalid("invalid OTA test public key"))?;
        key.to_owned()
    };
    Ok(Some(TestFeed {
        base: url.into(),
        key,
    }))
}

pub fn configured() -> io::Result<Option<TestFeed>> {
    #[cfg(desktop)]
    let (base, key) = (
        std::env::var_os("PRIVATEBASE_OTA_TEST_BASE"),
        std::env::var_os("PRIVATEBASE_OTA_TEST_PUBKEY"),
    );
    #[cfg(desktop)]
    let read = |value: Option<std::ffi::OsString>| {
        value
            .map(|v| {
                v.into_string()
                    .map_err(|_| invalid("invalid OTA test setting"))
            })
            .transpose()
    };
    #[cfg(desktop)]
    let (base, key) = (read(base)?, read(key)?);
    #[cfg(target_os = "android")]
    let (base, key) = (
        property(c"debug.privatebase.ota_test_base")?,
        property(c"debug.privatebase.ota_test_pubkey")?,
    );
    parse(base, key)
}

#[cfg(target_os = "android")]
fn property(name: &std::ffi::CStr) -> io::Result<Option<String>> {
    use std::ffi::{c_char, c_int};
    extern "C" {
        fn __system_property_get(name: *const c_char, value: *mut c_char) -> c_int;
    }
    // Bionic's PROP_VALUE_MAX includes the terminator.
    let mut value = [0u8; 92];
    let length = unsafe { __system_property_get(name.as_ptr(), value.as_mut_ptr().cast()) };
    if length == 0 {
        return Ok(None);
    }
    let value = value
        .get(..length as usize)
        .ok_or_else(|| invalid("invalid OTA test property length"))?;
    String::from_utf8(value.to_vec())
        .map(Some)
        .map_err(|_| invalid("invalid OTA test property"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_base_requires_both_settings_and_restricts_cleartext_hosts() {
        const KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        assert!(parse(None, None).unwrap().is_none());
        assert!(parse(None, Some(KEY.into())).is_err());
        assert!(parse(Some("http://127.0.0.1/".into()), None).is_err());
        for base in [
            "http://127.0.0.1:8789/",
            "http://[::1]/",
            "http://10.0.2.2/",
            "https://private.example/ota/",
        ] {
            let feed = parse(Some(base.into()), Some(KEY.into())).unwrap().unwrap();
            assert_eq!(feed.base, base);
            assert!(parse(Some(base.into()), Some(feed.key)).is_ok());
        }
        for base in [
            "http://private.example/",
            "http://10.0.2.3/",
            "http://127.0.0.1@evil.example/",
            "https://name:secret@private.example/",
            "http://localhost/",
            "http://[::]/",
            "http://127.0.0.1/no-slash",
            "http://127.0.0.1/?q",
            "https://private.example/#hash",
            "ftp://127.0.0.1/",
        ] {
            assert!(
                parse(Some(base.into()), Some(KEY.into())).is_err(),
                "{base}"
            );
        }
        assert!(parse(Some("http://127.0.0.1/".into()), Some("bad key".into())).is_err());
    }
}
