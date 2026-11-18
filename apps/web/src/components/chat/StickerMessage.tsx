import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import type { DecryptedMessage } from "../../features/chat/presentation.js";
import { t } from "../../i18n/index.js";
import { formatTime } from "../../i18n/format.js";
import { stickerName, type Sticker } from "../../features/stickers/catalog.js";
import { useStickerPicker } from "../../features/stickers/useStickerPicker.js";
import { ActionMenu, type ActionMenuItem } from "../../ui/ActionMenu.js";
import { Icon } from "../../ui/Icon.js";
import { StickerImage, useStickerImage } from "./StickerArt.js";
import TimedCountdownBadge from "./TimedCountdownBadge.js";

export function StickerMessageMenu({ stickerId, onOpenPack, items, ...menu }: ComponentProps<typeof ActionMenu> & {
  stickerId: string; onOpenPack?: () => void;
}) {
  const picker = useStickerPicker();
  const favourite = picker?.state.favourites.some(({ id }) => id === stickerId);
  const actions: ActionMenuItem[] = [];
  if (onOpenPack) actions.push({ id: "pack", icon: "image", label: t("stickerViewPack"), onSelect: onOpenPack });
  if (picker) actions.push({ id: "favourite", icon: favourite ? "star-off" : "star", label: t(favourite ? "stickerRemoveFavourite" : "stickerAddFavourite"),
    onSelect: () => void picker.setFavourite(stickerId, favourite ? "remove" : "add") });
  return <ActionMenu {...menu} items={actions.length ? [...actions, ...items.map((item, index) => index === 0 ? { ...item, separatorBefore: true } : item)] : items} />;
}

export function StickerMessage({ sticker, onOpen, menuOpen, failed, triggers, retryCatalog, onShowActions }: {
  sticker?: Sticker; onOpen: (opener: HTMLButtonElement) => void; menuOpen: boolean; failed: boolean;
  triggers: ComponentProps<"button">; retryCatalog?: () => void; onShowActions: () => void;
}) {
  const image = useStickerImage(sticker, "full");
  const alt = sticker ? stickerName(sticker) : t("stickerPreview");
  const reload = sticker && image.state === "failed" ? image.retry : retryCatalog;
  const loading = !reload && (!sticker || image.state === "loading");
  return <button {...triggers} type="button"
    onClick={(event) => {
      if (reload) reload();
      else if (sticker && !failed) onOpen(event.currentTarget);
      else if (failed) onShowActions();
    }}
    aria-label={reload ? t("stickerMessageImageFailed") : sticker && !failed ? t("stickerOpenPackMessage", { alt }) : failed ? t("failedMessageActions") : alt}
    aria-busy={loading || undefined} aria-haspopup={sticker && !failed && !reload ? "dialog" : undefined}
    className={`sticker-message message-action-surface ${menuOpen ? "message-menu-target" : ""} ${failed ? "is-failed" : ""} ${loading ? "bg-sunken animate-ui-pulse" : ""} ${reload ? "bg-sunken" : ""}`}>
    {sticker && !reload && <StickerImage sticker={sticker} alt={alt} image={image} />}
    {reload && <span className="sticker-message-placeholder">
      <span className="sticker-reload-caption"><Icon name={sticker ? "retry" : "image"} size={sticker ? 18 : 28} />{t("stickerPreview")}</span>
    </span>}
  </button>;
}

export function StickerMessageStatus({ message, isOwn, failed, showMeta, status, onRetry }: {
  message: DecryptedMessage; isOwn: boolean; failed: boolean; showMeta: boolean; status: string; onRetry?: () => void;
}) {
  const timed = message.expiryKind === "timed" && message.expiresAt != null;
  const meta = useRef<HTMLSpanElement>(null);
  const [wrapped, setWrapped] = useState(false);
  useLayoutEffect(() => {
    const element = meta.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observe = () => setWrapped(element.offsetHeight > 22);
    const observer = new ResizeObserver(observe);
    observer.observe(element);
    observe();
    return () => observer.disconnect();
  }, [failed, showMeta, timed]);
  if (!failed && !showMeta && !timed) return null;
  if (failed) return <div data-message-meta="" className="sticker-send-failed">
    <Icon name="alert-circle" size={14} />
    <span>{t("notSent")}</span>
    <span aria-hidden="true">·</span>
    <button type="button" className="sticker-message-retry" onClick={onRetry}>{t("retry")}</button>
    {timed && <TimedCountdownBadge expiresAt={message.expiresAt!} />}
  </div>;
  return <span ref={meta} data-message-meta="" className="sticker-meta" data-wrapped={wrapped || undefined}>
    {showMeta && message.status !== "sending" && <time dateTime={new Date(message.timestamp).toISOString()}>{formatTime(message.timestamp)}</time>}
    {showMeta && isOwn && <>
      <Icon name={message.status === "sending" ? "clock" : message.status === "sent" ? "check" : "check-double"} size={14} className={message.status === "read" ? "text-brand" : undefined} />
      <span>{status}</span>
    </>}
    {timed && <TimedCountdownBadge expiresAt={message.expiresAt!} />}
  </span>;
}
