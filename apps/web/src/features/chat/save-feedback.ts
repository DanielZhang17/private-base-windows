import { create } from "zustand";
import { t, type TranslationKey } from "../../i18n/index.js";
import { registerUnlockedSessionCleanup } from "../../platform/session-cleanup.js";
import { useAuthStore } from "../../stores/authStore.js";
import { getTopOverlay, subscribeToTopOverlay, type Overlay } from "../../ui/overlay-stack.js";

interface SaveResult {
  id: number;
  tone: "success" | "danger";
  key: TranslationKey;
  fileName: string | undefined;
}

interface SaveAnnouncement {
  id: number;
  text: string;
  assertive: boolean;
  viewer: string | undefined;
}

export const useSaveFeedbackStore = create<{
  notice: SaveResult | null;
  announcement: SaveAnnouncement | null;
  topOverlay: Overlay | undefined;
}>(() => ({ notice: null, announcement: null, topOverlay: getTopOverlay() }));

let generation = 0;
let nextNoticeId = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let deadline = 0;
let remaining = 0;
const pending: SaveResult[] = [];

function pauseTimer(): void {
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
  remaining = Math.max(0, deadline - Date.now());
}

function showNextSaveFeedback(): void {
  pauseTimer();
  const notice = getTopOverlay()?.kind === "modal" ? null : pending.shift() ?? null;
  remaining = notice?.tone === "danger" ? 8000 : 4000;
  useSaveFeedbackStore.setState({ notice, announcement: null });
}

function startTimer(notice: SaveResult): void {
  if (timer !== undefined) return;
  deadline = Date.now() + remaining;
  timer = setTimeout(() => dismissSaveFeedback(notice), remaining);
}

subscribeToTopOverlay((topOverlay) => {
  const held = topOverlay?.kind === "modal";
  if (held) pauseTimer();
  useSaveFeedbackStore.setState({ topOverlay });
  if (held) return;
  const { notice, announcement } = useSaveFeedbackStore.getState();
  if (!notice) showNextSaveFeedback();
  else if (announcement) startTimer(notice);
});

export function presentSaveFeedback(notice: SaveResult, viewer?: string): void {
  const { notice: current, announcement } = useSaveFeedbackStore.getState();
  const topOverlay = getTopOverlay();
  if (current !== notice || topOverlay?.kind === "modal" || topOverlay?.id !== viewer) return;
  startTimer(notice);
  if (!announcement) {
    const text = t(notice.key);
    useSaveFeedbackStore.setState({
      announcement: {
        id: notice.id,
        viewer,
        assertive: notice.tone === "danger",
        text: notice.fileName ? `${text} ${notice.fileName}` : text,
      },
    });
  }
}

export function dismissSaveFeedback(notice: SaveResult): void {
  if (useSaveFeedbackStore.getState().notice === notice) showNextSaveFeedback();
}

function clearSession(): void {
  generation += 1;
  pending.length = 0;
  showNextSaveFeedback();
}

registerUnlockedSessionCleanup(clearSession);
useAuthStore.subscribe?.((current, previous) => {
  // Loading the missing profile during session repair preserves the login.
  if (current.sessionId !== previous.sessionId || (previous.user?.id && current.user?.id !== previous.user.id)
    || current.device?.id !== previous.device?.id || (previous.accessToken && !current.accessToken)) {
    clearSession();
  }
});

export function captureSaveFeedback(fileName?: string) {
  const { accessToken, device, sessionId, user } = useAuthStore.getState();
  const wasAuthenticated = Boolean(accessToken);
  const deviceId = device?.id;
  const userId = user?.id;
  const startGeneration = generation;
  // Local lock invalidates pending saves even when the login identity stays the same.
  const isSaveSessionCurrent = () => {
    const current = useAuthStore.getState();
    return startGeneration === generation && wasAuthenticated && !!current.accessToken
      && !!deviceId && deviceId === current.device?.id && sessionId === current.sessionId;
  };
  return {
    isSaveSessionCurrent,
    publish(tone: SaveResult["tone"], key: TranslationKey) {
      if (!isSaveSessionCurrent()) return;
      const confirmedUser = !!userId && userId === useAuthStore.getState().user?.id;
      pending.push({
        id: ++nextNoticeId,
        tone,
        key: tone === "success" && !confirmedUser ? "fileSaved" : key,
        fileName: confirmedUser ? fileName : undefined,
      });
      if (!useSaveFeedbackStore.getState().notice && getTopOverlay()?.kind !== "modal") showNextSaveFeedback();
    },
  };
}

