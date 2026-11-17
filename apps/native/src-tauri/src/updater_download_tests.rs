use std::{
    io::{BufRead, BufReader},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    thread,
    time::Instant,
};

use super::*;

// Public verification vectors from tauri-plugin-updater 2.14.1's offline tests.
// These authenticate the four-byte payload "test", version 2.0.0; no private key.
const PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEE0OUVGNDc0NkZBNkU2RDcKUldUWDVxWnZkUFNlcERHV2cyYno4bjZBclFuQk13Z1FLMWdlVm9zb3JjYkx6Y3VuRCtLSitjWWU=";
const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUWDVxWnZkUFNlcFBGMnpzanZQL0wvVFF0QkxSbldSdmFxKzRvbUsxVUV1Z3RRcC9VU3JHaUkxdjc2MnNEeTNpZDNhb3I3YlJDOUVUeWVvdDZsTUhIcldvWjVoalVNMVFjPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxNjQ5MDUxCWZpbGU6cGF5bG9hZAl2ZXJzaW9uOjIuMC4wCkREcTJDTE9FbDVjUW1DMmVKUkhsblpQVlZpT1pzdTFDanBQS1FvZWk0QS9YQmZrRHFHTzBCK1FNcmNySGdFUTVxVjNtbmU3NXRkRldoSnBxVVhoOUFBPT0=";

async fn download_app(
    address: std::net::SocketAddr,
    read_timeout: Duration,
) -> tauri::App<tauri::test::MockRuntime> {
    // Production's update check initializes this before returning an Update;
    // these tests restore the fixture directly without a manifest request.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({ "pubkey": PUBLIC_KEY }),
    );
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(UpdateState::default())
        .build(context)
        .unwrap();
    let update = app
        .updater_builder()
        .target("test-target")
        .executable_path("runtime-path/app")
        .endpoints(vec!["https://example.invalid/update".parse().unwrap()])
        .unwrap()
        .configure_client(move |client| {
            // Only the loopback fixture uses HTTP; production remains HTTPS-only.
            configure_update_client(client, read_timeout)
                .https_only(false)
                .no_proxy()
        })
        .build()
        .unwrap()
        .restore_update(serde_json::json!({
            "version": "2.0.0",
            "platforms": { "test-target": {
                "url": format!("http://{address}/artifact"),
                "signature": SIGNATURE
            }}
        }))
        .unwrap()
        .unwrap();
    // Reproduce the pinned plugin's missing per-Update overall timeout.
    assert!(update.timeout.is_none());
    update.verify(b"test").unwrap();
    app.state::<UpdateState>().0.lock().await.pending = Some(PendingUpdate {
        update,
        bytes: None,
    });
    app
}

fn accept_request(listener: &TcpListener) -> TcpStream {
    let (mut stream, _) = listener.accept().unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut reader = BufReader::new(&mut stream);
    loop {
        let mut line = String::new();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        if line == "\r\n" {
            return stream;
        }
    }
}

#[test]
fn transport_failure_releases_session_and_keeps_the_update_retryable() {
    tauri::async_runtime::block_on(async {
        let app = download_app("127.0.0.1:0".parse().unwrap(), DOWNLOAD_READ_TIMEOUT).await;
        let state = app.state::<UpdateState>();
        // An unsupported transport fails in reqwest before opening any socket.
        state
            .0
            .lock()
            .await
            .pending
            .as_mut()
            .unwrap()
            .update
            .download_url = "unsupported://artifact".parse().unwrap();
        for _ in 0..2 {
            assert_eq!(
                update_download(app.handle().clone(), state.clone()).await,
                Err("network")
            );
            let session = state.0.try_lock().expect("failure must release the mutex");
            let pending = session
                .pending
                .as_ref()
                .expect("retain the update for retry");
            assert!(pending.bytes.is_none());
            assert_eq!(pending.update.version, "2.0.0");
        }
    });
}

#[test]
#[ignore = "requires loopback TCP binding; run explicitly with cargo test -- --ignored"]
fn stalled_download_releases_session_and_verified_retry_succeeds() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (release, stalled) = mpsc::channel();
    let server = thread::spawn(move || {
        let mut stream = accept_request(&listener);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nt")
            .unwrap();
        // Bound the fixture even if the read timeout is accidentally removed.
        let _ = stalled.recv_timeout(Duration::from_secs(3));
        drop(stream);
        let mut stream = accept_request(&listener);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntest")
            .unwrap();
    });

    tauri::async_runtime::block_on(async {
        let app = download_app(address, Duration::from_millis(250)).await;
        let state = app.state::<UpdateState>();
        let started = Instant::now();
        let result = update_download(app.handle().clone(), state.clone()).await;
        let elapsed = started.elapsed();
        release.send(()).unwrap();
        assert_eq!(result, Err("network"));
        assert!(elapsed < Duration::from_secs(2));
        {
            let session = state.0.try_lock().expect("timeout must release the mutex");
            assert!(session.pending.as_ref().unwrap().bytes.is_none());
        }

        update_download(app.handle().clone(), state.clone())
            .await
            .unwrap();
        let session = state.0.try_lock().unwrap();
        assert_eq!(
            session.pending.as_ref().unwrap().bytes.as_deref(),
            Some(b"test".as_slice())
        );
    });
    server.join().unwrap();
}

#[test]
#[ignore = "requires loopback TCP binding; run explicitly with cargo test -- --ignored"]
fn progressing_download_can_exceed_the_read_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let mut stream = accept_request(&listener);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\n")
            .unwrap();
        for byte in b"test" {
            thread::sleep(Duration::from_millis(200));
            stream.write_all(&[*byte]).unwrap();
        }
    });

    tauri::async_runtime::block_on(async {
        let read_timeout = Duration::from_millis(500);
        let app = download_app(address, read_timeout).await;
        let state = app.state::<UpdateState>();
        let started = Instant::now();
        update_download(app.handle().clone(), state.clone())
            .await
            .unwrap();
        assert!(started.elapsed() > read_timeout);
        assert_eq!(
            state
                .0
                .lock()
                .await
                .pending
                .as_ref()
                .unwrap()
                .bytes
                .as_deref(),
            Some(b"test".as_slice())
        );
    });
    server.join().unwrap();
}
