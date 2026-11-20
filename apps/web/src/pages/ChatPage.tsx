import { t, useLocale } from "../i18n/index.js";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useConversationMutations, type ConversationExit } from "../features/chat/useConversationMutations.js";
import { useConversation } from "../features/chat/useConversation.js";
import { useGroupModeration } from "../features/chat/useGroupModeration.js";
import { useMessageSelection } from "../features/chat/useMessageSelection.js";
import { useClearHistory } from "../features/chat/useClearHistory.js";
import { GroupJoinRequests } from "../features/chat/GroupJoinRequests.js";
import { canEditMessage, messageRun, timedDuration } from "../features/chat/presentation.js";
import { Badge, Button, ConfirmDialog, CountBadge, Dialog, EmptyState, Field, Icon, IconButton, Input, LiveAnnouncement, Notice, Sheet, Spinner, TopBar, useToast } from "../ui/index.js";
import { getTopOverlay } from "../ui/overlay-stack.js";
import MessageBubble from "../components/chat/MessageBubble.js";
import MessageInput from "../components/chat/MessageInput.js";
import { GroupMemberList } from "../components/chat/GroupMemberList.js";
import UserAvatar from "../components/avatar/UserAvatar.js";
import AddMembersModal from "../components/user-picker/AddMembersModal.js";
import { ConversationTransferMarkers, TRANSFER_RECEIVE_PATH } from "../features/transfer/HistoryTransferScreens.js";
import { StickerProvider } from "../features/stickers/useStickerPicker.js";
import { DateDivider } from "../components/chat/DateDivider.js";
import { capabilities } from "../platform/capabilities.js";
import { useGroupCallBanner } from "../features/calls/useGroupCall.js";
import { groupCallActions } from "../features/calls/group-call-store.js";
import { groupCallErrorTranslation } from "../features/calls/group-call-messages.js";
import { GroupCallBanner, GroupCallTimelineLines, GroupCallTopBarActions, RingMembersDialog } from "../components/calls/group/GroupCallEntry.js";
import type { CallType } from "../features/calls/group-call-view.js";

export default function ChatPage() {
  const { locale } = useLocale();
  const flow = useConversation();
  const paneRef = useRef<HTMLDivElement>(null);
  const [phone, setPhone] = useState(() => window.matchMedia?.("(max-width: 639px)").matches ?? false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [exit, setExit] = useState<{ conversationId: string | undefined; action: ConversationExit }>();
  const [edit, setEdit] = useState<{ id: string; content: string; baseSequence: number }>();
  const mutations = useConversationMutations(flow.conversationId, () => {
    setExit(undefined);
    flow.navigate("/");
  });
  const moderation = useGroupModeration(flow.conversation, flow.user?.id);
  const toast = useToast();
  const group = flow.conversation?.type === "group";
  const groupCallBanner = useGroupCallBanner(group ? flow.conversation : null);
  const [ringType, setRingType] = useState<CallType | null>(null);
  const joinGroupCall = async () => {
    const room = groupCallBanner.room;
    if (!room || !flow.conversationId) return;
    const result = await groupCallActions.join(flow.conversationId, room.id);
    if (!result.ok) toast.show({ tone: "danger", message: t(groupCallErrorTranslation[result.code]) });
  };
  const activeExit = exit?.conversationId === flow.conversationId ? exit?.action : undefined;
  const deletingGroup = activeExit === "deleteGroup";
  const timedOut = moderation.remainingSeconds > 0;
  const timeoutClock = timedOut
    ? `${new Intl.NumberFormat(locale).format(Math.floor(moderation.remainingSeconds / 60))}:${new Intl.NumberFormat(locale, { minimumIntegerDigits: 2 }).format(moderation.remainingSeconds % 60)}`
    : "";
  const failed = flow.outgoing.filter((row) => row.status === "failed" && !row.editTargetId);
  const failedEdits = flow.outgoing.filter((row) => row.status === "failed" && row.editTargetId);
  const accepted = flow.conversation?.members.some((member) => member.userId === flow.user?.id && member.acceptedAt != null);
  const canEdit = accepted && !timedOut;
  const outgoingIds = useMemo(() => new Set(flow.outgoing.filter((row) => !row.editTargetId).map((row) => row.id)), [flow.outgoing]);
  const selection = useMessageSelection({
    conversationId: flow.conversationId, userId: flow.user?.id, accepted: !!accepted, messages: flow.conversationMessages, outgoingIds,
    senderName: (id) => flow.conversation?.members.find((member) => member.userId === id)?.user.displayName
      ?? (id === flow.user?.id ? t("selfDisplayName") : t("contactDisplayNameFallback")),
  });
  const clear = useClearHistory(flow.conversationId, !group, flow.conversationMessages, () => {
    selection.cancel();
    setEdit(undefined);
  });
  const messages = useMemo(() => clear.suppressed
    ? flow.conversationMessages.filter(({ id }) => !clear.suppressed?.has(id)) : flow.conversationMessages, [clear.suppressed, flow.conversationMessages]);
  const canClearForEveryone = !!accepted && (!group || flow.isGroupAdmin);
  const clearTitle = clear.action === "everyone" ? "clearHistoryForEveryone" : "clearHistoryForMe";
  const selectionReason = useId();
  const selectionOrigin = useRef<{ conversationId: string; index: number; ids: string[] }>(undefined);
  const deleteDialogOpen = !!selection.confirmation || selection.skippedCount !== undefined;
  const currentEditMessage = canEdit && edit ? flow.conversationMessages.find((message) => message.id === edit.id
    && canEditMessage({ ...message, pendingEdit: null }, flow.user?.id, flow.deviceId)) : undefined;
  const editing = currentEditMessage ? edit : undefined;
  const editConflict = !!editing && (currentEditMessage?.editSequence ?? 0) !== editing.baseSequence;
  const timer = timedDuration(flow.conversationMessages);
  useEffect(() => {
    setEdit(undefined);
  }, [flow.conversationId]);
  useEffect(() => {
    if (getTopOverlay()) return;
    const wide = window.matchMedia?.("(min-width: 640px)").matches;
    const target = paneRef.current?.querySelector<HTMLElement>(wide ? "textarea" : "header button");
    target?.focus({ preventScroll: true });
  }, [flow.conversationId, flow.conversation?.id]);
  useEffect(() => {
    if (edit && !editing) setEdit(undefined);
  }, [edit, editing]);
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 639px)");
    const resize = () => { if (query) setPhone(query.matches); };
    query?.addEventListener("change", resize);
    return () => query?.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    const origin = selectionOrigin.current;
    if (!origin) return;
    if (origin.conversationId !== flow.conversationId) {
      selectionOrigin.current = undefined;
      return;
    }
    if (selection.active || deleteDialogOpen || getTopOverlay()) return;
    selectionOrigin.current = undefined;
    const focused = document.activeElement;
    if (focused?.isConnected && focused !== document.body && focused !== document.documentElement) return;
    const log = paneRef.current?.querySelector<HTMLElement>('[role="log"]');
    const rows = new Map(Array.from(log?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [], (row) => [row.dataset.messageId, row]));
    const nearest = origin.ids.reduce((closest, id, index) => rows.has(id)
      && (closest < 0 || Math.abs(index - origin.index) < Math.abs(closest - origin.index)) ? index : closest, -1);
    const target = rows.get(origin.ids[nearest])?.querySelector<HTMLElement>(".message-more");
    (target ?? log)?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
  }, [selection.active, deleteDialogOpen, flow.conversationId]);
  useEffect(() => { document.title = t("privateBase", { conversationName: flow.conversationName }); }, [flow.conversationName, locale]);
  useEffect(() => {
    if (flow.noticeMessage) { toast.show({ tone: "danger", message: flow.noticeMessage }); flow.dismissNotice(); }
  }, [flow.noticeMessage, flow.dismissNotice, toast]);

  async function discardOne(id: string) {
    try {
      if (await flow.discard(id) === "already-sending") toast.show({ tone: "warning", message: t("messageAlreadySending") });
    } catch { toast.show({ tone: "danger", message: t("messageDeleteFailed") }); }
  }

  const count = selection.ids.size;
  const copiedText = selection.copied && t("messageSelectionCopied", { count: selection.copied.count });
  const unavailable = selection.unavailable;
  const everyone = selection.confirmation === "everyone";
  const { skippedCount } = selection;
  const partial = skippedCount !== undefined;
  const confirmationCount = selection.confirmationCount;
  const deleteDescription = partial ? t("messageSelectionDeleteSkipped", { count: skippedCount })
    : everyone ? t("messageSelectionDeleteEveryoneDescription", { count: confirmationCount })
    : !selection.queuedCount ? t("messageSelectionDeleteLocalDescription", { count: confirmationCount })
    : t(selection.queuedCount === confirmationCount ? "messageSelectionDeleteQueuedDescription" : "messageSelectionDeleteMixedDescription");
  const dialogReason = `${selectionReason}-dialog`;
  const scopeLabel = `${selectionReason}-scope`;
  const scopeGroup = (id: string) => unavailable ? { tabIndex: 0, "aria-describedby": id } : {};
  const reason = (id: string) => unavailable && <p id={id} className="px-2 text-xs text-ink-muted">{t(unavailable)}</p>;
  const everyoneLabel = <><span>{t("deleteForEveryone")}</span>
    {unavailable && <span className="ms-2 text-xs font-normal" aria-hidden="true">{t("messageSelectionUnavailable")}</span>}</>;
  const closeDetails = () => { setDetailsOpen(false); flow.setShowGroupSettings(false); };
  const requestExit = (action: ConversationExit) => {
    closeDetails();
    mutations.clearDeleteError();
    setExit({ conversationId: flow.conversationId, action });
  };

  return <StickerProvider><div ref={paneRef} className="flex h-full min-h-0 flex-1 flex-col overflow-clip bg-surface"
    onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDrop={(event) => { if (event.dataTransfer.files.length) event.preventDefault(); }}>
    {selection.active ? <header data-call-avoid="top" className="shrink-0 border-b border-line px-2 pt-safe">
      <div className={`flex items-center gap-x-2 py-1 ${phone ? "" : "flex-wrap"}`}>
        <IconButton icon="close" label={t("messageSelectionCancel")} onClick={selection.cancel} disabled={selection.busy} />
        <span role="status" className="grow text-sm font-semibold">{t("messageSelectionCount", { count })}</span>
        {!phone && <div role="group" aria-label={t("messageSelectionActions")} className="flex flex-wrap items-start gap-1" {...scopeGroup(selectionReason)}>
          <Button variant="ghost" size="sm" disabled={selection.busy} onClick={() => void selection.copy()}>{t("messageSelectionCopy")}</Button>
          <Button variant="danger-ghost" size="sm" disabled={selection.busy} onClick={() => selection.requestDelete("local")}>{t("deleteForMe")}</Button>
          <div><Button variant={unavailable ? "ghost" : "danger-ghost"} className={unavailable ? "!text-ink-muted" : undefined} size="sm"
            disabled={selection.busy} aria-disabled={!!unavailable || undefined} aria-describedby={unavailable ? selectionReason : undefined}
            onClick={() => { if (!unavailable) selection.requestDelete("everyone"); }}>{everyoneLabel}</Button>
            {reason(selectionReason)}</div>
        </div>}
        <IconButton icon="more" label={t("conversationDetails")} disabled={selection.busy} onClick={() => setDetailsOpen(true)} />
      </div>
    </header> : <TopBar title={flow.conversationName} onBack={() => flow.navigate("/")} backLabel={t("backToConversations")} backOnPhoneOnly onTitleClick={() => setDetailsOpen(true)}
      leading={<UserAvatar avatarUrl={flow.directPeer?.user.avatarUrl} displayName={flow.conversationName} size="sm" online={group ? undefined : flow.peerOnline} group={group} />}
      subtitle={<span className="inline-flex items-center gap-1">{group ? t("members", { count: flow.conversation?.members.length ?? 0 }) : flow.peerOnline ? t("online") : t("offline")}{timer && <><Icon name="timer" size={14} />{t("disappearsAfterDuration", { duration: timer })}</>}</span>}
      actions={<>
        {group && flow.conversation && <GroupCallTopBarActions conversation={flow.conversation} banner={groupCallBanner} onStart={setRingType} />}
        {!group && <><IconButton icon="phone" label={t("startAudioCall")} loading={flow.startingCallType === "audio"} onClick={() => void flow.handleStartCall("audio")} disabled={!flow.callingSupported || flow.callDisabled || !!flow.startingCallType} />
          <IconButton icon="video" label={t("startVideoCall")} loading={flow.startingCallType === "video"} onClick={() => void flow.handleStartCall("video")} disabled={!flow.callingSupported || flow.callDisabled || !!flow.startingCallType} /></>}
        <IconButton icon="more" label={t("conversationDetails")} onClick={() => setDetailsOpen(true)} />
      </>} />}
    <h1 className="sr-only">{flow.conversationName}</h1>
    {group && flow.conversation && <GroupCallBanner conversation={flow.conversation} banner={groupCallBanner}
      onJoin={() => void joinGroupCall()} onReturn={() => groupCallActions.restore()} />}
    {group && flow.conversation && <RingMembersDialog open={!!ringType} conversation={flow.conversation} type={ringType ?? "audio"}
      onClose={() => setRingType(null)} onStart={async (ids) => {
        const result = await groupCallActions.start(flow.conversationId!, ringType ?? "audio", ids);
        return result.ok ? null : groupCallErrorTranslation[result.code];
      }} />}
    {flow.callUnsupported ? <Notice tone="warning" className="m-3">{t("encryptedCallsArenTSupportedOnThisDevice")}</Notice> : flow.callError && <Notice tone="danger" className="m-3">{flow.callError}</Notice>}
    <div ref={flow.messageListRef} role="log" tabIndex={-1} data-call-message-area="" aria-label={t("messages")} aria-live="polite" aria-relevant="additions" className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 py-3">
      {!clear.busy && (flow.hasOlderCachedMessages || flow.loadingOlderCachedMessages) && <div className="flex justify-center pb-2"><Button variant="ghost" size="sm" loading={flow.loadingOlderCachedMessages} onClick={() => void flow.handleLoadOlderCachedMessages()}>{t("loadOlderCachedMessages")}</Button></div>}
      {flow.hasUnverifiedLegacyHistory && <Notice tone="warning">{t("unverifiedLegacyHistory")}</Notice>}
      {flow.conversationError && <Notice tone="danger">{flow.conversationError}</Notice>}
      {flow.conversationLoading && <div className="py-3 text-center"><Spinner label={t("loadingConversation")} /></div>}
      {!messages.length && !clear.busy && !flow.conversationError && !flow.conversationLoading && <EmptyState
        title={t(flow.showHistoryGuidance ? "chats.emptyLinkedConversation" : "noMessagesYetSayHello")}
        description={flow.showHistoryGuidance ? t("chats.historyOnOtherDevices") : undefined}
        action={flow.showHistoryGuidance && capabilities.historyTransfer &&
          <Button leadingIcon="transfer" onClick={() => flow.navigate(TRANSFER_RECEIVE_PATH)}>{t("passkeySetup.transferAction")}</Button>} />}
      <ConversationTransferMarkers conversationId={flow.conversationId} />
      {messages.map((message, index, messages) => {
        const member = flow.conversation?.members.find((entry) => entry.userId === message.senderId);
        const queueEntry = flow.outgoing.find((row) => row.id === message.id);
        const failedEdit = failedEdits.find((row) => row.editTargetId === message.id);
        const divider = !index || new Date(messages[index - 1].timestamp).toDateString() !== new Date(message.timestamp).toDateString();
        const run = messageRun(messages, index);
        return <div key={message.id} className={run.first ? "mt-3" : "mt-0.5"}>
          {group && flow.conversation && groupCallBanner.timeline.length > 0 && <GroupCallTimelineLines events={groupCallBanner.timeline} conversation={flow.conversation}
            after={index ? new Date(messages[index - 1].timestamp).getTime() : -Infinity} before={new Date(message.timestamp).getTime()} />}
          {divider && <DateDivider date={new Date(message.timestamp)} />}
          <MessageBubble showMeta={run.last} firstInRun={run.first} message={message} isOwn={message.senderId === flow.user?.id} isGroup={group} senderAvatarUrl={member?.user.avatarUrl} senderName={member?.user.displayName}
            onSelect={flow.conversationId ? () => {
              if (!selection.active) selectionOrigin.current = { conversationId: message.conversationId, index, ids: messages.map(({ id }) => id) };
              selection.toggle(message);
            } : undefined}
            selection={selection.active ? { selected: selection.ids.has(message.id), busy: selection.busy } : undefined}
            failure={queueEntry?.error} onRetry={queueEntry && !timedOut ? () => void flow.retry(message.id) : undefined} onDiscard={queueEntry ? () => void discardOne(message.id) : undefined}
            onEdit={canEdit && edit?.id !== message.id && !queueEntry && canEditMessage(message, flow.user?.id, flow.deviceId)
              ? () => setEdit({ id: message.id, content: message.content, baseSequence: message.editSequence ?? 0 }) : undefined} />
          {failedEdit && !selection.active && <Notice tone="danger" className="ms-auto mt-1 max-w-sm" action={<>
            {(!failedEdit.sendDispatched || !failedEdit.retryable) && <Button size="sm" variant="ghost" onClick={() => void discardOne(failedEdit.id)}>{t("discard")}</Button>}
            <Button size="sm" variant="danger-ghost" disabled={timedOut} onClick={() => void flow.retry(failedEdit.id)}>{t("retry")}</Button>
          </>}>{failedEdit.error || t("messageEditFailed")}</Notice>}
        </div>;
      })}
      {group && flow.conversation && groupCallBanner.timeline.length > 0 && <GroupCallTimelineLines events={groupCallBanner.timeline} conversation={flow.conversation}
        after={messages.length ? new Date(messages[messages.length - 1].timestamp).getTime() : -Infinity} before={Infinity} />}
    </div>
    {flow.showScrollToBottom && <div className="relative"><div className="absolute end-4 bottom-3 z-10"><IconButton icon="arrow-down" label={t("scrollToBottom")} variant="secondary" className="shadow-raised" onClick={flow.scrollToLatest} /><CountBadge count={flow.newMessagesBelowCount} label={t("newMessages")} announcement={t("newCount", { count: flow.newMessagesBelowCount })} className="absolute -top-1 -end-1" /></div></div>}
    {!!flow.typingNames?.length && <p role="status" className="px-4 py-1 text-xs text-ink-muted">{t("typing", { count: flow.typingNames.length, names: flow.typingNames.join(", ") })}</p>}
    {flow.sendError && !editConflict && <Notice tone="danger" className="mx-3 mb-2">{flow.sendError}</Notice>}
    {flow.outgoingRemoved && <Notice className="mx-3 mb-2" onDismiss={flow.dismissOutgoingRemoval}>{t("unsentMessageRemoved")}</Notice>}
    {!selection.active && failed.length > 1 && <Notice tone="danger" className="mx-3 mb-2" action={<Button size="sm" variant="danger-ghost" disabled={timedOut} onClick={() => { failed.forEach((row) => void flow.retry(row.id)); }}>{t("retryAll")}</Button>}>{t("failedMessages", { count: failed.length })}</Notice>}
    <LiveAnnouncement message={selection.copied && copiedText ? { id: selection.copied.id, text: copiedText, assertive: false } : undefined} />
    {copiedText && <div className="flex shrink-0 justify-end px-3 py-2" data-selection-copy-toast="">
      <Notice tone="success" icon="check-circle" live={false}>{copiedText}</Notice>
    </div>}
    {phone && selection.active && <div role="group" aria-label={t("messageSelectionActions")} data-call-avoid="bottom"
      className="flex shrink-0 justify-center gap-2 border-t border-line bg-surface px-3 pt-2 pb-safe">
      <Button variant="secondary" leadingIcon="copy" className="flex-1" disabled={selection.busy} onClick={() => void selection.copy()}>{t("copy")}</Button>
      <Button variant="secondary" leadingIcon="trash" className="flex-1" disabled={selection.busy} onClick={(event) => { event.currentTarget.focus(); selection.requestDelete(); }}>{t("messageSelectionDeleteOptions")}</Button>
    </div>}
    {timedOut && <Notice tone="warning" className="mx-3 mb-2" title={t("groupTimedOut")} live={false}>
      <span role="timer" className="tabular-nums">{t("groupTimeoutCountdown", { time: timeoutClock })}</span>
    </Notice>}
    <div hidden={selection.active} className="shrink-0">
      {flow.isPendingRequest ? <Notice className="m-3" title={group ? t("youWereInvitedTo", { conversationName: flow.conversationName }) : t("wantsToMessageYou", { conversationName: flow.conversationName })} action={<div className="flex gap-2"><Button variant="secondary" onClick={() => void flow.handleDeclineRequest()}>{t("decline")}</Button><Button onClick={() => void flow.handleAcceptRequest()}>{t("accept")}</Button></div>} />
        : <MessageInput key={flow.conversationId} dropTarget={paneRef} messageList={flow.messageListRef} onSend={flow.handleSend} onSendFile={flow.handleSendFile} onTyping={flow.handleTyping}
          disabled={selection.active || clear.busy || timedOut || !accepted}
          editing={editing} editConflict={editConflict} onSaveEdit={editing ? (id, text) => flow.handleEdit(id, text, editing.baseSequence) : undefined}
          onCancelEdit={() => setEdit((current) => current === edit ? undefined : current)} />}
    </div>
    <ConfirmDialog open={deleteDialogOpen} tone={partial ? "default" : "danger"} busy={selection.busy} confirmDisabled={everyone && !!unavailable}
      title={partial ? t("messageSelectionDeleteResult") : t(everyone ? "messageSelectionDeleteEveryoneTitle" : "messageSelectionDeleteLocalTitle", { count: confirmationCount })}
      description={deleteDescription} confirmLabel={partial ? undefined : t("messageSelectionConfirmDelete")}
      cancelLabel={partial ? t("continue") : undefined}
      error={selection.deleteError && t(selection.deleteError)} onConfirm={() => void selection.confirmDelete()} onCancel={selection.cancelDelete}>
      {selection.chooseScope && <fieldset role="radiogroup" aria-labelledby={scopeLabel} className="grid gap-2" {...scopeGroup(dialogReason)}>
        <legend id={scopeLabel} className="mb-2 text-sm font-semibold">{t("messageSelectionDeleteScope")}</legend>
        <label className="flex min-h-11 items-center gap-3 rounded-control border border-line px-3 text-sm">
          <input type="radio" name={scopeLabel} checked={!everyone} disabled={selection.busy} className="size-5 accent-brand"
            onChange={() => selection.chooseDeleteScope("local")} />
          {t("thisDeviceOnly")}
        </label>
        <div>
          <label className={`flex min-h-11 items-center gap-3 rounded-control border border-line px-3 text-sm ${unavailable ? "text-ink-muted" : ""}`}>
            <input type="radio" name={scopeLabel} checked={everyone && !unavailable} disabled={selection.busy || !!unavailable}
              aria-describedby={unavailable ? dialogReason : undefined} className="size-5 accent-brand" onChange={() => selection.chooseDeleteScope("everyone")} />
            {t("removesForAllMembers")}
          </label>
          {reason(dialogReason)}
        </div>
      </fieldset>}
    </ConfirmDialog>

    <Sheet side="end" open={detailsOpen || !!flow.showGroupSettings} onClose={closeDetails} title={t("conversationDetails")}>
      <div className="flex flex-col items-center gap-2 py-3"><UserAvatar avatarUrl={flow.directPeer?.user.avatarUrl} displayName={flow.conversationName} size="lg" group={group} /><h2 className="text-lg font-semibold">{flow.conversationName}</h2>
        {!group && <><Badge icon="shield">{t("notVerified")}</Badge><Button variant="secondary" leadingIcon="shield" onClick={() => flow.directPeer && flow.navigate(`/verify/${flow.directPeer.userId}`)}>{t("verify")}</Button></>}
      </div>
      {timer && <p className="my-4 flex items-center gap-2 text-sm text-ink-muted"><Icon name="timer" size={18} />{t("timedMessagesDuration", { duration: timer })}</p>}
      {group && flow.conversation && <div className="space-y-4">
        {flow.isGroupAdmin && <Button variant="secondary" leadingIcon="edit" fullWidth onClick={() => { setDetailsOpen(false); flow.setShowGroupSettings(false); flow.setNewGroupName(flow.conversation?.name ?? ""); flow.setShowRenameGroup(true); }}>{t("renameGroup")}</Button>}
        <div className="flex items-center justify-between"><h3 className="text-xs font-semibold text-ink-subtle uppercase">{t("memberHeading", { count: flow.conversation.members.length })}</h3>
          {(flow.isGroupAdmin || flow.conversation.invitePolicy === "any_member") && <Button variant="ghost" size="sm" leadingIcon="user-plus" onClick={() => { setDetailsOpen(false); flow.setShowGroupSettings(false); flow.setShowAddMembers(true); }}>{t("addConversationMembers")}</Button>}
        </div>
        <GroupMemberList key={flow.conversation.id} members={flow.conversation.members} viewerId={flow.user?.id}
          isAdmin={flow.isGroupAdmin} moderation={moderation} onRemove={(member) => {
            closeDetails();
            mutations.requestRemoval({ userId: member.userId, displayName: member.user.displayName });
          }} />
        {flow.isGroupAdmin && <fieldset className="space-y-2"><legend className="mb-2 text-xs font-semibold text-ink-subtle uppercase">{t("invitePermissions")}</legend>{([['any_member', t("anyoneCanInviteNewMembers")], ['admins_only', t("onlyAdminsCanInviteMembers")]] as const).map(([value, label]) => <label key={value} className="flex min-h-11 items-center gap-3 text-sm"><input type="radio" name="invitePolicy" className="size-5 accent-[var(--primary)]" checked={flow.conversation?.invitePolicy === value} disabled={flow.updatingInvitePolicy} onChange={() => void flow.handleUpdateInvitePolicy(value)} />{label}</label>)}</fieldset>}
        {flow.isGroupAdmin && (detailsOpen || flow.showGroupSettings) && flow.conversation.joinByName !== undefined &&
          <GroupJoinRequests key={flow.conversation.id} conversationId={flow.conversation.id} joinByName={flow.conversation.joinByName} />}
      </div>}
      <div className="mt-6 flex flex-col items-start gap-1 border-t border-line pt-3">
        {flow.user && flow.conversationId && (flow.conversation || messages.length > 0) && <Button variant="ghost" leadingIcon="trash" disabled={clear.busy} onClick={() => { setDetailsOpen(false); flow.setShowGroupSettings(false); clear.request("local"); }}>{t("clearHistoryForMe")}</Button>}
        {canClearForEveryone && <Button variant="danger-ghost" leadingIcon="trash" disabled={clear.busy} onClick={() => { setDetailsOpen(false); flow.setShowGroupSettings(false); clear.request("everyone"); }}>{t("clearHistoryForEveryone")}</Button>}
        {group && flow.isGroupAdmin && <Button variant="danger-ghost" leadingIcon="trash" onClick={() => requestExit("deleteGroup")}>{t("deleteGroup")}</Button>}
        {flow.user && <Button variant="danger-ghost" onClick={() => requestExit("leave")}>{t("leaveConversation")}</Button>}
      </div>
    </Sheet>
    <ConfirmDialog open={!!clear.action} tone="danger" title={t(clearTitle)} confirmLabel={t(clear.failed ? "retry" : clearTitle)}
      description={t(clear.action === "everyone" ? "clearHistoryEveryoneDescription" : "clearHistoryLocalDescription")}
      error={clear.failed ? t(clear.action === "everyone" ? "clearHistoryEveryoneFailed" : "messageDeleteFailed") : undefined}
      busy={clear.busy} confirmDisabled={clear.action === "everyone" && !canClearForEveryone}
      onConfirm={() => void clear.confirm()} onCancel={clear.cancel} />
    {flow.showAddMembers && flow.conversationId && <AddMembersModal conversationId={flow.conversationId} existingMemberIds={flow.existingMemberIds} onClose={() => flow.setShowAddMembers(false)} onMembersAdded={flow.handleMembersAdded} />}
    <Dialog open={!!flow.showRenameGroup} onClose={() => flow.setShowRenameGroup(false)} title={t("renameGroup")} dismissible={!flow.renamingGroup} footer={<><Button variant="secondary" disabled={flow.renamingGroup} onClick={() => flow.setShowRenameGroup(false)}>{t("cancel")}</Button><Button loading={flow.renamingGroup} disabled={!flow.newGroupName?.trim()} onClick={() => void flow.handleRenameGroup()}>{t("saveChangesAction")}</Button></>}>
      <Field label={t("groupName")} required error={flow.renameGroupError}><Input maxLength={128} value={flow.newGroupName ?? ""} onChange={(event) => flow.setNewGroupName(event.target.value)} /></Field>
    </Dialog>
    <ConfirmDialog open={!!activeExit} tone="danger" title={deletingGroup ? t("deleteGroupConfirmTitle", { conversationName: flow.conversationName }) : t("leaveConversation2")}
      description={t(deletingGroup ? "thisWillPermanentlyDeleteTheGroupAndAll" : "youWillNoLongerReceiveMessagesFromThis")}
      confirmLabel={t(deletingGroup ? "deleteGroup" : "leaveConversation")} acknowledgeLabel={deletingGroup ? t("iUnderstandThisCannotBeUndone") : undefined}
      busy={mutations.deleting} error={mutations.deleteError} onConfirm={() => { if (activeExit) void mutations.deleteConversation(activeExit); }} onCancel={() => setExit(undefined)} />
    <ConfirmDialog open={!!mutations.removeTarget} tone="danger" title={t("removeFrom", { value: mutations.removeTarget?.displayName ?? t("memberDisplayNameFallback"), conversationName: flow.conversationName })} description={t("theyWillStopReceivingNewMessages")} confirmLabel={t("removeMemberAction")} busy={mutations.removing} error={mutations.removeError} onConfirm={() => void mutations.removeMember()} onCancel={mutations.cancelRemoval} />
  </div></StickerProvider>;
}
