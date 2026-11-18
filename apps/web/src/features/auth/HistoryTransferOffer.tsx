import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Device } from "@e2ee-chat/shared";
import { t } from "../../i18n/index.js";
import { api } from "../../services/api.js";
import { Button, Icon, ListItem, Spinner } from "../../ui/index.js";
import { relativeActivity } from "../devices/useDevices.js";
import { deviceIcon } from "../devices/devicePresentation.js";
import { AuthHeading } from "./AuthHeading.js";

export type SetupReceipt = Pick<Device, "id" | "deviceName" | "activatedAt">;

export function HistoryTransferOffer({ deviceId, onContinue, onTransfer }: {
  deviceId: string; onContinue: () => void; onTransfer: () => void;
}) {
  const devices = useQuery({ queryKey: ["myDevices"], queryFn: () => api.get<Device[]>("/api/devices") });
  const peers = devices.data?.filter(device => device.id !== deviceId);
  useEffect(() => { if (!devices.isLoading && !peers?.length) onContinue(); }, [devices.isLoading, peers?.length, onContinue]);
  if (devices.isLoading) return <Spinner label={t("loadingDevices")} />;
  if (!peers?.length) return null;
  return <main className="grid min-h-dvh place-items-center bg-canvas p-4 text-ink">
    <div className="grid w-full max-w-[30rem] gap-4 sm:rounded-card sm:border sm:border-line sm:bg-surface sm:p-8">
      <p className="text-sm font-semibold text-ink-subtle">{t("passkeySetup.stepOf", { current: 2, total: 2 })}</p>
      <AuthHeading title={t("passkeySetup.transferTitle")} />
      <p className="text-ink-muted">{t("passkeySetup.transferBody")}</p>
      <ul className="divide-y divide-line rounded-card border border-line">{peers.map(device => <li key={device.id}>
        <ListItem leading={<Icon name={deviceIcon(device.platform)} />} title={device.deviceName} subtitle={relativeActivity(device.lastSeenAt)} />
      </li>)}</ul>
      <Button leadingIcon="transfer" onClick={onTransfer}>{t("passkeySetup.transferAction")}</Button>
      <Button variant="ghost" onClick={onContinue}>{t("passkeySetup.skipForNow")}</Button>
      <p className="text-center text-sm text-ink-muted">{t("passkeySetup.transferLater")}</p>
    </div>
  </main>;
}
