import { useEffect, useState } from "react";
import { disableWebPush, enableWebPush, iosPushHint, showWebPushSettings, supportsWebPush, webPushEnabled } from "../../services/web-push.js";

export function useWebPushSettings() {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const supported = supportsWebPush();
  useEffect(() => {
    let disposed = false;
    if (supported) void webPushEnabled().then((value) => { if (!disposed) setEnabled(value); }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; };
  }, [supported]);
  const toggle = async (next: boolean) => {
    setBusy(true); setError(false);
    try {
      if (next) await enableWebPush(); else await disableWebPush();
      setEnabled(await webPushEnabled());
    } catch { setError(true); setEnabled(await webPushEnabled().catch(() => false)); }
    finally { setBusy(false); }
  };
  return { enabled, busy, error, supported, visible: showWebPushSettings(), iosHint: iosPushHint(), toggle };
}
