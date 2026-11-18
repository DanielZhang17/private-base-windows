/** Cross-tab hints contain opaque IDs only. IndexedDB remains the source of truth. */
export interface LocalMessageChange { id: string; kind: "hide" | "commit" | "undo" | "history" | "edit" | "outbox" | "outbox-batch" | "repair"; conversationId?: string }
const hideGenerations = new Map<string, number>();
const historyPreviewListeners = new Set<(id: string) => void>();
export function subscribeHistoryPreviews(listener: (id: string) => void): () => void {
  historyPreviewListeners.add(listener);
  return () => { historyPreviewListeners.delete(listener); };
}
const historyListeners = new Map<string, Set<() => void>>();
let unscopedHideGeneration = 0;
const removalListeners = new Set<(conversationId?: string) => void>();
export function subscribeMessageRemovals(listener: (conversationId?: string) => void): () => void {
  removalListeners.add(listener);
  return () => { removalListeners.delete(listener); };
}
function notifyRemoval(change: LocalMessageChange): void {
  if (change.kind === "hide" || change.kind === "commit") {
    for (const listener of removalListeners) listener(change.conversationId);
  }
}
function noteHideChange(conversationId?: string): void {
  if (conversationId) hideGenerations.set(conversationId, (hideGenerations.get(conversationId) ?? 0) + 1);
  else unscopedHideGeneration++; // Older peers sent only IDs; conservatively invalidate all pages.
}
export function getConversationHideGeneration(conversationId: string): number {
  return unscopedHideGeneration + (hideGenerations.get(conversationId) ?? 0);
}
export function subscribeHistoryImports(conversationId: string, listener: () => void): () => void {
  const listeners = historyListeners.get(conversationId) ?? new Set();
  listeners.add(listener);
  historyListeners.set(conversationId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) historyListeners.delete(conversationId);
  };
}

function notifyHistory(change: LocalMessageChange): void {
  if (change.kind === "history" && change.conversationId) {
    for (const listener of historyListeners.get(change.conversationId) ?? []) listener();
    for (const listener of historyPreviewListeners) listener(change.conversationId);
  }
}
export function createLocalMessageChannel(scope: { userId: string; deviceId: string }, onChange: (change: LocalMessageChange) => void) {
  const name = `privatebase:local-messages:${JSON.stringify([scope.userId, scope.deviceId])}`;
  let channel: BroadcastChannel | undefined;
  try { if (typeof BroadcastChannel !== "undefined") channel = new BroadcastChannel(name); } catch { /* Storage fallback below. */ }
  const seen = new Set<string>();
  const receive = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const event = value as LocalMessageChange & { nonce?: string };
    if (typeof event.id !== "string" || !["hide", "commit", "undo", "history", "edit", "outbox", "outbox-batch", "repair"].includes(event.kind) || typeof event.nonce !== "string" || seen.has(event.nonce)) return;
    seen.add(event.nonce);
    if (seen.size > 128) seen.delete(seen.values().next().value!);
    const conversationId = typeof event.conversationId === "string" ? event.conversationId : undefined;
    if (event.kind !== "outbox" && event.kind !== "outbox-batch") noteHideChange(conversationId);
    const change = { id: event.id, kind: event.kind, ...(conversationId ? { conversationId } : {}) };
    notifyRemoval(change);
    if (change.kind === "history") notifyHistory(change);
    else onChange(change);
  };
  if (channel) channel.onmessage = (event) => receive(event.data);
  const storage = (event: StorageEvent) => {
    if (event.key !== name || !event.newValue) return;
    try { receive(JSON.parse(event.newValue)); } catch { /* Ignore unrelated/malformed hints. */ }
  };
  window.addEventListener("storage", storage);
  return {
    publish(change: LocalMessageChange, includeSelf = false) {
      const event = { ...change, nonce: crypto.randomUUID() };
      seen.add(event.nonce);
      if (seen.size > 128) seen.delete(seen.values().next().value!);
      try { channel?.postMessage(event); } catch { /* Storage also reaches fallback-only tabs. */ }
      try { localStorage.setItem(name, JSON.stringify(event)); localStorage.removeItem(name); } catch { /* Storage may be disabled. */ }
      if (includeSelf) onChange(change);
    },
    close() { channel?.close(); window.removeEventListener("storage", storage); },
  };
}
let active: (ReturnType<typeof createLocalMessageChannel> & { userId: string }) | undefined;
export function connectLocalMessageChannel(scope: { userId: string; deviceId: string }, onChange: (change: LocalMessageChange) => void): () => void {
  const channel = { ...createLocalMessageChannel(scope, onChange), userId: scope.userId };
  active = channel;
  return () => { channel.close(); if (active === channel) active = undefined; };
}
export function publishLocalMessageChange(id: string, kind: LocalMessageChange["kind"], conversationId?: string, includeSelf = false, ownerId?: string): void {
  if (ownerId && active?.userId !== ownerId) return;
  if (kind !== "outbox" && kind !== "outbox-batch") noteHideChange(conversationId);
  const change = { id, kind, ...(conversationId ? { conversationId } : {}) };
  notifyHistory(change);
  notifyRemoval(change);
  active?.publish(change, includeSelf);
}
