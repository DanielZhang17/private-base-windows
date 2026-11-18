import { UnlockOffer } from "../auth/UnlockOffer.js";
import { NewDeviceAlerts } from "../devices/NewDeviceAlert.js";
import { t, useLocale } from "../../i18n/index.js";
import { useEffect, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "../../stores/authStore.js";
import { api } from "../../services/api.js";
import { showWebPushSettings } from "../../services/web-push.js";
import { capabilities } from "../../platform/capabilities.js";
import { TRANSFER_PATH, TRANSFER_SETUP_PATH, useTransferBanner } from "../transfer/HistoryTransferScreens.js";
import { resolveAvatarImageUrl } from "./avatar.js";
import { AppShell, Avatar, BottomBar, EmptyState, Icon, ListItem, NavItem, NavRail, TopBar, ToastProvider, Button } from "../../ui/index.js";

import { SETTINGS_SECTIONS, type SettingsSection } from "./sections.js";
export { SETTINGS_SECTIONS } from "./sections.js";

export function SettingsFrame({ section, detail, detailActive = true, title, onSignOut, detailOwnsHeading = false }: {
  section?: SettingsSection; detail: ReactNode; detailActive?: boolean; title: string; onSignOut?: () => void; detailOwnsHeading?: boolean;
}) {
  const { locale } = useLocale();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const onTransferScreen = pathname === TRANSFER_PATH || pathname === TRANSFER_SETUP_PATH;
  const transferBanner = useTransferBanner();
  const user = useAuthStore((state) => state.user);
  const { data: devices } = useQuery({ queryKey: ["myDevices"], queryFn: () => api.get<unknown[]>("/api/devices") });
  useEffect(() => { if (!detailOwnsHeading) document.title = t("privateBase2", { title }); }, [detailOwnsHeading, title, locale]);
  const destinations = <>
    <NavItem
      icon="chats"
      label={t("chats")}
      onClick={() => navigate("/")}
    />
    <NavItem
      icon="settings"
      label={t("settings")}
      active
      onClick={() => navigate("/settings")}
    />
  </>;
  return <ToastProvider>
    <AppShell
      banner={<>
        {transferBanner}
        {user && <>
          {section !== "devices" && <NewDeviceAlerts filter={section === "privacy" ? alert => alert.kind !== "approval_disabled" : undefined} />}
          {!onTransferScreen && <UnlockOffer />}
        </>}
      </>}

      rail={<NavRail footer={<Avatar
        name={user?.displayName ?? t("selfAvatarFallback")}
        src={resolveAvatarImageUrl(user?.avatarUrl)}
        size="sm"
      />}>
        {destinations}
      </NavRail>}

      bottomBar={<BottomBar>
        {destinations}
      </BottomBar>}

      list={<>
        <TopBar title={t("settings")} heading={!detailOwnsHeading} />
        <div className="min-h-0 grow overflow-y-auto px-2 py-4">

          <div className="flex items-center gap-3 px-3 pb-5">
            <Avatar
              name={user?.displayName ?? t("selfAvatarFallback")}
              src={resolveAvatarImageUrl(user?.avatarUrl)}
              size="lg"
            />
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold">
                {user?.displayName}
              </p>
              <p className="truncate text-sm text-ink-muted">@{user?.username}</p>
            </div>
          </div>

          <ul role="list" className="space-y-1">
            {SETTINGS_SECTIONS.filter(([key]) => (key !== "notifications" || capabilities.backgroundConnection || showWebPushSettings()) && (key !== "about" || !!capabilities.autoUpdate)).map(([key, label, icon]) => <li key={key}>
              <ListItem
                leading={<Icon name={icon} size={22} />}
                title={t(label)}
                subtitle={key === "devices" && devices ? t("devices", { count: devices.length }) : undefined}
                selected={section === key}
                trailing={<Icon name="chevron-right" size={18} />}
                onClick={() => navigate(key === "devices" ? "/devices" : `/settings?section=${key}`, { state: { settingsBack: true } })}
              />
            </li>)}
          </ul>

          {onSignOut && <Button
            variant="ghost"
            leadingIcon="logout"
            className="mt-6 w-full justify-start"
            onClick={onSignOut}
          >{t("signOut")}</Button>}

          <p className="px-3 pt-8 text-xs text-ink-subtle">Private Base</p>

        </div>
      </>}

      detail={detail}
      detailActive={detailActive}

      placeholder={<EmptyState
        icon="settings"
        title={t("yourSettings")}
        description={t("chooseASectionToGetStarted")}
      />}

    />
  </ToastProvider>;
}
