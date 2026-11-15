import { t, useLocale } from "../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import { useConversationMutations } from "../features/chat/useConversationMutations.js";
import { useConversation } from "../features/chat/useConversation.js";
import { timedDuration } from "../features/chat/presentation.js";
import { Badge, Button, ConfirmDialog, CountBadge, Dialog, EmptyState, Field, Icon, IconButton, Input, ListItem, Notice, Sheet, Spinner, TopBar, useToast } from "../ui/index.js";
import MessageBubble from "../components/chat/MessageBubble.js";
import MessageInput from "../components/chat/MessageInput.js";
import UserAvatar from "../components/avatar/UserAvatar.js";
import AddMembersModal from "../components/user-picker/AddMembersModal.js";
import { DateDivider } from "../components/chat/DateDivider.js";

export default function ChatPage() {
  const { locale } = useLocale();
  const flow = useConversation();
  const paneRef = useRef<HTMLDivElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const mutations = useConversationMutations(flow.conversationId, () => flow.navigate("/"));
  const toast = useToast();
  const group = flow.conversation?.type === "group";
  const failed = flow.outgoing.filter((row) => row.status === "failed");
  const timer = timedDuration(flow.conversationMessages);
  useEffect(() => {
    const wide = window.matchMedia?.("(min-width: 640px)").matches;
    const target = paneRef.current?.querySelector<HTMLElement>(wide ? "textarea" : "header button");
    target?.focus({ preventScroll: true });
  }, [flow.conversationId, flow.conversation?.id]);
  useEffect(() => { document.title = t("privateBase", { conversationName: flow.conversationName }); }, [flow.conversationName, locale]);
  useEffect(() => {
    if (flow.noticeMessage) { toast.show({ tone: "danger", message: flow.noticeMessage }); flow.dismissNotice(); }
  }, [flow.noticeMessage, flow.dismissNotice, toast]);

  return <div ref={paneRef} className="flex h-full min-h-0 flex-1 flex-col overflow-clip bg-surface"
    onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onDrop={(event) => { if (event.dataTransfer.files.length) event.preventDefault(); }}>
    <TopBar title={flow.conversationName} onBack={() => flow.navigate("/")} backLabel={t("backToConversations")} backOnPhoneOnly onTitleClick={() => setDetailsOpen(true)}
      leading={<UserAvatar avatarUrl={flow.directPeer?.user.avatarUrl} displayName={flow.conversationName} size="sm" online={group ? undefined : flow.peerOnline} group={group} />}
      subtitle={<span className="inline-flex items-center gap-1">{group ? t("members", { count: flow.conversation?.members.length ?? 0 }) : flow.peerOnline ? t("online") : t("offline")}{timer && <><Icon name="timer" size={14} />{t("disappearsAfterDuration", { duration: timer })}</>}</span>}
      actions={<>
        {!group && <><IconButton icon="phone" label={t("startAudioCall")} loading={flow.startingCallType === "audio"} onClick={() => void flow.handleStartCall("audio")} disabled={!flow.callingSupported || flow.callDisabled || !!flow.startingCallType} />
          <IconButton icon="video" label={t("startVideoCall")} loading={flow.startingCallType === "video"} onClick={() => void flow.handleStartCall("video")} disabled={!flow.callingSupported || flow.callDisabled || !!flow.startingCallType} /></>}
        <IconButton icon="more" label={t("conversationDetails")} onClick={() => setDetailsOpen(true)} />
      </>} />
    <h1 className="sr-only">{flow.conversationName}</h1>
    {flow.callUnsupported ? <Notice tone="warning" className="m-3">{t("encryptedCallsArenTSupportedOnThisDevice")}</Notice> : flow.callError && <Notice tone="danger" className="m-3">{flow.callError}</Notice>}
    <div ref={flow.messageListRef} role="log" data-call-message-area="" aria-label={t("messages")} aria-live="polite" aria-relevant="additions" className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 py-3">
      {(flow.hasOlderCachedMessages || flow.loadingOlderCachedMessages) && <div className="flex justify-center pb-2"><Button variant="ghost" size="sm" loading={flow.loadingOlderCachedMessages} onClick={() => void flow.handleLoadOlderCachedMessages()}>{t("loadOlderCachedMessages")}</Button></div>}
      {flow.conversationError && <Notice tone="danger">{flow.conversationError}</Notice>}
      {flow.conversationLoading && <div className="py-3 text-center"><Spinner label={t("loadingConversation")} /></div>}
      {!flow.conversationMessages.length && !flow.conversationError && !flow.conversationLoading && <EmptyState title={t("noMessagesYetSayHello")} />}
      {flow.conversationMessages.map((message, index, messages) => {
        const member = flow.conversation?.members.find((entry) => entry.userId === message.senderId);
        const queueEntry = flow.outgoing.find((row) => row.id === message.id);
        const divider = !index || new Date(messages[index - 1].timestamp).toDateString() !== new Date(message.timestamp).toDateString();
        return <div key={message.id}>
          {divider && <DateDivider date={new Date(message.timestamp)} />}
          <MessageBubble message={message} isOwn={message.senderId === flow.user?.id} isGroup={group} senderAvatarUrl={member?.user.avatarUrl} senderName={member?.user.displayName}
            failure={queueEntry?.error} onRetry={queueEntry ? () => void flow.retry(message.id) : undefined} onDiscard={queueEntry ? () => void flow.discard(message.id) : undefined} />
        </div>;
      })}
    </div>
    {flow.showScrollToBottom && <div className="relative"><div className="absolute end-4 bottom-3 z-10"><IconButton icon="arrow-down" label={t("scrollToBottom")} variant="secondary" className="shadow-raised" onClick={flow.scrollToLatest} /><CountBadge count={flow.newMessagesBelowCount} label={t("newMessages")} announcement={t("newCount", { count: flow.newMessagesBelowCount })} className="absolute -top-1 -end-1" /></div></div>}
    {!!flow.typingNames?.length && <p role="status" className="px-4 py-1 text-xs text-ink-muted">{t("typing", { count: flow.typingNames.length, names: flow.typingNames.join(", ") })}</p>}
    {flow.sendError && <Notice tone="danger" className="mx-3 mb-2">{flow.sendError}</Notice>}
    {flow.outgoingRemoved && <Notice className="mx-3 mb-2" onDismiss={flow.dismissOutgoingRemoval}>{t("unsentMessageRemoved")}</Notice>}
    {failed.length > 1 && <Notice tone="danger" className="mx-3 mb-2" action={<Button size="sm" variant="danger-ghost" onClick={() => { failed.forEach((row) => void flow.retry(row.id)); }}>{t("retryAll")}</Button>}>{t("failedMessages", { count: failed.length })}</Notice>}
    {flow.isPendingRequest ? <Notice className="m-3" title={group ? t("youWereInvitedTo", { conversationName: flow.conversationName }) : t("wantsToMessageYou", { conversationName: flow.conversationName })} action={<div className="flex gap-2"><Button variant="secondary" onClick={() => void flow.handleDeclineRequest()}>{t("decline")}</Button><Button onClick={() => void flow.handleAcceptRequest()}>{t("accept")}</Button></div>} />
      : <MessageInput key={flow.conversationId} dropTarget={paneRef} onSend={flow.handleSend} onSendFile={flow.handleSendFile} onTyping={flow.handleTyping} disabled={!flow.user || !flow.conversation} />}

    <Sheet side="end" open={detailsOpen || !!flow.showGroupSettings} onClose={() => { setDetailsOpen(false); flow.setShowGroupSettings(false); }} title={t("conversationDetails")}>
      <div className="flex flex-col items-center gap-2 py-3"><UserAvatar avatarUrl={flow.directPeer?.user.avatarUrl} displayName={flow.conversationName} size="lg" group={group} /><h2 className="text-lg font-semibold">{flow.conversationName}</h2>
        {!group && <><Badge icon="shield">{t("notVerified")}</Badge><Button variant="secondary" leadingIcon="shield" onClick={() => flow.directPeer && flow.navigate(`/verify/${flow.directPeer.userId}`)}>{t("verify")}</Button></>}
      </div>
      {timer && <p className="my-4 flex items-center gap-2 text-sm text-ink-muted"><Icon name="timer" size={18} />{t("timedMessagesDuration", { duration: timer })}</p>}
      {group && flow.conversation && <div className="space-y-4">
        {flow.isGroupAdmin && <Button variant="secondary" leadingIcon="edit" fullWidth onClick={() => { setDetailsOpen(false); flow.setShowGroupSettings(false); flow.setNewGroupName(flow.conversation?.name ?? ""); flow.setShowRenameGroup(true); }}>{t("renameGroup")}</Button>}
        <div className="flex items-center justify-between"><h3 className="text-xs font-semibold text-ink-subtle uppercase">{t("memberHeading", { count: flow.conversation.members.length })}</h3>
          {(flow.isGroupAdmin || flow.conversation.invitePolicy === "any_member") && <Button variant="ghost" size="sm" leadingIcon="user-plus" onClick={() => { setDetailsOpen(false); flow.setShowGroupSettings(false); flow.setShowAddMembers(true); }}>{t("addConversationMembers")}</Button>}
        </div>
        <ul>{flow.conversation.members.map((member) => <li key={member.userId}><ListItem leading={<UserAvatar avatarUrl={member.user.avatarUrl} displayName={member.user.displayName} size="sm" />} title={member.user.displayName} subtitle={`@${member.user.username}`} meta={member.role === "admin" ? t("admin") : undefined} trailing={flow.isGroupAdmin && member.userId !== flow.user?.id && <IconButton icon="trash" variant="danger-ghost" label={t("removeMemberNamed", { displayName: member.user.displayName })} onClick={() => { setDetailsOpen(false); flow.setShowGroupSettings(false); mutations.requestRemoval({ userId: member.userId, displayName: member.user.displayName }); }} />} /></li>)}</ul>
        {flow.isGroupAdmin && <fieldset className="space-y-2"><legend className="mb-2 text-xs font-semibold text-ink-subtle uppercase">{t("invitePermissions")}</legend>{([['any_member', t("anyoneCanInviteNewMembers")], ['admins_only', t("onlyAdminsCanInviteMembers")]] as const).map(([value, label]) => <label key={value} className="flex min-h-11 items-center gap-3 text-sm"><input type="radio" name="invitePolicy" className="size-5 accent-[var(--primary)]" checked={flow.conversation?.invitePolicy === value} disabled={flow.updatingInvitePolicy} onChange={() => void flow.handleUpdateInvitePolicy(value)} />{label}</label>)}</fieldset>}
      </div>}
      <div className="mt-6 border-t border-line pt-3"><Button variant="danger-ghost" leadingIcon="trash" onClick={() => { setDetailsOpen(false); flow.setShowGroupSettings(false); mutations.clearDeleteError(); flow.setShowDeleteConfirm(true); }}>{group && flow.isGroupAdmin ? t("deleteGroup") : t("leaveConversation")}</Button></div>
    </Sheet>
    {flow.showAddMembers && flow.conversationId && <AddMembersModal conversationId={flow.conversationId} existingMemberIds={flow.existingMemberIds} onClose={() => flow.setShowAddMembers(false)} onMembersAdded={flow.handleMembersAdded} />}
    <Dialog open={!!flow.showRenameGroup} onClose={() => flow.setShowRenameGroup(false)} title={t("renameGroup")} dismissible={!flow.renamingGroup} footer={<><Button variant="secondary" disabled={flow.renamingGroup} onClick={() => flow.setShowRenameGroup(false)}>{t("cancel")}</Button><Button loading={flow.renamingGroup} disabled={!flow.newGroupName?.trim()} onClick={() => void flow.handleRenameGroup()}>{t("saveChangesAction")}</Button></>}>
      <Field label={t("groupName")}><Input value={flow.newGroupName ?? ""} onChange={(event) => flow.setNewGroupName(event.target.value)} placeholder={t("groupName")} /></Field>
    </Dialog>
    <ConfirmDialog open={!!flow.showDeleteConfirm} tone="danger" title={group && flow.isGroupAdmin ? t("deleteGroupConfirmTitle", { conversationName: flow.conversationName }) : t("leaveConversation2")} description={group && flow.isGroupAdmin ? t("thisWillPermanentlyDeleteTheGroupAndAll") : t("youWillNoLongerReceiveMessagesFromThis")} confirmLabel={group && flow.isGroupAdmin ? t("deleteGroup") : t("leaveConversation")} acknowledgeLabel={group && flow.isGroupAdmin ? t("iUnderstandThisCannotBeUndone") : undefined} busy={mutations.deleting} error={mutations.deleteError} onConfirm={() => void mutations.deleteConversation()} onCancel={() => flow.setShowDeleteConfirm(false)} />
    <ConfirmDialog open={!!mutations.removeTarget} tone="danger" title={t("removeFrom", { value: mutations.removeTarget?.displayName ?? t("memberDisplayNameFallback"), conversationName: flow.conversationName })} description={t("theyWillStopReceivingNewMessages")} confirmLabel={t("removeMemberAction")} busy={mutations.removing} error={mutations.removeError} onConfirm={() => void mutations.removeMember()} onCancel={mutations.cancelRemoval} />
  </div>;
}
