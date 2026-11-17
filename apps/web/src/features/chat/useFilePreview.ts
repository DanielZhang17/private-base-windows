import { renderMessage, LocalizedError, type LocalizedMessage } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { useLocale, getLocale } from "../../i18n/index.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { decryptFile } from "@e2ee-chat/crypto";
import type { FileEncryptionKey } from "@e2ee-chat/crypto";
import { ApiError, api, resolveApiUrl } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { openFile, prepareFileOpen, filePreviewKind, isFileOpenBlocked, canOpenFile, SaveUnsupportedError } from "../../platform/files.js";
import { capabilities } from "../../platform/capabilities.js";
import { isNative } from "../../platform/environment.js";
import { t } from "../../i18n/index.js";
import { fileUrlResolver } from "../../lib/file-url-resolver.js";
import { useFileSave } from "../../features/chat/useFileSave.js";
import { captureSaveFeedback } from "./save-feedback.js";

export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

const ATTACHMENT_RETRY_DELAYS_MS = [200, 500, 1000, 1500];

export interface FilePreviewOptions {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileKey: string;
  fileIv: string;
  sizeBytes: number;
}

function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Uint8Array(bytes);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function createResponseError(response: Response): Promise<ApiError> {
  const body = await response.json().catch(() => ({ error: response.statusText }));
  const message = typeof body?.error === "string" ? body.error : response.statusText;
  const code = typeof body?.code === "string" ? body.code : undefined;
  return new ApiError(message, response.status, code);
}

export function useFilePreview({ fileId, fileName, mimeType, fileKey, fileIv, sizeBytes }: FilePreviewOptions) {
  useLocale();
  const { saveUnsupported, handleSave } = useFileSave();
  const active = useRef(false);
  const currentFileId = useRef(fileId);
  currentFileId.current = fileId;
  const isActive = () => active.current && currentFileId.current === fileId;
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [textPreview, setTextPreview] = useState<{ content: string; tooLarge: boolean } | null>(null);
  const closeTextPreview = () => setTextPreview(null);
  const loadedBlob = useRef<Blob | null>(null);
  const urlRef = useRef<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [expired, setExpired] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openBlocked, setOpenBlocked] = useState(false);
  const [actionWarning, setActionWarning] = useState(false);
  const blocked = openBlocked || isFileOpenBlocked(fileName, mimeType);
  const canOpen = !blocked && canOpenFile(fileName, mimeType);

  useEffect(() => setOpenBlocked(false), [fileId, fileName, mimeType, fileKey, fileIv]);

  const type = mimeType.trim().toLowerCase();
  const kind = filePreviewKind(type);
  const isText = kind === "text" && !isNative();
  const isImage = kind === "image";
  const isVideo = kind === "video";
  const isInline = !blocked && (isImage || (isVideo && document.createElement("video").canPlayType(type) !== ""));

  const load = useCallback(async (): Promise<Blob | null> => {
    if (!isActive()) return null;
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    const isCurrent = () => requestRef.current === request && !request.signal.aborted;
    setLoading(true);
    setError(null);
    setExpired(false);
    try {
      // Only encrypted bytes are fetched; decrypted bytes remain in memory.
      let resolvedUrl: { downloadUrl: string | null; expiresAt: number | null } | null = null;
      for (let attempt = 0; attempt <= ATTACHMENT_RETRY_DELAYS_MS.length; attempt += 1) {
        if (!isCurrent()) return null;
        try {
          resolvedUrl = await fileUrlResolver.resolve(fileId);
          if (!isCurrent()) return null;
          if (resolvedUrl.downloadUrl) break;
          
          if (attempt === ATTACHMENT_RETRY_DELAYS_MS.length) {
            // Last attempt failed, maybe it's actually expired?
            // Fallback to individual check to get real error
            resolvedUrl = await api.get<{ downloadUrl: string; expiresAt: number | null }>(`/api/files/download-url/${fileId}`);
          } else {
            await sleep(ATTACHMENT_RETRY_DELAYS_MS[attempt]);
          }
        } catch (err: any) {
          if (!isCurrent()) return null;
          if (err instanceof ApiError && err.code === "FILE_EXPIRED") {
            if (isCurrent()) setExpired(true);
            return null;
          }
          if (attempt === ATTACHMENT_RETRY_DELAYS_MS.length) throw err;
          await sleep(ATTACHMENT_RETRY_DELAYS_MS[attempt]);
        }
      }

      if (!isCurrent()) return null;
      if (!resolvedUrl?.downloadUrl) {
        throw new LocalizedError("fileDownloadUrlWasUnavailable");
      }

      const token = useAuthStore.getState().accessToken;
      if (!token) {
        throw new LocalizedError("missingAccessTokenForFileDownload");
      }

      const response = await fetch(resolveApiUrl(resolvedUrl.downloadUrl), {
        signal: request.signal,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        throw await createResponseError(response);
      }

      const encryptedBytes = new Uint8Array(await response.arrayBuffer());
      const key: FileEncryptionKey = { key: fileKey, iv: fileIv };
      const decrypted = await decryptFile(encryptedBytes, key);
      if (!isCurrent()) return null;
      const blob = new Blob([toArrayBufferView(decrypted)], { type: mimeType });
      loadedBlob.current = blob;

      if (isInline) {
        const nextUrl = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = nextUrl;
        setObjectUrl(nextUrl);
      }
      return blob;
    } catch (err: any) {
      if (!isCurrent()) return null;
      if (err instanceof ApiError && err.code === "FILE_EXPIRED") {
        setExpired(true);
        return null;
      }
      setError(toErrorMessage(err, "failedToLoadFile"));
      return null;
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [fileId, fileKey, fileIv, mimeType, isInline]);

  useEffect(() => {
    active.current = true;
    setObjectUrl(null);
    closeTextPreview();
    loadedBlob.current = null;
    if (isInline) void load();
    return () => {
      active.current = false;
      requestRef.current?.abort();
      requestRef.current = null;
      loadedBlob.current = null;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [load, isInline]);

  async function handleDownload(): Promise<void> {
    if (!isActive()) return;
    const feedback = captureSaveFeedback(isNative() ? fileName : undefined);
    if (saveUnsupported) {
      feedback.publish("danger", "savingFilesIsUnavailableOnThisDeviceImages");
      return;
    }
    const blob = loadedBlob.current ?? (await load());
    if (!blob || !isActive() || !feedback.isSaveSessionCurrent()) return;
    const mode = capabilities.fileSave;
    try {
      const result = await handleSave(blob, fileName);
      if (result !== "saved" || mode === "downloads" || mode === "share") return;
      feedback.publish("success", "fileSaved");
    } catch {
      feedback.publish("danger", "failedToSaveFile");
    }
  }

  async function handleOpen() {
    if (!isActive()) return;
    setActionError(null);
    setActionWarning(false);
    if (blocked) { setActionWarning(true); setActionError(t("fileSafetyWarning")); return; }
    if (!canOpen || (isNative() && !capabilities.fileOpen && capabilities.saveFile)) return handleDownload();
    let prepared: ReturnType<typeof prepareFileOpen> = null;
    try {
      if (isText && sizeBytes > MAX_TEXT_PREVIEW_BYTES) {
        setTextPreview({ content: "", tooLarge: true });
        return;
      }
      // Reserve on every tap, including cached PDFs. noopener's null result cannot
      // distinguish a successful direct open from a blocked popup after the fact.
      if (!isText) prepared = prepareFileOpen(mimeType);
      const blob = loadedBlob.current ?? (await load());
      if (!blob) { prepared?.cancel(); return; }
      if (isText) {
        if (blob.size > MAX_TEXT_PREVIEW_BYTES) { setTextPreview({ content: "", tooLarge: true }); return; }
        const content = await blob.text();
        if (isActive()) setTextPreview({ content, tooLarge: false });
      } else if (prepared) prepared.open(blob);
      else await openFile(blob, fileName, mimeType);
    } catch (err) {
      prepared?.cancel();
      const code = typeof err === "string" ? err : err instanceof Error ? err.message : "";
      if (code === "blocked") setOpenBlocked(true);
      setActionWarning(code === "blocked");
      setActionError(t(code === "blocked" ? "fileSafetyWarning" : err instanceof SaveUnsupportedError || code === "unsupported" ? "fileOpenUnsupported" : code === "no_app" ? "fileOpenNoApp" : code === "cancelled" ? "fileOpenCancelled" : "fileOpenFailed"));
    }
  }

  return { blocked, canOpen, actionWarning, fileSaveMode: capabilities.fileSave, openBlocked, textPreview, closeTextPreview, canPreview: isInline, actionError, clearActionError: () => setActionError(null), handleOpen, objectUrl, loading, error: error ? renderMessage(error) : null, expired, isImage, isVideo, saveUnsupported, load, handleDownload };
}

export function formatBytes(bytes: number): string {
  const value = bytes < 1024 ? bytes : bytes < 1024 * 1024 ? bytes / 1024 : bytes / 1024 / 1024;
  const unit = bytes < 1024 ? "B" : bytes < 1024 * 1024 ? "KB" : "MB";
  const digits = bytes < 1024 ? 0 : 1;
  return `${new Intl.NumberFormat(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)} ${unit}`;
}
