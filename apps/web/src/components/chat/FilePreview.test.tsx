import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FilePreview from "./FilePreview.js";
import { getCachedFile, setCachedFile } from "../../db/index.js";
import { decryptFile } from "@e2ee-chat/crypto";
import { saveFile, SaveUnsupportedError } from "../../platform/files.js";
import { capabilities } from "../../platform/capabilities.js";
import { click, press, setupDom } from "../../ui/test-utils.js";

vi.mock("../../db/index.js", () => ({ getCachedFile: vi.fn(), setCachedFile: vi.fn() }));
vi.mock("../../stores/authStore.js", () => ({ useAuthStore: { getState: () => ({ accessToken: "token" }) } }));
vi.mock("../../services/api.js", () => ({ ApiError: class extends Error {}, api: { get: vi.fn() }, resolveApiUrl: (url: string) => url }));
vi.mock("../../lib/file-url-resolver.js", () => ({ fileUrlResolver: { resolve: async () => ({ downloadUrl: "/encrypted", expiresAt: Date.now() + 60000 }) } }));
vi.mock("@e2ee-chat/crypto", () => ({ decryptFile: vi.fn(async () => new Uint8Array([1, 2, 3])) }));
vi.mock("../../platform/files.js", async (original) => ({ ...await original<object>(), saveFile: vi.fn(async () => {}) }));

const dom = setupDom();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:preview"); static revokeObjectURL = vi.fn(); });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([99]).buffer })));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });
const render = (mimeType = "application/pdf", fileId = "file") => dom.render(<FilePreview fileId={fileId} fileName="private.pdf" mimeType={mimeType} fileKey="key" fileIv="iv" sizeBytes={3} />);
const download = () => dom.container().querySelector<HTMLButtonElement>('[aria-label="Download private.pdf"]')!;

it.each(["application/pdf", "image/png"])("saves decrypted %s through the adapter without persisting plaintext", async (mimeType) => {
  await render(mimeType);
  await click(download());
  expect(decryptFile).toHaveBeenCalledExactlyOnceWith(new Uint8Array([99]), { key: "key", iv: "iv" });
  const [blob, filename] = vi.mocked(saveFile).mock.calls[0];
  expect(blob.type).toBe(mimeType);
  expect(blob.size).toBe(3);
  expect(filename).toBe("private.pdf");
  expect(getCachedFile).not.toHaveBeenCalled();
  expect(setCachedFile).not.toHaveBeenCalled();
});

it("shows save failures through the existing error state", async () => {
  vi.mocked(saveFile).mockRejectedValueOnce(new Error("Save denied"));
  await render();
  await click(download());
  expect(dom.container().textContent).toContain("Failed to load: private.pdf");
});

it("disables unsupported saving before loading a non-preview attachment", async () => {
  vi.spyOn(capabilities, "saveFile", "get").mockReturnValue(false);
  await render();
  expect(download().disabled).toBe(true);
  await click(download());
  expect(saveFile).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["image/png", "video/mp4"])("opens %s without downloading even when saving is unsupported", async (mimeType) => {
  vi.spyOn(capabilities, "saveFile", "get").mockReturnValue(false);
  await render(mimeType);
  const preview = dom.container().querySelector<HTMLElement>(mimeType === "image/png" ? "img" : "video")!;
  expect(preview.getAttribute("src")).toBe("blob:preview");
  await click(preview.closest("button")!);
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector("img,video")!.getAttribute("src")).toBe("blob:preview");
  expect(dialog.querySelector('[aria-label="Download private.pdf"]')).toBeNull();
  expect(saveFile).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  await press("Escape");
});

it("keeps downloads available beside the preview and in the viewer", async () => {
  await render("image/png");
  await click(dom.container().querySelector("img")!);
  expect(saveFile).not.toHaveBeenCalled();
  await click(document.querySelector('[role="dialog"] [aria-label="Download private.pdf"]')!);
  expect(saveFile).toHaveBeenCalledTimes(1);
  await press("Escape");
  await click(download());
  expect(saveFile).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("hides later saves after a typed unsupported error without losing the preview", async () => {
  vi.mocked(saveFile).mockRejectedValueOnce(new SaveUnsupportedError());
  await render("image/png");
  await click(download());
  expect(dom.container().querySelector("img")?.getAttribute("src")).toBe("blob:preview");
  expect(dom.container().textContent).not.toContain("Failed to load");
  expect(download()).toBeNull();
  await click(dom.container().querySelector("img")!);
  expect(document.querySelector('[role="dialog"] [aria-label="Download private.pdf"]')).toBeNull();
});

it("revokes a URL only when its inline preview is replaced or unmounted", async () => {
  await render("image/png");
  await click(dom.container().querySelector("img")!);
  await press("Escape");
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  await render("image/png", "other");
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  await dom.render(null);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});

it("does not create a blob URL if decryption finishes after unmount", async () => {
  let finish!: (bytes: Uint8Array) => void;
  vi.mocked(decryptFile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render("image/png");
  await dom.render(null);
  await act(async () => finish(new Uint8Array([1, 2, 3])));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(setCachedFile).not.toHaveBeenCalled();
});
