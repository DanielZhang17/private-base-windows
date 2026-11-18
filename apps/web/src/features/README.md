# Page logic contract for W3

Pages keep their current markup and classes and consume these hooks. Hooks contain no JSX or DaisyUI dependencies. Unless a parameter is shown, call the hook without arguments in the page's existing route. Page hooks require a React Router context; query-backed hooks also require the existing QueryClientProvider. Authentication, key ownership checks, crypto primitives, message sync and API token refresh remain in their existing modules.

Async actions report errors through returned state. Input setters are React state setters and accept values or updater functions. `navigate` is React Router's navigation action. DOM refs are bindings for the view, not application state to duplicate.

Keep these browser-test contracts:

- Placeholders: `Username`, `Display Name`, `Min 8 characters`, `Confirm Password`, `Password`, `Recovery key`, `Type a message...`, `Enter username...`.
- Buttons: `Create Account`, `Continue`, `Sign In`, `Sign Out`, `Unlock`, `New Chat`, `Start`, `Send`, `Accept`, `Sign in as @<user> instead`.
- Heading: `Chats`. Text: `Save Your Recovery Key`, `This browser already holds encryption keys`, `Your device keys will finish uploading automatically`, and `no longer knows which device they belong to`.
- Keep recovery-key text in `.mockup-code code`. Login/register/unlock must continue to submit through forms. Preserve the explicit local-key forgetting prompt.

## `auth/useLoginFlow.ts` — `useLoginFlow()`

State: `username`, `password`, `recoveryKey`, their `set*` setters; `error`, `loading`; `blockedOwner` (`undefined` means no prompt, `null` means keys with unknown ownership); `pendingLink` (`deviceName`, `linkRequestId`, `shortCode`, `expiresAt`, `mode`); `linkCompleting`; `capabilities` from `platform/capabilities.ts`, including `capabilities.passkeys`; `passkeysSupported` (compatibility alias); `recoveryRetry`. Bind `usernameInput` to the username input so autofill/passkey prefetch continues to work.

Actions: `handleSubmit(event)`, `preparePasskeyEntry()`, `handlePasskeyEntry()`, `signInAsOwner()`, `forgetLocalKeys()`, `cancelLink()`. Login prepares passkey options before the gesture and aborts conditional autofill when an explicit sign-in starts. New-device provisioning saves an encrypted unlock method before activating the device. Existing-device passkey sign-in still leaves local keys locked. See [passkey setup](../../../../docs/passkey-setup.md).

W3b step order: `step` starts at `sign-in` (Username and Password only). `handleSubmit` signs in with existing keys or, after the owner/device checks, sets `step="setup"` without generating or deleting keys. `setupMethod` starts null. `useRecoveryKey()` reveals the recovery textarea; its form uses `handleSubmit`. `approveFromAnotherDevice()` starts an approval request. Both setup actions repeat the owner/device checks before replacing any keys. `backToSignIn()` clears the recovery input. The existing API verifies new-device credentials when the chosen start/recover request runs; the local setup transition does not authenticate a session. Cancel returns to setup; `retryLink()` checks the same pending request immediately and shares the poll/completion lock.

Render `ForgetLocalKeysPrompt` when `blockedOwner !== undefined`, and the approval/recovery view when `pendingLink` exists. A pending request polls every 1.5s and stops polling on cleanup. Cancel is ignored while a poll/completion is in flight.

Approved requests are stored in sessionStorage under `e2ee-recovery-retry` with exactly `{ linkRequestId, challengeNonce, mode, deviceName, expiresAt, username }`. No password or recovery key is stored there. After reload, `recoveryRetry` offers **Finish recovery** through the password form; keep its username read-only. No completion runs until the password successfully unlocks the existing keys. Completion reuses the request/nonce and preserves the existing 409/deviceId lost-response login path. Success, expiry, rejection, cancellation or explicitly abandoning the retry clears the record. A different local key owner still gets the existing guard.

## `auth/useRegisterFlow.ts` — `useRegisterFlow()`

State: `username`, `displayName`, `password`, `confirmPassword`, `avatarUrl`, `showAvatarPicker` and their setters; `error`, `loading`, `generatedRecoveryKey`, `uploadWarning`, `blockedOwner`.

Actions: `handleSubmit(event)`, `forgetLocalKeys()`, `copyRecoveryKey()`, `navigate`. `copyRecoveryKey` uses the platform clipboard adapter. Use `navigate('/login', { state: { username } })` for the prompt's sign-in-instead action and `navigate('/')` for Continue. The hook preserves the local-key owner guard, registration, recovery-key generation and three pre-key upload attempts. It prevents duplicate registration and cancels upload-delay timers on unmount; app key maintenance continues to handle later uploads. Show the full recovery-key step even when uploading ultimately fails. `avatarSrc` resolves the selected avatar for the UI Avatar. `copyRecoveryKey()` returns a promise so the view can show success/failure toasts. `saveRecoveryKey()` uses the platform file adapter; show it only when `capabilities.saveFile`. Continue requires the saved-key acknowledgement in the view; keep `.mockup-code code` intact.

## `auth/useUnlock.ts` — `useUnlock()`

State: `auth.user`, `password`/`setPassword`, `error`, `loading`, `confirmForget`/`setConfirmForget`, `redirectTo`.

Actions: `handleUnlock(event)`, `handleForgetDevice()`. Render `<Navigate to={redirectTo} replace />` when non-null. The hook never renders navigation itself. Unlock returns to the original pathname/search/hash. `avatarSrc` resolves the account avatar. `passwordInput` focuses on tablet/desktop, and selects the input after a wrong password. Forget remains a two-step action; the first call only opens the shared acknowledgement dialog. Its confirm calls `handleForgetDevice` after acknowledgement. Unlock and forget are single-flight.

## `chat/useChatList.ts` — `useChatList()`

State: `conversations`, `pendingConversations`, `acceptedConversations`, `isLoading`, `listError`, `loadError`, `user`, `onlineUsers`, `unreadCounts`, `allMessages`; modal/form state `showNewChat`, `showNewGroup`, `newChatUsername`, `groupName`, `groupMembers`, `newChatError` with their setters; `creatingChat`. `groupMembers` uses the existing plain `PickerUser` shape.

Actions: `openChat(id)`, `startNewChat()`, `startNewGroup()`, `respondToRequest(id, 'accept' | 'decline')`, `dismissListError()`. Presentation helpers: `getDirectPeer(conversation)`, `getConversationName(conversation)`, `relativeTime(timestamp)`, `getLastMessagePreview(content, type)`. Creation is single-flight. Render initial loading/`loadError` before the empty list. Request-action failures appear in dismissible `listError` alongside cached conversations; retry and a later successful refetch clear them.

## `chat/useConversation.ts` — `useConversation()`

Reads `:conversationId` from the route. State: `conversationId`, `conversation`, `conversationLoading`, `conversationError`, `conversationMessages`, `user`, `conversationName`, `directPeer`, `peerOnline`, `typingNames`, `isGroupAdmin`, `isPendingRequest`, `existingMemberIds`, `callingSupported`, `callDisabled`, `startingCallType`, `callError`, `callUnsupported` (boolean, true when a call attempt fails because E2EE calling is unsupported; `callError` contains the explanation).

View state: `showAddMembers`, `showDeleteConfirm`, `showGroupSettings`, `showRenameGroup`, `newGroupName` and their setters; `renamingGroup`, `updatingInvitePolicy`, `deletingConversation`; `hasOlderCachedMessages`, `loadingOlderCachedMessages`; `showScrollToBottom`, `newMessagesBelowCount`, and `scrollToLatest`. Bind `messageListRef` to the scrolling viewport.

Actions: `handleLoadOlderCachedMessages()`, `handleMembersAdded()`, `handleUpdateInvitePolicy(policy)`, `handleRemoveMember(userId)`, `handleRenameGroup()`, `handleDeleteConversation()`, `handleAcceptRequest()`, `handleDeclineRequest()`, `handleTyping()`, `handleStartCall('audio' | 'video')`, `navigate`. Send actions/state are forwarded from `useSendMessage` below. `pendingConfirmation`, `notice`, `dismissNotice` follow the shared feedback contract.

The hook owns cached history, sync initialization, chat WebSocket subscription, acknowledgements, typing timeout and scrolling state. It closes its socket, cancels timers/animation frames, and ignores stale older-history scroll work on cleanup. Invite/rename/request failures are exposed as notices. Metadata loading/error feedback is rendered alongside cached history, so unavailable metadata never hides messages already on the device. Calling still requires browser E2EE support and a securely distributed call key.

## `chat/useSendMessage.ts` — `useSendMessage(conversation | undefined)`

Returns `handleSend(text, { ttlSeconds })`, `handleSendFile(file, { ttlSeconds })`, `outgoing` for this conversation, `retry(messageId)`, `discard(messageId)`, `sendError`. `ttlSeconds` is a number or null. It uses the auth store's current user/device. New messages appear immediately in the existing chat store with status `sending`; failed sends stay visible. Render each failed outbox entry's `error` with Retry/Discard actions. `sendError` also reports local storage/encryption failures.

File encryption and upload live here and in the queue controller. Upload PUT responses are checked before a file message can be sent. File keys stay in the existing local message-content convention and encrypted E2EE payload; upload APIs receive only encrypted bytes and existing routing/MIME metadata. During initial file encryption, the bubble displays `Encrypting file...`.

## `chat/useFileSave.ts` — `useFileSave()`

Returns `capabilities` from `platform/capabilities.ts`, `saveUnsupported` (boolean),
`saveError` (`SaveUnsupportedError | null`), and
`handleSave(blob, filename): Promise<"saved" | "cancelled" | undefined>`.
No router or query provider is required. `capabilities.saveFile` is true on web and native desktop, and on native iOS/Android
when the pre-JS `fileSave` capability is advertised. Hide or disable Save when `saveUnsupported` is true; it includes both
the capability flag and typed failures from the adapter.

`handleSave` delegates to the platform adapter. Unsupported saves become
`saveError`/`saveUnsupported` state and reject so callers can show a toast.
Other save failures also reject. Native cancellation resolves as `"cancelled"` without writing.
FilePreview uses this hook, disables its attachment save action when unsupported,
and keeps decrypted image/video object-URL previews
visible. Saving support does not gate loading or decrypting inline previews.
The platform adapter rejects unadvertised mobile saves before importing dialog/fs plugins;
advertised mobile saves invoke the scoped native command.

## `chat/useOutgoingQueue.ts` — `useOutgoingQueue()`

Returns all current user/device `outgoing` records and `retry(id)`/`discard(id)`. Mounting starts a reference-counted queue worker; cleanup removes its retry timer and online listener when the last consumer leaves. Layout and the call hook keep it alive throughout the authenticated UI, and `useSendMessage` also subscribes. W3 should preserve an authenticated lifecycle owner if replacing Layout. No worker runs before keys are unlocked.

Each record has identity/routing metadata, `queuedAt`, `status`, `attempts`, `retryable`, `nextAttemptAt`, `error`, and prepared encrypted request `steps`. Encrypted file bytes remain until the message receipt is accepted; `upload.uploaded` avoids repeating successful PUTs. `status` is `sending` or `failed`; successful entries leave the queue and become `sent` messages. Later entries wait behind pending or automatically retrying entries in their conversation. Terminal failures (`failed` and not `retryable`) stay visible with Retry/Discard. Direct-message failures never block later messages. A terminal group failure blocks only when its group-message ciphertext may have been submitted without a confirmed receipt; a distribution-only, upload, or preparation failure does not block. Retry of an unresolved group message keeps its position and identical ciphertext until the idempotent receipt arrives; Discard releases later messages. Other terminal retries move to the queue tail. If the message itself was definitely unsent, Retry encrypts it at the current chain position, retaining any possibly submitted distribution steps for identical replay. Waiting entries remain `sending`.

Retry policy: network errors, HTTP 429 and 5xx fail visibly and retry after 2s, 5s, 15s, then 60s (60s thereafter). `online` retries eligible failures immediately. Other 4xx retain their error without automatic retry; manual retry is available. Fanout and sender-key preparation preserve per-device failures in an AggregateError: automatic retry applies when every underlying failure is transient, while a permanent failure still requires manual action. Discard removes an unsent local entry and its display message, after any active attempt settles; it takes the same conversation Web Lock as retry and rereads the entry under that lock. Conditional IndexedDB updates prevent a late attempt from recreating a discarded entry even without Web Locks. Outbox writes carry a revision token; repairs and send attempts compare it in the write transaction so a stale snapshot cannot overwrite or delete another tab’s newer progress. Discard immediately drains eligible waiting messages, in order within each conversation and concurrently across conversations. Discard cannot unsend an accepted message.

Durability/security: IndexedDB stays at version **5**, with outbox records stored in `syncState` under the `outgoing:` prefix so rollback clients can still open it. Existing stores and indexes remain intact. Pre-release v6 data is copied from `outgoingQueue` on `VersionError`; v6 never shipped, and any open v6 tabs must be closed because they can still write the old store after that one-time copy. `saveQueuedMessage` atomically saves the outbox entry and existing `messages` display record, and assigns durable ordering in the same transaction. The outbox contains ciphertext/envelopes/encrypted upload bytes, never message plaintext, file keys or plaintext file bytes. Display content is saved only in the existing `messages.content` convention. Interrupted initial file encryption becomes a visible failure requiring reattachment; encrypted files already in the outbox survive reload. Cached-page reads join message IDs to the outbox in one read transaction and annotate each record with `hasOutgoingEntry`; history normalization keeps queued messages past their optimistic expiry. This annotation is recomputed on every read, so stale flags or failed messages without an outbox entry cannot bypass ordinary expiry.

If legacy cleanup removes a queued message’s display row, prepared retryable envelopes still send. Orphans that cannot be sent are retired atomically with their encrypted upload bytes, so they cannot block later sends. A dismissible localized notice appears only in the affected conversation.

Ratchet choice: `session-manager.encryptForDevice` persists the advanced Double Ratchet during encryption, so every network retry replays the **same message IDs, ciphertext, IVs and headers**. `prepareDirectPayloadFanout` separates encryption from POST without rewriting session handling. Sender-key distributions are also durable steps; retrying them does not encrypt a new distribution. The session also preserves the public X3DH initial header until an authenticated reply confirms the peer has the session, so discarding the first failed envelope cannot strand the ratchet. No session is rolled back or reset. Encryption is allowed again during preparation before any envelope was submitted, after an explicit file-reservation rejection before acceptance, or for a manually retried terminal failure known to precede any send request. Each step persists its own `sendDispatched` marker before its POST. The row's `sendDispatched` summarizes only its actual message ciphertext, excluding sender-key distributions. A distribution response-parse failure retains that distribution for identical replay but allows a fresh group-message envelope on terminal Retry. A group-message response-parse failure preserves that group envelope and blocks newer chain indices. Legacy steps without markers conservatively inherit the old row marker (or unknown/submitted when both are absent). Active retries persist `retryable: true` before clearing their error so reload can resume them; older non-retryable sending rows return to Failed even if their error is missing. Crypto preparation is serialized, while upload reservation/PUT and conversation metadata requests run outside that lock so a stalled upload cannot block another conversation. Pending conversation delivery stays ordered because Sender Keys do not retain skipped receive keys; known pre-send terminal retries use fresh encryption, while dispatched retries must preserve the server's original envelope. Web Locks serialize each conversation across tabs when available.

Both send endpoints now replay by stable ID and return original stored timestamps/expiry. The group endpoint batches its message and delivery writes atomically and repairs legacy partial rows on retry. Completion requires the send endpoint receipt; `/sync` history is not evidence of completed delivery bookkeeping. Responses retain the existing fields and 201 status. Idempotency currently lasts as long as the message row is retained; durable receipt tombstones after scheduled deletion require a separate schema migration.

Uploads use the API client's binary PUT path, including token refresh and session-change protection. A 404/410 or explicit unattached reservation rejection renews the upload URL and re-PUTs the retained ciphertext. If the rejected message referenced an old file ID, only that definitively unaccepted file envelope is prepared again with the new ID; completed sender-key distribution steps are retained. File keys and plaintext bytes never enter the outbox.

`uploadMimeType` selects upload metadata for every initial upload and reservation renewal: image/video types on the shared allow-list keep their normalized MIME type; all other types use `application/octet-stream`. A structured 400 validation error on `mimeType` retries once immediately as octet-stream within the same attempt, and retains that fallback for future renewals. Original file names/types remain in the encrypted message payload. Previews and downloads use that decrypted type; unsupported media decoding falls back to a file card. Deploy the updated API allow-list before the web bundle; the MIME fallback also tolerates the reverse order during rollout.

## `calls/useCall.ts` — `useCall()`

`CallProvider` is mounted above Routes in App and enabled only while unlocked. It owns one
`useCallSession(callId)` lifecycle for a call explicitly started or accepted in this tab. `localCallOwnership` is an in-memory
per-tab consent record, granted only by local Start/Accept and cleared on end/teardown.
Server notifications and hydration cannot grant ownership: acceptance elsewhere dismisses
the incoming modal without peer creation, capture, or signaling here. A stale call URL after reload shows the ended state
and never restarts capture.
`clearCall(callId)` only clears that call; cleanup for an old ID cannot alter a newer
pending or owned call. Lock/sign-out use `clearAllCalls()` to cancel all local work.
Outgoing Start reserves its own token before the initiate request, binds the server call
ID when available, and completes only if that token remains current. It does not depend
on the shared call epoch, so a retired call's delayed cleanup cannot cancel a redial.
If Start is cancelled after creating a server call, its cancellation watcher deletes that
call's pending key and sends `/api/calls/:id/end` immediately, even while fanout is still
pending. Cleanup is ID-scoped and does not touch a newer call. It is also run on failed
fanout; joining an existing call (`created: false`) never ends that pre-existing call.
Cancelled key writes are deleted again after they commit, so they cannot recreate the key.
`cleanupCallBestEffort` is shared with hangup: local key deletion runs independently of
network progress; transient end failures retry after 500ms and 1500ms (three attempts total),
rechecking user/device/session identity and authentication before every attempt.
If sign-out has removed the session, the client cannot authenticate an end request and
only deletes the local key. The server's existing 30-second ring timeout is the fallback
for an unaccepted call; that alarm does not cover a call that was already accepted.


`useCall()` now reads that provider's context; CallPage and CallBubble never acquire or dispose media.
Incoming ringing invitations retain the existing modal/accept flow. A reference-counted outgoing
queue consumer remains mounted throughout the unlocked app, including the full call screen.

State: `callType`, `localStream`, `remoteEntries`, `peerAvatarUrl`, `peerName`, `isGroupCall`, `conversationName`,
`stage`, `error`, `callUnsupported`, `callDuration`, `isMuted`, `isVideoOff`, `isSharingScreen`,
`canShareScreen`. Views bind streams through `useMediaElement`; the provider renders persistent
remote audio for both voice and video. Presentation identity uses the other member for direct
calls, or the conversation name/avatar (group initials when absent) for groups; caller metadata
stays separate for the incoming-call modal. Every remote video is muted to avoid duplicate audio.

Actions: `toggleMute()`, `handleToggleVideo()`, `toggleScreenShare()`, `handleEnd()`,
`minimizeCall()` (conversation route, falling back to store metadata during setup), `restoreCall()` (call route), `formatDuration(seconds)`.
Any route away from the call displays the bubble until the call ends. End from the bubble and
remote hangup keep the current route/draft and show a toast. The full route keeps its usual end state.

The lifecycle retains pending-key recovery, fail-closed E2EE capability/setup/signaling checks,
all acquired-track tracking, parked-camera/screen cleanup and late-capture cancellation.
Minimising changes no peer, sender, receiver, worker or timer. Hangup, terminal failure, session
teardown and provider unmount close signaling/peers, stop tracks and release the transform worker.
Call guards use a tab-local call epoch and the login identity (user/device/session), never
the persisted cross-tab auth epoch. Local key lock, sign-out and end invalidate the epoch
and stop media; locking/unlocking another tab of the same login leaves this call running.
Every async continuation and timer checks the call epoch and local ownership; stale work
uses only its captured peer/socket and cannot signal for, overwrite or tear down the next call.
Offer answering and TURN setup also check cancellation inside their awaited helpers.
No running call is persisted across reloads. `useCallBubblePosition` owns pointer capture, drag
threshold, clamping and edge snapping; geometry helpers are pure. It measures the visible
`data-call-message-area` and excludes `data-call-avoid="top|bottom|left|right"` controls.
TopBar, BottomBar, NavRail and MessageInput register these zones declaratively. ResizeObserver
reclamps when a composer grows; route mutations refresh registrations, and visualViewport
resize/scroll handles keyboards. Defaults are top-right on desktop/tablet and above the composer
on phones, within safe-area gutters.

## `calls/useMediaElement.ts` — `useMediaElement<T extends HTMLMediaElement>(stream, play?)`

Returns an element ref. Bind it to remote `<audio>` or `<video>`; it assigns `srcObject` and clears it on cleanup. The bubble opts into explicit `play()` on mount, stream changes, metadata and added tracks (including a video track arriving after audio). Playback attributes and styling remain the view's responsibility. It does not own/stop the supplied stream.

## `settings/useSettings.ts` — `useSettings()`

Settings is a view over the existing profile, preference, passkey, emoji, recovery and account actions. `section` / `selectedSection` read `?section=profile|appearance|security|emoji|account`; `closeSection` pops history for in-app detail links and replaces a direct link with `/settings`. Settings links carry `state.settingsBack`; the shared `useSettingsBack` hook supplies the same behavior to Devices (`goBack`). `SettingsFrame` supplies the settings menu, responsive shell and local toast provider; the three settings routes mount it once outside legacy Layout through the protected `SettingsLayout` route group in App.tsx. `SettingsLayout` retains outgoing-queue processing and the incoming-call layer without adding visual navigation. `SETTINGS_SECTIONS` is shared menu metadata.

Profile: `displayName`/setter, `profileChanged`, `savingProfile`, `handleSaveProfile()` (boolean result), `avatarSrc`, `handleAvatarChange(url)` (boolean result), `copyUsername()`. Appearance keeps `appearanceDraft`/setter and existing save/reset actions; `handleThemeChange(mode)` saves immediately. Preview values include readable foregrounds, measured `previewRatios`, `incomingEdgeWarning`, and `colorInputValue`. Custom colours remain local to the user/device.

Security retains `capabilities`, passkey query and registration actions. Hide the entire passkey section when `capabilities.passkeys` is false; queries, option preloading and WebAuthn are also guarded. `requestDeletePasskey(id, name)` / `requestDeleteEmoji(id, name)` open `confirmation`; `handleDeletePasskey` / `handleDeleteEmoji` execute only from ConfirmDialog and close it on success. Errors and busy state remain in the dialog. Emoji additions use `showAddEmoji`/setter and `closeAddEmoji()`; cancellation or dismissal clears the selected file to match the remounted native input; resolved emoji image URLs are exposed as `src`.

`handleLockNow()` locks keys, calls `bumpSessionState()` so App enters its locked auth phase and stops unlocked effects/maintenance, then routes to Unlock. If `handleForgetKeys()` fails after clearing in-memory keys, it also bumps the session state so App leaves the unlocked phase. `showForgetKeys` / `showDeleteAccount` and their setters control acknowledgement dialogs; `handleForgetKeys()` and `handleDeleteAccount()` execute after acknowledgement. Account deletion retains server password/DELETE validation. `handleLogout()` retains the existing root-menu one-click Sign Out contract and clears account state before logout/navigation; Account's Sign Out entry adds the spec confirmation.

Recovery enrollment is supported only before a key is set up: the API rejects replacement with HTTP 409. Settings hides creation after enrollment, and `handleEnrollRecoveryKey()` ignores calls while already enrolled. Recovery: `handleEnrollRecoveryKey()`, `enrollingRecovery`, `generatedRecoveryKey`, `hasRecoveryKey`, `recoveryError`. `copyRecoveryKey()` returns the platform `copyText` promise; `saveRecoveryKey()` uses `saveFile`, shown only when `canSaveRecoveryKey`. `dismissRecoveryKey` clears the secret after the shared non-dismissible `RecoveryKeyDialog` requires acknowledgement. Copy/save failures stay visible; success uses a toast and never includes the secret.

## `settings/useAvatarUpload.ts` — `useAvatarUpload(onChange)`

Returns `uploading`, `handleFileUpload(event)` and shared feedback state. Uploads are single-flight, HTTP failures become a notice, and unmount aborts PUT and prevents a late callback. `useAvatarPicker(value, onChange)` holds character search, generated choices, upload state and resolved URLs. AvatarPicker keeps its existing props API and consumes only features/UI; upload failures use a toast.

## `devices/useDevices.ts` — `useDevices()`

Returns current device ID, devices/loading, pending requests/loading, recovery status, and inline error/retry state. Devices include `activity`, absolute `activityTitle`, `icon`, and `linkedBy`; requests include `codeChunks`, `expired`, and `expiresLabel`. Requests poll every 1.5s.

`handleRemoveDevice(id)` opens `removalTarget` without a network mutation. `confirmRemoveDevice()` executes removal, returns success, closes on success and retains `removeError`/target on failure. `cancelRemoveDevice()` dismisses while idle; the current device cannot be removed here.

`handleApprove(request)` signs the existing public request fields. `handleReject(id)` rejects a pending approval. **`handleCancel(request)` cancels only approved, incomplete `approved_link` requests via POST `/api/device-links/:id/reject`.** Recovery requests are informational: all three handlers reject them locally. Expired/completed requests have no mutation action. These actions are single-flight and return a success boolean. `dismissRequest(id)` hides an expired card locally. Recovery reveal/copy/save follows the same contract as settings.

## `verify/useSafetyNumber.ts` — `useSafetyNumber()`

Loads the first active remote device and computes the safety number using existing crypto. Results are keyed to route/identity; stale async results are ignored. Existing `error`, `remoteUser`, `safetyNumber`, `navigate` remain. `groups` contains the five-digit groups, avatar URLs are resolved, `noIdentity` distinguishes unfinished setup, and `retry()` reloads lookups.

`toggleVerification()` stores/removes the current public safety number under an account/contact-scoped localStorage key and returns success; `verified`, `verificationChanged`, `verificationError` drive the view. A changed local or remote identity changes the computed number and requires re-verification. This marker is local to this browser and does not change crypto/session behavior. `copySafetyNumber()` uses `copyText`. Conversation badge integration can consume this same marker in W3a.

## `shared/useFeedback.ts` — `useFeedback()`

Returns `pendingConfirmation`, `notice`, `setNotice(message | null)`, `dismissNotice()`, `requestConfirmation(message, title?, confirmLabel?, destructive?) -> Promise<boolean>`.

`pendingConfirmation` is null or `{ title, message, confirmLabel, destructive, onConfirm, onCancel }`. Render the state and wire the callbacks; do not invoke the destructive operation separately. Cancelling, replacing a confirmation, or unmounting resolves false. Defaults are title/label `Confirm`, destructive true. `components/app/FlowFeedback` supplies the temporary minimal DaisyUI dialogs; W3 can replace its markup.

## Remaining coordination

- API/schema: add durable send receipt tombstones if idempotency must extend beyond scheduled message deletion (`apps/api/src/lib/cleanup.ts`). This round fixes replay while a message row exists; migrations and cleanup changes remain outside ownership.
- W3: Layout currently renders desktop and mobile Outlets simultaneously and hides one through CSS. Preserve the current markup for this workstream, but use a single live route surface in the rebuilt shell to avoid duplicate page/controller mounts.
- Signaling reconnection after a WebSocket closes remains existing behavior in `calls/useCall.ts` and `services/ws.ts`; message sync still supplies chat catch-up. Full reconnect/re-negotiation is separate from this extraction.

## W3a view adapters

The shell and chat/call views import data and actions through features. `chat/useAppPhase`
contains the unchanged auth-phase evaluation and key-maintenance lifecycle used by App;
route paths and guard decisions stay in App. `chat/useShell` exposes the current user,
unread total for current conversations and online state, and subscribes to browser online/offline events. Layout
keeps `useOutgoingQueue` mounted once and renders one route surface in `AppShell`.

`chat/useFilePreview(options)` owns fetched attachment decryption in memory,
retry, expiry, object-URL and platform-save states. It exposes `loading`, `expired`,
`error`, `objectUrl`, `isImage`, `isVideo`, `saveUnsupported`, `load` and `handleDownload`.
Decrypted bytes are never written to the attachment cache. Blob URLs are revoked
on replacement/unmount; stale asynchronous loads cannot create URLs. The inline
preview and viewer share one URL.
`chat/useMediaGestures` owns pointer tracking, zoom/pan, tap timing and phone swipe
dismissal; `chat/media-gestures` contains pure geometry and tap classification.
File keys remain in the encrypted channel; the API never receives a file key.
`chat/useEmojiText`, `chat/avatar` and `chat/presentation` expose resolved emoji/avatar
URLs, text segments and date/expiry/preview labels for presentational components.

`chat/useComposer(options)` owns text, emoji insertion and selected timer. File picking
or dropping inside a conversation stages one attachment with the account's saved
compression setting. The sender can override it for that attachment. Send compresses
locally when selected and forwards the resulting file and timer to the existing
`onSendFile` queue action. Escape or Remove attachment clears the staged file.
Enter sends on fine pointers; touch keyboards, Shift+Enter and IME composition keep
Enter as text input. The textarea grows to six lines. MessageInput keeps the existing
`Type a message...` placeholder and Send accessible name. Attach opens a Sheet with
Choose file and the per-message timer. The timer remains per-message, not a new
server-side conversation setting. The conversation subtitle reflects the latest timed
message's duration; individual messages expose their existing expiry countdown.

`chat/useUserPicker` preserves contact search, self/exclusion filtering and selection;
`chat/useAddMembers` preserves the add-members endpoint and errors.
`chat/useConversationMutations(conversationId, onDeleted)` uses the existing remove-member
and delete/leave endpoints with busy/error state retained inside ConfirmDialog until
success or cancellation. Other conversation behavior remains in `useConversation`.
The message Retry/Discard callbacks still come directly from `useConversation`'s outgoing
queue. Queue display updates read the committed message record so delayed receipts cannot
restore content that another device or tab deleted. Its automatic retry policy is unchanged. `chat/message-actions` exposes platform
clipboard copying without data-layer imports in the bubble. Failed-bubble Retry names
include the message text or attachment filename, keeping failed messages distinguishable
to screen readers without exposing file keys.

`CallProvider` also owns `useCallInvitationOwner`: its Accept/Decline requests, completion,
loading state and errors survive modal remounts and route changes. The modal only triggers
the action and reads that state. Only a real end, local lock/sign-out or changed login cancels
a pending response; successful Accept grants this tab ownership and opens the call route.
`calls/useIncomingCall()` exposes the current invitation, `visible`, `loadingAction`,
`error`, `callUnsupported` and `respond('accept' | 'decline')`. Accept requires the existing
secure invitation key and encrypted-media capability. Failed responses remain visible.
CallControls is presentational and receives the existing `useCall` actions as props.
CallPage disables its camera toggle until `localStream` exists; mute remains available
before capture so the existing mute-intent handling continues to work.
The call layer uses the scoped `DarkSurface` primitive; it never changes the app's theme
or the native titlebar attributes. Contact verification currently has no saved verified
state in the feature contract, so conversation details show Not verified and link to the
existing Verify route.

`calls/useCallPresentation(video, connected)` holds only the local-preview corner and
phone video-control visibility. After four seconds of inactivity on a coarse-pointer
phone, the controls fade; pointer/keyboard input shows them again. The preview snaps
to the release corner on drag, with Move camera preview as the keyboard alternative.
No media routing, key setup or call lifecycle logic lives in that adapter.

Known limitation (accepted): orphan retirement doesn't see file preparation in *another* new-version tab. If a legacy v5 tab expires a queued file's display row while a second new tab is still encrypting that file, a third new tab may retire the entry. The user must re-attach the file. Nothing leaks, and other sends aren't blocked. This only happens while legacy tabs from before the deploy are still open.

## Android background calls and notifications

`settings/useBackgroundSettings` exposes the per-device, account-scoped background
opt-in, pending/error state, system status and settings actions. The Notifications
menu and view require `capabilities.backgroundConnection`; all eight copy keys use
`androidBackground.*` in the normal 12 locale bundles.

`calls/useNativeCallNotifications` runs once in CallProvider when enabled and
`capabilities.nativeCallNotifications` is available. It posts hidden incoming calls,
cancels exact IDs on replacement/end/acceptance elsewhere, and drains native action
batches at startup, visibility, focus and the payload-free window wake event.
Deferred Accept waits for the secure invite and visible session, checks server
ringing status/expiry, then calls the same invitation owner's local Accept path.
A deferred Accept blocks later navigation in FIFO order; a later Decline of the
same call replaces it at that queue position. Native Accept records pending local
consent with the call ID and tab-local epoch before its POST, and completes
ownership even if the accepted event or backgrounding arrives first. Initial media
capture waits for visibility; a hidden wait past the server ring deadline ends the
call through shared cleanup. Legacy sessions use the API identity fallback (device
ID, then authEpoch) when sessionId is null. The
provider keeps shared incoming controls on the native call route while accepting
or displaying a response failure. UnlockedAppEffects owns the service session and
retains the shared presence socket; key lock/account cleanup invalidate both
native lifecycles before asynchronous continuations can act.

## `updates/useUpdates.ts` — native app-wide updates

Mounted once by `UpdateProvider` beneath CallProvider, independent of auth/unlock.
The `/clients` route is outside this provider; in-app navigation tears down its
timer/listener and ignores pending check results. The non-mandatory `UpdateBanner`
shares ChatListPage’s column visibility: immediately below the phone list header
and at the desktop sidebar bottom, including while a conversation is open. On a
phone the whole list column, including its banner, hides when detail is open. It
never enters the conversation pane, settings, About or calls. Available updates
show one ellipsized size/network line; only Android without a known-unmetered
connection gets the metered hint. Banner actions are right-aligned. About uses full-size actions and the
shared Disclosure for release notes; the provider still owns the mandatory dialog.
Capability-gated startup and six-hour checks drive idle/checking/available/
downloading/ready/error state. Native download resolution means verified; progress
listeners and timers are cleaned up on teardown. Android auto-download requires a
known unmetered connection, otherwise Download is an explicit action. The channel
is stored per device as `private-base:update-channel`, independent of account data;
it is locked while preparing or holding a verified update because native retains
one candidate. Requested installation waits for CallProvider/live call state, and
Later cancels that request. Mandatory update dismissal signs out; About retains
status, retry, channel, current native version and release notes. See
[releasing.md](../../../../docs/releasing.md) for native prerequisites and acceptance.

## `clients/useClientsPage.ts` — `useClientsPage()`

Logic for the public download page `/clients` (`pages/ClientsPage.tsx` is a pure view). It needs no router, query client or session; it only needs a `ToastProvider` above it.

- Platform detection (`clients/platform.ts`) runs once on mount: `?platform=macos|windows|android|ios`, then Android, iOS (including iPadOS desktop mode: `MacIntel` with more than one touch point), Windows, macOS, else `other`. `featured` is the detected platform, or `"web"` for `other`; `others` is every remaining platform in the fixed order macOS, Windows, Android, iPhone and iPad, never repeating the featured one.
- The manifest (`clients/manifest.ts`) is `https://dist.718788.xyz/private-base/releases/latest.json`, fetched with `cache: "no-store"`, `credentials: "omit"`, no referrer and an 8 s timeout. Validation rejects the whole manifest for any malformed entry or any download URL whose origin is not exactly `https://dist.718788.xyz`; `null`/missing platforms are "Coming soon".
- `status` is `loading`, `ready` or `error`; `retry()` refetches while the error stays shown with `retrying` true. `cards[platform]` holds formatted values (decimal MB, processor label key or raw value, `{{minOs}}`, checksum groups, verify command). `footer` holds the version and the long publish date.
- `copyChecksum(platform)` uses the platform clipboard adapter and shows a success or failure toast. `onDownloadClick` hands download links to the system browser in the native shells.
- `main.tsx` mounts `ClientsApp` (page + toasts only) for a direct visit to `/clients`, so no auth phase, key, sync, push or call effects start. `App.tsx` also routes `/clients` without a guard for in-app navigation.


## Message actions

`chat/useMessageActions(message)` owns menu position, touch long-press timing (500 ms,
8 px movement tolerance), scroll cancellation, click suppression, and delete busy/error
state. `triggers` bind only to the bubble surface; `openFromButton` binds the accessible
More button. While the menu is mounted, document capture consumes the opening touch's
release and compatibility mouse/contextmenu events across the Sheet portal. The guard
lasts through the hold and 400 ms after release; a fresh pointer/touch/keyboard action
clears it so intentional menu actions and dismissal still work. Sent-message
`requestDeleteForMe` hides durably via `hideMessageWithUndo` and offers a five-second
Undo toast. The hidden record/file cache survive until commit; history and sync never
re-publish them. Undo restores the record unless a deletion arrived, in which case it
restores only the tombstone. The hidden marker stores the Undo deadline; a new DB
connection commits expired entries and schedules active ones for their remaining time,
preserving another tab’s Undo window. An unlocked sweep runs every 30 seconds and
on visibility return, lock and sign-out teardown, retrying failed deadline writes.
The owning tab commits at that same deadline; hidden markers prevent reload/sync
from resurrecting content throughout. Queued/failed messages confirm before
`deleteForMe` discards pending outbox work; `deleteForEveryone` calls DELETE `/api/messages/:id` after the view's ConfirmDialog. File deletions include
the opaque `fileId` query parameter to disambiguate older rows without a stored file reference;
no filename, plaintext, or file key enters this request.
The presentational `ui/ActionMenu` handles desktop pointer placement and keyboard
navigation, or the existing bottom Sheet on phones. Failed messages retain one-tap
Retry and also offer Retry/Discard inside the common menu.

Accepted senders can select Edit message on live text sent with an edit key from
the current device. The composer
keeps the unsent draft and timer while editing, and saves a versioned text operation
through the existing v5 outbox. The pending edit appears in the bubble and chat
preview. An edit receipt replaces the committed text and clears the pending change
atomically. Plaintext lives in the v5 message record. A side record in `syncState`
keeps the AES-GCM-wrapped edit key, sequence and latest encrypted revision through
legacy-tab writes. Only the password-derived local key can unwrap it.
The outbox can recover pending text after a legacy rewrite. Temporary hide blocks
publication while edits can continue to apply. Undo restores the current text and
any pending edit. Permanent hide, deletion and expiry clear the side record, with
cache cleanup reconciling removals by legacy tabs. The menu keeps delete available
during an outstanding edit. Delete for me leaves a retryable signed edit in the
outbox for delivery until the original expires or is deleted for everyone.

`message-sync` handles deletion events and sync tombstones before decryption/dedupe.
A separate `mutationSince` / `mutationSeq` cursor consumes commit-ordered deletion
log pages, even when the message page is empty. It persists under
`message-mutations:<account>:<device>` after application; conversation backfills
never advance this global cursor. Legacy sync omits the mutation stream and preserves
original server-timestamp/id ordering. Edit-aware sync sends `edits=1` and `editSince` and advances the
`message-mutations-edits:<account>:<device>` key only on an edit-aware server response. Live and offline
edits authenticate the original logical message ID, conversation, sender, device
and edit sequence. The original send delivers the edit key under its ordinary
encryption. Recipients use that key and the original device signature to apply
revisions without changing any receive chain. The client ignores edit hints for
missing originals. When an original arrives with a newer `latestEditSeq`, it
pulls the latest revision by logical message ID. Opening a conversation and
membership notifications reconcile cached originals in bounded batches. Edits
received during lock are queued as ciphertext and retried after unlock.
The highest authenticated edit sequence wins. Hidden or deleted originals suppress
edits.
Guarded cached history merges into the current store. Tombstones and higher
edit sequences take precedence, and other conflicts prefer local/live entries.
Durable hidden/deleted markers prevent delayed ACKs, frames and persistence
from restoring content. Deletion clears legacy decrypted `fileCache` entries and local
file keys; unmount clears active preview blobs/URLs. Conversation previews derive from
the updated store. `useFilePreview` exposes `handleOpen`/`handleDownload`, plus action
errors for toasts. FilePreview shares those actions with the message menu through its
ref, and keeps images/video in the existing viewer. PDFs on web reserve a tab synchronously on every tap, including cached opens, and
navigate it to a forced-`application/pdf` blob with no opener. A blocked reservation
shows the existing localized file-open error instead of silently accepting null.
Text/Markdown/CSV use `textPreview` / `closeTextPreview` and render a literal `<pre>`
text node in Dialog with Copy text and Save/Share footer actions; advertised and
actual sizes above 2 MiB offer Save. Save closes the text dialog and returns focus
to the attachment row before preparing the file. Preparation errors show inline
with Retry. Blocked types omit Open and show a five-second warning toast on a row
tap with an explicit Save/Share action. Desktop saves from Save or legacy Open
show a localized “Saved” confirmation with the attachment name.
Saves started while the session profile is missing show a name-free confirmation.
Android Downloads mode uses native confirmation, and iOS Share mode uses the share
sheet. Failed saves still show a localized error. An unlocked-session store receives
results even after the preview unmounts. The topmost overlay by
visual layer controls feedback. The most recent registration wins ties within
the same layer. A media viewer shows the notice below its toolbar.
Dialogs, sheets and incoming-call prompts hold the queue and pause its timers.
An empty stack uses the global toast. Each result is announced once when its
notice mounts.
Success expires after four seconds and errors after eight seconds, with dismissal
available on either surface. Lock and session changes clear notices and suppress
pending results. Cancellations are silent. Web downloads use browser feedback.
Preview and tab routing use an explicit MIME allow-list; SVG/HTML/XML/JavaScript and
unknown types are download-only. Direct fanout tombstones resolve to the existing
logical display row, while unknown local echoes remain ignored. Retry atomically
persists the Sending display status with the outbox before reading the display back.


Deleted send receipts complete the outbox while persisting a blank tombstone, clearing
legacy decrypted attachment caches and unblocking later Sender Key messages. File
preparation participates in a cancellation registry; both its success and error paths
check cancellation plus durable hidden/deleted markers before publishing. Initial
outbox writes also respect those markers. Native file IPC uses the binary v2 contract
in platform/README.md. A blocked Open displays localized safety feedback with an
explicit Save action; no automatic saving occurs.


`startLocalHiddenMessageSync` connects `local-message-changes` while unlocked. DB
hide/commit/Undo writes publish opaque IDs only, scoped to account + device, over
BroadcastChannel plus a storage-event fallback. Peers re-read shared IndexedDB via
`reconcileLocalMessageChange`; hidden/missing records leave the store, unmounting
FilePreview and revoking its object URLs, while Undo restores the durable record.
Teardown closes transports and session-guards pending reads.


Conversation opening always merges the latest cached page, including when startup
mutation sync has already populated the store with tombstones. Deletion markers,
first record redaction and decrypted-file cache eviction share one IDB transaction;
guarded receives/outbox writes evict attachment references before redacting too.
Mutation pages return a safe `mutationCursor` high-water checkpoint: it is persisted
per account/device after applying the page, even when all scanned rows were filtered
out. Partial pages never advance past their last returned mutation.

History pages read messages, queue annotations and all hidden/deleted barriers in a
single IndexedDB snapshot. Local writes and scoped cross-tab hints bump a conversation
hide generation synchronously; an invalidated snapshot is retried before publication.
Older peers without a conversation ID conservatively invalidate all pending pages.
The contiguous cache window keeps its own timestamp/id cursor, reset with the sync
session; injected mutation/live entries never move it. Older loads use that cursor,
including across equal timestamps, rather than the oldest entry in the display store.


Tombstone family resolution requires matching sender + conversation; unverified
roots are never materialized. Exact-ID deletion guards reject mismatched owners too.
`message-action-session` captures primitive user/device/session IDs for delete/hide/
Undo continuations. IDB mutations can receive that current-session guard and roll
back stale continuations. Five-second Undo toast subscriptions survive bubble removal
but clear on identity change or unlocked-session teardown.

## History transfer integration

`HistoryTransferOwner` mounts in the unlocked branch of `App.tsx` beside
`UnlockedAppEffects`, above the route outlets. Linked devices opens
`/devices/transfer` and its sender and receiver modes. The passkey setup
offer can link to `/setup/history-transfer` after activation and unlock.
The screens and shell banner share the tab-local `useHistoryTransfer` controller.

`continueInBackground()` leaves an active or paused transfer running.
`stop()` cancels it, and `resume()` retries the open transfer after a drop.
When `requiresPairing` is true, the screens start a new pairing. The durable
receiver checkpoint preselects unfinished chats after both devices compare
the fresh code. `canFinalize` allows an empty manifest to acknowledge an
entirely copied checkpoint. Prepared archives are invalidated by selected-chat
removals and committed text edits, and a durable revision check covers delayed
cross-tab hints.

The catalog estimates local bytes before preparation. Receiver free space and
mobile-data status travel as encrypted peer metadata. The sender measures the
link with an encrypted 2 MiB probe, and the progress deadline advances only as
data records are received or acknowledged. A stall drops the idle-lock hold.
Pre-upgrade rows are eligible when the server verifies the exact envelope was
sent by or addressed to this active device. Unverifiable message counts appear
in the picker before sending.

A transfer includes the latest committed decrypted text and its edited marker.
Pending edits, edit keys, and signed edit envelopes stay on the source device.
An imported message can show the edited text immediately. Editing it or
decrypting later revisions requires an edit key the receiving device obtained
independently through the original send. Authorship still belongs to the
original sending device. Stickers use the same canonical rows and transfer as
encrypted message content.

The fenced IndexedDB v7 upgrade keeps wrapped keys and pending edit ciphertext
from main's v5 layout. Edit keys for quarantined rows become available only
after verified legacy promotion. The upgrade retains edit cursors and repair
jobs and rebuilds the edit outbox's account-scoped indexes.

QR dependencies are pinned in the web manifest. The web camera path uses
`BarcodeDetector` when available and uses `jsqr` as its fallback. The app can
always enter the eight English words on the sending device.

## Sticker packs

The chat-scoped sticker provider shares picker preferences, favourites, recents, and a timer-aware composer send callback with the picker, pack sheet, and message actions. The storage module writes per-account and device `accountState` transactions and keeps the local favourite mutation separate from any future encrypted sync. The strict token parser and synchronous `isSticker` helper also work before the lazy catalog loads. See [the sticker runtime documentation](../../../../docs/stickers.md).
