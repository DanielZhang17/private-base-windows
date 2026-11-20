import { t } from "../../../i18n/index.js";
import type { useGroupCall } from "../../../features/calls/useGroupCall.js";
import { useGroupConversation } from "../../../features/calls/group-call-view.js";
import { participantName } from "./GroupCallTile.js";

type GroupCall = ReturnType<typeof useGroupCall>;

/** Localised text for the latest transient event (spec §5.2), shared by the pill and the live region. */
export function useGroupCallEventText(call: GroupCall) {
  const event = call.event;
  const conversation = useGroupConversation(call.room?.conversationId);
  if (!event) return null;
  const who = call.participants.find((participant) => participant.userId === event.userId);
  const member = conversation?.members.find((item) => item.userId === event.userId);
  const name = who ? participantName(who) : member?.user.displayName ?? t("groupCall.unknownMember");
  return event.kind === "joined" ? t("groupCall.eventJoined", { name })
    : event.kind === "left" ? t("groupCall.eventLeft", { name })
    : event.kind === "lost_connection" ? t("groupCall.eventLostConnection", { name })
    : event.kind === "removed" ? t("groupCall.eventRemoved", { name })
    : event.kind === "timed_out" ? t("groupCall.eventTimedOut", { name })
    : t("groupCall.someoneSharing", { name });
}

