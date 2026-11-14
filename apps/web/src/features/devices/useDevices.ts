import { renderMessage, type LocalizedMessage } from "../../i18n/messages.js";
import { translateError, toErrorMessage } from "../shared/errors.js";
import { formatDateTime, formatTime, formatRelativeTimestamp } from "../../i18n/format.js";
import { t, useLocale } from "../../i18n/index.js";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Device, DeviceLinkRequestSummary } from "@e2ee-chat/shared";
import { api } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { generateRecoveryKey, signDeviceLinkApproval } from "../../lib/device-link.js";
import { copyText } from "../../platform/clipboard.js";
import { capabilities } from "../../platform/capabilities.js";
import { saveFile } from "../../platform/files.js";
import { useSettingsBack } from "../settings/useSettingsBack.js";

export function relativeActivity(timestamp: number | null): string {
  if (!timestamp) return t("notActiveYet");
  return Date.now() - timestamp < 60_000 ? t("activeNow") : t("lastActive", { time: formatRelativeTimestamp(timestamp) });
}

export function useDevices() {
  useLocale();
  const navigate = useNavigate();
  const goBack = useSettingsBack();
  const currentDeviceId = useAuthStore((state) => state.device?.id);
  const [removalTarget, setRemovalTarget] = useState<Device | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [generatedRecoveryKey, setGeneratedRecoveryKey] = useState<string | null>(null);
  const [enrollingRecovery, setEnrollingRecovery] = useState(false);
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [removeError, setRemoveError] = useState<LocalizedMessage | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const devicesQuery = useQuery({ queryKey: ["myDevices"], queryFn: () => api.get<Device[]>("/api/devices") });
  const pendingRequestsQuery = useQuery({ queryKey: ["pendingDeviceLinks"], queryFn: () => api.get<DeviceLinkRequestSummary[]>("/api/device-links/pending"), refetchInterval: 1_500 });
  const recoveryStatusQuery = useQuery({ queryKey: ["recoveryKeyStatus"], queryFn: () => api.get<{ enrolled: boolean }>("/api/device-links/recovery-key") });

  const handleRemoveDevice = (deviceId: string) => {
    if (deviceId === currentDeviceId) return;
    setRemoveError(null);
    setRemovalTarget(devicesQuery.data?.find((device) => device.id === deviceId) ?? null);
  };
  const confirmRemoveDevice = async () => {
    if (!removalTarget || inFlight.current) return false;
    inFlight.current = true;
    setRemoving(removalTarget.id); setRemoveError(null);
    try {
      await api.delete(`/api/devices/${removalTarget.id}`);
      await devicesQuery.refetch(); setRemovalTarget(null);
      return true;
    } catch (failure: any) { setRemoveError(toErrorMessage(failure, "failedToRemoveDevice")); return false; }
    finally { inFlight.current = false; setRemoving(null); }
  };
  const actOnRequest = async (request: DeviceLinkRequestSummary, action: "approve" | "reject") => {
    if (inFlight.current || request.linkMethod !== "approved_link" || request.expiresAt <= Date.now()) return false;
    if (action === "approve" && (request.status !== "pending" || !recoveryStatusQuery.data?.enrolled)) return false;
    if (action === "reject" && request.status !== "pending" && request.status !== "approved") return false;
    inFlight.current = true;
    setPendingActionId(request.id); setError(null);
    try {
      if (action === "approve") {
        const approvalSignature = await signDeviceLinkApproval(request.id, request.identityKey, request.shortCode ?? "", request.expiresAt);
        await api.post(`/api/device-links/${request.id}/approve`, { approvalSignature });
        await devicesQuery.refetch();
      } else await api.post(`/api/device-links/${request.id}/reject`);
      await pendingRequestsQuery.refetch(); return true;
    } catch (failure: any) { setError(toErrorMessage(failure, action === "approve" ? "failedToApproveDeviceLink" : "failedToRejectDeviceLink")); return false; }
    finally { inFlight.current = false; setPendingActionId(null); }
  };
  const handleApprove = (request: DeviceLinkRequestSummary) => actOnRequest(request, "approve");
  const handleReject = (requestId: string) => {
    const request = pendingRequestsQuery.data?.find((item) => item.id === requestId);
    return request ? actOnRequest(request, "reject") : Promise.resolve(false);
  };
  const handleCancel = (request: DeviceLinkRequestSummary) => request.status === "approved" && request.linkMethod === "approved_link"
    ? actOnRequest(request, "reject") : Promise.resolve(false);
  const handleEnrollRecoveryKey = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setEnrollingRecovery(true); setError(null);
    const recoveryKey = generateRecoveryKey();
    try { await api.post("/api/device-links/recovery-key", { recoveryKey }); setGeneratedRecoveryKey(recoveryKey); await recoveryStatusQuery.refetch(); }
    catch (failure: any) { setError(toErrorMessage(failure, "failedToEnrollRecoveryKey")); }
    finally { inFlight.current = false; setEnrollingRecovery(false); }
  };
  const devices = (devicesQuery.data ?? []).map((device) => ({
    ...device,
    activity: relativeActivity(device.lastSeenAt), activityTitle: device.lastSeenAt ? formatDateTime(device.lastSeenAt) : undefined,
    icon: /phone|android|iphone|ipad/i.test(device.deviceName) ? "device-phone" as const : "device-desktop" as const,
    linkedBy: device.linkMethod === "recovery" ? t("linkedWithARecoveryKey") : device.linkMethod === "approved_link" ? t("approvedByALinkedDevice") : t("originalDevice"),
  })).sort((a, b) => Number(b.id === currentDeviceId) - Number(a.id === currentDeviceId));
  return {
    navigate, goBack, currentDeviceId, removing, pendingActionId, generatedRecoveryKey, enrollingRecovery,
    removalTarget, removeError: removeError ? renderMessage(removeError) : null, handleRemoveDevice, confirmRemoveDevice,
    cancelRemoveDevice: () => { if (!inFlight.current) setRemovalTarget(null); },
    error: (error ? renderMessage(error) : null) || (devicesQuery.error ? translateError(devicesQuery.error) : undefined) || (pendingRequestsQuery.error ? translateError(pendingRequestsQuery.error) : undefined) || (recoveryStatusQuery.error ? translateError(recoveryStatusQuery.error) : undefined),
    handleApprove, handleReject, handleCancel, handleEnrollRecoveryKey,
    copyRecoveryKey: async () => { if (generatedRecoveryKey) await copyText(generatedRecoveryKey); },
    saveRecoveryKey: async () => { if (generatedRecoveryKey) await saveFile(new Blob([generatedRecoveryKey], { type: "text/plain" }), "private-base-recovery-key.txt"); },
    canSaveRecoveryKey: capabilities.saveFile,
    dismissRecoveryKey: () => setGeneratedRecoveryKey(null),
    dismissRequest: (id: string) => setDismissed((current) => [...current, id]),
    retry: () => { void devicesQuery.refetch(); void pendingRequestsQuery.refetch(); void recoveryStatusQuery.refetch(); },
    devicesLoading: devicesQuery.isLoading, requestsLoading: pendingRequestsQuery.isLoading,
    devices, pendingRequests: (pendingRequestsQuery.data ?? []).filter((request) => !dismissed.includes(request.id)).map((request) => ({
      ...request,
      codeChunks: request.shortCode?.match(/.{1,3}/g) ?? [],
      expired: request.expiresAt <= Date.now() || request.status === "expired",
      expiresLabel: formatTime(request.expiresAt, { hour: "numeric" }),
    })),
    hasRecoveryKey: recoveryStatusQuery.data?.enrolled ?? false,
    recoveryLoading: recoveryStatusQuery.isLoading,
  };
}
