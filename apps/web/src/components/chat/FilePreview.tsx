import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import MediaViewer from "./MediaViewer.js";
import { copyMessageText } from "../../features/chat/message-actions.js";
import { fileTypeLabel } from "../../features/chat/presentation.js";
import { t, useLocale } from "../../i18n/index.js";
import { useFilePreview, formatBytes, type FilePreviewOptions } from "../../features/chat/useFilePreview.js";
import { Button, Dialog, Icon, IconButton, Spinner, useToast } from "../../ui/index.js";

export interface FilePreviewActions { open: () => void; save: () => void }
export default function FilePreview(props: FilePreviewOptions & { actionsRef?: Ref<FilePreviewActions>; onBlocked?: () => void; onSaveUnsupportedChange?: (unsupported: boolean) => void }) {
  useLocale();
  const toast = useToast();
  const rowRef = useRef<HTMLDivElement>(null);
  const pendingDialogSave = useRef<(() => void) | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => { setPreviewFailed(false); setViewerOpen(false); }, [props.fileId, props.mimeType, props.fileKey, props.fileIv]);
  const failPreview = () => { setPreviewFailed(true); setViewerOpen(false); };
  const { fileName, sizeBytes, mimeType } = props;
  const { blocked, canOpen, actionWarning, fileSaveMode, textPreview, closeTextPreview, canPreview, loading, error, expired, objectUrl, isImage, isVideo, saveUnsupported, load, handleDownload, handleOpen, actionError, clearActionError } = useFilePreview(props);
  const open = async () => {
    if (canPreview && !previewFailed) {
      const blob = objectUrl ? true : await load();
      if (blob) setViewerOpen(true);
    } else await handleOpen();
  };
  const save = () => void handleDownload();
  const saveFromDialog = () => {
    pendingDialogSave.current = save;
    closeTextPreview();
  };
  useEffect(() => {
    const commitSave = pendingDialogSave.current;
    if (textPreview || !commitSave) return;
    pendingDialogSave.current = null;
    rowRef.current?.focus({ preventScroll: true });
    commitSave();
  }, [textPreview]);
  useImperativeHandle(props.actionsRef, () => ({ open: () => void open(), save }));
  useEffect(() => {
    if (actionError) { toast.show({ tone: actionWarning ? "warning" : "danger", duration: actionWarning ? 5000 : 0, message: actionError, ...(actionWarning && !saveUnsupported ? { action: { label: t(fileSaveMode === "share" ? "fileShare" : "fileSave"), onClick: save } } : {}) }); clearActionError(); }
  }, [actionError]);
  useEffect(() => { if (blocked) props.onBlocked?.(); }, [blocked, props.onBlocked]);
  useEffect(() => { props.onSaveUnsupportedChange?.(saveUnsupported); }, [saveUnsupported, props.onSaveUnsupportedChange]);
  const saveLabel = t(fileSaveMode === "share" ? "fileShareNamed" : "fileSaveNamed", { name: fileName });
  const description = t("fileDescription", { format: fileTypeLabel(fileName), size: formatBytes(sizeBytes) });
  // Use the same focus target while the row changes from the file card to loading or Retry.
  if (loading) return <div ref={rowRef} tabIndex={-1} className="flex items-center gap-3 py-2 text-sm" role="status"><Spinner label={null} />{t("loadingFileNamed", { name: fileName })}</div>;
  if (expired) return <div ref={rowRef} tabIndex={-1} className="flex items-center gap-3 py-2"><Icon name="timer" /><div><p className="font-semibold">{t("fileExpired")}</p><p className="text-xs">{fileName} · {formatBytes(sizeBytes)}</p></div></div>;
  if (error) return <div ref={rowRef} tabIndex={-1} className="space-y-2"><p role="alert">{t("fileLoadFailedNamed", { name: fileName })}</p><Button size="sm" variant="secondary" onClick={() => void load()}>{t("retry")}</Button></div>;
  if ((isImage || isVideo) && objectUrl && !previewFailed) return <div className="max-w-xs">
    {isImage ? <button type="button" className="block max-w-full" aria-label={t("openMedia", { name: fileName })} onClick={() => setViewerOpen(true)}>
      <img draggable={false} src={objectUrl} alt={fileName} onError={failPreview} className="max-w-full rounded-control" />
    </button> : <button type="button" className="relative block max-w-full" aria-label={t("openMedia", { name: fileName })} onClick={() => setViewerOpen(true)}>
      <video src={objectUrl} playsInline preload="metadata" onError={failPreview} className="pointer-events-none max-w-full rounded-control" />
      <span className="absolute inset-0 flex items-center justify-center"><Icon name="video" size={32} /></span>
    </button>}
    {viewerOpen && <MediaViewer
      objectUrl={objectUrl} fileName={fileName} isVideo={isVideo}
      onClose={() => setViewerOpen(false)} onError={failPreview}
      onSave={saveUnsupported ? undefined : save} saveLabel={saveLabel}
    />}
    <div className="mt-1 flex items-center gap-2"><p className="min-w-0 flex-1 break-words text-xs">{fileName} · {formatBytes(sizeBytes)}</p>
      {!saveUnsupported && <IconButton icon="download" label={saveLabel} onClick={save} className="text-inherit" />}
    </div>
  </div>;
  return <div ref={rowRef} tabIndex={-1} className="flex items-center gap-2"><Dialog open={textPreview !== null} onClose={closeTextPreview} title={fileName} className="file-text-dialog sm:max-w-3xl" footer={<>
    {!textPreview?.tooLarge && <Button variant="secondary" onClick={() => void copyMessageText(textPreview?.content ?? "").then(() => toast.show({ tone: "success", message: t("textCopied") })).catch(() => toast.show({ tone: "danger", message: t("couldNotCopyMessage") }))}>{t("copyText")}</Button>}
    <Button onClick={saveFromDialog} disabled={saveUnsupported}>{t(fileSaveMode === "share" ? "fileShare" : "fileSave")}</Button>
  </>}>
    {textPreview?.tooLarge ? <p>{t("textPreviewTooLarge")}</p>
      : <pre className="max-h-[70dvh] overflow-auto whitespace-pre-wrap break-words rounded-control bg-sunken p-3 font-[family-name:var(--font-code)] text-[13px] leading-[18px]">{textPreview?.content}</pre>}
  </Dialog><button type="button" className="flex min-h-11 w-full items-center gap-3 text-start disabled:cursor-not-allowed" onClick={() => void open()} aria-label={canOpen ? t("fileOpenNamed", { name: fileName }) : saveLabel}>
    <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-current/10"><Icon name="file" size={22} /></span>
    <span className="min-w-0 flex-1"><span className="block break-words text-sm font-semibold">{fileName}</span><span className="text-xs">{description}</span></span>
  </button>{!saveUnsupported && <IconButton icon="download" label={saveLabel} onClick={save} className="text-inherit" />}</div>;
}
