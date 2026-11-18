import { useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { Button, Icon, Notice, Spinner } from "../../ui/index.js";
import { AuthHeading } from "./AuthHeading.js";

export function NativeHandoffWait({ stage, error, restart, cancel, retry, canRetry, restarting }: {
  stage: "browser" | "redeeming"; error: string; restart: () => void; cancel: () => void;
  retry: () => void; canRetry: boolean; restarting: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(seconds => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [stage]);
  if (stage === "browser") return <>
    <div className="grid size-16 place-items-center rounded-card bg-brand-soft text-on-brand-soft"><Icon name="globe" size={28} /></div>
    <AuthHeading title={t("passkeySetup.browserTitle")} />
    <p className="text-ink-muted">{t("passkeySetup.browserBody")}</p>
    {elapsed >= 180
      ? <Notice tone="danger" action={<Button variant="secondary" disabled={restarting} onClick={restart}>{t("retry")}</Button>}>{t("passkeySetup.browserTimeout")}</Notice>
      : <Spinner label={t("passkeySetup.browserWaiting")} />}
    <div className="mt-auto flex flex-col gap-3 pt-5">
      <Button variant="secondary" size="lg" loading={restarting} onClick={restart}>{t("passkeySetup.restartSignIn")}</Button>
      <p className="text-sm text-ink-muted">{t("passkeySetup.restartSignInHelp")}</p>
      <Button variant="ghost" onClick={cancel}>{t("cancel")}</Button>
    </div>
  </>;
  const expired = elapsed >= 120;
  return <>
    <AuthHeading title={t("passkeySetup.signingIn")} />
    {!error && elapsed < 30 && <Spinner label={elapsed >= 15 ? t("stillWorking") : t("passkeySetup.signingIn")} />}
    {(error || elapsed >= 30) && <Notice tone="danger" action={<Button variant="secondary" disabled={!expired && !canRetry}
      onClick={expired ? restart : retry}>{t(expired ? "passkeySetup.restartSignIn" : "retry")}</Button>}>
      {t(expired ? "passkeySetup.browserTimeoutStart" : "passkeySetup.redeemFailed")}
    </Notice>}
    {(error || elapsed >= 30) && <Button variant="ghost" onClick={cancel}>{t("cancel")}</Button>}
  </>;
}
