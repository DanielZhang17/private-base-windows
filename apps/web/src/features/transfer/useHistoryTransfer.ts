import { useSyncExternalStore } from "react";
import { generateX25519KeyPair, type X25519KeyPair } from "@e2ee-chat/crypto";
import { HISTORY_TRANSFER_TTL_MS, historyTransferStickerPreferencesSchema, type ConversationWithMembers, type HistoryTransferCheckpoint, type HistoryTransferManifest, type HistoryTransferQr } from "@e2ee-chat/shared";
import { guardMessageForPublish, type LocalMessage } from "../../db/index.js";
import { acceptsHistoryTransfer, estimateHistoryStorage, exportHistoryTransfer, getHistoryTransferMarkers, historyArchiveIsCurrent, historyTransferCatalog, importHistoryTransferItem, verifyLegacyHistoryOwnership, type HistoryArchiveRevisions, type HistoryDisclosureCandidate } from "../../db/history-transfer.js";
import {
  checkpointForManifest, clearHistoryTransferCheckpoint, listInterruptedHistoryTransfers, loadHistoryTransferCheckpoint,
  saveHistoryTransferCheckpoint, claimHistoryTransferLease, completeHistoryTransferChat, renewHistoryTransferLease, releaseHistoryTransferLease, type HistoryTransferLease,
} from "../../db/history-transfer-progress.js";
import { refreshConversationList } from "../../lib/conversation-cache.js";
import { getUnlockGeneration, holdIdleLock, keysLoaded } from "../../lib/key-manager.js";
import { reconcileImportedHistoryDeletions, reconcileLocalMessageChange, verifyHistoryDisclosure } from "../../lib/message-sync.js";
import { publishLocalMessageChange, subscribeMessageRemovals } from "../../lib/local-message-changes.js";
import { normalizeExpiryMetadata } from "../../lib/message-retention.js";
import { registerUnlockedSessionCleanup } from "../../platform/session-cleanup.js";
import { api } from "../../services/api.js";
import { fetchTurnCredentials } from "../../services/webrtc.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { mergeTransferredStickers, readStickerState, stickerStateKey, updateStickerState } from "../stickers/storage.js";
import { buildTransferArchive } from "./archive.js";
import { createTransferPairing, encodeTransferWords, parseTransferPairing, transferRoomId, transferVersionError, UnsupportedTransferVersion } from "./pairing.js";
import { HistoryTransferStream, TransferArchiveChangedError, TransferStorageError, type HistoryTransferProgress, type HistoryTransferRole, type TransferDeviceCapacity } from "./stream.js";
import { HistoryTransferTransport } from "./transport.js";

type Phase = "idle" | "starting" | "waiting" | "pairing" | "ready" | "transferring" | "reconnecting" | "paused"
  | "complete" | "cancelled" | "expired" | "error";
type ErrorCode = "device-locked" | "invalid-pairing" | "code-used" | "other-account" | "check-code-mismatch"
  | "access-revoked" | "connection" | "protocol" | "export" | "archive-changed" | "storage" | "offline" | "version" | "version-local" | "transfer-interrupted" | "busy";

export interface HistoryTransferInvitation {
  qr: HistoryTransferQr;
  words: string;
  expiresAt: number;
}

export interface HistoryTransferState {
  phase: Phase;
  role?: HistoryTransferRole;
  invitation?: HistoryTransferInvitation;
  checkCode?: string;
  peerDeviceId?: string;
  peerDeviceName?: string;
  expiresAt?: number;
  localConfirmed: boolean;
  peerConfirmed: boolean;
  preparing: boolean;
  background: boolean;
  requiresPairing: boolean;
  canFinalize: boolean;
  canSend: boolean;
  checkpoint?: HistoryTransferCheckpoint;
  summary?: { chats: number; messages: number; attachmentBytes: number; attachmentFiles: number; missingFiles: string[]; missingFileCount: number;
    skippedChats: { id: string; name?: string }[]; elapsedMs: number };
  manifest?: HistoryTransferManifest;
  progress: HistoryTransferProgress;
  peerCapacity?: TransferDeviceCapacity;
  estimatedBytesPerSecond?: number;
  peerStopped?: boolean;
  stoppedAfterStart?: boolean;
  screenOn?: boolean;
  error?: ErrorCode;
}

const initialState: HistoryTransferState = {
  phase: "idle", localConfirmed: false, peerConfirmed: false, preparing: false,
  background: false, requiresPairing: false, canFinalize: false, canSend: false,
  progress: { records: 0, totalRecords: 0, bytes: 0, totalBytes: 0 },
};

const RECONNECT_GRACE_MS = 60_000;
export const TRANSFER_PROGRESS_TIMEOUT_MS = 60_000;
function allChatsCompleted(checkpoint: HistoryTransferCheckpoint): boolean {
  const completed = new Set(checkpoint.completedChatIds);
  return checkpoint.chats.length > 0 && checkpoint.chats.every((chat) => completed.has(chat.id));
}
export interface HistoryTransferSelection { conversationId: string }
export interface HistoryTransferPrepareOptions {
  copyDownloadedFiles?: boolean;
  hiddenConversationIds?: readonly string[];
  checkSpace?: boolean;
}

interface Run {
  role: HistoryTransferRole;
  userId: string;
  deviceId: string;
  sessionId: string | null;
  unlockGeneration: number;
  keyPair?: X25519KeyPair;
  roomId?: string;
  transport?: HistoryTransferTransport;
  stream: HistoryTransferStream;
  timer?: ReturnType<typeof setTimeout>;
  prepareVersion: number;
  selectedChats?: Set<string>;
  archiveRevisions?: HistoryArchiveRevisions;
  archiveCandidates?: readonly HistoryDisclosureCandidate[];
  archiveExpiresAt?: number;
  archiveRequiredBytes?: number;
  chatNames?: Map<string, string>;
  progressTimer?: ReturnType<typeof setTimeout>;
  lastProgressRecord: number;
  lastReceiptActivity: number;
  paired: boolean;
  lease?: HistoryTransferLease;
  leaseTimer?: ReturnType<typeof setInterval>;
  peerDeviceId?: string;
  peerDeviceName?: string;
  expectedPeerId?: string;
  importedAt: number;
  resumeInfo?: Promise<HistoryTransferCheckpoint | undefined>;
  checkpoint?: HistoryTransferCheckpoint;
  receiverFinishedChats?: boolean;
  writes: Promise<void>;
  releaseIdle?: () => void;
  wakeLock?: WakeLockSentinel;
  requestingWakeLock?: boolean;
  reconnectGrace?: { deadline: number };
  retry?: ReturnType<typeof setTimeout>;
  pauseTimer?: ReturnType<typeof setTimeout>;
  connecting?: { grace?: Run["reconnectGrace"]; promise: Promise<void> };
  connectionTimer?: ReturnType<typeof setTimeout>;
  iceInterrupted?: boolean;
  resumeCheck?: symbol;
  startedAt?: number;
  cleanup?: () => void;
  dirtyChats: Set<string>;
}

class HistoryTransferController {
  private run?: Run;
  private interruptedRun?: Pick<Run, "userId" | "deviceId" | "role" | "sessionId" | "writes" | "lease">
    & { peerDeviceId: string };
  private state = initialState;
  private listeners = new Set<() => void>();
  private unwatchSession?: () => void;

  getSnapshot = (): HistoryTransferState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(next: Partial<HistoryTransferState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  private sameSession(run: Pick<Run, "sessionId" | "userId" | "deviceId" | "unlockGeneration">): boolean {
    const { sessionId, user, device, accessToken } = useAuthStore.getState();
    return !!accessToken && user?.id === run.userId && device?.id === run.deviceId && device.status === "active"
      && sessionId === run.sessionId && getUnlockGeneration() === run.unlockGeneration && keysLoaded();
  }

  private current(run: Run): boolean { return this.run === run && this.sameSession(run); }

  private assertCurrent(run: Run): void {
    if (!this.current(run)) throw new Error("History transfer session ended");
  }

  private begin(role: HistoryTransferRole, expectedPeerId?: string): Run {
    if (this.run) {
      if (!this.run.paired) this.run.transport?.cancel();
      this.end(this.run, "cancelled");
    }
    this.unwatchSession?.();
    this.interruptedRun = undefined;
    this.state = initialState;
    const { user, device, sessionId, accessToken } = useAuthStore.getState();
    if (!keysLoaded() || !user || !device || device.status !== "active" || !accessToken) {
      this.set({ ...initialState, phase: "error", error: "device-locked" });
      throw new Error("An unlocked active device is required");
    }
    const stream = new HistoryTransferStream(role, async (item) => {
      if (!run.lease || !run.peerDeviceId) throw new Error("History transfer lease is missing");
      const changed = await importHistoryTransferItem(run.userId, item, () => this.current(run), Date.now(), {
        fromDeviceId: run.peerDeviceId!, deviceName: run.peerDeviceName ?? run.peerDeviceId!, at: run.importedAt,
      }, { userId: run.userId, deviceId: run.deviceId, role: run.role, peerDeviceId: run.peerDeviceId, lease: run.lease });
      if (changed && this.current(run)) {
        run.dirtyChats.add(changed.conversationId);
        await this.publishImported(run, changed);
      }
    }, () => this.updateStream(run), (error) => {
      if (error instanceof TransferStorageError) this.needsPairing(run, "storage");
      else this.fail(run, "protocol");
    }, () => run.transport?.pause(), {
      load: async () => run.checkpoint ?? await run.resumeInfo ?? null,
      received: async (checkpoint) => {
        const local = await run.resumeInfo;
        // A durable receipt can finish only the same interrupted archive, even
        // if a later transfer between these devices selects the same chats.
        if (checkpoint && (checkpoint.resumeId ? local?.resumeId !== checkpoint.resumeId : checkpoint.confirmationOnly)) checkpoint = null;
        const saved = checkpoint ?? local;
        if (!this.current(run)) return;
        // Only the receiver can attest to committed chats. A local checkpoint
        // can still suggest the chat selection and attachment preference.
        run.checkpoint = checkpoint ?? (saved ? { ...saved, completedChatIds: [], bytes: 0 } : undefined);
        run.receiverFinishedChats = !!checkpoint && allChatsCompleted(checkpoint);
        this.set({ checkpoint: run.checkpoint, canFinalize: run.receiverFinishedChats });
      },
      manifest: async (manifest) => {
        const saved = run.checkpoint ?? await run.resumeInfo;
        if (!this.current(run)) return;
        if (!manifest.chats.length && !(saved && saved.resumeId === manifest.resumeId && allChatsCompleted(saved))) throw new Error("Nothing to finalize");
        await this.persist(run, checkpointForManifest(manifest, saved), true);
        if (manifest.stickers && run.lease && this.current(run)) {
          const preferences = manifest.stickers;
          await updateStickerState(stickerStateKey(run.userId, run.deviceId), (state) => mergeTransferredStickers(state, preferences),
            { lease: run.lease, current: () => this.current(run) });
        }
      },
      chatComplete: async (id, bytes) => {
        const { userId, deviceId, role, peerDeviceId, lease } = run;
        if (!lease || !peerDeviceId) throw new Error("History transfer lease is missing");
        const checkpoint = await completeHistoryTransferChat({ userId, deviceId, role, peerDeviceId, lease }, id, bytes, () => this.current(run));
        if (!this.current(run)) return;
        run.checkpoint = checkpoint;
        this.set({ checkpoint });
        if (run.dirtyChats.delete(id)) publishLocalMessageChange(id, "history", id);
      },
      receipt: async () => {
        const saved = run.checkpoint;
        if (!saved || !allChatsCompleted(saved)) throw new Error("History receipt is missing committed chats");
        const receipt = { ...saved, confirmationOnly: true } as const;
        await this.persist(run, receipt);
        this.assertCurrent(run);
        return receipt;
      },
      receivedReceipt: (receipt) => {
        const expected = run.checkpoint;
        if (!expected || receipt.resumeId !== expected.resumeId || !allChatsCompleted(receipt)
          || expected.chats.length !== receipt.chats.length || !expected.chats.every(({ id }) => receipt.completedChatIds.includes(id))) {
          throw new Error("Unexpected history transfer receipt");
        }
        run.checkpoint = receipt;
      },
      estimateStorage: (items) => estimateHistoryStorage(run.userId, items),
    });
    const run: Run = { role, userId: user.id, deviceId: device.id, sessionId,
      unlockGeneration: getUnlockGeneration(), stream, prepareVersion: 0, expectedPeerId,
      importedAt: Date.now(), paired: false, writes: Promise.resolve(), lastProgressRecord: -1, lastReceiptActivity: 0, dirtyChats: new Set() };
    this.watchSession({ userId: run.userId, deviceId: run.deviceId, sessionId, unlockGeneration: run.unlockGeneration });
    const visibility = () => {
      if (document.visibilityState !== "visible" || !this.current(run)) return;
      if (this.state.phase === "transferring" && run.releaseIdle) this.keepScreenOn(run);
      if (this.state.phase === "reconnecting" && (run.reconnectGrace?.deadline ?? 0) > Date.now()) void this.reconnect(run).catch(() => undefined);
    };
    document.addEventListener("visibilitychange", visibility);
    const unsub = subscribeMessageRemovals((id) => {
      if (run.selectedChats && (!id || run.selectedChats.has(id))) this.invalidateArchive(run);
    });
    const unsubChats = role === "sender" ? useChatStore.subscribe((next, previous) => {
      if (next.conversations !== previous.conversations && run.selectedChats?.size
        && !this.selectedChatsAllowed(run, next.conversations)) this.invalidateArchive(run);
    }) : undefined;
    run.cleanup = () => { unsub(); unsubChats?.(); document.removeEventListener("visibilitychange", visibility); };
    this.run = run;
    this.set({ role, phase: "starting" });
    this.expireAt(run, Date.now() + HISTORY_TRANSFER_TTL_MS);
    return run;
  }

  /** Scope terminal snapshots too, without retaining a finished run or archive in an auth callback. */
  private watchSession(scope: Pick<Run, "sessionId" | "userId" | "deviceId" | "unlockGeneration">): void {
    const clearSnapshot = () => {
      this.state = initialState;
      this.set({});
    };
    const lock = registerUnlockedSessionCleanup(() => {
      if (this.run) this.needsPairing(this.run);
      else if (this.interruptedRun) this.set({ manifest: undefined, peerDeviceId: undefined, peerDeviceName: undefined,
        checkpoint: undefined, progress: initialState.progress });
      else clearSnapshot();
    });
    const auth = useAuthStore.subscribe(() => {
      if (this.sameSession(scope)) return;
      if (this.run) this.needsPairing(this.run);
      const { user, device, sessionId, accessToken } = useAuthStore.getState();
      if (accessToken && user?.id === scope.userId && device?.id === scope.deviceId && sessionId === scope.sessionId
        && this.interruptedRun) return;
      this.interruptedRun = undefined;
      clearSnapshot();
      this.unwatchSession?.();
    });
    this.unwatchSession = () => { lock(); auth(); this.unwatchSession = undefined; };
  }

  private expireAt(run: Run, expiresAt: number): void {
    clearTimeout(run.timer);
    this.set({ expiresAt });
    run.timer = setTimeout(() => this.expired(run), Math.max(0, Math.min(HISTORY_TRANSFER_TTL_MS, expiresAt - Date.now())));
  }

  private expired(run: Run): void {
    if (run.stream.started && !run.stream.complete) this.needsPairing(run);
    else this.end(run, "expired");
  }

  private end(run: Run, phase: "expired" | "cancelled" | "error" | "complete" | "paused", error?: ErrorCode, privateState = false): void {
    if (this.run !== run) return;
    if (this.current(run)) for (const id of run.dirtyChats) publishLocalMessageChange(id, "history", id);
    this.run = undefined;
    clearTimeout(run.timer);
    clearTimeout(run.progressTimer);
    clearTimeout(run.connectionTimer);
    clearInterval(run.leaseTimer);
    const lease = run.lease;
    if (lease) void run.writes.then(() => releaseHistoryTransferLease(lease)).catch(() => undefined);
    this.clearReconnect(run);
    run.releaseIdle?.();
    this.releaseScreen(run);
    run.cleanup?.();
    run.transport?.dispose();
    run.stream.dispose();
    run.keyPair?.privateKey.fill(0);
    this.set({
      phase: !privateState && run.stream.complete ? "complete" : phase,
      invitation: undefined, checkCode: undefined, preparing: false, error,
      localConfirmed: false, peerConfirmed: false,
      requiresPairing: phase === "paused", screenOn: false,
      canFinalize: false, canSend: false,
      ...(phase === "cancelled" ? { checkpoint: undefined, stoppedAfterStart: run.stream.started } : {}),
      ...(privateState ? { manifest: undefined, peerDeviceId: undefined, peerDeviceName: undefined, checkpoint: undefined, progress: initialState.progress } : {}),
    });
  }

  private fail(run: Run, error: ErrorCode): void {
    if (!this.current(run)) return;
    const confirmed = run.paired || run.stream.confirmed || run.stream.started;
    if (confirmed) this.interruptRoom(run);
    else if (error === "check-code-mismatch") run.transport?.reject();
    else if (error === "version" || error === "version-local") run.transport?.rejectVersion();
    else run.transport?.cancel();
    this.end(run, "error", confirmed ? "transfer-interrupted" : error);
  }

  private interruptRoom(run: Run): void {
    if (run.transport?.abort()) return;
    const { device, user, sessionId, accessToken } = useAuthStore.getState();
    if (run.roomId && accessToken && user?.id === run.userId && device?.id === run.deviceId && sessionId === run.sessionId) {
      void api.delete(`/api/history-transfer/${run.roomId}?reason=interrupted`).catch(() => undefined);
    }
  }

  private needsPairing(run: Run, error?: ErrorCode, notifyPeer = true): void {
    if (this.run !== run) return;
    if (notifyPeer) {
      if (run.paired) this.interruptRoom(run);
      else run.transport?.cancel();
    }
    const { userId, deviceId, role, sessionId, peerDeviceId, writes, lease } = run;
    if (run.stream.started && peerDeviceId) this.interruptedRun = { userId, deviceId, role, sessionId, peerDeviceId, writes, lease };
    this.end(run, run.stream.started ? "paused" : "cancelled", error, !error);
  }

  private persist(run: Run, checkpoint: HistoryTransferCheckpoint, beginImport = false): Promise<void> {
    if (!this.current(run) || !run.peerDeviceId) return Promise.resolve();
    run.checkpoint = checkpoint;
    this.set({ checkpoint });
    const peer = run.peerDeviceId;
    const operation = run.writes.then(() => saveHistoryTransferCheckpoint(run, peer, checkpoint, () => this.current(run), undefined, run.lease, beginImport));
    run.writes = operation.catch(() => undefined);
    return operation;
  }

  private eraseCheckpoint(run: Run): void {
    const peer = run.peerDeviceId;
    if (peer && run.lease) run.writes = run.writes.then(() => clearHistoryTransferCheckpoint(run, peer, run.lease)).catch(() => undefined);
  }

  private connect(run: Run, pairing: ReturnType<typeof parseTransferPairing>, iceServers: RTCIceServer[]): void {
    this.assertCurrent(run);
    const { roomId, keyPair, deviceId, role, stream } = run;
    run.transport = new HistoryTransferTransport({
      roomId: roomId!, keyPair: keyPair!, deviceId, role, stream, psk: pairing.secret,
      expectedPeerId: run.expectedPeerId ?? pairing.qr?.receiverDeviceId,
      onRoom: (expiresAt) => {
        if (!this.current(run)) return;
        this.expireAt(run, expiresAt);
        if (!stream.complete && !run.paired) this.set({ phase: "waiting", error: undefined });
      },
      onLease: (expiresAt) => { if (this.current(run)) this.expireAt(run, expiresAt); },
      onPeer: async (peerDeviceId, peerDeviceName) => {
        if (!this.current(run) || stream.complete) return;
        if (!run.lease) {
          const lease = await claimHistoryTransferLease(run, peerDeviceId);
          if (!this.current(run) || stream.complete) {
            if (lease) await releaseHistoryTransferLease(lease);
            return;
          }
          if (!lease) { this.fail(run, "busy"); return; }
          run.lease = lease;
          const lostLease = () => this.fail(run, "busy");
          run.leaseTimer = setInterval(() => {
            void renewHistoryTransferLease(lease).then((valid) => { if (!valid) lostLease(); }).catch(lostLease);
          }, 10_000);
        } else if (!await this.renewLease(run)) {
          return;
        }
        if (!this.current(run)) return;
        if (!run.paired && !run.peerDeviceId) {
          run.connectionTimer = setTimeout(() => this.fail(run, "connection"), 30_000);
        }
        run.peerDeviceId = peerDeviceId;
        run.peerDeviceName = peerDeviceName;
        run.iceInterrupted = false;
        run.resumeInfo ??= loadHistoryTransferCheckpoint(run, peerDeviceId);
        void run.resumeInfo.catch(() => undefined);
        this.set({ phase: run.paired ? "reconnecting" : "pairing", peerDeviceId, peerDeviceName,
          peerConfirmed: false, invitation: undefined, error: undefined });
        this.resumeStream(run);
      },
      onError: (reason) => this.fail(run, reason ?? "protocol"),
      onPause: () => this.pause(run),
      onIceState: (moving) => {
        if (!this.current(run)) return;
        if (!moving) {
          run.iceInterrupted = true;
          stream.setSendingPaused(true);
          this.pause(run, 8_000);
          return;
        }
        run.iceInterrupted = false;
        this.resumeStream(run);
        this.updateStream(run);
      },
      onEnd: (reason) => {
        if (reason === "cancelled" && stream.started && this.current(run)) this.set({ peerStopped: true });
        if (reason === "expired") { this.expired(run); return; }
        if ((reason === "cancelled" && stream.started) || reason === "access-revoked") this.eraseCheckpoint(run);
        if (reason === "failed" || (reason === "rejected" && (run.paired || stream.started))) {
          if (stream.started) this.needsPairing(run, "transfer-interrupted", false);
          else this.end(run, "error", "transfer-interrupted");
        } else if (reason === "access-revoked" || reason === "rejected" || reason === "version" || reason === "version-local") {
          this.end(run, "error", reason === "rejected" ? "check-code-mismatch" : reason);
        } else this.end(run, reason);
      },
    });
    run.transport.connect(useAuthStore.getState().accessToken!, iceServers);
  }

  private resumeStream(run: Run): void {
    if (run.role !== "sender" || !run.stream.started) {
      run.stream.setSendingPaused(false);
      return;
    }
    run.stream.setSendingPaused(true);
    const check = run.resumeCheck = Symbol();
    const current = () => this.current(run) && run.resumeCheck === check;
    void (async () => {
      if (!await this.revalidateMembership(run, current) || !await this.revalidateDisclosure(run, current)
        || !current() || !await this.renewLease(run) || !current()) return;
      run.resumeCheck = undefined;
      run.stream.setSendingPaused(false);
      this.updateStream(run);
    })().catch(() => { if (current()) run.transport?.pause(); });
  }

  private keepScreenOn(run: Run): void {
    if (!navigator.wakeLock || run.wakeLock || run.requestingWakeLock || document.visibilityState === "hidden") return;
    run.requestingWakeLock = true;
    void navigator.wakeLock.request("screen").then((lock) => {
      if (!this.current(run) || this.state.phase !== "transferring" || !run.releaseIdle) { void lock.release().catch(() => undefined); return; }
      run.wakeLock = lock;
      this.set({ screenOn: true });
      lock.addEventListener("release", () => {
        if (run.wakeLock !== lock) return;
        run.wakeLock = undefined;
        if (this.current(run)) this.set({ screenOn: false });
      }, { once: true });
    }).catch(() => undefined).finally(() => { run.requestingWakeLock = false; });
  }

  private releaseScreen(run: Run): void {
    const lock = run.wakeLock;
    run.wakeLock = undefined;
    if (lock) void lock.release().catch(() => undefined);
  }

  private updateStream(run: Run): void {
    if (!this.current(run)) return;
    const { stream } = run;
    if (stream.checkCode) clearTimeout(run.connectionTimer);
    if (stream.confirmed) {
      run.paired = true;
      run.transport?.reportPaired();
    }
    if (stream.complete) {
      const chats = run.checkpoint?.chats ?? [];
      // Pre-v3 checkpoints never shipped, so an absent additions count means zero additions.
      const additions = chats.flatMap(({ additions }) => additions ? [additions] : []);
      const skipped = new Set(chats.filter((chat) => chat.additions?.skipped).map(({ id }) => id));
      const missingFiles = stream.manifest?.chats.flatMap((chat) => skipped.has(chat.id) ? [] : chat.missingFiles ?? []) ?? [];
      const names = new Map<string, string>();
      for (const chat of useChatStore.getState().conversations) {
        const name = chat.name ?? chat.members.filter(({ userId }) => userId !== run.userId).map(({ user }) => user.displayName).join(", ");
        if (name) names.set(chat.id, name);
      }
      for (const [id, name] of run.chatNames ?? []) names.set(id, name);
      for (const { id, name } of stream.manifest?.chats ?? []) if (name) names.set(id, name);
      this.set({ summary: {
        chats: additions.filter((chat) => chat.messages || chat.attachmentFiles).length,
        messages: additions.reduce((sum, chat) => sum + chat.messages, 0),
        attachmentBytes: additions.reduce((sum, chat) => sum + chat.attachmentBytes, 0),
        attachmentFiles: additions.reduce((sum, chat) => sum + chat.attachmentFiles, 0),
        missingFiles, missingFileCount: chats.reduce((sum, chat) => sum + (skipped.has(chat.id) ? 0 : chat.missingFileCount ?? 0), 0),
        skippedChats: [...skipped].map((id) => ({ id, name: names.get(id) })),
        elapsedMs: Date.now() - (run.startedAt ?? Date.now()),
      }, manifest: undefined, checkpoint: undefined });
      if (run.role === "sender") this.eraseCheckpoint(run);
      else void reconcileImportedHistoryDeletions();
      this.end(run, "complete");
      return;
    }
    const phase = stream.ready && !run.iceInterrupted && !run.resumeCheck ? stream.started ? "transferring" : "ready"
      : this.state.phase;
    if (stream.ready && !run.iceInterrupted && !run.resumeCheck) this.clearReconnect(run);
    const progress = stream.progress;
    const receiptActivity = stream.receiptActivity;
    if (stream.started && (progress.records > Math.max(run.lastProgressRecord, 0) || receiptActivity > run.lastReceiptActivity
      || (phase === "transferring" && run.lastProgressRecord < 0))) {
      run.lastProgressRecord = progress.records;
      run.lastReceiptActivity = receiptActivity;
      run.startedAt ??= Date.now();
      run.releaseIdle ??= holdIdleLock();
      clearTimeout(run.progressTimer);
      run.progressTimer = setTimeout(() => {
        if (!this.current(run)) return;
        if (this.state.phase === "transferring") this.needsPairing(run, "connection");
        else {
          run.releaseIdle?.();
          run.releaseIdle = undefined;
          this.releaseScreen(run);
          this.set({ screenOn: false });
        }
      }, TRANSFER_PROGRESS_TIMEOUT_MS);
    }
    if (run.role === "sender" && phase === "transferring" && run.checkpoint && stream.manifest) {
      let boundary = 0;
      const bytes = stream.progress.bytes;
      const completed = new Set(run.checkpoint.completedChatIds);
      for (const chat of stream.manifest.chats) {
        boundary += chat.bytes;
        if (boundary <= bytes) completed.add(chat.id);
      }
      if (completed.size !== run.checkpoint.completedChatIds.length) {
        void this.persist(run, { ...run.checkpoint, bytes, completedChatIds: [...completed] }).catch(() => undefined);
      }
    }
    this.set({ phase, manifest: stream.manifest, progress,
      peerCapacity: stream.peerCapacity, estimatedBytesPerSecond: stream.estimatedBytesPerSecond,
      canSend: run.role === "sender" && phase === "ready" && stream.ready && !stream.started && !this.state.preparing && this.preparedCanSend(run),
      localConfirmed: stream.localConfirmed, peerConfirmed: stream.peerConfirmed,
      checkCode: stream.checkCode,
    });
    if (phase === "transferring" && run.releaseIdle) this.keepScreenOn(run);
  }

  private async keyPair(run: Run): Promise<X25519KeyPair> {
    const pair = await generateX25519KeyPair();
    if (!this.current(run)) {
      pair.privateKey.fill(0);
      throw new Error("History transfer session ended");
    }
    return run.keyPair = pair;
  }

  startAsReceiver = async (options?: { resumeFromPeerDeviceId?: string }): Promise<HistoryTransferInvitation> => {
    const run = this.begin("receiver", options?.resumeFromPeerDeviceId);
    if (!navigator.onLine) { this.fail(run, "offline"); throw new Error("Offline"); }
    try {
      await this.keyPair(run);
      const qr = createTransferPairing(run.deviceId);
      const roomId = await transferRoomId(qr.secret);
      this.assertCurrent(run);
      const { iceServers } = await fetchTurnCredentials();
      this.assertCurrent(run);
      run.roomId = roomId;
      const { expiresAt } = await api.post<{ expiresAt: number }>(`/api/history-transfer/${roomId}`);
      if (!this.current(run) && this.sameSession(run)) {
        void api.delete(`/api/history-transfer/${roomId}`).catch(() => undefined);
      }
      this.assertCurrent(run);
      const invitation = { qr, words: encodeTransferWords(qr.secret), expiresAt };
      this.expireAt(run, expiresAt);
      this.set({ invitation });
      this.connect(run, { secret: qr.secret }, iceServers);
      return invitation;
    } catch (error) {
      this.fail(run, "connection");
      throw error;
    }
  };

  startAsSender = async (input: HistoryTransferQr | string, options?: { resumeFromPeerDeviceId?: string }): Promise<void> => {
    const run = this.begin("sender", options?.resumeFromPeerDeviceId);
    if (!navigator.onLine) { this.fail(run, "offline"); throw new Error("Offline"); }
    let pairing;
    try {
      pairing = parseTransferPairing(input);
      if (pairing.qr?.receiverDeviceId === run.deviceId) throw new Error("The receiver must be a different device");
    } catch (error) {
      if (this.current(run)) this.fail(run, error instanceof UnsupportedTransferVersion ? transferVersionError(error.peerVersion) : "invalid-pairing");
      throw error;
    }
    try {
      run.roomId = await transferRoomId(pairing.secret);
      this.assertCurrent(run);
      await api.get(`/api/history-transfer/${run.roomId}`);
      await this.keyPair(run);
      const { iceServers } = await fetchTurnCredentials();
      this.assertCurrent(run);
      this.connect(run, pairing, iceServers);
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 410) this.end(run, "expired");
      else this.fail(run, status === 409 ? "code-used" : status === 403 ? "other-account"
        : status === 404 || status === 400 ? "invalid-pairing" : "connection");
      throw error;
    }
  };

  prepare = async (selection?: readonly HistoryTransferSelection[], options?: HistoryTransferPrepareOptions): Promise<HistoryTransferManifest & { requiredBytes: number; freeBytes: number | undefined }> => {
    const run = this.run;
    if (!run || !this.current(run) || run.role !== "sender" || !run.stream.ready || run.stream.started) {
      throw new Error("History transfer sender is not ready");
    }
    const version = ++run.prepareVersion;
    run.selectedChats = undefined;
    run.archiveRevisions = undefined;
    run.archiveCandidates = undefined;
    this.set({ preparing: true, canSend: false, error: undefined });
    run.stream.prepare(undefined);
    try {
      const checkpoint = run.checkpoint;
      const hidden = new Set(options?.hiddenConversationIds);
      const completed = new Set(checkpoint?.completedChatIds);
      const requested = selection ?? checkpoint?.chats.filter(({ id }) => !completed.has(id) && !hidden.has(id))
        .map(({ id }) => ({ conversationId: id }));
      const copyDownloadedFiles = options?.copyDownloadedFiles ?? checkpoint?.copyDownloadedFiles ?? false;
      const conversations = requested?.length === 0 ? [] : (await refreshConversationList())
        .filter((conversation) => acceptsHistoryTransfer(conversation, run.userId));
      this.assertCurrent(run);
      const currentIds = new Set(conversations.map(({ id }) => id));
      if (selection?.some(({ conversationId }) => !currentIds.has(conversationId))) {
        throw new Error("A selected conversation is no longer available");
      }
      const selected = requested?.filter(({ conversationId }) => currentIds.has(conversationId))
        ?? conversations.filter(({ id }) => !hidden.has(id)).map(({ id }) => ({ conversationId: id }));
      if (run.prepareVersion !== version) throw new Error("History transfer selection changed");
      const selectedChats = new Set(selected.map(({ conversationId }) => conversationId));
      run.selectedChats = selectedChats;
      await this.verifyLegacy(run, conversations.filter(({ id }) => selectedChats.has(id)),
        () => this.current(run) && run.prepareVersion === version);
      this.assertCurrent(run);
      const { items, candidates, skippedLegacy, missingFiles, revisions } = await exportHistoryTransfer(run.userId, conversations,
        selected.map(({ conversationId }) => ({ conversationId, includeAttachments: copyDownloadedFiles })));
      this.assertCurrent(run);
      const resumeId = checkpoint ? checkpoint.resumeId : crypto.randomUUID();
      const { favourites, recent } = await readStickerState(stickerStateKey(run.userId, run.deviceId));
      const stickers = historyTransferStickerPreferencesSchema.parse({ favourites, recent });
      const archive = buildTransferArchive(items, run.userId, copyDownloadedFiles, skippedLegacy, missingFiles, resumeId,
        favourites.length || recent.length ? stickers : undefined, run.peerDeviceId ? { receiver: run.peerDeviceId, sender: run.deviceId } : undefined);
      const expiresAt = items.reduce((earliest, { entry }) => entry.kind === "message"
        ? Math.min(earliest, normalizeExpiryMetadata(entry.message).expiresAt, entry.attachment?.expiresAt ?? Infinity) : earliest, Infinity);
      const current = () => this.current(run) && run.prepareVersion === version && Date.now() < expiresAt;
      const free = run.stream.peerCapacity?.free;
      let requiredBytes = archive.storageBytes;
      if (requiredBytes && (options?.checkSpace || (free !== undefined && requiredBytes > free))) {
        await verifyHistoryDisclosure(selectedChats, current, candidates);
        if (!current() || !await historyArchiveIsCurrent(revisions, true) || !current()) throw new TransferArchiveChangedError("History changed during export");
        requiredBytes = await run.stream.estimateRemaining(archive, async () => current() && await historyArchiveIsCurrent(revisions) && current());
      }
      this.assertCurrent(run);
      if (run.prepareVersion === version) {
        run.archiveRevisions = revisions;
        run.archiveCandidates = candidates;
        run.archiveRequiredBytes = requiredBytes;
        run.archiveExpiresAt = expiresAt;
        run.stream.prepare(archive);
      }
      return { ...archive.manifest, requiredBytes, freeBytes: run.stream.peerCapacity?.free };
    } catch (error) {
      if (this.current(run) && run.prepareVersion === version) this.set({ error: error instanceof TransferArchiveChangedError ? "archive-changed" : "export" });
      throw error;
    } finally {
      if (this.current(run) && run.prepareVersion === version) {
        this.set({ preparing: false, canSend: this.state.phase === "ready" && run.stream.ready && this.preparedCanSend(run) });
      }
    }
  };

  private invalidateArchive(run: Run): void {
    if (!this.current(run) || run.stream.complete || run.role !== "sender") return;
    if (run.stream.started) {
      this.needsPairing(run, "archive-changed");
      return;
    }
    ++run.prepareVersion;
    run.archiveRevisions = undefined;
    run.archiveCandidates = undefined;
    run.selectedChats = undefined;
    run.stream.prepare(undefined);
    this.set({ preparing: false, canSend: false, error: "archive-changed" });
  }

  private async revalidateArchive(run: Run, preflight = false): Promise<boolean> {
    const revisions = run.archiveRevisions;
    const unchanged = revisions && await historyArchiveIsCurrent(revisions, preflight);
    if (!this.current(run) || revisions !== run.archiveRevisions) return false;
    if (unchanged && Date.now() < (run.archiveExpiresAt ?? Infinity)) return true;
    this.invalidateArchive(run);
    return false;
  }

  private selectedChatsAllowed(run: Run, conversations: readonly ConversationWithMembers[]): boolean {
    const allowed = new Set(conversations.filter((chat) => acceptsHistoryTransfer(chat, run.userId)).map(({ id }) => id));
    return !run.selectedChats || [...run.selectedChats].every((id) => allowed.has(id));
  }

  private async revalidateMembership(run: Run, current = () => this.current(run)): Promise<boolean> {
    const manifest = run.stream.manifest;
    if (!manifest || !current()) return false;
    if (!manifest.chats.length) return true;
    const conversations = await refreshConversationList();
    if (!current() || manifest !== run.stream.manifest) return false;
    if (this.selectedChatsAllowed(run, conversations)) return true;
    this.invalidateArchive(run);
    return false;
  }

  private async renewLease(run: Run): Promise<boolean> {
    if (run.lease && !await renewHistoryTransferLease(run.lease)) {
      this.fail(run, "busy");
      return false;
    }
    return this.current(run);
  }

  private async revalidateDisclosure(run: Run, current = () => this.current(run)): Promise<boolean> {
    const revisions = run.archiveRevisions;
    try {
      await verifyHistoryDisclosure(run.selectedChats ?? new Set(), () => current() && run.archiveRevisions === revisions
        && Date.now() < (run.archiveExpiresAt ?? Infinity), run.archiveCandidates);
    } catch (error) {
      if (!current() || !await this.revalidateArchive(run, true)) return false;
      throw error;
    }
    return current() && await this.revalidateArchive(run, true);
  }

  private preparedCanSend(run: Run): boolean {
    const manifest = run.stream.manifest;
    if (!manifest) return false;
    if ((run.archiveRequiredBytes ?? 0) > (run.stream.peerCapacity?.free ?? Infinity)) return false;
    if (!manifest.chats.length) return !!run.receiverFinishedChats;
    return manifest.chats.some((chat) => chat.messages > 0) || !manifest.chats.some((chat) => !!chat.skippedLegacyMessages);
  }

  confirmCheckCode = (code: string): boolean => {
    const run = this.run;
    if (!run || !this.current(run) || !run.stream.checkCode
      || (this.state.phase !== "pairing" && this.state.phase !== "ready")) return false;
    if (code.replace(/\s/g, "") !== run.stream.checkCode) {
      this.fail(run, "check-code-mismatch");
      return false;
    }
    run.stream.confirm();
    return true;
  };

  rejectComparison = (): void => {
    const run = this.run;
    if (run && this.state.phase === "pairing") this.fail(run, "check-code-mismatch");
  };

  send = async (): Promise<void> => {
    const run = this.run;
    const manifest = run?.stream.manifest;
    if (!run || !this.current(run) || this.state.preparing || !run.stream.ready || run.stream.started
      || !manifest || !this.preparedCanSend(run)) throw new Error("History transfer is not ready");
    const version = run.prepareVersion;
    if (!await this.revalidateMembership(run)) throw new Error("A selected conversation is no longer available");
    if (run.prepareVersion !== version) throw new Error("History transfer selection changed");
    if (!await this.revalidateDisclosure(run)) throw new Error("History changed after preparing the transfer");
    this.assertCurrent(run);
    if (run.prepareVersion !== version || this.state.phase !== "ready" || run.stream.started) throw new Error("History transfer is not ready");
    const checkpoint = checkpointForManifest(manifest, run.checkpoint);
    await this.persist(run, checkpoint);
    this.assertCurrent(run);
    if (run.prepareVersion !== version || this.state.phase !== "ready" || run.stream.started) throw new Error("History transfer is not ready");
    run.stream.send(!manifest.chats.length && !!run.receiverFinishedChats, () => this.revalidateArchive(run));
  };

  private clearReconnect(run: Run): void {
    clearTimeout(run.pauseTimer);
    clearTimeout(run.retry);
    run.reconnectGrace = undefined;
  }

  private pause(run: Run, retryDelay = run.role === "sender" ? 1_500 : 3_000): void {
    if (!this.current(run)) return;
    run.stream.peerDisconnected();
    if (run.stream.complete) return;
    run.resumeCheck = undefined;
    if (run.stream.started) run.stream.setSendingPaused(true);
    if (!run.paired && run.peerDeviceId) {
      this.fail(run, "connection");
      return;
    }
    const showPaused = () => {
      if (!this.current(run)) return;
      if (run.resumeCheck) {
        run.resumeCheck = undefined;
        run.transport?.close();
      }
      this.clearReconnect(run);
      run.releaseIdle?.();
      run.releaseIdle = undefined;
      this.releaseScreen(run);
      this.set({ screenOn: false, canSend: false, phase: "paused", peerConfirmed: false, checkCode: undefined, error: this.state.error === "archive-changed" ? this.state.error : "connection" });
    };
    if (!run.stream.started) { showPaused(); return; }
    if (this.state.phase === "paused" && !run.reconnectGrace) return;
    if (!run.reconnectGrace) {
      run.reconnectGrace = { deadline: Date.now() + RECONNECT_GRACE_MS };
      run.pauseTimer = setTimeout(showPaused, RECONNECT_GRACE_MS);
    }
    this.set({ phase: "reconnecting", canSend: false, peerConfirmed: false, checkCode: undefined, error: undefined });
    clearTimeout(run.retry);
    run.retry = setTimeout(() => void this.reconnect(run).catch(() => this.pause(run)), retryDelay);
  }

  private async reconnect(run: Run): Promise<void> {
    const transport = run.transport;
    if (!this.current(run) || !transport) return;
    const grace = run.reconnectGrace;
    if (run.connecting && run.connecting.grace === grace) return run.connecting.promise;
    const stillReconnecting = () => this.current(run) && grace === run.reconnectGrace && (!grace || grace.deadline > Date.now());
    const promise = (async () => {
      if (!stillReconnecting()) return;
      const { iceServers } = await fetchTurnCredentials();
      if (!stillReconnecting()) return;
      clearTimeout(run.retry);
      transport.connect(useAuthStore.getState().accessToken!, iceServers);
    })().catch((error) => { if (stillReconnecting()) throw error; });
    run.connecting = { grace, promise };
    try {
      await promise;
    } finally {
      if (run.connecting?.promise === promise) run.connecting = undefined;
    }
  }

  resume = async (): Promise<void> => {
    const run = this.run;
    if (!run || !this.current(run) || this.state.phase !== "paused") return;
    if (!run.stream.started) {
      await this.reconnect(run);
      return;
    }
    this.set({ phase: "reconnecting" });
    this.pause(run);
    await this.reconnect(run);
  };

  continueInBackground = (): boolean => {
    if (!this.run?.stream.started || !this.current(this.run)) return false;
    this.set({ background: true });
    return true;
  };

  showTransfer = (): void => { this.set({ background: false }); };

  dismiss = (): void => {
    if (this.run) return;
    this.interruptedRun = undefined;
    this.state = initialState;
    this.set({});
  };

  private verifyLegacy(run: Run, chats: readonly ConversationWithMembers[], current: () => boolean): Promise<void> {
    return verifyLegacyHistoryOwnership(run.userId, chats, async (messages) =>
      (await api.post<{ ids: string[] }>("/api/messages/history-ownership", { messages })).ids, current, Date.now(), async (ids) => {
        for (const id of ids) await reconcileLocalMessageChange(id, useChatStore.getState(), current);
      });
  }

  listChats = async () => {
    const run = this.run;
    if (!run || !this.current(run) || run.role !== "sender") return [];
    const conversations = (await refreshConversationList()).filter((conversation) => acceptsHistoryTransfer(conversation, run.userId));
    await this.verifyLegacy(run, conversations, () => this.current(run));
    this.assertCurrent(run);
    const chats = await historyTransferCatalog(run.userId, conversations);
    this.assertCurrent(run);
    run.chatNames = new Map(chats.flatMap(({ id, name }) => name ? [[id, name] as const] : []));
    return chats;
  };

  startFresh = (): void => {
    const run = this.run;
    if (!run || !this.current(run) || run.stream.started) return;
    this.invalidateArchive(run);
    run.checkpoint = undefined;
    run.resumeInfo = Promise.resolve(undefined);
    run.receiverFinishedChats = false;
    this.set({ checkpoint: undefined, canFinalize: false, error: undefined });
  };

  listInterrupted = async (role: HistoryTransferRole) => {
    const { user, device, accessToken } = useAuthStore.getState();
    return keysLoaded() && user && device && accessToken ? listInterruptedHistoryTransfers({ userId: user.id, deviceId: device.id, role }) : [];
  };

  discardInterrupted = async (role: HistoryTransferRole, peerDeviceId: string): Promise<void> => {
    const { user, device, accessToken } = useAuthStore.getState();
    if (keysLoaded() && user && device && accessToken) await clearHistoryTransferCheckpoint({ userId: user.id, deviceId: device.id, role }, peerDeviceId);
  };

  conversationMarkers = async (conversationId: string) => {
    const { user, accessToken } = useAuthStore.getState();
    return keysLoaded() && user && accessToken ? getHistoryTransferMarkers(user.id, conversationId) : [];
  };

  stop = (): void => {
    const run = this.run;
    if (!run) {
      const interrupted = this.interruptedRun;
      const { user, device, sessionId, accessToken } = useAuthStore.getState();
      if (interrupted && accessToken && user?.id === interrupted.userId
        && device?.id === interrupted.deviceId && sessionId === interrupted.sessionId) {
        void interrupted.writes.then(() => clearHistoryTransferCheckpoint(interrupted, interrupted.peerDeviceId, interrupted.lease, true)).catch(() => undefined);
      }
      this.dismiss();
      return;
    }
    if (this.current(run) && !run.stream.complete && !run.transport?.cancel() && run.roomId) {
      void api.delete(`/api/history-transfer/${run.roomId}`).catch(() => undefined);
    }
    if (run.stream.started) this.eraseCheckpoint(run);
    this.end(run, "cancelled");
  };

  private async publishImported(run: Run, changed: LocalMessage): Promise<void> {
    const visible = await guardMessageForPublish(changed, run.userId);
    if (!this.current(run)) return;
    const chat = useChatStore.getState();
    if (!visible) {
      if (changed.deletedAt != null) chat.removeMessages([changed.id]);
      return;
    }
    const existing = chat.messages.get(visible.conversationId)?.find((message) => message.id === visible.id);
    if (existing && existing.senderId === visible.senderId
      && (visible.deletedAt != null || existing.status === "failed" || (visible.editedAt ?? 0) > (existing.editedAt ?? 0))) {
      chat.addMessage(visible.conversationId, { ...existing, ...visible, ...normalizeExpiryMetadata(visible),
        type: visible.type as typeof existing.type, status: visible.status as typeof existing.status, fileMetadata: undefined });
    }
  }
}

const controller = new HistoryTransferController();

/** The screen and banner subscribe to the same tab-local transfer. */
export function useHistoryTransfer() {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return {
    ...state,
    startAsReceiver: controller.startAsReceiver,
    startAsSender: controller.startAsSender,
    prepare: controller.prepare,
    confirmCheckCode: controller.confirmCheckCode,
    rejectComparison: controller.rejectComparison,
    startFresh: controller.startFresh,
    send: controller.send,
    resume: controller.resume,
    continueInBackground: controller.continueInBackground,
    showTransfer: controller.showTransfer,
    dismiss: controller.dismiss,
    listChats: controller.listChats,
    listInterrupted: controller.listInterrupted,
    discardInterrupted: controller.discardInterrupted,
    conversationMarkers: controller.conversationMarkers,
    stop: controller.stop,
    cancel: controller.stop,
  };
}

export type { HistoryTransferProgress, HistoryTransferQr };
