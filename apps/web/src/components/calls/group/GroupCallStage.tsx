import { useMatchMedia } from "../../../features/calls/group-call-view.js";
import type { GroupCallLayout } from "../../../features/calls/group-call-store.js";
import GroupCallTile, { type GroupParticipant } from "./GroupCallTile.js";

interface Props {
  participants: GroupParticipant[];
  layout: GroupCallLayout;
  /** Pinned user, else screen sharer, else active speaker, else first tile (from useGroupCall). */
  spotlightUserId: string | null;
  pinnedUserId: string | null;
  onPin: (userId: string | null) => void;
  controlsVisible: boolean;
}

export function usePhonePortrait() {
  return useMatchMedia("(max-width: 639px) and (orientation: portrait)");
}

function visibleSharer(participants: GroupParticipant[]) {
  return participants.find((participant) => participant.screen && participant.media?.sharing);
}

/** Spotlight when pinned or someone shares (any layout, spec §2.2), when chosen, or automatically on portrait phones with 5+ remote tiles. */
export function isSpotlight(participants: GroupParticipant[], layout: GroupCallLayout, pinnedUserId: string | null, phonePortrait: boolean) {
  if (!participants.length) return false;
  if (pinnedUserId || visibleSharer(participants)) return true;
  if (layout === "spotlight") return participants.length > 1;
  return layout === "auto" && phonePortrait && participants.length >= 5;
}

/** Grid column count by remote participant count (spec §2.2). Rows with fewer tiles are centred by the flex wrap. */
function gridColumns(count: number, phonePortrait: boolean) {
  if (count <= 1) return 1;
  if (phonePortrait) return count === 2 ? 1 : 2;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  return 4;
}

export default function GroupCallStage({ participants, layout, spotlightUserId, pinnedUserId, onPin, controlsVisible }: Props) {
  const phonePortrait = usePhonePortrait();
  const count = participants.length;
  if (!count) return null;
  const tile = (participant: GroupParticipant, variant: "grid" | "main" | "strip", screen = false) => <GroupCallTile
    key={`${participant.userId}:${screen ? "screen" : "camera"}`} participant={participant} variant={variant} screen={screen}
    pinned={pinnedUserId === participant.userId} onPin={onPin} controlsVisible={controlsVisible} />;

  if (!isSpotlight(participants, layout, pinnedUserId, phonePortrait)) {
    const columns = gridColumns(count, phonePortrait);
    const rows = Math.ceil(count / columns);
    return <div className="flex h-full w-full flex-wrap content-center items-center justify-center gap-2 p-2 sm:p-4">
      {participants.map((participant) => <div key={participant.userId}
        style={{ width: `calc((100% - ${(columns - 1) * 0.5}rem) / ${columns})`, height: `calc((100% - ${(rows - 1) * 0.5}rem) / ${rows})` }}
        // Phones fill the cell; wider screens fit and centre a true 16:9 tile by both width and height (container units).
        className="flex min-h-0 min-w-0 items-center justify-center [container-type:size]">
        <div className={phonePortrait ? "h-full w-full" : "aspect-video w-[min(100cqw,calc(100cqh*16/9))]"}>{tile(participant, "grid")}</div>
      </div>)}
    </div>;
  }

  // Spotlight: one main tile (pinned > screen share > active speaker) plus a filmstrip. Strip order never changes.
  const sharer = !pinnedUserId ? visibleSharer(participants) : undefined;
  const main = participants.find((participant) => participant.userId === pinnedUserId) ?? sharer
    ?? participants.find((participant) => participant.userId === spotlightUserId) ?? participants[0]!;
  const showScreen = !!main.screen && !!main.media?.sharing && (!pinnedUserId || !!sharer);
  const strip = participants.filter((participant) => showScreen || participant.userId !== main.userId);
  return <div className="flex h-full w-full flex-col gap-2 p-2 sm:p-4">
    <div className="min-h-0 flex-1">{tile(main, "main", showScreen)}</div>
    {strip.length > 0 && <div role="list" data-call-filmstrip="" className="flex shrink-0 justify-center-safe gap-2 overflow-x-auto pb-1">
      {strip.map((participant) => <div role="listitem" key={participant.userId} className="shrink-0">{tile(participant, "strip")}</div>)}
    </div>}
  </div>;
}
