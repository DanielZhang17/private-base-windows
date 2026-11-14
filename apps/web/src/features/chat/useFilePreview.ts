import { renderMessage, LocalizedError, type LocalizedMessage } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { useLocale, getLocale } from "../../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import { decryptFile } from "@e2ee-chat/crypto";
import type { FileEncryptionKey } from "@e2ee-chat/crypto";
import { ApiError, api, resolveApiUrl } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { getCachedFile, setCachedFile } from "../../db/index.js";
import { fileUrlResolver } from "../../lib/file-url-resolver.js";
import { useFileSave } from "../../features/chat/useFileSave.js";

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

export function useFilePreview({ fileId, fileName, mimeType, fileKey, fileIv }: FilePreviewOptions) {
  useLocale();
  const { saveUnsupported, handleSave } = useFileSave();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const loadedBlob = useRef<Blob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LocalizedMessage | null>(null);
  const [expired, setExpired] = useState(false);

  const isImage = mimeType.startsWith("image/");
  const isVideo = mimeType.startsWith("video/");
  const isInline = isImage || isVideo;

  useEffect(() => {
    if (!isInline) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  async function load(): Promise<Blob | null> {
    setLoading(true);
    setError(null);
    setExpired(false);
    try {
      // 1. Check IndexedDB cache first
      const cached = await getCachedFile(fileId);
      if (cached && cached.expiresAt > Date.now()) {
        loadedBlob.current = cached.blob;
        const nextUrl = URL.createObjectURL(cached.blob);
        setObjectUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return nextUrl;
        });
        return cached.blob;
      }

      // 2. Cache miss — fetch, decrypt, cache
      let resolvedUrl: { downloadUrl: string | null; expiresAt: number | null } | null = null;
      for (let attempt = 0; attempt <= ATTACHMENT_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          resolvedUrl = await fileUrlResolver.resolve(fileId);
          if (resolvedUrl.downloadUrl) break;
          
          if (attempt === ATTACHMENT_RETRY_DELAYS_MS.length) {
            // Last attempt failed, maybe it's actually expired?
            // Fallback to individual check to get real error
            resolvedUrl = await api.get<{ downloadUrl: string; expiresAt: number | null }>(`/api/files/download-url/${fileId}`);
          } else {
            await sleep(ATTACHMENT_RETRY_DELAYS_MS[attempt]);
          }
        } catch (err: any) {
          if (err instanceof ApiError && err.code === "FILE_EXPIRED") {
            setExpired(true);
            return null;
          }
          if (attempt === ATTACHMENT_RETRY_DELAYS_MS.length) throw err;
          await sleep(ATTACHMENT_RETRY_DELAYS_MS[attempt]);
        }
      }

      if (!resolvedUrl?.downloadUrl) {
        throw new LocalizedError("fileDownloadUrlWasUnavailable");
      }

      const token = useAuthStore.getState().accessToken;
      if (!token) {
        throw new LocalizedError("missingAccessTokenForFileDownload");
      }

      const response = await fetch(resolveApiUrl(resolvedUrl.downloadUrl), {
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
      const blob = new Blob([toArrayBufferView(decrypted)], { type: mimeType });
      loadedBlob.current = blob;

      // 3. Store in IndexedDB
      await setCachedFile({
        id: fileId,
        blob,
        mimeType,
        fileName,
        cachedAt: Date.now(),
        expiresAt: resolvedUrl.expiresAt ?? Date.now(),
      });

      const nextUrl = URL.createObjectURL(blob);
      setObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return nextUrl;
      });
      return blob;
    } catch (err: any) {
      if (err instanceof ApiError && err.code === "FILE_EXPIRED") {
        setExpired(true);
        return null;
      }
      setError(toErrorMessage(err, "failedToLoadFile"));
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function handleDownload() {
    if (saveUnsupported) return;
    const blob = loadedBlob.current ?? (await load());
    if (!blob) return;
    try {
      await handleSave(blob, fileName);
    } catch (err: any) {
      setError(toErrorMessage(err, "failedToSaveFile"));
    }
  }

  return { objectUrl, loading, error: error ? renderMessage(error) : null, expired, isImage, isVideo, saveUnsupported, load, handleDownload };
}

export function formatBytes(bytes: number): string {
  const value = bytes < 1024 ? bytes : bytes < 1024 * 1024 ? bytes / 1024 : bytes / 1024 / 1024;
  const unit = bytes < 1024 ? "B" : bytes < 1024 * 1024 ? "KB" : "MB";
  const digits = bytes < 1024 ? 0 : 1;
  return `${new Intl.NumberFormat(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)} ${unit}`;
}
