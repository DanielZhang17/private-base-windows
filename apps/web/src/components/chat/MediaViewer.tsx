import { useEffect, useId, useRef } from "react";
import { getLocale, t, useLocale } from "../../i18n/index.js";
import { useMediaGestures } from "../../features/chat/useMediaGestures.js";
import { DarkSurface, IconButton, Portal } from "../../ui/index.js";
import { useModalFocus } from "../../ui/useModalFocus.js";
import "./MediaViewer.css";

interface MediaViewerProps {
  objectUrl: string;
  fileName: string;
  isVideo: boolean;
  onClose: () => void;
  onError?: () => void;
  onSave?: () => void;
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

export default function MediaViewer({ objectUrl, fileName, isVideo, onClose, onError, onSave }: MediaViewerProps) {
  useLocale();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const titleId = useId();
  useModalFocus({ open: true, onClose, panelRef, initialFocusRef: closeRef });
  useEffect(() => {
    const video = videoRef.current;
    return () => { video?.pause(); };
  }, [objectUrl]);

  return <Portal><DarkSurface ref={panelRef} className="media-viewer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
    <div className="media-viewer-toolbar">
      <IconButton ref={closeRef} icon="close" label={t("close")} onClick={onClose} />
      <h2 id={titleId} className="min-w-0 flex-1 truncate">{t("mediaViewerTitle", { name: fileName })}</h2>
      {onSave && <IconButton icon="download" label={t("download", { fileName })} onClick={onSave} />}
    </div>
    {isVideo ? <div className="media-viewer-stage" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <video ref={videoRef} src={objectUrl} aria-label={fileName} className="media-viewer-video" tabIndex={0} controls playsInline autoPlay onError={onError ?? onClose} />
    </div> : <ImageView objectUrl={objectUrl} fileName={fileName} onClose={onClose} onError={onError} />}
  </DarkSurface></Portal>;
}
