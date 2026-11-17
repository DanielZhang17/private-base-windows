import { t, useLocale } from "../../i18n/index.js";
import { IconButton } from "../../ui/index.js";
interface Props {
  onEnd: () => void;
  isMuted: boolean;
  isVideoOff: boolean;
  video: boolean;
  cameraDisabled?: boolean;
  toggleMute: () => void;
  toggleVideo: () => void;
  canShareScreen?: boolean;
  isSharingScreen?: boolean;
  toggleScreenShare?: () => void;
}
export default function CallControls({ onEnd, isMuted, isVideoOff, video, cameraDisabled, toggleMute, toggleVideo, canShareScreen, isSharingScreen, toggleScreenShare }: Props) {
  useLocale();
  return <div className="flex flex-wrap items-center justify-center gap-4 [@media(max-height:400px)]:gap-2 [@media(max-height:400px)]:[&>button]:size-11">
    <IconButton icon={isMuted ? "mic-off" : "mic"} label={isMuted ? t("unmuteMicrophone") : t("muteMicrophone")} size="lg" variant="secondary" className="aria-pressed:bg-ink aria-pressed:text-canvas" aria-pressed={isMuted} onClick={toggleMute} />
    {video && <IconButton icon={isVideoOff ? "video-off" : "video"} label={isVideoOff ? t("turnOnCamera") : t("turnOffCamera")} size="lg" variant="secondary" className="aria-pressed:bg-ink aria-pressed:text-canvas" aria-pressed={isVideoOff} disabled={cameraDisabled} onClick={toggleVideo} />}
    {video && canShareScreen && <IconButton icon="monitor" label={isSharingScreen ? t("stopSharingScreen") : t("shareScreen")} size="lg" variant="secondary" className="aria-pressed:bg-ink aria-pressed:text-canvas" aria-pressed={isSharingScreen} onClick={toggleScreenShare} />}
    <IconButton icon="phone-off" label={t("endCall")} size="lg" variant="danger" onClick={onEnd} />
  </div>;
}
