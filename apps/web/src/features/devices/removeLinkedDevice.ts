import { createDeviceActionPayload, deviceRemovalProofSubject } from "@e2ee-chat/shared";
import { signWithIdentityKey } from "../../lib/key-manager.js";
import { api } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";

export async function removeLinkedDevice(targetId: string): Promise<void> {
  const deviceId = useAuthStore.getState().device?.id;
  if (!deviceId) throw new Error("Missing device");
  const path = `/api/devices/${encodeURIComponent(targetId)}`;
  const { challengeId } = await api.post<{ challengeId: string }>(`${path}/remove-options`);
  const signature = await signWithIdentityKey(createDeviceActionPayload("remove_device", deviceRemovalProofSubject(deviceId, targetId), challengeId));
  await api.delete(path, { challengeId, signature });
}
