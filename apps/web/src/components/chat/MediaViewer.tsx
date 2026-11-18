import { useCallback, useEffect, useId, useLayoutEffect, useRef } from "react";
import { getLocale, t, useLocale } from "../../i18n/index.js";
import { dismissSaveFeedback, presentSaveFeedback, useSaveFeedbackStore } from "../../features/chat/save-feedback.js";
import { useMediaGestures } from "../../features/chat/useMediaGestures.js";
import { DarkSurface, IconButton, LiveAnnouncement, Notice, Portal } from "../../ui/index.js";
import { getTopOverlay, OVERLAY_RANK, registerOverlay } from "../../ui/overlay-stack.js";
import { useModalFocus } from "../../ui/useModalFocus.js";
import "./MediaViewer.css";

interface MediaViewerProps {
  objectUrl: string;
  fileName: string;
  isVideo: boolean;
  onClose: () => void;
  onError?: () => void;
  onSave?: () => void;
  saveLabel?: string;
}

function ImageView({ objectUrl, fileName, onClose, onError }: Pick<MediaViewerProps, "objectUrl" | "fileName" | "onClose" | "onError">) {
  const { stageRef, media, zoom, swipe, dragging, setNatural, toggleZoom, pointerHandlers } = useMediaGestures(onClose);
  return <>
    <div ref={stageRef} className="media-viewer-stage media-viewer-image-stage" {...pointerHandlers}>
      <img src={objectUrl} alt={fileName} draggable={false} className="media-viewer-image" onError={onError ?? onClose}
        onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        data-dragging={dragging || undefined}
        style={{ width: media.width || undefined, height: media.height || undefined, transform: `translate(${zoom.x}px, ${zoom.y + swipe}px) scale(${zoom.scale})` }} />
    </div>
    <button type="button" className="media-viewer-zoom" onClick={toggleZoom} aria-label={zoom.scale > 1 ? t("mediaZoomReset") : t("mediaZoomIn")}>
      {new Intl.NumberFormat(getLocale(), { style: "percent", maximumFractionDigits: 0 }).format(zoom.scale)}
    </button>
  </>;
}

export default function MediaViewer({ objectUrl, fileName, isVideo, onClose, onError, onSave, saveLabel }: MediaViewerProps) {
  useLocale();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const titleId = useId();
  const dismiss = useRef(onClose);
  dismiss.current = onClose;
  const saveFeedback = useSaveFeedbackStore(({ topOverlay, notice }) =>
    topOverlay?.kind === "viewer" && topOverlay.id === titleId ? notice : null);
  const announcement = useSaveFeedbackStore(({ announcement }) => announcement?.viewer === titleId ? announcement : undefined);
  useLayoutEffect(() => registerOverlay({ kind: "viewer", id: titleId, rank: OVERLAY_RANK.mediaViewer, onBack: () => dismiss.current() }), [titleId]);
  useLayoutEffect(() => {
    if (saveFeedback) presentSaveFeedback(saveFeedback, titleId);
  }, [saveFeedback, titleId]);
  useModalFocus({ open: true, onClose, panelRef, initialFocusRef: closeRef, isTop: () => {
    const top = getTopOverlay();
    return top?.kind === "viewer" && top.id === titleId;
  } });
  useEffect(() => {
    const video = videoRef.current;
    return () => { video?.pause(); };
  }, [objectUrl]);
  const dismissRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    // Restore focus before the focused button leaves the DOM.
    return () => {
      if (button.ownerDocument.activeElement === button) closeRef.current?.focus();
    };
  }, []);
  return <Portal><DarkSurface ref={panelRef} className="media-viewer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
    <LiveAnnouncement message={announcement} />
    <div className="media-viewer-toolbar relative">
      <IconButton ref={closeRef} icon="close" label={t("close")} onClick={onClose} />
      <h2 id={titleId} className="min-w-0 flex-1 truncate">{t("mediaViewerTitle", { name: fileName })}</h2>
      {onSave && <IconButton icon="download" label={saveLabel ?? t("fileSaveNamed", { name: fileName })} onClick={onSave} />}
      {saveFeedback && <div className="pointer-events-none absolute inset-x-0 top-full z-10 mx-auto w-full max-w-sm px-2">
        <Notice live={false} tone={saveFeedback.tone} title={t(saveFeedback.key)}
          onDismiss={() => dismissSaveFeedback(saveFeedback)} dismissRef={dismissRef}
          className="[&>button]:pointer-events-auto">
          {saveFeedback.fileName && <p className="line-clamp-2 break-words">{saveFeedback.fileName}</p>}
        </Notice>
      </div>}
    </div>
    {isVideo ? <div className="media-viewer-stage" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <video ref={videoRef} src={objectUrl} aria-label={fileName} className="media-viewer-video" tabIndex={0} controls playsInline autoPlay onError={onError ?? onClose} />
    </div> : <ImageView objectUrl={objectUrl} fileName={fileName} onClose={onClose} onError={onError} />}
  </DarkSurface></Portal>;
}
