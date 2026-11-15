import { afterEach, expect, it, vi } from "vitest";
import { useCallStore } from "./callStore.js";

afterEach(() => useCallStore.getState().clearAllCalls());
const meta = { callId: "call", conversationId: "chat", callType: "audio" as const, initiatorId: "bob", callerUserId: "bob", keyReady: true };

it("does not copy consent between independent tab heaps receiving the same server event", async () => {
  // Each tab loads its own non-persisted store, even when IndexedDB/auth are shared.
  const tabA = useCallStore;
  vi.resetModules();
  const tabB = (await import("./callStore.js")).useCallStore;
  try {
    tabA.getState().setIncomingCall(meta);
    tabB.getState().setIncomingCall(meta);
    expect(tabA.getState().acceptLocalCall("call")).toBe(true);
    tabB.getState().updateCallStatus("call", "active");
    expect(tabA.getState().localCallOwnership).toEqual({ callId: "call", reason: "accepted" });
    expect(tabB.getState().localCallOwnership).toBeNull();
    expect(tabB.getState().callStatus).toBe("active");
    const epochA = tabA.getState().localCallEpoch;
    const epochB = tabB.getState().localCallEpoch;
    const tabBLock = (await import("../platform/session-cleanup.js")).clearRegisteredLocalCallState;
    tabBLock();
    expect(tabB.getState().localCallEpoch).toBeGreaterThan(epochB);
    expect(tabA.getState().localCallEpoch).toBe(epochA);
    expect(tabA.getState().localCallOwnership).toEqual({ callId: "call", reason: "accepted" });
    tabA.getState().updateCallStatus("call", "ended");
    expect(tabA.getState().localCallOwnership).toBeNull();
  } finally { tabB.getState().clearAllCalls(); }
});

it("grants ownership only on local Start/Accept, never incoming metadata or hydration", () => {
  useCallStore.getState().setIncomingCall(meta);
  useCallStore.getState().hydrateCall({ ...meta, direction: "incoming", status: "active" });
  expect(useCallStore.getState().localCallOwnership).toBeNull();
  expect(useCallStore.getState().acceptLocalCall("other")).toBe(false);
  useCallStore.getState().setOutgoingCall(meta);
  expect(useCallStore.getState().localCallOwnership).toEqual({ callId: "call", reason: "started" });
  useCallStore.getState().clearAllCalls();
  expect(useCallStore.getState().localCallOwnership).toBeNull();
});


it("round 4: targeted cleanup is a no-op for a newer pending or owned call", () => {
  useCallStore.getState().clearAllCalls();
  useCallStore.getState().setOutgoingCall({ ...meta, callId: "A" });
  useCallStore.getState().updateCallStatus("A", "ended");
  const token = useCallStore.getState().beginCallStart()!;
  const pending = useCallStore.getState();
  useCallStore.getState().clearCall("A");
  expect(useCallStore.getState()).toBe(pending);
  expect(useCallStore.getState().bindCallStart(token, "B")).toBe(true);
  const bound = useCallStore.getState();
  useCallStore.getState().clearCall("A");
  expect(useCallStore.getState()).toBe(bound);
  expect(useCallStore.getState().setOutgoingCall({ ...meta, callId: "B" }, token)).toBe(true);
  const owned = useCallStore.getState();
  useCallStore.getState().clearCall("A");
  expect(useCallStore.getState()).toBe(owned);
  expect(useCallStore.getState().localCallOwnership).toEqual({ callId: "B", reason: "started" });
  useCallStore.getState().clearCall("B");
  expect(useCallStore.getState().activeCallId).toBeNull();
});

it("round 4: only the pending Start's token can finish it; lock/sign-out reset invalidates it", () => {
  useCallStore.getState().clearAllCalls();
  const first = useCallStore.getState().beginCallStart()!;
  useCallStore.getState().clearAllCalls();
  const second = useCallStore.getState().beginCallStart()!;
  useCallStore.getState().finishCallStart(first);
  expect(useCallStore.getState().pendingCallStart?.token).toBe(second);
  expect(useCallStore.getState().bindCallStart(first, "A")).toBe(false);
  expect(useCallStore.getState().setOutgoingCall({ ...meta, callId: "A" }, first)).toBe(false);
  expect(useCallStore.getState().bindCallStart(second, "B")).toBe(true);
  useCallStore.getState().clearCall("B");
  expect(useCallStore.getState().pendingCallStart).toBeNull();
  expect(useCallStore.getState().setOutgoingCall({ ...meta, callId: "B" }, second)).toBe(false);
});
