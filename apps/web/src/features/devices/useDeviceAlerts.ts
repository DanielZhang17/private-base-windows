import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createDeviceActionPayload, deviceAlertActionProofContext, type DeviceAlert, type DeviceLimitEntry } from "@e2ee-chat/shared";
import { signWithIdentityKey } from "../../lib/key-manager.js";
import { api } from "../../services/api.js";
import { subscribeToDeviceAlerts } from "../../services/device-alerts.js";
import { useAuthStore } from "../../stores/authStore.js";

export function useDeviceAlerts(active = true) {
  const deviceId = useAuthStore(state => state.device?.id);
  const userId = useAuthStore(state => state.user?.id);
  const client = useQueryClient();
  const queryKey = ["device-alerts", deviceId];
  const query = useQuery({
    queryKey, enabled: active && !!deviceId,
    queryFn: () => api.get<DeviceAlert[]>("/api/devices/alerts"),
  });
  useEffect(() => {
    if (!active || !deviceId) return;
    return subscribeToDeviceAlerts((recipient, kind) => {
      if (recipient !== deviceId) return;
      void client.invalidateQueries({ queryKey: ["device-alerts", deviceId] });
      if (!kind || kind === "approval_disabled") void client.invalidateQueries({ queryKey: ["privacy", userId] });
      if (!kind || kind !== "approval_disabled") void client.invalidateQueries({ queryKey: ["myDevices"] });
    });
  }, [active, client, deviceId, userId]);
  const respond = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: "ack" | "not-me" }) => {
      if (!deviceId) throw new Error("Missing device");
      const path = `/api/devices/alerts/${encodeURIComponent(id)}/${action}`;
      const { challengeId } = await api.post<{ challengeId: string }>(`${path}/options`);
      const context = deviceAlertActionProofContext(action, deviceId, id);
      const signature = await signWithIdentityKey(createDeviceActionPayload(context.action, context.subject, challengeId));
      return api.post<{ success: true; devicesAddedSince?: DeviceLimitEntry[]; credential?: {
        id: string; credentialId: string; name: string; createdAt: number;
      } | null }>(path, { challengeId, signature });
    },
    onSuccess: async (_, { action }) => {
      await client.invalidateQueries({ queryKey });
      if (action === "not-me") await client.invalidateQueries({ queryKey: ["myDevices"] });
    },
  });
  return {
    alerts: Array.isArray(query.data) ? query.data : [],
    loading: query.isLoading,
    error: respond.error ?? query.error,
    responding: respond.isPending,
    retry: query.refetch,
    acknowledge: (id: string) => respond.mutateAsync({ id, action: "ack" }),
    revokeAsNotMe: (id: string) => respond.mutateAsync({ id, action: "not-me" }),
  };
}
