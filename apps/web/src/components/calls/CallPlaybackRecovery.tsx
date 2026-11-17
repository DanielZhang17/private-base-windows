import { t, useLocale } from "../../i18n/index.js";
import { useCallPlayback } from "../../features/calls/CallPlaybackContext.js";
import { Button, IconButton } from "../../ui/index.js";

export default function CallPlaybackRecovery({ compact = false }: { compact?: boolean }) {
  useLocale();
  const playback = useCallPlayback();
  if (!playback?.hasBlockedMedia) return null;
  const label = playback.hasBlockedVideo ? t("tapToPlay") : t("tapToTurnOnSound");
  const icon = playback.hasBlockedVideo ? "play" : "speaker";
  return compact
    ? <IconButton data-call-playback-recovery="" icon={icon} label={label} variant="primary" onClick={playback.resumeBlocked} />
    : <div data-call-playback-recovery="" className="flex w-full justify-center">
      <Button leadingIcon={icon} className="max-w-full [@media(max-height:400px)]:px-3 [@media(max-height:400px)]:text-sm" onClick={playback.resumeBlocked}>{label}</Button>
    </div>;
}
