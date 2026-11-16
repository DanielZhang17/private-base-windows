import { act } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setupDom } from "../../ui/test-utils.js";
vi.mock("../../services/web-push.js", () => ({ disableWebPush: vi.fn(async () => {}), storePushLocale: vi.fn(async () => {}) }));
vi.mock("../../services/api.js", () => ({ api: { get: vi.fn() } }));
vi.mock("../../lib/key-manager.js", () => ({ keysLoaded: vi.fn(() => true) }));
vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ accessToken: "token", sessionId: "session", user: { id: "bob" }, device: { id: "device" } })) };
});
import WebPushEffects from "./WebPushEffects.js";
import { disableWebPush, storePushLocale } from "../../services/web-push.js";
import { clearUnlockedSessionState } from "../../platform/session-cleanup.js";
import { useAuthStore } from "../../stores/authStore.js";
import { api } from "../../services/api.js";
import { keysLoaded } from "../../lib/key-manager.js";
const { render, container } = setupDom();
let worker: EventTarget;
function Probe({ unlocked }: { unlocked: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  return <><WebPushEffects unlocked={unlocked} /><output>{location.pathname}{location.search}</output>
    <button onClick={() => navigate("/settings")}>Settings</button></>;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(keysLoaded).mockReturnValue(true);
  worker = new EventTarget();
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
  useAuthStore.setState({ accessToken: "token", sessionId: "session", user: { id: "bob" }, device: { id: "device" } } as never);
  vi.mocked(api.get).mockResolvedValue({ conversationId: "conv" });
});
afterEach(() => { Reflect.deleteProperty(navigator, "serviceWorker"); });
it("keeps cold locked startup subscribed, but explicit lock tears it down", async () => {
  await render(<MemoryRouter><Probe unlocked={false} /></MemoryRouter>);
  clearUnlockedSessionState();
  expect(disableWebPush).not.toHaveBeenCalled();
  await render(<MemoryRouter><Probe unlocked /></MemoryRouter>);
  clearUnlockedSessionState();
  expect(disableWebPush).toHaveBeenCalledTimes(1);
  expect(storePushLocale).toHaveBeenCalledWith("en", "New message", "Incoming call");
});
it("uses the previous account token when signing out or switching accounts", async () => {
  await render(<MemoryRouter><Probe unlocked={false} /></MemoryRouter>);
  await act(async () => { useAuthStore.setState({ accessToken: "new-token", sessionId: "new-session" }); });
  expect(disableWebPush).toHaveBeenCalledWith("token", { accountTeardown: true, session: { userId: "bob", deviceId: "device", loginIdentity: "session:session" } });
});
it("drops a message URL seen while locked instead of retaining it through unlock", async () => {
  await render(<MemoryRouter initialEntries={["/?push=message"]}><Probe unlocked={false} /></MemoryRouter>);
  expect(api.get).not.toHaveBeenCalled();
  await render(<MemoryRouter initialEntries={["/?push=message"]}><Probe unlocked /></MemoryRouter>);
  expect(api.get).not.toHaveBeenCalled();
  expect(container().querySelector("output")!.textContent).toBe("/");
});
it("resolves a message URL once when already unlocked", async () => {
  await render(<MemoryRouter initialEntries={["/?push=message"]}><Probe unlocked /></MemoryRouter>);
  expect(api.get).toHaveBeenCalledExactlyOnceWith("/api/push/target");
  expect(container().querySelector("output")!.textContent).toBe("/chat/conv");
});
it.each(["/chat/conversation", "/call/call-1?push=call", "/?push=message"])("routes an unlocked push-open %s through the SPA", async (destination) => {
  await render(<MemoryRouter><Probe unlocked /></MemoryRouter>);
  await act(async () => { worker.dispatchEvent(new MessageEvent("message", { data: { type: "push-open", destination } })); });
  expect(container().querySelector("output")!.textContent).toBe(destination === "/?push=message" ? "/chat/conv" : destination);
});
it.each(["locked", "signed-out", "keys-locked"])("ignores push-open while %s without retaining a destination", async (state) => {
  if (state === "signed-out") useAuthStore.setState({ accessToken: null });
  if (state === "keys-locked") vi.mocked(keysLoaded).mockReturnValue(false);
  await render(<MemoryRouter><Probe unlocked={state !== "locked"} /></MemoryRouter>);
  await act(async () => { worker.dispatchEvent(new MessageEvent("message", { data: { type: "push-open", destination: "/call/ignored?push=call" } })); });
  await render(<MemoryRouter><Probe unlocked /></MemoryRouter>);
  expect(container().querySelector("output")!.textContent).toBe("/");
  expect(api.get).not.toHaveBeenCalled();
});
it.each(["https://evil.example.com/call/x", "//evil.example.com", "/settings", "/native/passkey/sign-in", "/call/../other", "/chat/x?next=other"])("rejects push-open destination %s", async (destination) => {
  await render(<MemoryRouter><Probe unlocked /></MemoryRouter>);
  await act(async () => { worker.dispatchEvent(new MessageEvent("message", { data: { type: "push-open", destination } })); });
  expect(container().querySelector("output")!.textContent).toBe("/");
});
it.each(["session", "lock"])("ignores a late message target after a %s change", async (change) => {
  let finish!: (value: unknown) => void;
  vi.mocked(api.get).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render(<MemoryRouter initialEntries={["/?push=message"]}><Probe unlocked /></MemoryRouter>);
  if (change === "session") await act(async () => { useAuthStore.setState({ sessionId: "different-login" }); });
  else {
    await render(<MemoryRouter><Probe unlocked={false} /></MemoryRouter>);
    await render(<MemoryRouter><Probe unlocked /></MemoryRouter>);
  }
  await act(async () => finish({ conversationId: "stale-conversation" }));
  expect(container().querySelector("output")!.textContent).toBe("/");
});
it.each(["call", "user-route"])("a newer %s supersedes a pending message lookup", async (newer) => {
  let finish!: (value: unknown) => void;
  vi.mocked(api.get).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render(<MemoryRouter><Probe unlocked /></MemoryRouter>);
  await act(async () => { worker.dispatchEvent(new MessageEvent("message", { data: { type: "push-open", destination: "/?push=message" } })); });
  expect(api.get).toHaveBeenCalledExactlyOnceWith("/api/push/target");
  await act(async () => {
    if (newer === "call") worker.dispatchEvent(new MessageEvent("message", { data: { type: "push-open", destination: "/call/new-call?push=call" } }));
    else container().querySelector<HTMLButtonElement>("button")!.click();
  });
  const expected = newer === "call" ? "/call/new-call?push=call" : "/settings";
  expect(container().querySelector("output")!.textContent).toBe(expected);
  await act(async () => finish({ conversationId: "stale-conversation" }));
  expect(container().querySelector("output")!.textContent).toBe(expected);
});
