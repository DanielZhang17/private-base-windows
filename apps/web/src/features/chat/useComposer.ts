import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CustomEmoji } from "@e2ee-chat/shared";
import { literalShortcodeSpans, parseEmojiTextSegments, serializeCustomEmojiShortcodes, type RetainedEmojiSpan } from "../../lib/custom-emojis.js";
import { api } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useUiPreferencesStore } from "../../stores/uiPreferencesStore.js";
import { getTopOverlay } from "../../ui/overlay-stack.js";
import { compressAttachment, fitsAttachmentLimit, isCompressibleMedia } from "./attachment-compression.js";

interface SendOptions {
  ttlSeconds: number | null;
}

export interface ComposerOptions {
  onSend: (text: string, options: SendOptions) => void;
  onSendFile?: (file: File, options: SendOptions) => void;
  onTyping?: () => void;
  disabled?: boolean;
  dropTarget?: RefObject<HTMLElement | null>;
  messageList?: RefObject<HTMLDivElement | null>;
  editing?: { id: string; content: string };
  editConflict?: boolean;
  onSaveEdit?: (id: string, text: string) => Promise<boolean>;
  onCancelEdit?: () => void;
}

export const TTL_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "", value: "" },
  { label: "1m", value: "60" },
  { label: "3m", value: "180" },
  { label: "5m", value: "300" },
  { label: "1h", value: "3600" },
  { label: "6h", value: "21600" },
  { label: "1d", value: "86400" },
  { label: "3d", value: "259200" },
  { label: "7d", value: "604800" },
];

function editDraftFromWire(content: string) {
  let text = "";
  const emojis: RetainedEmojiSpan[] = [];
  for (const segment of parseEmojiTextSegments(content)) {
    const end = text.length + segment.value.length;
    if (segment.emojiId) emojis.push({ start: text.length, end, id: segment.emojiId });
    else emojis.push(...literalShortcodeSpans(segment.value, text.length));
    text += segment.value;
  }
  return { text, emojis };
}

function replaceEditDraft(draft: ReturnType<typeof editDraftFromWire>, text: string, start: number, end: number) {
  const shift = text.length - draft.text.length;
  const emojis = draft.emojis.flatMap((emoji) => emoji.end <= start ? [emoji] : emoji.start >= end
    ? [{ ...emoji, start: emoji.start + shift, end: emoji.end + shift }] : []);
  return { text, emojis };
}

function updateEditDraft(draft: ReturnType<typeof editDraftFromWire>, text: string, cursor?: number) {
  if (draft.text === text) return draft;
  // The caret marks the end of a textarea edit. Prefer that suffix even when
  // the new text happens to be identical to an adjacent original shortcode.
  const suffixHint = cursor !== undefined && draft.text.endsWith(text.slice(cursor)) ? text.length - cursor : undefined;
  const sharedLength = Math.min(text.length, draft.text.length);
  let start = 0;
  while (start < sharedLength - (suffixHint ?? 0) && draft.text[start] === text[start]) start++;
  let suffix = suffixHint ?? 0;
  while (suffix < sharedLength - start && draft.text.at(-1 - suffix) === text.at(-1 - suffix)) suffix++;
  return replaceEditDraft(draft, text, start, draft.text.length - suffix);
}

export function useComposer({ onSend, onSendFile, disabled, dropTarget, editing, editConflict, onSaveEdit, onCancelEdit }: ComposerOptions, phone = false) {
  const [draft, setDraft] = useState("");
  const [editDraft, setEditDraft] = useState(() => editDraftFromWire(""));
  const [savingEdit, setSavingEdit] = useState(false);
  const savingEditRef = useRef(false);
  const text = editing ? editDraft.text : draft;
  const setText = (value: string, cursor?: number) => {
    if (editing) setEditDraft((previous) => updateEditDraft(previous, value, cursor));
    else setDraft(value);
  };
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [compress, setCompress] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [attachmentError, setAttachmentError] = useState<"attachmentCompressionFailed" | "errorFileTooLarge" | null>(null);
  const activeCompression = useRef<AbortController | null>(null);
  const editingMessage = !!editing;
  const acceptsFiles = !!onSendFile && !editingMessage;
  const userId = useAuthStore((state) => state.user?.id);
  const savedCompression = useUiPreferencesStore((state) => !!(userId && state.preferencesByUserId[userId]?.compressAttachments));
  const [dragging, setDragging] = useState(false);
  const [ttlSeconds, setTtlSeconds] = useState<string>("");
  const editingId = editing?.id;
  const [pickerEditingId, setPickerEditingId] = useState<string | null | undefined>(null);
  const showEmojiPicker = pickerEditingId !== null && pickerEditingId === editingId;
  const setShowEmojiPicker = useCallback((open: boolean) => {
    setPickerEditingId(open ? editingId : null);
  }, [editingId]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);


  useEffect(() => () => activeCompression.current?.abort(), []);

  useLayoutEffect(() => {
    setPickerEditingId(null);
    if (!editing) return;
    setEditDraft(editDraftFromWire(editing.content));
  }, [editing?.id]);

  useEffect(() => {
    // The mobile Sheet restores its trigger during passive cleanup.
    if (editing && !getTopOverlay()) inputRef.current?.focus({ preventScroll: true });
  }, [editing?.id]);

  useLayoutEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(144, textarea.scrollHeight)}px`;
  }, [text]);

  const customEmojisQuery = useQuery({
    queryKey: ["myCustomEmojis"],
    queryFn: () => api.get<CustomEmoji[]>("/api/emojis/mine"),
    staleTime: 60_000,
  });

  const sendOptions: SendOptions = {
    ttlSeconds: ttlSeconds ? Number(ttlSeconds) : null,
  };

  const sendSticker = useCallback((token: string) => {
    if (editingMessage || disabled || activeCompression.current) return;
    onSend(token, { ttlSeconds: ttlSeconds ? Number(ttlSeconds) : null });
  }, [onSend, ttlSeconds, editingMessage, disabled]);

  const insertAtCursor = (value: string) => {
    if (savingEditRef.current) return;
    const textarea = inputRef.current;
    if (!textarea) {
      setText(`${text}${value}`, text.length + value.length);
      return;
    }

    const selectionStart = textarea.selectionStart ?? text.length;
    const selectionEnd = textarea.selectionEnd ?? text.length;
    const nextValue = `${text.slice(0, selectionStart)}${value}${text.slice(selectionEnd)}`;
    const nextCursor = selectionStart + value.length;
    if (editing) setEditDraft((previous) => replaceEditDraft(previous, nextValue, selectionStart, selectionEnd));
    else setText(nextValue, nextCursor);
    window.requestAnimationFrame(() => {
      if (!phone || !showEmojiPicker) textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const removeAttachment = () => {
    activeCompression.current?.abort();
    activeCompression.current = null;
    setCompressing(false);
    setAttachmentError(null);
    setPendingFile(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (editing) {
      if (disabled || editConflict || !trimmed || !onSaveEdit || savingEditRef.current) return;
      const serialized = serializeCustomEmojiShortcodes(text, customEmojisQuery.data ?? [], editDraft.emojis).trim();
      if (serialized === editing.content.trim()) { onCancelEdit?.(); return; }
      savingEditRef.current = true;
      setSavingEdit(true);
      try {
        if (await onSaveEdit(editing.id, serialized)) onCancelEdit?.();
      } finally {
        savingEditRef.current = false;
        setSavingEdit(false);
      }
      return;
    }
    if (disabled || activeCompression.current || (!trimmed && !pendingFile)) return;
    if (pendingFile) {
      let ready = pendingFile;
      if (compress && isCompressibleMedia(ready)) {
        const controller = new AbortController();
        activeCompression.current = controller;
        setCompressing(true);
        setAttachmentError(null);
        const sessionId = useAuthStore.getState().sessionId;
        try {
          ready = await compressAttachment(ready, controller.signal);
          if (controller.signal.aborted || sessionId !== useAuthStore.getState().sessionId) return;
        } catch {
          if (!controller.signal.aborted) setAttachmentError("attachmentCompressionFailed");
          return;
        } finally {
          if (activeCompression.current === controller) {
            activeCompression.current = null;
            if (!controller.signal.aborted) setCompressing(false);
          }
        }
      }
      if (!fitsAttachmentLimit(ready)) {
        setAttachmentError("errorFileTooLarge");
        return;
      }
      onSendFile?.(ready, sendOptions);
      setPendingFile(null);
      setAttachmentError(null);
    }
    const serialized = serializeCustomEmojiShortcodes(trimmed, customEmojisQuery.data ?? []);
    if (trimmed) onSend(serialized, sendOptions);
    setText("");
    if (!phone || !showEmojiPicker) {
      setShowEmojiPicker(false);
      inputRef.current?.focus({ preventScroll: true });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !showEmojiPicker && !e.defaultPrevented && !getTopOverlay()) {
      if (editing) {
        if (!e.nativeEvent.isComposing && !savingEditRef.current) onCancelEdit?.();
        return;
      }
      removeAttachment();
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia?.("(pointer: coarse)").matches) {
      e.preventDefault();
      void handleSubmit(e);
    }
  };

  const stageFile = (file: File | undefined) => {
    if (!file || disabled || editing || activeCompression.current) return;
    setPendingFile(file);
    setCompress(savedCompression && isCompressibleMedia(file));
    setAttachmentError(null);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    stageFile(e.target.files?.[0]);
    e.target.value = "";
  };

  useEffect(() => {
    const target = dropTarget?.current;
    if (!target || (!acceptsFiles && !editingMessage)) return;
    const over = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      const canStage = acceptsFiles && !disabled && !activeCompression.current;
      event.dataTransfer.dropEffect = canStage ? "copy" : "none";
      setDragging(canStage);
    };
    const leave = (event: DragEvent) => {
      if (!(event.relatedTarget instanceof Node) || !target.contains(event.relatedTarget)) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      setDragging(false);
      if (acceptsFiles) stageFile(event.dataTransfer.files[0]);
    };
    target.addEventListener("dragover", over);
    target.addEventListener("dragleave", leave);
    target.addEventListener("drop", drop);
    return () => {
      target.removeEventListener("dragover", over);
      target.removeEventListener("dragleave", leave);
      target.removeEventListener("drop", drop);
    };
  }, [dropTarget, disabled, savedCompression, acceptsFiles, editingMessage]);

  return {
    text, setText, pendingFile, removeAttachment, compress, compressing, attachmentError, dragging, savingEdit,
    canCompress: !!pendingFile && isCompressibleMedia(pendingFile),
    setCompress: (value: boolean) => { setCompress(value); setAttachmentError(null); },
    ttlSeconds, setTtlSeconds, showEmojiPicker, setShowEmojiPicker, inputRef, fileInputRef, sendSticker,
    customEmojis: customEmojisQuery.data ?? [], insertAtCursor, handleSubmit, handleKeyDown, handleFileChange,
  };
}
