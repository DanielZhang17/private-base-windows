import { useState } from "react";
import { HistoryTransferOffer, type SetupReceipt } from "../../features/auth/HistoryTransferOffer.js";
import { deviceAlertTime } from "../../features/devices/devicePresentation.js";
import { capabilities } from "../../platform/capabilities.js";
import { UnlockOffer } from "../../features/auth/UnlockOffer.js";
import { NewDeviceAlerts } from "../../features/devices/NewDeviceAlert.js";
import { t, useLocale } from "../../i18n/index.js";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useOutgoingQueue } from "../../features/chat/useOutgoingQueue.js";
import { TRANSFER_SETUP_PATH, useTransferBanner } from "../../features/transfer/HistoryTransferScreens.js";
import { useShell } from "../../features/chat/useShell.js";
import { AppShell, BottomBar, Button, NavItem, NavRail, EmptyState, Notice } from "../../ui/index.js";
import ChatListPage from "../../pages/ChatListPage.js";
import UserAvatar from "../avatar/UserAvatar.js";
import IncomingCallModal from "../calls/IncomingCallModal.js";

export default function Layout() {
  useLocale();
  useOutgoingQueue();
  const { user, isOnline, unread } = useShell();
  const { pathname, search, state } = useLocation();
  const setupState = state as { passkeySetup?: SetupReceipt; transferOffered?: boolean } | null;
  const completedSetup = setupState?.passkeySetup;
  const [showSetupReceipt, setShowSetupReceipt] = useState(true);
  const [showTransfer, setShowTransfer] = useState(true);
  const navigate = useNavigate();
  const transferBanner = useTransferBanner();
  const atRoot = pathname === "/";
  const settingsActive = pathname === "/settings" || pathname === "/devices";
  const navigation = <>
    <NavItem icon="chats" label={t("chats")} active={!settingsActive} count={unread} onClick={() => navigate("/")} />
    <NavItem icon="settings" label={t("settings")} active={settingsActive} onClick={() => navigate("/settings")} />
  </>;

  if (capabilities.historyTransfer && completedSetup && showTransfer && !setupState?.transferOffered && atRoot) {
    return <HistoryTransferOffer deviceId={completedSetup.id} onContinue={() => setShowTransfer(false)}
      onTransfer={() => navigate(TRANSFER_SETUP_PATH, { replace: true, state: { passkeySetup: completedSetup, transferOffered: true } })} />;
  }
  return <>
    <AppShell
      banner={<>
        {transferBanner}
        {!isOnline && <Notice tone="warning" icon="offline" className="rounded-none">{t("youAreOfflineMessagesWillSendWhenYou")}</Notice>}
        {user && pathname !== "/devices" && <NewDeviceAlerts compact={!atRoot && !settingsActive}
          filter={pathname === "/settings" && new URLSearchParams(search).get("section") === "privacy"
            ? alert => alert.kind !== "approval_disabled" : undefined} />}
        {completedSetup?.activatedAt && showSetupReceipt && <Notice tone="info">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <div className="min-w-0 flex-[1_1_14rem]">
              <p className="text-ink-muted">{t("passkeySetup.otherDevicesWillSee")}</p>
              <p className="break-words"><strong>{completedSetup.deviceName}</strong></p>
              <p className="text-ink-muted">{t("passkeySetup.receiptTime", { time: deviceAlertTime(completedSetup.activatedAt) })}</p>
            </div>
            <Button variant="ghost" className="ms-auto min-w-11 shrink-0" onClick={() => setShowSetupReceipt(false)}>{t("dismiss")}</Button>
          </div>
        </Notice>}
        {user && <UnlockOffer />}
      </>}
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
