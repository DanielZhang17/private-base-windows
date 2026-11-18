import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../../i18n/index.js";
import { Icon } from "../../ui/Icon.js";
import type { ActionMenuPosition } from "../../ui/ActionMenu.js";
import { useLongPress } from "../../features/chat/useLongPress.js";
import { stickerName, type Sticker } from "../../features/stickers/catalog.js";
import { StickerImage, useStickerImage } from "./StickerArt.js";

export default function StickerTile({ sticker, tabIndex, index, selected, favourited, menuOpen = false, onPreview, onActivate, onFocus, onKeyDown, onImageState, canActivate }: {
  sticker: Sticker; tabIndex: number; index: number; selected?: boolean; favourited?: boolean; menuOpen?: boolean;
  onPreview?: (position: ActionMenuPosition, source: HTMLButtonElement) => void;
  onActivate: (id: string, element: HTMLButtonElement) => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  canActivate?: () => boolean;
  onImageState?: (state: ReturnType<typeof useStickerImage>["state"]) => void;
}) {
  const image = useStickerImage(sticker, "thumb");
  const press = useLongPress(menuOpen);
  const report = useRef(onImageState);
  report.current = onImageState;
  useEffect(() => report.current?.(image.state), [image.state]);
  const [pressed, setPressed] = useState(false);
  const activation = useRef<{ id: string; state: typeof image.state } | undefined>(undefined);
  const name = stickerName(sticker);
  const label = favourited ? t("stickerInFavourites", { name }) : name;
  const selecting = selected !== undefined;
  const activate = (element: HTMLButtonElement) => {
    if (selecting || image.state === "ready") onActivate(sticker.id, element);
    else if (image.state === "failed") void image.retry();
  };

  return <button type="button" data-sticker-tile={index} data-sticker-id={sticker.id} tabIndex={tabIndex} onFocus={onFocus}
    className={`sticker-tile message-action-surface ${image.state === "loading" ? "bg-sunken animate-ui-pulse" : ""} ${image.state === "failed" ? "bg-sunken text-ink-muted" : ""} ${menuOpen ? "message-menu-target" : ""}`}
    aria-label={selecting ? label : image.state === "failed" ? t("stickerImageFailed", { name: label }) : t("stickerSendNamed", { name: label })}
    aria-busy={image.state === "loading" || undefined} aria-pressed={selected}
    aria-haspopup={onPreview ? "menu" : undefined} aria-expanded={onPreview ? menuOpen : undefined}
    data-pressed={pressed || undefined}
    onPointerDown={(event) => {
      if (event.button !== 0 || !event.isPrimary || canActivate?.() === false) return;
      const { clientX, clientY, currentTarget } = event;
      activation.current = { id: sticker.id, state: image.state };
      press.begin(event, onPreview ? () => onPreview({ x: clientX, y: clientY, source: "pointer" }, currentTarget) : undefined, () => setPressed(false));
      if (image.state === "ready") setPressed(true);
    }}
    onPointerLeave={(event) => { if (event.pointerType !== "touch") press.cancel(); }}
    onPointerMove={press.move} onPointerCancel={press.cancel} onLostPointerCapture={press.cancel}
    onPointerUp={(event) => {
      const start = activation.current;
      activation.current = undefined;
      if (!press.release(event) || start?.id !== sticker.id || (!selecting && start.state !== image.state)) return;
      const releasedOver = document.elementFromPoint ? document.elementFromPoint(event.clientX, event.clientY) : event.target;
      if (releasedOver instanceof Node && event.currentTarget.contains(releasedOver)) activate(event.currentTarget);
    }}
    onClickCapture={press.captureClick}
    onClick={(event) => {
      const fromPointer = "pointerType" in event.nativeEvent && !!event.nativeEvent.pointerType;
      if (!event.detail && !fromPointer && canActivate?.() !== false) activate(event.currentTarget);
    }}
    onContextMenu={(event) => {
      if (!onPreview) return;
      event.preventDefault();
      event.stopPropagation();
      if (press.contextMenu()) onPreview({ x: event.clientX, y: event.clientY, source: "pointer" }, event.currentTarget);
    }}
    onKeyDown={(event) => {
      if (onPreview && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        onPreview({ x: rect.left, y: rect.bottom, top: rect.top, source: "button", keyboard: true }, event.currentTarget);
      } else onKeyDown(event);
    }}>
    {image.state === "failed" ? <Icon name="image" size={24} /> : <StickerImage sticker={sticker} image={image} />}
    {favourited && <span className="sticker-favourite-mark"><Icon name="star" size={16} /></span>}
  </button>;
}
