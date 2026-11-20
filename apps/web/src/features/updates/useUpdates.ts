import { useCallback, useEffect, useRef, useState } from "react";
import { capabilities } from "../../platform/capabilities.js";
import { readUpdateChannel, uiBundles, UPDATE_CHANNEL_KEY, updates, UpdateError, type UpdateChannel, type UpdateCheck, type UpdateErrorCode, type UpdateProgress } from "../../platform/updates.js";
import { useCallStore } from "../../stores/callStore.js";

export { UPDATE_CHANNEL_KEY } from "../../platform/updates.js";
export const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
type Status = "idle" | "checking" | "available" | "downloading" | "ready" | "error";
type Retry = "check" | "download" | "install";
export interface UpdateState {
  status: Status;
  update?: UpdateCheck;
  progress?: UpdateProgress;
  error?: UpdateErrorCode;
  retry?: Retry;
  verified?: boolean;
  androidMetered?: boolean;
}
function connectionInfo() {
  return (navigator as Navigator & { connection?: { type?: string; metered?: boolean; saveData?: boolean } }).connection;
}
export function isKnownUnmeteredConnection(): boolean {
  const connection = connectionInfo();
  return !!connection && connection.metered !== true &&
    (connection.metered === false || connection.type === "wifi" || connection.type === "ethernet");
}
export function canDownloadAutomatically(kind: "desktop" | "android"): boolean {
  return kind === "desktop" || (!connectionInfo()?.saveData && isKnownUnmeteredConnection());
}
const errorCode = (error: unknown): UpdateErrorCode => error instanceof UpdateError ? error.code : "failed";

/** One app-wide owner; independent of authentication and local-key unlock. */
export function useUpdates(callActive: boolean) {
  const kind = capabilities.autoUpdate;
  const [channel, setChannelState] = useState<UpdateChannel>();
  const [version, setVersion] = useState<string>();
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const [dismissed, setDismissed] = useState(false);
  const [deferred, setDeferred] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [changingChannel, setChangingChannel] = useState(false);
  const current = useRef(state); current.current = state;
  const active = useRef(callActive); active.current = callActive;
  const epoch = useRef(0);
  const busy = useRef(false);
  const unlisten = useRef<(() => void) | undefined>(undefined);
  const isCurrent = (token: number) => token === epoch.current;

  useEffect(() => {
    let mounted = true;
    void readUpdateChannel().then(channel => { if (mounted) setChannelState(channel); });
    return () => { mounted = false; };
  }, []);

  const download = useCallback(async (update = current.current.update) => {
    if (!kind || !update?.available || busy.current) return;
    const token = epoch.current;
    busy.current = true;
    setDismissed(false);
    setState({ status: "downloading", update, progress: { downloaded: 0, total: update.sizeBytes ?? 0 } });
    let stop: (() => void) | undefined;
    let downloading = true;
    try {
      stop = await updates.onProgress(progress => {
        if (downloading && isCurrent(token)) setState({ status: "downloading", update, progress });
      });
      if (!isCurrent(token)) return;
      unlisten.current = stop;
      await updates.download();
      if (isCurrent(token)) setState({ status: "ready", update, verified: true });
    } catch (error) {
      if (isCurrent(token)) setState({ status: "error", update, error: errorCode(error), retry: "download" });
    } finally {
      downloading = false;
      stop?.();
      if (isCurrent(token)) { unlisten.current = undefined; busy.current = false; }
    }
  }, [kind]);

  const check = useCallback(async () => {
    if (!kind || !channel || busy.current) return;
    setDismissed(false);
    const token = epoch.current;
    busy.current = true;
    const previous = current.current.update;
    const verified = current.current.verified;
    setState({ status: "checking", update: previous, verified });
    try {
      const update = await updates.check(channel);
      if (!isCurrent(token)) return;
      if (update.available && verified && update.version === previous?.version) {
        // A policy refresh for the same candidate retains the native verified download.
        setState({ status: "ready", update, verified: true });
      } else {
        // The WebView safeguard still applies when Android metering is unavailable.
        const androidMetered = update.available && kind === "android" && isKnownUnmeteredConnection()
          && await uiBundles.isAndroidUnmetered() === false;
        if (!isCurrent(token)) return;
        setDeferred(false);
        setState(update.available ? { status: "available", update, androidMetered } : { status: "idle" });
        busy.current = false;
        if (update.available && !androidMetered && canDownloadAutomatically(kind)) await download(update);
      }
    } catch (error) {
      if (isCurrent(token)) {
        setDeferred(false);
        setState({ status: "error", update: previous, error: errorCode(error), retry: "check", verified });
      }
    } finally { if (isCurrent(token)) busy.current = false; }
  }, [kind, channel, download]);

  const install = useCallback(async () => {
    if (!kind || busy.current || !(current.current.status === "ready" || current.current.retry === "install")) return;
    // Recheck the CallProvider state and the live store at the command boundary.
    const call = useCallStore.getState();
    if (active.current || call.pendingCallStart || call.callStatus === "active" || call.callStatus === "ringing") {
      setDeferred(true); setDismissed(false); return;
    }
    const token = epoch.current;
    busy.current = true; setInstalling(true); setDeferred(false);
    try {
      await updates.install();
      if (isCurrent(token)) setState({ status: "ready", update: current.current.update, verified: true });
    } catch (error) {
      if (isCurrent(token)) setState({ status: "error", update: current.current.update, error: errorCode(error), retry: "install", verified: true });
    } finally { if (isCurrent(token)) { busy.current = false; setInstalling(false); } }
  }, [kind]);

  useEffect(() => {
    const token = ++epoch.current;
    if (!kind || !channel) return;
    void updates.getVersion().then(value => { if (isCurrent(token)) setVersion(value); }).catch(() => {});
    void check();
    const timer = setInterval(() => { void check(); }, UPDATE_INTERVAL);
    return () => { ++epoch.current; busy.current = false; clearInterval(timer); unlisten.current?.(); unlisten.current = undefined; };
  }, [kind, channel, check]);
  const ready = state.status === "ready" || state.retry === "install";
  useEffect(() => { if (deferred && !callActive && ready) void install(); }, [deferred, callActive, ready, install]);

  const channelLocked = !channel || uiBundles.isReadOnly() || busy.current || changingChannel || ready || installing || deferred;
  async function setChannel(next: UpdateChannel) {
    if ((next !== "stable" && next !== "beta") || busy.current || channelLocked || next === channel) return;
    const token = epoch.current;
    busy.current = true;
    setChangingChannel(true);
    try {
      await uiBundles.setChannel(next);
    } catch {
      if (isCurrent(token)) setState(s => ({ ...s, error: "failed" }));
      return;
    } finally {
      if (isCurrent(token)) { busy.current = false; setChangingChannel(false); }
    }
    try { localStorage.setItem(UPDATE_CHANNEL_KEY, next); } catch { /* In-memory choice still works. */ }
    if (!isCurrent(token)) return;
    setState({ status: "idle" }); current.current = { status: "idle" };
    setChannelState(next);
  }
  async function openPermissionSettings() {
    try { await updates.openPermissionSettings(); }
    catch (error) { setState(s => ({ ...s, error: errorCode(error) })); }
  }
  return {
    kind, channel, setChannel, channelLocked, version, state, ready, deferred, installing, dismissed, callActive,
    check, download: () => download(), install, openPermissionSettings,
    retry: () => state.retry === "install" ? install() : state.retry === "download" ? download() : check(),
    later: () => { setDismissed(true); setDeferred(false); },
  };
}
