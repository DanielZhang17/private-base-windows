import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { PasskeyLoginOptionsResponse, PasskeyRegistrationOptionsResponse } from "@e2ee-chat/shared";
import { t, useLocale } from "../i18n/index.js";
import { Button, Notice } from "../ui/index.js";
import { createPasskeyCredential, getPasskeyAssertion } from "../lib/webauthn.js";
import { getHandoffProvisionHash } from "../platform/passkeyHandoff.js";
import { resolveApiUrl } from "../services/api-url.js";

// Deliberately bypass the session API client: no bearer token, cookies, refresh, or token storage.
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(resolveApiUrl(path), {
    method: "POST", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("Handoff failed");
  return response.json();
}

export default function NativePasskeyPage() {
  useLocale();
  const location = useLocation();
  const [params] = useState(() => new URLSearchParams(location.search));
  const adding = location.pathname === "/native/passkey/add";
  const state = params.get("state") ?? "";
  const valueKey = adding ? "ticket" : "challenge";
  const value = params.get(valueKey) ?? "";
  const bundleHash = getHandoffProvisionHash(params, !adding);
  const valid = bundleHash !== null && /^[A-Za-z0-9_-]{43}$/.test(state) && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    params.getAll("state").length === 1 && params.getAll(valueKey).length === 1 &&
    [...params.keys()].every(key => key === "state" || key === valueKey ||
      (bundleHash && (key === "mode" || key === "bundleHash"))) && window.self === window.top;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [callback, setCallback] = useState<string | null>(null);
  const returnLink = useRef<HTMLAnchorElement>(null);
  const inFlight = useRef(false);
  const provisionOptions = useRef<PasskeyLoginOptionsResponse | undefined>(undefined);
  const [provisionReady, setProvisionReady] = useState(false);
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const platform = /Android/i.test(navigator.userAgent) ? "Android" : /iPhone|iPad/i.test(navigator.userAgent) ? "iOS"
    : /Windows/i.test(navigator.userAgent) ? "Windows" : "macOS";
  useEffect(() => {
    if (!valid || !bundleHash) return;
    let active = true;
    void post<PasskeyLoginOptionsResponse>("/auth/passkey/provision-options", { bundleHash, handoff: { codeChallenge: value } })
      .then(options => { if (active) { provisionOptions.current = options; setProvisionReady(true); } })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [valid, bundleHash, value, prepareAttempt]);
  useEffect(() => {
    // Keep the ticket out of history and subsequent referrers. The state lives only in this page.
    window.history.replaceState(null, "", location.pathname);
  }, [location.pathname]);
  useEffect(() => { if (callback) returnLink.current?.click(); }, [callback]);

  const run = async () => {
    if (!valid || inFlight.current || callback) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const result = new URL("privatebase://passkey");
      result.searchParams.set("state", state);
      if (adding) {
        const { challengeId, options } = await post<PasskeyRegistrationOptionsResponse>("/auth/passkey/handoff/register-options", { ticket: value });
        const credential = await createPasskeyCredential(options);
        const { pendingId } = await post<{ pendingId: string }>("/auth/passkey/handoff/register", { ticket: value, challengeId, credential });
        result.searchParams.set("registered", pendingId);
      } else {
        const handoff = { codeChallenge: value };
        const path = bundleHash ? "/auth/passkey/provision" : "/auth/passkey/login";
        const input = bundleHash ? { bundleHash, handoff } : { handoff };
        const { challengeId, options } = provisionOptions.current ?? await post<PasskeyLoginOptionsResponse>(`${path}-options`, input);
        const credential = await getPasskeyAssertion(options);
        const { code } = await post<{ code: string }>(path, { challengeId, credential, ...input });
        result.searchParams.set("code", code);
      }
      setCallback(result.href);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  };

  return <main className="min-h-dvh bg-canvas text-ink flex items-center justify-center p-6">
    <section className="w-full max-w-sm space-y-5 rounded-card border border-line bg-surface p-6">
      <img src="/brand/icon-rounded.svg" alt="Private Base" className="size-14" />
      <h1 className="text-xl font-semibold">{adding ? t("addAPasskey") : bundleHash ? t("passkeySetup.browserHeadingPlatform", { platform }) : t("signInWithAPasskey")}</h1>
      <p className="text-ink-muted">{t(bundleHash ? "nativePasskeyProvisionPrompt" : "nativePasskeyBrowserPrompt")}</p>
      {(!valid || failed) && <Notice tone="danger" action={valid && bundleHash && !provisionReady
        ? <Button variant="secondary" onClick={() => { setFailed(false); setPrepareAttempt(attempt => attempt + 1); }}>{t("retry")}</Button>
        : undefined}>{t(!valid ? "nativePasskeyInvalidRequest" : "nativePasskeyFailed")}</Notice>}
      {callback ? <a ref={returnLink} href={callback} className="block text-brand underline">{t("nativePasskeyReturn")}</a> :
        <Button fullWidth loading={busy} disabled={!valid || failed || (!!bundleHash && !provisionReady)} onClick={() => void run()}>{t(bundleHash ? "passkeySetup.browserContinue" : "continue")}</Button>}
    </section>
  </main>;
}
