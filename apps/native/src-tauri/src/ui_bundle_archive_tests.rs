use super::*;
use flate2::{write::GzEncoder, Compression};
use serde_json::{json, Value};
use tar::{Builder as TarBuilder, EntryType, Header};

fn manifest(content: &[u8]) -> Value {
    json!({
        "uiVersion": "0.2.0-beta.1",
        "nativeContract": 1,
        "dbSchemaVersion": 9,
        "minShellVersion": "0.1.3",
        "maxShellVersion": "0.1.5",
        "createdAt": "2026-10-01T00:00:00Z",
        "files": [{"path": "index.html", "sha256": hash(content), "size": content.len()}]
    })
}

fn parse(value: &Value) -> io::Result<Manifest> {
    Manifest::parse(&serde_json::to_vec(value).unwrap())
}

fn tar_entry(builder: &mut TarBuilder<impl Write>, name: &str, kind: EntryType, bytes: &[u8]) {
    let mut header = Header::new_ustar();
    header.set_mode(0o644);
    header.set_size(bytes.len() as u64);
    header.set_entry_type(kind);
    // Set the raw name to exercise paths the tar crate refuses to author.
    header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
    header.set_cksum();
    builder.append(&header, bytes).unwrap();
}

fn bundle(metadata: &Value, name: &str, kind: EntryType, bytes: &[u8]) -> Vec<u8> {
    let mut builder = TarBuilder::new(GzEncoder::new(Vec::new(), Compression::default()));
    tar_entry(
        &mut builder,
        "manifest.json",
        EntryType::Regular,
        &serde_json::to_vec(metadata).unwrap(),
    );
    tar_entry(&mut builder, name, kind, bytes);
    builder.into_inner().unwrap().finish().unwrap()
}

#[test]
fn manifest_requires_semver_valid_metadata_and_inclusive_compatibility() {
    let valid = manifest(b"html");
    let manifest = parse(&valid).unwrap();
    let embedded = Version::new(0, 1, 3);
    let target = &manifest.target;
    assert!(target.compatible(1, &embedded, &embedded, 9));
    assert!(target.compatible(1, &Version::new(0, 1, 5), &embedded, 9));
    assert!(!target.compatible(1, &Version::new(0, 1, 2), &embedded, 9));
    assert!(!target.compatible(1, &Version::new(0, 1, 6), &embedded, 9));
    assert!(!target.compatible(2, &embedded, &embedded, 9));
    assert!(!target.compatible(1, &embedded, &Version::new(0, 2, 0), 9));
    assert!(!target.compatible(1, &embedded, &target.ui_version, 9));
    let same_precedence = Version::parse("0.2.0-beta.1+full-build").unwrap();
    assert!(!target.compatible(1, &embedded, &same_precedence, 9));
    assert!(!target.compatible(1, &embedded, &embedded, 8));
    assert!(!target.compatible(1, &embedded, &embedded, 10));
    for (field, value) in [
        ("uiVersion", json!("0.2")),
        ("nativeContract", json!(1.5)),
        ("dbSchemaVersion", json!(0)),
        ("dbSchemaVersion", json!(1.5)),
        ("dbSchemaVersion", Value::Null),
        ("createdAt", json!("yesterday")),
        ("maxShellVersion", json!("0.1.2")),
        ("files", json!([])),
    ] {
        let mut bad = valid.clone();
        bad[field] = value;
        assert!(parse(&bad).is_err(), "{field}");
    }
}

#[test]
fn verifies_tauri_encoding_and_minisign_signature_before_staging() {
    // Public test vector from minisign-verify's documentation.
    let public_key = STANDARD.encode(
        "untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
    );
    let raw_signature = concat!(
        "untrusted comment: signature from minisign secret key\n",
        "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/",
        "z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n",
        "trusted comment: timestamp:1633700835\tfile:test\tprehashed\n",
        "wLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==",
    );
    let signature = STANDARD.encode(raw_signature);
    assert!(verify_signature(b"test", &signature, &public_key).is_ok());
    assert!(verify_signature(b"tEst", &signature, &public_key).is_err());
    let bad_signature = STANDARD.encode(raw_signature.replace("Ai1zBI", "Ai1zBC"));
    assert!(verify_signature(b"test", &bad_signature, &public_key).is_err());

    let root = tempfile::tempdir().unwrap();
    assert!(stage(root.path(), b"test", &bad_signature, &public_key).is_err());
    assert_eq!(root.path().read_dir().unwrap().count(), 0);
    assert!(verify_signature(&vec![0; MAX_BUNDLE + 1], &signature, &public_key).is_err());
}

#[test]
fn unpacks_only_exact_listed_regular_files() {
    let root = tempfile::tempdir().unwrap();
    let content = b"html";
    let metadata = manifest(content);
    let bytes = bundle(&metadata, "index.html", EntryType::Regular, content);
    unpack(&bytes, root.path()).unwrap();
    assert_eq!(fs::read(root.path().join("index.html")).unwrap(), content);

    for (name, kind, asset) in [
        ("index.html", EntryType::Regular, b"HTML" as &[u8]),
        ("index.html", EntryType::Symlink, b""),
        ("index.html", EntryType::Link, b""),
        ("../index.html", EntryType::Regular, content),
        ("/index.html", EntryType::Regular, content),
        ("C:\\index.html", EntryType::Regular, content),
        ("unlisted.html", EntryType::Regular, content),
    ] {
        let destination = tempfile::tempdir().unwrap();
        let mut metadata = metadata.clone();
        if !kind.is_file() {
            metadata["files"][0]["size"] = json!(0);
            metadata["files"][0]["sha256"] = json!(hash(b""));
            metadata["files"].as_array_mut().unwrap().push(json!({
                "path": "index.html",
                "sha256": hash(content),
                "size": content.len()
            }));
            metadata["files"][0]["path"] = json!("linked.js");
        }
        let name = if kind.is_file() { name } else { "linked.js" };
        assert!(
            unpack(&bundle(&metadata, name, kind, asset), destination.path()).is_err(),
            "{name} {kind:?}"
        );
        assert_eq!(destination.path().read_dir().unwrap().count(), 0);
    }

    assert!(unpack(
        &bytes[..bytes.len() - 4],
        tempfile::tempdir().unwrap().path()
    )
    .is_err());
    let concatenated = [bytes.as_slice(), bytes.as_slice()].concat();
    assert!(unpack(&concatenated, tempfile::tempdir().unwrap().path()).is_err());
}

#[test]
fn rejects_unsafe_manifest_paths_and_expansion_limits() {
    let valid = manifest(b"html");
    for path in [
        "../index.html",
        "/index.html",
        "a/../index.html",
        "a\\index.html",
        "nul.js",
        "index.html/.",
        "INDEX.HTML",
    ] {
        let mut bad = valid.clone();
        bad["files"].as_array_mut().unwrap().push(json!({
            "path": path, "sha256": hash(b""), "size": 0,
        }));
        assert!(parse(&bad).is_err(), "{path}");
    }
    let mut bad = valid.clone();
    bad["files"][0]["size"] = json!(MAX_FILE + 1);
    assert!(parse(&bad).is_err());
    let mut bad = valid;
    for index in 0..5 {
        bad["files"].as_array_mut().unwrap().push(json!({
            "path": format!("assets/chunk-{index}.js"), "sha256": hash(b""), "size": MAX_FILE,
        }));
    }
    assert!(parse(&bad).is_err());
}
