import { localized } from "../../i18n/messages.js";
import { formatTime } from "../../i18n/format.js";
import { t, useLocale } from "../../i18n/index.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { attachmentName, copyableMessageText, fileTypeLabel, isSticker, parseFilePayload, parseStickerToken, type DecryptedMessage } from "../../features/chat/presentation.js";
import { canOpenFile, copyMessageText } from "../../features/chat/message-actions.js";
import { formatBytes } from "../../features/chat/useFilePreview.js";
import { captureMessageActionSession, isMessageActionSessionCurrent, trackMessageUndoToast } from "../../features/chat/message-action-session.js";
import { useMessageActions } from "../../features/chat/useMessageActions.js";
import { messageSelectionText } from "../../features/chat/message-selection.js";
import { ActionMenu, ConfirmDialog, Icon, IconButton, useToast, type ActionMenuItem } from "../../ui/index.js";
import FilePreview, { type FilePreviewActions } from "./FilePreview.js";
import InlineEmojiText from "./InlineEmojiText.js";
import { stickerName, useStickerCatalog } from "../../features/stickers/catalog.js";
import { StickerArt } from "./StickerArt.js";
import { StickerMessage, StickerMessageMenu, StickerMessageStatus } from "./StickerMessage.js";
import { packSelection, StickerPackSheet } from "./StickerPackSheet.js";
import TimedCountdownBadge from "./TimedCountdownBadge.js";

interface Props {
  message: DecryptedMessage;
  isOwn: boolean;
  isGroup?: boolean;
  showMeta?: boolean;
  firstInRun?: boolean;
  senderAvatarUrl?: string | null;
  senderName?: string;
  failure?: string | null;
  onRetry?: () => void;
  onDiscard?: () => void;
  onEdit?: () => void;
  onSelect?: () => void;
  selection?: { selected: boolean; busy: boolean };
}
export default function MessageBubble({ message, isOwn, isGroup, senderName, failure, onRetry, onDiscard, onEdit, onSelect, selection, showMeta = true, firstInRun = true }: Props) {
  useLocale();
  const selecting = !!selection;
  const actions = useMessageActions(message, isOwn, selecting);
  const selectionControl = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selecting && selection?.selected) selectionControl.current?.focus({ preventScroll: true });
  }, [selecting]);
  const fileActions = useRef<FilePreviewActions>(null);
  const toast = useToast();
  const [fileBlocked, setFileBlocked] = useState(false);
  const [fileSaveUnsupported, setFileSaveUnsupported] = useState(false);
  const markBlocked = useCallback(() => setFileBlocked(true), []);
  useEffect(() => setFileBlocked(false), [message.id, message.content]);
  const deleted = !!message.deletedAt;
  const failed = !deleted && isOwn && message.status === "failed";
  const stickerId = isSticker(message) && (isOwn || message.status !== "failed") ? parseStickerToken(message.content) : null;
  const { catalog, failed: catalogFailed, retry: retryCatalog } = useStickerCatalog(!!stickerId);
  const sticker = stickerId ? catalog?.stickers.get(stickerId) : undefined;
  const [packOpen, setPackOpen] = useState(false);
  const packOpenRef = useRef(false);
  packOpenRef.current = packOpen;
  const more = useRef<HTMLButtonElement>(null);
  const packOpener = useRef<HTMLButtonElement | null>(null);
  const openPack = (opener = more.current) => {
    packOpener.current = opener;
    setPackOpen(true);
  };
  const closePack = () => {
    setPackOpen(false);
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) packOpener.current?.focus({ preventScroll: true });
    });
  };
  useEffect(() => () => {
    if (packOpenRef.current) requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return;
      document.querySelector<HTMLElement>('[role=log] .message-more, [data-sticker-focus-fallback]')?.focus({ preventScroll: true });
    });
  }, []);
  const queued = !!onDiscard || message.status === "sending" || failed;
  const file = !deleted && message.type === "file" ? parseFilePayload(message.content) : null;
  const time = formatTime(message.timestamp);
  const deletedText = t(isOwn ? "youDeletedMessage" : "messageDeleted");
  const status = message.status === "sending" ? t("messageSendingStatus") : message.status === "sent" ? t("messageSentStatus") : message.status === "delivered" ? t("messageDeliveredStatus") : message.status === "read" ? t("messageReadStatus") : t("notSent");
  useEffect(() => {
    if (actions.error && !actions.confirmDelete && !actions.confirmLocalDelete) { toast.show({ tone: "danger", message: actions.error }); actions.clearError(); }
  }, [actions.error, actions.confirmDelete, actions.confirmLocalDelete]);
  const copy = (text: string) => void copyMessageText(text).then(() => toast.show({ tone: "success", message: localized("messageCopied") })).catch(() => toast.show({ tone: "danger", message: localized("couldNotCopyMessage") }));
  const deleteForMe = () => {
    const session = captureMessageActionSession();
    const current = () => isMessageActionSessionCurrent(session);
    void actions.requestDeleteForMe().then((undo) => {
      if (!undo || !current()) return;
      const id = toast.show({ duration: 5000, message: localized("messageDeletedForYou"), action: { label: localized("undo"), onClick: () => {
        if (!current()) return;
        void undo().then((restored) => { if (!restored && current()) toast.show({ tone: "danger", message: localized("messageUndoUnavailable") }); })
          .catch(() => { if (current()) toast.show({ tone: "danger", message: localized("messageDeleteFailed") }); });
      } } });
      trackMessageUndoToast(session, () => toast.dismiss(id));
    });
  };
  const items: ActionMenuItem[] = [];
  const displayText = message.pendingEdit?.content ?? message.content;
  const pendingEditStatus = !deleted && !stickerId && message.pendingEdit ? t("messageEditPending") : null;
  const editStatus = pendingEditStatus ?? (!deleted && message.editedAt ? t("messageEdited") : null);
  if (!stickerId && !deleted && message.type === "text" && displayText) items.push({ id: "copy", icon: "copy", label: t("copyText"), onSelect: () => copy(copyableMessageText(message)) });
  if (onEdit && !isSticker(message)) items.push({ id: "edit", icon: "edit", label: t("editMessageAction"), onSelect: onEdit });
  if (file && !queued) {
    if (!fileBlocked && canOpenFile(file.fileName, file.mimeType)) items.push({ id: "open", icon: "file", label: t("fileOpen"), onSelect: () => fileActions.current?.open() });
    if (actions.fileSaveSupported && !fileSaveUnsupported) items.push({ id: "save", icon: actions.fileSaveMode === "share" ? "share" : "download", label: t(actions.fileSaveMode === "share" ? "fileShare" : "fileSave"), onSelect: () => fileActions.current?.save() });
  }
  if (!deleted && message.type === "file" && message.content) items.push({ id: "copy-name", icon: "copy", label: t("copyFileName"), onSelect: () => copy(attachmentName(message.content)) });
  if (failed && onRetry) items.push({ id: "retry", icon: "retry", label: t("retry"), onSelect: onRetry });
  if (onSelect) items.push({ id: "select", icon: "check", label: t("messageSelect"), onSelect });
  if (failed && onDiscard) items.push({ id: "discard", icon: "trash", label: t("discard"), onSelect: onDiscard, danger: true, separatorBefore: items.length > 0 });
  items.push({ id: "delete-me", icon: "trash", hint: t("thisDeviceOnly"), label: t("deleteForMe"), onSelect: deleteForMe, danger: true, separatorBefore: items.length > 0 && !items.at(-1)?.danger });
  if (isOwn && !queued && !deleted) items.push({ id: "delete-everyone", icon: "trash", hint: t("removesForAllMembers"), label: t("deleteForEveryone"), onSelect: () => { actions.clearError(); actions.setConfirmDelete(true); }, danger: true });
  const content = deleted ? <span>{deletedText}</span>
    : message.type === "file" ? file ? <FilePreview actionsRef={fileActions} onBlocked={markBlocked} onSaveUnsupportedChange={setFileSaveUnsupported} messageId={message.id} fileId={file.fileId} fileName={file.fileName} mimeType={file.mimeType} fileKey={file.fileKey} fileIv={file.iv ?? file.fileIv!} sizeBytes={file.size ?? file.sizeBytes} />
    : <span>{message.status === "sending" ? t("encryptingFile") : failed ? t("fileNotSent") : t("invalidFilePayload")}</span>
    : !isOwn && message.status === "failed" ? <span>{t("aMessageCouldNotBeDecrypted")}</span> : <InlineEmojiText content={displayText} />;
  const preview = <div className="min-w-0"><p className="text-[13px] font-semibold leading-[18px]">{isOwn ? t("selfDisplayName") : senderName ?? t("contactDisplayNameFallback")}</p>
    {file ? <div className="mt-2 flex items-center gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-sunken"><Icon name="file" /></span><div className="min-w-0"><p className="break-words text-sm">{file.fileName}</p><p className="text-xs text-ink-subtle">{t("fileDescription", { size: formatBytes(file.size ?? file.sizeBytes ?? 0), format: fileTypeLabel(file.fileName) })}</p></div></div>
      : <p className="mt-1 line-clamp-2 break-words text-sm font-normal text-ink-muted">{deleted ? deletedText : message.type === "file" ? attachmentName(message.content) : !stickerId ? displayText
        : <span className="flex items-center gap-3">{sticker && <StickerArt sticker={sticker} size="thumb" className="size-14 shrink-0" />}{t("stickerPreview")}</span>}</p>}
  </div>;
  const announcement = t("messageAnnouncement", { name: isOwn ? t("selfDisplayName") : senderName ?? t("contactDisplayNameFallback"), status: pendingEditStatus ?? (failed ? t("notSent") : time) });
  const stickerAnnouncement = stickerId ? t("stickerMessageAnnouncement", { message: announcement, sticker: sticker ? stickerName(sticker) : t("stickerPreview"), status: isOwn && !failed ? status : "" }) : announcement;
  const menu = { open: !!actions.position, position: actions.position ?? { x: 0, y: 0 }, onClose: actions.close,
    title: t("messageActions"), items, preview, children: failure && <p className="px-3 py-2 text-sm text-ink-muted">{failure}</p> };
  return <article data-message-id={message.id} className={`${selecting ? "grid grid-cols-[44px_minmax(0,1fr)] items-start cursor-pointer rounded-control select-none" : ""} ${selection?.selected ? "bg-brand-soft" : ""}`} aria-label={stickerAnnouncement}
    onClick={selecting && !selection?.busy ? onSelect : undefined} onClickCapture={selecting ? actions.triggers.onClickCapture : undefined}
    onContextMenu={selecting ? (event) => event.preventDefault() : undefined}>
    {selection && <button ref={selectionControl} type="button" role="checkbox" aria-checked={selection.selected}
      aria-label={[stickerAnnouncement, !stickerId && (file ? file.fileName : messageSelectionText(message))].filter(Boolean).join(", ")}
      aria-disabled={selection.busy || undefined} className="grid size-11 cursor-pointer place-items-center rounded-control"
      onClick={(event) => { event.stopPropagation(); if (!selection.busy) onSelect?.(); }}>
      <span className={`flex size-5 items-center justify-center rounded border ${selection.selected ? "border-brand bg-brand text-on-brand" : "border-line-strong bg-surface"}`}>
        {selection.selected && <Icon name="check" size={16} />}
      </span>
    </button>}
    <div className={`flex min-w-0 flex-col ${isOwn ? "items-end" : "items-start"}`}>
    {firstInRun && isGroup && !isOwn && senderName && <p className="mb-1 px-3 text-xs font-semibold text-ink-muted">{senderName}</p>}
    <div className={`message-row flex w-full items-center gap-2 ${isOwn ? "flex-row-reverse" : ""}`} data-menu-open={!!actions.position || undefined}>
      {stickerId ? <div className="sticker-message-frame" inert={selecting}>
        <StickerMessage key={stickerId} sticker={sticker} failed={failed} menuOpen={!!actions.position} triggers={actions.triggers}
          onShowActions={() => more.current?.click()} retryCatalog={catalogFailed ? retryCatalog : undefined} onOpen={openPack} />
        <StickerMessageStatus message={message} isOwn={isOwn} failed={failed} showMeta={showMeta} status={status}
          onRetry={onRetry ?? (() => more.current?.click())} />
      </div> : failed ? <button {...actions.triggers} inert={selecting} type="button" onClick={onRetry ?? actions.openFromButton}
        aria-label={t("retryMessage", { content: message.type === "file" ? attachmentName(message.content) : message.content })}
        className={`message-action-surface bubble bubble-own bubble-failed text-start ${actions.position ? "message-menu-target" : ""}`}>
        {message.type === "file" ? attachmentName(message.content) : <InlineEmojiText content={message.content} />}
      </button> : <div {...actions.triggers} inert={selecting} className={`message-action-surface bubble ${isOwn ? "bubble-own" : "bubble-incoming"} ${deleted ? "bubble-deleted" : ""} ${actions.position ? "message-menu-target" : ""}`}>{content}</div>}
      {!selection && <IconButton ref={more} icon="more" label={t(failed ? "failedMessageActions" : "messageActions")} size="sm" aria-haspopup="menu" aria-expanded={!!actions.position} onClick={actions.openFromButton} className="message-more text-ink-subtle focus-visible:outline-2 focus-visible:outline-brand" />}
    </div>
    {!stickerId && (showMeta || editStatus || (message.expiryKind === "timed" && message.expiresAt != null)) && <div className={`flex min-h-7 flex-wrap items-center gap-1.5 px-1 pt-1 text-xs tabular-nums ${failed ? "font-semibold text-danger" : "text-ink-subtle"}`}>
      {showMeta && <span data-message-meta="" className="inline-flex items-center gap-1.5">{failed ? <><Icon name="alert-circle" size={14} /><span>{t("notSent")}</span></>
        : <>{message.status !== "sending" && <time dateTime={new Date(message.timestamp).toISOString()}>{time}</time>}{isOwn && !deleted && !pendingEditStatus && <><Icon name={message.status === "sending" ? "clock" : message.status === "sent" ? "check" : "check-double"} size={14} className={message.status === "read" ? "text-brand" : undefined} /><span>{status}</span></>}
          </>}</span>}
      {editStatus && <span>{editStatus}</span>}
      {message.expiryKind === "timed" && message.expiresAt != null && <TimedCountdownBadge expiresAt={message.expiresAt} />}
    </div>}
    </div>
    {!selecting && (actions.position && stickerId && !failed
      ? <StickerMessageMenu {...menu} stickerId={stickerId} onOpenPack={sticker ? openPack : undefined} />
      : <ActionMenu {...menu} />)}
    {packOpen && sticker && catalog && <StickerPackSheet pack={packSelection(sticker)} stickers={catalog.stickers} onClose={closePack} />}
    <ConfirmDialog open={actions.confirmLocalDelete} title={t("deleteQueuedTitle")} description={t("deleteQueuedDescription")} confirmLabel={t("deleteForMe")} tone="danger" error={actions.error} onConfirm={() => void actions.deleteForMe()} onCancel={() => actions.setConfirmLocalDelete(false)} />
    <ConfirmDialog open={actions.confirmDelete} title={file ? t("deleteFileEveryoneTitle", { fileName: file.fileName }) : t("deleteForEveryoneTitle")} description={t("deleteForEveryoneDescription")} confirmLabel={t("deleteForEveryone")} tone="danger" busy={actions.busy} error={actions.error} onConfirm={() => void actions.deleteForEveryone()} onCancel={() => { if (!actions.busy) actions.setConfirmDelete(false); }} />
  </article>;
}
