use std::{io, time::Duration};

use crate::ui_bundle_archive::invalid;

const READ_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

pub struct Client {
    #[cfg(not(target_os = "android"))]
    inner: reqwest::Client,
}

impl Client {
    pub fn new(_base: &str) -> io::Result<Self> {
        #[cfg(not(target_os = "android"))]
        let inner = {
            let builder = crate::update_transport::configure_update_client(
                reqwest::Client::builder(),
                READ_TIMEOUT,
            );
            #[cfg(all(debug_assertions, desktop))]
            let builder = if reqwest::Url::parse(_base)
                .is_ok_and(|url| crate::ui_bundle_test_feed::allows_http(&url))
            {
                builder.https_only(false).no_proxy()
            } else {
                builder
            };
            builder
                .timeout(REQUEST_TIMEOUT)
                .build()
                .map_err(io::Error::other)?
        };
        Ok(Self {
            #[cfg(not(target_os = "android"))]
            inner,
        })
    }

    // Only an authenticated 204 or 404 is an absent feed. TLS and other
    // request failures must leave the prepared update policy in place.
    pub async fn get(&self, url: String, limit: usize) -> io::Result<Option<Vec<u8>>> {
        #[cfg(target_os = "android")]
        {
            tauri::async_runtime::spawn_blocking(move || android::get(&url, limit, false))
                .await
                .map_err(io::Error::other)?
        }
        #[cfg(not(target_os = "android"))]
        {
            let mut response = self.inner.get(url).send().await.map_err(io::Error::other)?;
            if !has_body(response.status().as_u16(), response.content_length(), limit)? {
                return Ok(None);
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(io::Error::other)? {
                check_chunk(bytes.len(), chunk.len(), limit)?;
                bytes.extend_from_slice(&chunk);
            }
            Ok(Some(bytes))
        }
    }

    pub async fn get_archive(&self, url: String, limit: usize) -> io::Result<Option<Vec<u8>>> {
        #[cfg(target_os = "android")]
        {
            tauri::async_runtime::spawn_blocking(move || android::get(&url, limit, true))
                .await
                .map_err(io::Error::other)?
        }
        #[cfg(not(target_os = "android"))]
        self.get(url, limit).await
    }
}

#[cfg(target_os = "android")]
pub use android::unmetered;

#[cfg(all(debug_assertions, any(target_os = "android", all(test, desktop))))]
pub(crate) fn android_local_test_http(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|url| crate::ui_bundle_test_feed::allows_http(&url))
}

#[cfg(any(target_os = "android", test))]
fn require_unmetered<T>(route: Option<T>) -> io::Result<T> {
    route.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::WouldBlock,
            "OTA download waits for unmetered Android connectivity",
        )
    })
}

#[cfg(any(target_os = "android", test))]
fn android_archive_route<T>(
    archive: bool,
    local_test_http: bool,
    unmetered: impl FnOnce() -> Option<T>,
) -> io::Result<Option<T>> {
    if archive && !local_test_http {
        require_unmetered(unmetered()).map(Some)
    } else {
        Ok(None)
    }
}

#[cfg(any(target_os = "android", test))]
fn recheck_failed_transfer<T, E: From<io::Error>>(
    result: Result<T, E>,
    is_unmetered: impl FnOnce() -> bool,
) -> Result<T, E> {
    if result.is_err() {
        require_unmetered(is_unmetered().then_some(()))?;
    }
    result
}

fn has_body(status: u16, size: Option<u64>, limit: usize) -> io::Result<bool> {
    match status {
        204 | 404 => Ok(false),
        200..=299 if size.is_none_or(|size| size <= limit as u64) => Ok(true),
        200..=299 => Err(invalid("OTA response exceeds size limit")),
        _ => Err(io::Error::other("unexpected OTA response status")),
    }
}

fn check_chunk(received: usize, next: usize, limit: usize) -> io::Result<()> {
    if next > limit.saturating_sub(received) {
        return Err(invalid("OTA response exceeds size limit"));
    }
    Ok(())
}

#[cfg(target_os = "android")]
mod android {
    use std::time::Instant;

    use jni::{
        objects::{JObject, JValue},
        JNIEnv, JavaVM,
    };

    use super::*;
    use crate::ota::ota_debug;

    type JavaResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

    fn with_java<T>(action: impl FnOnce(&mut JNIEnv<'_>) -> JavaResult<T>) -> io::Result<T> {
        // Tao initializes ndk-context with the Android process's JavaVM before
        // Tauri starts the OTA worker. The VM outlives this attached thread.
        let vm = unsafe { JavaVM::from_raw(ndk_context::android_context().vm().cast()) }
            .map_err(io::Error::other)?;
        let mut env = vm.attach_current_thread().map_err(io::Error::other)?;
        let result = env.with_local_frame(16, action);
        clear_java_exception(&mut env).map_err(io::Error::other)?;
        result.map_err(|error| match error.downcast::<io::Error>() {
            Ok(error) => *error,
            Err(error) => io::Error::other(error),
        })
    }

    struct Route<'local> {
        manager: JObject<'local>,
        network: JObject<'local>,
    }

    impl Route<'_> {
        fn metering(&self, env: &mut JNIEnv<'_>) -> jni::errors::Result<Option<bool>> {
            let caps = env
                .call_method(
                    &self.manager,
                    "getNetworkCapabilities",
                    "(Landroid/net/Network;)Landroid/net/NetworkCapabilities;",
                    &[JValue::Object(&self.network)],
                )?
                .l()?;
            if caps.is_null() {
                return Ok(None);
            }
            let caps = env.auto_local(caps);
            // android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED
            env.call_method(caps.as_ref(), "hasCapability", "(I)Z", &[JValue::Int(11)])?
                .z()
                .map(Some)
        }

        fn confirmed_unmetered(&self, env: &mut JNIEnv<'_>) -> bool {
            self.metering(env).is_ok_and(|status| status == Some(true))
        }
    }

    fn active_route<'local>(env: &mut JNIEnv<'local>) -> JavaResult<Option<Route<'local>>> {
        // Tao holds a global reference to the Android application context.
        let context = unsafe { JObject::from_raw(ndk_context::android_context().context().cast()) };
        let service = env.new_string("connectivity")?;
        let manager = env
            .call_method(
                context,
                "getSystemService",
                "(Ljava/lang/String;)Ljava/lang/Object;",
                &[JValue::Object(&service)],
            )?
            .l()?;
        let network = env
            .call_method(&manager, "getActiveNetwork", "()Landroid/net/Network;", &[])?
            .l()?;
        Ok((!network.is_null()).then_some(Route { manager, network }))
    }

    pub fn unmetered() -> Option<bool> {
        with_java(|env| match active_route(env)? {
            Some(route) => Ok(route.metering(env)?),
            None => Ok(None),
        })
        .ok()
        .flatten()
    }

    pub(super) fn get(url: &str, limit: usize, archive: bool) -> io::Result<Option<Vec<u8>>> {
        #[cfg(debug_assertions)]
        let test_http = android_local_test_http(url);
        #[cfg(not(debug_assertions))]
        let test_http = false;
        ota_debug!("Android request {url} (archive: {archive}, local test HTTP: {test_http})");
        with_java(|env| {
            // Emulator host aliases and adb-reversed loopback need the default route.
            let route = android_archive_route(archive, test_http, || {
                active_route(env)
                    .ok()
                    .flatten()
                    .filter(|route| route.confirmed_unmetered(env))
            })?;
            ota_debug!("Android request uses bound network: {}", route.is_some());
            let result = transfer(env, url, limit, route.as_ref(), test_http);
            if let Some(route) = &route {
                // A blocked read can throw before the next metering check.
                // Clear that exception before asking about the bound route.
                recheck_failed_transfer(result, || {
                    clear_java_exception(env).is_ok() && route.confirmed_unmetered(env)
                })
            } else {
                result
            }
        })
    }

    fn transfer(
        env: &mut JNIEnv<'_>,
        url: &str,
        limit: usize,
        route: Option<&Route<'_>>,
        test_http: bool,
    ) -> JavaResult<Option<Vec<u8>>> {
        let url = env.new_string(url)?;
        let url = env.new_object(
            "java/net/URL",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&url)],
        )?;
        // Bind archive transfers to the inspected network so they cannot
        // switch to cellular when Wi-Fi disappears.
        #[cfg(debug_assertions)]
        let conn = if test_http {
            let direct = env
                .get_static_field("java/net/Proxy", "NO_PROXY", "Ljava/net/Proxy;")?
                .l()?;
            env.call_method(
                &url,
                "openConnection",
                "(Ljava/net/Proxy;)Ljava/net/URLConnection;",
                &[JValue::Object(&direct)],
            )
        } else {
            open_connection(env, &url, route)
        }?;
        #[cfg(not(debug_assertions))]
        let conn = open_connection(env, &url, route)?;
        let conn = conn.l()?;
        // Leave the platform socket factory and hostname verifier in
        // place. Conscrypt applies app trust policy and disabled roots.
        if !test_http && !env.is_instance_of(&conn, "javax/net/ssl/HttpsURLConnection")? {
            return Err(invalid("OTA requires HTTPS").into());
        }
        let result = response(env, &conn, limit, route);
        clear_java_exception(env)?;
        env.call_method(&conn, "disconnect", "()V", &[])?;
        result
    }

    fn open_connection<'local>(
        env: &mut JNIEnv<'local>,
        url: &JObject<'local>,
        route: Option<&Route<'_>>,
    ) -> jni::errors::Result<jni::objects::JValueOwned<'local>> {
        match route {
            Some(route) => env.call_method(
                &route.network,
                "openConnection",
                "(Ljava/net/URL;)Ljava/net/URLConnection;",
                &[JValue::Object(url)],
            ),
            None => env.call_method(url, "openConnection", "()Ljava/net/URLConnection;", &[]),
        }
    }

    fn clear_java_exception(env: &mut JNIEnv<'_>) -> jni::errors::Result<()> {
        if env.exception_check()? {
            #[cfg(debug_assertions)]
            let exception = env.exception_occurred();
            env.exception_clear()?;
            #[cfg(debug_assertions)]
            if let Ok(exception) = exception {
                let exception = env.auto_local(exception);
                let _ = env.with_local_frame(2, |env| -> jni::errors::Result<()> {
                    let tag = env.new_string("PrivateBaseOTA")?;
                    let message = env.new_string("Android OTA HTTP exception")?;
                    env.call_static_method(
                        "android/util/Log",
                        "d",
                        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/Throwable;)I",
                        &[
                            JValue::Object(&tag),
                            JValue::Object(&message),
                            JValue::Object(exception.as_ref()),
                        ],
                    )?;
                    Ok(())
                });
                if env.exception_check()? {
                    env.exception_clear()?;
                }
            }
        }
        Ok(())
    }

    fn response(
        env: &mut JNIEnv<'_>,
        conn: &JObject<'_>,
        limit: usize,
        route: Option<&Route<'_>>,
    ) -> JavaResult<Option<Vec<u8>>> {
        let started = Instant::now();
        env.call_method(
            conn,
            "setInstanceFollowRedirects",
            "(Z)V",
            &[JValue::Bool(0)],
        )?;
        env.call_method(conn, "setUseCaches", "(Z)V", &[JValue::Bool(0)])?;
        env.call_method(conn, "setConnectTimeout", "(I)V", &[JValue::Int(15_000)])?;
        env.call_method(
            conn,
            "setReadTimeout",
            "(I)V",
            &[JValue::Int(READ_TIMEOUT.as_millis() as i32)],
        )?;
        let status = env.call_method(conn, "getResponseCode", "()I", &[])?.i()?;
        let size = env.call_method(conn, "getContentLength", "()I", &[])?.i()?;
        ota_debug!("Android response HTTP {status} (content length {size})");
        if !has_body(u16::try_from(status)?, u64::try_from(size).ok(), limit)? {
            return Ok(None);
        }

        let stream = env
            .call_method(conn, "getInputStream", "()Ljava/io/InputStream;", &[])?
            .l()?;
        let result = read_body(env, &stream, started, limit, route);
        clear_java_exception(env)?;
        env.call_method(stream, "close", "()V", &[])?;
        result.map(Some)
    }

    fn read_body(
        env: &mut JNIEnv<'_>,
        stream: &JObject<'_>,
        started: Instant,
        limit: usize,
        route: Option<&Route<'_>>,
    ) -> JavaResult<Vec<u8>> {
        const CHUNK: usize = 16 * 1024;
        let array = env.new_byte_array(CHUNK as i32)?;
        let mut chunk = [0; CHUNK];
        let mut bytes = Vec::new();
        loop {
            if let Some(route) = route {
                require_unmetered(route.confirmed_unmetered(env).then_some(()))?;
            }
            let count = env
                .call_method(stream, "read", "([B)I", &[JValue::Object(&array)])?
                .i()?;
            if started.elapsed() >= REQUEST_TIMEOUT {
                return Err(io::Error::from(io::ErrorKind::TimedOut).into());
            }
            if count == -1 {
                return Ok(bytes);
            }
            let count = usize::try_from(count)?;
            check_chunk(bytes.len(), count, limit)?;
            env.get_byte_array_region(&array, 0, &mut chunk[..count])?;
            bytes.extend(chunk[..count].iter().map(|byte| *byte as u8));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_missing_or_empty_successful_policy_is_absent() {
        assert!(!has_body(404, None, 8).unwrap());
        assert!(!has_body(204, None, 8).unwrap());
        assert!(has_body(200, None, 8).unwrap());
        assert!(has_body(200, Some(8), 8).unwrap());
        for status in [0, 302, 403, 503] {
            assert_eq!(
                has_body(status, None, 8).unwrap_err().kind(),
                io::ErrorKind::Other
            );
        }
        assert_eq!(
            has_body(200, Some(9), 8).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(check_chunk(6, 2, 8).is_ok());
        assert!(check_chunk(6, 3, 8).is_err());
    }

    #[test]
    fn archive_transfers_defer_without_confirmed_unmetered_connectivity() {
        assert_eq!(require_unmetered(Some("network")).unwrap(), "network");
        assert_eq!(
            require_unmetered(None::<()>).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
    }

    #[cfg(all(debug_assertions, any(desktop, target_os = "android")))]
    #[test]
    fn only_local_debug_http_archives_bypass_android_network_binding() {
        for url in [
            "http://10.0.2.2:8789/ui/1.0.1/bundle.tar.gz",
            "http://127.0.0.1:8789/",
            "http://[::1]:8789/",
        ] {
            let route = android_archive_route::<()>(true, android_local_test_http(url), || {
                panic!("must not look up a network for a local debug fixture")
            });
            assert_eq!(route.unwrap(), None);
        }
        for url in [
            "https://dist.718788.xyz/ui/1.0.1/bundle.tar.gz",
            "http://10.0.2.3:8789/",
            "https://10.0.2.2:8789/",
        ] {
            assert_eq!(
                android_archive_route(true, android_local_test_http(url), || Some(
                    "active network"
                ))
                .unwrap(),
                Some("active network")
            );
        }
    }

    #[test]
    fn ordinary_archives_require_a_route_and_discovery_does_not() {
        assert_eq!(
            android_archive_route(true, false, || None::<()>)
                .unwrap_err()
                .kind(),
            io::ErrorKind::WouldBlock
        );
        assert_eq!(
            android_archive_route::<()>(false, false, || panic!("discovery is unbound")).unwrap(),
            None
        );
    }

    #[test]
    fn a_failed_read_uses_the_metered_retry_only_when_the_bound_route_is_unavailable() {
        let failed = || Err::<(), io::Error>(io::ErrorKind::ConnectionReset.into());
        assert_eq!(
            recheck_failed_transfer(failed(), || false)
                .unwrap_err()
                .kind(),
            io::ErrorKind::WouldBlock
        );
        assert_eq!(
            recheck_failed_transfer(failed(), || true)
                .unwrap_err()
                .kind(),
            io::ErrorKind::ConnectionReset
        );
        assert!(
            recheck_failed_transfer(Ok::<_, io::Error>(()), || panic!("successful transfer"))
                .is_ok()
        );
    }
}
