import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CustomEmoji } from "@e2ee-chat/shared";
import { serializeCustomEmojiShortcodes } from "../../lib/custom-emojis.js";
import { api } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useUiPreferencesStore } from "../../stores/uiPreferencesStore.js";
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

export function useComposer({ onSend, onSendFile, disabled, dropTarget }: ComposerOptions) {
  const [text, setText] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [compress, setCompress] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [attachmentError, setAttachmentError] = useState<"attachmentCompressionFailed" | "errorFileTooLarge" | null>(null);
  const activeCompression = useRef<AbortController | null>(null);
  const acceptsFiles = !!onSendFile;
  const userId = useAuthStore((state) => state.user?.id);
  const savedCompression = useUiPreferencesStore((state) => !!(userId && state.preferencesByUserId[userId]?.compressAttachments));
  const [dragging, setDragging] = useState(false);
  const [ttlSeconds, setTtlSeconds] = useState<string>("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => activeCompression.current?.abort(), []);

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

  useEffect(() => {
    if (!showEmojiPicker) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setShowEmojiPicker(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [showEmojiPicker]);

  const insertAtCursor = (value: string) => {
    const textarea = inputRef.current;
    if (!textarea) {
      setText((prev) => `${prev}${value}`);
      return;
    }

    const selectionStart = textarea.selectionStart ?? text.length;
    const selectionEnd = textarea.selectionEnd ?? text.length;
    const nextValue = `${text.slice(0, selectionStart)}${value}${text.slice(selectionEnd)}`;
    const nextCursor = selectionStart + value.length;
    setText(nextValue);
    window.requestAnimationFrame(() => {
      textarea.focus();
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
    setShowEmojiPicker(false);
    inputRef.current?.focus({ preventScroll: true });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setShowEmojiPicker(false); removeAttachment(); }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia?.("(pointer: coarse)").matches) {
      e.preventDefault();
      void handleSubmit(e);
    }
  };

  const stageFile = (file: File | undefined) => {
    if (!file || disabled || activeCompression.current) return;
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
    if (!target || !acceptsFiles) return;
    const over = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      const canStage = !disabled && !activeCompression.current;
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
      stageFile(event.dataTransfer.files[0]);
    };
    target.addEventListener("dragover", over);
    target.addEventListener("dragleave", leave);
    target.addEventListener("drop", drop);
    return () => {
      target.removeEventListener("dragover", over);
      target.removeEventListener("dragleave", leave);
      target.removeEventListener("drop", drop);
    };
  }, [dropTarget, disabled, savedCompression, acceptsFiles]);

  return {
    text, setText, pendingFile, removeAttachment, compress, compressing, attachmentError, dragging,
    canCompress: !!pendingFile && isCompressibleMedia(pendingFile),
    setCompress: (value: boolean) => { setCompress(value); setAttachmentError(null); },
    ttlSeconds, setTtlSeconds, showEmojiPicker, setShowEmojiPicker, inputRef, fileInputRef, pickerRef,
    customEmojis: customEmojisQuery.data ?? [], insertAtCursor, handleSubmit, handleKeyDown, handleFileChange,
  };
}
