import { useEffect } from "react";
import type { Device, User } from "@e2ee-chat/shared";
import { api } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";

interface SessionStateResponse {
  user: User;
  device: Device;
}

export default function SessionRepairEffects() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const user = useAuthStore((state) => state.user);
  const deviceId = useAuthStore((state) => state.device?.id);
  const repairSessionIdentity = useAuthStore((state) => state.repairSessionIdentity);

  useEffect(() => {
    if (!accessToken || !deviceId || user) return;

    let cancelled = false;

    void api.get<SessionStateResponse>("/api/account/session")
      .then((session) => {
        if (cancelled) return;
        repairSessionIdentity(session);
      })
      .catch((error) => {
        console.error("Failed to repair session identity", error);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, deviceId, repairSessionIdentity, user]);

  return null;
}
