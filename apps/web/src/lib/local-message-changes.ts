/** Cross-tab hints contain opaque IDs only. IndexedDB remains the source of truth. */
export interface LocalMessageChange { id: string; kind: "hide" | "commit" | "undo"; conversationId?: string }
const hideGenerations = new Map<string, number>();
let unscopedHideGeneration = 0;
function noteHideChange(conversationId?: string): void {
  if (conversationId) hideGenerations.set(conversationId, (hideGenerations.get(conversationId) ?? 0) + 1);
  else unscopedHideGeneration++; // Older peers sent only IDs; conservatively invalidate all pages.
}
export function getConversationHideGeneration(conversationId: string): number {
  return unscopedHideGeneration + (hideGenerations.get(conversationId) ?? 0);
}
export function createLocalMessageChannel(scope: { userId: string; deviceId: string }, onChange: (change: LocalMessageChange) => void) {
  const name = `privatebase:local-messages:${JSON.stringify([scope.userId, scope.deviceId])}`;
  let channel: BroadcastChannel | undefined;
  try { if (typeof BroadcastChannel !== "undefined") channel = new BroadcastChannel(name); } catch { /* Storage fallback below. */ }
  const seen = new Set<string>();
  const receive = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const event = value as LocalMessageChange & { nonce?: string };
    if (typeof event.id !== "string" || !["hide", "commit", "undo"].includes(event.kind) || typeof event.nonce !== "string" || seen.has(event.nonce)) return;
    seen.add(event.nonce);
    if (seen.size > 128) seen.delete(seen.values().next().value!);
    const conversationId = typeof event.conversationId === "string" ? event.conversationId : undefined;
    noteHideChange(conversationId);
    onChange({ id: event.id, kind: event.kind, ...(conversationId ? { conversationId } : {}) });
  };
  if (channel) channel.onmessage = (event) => receive(event.data);
  const storage = (event: StorageEvent) => {
    if (event.key !== name || !event.newValue) return;
    try { receive(JSON.parse(event.newValue)); } catch { /* Ignore unrelated/malformed hints. */ }
  };
  window.addEventListener("storage", storage);
  return {
    publish(change: LocalMessageChange) {
      const event = { ...change, nonce: crypto.randomUUID() };
      seen.add(event.nonce);
      if (seen.size > 128) seen.delete(seen.values().next().value!);
      try { channel?.postMessage(event); } catch { /* Storage also reaches fallback-only tabs. */ }
      try { localStorage.setItem(name, JSON.stringify(event)); localStorage.removeItem(name); } catch { /* Storage may be disabled. */ }
    },
    close() { channel?.close(); window.removeEventListener("storage", storage); },
  };
}
let active: ReturnType<typeof createLocalMessageChannel> | undefined;
export function connectLocalMessageChannel(scope: { userId: string; deviceId: string }, onChange: (change: LocalMessageChange) => void): () => void {
  const channel = createLocalMessageChannel(scope, onChange);
  active = channel;
  return () => { channel.close(); if (active === channel) active = undefined; };
}
export function publishLocalMessageChange(id: string, kind: LocalMessageChange["kind"], conversationId?: string): void {
  noteHideChange(conversationId);
  active?.publish({ id, kind, ...(conversationId ? { conversationId } : {}) });
}
