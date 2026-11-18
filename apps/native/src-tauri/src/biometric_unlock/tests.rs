use super::*;

const VAULT_ID: &str = "3d0d68db-eb21-4c1e-9cf7-bf13abb6e151";

#[test]
fn validates_the_adapter_uuid_without_path_or_case_aliases() {
    assert_eq!(validate_vault_id(VAULT_ID), Ok(()));
    for invalid in [
        "",
        "../device",
        "C:\\device",
        "NUL",
        "3D0D68DB-EB21-4C1E-9CF7-BF13ABB6E151",
        "3d0d68db-eb21-1c1e-9cf7-bf13abb6e151",
        "3d0d68db-eb21-4c1e-0cf7-bf13abb6e151",
        "3d0d68db-eb21-4c1e-9cf7-bf13abb6e15/",
        "3d0d68db-eb21-4c1e-9cf7-bf13abb6e151 ",
    ] {
        assert_eq!(validate_vault_id(invalid), Err(FAILED));
    }
}

#[test]
fn accepts_only_canonical_unpadded_base64url_for_32_bytes() {
    let raw = [255; 32];
    let valid = URL_SAFE_NO_PAD.encode(raw);
    assert_eq!(valid.len(), 43);
    assert_eq!(*decode_key(&valid).unwrap(), raw);
    let noncanonical = format!("{}9", &valid[..42]);
    for invalid in [
        format!("{valid}="),
        valid.replace('_', "/"),
        noncanonical,
        URL_SAFE_NO_PAD.encode([0; 31]),
        URL_SAFE_NO_PAD.encode([0; 33]),
    ] {
        assert_eq!(decode_key(&invalid).err(), Some(FAILED));
    }
}

#[test]
fn maps_hello_statuses_without_exposing_os_errors() {
    for (status, expected) in [
        (0, Ok(())),
        (1, Err(FAILED)),
        (2, Err(INVALIDATED)),
        (3, Err("cancelled")),
        (4, Err("cancelled")),
        (5, Err(FAILED)),
        (6, Err("lockout")),
        (7, Err(UNSUPPORTED)),
        (i32::MAX, Err(FAILED)),
    ] {
        assert_eq!(hello_status(status, true), expected);
    }
    assert_eq!(hello_status(2, false), Err(FAILED));
}

#[test]
fn only_definitive_public_key_export_errors_are_unsupported() {
    for code in [
        0x80004001u32,
        0x80070032,
        0x80090008,
        0x8009000a,
        0x80090029,
    ] {
        assert_eq!(public_key_export_error(code as i32), UNSUPPORTED);
    }
    for code in [0x80010108u32, 0x800706ba, 0x80004005, 0x80070057] {
        // Disconnected, RPC server unavailable, generic failure, invalid arg.
        assert_eq!(public_key_export_error(code as i32), FAILED);
    }
}

#[test]
fn probe_distinguishes_supported_unavailable_and_retryable_failure() {
    assert_eq!(probe_result(Ok(true)), Ok(Some("windows-hello")));
    assert_eq!(probe_result(Ok(false)), Ok(None));
    assert_eq!(probe_result(Err(UNSUPPORTED)), Ok(None));
    assert_eq!(probe_result(Err(FAILED)), Err(FAILED));
}

#[test]
fn a_stalled_probe_releases_startup_and_can_be_retried() {
    let probe = ReadinessProbe::default();
    let (release, blocked) = mpsc::channel();
    let (started, running) = mpsc::channel();
    assert_eq!(
        probe.check(Duration::from_millis(20), move || {
            started.send(()).unwrap();
            let _ = blocked.recv_timeout(Duration::from_secs(2));
            Ok(false)
        }),
        Err(FAILED)
    );
    running.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(
        probe.check(Duration::from_secs(1), || panic!("one OS query at a time")),
        Err(FAILED)
    );
    release.send(()).unwrap();
    drop(probe.active.lock().unwrap());
    assert_eq!(probe.check(Duration::from_secs(1), || Ok(true)), Ok(true));
}

#[test]
fn enrollment_arguments_accept_locale_without_affecting_the_key() {
    let body = serde_json::json!({
        "vaultId": VAULT_ID,
        "key": URL_SAFE_NO_PAD.encode([37; 32]),
        "locale": "fr-CA",
    });
    let (vault, key) = enrollment_arguments(&body.into()).unwrap();
    assert_eq!(vault, VAULT_ID);
    assert_eq!(*key, [37; 32]);
}

#[test]
fn queued_enrollment_excludes_cleanup_across_processes_until_it_settles() {
    const LOCK_ROOT: &str = "PRIVATEBASE_TEST_BIOMETRIC_LOCK_ROOT";
    if let Some(root) = std::env::var_os(LOCK_ROOT) {
        assert!(matches!(
            StoreLease::try_acquire(Path::new(&root)),
            Err(FAILED)
        ));
        return;
    }

    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let lease = StoreLease::try_acquire(root).unwrap();
    let path = current_slot_path(root, VAULT_ID);
    let slot = path.clone();
    let enrollment = async move {
        let _lease = lease;
        fs::write(slot, b"wrapped fixture").unwrap();
    };
    // The enrollment is admitted even though its response future has never
    // been polled. A restarted document or another process must retry removal.
    assert!(matches!(StoreLease::try_acquire(root), Err(FAILED)));
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "biometric_unlock::tests::queued_enrollment_excludes_cleanup_across_processes_until_it_settles"])
        .env(LOCK_ROOT, root)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&child.stdout);
    assert!(
        child.status.success() && stdout.contains("1 passed"),
        "{stdout}"
    );
    assert!(!path.exists());

    tauri::async_runtime::block_on(enrollment);
    for _ in 0..2 {
        let _lease = StoreLease::try_acquire(root).unwrap();
        remove_slot(&path, || Ok(())).unwrap();
        assert!(!path.exists());
    }
}

#[test]
fn enrollment_signs_twice_and_only_commits_a_reproducible_signature() {
    let directory = tempfile::tempdir().unwrap();
    let slot = directory.path().join("test.dpapi");
    for second in [Ok(38), Err("cancelled"), Err(FAILED), Ok(37)] {
        let mut results = [Ok(37), second].into_iter();
        let result = with_reproducible_signature(
            || {
                results
                    .next()
                    .unwrap()
                    .map(|byte| Zeroizing::new(vec![byte; 256]))
            },
            |signature| {
                assert_eq!(signature, &[37; 256]);
                fs::write(&slot, b"wrapped fixture").map_err(|_| FAILED)
            },
        );
        assert_eq!(results.next(), None);
        match second {
            Ok(37) => {
                assert_eq!(result, Ok(()));
                assert!(slot.is_file());
            }
            Ok(_) => {
                assert_eq!(result, Err(UNSUPPORTED));
                assert!(!slot.exists());
            }
            Err(error) => {
                assert_eq!(result, Err(error));
                assert!(!slot.exists());
            }
        }
    }
}

#[test]
fn signature_source_is_wiped_even_if_its_length_is_unsupported() {
    let mut source = [37; 256];
    assert_eq!(
        &copy_and_wipe_signature(&mut source).unwrap()[..],
        &[37; 256]
    );
    assert_eq!(source, [0; 256]);
    let mut invalid = [37; 255];
    assert_eq!(
        copy_and_wipe_signature(&mut invalid).err(),
        Some(UNSUPPORTED)
    );
    assert_eq!(invalid, [0; 255]);
}

#[test]
fn wrapping_is_bound_to_the_credential_and_challenge_and_detects_tampering() {
    let key = Zeroizing::new([35; 32]);
    let signature = [77; 256];
    let fingerprint = [78; 32];
    let challenge = b"installation:one/vault:one";
    let record = seal(&key, challenge, &signature, &fingerprint, [37; 12]).unwrap();
    assert!(!record.windows(32).any(|bytes| bytes == *key));
    assert_eq!(check_credential(&record, &fingerprint), Ok(()));
    assert_eq!(check_credential(&record, &[79; 32]), Err(INVALIDATED));
    assert_eq!(*unseal(&record, challenge, &signature).unwrap(), *key);
    for other_challenge in [b"installation:two/vault:one", b"installation:one/vault:two"] {
        assert_eq!(
            unseal(&record, other_challenge, &signature).err(),
            Some(FAILED)
        );
    }
    assert_eq!(unseal(&record, challenge, &[79; 256]).err(), Some(FAILED));
    let mut corrupt = record;
    corrupt[RECORD_LEN - 1] ^= 1;
    assert_eq!(unseal(&corrupt, challenge, &signature).err(), Some(FAILED));
}

#[test]
fn removal_retries_keep_the_record_until_the_credential_is_gone() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("slot.dpapi");
    fs::write(&path, b"opaque wrapped record").unwrap();
    assert_eq!(remove_slot(&path, || Err(FAILED)), Err(FAILED));
    assert!(path.is_file());
    assert_eq!(remove_slot(&path, || Ok(())), Ok(()));
    assert!(!path.exists());
    // The next cleanup retry still attempts to remove a potential orphan.
    assert_eq!(remove_slot(&path, || Err(FAILED)), Err(FAILED));
    assert_eq!(remove_slot(&path, || Ok(())), Ok(()));
}

#[test]
fn failed_enrollment_keeps_the_durable_id_until_later_deletion_succeeds() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let pending = pending_enrollment_path(root, VAULT_ID);
    let name = vault_credential(VAULT_ID);
    assert_eq!(
        journal_enrollment(
            root,
            VAULT_ID,
            || {
                assert!(
                    pending.is_file(),
                    "journal must precede credential creation"
                );
                Err(UNSUPPORTED)
            },
            |credential| {
                assert_eq!(credential, name);
                Err(FAILED)
            },
        ),
        Err(UNSUPPORTED)
    );
    assert!(pending.is_file());
    retry_pending_enrollments(root, |credential| {
        assert_eq!(credential, name);
        Err(FAILED)
    });
    assert!(pending.is_file());
    // A fresh request can recover the old UUID without the web client passing it.
    let mut removed = Vec::new();
    retry_pending_enrollments(root, |credential| {
        removed.push(credential.to_owned());
        Ok(())
    });
    assert_eq!(removed, [name]);
    assert!(!pending.exists());
}

#[test]
fn recovery_clears_a_committed_marker_without_deleting_its_credential() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let pending = pending_enrollment_path(root, VAULT_ID);
    let slot = current_slot_path(root, VAULT_ID);
    assert_eq!(
        journal_enrollment(
            root,
            VAULT_ID,
            || {
                assert!(pending.is_file());
                fs::write(&slot, b"wrapped fixture").map_err(|_| FAILED)
            },
            |_| panic!("must not delete committed credential")
        ),
        Ok(())
    );
    assert!(!pending.exists());
    // Simulate an exit after the wrapped record was written.
    fs::write(&pending, []).unwrap();
    retry_pending_enrollments(root, |_| panic!("must not delete committed credential"));
    assert!(!pending.exists());
    assert!(slot.is_file());
}

#[test]
fn a_failed_enrollment_with_confirmed_rollback_clears_its_marker() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    assert_eq!(
        journal_enrollment(root, VAULT_ID, || Err(FAILED), |_| Ok(())),
        Err(FAILED)
    );
    assert!(!pending_enrollment_path(root, VAULT_ID).exists());
}

#[test]
fn removal_recovers_new_credential_names_without_installation_id() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let slot = root.join(format!("{VAULT_ID}.v2.dpapi"));
    fs::write(&slot, b"wrapped fixture").unwrap();
    let expected = vault_credential(VAULT_ID);
    assert_eq!(
        remove_vault_slots(
            root,
            VAULT_ID,
            || Ok(None),
            |_, _| panic!("new slot"),
            |name| {
                assert_eq!(name, expected);
                Err(FAILED)
            }
        ),
        Err(FAILED)
    );
    assert!(slot.is_file());
    for _ in 0..2 {
        assert_eq!(
            remove_vault_slots(
                root,
                VAULT_ID,
                || Ok(None),
                |_, _| panic!("new slot"),
                |name| {
                    assert_eq!(name, expected);
                    Ok(())
                }
            ),
            Ok(())
        );
        assert!(!slot.exists());
    }
}

#[test]
fn removal_cleans_v2_even_if_installation_id_is_unreadable() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let current = current_slot_path(root, VAULT_ID);
    let pending = pending_enrollment_path(root, VAULT_ID);
    fs::write(&current, b"wrapped fixture").unwrap();
    fs::write(&pending, []).unwrap();
    // Run twice to exercise both an identified v2 record and an absent record.
    for _ in 0..2 {
        assert_eq!(
            remove_vault_slots(
                root,
                VAULT_ID,
                || Err(FAILED),
                |_, _| panic!("new slot"),
                |name| {
                    assert_eq!(name, vault_credential(VAULT_ID));
                    Ok(())
                },
            ),
            Ok(())
        );
        assert!(!current.exists());
        assert!(!pending.exists());
    }
}

#[test]
fn removal_preserves_an_unidentifiable_legacy_slot_for_retry() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let legacy = root.join(format!("{VAULT_ID}.dpapi"));
    fs::write(&legacy, b"legacy wrapped fixture").unwrap();
    assert_eq!(
        remove_vault_slots(
            root,
            VAULT_ID,
            || Ok(None),
            |_, _| panic!("legacy name unknown"),
            |name| {
                assert_eq!(name, vault_credential(VAULT_ID));
                Ok(())
            },
        ),
        Err(FAILED)
    );
    assert!(legacy.is_file());
    let installation = [27; 32];
    assert_eq!(
        remove_vault_slots(
            root,
            VAULT_ID,
            || Ok(Some([28; 32])),
            |_, _| Err(FAILED),
            |name| {
                assert_eq!(name, vault_credential(VAULT_ID));
                Ok(())
            },
        ),
        Err(FAILED)
    );
    assert!(legacy.is_file());
    let mut deleted = Vec::new();
    assert_eq!(
        remove_vault_slots(
            root,
            VAULT_ID,
            || Ok(Some(installation)),
            |path, name| {
                assert_eq!(path, legacy);
                assert_eq!(name, vault_challenge(&installation, VAULT_ID));
                Ok(())
            },
            |name| {
                deleted.push(name.to_owned());
                Ok(())
            },
        ),
        Ok(())
    );
    assert_eq!(
        deleted,
        [
            vault_credential(VAULT_ID),
            vault_challenge(&installation, VAULT_ID)
        ]
    );
    assert!(!legacy.exists());
}

#[test]
fn ipc_rejects_all_four_commands_without_a_local_store() {
    use tauri::{
        ipc::CallbackFn,
        test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY},
        webview::InvokeRequest,
        WebviewWindowBuilder,
    };

    // Supply unavailable state without running the OS probe or a Hello prompt.
    let state = BiometricUnlock(None);
    assert_eq!(state.initial_readiness(), None);
    let other_commands: fn(Invoke<tauri::test::MockRuntime>) -> bool = tauri::generate_handler![
        biometric_unlock_probe,
        biometric_unlock,
        biometric_unlock_remove
    ];
    let app = mock_builder()
        .manage(state)
        .invoke_handler(move |invoke| match invoke.message.command() {
            "biometric_unlock_enroll" => dispatch_enrollment(invoke),
            _ => other_commands(invoke),
        })
        .build(mock_context(noop_assets()))
        .unwrap();
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    for (command, args) in [
        (
            "biometric_unlock_enroll",
            serde_json::json!({ "vaultId": VAULT_ID, "key": URL_SAFE_NO_PAD.encode([0; 32]), "locale": "de-DE" }),
        ),
        (
            "biometric_unlock",
            serde_json::json!({ "vaultId": VAULT_ID, "locale": "de-DE" }),
        ),
        (
            "biometric_unlock_remove",
            serde_json::json!({ "vaultId": VAULT_ID }),
        ),
        ("biometric_unlock_probe", serde_json::json!({})),
    ] {
        let response = get_ipc_response(
            &main,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: if cfg!(any(windows, target_os = "android")) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: args.into(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        );
        assert_eq!(response.unwrap_err(), serde_json::json!(UNSUPPORTED));
    }
}
