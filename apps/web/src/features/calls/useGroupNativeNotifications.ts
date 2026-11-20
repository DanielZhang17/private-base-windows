import { useEffect } from "react";
import { t } from "../../i18n/index.js";
import { keysLoaded } from "../../lib/key-manager.js";
import { capabilities } from "../../platform/capabilities.js";
import { getCachedConversation } from "../../lib/conversation-cache.js";
import { navigate } from "../../platform/navigation.js";
import { groupCallActions, useGroupCallStore } from "./group-call-store.js";

const channelId = "group-call-status";

/** The Android background service is owned by UnlockedAppEffects. The call adds
 * its own notification and actions through the platform's notification plugin. */
export function useGroupNativeNotifications(enabled: boolean) {
  const callId = useGroupCallStore((state) => state.session?.room.id);
  useEffect(() => {
    if (!enabled || !callId || !capabilities.nativeCallNotifications) return;
    let stopped = false;
    let dispose = () => {};
    const id = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
    void (async () => {
      const native = await import("@tauri-apps/plugin-notification");
      if (stopped || !await native.isPermissionGranted()) return;
      await native.createChannel({ id: channelId, name: t("callScreenTitle"), importance: native.Importance.Low, visibility: native.Visibility.Private });
      for (const muted of [false, true]) {
        if (stopped) return;
        await native.registerActionTypes([{ id: muted ? "group-call-muted" : "group-call-unmuted", actions: [
          { id: "group-call-toggle-mute", title: t(muted ? "unmuteMicrophone" : "muteMicrophone") },
          { id: "group-call-leave", title: t("groupCall.leave") },
        ] }]);
      }
      if (stopped) return;
      const listener = await native.onAction((event) => {
        const live = useGroupCallStore.getState().session;
        if (stopped || event.notification?.id !== id || live?.room.id !== callId) return;
        if (event.actionId === "group-call-toggle-mute") groupCallActions.toggleMute();
        else if (event.actionId === "group-call-leave") void groupCallActions.leave();
        else if (event.actionId === "tap") groupCallActions.restore();
      });
      if (stopped) { await listener.unregister(); return; }

      let revision = "";
      const update = () => {
        const live = useGroupCallStore.getState().session;
        if (stopped || live?.room.id !== callId) return;
        const room = live.room;
        const group = getCachedConversation(room.conversationId)?.name ?? t("callScreenTitle");
        const count = room.participants.length;
        const muted = live.media.muted;
        const next = JSON.stringify([group, count, muted]);
        if (next === revision) return;
        revision = next;
        native.sendNotification({ id, channelId, title: group, body: t("groupCall.ongoingPeople", { count }),
          ongoing: true, autoCancel: false, when: room.startedAt, usesChronometer: true,
          actionTypeId: muted ? "group-call-muted" : "group-call-unmuted" });
      };
      const unsubscribe = useGroupCallStore.subscribe(update);
      dispose = () => {
        unsubscribe();
        void listener.unregister().catch(() => undefined);
        void native.removeActive([{ id }]).catch(() => undefined);
      };
      update();
    })().catch(() => undefined);
    return () => { stopped = true; dispose(); };
  }, [enabled, callId]);

  useEffect(() => {
    if (!enabled || !capabilities.nativeCallNotifications) return;
    let stopped = false;
    const unsubscribe = useGroupCallStore.subscribe((state, previous) => {
      if (!keysLoaded()) return;
      if (state.invitations === previous.invitations && state.notice === previous.notice) return;
      const now = Date.now();
      const missed = previous.invitations.find((invite) => invite.ringUntil <= now && invite.ringUntil > now - 30_000
        && !state.invitations.some((current) => current.callId === invite.callId) && state.session?.room.id !== invite.callId);
      const quiet = state.notice !== previous.notice && state.notice?.kind === "quiet" && document.hidden ? state.notice : null;
      const conversationId = missed?.conversationId ?? quiet?.conversationId;
      if (!conversationId) return;
      void (async () => {
        const native = await import("@tauri-apps/plugin-notification");
        if (stopped || !await native.isPermissionGranted()) return;
        await native.createChannel({ id: channelId, name: t("callScreenTitle"), importance: native.Importance.Low, visibility: native.Visibility.Private });
        if (stopped) return;
        const id = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
        native.sendNotification({ id, channelId,
          title: t(missed ? "groupCall.missed" : "groupCall.inProgress"), body: getCachedConversation(conversationId)?.name ?? undefined });
        const timeout = setTimeout(() => void listener.then((handle) => handle.unregister()).catch(() => undefined), 60_000);
        const listener = native.onAction((event) => {
          if (stopped || event.notification?.id !== id || event.actionId !== "tap") return;
          navigate(`/chat/${encodeURIComponent(conversationId)}`);
          clearTimeout(timeout);
          void listener.then((handle) => handle.unregister()).catch(() => undefined);
        });
        void listener.catch(() => clearTimeout(timeout));
      })().catch(() => undefined);
    });
    return () => { stopped = true; unsubscribe(); };
  }, [enabled]);
}
