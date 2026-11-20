import { t, useLocale } from "../i18n/index.js";
import { useGroupCallStore } from "../features/calls/group-call-store.js";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useChatList } from "../features/chat/useChatList.js";
import { useHoldUnlockOffer } from "../features/auth/unlockOfferGate.js";
import { UpdateBanner } from "../features/updates/UpdateBanner.js";
import { chatPreview } from "../features/chat/presentation.js";
import { TRANSFER_RECEIVE_PATH } from "../features/transfer/HistoryTransferScreens.js";
import { capabilities } from "../platform/capabilities.js";
import { Button, CountBadge, Dialog, EmptyState, Field, Icon, IconButton, Input, ListItem, Notice, Skeleton, TopBar } from "../ui/index.js";
import UserAvatar from "../components/avatar/UserAvatar.js";
import UserPicker from "../components/user-picker/UserPicker.js";

export default function ChatListPage() {
  const activeGroupCalls = useGroupCallStore((state) => state.activeByConversation);
  const { locale } = useLocale();
  const flow = useChatList();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const showHistoryGuidance = pathname === "/" && flow.showHistoryGuidance;
  // A freshly linked device is still setting up: keep the unlock offer out of the way of history transfer.
  useHoldUnlockOffer(showHistoryGuidance);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const lastOpenedRow = useRef<HTMLButtonElement | null>(null);
  const closeNewChat = () => { flow.setShowNewChat(false); flow.setNewChatError(null); };
  const closeNewGroup = () => { flow.setShowNewGroup(false); flow.setGroupMembers([]); flow.setNewChatError(null); };
  const matches = (conversation: NonNullable<typeof flow.conversations>[number]) => flow.getConversationName(conversation).toLowerCase().includes(search.trim().toLowerCase());
  const accepted = flow.acceptedConversations.filter(matches);
  const requests = flow.pendingConversations.filter(matches);
  useEffect(() => {
    if (pathname === "/") document.title = t("chatsPrivateBase");
  }, [pathname, locale]);
  useEffect(() => {
    if (pathname === "/") lastOpenedRow.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); }
      if (event.key.toLowerCase() === "n") { event.preventDefault(); flow.setShowNewChat(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pathname, flow.setShowNewChat]);

  return <div className="flex min-h-0 flex-1 flex-col">
    <TopBar title={t("chats")} actions={<>
      <IconButton icon="search" label={t("searchConversations")} onClick={() => { setSearchOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); }} />
      <IconButton icon="plus" label={t("newChat")} onClick={() => flow.setShowNewChat(true)} />
    </>} />
    <UpdateBanner />
    <div className={`${searchOpen ? "block" : "hidden lg:block"} px-3 pt-3 pb-1`}>
      <Input ref={searchRef} aria-label={t("searchConversations")} placeholder={t("searchAction")} leading={<Icon name="search" size={18} />} value={search} onChange={(event) => setSearch(event.target.value)} />
    </div>
    {flow.listError && <Notice tone="danger" className="m-2" action={<Button variant="danger-ghost" size="sm" onClick={flow.dismissListError}>{t("dismiss")}</Button>}>{flow.listError}</Notice>}
    {/* The transfer action sits on its own row so it stays readable next to the close button in narrow panes. */}
    {showHistoryGuidance && <Notice className="m-2" onDismiss={flow.dismissHistoryGuidance}>
      <p>{t("chats.historyOnOtherDevices")}</p>
      {capabilities.historyTransfer && <Button variant="secondary" size="sm" leadingIcon="transfer" className="mt-2"
        onClick={() => navigate(TRANSFER_RECEIVE_PATH)}>{t("passkeySetup.transferAction")}</Button>}
    </Notice>}
    <div className="min-h-0 flex-1 overflow-y-auto">
      {flow.loadError && !flow.conversations ? <EmptyState icon="offline" title={t("couldNotLoadConversations")} description={flow.loadError} />
        : flow.isLoading ? <div className="space-y-2 p-3" aria-busy="true" aria-label={t("loadingChats")}>{Array.from({ length: 6 }, (_, i) => <div key={i} className="flex h-16 items-center gap-3"><Skeleton shape="circle" /><div className="flex-1 space-y-2"><Skeleton className="w-3/4" /><Skeleton /></div></div>)}</div>
        : !flow.conversations?.length ? <EmptyState icon="chats" title={t("noConversationsYet")} description={t("findSomeoneByUsernameToStartYourFirst")} action={<Button leadingIcon="plus" onClick={() => flow.setShowNewChat(true)}>{t("startAConversation")}</Button>} />
        : !accepted.length && !requests.length ? <EmptyState icon="search" title={t("noMatchesFor", { search: search })} />
        : <>
          {requests.length > 0 && <section aria-label={t("conversationRequests")}>
            <h2 className="px-5 pt-4 pb-1 text-xs font-semibold tracking-wider text-ink-subtle uppercase">{t("conversationRequestsHeading")}</h2>
            <ul className="space-y-2 p-2">{requests.map((conversation) => <li key={conversation.id} className="rounded-card border border-line bg-surface p-2">
              <ListItem leading={<UserAvatar avatarUrl={flow.getDirectPeer(conversation)?.user.avatarUrl} displayName={flow.getConversationName(conversation)} group={conversation.type === "group"} />} title={flow.getConversationName(conversation)} subtitle={conversation.type === "group" ? t("groupInvite") : t("chatRequest")} onClick={() => flow.openChat(conversation.id)} />
              <div className="flex justify-end gap-2 pt-1"><Button size="sm" variant="secondary" onClick={() => void flow.respondToRequest(conversation.id, "decline")}>{t("decline")}</Button><Button size="sm" onClick={() => void flow.respondToRequest(conversation.id, "accept")}>{t("accept")}</Button></div>
            </li>)}</ul>
          </section>}
          {requests.length > 0 && <h2 className="px-5 pt-3 pb-1 text-xs font-semibold tracking-wider text-ink-subtle uppercase">{t("chats")}</h2>}
          <ul className="space-y-0.5 p-2" aria-label={t("chats")} onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            event.preventDefault(); buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
          }}>{accepted.map((conversation) => {
            const peer = flow.getDirectPeer(conversation);
            const last = flow.getLastVisibleMessage(conversation.id);
            const failed = last?.status === "failed";
            const unread = flow.unreadCounts.get(conversation.id) ?? 0;
            const callActive = conversation.type === "group" && !!activeGroupCalls[conversation.id];
            const preview = callActive ? t("groupCall.rowInProgress")
              : last ? chatPreview(last, conversation, flow.user?.id) : conversation.type === "group" ? t("members", { count: conversation.members.length }) : t("startChatting");
            return <li key={conversation.id}><ListItem className="min-h-16" selected={pathname === `/chat/${conversation.id}`} onClick={(event) => { lastOpenedRow.current = event.currentTarget; flow.openChat(conversation.id); }}
              leading={<UserAvatar avatarUrl={peer?.user.avatarUrl} displayName={flow.getConversationName(conversation)} online={peer ? flow.onlineUsers.has(peer.userId) : undefined} group={conversation.type === "group"} />}
              title={<span aria-label={unread > 0 ? t("conversationWithUnread", { name: flow.getConversationName(conversation), count: unread }) : undefined}>{flow.getConversationName(conversation)}</span>}
              subtitle={<span className="flex flex-col">
                <span className={`inline-flex max-w-full items-center gap-1 ${callActive ? "font-medium text-brand" : failed ? "text-danger" : ""}`}>{callActive ? <Icon name="phone" size={14} /> : failed ? <Icon name="alert-circle" size={14} /> : last?.expiryKind === "timed" ? <Icon name="timer" size={14} /> : null}<span className="truncate">{preview}</span></span>
                {!!conversation.pendingJoinRequestCount && <span className="font-medium text-brand">{t("groupJoinRequestsPending", { count: conversation.pendingJoinRequestCount })}</span>}
              </span>}
              meta={last && flow.relativeTime(last.timestamp)} trailing={<CountBadge count={unread} label={t("unreadMessages")} announcement={t("unreadCount", { count: unread })} />} /></li>;
          })}</ul>
        </>}
    </div>
    <Dialog open={flow.showNewChat} title={t("newChat")} onClose={closeNewChat} dismissible={!flow.creatingChat}>
      <div className="mb-4 space-y-1">
        <ListItem leading={<Icon name="users" />} title={t("newGroupAction")} onClick={() => { closeNewChat(); flow.setShowNewGroup(true); }} />
        <ListItem leading={<Icon name="user-plus" />} title={t("groupJoinAction")} onClick={() => { closeNewChat(); flow.setShowJoinGroup(true); }} />
      </div>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void flow.startNewChat(); }}>
        <Field label={t("username")} error={flow.newChatError}><Input placeholder={t("enterUsername")} value={flow.newChatUsername} onChange={(event) => flow.setNewChatUsername(event.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={closeNewChat} disabled={flow.creatingChat}>{t("cancel")}</Button><Button type="submit" loading={flow.creatingChat} disabled={!flow.newChatUsername.trim()}>{t("startChatAction")}</Button></div>
      </form>
    </Dialog>
    <Dialog open={flow.showNewGroup} title={t("newGroupDialogTitle")} onClose={closeNewGroup} dismissible={!flow.creatingChat}>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void flow.startNewGroup(); }}>
        <Field label={t("groupName")} required error={flow.groupNameTaken ? flow.newChatError : undefined}>
          <Input maxLength={128} value={flow.groupName} onChange={(event) => { flow.setGroupName(event.target.value); flow.setNewChatError(null); }} />
        </Field>
        <UserPicker selectedUsers={flow.groupMembers} onSelectionChange={flow.setGroupMembers} placeholder={t("groupMembersPlaceholder")} />
        {flow.newChatError && !flow.groupNameTaken && <Notice tone="danger">{flow.newChatError}</Notice>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={closeNewGroup} disabled={flow.creatingChat}>{t("cancel")}</Button><Button type="submit" loading={flow.creatingChat} disabled={!flow.groupMembers.length || !flow.groupName.trim()}>{t("createGroup")}</Button></div>
      </form>
    </Dialog>
    <Dialog open={flow.showJoinGroup} title={t("groupJoinAction")} onClose={flow.closeJoinGroup} dismissible={!flow.creatingChat}>
      {flow.joinSubmitted ? <div className="space-y-4">
        <Notice>{t("groupJoinSubmitted")}</Notice>
        <Button onClick={flow.closeJoinGroup}>{t("close")}</Button>
      </div> : <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void flow.requestGroupJoin(); }}>
        <Field label={t("groupName")} required help={t("groupJoinExactName")} error={flow.newChatError}>
          <Input maxLength={128} value={flow.joinGroupName} onChange={(event) => { flow.setJoinGroupName(event.target.value); flow.setNewChatError(null); }} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={flow.closeJoinGroup} disabled={flow.creatingChat}>{t("cancel")}</Button>
          <Button type="submit" loading={flow.creatingChat} disabled={!flow.joinGroupName.trim()}>{t("groupJoinSendRequest")}</Button>
        </div>
      </form>}
    </Dialog>
  </div>;
}
