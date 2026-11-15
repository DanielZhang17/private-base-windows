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

Actions: `handleSubmit(event)`, `handlePasskeyLogin()`, `prefetchPasskeyOptions(username)`, `signInAsOwner()`, `forgetLocalKeys()`, `cancelLink()`. `handleSubmit` prevents default and coalesces simultaneous submissions. Hide passkey actions when `capabilities.passkeys` is false; prefetch then does nothing and login reports the unsupported error without requesting options or invoking WebAuthn, even with cached options. Passkey sign-in leaves local keys locked, as before.

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
`saveError` (`SaveUnsupportedError | null`), and `handleSave(blob, filename): Promise<void>`.
No router or query provider is required. `capabilities.saveFile` is true on web
and native desktop, and false on native iOS/Android until native share-sheet saving
is available. Hide or disable Save when `saveUnsupported` is true; it includes both
the capability flag and typed failures from the adapter.

`handleSave` delegates to the platform adapter. Unsupported saves become
`saveError`/`saveUnsupported` state; other save failures reject for the caller's
existing error handling. Desktop dialog cancellation resolves without writing.
FilePreview uses this hook, disables its attachment save action when unsupported,
and keeps decrypted image/video object-URL previews
visible. Saving support does not gate loading or decrypting inline previews.
The platform adapter rejects mobile saves before importing dialog/fs plugins.

## `chat/useOutgoingQueue.ts` — `useOutgoingQueue()`

Returns all current user/device `outgoing` records and `retry(id)`/`discard(id)`. Mounting starts a reference-counted queue worker; cleanup removes its retry timer and online listener when the last consumer leaves. Layout and the call hook keep it alive throughout the authenticated UI, and `useSendMessage` also subscribes. W3 should preserve an authenticated lifecycle owner if replacing Layout. No worker runs before keys are unlocked.

Each record has identity/routing metadata, `queuedAt`, `status`, `attempts`, `retryable`, `nextAttemptAt`, `error`, and prepared encrypted request `steps`. Encrypted file bytes remain until the message receipt is accepted; `upload.uploaded` avoids repeating successful PUTs. `status` is `sending` or `failed`; successful entries leave the queue and become `sent` messages. Later entries wait behind the first pending entry in their conversation, including a permanent failure until it is retried or discarded. Waiting entries remain `sending`.

Retry policy: network errors, HTTP 429 and 5xx fail visibly and retry after 2s, 5s, 15s, then 60s (60s thereafter). `online` retries eligible failures immediately. Other 4xx retain their error without automatic retry; manual retry is available. Fanout and sender-key preparation preserve per-device failures in an AggregateError: automatic retry applies when every underlying failure is transient, while a permanent failure still requires manual action. Discard removes an unsent local entry and its display message, after any active attempt settles; it takes the same conversation Web Lock as retry and rereads the entry under that lock. Conditional IndexedDB updates prevent a late attempt from recreating a discarded entry even without Web Locks. Outbox writes carry a revision token; repairs and send attempts compare it in the write transaction so a stale snapshot cannot overwrite or delete another tab’s newer progress. Discard cannot unsend an accepted message.

Durability/security: IndexedDB stays at version **5**, with outbox records stored in `syncState` under the `outgoing:` prefix so rollback clients can still open it. Existing stores and indexes remain intact. Pre-release v6 data is copied from `outgoingQueue` on `VersionError`; v6 never shipped, and any open v6 tabs must be closed because they can still write the old store after that one-time copy. `saveQueuedMessage` atomically saves the outbox entry and existing `messages` display record, and assigns durable ordering in the same transaction. The outbox contains ciphertext/envelopes/encrypted upload bytes, never message plaintext, file keys or plaintext file bytes. Display content is saved only in the existing `messages.content` convention. Interrupted initial file encryption becomes a visible failure requiring reattachment; encrypted files already in the outbox survive reload. Cached-page reads join message IDs to the outbox in one read transaction and annotate each record with `hasOutgoingEntry`; history normalization keeps queued messages past their optimistic expiry. This annotation is recomputed on every read, so stale flags or failed messages without an outbox entry cannot bypass ordinary expiry.

If legacy cleanup removes a queued message’s display row, prepared retryable envelopes still send. Orphans that cannot be sent are retired atomically with their encrypted upload bytes, so they cannot block later sends. A dismissible localized notice appears only in the affected conversation.

Ratchet choice: `session-manager.encryptForDevice` persists the advanced Double Ratchet during encryption, so every network retry replays the **same message IDs, ciphertext, IVs and headers**. `prepareDirectPayloadFanout` separates encryption from POST without rewriting session handling. Sender-key distributions are also durable steps; retrying them does not encrypt a new distribution. The session also preserves the public X3DH initial header until an authenticated reply confirms the peer has the session, so discarding the first failed envelope cannot strand the ratchet. No session is rolled back or reset. Encryption is allowed again during preparation before any envelope was submitted, or after an explicit file-reservation rejection before acceptance. Crypto preparation is serialized, while upload reservation/PUT and conversation metadata requests run outside that lock so a stalled upload cannot block another conversation. Conversation delivery stays ordered because Sender Keys do not retain skipped receive keys. Web Locks serialize each conversation across tabs when available.

Both send endpoints now replay by stable ID and return original stored timestamps/expiry. The group endpoint batches its message and delivery writes atomically and repairs legacy partial rows on retry. Completion requires the send endpoint receipt; `/sync` history is not evidence of completed delivery bookkeeping. Responses retain the existing fields and 201 status. Idempotency currently lasts as long as the message row is retained; durable receipt tombstones after scheduled deletion require a separate schema migration.

Uploads use the API client's binary PUT path, including token refresh and session-change protection. A 404/410 or explicit unattached reservation rejection renews the upload URL and re-PUTs the retained ciphertext. If the rejected message referenced an old file ID, only that definitively unaccepted file envelope is prepared again with the new ID; completed sender-key distribution steps are retained. File keys and plaintext bytes never enter the outbox.

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
queue. Its automatic retry policy is unchanged. `chat/message-actions` exposes platform
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
