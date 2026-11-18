import type { DeviceAlert } from "@e2ee-chat/shared";

export function deviceAlertDestination(kind: DeviceAlert["kind"]): "/devices" | "/settings?section=privacy" {
  return kind === "approval_disabled" ? "/settings?section=privacy" : "/devices";
}

type AlertListener = (deviceId: string, kind?: DeviceAlert["kind"]) => void;
const subscribers = new Set<AlertListener>();

export function subscribeToDeviceAlerts(listener: AlertListener): () => void {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}

export function publishDeviceAlertsChanged(deviceId: string, kind?: DeviceAlert["kind"]): void {
  for (const subscriber of subscribers) subscriber(deviceId, kind);
}
