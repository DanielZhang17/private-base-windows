import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAvatarUpload } from "./useAvatarUpload.js";
import { api } from "../../services/api.js";
vi.mock("../../services/api.js", () => ({ api: { post: vi.fn() }, resolveApiUrl: (path: string) => path }));
vi.mock("../../stores/authStore.js", () => ({ useAuthStore: { getState: () => ({ accessToken: "token" }) } }));
let root: Root;
let state: ReturnType<typeof useAvatarUpload>;
const change = vi.fn();
const input = { files: [{ type: "image/png", size: 1, arrayBuffer: async () => new ArrayBuffer(1) }], value: "file" };
function Probe() { state = useAvatarUpload(change); return null; }
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); root = createRoot(document.createElement("div")); });
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it("reports upload errors through hook state without native alerts", async () => {
  vi.mocked(api.post).mockRejectedValue(new Error("Upload unavailable"));
  await act(async () => root.render(<Probe />));
  await act(async () => { await state.handleFileUpload({ target: input } as never); });
  expect(state.notice).toBe("Failed to upload avatar\nUpload unavailable");
  expect(state.uploading).toBe(false);
  expect(change).not.toHaveBeenCalled();
});
it("does not update an avatar if an upload finishes after unmount", async () => {
  vi.mocked(api.post).mockResolvedValue({ uploadUrl: "/upload" } as never);
  let resolve!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise((r) => { resolve = r; })));
  await act(async () => root.render(<Probe />));
  let pending!: Promise<void>;
  await act(async () => { pending = state.handleFileUpload({ target: input } as never); });
  const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  resolve({ ok: true, json: async () => ({ avatarUrl: "r2://avatar" }) });
  await pending;
  expect(change).not.toHaveBeenCalled();
  root = createRoot(document.createElement("div"));
});
