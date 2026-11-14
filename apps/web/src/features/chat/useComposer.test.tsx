import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useComposer } from "./useComposer.js";
import { compressAttachment } from "./attachment-compression.js";
import { useUiPreferencesStore } from "../../stores/uiPreferencesStore.js";
import { getDefaultUiPreferences } from "../../lib/ui-preferences.js";
vi.mock("../../services/api.js", () => ({ api: { get: async () => [] } }));
vi.mock("../../stores/authStore.js", () => {
  const auth = { user: { id: "alice" }, sessionId: "session" };
  return { useAuthStore: Object.assign((selector: (state: typeof auth) => unknown) => selector(auth), { getState: () => auth }) };
});
vi.mock("./attachment-compression.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./attachment-compression.js")>(),
  compressAttachment: vi.fn(),
}));
let root: Root;
let dropArea: HTMLDivElement | null;
let result: ReturnType<typeof useComposer>;
const send = vi.fn(); const sendFile = vi.fn();
function Probe({ disabled = false }) {
  const dropTarget = useRef<HTMLDivElement>(null);
  result = useComposer({ onSend: send, onSendFile: sendFile, disabled, dropTarget });
  return <div ref={(node) => { dropTarget.current = dropArea = node; }}><textarea ref={result.inputRef} /></div>;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(compressAttachment).mockReset();
  useUiPreferencesStore.getState().clearPreferencesForUser("alice");
  root = createRoot(document.createElement("div"));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const render = async (disabled = false) => { await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><Probe disabled={disabled} /></QueryClientProvider>)); };
function drop(file: File) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
  dropArea!.querySelector("textarea")!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}
it("retains a picked file until Send and passes the selected timer to the queue callback", async () => {
  await render(); const file = new File(["private"], "route.pdf", { type: "application/pdf" });
  await act(async () => result.handleFileChange({ target: { files: [file], value: "" } } as never));
  expect(sendFile).not.toHaveBeenCalled(); expect(result.pendingFile).toBe(file);
  await act(async () => result.setTtlSeconds("300"));
  await act(async () => result.handleSubmit({ preventDefault() {} } as never));
  expect(sendFile).toHaveBeenCalledExactlyOnceWith(file, { ttlSeconds: 300 });
  expect(result.pendingFile).toBeNull();
});
it("does not send dropped files from a disabled composer", async () => {
  await render(true);
  await act(async () => drop(new File(["x"], "private.txt")));
  expect(result.pendingFile).toBeNull(); expect(sendFile).not.toHaveBeenCalled();
});
it("stages dropped media with the account default and sends only on submit", async () => {
  useUiPreferencesStore.getState().savePreferencesForUser("alice", { ...getDefaultUiPreferences("light"), compressAttachments: true });
  await render();
  const video = new File(["original video"], "holiday.mov", { type: "video/quicktime" });
  const encoded = new File(["video"], "holiday.mp4", { type: "video/mp4" });
  vi.mocked(compressAttachment).mockResolvedValue(encoded);
  await act(async () => drop(video));
  expect(result.pendingFile).toBe(video);
  expect(result.compress).toBe(true);
  expect(compressAttachment).not.toHaveBeenCalled();
  expect(sendFile).not.toHaveBeenCalled();
  await act(async () => result.handleSubmit({ preventDefault() {} } as never));
  expect(compressAttachment).toHaveBeenCalledExactlyOnceWith(video, expect.any(AbortSignal));
  expect(sendFile).toHaveBeenCalledExactlyOnceWith(encoded, { ttlSeconds: null });
  await act(async () => drop(video));
  await act(async () => result.setCompress(false));
  await act(async () => result.handleSubmit({ preventDefault() {} } as never));
  expect(sendFile).toHaveBeenLastCalledWith(video, { ttlSeconds: null });
});

it("keeps the attachment and message ready for an explicit retry when compression fails", async () => {
  await render();
  const image = new File(["image"], "photo.gif", { type: "image/gif" });
  vi.mocked(compressAttachment).mockRejectedValue(new Error("Unsupported"));
  await act(async () => { drop(image); result.setText("A caption"); result.setCompress(true); });
  await act(async () => result.handleSubmit({ preventDefault() {} } as never));
  expect(result.pendingFile).toBe(image);
  expect(result.text).toBe("A caption");
  expect(result.attachmentError).toBe("attachmentCompressionFailed");
  expect(sendFile).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it("aborts an in-flight attachment when the composer unmounts", async () => {
  await render();
  const image = new File(["image"], "photo.jpg", { type: "image/jpeg" });
  let finish!: (file: File) => void;
  vi.mocked(compressAttachment).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await act(async () => { drop(image); result.setCompress(true); });
  let submitting!: Promise<void>;
  await act(async () => { submitting = result.handleSubmit({ preventDefault() {} } as never); });
  const signal = vi.mocked(compressAttachment).mock.calls[0][1];
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  finish(image);
  await submitting;
  expect(sendFile).not.toHaveBeenCalled();
  root = createRoot(document.createElement("div"));
});
it("keeps Enter as a newline on a touch keyboard and while composing text", async () => {
  await render(); await act(async () => result.setText("Hello"));
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const preventDefault = vi.fn();
  await act(async () => result.handleKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault } as never));
  expect(send).not.toHaveBeenCalled(); expect(preventDefault).not.toHaveBeenCalled();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  await act(async () => result.handleKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: true }, preventDefault } as never));
  expect(send).not.toHaveBeenCalled();
});
