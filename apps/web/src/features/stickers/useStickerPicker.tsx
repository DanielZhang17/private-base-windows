import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { stickerToken } from "../../lib/stickers.js";
import { useAuthStore } from "../../stores/authStore.js";
import { isNative } from "../../platform/environment.js";
import { useToast } from "../../ui/index.js";
import { addFavourite, defaultStickerState, FAVOURITES_LIMIT, readStickerState, recordRecent, removeFavourite, stickerStateKey, subscribeToFavourites, updateStickerState, type StickerState } from "./storage.js";
import { captureMessageActionSession, isMessageActionSessionCurrent, trackMessageUndoToast } from "../chat/message-action-session.js";
import { allowStickerSend } from "./picker-model.js";

type Sender = (text: string) => void;

function useStickerControls(storageKey: string | undefined, sessionId: string | null | undefined) {
  // Async writes keep their original identity without keying the chat subtree.
  const scope = useMemo(() => ({ latest: defaultStickerState, pending: Promise.resolve(), mounted: false, lastSend: new Map<string, number>() }),
    [storageKey, sessionId]);
  const [stored, setStored] = useState<{ scope: typeof scope; value: StickerState }>();
  const state = stored?.scope === scope ? stored.value : defaultStickerState;
  const [sender, setSender] = useState<Sender>();
  const toast = useToast();

  useLayoutEffect(() => {
    scope.mounted = true;
    return () => { scope.mounted = false; };
  }, [scope]);

  const publish = useCallback((value: StickerState) => {
    scope.latest = value;
    if (scope.mounted) setStored({ scope, value });
  }, [scope]);

  const change = useCallback((update: (previous: StickerState) => StickerState, requireCommit = false) => {
    const operation = scope.pending.then(async () => {
      let next: StickerState;
      try {
        if (!storageKey) throw new Error("Sticker storage unavailable");
        next = await updateStickerState(storageKey, update);
      } catch (error) {
        if (requireCommit) throw error;
        next = update(scope.latest);
      }
      publish(next);
    });
    scope.pending = operation.catch(() => undefined);
    return operation;
  }, [storageKey, scope, publish]);

  useEffect(() => {
    if (!storageKey) return;
    scope.pending = scope.pending.then(async () => publish(await readStickerState(storageKey).catch(() => scope.latest)));
    return subscribeToFavourites(storageKey, (favourites) => publish({ ...scope.latest, favourites }));
  }, [storageKey, scope, publish]);

  const registerSender = useCallback((send: Sender | undefined) => {
    setSender(() => send);
  }, []);

  const send = (id: string) => {
    const at = Date.now();
    if (!sender || !allowStickerSend(scope.lastSend.get(id), at)) return false;
    scope.lastSend.set(id, at);
    sender(stickerToken(id));
    void change((previous) => recordRecent(previous, id));
    return true;
  };

  const setFavourite = async (id: string, intent: "add" | "remove", feedback?: {
    onFull: () => void; onRemoved: (undo: () => void) => void; onError?: () => void;
  }) => {
    const session = captureMessageActionSession();
    const canUndo = () => storageKey ? isMessageActionSessionCurrent(session) : scope.mounted;
    let removed: StickerState["favourites"][number] | undefined;
    let added = false;
    let full = false;
    const showLimit = () => {
      if (feedback) feedback.onFull();
      else toast.show({ message: t("stickerFavouritesFull", { max: new Intl.NumberFormat().format(FAVOURITES_LIMIT) }), duration: 0 });
    };
    const showSaveError = () => {
      if (!canUndo()) return;
      if (feedback?.onError) feedback.onError();
      else toast.show({ tone: "danger", message: t("stickerFavouritesSaveFailed") });
    };
    try {
      await change((previous) => {
        const existing = previous.favourites.find((entry) => entry.id === id);
        if (intent === "remove") {
          removed = existing;
          return removeFavourite(previous, id);
        }
        const next = addFavourite(previous, { id, addedAt: Date.now() });
        added = next !== previous;
        full = !existing && !added;
        return next;
      }, true);
    } catch {
      showSaveError();
      return;
    }
    if (!scope.mounted || !canUndo()) return;
    if (added) toast.show({ tone: "success", message: t("stickerAddedToFavourites") });
    if (full) showLimit();
    if (!removed) return;

    const entry = removed;
    const undo = () => {
      if (!canUndo()) return;
      let atLimit = false;
      void change((previous) => {
        if (!canUndo()) return previous;
        atLimit = previous.favourites.length >= FAVOURITES_LIMIT && !previous.favourites.some((favourite) => favourite.id === id);
        return addFavourite(previous, entry);
      }, true).then(() => {
        if (atLimit && canUndo() && (scope.mounted || !feedback)) showLimit();
      }, showSaveError);
    };
    if (feedback) feedback.onRemoved(undo);
    else {
      const toastId = toast.show({ message: t("stickerRemovedFromFavourites"), action: { label: t("undo"), onClick: undo } });
      if (storageKey) trackMessageUndoToast(session, () => toast.dismiss(toastId));
    }
  };

  const snapshotRecent = useCallback(() => {
    const snapshot = scope.pending.then(async () => {
      if (storageKey) {
        const { recent } = await readStickerState(storageKey).catch(() => scope.latest);
        publish({ ...scope.latest, recent });
      }
      return scope.latest.recent;
    });
    scope.pending = snapshot.then(() => undefined);
    return snapshot;
  }, [scope, storageKey, publish]);
  return { state, change, registerSender, canSend: !!sender, send, setFavourite, snapshotRecent };
}

type StickerControls = ReturnType<typeof useStickerControls>;
const PickerContext = createContext<StickerControls | null>(null);

let workerRegistration: Promise<unknown> | undefined;

export function StickerProvider({ children }: { children: ReactNode }) {
  const user = useAuthStore((state) => state.user?.id);
  const device = useAuthStore((state) => state.device?.id);
  const session = useAuthStore((state) => state.sessionId);
  useEffect(() => {
    if (!user || isNative() || !window.isSecureContext || !navigator.serviceWorker?.register) return;
    workerRegistration ??= navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => { workerRegistration = undefined; });
  }, [user]);
  const storageKey = user && device ? stickerStateKey(user, device) : undefined;
  const controls = useStickerControls(storageKey, session);
  return <PickerContext.Provider value={controls}>{children}</PickerContext.Provider>;
}

export function useStickerPicker() {
  return useContext(PickerContext);
}
