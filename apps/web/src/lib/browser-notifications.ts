import { t } from "../i18n/index.js";
import { notify } from "../platform/notifications.js";
import { isNative } from "../platform/environment.js";
import { navigate } from "../platform/navigation.js";
import { capabilities } from "../platform/capabilities.js";
import { showMessageNotification as showNativeMessageNotification } from "../platform/android-background.js";

export { requestNotificationPermission } from "../platform/notifications.js";

export function showMessageNotification(
  senderName: string,
  conversationId: string,
  decryptedPreview?: "sticker",
): void {
  if (capabilities.nativeCallNotifications && document.hidden) {
    void showNativeMessageNotification(conversationId, senderName).catch(() => undefined);
    return;
  }
  void notify({
    title: t("newMessageNotification", { name: senderName }),
    ...(decryptedPreview === "sticker" && !isNative() ? { body: t("stickerPreview") } : {}),
    tag: conversationId,
    icon: "/favicon.ico",
    onClick: () => {
      window.focus();
      navigate(`/chat/${conversationId}`);
    },
  }).catch((error: unknown) => console.error("Message notification failed", error));
}
