import { useEffect, useState, useSyncExternalStore } from "react";
import { useAuthStore } from "../../stores/authStore.js";
import { getLocalKeyOwner, hasLocalKeyMaterial, keysLoaded, onKeysLocked, retryNativeKeyCleanup } from "../../lib/key-manager.js";
import { isDatabaseUpgradeBlocked, readPendingSetupRecord, subscribeDatabaseUpgrade } from "../../db/index.js";
import { useKeyMaintenance } from "../../components/app/useKeyMaintenance.js";
import { capabilities } from "../../platform/capabilities.js";

export type AuthPhase = "checking" | "database-blocked" | "database-error" | "anonymous" | "locked" | "unlocked";

export function useDatabaseUpgradeBlocked(): boolean {
  return useSyncExternalStore(subscribeDatabaseUpgrade, isDatabaseUpgradeBlocked);
}

export function useAuthPhase(): AuthPhase {
  const authenticated = useAuthStore((state) => !!state.accessToken);
  const deviceId = useAuthStore((state) => state.device?.id);
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const [phase, setPhase] = useState<AuthPhase>("checking");
  const upgradeBlocked = useDatabaseUpgradeBlocked();

  useEffect(() => {
    let cancelled = false;

    async function evaluate() {
      if (!authenticated || !deviceId) {
        setPhase("anonymous");
        return;
      }

      const hasKeys = await hasLocalKeyMaterial();
      if (!hasKeys) {
        if (!cancelled) setPhase("anonymous");
        return;
      }
      const [setup, owner] = await Promise.all([readPendingSetupRecord(), getLocalKeyOwner()]);
      if (cancelled) return;
      const pending = setup?.stage === "unlockReady" || (setup?.stage === "complete" && setup.deviceId !== deviceId);
      if (pending || (owner?.deviceId && owner.deviceId !== deviceId)) setPhase("anonymous");
      else setPhase(keysLoaded() ? "unlocked" : "locked");
    }

    setPhase("checking");
    void evaluate().catch(() => { if (!cancelled) setPhase("database-error"); });

    return () => {
      cancelled = true;
    };
  }, [authenticated, authEpoch, deviceId]);

  return phase === "checking" && upgradeBlocked ? "database-blocked" : phase;
}

export function useAppLifecycle(phase: AuthPhase) {
  useEffect(() => onKeysLocked(() => useAuthStore.getState().bumpSessionState()), []);
  useEffect(() => { if (capabilities.biometricUnlock) void retryNativeKeyCleanup().catch(() => undefined); }, []);
  useKeyMaintenance(phase === "unlocked");
}
