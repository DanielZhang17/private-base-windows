import { LocalizedError } from "../i18n/messages.js";
import { isNative } from "./environment.js";

export async function openExternal(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new LocalizedError("externalLinksMustUseHttpOrHttps");
  }
  if (isNative()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(parsed.href);
  } else {
    window.open(parsed.href, "_blank", "noopener,noreferrer");
  }
}
