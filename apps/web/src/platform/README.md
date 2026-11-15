# Platform integration

Import `isNative`, `platformName`, `capabilities`, `navigate`, `notify`,
`copyText`, `openExternal`, and `saveFile` from `platform/index.ts`.
Capabilities use getters; read them when rendering or starting an operation.

- `notify({ title, body?, onClick?, tag?, icon? }): Promise<boolean>` requests
  permission at most once per session (call `requestNotificationPermission()`
  from a user action to ask again) and returns false if denied/unavailable. Native notifications use
  the notification plugin and route click callbacks by notification ID.
- `copyText(text): Promise<void>` uses the native clipboard plugin or the web
  clipboard, with a selection fallback for older browsers.
- `openExternal(url): Promise<void>` accepts absolute HTTP/HTTPS URLs and opens
  the system browser on native, or a browser tab without an opener on web.
- `capabilities.saveFile` is true on web (including mobile browsers) and native
  desktop, and false on native iOS/Android until a native share-sheet save is added.
- `saveFile(blob, filename): Promise<void>` uses a native desktop save dialog
  followed by a write to the selected path; cancellation does not write a file.
  Web uses a temporary object URL and download link. When `capabilities.saveFile`
  is false, it rejects with `SaveUnsupportedError` (`code: "SAVE_UNSUPPORTED"`,
  exported from `platform/index.ts`) before importing either dialog or fs.
  Image/video previews do not depend on save support.
- `captureUserMedia(constraints)` / `captureDisplayMedia(constraints)` (also
  re-exported from `services/webrtc.ts`) wrap `getUserMedia`/`getDisplayMedia`
  and register every acquired track; `stopAllCapturedTracks()` stops them all.
  Never call `navigator.mediaDevices` directly, or session expiry cannot release
  tracks held outside `callStore.localStream` (e.g. the camera during a screen
  share).
- `clearAccountScopedState(): void` stops call media and drops the query cache
  and chat/presence/call stores. Call it whenever a session ends without a
  page load; the session-expiry paths in `services/api.ts` already do.
- Adapter/plugin failures reject their promises so callers can show an error.
  `navigate(path)` is synchronous and uses the registered React router, with a
  location fallback before mounting. `RouterNavigation` registers it at startup.

Web and native both use `BrowserRouter`. Tauri 2's asset resolver falls back to
`index.html` for missing paths, including reloads on nested chat routes:
[Tauri 2.0 source](https://github.com/tauri-apps/tauri/blob/tauri-v2.0.0/crates/tauri/src/manager/mod.rs#L379-L385).

## Requests for W1 and W3

- W3: hide passkey controls in LoginPage and SettingsPage when
  `capabilities.passkeys` is false. Credential operations also reject with
  `PasskeyUnsupportedError` (`code: "PASSKEY_UNSUPPORTED"`). Native origins are
  intentionally excluded; the server WebAuthn origin list is unchanged.
- W1/W3: when `capabilities.e2eeCalls` is false, replace call controls with a
  clear message that this device cannot make end-to-end encrypted calls.
  Catch `E2EECallUnsupportedError` (`code: "E2EE_CALL_UNSUPPORTED"`), re-exported
  by `services/webrtc.ts`, for setup failures. There is no plaintext fallback.
- W1/W3: adopt `copyText` and the other adapters in page/component logic.
  `attachLocalTracks` is only for initial setup before a local SDP is installed;
  subsequent camera/screen changes must reuse an already transformed sender.
- W3: hide or disable Save when `useFileSave().saveUnsupported` is true or
  `capabilities.saveFile` is false. FilePreview already uses this hook and keeps
  images/videos visible when saving is unavailable.

## Requests for native/core

No Tauri project files are included here. Register Rust plugins compatible with
the JS versions in `apps/web/package.json`: notification, clipboard-manager,
opener, dialog, and fs. Grant these permissions to the app webview:

- `notification:default` (permission checks/requests, sending, action registration
  and event listeners).
- `clipboard-manager:allow-write-text`.
- `opener:allow-open-url`, scoped to HTTP/HTTPS URLs.
- Desktop only: `dialog:allow-save` and `fs:allow-write-file`; the save dialog
  adds the chosen destination to the filesystem scope. Do not grant unrestricted
  filesystem access. Native mobile receives no fs write grant: fs plugin 2.7.1
  does not enforce selected-path scopes for mobile `file://` URLs. The frontend
  therefore rejects mobile saves without loading dialog/fs. Native/core will add
  a share-sheet save path later.

Supply `VITE_API_BASE_URL=https://chat-api.718788.xyz` when building the frontend
(example: `apps/web/.env.native.example`). Native startup rejects a missing or
non-HTTP(S) absolute base URL. Vite only loads `.env.native` automatically when
using `--mode native`; exporting the environment variable also works.
The root `.gitignore` currently ignores `.env.native.example` via `.env.*`;
the integrating workstream must force-add the example or add an ignore exception.

Validate plugin permissions, notification clicks, save dialogs, clipboard, nested
route reloads and encrypted calls on the actual four target WebViews. Tests use
mocked native plugins; capability detection reflects the installed WebView's
sender/receiver APIs, not the OS name. Chromium uses `createEncodedStreams` with
`encodedInsertableStreams: true`; WebKit uses `RTCRtpScriptTransform` workers.
Windows notification clicks are only reported while a toast is on screen, per
the [plugin documentation](https://v2.tauri.app/reference/javascript/notification/#onaction).
Notification click callbacks are in memory and apply while the app is running;
restoring navigation after an OS cold launch needs native lifecycle integration.

Native passkey handoff (phase 1) is documented in [native-passkeys.md](../../../../docs/native-passkeys.md).
`capabilities.nativePasskeys` is separate from browser WebAuthn. Phase 2 launchers
advertise the `passkey_handoff_start` command before JS starts; older launchers
keep this capability disabled. Login/settings show passkeys when either path is
available. Handoff authentication still requires password unlock of local keys.

Android background integration is enabled only by native Android plus the pre-JS
`__PRIVATEBASE_NATIVE_CAPABILITIES__.backgroundConnection` and
`.nativeCallNotifications` flags (exposed through `capabilities`). Older shells
never receive the new commands. `android-background.ts` whitelists the app-command
IPC fields; message notifications carry only conversation ID and sender name.
`android-background-service.ts` serializes service changes and stores opt-in at
`private-base:android-background:<userId>` on this device. UnlockedAppEffects owns
its session; account teardown and local key lock synchronously invalidate work
through `registerUnlockedSessionCleanup`, then stop the native service.
CallProvider owns native notification routing and the single FIFO action drain.
Hidden native wakeups may decline; Accept and conversation navigation wait for a
visible unlocked session. Accept validates the current secure invite and server
state before using the existing local-consent invitation owner. No native event
payload or notification alone grants call ownership.
