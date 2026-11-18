import { useLocation, useNavigate } from "react-router-dom";
import { t, useLocale } from "../i18n/index.js";
import { AuthHeading } from "../features/auth/AuthHeading.js";
import { Button, Icon } from "../ui/index.js";

export default function SessionEndedPage() {
  useLocale();
  const { state } = useLocation();
  const navigate = useNavigate();
  const name = (state as { replacementDeviceName?: unknown } | null)?.replacementDeviceName;
  return <main className="grid min-h-dvh place-items-center bg-canvas px-4 py-7 text-ink">
    <section className="grid w-full max-w-[26rem] gap-4 sm:rounded-card sm:border sm:border-line sm:bg-surface sm:p-8">
      <img src="/brand/icon-rounded.svg" alt="Private Base" className="size-14" />
      <div className="grid size-12 place-items-center rounded-control bg-warning-soft text-warning"><Icon name="device-desktop" /></div>
      <AuthHeading title={t("deviceAlert.sessionEndedTitle")} />
      <p className="text-ink-muted">{typeof name === "string" && name ? t("replace.sessionEnded", { newDeviceName: name }) : t("deviceAlert.sessionEnded")}</p>
      <Button size="lg" onClick={() => navigate("/login", { replace: true })}>{t("signInHeading")}</Button>
    </section>
  </main>;
}
