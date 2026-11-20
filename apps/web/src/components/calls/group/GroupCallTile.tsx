import { t, useLocale } from "../../../i18n/index.js";
import { useMediaElement } from "../../../features/calls/useMediaElement.js";
import type { useGroupCall } from "../../../features/calls/useGroupCall.js";
import { Icon, IconButton, Spinner, cx } from "../../../ui/index.js";
import UserAvatar from "../../avatar/UserAvatar.js";

export type GroupParticipant = ReturnType<typeof useGroupCall>["participants"][number];

interface Props {
  participant: GroupParticipant;
  /** Main slot in Spotlight, or any Grid cell. Filmstrip tiles are compact. */
  variant: "grid" | "main" | "strip";
  /** Render the shared screen instead of the camera. */
  screen?: boolean;
  pinned: boolean;
  onPin: (userId: string | null) => void;
  /** Whether call controls are currently shown (pin button follows them on touch screens). */
  controlsVisible: boolean;
}

export function participantName(participant: GroupParticipant) {
  return participant.displayName ?? t("groupCall.unknownMember");
}

/** One remote participant. The tile is not a button: taps on the stage toggle the controls, as in 1:1 calls. */
export default function GroupCallTile({ participant, variant, screen = false, pinned, onPin, controlsVisible }: Props) {
  useLocale();
  const name = participantName(participant);
  const stream = screen ? participant.screen : participant.stream;
  const showVideo = !!stream && participant.stage === "live" && (screen
    || (participant.media?.cameraOff === false && participant.media.receivingVideo !== false && !participant.videoPaused));
  const { ref } = useMediaElement<HTMLVideoElement>(showVideo ? stream : null, true);
  const muted = participant.media?.muted === true;
  const cameraOff = !screen && participant.media?.cameraOff === true;
  const reconnecting = participant.stage === "reconnecting" || participant.keyWaiting;
  const connecting = participant.stage === "connecting";
  const strip = variant === "strip";
  const label = screen ? t("groupCall.screenOf", { name }) : [
    name,
    muted && t("groupCall.state.muted"),
    cameraOff && t("groupCall.state.cameraOff"),
    participant.speaking && t("groupCall.state.speaking"),
    participant.quality === "poor" && t("groupCall.poorConnection"),
    reconnecting && t("groupCall.state.reconnecting"),
  ].filter(Boolean).join(", ");

  return <div role="group" aria-label={label} data-speaking={participant.speaking && !screen ? "" : undefined}
    className={cx(
      "group/tile relative isolate min-h-0 min-w-0 overflow-hidden rounded-card bg-sunken",
      strip ? "aspect-video w-36 shrink-0 sm:w-44" : "h-full w-full",
      // Static speaking ring, inset so it never changes the tile size (no layout shift, no pulse).
      "after:pointer-events-none after:absolute after:inset-0 after:rounded-card after:ring-2 after:ring-inset after:ring-transparent",
      participant.speaking && !screen && "after:ring-brand",
    )}>
    {showVideo
      ? <video ref={ref} autoPlay muted playsInline aria-hidden="true"
          className={cx("absolute inset-0 h-full w-full bg-sunken", screen ? "object-contain" : "object-cover")} />
      : <div className="absolute inset-0 flex items-center justify-center">
          <UserAvatar avatarUrl={participant.avatarUrl} displayName={name} size={strip ? "sm" : "lg"} />
        </div>}

    {(reconnecting || connecting) && <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-scrim text-center">
      <Spinner size={strip ? 16 : 24} label={participant.keyWaiting ? t("groupCall.tileKeyWaiting") : connecting ? t("connecting") : t("callReconnecting")} />
      {!strip && <span className="px-3 text-sm text-ink">{participant.keyWaiting ? t("groupCall.tileKeyWaiting") : connecting ? t("connecting") : t("callReconnecting")}</span>}
    </div>}

    {participant.quality === "poor" && !reconnecting && !strip && <span className="absolute start-2 top-2 inline-flex items-center gap-1 rounded-control bg-warn-soft px-2 py-1 text-xs font-semibold text-warn">
      <Icon name="signal" size={16} />{t("groupCall.poorConnection")}
    </span>}

    {!strip && !screen && <div className={cx(
      "absolute end-2 top-2 transition-opacity",
      pinned || controlsVisible ? "opacity-100" : "opacity-0 pointer-fine:group-hover/tile:opacity-100 focus-within:opacity-100",
    )}>
      <IconButton size="sm" variant="secondary" icon={pinned ? "pin-off" : "pin"} aria-pressed={pinned}
        label={pinned ? t("groupCall.unpinName", { name }) : t("groupCall.pinName", { name })}
        onClick={(event) => { event.stopPropagation(); onPin(pinned ? null : participant.userId); }} />
    </div>}

    <span className={cx(
      "absolute bottom-2 start-2 inline-flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-control bg-raised px-2 py-1 text-xs font-semibold text-ink",
      strip && "bottom-1 start-1 max-w-[calc(100%-0.5rem)] px-1.5 py-0.5",
    )}>
      {muted && !screen && <Icon name="mic-off" size={16} className="shrink-0" />}
      <span className="truncate">{screen ? t("groupCall.screenOf", { name }) : name}</span>
    </span>
  </div>;
}
