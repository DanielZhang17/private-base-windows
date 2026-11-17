# Private Base native base

Shared Tauri 2 shell for the existing React app in `apps/web`. The Rust library
exposes `run()` with `tauri::mobile_entry_point` on mobile, and the desktop binary
calls that same entry point. It registers notification, opener, clipboard-manager,
dialog and fs plugins matching the versions used by the web platform adapters,
plus updater and process plugins on desktop.
This branch contains no Android/iOS projects, entitlements, OS code-signing
configuration, or platform-specific Tauri configuration files. Desktop updater
signing and the shared Windows passive update mode are configured here.
The shared application identifier is `xyz.chat718788.e2eechat`; each component
starts with a letter so Android and iOS project initialization accepts it.

## Development and builds

Install the host's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/),
including Rust (at least 1.90), and install the workspace dependencies from the
repository root:

```sh
npx -y pnpm@10.33.0 install
npx -y pnpm@10.33.0 native:dev
```

`native:dev` runs `tauri dev`. Its `beforeDevCommand` runs `scripts/dev-web.mjs`,
which first builds the web app's workspace dependencies with
`pnpm --filter "@e2ee-chat/web^..." build`, then starts the web workspace's
Vite server at `http://localhost:5173`. A failed dependency build stops startup.
Vite uses a strict port so Tauri cannot load a
different application's server after a port conflict. Vite proxies `/auth`,
`/api`, and `/ws` to the local Worker at port 8787; start that Worker separately
with local bindings as described in the root project guidance. Stop an existing
Vite server before using this command. Native dev alone does not start the API.

```sh
# Release build, including the host platform's default bundles.
npx -y pnpm@10.33.0 native:build

# Debug executable with the real built frontend, without an installer/bundle.
npx -y pnpm@10.33.0 --filter @e2ee-chat/native tauri build --debug --no-bundle
```

`beforeBuildCommand` runs `scripts/build-web.mjs` before compiling Rust. It builds
the web app's workspace dependencies (`pnpm --filter "@e2ee-chat/web^..." build`,
so clean checkouts work), then runs the web package's `tsc -b` and
`vite build --outDir dist-native`. A failed step stops the native build.
Both hooks share `scripts/pnpm.mjs`: JavaScript `npm_execpath` entry points run
through Node, standalone executables (including `pnpm.exe`) run directly, and
an unset `npm_execpath` falls back to `pnpm` on PATH. The Windows PATH fallback
uses a shell for `.cmd` shims and quotes the fixed arguments to preserve `^`.
Run the documented pnpm scripts to provide the package working directory.
`frontendDist` is `../../web/dist-native`, relative to `src-tauri`: the native
bundle has its own gitignored output directory, so it never shares
`apps/web/dist` with the plain web build, which does not set the native API
default. Keep the hook's steps in sync with the web package's `build` script.

The package script is `dev:native`, not `dev`, so the root `pnpm dev` (`turbo dev`)
does not start a second Vite server on port 5173; native dev is opt-in through
`native:dev`. In `turbo.json`, `@e2ee-chat/native#build` is uncached (Turbo cannot
see the frontend inputs or `src-tauri/target`; Cargo and Vite do their own
incremental work) and runs after `@e2ee-chat/web#build`, so a root `pnpm build`
never builds the shared packages concurrently with this hook. Its `env` declares
`VITE_API_BASE_URL`, preserving an explicit API override through Turbo's strict
environment filtering. Verify with `pnpm exec turbo build --dry=json`.
The native task's `passThroughEnv` forwards `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` through strict filtering without including
their values in Turbo's cache hash. They must remain outside `env`/`globalEnv`;
the native build remains uncached. The hooks inherit the environment without
printing it, and the signing helper disables shell tracing.

The host debug executable is `apps/native/src-tauri/target/debug/e2ee-chat-native`
(`.exe` on Windows). Release artifacts are under `target/release` and bundles
under `target/release/bundle`. `Cargo.lock` and the pnpm lockfile are checked in;
the Tauri CLI and Rust plugin dependencies are pinned to exact v2 releases.
The direct `serde_json` dependency is required by Tauri's generated context when
the configuration contains plugin settings.

## Desktop auto-update

The first updatable release is **0.1.0**, synchronized in `package.json`,
`src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`. The bundled version is
available to the web layer through `@tauri-apps/api/app`'s `getVersion()`; the
local main window has only `core:app:allow-version` for that API.
Tauri derives Android's `versionCode` as
`major * 1_000_000 + minor * 1_000 + patch`, so 0.1.0 is **1000**. Keep minor and
patch below 1000 and increase semver for every published Android build; never
reuse a version or override this code with a lower value. See the
[Tauri Android version rule](https://v2.tauri.app/distribute/google-play/).

The updater/process Rust plugins and JS packages are exactly pinned to
2.14.1 (2026-10-28) and 2.4.0 (2026-09-26), respectively. All newly introduced
locked Rust packages must also be at least two weeks old at integration.
The wrappers use the Rust APIs and do not import the raw JS updater bindings.

Desktop registration is guarded by `cfg(desktop)`. A plugin initialization
script merges `autoUpdate: "desktop"` into
`window.__PRIVATEBASE_NATIVE_CAPABILITIES__` before application JS runs, preserving
other capability keys. Update distribution supports macOS aarch64/x86_64 and
Windows x86_64. Other desktop targets return `"unsupported"`; this module grants
no updater capability or commands on Android/iOS. Android's native updater and
`update_open_permission_settings` belong to `native/android`.

The local desktop main window can invoke only these wrappers:

| Command | Behavior |
| --- | --- |
| `update_check`, `{ channel: "stable" \| "beta" }` | Returns `{ available: false }` or `{ available: true, version, notes?, mandatory }`. `sizeBytes` is omitted because the static desktop manifest does not specify a size. Unsupported target/channel rejects `"unsupported"`; request, manifest, or native install-ID storage failures reject `"network"`. |
| `update_download` | Downloads and verifies the Tauri signature, retaining the bytes in memory. Emits `update-progress` to `main` with `{ downloaded, total }`; total is 0 when unknown and becomes the verified byte count at completion. Resolve means verified/ready. Rejects `"not_ready"` without an eligible check, `"network"` for transport failures/timeouts, or `"download_failed"` for signature/verification failures. |
| `update_install` | Installs only retained verified bytes. Rejects `"not_ready"` before download and `"install_failed"` on installation errors. macOS replaces the bundle and requests a restart; Windows launches NSIS in passive mode, exits, and the installer relaunches the app. |

Register `listen("update-progress", ...)` before downloading and retain its
unlisten function. Only event listen/unlisten permissions accompany the wrapper
grants; there are no raw `updater:*` or `process:*` permissions. The process plugin
is registered on desktop, but has no public Rust restart function: the wrapper
uses `AppHandle::request_restart()`, the same implementation as its JS `relaunch`.
App command permissions are generated from the explicit list in `build.rs`, so
they are enforced by Tauri's ACL rather than globally accessible app commands.

Rust constructs the sole manifest endpoint with
`app.updater_builder().endpoints(...)`:

```text
https://dist.718788.xyz/private-base/releases/{stable|beta}/updater/{{target}}-{{arch}}.json
```

There are no configured fallback endpoints and no JS URL/key arguments. Both
manifest and artifact requests require HTTPS and disable redirects. Artifact
URLs must stay in the announced version's immutable folder on that same host.
The shared HTTP client permits at most 60 seconds without a successful read;
progressing artifact downloads have no overall time limit. A stalled download
rejects `"network"`, releases the session mutex, and retains the eligible update
without partial bytes so the next `update_download` can retry from the start.
Static JSON uses Tauri's `version`, `notes`, `pub_date`, and `platforms` with each
target's `signature`/`url`, plus `rolloutPercent` (required integer 0–100), optional
`minimumVersion`, and `blocked` (defaults to an empty list). Missing or malformed
rollout/version policy fails the check. The stable download-page `latest.json`
and the Android manifests are separate and are not consumed by this updater.

Eligibility requires a strictly newer semver, an unblocked candidate, and a
rollout bucket below `rolloutPercent`. Build metadata cannot bypass the version
or blocked checks. The bucket is SHA-256 of a random native 32-byte install ID,
using its first eight bytes as a big-endian integer modulo 10,000. The ID lives
in `app_config_dir()/updater-install-id` (0600 on Unix), never in JS, and persists
across launches/channels/releases. `mandatory` means the current semver is below
`minimumVersion`; it does not bypass rollout, blocking, or downgrade refusal.
Publish mandatory releases at 100% rollout when every old client needs them.

Checks/download/install are serialized. A successful check clears an ineligible
or blocked pending update and preserves a ready download only for the same
version, URL, and signature. A failed check preserves the previous successful
selection. Install uses that selection without a new network request; the web
layer should keep its periodic checks running. Downloads are not persisted
across process exit. The web layer owns startup/6-hour checks, beta opt-in, banners,
and deferring installation throughout an active call; native obeys install calls.

### Signing and builds

`bundle.createUpdaterArtifacts` is true and the supplied minisign public key is
configured in `plugins.updater.pubkey`. `requireSignedVersion` is also true:
the signed trusted comment must bind the artifact to the announced version,
preventing an old signed binary from masquerading as a newer release. The pinned
Tauri CLI embeds that version during builds. For manually signed Windows
artifacts use `tauri signer sign --app-version X.Y.Z`.

Set `TAURI_SIGNING_PRIVATE_KEY` to the path
`~/.private-base-release/updater.key` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to
the password from Keychain service `private-base-updater-key` at build time only.
On macOS the helper supplies both and executes its arguments without printing
either value:

```sh
cd apps/native
./scripts/with-signing-env.sh npx -y pnpm@10.33.0 tauri build --debug --bundles app
```

Use a shell with tracing disabled. Never run environment-dumping commands through
this helper. Keys/passwords stay outside the repository; do not put them in
`.env` files or pass passwords as CLI arguments. If the key/Keychain password is
unavailable, the helper fails without running the build. Without signing env,
`createUpdaterArtifacts` cannot produce the signed update artifacts. This is
separate from Apple bundle signing/notarization and Windows Authenticode signing.
Platform branches own those OS signing settings. Release artifacts belong under
`private-base/releases/<version>/` and must never be overwritten; channel
manifests may subsequently point at them. Nothing here publishes or uploads.

Validate without launching the app:

```sh
cd apps/native/src-tauri
cargo test --locked
# On a host permitting loopback TCP sockets, also run the download regressions:
cargo test --locked -- --ignored
cargo clippy --locked -- -D warnings
cargo fmt --check
cd ..
pnpm test
sh -n scripts/with-signing-env.sh
./scripts/with-signing-env.sh pnpm tauri build --debug --bundles app
```

Rust tests cover static-manifest parsing, malformed policy, rollout boundaries
and stability, blocked versions, minimumVersion, downgrade/build-metadata refusal,
fixed URLs, and native install-ID persistence. JS regressions cover permission
boundaries and capability merging. A bundle build does not exercise installation.
Headless download tests check transport errors, mutex release and retryable state.
Two explicitly ignored loopback tests additionally verify timeout cancellation,
a signature-verified retry, and slow downloads that exceed the read timeout while
continuing to make progress. Run them with the command above outside restricted
sandboxes that prohibit binding TCP listeners.
Round-one verification passed: 10 Rust tests (2 loopback tests explicitly ignored
in this sandbox), 25 native JS tests, Clippy with warnings denied, and Rust
formatting. The initial signed macOS debug `.app`, `.app.tar.gz`, and `.sig` were
built with the helper; the app was not launched.
Manually verify 0.1.0 → 0.1.1 on beta on both macOS architectures and Windows
NSIS: real progress, verified readiness, replacement/relaunch, tampered-signature
and wrong-version signature rejection, blocked/rollout/minimum/downgrade behavior,
and the web layer's active-call deferral. Verify updater IPC is denied to other
windows/remote pages, and confirm `getVersion()` returns the new embedded version.

## Environment

| Variable | Behavior |
| --- | --- |
| `VITE_API_BASE_URL` | Native production builds use this trimmed value, defaulting to `https://chat-api.718788.xyz` when missing/blank. It is compiled into the public frontend; it must not contain secrets. Dev leaves it unset by default, using Vite's local API proxy. |
| `npm_execpath` | Set by pnpm and consumed by both hooks. JavaScript entry points and native executables are supported; if absent, the hooks use `pnpm` on PATH. Do not set manually during normal use. |

For example, in a POSIX shell:

```sh
VITE_API_BASE_URL=https://preview-api.example.com npx -y pnpm@10.33.0 native:build
```

PowerShell: set `$env:VITE_API_BASE_URL = 'https://preview-api.example.com'` before
running the same pnpm command. Changing this variable does **not** expand the CSP:
also explicitly replace/add that API's exact HTTP(S) origin in `connect-src` and
`img-src`, and its matching WS(S) origin in `connect-src`, using a reviewed Tauri
config overlay (`tauri build --config <file>`) or a config edit. The default API
and localhost:8787 connections are already allowed. Never use wildcard API hosts.
Backend `JWT_SECRET`, `TURN_SECRET`, and `.dev.vars` do not belong in this package.

## CSP and capabilities

The shared policy is defined in `src-tauri/tauri.conf.json`. Every source beyond
`'self'` has a specific purpose:

| Directive | Allowed sources and reason |
| --- | --- |
| `default-src 'self'` | Other resource types fall back to bundled/same-origin assets. |
| `script-src 'self' 'wasm-unsafe-eval'` | Allows libsodium's WASM compilation without enabling JavaScript `unsafe-eval`, inline scripts, or remote script hosts. |
| `worker-src 'self' blob:` | Allows bundled workers and workers created from local Blob URLs. |
| `connect-src` | Exact production API HTTPS origin and matching WSS origin for encrypted messages, calls' signaling, uploads and authenticated REST requests. Exact `http://localhost:8787` / `ws://localhost:8787` permit local API development. `ipc:` / `http://ipc.localhost` are Tauri's internal command bridge, needed by the native plugins; they are not external API hosts. |
| `img-src 'self' blob: data: https://chat-api.718788.xyz https://genshin.jmp.blue https://api.dicebear.com` | Blob/data URLs display client-side decrypted attachments and previews. The exact API origin serves uploaded avatars under `/api/account/avatar/...`; the two third-party origins serve the existing Genshin and DiceBear avatars and picker previews. No wildcard hosts are allowed. |
| `media-src 'self' blob: mediastream:` | Decrypted media attachments and local/remote WebRTC streams. |
| `style-src 'self' 'unsafe-inline'` | Supports React inline style attributes and the existing UI's dynamic styles. It does not permit inline JavaScript. |

`https://genshin.jmp.blue` and `https://api.dicebear.com` are third-party image
hosts. Loading avatars or picker previews from them reveals the user's IP
address to those providers.

Tauri's normal nonce/hash and IPC-source injection remains enabled. The dev CLI
also handles the dev server's connection requirements; `devCsp` is not disabled.
See Tauri's [CSP reference](https://v2.tauri.app/security/csp/).

All capability files apply only to the local `main` window.
`capabilities/default.json` grants the shared notification, clipboard-copy and
HTTP(S)-opener permissions on every platform, with no filesystem or dialog grants.
`capabilities/desktop.json` grants only save-dialog and file-write permissions,
restricted to `"platforms": ["macOS", "windows", "linux"]`. No remote origins
receive native permissions, and no broad `core:default` or plugin default
permission sets are granted. `capabilities/updater.json` adds only the desktop
update wrappers and progress listeners described above. These permissions support the adapters in
`apps/web/src/platform/{clipboard,files,notifications,external}.ts`:

| Permission | Adapter call and purpose |
| --- | --- |
| `core:app:allow-version` | `getVersion()` reads the version embedded in the native build. |
| `notification:allow-is-permission-granted` | `isPermissionGranted()` checks the existing OS notification permission. |
| `notification:allow-request-permission` | `requestPermission()` asks the user to grant notifications. |
| `notification:allow-notify` | `sendNotification()` sends the notification after permission is granted. |
| `notification:allow-register-action-types` | `registerActionTypes()` registers the adapter's Open action for clickable notifications. |
| `notification:allow-register-listener` | `onAction()` registers the notification action callback through a plugin channel. The adapter retains this listener for the app session and does not call `remove_listener`. |
| `clipboard-manager:allow-write-text` | `writeText()` copies text. Clipboard read and image operations are not granted. |
| `dialog:allow-save` (desktop only) | `save()` lets the user choose one file destination; cancellation does not write a file. Open-file and message dialogs are not granted. |
| `fs:allow-write-file` (desktop only) | `writeFile()` writes the adapter's byte array to a destination already selected with the save dialog. There is no static filesystem scope. |
| `opener:allow-open-url` with `https://*` / `http://*` | `openUrl()` opens an absolute HTTP(S) URL in the default browser. File paths, reveal-in-folder and other URL schemes are not granted. |

On desktop, the [save dialog](https://v2.tauri.app/reference/javascript/dialog/#save)
adds its selected path to the filesystem scope at runtime. The fs plugin is registered
before dialog so that scope is available. With no static allowed paths, writes
to unselected destinations are rejected. Selected paths remain available for the
app session; no persisted-scope plugin is installed, so they are cleared on restart.

Mobile file saving is disabled. In fs plugin 2.7.1, the iOS/Android
`SafeFilePath::Url` path in `resolve_file` opens URLs without a filesystem scope
check. An empty scope and disabled dropped-path scoping cannot make that grant
safe on mobile. The desktop capability is excluded on iOS/Android, so renderer
save-dialog and file-write commands are denied there, including direct `file://`
write attempts. The `native/android` and `native/ios` branches must implement a
native save that enforces selected-path authorization before enabling mobile
file saving. The current web adapter's mobile save attempt rejects; there is no
unrestricted filesystem fallback.

`plugins.fs.scopeDroppedPaths` is explicitly `false` for fs 2.7.1. This disables
its default behavior of adding dropped files and recursively adding dropped
directories to the runtime scope, so dropping a path does not grant write access.
The dialog plugin's `open` command can also add selected files/directories to
that scope, but it is blocked: the only dialog grant is the desktop-only
`dialog:allow-save`, with no `dialog:allow-open` or `dialog:default`. Clipboard,
notification and opener do not add paths to the fs plugin's runtime scope.
No read, remove, exists, directory, `$HOME` or `$DOWNLOAD` permissions are granted.
Notification scheduling/channel management and listener removal are also absent.
No shell plugin or global Tauri API is enabled.

The merged web platform layer already supplies the JavaScript plugin bindings.
This package registers their Rust counterparts and leaves the adapters unchanged.
The individual notification permissions deliberately replace the platform README's
broader `notification:default` suggestion. OS notification permission is still
requested through the adapter's normal permission flow.

## Brand icons and startup color

The real W2 masters live in `apps/web/public/brand/`. From the repository root,
regenerate the complete icon set from the square, unmasked master, then replace
only the macOS ICNS from the rounded, transparent master:

```sh
pnpm --filter @e2ee-chat/native tauri icon ../web/public/brand/icon-1024.png
native_icon_tmp="$(mktemp -d)"
pnpm --filter @e2ee-chat/native tauri icon ../web/public/brand/icon-rounded-1024.png --output "$native_icon_tmp"
cp "$native_icon_tmp/icon.icns" apps/native/src-tauri/icons/icon.icns
rm -rf "$native_icon_tmp"
```

Use `npx -y pnpm@10.33.0` in place of `pnpm` if it is not on PATH. macOS does not
mask the app icon, so its ICNS uses the pre-rounded artwork. Windows, Android,
iOS and the other PNG assets use the unrounded master, leaving masking to their
platform. Generated assets under `src-tauri/icons/` include icon resource XML;
they are not initialized mobile projects. The temporary placeholder master has
been removed.

The main window's `backgroundColor` is `#0f3f52`. Tauri applies this color to the
window and webview before the frontend paints, avoiding a white startup flash.
OS launch-screen assets/themes remain with the platform branches' generated
Android/iOS projects.

## Platform branch responsibilities

| Branch | Configuration to add there |
| --- | --- |
| `native/macos` | Entitlements, camera/microphone usage strings (`NSCameraUsageDescription`, `NSMicrophoneUsageDescription`), permissions, signing/notarization and bundle configuration. |
| `native/windows` | WebView2 runtime/distribution strategy, installer configuration and signing. |
| `native/android` | Run `pnpm tauri android init`, own the generated project/manifest, camera/microphone/notification permissions, SDK/signing and device dev-server setup. Wire `native:android`. Implement a native, scope-checked save before enabling mobile file saving. |
| `native/ios` | Run `pnpm tauri ios init`, own the generated Xcode project/`Info.plist`, usage strings, capabilities/provisioning/signing and device dev-server setup. Wire `native:ios`. Implement a native, scope-checked save before enabling mobile file saving. |

Root `native:android` and `native:ios` currently print an explanation and exit 1;
they do not initialize projects. `src-tauri/gen/` and `target/` are ignored.
Platform branches must deliberately adjust ignore rules if they track generated
project files. Mobile initialization is intentionally deferred to those branches.

## Windows (debug, unsigned)

`src-tauri/tauri.windows.conf.json` is automatically merged by Tauri on Windows.
It selects only NSIS, installs for the current user without elevation, and leaves
Authenticode certificate/sign-command settings unset. No signing secrets are
needed. The installer downloads the WebView2 Evergreen bootstrapper when the
runtime is missing, so first installation needs internet access in that case;
it does not bundle an offline runtime. See the
[Tauri Windows installer guide](https://v2.tauri.app/distribute/windows-installer/).

NSIS includes English, Simplified/Traditional Chinese, Japanese, Korean, German,
Spanish, French, Brazilian/European Portuguese, Italian and Russian. English is
first as the fallback. `displayLanguageSelector: false` uses the OS language
without a language-selection dialog; see the [NSIS config reference](https://v2.tauri.app/reference/config/#nsisconfig).

WebView2 already follows the user's Windows display language: the pinned
[Wry 0.57.2 backend](https://github.com/tauri-apps/wry/blob/wry-v0.57.2/src/webview2/mod.rs#L345-L349)
reads `GetUserDefaultUILanguage`, converts it with `LCIDToLocaleName`, and sets
WebView2's environment `Language` before creation. Microsoft documents that
[`Language`](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environmentoptions#get_language)
controls the browser UI and Accept-Language. The web app uses the resulting
`navigator.languages` for System mode; Settings can override the app UI language.
After changing the Windows display language, restart the app. This is confirmed
from the backend source and API documentation; a Windows runtime check remains
to be done: inspect `navigator.language` and `navigator.languages` in DevTools
with a supported non-English Windows display language and System mode selected.

Windows keeps the native title bar and caption buttons (`decorations: true`).
Per UI spec 6.2, it sets no `data-titlebar="overlay"` or drag region: the web
content starts below the native frame. The minimum window size is 360×560.
Tauri replaces the entire `app.windows` array when merging the overlay, so it
repeats the main window's shared size, title and brand background settings.
CSP, the identifier, icons and plugin permissions remain inherited.

On an x64 Windows machine, install Node 22 LTS, Rust stable (MSVC toolchain),
and the Visual Studio C++ build tools and Windows SDK from the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#windows).
Then run from the repository root in PowerShell:

```powershell
npx -y pnpm@10.33.0 install --frozen-lockfile
npx -y pnpm@10.33.0 native:dev
# Stop dev before building the bundled frontend and installer.
npx -y pnpm@10.33.0 native:build --debug
```

The debug executable is `apps/native/src-tauri/target/debug/e2ee-chat-native.exe`;
the NSIS installer is `apps/native/src-tauri/target/debug/bundle/nsis/*-setup.exe`.
These are unsigned test builds. Do not use the shared release-build example for
this branch's validation.

### Open and save decrypted attachments

Windows merges `fileOpen: true` and `fileSave: "dialog"` into the existing
pre-JS native capabilities. The local `main` window alone can invoke
the v2 binary commands and `clear_open_cache()` through the
[file permissions](src-tauri/permissions/files.toml) and
[Windows capability](src-tauri/capabilities/windows-files.json):

```ts
const options = {
  headers: { "x-file-name": encodeURIComponent(name), "x-mime-type": mimeType },
};
await invoke("open_file", bytes /* Uint8Array */, options); // Promise<void>
await invoke("save_file", bytes /* Uint8Array */, options); // "saved" | "cancelled"
await invoke("clear_open_cache");
```

Rust accepts `tauri::ipc::Request<'_>` and only `InvokeBody::Raw`; JSON number
arrays and objects reject with `"unsupported"`. Both metadata headers are required,
percent-decoded once with strict UTF-8/escape validation, then sanitized. Literal
`+` stays `+`. The borrowed raw buffer's 100 MiB limit and the Open type policy are
checked before the single copy needed by the blocking file worker.

Both file commands reject payloads above 100 MiB, strip separators, controls and
Windows-invalid filename characters, protect reserved device names and cap names
at 180 UTF-8 bytes while preserving the final extension. Cached names are further
budgeted from the full destination directory, including the random subfolder and
separator, so the complete path is at most 218 UTF-16 code units (Excel's limit).
Only the stem is shortened; if the extension plus a stem cannot fit, Open rejects
with `"unsupported"`. An extension too large to preserve is rejected. MIME types
accept a simple `type/subtype` value and otherwise become `application/octet-stream`; Windows selects the handler by
extension. Names, bytes and path-bearing errors are never logged by these commands.

`save_file` presents the existing native save dialog, parented to the main window,
and writes only its selected destination. It resolves to `"saved"` after marking
and writing or `"cancelled"` without writing or marking when dismissed.
Validation/marking/write failures reject with `"unsupported"`. Existing desktop dialog/fs grants remain for legacy clients.

`open_file` writes only to `app_cache_dir()/open/s<session>-e<epoch>-<random>/<sanitized-name>`
and calls [`ShellExecuteW` with the `open` verb](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecutew).
Open requires a case-insensitive match of the final sanitized extension against
the explicit desktop allowlist:

- Documents: pdf, txt, md, csv, tsv, rtf, doc, docx, xls, xlsx, ppt, pptx, odt, ods,
  odp, pages, numbers, key, epub.
- Images: png, jpg, jpeg, gif, webp, heic, heif, avif, bmp, tiff, tif.
- Audio: mp3, m4a, aac, wav, flac, ogg, opus.
- Video: mp4, mov, m4v, webm, mkv, avi.
- Archives: zip.

Every other extension (including no extension) rejects with `"blocked"`.
Macro-enabled Office formats, SVG/HTML/XML/JS, executables and double extensions
such as `report.pdf.pyzw` are blocked. The existing Windows extension denylist and
executable/script MIME denylist remain additional checks, even for an allowlisted
extension. MIME parameters cannot disguise a blocked type. The policy runs before
copying the binary payload and again on the final cache filename before writing
or launching. The web client can offer Save with a toast; Save still accepts
blocked Open types and marks them as downloaded from the internet.
Missing/incomplete associations reject with `"no_app"`, OS
cancellation with `"cancelled"`, and other failures with `"unsupported"`.
Failed handoffs remove their copies immediately. Successful handoffs retain the
copy for asynchronous reads by the selected app. **Open hands decrypted contents
to that app**, which may make its own copies outside Private Base's control.

Both Open copies and selected Save destinations receive a
[`Zone.Identifier` alternate data stream](https://learn.microsoft.com/en-us/windows/win32/fileio/file-streams)
containing exactly `[ZoneTransfer]\r\nZoneId=3\r\n` before decrypted bytes are
written. This marks the attachment as downloaded from the internet for Windows
and Office protections. A marking failure rejects with `"unsupported"`; it never
launches an unmarked copy or reports a successful Save. On overwrite, marking
precedes truncation so a failed marker preserves the previous contents. Save to
a filesystem without ADS support also fails; cancellation performs no file I/O.
Host tests inject the stream writer and assert its exact path/content and ordering
for Open and Save. Real ADS behavior still needs an NTFS runtime check.

The dedicated Open folder is cleared before the frontend starts, on
`clear_open_cache()` (for the web lock/sign-out hook), and pruned for entries at
least one hour old before each Open. Cleanup stays inside that folder and does
not follow symlinks or Windows reparse points. The three file commands route
through a synchronous raw IPC dispatcher after Tauri's normal capability check.
They do not use Tauri's async command macro, which would defer the command call
itself until the response task was polled. Open and Save capture their admission
epoch during synchronous dispatch, before validation/copying, constructing the
response future, or scheduling workers. A request left completely unpolled before
Clear therefore keeps its original ticket and is cancelled on its first poll.
A queued revoked Save resolves `"cancelled"`; Save also rechecks after the dialog,
before writing its selected destination.

Open rechecks before copying, before/after staging, before dispatch, and at the
actual `ShellExecuteW` call. A short handoff guard makes the final check plus OS
call indivisible with revocation and never spans file I/O. `clear_open_cache`
bumps the epoch in its synchronous handler, before constructing its cleanup future
or taking the cache mutex. Stale Open work rejects with `"cancelled"`, discards
its staged directory and cannot launch.

Each staged directory records a 128-bit random process session ID and its epoch.
The session ID is generated once per process using `BCryptGenRandom` on Windows
(`/dev/urandom` in host tests). Startup tries to delete every cached copy. Clear
keeps its original cutoff, deletes all other-session and legacy copies regardless
of their epoch, and deletes this session's copies only below that cutoff. Newly
admitted opens survive delayed/retried clears. A failed deletion never adopts an
old copy into the current session or resets its eligibility: the next clear or
startup retries it even if its old epoch is higher than the current cutoff.
Reinitializing the cache within the same process also starts above any existing
owned epoch before attempting deletion, so a failed startup cleanup cannot make
an owned copy exempt by resetting the counter.
The cache mutex remains held until handoff/discard finishes, so a resolved clear
cannot be followed by an old worker leaving a decrypted copy. Cleanup failure does
not restore revoked tickets. Windows may refuse deletion while another app holds
a file open; cleanup tries every eligible entry, clear rejects on failure, and
later cleanup retries.
The existing exact-pinned [`tempfile = "=3.27.0"`](https://docs.rs/crate/tempfile/3.27.0)
development dependency is also used on Windows for random scoped directories;
that release dates to March 11, 2026. No lockfile or dependency versions changed.

Round-5 verification on the macOS host (Rust 1.99.1), from `apps/native/src-tauri`
unless noted:

```text
cargo test --locked --offline
# 51 passed; 0 failed
cargo clippy -- -D warnings
cargo clippy --all-targets --locked --offline -- -D warnings
cargo build --locked --offline
cargo fmt --all --check
# all pass
# From apps/native:
./node_modules/.bin/vitest run
# 28 passed
```

The actual Windows modules and command wiring also pass Windows-target Clippy
with warnings denied in the isolated harness under `target/windows-files-check`.
Use a writable `CARGO_HOME` in this sandbox. Validate the shared/merged Windows
config and all capabilities against the pinned CLI/generated JSON schemas.
The full `cargo build --target x86_64-pc-windows-msvc --locked --offline` exits 101
in `tauri-winres` with `NotAttempted("llvm-rc")`: the Windows resource compiler/SDK
is absent on this host. A full target `cargo check` has the same prerequisite.
The isolated Windows-target harness compiles the actual file module, commands
and deferred-window wiring without that resource step.

Manual Windows checks after integrating the web branch: open PDF, Office, text,
Markdown and CSV attachments in their default apps; confirm unknown associations
produce the toast; save, overwrite and cancel without a write on cancellation;
confirm blocked Open types offer Save; exercise Unicode/long/hostile names and
the 100 MiB limit. Confirm Excel can open a long-name cached spreadsheet and that
its complete path stays within 218 UTF-16 units. Inspect `Zone.Identifier` on both
cached and saved files on NTFS (`Get-Content -LiteralPath <path> -Stream Zone.Identifier`),
and confirm Office protected view/macro blocking and normal Windows protections
apply. Check an ADS-unsupported destination rejects instead of reporting success.
Inspect the dedicated cache after startup, lock/sign-out and an hour-old copy
followed by Open, including a file held open by another app. Confirm the flags coexist with capture/passkey
flags and other windows/remote origins cannot invoke the commands. Run the debug
Windows build above; no GUI is launched by the automated checks.

### Passkey browser handoff (phase 2)

Windows registers `passkey_handoff_start(url, callbackScheme)` and opens the
validated URL in the default browser through the existing Rust opener plugin.
Only `https://chat.718788.xyz` (including an explicit default port 443) and exactly
`/native/passkey/sign-in` or `/native/passkey/add` are accepted. Debug Rust builds
also accept `http://localhost:5173` on those paths. The callback scheme must be
`privatebase`. Userinfo, fragments, alternate ports, normalized/extra path
segments and malformed or duplicate query parameters are rejected. Requests must
carry the phase-1 state and challenge/ticket, without a verifier or extra fields.

The Windows-only [deep-link configuration](src-tauri/tauri.windows.conf.json)
associates `privatebase` in the current-user NSIS installer. At runtime,
`tauri-plugin-deep-link` also registers the current executable under
`HKCU\Software\Classes\privatebase`, supporting the raw debug executable without
elevation. Running a different debug copy updates that user's association to the
new executable. `tauri-plugin-single-instance` is installed first; its callback
shows, unminimizes and focuses the existing main window on relaunch. A pure
routing decision forwards only a matching, unexpired pending callback to
deep-link's Rust listener; normal relaunches and invalid or unsolicited links
only activate the window. Automatic single-instance `deep-link` forwarding is
deliberately disabled to avoid forwarding unsolicited URLs or diagnostic logging
of nonmatching schemes. A cold launch with a sole URL argument in another scheme
is ignored before plugin initialization, which otherwise logs that URL in debug
builds. See Tauri's [deep-link runtime registration](https://v2.tauri.app/plugin/deep-linking/#registering-desktop-deep-links-at-runtime).

Only one session can wait at a time. The native listener accepts exactly
`privatebase://passkey` with the originating state and expected `code` or
`registered` result. Wrong-state, wrong-result, duplicate, expired and unsolicited
callbacks are ignored, including cold-start links; no stored startup callback is
replayed. A callback resolves only its initiating command. The five-minute timeout
rejects with `"cancelled"`; invalid requests, a concurrent start, browser-open
failure and other command failures reject with `"unsupported"`. Session cleanup
also runs when the command future is dropped. URLs and callbacks are not logged
or written to persistent storage.

The Windows overlay defers main-window creation until registration has finished.
The pre-JS initialization script merges into
`window.__PRIVATEBASE_NATIVE_CAPABILITIES__`, preserving existing keys and adding
`passkeyHandoff: true` only after successful registration. If registration fails,
the window still opens without the passkey flag and the command returns
`"unsupported"`. Other platforms register neither this
command nor its capability advertisement. The
[Windows capability](src-tauri/capabilities/windows-passkey.json) grants only
`allow-passkey-handoff-start` to the local `main` window. The renderer receives no
deep-link getter, registration or event-listener permissions.

New direct dependencies are pinned exactly: deep-link 2.6.3 and single-instance
2.5.5 (both published October 28, 2026), plus the existing locked Tokio 1.54.1
(October 21, 2026). All predate this change by at least two weeks. The two plugins
are also dev dependencies so host tests compile the Windows Tauri command and
builder wiring without launching an app or requiring the Windows SDK.

Phase-2 verification on this Mac:

```text
cargo test --locked
test result: ok. 13 passed; 0 failed
cargo clippy -- -D warnings
cargo clippy --all-targets -- -D warnings
Finished `dev` profile [unoptimized + debuginfo]
cargo fmt --check
# exits 0
npx vitest run
Tests 24 passed (24)
# JSON Schema validation of shared + merged Windows config and Windows capability
PASS
cargo check --target x86_64-pc-windows-msvc --locked
Err value: NotAttempted("llvm-rc")
```

The cross-check reads the Windows overlay and resolves its capability before
failing in `tauri-winres`; this host has no Windows resource compiler/SDK. It
cannot build or launch a Windows executable. On Windows, run the debug build
above, then check both sign-in and add-passkey with a test account, callback
delivery and normal relaunch activation of an already running/minimized instance,
and the capability flag before the frontend starts. Confirm the raw executable
and current-user installer both register the scheme, a second pending invoke
rejects with `"unsupported"`, a
browser dismissed without a callback times out after five minutes with
`"cancelled"`, and wrong-state/result, replayed and cold-start callbacks do not
complete a session. No emulator, simulator or existing app was touched here.

### Windows capture protection

Capture protection defaults to **on**, including the sign-in screen. Native code
loads `capture-protection.json` using Tauri's `app_config_dir()` before building
the main window. On Windows the file is
`%APPDATA%\xyz.chat718788.e2eechat\capture-protection.json`, containing
`{"enabled":true}` or `{"enabled":false}`. Only an explicit boolean false disables
protection; missing, unreadable or corrupt values default to true. The Windows
overlay retains `contentProtected: true` as its default; the deferred builder
overrides it with the persisted value. Tao applies display affinity before
creating the webview or showing the window. The window stays hidden until the
additional checked Win32 call succeeds; a failure aborts startup.
The pre-JS script merges `captureProtection: "full"` alongside the passkey flag,
even when passkey registration fails, without replacing other capability keys.

`invoke("get_capture_protection")` returns `{ enabled: boolean }` from native
state. `invoke("set_capture_protection", { enabled })` returns `Promise<void>`
and persists the value before setting affinity on every current app window,
including `main`. Writes use a synced temporary file and replacement in the same
directory, preserving the previous file on write/replacement failure. A native
mutex serializes reads and updates. Persistence failure rejects without changing
the windows; affinity failure restores the previous preference and window state
and reports any rollback errors. Repeating the same value is idempotent. The
[permissions](src-tauri/permissions/capture-protection.toml) allow only these
two commands, and their [Windows capability](src-tauri/capabilities/windows-capture-protection.json)
grants them only to the local `main` window. No general window-control or renderer
config-file permission is granted. The web app reads native state and does not
store or replay a localStorage preference.

The checked call uses `RtlGetVersion` to choose `WDA_EXCLUDEFROMCAPTURE` from
Windows 10 version 2004 (build 19041) onward and `WDA_MONITOR` on older builds.
Disabling always sets `WDA_NONE`. See Microsoft's
[display-affinity API](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)
for the supported capture APIs and DWM requirement. The direct `windows`
dependency is pinned to the existing locked **0.62.2**
([published October 6, 2025](https://docs.rs/crate/windows/0.62.2)), with only the
features needed for affinity and OS-version lookup; no locked package versions
change.

Verification for this change on the macOS host:

```text
cargo test --locked
# 24 passed; 0 failed (includes persistence, write/replace failure and rollback)
cargo clippy -- -D warnings
cargo clippy --all-targets --locked --offline -- -D warnings
# Finished dev profile; no warnings
cargo fmt --check
# exits 0
npx --no-install vitest run
# 26 passed (includes capability merge and least-privilege checks)
# JSON Schema: shared + merged Windows config and all 4 capabilities
PASS
cargo check --target x86_64-pc-windows-msvc --locked --offline
# exits 101: NotAttempted("llvm-rc")
```

Cargo checks use a writable temporary `CARGO_HOME` because the default cache is
read-only in this sandbox. The persistence tests cover default-on, restart
roundtrips, malformed values, failed writes/replacements leaving window state
unchanged, and affinity failure restoring the previous state. Host tests also
type-check both capture commands, the invoke handler and deferred window setup.
An isolated `x86_64-pc-windows-msvc` harness imports the actual capture module,
window setup and command wiring; it also passes Clippy with `-D warnings` without
the application's resource-compilation step.
The Windows resource compiler/SDK is missing, so a full Windows build and launch
remain unverified. On Windows 10 2004+/Windows 11,
manually test screenshots, Snipping Tool and recording immediately from cold
launch at sign-in, then after disabling, enabling and repeating each command.
Confirm a relaunch restores the selected value, both native capability keys coexist
when passkeys are available, and other app windows follow the command. On an older
build, confirm captures show blank window content with `WDA_MONITOR`. With the
shared web UI integrated, verify a stored opt-out applies before the sign-in page
loads and the toggle takes effect immediately. Use the unsigned debug build
instructions above.

### Testing the Windows CI artifacts

`.github/workflows/native-windows.yml` runs on pushes to `native/windows` and
`workflow_dispatch`. It uses `windows-latest`, pnpm 10.33.0, Node 22 and Rust
stable, caches pnpm/Cargo, installs the frozen lockfile, and runs
`pnpm native:build --debug`. It uploads two artifacts for 14 days and does not
create a release or publish anything. This work does not push or dispatch CI.

1. After choosing to push the branch, open its successful **Native Windows
   (debug, unsigned)** run in GitHub Actions. Download and extract
   `private-base-windows-x64-debug-nsis` and/or
   `private-base-windows-x64-debug-exe` on an x64 Windows machine.
2. Run the extracted `*-setup.exe` as your normal user. Confirm it installs to
   your user profile without requesting administrator access and launches
   **Private Base**. On a machine without WebView2, keep internet available and
   confirm the bootstrapper installs the runtime. The raw
   `e2ee-chat-native.exe` can run directly once
   [WebView2 Evergreen Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
   is installed; it does not install prerequisites. Windows may warn because
   these builds are unsigned; verify the run and commit before allowing a test.
3. Confirm the window remains open, the native caption buttons/drag/resize work,
   and content and toasts do not overlap them at 360px and 1100px widths. Test
   login/API requests, encrypted messages, clipboard copy, notification clicks,
   a save dialog, and nested-route reloads. Production builds default to
   `https://chat-api.718788.xyz`; use dedicated test accounts.
4. In the debug app, open WebView2 DevTools with **Ctrl+Shift+I**. Record
   `navigator.userAgent` and `location.origin`, then run the following in the
   Console. It mirrors `capabilities.e2eeCalls` without requesting media or
   changing application state:

   ```js
   (() => {
     const sender = globalThis.RTCRtpSender?.prototype;
     const receiver = globalThis.RTCRtpReceiver?.prototype;
     const legacy = typeof sender?.createEncodedStreams === "function" &&
       typeof receiver?.createEncodedStreams === "function";
     const script = typeof RTCRtpScriptTransform !== "undefined" &&
       typeof Worker !== "undefined" && !!sender && !!receiver &&
       "transform" in sender && "transform" in receiver;
     const e2eeCalls = typeof RTCPeerConnection !== "undefined" &&
       !!globalThis.crypto?.subtle && typeof TransformStream !== "undefined" &&
       (legacy || script);
     return { legacy, script, e2eeCalls };
   })()
   ```

5. Require `e2eeCalls: true` before testing voice/video with another supported
   client. Check camera/microphone allow and deny paths and that ending a call
   releases capture. If neither transform path exists, calls must be blocked
   with `E2EE_CALL_UNSUPPORTED`; never enable an unencrypted fallback. API
   detection alone does not verify encryption or a successful call. Uninstall
   through Windows Settings after testing the installer.

### WebView2 calls and permission limits

[WebView2 uses Chromium](https://learn.microsoft.com/en-us/microsoft-edge/webview2/).
Chromium ships the legacy `createEncodedStreams` path and the newer
[`RTCRtpScriptTransform` path (Chrome 141)](https://developer.chrome.com/release-notes/141#webrtc_encoded_transform_v2).
Current Evergreen WebView2 is therefore expected to support encoded transforms;
the installed runtime must pass the probe above. The shared app checks both
sender and receiver APIs and fails closed. No feature flag, CSP relaxation,
permission grant or release debug hook is added here.

Camera/microphone access uses WebView2's
[permission requests](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/overview-features-apis#permissions)
and Windows privacy settings. Unpackaged Win32/NSIS has no Tauri configuration
field equivalent to Apple's camera/microphone usage strings. Required explanatory
copy for the shared pre-permission UI is:

- "Private Base uses the camera for end-to-end encrypted calls."
- "Private Base uses the microphone for end-to-end encrypted calls."

Shared-branch request: show that rationale before requesting capture if it is
not already present; `apps/web` is outside this branch's edit scope. OS/WebView2
permission dialogs and denial behavior still need a Windows runtime check.

This Mac cannot build or launch the Windows artifact: the installed MSVC Rust
target alone does not supply `llvm-rc` or the Windows SDK/linker. Windows CI and
the manual artifact checks above remain necessary; a successful cross-target
type check would not establish WebView2 call support or launch behavior.

Local Windows-branch verification on this Mac: `cd apps/native && npx vitest run`
passes all 23 tests, and standalone actionlint 1.7.12 accepts
`.github/workflows/native-windows.yml`. With a temporary writable `CARGO_HOME`
outside the sandbox's read-only Cargo cache,
`cd apps/native/src-tauri && cargo check --target x86_64-pc-windows-msvc`
reads the Windows overlay, then exits 101 in `tauri-winres` with
`NotAttempted("llvm-rc")`. No Windows executable or installer has been built or
launched locally, and CI has not been run from this worktree.

## Verification and integration limits

```sh
npx -y pnpm@10.33.0 --filter @e2ee-chat/native test
npx -y pnpm@10.33.0 typecheck
npx -y pnpm@10.33.0 --filter @e2ee-chat/web test
npx -y pnpm@10.33.0 --filter @e2ee-chat/api test
cd apps/native/src-tauri
cargo check
cargo clippy -- -D warnings
cargo fmt --check
# Requires a usable Windows resource compiler/SDK even for cargo check:
cargo check --target x86_64-pc-windows-msvc
```

Build-hook tests cover the dependency-first step order, the production default,
blank values, literal environment overrides, failure propagation, and the
workspace wiring (native output directory, opt-in dev, uncached Turbo build and
API environment forwarding). They also cover JavaScript/standalone/PATH pnpm
launchers and dependency-first dev startup and failure handling. The CSP
regression test asserts the exact image source directive, including both
third-party avatar origins without wildcards. The capability regression test
asserts both exact permission lists and the desktop platform restriction, including
the desktop-only write-file permission and HTTP(S)-only opener scope, so extra
filesystem or clipboard access or mobile save grants fail it.
It also requires `plugins.fs.scopeDroppedPaths` to remain `false`, guarding the
save-dialog-only boundary against automatic drag-and-drop scope grants.
A native startup smoke test verifies
process survival, not encrypted calls or OS permission dialogs. Each platform
branch must verify WebView support for the app's WebRTC Insertable Streams path;
an unsupported E2EE path must fail closed.

Host verification on macOS (Rust 1.99.1): `cargo check`, Clippy with warnings denied,
Rust formatting, root typecheck, 23 native tests, 330 web tests and 141 API tests all
passed. The debug/no-bundle build ran the web build first and succeeded. The
executable survived a 10-second smoke run without a Rust panic, with macOS
LaunchServices/XPC diagnostic messages in this sandbox. A clean build (no
`packages/*/dist` or `apps/web/dist*`) also succeeded.
The Windows cross-check reached the app build script but failed in `tauri-winres`
with `NotAttempted("llvm-rc")`: this host lacks the Windows resource compiler/SDK.

Round-two mobile init checks used a throwaway copy outside the worktree:
`tauri android init --ci --skip-targets-install` generated a project containing
`xyz.chat718788.e2eechat`. The corresponding iOS command passed identifier
validation but could not finish because XcodeGen was missing and the sandbox
cannot install it into Homebrew's directories. No mobile projects were retained;
the throwaway copy was deleted. The iOS branch still needs the host prerequisites
from the linked Tauri guide before completing initialization.

The merged API CORS allowlist includes `tauri://localhost`,
`http://tauri.localhost` and `https://tauri.localhost`, in addition to the web site,
Pages previews and Vite. Platform branches must confirm their actual WebView
origin and test authenticated API requests without weakening CORS, token checks
or encryption. This package does not modify `apps/api` or `apps/web`.
