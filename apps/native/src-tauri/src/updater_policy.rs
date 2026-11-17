use std::cmp::Ordering;

use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const RELEASE_BASE: &str = "https://dist.718788.xyz/private-base/releases/";

pub fn endpoint(channel: &str) -> Result<String, &'static str> {
    match channel {
        "stable" | "beta" => Ok(format!(
            "{RELEASE_BASE}{channel}/updater/{{{{target}}}}-{{{{arch}}}}.json"
        )),
        _ => Err("unsupported"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: Version,
    notes: Option<String>,
    rollout_percent: u8,
    minimum_version: Option<Version>,
    #[serde(default)]
    blocked: Vec<Version>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mandatory: Option<bool>,
}

// A fixed SHA-256 bucket is stable across runs, versions, channels and platforms.
// Use 10,000 buckets so an integer percent always selects exactly that share.
fn rollout_bucket(install_id: &[u8; 32]) -> u16 {
    let hash = Sha256::digest(install_id);
    let prefix = u64::from_be_bytes(hash[..8].try_into().expect("SHA-256 has eight bytes"));
    (prefix % 10_000) as u16
}

pub fn evaluate_manifest(
    raw: &serde_json::Value,
    current: &Version,
    install_id: &[u8; 32],
) -> Result<CheckResult, &'static str> {
    let manifest: Manifest = serde_json::from_value(raw.clone()).map_err(|_| "network")?;
    if manifest.rollout_percent > 100 {
        return Err("network");
    }
    if manifest.version.cmp_precedence(current) != Ordering::Greater
        || manifest
            .blocked
            .iter()
            .any(|version| version.cmp_precedence(&manifest.version) == Ordering::Equal)
        || rollout_bucket(install_id) >= u16::from(manifest.rollout_percent) * 100
    {
        return Ok(CheckResult::default());
    }

    Ok(CheckResult {
        available: true,
        version: Some(manifest.version.to_string()),
        notes: manifest.notes,
        mandatory: Some(
            manifest
                .minimum_version
                .is_some_and(|minimum| current.cmp_precedence(&minimum) == Ordering::Less),
        ),
    })
}

// Restrict artifacts to the immutable folder of the announced version as well
// as the fixed HTTPS release host. Redirects are disabled by the HTTP client.
pub fn valid_artifact_url(url: &reqwest::Url, version: &str) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("dist.718788.xyz")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url
            .path()
            .strip_prefix(&format!("/private-base/releases/{version}/"))
            .is_some_and(|file| !file.is_empty() && !file.contains('/') && !file.contains('%'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest() -> serde_json::Value {
        json!({
            "version": "0.1.1",
            "notes": "A release",
            "pub_date": "2026-10-01T00:00:00Z",
            "platforms": {"darwin-aarch64": {
                "signature": "test-signature",
                "url": "https://dist.718788.xyz/private-base/releases/0.1.1/app.tar.gz"
            }},
            "rolloutPercent": 100,
            "minimumVersion": "0.1.0",
            "blocked": []
        })
    }

    fn evaluate(raw: &serde_json::Value) -> Result<CheckResult, &'static str> {
        evaluate_manifest(raw, &Version::new(0, 1, 0), &[7; 32])
    }

    #[test]
    fn parses_tauri_static_manifest_and_contract_result() {
        let raw = manifest();
        let release: tauri_plugin_updater::RemoteRelease =
            serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(release.version, Version::new(0, 1, 1));
        assert_eq!(
            serde_json::to_value(evaluate(&raw).unwrap()).unwrap(),
            json!({"available": true, "version": "0.1.1", "notes": "A release", "mandatory": false})
        );
        assert_eq!(
            serde_json::to_value(CheckResult::default()).unwrap(),
            json!({"available": false})
        );
    }

    #[test]
    fn rejects_malformed_policy_instead_of_ignoring_it() {
        for (field, value) in [
            ("version", json!("invalid")),
            ("rolloutPercent", json!(101)),
            ("rolloutPercent", json!(-1)),
            ("rolloutPercent", json!(0.5)),
            ("minimumVersion", json!("invalid")),
            ("blocked", json!(["invalid"])),
        ] {
            let mut raw = manifest();
            raw[field] = value;
            assert_eq!(evaluate(&raw), Err("network"), "{field}");
        }
        let mut raw = manifest();
        raw.as_object_mut().unwrap().remove("rolloutPercent");
        assert_eq!(evaluate(&raw), Err("network"));
    }

    #[test]
    fn never_downgrades_or_reinstalls_including_build_metadata() {
        for version in ["0.0.9", "0.1.0", "0.1.0+new", "0.1.0-beta.1"] {
            let mut raw = manifest();
            raw["version"] = json!(version);
            assert!(!evaluate(&raw).unwrap().available, "{version}");
        }
    }

    #[test]
    fn skips_blocked_candidate_but_can_update_a_blocked_current_version() {
        let mut raw = manifest();
        raw["blocked"] = json!(["0.1.1"]);
        assert!(!evaluate(&raw).unwrap().available);
        raw["blocked"] = json!(["0.1.1+other-build"]);
        assert!(!evaluate(&raw).unwrap().available);
        raw["blocked"] = json!(["0.1.0"]);
        assert!(evaluate(&raw).unwrap().available);
    }

    #[test]
    fn mandatory_is_strictly_below_minimum_and_does_not_bypass_policy() {
        let mut raw = manifest();
        assert_eq!(evaluate(&raw).unwrap().mandatory, Some(false));
        raw["minimumVersion"] = json!("0.1.1");
        assert_eq!(evaluate(&raw).unwrap().mandatory, Some(true));
        raw["blocked"] = json!(["0.1.1"]);
        assert!(!evaluate(&raw).unwrap().available);
        raw["blocked"] = json!([]);
        raw["rolloutPercent"] = json!(0);
        assert!(!evaluate(&raw).unwrap().available);
        raw["rolloutPercent"] = json!(100);
        raw.as_object_mut().unwrap().remove("minimumVersion");
        assert_eq!(evaluate(&raw).unwrap().mandatory, Some(false));
    }

    #[test]
    fn rollout_is_stable_and_obeys_percentage_boundaries() {
        // SHA-256 of 32 zero bytes, first eight bytes as big-endian mod 10,000.
        assert_eq!(rollout_bucket(&[0; 32]), 9175);
        let mut raw = manifest();
        for byte in 0..=255 {
            let id = [byte; 32];
            let bucket = rollout_bucket(&id);
            assert_eq!(bucket, rollout_bucket(&id));
            for percent in [0, 1, 25, 50, 99, 100] {
                raw["rolloutPercent"] = json!(percent);
                assert_eq!(
                    evaluate_manifest(&raw, &Version::new(0, 1, 0), &id)
                        .unwrap()
                        .available,
                    bucket < percent * 100
                );
            }
        }
    }

    #[test]
    fn endpoint_accepts_only_fixed_channels() {
        for channel in ["stable", "beta"] {
            assert_eq!(
                endpoint(channel).unwrap(),
                format!("{RELEASE_BASE}{channel}/updater/{{{{target}}}}-{{{{arch}}}}.json")
            );
        }
        for channel in ["", "Stable", "../stable", "https://example.com"] {
            assert_eq!(endpoint(channel), Err("unsupported"));
        }
    }

    #[test]
    fn artifacts_require_fixed_https_origin_and_immutable_version_folder() {
        let good = "https://dist.718788.xyz/private-base/releases/0.1.1/app.tar.gz";
        assert!(valid_artifact_url(&good.parse().unwrap(), "0.1.1"));
        for bad in [
            good.replace("https:", "http:"),
            good.replace("dist.718788.xyz", "example.com"),
            good.replace("dist.718788.xyz", "dist.718788.xyz:8443"),
            good.replace("dist.718788.xyz", "user@dist.718788.xyz"),
            good.replace("0.1.1", "0.1.0"),
            good.replace("app.tar.gz", "../app.tar.gz"),
            good.replace("app.tar.gz", "%2e%2e%2fapp.tar.gz"),
            good.replace("app.tar.gz", ""),
            format!("{good}?redirect=elsewhere"),
            format!("{good}#fragment"),
        ] {
            assert!(!valid_artifact_url(&bad.parse().unwrap(), "0.1.1"));
        }
    }
}
