import { useEffect } from "react";
import ClientsPage from "./pages/ClientsPage.js";
import { isNative } from "./platform/environment.js";
import { ToastProvider } from "./ui/index.js";

/**
 * Standalone root for a direct visit to /clients. Unlike App it mounts no auth phase,
 * key, session-repair, push, call or sync effects, and imports no stores or crypto.
 * The theme follows the system preference through the CSS tokens.
 */
export default function ClientsApp() {
  // A native load or reload of /clients still owes the OTA shell its channel import and
  // readiness. Only the platform module is loaded, and never in a browser.
  useEffect(() => {
    if (!isNative()) return;
    let stop: (() => void) | undefined;
    let mounted = true;
    void import("./platform/ui-bundle-public.js").then(({ startPublicUiBundle }) => {
      if (mounted) stop = startPublicUiBundle();
    });
    return () => { mounted = false; stop?.(); };
  }, []);
  return (
    <ToastProvider>
      <ClientsPage />
    </ToastProvider>
  );
}
