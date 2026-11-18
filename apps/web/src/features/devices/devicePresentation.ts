import type { DeviceLimitEntry } from "@e2ee-chat/shared";
import { t } from "../../i18n/index.js";
import { formatDateTime, formatTime } from "../../i18n/format.js";
import type { IconName } from "../../ui/icons/paths.js";

export function deviceIcon(platform: string | null | undefined): IconName {
  if (platform === "macos") return "laptop";
  if (platform === "windows") return "device-desktop";
  if (platform === "android" || platform === "ios") return "device-phone";
  return "globe";
}

export function linkMethodLabel(method: DeviceLimitEntry["linkMethod"]) {
  return t(method === "passkey" ? "devices.linkedWithPasskey" : method === "recovery" ? "linkedWithARecoveryKey"
    : method === "approved_link" ? "approvedByALinkedDevice" : "originalDevice");
}

export function deviceAlertTime(at: number) {
  return new Date(at).toDateString() === new Date().toDateString()
    ? t("deviceAlert.today", { time: formatTime(at) }) : formatDateTime(at);
}
