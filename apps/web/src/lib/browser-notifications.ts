import { t } from "../i18n/index.js";
import { notify } from "../platform/notifications.js";
import { navigate } from "../platform/navigation.js";

export { requestNotificationPermission } from "../platform/notifications.js";

export function showMessageNotification(
  senderName: string,
  conversationId: string,
): void {
  void notify({
    title: t("newMessageNotification", { name: senderName }),
    tag: conversationId,
    icon: "/favicon.ico",
    onClick: () => {
      window.focus();
      navigate(`/chat/${conversationId}`);
    },
  }).catch((error: unknown) => console.error("Message notification failed", error));
}
