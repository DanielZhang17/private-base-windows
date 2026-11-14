import { t, useLocale } from "../../i18n/index.js";
import { useMediaElement } from "../../features/calls/useMediaElement.js";
import { Spinner } from "../../ui/index.js";
interface Props { streams: Map<string, MediaStream> }
export default function VideoGrid({ streams }: Props) {
  useLocale();
  const entries = Array.from(streams.entries());
  return <div className={`grid h-full w-full gap-2 ${entries.length > 1 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"}`}>
    {entries.map(([userId, stream]) => <RemoteVideoTile key={userId} stream={stream} />)}
    {!entries.length && <div className="flex items-center justify-center"><Spinner label={t("waitingForVideo")} size={32} /></div>}
  </div>;
}
function RemoteVideoTile({ stream }: { stream: MediaStream }) {
  useLocale();
  const ref = useMediaElement<HTMLVideoElement>(stream);
  return <video ref={ref} autoPlay playsInline aria-label={t("contactSVideo")} className="h-full w-full bg-sunken object-cover sm:object-contain" />;
}
