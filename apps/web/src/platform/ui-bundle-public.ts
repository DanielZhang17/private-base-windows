import { afterPaint } from "./after-paint.js";
import { capabilities } from "./capabilities.js";
import { uiBundles } from "./updates.js";

/**
 * Native direct entry to the public /clients pages (main.tsx → ClientsApp). Imports the
 * saved channel and, once the page has painted, acknowledges the OTA trial. There is no
 * IndexedDB check: this entry never opens the database, so the rendered page is the proof.
 * Returns a cleanup that cancels a pending acknowledgement.
 */
export function startPublicUiBundle(): () => void {
  if (!capabilities.otaUi) return () => {};
  void uiBundles.initializeChannel().catch(() => {});
  if (import.meta.env.VITE_OTA_TEST_NO_READY === "1") return () => {};
  return afterPaint(() => { void uiBundles.ready()?.catch(() => {}); });
}
