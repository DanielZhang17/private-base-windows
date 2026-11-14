import { t, useLocale } from "../../i18n/index.js";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useOutgoingQueue } from "../../features/chat/useOutgoingQueue.js";
import { useShell } from "../../features/chat/useShell.js";
import { AppShell, BottomBar, NavItem, NavRail, EmptyState, Notice } from "../../ui/index.js";
import ChatListPage from "../../pages/ChatListPage.js";
import UserAvatar from "../avatar/UserAvatar.js";
import IncomingCallModal from "../calls/IncomingCallModal.js";

export default function Layout() {
  useLocale();
  useOutgoingQueue();
  const { user, isOnline, unread } = useShell();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const atRoot = pathname === "/";
  const settingsActive = pathname === "/settings" || pathname === "/devices";
  const navigation = <>
    <NavItem icon="chats" label={t("chats")} active={!settingsActive} count={unread} onClick={() => navigate("/")} />
    <NavItem icon="settings" label={t("settings")} active={settingsActive} onClick={() => navigate("/settings")} />
  </>;

  return <>
    <AppShell
      banner={!isOnline && <Notice tone="warning" icon="offline" className="rounded-none">{t("youAreOfflineMessagesWillSendWhenYou")}</Notice>}
      rail={<NavRail footer={user && <UserAvatar avatarUrl={user.avatarUrl} displayName={user.displayName} size="sm" />}>{navigation}</NavRail>}
      bottomBar={<BottomBar>{navigation}</BottomBar>}
      list={<ChatListPage />}
      detail={atRoot ? undefined : <>
        <div className="flex min-h-0 flex-1 flex-col overflow-clip"><Outlet /></div>
        {pathname === "/settings" && <div className="sm:hidden"><BottomBar>{navigation}</BottomBar></div>}
      </>}
      placeholder={<EmptyState icon="chats" title={t("noConversationOpen")} description={t("pickAConversationFromTheListOrStart")} className="my-auto" />}
    />
    <IncomingCallModal />
  </>;
}
