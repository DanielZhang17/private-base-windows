import { i18n, initializeLocale } from "./i18n/index.js";
import { configureNativeViewport } from "./platform/viewport.js";

/** Locale failures must never prevent the app from mounting. English is bundled. */
export async function bootstrap(render: () => void): Promise<void> {
  configureNativeViewport();
  try {
    await initializeLocale();
  } catch {
    try {
      await i18n.changeLanguage("en");
    } catch {
      // Still mount if the language engine itself fails during fallback.
    }
  } finally {
    render();
  }
}
