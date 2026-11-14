import { localized } from "../../i18n/messages.js";
import { formatTime } from "../../i18n/format.js";
import { t, useLocale } from "../../i18n/index.js";
import { useState } from "react";
import { attachmentName, parseFilePayload, type DecryptedMessage } from "../../features/chat/presentation.js";
import { copyMessageText } from "../../features/chat/message-actions.js";
import { Button, Icon, IconButton, Sheet, useToast } from "../../ui/index.js";
import FilePreview from "./FilePreview.js";
import InlineEmojiText from "./InlineEmojiText.js";
import TimedCountdownBadge from "./TimedCountdownBadge.js";

interface Props {
  message: DecryptedMessage;
  isOwn: boolean;
  isGroup?: boolean;
  senderAvatarUrl?: string | null;
  senderName?: string;
  failure?: string | null;
  onRetry?: () => void;
  onDiscard?: () => void;
}
export default function MessageBubble({ message, isOwn, isGroup, senderName, failure, onRetry, onDiscard }: Props) {
  useLocale();
  const [moreOpen, setMoreOpen] = useState(false);
  const toast = useToast();
  const failed = isOwn && message.status === "failed";
  const file = message.type === "file" ? parseFilePayload(message.content) : null;
  const time = formatTime(message.timestamp);
  const status = message.status === "sending" ? t("messageSendingStatus") : message.status === "sent" ? t("messageSentStatus") : message.status === "delivered" ? t("messageDeliveredStatus") : message.status === "read" ? t("messageReadStatus") : t("notSent");
  const content = message.type === "file" ? file ? <FilePreview fileId={file.fileId} fileName={file.fileName} mimeType={file.mimeType} fileKey={file.fileKey} fileIv={file.iv ?? file.fileIv!} sizeBytes={file.size ?? file.sizeBytes ?? 0} />
    : <span>{message.status === "sending" ? t("encryptingFile") : failed ? t("fileNotSent") : t("invalidFilePayload")}</span>
    : <InlineEmojiText content={message.content} />;
  if (!isOwn && message.status === "failed") return <p className="py-2 text-center text-sm text-ink-muted">{t("aMessageCouldNotBeDecrypted")} <Button variant="ghost" size="sm" onClick={() => toast.show({ message: localized("thisDeviceCouldNotOpenTheMessageWith") })}>{t("why")}</Button></p>;
  return <article className={`flex flex-col ${isOwn ? "items-end" : "items-start"} pb-2`} aria-label={t("messageAnnouncement", { name: isOwn ? t("selfDisplayName") : senderName ?? t("contactDisplayNameFallback"), status: failed ? t("notSent") : time })}>
    {isGroup && !isOwn && senderName && <p className="mb-1 px-3 text-xs font-semibold text-ink-muted">{senderName}</p>}
    {failed ? <button type="button" onClick={onRetry} disabled={!onRetry} aria-label={t("retryMessage", { content: message.type === "file" ? attachmentName(message.content) : message.content })} className="bubble bubble-own bubble-failed text-start">{message.type === "file" ? attachmentName(message.content) : <InlineEmojiText content={message.content} />}</button>
      : <div className={`bubble ${isOwn ? "bubble-own" : "bubble-incoming"}`}>{content}</div>}
    <div className={`flex min-h-7 flex-wrap items-center gap-1.5 px-1 pt-1 text-xs tabular-nums ${failed ? "font-semibold text-danger" : "text-ink-subtle"}`}>
      {failed ? <><Icon name="alert-circle" size={14} /><span>{t("notSent")}</span><Button variant="danger-ghost" size="sm" leadingIcon="retry" onClick={onRetry} disabled={!onRetry}>{t("retry")}</Button><IconButton icon="more" label={t("failedMessageActions")} onClick={() => setMoreOpen(true)} /></>
        : <>{message.status !== "sending" && <time dateTime={new Date(message.timestamp).toISOString()}>{time}</time>}{isOwn && <><Icon name={message.status === "sending" ? "clock" : message.status === "sent" ? "check" : "check-double"} size={14} className={message.status === "read" ? "text-brand" : undefined} /><span>{status}</span></>}
          {message.expiryKind === "timed" && message.expiresAt != null && <TimedCountdownBadge expiresAt={message.expiresAt} />}</>}
    </div>
    <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title={t("messageNotSent")}>
      {failure && <p className="mb-3 text-sm text-ink-muted">{failure}</p>}
      <div className="flex flex-col gap-2">
        {message.type === "text" && <Button variant="secondary" leadingIcon="copy" onClick={() => void copyMessageText(message.content).then(() => { setMoreOpen(false); toast.show({ tone: "success", message: localized("messageCopied") }); }).catch(() => toast.show({ tone: "danger", message: localized("couldNotCopyMessage") }))}>{t("copyText")}</Button>}
        <Button variant="danger-ghost" leadingIcon="trash" onClick={() => { onDiscard?.(); setMoreOpen(false); }} disabled={!onDiscard}>{t("discard")}</Button>
      </div>
    </Sheet>
  </article>;
}
