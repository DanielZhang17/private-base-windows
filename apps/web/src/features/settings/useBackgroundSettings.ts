import { useEffect, useState, useSyncExternalStore } from "react";
import { capabilities } from "../../platform/capabilities.js";
import { openBackgroundSettings } from "../../platform/android-background.js";
import { backgroundSnapshot, refreshBackgroundStatus, setStayConnected, subscribeBackground } from "../../platform/android-background-service.js";

export function useBackgroundSettings() {
  const state = useSyncExternalStore(subscribeBackground, backgroundSnapshot);
  const [settingsError, setSettingsError] = useState(false);
  const supported = capabilities.backgroundConnection;
  useEffect(() => { if (supported) void refreshBackgroundStatus(); }, [supported]);
  const openSettings = async (setting: "battery" | "fullScreen") => {
    setSettingsError(false);
    try { await openBackgroundSettings(setting); } catch { setSettingsError(true); }
  };
  return { ...state, supported, error: state.error || settingsError, setEnabled: setStayConnected, openSettings };
}
