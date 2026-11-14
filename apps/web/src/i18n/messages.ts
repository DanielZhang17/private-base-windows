import { isValidElement } from "react";
import { t, type TranslationKey } from "./index.js";

/** UI copy kept in state stays independent of the current language. */
export interface LocalizedMessage {
  key: TranslationKey;
  params?: Record<string, string | number>;
  diagnostic?: string;
}

export function localized(key: TranslationKey, params?: LocalizedMessage["params"]): LocalizedMessage {
  return { key, params };
}

export function isLocalizedMessage(value: unknown): value is LocalizedMessage {
  return typeof value === "object" && value !== null && !isValidElement(value) && "key" in value;
}

export function renderMessage(message: LocalizedMessage): string {
  const text = t(message.key, { replace: message.params });
  return message.diagnostic ? t("errorWithDiagnostic", { message: text, diagnostic: message.diagnostic }) : text;
}

/** Local failures carry copy metadata; exceptions are never translated when thrown. */
export class LocalizedError extends Error {
  readonly localizedMessage: LocalizedMessage;

  constructor(key: TranslationKey, params?: LocalizedMessage["params"]) {
    super(key);
    this.name = "LocalizedError";
    this.localizedMessage = localized(key, params);
  }
}
