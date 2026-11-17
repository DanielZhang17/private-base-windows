import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openFile, prepareFileOpen } from "./files.js";
const open = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:file"); static revokeObjectURL = vi.fn(); });
  vi.stubGlobal("open", open);
  open.mockReturnValue({ opener: window });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it.each(["image/png", "video/mp4"])("opens web %s from memory and revokes the URL after a delay", async (type) => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await openFile(new Blob(["private"], { type }), "a.file", type);
  expect(open).toHaveBeenCalledWith("blob:file", "_blank");
  expect(open.mock.results.at(-1)?.value.opener).toBeNull();
  expect(click).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:file");
});
it("downloads other web types and releases the temporary URL", async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await openFile(new Blob(["data"]), "archive.zip", "application/zip");
  expect(click).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
  vi.runAllTimers();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:file");
});
it("reports a blocked PDF tab reservation before loading the attachment", () => {
  open.mockReturnValueOnce(null);
  expect(() => prepareFileOpen("application/pdf")).toThrow("FILE_OPEN_BLOCKED");
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("reserves a tab synchronously and navigates it only when decrypted bytes are ready", () => {
  const tab = { closed: false, opener: window, location: { replace: vi.fn() }, close: vi.fn() };
  open.mockReturnValueOnce(tab);
  const reserved = prepareFileOpen("application/pdf")!;
  expect(open).toHaveBeenCalledWith("about:blank", "_blank");
  expect(tab.opener).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  reserved.open(new Blob(["private"]));
  expect(tab.location.replace).toHaveBeenCalledWith("blob:file");
  reserved.cancel(); expect(tab.close).toHaveBeenCalledOnce();
});

it.each(["image/svg+xml", "text/html", "application/xhtml+xml", "application/xml", "text/xml", "text/javascript", "application/javascript", "image/unknown", "video/unknown", "application/octet-stream"])("never opens active/unknown %s in the app origin", async (type) => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const blob = new Blob(['<svg><script>window.opener.localStorage.clear()</script></svg>'], { type });
  expect(prepareFileOpen(type)).toBeNull();
  await openFile(blob, "untrusted.pdf", type);
  expect(open).not.toHaveBeenCalled();
  expect(click).toHaveBeenCalledOnce();
  expect(URL.createObjectURL).toHaveBeenCalledExactlyOnceWith(blob);
  vi.runAllTimers();
});
it("sandboxes even active bytes mislabeled as an allowed media type", async () => {
  await openFile(new Blob(['<svg><script>alert(1)</script></svg>']), "untrusted.png", "image/png");
  vi.clearAllTimers();
  vi.useRealTimers();
  const [content, wrapper] = vi.mocked(URL.createObjectURL).mock.calls.map(([blob]) => blob as Blob);
  expect(content.type).toBe("image/png");
  const text = await new Promise<string>((resolve) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(wrapper);
  });
  const doc = new DOMParser().parseFromString(text, "text/html");
  expect(doc.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
  expect(doc.querySelector("script,svg")).toBeNull();
  expect(text).not.toContain("alert(1)");
});

it.each(["application/pdf", "APPLICATION/PDF; charset=utf-8"])("forces %s to a PDF blob and opens a noopener tab even if the blob contains HTML", async (declaredType) => {
  const blob = new Blob(['<!doctype html><script>window.opener.localStorage.clear()</script>'], { type: "text/html" });
  open.mockReturnValueOnce(null); // noopener legitimately returns null on success.
  await expect(openFile(blob, "untrusted.pdf", declaredType)).resolves.toBeUndefined();
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(vi.mocked(URL.createObjectURL).mock.calls[0][0]).toMatchObject({ type: "application/pdf" });
  expect(open).toHaveBeenCalledExactlyOnceWith("blob:file", "_blank", "noopener");
  expect(document.querySelector("iframe,script")).toBeNull();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000);
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:file");
});
