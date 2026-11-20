import type { GroupCallErrorCode, GroupCallExitReason } from "@e2ee-chat/shared";
import type { TranslationKey } from "../../i18n/index.js";

export const groupCallErrorTranslation = {
  call_disabled: "groupCall.unavailable",
  call_capability_required: "encryptedCallsArenTSupportedOnThisDevice",
  call_not_member: "groupCall.notMember",
  call_timed_out: "groupTimedOut",
  call_needs_members: "groupCall.needsMembers",
  call_full: "groupCall.full",
  call_unavailable: "callEnded",
  call_forbidden: "groupCall.forbidden",
  call_invalid_ring: "groupCall.invalidRing",
  call_already_in_progress: "groupCall.alreadyInCall",
  call_network: "callSignalingFailed",
  call_invitation_pending: "preparingSecureCallInvite",
} as const satisfies Record<GroupCallErrorCode, TranslationKey>;

export const groupCallExitTranslation = {
  empty: "callEnded",
  alone: "callEnded",
  left: "callEnded",
  lost_connection: "connectionFailed",
  timed_out: "groupTimedOut",
  ended_for_everyone: "groupCall.endedForEveryone",
  group_deleted: "groupCall.groupDeleted",
  removed: "groupCall.removedFromGroup",
  moved: "groupCall.movedToOtherDevice",
} as const satisfies Record<GroupCallExitReason, TranslationKey>;
