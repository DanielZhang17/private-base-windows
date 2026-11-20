import { useState } from "react";
import { t, useLocale } from "../../i18n/index.js";
import { copyText } from "../../platform/clipboard.js";
import type { CallDiagnostics, CallMediaStats } from "../../features/calls/CallContext.js";
import { Button, Dialog, IconButton } from "../../ui/index.js";

function DiagnosticRow({ label, value }: { label: string; value?: string }) {
  return <div className="grid grid-cols-2 gap-3 py-1">
    <dt className="text-ink-muted">{label}</dt>
    <dd className="text-end tabular-nums">{value ?? "—"}</dd>
  </div>;
}

export default function CallDiagnosticsControl({ diagnostics }: { diagnostics: CallDiagnostics | null }) {
  useLocale();
  const [open, setOpen] = useState(false);
  return <>
    <IconButton icon="info" label={t("callDiagnosticsTitle")} size="lg" variant="secondary" aria-haspopup="dialog" onClick={() => setOpen(true)} />
    {open && <CallDiagnosticsPanel diagnostics={diagnostics} onClose={() => setOpen(false)} />}
  </>;
}

function CallDiagnosticsPanel({ diagnostics, onClose }: { diagnostics: CallDiagnostics | null; onClose: () => void }) {
  const { locale } = useLocale();
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed">();
  const bitrate = new Intl.NumberFormat(locale, { style: "unit", unit: "kilobit-per-second", maximumFractionDigits: 1 });
  const milliseconds = new Intl.NumberFormat(locale, { style: "unit", unit: "millisecond" });
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const number = new Intl.NumberFormat(locale, { useGrouping: false });
  const streams: [title: string, stats: CallMediaStats | undefined, video?: boolean][] = [
    [t("callDiagnosticsAudioSent"), diagnostics?.audioSent],
    [t("callDiagnosticsAudioReceived"), diagnostics?.audioReceived],
    [t("callDiagnosticsVideoSent"), diagnostics?.videoSent, true],
    [t("callDiagnosticsVideoReceived"), diagnostics?.videoReceived, true],
  ];

  async function copyDiagnostics() {
    if (!diagnostics) return;
    try {
      await copyText(JSON.stringify(diagnostics, null, 2));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  // Offset by the native overlay title bar (0 outside desktop shells) so a tall panel never sits under it.
  return <Dialog open surface="dark" title={t("callDiagnosticsTitle")} onClose={onClose} dismissOnBack
      className="pt-safe px-safe pb-safe! mt-[var(--titlebar-height)] max-h-[calc(100dvh-var(--titlebar-height)-3rem)] sm:max-h-[calc(100dvh-var(--titlebar-height)-3rem)] [@media(max-height:400px)]:overflow-y-auto [@media(max-height:400px)]:[&>div]:shrink-0"
      footer={<div className="flex flex-wrap items-center justify-end gap-3">
        <p role="status" className="min-w-0 text-sm text-ink-muted">
          {copyStatus === "copied" ? t("textCopied") : copyStatus === "failed" ? t("callDiagnosticsCopyFailed") : null}
        </p>
        <Button variant="secondary" disabled={!diagnostics} onClick={() => void copyDiagnostics()}>{t("callDiagnosticsCopy")}</Button>
      </div>}>
      {/* Focusable so keyboard users can scroll the stats with arrow / Page keys inside the dialog body. */}
      {diagnostics ? <div tabIndex={0} role="region" aria-label={t("callDiagnosticsTitle")}
        className="space-y-3 rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
        <dl>
          <DiagnosticRow label={t("callDiagnosticsLocalCandidate")} value={diagnostics.localCandidateType} />
          <DiagnosticRow label={t("callDiagnosticsRemoteCandidate")} value={diagnostics.remoteCandidateType} />
          <DiagnosticRow label={t("callDiagnosticsTransport")} value={diagnostics.transport?.toUpperCase()} />
          {diagnostics.localCandidateType === "relay" && <DiagnosticRow label={t("callDiagnosticsTurnTransport")} value={diagnostics.turnTransport?.toUpperCase()} />}
          <DiagnosticRow label={t("callDiagnosticsRtt")} value={diagnostics.roundTripTimeMs === undefined ? undefined : milliseconds.format(diagnostics.roundTripTimeMs)} />
        </dl>
        {streams.map(([title, stats, video]) => stats && <section key={title} className="border-t border-line pt-3">
          <h3 className="font-semibold">{title}</h3>
          <dl>
            <DiagnosticRow label={t("callDiagnosticsCodec")} value={stats.codec} />
            <DiagnosticRow label={t("callDiagnosticsBitrate")} value={stats.bitrateBps === undefined ? undefined : bitrate.format(stats.bitrateBps / 1000)} />
            <DiagnosticRow label={t("callDiagnosticsPacketLoss")} value={stats.packetLoss === undefined ? undefined : percent.format(stats.packetLoss)} />
            {video && <DiagnosticRow label={t("callDiagnosticsResolution")} value={stats.resolution &&
              `${number.format(stats.resolution.width)} × ${number.format(stats.resolution.height)}`} />}
          </dl>
        </section>)}
      </div> : <p className="text-sm text-ink-muted">{t("callDiagnosticsWaiting")}</p>}
  </Dialog>;
}
