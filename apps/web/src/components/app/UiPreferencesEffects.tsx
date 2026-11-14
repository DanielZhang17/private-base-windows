import { useEffect, useState } from "react";
import { useAuthStore } from "../../stores/authStore.js";
import { useUiPreferencesStore } from "../../stores/uiPreferencesStore.js";
import {
  getDefaultUiPreferences,
  getReadableTextColor,
  resolveTheme,
} from "../../lib/ui-preferences.js";

export default function UiPreferencesEffects() {
  const userId = useAuthStore((state) => state.user?.id);
  const [prefersDark, setPrefersDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const getPreferencesForUser = useUiPreferencesStore((state) => state.getPreferencesForUser);
  const preferences = getPreferencesForUser(userId, prefersDark);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    mediaQuery.addEventListener("change", listener);
    setPrefersDark(mediaQuery.matches);
    return () => mediaQuery.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    const resolvedTheme = resolveTheme(preferences.themeMode, prefersDark);
    const defaults = getDefaultUiPreferences(resolvedTheme);
    const outgoing = preferences.outgoingMessageColor || defaults.outgoingMessageColor;
    const incoming = preferences.incomingMessageColor || defaults.incomingMessageColor;
    const send = preferences.sendButtonColor || defaults.sendButtonColor;

    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    const themeColor = resolvedTheme === "dark" ? "#0e171c" : "#eef2f3";
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
      meta.content = themeColor;
      // A forced preference must override the browser's OS-colour media query.
      if (preferences.themeMode === "system") {
        const media = meta.dataset.systemMedia;
        if (media) meta.setAttribute("media", media);
        const systemMedia = meta.getAttribute("media") ?? "";
        if (systemMedia.includes("dark")) meta.content = "#0e171c";
        else if (systemMedia.includes("light")) meta.content = "#eef2f3";
      } else {
        const media = meta.getAttribute("media");
        if (media) meta.dataset.systemMedia = media;
        meta.removeAttribute("media");
      }
    });
    root.style.setProperty("--message-own-bg", outgoing);
    root.style.setProperty("--message-own-fg", getReadableTextColor(outgoing));
    root.style.setProperty("--message-incoming-bg", incoming);
    root.style.setProperty("--message-incoming-fg", getReadableTextColor(incoming));
    root.style.setProperty("--send-button-bg", send);
    root.style.setProperty("--send-button-fg", getReadableTextColor(send));
  }, [preferences, prefersDark]);

  return null;
}
