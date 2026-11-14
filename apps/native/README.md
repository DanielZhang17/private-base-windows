# Private Base native base

Shared Tauri 2 shell for the existing React app in `apps/web`. The Rust library
exposes `run()` with `tauri::mobile_entry_point` on mobile, and the desktop binary
calls that same entry point. It registers notification, opener, clipboard-manager,
dialog and fs plugins matching the versions used by the web platform adapters.
This branch contains no Android/iOS projects, entitlements, installer settings,
signing configuration, or platform-specific Tauri configuration files.
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

The host debug executable is `apps/native/src-tauri/target/debug/e2ee-chat-native`
(`.exe` on Windows). Release artifacts are under `target/release` and bundles
under `target/release/bundle`. `Cargo.lock` and the pnpm lockfile are checked in;
the Tauri CLI and Rust plugin dependencies are pinned to exact v2 releases.
The direct `serde_json` dependency is required by Tauri's generated context when
the configuration contains plugin settings.

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

Both capability files apply only to the local `main` window.
`capabilities/default.json` grants the shared notification, clipboard-copy and
HTTP(S)-opener permissions on every platform, with no filesystem or dialog grants.
`capabilities/desktop.json` grants only save-dialog and file-write permissions,
restricted to `"platforms": ["macOS", "windows", "linux"]`. No remote origins
receive native permissions, and no broad `core:default` or plugin default
permission sets are granted. These permissions support the adapters in
`apps/web/src/platform/{clipboard,files,notifications,external}.ts`:

| Permission | Adapter call and purpose |
| --- | --- |
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
