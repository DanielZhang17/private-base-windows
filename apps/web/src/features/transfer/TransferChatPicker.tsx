import { useEffect, useState } from "react";
import { getLocale, t } from "../../i18n/index.js";
import { Avatar, Button, Icon, Input, Notice } from "../../ui/index.js";
import { resolveAvatarImageUrl } from "../../lib/avatar-url.js";
import { onCellularData, wifiHintOnLargeTransfer } from "./stream.js";
import { TransferHeading, TransferWait } from "./TransferPairingScreens.js";
import type { useHistoryTransfer } from "./useHistoryTransfer.js";

type Flow = ReturnType<typeof useHistoryTransfer>;
type Chat = Awaited<ReturnType<Flow["listChats"]>>[number];
const CELLULAR_WARNING_BYTES = 50_000_000;

export function transferNumber(value: number): string {
  return new Intl.NumberFormat(getLocale()).format(value);
}
export function transferBytes(value?: number): string {
  if (value === undefined) return "—";
  const [unit, divisor] = value >= 1e9 ? ["gigabyte", 1e9] : value >= 1e6 ? ["megabyte", 1e6] : value >= 1e3 ? ["kilobyte", 1e3] : ["byte", 1];
  return new Intl.NumberFormat(getLocale(), { style: "unit", unit, unitDisplay: unit === "byte" ? "long" : "short", maximumFractionDigits: 1 }).format(value / divisor);
}
export function transferDuration(seconds: number, short = false): string {
  if (seconds < 60 && !short) return t("transfer.lessThanMinute");
  const unit = seconds < 60 ? "second" : seconds < 3600 ? "minute" : "hour";
  const value = Math.max(0, Math.round(seconds / (unit === "second" ? 1 : unit === "minute" ? 60 : 3600)));
  return new Intl.NumberFormat(getLocale(), { style: "unit", unit, unitDisplay: short ? "short" : "long" }).format(value);
}

export function TransferChatPicker({ flow, peer, deviceName }: { flow: Flow; peer: string; deviceName: string }) {
  const { listChats, checkpoint, prepare, send, canFinalize, startFresh } = flow;
  const [chats, setChats] = useState<Chat[]>();
  const [loadingError, setLoadingError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState(new Set<string>());
  const [files, setFiles] = useState(checkpoint?.copyDownloadedFiles ?? false);
  const [query, setQuery] = useState("");
  const [starting, setStarting] = useState(false);
  const [exactSize, setExactSize] = useState<number>();
  const [requiredBytes, setRequiredBytes] = useState<number>();
  const [actionError, setActionError] = useState(false);
  const [cellular, setCellular] = useState(onCellularData);

  useEffect(() => {
    let current = true;
    void listChats().then((entries) => {
      if (!current) return;
      const suggested = new Set(checkpoint?.chats.map(({ id }) => id));
      const completed = new Set(checkpoint?.completedChatIds);
      setChats(entries);
      setSelection(new Set(entries.filter(({ id, hidden }) => !hidden && (!checkpoint || suggested.has(id))
        && !completed.has(id)).map(({ id }) => id)));
    }).catch(() => { if (current) setLoadingError(true); });
    return () => { current = false; };
  // The checkpoint that opened this picker is the preselection. Starting a send also writes a checkpoint.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listChats, attempt]);

  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
    const update = () => setCellular(onCellularData());
    connection?.addEventListener("change", update);
    return () => connection?.removeEventListener("change", update);
  }, []);

  const completed = new Set(checkpoint?.completedChatIds);
  const search = query.trim().toLocaleLowerCase();
  const matches = (chat: Chat) => !search || (chat.name ?? "").toLocaleLowerCase().includes(search);
  const visible = chats?.filter((chat) => !chat.hidden && matches(chat)) ?? [];
  const hidden = chats?.filter((chat) => chat.hidden && matches(chat)) ?? [];
  const bulk = visible.filter(({ id }) => !completed.has(id));
  const selectedBulk = bulk.filter(({ id }) => selection.has(id)).length;
  const all = bulk.length > 0 && selectedBulk === bulk.length;
  const mixed = selectedBulk > 0 && !all;
  const selected = chats?.filter(({ id }) => selection.has(id) && !completed.has(id)) ?? [];
  const totalCached = selected.reduce((sum, chat) => sum + chat.cachedBytes, 0);
  const size = exactSize ?? selected.reduce((sum, chat) => sum + chat.bytes + (files ? chat.cachedBytes : 0), 0);
  const lazyFiles = selected.reduce((sum, chat) => sum + chat.files - (files ? chat.cachedFiles : 0), 0);
  const mobilePeer = flow.peerCapacity?.cellular ? peer : cellular ? deviceName : undefined;
  const mobileWarn = !!mobilePeer && size > CELLULAR_WARNING_BYTES;
  const wifiHint = !mobileWarn && size > 200_000_000 && (flow.peerCapacity?.wifiHint || wifiHintOnLargeTransfer());
  const free = flow.peerCapacity?.free;
  const exceedsFree = free !== undefined && requiredBytes !== undefined && requiredBytes > free;
  const needsSpaceCheck = free !== undefined && requiredBytes === undefined && size > free;
  useEffect(() => {
    if (flow.error === "archive-changed") { setExactSize(undefined); setRequiredBytes(undefined); }
  }, [flow.error]);
  const seconds = flow.estimatedBytesPerSecond ? size / flow.estimatedBytesPerSecond : undefined;
  const duration = seconds === undefined ? undefined : seconds < 60 ? t("transfer.lessThanMinute")
    : t("transfer.aboutDuration", { duration: transferDuration(seconds) });
  const chatCount = t("transfer.chatCount", { count: selected.length });
  const skipped = flow.manifest?.chats.reduce((sum, chat) => sum + (chat.skippedLegacyMessages ?? 0), 0) ?? 0;
  const noMoreChats = !!canFinalize && !selected.length;
  const editable = !starting && !flow.preparing;

  const changeSelection = (ids: string[], checked: boolean) => {
    setExactSize(undefined);
    setRequiredBytes(undefined);
    setActionError(false);
    setSelection((previous) => {
      const next = new Set(previous);
      for (const id of ids) if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };
  const start = async (recheckSpace = false) => {
    if (!editable || (exceedsFree && !recheckSpace) || (!selected.length && !noMoreChats)) return;
    setStarting(true);
    setActionError(false);
    try {
      const manifest = !recheckSpace && flow.canSend && exactSize !== undefined && flow.manifest ? flow.manifest
        : await prepare(selected.map(({ id }) => ({ conversationId: id })), { copyDownloadedFiles: files, ...(recheckSpace ? { checkSpace: true } : {}) });
      setExactSize(manifest.bytes);
      const required = "requiredBytes" in manifest && typeof manifest.requiredBytes === "number" ? manifest.requiredBytes : requiredBytes ?? manifest.bytes;
      setRequiredBytes(required);
      if (recheckSpace || needsSpaceCheck) return;
      const available = "freeBytes" in manifest ? manifest.freeBytes : free;
      if (!noMoreChats && typeof available === "number" && required > available) return;
      if (!mobileWarn && manifest.bytes > CELLULAR_WARNING_BYTES && (flow.peerCapacity?.cellular || onCellularData())) return;
      if (manifest.chats.some((chat) => chat.skippedLegacyMessages) && (exactSize === undefined || !manifest.chats.some((chat) => chat.messages))) return;
      await send();
    } catch { setActionError(true); }
    finally { setStarting(false); }
  };

  function chatRow(chat: Chat) {
    const name = chat.name ?? t("directMessage");
    const copied = completed.has(chat.id);
    const meta = copied ? t("transfer.alreadyCopied") : t("transfer.chatMeta", {
      count: chat.messages, size: transferBytes(chat.bytes + (files ? chat.cachedBytes : 0)),
    }) + (chat.pendingLegacyMessages ? ` · ${t("transfer.skippedLegacy", { count: chat.pendingLegacyMessages })}` : "");
    return <li key={chat.id}>
      <label className="transfer-picker-row">
        <input type="checkbox" className="transfer-checkbox" aria-label={`${name}, ${meta}`} checked={copied || selection.has(chat.id)}
          disabled={copied || !editable} onChange={(event) => changeSelection([chat.id], event.target.checked)} />
        <Avatar name={name} src={resolveAvatarImageUrl(chat.avatarUrl) ?? undefined} size="sm" />
        <span className="min-w-0"><span title={name} className="block truncate font-semibold">{name}</span><span className="block text-sm text-ink-muted">{meta}</span></span>
      </label>
    </li>;
  }
  const startLabel = noMoreChats ? t("transfer.finish") : needsSpaceCheck ? t("transfer.checkSpace")
    : mobileWarn ? t("transfer.startCellular") : t("transfer.start");
  return <>
    <div className="transfer-scroll">
      <div className="transfer-column space-y-4">
        <div className="space-y-1">
          <TransferHeading>{t("transfer.chooseTitle")}</TransferHeading>
          <p className="text-sm text-ink-muted">{free !== undefined ? t("transfer.toDevice", { deviceName: peer, free: transferBytes(free) }) : t("transfer.to", { deviceName: peer })}</p>
        </div>
        {loadingError ? <Notice tone="danger"><p>{t("transfer.prepareFailed")}</p><Button variant="secondary" onClick={() => {
          setLoadingError(false); setAttempt((value) => value + 1);
        }}>{t("transfer.tryAgain")}</Button></Notice> : !chats && <TransferWait>{t("transfer.loadingChats")}</TransferWait>}
        {exceedsFree && <Notice tone="danger">
          <p>{t("transfer.insufficientSpace", { deviceName: peer, free: transferBytes(free) })}</p>
          <Button className="mt-2" variant="secondary" disabled={!editable} onClick={() => void start(true)}>{t("transfer.checkSpace")}</Button>
        </Notice>}
        {needsSpaceCheck && <Notice tone="warning">
          {t("transfer.estimatedSpaceWarning", { deviceName: peer, free: transferBytes(free) })}
        </Notice>}
        {mobileWarn && <Notice tone="warning" icon="signal">{t("transfer.cellular", { deviceName: mobilePeer, size: transferBytes(size) })}</Notice>}
        {wifiHint && <Notice tone="warning" icon="signal">{t("transfer.wifiBest")}</Notice>}
        {skipped > 0 && <Notice tone="warning">{t("transfer.skippedLegacy", { count: skipped })}</Notice>}
        {flow.error === "archive-changed" ? <Notice tone="warning">{t("transfer.archiveChanged")}</Notice>
          : (flow.error === "export" || actionError) && <Notice tone="danger">{t("transfer.prepareFailed")}</Notice>}
        {chats && <>
          {checkpoint && <Button variant="ghost" disabled={!editable} onClick={() => {
            startFresh(); setExactSize(undefined); setRequiredBytes(undefined); setFiles(false); setActionError(false);
            setSelection(new Set(chats.filter((chat) => !chat.hidden).map(({ id }) => id)));
          }}>{t("transfer.startAgain")}</Button>}
          <div>
            <div className="transfer-list">
              {search ? <Button className="min-h-14 w-full justify-start" variant="ghost" disabled={!bulk.length || !editable}
                onClick={() => changeSelection(bulk.map(({ id }) => id), !all)}>{t(all ? "transfer.clearResults" : "transfer.selectResults", { count: bulk.length })}</Button>
                : <label className="transfer-picker-row font-semibold"><input type="checkbox" className="transfer-checkbox" checked={all}
                  aria-checked={mixed ? "mixed" : all} disabled={!bulk.length || !editable}
                  ref={(input) => { if (input) input.indeterminate = mixed; }} onChange={() => changeSelection(bulk.map(({ id }) => id), !all)} />
                {t("transfer.allChats", { count: chats.filter((chat) => !chat.hidden).length })}</label>}
              <label className="transfer-picker-row justify-between">
                <span><span className="block font-semibold" id="transfer-copy-files">{t("transfer.includeFiles")}</span>
                  <span className="block text-sm text-ink-muted">{totalCached ? t("transfer.filesOnDevice", { size: transferBytes(totalCached) }) : t("transfer.nothingSaved")}</span></span>
                <input type="checkbox" role="switch" className="transfer-switch" checked={files} disabled={!editable}
                  aria-labelledby="transfer-copy-files" aria-describedby="transfer-file-help"
                  onChange={(event) => { setExactSize(undefined); setRequiredBytes(undefined); setFiles(event.target.checked); }} />
              </label>
            </div>
            <p id="transfer-file-help" className="mt-2 text-sm text-ink-muted">{t("transfer.filesDisclosure", { deviceName: peer })}</p>
          </div>
          {chats.length > 12 && <Input type="search" leading={<Icon name="search" size={18} />} value={query} placeholder={t("transfer.searchChats")}
            aria-label={t("transfer.searchChats")} onChange={(event) => setQuery(event.target.value)} />}
          {!!visible.length && <ul className="transfer-list">{visible.map(chatRow)}</ul>}
          {!!hidden.length && <section className="space-y-2">
            <h2 className="text-sm font-semibold text-ink-muted">{t("transfer.hiddenChats")}</h2>
            <ul className="transfer-list">{hidden.map(chatRow)}</ul>
          </section>}
          {search && !visible.length && !hidden.length && <p className="text-sm text-ink-muted">{t("transfer.noResults")}</p>}
          <div className="text-xs text-ink-muted"><p>{t("transfer.alsoSent")}</p><p>{t("transfer.keysStay")}</p></div>
        </>}
      </div>
    </div>
    <footer className="transfer-footer">
      <div className="mx-auto flex w-full max-w-lg flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm">
          <p className="font-semibold">{noMoreChats ? t("transfer.allCopied") : !selected.length ? t("transfer.chooseOne") : duration
            ? t("transfer.summary", { chats: chatCount, size: transferBytes(size), duration })
            : t("transfer.summaryEstimating", { chats: chatCount, size: transferBytes(size) })}</p>
          {!!selected.length && <p className="text-ink-muted">{t(files ? "transfer.summaryWith" : "transfer.summaryWithout", { deviceName: peer })}</p>}
          {lazyFiles > 0 && <p className="text-xs text-ink-muted">{t("transfer.lazyFiles", { count: lazyFiles })}</p>}
        </div>
        <Button className="shrink-0" size="lg" loading={starting} disabled={exceedsFree || (!selected.length && !noMoreChats)}
          aria-label={noMoreChats || needsSpaceCheck ? undefined : t(mobileWarn ? "transfer.startCellularLabel" : "transfer.startLabel", {
            chats: chatCount, files: t(files ? "transfer.withFiles" : "transfer.withoutFiles"), deviceName: peer,
          })} onClick={() => void start()}>{startLabel}</Button>
      </div>
    </footer>
  </>;
}
