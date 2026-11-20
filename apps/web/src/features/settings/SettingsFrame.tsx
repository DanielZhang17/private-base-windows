import { NewDeviceAlerts } from "../devices/NewDeviceAlert.js";
import { t, useLocale } from "../../i18n/index.js";
import { useEffect, useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "../../stores/authStore.js";
import { api } from "../../services/api.js";
import { showWebPushSettings } from "../../services/web-push.js";
import { capabilities } from "../../platform/capabilities.js";
import { useTransferBanner } from "../transfer/HistoryTransferScreens.js";
import { resolveAvatarImageUrl } from "./avatar.js";
import { AppShell, Avatar, BottomBar, EmptyState, Icon, ListItem, NavItem, NavRail, TopBar, ToastProvider, Button, useToast } from "../../ui/index.js";

import { SETTINGS_SECTIONS, type SettingsSection } from "./sections.js";
import { captureToggleGated, createSecretTapCounter, unlockCaptureToggle, useCaptureToggleUnlocked } from "./hiddenOptions.js";
export { SETTINGS_SECTIONS } from "./sections.js";

export function SettingsFrame({ section, detail, detailActive = true, title, onSignOut, detailOwnsHeading = false }: {
  section?: SettingsSection; detail: ReactNode; detailActive?: boolean; title: string; onSignOut?: () => void; detailOwnsHeading?: boolean;
}) {
  const { locale } = useLocale();
  const navigate = useNavigate();
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
        {user && section !== "devices" && <NewDeviceAlerts filter={section === "privacy" ? alert => alert.kind !== "approval_disabled" : undefined} />}
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
            {SETTINGS_SECTIONS.filter(([key]) => (key !== "notifications" || capabilities.backgroundConnection || showWebPushSettings()) && (key !== "about" || capabilities.autoUpdate || capabilities.otaUiAvailable)).map(([key, label, icon]) => <li key={key}>
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

          <SettingsBrandFooter />

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

/** "Private Base" footer. On Android, seven quick taps reveal the hidden screenshot switch in Privacy. */
function SettingsBrandFooter() {
  const toast = useToast();
  const unlocked = useCaptureToggleUnlocked();
  const tap = useMemo(() => createSecretTapCounter(() => {
    unlockCaptureToggle();
    toast.show({ tone: "success", message: t("captureToggleUnlocked") });
  }), [toast]);
  if (!captureToggleGated() || unlocked) return <p className="px-3 pt-8 text-xs text-ink-subtle">Private Base</p>;
  // Looks and reads like the plain label (no button role: an easter-egg gesture, not a feature), but it is focusable
  // so keyboard users can reveal the switch too: Enter or Space counts as a tap.
  return <p className="px-3 pt-8 text-xs text-ink-subtle"><span tabIndex={0} className="select-none rounded-sm" onClick={tap}
    onKeyDown={(event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (!event.repeat) tap();
    }}>Private Base</span></p>;
}
