import { t, useLocale } from "../../i18n/index.js";
import { IconButton, Select } from "../../ui/index.js";
import type { CallCamera } from "../../platform/media.js";
import type { ReactNode } from "react";
interface Props {
  onEnd: () => void;
  isMuted: boolean;
  isVideoOff: boolean;
  video: boolean;
  cameraDisabled?: boolean;
  videoBusy?: boolean;
  cameras?: CallCamera[];
  cameraId?: string;
  selectCamera?: (id: string) => void;
  cycleCamera?: () => void;
  toggleMute: () => void;
  toggleVideo: () => void;
  canShareScreen?: boolean;
  isSharingScreen?: boolean;
  toggleScreenShare?: () => void;
  diagnostics?: ReactNode;
}
export default function CallControls({ onEnd, isMuted, isVideoOff, video, cameraDisabled, videoBusy, cameras = [], cameraId, selectCamera, cycleCamera, toggleMute, toggleVideo, canShareScreen, isSharingScreen, toggleScreenShare, diagnostics }: Props) {
  useLocale();
  return <div className="flex flex-wrap items-center justify-center gap-4 [@media(max-height:400px)]:gap-2 [@media(max-height:400px)]:[&>button]:size-11">
    <IconButton icon={isMuted ? "mic-off" : "mic"} label={isMuted ? t("unmuteMicrophone") : t("muteMicrophone")} size="lg" variant="secondary" className="aria-pressed:bg-ink aria-pressed:text-canvas" aria-pressed={isMuted} onClick={toggleMute} />
    {video && <IconButton icon={isVideoOff ? "video-off" : "video"} label={isVideoOff ? t("turnOnCamera") : t("turnOffCamera")} size="lg" variant="secondary" className="aria-pressed:bg-ink aria-pressed:text-canvas" aria-pressed={isVideoOff} disabled={isVideoOff && (cameraDisabled || videoBusy)} onClick={toggleVideo} />}
    {video && cameras.length > 1 && <IconButton icon="transfer" label={t("callSwitchCamera")} size="lg" variant="secondary" disabled={cameraDisabled || videoBusy} onClick={cycleCamera} />}
    {video && canShareScreen && <IconButton icon="monitor" label={isSharingScreen ? t("stopSharingScreen") : t("shareScreen")} size="lg" variant="secondary" className="aria-pressed:bg-ink aria-pressed:text-canvas" aria-pressed={isSharingScreen} disabled={!isSharingScreen && (cameraDisabled || videoBusy)} onClick={toggleScreenShare} />}
    {diagnostics}
    <IconButton icon="phone-off" label={t("endCall")} size="lg" variant="danger" onClick={onEnd} />
    {video && cameras.length > 2 && <Select className="w-auto max-w-48" aria-label={t("callSelectCamera")} value={cameraId} disabled={cameraDisabled || videoBusy} onChange={(event) => selectCamera?.(event.currentTarget.value)}>
      {cameras.map((camera, index) => <option key={camera.id} value={camera.id}>{camera.label || t("callCameraNumber", { number: index + 1 })}</option>)}
    </Select>}
  </div>;
}
