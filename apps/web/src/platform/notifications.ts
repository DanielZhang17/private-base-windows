import { getLocale, t, type Locale } from "../i18n/index.js";
import { isNative } from "./environment.js";

export interface NotificationOptions {
  title: string;
  body?: string;
  onClick?: () => void;
  tag?: string;
  icon?: string;
}

let nextId = Date.now() % 0x7fffffff;
const clickHandlers = new Map<number, () => void>();
let actionListener: Promise<unknown> | undefined;
let actionTypes: { locale: Locale; registered: Promise<void> } | undefined;
const OPEN_ACTION = "e2ee-open";

// Native passive requests may prompt once per session. Browser prompts require a gesture.
let passivePromptUsed = false;

async function ensurePermission(passive: boolean): Promise<boolean> {
  // No await may separate this check from the set, or concurrent messages would each prompt.
  const mayPrompt = () => {
    if (!passive) return true;
    if (passivePromptUsed) return false;
    passivePromptUsed = true;
    return true;
  };
  if (isNative()) {
    const plugin = await import("@tauri-apps/plugin-notification");
    if (await plugin.isPermissionGranted()) return true;
    return mayPrompt() && await plugin.requestPermission() === "granted";
  }
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return !passive && await Notification.requestPermission() === "granted";
}

/** An explicit request: prompts whenever the permission is still undecided. */
export function requestNotificationPermission(): Promise<boolean> {
  return ensurePermission(false);
}

/**
 * Returns false when notifications are unavailable or permission is absent. Native clients may
 * prompt once per session; browsers request permission only through explicit settings gestures.
 */
export async function notify(options: NotificationOptions): Promise<boolean> {
  if (!await ensurePermission(true)) return false;

  if (isNative()) {
    const plugin = await import("@tauri-apps/plugin-notification");
    const id = nextId++;
    if (options.onClick) {
      const locale = getLocale();
      if (actionTypes?.locale !== locale) {
        // Serialize replacements so a slower registration cannot restore an older language.
        const registered = (actionTypes?.registered.catch(() => undefined) ?? Promise.resolve())
          .then(() => plugin.registerActionTypes([{
            id: OPEN_ACTION,
            actions: [{ id: "open", title: t("openNotificationAction", { lng: locale }), foreground: true }],
          }])).catch((error: unknown) => {
            if (actionTypes?.registered === registered) actionTypes = undefined;
            throw error;
          });
        actionTypes = { locale, registered };
      }
      await actionTypes.registered;
      actionListener ??= plugin.onAction((event) => {
        const notificationId = event.notification?.id;
        if (notificationId == null) return;
        const callback = clickHandlers.get(notificationId);
        clickHandlers.delete(notificationId);
        callback?.();
      }).catch((error: unknown) => {
        actionListener = undefined;
        throw error;
      });
      await actionListener;
      // Dismissed notifications do not always emit an event. Bound their callbacks.
      if (clickHandlers.size >= 100) clickHandlers.delete(clickHandlers.keys().next().value!);
      clickHandlers.set(id, options.onClick);
    }
    plugin.sendNotification({ id, title: options.title, body: options.body, actionTypeId: options.onClick ? OPEN_ACTION : undefined });
    return true;
  }

  const notification = new Notification(options.title, {
    body: options.body,
    tag: options.tag,
    icon: options.icon,
  });
  notification.onclick = () => {
    notification.close();
    options.onClick?.();
  };
  return true;
}
