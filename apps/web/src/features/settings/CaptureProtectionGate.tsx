import { useEffect, type ReactNode } from "react";
import { t, useLocale } from "../../i18n/index.js";
import { Button, Notice, Spinner } from "../../ui/index.js";
import { bypassCaptureGuard, ensureHiddenCaptureProtection, useCaptureGuard, useCaptureToggleHidden } from "./hiddenOptions.js";

/**
 * Android app: covers unlocked content until screenshot protection is confirmed on (its switch is hidden there).
 * Everywhere else, and once the user has revealed the switch, it renders its children straight away.
 */
export function CaptureProtectionGate({ children }: { children: ReactNode }) {
  useLocale();
  const hidden = useCaptureToggleHidden();
  const guard = useCaptureGuard();
  useEffect(() => { if (hidden && guard === "pending") void ensureHiddenCaptureProtection(); }, [hidden, guard]);
  if (!hidden || guard === "on" || guard === "bypassed") return <>{children}</>;
  return <div className="h-dvh bg-canvas flex flex-col gap-6 items-center justify-center px-safe pb-safe pt-safe" data-capture-guard="">
    {guard === "pending" ? <Spinner size={32} /> : <div className="mx-4 grid max-w-sm gap-3">
      <Notice tone="warning">{t("captureProtectionStartFailed")}</Notice>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={bypassCaptureGuard}>{t("captureProtectionContinueAnyway")}</Button>
        <Button onClick={() => void ensureHiddenCaptureProtection()}>{t("retry")}</Button>
      </div>
    </div>}
  </div>;
}
