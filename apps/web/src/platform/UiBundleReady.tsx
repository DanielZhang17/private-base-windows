import { useEffect } from "react";
import { getAppDB } from "../db/index.js";
import { afterPaint } from "./after-paint.js";
import { capabilities } from "./capabilities.js";
import { uiBundles } from "./updates.js";

/** Mount once at the app root, startup screens included: native waits for this import before its first OTA check. */
export function UiBundleChannelImport() {
  useEffect(() => {
    void uiBundles.initializeChannel().catch(() => {});
  }, []);
  return null;
}

/**
 * Mount inside each screen that renders real content, never beside a redirect or the
 * startup loader. The first one to paint acknowledges the OTA trial; later mounts reuse
 * the same once-per-process acknowledgement.
 */
export function UiBundleReady() {
  useEffect(() => {
    // The no-ready test build exercises native rollback of an unacknowledged trial.
    if (!capabilities.otaUi || import.meta.env.VITE_OTA_TEST_NO_READY === "1") return;
    let cancelled = false;
    // Wait until the committed screen has really painted before vouching for this bundle.
    const cancelPaint = afterPaint(() => {
      // Signed-out startup can reach a usable screen without touching IndexedDB.
      void getAppDB().then(() => {
        if (!cancelled) return uiBundles.ready();
      }).catch(() => {});
    });
    return () => { cancelled = true; cancelPaint(); };
  }, []);
  return null;
}
