import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { capabilities } from "../../platform/capabilities.js";
import { getCaptureProtection, setCaptureProtection } from "../../platform/capture-protection.js";
import { t, useLocale } from "../../i18n/index.js";
import { translateError } from "../shared/errors.js";

export interface PrivacySettings {
  discoverable: boolean;
  groupInvites: "everyone" | "contacts" | "nobody";
}

export function usePrivacySettings(active: boolean) {
  useLocale();
  const userId = useAuthStore(state => state.user?.id);
  const client = useQueryClient();
  const queryKey = ["privacy", userId];
  const query = useQuery({ queryKey, queryFn: () => api.get<PrivacySettings>("/api/account/privacy"), enabled: active && !!userId });
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const save = async (patch: Partial<PrivacySettings>) => {
    if (savingRef.current || !query.data) return false;
    savingRef.current = true; setSaving(true); setSaveError(false);
    try {
      await client.cancelQueries({ queryKey });
      const updated = await api.patch<PrivacySettings>("/api/account/privacy", patch);
      client.setQueryData(queryKey, updated);
      return true;
    } catch { setSaveError(true); return false; }
    finally { savingRef.current = false; setSaving(false); }
  };
  const captureCapability = capabilities.captureProtection;
  const captureKey = ["capture-protection"];
  const captureQuery = useQuery({
    queryKey: captureKey,
    queryFn: getCaptureProtection,
    enabled: active && !!captureCapability,
    networkMode: "always",
    staleTime: Infinity,
    retry: false,
  });
  const [captureBusy, setCaptureBusy] = useState(false);
  const captureBusyRef = useRef(false);
  const [captureError, setCaptureError] = useState(false);
  const changeCapture = async (enabled: boolean) => {
    if (!captureCapability || captureQuery.data === undefined || captureQuery.isError || captureBusyRef.current) return false;
    captureBusyRef.current = true; setCaptureBusy(true); setCaptureError(false);
    try { await setCaptureProtection(enabled); client.setQueryData(captureKey, enabled); return true; }
    catch { setCaptureError(true); return false; }
    finally { captureBusyRef.current = false; setCaptureBusy(false); }
  };
  return {
    data: query.data, loading: query.isLoading, disabled: saving || !query.data || query.isError,
    error: saveError ? t("privacySaveFailed") : query.error ? translateError(query.error, "privacyLoadFailed") : null,
    save, retry: () => { setSaveError(false); void query.refetch(); },
    capture: {
      capability: captureCapability, enabled: captureQuery.isError ? undefined : captureQuery.data, busy: captureBusy,
      error: captureError || captureQuery.isError ? t("captureProtectionFailed") : null,
      retry: () => { void captureQuery.refetch(); }, setEnabled: changeCapture,
    },
  };
}
