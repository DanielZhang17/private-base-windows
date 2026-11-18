import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { Button, Disclosure, Icon, Notice, Spinner } from "../../ui/index.js";
import { transferBytes, transferDuration, transferNumber } from "./TransferChatPicker.js";
import { TransferHeading, TransferTile } from "./TransferPairingScreens.js";
import type { useHistoryTransfer } from "./useHistoryTransfer.js";

type Flow = ReturnType<typeof useHistoryTransfer>;

export function transferPercent(bytes: number, total: number): number {
  return total > 0 ? Math.min(100, Math.floor(bytes * 100 / total)) : 0;
}

export function TransferBar({ percent, thin = false, label, valueText }: {
  percent: number; thin?: boolean; label?: string; valueText?: string;
}) {
  return <div role={label ? "progressbar" : undefined} aria-label={label} aria-valuemin={label ? 0 : undefined}
    aria-valuemax={label ? 100 : undefined} aria-valuenow={label ? percent : undefined}
    aria-valuetext={label ? valueText : undefined} aria-hidden={label ? undefined : true}
    className={`transfer-bar ${thin ? "h-1" : "h-2"}`}>
    <div style={{ width: `${percent}%` }} />
  </div>;
}

function useTransferSpeed(bytes: number, total: number, moving: boolean) {
  const current = useRef(bytes);
  current.current = bytes;
  const [speed, setSpeed] = useState<number>();
  const [remaining, setRemaining] = useState<number>();
  useEffect(() => {
    setSpeed(undefined);
    setRemaining(undefined);
    if (!moving) return;
    const start = performance.now();
    const samples = [{ at: start, bytes: current.current }];
    let estimateAt = -Infinity;
    const timer = setInterval(() => {
      const now = performance.now();
      samples.push({ at: now, bytes: current.current });
      while (samples.length > 1 && samples[0].at < now - 5_100) samples.shift();
      if (now - start < 2_900) return;
      const first = samples[0];
      const rate = (current.current - first.bytes) * 1000 / Math.max(1, now - first.at);
      setSpeed(rate > 0 ? rate : undefined);
      if (now - estimateAt >= 5_000) {
        setRemaining(rate > 0 ? (total - current.current) / rate : undefined);
        estimateAt = now;
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [moving, total]);
  return { speed, remaining };
}

export function TransferProgressScreen({ flow, peer, deviceName, background, stop, resume, canKeepScreenOn }: {
  flow: Flow; peer: string; deviceName: string; background: () => void; stop: () => void; resume: () => void; canKeepScreenOn: boolean;
}) {
  const { phase, role, progress, manifest, checkpoint } = flow;
  const { bytes, totalBytes } = progress;
  const percent = transferPercent(bytes, totalBytes);
  const { speed, remaining } = useTransferSpeed(bytes, totalBytes, phase === "transferring");
  const completed = new Set(checkpoint?.completedChatIds);
  const scale = Math.floor(percent / 25) * 25;
  const paused = phase === "paused";
  let start = 0;
  return <div className="transfer-column transfer-fill space-y-4">
    <div className="space-y-1">
      <TransferHeading>{t(role === "receiver" ? "transfer.receivingTitle" : "transfer.sendingTitle")}</TransferHeading>
      <p className="text-sm text-ink-muted">{t(role === "receiver" ? "transfer.from" : "transfer.to", { deviceName: peer })}</p>
    </div>
    <div className="space-y-2 tabular-nums">
      <p className="text-4xl font-bold" aria-hidden="true">{percent}%</p>
      <TransferBar percent={percent} label={t("transfer.title")} valueText={t("transfer.progressValue", {
        percent, done: transferBytes(bytes), total: transferBytes(totalBytes),
      })} />
      <p className="text-sm text-ink-muted">{t("transfer.progressLine", {
        done: transferBytes(bytes), total: transferBytes(totalBytes), speed: speed === undefined ? "—" : t("transfer.perSecond", { size: transferBytes(speed) }),
        remaining: remaining === undefined ? "—" : remaining < 60 ? t("transfer.lessThanMinute")
          : t("transfer.aboutRemaining", { duration: transferDuration(remaining) }),
      })}</p>
      <span aria-live="polite" className="sr-only">{scale > 0 ? t("transfer.bannerProgress", { percent: scale }) : ""}</span>
    </div>
    {phase === "reconnecting" ? <Notice tone="warning"><span className="flex items-center gap-2"><Spinner label={null} />{t("transfer.reconnecting")}</span></Notice>
      : paused ? <Notice tone="warning">
        <p>{flow.error === "storage" ? t("transfer.failStorage", { deviceName: role === "receiver" ? deviceName : peer })
          : flow.error === "archive-changed" ? t("transfer.archiveChanged")
          : flow.error === "transfer-interrupted" ? t("transfer.interruptedFailure") : t("transfer.paused", {
          done: completed.size, total: checkpoint?.chats.length ?? manifest?.chats.length ?? 0, deviceName: role === "receiver" ? deviceName : peer,
        })}</p>
        <div className="mt-3 flex flex-wrap gap-2"><Button onClick={resume}>{t(flow.requiresPairing && flow.error !== "storage" ? "transfer.pairAgain" : "transfer.resume")}</Button>
          <Button variant="ghost" onClick={stop}>{t("transfer.stopTransfer")}</Button></div>
      </Notice>
      : <Notice live={false}><p>{t("transfer.keepOpen")}</p>{!canKeepScreenOn && <p className="mt-1">{t("transfer.screenMayTurnOff")}</p>}</Notice>}
    {!!manifest?.chats.length && <ul className="transfer-list">
      {manifest.chats.map((chat) => {
        const chatPercent = transferPercent(Math.max(0, bytes - start), chat.bytes);
        start += chat.bytes;
        const done = completed.has(chat.id) || chatPercent === 100;
        const skipped = done && !!chat.missingFiles?.length;
        const name = chat.name ?? t("directMessage");
        return <li key={chat.id} className="transfer-picker-row">
          {done ? <Icon name={skipped ? "alert" : "check-circle"} className={skipped ? "text-warning" : "text-success"} />
            : chatPercent > 0 ? <Spinner label={null} size={20} /> : <Icon name="clock" className="text-ink-muted" />}
          <div className="min-w-0 flex-1"><p title={name} className="truncate font-semibold">{name}</p>
            {done ? <p className="text-sm text-ink-muted">{skipped ? t("transfer.someSkipped") : t("transfer.chatDone", { count: chat.messages })}</p>
              : chatPercent > 0 ? <><TransferBar percent={chatPercent} thin label={name} /><p className="text-sm text-ink-muted">{chatPercent}%</p></>
              : <p className="text-sm text-ink-muted">{t("transfer.waiting")}</p>}
          </div>
        </li>;
      })}
    </ul>}
    <div className="transfer-bottom flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      <Button variant="secondary" onClick={background}>{t("transfer.continueBackground")}</Button>
      {!paused && <Button variant="danger-ghost" onClick={stop}>{t("transfer.stopTransfer")}</Button>}
    </div>
  </div>;
}

export function TransferSummary({ flow, peer, finish }: { flow: Pick<Flow, "role" | "summary">; peer: string; finish: () => void }) {
  const receiver = flow.role === "receiver";
  const summary = flow.summary;
  return <div className="transfer-column transfer-fill space-y-4">
    <TransferTile icon="check-circle" tone="success" />
    <TransferHeading>{t(receiver ? "transfer.doneReceiver" : "transfer.doneSender")}</TransferHeading>
    {summary && <>
      <dl className="grid grid-cols-2 gap-3">
        {([
          [t("transfer.statChats"), transferNumber(summary.chats)],
          [t("transfer.statMessages"), transferNumber(summary.messages)],
          [t("transfer.statFiles"), transferNumber(summary.attachmentFiles)],
          [t("transfer.statTime"), transferDuration(summary.elapsedMs / 1000, true)],
        ]).map(([label, value]) => <div key={label} className="rounded-control bg-sunken p-3">
          <dt className="text-xs font-semibold text-ink-muted">{label}</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
        </div>)}
      </dl>
      {!!summary.skippedChats?.length && <Notice tone="warning" title={t("transfer.skippedChats")}>
        <ul className="list-disc ps-4">{summary.skippedChats.map(({ id, name }) => <li key={id}>{name ?? t("transfer.skippedChatUnknown")}</li>)}</ul>
      </Notice>}
      {!!(summary.missingFileCount || summary.missingFiles.length) && <>
        <Notice tone="warning">{t("transfer.filesMissing", { count: summary.missingFileCount || summary.missingFiles.length, deviceName: receiver ? peer : t("transfer.thisDevice") })}</Notice>
        {!!summary.missingFiles.length && <Disclosure summary={t("transfer.showFiles")} className="border-y border-line">
          <ul className="list-disc space-y-1 pb-3 ps-5 text-sm">{summary.missingFiles.map((name, index) => <li key={index} className="break-words">{name}</li>)}</ul>
        </Disclosure>}
      </>}
    </>}
    <Button size="lg" fullWidth className="transfer-bottom" onClick={finish}>{t(receiver ? "transfer.goToChats" : "transfer.done")}</Button>
  </div>;
}
