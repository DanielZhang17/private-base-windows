import { expect, it } from "vitest";
import { setLocalePreference, t } from "../../i18n/index.js";
import { LocalizedError, renderMessage } from "../../i18n/messages.js";
import { toErrorMessage, translateError } from "./errors.js";

it("maps stable codes and exact server/lib diagnostics to message keys", async () => {
  await setLocalePreference("de");
  expect(toErrorMessage({ code: "FILE_EXPIRED", message: "backend detail" })).toEqual({ key: "fileExpired" });
  expect(toErrorMessage(new Error("Invalid credentials"))).toEqual({ key: "errorInvalidCredentials" });
  expect(translateError(new Error("Invalid credentials"))).toBe(t("errorInvalidCredentials"));
});

it("retains keys and interpolation parameters across language changes", async () => {
  await setLocalePreference("de");
  const message = toErrorMessage(new LocalizedError("finishRecoveryAs", { username: "alice" }));
  expect(message).toEqual({ key: "finishRecoveryAs", params: { username: "alice" } });
  expect(renderMessage(message)).toBe(t("finishRecoveryAs", { username: "alice" }));
  await setLocalePreference("en");
  expect(renderMessage(message)).toBe("Finish recovery as @alice");
});

it.each(["unexpected backend detail", "File: arbitrary diagnostic", "Device: offline", "Invalid credentials: diagnostic"])("keeps unknown diagnostics intact with a localized fallback: %s", async (diagnostic) => {
  await setLocalePreference("de");
  const message = toErrorMessage(new Error(diagnostic));
  expect(message).toEqual({ key: "genericError", diagnostic });
  expect(renderMessage(message)).toBe(t("errorWithDiagnostic", { message: t("genericError"), diagnostic }));
  await setLocalePreference("en");
  expect(renderMessage(message)).toBe(`Something went wrong. Please try again.\n${diagnostic}`);
});

it("never reverse-matches presentation copy or already translated text", async () => {
  await setLocalePreference("de");
  const german = t("recoveryKeyCopied");
  await setLocalePreference("en");
  expect(toErrorMessage(german)).toEqual({ key: "genericError", diagnostic: german });
  expect(toErrorMessage("Recovery key copied")).toEqual({ key: "genericError", diagnostic: "Recovery key copied" });
});
