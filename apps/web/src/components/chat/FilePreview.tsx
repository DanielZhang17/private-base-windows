import { t, useLocale } from "../../i18n/index.js";
import { useFilePreview, formatBytes, type FilePreviewOptions } from "../../features/chat/useFilePreview.js";
import { Button, Icon, IconButton, Spinner } from "../../ui/index.js";

export default function FilePreview(props: FilePreviewOptions) {
  useLocale();
  const { fileName, sizeBytes, mimeType } = props;
  const { loading, error, expired, objectUrl, isImage, isVideo, saveUnsupported, load, handleDownload } = useFilePreview(props);
  const description = t("fileDescription", { format: mimeType.split("/")[1]?.toUpperCase() ?? t("fileTypeLabel"), size: formatBytes(sizeBytes) });
  if (loading) return <div className="flex items-center gap-3 py-2 text-sm" role="status"><Spinner label={null} />{t("loadingFileNamed", { name: fileName })}</div>;
  if (expired) return <div className="flex items-center gap-3 py-2"><Icon name="timer" /><div><p className="font-semibold">{t("fileExpired")}</p><p className="text-xs">{fileName} · {formatBytes(sizeBytes)}</p></div></div>;
  if (error) return <div className="space-y-2"><p role="alert">{t("fileLoadFailedNamed", { name: fileName })}</p><Button size="sm" variant="secondary" onClick={() => void load()}>{t("retry")}</Button></div>;
  if ((isImage || isVideo) && objectUrl) return <div className="max-w-xs">
    {isImage ? <img src={objectUrl} alt={fileName} className="max-w-full rounded-control" onClick={saveUnsupported ? undefined : () => void handleDownload()} />
      : <video src={objectUrl} controls className="max-w-full rounded-control" />}
    <div className="mt-1 flex items-center gap-2"><p className="min-w-0 flex-1 break-words text-xs">{fileName} · {formatBytes(sizeBytes)}</p>
      {!saveUnsupported && <IconButton icon="download" label={t("download", { fileName: fileName })} onClick={() => void handleDownload()} className="text-inherit" />}
    </div>
  </div>;
  return <button type="button" className="flex min-h-11 w-full items-center gap-3 text-start disabled:cursor-not-allowed" onClick={() => void handleDownload()} disabled={saveUnsupported} aria-label={t("download", { fileName: fileName })}>
    <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-current/10"><Icon name="file" size={22} /></span>
    <span className="min-w-0 flex-1"><span className="block break-words text-sm font-semibold">{fileName}</span><span className="text-xs">{description}</span></span>
    <Icon name="download" size={20} />
  </button>;
}
