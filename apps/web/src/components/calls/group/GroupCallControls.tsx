import { useId, useRef, useState } from "react";
import { t, useLocale } from "../../../i18n/index.js";
import type { useGroupCall } from "../../../features/calls/useGroupCall.js";
import { ActionMenu, CountBadge, IconButton, type ActionMenuItem, type ActionMenuPosition } from "../../../ui/index.js";
import { participantName } from "./GroupCallTile.js";

type GroupCall = ReturnType<typeof useGroupCall>;

interface Props {
  call: GroupCall;
  session: NonNullable<GroupCall["session"]>;
  onOpenParticipants: () => void;
  participantsButtonRef: React.RefObject<HTMLButtonElement | null>;
}

const toggled = "aria-pressed:bg-ink aria-pressed:text-canvas";
// 56 px controls; 44 px with 8 px gaps on portrait phones and short windows so the row (incl. Leave) fits 390 px.
const compact = "max-sm:portrait:size-11 [@media(max-height:400px)]:size-11";

export default function GroupCallControls({ call, session, onOpenParticipants, participantsButtonRef }: Props) {
  useLocale();
  const { actions } = call;
  const shareReasonId = useId();
  const video = session.room.type === "video";
  const media = session.media;
  const sharer = call.participants.find((participant) => participant.userId === session.screenShareOwnerId);
  const someoneElseSharing = !!session.screenShareOwnerId && !!sharer;
  const sharing = !!media.sharing;
  const inCall = call.participants.length + 1;
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<ActionMenuPosition | null>(null);
  const micBlocked = session.mediaError === "microphone";

  const items: ActionMenuItem[] = [
    ...(["auto", "grid", "spotlight"] as const).map((layout, index): ActionMenuItem => ({
      id: `layout-${layout}`, checked: call.layout === layout,
      label: t(layout === "auto" ? "groupCall.layoutAuto" : layout === "grid" ? "groupCall.layoutGrid" : "groupCall.layoutSpotlight"),
      hint: index === 0 ? t("groupCall.layout") : undefined,
      onSelect: () => actions.setLayout(layout),
    })),
    { id: "self-view", separatorBefore: true, icon: call.selfViewHidden ? "eye" : "eye-off",
      label: call.selfViewHidden ? t("groupCall.showSelfView") : t("groupCall.hideSelfView"),
      onSelect: () => actions.setSelfViewHidden(!call.selfViewHidden) },
    ...(video && session.cameras.length > 2 ? session.cameras.map((camera, index): ActionMenuItem => ({
      id: `camera-${camera.id}`, separatorBefore: index === 0, checked: session.cameraId === camera.id,
      label: camera.label || t("callCameraNumber", { number: index + 1 }), onSelect: () => void actions.selectCamera(camera.id),
    })) : []),
  ];

  return <div className="flex flex-wrap items-center justify-center gap-4 max-sm:portrait:gap-2 [@media(max-height:400px)]:gap-2">
    {/* Privacy-reducing controls (mute, camera off, stop sharing, leave) are never blocked by pending work. */}
    <IconButton icon={media.muted || micBlocked ? "mic-off" : "mic"} size="lg" variant="secondary" className={`${toggled} ${compact}`}
      label={micBlocked ? t("groupCall.microphoneDenied") : media.muted ? t("unmuteMicrophone") : t("muteMicrophone")}
      aria-pressed={media.muted || micBlocked}
      onClick={() => { if (micBlocked) void actions.retryMicrophone(); else actions.toggleMute(); }} />
    {video && <IconButton icon={media.cameraOff ? "video-off" : "video"} size="lg" variant="secondary" className={`${toggled} ${compact}`}
      label={media.cameraOff ? t("turnOnCamera") : t("turnOffCamera")} aria-pressed={!!media.cameraOff}
      onClick={() => void actions.toggleCamera()} />}
    {video && session.cameras.length === 2 && <IconButton icon="transfer" size="lg" variant="secondary" className={compact}
      label={t("callSwitchCamera")} disabled={!!media.cameraOff}
      onClick={() => { const next = session.cameras.find((camera) => camera.id !== session.cameraId); if (next) void actions.selectCamera(next.id); }} />}
    {video && (session.canShareScreen || sharing) && <>
      {someoneElseSharing && !sharing && <span id={shareReasonId} className="sr-only">{t("groupCall.someoneSharing", { name: participantName(sharer!) })}</span>}
      <IconButton icon="monitor" size="lg" variant="secondary" className={`${toggled} ${compact} ${someoneElseSharing && !sharing ? "opacity-50" : ""}`}
        label={sharing ? t("stopSharingScreen") : t("shareScreen")} aria-pressed={sharing}
        aria-disabled={!sharing && someoneElseSharing ? true : undefined} aria-describedby={!sharing && someoneElseSharing ? shareReasonId : undefined}
        onClick={() => { if (sharing || !someoneElseSharing) void actions.toggleScreenShare(); }} />
    </>}
    <span className="relative inline-flex">
      <IconButton ref={participantsButtonRef} icon="users" size="lg" variant="secondary" aria-haspopup="dialog" className={compact}
        label={t("groupCall.participantsLabel", { count: inCall })} onClick={onOpenParticipants} />
      <CountBadge count={inCall} label={t("groupCall.participantsLabel", { count: inCall })} className="pointer-events-none absolute -end-1 -top-1" />
    </span>
    {/* More and Leave wrap together, so Leave is never alone on a second row. */}
    <span className="inline-flex items-center gap-4 max-sm:portrait:gap-2 [@media(max-height:400px)]:gap-2">
      <IconButton ref={moreRef} icon="more" size="lg" variant="secondary" aria-haspopup="menu" aria-expanded={!!menu} label={t("groupCall.more")} className={compact}
        onClick={(event) => {
          const box = moreRef.current?.getBoundingClientRect();
          setMenu(box ? { x: box.right, y: box.top, top: box.top, source: "button", align: "end", keyboard: event.detail === 0 } : { x: 0, y: 0 });
        }} />
      <IconButton icon="phone-off" size="lg" variant="danger" label={t("groupCall.leave")} className={compact} onClick={() => void actions.leave()} />
    </span>
    <ActionMenu open={!!menu} elevated surface="dark" position={menu ?? { x: 0, y: 0 }} title={t("groupCall.more")} items={items} onClose={() => setMenu(null)} />
  </div>;
}
