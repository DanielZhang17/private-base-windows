use std::{
    fs::{self, Metadata, OpenOptions},
    future::Future,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, SystemTime},
};
use tauri::{
    http::HeaderMap,
    ipc::{
        CommandArg, CommandItem, Invoke, InvokeBody, InvokeError, InvokeResolver, IpcResponse,
        Request,
    },
    Manager,
};
use tauri_plugin_dialog::DialogExt;

const UNSUPPORTED: &str = "unsupported";
const MAX_FILE_BYTES: usize = 100 * 1024 * 1024;
const MAX_NAME_BYTES: usize = 180;
const MAX_OPEN_PATH_CHARS: usize = 218;
const ZONE_IDENTIFIER: &[u8] = b"[ZoneTransfer]\r\nZoneId=3\r\n";
const OPEN_CACHE_TTL: Duration = Duration::from_secs(60 * 60);

struct FilePayload {
    name: String,
    mime_type: String,
    bytes: Vec<u8>,
}

impl FilePayload {
    #[cfg(test)]
    fn from_ipc(body: &InvokeBody, headers: &HeaderMap, open: bool) -> Result<Self, &'static str> {
        Self::from_ipc_checked(body, headers, open, || Ok(()))
    }

    fn from_ipc_checked(
        body: &InvokeBody,
        headers: &HeaderMap,
        open: bool,
        before_copy: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<Self, &'static str> {
        let InvokeBody::Raw(bytes) = body else {
            return Err(UNSUPPORTED);
        };
        // Check the borrowed IPC buffer before decoding metadata or cloning bytes.
        validate_size(bytes.len())?;
        let name = sanitize_name(&decode_header(headers, "x-file-name")?)?;
        let mime_type = decode_header(headers, "x-mime-type")?;
        if open && !can_open(&name, &mime_type) {
            return Err("blocked");
        }
        before_copy()?;
        Ok(Self {
            name,
            mime_type: sanitize_mime_type(&mime_type),
            bytes: bytes.clone(),
        })
    }
}

fn decode_header(headers: &HeaderMap, key: &str) -> Result<String, &'static str> {
    let encoded = headers
        .get(key)
        .ok_or(UNSUPPORTED)?
        .to_str()
        .map_err(|_| UNSUPPORTED)?;
    let mut decoded = Vec::with_capacity(encoded.len());
    let mut input = encoded.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let high = char::from(input.next().ok_or(UNSUPPORTED)?)
                .to_digit(16)
                .ok_or(UNSUPPORTED)?;
            let low = char::from(input.next().ok_or(UNSUPPORTED)?)
                .to_digit(16)
                .ok_or(UNSUPPORTED)?;
            decoded.push((high * 16 + low) as u8);
        } else {
            // encodeURIComponent leaves '+' literal; this isn't form encoding.
            decoded.push(byte);
        }
    }
    String::from_utf8(decoded).map_err(|_| UNSUPPORTED)
}

fn validate_size(length: usize) -> Result<(), &'static str> {
    if length > MAX_FILE_BYTES {
        Err(UNSUPPORTED)
    } else {
        Ok(())
    }
}

fn truncate_stem(value: &str, bytes: usize, utf16: usize) -> &str {
    let mut end = 0;
    let mut units = 0;
    for c in value.chars() {
        if end + c.len_utf8() > bytes || units + c.len_utf16() > utf16 {
            break;
        }
        end += c.len_utf8();
        units += c.len_utf16();
    }
    &value[..end]
}

fn reserved_name(stem: &str) -> bool {
    let upper = stem
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_uppercase();
    matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        upper.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}

fn sanitize_name(name: &str) -> Result<String, &'static str> {
    let clean: String = name
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .collect();
    let clean = clean.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let clean = if clean.is_empty() {
        "attachment"
    } else {
        clean
    };
    fit_name(clean, MAX_NAME_BYTES, usize::MAX)
}

fn fit_name(name: &str, bytes: usize, utf16: usize) -> Result<String, &'static str> {
    let (stem, extension) = name
        .rfind('.')
        .map_or((name, ""), |index| name.split_at(index));
    // Reject the impossible case instead of silently changing the extension.
    let budget = bytes
        .checked_sub(extension.len())
        .filter(|n| *n > 0)
        .ok_or(UNSUPPORTED)?;
    let units = utf16
        .checked_sub(extension.encode_utf16().count())
        .filter(|n| *n > 0)
        .ok_or(UNSUPPORTED)?;
    let stem = truncate_stem(stem, budget, units).trim_end_matches(['.', ' ']);
    let stem = if stem.is_empty() {
        truncate_stem("attachment", budget, units)
    } else {
        stem
    };
    let prefix = if reserved_name(stem) { "_" } else { "" };
    let stem = truncate_stem(stem, budget - prefix.len(), units - prefix.len())
        .trim_end_matches(['.', ' ']);
    Ok(format!("{prefix}{stem}{extension}"))
}

fn path_chars(path: &Path) -> usize {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str().encode_wide().count()
    }
    #[cfg(not(windows))]
    path.to_string_lossy().encode_utf16().count()
}

fn cached_name(directory: &Path, name: &str) -> Result<String, &'static str> {
    let budget = MAX_OPEN_PATH_CHARS
        .checked_sub(path_chars(directory) + 1)
        .ok_or(UNSUPPORTED)?;
    fit_name(name, MAX_NAME_BYTES, budget)
}

fn sanitize_mime_type(mime_type: &str) -> String {
    let valid_token = |part: &str| {
        !part.is_empty()
            && part.bytes().all(|b| {
                b.is_ascii_alphanumeric()
                    || matches!(
                        b,
                        b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
                    )
            })
    };
    if mime_type.len() <= 127
        && mime_type
            .split_once('/')
            .is_some_and(|(kind, subtype)| valid_token(kind) && valid_token(subtype))
    {
        mime_type.to_ascii_lowercase()
    } else {
        "application/octet-stream".to_owned()
    }
}

// Only these final extensions may be handed to the desktop OS.
const ALLOWED_EXTENSIONS: &[&str] = &[
    "pdf", "txt", "md", "csv", "tsv", "rtf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt",
    "ods", "odp", "pages", "numbers", "key", "epub", "png", "jpg", "jpeg", "gif", "webp", "heic",
    "heif", "avif", "bmp", "tiff", "tif", "mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "mp4",
    "mov", "m4v", "webm", "mkv", "avi", "zip",
];

// Retain the Windows denylist as a second check.
const BLOCKED_EXTENSIONS: &[&str] = &[
    "exe",
    "com",
    "scr",
    "pif",
    "cpl",
    "msi",
    "msp",
    "mst",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "psd1",
    "ps1xml",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "wsc",
    "hta",
    "lnk",
    "url",
    "reg",
    "inf",
    "scf",
    "jar",
    "py",
    "pyw",
    "pyc",
    "pyo",
    "pyz",
    "rb",
    "pl",
    "php",
    "sh",
    "bash",
    "appref-ms",
    "application",
    "gadget",
    "msc",
    "vb",
    "chm",
    "settingcontent-ms",
    "library-ms",
    "appx",
    "appxbundle",
    "msix",
    "msixbundle",
    "ps2",
    "psc1",
    "psc2",
    "search-ms",
    "searchconnector-ms",
];
const BLOCKED_MIME_TYPES: &[&str] = &[
    "application/x-msdownload",
    "application/x-msdos-program",
    "application/x-dosexec",
    "application/x-ms-dos-executable",
    "application/vnd.microsoft.portable-executable",
    "application/x-executable",
    "application/x-pie-executable",
    "application/x-sharedlib",
    "application/x-msi",
    "application/x-ms-installer",
    "application/x-ms-shortcut",
    "application/x-ms-application",
    "application/x-ms-xbap",
    "application/vnd.ms-appx",
    "application/vnd.ms-appx.bundle",
    "application/msix",
    "application/msixbundle",
    "application/vnd.ms-htmlhelp",
    "application/x-sh",
    "application/x-shellscript",
    "text/x-shellscript",
    "text/x-sh",
    "application/x-bat",
    "application/x-batch",
    "text/x-bat",
    "text/x-msdos-batch",
    "application/x-powershell",
    "text/x-powershell",
    "application/java-archive",
    "application/x-java-archive",
    "application/x-jar",
    "text/x-python",
    "application/x-python",
    "application/x-python-code",
    "text/x-python-script",
    "application/x-ruby",
    "text/x-ruby",
    "application/x-perl",
    "text/x-perl",
    "application/x-php",
    "application/x-httpd-php",
    "text/x-php",
    "application/javascript",
    "application/x-javascript",
    "text/javascript",
    "text/ecmascript",
    "application/ecmascript",
    "text/vbscript",
    "application/x-vbscript",
    "text/x-vbscript",
];

fn can_open(name: &str, mime_type: &str) -> bool {
    let extension = name
        .rsplit_once('.')
        .map_or("", |(_, ext)| ext)
        .to_ascii_lowercase();
    // Parameters cannot disguise a dangerous MIME, even though they aren't valid
    // simple MIME metadata and will otherwise fall back to octet-stream.
    let mime_type = mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    ALLOWED_EXTENSIONS.contains(&extension.as_str())
        && !BLOCKED_EXTENSIONS.contains(&extension.as_str())
        && !extension.starts_with("msh")
        && !BLOCKED_MIME_TYPES.contains(&mime_type.as_str())
}

// The injected writer lets host tests verify the exact ADS path/content without
// creating a misleading colon-named sidecar on a non-NTFS filesystem.
fn write_zone_identifier(
    path: &Path,
    write_stream: impl FnOnce(&Path, &[u8]) -> io::Result<()>,
) -> io::Result<()> {
    let mut stream = path.as_os_str().to_os_string();
    stream.push(":Zone.Identifier");
    write_stream(Path::new(&stream), ZONE_IDENTIFIER)
}

fn write_received(
    path: &Path,
    bytes: &[u8],
    create_new: bool,
    write_stream: impl FnOnce(&Path, &[u8]) -> io::Result<()>,
) -> io::Result<()> {
    let mut output = OpenOptions::new()
        .write(true)
        .create(!create_new)
        .create_new(create_new)
        .truncate(false)
        .open(path)?;
    // Fail closed: mark before writing decrypted bytes or truncating an existing
    // selected file. A filesystem without ADS support must not report success.
    write_zone_identifier(path, write_stream)?;
    output.set_len(0)?;
    output.write_all(bytes)?;
    output.flush()
}

fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Include junctions and all other reparse points, not just symlinks.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.is_symlink()
}

fn check_root(root: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(root)?;
    if is_link(&metadata) || !metadata.is_dir() {
        return Err(io::Error::other("Invalid Open cache"));
    }
    Ok(())
}

fn remove_entry(path: &Path, metadata: &Metadata) -> io::Result<()> {
    if is_link(metadata) {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x10 != 0 {
                return fs::remove_dir(path);
            }
        }
        fs::remove_file(path)
    } else if metadata.is_dir() {
        // remove_dir_all does not follow nested symlinks/junctions either.
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn process_session() -> io::Result<&'static str> {
    static SESSION: OnceLock<Result<String, ()>> = OnceLock::new();
    SESSION
        .get_or_init(|| {
            let random = || -> io::Result<String> {
                let mut bytes = [0u8; 16];
                #[cfg(windows)]
                {
                    use windows::Win32::Security::Cryptography::{
                        BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
                    };
                    // SAFETY: the system-preferred RNG writes only this live buffer;
                    // no algorithm handle is required with this flag.
                    unsafe { BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }
                        .ok()
                        .map_err(|_| io::Error::other("Open session RNG failed"))?;
                }
                #[cfg(not(windows))]
                {
                    use std::io::Read;
                    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
                }
                Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
            };
            random().map_err(|_| ())
        })
        .as_ref()
        .map(String::as_str)
        .map_err(|_| io::Error::other("Open session RNG failed"))
}

fn staged_owner(path: &Path) -> Option<(&str, u64)> {
    let (session, rest) = path
        .file_name()?
        .to_str()?
        .strip_prefix('s')?
        .split_once("-e")?;
    if session.len() != 32 || !session.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let (epoch, random) = rest.split_once('-')?;
    if random.is_empty() {
        return None;
    }
    Some((session, epoch.parse().ok()?))
}

fn cleanup(
    root: &Path,
    older_than: Option<SystemTime>,
    before_epoch: Option<(&str, u64)>,
) -> io::Result<()> {
    cleanup_with_remover(root, older_than, before_epoch, remove_entry)
}

fn cleanup_with_remover(
    root: &Path,
    older_than: Option<SystemTime>,
    before_epoch: Option<(&str, u64)>,
    mut remove: impl FnMut(&Path, &Metadata) -> io::Result<()>,
) -> io::Result<()> {
    check_root(root)?;
    let mut failure = None;
    for entry in fs::read_dir(root)? {
        let result = (|| {
            let path = entry?.path();
            // Only this session's newly admitted copies are exempt. Other
            // sessions and legacy names remain eligible on every retry, even
            // after startup cleanup failed and their epoch exceeds our cutoff.
            if before_epoch.is_some_and(|(current, cutoff)| {
                staged_owner(&path)
                    .is_some_and(|(session, epoch)| session == current && epoch >= cutoff)
            }) {
                return Ok(());
            }
            let metadata = fs::symlink_metadata(&path)?;
            let expired = match older_than {
                None => true,
                Some(now) => now
                    .duration_since(metadata.modified()?)
                    .is_ok_and(|age| age >= OPEN_CACHE_TTL),
            };
            if expired || is_link(&metadata) {
                remove(&path, &metadata)?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            // Try every entry even if another application has one file locked.
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

#[derive(Default)]
struct OpenRevocation {
    epoch: AtomicU64,
    // Independent of the cache mutex. Only revocation and the final OS call
    // hold this short guard; it never spans copying, file I/O or dispatch.
    handoff: Mutex<()>,
}

struct OpenTicket {
    revocation: Arc<OpenRevocation>,
    epoch: u64,
}

impl OpenTicket {
    fn check(&self) -> Result<(), &'static str> {
        if self.revocation.epoch.load(Ordering::SeqCst) == self.epoch {
            Ok(())
        } else {
            Err("cancelled")
        }
    }

    fn launch(
        &self,
        launch: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<(), &'static str> {
        let _guard = self.revocation.handoff.lock().map_err(|_| UNSUPPORTED)?;
        self.check()?;
        launch()
    }
}

pub(crate) struct OpenCache {
    root: Mutex<PathBuf>,
    revocation: Arc<OpenRevocation>,
    session: &'static str,
}

impl OpenCache {
    pub(crate) fn initialize(app_cache: PathBuf) -> io::Result<Self> {
        Self::initialize_with_remover(app_cache, remove_entry)
    }

    fn initialize_with_remover(
        app_cache: PathBuf,
        remove: impl FnMut(&Path, &Metadata) -> io::Result<()>,
    ) -> io::Result<Self> {
        let session = process_session()?;
        fs::create_dir_all(&app_cache)?;
        let root = app_cache.join("open");
        match fs::create_dir(&root) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error),
        }
        check_root(&root)?;
        // Reinitialization in the same process must not reset below an owned
        // directory that startup cannot delete. Foreign sessions never affect
        // our epoch because every clear always retries those directories.
        let mut epoch = 0;
        for entry in fs::read_dir(&root)? {
            if let Some((owner, previous)) = staged_owner(&entry?.path()) {
                if owner == session {
                    epoch = epoch.max(
                        previous
                            .checked_add(1)
                            .ok_or_else(|| io::Error::other("Open epoch exhausted"))?,
                    );
                }
            }
        }
        // Locked copies remain private and are retried on clear/later opens.
        let _ = cleanup_with_remover(&root, None, None, remove);
        Ok(Self {
            root: Mutex::new(root),
            revocation: Arc::new(OpenRevocation {
                epoch: AtomicU64::new(epoch),
                ..Default::default()
            }),
            session,
        })
    }

    fn capture(&self) -> OpenTicket {
        let epoch = self.revocation.epoch.load(Ordering::SeqCst);
        OpenTicket {
            revocation: self.revocation.clone(),
            epoch,
        }
    }

    fn revoke(&self) -> Result<u64, &'static str> {
        let _guard = self.revocation.handoff.lock().map_err(|_| UNSUPPORTED)?;
        // The handoff guard serializes every writer; readers capture atomically.
        let next = self
            .revocation
            .epoch
            .load(Ordering::SeqCst)
            .checked_add(1)
            .ok_or(UNSUPPORTED)?;
        self.revocation.epoch.store(next, Ordering::SeqCst);
        Ok(next)
    }

    fn open(
        &self,
        ticket: &OpenTicket,
        file: FilePayload,
        now: SystemTime,
        write_stream: impl FnOnce(&Path, &[u8]) -> io::Result<()>,
        handoff: impl FnOnce(&Path, &OpenTicket) -> Result<(), &'static str>,
    ) -> Result<(), &'static str> {
        ticket.check()?;
        if !can_open(&file.name, &file.mime_type) {
            return Err("blocked");
        }
        // Retain the cache mutex through handoff/discard, while revocation can
        // invalidate this ticket independently, even during a slow stage.
        let root = self.root.lock().map_err(|_| UNSUPPORTED)?;
        ticket.check()?;
        check_root(&root).map_err(|_| UNSUPPORTED)?;
        let _ = cleanup(&root, Some(now), None);
        ticket.check()?;
        let directory = tempfile::Builder::new()
            .prefix(&format!("s{}-e{}-", self.session, ticket.epoch))
            .rand_bytes(24)
            .tempdir_in(&*root)
            .map_err(|_| UNSUPPORTED)?;
        let name = cached_name(directory.path(), &file.name)?;
        if !can_open(&name, &file.mime_type) {
            return Err("blocked");
        }
        let path = directory.path().join(name);
        ticket.check()?;
        write_received(&path, &file.bytes, true, write_stream).map_err(|_| UNSUPPORTED)?;
        ticket.check()?; // Before dispatch; handoff checks again at the OS call.
        handoff(&path, ticket)?;
        ticket.check()?;
        // The associated app may read asynchronously. Retain only after success.
        let _ = directory.keep();
        Ok(())
    }

    fn clear_before(&self, cutoff: u64) -> Result<(), &'static str> {
        self.clear_before_with_remover(cutoff, remove_entry)
    }

    fn clear_before_with_remover(
        &self,
        cutoff: u64,
        remove: impl FnMut(&Path, &Metadata) -> io::Result<()>,
    ) -> Result<(), &'static str> {
        let root = self.root.lock().map_err(|_| UNSUPPORTED)?;
        cleanup_with_remover(&root, None, Some((self.session, cutoff)), remove)
            .map_err(|_| UNSUPPORTED)
    }

    #[cfg(test)]
    fn clear(&self) -> Result<(), &'static str> {
        let cutoff = self.revoke()?;
        self.clear_before(cutoff)
    }
}

fn save_to(
    path: Option<PathBuf>,
    bytes: &[u8],
    write_stream: impl FnOnce(&Path, &[u8]) -> io::Result<()>,
) -> Result<&'static str, &'static str> {
    let Some(path) = path else {
        return Ok("cancelled");
    };
    write_received(&path, bytes, false, write_stream).map_err(|_| UNSUPPORTED)?;
    Ok("saved")
}

fn require_main(label: &str) -> Result<(), &'static str> {
    if label == "main" {
        Ok(())
    } else {
        Err(UNSUPPORTED)
    }
}

fn shell_result(code: isize, last_error: u32) -> Result<(), &'static str> {
    match code {
        33.. => Ok(()),
        27 | 31 => Err("no_app"), // SE_ERR_ASSOCINCOMPLETE / SE_ERR_NOASSOC
        _ if last_error == 1223 => Err("cancelled"), // ERROR_CANCELLED
        _ => Err(UNSUPPORTED),
    }
}

#[cfg(windows)]
fn shell_open(
    window: &tauri::WebviewWindow,
    path: &Path,
    ticket: &OpenTicket,
) -> Result<(), &'static str> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            Foundation::{GetLastError, SetLastError, WIN32_ERROR},
            System::Com::{
                CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
            },
            UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        },
    };
    let hwnd = window.hwnd().map_err(|_| UNSUPPORTED)?;
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: this blocking worker initializes COM for its own thread. Each
    // successful initialization (including S_FALSE) is balanced on the same thread.
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }
        .ok()
        .map_err(|_| UNSUPPORTED)?;
    // SAFETY: path is a live, NUL-terminated absolute path produced exclusively
    // by OpenCache; there are no shell arguments or renderer-supplied paths.
    let result = ticket.launch(|| unsafe {
        SetLastError(WIN32_ERROR(0));
        let code = ShellExecuteW(
            Some(hwnd),
            w!("open"),
            PCWSTR(path.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        let error = GetLastError().0;
        shell_result(code.0 as isize, error)
    });
    // SAFETY: balance this thread's successful COM initialization even when the
    // ticket was revoked before ShellExecuteW could run.
    unsafe { CoUninitialize() };
    result
}

// Host tests compile the actual commands but never invoke a GUI or an opener.
#[cfg(all(test, not(windows)))]
fn shell_open(
    _window: &tauri::WebviewWindow,
    _path: &Path,
    ticket: &OpenTicket,
) -> Result<(), &'static str> {
    ticket.launch(|| shell_result(0, 0))
}

// These functions must stay synchronous: a Tauri async command macro defers
// calling the function itself until its response task is polled. This raw IPC
// wrapper runs after Tauri's normal ACL check, before scheduling any response.
pub(crate) fn dispatch(invoke: Invoke) -> bool {
    let command = match invoke.message.command() {
        "open_file" => "open_file",
        "save_file" => "save_file",
        "clear_open_cache" => "clear_open_cache",
        _ => return false,
    };
    let item = |key| CommandItem {
        plugin: None,
        name: command,
        key,
        message: &invoke.message,
        acl: &invoke.acl,
    };
    let window = match tauri::WebviewWindow::from_command(item("window")) {
        Ok(window) => window,
        Err(_) => {
            invoke.resolver.reject(UNSUPPORTED);
            return true;
        }
    };
    let request = match Request::from_command(item("request")) {
        Ok(request) => request,
        Err(_) => {
            invoke.resolver.reject(UNSUPPORTED);
            return true;
        }
    };
    let app = window.app_handle().clone();
    match command {
        "open_file" => respond(invoke.resolver, open_file(app, window, request)),
        "save_file" => respond(invoke.resolver, save_file(app, window, request)),
        _ => respond(invoke.resolver, clear_open_cache(app, window)),
    }
    true
}

fn respond<T: IpcResponse + Send + 'static>(
    resolver: InvokeResolver,
    work: impl Future<Output = Result<T, &'static str>> + Send + 'static,
) {
    resolver.respond_async(async move { work.await.map_err(InvokeError::from) });
}

fn prepare_file(
    cache: &OpenCache,
    window: &str,
    body: &InvokeBody,
    headers: &HeaderMap,
    open: bool,
) -> Result<(OpenTicket, FilePayload), &'static str> {
    // Called on the synchronous dispatch stack, not in a future body.
    let ticket = cache.capture();
    require_main(window)?;
    ticket.check()?;
    let file = FilePayload::from_ipc_checked(body, headers, open, || ticket.check())?;
    ticket.check()?;
    Ok((ticket, file))
}

async fn run_admitted<T, F: Future<Output = Result<T, &'static str>>>(
    admission: Result<(OpenTicket, FilePayload), &'static str>,
    work: impl FnOnce(OpenTicket, FilePayload) -> F,
) -> Result<T, &'static str> {
    let (ticket, file) = admission?;
    ticket.check()?; // Includes requests left completely unpolled before Clear.
    work(ticket, file).await
}

fn open_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Request<'_>,
) -> impl Future<Output = Result<(), &'static str>> + Send + 'static {
    let admission = prepare_file(
        &app.state::<OpenCache>(),
        window.label(),
        request.body(),
        request.headers(),
        true,
    );
    run_admitted(admission, move |ticket, file| async move {
        tauri::async_runtime::spawn_blocking(move || {
            app.state::<OpenCache>().open(
                &ticket,
                file,
                SystemTime::now(),
                |path, bytes| fs::write(path, bytes),
                |path, ticket| shell_open(&window, path, ticket),
            )
        })
        .await
        .map_err(|_| UNSUPPORTED)?
    })
}

fn save_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: Request<'_>,
) -> impl Future<Output = Result<&'static str, &'static str>> + Send + 'static {
    let admission = prepare_file(
        &app.state::<OpenCache>(),
        window.label(),
        request.body(),
        request.headers(),
        false,
    );
    let pending = run_admitted(admission, move |ticket, file| async move {
        tauri::async_runtime::spawn_blocking(move || {
            ticket.check()?;
            let selected = app
                .dialog()
                .file()
                .set_parent(&window)
                .set_file_name(&file.name)
                .blocking_save_file();
            ticket.check()?;
            let path = selected
                .map(|path| path.into_path().map_err(|_| UNSUPPORTED))
                .transpose()?;
            save_to(path, &file.bytes, |path, bytes| fs::write(path, bytes))
        })
        .await
        .map_err(|_| UNSUPPORTED)?
    });
    async move {
        match pending.await {
            Err("cancelled") => Ok("cancelled"),
            result => result,
        }
    }
}

fn prepare_clear(cache: &OpenCache, window: &str) -> Result<u64, &'static str> {
    require_main(window)?;
    cache.revoke()
}

fn clear_open_cache(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> impl Future<Output = Result<(), &'static str>> + Send + 'static {
    // Bump on the synchronous dispatch stack, before constructing the future.
    let cutoff = prepare_clear(&app.state::<OpenCache>(), window.label());
    async move {
        let cutoff = cutoff?;
        tauri::async_runtime::spawn_blocking(move || app.state::<OpenCache>().clear_before(cutoff))
            .await
            .map_err(|_| UNSUPPORTED)?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(name: &str) -> FilePayload {
        FilePayload {
            name: sanitize_name(name).unwrap(),
            mime_type: "application/pdf".to_owned(),
            bytes: vec![1, 2, 3],
        }
    }

    fn no_zone(_path: &Path, _bytes: &[u8]) -> io::Result<()> {
        Ok(())
    }

    fn headers(name: &str, mime: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-file-name", name.parse().unwrap());
        headers.insert("x-mime-type", mime.parse().unwrap());
        headers
    }

    #[test]
    fn unpolled_file_requests_keep_the_ticket_admitted_before_clear_dispatch() {
        use std::cell::Cell;
        for open in [true, false] {
            let directory = tempfile::tempdir().unwrap();
            let cache = OpenCache::initialize(directory.path().to_owned()).unwrap();
            let body = InvokeBody::Raw(vec![1, 2, 3]);
            let metadata = headers("queued.pdf", "application/pdf");
            // The same synchronous admission + deferred work used by both IPC
            // wrappers. Leave the request completely unpolled until after Clear.
            let admission = prepare_file(&cache, "main", &body, &metadata, open);
            let called = Cell::new(false);
            let pending = run_admitted(admission, |ticket, _| {
                called.set(true);
                std::future::ready(ticket.check())
            });
            let cutoff = prepare_clear(&cache, "main");
            let clear = async { cache.clear_before(cutoff?) };
            assert_eq!(tauri::async_runtime::block_on(pending), Err("cancelled"));
            assert!(!called.get()); // No dialog, staging, or OS launch was queued.
            assert_eq!(tauri::async_runtime::block_on(clear), Ok(()));
            let admitted_after_clear = prepare_file(&cache, "main", &body, &metadata, open);
            assert_eq!(
                tauri::async_runtime::block_on(run_admitted(admitted_after_clear, |ticket, _| {
                    std::future::ready(ticket.check())
                })),
                Ok(())
            );
        }
    }

    #[test]
    fn failed_startup_and_clear_deletions_never_exempt_foreign_session_copies() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("open");
        fs::create_dir(&root).unwrap();
        let current = process_session().unwrap();
        let foreign = if current == "00000000000000000000000000000000" {
            "11111111111111111111111111111111"
        } else {
            "00000000000000000000000000000000"
        };
        let locked = root.join(format!("s{foreign}-e9000-locked"));
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("old.pdf"), [7]).unwrap();
        let remove_unlocked = |path: &Path, metadata: &Metadata| {
            if path == locked {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else {
                remove_entry(path, metadata)
            }
        };
        // Repeated startup failures must not adopt a previous process's copy.
        let first =
            OpenCache::initialize_with_remover(directory.path().to_owned(), remove_unlocked)
                .unwrap();
        drop(first);
        let cache =
            OpenCache::initialize_with_remover(directory.path().to_owned(), remove_unlocked)
                .unwrap();
        assert!(locked.exists());
        assert_ne!(cache.session, foreign);
        let old_ticket = cache.capture();
        let cutoff = cache.revoke().unwrap();
        let current_ticket = cache.capture();
        let mut retained = None;
        cache
            .open(
                &current_ticket,
                payload("new.pdf"),
                SystemTime::now(),
                no_zone,
                |path, ticket| {
                    ticket.launch(|| {
                        retained = Some(path.to_owned());
                        Ok(())
                    })
                },
            )
            .unwrap();
        let retained = retained.unwrap();
        assert_eq!(
            cache.clear_before_with_remover(cutoff, remove_unlocked),
            Err(UNSUPPORTED)
        );
        assert_eq!(old_ticket.check(), Err("cancelled"));
        assert_eq!(current_ticket.check(), Ok(()));
        assert!(locked.exists());
        assert!(retained.exists());
        // Retry the identical cutoff after the foreign file is unlocked. Its
        // high epoch must not make it exempt, while our newly admitted copy stays.
        cache.clear_before(cutoff).unwrap();
        assert!(!locked.exists());
        assert!(retained.exists());
        drop(cache);
        OpenCache::initialize(directory.path().to_owned()).unwrap();
        assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    }

    #[test]
    fn sessions_are_random_process_scoped_and_legacy_names_have_no_current_owner() {
        let first_root = tempfile::tempdir().unwrap();
        let second_root = tempfile::tempdir().unwrap();
        let first = OpenCache::initialize(first_root.path().to_owned()).unwrap();
        let second = OpenCache::initialize(second_root.path().to_owned()).unwrap();
        assert_eq!(first.session, second.session);
        assert_eq!(first.session.len(), 32);
        assert!(first.session.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let path = PathBuf::from(format!("s{}-e42-random", first.session));
        assert_eq!(staged_owner(&path), Some((first.session, 42)));
        for legacy in [
            "epoch-9000-random",
            "file-legacy",
            "sbad-e1-random",
            "s00000000000000000000000000000000-e1-",
        ] {
            assert_eq!(staged_owner(Path::new(legacy)), None);
        }
    }

    #[test]
    fn failed_same_process_startup_cleanup_cannot_reset_below_an_owned_epoch() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("open");
        fs::create_dir(&root).unwrap();
        let session = process_session().unwrap();
        let locked = root.join(format!("s{session}-e9000-locked"));
        fs::create_dir(&locked).unwrap();
        fs::write(locked.join("old.pdf"), [1]).unwrap();
        let cache = OpenCache::initialize_with_remover(directory.path().to_owned(), |_, _| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        })
        .unwrap();
        assert!(locked.exists());
        assert!(cache.capture().epoch > 9000);
        cache.clear().unwrap();
        assert!(!locked.exists());
    }

    #[test]
    fn revoke_while_a_worker_waits_for_the_cache_mutex_cancels_its_entry_ticket() {
        use std::sync::mpsc;
        let directory = tempfile::tempdir().unwrap();
        let cache = Arc::new(OpenCache::initialize(directory.path().to_owned()).unwrap());
        let ticket = cache.capture(); // Command entry, before the worker is queued.
        let root = cache.root.lock().unwrap();
        let (entered, waiting) = mpsc::channel();
        let worker_cache = cache.clone();
        let worker = std::thread::spawn(move || {
            entered.send(()).unwrap();
            worker_cache.open(
                &ticket,
                payload("queued.pdf"),
                SystemTime::now(),
                |_, _| panic!("revoked work must not stage"),
                |_, _| panic!("revoked work must not launch"),
            )
        });
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        // Must not wait for the cache mutex held above.
        let cutoff = cache.revoke().unwrap();
        drop(root);
        assert_eq!(worker.join().unwrap(), Err("cancelled"));
        cache.clear_before(cutoff).unwrap();
        assert_eq!(
            fs::read_dir(directory.path().join("open")).unwrap().count(),
            0
        );
    }

    #[test]
    fn revocation_during_staging_discards_bytes_before_clear_resolves() {
        use std::sync::mpsc;
        let directory = tempfile::tempdir().unwrap();
        let cache = Arc::new(OpenCache::initialize(directory.path().to_owned()).unwrap());
        let ticket = cache.capture();
        let (staged, staging) = mpsc::channel();
        let (resume, paused) = mpsc::channel();
        let worker_cache = cache.clone();
        let worker = std::thread::spawn(move || {
            worker_cache.open(
                &ticket,
                payload("staging.pdf"),
                SystemTime::now(),
                |_, _| {
                    staged.send(()).unwrap();
                    paused.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(())
                },
                |_, _| panic!("revoked staged copy must not dispatch"),
            )
        });
        staging.recv_timeout(Duration::from_secs(5)).unwrap();
        let cutoff = cache.revoke().unwrap(); // Revoke while the worker owns root.
        let clearing_cache = cache.clone();
        let clear = std::thread::spawn(move || clearing_cache.clear_before(cutoff));
        resume.send(()).unwrap();
        assert_eq!(worker.join().unwrap(), Err("cancelled"));
        assert_eq!(clear.join().unwrap(), Ok(()));
        assert_eq!(
            fs::read_dir(directory.path().join("open")).unwrap().count(),
            0
        );
    }

    #[test]
    fn revocation_after_dispatch_prevents_the_final_os_launch() {
        let directory = tempfile::tempdir().unwrap();
        let cache = OpenCache::initialize(directory.path().to_owned()).unwrap();
        let ticket = cache.capture();
        let mut cutoff = None;
        assert_eq!(
            cache.open(
                &ticket,
                payload("dispatched.pdf"),
                SystemTime::now(),
                no_zone,
                |path, ticket| {
                    assert_eq!(fs::read(path).unwrap(), [1, 2, 3]);
                    // Simulate revocation while the OS handoff is queued.
                    cutoff = Some(cache.revoke().unwrap());
                    ticket.launch(|| panic!("revoked dispatch must not call the OS"))
                }
            ),
            Err("cancelled")
        );
        cache.clear_before(cutoff.unwrap()).unwrap();
        assert_eq!(
            fs::read_dir(directory.path().join("open")).unwrap().count(),
            0
        );
    }

    #[test]
    fn delayed_clears_remove_only_earlier_epochs_and_keep_new_opens() {
        let directory = tempfile::tempdir().unwrap();
        let cache = OpenCache::initialize(directory.path().to_owned()).unwrap();
        let retain = |ticket: &OpenTicket, name: &str| {
            let mut retained = None;
            cache
                .open(
                    ticket,
                    payload(name),
                    SystemTime::now(),
                    no_zone,
                    |path, ticket| {
                        ticket.launch(|| {
                            retained = Some(path.to_owned());
                            Ok(())
                        })
                    },
                )
                .unwrap();
            let retained = retained.unwrap();
            assert_eq!(
                staged_owner(retained.parent().unwrap()),
                Some((cache.session, ticket.epoch))
            );
            retained
        };
        let old = retain(&cache.capture(), "old.pdf");
        let first_clear = cache.revoke().unwrap();
        let admitted = retain(&cache.capture(), "admitted.pdf");
        let second_clear = cache.revoke().unwrap();
        let newest = retain(&cache.capture(), "newest.pdf");
        let legacy = directory.path().join("open/file-legacy");
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("legacy.pdf"), [4]).unwrap();
        cache.clear_before(first_clear).unwrap();
        assert!(!old.exists());
        assert!(!legacy.exists());
        assert!(admitted.exists());
        assert!(newest.exists());
        cache.clear_before(second_clear).unwrap();
        assert!(!admitted.exists());
        assert!(newest.exists());
        // Even a retried older cleanup must not delete the newer admission.
        cache.clear_before(first_clear).unwrap();
        assert!(newest.exists());
    }

    #[test]
    fn revocation_is_checked_immediately_before_the_ipc_payload_copy() {
        let directory = tempfile::tempdir().unwrap();
        let cache = OpenCache::initialize(directory.path().to_owned()).unwrap();
        let ticket = cache.capture();
        let body = InvokeBody::Raw(vec![1, 2, 3]);
        let metadata = headers("copy.pdf", "application/pdf");
        assert_eq!(
            FilePayload::from_ipc_checked(&body, &metadata, true, || {
                cache.revoke().unwrap();
                ticket.check()
            })
            .err(),
            Some("cancelled")
        );
        assert_eq!(
            fs::read_dir(directory.path().join("open")).unwrap().count(),
            0
        );
    }

    #[test]
    fn cleanup_failure_does_not_restore_revoked_tickets() {
        let directory = tempfile::tempdir().unwrap();
        let cache = OpenCache::initialize(directory.path().to_owned()).unwrap();
        let ticket = cache.capture();
        let root = directory.path().join("open");
        fs::remove_dir(&root).unwrap();
        fs::write(&root, b"not a cache directory").unwrap();
        let cutoff = cache.revoke().unwrap();
        assert_eq!(cache.clear_before(cutoff), Err(UNSUPPORTED));
        assert_eq!(ticket.check(), Err("cancelled"));
        assert_eq!(
            cache.open(
                &ticket,
                payload("stale.pdf"),
                SystemTime::now(),
                no_zone,
                |_, _| panic!("must not launch")
            ),
            Err("cancelled")
        );
    }

    #[test]
    fn binary_ipc_decodes_headers_and_preserves_exact_bytes() {
        let body = InvokeBody::Raw(vec![0, 128, 255]);
        let file = FilePayload::from_ipc(
            &body,
            &headers("%E6%96%87%F0%9F%98%80%20a+b%2F%5C.txt", "TEXT%2FPLAIN"),
            true,
        )
        .unwrap();
        assert_eq!(file.name, "文😀 a+b.txt");
        assert_eq!(file.mime_type, "text/plain");
        assert_eq!(file.bytes, [0, 128, 255]);
        let file =
            FilePayload::from_ipc(&body, &headers("name.txt", "invalid MIME"), false).unwrap();
        assert_eq!(file.mime_type, "application/octet-stream");
        for json in [
            serde_json::json!([1, 2, 3]),
            serde_json::json!({"bytes": [1, 2, 3]}),
        ] {
            assert_eq!(
                FilePayload::from_ipc(
                    &InvokeBody::Json(json),
                    &headers("name.txt", "text/plain"),
                    false
                )
                .err(),
                Some(UNSUPPORTED)
            );
        }
        for encoded in ["bad%", "bad%1", "bad%GG", "%FF", "%C0%AF"] {
            assert_eq!(
                FilePayload::from_ipc(&body, &headers(encoded, "text/plain"), false).err(),
                Some(UNSUPPORTED)
            );
        }
        assert_eq!(
            FilePayload::from_ipc(&body, &HeaderMap::new(), false).err(),
            Some(UNSUPPORTED)
        );
    }

    #[test]
    fn oversized_binary_body_is_rejected_before_metadata_or_copy() {
        let body = InvokeBody::Raw(vec![0; MAX_FILE_BYTES + 1]);
        assert_eq!(
            FilePayload::from_ipc(&body, &HeaderMap::new(), false).err(),
            Some(UNSUPPORTED)
        );
    }

    #[test]
    fn blocks_full_windows_policy_after_sanitization_but_allows_save() {
        let body = InvokeBody::Raw(vec![1]);
        for extension in "exe com scr pif cpl msi msp mst bat cmd ps1 psm1 psd1 ps1xml vbs vbe js jse wsf wsh wsc hta lnk url reg inf scf jar py pyw pyc pyo pyz rb pl php sh bash appref-ms application gadget msc msh msh1 msh2xml vb chm settingcontent-ms library-ms appx appxbundle msix msixbundle".split_whitespace() {
            let name = format!("report.pdf.{}%00%2F%5C%20.", extension.to_ascii_uppercase());
            let metadata = headers(&name, "application/octet-stream");
            assert_eq!(FilePayload::from_ipc(&body, &metadata, true).err(), Some("blocked"), "{extension}");
            assert!(FilePayload::from_ipc(&body, &metadata, false).is_ok());
        }
        for mime in BLOCKED_MIME_TYPES {
            let metadata = headers("harmless.pdf", &mime.to_ascii_uppercase());
            assert_eq!(
                FilePayload::from_ipc(&body, &metadata, true).err(),
                Some("blocked")
            );
            assert!(FilePayload::from_ipc(&body, &metadata, false).is_ok());
        }
        assert_eq!(
            FilePayload::from_ipc(
                &body,
                &headers("harmless.pdf", "application/x-msdownload; charset=utf-8"),
                true
            )
            .err(),
            Some("blocked")
        );
    }

    #[test]
    fn budgets_the_entire_cached_path_in_utf16_preserving_extension() {
        let directory = PathBuf::from(format!("C:\\{}", "x".repeat(170)));
        for name in [
            format!("{}.xlsx", "a".repeat(180)),
            format!("{}.xlsx", "😀".repeat(60)),
        ] {
            let name = sanitize_name(&name).unwrap();
            let fitted = cached_name(&directory, &name).unwrap();
            assert!(path_chars(&directory.join(&fitted)) <= 218);
            assert!(fitted.ends_with(".xlsx"));
            assert!(fitted.len() <= MAX_NAME_BYTES);
        }
        let fitted = cached_name(&directory, &format!("{}.xlsx", "a".repeat(170))).unwrap();
        assert_eq!(path_chars(&directory.join(fitted)), 218);
        assert_eq!(fit_name("CONlong.txt", 7, 7), Ok("_CO.txt".to_owned()));
        assert!(cached_name(&PathBuf::from("x".repeat(217)), "a.xlsx").is_err());
    }

    #[test]
    fn open_and_save_mark_the_zone_before_handoff_or_success() {
        use std::cell::Cell;
        let directory = tempfile::tempdir().unwrap();
        let cache = OpenCache::initialize(directory.path().to_owned()).unwrap();
        let marked = Cell::new(false);
        cache
            .open(
                &cache.capture(),
                payload("report.pdf"),
                SystemTime::now(),
                |stream, content| {
                    assert!(stream
                        .as_os_str()
                        .to_string_lossy()
                        .ends_with("report.pdf:Zone.Identifier"));
                    assert_eq!(content, b"[ZoneTransfer]\r\nZoneId=3\r\n");
                    marked.set(true);
                    Ok(())
                },
                |_, _ticket| {
                    assert!(marked.get());
                    Ok(())
                },
            )
            .unwrap();
        let selected = directory.path().join("selected.py");
        let mut expected_stream = selected.as_os_str().to_os_string();
        expected_stream.push(":Zone.Identifier");
        marked.set(false);
        assert_eq!(
            save_to(Some(selected.clone()), &[1, 2, 3], |stream, content| {
                assert_eq!(stream, Path::new(&expected_stream));
                assert_eq!(content, b"[ZoneTransfer]\r\nZoneId=3\r\n");
                marked.set(true);
                Ok(())
            }),
            Ok("saved")
        );
        assert!(marked.get());
        assert_eq!(fs::read(selected).unwrap(), [1, 2, 3]);
    }

    #[test]
    fn zone_failure_prevents_launch_success_and_unmarked_byte_writes() {
        let directory = tempfile::tempdir().unwrap();
        let cache = OpenCache::initialize(directory.path().to_owned()).unwrap();
        assert_eq!(
            cache.open(
                &cache.capture(),
                payload("report.pdf"),
                SystemTime::now(),
                |_, _| Err(io::Error::other("marker failed")),
                |_, _ticket| panic!("must not launch")
            ),
            Err(UNSUPPORTED)
        );
        assert_eq!(
            fs::read_dir(directory.path().join("open")).unwrap().count(),
            0
        );
        let selected = directory.path().join("existing.txt");
        fs::write(&selected, b"original").unwrap();
        assert_eq!(
            save_to(Some(selected.clone()), b"received", |_, _| Err(
                io::Error::other("marker failed")
            )),
            Err(UNSUPPORTED)
        );
        assert_eq!(fs::read(selected).unwrap(), b"original");
    }

    #[test]
    fn sanitizes_windows_paths_controls_devices_and_empty_names() {
        for (input, expected) in [
            ("../../a\\b\u{0}\n.pdf", "ab.pdf"),
            ("C:\\a<>:\"|?*.txt", "Ca.txt"),
            ("  report.pdf. ", "report.pdf"),
            ("..", "attachment"),
            ("/\\\r\n", "attachment"),
            ("CON.pdf", "_CON.pdf"),
            ("con .txt", "_con.txt"),
            ("LPT¹.csv", "_LPT¹.csv"),
            ("aux.backup.txt", "_aux.backup.txt"),
            ("文档.pdf", "文档.pdf"),
        ] {
            assert_eq!(sanitize_name(input), Ok(expected.to_owned()));
        }
    }

    #[test]
    fn caps_unicode_names_at_a_character_boundary_and_preserves_extension() {
        for name in [format!("{}.docx", "文😀".repeat(100)), "a".repeat(300)] {
            let sanitized = sanitize_name(&name).unwrap();
            assert!(sanitized.len() <= MAX_NAME_BYTES);
            assert_eq!(
                Path::new(&name).extension(),
                Path::new(&sanitized).extension()
            );
        }
        assert_eq!(
            sanitize_name(&format!("a.{}", "x".repeat(MAX_NAME_BYTES))),
            Err(UNSUPPORTED)
        );
    }

    #[test]
    fn normalizes_only_simple_mime_types() {
        for mime_type in [
            "application/pdf",
            "text/plain",
            "text/markdown",
            "text/csv",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "image/svg+xml",
        ] {
            assert_eq!(sanitize_mime_type(mime_type), mime_type);
        }
        assert_eq!(sanitize_mime_type("TEXT/PLAIN"), "text/plain");
        for invalid in [
            "",
            "text",
            "/pdf",
            "text/",
            "text/plain;charset=utf-8",
            " text/plain",
            "text/plain\n",
            "text/a/b",
            "*/plain",
            "t/文",
        ] {
            assert_eq!(sanitize_mime_type(invalid), "application/octet-stream");
        }
    }

    #[test]
    fn enforces_the_100_mib_boundary() {
        assert_eq!(validate_size(0), Ok(()));
        assert_eq!(validate_size(MAX_FILE_BYTES), Ok(()));
        assert_eq!(validate_size(MAX_FILE_BYTES + 1), Err(UNSUPPORTED));
        assert_eq!(validate_size(usize::MAX), Err(UNSUPPORTED));
    }

    #[test]
    fn save_cancel_does_not_write_and_selected_save_is_exact() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            save_to(None, &[1, 2, 3], |_, _| panic!("cancel must not mark")),
            Ok("cancelled")
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
        let path = directory.path().join("selected.txt");
        fs::write(&path, b"previous longer contents").unwrap();
        assert_eq!(
            save_to(Some(path.clone()), &[1, 2, 3], no_zone),
            Ok("saved")
        );
        assert_eq!(fs::read(path).unwrap(), [1, 2, 3]);
        assert_eq!(
            save_to(Some(directory.path().to_owned()), &[1], no_zone),
            Err(UNSUPPORTED)
        );
    }

    #[test]
    fn cache_uses_unique_private_subfolders_and_cleans_failed_handoffs() {
        let directory = tempfile::tempdir().unwrap();
        let cache = OpenCache::initialize(directory.path().to_owned()).unwrap();
        let root = directory.path().join("open");
        let mut paths = Vec::new();
        for _ in 0..2 {
            cache
                .open(
                    &cache.capture(),
                    payload("../report.pdf"),
                    SystemTime::now(),
                    no_zone,
                    |path, _ticket| {
                        assert!(path.starts_with(&root));
                        assert_eq!(path.file_name().unwrap(), "report.pdf");
                        assert_eq!(fs::read(path).unwrap(), [1, 2, 3]);
                        paths.push(path.to_owned());
                        Ok(())
                    },
                )
                .unwrap();
        }
        assert_ne!(paths[0], paths[1]);
        for error in ["no_app", "cancelled", UNSUPPORTED] {
            assert_eq!(
                cache.open(
                    &cache.capture(),
                    payload("report.pdf"),
                    SystemTime::now(),
                    no_zone,
                    |_, _ticket| Err(error)
                ),
                Err(error)
            );
            assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        }
        cache.clear().unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn startup_clear_and_expiry_touch_only_the_open_subfolder() {
        let directory = tempfile::tempdir().unwrap();
        let sibling = directory.path().join("unrelated");
        fs::write(&sibling, [9]).unwrap();
        let cache = OpenCache::initialize(directory.path().to_owned()).unwrap();
        let root = directory.path().join("open");
        cache
            .open(
                &cache.capture(),
                payload("old.pdf"),
                SystemTime::now(),
                no_zone,
                |_, _ticket| Ok(()),
            )
            .unwrap();
        let entry = fs::read_dir(&root).unwrap().next().unwrap().unwrap().path();
        let modified = fs::metadata(&entry).unwrap().modified().unwrap();
        cleanup(
            &root,
            Some(modified + OPEN_CACHE_TTL - Duration::from_secs(1)),
            None,
        )
        .unwrap();
        assert!(entry.exists());
        cleanup(&root, Some(modified - Duration::from_secs(1)), None).unwrap();
        assert!(entry.exists()); // A future timestamp isn't old.
        cache
            .open(
                &cache.capture(),
                payload("fresh.pdf"),
                modified + OPEN_CACHE_TTL,
                no_zone,
                |_, _ticket| Ok(()),
            )
            .unwrap();
        assert!(!entry.exists()); // Opportunistic pruning before the next Open.
        drop(cache);
        let cache = OpenCache::initialize(directory.path().to_owned()).unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        cache.clear().unwrap();
        cache.clear().unwrap();
        assert_eq!(fs::read(sibling).unwrap(), [9]);
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_never_follows_symlinks_or_a_replaced_root() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let keep = outside.path().join("keep.txt");
        fs::write(&keep, [7]).unwrap();
        let cache = OpenCache::initialize(directory.path().to_owned()).unwrap();
        let root = directory.path().join("open");
        symlink(outside.path(), root.join("linked")).unwrap();
        fs::create_dir(root.join("nested")).unwrap();
        symlink(outside.path(), root.join("nested/linked")).unwrap();
        cache.clear().unwrap();
        assert!(keep.exists());
        fs::remove_dir(&root).unwrap();
        symlink(outside.path(), &root).unwrap();
        assert!(cache.clear().is_err());
        assert_eq!(
            cache.open(
                &cache.capture(),
                payload("report.pdf"),
                SystemTime::now(),
                no_zone,
                |_, _ticket| panic!("must not launch")
            ),
            Err(UNSUPPORTED)
        );
        assert!(OpenCache::initialize(directory.path().to_owned()).is_err());
        assert!(keep.exists());
    }

    #[test]
    fn blocks_unlisted_extensions_without_creating_a_copy_but_allows_save() {
        let directory = tempfile::tempdir().unwrap();
        let cache = OpenCache::initialize(directory.path().to_owned()).unwrap();
        for name in [
            "program.EXE",
            "shortcut.lnk",
            "script.cmd",
            "site.url",
            "script.ps1",
            "report.pdf.pyzw",
            "report.docm",
            "report.xlsm",
            "report.pptm",
            "template.dotm",
            "template.xltm",
            "template.potm",
            "slides.ppsm",
            "image.svg",
            "page.html",
            "data.xml",
            "script.js",
            "unknown.extension",
            "no_extension",
        ] {
            let body = InvokeBody::Raw(vec![1, 2, 3]);
            let metadata = headers(name, "application/octet-stream");
            assert_eq!(
                FilePayload::from_ipc(&body, &metadata, true).err(),
                Some("blocked"),
                "{name}"
            );
            assert!(FilePayload::from_ipc(&body, &metadata, false).is_ok());
            assert_eq!(
                cache.open(
                    &cache.capture(),
                    payload(name),
                    SystemTime::now(),
                    |_, _| panic!("must not mark"),
                    |_, _ticket| panic!("must not launch")
                ),
                Err("blocked")
            );
        }
        assert_eq!(
            fs::read_dir(directory.path().join("open")).unwrap().count(),
            0
        );
        for name in [
            "document.pdf",
            "report.docx",
            "sheet.xlsx",
            "slides.pptx",
            "notes.txt",
            "notes.md",
            "data.csv",
            "video.mp4",
        ] {
            assert!(can_open(name, "application/octet-stream"));
        }
    }

    #[test]
    fn permits_only_listed_extensions_and_still_rejects_executable_mime() {
        let body = InvokeBody::Raw(vec![1, 2, 3]);
        for extension in "pdf txt md csv tsv rtf doc docx xls xlsx ppt pptx odt ods odp pages numbers key epub png jpg jpeg gif webp heic heif avif bmp tiff tif mp3 m4a aac wav flac ogg opus mp4 mov m4v webm mkv avi zip".split_whitespace() {
            let name = format!("report.{}%00%2F%5C%20.", extension.to_ascii_uppercase());
            assert!(FilePayload::from_ipc(&body, &headers(&name, "application/octet-stream"), true).is_ok(), "{extension}");
            assert_eq!(FilePayload::from_ipc(&body, &headers(&name, "text/x-python"), true).err(), Some("blocked"), "{extension}");
        }
        for name in ["report.pdf", "report.docx", "video.mp4"] {
            assert!(FilePayload::from_ipc(&body, &headers(name, ""), true).is_ok());
        }
    }

    #[test]
    fn maps_shell_errors_and_only_accepts_the_main_window() {
        assert_eq!(shell_result(33, 0), Ok(()));
        assert_eq!(shell_result(31, 0), Err("no_app"));
        assert_eq!(shell_result(27, 0), Err("no_app"));
        assert_eq!(shell_result(5, 1223), Err("cancelled"));
        assert_eq!(shell_result(5, 0), Err(UNSUPPORTED));
        assert_eq!(require_main("main"), Ok(()));
        assert_eq!(require_main("other"), Err(UNSUPPORTED));
    }
}
