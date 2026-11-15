use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Url;
use tokio::sync::oneshot;

const UNSUPPORTED: &str = "unsupported";
const CANCELLED: &str = "cancelled";

// Deep-link inspects a sole CLI URL during initialization and logs unknown
// schemes in debug builds. Ignore that unsolicited launch before it can log.
pub(super) fn ignore_startup_url(mut args: impl Iterator<Item = String>) -> bool {
    args.next(); // executable
    let argument = args.next();
    if args.next().is_some() {
        return false;
    }
    argument
        .and_then(|arg| Url::parse(&arg).ok())
        .is_some_and(|url| url.scheme() != "privatebase")
}

struct Request {
    url: Url,
    state: String,
    result_key: &'static str,
}

// Check the original spelling too: URL parsing normalizes empty userinfo,
// backslashes, dot segments and default ports before callers can inspect them.
fn validate_request(raw: &str, callback_scheme: &str) -> Result<Request, &'static str> {
    if callback_scheme != "privatebase"
        || raw
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace() || b == b'\\')
    {
        return Err(UNSUPPORTED);
    }
    let (origin, path_and_query) = raw
        .split_once("://")
        .and_then(|(scheme, rest)| {
            rest.split_once('/')
                .map(|(authority, path)| (format!("{scheme}://{authority}"), path))
        })
        .ok_or(UNSUPPORTED)?;
    let allowed_origin = matches!(
        origin.as_str(),
        "https://chat.718788.xyz" | "https://chat.718788.xyz:443"
    );
    #[cfg(debug_assertions)]
    let allowed_origin = allowed_origin || origin == "http://localhost:5173";
    if !allowed_origin {
        return Err(UNSUPPORTED);
    }
    let (value_key, result_key) = match path_and_query.split(['?', '#']).next() {
        Some("native/passkey/sign-in") => ("challenge", "code"),
        Some("native/passkey/add") => ("ticket", "registered"),
        _ => return Err(UNSUPPORTED),
    };
    let url = Url::parse(raw).map_err(|_| UNSUPPORTED)?;
    if url.fragment().is_some() {
        return Err(UNSUPPORTED);
    }
    let mut state = None;
    let mut value = None;
    for (key, item) in url.query_pairs() {
        let slot = match key.as_ref() {
            "state" => &mut state,
            key if key == value_key => &mut value,
            _ => return Err(UNSUPPORTED),
        };
        if slot.is_some()
            || item.len() != 43
            || !item
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(UNSUPPORTED);
        }
        *slot = Some(item.into_owned());
    }
    if value.is_none() {
        return Err(UNSUPPORTED);
    }
    Ok(Request {
        url,
        state: state.ok_or(UNSUPPORTED)?,
        result_key,
    })
}

fn has_callback_base(raw: &str) -> bool {
    raw.split_once('?')
        .is_some_and(|(base, _)| base == "privatebase://passkey")
        && !raw
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
}

impl Request {
    fn matches_callback(&self, raw: &str) -> bool {
        if !has_callback_base(raw) {
            return false;
        }
        let Ok(url) = Url::parse(raw) else {
            return false;
        };
        if url.fragment().is_some() {
            return false;
        }
        let mut state_seen = false;
        let mut result_seen = false;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "state" if !state_seen && value == self.state => state_seen = true,
                key if key == self.result_key && !result_seen && !value.is_empty() => {
                    result_seen = true;
                }
                _ => return false,
            }
        }
        state_seen && result_seen
    }
}

struct Pending {
    request: Arc<Request>,
    deadline: Instant,
    sender: oneshot::Sender<String>,
}

impl Pending {
    fn matches_callback(&self, callback: &str) -> bool {
        Instant::now() < self.deadline && self.request.matches_callback(callback)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum SecondInstanceRoute {
    FocusOnly,
    FocusAndCallback,
}

fn second_instance_route(
    args: &[String],
    pending: Option<&Pending>,
    now: Instant,
) -> SecondInstanceRoute {
    if args.len() == 2
        && pending.is_some_and(|p| now < p.deadline && p.request.matches_callback(&args[1]))
    {
        SecondInstanceRoute::FocusAndCallback
    } else {
        SecondInstanceRoute::FocusOnly
    }
}

#[derive(Default)]
struct Handoffs(Mutex<Option<Pending>>);

// Cancelling/dropping a command future must release its slot. Pointer identity
// prevents an older command's cleanup from removing a newer pending session.
struct Session<'a> {
    handoffs: &'a Handoffs,
    request: Arc<Request>,
}

impl Drop for Session<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.handoffs.0.lock() {
            if pending
                .as_ref()
                .is_some_and(|p| Arc::ptr_eq(&p.request, &self.request))
            {
                pending.take();
            }
        }
    }
}

impl Handoffs {
    fn route_second_instance(&self, args: &[String]) -> SecondInstanceRoute {
        self.0
            .lock()
            .map_or(SecondInstanceRoute::FocusOnly, |pending| {
                second_instance_route(args, pending.as_ref(), Instant::now())
            })
    }

    async fn start(
        &self,
        request: Request,
        duration: Duration,
        open: impl FnOnce(&str) -> Result<(), ()>,
    ) -> Result<String, &'static str> {
        let request = Arc::new(request);
        let deadline = Instant::now() + duration;
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.0.lock().map_err(|_| UNSUPPORTED)?;
            if pending.is_some() {
                return Err(UNSUPPORTED);
            }
            *pending = Some(Pending {
                request: request.clone(),
                deadline,
                sender,
            });
        }
        let _session = Session {
            handoffs: self,
            request: request.clone(),
        };
        open(request.url.as_str()).map_err(|_| UNSUPPORTED)?;
        tokio::time::timeout_at(deadline.into(), receiver)
            .await
            .map_err(|_| CANCELLED)?
            .map_err(|_| UNSUPPORTED)
    }

    fn deliver(&self, callback: &str) {
        let Ok(mut pending) = self.0.lock() else {
            return;
        };
        if pending
            .as_ref()
            .is_some_and(|p| p.matches_callback(callback))
        {
            if let Some(session) = pending.take() {
                let _ = session.sender.send(callback.to_owned());
            }
        }
    }
}

// Tauri APIs here are portable, so host tests also type-check the Windows wiring.
#[cfg(any(windows, test))]
pub(super) mod windows {
    use super::*;
    use tauri::{Manager, WebviewWindowBuilder};
    use tauri_plugin_deep_link::DeepLinkExt;
    use tauri_plugin_opener::OpenerExt;

    struct Available {
        enabled: bool,
    }

    #[tauri::command]
    pub(crate) async fn passkey_handoff_start(
        app: tauri::AppHandle,
        url: String,
        callback_scheme: String,
    ) -> Result<String, String> {
        if !app.state::<Available>().enabled {
            return Err(UNSUPPORTED.to_owned());
        }
        let request = validate_request(&url, &callback_scheme).map_err(str::to_owned)?;
        app.state::<Handoffs>()
            .start(request, Duration::from_secs(5 * 60), |url| {
                app.opener().open_url(url, None::<&str>).map_err(|_| ())
            })
            .await
            .map_err(str::to_owned)
    }

    pub(crate) fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
        builder
            // First plugin: the browser's second process forwards to this instance.
            // Filter before calling deep-link, whose debug diagnostics can log
            // nonmatching schemes. No automatic `deep-link` forwarding feature.
            .plugin(tauri_plugin_single_instance::init(|app, args, _| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                let route = app
                    .try_state::<Handoffs>()
                    .map_or(SecondInstanceRoute::FocusOnly, |state| {
                        state.route_second_instance(&args)
                    });
                if route == SecondInstanceRoute::FocusAndCallback {
                    if let Some(deep_link) =
                        app.try_state::<tauri_plugin_deep_link::DeepLink<tauri::Wry>>()
                    {
                        deep_link.handle_cli_arguments(args.iter());
                    }
                }
            }))
            .plugin(tauri_plugin_deep_link::init())
            .manage(Handoffs::default())
            .setup(|app| {
                // Writes only HKCU\Software\Classes\privatebase; no elevation.
                let available = app.deep_link().register("privatebase").is_ok();
                app.manage(Available { enabled: available });
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle.state::<Handoffs>().deliver(url.as_str());
                    }
                });
                // Never replay get_current(): a cold-start callback is unsolicited.
                // The Windows overlay defers creation so support is known before JS.
                let capture_protection = crate::capture_protection::CaptureProtection::load(
                    app.path().app_config_dir()?.join("capture-protection.json"),
                );
                let capture_protection_enabled = capture_protection.enabled()?;
                app.manage(capture_protection);
                let config = app
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|w| w.label == "main")
                    .ok_or(UNSUPPORTED)?;
                // Tao applies display affinity before creating the webview. Keep
                // the window hidden until our checked Win32 call also succeeds.
                let window = WebviewWindowBuilder::from_config(app, config)?
                    .content_protected(capture_protection_enabled)
                    .visible(false)
                    .initialization_script(crate::native_capabilities_script(available))
                    .build()?;
                #[cfg(windows)]
                crate::capture_protection::apply(&window, capture_protection_enabled)?;
                window.show()?;
                Ok(())
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;

    const STATE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const VALUE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn start_url(origin: &str, path: &str) -> String {
        let key = if path == "/native/passkey/add" {
            "ticket"
        } else {
            "challenge"
        };
        format!("{origin}{path}?state={STATE}&{key}={VALUE}")
    }

    fn request() -> Request {
        validate_request(
            &start_url("https://chat.718788.xyz", "/native/passkey/sign-in"),
            "privatebase",
        )
        .ok()
        .unwrap()
    }

    fn callback(state: &str, key: &str) -> String {
        format!("privatebase://passkey?state={state}&{key}={VALUE}")
    }

    #[test]
    fn second_instance_routing_focuses_relaunches_and_only_forwards_matching_callbacks() {
        let now = Instant::now();
        let (sender, _receiver) = oneshot::channel();
        let pending = Pending {
            request: Arc::new(request()),
            deadline: now + Duration::from_secs(300),
            sender,
        };
        let valid = vec!["app.exe".to_owned(), callback(STATE, "code")];
        assert_eq!(
            second_instance_route(&valid, Some(&pending), now),
            SecondInstanceRoute::FocusAndCallback
        );
        assert_eq!(
            second_instance_route(&valid, None, now),
            SecondInstanceRoute::FocusOnly
        );
        assert_eq!(
            second_instance_route(&valid, Some(&pending), pending.deadline),
            SecondInstanceRoute::FocusOnly
        );
        for args in [
            vec!["app.exe".to_owned()],
            vec!["app.exe".to_owned(), "--flag".to_owned()],
            vec![
                "app.exe".to_owned(),
                "privatebase://evil?state=secret".to_owned(),
            ],
            vec![
                "app.exe".to_owned(),
                "https://evil.example/?state=secret".to_owned(),
            ],
            vec!["app.exe".to_owned(), callback(VALUE, "code")],
            vec!["app.exe".to_owned(), callback(STATE, "registered")],
            vec![
                "app.exe".to_owned(),
                callback(STATE, "code"),
                "extra".to_owned(),
            ],
        ] {
            assert_eq!(
                second_instance_route(&args, Some(&pending), now),
                SecondInstanceRoute::FocusOnly
            );
            assert_eq!(
                second_instance_route(&args, None, now),
                SecondInstanceRoute::FocusOnly
            );
        }
    }

    #[test]
    fn unknown_startup_url_is_ignored_before_plugin_diagnostics() {
        for url in [
            "https://evil.example/?state=secret",
            "other://passkey?code=secret",
        ] {
            assert!(ignore_startup_url(
                ["app.exe".to_owned(), url.to_owned()].into_iter()
            ));
        }
        for args in [
            vec!["app.exe"],
            vec!["app.exe", "--flag"],
            vec!["app.exe", "privatebase://passkey?code=unsolicited"],
            vec!["app.exe", "https://example.test", "--flag"],
        ] {
            assert!(!ignore_startup_url(args.into_iter().map(str::to_owned)));
        }
    }

    #[test]
    fn accepts_both_production_paths() {
        for path in ["/native/passkey/sign-in", "/native/passkey/add"] {
            assert!(
                validate_request(&start_url("https://chat.718788.xyz", path), "privatebase")
                    .is_ok()
            );
            assert!(validate_request(
                &start_url("https://chat.718788.xyz:443", path),
                "privatebase"
            )
            .is_ok());
        }
    }

    #[test]
    fn rejects_wrong_origin_including_userinfo_and_ports() {
        for origin in [
            "https://evil.example",
            "https://chat.718788.xyz.evil.example",
            "http://chat.718788.xyz",
            "file://chat.718788.xyz",
            "javascript://chat.718788.xyz",
            "https://chat.718788.xyz:444",
            "https://chat.718788.xyz:5173",
            "https://user@chat.718788.xyz",
            "https://user:secret@chat.718788.xyz",
            "https://@chat.718788.xyz",
            "https://:secret@chat.718788.xyz",
            "http://localhost",
            "http://localhost:5174",
            "https://localhost:5173",
            "http://127.0.0.1:5173",
            "https://chat.718788.xyz.",
        ] {
            assert!(
                validate_request(&start_url(origin, "/native/passkey/sign-in"), "privatebase")
                    .is_err(),
                "{origin}"
            );
        }
    }

    #[test]
    fn rejects_wrong_and_normalized_paths() {
        for path in [
            "/",
            "/native/passkey/sign-in/extra",
            "/native/passkey/add/extra",
            "/native/passkey/sign-in/",
            "/native/passkey/sign-in-extra",
            "/native/passkey/other",
            "/native/passkey/../passkey/sign-in",
            "/native/passkey/%73ign-in",
            "/native\\passkey\\sign-in",
        ] {
            assert!(
                validate_request(&start_url("https://chat.718788.xyz", path), "privatebase")
                    .is_err(),
                "{path}"
            );
        }
    }

    #[test]
    fn rejects_bad_callback_scheme_and_queries() {
        let url = start_url("https://chat.718788.xyz", "/native/passkey/sign-in");
        for scheme in ["", "https", "PrivateBase", "privatebase:", "privatebase://"] {
            assert!(validate_request(&url, scheme).is_err());
        }
        for bad in [
            format!("{url}#fragment"),
            format!("{url}&state={STATE}"),
            format!("{url}&challenge={VALUE}"),
            format!("{url}&codeVerifier=secret"),
            url.replace(STATE, "short"),
            url.replace("challenge", "ticket"),
            url.replace(VALUE, ""),
            format!(" {url}"),
            url.replace("https", "ht\ntps"),
            "https://chat.718788.xyz/native/passkey/sign-in".to_owned(),
        ] {
            assert!(validate_request(&bad, "privatebase").is_err());
        }
    }

    #[test]
    fn localhost_is_debug_only() {
        for path in ["/native/passkey/sign-in", "/native/passkey/add"] {
            assert_eq!(
                validate_request(&start_url("http://localhost:5173", path), "privatebase").is_ok(),
                cfg!(debug_assertions)
            );
        }
    }

    #[test]
    fn callback_filter_binds_state_and_result_type() {
        let request = request();
        let valid = callback(STATE, "code");
        assert!(request.matches_callback(&valid));
        for bad in [
            callback(VALUE, "code"),
            callback(STATE, "registered"),
            valid.replace("://passkey", "://evil"),
            valid.replace("privatebase:", "https:"),
            valid.replace("://passkey", "://user@passkey"),
            valid.replace("://passkey", "://@passkey"),
            valid.replace("://passkey", "://passkey:123"),
            valid.replace("passkey?", "passkey/?"),
            valid.replace("passkey?", "passkey/extra?"),
            format!("{valid}#fragment"),
            format!("{valid}&state={STATE}"),
            format!("{valid}&code={VALUE}"),
            format!("{valid}&registered={VALUE}"),
            format!("{valid}&other=value"),
            valid.replace(VALUE, ""),
            valid.replace("state=", "missing="),
        ] {
            assert!(!request.matches_callback(&bad));
        }
        let add = validate_request(
            &start_url("https://chat.718788.xyz", "/native/passkey/add"),
            "privatebase",
        )
        .ok()
        .unwrap();
        assert!(add.matches_callback(&callback(STATE, "registered")));
        assert!(!add.matches_callback(&valid));
    }

    #[test]
    fn delivers_only_to_pending_session_and_only_once() {
        tauri::async_runtime::block_on(async {
            let handoffs = Handoffs::default();
            let valid = callback(STATE, "code");
            handoffs.deliver(&valid); // Must not queue an unsolicited callback.
            let result = handoffs
                .start(request(), Duration::from_secs(1), |_| {
                    handoffs.deliver(&callback(VALUE, "code"));
                    handoffs.deliver(&callback(STATE, "registered"));
                    assert!(handoffs.0.lock().unwrap().is_some());
                    handoffs.deliver(&valid);
                    handoffs.deliver(&valid); // Replay is ignored.
                    Ok(())
                })
                .await;
            assert_eq!(result, Ok(valid));
            assert!(handoffs.0.lock().unwrap().is_none());
        });
    }

    #[test]
    fn rejects_concurrent_start_without_opening_browser() {
        tauri::async_runtime::block_on(async {
            let handoffs = Handoffs::default();
            let mut first = Box::pin(handoffs.start(request(), Duration::from_secs(1), |_| Ok(())));
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(
                    first.as_mut().poll(cx).is_pending()
                ))
                .await
            );
            assert_eq!(
                handoffs
                    .start(request(), Duration::from_secs(1), |_| panic!(
                        "second browser opened"
                    ))
                    .await,
                Err(UNSUPPORTED)
            );
            handoffs.deliver(&callback(STATE, "code"));
            assert!(first.await.is_ok());
        });
    }

    #[test]
    fn failure_timeout_and_dropped_future_release_slot() {
        tauri::async_runtime::block_on(async {
            let handoffs = Handoffs::default();
            assert_eq!(
                handoffs
                    .start(request(), Duration::from_secs(1), |_| Err(()))
                    .await,
                Err(UNSUPPORTED)
            );
            assert!(handoffs.0.lock().unwrap().is_none());
            assert_eq!(
                handoffs
                    .start(request(), Duration::ZERO, |_| {
                        handoffs.deliver(&callback(STATE, "code")); // Expired already.
                        Ok(())
                    })
                    .await,
                Err(CANCELLED)
            );
            assert!(handoffs.0.lock().unwrap().is_none());
            let mut abandoned =
                Box::pin(handoffs.start(request(), Duration::from_secs(1), |_| Ok(())));
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(
                    abandoned.as_mut().poll(cx).is_pending()
                ))
                .await
            );
            drop(abandoned);
            assert!(handoffs.0.lock().unwrap().is_none());
            assert_eq!(
                handoffs
                    .start(request(), Duration::from_secs(1), |_| {
                        handoffs.deliver(&callback(STATE, "code"));
                        Ok(())
                    })
                    .await,
                Ok(callback(STATE, "code"))
            );
        });
    }

    #[test]
    fn stale_callback_and_older_cleanup_cannot_take_new_session() {
        tauri::async_runtime::block_on(async {
            let handoffs = Handoffs::default();
            let mut first = Box::pin(handoffs.start(request(), Duration::from_secs(1), |_| Ok(())));
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(
                    first.as_mut().poll(cx).is_pending()
                ))
                .await
            );
            handoffs.deliver(&callback(STATE, "code"));
            let mut next_request = request();
            next_request.state = VALUE.to_owned();
            let mut next =
                Box::pin(handoffs.start(next_request, Duration::from_secs(1), |_| Ok(())));
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(
                    next.as_mut().poll(cx).is_pending()
                ))
                .await
            );
            assert!(first.await.is_ok()); // Its guard must not clear `next`.
            assert_eq!(
                handoffs.route_second_instance(&["app.exe".to_owned(), callback(STATE, "code")]),
                SecondInstanceRoute::FocusOnly
            );
            handoffs.deliver(&callback(STATE, "code"));
            assert_eq!(
                handoffs.route_second_instance(&["app.exe".to_owned(), callback(VALUE, "code")]),
                SecondInstanceRoute::FocusAndCallback
            );
            handoffs.deliver(&callback(VALUE, "code"));
            assert_eq!(next.await, Ok(callback(VALUE, "code")));
        });
    }

    #[test]
    fn windows_builder_wiring_type_checks_on_host() {
        let _configure: fn(tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> =
            windows::configure;
    }
}
