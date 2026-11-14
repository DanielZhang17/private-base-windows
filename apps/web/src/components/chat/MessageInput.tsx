import { formatDuration } from "../../i18n/format.js";
import { t, useLocale } from "../../i18n/index.js";
import { useState } from "react";
import { useComposer, TTL_OPTIONS, type ComposerOptions } from "../../features/chat/useComposer.js";
import { formatBytes } from "../../features/chat/useFilePreview.js";
import { Badge, Button, Field, Select, IconButton, Notice, Sheet, Textarea } from "../../ui/index.js";
import EmojiPickerPopover from "./EmojiPickerPopover.js";

export default function MessageInput(props: ComposerOptions) {
  useLocale();
  const input = useComposer(props);
  const [attachOpen, setAttachOpen] = useState(false);
  return <form onSubmit={input.handleSubmit} className={`shrink-0 border-t border-line px-2 pt-2 pb-safe ${input.dragging ? "bg-brand-soft" : "bg-surface"}`}>
    {input.pendingFile && <div className="mb-2 rounded-control bg-sunken px-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{input.pendingFile.name} · {formatBytes(input.pendingFile.size)}</span>
        <IconButton icon="close" label={t("removeAttachment")} onClick={input.removeAttachment} />
      </div>
      {input.canCompress && <label className="flex min-h-10 items-center gap-2">
        <input type="checkbox" className="size-4 shrink-0 accent-[var(--primary)]" checked={input.compress} disabled={input.compressing}
          onChange={(event) => input.setCompress(event.target.checked)} />
        {t("compressAttachment")}
      </label>}
      {input.compressing && <p role="status" className="pb-2 text-ink-muted">{t("compressingAttachment")}</p>}
      {input.attachmentError && <Notice className="mb-2" tone="warning">{t(input.attachmentError)}</Notice>}
    </div>}
    {input.ttlSeconds && <div className="mb-2 flex items-center gap-2 px-2"><Badge icon="timer">{t("disappearsAfterDuration", { duration: formatDuration(Number(input.ttlSeconds)) })}</Badge><IconButton icon="close" label={t("turnOffMessageTimer")} onClick={() => input.setTtlSeconds("")} /></div>}
    <div className="flex items-end gap-1 pb-2">
      {props.onSendFile && <><input ref={input.fileInputRef} type="file" aria-label={t("attachFile")} className="hidden" onChange={input.handleFileChange} /><IconButton icon="attach" label={t("attachFile")} onClick={() => setAttachOpen(true)} disabled={props.disabled || input.compressing} /></>}
      <Textarea ref={input.inputRef} value={input.text} onChange={(event) => { input.setText(event.target.value); props.onTyping?.(); }} onKeyDown={input.handleKeyDown} placeholder={input.dragging ? t("dropFileToAttach") : t("typeAMessage")} aria-label={t("message")} rows={1} className="flex-1 rounded-[22px] border-transparent bg-sunken [&>textarea]:max-h-36 [&>textarea]:resize-none [&>textarea]:bg-transparent" disabled={props.disabled} readOnly={input.compressing} />
      <div ref={input.pickerRef} className="relative flex shrink-0">
        <IconButton icon="emoji" label={t("addEmoji")} onClick={() => input.setShowEmojiPicker(!input.showEmojiPicker)} disabled={props.disabled || input.compressing} />
        {!input.compressing && input.showEmojiPicker && <EmojiPickerPopover customEmojis={input.customEmojis} onSelectUnicode={input.insertAtCursor} onSelectCustom={(shortcode) => input.insertAtCursor(`:${shortcode}:`)} />}
      </div>
      <IconButton icon="send" label={t("sendMessageAction")} type="submit" className="send-button-themed" disabled={(!input.text.trim() && !input.pendingFile) || props.disabled || input.compressing} />
    </div>
    <Sheet open={attachOpen} onClose={() => setAttachOpen(false)} title={t("attach")}>
      <div className="space-y-4">
        {props.onSendFile && <Button variant="secondary" leadingIcon="attach" fullWidth onClick={() => { setAttachOpen(false); input.fileInputRef.current?.click(); }}>{t("chooseFile")}</Button>}
        <Field label={t("timedMessageExpiry")}><Select aria-label={t("timedMessageExpiry")} className="h-11 rounded-control border border-line-strong bg-surface px-3" value={input.ttlSeconds} onChange={(event) => { input.setTtlSeconds(event.target.value); setAttachOpen(false); }}>{TTL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.value ? formatDuration(Number(option.value)) : t("messageTimerOff")}</option>)}</Select></Field>
      </div>
    </Sheet>
  </form>;
}
