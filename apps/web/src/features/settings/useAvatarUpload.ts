import { LocalizedError } from "../../i18n/messages.js";
import { toErrorMessage } from "../shared/errors.js";
import { useLocale } from "../../i18n/index.js";
import { useEffect, useRef, useState } from "react";
import { api, resolveApiUrl } from "../../services/api.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useFeedback } from "../shared/useFeedback.js";

const AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_AVATAR_SIZE = 2 * 1024 * 1024;

export function useAvatarUpload(onChange: (avatarUrl: string) => void, onLocalFile?: (file: File) => void) {
  useLocale();
  const { pendingConfirmation, notice, noticeMessage, setNotice, dismissNotice } = useFeedback();
  const [uploading, setUploading] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);

  const uploadFile = async (file: File) => {
    if (!mounted.current || inFlight.current) return;
    inFlight.current = true;
    setUploading(true);
    setNotice(null);
    const abort = new AbortController();
    controller.current = abort;
    const { sessionId, accessToken } = useAuthStore.getState();
    try {
      if (!accessToken) throw new LocalizedError("missingAccessToken");
      const { uploadUrl } = await api.post<{ uploadUrl: string }>("/api/account/avatar-upload-url", {
        mimeType: file.type, sizeBytes: file.size,
      });
      const body = await file.arrayBuffer();
      const { accessToken: token, sessionId: currentSession } = useAuthStore.getState();
      if (!mounted.current || currentSession !== sessionId) return;
      if (!token) throw new LocalizedError("missingAccessToken");
      const response = await fetch(resolveApiUrl(uploadUrl), {
        method: "PUT", signal: abort.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": file.type },
        body,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(typeof body?.error === "string" ? body.error : response.statusText);
      }
      const { avatarUrl } = await response.json() as { avatarUrl: string };
      if (mounted.current && useAuthStore.getState().sessionId === sessionId) onChange(avatarUrl);
    } catch (error: any) {
      if (mounted.current) setNotice(toErrorMessage(error, "failedToUploadAvatar"));
    } finally {
      inFlight.current = false;
      if (mounted.current) setUploading(false);
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file || inFlight.current) return;
    try {
      if (!AVATAR_TYPES.has(file.type)) throw new LocalizedError("errorUnsupportedAvatarType");
      if (file.size <= 0 || file.size > MAX_AVATAR_SIZE) throw new LocalizedError("errorAvatarTooLarge");
      if (onLocalFile) {
        setNotice(null);
        onLocalFile(file);
      } else {
        await uploadFile(file);
      }
    } catch (error) {
      setNotice(toErrorMessage(error, "failedToUploadAvatar"));
    }
  };
  return { uploading, uploadFile, handleFileUpload, pendingConfirmation, notice, noticeMessage, dismissNotice };
}
