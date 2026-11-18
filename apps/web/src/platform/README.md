# Platform integration

Import `isNative`, `platformName`, `capabilities`, `navigate`, `notify`,
`copyText`, `openExternal`, `openFile`, and `saveFile` from `platform/index.ts`.
Capabilities use getters; read them when rendering or starting an operation.

- `notify({ title, body?, onClick?, tag?, icon? }): Promise<boolean>` requests
  permission at most once per session (call `requestNotificationPermission()`
  from a user action to ask again) and returns false if denied/unavailable. Native notifications use
  the notification plugin and route click callbacks by notification ID.
- `copyText(text): Promise<void>` uses the native clipboard plugin or the web
  clipboard, with a selection fallback for older browsers.
- `openExternal(url): Promise<void>` accepts absolute HTTP/HTTPS URLs and opens
  the system browser on native, or a browser tab without an opener on web.
- `capabilities.saveFile` is true on web and native desktop. On native iOS/Android
  it becomes true when the shell advertises `fileSave` (see the command contract below).
- `saveFile(blob, filename): Promise<"saved" | "cancelled" | undefined>` returns the
  native command result, or reports the outcome of the legacy desktop save dialog
  and file write. Web uses a temporary object URL and download link and resolves
  to `undefined`. When `capabilities.saveFile`
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
  therefore rejects mobile saves without loading dialog/fs unless the shell advertises
  the scoped `save_file` command below.

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

## Native auto-update

`capabilities.autoUpdate` reads the native pre-JS `autoUpdate: "desktop" | "android"`
flag without altering other capability keys. Browsers, iOS and older shells do not
check for updates or display update controls. `updates.ts` wraps the fixed native
commands and progress event; it passes only the selected channel to a check, never
a URL. Native owns rollout, blocking, downgrade protection and verification.
`getVersion()` uses Tauri's embedded app version. `features/updates` owns a single
auth-independent lifecycle beneath CallProvider, including call-aware install
deferral. Native integration, manifest layout and acceptance are in
[releasing.md](../../../../docs/releasing.md).


## Native file command contract v2 (binary IPC)

Before JavaScript starts, advertise supported commands on
`window.__PRIVATEBASE_NATIVE_CAPABILITIES__`:

```ts
{ fileOpen: true, fileSave: "dialog" | "downloads" | "share" }
```

Only advertise each flag once its command is implemented and permitted. The frontend
passes a **raw `Uint8Array` body**, never a JSON object or number array:

```ts
invoke("open_file", bytes /* Uint8Array */, {
  headers: { "x-file-name": encodeURIComponent(name), "x-mime-type": mimeType }
}) // Promise<void>; rejects "unsupported" | "no_app" | "cancelled" | "blocked"
invoke("save_file", bytes /* Uint8Array */, {
  headers: { "x-file-name": encodeURIComponent(name), "x-mime-type": mimeType }
}) // Promise<"saved" | "cancelled">
```

Rust commands take `request: tauri::ipc::Request<'_>`, read `InvokeBody::Raw(bytes)`,
and reject `InvokeBody::Json` with `"unsupported"`. Read and percent-decode the name
header, validate the MIME form and sanitize the final name. Enforce the 100 MiB cap
before any copy where possible. Binary IPC avoids the ~30x memory overhead of JSON
number arrays. `clear_open_cache` and the pre-JS capability flags are unchanged.

A `"blocked"` Open rejection shows the translated safety message and an explicit
Save action. It never automatically saves or retries Open. Save remains the user's
choice and can save types refused for Open.

### Native enforcement policy

Native branches enforce the following **before OS handoff**, using case-insensitive
extension and MIME checks on the final sanitized name. Dangerous last extensions in
double-extension names are also blocked. These restrictions are native responsibilities;
web IPC tests assert the binary transport and blocked-to-Save UI behavior.

- Windows Open blocks: exe com scr pif cpl msi msp mst bat cmd ps1 psm1 psd1 ps1xml
  vbs vbe js jse wsf wsh wsc hta lnk url reg inf scf jar py pyw pyc pyo pyz rb pl php
  sh bash appref-ms application gadget msc msh* vb chm settingcontent-ms library-ms
  appx appxbundle msix msixbundle.
- macOS Open blocks: app command tool sh bash zsh csh ksh terminal workflow action
  scpt scptd applescript pkg mpkg jar py pl rb php osx dylib bundle plugin kext prefPane.
- Executable/script MIME types (including application/x-msdownload, application/x-sh,
  application/x-executable, application/java-archive and text/x-python) are blocked.
- Android Open also blocks APK (`application/vnd.android.package-archive`). Mobile
  viewers retain OS sandboxing. Blocked files can still be saved explicitly.
Before handing a file to the OS, check both the case-insensitive extension and MIME
against the Open policy on the final sanitized name, including double extensions
whose last component is dangerous. Rejections use `"blocked"`; Save stays allowed.

- Before opening **and when saving**, Windows marks received copies with the
  `Zone.Identifier` ADS (`[ZoneTransfer]\r\nZoneId=3\r\n`) or IAttachmentExecute.
  macOS sets `com.apple.quarantine` to `0081;<hex unix time>;Private Base;<UUID>`.
  This preserves SmartScreen/Gatekeeper and Office downloaded-file protections.

`openFile(blob, filename, mimeType)` uses `open_file` when `fileOpen` is true.
Without that flag, native shells retain the legacy save behavior: a selected-path
save dialog on desktop, or a visible unsupported notice on mobile. With `fileSave`,
`saveFile` uses `save_file`; mobile never imports the desktop dialog/fs plugins.
The `share` mode labels the message-menu action Share file. Android confirms
`downloads` saves with a native notification or an Open action in a Snackbar.
The web UI shows success notices for desktop dialog saves and localized errors
for failed native saves. Native implementations
must sanitize names, scope any temporary files, clean them up, and never log names
or bytes. Native Open necessarily hands decrypted bytes to the selected application.
Cancellation from Save resolves without writing; Open rejections display a toast.

On web, PDFs open in a new tab using a newly created blob whose MIME type is forced
unconditionally to `application/pdf`, regardless of the input blob's declared type.
The direct tab path uses `noopener`. For asynchronous fetching/decryption, the hook
reserves a trusted blank tab during every tap (including cached PDFs), detects blocked
reservations before loading, immediately sets its `opener` to null,
and navigates it only after the forced-PDF blob is ready. The browser PDF viewer
handles PDF bytes in its plugin context; HTML/script bytes mislabeled as PDF are
never parsed into an app-origin document. PDF blob URLs are revoked after 60 seconds.
PDFs never use an iframe, since Chromium can show a blank viewer in sandboxed frames.

Plain text/Markdown/CSV render inside the app Dialog as a React `<pre>` text node
(`textContent`), with no HTML parsing. Preview decoding/rendering is capped at 2 MiB,
checking both advertised and actual decrypted size. Larger text offers Download;
there is no automatic download. Native text/PDF Open still uses `open_file` unchanged.

Known raster images and videos keep the existing `<img>` / `<video>` viewer; their
adapter tab fallback retains its sandboxed wrapper. SVG, HTML/XHTML, XML, JavaScript
and unknown types remain download-only, regardless of a `.pdf` filename. No attachment
content or filename enters generated wrapper HTML. Decrypted bytes remain in memory;
only user-initiated downloads write them. No decrypted attachment enters IndexedDB.

### Biometric device unlock

A supported native shell advertises
`window.__PRIVATEBASE_NATIVE_CAPABILITIES__.biometricUnlock` before JS starts.
Its value is `"touchid"`, `"faceid"`, `"windows-hello"`, or
`"android-biometric"`. Browsers and older shells leave it absent. The web
adapter in `biometric-unlock.ts` exposes enroll, unlock, and remove.

| Command | Arguments | Success |
| --- | --- | --- |
| `biometric_unlock_enroll` | `{ vaultId, key, locale? }` | No value |
| `biometric_unlock` | `{ vaultId, locale? }` | The stored key |
| `biometric_unlock_remove` | `{ vaultId }` | No value, including if the item is absent |
| `biometric_unlock_probe` (optional) | No arguments | A method kind, `"fingerprint"`, `"biometric"`, or `null` |

The vault ID is a random local identifier for this keystore slot. The key is exactly 32 bytes encoded
as unpadded base64url. Enroll and unlock require fresh biometric authentication.
Bind secrets to this installation and current biometric set via the OS keystore.
The shell must deny unlock if the biometric set changes and reject with
`"invalidated"`. Use `"cancelled"` for a dismissed prompt and `"unsupported"`
when the keystore cannot enforce the contract.

Accepted platform guarantees (PM decision, 2026-11-18). The minimum is that
adding a new biometric must invalidate the item, because that is the takeover
risk. Removing one of several enrolled biometrics need not invalidate it.
- **macOS / iOS:** Keychain `biometryCurrentSet` invalidates on any change to
  the enrolled set.
- **Android:** a Keystore key with `setInvalidatedByBiometricEnrollment(true)`
  is invalidated when a biometric is added or all are removed. Removing one of
  several may leave the item usable.
- **Windows:** the factor is Windows Hello verification (face, fingerprint or
  the TPM-backed Hello PIN) using a `KeyCredentialManager` credential.
  Biometric re-enrolment cannot be detected. Deleting or resetting the Hello
  credential invalidates the item. The UI labels this method "Windows Hello",
  never biometrics alone. Never include key material in logs,
errors, or persistent IPC state. IndexedDB stores only the vault ID and slot
metadata for native unlock. The app can use any other enrolled method if a
biometric item is invalidated.
Before invoking enrollment, the web client commits a cleanup journal entry
with the new slot identifier. It removes that entry in the IndexedDB
transaction that saves the vault slot. Turning off native unlock writes its
identifier to the same journal in the transaction that removes the slot.
Vault and device resets retain cleanup entries and discard outstanding
enrollment commits. The app drains the journal one item at a time at startup,
after reset, on focus, and when the user retries in Security settings. A
successful, idempotent removal retires its entry. The web client bounds probe,
prompt, and removal waits to 1.5 seconds, 60 seconds, and 8 seconds respectively.
An expired or cancelled web wait does not cancel native IPC already in flight.
Cleanup uses the journal and the existing ordering guarantee for the slot ID.

#### NATIVE-CONTRACT-CHANGES

- Advertise `biometricUnlockRemove: true` whenever removal is available
  independently of the ability to enroll or unlock. The app also accepts the
  macOS branch’s `biometricUnlockCleanup: true` and infers removal support
  from the existing `biometricUnlock` advertisement or an advertised probe.
  Removal requires no authentication prompt. It must either finish after any
  earlier admitted enrollment of that ID has settled, or reject with `failed`
  while that enrollment can still write. This applies across document reloads
  and processes sharing the same native store.
- Advertise `biometricUnlockProbe: true` when the optional, non-interactive
  `biometric_unlock_probe` is registered. The app also accepts the Android
  branch’s `androidBiometricProbe: true`. Return a value valid for
  `biometricUnlock`, or return `"fingerprint"` for a fingerprint-only Android
  prompt and `"biometric"` for a generic Android prompt. Return `null` or
  reject with `unsupported` when the method is unavailable. Reject transient
  probe errors with `failed` so the app can offer a retry. The web client calls
  the probe at startup, on focus, after saving a native slot, and on retry.
  A probe result only describes present availability. The unlock command
  determines whether an individual slot has been invalidated. An explicit
  unlock of a saved slot can invoke the unlock command while a probe is pending.
- A shell without Web Locks may advertise `biometricUnlockSingleDocument: true`
  if only one live privileged document can access the native key store and
  its IndexedDB journal at any time. The existing Android branch’s
  `androidBiometricProbe: true` also opts into this single-document fallback.
  Without either form of exclusive enrollment coordination, the web client
  allows unlock and cleanup of retired keys. Recovery of a journal entry
  whose enrollment may still be active requires Web Locks or the
  single-document guarantee.
- On macOS, enroll and unlock may receive the optional `locale` argument
  containing the web app’s current BCP 47 locale. Older handlers can ignore
  it. The existing argument names, key encoding, and success values for
  enroll, unlock, and remove continue to work.
- The client recognizes `unsupported` from enrollment as a durable limitation
  for that method in the current document. Settings and the unlock offer use
  this result to stop offering enrollment. The wire error codes are
  `cancelled`, `lockout`, `invalidated`, `unsupported`, and `failed`, encoded
  as a string or an object with a `code` field. Use `invalidated` only for a
  slot confirmed permanently unavailable. Unknown errors are retryable.
- The existing `androidBiometricKind: "fingerprint"` hint still selects the
  fingerprint-only label alongside `biometricUnlock: "android-biometric"`.
  A cleanup-only shell can advertise `biometricUnlockKind` using the same
  values as `biometricUnlock` to keep the method label without enabling
  authentication. For example, an iOS Touch ID device can identify its method
  even with the sensor unavailable. Windows uses the Windows Hello label when
  the capability is unavailable and the shell is identified as Windows.

### Native passkey provisioning capability

Advertise `passkeyProvisionHandoff: true` alongside `passkeyHandoff: true`
when the launcher accepts `mode=provision&bundleHash=<base64url SHA-256>`
on the existing sign-in path while retaining the state and callback checks.
Older launchers can continue ordinary passkey sign-in and registration.
