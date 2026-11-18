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
fn hello_stays_available_after_a_transient_probe_failure() {
    for probe in [Ok(true), Err(FAILED), Err("lockout")] {
        assert!(offer_hello_at_startup(probe, || panic!(
            "no slot lookup needed"
        )));
    }
    for probe in [Ok(false), Err(UNSUPPORTED)] {
        assert!(offer_hello_at_startup(probe, || true));
        assert!(!offer_hello_at_startup(probe, || false));
    }
}

#[test]
fn a_stalled_probe_releases_startup_with_hello_still_retryable() {
    let (release, blocked) = mpsc::channel();
    let (finished, done) = mpsc::channel();
    assert!(offer_hello_with_deadline(
        Duration::from_millis(20),
        move || {
            // A deadline regression eventually returns false instead of hanging
            // the test suite. The real path returns while this worker is blocked.
            let _ = blocked.recv_timeout(Duration::from_secs(2));
            let _ = finished.send(());
            false
        }
    ));
    assert!(done.try_recv().is_err());
    release.send(()).unwrap();
    done.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(!offer_hello_with_deadline(Duration::from_secs(2), || false));
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
fn ipc_rejects_all_three_commands_when_hello_is_unavailable() {
    use tauri::{
        ipc::CallbackFn,
        test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY},
        webview::InvokeRequest,
        WebviewWindowBuilder,
    };

    // Supply unavailable state without running the OS probe or a Hello prompt.
    let state = BiometricUnlock(None);
    assert_eq!(state.capability(), None);
    let app = mock_builder()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            biometric_unlock_enroll,
            biometric_unlock,
            biometric_unlock_remove
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    let main = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    for (command, args) in [
        (
            "biometric_unlock_enroll",
            serde_json::json!({ "vaultId": VAULT_ID, "key": URL_SAFE_NO_PAD.encode([0; 32]) }),
        ),
        (
            "biometric_unlock",
            serde_json::json!({ "vaultId": VAULT_ID }),
        ),
        (
            "biometric_unlock_remove",
            serde_json::json!({ "vaultId": VAULT_ID }),
        ),
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
