import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FilePreview from "./FilePreview.js";
import { getCachedFile, setCachedFile } from "../../db/index.js";
import { decryptFile } from "@e2ee-chat/crypto";
import { saveFile, SaveUnsupportedError } from "../../platform/files.js";
import { capabilities } from "../../platform/capabilities.js";

vi.mock("../../db/index.js", () => ({ getCachedFile: vi.fn(), setCachedFile: vi.fn(async () => {}) }));
vi.mock("../../stores/authStore.js", () => ({ useAuthStore: { getState: () => ({ accessToken: "token" }) } }));
vi.mock("../../services/api.js", () => ({ ApiError: class extends Error {}, api: { get: vi.fn() }, resolveApiUrl: (url: string) => url }));
vi.mock("../../lib/file-url-resolver.js", () => ({ fileUrlResolver: { resolve: async () => ({ downloadUrl: "/encrypted", expiresAt: Date.now() + 60000 }) } }));
vi.mock("@e2ee-chat/crypto", () => ({ decryptFile: vi.fn(async () => new Uint8Array([1, 2, 3])) }));
vi.mock("../../platform/files.js", async (original) => ({ ...await original<object>(), saveFile: vi.fn(async () => {}) }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:preview"); static revokeObjectURL = vi.fn(); });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([99]).buffer })));
  container = document.createElement("div"); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(mimeType = "application/pdf") {
  await act(async () => root.render(<FilePreview fileId="file" fileName="private.pdf" mimeType={mimeType} fileKey="key" fileIv="iv" sizeBytes={3} />));
}

it.each(["application/pdf", "image/png"])("saves cached decrypted %s bytes through the platform adapter", async (mimeType) => {
  const blob = new Blob(["private"], { type: mimeType });
  vi.mocked(getCachedFile).mockResolvedValue({ blob, expiresAt: Date.now() + 60000 } as never);
  await render(mimeType);
  await act(async () => { container.querySelector<HTMLElement>(mimeType === "image/png" ? "img" : "button")!.click(); });
  expect(saveFile).toHaveBeenCalledExactlyOnceWith(blob, "private.pdf");
  expect(fetch).not.toHaveBeenCalled();
  expect(decryptFile).not.toHaveBeenCalled();
});

it("saves freshly decrypted bytes with the original filename and MIME type", async () => {
  vi.mocked(getCachedFile).mockResolvedValue(undefined);
  await render();
  await act(async () => container.querySelector("button")!.click());
  expect(decryptFile).toHaveBeenCalledWith(new Uint8Array([99]), { key: "key", iv: "iv" });
  const blob = vi.mocked(setCachedFile).mock.calls[0][0].blob;
  expect(blob.type).toBe("application/pdf");
  expect(blob.size).toBe(3);
  expect(saveFile).toHaveBeenCalledExactlyOnceWith(blob, "private.pdf");
});

it("shows a save failure through the existing file error state", async () => {
  vi.mocked(getCachedFile).mockResolvedValue({ blob: new Blob(["private"]), expiresAt: Date.now() + 60000 } as never);
  vi.mocked(saveFile).mockRejectedValueOnce(new Error("Save denied"));
  await render();
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("Failed to load: private.pdf");
});

it("disables unsupported saving before loading a non-preview attachment", async () => {
  vi.spyOn(capabilities, "saveFile", "get").mockReturnValue(false);
  await render();
  const button = container.querySelector("button")!;
  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(saveFile).not.toHaveBeenCalled();
  expect(getCachedFile).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["image/png", "video/mp4"])("keeps %s previewing when saving is unsupported", async (mimeType) => {
  vi.spyOn(capabilities, "saveFile", "get").mockReturnValue(false);
  vi.mocked(getCachedFile).mockResolvedValue(undefined);
  await render(mimeType);
  const preview = container.querySelector<HTMLElement>(mimeType === "image/png" ? "img" : "video")!;
  expect(preview.getAttribute("src")).toBe("blob:preview");
  expect(decryptFile).toHaveBeenCalled();
  await act(async () => preview.click());
  expect(saveFile).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Failed to load");
});

it("keeps an image preview and disables later saves after a typed unsupported error", async () => {
  vi.mocked(getCachedFile).mockResolvedValue({ blob: new Blob(["image"]), expiresAt: Date.now() + 60000 } as never);
  vi.mocked(saveFile).mockRejectedValueOnce(new SaveUnsupportedError());
  await render("image/png");
  await act(async () => container.querySelector("img")!.click());
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:preview");
  expect(container.textContent).not.toContain("Failed to load");
  await act(async () => container.querySelector("img")!.click());
  expect(saveFile).toHaveBeenCalledTimes(1);
});
