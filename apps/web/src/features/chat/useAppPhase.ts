import { useEffect, useState } from "react";
import { useAuthStore } from "../../stores/authStore.js";
import { hasLocalKeyMaterial, keysLoaded, onKeysLocked } from "../../lib/key-manager.js";
import { useKeyMaintenance } from "../../components/app/useKeyMaintenance.js";
export type AuthPhase = "checking" | "anonymous" | "locked" | "unlocked";

export function useAuthPhase(): AuthPhase {
  const accessToken = useAuthStore((state) => state.accessToken);
  const deviceId = useAuthStore((state) => state.device?.id);
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const [phase, setPhase] = useState<AuthPhase>("checking");

  useEffect(() => {
    let cancelled = false;

    async function evaluate() {
      if (!accessToken) {
        setPhase("anonymous");
        return;
      }

      if (keysLoaded()) {
        setPhase("unlocked");
        return;
      }

      if (!deviceId) {
        setPhase("anonymous");
        return;
      }

      const hasKeys = await hasLocalKeyMaterial();
      if (!cancelled) {
        setPhase(hasKeys ? "locked" : "anonymous");
      }
    }

    setPhase("checking");
    void evaluate();

    return () => {
      cancelled = true;
    };
  }, [accessToken, authEpoch, deviceId]);

  return phase;
}

export function useAppLifecycle(phase: AuthPhase) {
  useEffect(() => onKeysLocked(() => useAuthStore.getState().bumpSessionState()), []);
  useKeyMaintenance(phase === "unlocked");
}
