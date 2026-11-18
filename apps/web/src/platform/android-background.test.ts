import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { capabilities } from "./capabilities.js";
import * as adapter from "./android-background.js";
import { backgroundSnapshot, setStayConnected, startBackgroundSession } from "./android-background-service.js";
import { clearRegisteredLocalCallState, clearUnlockedSessionState } from "./session-cleanup.js";
import { showMessageNotification } from "../lib/browser-notifications.js";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), permission: vi.fn(), notify: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./notifications.js", () => ({ requestNotificationPermission: mocks.permission, notify: mocks.notify }));
let dispose: (() => void) | undefined;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  vi.spyOn(capabilities, "backgroundConnection", "get").mockReturnValue(true);
  vi.spyOn(capabilities, "nativeCallNotifications", "get").mockReturnValue(true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  mocks.permission.mockResolvedValue(true);
  mocks.notify.mockResolvedValue(true);
  mocks.invoke.mockImplementation(async (name: string) => name === "background_status" ?
    { running: false, notifications: true, fullScreen: false, batteryExempt: false } : name === "take_notification_actions" ? [] : true);
});
afterEach(async () => { dispose?.(); dispose = undefined; await flush(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("defaults off per account, persists opt-in, restores it and stops on teardown without clearing the preference", async () => {
  dispose = startBackgroundSession("alice", () => true);
  expect(backgroundSnapshot().enabled).toBe(false);
  expect(await setStayConnected(true)).toBe(true);
  expect(mocks.permission).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledWith("configure_background", { enabled: true });
  expect(localStorage.getItem("private-base:android-background:alice")).toBe("true");
  dispose(); await flush();
  expect(mocks.invoke).toHaveBeenCalledWith("configure_background", { enabled: false });
  dispose = startBackgroundSession("alice", () => true); await flush();
  expect(backgroundSnapshot().enabled).toBe(true);
  dispose(); await flush();
  dispose = startBackgroundSession("bob", () => true);
  expect(backgroundSnapshot().enabled).toBe(false);
  expect(await setStayConnected(false)).toBe(true);
  expect(localStorage.getItem("private-base:android-background:bob")).toBe("false");
});
it.each(["denied", "native failure", "storage failure"])("stays off and stops after %s", async (failure) => {
  dispose = startBackgroundSession("alice", () => true);
  if (failure === "denied") mocks.permission.mockResolvedValue(false);
  if (failure === "native failure") mocks.invoke.mockImplementation(async (name: string, args?: { enabled: boolean }) => {
    if (name === "configure_background" && args?.enabled) throw "unavailable";
  });
  if (failure === "storage failure") vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(await setStayConnected(true)).toBe(false);
  expect(backgroundSnapshot()).toMatchObject({ enabled: false, busy: false, error: true });
  expect(mocks.invoke).toHaveBeenCalledWith("configure_background", { enabled: false });
});
it.each(["lock", "logout", "off"])("invalidates a delayed permission grant on %s", async (reason) => {
  const permission = deferred<boolean>();
  mocks.permission.mockReturnValue(permission.promise);
  let current = true;
  dispose = startBackgroundSession("alice", () => current);
  const enabling = setStayConnected(true);
  if (reason === "lock") clearRegisteredLocalCallState();
  else if (reason === "logout") { current = false; dispose(); }
  else await setStayConnected(false);
  permission.resolve(true); await enabling; await flush();
  expect(mocks.invoke).not.toHaveBeenCalledWith("configure_background", { enabled: true });
  expect(backgroundSnapshot().enabled).toBe(false);
});
it("serializes an in-flight start with off and cannot resume during the stop", async () => {
  const start = deferred<null>(); const stop = deferred<null>();
  mocks.invoke.mockImplementation(async (name: string, args?: { enabled: boolean }) => {
    if (name === "configure_background") return args?.enabled ? start.promise : stop.promise;
  });
  dispose = startBackgroundSession("alice", () => true);
  const enabling = setStayConnected(true); await flush();
  const disabling = setStayConnected(false);
  window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange"));
  expect(backgroundSnapshot()).toMatchObject({ enabled: false, busy: true });
  start.resolve(null); await flush(); stop.resolve(null);
  await Promise.all([enabling, disabling]);
  const changes = mocks.invoke.mock.calls.filter(([name]) => name === "configure_background");
  expect(changes.map(([, args]) => args.enabled)).toEqual([true, false, false]);
  expect(backgroundSnapshot()).toMatchObject({ enabled: false, busy: false });
});
it("cancels a start that completes after account teardown", async () => {
  const start = deferred<null>();
  mocks.invoke.mockImplementation(async (name: string, args?: { enabled: boolean }) => name === "configure_background" && args?.enabled ? start.promise : null);
  dispose = startBackgroundSession("alice", () => true);
  const enabling = setStayConnected(true); await flush();
  clearUnlockedSessionState(); start.resolve(null); await enabling; await flush();
  const changes = mocks.invoke.mock.calls.filter(([name]) => name === "configure_background");
  expect(changes.at(-1)).toEqual(["configure_background", { enabled: false }]);
  expect(localStorage.getItem("private-base:android-background:alice")).not.toBe("true");
});
it("whitelists call/message IPC and uses only the native message path while hidden", async () => {
  await adapter.showIncomingCall({ callId: "call-1", callerName: "Alice", video: false, secret: "never native" } as Parameters<typeof adapter.showIncomingCall>[0]);
  expect(mocks.invoke).toHaveBeenCalledWith("show_incoming_call", { callId: "call-1", callerName: "Alice", video: false });
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  showMessageNotification("Alice", "chat-1"); await flush();
  expect(mocks.invoke).toHaveBeenCalledWith("show_message_notification", { conversationId: "chat-1", senderName: "Alice" });
  expect(mocks.notify).not.toHaveBeenCalled();
  await adapter.showIncomingCall({ callId: "../bad", callerName: "Alice", video: false });
  await adapter.cancelIncomingCall("../bad");
  expect(mocks.invoke.mock.calls.some(([, args]) => JSON.stringify(args).includes("../bad"))).toBe(false);
});
it("does not invoke the new commands in older shells and keeps generic sticker notifications", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android");
  vi.spyOn(capabilities, "backgroundConnection", "get").mockReturnValue(false);
  vi.spyOn(capabilities, "nativeCallNotifications", "get").mockReturnValue(false);
  dispose = startBackgroundSession("alice", () => true);
  expect(await setStayConnected(true)).toBe(false);
  await adapter.configureBackground(true); await adapter.configureBackground(false);
  await adapter.showIncomingCall({ callId: "call-1", callerName: "Alice", video: false });
  await adapter.cancelIncomingCall("call-1"); expect(await adapter.takeNotificationActions()).toEqual([]);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  showMessageNotification("Alice", "chat-1", "sticker"); await flush();
  expect(mocks.notify).toHaveBeenCalledTimes(1); expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.notify.mock.calls[0][0]).not.toHaveProperty("body");
});

it("includes a decrypted sticker preview in a browser notification", async () => {
  vi.spyOn(capabilities, "nativeCallNotifications", "get").mockReturnValue(false);
  showMessageNotification("Alice", "chat-1", "sticker"); await flush();
  expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ body: "Sticker" }));
});
it("requires native Android and explicit flags while preserving passkey handoff", () => {
  vi.restoreAllMocks();
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { passkeyHandoff: true, backgroundConnection: true, nativeCallNotifications: true };
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android");
  expect(capabilities.backgroundConnection).toBe(true); expect(capabilities.nativeCallNotifications).toBe(true);
  expect(capabilities.nativePasskeys).toBe(true);
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { passkeyHandoff: true };
  expect(capabilities.backgroundConnection).toBe(false); expect(capabilities.nativeCallNotifications).toBe(false);
  window.__PRIVATEBASE_NATIVE_CAPABILITIES__ = { backgroundConnection: true, nativeCallNotifications: true };
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
  expect(capabilities.backgroundConnection).toBe(false); expect(capabilities.nativeCallNotifications).toBe(false);
  vi.unstubAllGlobals();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android");
  expect(capabilities.backgroundConnection).toBe(false); expect(capabilities.nativeCallNotifications).toBe(false);
  delete window.__PRIVATEBASE_NATIVE_CAPABILITIES__;
});
it("gates the service independently from native call notifications", async () => {
  vi.spyOn(capabilities, "backgroundConnection", "get").mockReturnValue(false);
  dispose = startBackgroundSession("alice", () => true);
  expect(await setStayConnected(true)).toBe(false);
  await adapter.configureBackground(false);
  expect(mocks.invoke).not.toHaveBeenCalled();
  await adapter.showIncomingCall({ callId: "call-1", callerName: "Alice", video: false });
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("show_incoming_call", { callId: "call-1", callerName: "Alice", video: false });
});
