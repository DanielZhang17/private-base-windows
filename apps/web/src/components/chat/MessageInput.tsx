import { formatDuration } from "../../i18n/format.js";
import { t, useLocale } from "../../i18n/index.js";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useComposer, TTL_OPTIONS, type ComposerOptions } from "../../features/chat/useComposer.js";
import { formatBytes } from "../../features/chat/useFilePreview.js";
import { Badge, Button, Field, Select, Icon, IconButton, Notice, Sheet, Textarea } from "../../ui/index.js";
import ComposerPicker from "./EmojiPickerPopover.js";
import { useStickerPicker } from "../../features/stickers/useStickerPicker.js";
import type { StickerTab } from "../../features/stickers/storage.js";
import { useComposerPanel, useComposerScrollAnchor, usePickerDismissal } from "../../features/stickers/useComposerPanel.js";
import { OVERLAY_RANK } from "../../ui/overlay-stack.js";
import { useOverlayLayer } from "../../ui/useOverlayLayer.js";

export default function MessageInput(props: ComposerOptions) {
  useLocale();
  const [attachOpen, setAttachOpen] = useState(false);
  const editing = !!props.editing;
  const [phone, setPhone] = useState(() => window.matchMedia?.("(max-width: 639px)").matches ?? false);
  const input = useComposer(props, phone);
  const [selectedTab, setSelectedTab] = useState<StickerTab>();
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const picker = useStickerPicker();
  const registerSender = picker?.registerSender;
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const blocked = !!props.disabled || input.compressing || input.savingEdit;
  const stickerSendBlocked = blocked || editing;
  const open = input.showEmojiPicker && !blocked;
  const inline = phone && open;
  const dismiss = useCallback((restore = false) => {
    input.setShowEmojiPicker(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  }, [input.setShowEmojiPicker]);
  const geometry = useComposerPanel(phone, inline, input.inputRef, dismiss);
  const isTop = useOverlayLayer(open, "popover", OVERLAY_RANK.picker, inline ? () => dismiss(true) : undefined);
  usePickerDismissal({ open, phone, isTop, picker: panel, trigger, list: props.messageList, dismiss });
  useComposerScrollAnchor(props.messageList);
  const senderRef = useRef(input.sendSticker);
  senderRef.current = input.sendSticker;
  useLayoutEffect(() => {
    registerSender?.(stickerSendBlocked ? undefined : (text) => senderRef.current(text));
    return () => registerSender?.(undefined);
  }, [registerSender, stickerSendBlocked]);
  useLayoutEffect(() => { if (blocked) dismiss(); }, [blocked, dismiss]);
  useLayoutEffect(() => { if (editing || props.disabled) setAttachOpen(false); }, [editing, props.disabled]);
  useLayoutEffect(() => { if (inline && document.activeElement === input.inputRef.current) geometry.blurForPanel(); }, [inline]);
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 639px)");
    const resize = () => { if (query) setPhone(query.matches); };
    query?.addEventListener("change", resize);
    return () => query?.removeEventListener("change", resize);
  }, []);
  const body = open && <ComposerPicker id={id} panelRef={panel} presentation={phone ? "panel" : "popover"} focusOnOpen={focusOnOpen}
    allowStickers={!editing} tab={selectedTab ?? picker?.state.tab ?? "unicode"} onTab={(tab) => {
      setSelectedTab(tab);
      if (picker) void picker.change((state) => ({ ...state, tab }));
    }}
    customEmojis={input.customEmojis} onSelectUnicode={input.insertAtCursor} onSelectCustom={(shortcode) => input.insertAtCursor(`:${shortcode}:`)} />;

  return <form data-call-avoid="bottom" onSubmit={input.handleSubmit} className={`shrink-0 border-t border-line px-2 pt-2 ${!inline && (!phone || geometry.occupied < 1) ? "pb-safe" : ""} ${input.dragging ? "bg-brand-soft" : "bg-surface"}`}>
    {editing && <div className="mb-2 rounded-control bg-sunken px-3 py-1 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 font-semibold"><Icon name="edit" size={16} />{t("editingMessage")}</span>
        <Button variant="ghost" size="sm" onClick={() => { props.onCancelEdit?.(); input.inputRef.current?.focus({ preventScroll: true }); }} disabled={input.savingEdit}>{t("cancel")}</Button>
      </div>
      {!input.text.trim() && <p role="status" className="pb-2 text-ink-muted">{t("emptyMessageEdit")}</p>}
      {props.editConflict && <p role="alert" className="pb-2 text-danger">{t("messageEditConflict")}</p>}
    </div>}
    {!editing && input.pendingFile && <div className="mb-2 rounded-control bg-sunken px-3 text-sm">
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
    {!editing && input.ttlSeconds && <div className="mb-2 flex items-center gap-2 px-2"><Badge icon="timer">{t("disappearsAfterDuration", { duration: formatDuration(Number(input.ttlSeconds)) })}</Badge><IconButton icon="close" label={t("turnOffMessageTimer")} onClick={() => input.setTtlSeconds("")} /></div>}
    <div className="sticker-composer-row">
      {!editing && props.onSendFile && <><input ref={input.fileInputRef} type="file" aria-label={t("attachFile")} className="hidden" onChange={input.handleFileChange} /><IconButton icon="attach" label={t("attachFile")} className="sticker-composer-attach" onClick={() => { dismiss(); setAttachOpen(true); }} disabled={blocked} /></>}
      <Textarea ref={input.inputRef} onFocus={geometry.measure} onBlur={geometry.measure} onClick={() => { if (inline) geometry.showKeyboard(); }} value={input.text} onChange={(event) => { input.setText(event.target.value, event.target.selectionStart ?? undefined); if (!editing) props.onTyping?.(); }} onKeyDown={input.handleKeyDown} placeholder={input.dragging ? t("dropFileToAttach") : t("typeAMessage")} aria-label={t("message")} rows={1} className="sticker-composer-field" disabled={props.disabled} readOnly={editing ? input.savingEdit : input.compressing} />
      <div className="flex shrink-0">
        <IconButton ref={trigger} data-sticker-focus-fallback="" icon={inline ? "keyboard" : "emoji"} label={t(inline ? "showKeyboard" : editing ? "addEmoji" : "emojiAndStickers")}
          aria-haspopup={phone ? undefined : "dialog"} aria-expanded={open} aria-controls={open ? id : undefined}
          className="sticker-composer-trigger" disabled={blocked}
          onPointerDown={(event) => { if (event.button === 0) event.preventDefault(); }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            if (inline) geometry.showKeyboard();
            else if (open) dismiss(event.detail === 0);
            else {
              setFocusOnOpen(event.detail === 0);
              input.setShowEmojiPicker(true);
            }
          }} />
      </div>
      {open && <div className="composer-picker-dock" data-panel={inline || undefined} style={inline ? {
        blockSize: `max(0px, calc(${geometry.height - geometry.occupied}px + var(--safe-bottom)))`,
      } : undefined}>{body}</div>}
      <IconButton icon={editing ? "check" : "send"} label={t(editing ? "saveChangesAction" : "sendMessageAction")} type="submit" className="send-button-themed" disabled={(!input.text.trim() && (editing || !input.pendingFile)) || blocked || props.editConflict} />
    </div>
    {phone && geometry.overlay > 0 && <div aria-hidden="true" style={{ blockSize: geometry.overlay }} />}
    <Sheet open={attachOpen && !editing && !props.disabled} onClose={() => setAttachOpen(false)} title={t("attach")}>
      <div className="space-y-4">
        {props.onSendFile && <Button variant="secondary" leadingIcon="attach" fullWidth onClick={() => { setAttachOpen(false); input.fileInputRef.current?.click(); }}>{t("chooseFile")}</Button>}
        <Field label={t("timedMessageExpiry")}><Select aria-label={t("timedMessageExpiry")} className="h-11 rounded-control border border-line-strong bg-surface px-3" value={input.ttlSeconds} onChange={(event) => { input.setTtlSeconds(event.target.value); setAttachOpen(false); }}>{TTL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.value ? formatDuration(Number(option.value)) : t("messageTimerOff")}</option>)}</Select></Field>
      </div>
    </Sheet>
  </form>;
}
