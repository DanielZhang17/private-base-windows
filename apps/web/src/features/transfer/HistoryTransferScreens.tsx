import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { t, useLocale } from "../../i18n/index.js";
import { formatDate } from "../../i18n/format.js";
import { refreshLatestConversationPreview } from "../../lib/message-sync.js";
import { subscribeHistoryImports, subscribeHistoryPreviews } from "../../lib/local-message-changes.js";
import { useAuthStore } from "../../stores/authStore.js";
import { Button, ConfirmDialog, Icon, IconButton, ListItem, Notice, TopBar, useToast } from "../../ui/index.js";
import type { HistoryTransferMarker } from "../../db/history-transfer.js";
import type { InterruptedHistoryTransfer } from "../../db/history-transfer-progress.js";
import { deviceTransferCapacity } from "./stream.js";
import { CompareTransferCode, EnterTransferWords, ScanTransferCode, ShowTransferInvitation, TransferHeading, TransferTile, TransferWait } from "./TransferPairingScreens.js";
import { TransferChatPicker, transferBytes } from "./TransferChatPicker.js";
import { TransferBar, TransferProgressScreen, TransferSummary, transferPercent } from "./TransferProgress.js";
import { useHistoryTransfer } from "./useHistoryTransfer.js";
import "./TransferScreens.css";

export const TRANSFER_PATH = "/devices/transfer";
export const TRANSFER_SETUP_PATH = "/setup/history-transfer";
export const TRANSFER_RECEIVE_PATH = transferLink("receive");

type Flow = ReturnType<typeof useHistoryTransfer>;
type Mode = "send" | "receive";

function transferLink(mode: Mode, peer?: string) {
  const params = new URLSearchParams({ mode });
  if (peer) params.set("peer", peer);
  return `${TRANSFER_PATH}?${params}`;
}
function isTransferScreen(pathname: string) {
  return pathname === TRANSFER_PATH || pathname === TRANSFER_SETUP_PATH;
}
function progressPhase(phase: Flow["phase"]) {
  return phase === "transferring" || phase === "reconnecting" || phase === "paused";
}

export function HistoryTransferOwner() {
  const { pathname } = useLocation();
  const flow = useHistoryTransfer();
  const toast = useToast();
  const visible = isTransferScreen(pathname);
  useEffect(() => subscribeHistoryPreviews((id) => { void refreshLatestConversationPreview(id).catch(() => undefined); }), []);
  const wasVisible = useRef(visible);
  const completed = useRef(false);
  useEffect(() => {
    if (wasVisible.current && !visible) {
      if (progressPhase(flow.phase)) flow.continueInBackground();
      else if (["starting", "waiting", "pairing", "ready"].includes(flow.phase)) flow.stop();
    }
    if (visible) flow.showTransfer();
    wasVisible.current = visible;
  }, [visible, flow.phase, flow.continueInBackground, flow.stop, flow.showTransfer]);
  useEffect(() => {
    if (flow.phase !== "complete") completed.current = false;
    else if (!visible && !completed.current && flow.peerDeviceName) {
      completed.current = true;
      toast.show({ tone: "success", message: t(flow.role === "receiver" ? "transfer.doneReceiver" : "transfer.doneToast", { deviceName: flow.peerDeviceName }) });
    }
  }, [visible, flow.phase, flow.role, flow.peerDeviceName, toast]);

  useEffect(() => {
    if (!progressPhase(flow.phase)) return;
    const confirmExit = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = true; };
    window.addEventListener("beforeunload", confirmExit);
    return () => window.removeEventListener("beforeunload", confirmExit);
  }, [flow.phase]);
  return null;
}

export function useTransferBanner() {
  useLocale();
  const flow = useHistoryTransfer();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  if (isTransferScreen(pathname) || !progressPhase(flow.phase)) return null;
  const percent = transferPercent(flow.progress.bytes, flow.progress.totalBytes);
  const milestone = Math.floor(percent / 10) * 10;
  return <div className="transfer-banner mx-3 my-2 flex flex-wrap items-center gap-3 rounded-control bg-brand-soft px-3 py-1.5 text-on-brand-soft sm:mx-4">
    <Icon name="transfer" size={20} />
    <div className="min-w-0 grow space-y-1 text-sm font-semibold">
      <span aria-hidden="true">{flow.phase === "paused" ? t("transfer.pausedTitle") : t("transfer.bannerProgress", { percent })}</span>
      <span className="sr-only" role="status">{flow.phase === "paused" ? t("transfer.pausedTitle") : t("transfer.bannerProgress", { percent: milestone })}</span>
      <div className="max-w-xs"><TransferBar percent={percent} thin /></div>
    </div>
    <Button variant="ghost" size="sm" onClick={() => navigate(transferLink(flow.role === "sender" ? "send" : "receive"))}>{t("transfer.view")}</Button>
  </div>;
}

export function LinkedDevicesTransfer({ devices }: { devices: { id: string; deviceName: string }[] }) {
  useLocale();
  const navigate = useNavigate();
  const flow = useHistoryTransfer();
  const deviceId = useAuthStore((state) => state.device?.id);
  const accountId = useAuthStore((state) => state.user?.id);
  const [interrupted, setInterrupted] = useState<Array<InterruptedHistoryTransfer & { mode: Mode }>>([]);
  useEffect(() => {
    let active = true;
    setInterrupted([]);
    if (!accountId || !deviceId || (progressPhase(flow.phase) && !flow.requiresPairing)) return;
    void Promise.all([flow.listInterrupted("sender"), flow.listInterrupted("receiver")]).then(([send, receive]) => {
      if (active) setInterrupted([...send.map((item) => ({ ...item, mode: "send" as const })), ...receive.map((item) => ({ ...item, mode: "receive" as const }))]);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [flow.phase, flow.requiresPairing, flow.listInterrupted, accountId, deviceId]);
  return <section className="space-y-3" aria-label={t("transfer.title")}>
    {interrupted.map((item) => {
      const name = devices.find(({ id }) => id === item.peerDeviceId)?.deviceName ?? t("transfer.otherDevice");
      const stats = { deviceName: name, done: item.completedChatIds.length, total: item.chats.length };
      return <Notice key={`${item.mode}:${item.peerDeviceId}`} tone="warning">
        <p>{t(item.mode === "send" ? "transfer.unfinished" : "transfer.unfinishedFrom", stats)}</p>
        <Button variant="secondary" className="mt-2" onClick={() => { flow.dismiss(); navigate(transferLink(item.mode, item.peerDeviceId)); }}>{t("transfer.resume")}</Button>
      </Notice>;
    })}
    <ListItem leading={<Icon name="transfer" />} title={t("transfer.title")} subtitle={t("transfer.entryHelp")}
      trailing={<Icon name="chevron-right" size={18} />} onClick={() => {
        if (progressPhase(flow.phase)) navigate(transferLink(flow.role === "sender" ? "send" : "receive"));
        else { flow.dismiss(); navigate(TRANSFER_PATH); }
      }} />
  </section>;
}

export function HistoryTransferScreen({ setup = false }: { setup?: boolean }) {
  useLocale();
  const flow = useHistoryTransfer();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { state } = useLocation();
  const requested = params.get("mode");
  const mode = setup ? "receive" : requested === "send" || requested === "receive" ? requested : undefined;
  const [entry, setEntry] = useState<"scan" | "words">("scan");
  const [viewfinder, setViewfinder] = useState(false);
  const [stopDialog, setStopDialog] = useState(false);
  const [freeHere, setFreeHere] = useState<number>();
  const receiverStarted = useRef(false);
  const device = useAuthStore((state) => state.device);
  const username = useAuthStore((state) => state.user?.username) ?? "";
  const thisDevice = device?.deviceName ?? t("transfer.thisDevice");
  const peer = flow.peerDeviceName ?? t("transfer.otherDevice");
  const expectingPeer = params.get("peer") ?? (flow.requiresPairing ? flow.peerDeviceId : undefined) ?? undefined;
  const inProgress = progressPhase(flow.phase) && (!!flow.progress.totalRecords || flow.requiresPairing || !!flow.checkpoint);
  const active = ["starting", "waiting", "pairing", "ready"].includes(flow.phase) || flow.phase === "paused" || inProgress;
  const title = t(mode === "send" || flow.role === "sender" ? "transfer.sendTitle" : "transfer.title");
  const leave = setup ? "/" : "/devices";
  const leaveTransfer = (target = leave) => setup ? navigate(target, { replace: true, state }) : navigate(target);

  const newCode = useCallback(() => {
    void flow.startAsReceiver({ resumeFromPeerDeviceId: expectingPeer }).catch(() => undefined);
  }, [flow.startAsReceiver, expectingPeer]);
  useEffect(() => {
    if (mode !== "receive") receiverStarted.current = false;
    if (!inProgress && active && ((flow.role === "receiver" && mode !== "receive") || (flow.role === "sender" && mode !== "send"))) {
      flow.stop();
      flow.dismiss();
      return;
    }
    if (mode !== "receive" || receiverStarted.current || flow.phase !== "idle") return;
    receiverStarted.current = true;
    newCode();
  }, [mode, flow.phase, flow.role, flow.stop, flow.dismiss, inProgress, active, newCode]);
  useEffect(() => { document.title = t("privateBase2", { title }); }, [title]);
  useEffect(() => {
    if (flow.role !== "receiver" || flow.phase !== "ready") return;
    let active = true;
    void deviceTransferCapacity().then(({ free }) => { if (active) setFreeHere(free); }).catch(() => undefined);
    return () => { active = false; };
  }, [flow.phase, flow.role]);

  const connect = (input: string) => { void flow.startAsSender(input, { resumeFromPeerDeviceId: expectingPeer }).catch(() => undefined); };
  const goBack = () => {
    if (inProgress) flow.continueInBackground();
    else { if (active) flow.stop(); flow.dismiss(); }
    leaveTransfer();
  };
  const stop = () => { if (inProgress) setStopDialog(true); else flow.stop(); };
  const restart = () => {
    if (mode === "receive" || flow.role === "receiver") newCode();
    else { flow.stop(); flow.dismiss(); setEntry("scan"); }
  };
  const resume = () => {
    if (!flow.requiresPairing) { void flow.resume().catch(() => undefined); return; }
    if (flow.role === "receiver") newCode();
    else { if (expectingPeer) navigate(transferLink("send", expectingPeer), { replace: true }); flow.dismiss(); setEntry("scan"); }
  };
  const onExitKey = useRef(goBack);
  onExitKey.current = goBack;
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !stopDialog) {
        event.preventDefault();
        onExitKey.current();
      }
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [stopDialog]);

  const showPicker = flow.phase === "ready" && flow.role === "sender";
  const camera = viewfinder && mode === "send" && flow.phase === "idle";
  let content;
  if (flow.phase === "complete") {
    content = <TransferSummary flow={flow} peer={peer} finish={() => { flow.dismiss(); leaveTransfer(flow.role === "receiver" ? "/" : leave); }} />;
  } else if (inProgress) {
    content = <TransferProgressScreen flow={flow} peer={peer} deviceName={thisDevice} background={goBack} stop={stop} resume={resume} canKeepScreenOn={!!flow.screenOn} />;
  } else if (flow.phase === "error" || flow.phase === "cancelled" || (flow.phase === "expired" && flow.role === "sender")) {
    const error = flow.error;
    const body = error === "offline" ? t("transfer.failOffline")
      : error === "other-account" ? t("transfer.otherAccount", { username })
      : error === "code-used" ? t("transfer.codeUsed")
      : error === "invalid-pairing" ? t("transfer.wrongCode")
      : error === "version" ? t("transfer.failVersion", { deviceName: peer })
      : error === "version-local" ? t("transfer.failVersionLocal")
      : error === "access-revoked" ? t("transfer.peerGone", { deviceName: peer })
      : error === "transfer-interrupted" ? t("transfer.interruptedFailure")
      : error === "busy" ? t("transfer.peerBusy")
      : error === "protocol" ? t("transfer.failIntegrity")
      : error === "check-code-mismatch" ? t("transfer.mismatchBody")
      : flow.peerStopped ? t("transfer.peerStopped", { deviceName: peer })
      : flow.phase === "cancelled" ? flow.stoppedAfterStart
        ? t("transfer.stopBody", { deviceName: flow.role === "receiver" ? thisDevice : peer })
        : t("transfer.stoppedBeforeSending")
      : flow.phase === "expired" ? t("transfer.codeExpired") : t("transfer.failConnect");
    const final = flow.peerStopped || error === "access-revoked";
    content = <div className="transfer-column transfer-fill space-y-4">
      <TransferTile icon="alert-circle" tone="danger" />
      <TransferHeading>{t("transfer.stoppedTitle")}</TransferHeading>
      <p className="text-ink-muted">{body}</p>
      <div className="transfer-bottom transfer-pair">
        <Button size="lg" onClick={final ? goBack : restart}>{t(final ? "transfer.done" : "transfer.startAgain")}</Button>
        {!final && <Button size="lg" variant="ghost" onClick={goBack}>{t("transfer.close")}</Button>}
      </div>
    </div>;
  } else if (flow.checkCode && flow.phase === "pairing") {
    const code = flow.checkCode;
    content = <CompareTransferCode code={code} sending={flow.role === "sender"} deviceName={thisDevice} otherDevice={peer}
      confirmed={flow.localConfirmed} confirm={() => flow.confirmCheckCode(code)} stop={flow.rejectComparison} />;
  } else if (flow.phase === "ready" && flow.role === "receiver") {
    content = <div className="transfer-column transfer-fill space-y-4">
      <TransferHeading>{t("transfer.waitingTitle")}</TransferHeading>
      <TransferWait>{t("transfer.choosingOn", { deviceName: peer === thisDevice ? t("transfer.sendingDevice") : peer })}</TransferWait>
      {freeHere !== undefined && <p className="text-sm text-ink-muted">{t("transfer.freeHere", { free: transferBytes(freeHere) })}</p>}
      <Button size="lg" variant="secondary" className="transfer-bottom" onClick={stop}>{t("transfer.stopTransfer")}</Button>
    </div>;
  } else if (flow.phase === "paused") {
    content = <div className="transfer-column space-y-4">
      <TransferHeading>{t("transfer.pausedTitle")}</TransferHeading>
      <Notice tone="warning">{t("transfer.failConnect")}</Notice>
      <div className="transfer-pair"><Button onClick={resume}>{t("transfer.resume")}</Button><Button variant="secondary" onClick={stop}>{t("transfer.stopTransfer")}</Button></div>
    </div>;
  } else if (mode === "receive") {
    content = <ShowTransferInvitation invitation={flow.invitation} expired={flow.phase === "expired"} peer={flow.peerDeviceName} renew={newCode} />;
  } else if (mode === "send") {
    content = flow.phase === "pairing" || flow.phase === "starting" || flow.phase === "waiting" ? <div className="transfer-column space-y-4">
      <TransferHeading>{t("transfer.connectingTitle")}</TransferHeading>
      <TransferWait>{flow.peerDeviceName ? t("transfer.connectingTo", { deviceName: peer }) : t("transfer.waitingOther")}</TransferWait>
    </div> : entry === "words" ? <EnterTransferWords connect={connect} connecting={false} />
      : <ScanTransferCode connect={connect} enter={() => setEntry("words")} onViewfinder={setViewfinder} />;
  } else {
    const options = [
      ["receive", "transfer.getHere", "transfer.getHereHelp", "download"],
      ["send", "transfer.sendFromHere", "transfer.sendFromHereHelp", "transfer"],
    ] as const;
    content = <div className="transfer-column space-y-4">
      <TransferHeading>{t("transfer.title")}</TransferHeading>
      <div className="transfer-list">{options.map(([role, label, help, icon]) => <ListItem key={role}
        leading={<Icon name={icon} />} title={t(label)} subtitle={t(help)} trailing={<Icon name="chevron-right" size={18} />}
        onClick={() => navigate(transferLink(role))} />)}</div>
    </div>;
  }
  return <div data-theme={camera ? "dark" : undefined} className={`transfer-screen flex min-h-0 flex-1 flex-col ${camera ? "transfer-camera-active" : "bg-surface"}`}>
    <TopBar title={title} heading={false} actions={<IconButton icon={inProgress ? "chevron-down" : "close"} onClick={goBack}
      label={t(inProgress ? "transfer.continueBackground" : flow.phase === "complete" || flow.phase === "error" || flow.phase === "cancelled" ? "transfer.close" : "transfer.cancelLabel")} />} />
    {showPicker ? <TransferChatPicker flow={flow} peer={peer} deviceName={thisDevice} />
      : <div className={`transfer-scroll ${camera ? "transfer-camera-scroll" : "pb-safe"}`}>{content}</div>}
    <ConfirmDialog open={stopDialog} title={t("transfer.stopTitle")} description={t("transfer.stopBody", { deviceName: flow.role === "receiver" ? thisDevice : peer })}
      confirmLabel={t("transfer.stopTransfer")} cancelLabel={t("transfer.keepGoing")} onCancel={() => setStopDialog(false)} onConfirm={() => {
        setStopDialog(false);
        flow.stop();
        if (flow.requiresPairing) leaveTransfer();
      }} />
  </div>;
}

export function ConversationTransferMarkers({ conversationId }: { conversationId?: string }) {
  useLocale();
  const accountId = useAuthStore((state) => state.user?.id);
  const { conversationMarkers } = useHistoryTransfer();
  const [snapshot, setSnapshot] = useState<{ accountId: string; conversationId: string; markers: HistoryTransferMarker[] }>();
  useEffect(() => {
    if (!conversationId || !accountId) return;
    let current = true;
    const refresh = () => void conversationMarkers(conversationId).then((markers) => {
      if (current) setSnapshot({ accountId, conversationId, markers });
    }).catch(() => undefined);
    refresh();
    const unsub = subscribeHistoryImports(conversationId, refresh);
    return () => { current = false; unsub(); };
  }, [accountId, conversationId, conversationMarkers]);
  if (!snapshot || snapshot.accountId !== accountId || snapshot.conversationId !== conversationId) return null;
  return <>{snapshot.markers.map(({ fromDeviceId, deviceName, at }) => <p key={fromDeviceId} className="py-2 text-center text-xs text-ink-muted">
    {t("transfer.importedLine", { deviceName, date: formatDate(at, { dateStyle: "medium" }) })}
  </p>)}</>;
}
