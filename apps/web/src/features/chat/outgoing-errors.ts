import en from "../../i18n/locales/en.json";
import { t, type TranslationKey } from "../../i18n/index.js";
import { translateError, toErrorMessage } from "../shared/errors.js";

export const INTERRUPTED_FILE_ERROR = "fileEncryptionWasInterruptedAttachTheFileAgain";
/** Durable queue records contain a source key, never an exception's localized message. */
export function outgoingErrorKey(error: unknown): TranslationKey {
  const failure = error as { code?: string; message?: string; status?: number } | null;
  const message = typeof error === "string" ? error : failure?.message;
  if (message && Object.hasOwn(en, message)) return message as TranslationKey;
  const known = toErrorMessage(error, "messageNotSent");
  if (!known.diagnostic) return known.key;
  if (error instanceof TypeError || failure?.status === 0) return "errorNetworkError";
  if (failure?.status === 429) return "errorRateLimitExceeded";
  return "messageNotSent";
}

export function outgoingErrorLabel(key: string): string {
  // Older queues may contain an English diagnostic rather than a key.
  return Object.hasOwn(en, key) ? t(key as TranslationKey) : translateError(key, "messageNotSent");
}
