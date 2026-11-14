import { t, useLocale } from "../../i18n/index.js";
import { useState } from "react";
import type { LocalKeyOwner } from "../../lib/key-manager.js";
import { Button, Icon, Notice } from "../../ui/index.js";
import ForgetLocalKeysDialog from "./ForgetLocalKeysDialog.js";

/**
 * Shown when signing in or registering would overwrite encryption keys this browser already
 * holds. Deleting them requires an explicit confirmation.
 */
export default function ForgetLocalKeysPrompt({ owner, sameAccount = false, error, loading, onSignInInstead, onForget }: {
  /** Owner of the local keys; null when they exist but their owner is unknown. */
  owner: LocalKeyOwner | null;
  /** The keys belong to the account being signed in to, but their device id was lost. */
  sameAccount?: boolean;
  error: string;
  loading: boolean;
  onSignInInstead: () => void;
  onForget: () => void;
}) {
  useLocale();
  const [confirmForget, setConfirmForget] = useState(false);
  const account = owner ? `@${owner.username}` : t("anotherAccount");

  return (
    <main className="h-dvh overflow-y-auto bg-canvas text-ink px-safe pt-safe pb-safe">
      <div className="flex min-h-full flex-col items-center px-4 py-7 sm:justify-center">
        <section className="flex w-full max-w-[26rem] flex-col gap-4 sm:rounded-card sm:border sm:border-line sm:bg-surface sm:p-8 sm:shadow-raised">
          <span className="flex size-11 items-center justify-center rounded-full bg-warn-soft text-warn"><Icon name="alert" size={24} /></span>
          <h1 className="text-[1.375rem] leading-tight font-semibold tracking-tight">{t("thisBrowserAlreadyHoldsEncryptionKeys")}</h1>
          <p className="text-ink-muted">{sameAccount
            ? t("thisBrowserHoldsEncryptionKeysForButNo", { account: account })
            : t("thisBrowserHoldsTheEncryptionKeysForSigning", { account: account })}</p>
          {error && !confirmForget && <Notice tone="danger">{error}</Notice>}
          <Button disabled={loading} onClick={onSignInInstead}>
            {owner && !sameAccount ? t("signInAsInstead", { account: account }) : t("returnToSignIn")}
          </Button>
          <Button variant="danger-ghost" disabled={loading} onClick={() => setConfirmForget(true)}>
            {owner ? t("forgetSKeysOnThisBrowser", { account: account }) : t("forgetThisAccountSKeysOnThisBrowser")}
          </Button>
        </section>
      </div>
      <ForgetLocalKeysDialog open={confirmForget} loading={loading} error={error} onForget={onForget} onCancel={() => setConfirmForget(false)} />
    </main>
  );
}
