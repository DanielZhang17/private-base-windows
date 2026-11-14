import { localized } from "../i18n/messages.js";
import { t, useLocale } from "../i18n/index.js";
import { useSafetyNumber } from "../features/verify/useSafetyNumber.js";
import { SettingsFrame } from "../features/settings/SettingsFrame.js";
import { Avatar, Badge, Button, Icon, Notice, Skeleton, TopBar, useToast } from "../ui/index.js";

function VerifyView({ v }: { v: ReturnType<typeof useSafetyNumber> }) {
  useLocale();
  const toast = useToast();
  const name = v.remoteUser?.displayName ?? t("thisContact");
  async function copy() { try { await v.copySafetyNumber(); toast.show({ tone: "success", message: localized("safetyNumberCopied") }); } catch { toast.show({ tone: "danger", message: localized("couldNotCopySafetyNumber") }); } }
  return <>

    <TopBar
      title={t("verifySafetyNumber")}
      onBack={() => v.navigate(-1)}
      backOnPhoneOnly
    />

    <div className="min-h-0 grow overflow-y-auto pb-safe">
      <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">

        <div className="flex items-center justify-center gap-6 py-2">
          <div className="flex min-w-0 flex-col items-center gap-2">
            <Avatar
              name={v.localUser?.displayName ?? t("selfDisplayName")}
              src={v.localAvatarSrc}
              size="lg"
            />
            <p className="text-sm text-ink-muted">{t("selfDisplayName")}</p>
          </div>
          <Icon
            name="shield"
            size={28}
            className="text-ink-muted"
          />
          <div className="flex min-w-0 flex-col items-center gap-2">
            <Avatar
              name={name}
              src={v.remoteAvatarSrc}
              size="lg"
            />
            <p className="max-w-40 truncate text-sm text-ink-muted">
              {name}
            </p>
          </div>
        </div>

        <div className="text-center">
          <Badge tone={v.verified ? "success" : "neutral"} icon={v.verified ? "shield-check" : "shield"}>
            {v.verified ? t("verified") : t("notVerified")}
          </Badge>
        </div>

        {v.verificationChanged && <Notice tone="warning" title={t("safetyNumberChanged")}>{t("sSafetyNumberChangedThisHappensWhenSomeone", { name: name, name1: name })}</Notice>}

        {v.noIdentity ? <Notice>{t("hasNotFinishedSettingUp", { name: name })}</Notice> : v.error ? <Notice tone="danger" action={<Button variant="secondary" onClick={v.retry}>{t("retry")}</Button>}>
          {v.error}
        </Notice> : <>

          <p className="text-center text-sm text-ink-muted">{t("compareThisNumberWithTheOneOnS", { name: name })}</p>

          <div
            aria-label={t("safetyNumber")}
            aria-busy={!v.safetyNumber}
            className="secret-text grid grid-cols-3 gap-x-3 gap-y-5 rounded-card bg-sunken p-5 text-center text-lg sm:grid-cols-4"
          >
            {v.safetyNumber ? v.groups.map((group, index) => <span key={index}>
              {group}
            </span>) : Array.from({ length: 12 }, (_, index) => <Skeleton key={index} className="h-6 w-full" />)}
          </div>

          <p className="text-center text-xs text-ink-muted">{t("ifTheNumbersMatchYouAreTalkingTo")}</p>

          {v.verificationError && <Notice tone="danger">
            {v.verificationError}
          </Notice>}

          <div className="flex flex-wrap justify-center gap-3">
            <Button
              variant="secondary"
              leadingIcon="copy"
              disabled={!v.safetyNumber}
              onClick={() => void copy()}
            >{t("copy")}</Button>
            <Button
              leadingIcon={v.verified ? "shield" : "shield-check"}
              disabled={!v.safetyNumber}
              onClick={() => { if (v.toggleVerification()) toast.show({ tone: "success", message: v.verified ? localized("verificationRemoved") : localized("safetyNumberVerified") }); }}
            >
              {v.verified ? t("removeVerification") : t("markAsVerified")}
            </Button>
          </div>

        </>}

      </div>
    </div>

  </>;
}
export default function VerifyPage() {
  useLocale();
  const verification = useSafetyNumber();
  return <SettingsFrame title={t("verifySafetyNumber")} detail={<VerifyView v={verification} />} />;
}
