import { act, createRef, type Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SaveFeedbackToastProvider from "../app/SaveFeedbackToastProvider.js";
import IncomingCallModal from "../calls/IncomingCallModal.js";
import * as environment from "../../platform/environment.js";
import FilePreview, { type FilePreviewActions } from "./FilePreview.js";
import MediaViewer from "./MediaViewer.js";
import { getCachedFile, setCachedFile } from "../../db/index.js";
import { decryptFile } from "@e2ee-chat/crypto";
import { openFile, prepareFileOpen, saveFile, SaveUnsupportedError } from "../../platform/files.js";
import { capabilities } from "../../platform/capabilities.js";
import { captureSaveFeedback } from "../../features/chat/save-feedback.js";
import { IncomingCallContext } from "../../features/calls/IncomingCallContext.js";
import { setLocalePreference } from "../../i18n/index.js";
import { clearRegisteredLocalCallState, clearUnlockedSessionState } from "../../platform/session-cleanup.js";
import { useAuthStore } from "../../stores/authStore.js";
import { useCallStore } from "../../stores/callStore.js";
import { Dialog, Sheet } from "../../ui/index.js";
import { click, press, setupDom } from "../../ui/test-utils.js";

vi.mock("../../db/index.js", () => ({ getCachedFile: vi.fn(), setCachedFile: vi.fn() }));
vi.mock("../../stores/authStore.js", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ accessToken: "token", user: { id: "alice" }, device: { id: "device" }, sessionId: "session" })) };
});
vi.mock("../../services/api.js", () => ({ ApiError: class extends Error {}, api: { get: vi.fn() }, resolveApiUrl: (url: string) => url }));
vi.mock("../../lib/file-url-resolver.js", () => ({ fileUrlResolver: { resolve: async () => ({ downloadUrl: "/encrypted", expiresAt: Date.now() + 60000 }) } }));
vi.mock("@e2ee-chat/crypto", () => ({ decryptFile: vi.fn(async () => new Uint8Array([1, 2, 3])) }));
vi.mock("../../platform/files.js", async (original) => ({ ...await original<object>(), saveFile: vi.fn(async () => {}), openFile: vi.fn(async () => {}), prepareFileOpen: vi.fn(() => null) }));

const dom = setupDom();
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState(useAuthStore.getInitialState());
  vi.stubGlobal("Blob", class extends Blob {
    text(): Promise<string> {
      return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(this); });
    }
  });
  vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:preview"); static revokeObjectURL = vi.fn(); });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, headers: new Headers({ "content-type": "application/octet-stream" }), arrayBuffer: async () => new Uint8Array([99]).buffer })));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
});
afterEach(async () => {
  await act(async () => clearUnlockedSessionState());
  vi.restoreAllMocks();
});
const render = (mimeType = "application/pdf", fileId = "file", sizeBytes = 3, actionsRef?: Ref<FilePreviewActions>) => dom.render(<SaveFeedbackToastProvider><FilePreview fileId={fileId} fileName="private.pdf" mimeType={mimeType} fileKey="key" fileIv="iv" sizeBytes={sizeBytes} actionsRef={actionsRef} /></SaveFeedbackToastProvider>);
const download = () => dom.container().querySelector<HTMLButtonElement>('[aria-label="Save private.pdf"][title]')!;
const toastLayer = () => document.querySelector('[role="region"][aria-label="Notifications"]')!;
const successToast = () => toastLayer().querySelector('[data-toast-tone="success"]');
const errorToast = () => toastLayer().querySelector('[data-toast-tone="danger"]');
const viewerSaveNotice = (viewer: Element) => viewer.querySelector('.media-viewer-toolbar [role="group"]');
const liveRegion = (surface: Element, priority: "polite" | "assertive") => surface.querySelector(`[aria-live="${priority}"]`)!;

describe.each(["toast", "viewer"] as const)("save announcements in the %s", (surfaceType) => {
  it.each([
    { priority: "polite", text: "Saved private.pdf" },
    { priority: "assertive", text: "Failed to save file private.pdf" },
  ] as const)("updates the mounted $priority region on settlement", async ({ priority, text }) => {
    vi.spyOn(environment, "isNative").mockReturnValue(true);
    let finish!: () => void;
    vi.mocked(saveFile).mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = priority === "polite" ? () => resolve("saved") : () => reject(new Error("Save denied"));
    }));
    await render("image/png");
    if (surfaceType === "viewer") await click(dom.container().querySelector("img")!);
    const surface = surfaceType === "viewer" ? document.querySelector('[role="dialog"]')! : toastLayer();
    const polite = liveRegion(surface, "polite");
    const assertive = liveRegion(surface, "assertive");
    for (const region of [polite, assertive]) {
      expect(region.classList.contains("sr-only")).toBe(true);
      expect(region.textContent).toBe("");
    }
    await click(surfaceType === "viewer" ? surface.querySelector('[aria-label="Save private.pdf"]')! : download());
    expect(saveFile).toHaveBeenCalledOnce();
    expect(polite.textContent).toBe("");
    expect(assertive.textContent).toBe("");
    await act(async () => finish());
    expect(liveRegion(surface, "polite")).toBe(polite);
    expect(liveRegion(surface, "assertive")).toBe(assertive);
    expect(polite.textContent).toBe(priority === "polite" ? text : "");
    expect(assertive.textContent).toBe(priority === "assertive" ? text : "");
    expect(surface.querySelector('[role="status"], [role="alert"]')).toBeNull();
    if (surfaceType === "viewer") {
      const globalRegion = liveRegion(toastLayer(), priority);
      expect(globalRegion.textContent).toBe("");
      await click(surface.querySelector('[aria-label="Close"]')!);
      expect(priority === "polite" ? successToast() : errorToast()).not.toBeNull();
      expect(globalRegion.textContent).toBe("");
    }
  });
});

it("updates the same polite region for two identical save confirmations", async () => {
  vi.useFakeTimers();
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  vi.mocked(saveFile).mockResolvedValueOnce("saved").mockResolvedValueOnce("saved");
  await render();
  const polite = liveRegion(toastLayer(), "polite");
  await click(download());
  const first = polite.firstChild;
  expect(first?.textContent).toBe("Saved private.pdf");
  await click(download());
  expect(liveRegion(toastLayer(), "polite")).toBe(polite);
  expect(polite.firstChild).toBe(first);
  await act(async () => vi.advanceTimersByTime(4000));
  expect(polite.firstChild).not.toBe(first);
  expect(polite.textContent).toBe("Saved private.pdf");
});

it("holds queued results until the last non-media modal closes", async () => {
  vi.useFakeTimers();
  const renderModals = (dialogOpen: boolean, sheetOpen: boolean) => dom.render(<SaveFeedbackToastProvider>
    <Dialog open={dialogOpen} onClose={() => {}} title="Dialog" />
    <Sheet open={sheetOpen} onClose={() => {}} title="Sheet" />
  </SaveFeedbackToastProvider>);
  await renderModals(true, true);
  const feedback = captureSaveFeedback("private.pdf");
  await act(async () => {
    feedback.publish("success", "fileSaved");
    feedback.publish("danger", "failedToSaveFile");
  });
  const polite = liveRegion(toastLayer(), "polite");
  const assertive = liveRegion(toastLayer(), "assertive");
  expect(successToast()).toBeNull();
  expect(errorToast()).toBeNull();
  expect(polite.textContent).toBe("");
  expect(assertive.textContent).toBe("");
  await act(async () => vi.advanceTimersByTime(20000));
  await renderModals(true, false);
  expect(successToast()).toBeNull();
  expect(polite.textContent).toBe("");
  await renderModals(false, false);
  expect(successToast()?.textContent).toBe("Savedprivate.pdf");
  expect(polite.textContent).toBe("Saved private.pdf");
  await act(async () => vi.advanceTimersByTime(3999));
  expect(successToast()).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(1));
  expect(errorToast()?.textContent).toBe("Failed to save fileprivate.pdf");
  expect(assertive.textContent).toBe("Failed to save file private.pdf");
});

it("pauses a visible save notice while a non-media dialog is open", async () => {
  vi.useFakeTimers();
  const renderDialog = (open: boolean) => dom.render(<SaveFeedbackToastProvider>
    <Dialog open={open} onClose={() => {}} title="Dialog" />
  </SaveFeedbackToastProvider>);
  await renderDialog(false);
  await act(async () => captureSaveFeedback("private.pdf").publish("success", "fileSaved"));
  const polite = liveRegion(toastLayer(), "polite");
  const first = polite.firstChild;
  expect(first?.textContent).toBe("Saved private.pdf");
  await act(async () => vi.advanceTimersByTime(1000));
  await renderDialog(true);
  expect(successToast()).toBeNull();
  await act(async () => vi.advanceTimersByTime(10000));
  await renderDialog(false);
  expect(successToast()).not.toBeNull();
  expect(polite.firstChild).toBe(first);
  await act(async () => vi.advanceTimersByTime(2999));
  expect(successToast()).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(1));
  expect(successToast()).toBeNull();
});

it("shows save feedback in a viewer above a sheet and pauses it when the viewer closes", async () => {
  vi.useFakeTimers();
  const renderOverlays = (sheetOpen: boolean, viewerOpen: boolean) => dom.render(<SaveFeedbackToastProvider>
    <Sheet open={sheetOpen} onClose={() => {}} title="Sheet" />
    {viewerOpen && <MediaViewer objectUrl="blob:preview" fileName="private.pdf" isVideo={false} onClose={() => {}} />}
  </SaveFeedbackToastProvider>);
  await renderOverlays(true, false);
  await act(async () => captureSaveFeedback("private.pdf").publish("success", "fileSaved"));
  expect(successToast()).toBeNull();
  await renderOverlays(true, true);
  const viewer = document.querySelector(".media-viewer")!;
  expect(viewerSaveNotice(viewer)?.textContent).toBe("Savedprivate.pdf");
  expect(liveRegion(viewer, "polite").textContent).toBe("Saved private.pdf");
  expect(successToast()).toBeNull();
  await act(async () => vi.advanceTimersByTime(1000));
  await renderOverlays(true, false);
  await act(async () => vi.advanceTimersByTime(10000));
  expect(successToast()).toBeNull();
  await renderOverlays(false, false);
  expect(successToast()?.textContent).toBe("Savedprivate.pdf");
  expect(liveRegion(toastLayer(), "polite").textContent).toBe("");
  await act(async () => vi.advanceTimersByTime(2999));
  expect(successToast()).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(1));
  expect(successToast()).toBeNull();
});

it("holds and pauses save feedback while the incoming-call prompt is visible", async () => {
  vi.useFakeTimers();
  const owner = {
    respond: vi.fn(),
    loadingAction: null,
    error: null,
    pendingLocalAcceptance: null,
    finishNativeCaptureWait: vi.fn(),
  };
  const feedback = captureSaveFeedback("private.pdf");
  await dom.render(<SaveFeedbackToastProvider>
    <IncomingCallContext.Provider value={owner}><IncomingCallModal /></IncomingCallContext.Provider>
  </SaveFeedbackToastProvider>);
  await act(async () => feedback.publish("success", "fileSaved"));
  await act(async () => vi.advanceTimersByTime(1000));
  await act(async () => useCallStore.getState().setIncomingCall({
    callId: "call", conversationId: "chat", callType: "audio", initiatorId: "bob",
    callerUserId: "bob", callerName: "Bob", keyReady: true,
  }));
  try {
    expect(document.querySelector('[aria-label="Incoming call"]')).not.toBeNull();
    expect(successToast()).toBeNull();
    await act(async () => feedback.publish("danger", "failedToSaveFile"));
    await act(async () => vi.advanceTimersByTime(20000));
    expect(errorToast()).toBeNull();
    expect(liveRegion(toastLayer(), "assertive").textContent).toBe("");
  } finally {
    await act(async () => useCallStore.getState().clearCall("call"));
  }
  expect(successToast()?.textContent).toBe("Savedprivate.pdf");
  await act(async () => vi.advanceTimersByTime(2999));
  expect(successToast()).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(1));
  expect(errorToast()?.textContent).toBe("Failed to save fileprivate.pdf");
  expect(liveRegion(toastLayer(), "assertive").textContent).toBe("Failed to save file private.pdf");
});

it("keeps save feedback in the higher-layer viewer when an incoming call rings", async () => {
  vi.useFakeTimers();
  const owner = {
    respond: vi.fn(),
    loadingAction: null,
    error: null,
    pendingLocalAcceptance: null,
    finishNativeCaptureWait: vi.fn(),
  };
  await dom.render(<SaveFeedbackToastProvider>
    <MediaViewer objectUrl="blob:preview" fileName="private.pdf" isVideo={false} onClose={() => {}} />
    <IncomingCallContext.Provider value={owner}><IncomingCallModal /></IncomingCallContext.Provider>
  </SaveFeedbackToastProvider>);
  const viewer = document.querySelector(".media-viewer")!;
  await act(async () => useCallStore.getState().setIncomingCall({
    callId: "call", conversationId: "chat", callType: "audio", initiatorId: "bob",
    callerUserId: "bob", callerName: "Bob", keyReady: true,
  }));
  try {
    expect(document.querySelector('[aria-label="Incoming call"]')).not.toBeNull();
    await act(async () => captureSaveFeedback("private.pdf").publish("success", "fileSaved"));
    expect(viewerSaveNotice(viewer)?.textContent).toBe("Savedprivate.pdf");
    expect(liveRegion(viewer, "polite").textContent).toBe("Saved private.pdf");
    expect(successToast()).toBeNull();
    await act(async () => vi.advanceTimersByTime(4000));
    expect(viewerSaveNotice(viewer)).toBeNull();
  } finally {
    await act(async () => useCallStore.getState().clearCall("call"));
  }
});

it("announces globally if the viewer closes before the notice mounts", async () => {
  await render("image/png");
  await click(dom.container().querySelector("img")!);
  const viewer = document.querySelector('[role="dialog"]')!;
  const close = viewer.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
  await act(async () => {
    captureSaveFeedback("private.pdf").publish("success", "fileSaved");
    expect(viewerSaveNotice(viewer)).toBeNull();
    close.click();
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(successToast()?.textContent).toBe("Savedprivate.pdf");
  expect(liveRegion(toastLayer(), "polite").textContent).toBe("Saved private.pdf");
});

it("uses the language selected while a result waits in the queue", async () => {
  vi.useFakeTimers();
  await render();
  const layer = toastLayer();
  const feedback = captureSaveFeedback("private.pdf");
  await act(async () => {
    feedback.publish("success", "fileSaved");
    feedback.publish("danger", "failedToSaveFile");
  });
  expect(liveRegion(layer, "polite").textContent).toBe("Saved private.pdf");
  try {
    await act(async () => setLocalePreference("de"));
    await act(async () => vi.advanceTimersByTime(4000));
    const message = "Datei konnte nicht gespeichert werden";
    expect(layer.querySelector('[data-toast-tone="danger"] p')?.textContent).toBe(message);
    expect(liveRegion(layer, "assertive").textContent).toBe(`${message} private.pdf`);
  } finally {
    await act(async () => setLocalePreference("en"));
  }
});

it.each([
  { firstResult: "failure", delay: 1000 },
  { firstResult: "success", delay: 1000 },
  { firstResult: "failure", delay: 0 },
  { firstResult: "success", delay: 0 },
] as const)("keeps both save outcomes when $firstResult settles first and the gap is $delay ms", async ({ firstResult, delay }) => {
  vi.useFakeTimers();
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  let fail!: (error: Error) => void;
  let finish!: (result: "saved") => void;
  vi.mocked(saveFile)
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render("image/png");
  await click(download());
  await click(download());
  expect(saveFile).toHaveBeenCalledTimes(2);

  const failure = {
    settle: () => fail(new Error("Save denied")),
    toast: errorToast,
    announcement: liveRegion(toastLayer(), "assertive"),
    text: "Failed to save file private.pdf",
    duration: 8000,
  };
  const success = {
    settle: () => finish("saved"),
    toast: successToast,
    announcement: liveRegion(toastLayer(), "polite"),
    text: "Saved private.pdf",
    duration: 4000,
  };
  const [first, second] = firstResult === "failure" ? [failure, success] : [success, failure];
  if (delay) {
    await act(async () => first.settle());
    await act(async () => vi.advanceTimersByTime(delay));
    await act(async () => second.settle());
  } else {
    await act(async () => {
      first.settle();
      second.settle();
    });
  }

  const firstMessage = first.announcement.firstChild;
  expect(firstMessage?.textContent).toBe(first.text);
  expect(first.toast()).not.toBeNull();
  expect(second.toast()).toBeNull();
  expect(second.announcement.textContent).toBe("");
  await act(async () => vi.advanceTimersByTime(first.duration - delay - 1));
  expect(first.announcement.firstChild).toBe(firstMessage);
  expect(first.toast()).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(1));
  expect(first.toast()).toBeNull();
  expect(first.announcement.textContent).toBe("");
  expect(second.toast()).not.toBeNull();
  expect(second.announcement.textContent).toBe(second.text);
  await act(async () => vi.advanceTimersByTime(second.duration - 1));
  expect(second.toast()).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(1));
  expect(second.toast()).toBeNull();
  expect(second.announcement.textContent).toBe("");
});

it.each(["application/pdf", "image/png", "video/mp4", "application/x-apple-diskimage"])("saves decrypted %s with the payload type despite the server's octet-stream type", async (mimeType) => {
  await render(mimeType);
  await click(download());
  expect(decryptFile).toHaveBeenCalledExactlyOnceWith(new Uint8Array([99]), { key: "key", iv: "iv" });
  const [blob, filename] = vi.mocked(saveFile).mock.calls[0];
  expect(blob.type).toBe(mimeType);
  expect(blob.size).toBe(3);
  expect(filename).toBe("private.pdf");
  expect(getCachedFile).not.toHaveBeenCalled();
  expect(setCachedFile).not.toHaveBeenCalled();
  expect(successToast()).toBeNull();
});

describe.each([
  { mode: "downloads", title: null },
  { mode: "dialog", title: "Saved" },
  { mode: "share", title: null },
  { mode: undefined, title: "Saved" },
] as const)("native attachment save ($mode, $title)", ({ mode, title }) => {
  const actionsRef = createRef<FilePreviewActions>();
  beforeEach(() => {
    vi.spyOn(environment, "isNative").mockReturnValue(true);
    vi.spyOn(capabilities, "fileSave", "get").mockReturnValue(mode);
  });

  it("shows success after settlement only for web-managed confirmation", async () => {
    let finish!: (result: "saved") => void;
    vi.mocked(saveFile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render("application/pdf", "file", 3, actionsRef);
    await act(async () => actionsRef.current!.save());
    expect(saveFile).toHaveBeenCalledOnce();
    expect(successToast()).toBeNull();
    await act(async () => finish("saved"));
    if (title) {
      const toast = successToast()!;
      expect(toast.querySelector("p")?.textContent).toBe(title);
      expect(toast.querySelector("p + div")?.textContent).toBe("private.pdf");
      expect(toast.querySelector("p + div > span")?.classList.contains("line-clamp-2")).toBe(true);
    } else {
      expect(successToast()).toBeNull();
      expect(liveRegion(toastLayer(), "polite").textContent).toBe("");
    }
    expect(errorToast()).toBeNull();
  });

  it("stays silent on cancellation", async () => {
    vi.mocked(saveFile).mockResolvedValueOnce("cancelled");
    await render("application/pdf", "file", 3, actionsRef);
    await act(async () => actionsRef.current!.save());
    expect(saveFile).toHaveBeenCalledOnce();
    expect(successToast()).toBeNull();
    expect(errorToast()).toBeNull();
  });

  it("shows only a localized error on failure", async () => {
    vi.mocked(saveFile).mockRejectedValueOnce(new Error("Write failed at /private/path"));
    await render("application/pdf", "file", 3, actionsRef);
    await act(async () => actionsRef.current!.save());
    expect(errorToast()?.textContent).toBe("Failed to save fileprivate.pdf");
    expect(successToast()).toBeNull();
  });
});

it.each(["profile pending", "profile repaired", "session replaced"] as const)("checks save scope during session repair (%s)", async (state) => {
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  vi.spyOn(capabilities, "fileSave", "get").mockReturnValue("dialog");
  useAuthStore.setState({ user: null, sessionId: null });
  let finish!: (bytes: Uint8Array) => void;
  vi.mocked(decryptFile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  if (state !== "session replaced") vi.mocked(saveFile).mockResolvedValueOnce("saved");
  await render();
  await click(download());
  expect(decryptFile).toHaveBeenCalledOnce();
  await act(async () => {
    if (state === "profile repaired") useAuthStore.setState({ user: useAuthStore.getInitialState().user });
    if (state === "session replaced") useAuthStore.setState({ sessionId: "another-session" });
    finish(new Uint8Array([1, 2, 3]));
  });
  if (state === "session replaced") {
    expect(saveFile).not.toHaveBeenCalled();
    expect(successToast()).toBeNull();
  } else {
    expect(saveFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ size: 3 }), "private.pdf");
    expect(successToast()?.textContent).toBe("Saved");
  }
});

it.each([
  ["lock", clearRegisteredLocalCallState],
  ["unlocked session teardown", clearUnlockedSessionState],
  ["session replacement", () => useAuthStore.setState({ sessionId: "new-session" })],
] as const)("clears the attachment-name toast on %s even after the bubble unmounts", async (_reason, endSession) => {
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  vi.mocked(saveFile).mockResolvedValueOnce("saved");
  await render();
  await click(download());
  await dom.render(<SaveFeedbackToastProvider>{null}</SaveFeedbackToastProvider>);
  expect(successToast()?.textContent).toContain("private.pdf");
  await act(async () => endSession());
  expect(successToast()).toBeNull();
});

it("shows confirmation after the attachment unmounts on a chat switch during save", async () => {
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  let finish!: (result: "saved") => void;
  vi.mocked(saveFile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render();
  await click(download());
  expect(saveFile).toHaveBeenCalledOnce();
  await dom.render(<SaveFeedbackToastProvider><p>Another chat</p></SaveFeedbackToastProvider>);
  expect(download()).toBeNull();
  await act(async () => finish("saved"));
  expect(successToast()?.textContent).toBe("Savedprivate.pdf");
});

it("does not start a native save if the attachment unmounts during decryption", async () => {
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  let finish!: (bytes: Uint8Array) => void;
  vi.mocked(decryptFile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render();
  await click(download());
  expect(decryptFile).toHaveBeenCalledOnce();
  await dom.render(<SaveFeedbackToastProvider><p>Another chat</p></SaveFeedbackToastProvider>);
  await act(async () => finish(new Uint8Array([1, 2, 3])));
  expect(saveFile).not.toHaveBeenCalled();
  expect(successToast()).toBeNull();
});

it("moves a live save notice to another attachment's viewer and back without restarting its expiry", async () => {
  vi.useFakeTimers();
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  vi.mocked(saveFile).mockResolvedValueOnce("saved");
  await render();
  await click(download());
  expect(successToast()?.textContent).toBe("Savedprivate.pdf");
  const announcement = liveRegion(toastLayer(), "polite").firstChild;
  expect(announcement?.textContent).toBe("Saved private.pdf");
  await act(async () => vi.advanceTimersByTime(2000));
  await dom.render(<SaveFeedbackToastProvider>
    <FilePreview key="other" fileId="other" fileName="other.png" mimeType="image/png" fileKey="key" fileIv="iv" sizeBytes={3} />
  </SaveFeedbackToastProvider>);
  await click(dom.container().querySelector("img")!);
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector("h2")?.textContent).toContain("other.png");
  expect(viewerSaveNotice(dialog)?.textContent).toBe("Savedprivate.pdf");
  expect(liveRegion(dialog, "polite").textContent).toBe("");
  expect(successToast()).toBeNull();
  await click(dialog.querySelector('[aria-label="Close"]')!);
  expect(successToast()?.textContent).toBe("Savedprivate.pdf");
  expect(liveRegion(toastLayer(), "polite").firstChild).toBe(announcement);
  await act(async () => vi.advanceTimersByTime(1999));
  expect(successToast()).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(1));
  expect(successToast()).toBeNull();
  expect(liveRegion(toastLayer(), "polite").textContent).toBe("");
});

it.each([
  ["lock", clearRegisteredLocalCallState],
  ["session replacement", () => useAuthStore.setState({ sessionId: "new-session" })],
] as const)("suppresses pending native save feedback after %s", async (_reason, endSession) => {
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  let finish!: (result: "saved") => void;
  vi.mocked(saveFile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render();
  await click(download());
  expect(saveFile).toHaveBeenCalledOnce();
  await act(async () => endSession());
  await act(async () => finish("saved"));
  expect(successToast()).toBeNull();
  expect(errorToast()).toBeNull();
});

it("shows web save failures through the existing error state", async () => {
  vi.mocked(saveFile).mockRejectedValueOnce(new Error("Save denied"));
  await render();
  await click(download());
  expect(errorToast()?.textContent).toContain("Failed to save file");
});

it("shows a native save preparation failure once in the attachment row", async () => {
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  vi.spyOn(capabilities, "fileSave", "get").mockReturnValue("downloads");
  vi.mocked(decryptFile).mockRejectedValueOnce(new Error("Decryption failed"));
  await render();
  await click(download());
  expect(saveFile).not.toHaveBeenCalled();
  expect(errorToast()).toBeNull();
  expect(liveRegion(toastLayer(), "assertive").textContent).toBe("");
  expect(dom.container().querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(dom.container().querySelector('[role="alert"]')?.textContent).toContain("private.pdf");
  expect(dom.container().querySelector("button")?.textContent).toBe("Retry");
});

it("disables unsupported saving before loading a non-preview attachment", async () => {
  vi.spyOn(capabilities, "saveFile", "get").mockReturnValue(false);
  await render();
  expect(download()).toBeNull();
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
  expect(dialog.querySelector('[aria-label="Save private.pdf"]')).toBeNull();
  expect(saveFile).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  await press("Escape");
});

it("shows desktop save feedback below the media toolbar and clears it on lock", async () => {
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  vi.spyOn(capabilities, "fileSave", "get").mockReturnValue("dialog");
  vi.mocked(saveFile).mockResolvedValueOnce("saved").mockResolvedValueOnce("saved");
  await render("image/png");
  await click(download());
  expect(successToast()?.textContent).toBe("Savedprivate.pdf");
  await click(dom.container().querySelector("img")!);
  const dialog = document.querySelector('[role="dialog"]')!;
  const toolbar = dialog.querySelector(".media-viewer-toolbar")!;
  await click(toolbar.querySelector('[aria-label="Save private.pdf"]')!);
  expect(saveFile).toHaveBeenCalledTimes(2);
  expect(successToast()).toBeNull();
  expect(toolbar.querySelector(".absolute.top-full.pointer-events-none [role=group]")?.textContent).toBe("Savedprivate.pdf");
  await act(async () => clearRegisteredLocalCallState());
  expect(viewerSaveNotice(dialog)).toBeNull();
  expect(liveRegion(dialog, "polite").textContent).toBe("");
  expect(successToast()).toBeNull();
  await click(toolbar.querySelector('[aria-label="Close"]')!);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("keeps the media viewer toolbar usable after a save failure", async () => {
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  vi.spyOn(capabilities, "fileSave", "get").mockReturnValue("downloads");
  vi.mocked(saveFile).mockRejectedValueOnce(new Error("Save denied")).mockResolvedValueOnce("cancelled");
  await render("image/png");
  await click(dom.container().querySelector("img")!);
  const toolbar = document.querySelector(".media-viewer-toolbar")!;
  const stage = document.querySelector(".media-viewer-stage")!;
  const zoom = document.querySelector(".media-viewer-zoom")!;
  await click(zoom);
  expect(zoom.textContent).toBe("250%");
  const viewerSave = toolbar.querySelector('[aria-label="Save private.pdf"]')!;
  await click(viewerSave);
  const notice = toolbar.querySelector('[role="group"]')!;
  expect(notice.textContent).toBe("Failed to save fileprivate.pdf");
  expect(document.querySelector(".media-viewer-stage")).toBe(stage);
  expect(zoom.textContent).toBe("250%");
  expect(errorToast()).toBeNull();
  await click(notice.querySelector('[aria-label="Dismiss"]')!);
  expect(toolbar.querySelector('[role="group"]')).toBeNull();
  expect(zoom.textContent).toBe("250%");
  await click(viewerSave);
  expect(saveFile).toHaveBeenCalledTimes(2);
  await click(toolbar.querySelector('[aria-label="Close"]')!);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(errorToast()).toBeNull();
});

it.each(["Dismiss", "Save private.pdf"])("handles viewer notice expiry with focus on %s", async (focusLabel) => {
  vi.useFakeTimers();
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  vi.mocked(saveFile).mockResolvedValueOnce("saved");
  await render("image/png");
  await click(dom.container().querySelector("img")!);
  const dialog = document.querySelector('[role="dialog"]')!;
  const save = dialog.querySelector('[aria-label="Save private.pdf"]')!;
  await click(save);
  const focusedButton = dialog.querySelector<HTMLButtonElement>(`[aria-label="${focusLabel}"]`)!;
  focusedButton.focus();
  expect(document.activeElement).toBe(focusedButton);
  await act(async () => vi.advanceTimersByTime(4000));
  expect(viewerSaveNotice(dialog)).toBeNull();
  const expectedFocus = focusLabel === "Dismiss" ? dialog.querySelector('[aria-label="Close"]') : focusedButton;
  expect(document.activeElement).toBe(expectedFocus);
});

it.each([true, false])("restores focus after a global save toast expires (opener mounted=%s)", async (keepOpener) => {
  vi.useFakeTimers();
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  vi.mocked(saveFile).mockResolvedValueOnce("saved");
  const renderChat = (showAttachment: boolean) => dom.render(<SaveFeedbackToastProvider><main>
    {showAttachment && <FilePreview fileId="file" fileName="private.pdf" mimeType="image/png" fileKey="key" fileIv="iv" sizeBytes={3} />}
  </main></SaveFeedbackToastProvider>);
  await renderChat(true);
  const opener = download();
  opener.focus();
  await click(opener);
  const dismiss = successToast()!.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!;
  dismiss.focus();
  expect(document.activeElement).toBe(dismiss);
  if (!keepOpener) await renderChat(false);
  await act(async () => vi.advanceTimersByTime(4000));
  expect(successToast()).toBeNull();
  expect(document.activeElement).toBe(keepOpener ? opener : dom.container().querySelector("main"));
});

it("shows a toast when a viewer save fails after the viewer closes", async () => {
  vi.useFakeTimers();
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  let fail!: (reason: Error) => void;
  vi.mocked(saveFile).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  await render("image/png");
  await click(dom.container().querySelector("img")!);
  const toolbar = document.querySelector(".media-viewer-toolbar")!;
  await click(toolbar.querySelector('[aria-label="Save private.pdf"]')!);
  expect(saveFile).toHaveBeenCalledOnce();
  await click(toolbar.querySelector('[aria-label="Close"]')!);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => fail(new Error("Save denied")));
  expect(errorToast()?.textContent).toBe("Failed to save fileprivate.pdf");
  await act(async () => vi.advanceTimersByTime(7999));
  expect(errorToast()).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(1));
  expect(errorToast()).toBeNull();
});

it("shows viewer feedback when the viewer opens while an inline save is pending", async () => {
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  let finish!: (result: "saved") => void;
  vi.mocked(saveFile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render("image/png");
  await click(download());
  expect(saveFile).toHaveBeenCalledOnce();
  await click(dom.container().querySelector("img")!);
  await act(async () => finish("saved"));
  expect(viewerSaveNotice(document.querySelector('[role="dialog"]')!)?.textContent).toBe("Savedprivate.pdf");
  expect(successToast()).toBeNull();
});

it("hides later saves after a typed unsupported error without losing the preview", async () => {
  vi.mocked(saveFile).mockRejectedValueOnce(new SaveUnsupportedError());
  await render("image/png");
  await click(download());
  expect(dom.container().querySelector("img")?.getAttribute("src")).toBe("blob:preview");
  expect(dom.container().textContent).not.toContain("Failed to load");
  expect(download()).toBeNull();
  await click(dom.container().querySelector("img")!);
  expect(document.querySelector('[role="dialog"] [aria-label="Save private.pdf"]')).toBeNull();
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

const newMediaTypes = ["image/avif", "image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence", "video/quicktime"];
it.each(newMediaTypes)("previews and opens decrypted %s when the platform can decode it", async (mimeType) => {
  await render(mimeType);
  expect(vi.mocked(URL.createObjectURL).mock.calls[0][0]).toMatchObject({ type: mimeType });
  const preview = dom.container().querySelector("img,video")!;
  expect(preview.tagName).toBe(mimeType.startsWith("image/") ? "IMG" : "VIDEO");
  await click(preview.closest("button")!);
  expect(document.querySelector('[role="dialog"] img,[role="dialog"] video')?.getAttribute("src")).toBe("blob:preview");
  await press("Escape");
});

it.each(newMediaTypes.flatMap((mimeType) => ["inline", "viewer"].map((surface) => ({ mimeType, surface }))))("falls back from $surface decode errors for $mimeType to the downloadable file card", async ({ mimeType, surface }) => {
  await render(mimeType);
  const preview = dom.container().querySelector("img,video")!;
  if (surface === "viewer") await click(preview.closest("button")!);
  const failed = surface === "viewer" ? document.querySelector('[role="dialog"] img,[role="dialog"] video')! : preview;
  await act(async () => { failed.dispatchEvent(new Event("error")); });
  expect(dom.container().querySelector("img,video")).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(dom.container().textContent).toContain("private.pdf");
  expect(dom.container().textContent).toContain("3 B");
  expect(download()).not.toBeNull();
  await click(download());
  expect(saveFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: mimeType, size: 3 }), "private.pdf");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("uses the file card immediately when canPlayType reports unsupported QuickTime", async () => {
  vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("");
  await render("video/quicktime");
  expect(HTMLMediaElement.prototype.canPlayType).toHaveBeenCalledWith("video/quicktime");
  expect(dom.container().querySelector("video")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  await click(download());
  expect(saveFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "video/quicktime" }), "private.pdf");
});

it("allows previews again when an unsupported attachment is replaced", async () => {
  await render("image/heic");
  await act(async () => { dom.container().querySelector("img")!.dispatchEvent(new Event("error")); });
  await render("image/avif", "other");
  expect(dom.container().querySelector("img")?.getAttribute("src")).toBe("blob:preview");
});

it("tapping a PDF opens through the platform adapter without an iframe or decrypted cache", async () => {
  await render();
  await click(dom.container().querySelector('[aria-label="Open private.pdf"]')!);
  expect(document.querySelector("iframe")).toBeNull();
  expect(openFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "application/pdf", size: 3 }), "private.pdf", "application/pdf");
  expect(saveFile).not.toHaveBeenCalled();
  expect(setCachedFile).not.toHaveBeenCalled();
});
it.each(["unsupported", "no_app", "cancelled"])("shows native Open failure %s as a toast", async (code) => {
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  vi.spyOn(capabilities, "fileOpen", "get").mockReturnValue(true);
  vi.mocked(openFile).mockRejectedValueOnce(code);
  await render();
  await click(dom.container().querySelector('[aria-label="Open private.pdf"]')!);
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  expect(dom.container().querySelector('[aria-label="Open private.pdf"]')).not.toBeNull();
});

it.each([
  ["saved", "Savedprivate.pdf"],
  ["cancelled", undefined],
] as const)("reports legacy desktop Open fallback result %s like Save", async (result, text) => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows NT 10.0");
  vi.mocked(saveFile).mockResolvedValueOnce(result);
  await render();
  await click(dom.container().querySelector('[aria-label="Open private.pdf"]')!);
  expect(saveFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "application/pdf" }), "private.pdf");
  expect(openFile).not.toHaveBeenCalled();
  expect(successToast()?.textContent).toBe(text);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("reserves a web tab during the tap before asynchronous attachment decryption", async () => {
  const open = vi.fn(); const cancel = vi.fn();
  vi.mocked(prepareFileOpen).mockReturnValueOnce({ open, cancel });
  vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("");
  await render("video/quicktime");
  await click(dom.container().querySelector('[aria-label="Open private.pdf"]')!);
  expect(prepareFileOpen).toHaveBeenCalledWith("video/quicktime");
  expect(vi.mocked(prepareFileOpen).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fetch).mock.invocationCallOrder[0]);
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ type: "video/quicktime", size: 3 }));
  expect(openFile).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
});

it("closes a reserved tab if decryption completes after the preview unmounts", async () => {
  const open = vi.fn(); const cancel = vi.fn();
  vi.mocked(prepareFileOpen).mockReturnValueOnce({ open, cancel });
  let finish!: (bytes: Uint8Array) => void;
  vi.mocked(decryptFile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("");
  await render("video/quicktime");
  await click(dom.container().querySelector('[aria-label="Open private.pdf"]')!);
  await dom.render(null);
  await act(async () => finish(new Uint8Array([1])));
  expect(cancel).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
});

it.each(["text/plain", "text/markdown", "text/csv"])("renders %s literally through textContent in the app viewer", async (type) => {
  const content = '<script>alert("untrusted")</script><img src=x onerror=alert(1)> # heading';
  vi.mocked(decryptFile).mockResolvedValueOnce(new TextEncoder().encode(content));
  const readText = Blob.prototype.text;
  let reading!: Promise<string>;
  vi.spyOn(Blob.prototype, "text").mockImplementation(function (this: Blob) { reading = readText.call(this); return reading; });
  const open = vi.spyOn(window, "open");
  const alert = vi.spyOn(window, "alert");
  await render(type);
  await click(dom.container().querySelector('[aria-label="Open private.pdf"]')!);
  await act(async () => { await reading; });
  expect(document.querySelector("pre")?.textContent).toBe(content);
  expect(document.querySelector("script,img,iframe")).toBeNull();
  expect(open).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
  expect(openFile).not.toHaveBeenCalled();
  expect(prepareFileOpen).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  await press("Escape");
  expect(document.querySelector("pre")).toBeNull();
});
it.each(["declared", "actual"])("caps the %s text size at 2 MiB and offers Download", async (sizeSource) => {
  const size = 2 * 1024 * 1024 + 1;
  const read = vi.spyOn(Blob.prototype, "text");
  if (sizeSource === "actual") vi.mocked(decryptFile).mockResolvedValueOnce(new Uint8Array(size));
  await render("text/plain", "file", sizeSource === "declared" ? size : 3);
  await click(dom.container().querySelector('[aria-label="Open private.pdf"]')!);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("This text file is too large to preview");
  expect(document.querySelector("pre")).toBeNull();
  expect(read).not.toHaveBeenCalled();
  if (sizeSource === "declared") expect(fetch).not.toHaveBeenCalled();
  const download = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Save file")!;
  await click(download);
  expect(saveFile).toHaveBeenCalledTimes(1);
});
it.each(["image/svg+xml", "text/html", "application/xml"])("downloads active %s without previewing or navigating it", async (type) => {
  vi.useFakeTimers();
  vi.mocked(decryptFile).mockResolvedValueOnce(new TextEncoder().encode('<svg><script>alert(1)</script></svg>'));
  const open = vi.spyOn(window, "open");
  await render(type);
  expect(dom.container().querySelector("img,video,iframe")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  await click(dom.container().querySelector('[aria-label="Save private.pdf"]:not([title])')!);
  const warning = document.querySelector('[role="alert"]')!;
  expect(warning.textContent).toContain("For your safety");
  expect(fetch).not.toHaveBeenCalled();
  expect(saveFile).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(4999));
  expect(document.querySelector('[role="alert"]')).toBe(warning);
  const save = [...warning.querySelectorAll("button")].find((button) => button.textContent === "Save file")!;
  await click(save);
  expect(saveFile).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
  expect(openFile).not.toHaveBeenCalled();
  expect(prepareFileOpen).not.toHaveBeenCalled();
  expect(document.querySelector("img,video,iframe")).toBeNull();
  expect(successToast()).toBeNull();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("offers Save in the warning toast when native Open is blocked", async () => {
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  vi.spyOn(capabilities, "fileOpen", "get").mockReturnValue(true);
  vi.spyOn(capabilities, "fileSave", "get").mockReturnValue("dialog");
  vi.mocked(openFile).mockRejectedValueOnce("blocked");
  vi.mocked(saveFile).mockResolvedValueOnce("saved");
  await render();
  await click(dom.container().querySelector('[aria-label="Open private.pdf"]')!);
  const warning = document.querySelector('[role="alert"]')!;
  expect(warning.textContent).toContain("For your safety, Private Base doesn't open this type of file. Save it only if you trust the sender.");
  const save = [...warning.querySelectorAll("button")].find((button) => button.textContent === "Save file")!;
  expect(save).not.toBeUndefined();
  await click(save);
  expect(saveFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "application/pdf", size: 3 }), "private.pdf");
  expect(openFile).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(successToast()?.textContent).toBe("Savedprivate.pdf");
  expect(liveRegion(toastLayer(), "polite").textContent).toBe("Saved private.pdf");
});

it("does not let the safety toast save an attachment after its preview is removed", async () => {
  vi.spyOn(environment, "isNative").mockReturnValue(true);
  vi.spyOn(capabilities, "fileOpen", "get").mockReturnValue(true);
  vi.mocked(openFile).mockRejectedValueOnce("blocked");
  await render();
  await click(dom.container().querySelector('[aria-label="Open private.pdf"]')!);
  await dom.render(<SaveFeedbackToastProvider>{null}</SaveFeedbackToastProvider>);
  const warning = document.querySelector('[role="alert"]')!;
  await click([...warning.querySelectorAll("button")].find((button) => button.textContent === "Save file")!);
  expect(saveFile).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("opens HTML bytes declared as PDF only in a forced-PDF tab, never an iframe", async () => {
  vi.useFakeTimers();
  const actual = await vi.importActual<typeof import("../../platform/files.js")>("../../platform/files.js");
  vi.mocked(prepareFileOpen).mockImplementationOnce(actual.prepareFileOpen);
  vi.mocked(decryptFile).mockResolvedValueOnce(new TextEncoder().encode('<html><script>window.opener.localStorage.clear()</script></html>'));
  const tab = { closed: false, opener: window, location: { replace: vi.fn() }, close: vi.fn() };
  const open = vi.spyOn(window, "open").mockReturnValue(tab as never);
  await render();
  await click(dom.container().querySelector('[aria-label="Open private.pdf"]')!);
  expect(open).toHaveBeenCalledWith("about:blank", "_blank");
  expect(tab.opener).toBeNull();
  expect(tab.location.replace).toHaveBeenCalledWith("blob:preview");
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(vi.mocked(URL.createObjectURL).mock.calls[0][0]).toMatchObject({ type: "application/pdf" });
  expect(document.querySelector("iframe,script")).toBeNull();
  await act(async () => vi.runOnlyPendingTimers());
});

it("reserves every PDF tab synchronously, including repeated opens of a cached decrypted PDF", async () => {
  vi.useFakeTimers();
  const actual = await vi.importActual<typeof import("../../platform/files.js")>("../../platform/files.js");
  vi.mocked(prepareFileOpen).mockImplementationOnce(actual.prepareFileOpen).mockImplementationOnce(actual.prepareFileOpen);
  const tab = () => ({ closed: false, opener: window, location: { replace: vi.fn() }, close: vi.fn() });
  const first = tab(), second = tab();
  const open = vi.spyOn(window, "open").mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
  let finish!: (bytes: Uint8Array) => void;
  vi.mocked(decryptFile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render();
  await click(dom.container().querySelector('[aria-label="Open private.pdf"]')!);
  expect(open).toHaveBeenCalledTimes(1);
  expect(first.opener).toBeNull();
  expect(first.location.replace).not.toHaveBeenCalled();
  await act(async () => finish(new Uint8Array([37, 80, 68, 70])));
  expect(first.location.replace).toHaveBeenCalledWith("blob:preview");
  await click(dom.container().querySelector('[aria-label="Open private.pdf"]')!);
  expect(open).toHaveBeenCalledTimes(2);
  expect(second.opener).toBeNull();
  expect(second.location.replace).toHaveBeenCalledWith("blob:preview");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(decryptFile).toHaveBeenCalledTimes(1);
  expect(openFile).not.toHaveBeenCalled();
  for (const [blob] of vi.mocked(URL.createObjectURL).mock.calls) expect((blob as Blob).type).toBe("application/pdf");
  await act(async () => vi.runOnlyPendingTimers());
});
it("reports a blocked cached-PDF tab instead of silently treating noopener's null as success", async () => {
  vi.useFakeTimers();
  const actual = await vi.importActual<typeof import("../../platform/files.js")>("../../platform/files.js");
  vi.mocked(prepareFileOpen).mockImplementationOnce(actual.prepareFileOpen).mockImplementationOnce(actual.prepareFileOpen);
  const tab = { closed: false, opener: window, location: { replace: vi.fn() }, close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValueOnce(tab as never).mockReturnValueOnce(null);
  await render();
  await click(dom.container().querySelector('[aria-label="Open private.pdf"]')!);
  await click(dom.container().querySelector('[aria-label="Open private.pdf"]')!);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not open the file");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(openFile).not.toHaveBeenCalled();
  await act(async () => vi.runOnlyPendingTimers());
});

it("shows size before extension and one 44px Save button with inherited contrast", async () => {
  await render();
  expect(dom.container().textContent).toContain("3 B · PDF");
  const save = download();
  expect(save.className).toContain("text-inherit");
  expect(save.className).toContain("size-11");
  expect(dom.container().querySelectorAll('[title="Save private.pdf"]')).toHaveLength(1);
  expect(dom.container().querySelectorAll("svg")).toHaveLength(2); // file tile and Save, no external-link icon
});
it("copies literal text from the viewer footer and offers Save beside it", async () => {
  const content = "<b>literal text</b>";
  vi.mocked(decryptFile).mockResolvedValueOnce(new TextEncoder().encode(content));
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const readText = Blob.prototype.text;
  let reading!: Promise<string>;
  vi.spyOn(Blob.prototype, "text").mockImplementation(function (this: Blob) { reading = readText.call(this); return reading; });
  await render("text/plain");
  const opener = dom.container().querySelector('[aria-label="Open private.pdf"]')!;
  const row = opener.closest('[tabindex="-1"]');
  await click(opener);
  await act(async () => { await reading; });
  const dialog = document.querySelector('[role="dialog"]')!;
  const pre = dialog.querySelector("pre")!;
  expect(pre.textContent).toBe(content);
  expect(pre.querySelector("b")).toBeNull();
  expect(pre.className).toContain("bg-sunken");
  const buttons = [...dialog.querySelectorAll("button")];
  await click(buttons.find((button) => button.textContent === "Copy text")!);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(content);
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Text copied");
  const saveStarted = vi.fn();
  vi.mocked(saveFile).mockImplementationOnce(async () => {
    saveStarted(document.querySelector('[role="dialog"]'), document.activeElement);
    return undefined;
  });
  await click(buttons.find((button) => button.textContent === "Save file")!);
  expect(saveFile).toHaveBeenCalledOnce();
  expect(saveStarted).toHaveBeenCalledExactlyOnceWith(null, row);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(row);
  expect(document.querySelectorAll('[role="region"] [role="status"]')).toHaveLength(1);
  expect(successToast()?.textContent).toBe("Text copied");
});

it.each([
  { result: "saved", priority: "polite", text: "Saved" },
  { result: "failed", priority: "assertive", text: "Failed to save file" },
] as const)("closes oversized text preview before saving and shows a $result result in the global toast", async ({ result, priority, text }) => {
  if (result === "saved") vi.mocked(saveFile).mockResolvedValueOnce("saved");
  else vi.mocked(saveFile).mockRejectedValueOnce(new Error("Save denied"));
  let finish!: (bytes: Uint8Array) => void;
  vi.mocked(decryptFile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render("text/plain", "file", 2 * 1024 * 1024 + 1);
  const opener = dom.container().querySelector('[aria-label="Open private.pdf"]')!;
  const row = opener.closest('[tabindex="-1"]');
  await click(opener);
  const dialog = document.querySelector('[role="dialog"]')!;
  await click([...dialog.querySelectorAll("button")].find((button) => button.textContent === "Save file")!);
  expect(decryptFile).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(row);
  await press("Escape");
  await act(async () => finish(new Uint8Array([1, 2, 3])));
  expect(saveFile).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(row);
  expect(liveRegion(toastLayer(), priority).textContent).toBe(text);
  expect((result === "saved" ? successToast() : errorToast())?.textContent).toBe(text);
});

it("shows an oversized-text preparation failure as an inline alert with Retry", async () => {
  vi.mocked(decryptFile).mockRejectedValueOnce(new Error("Decryption failed"));
  await render("text/plain", "file", 2 * 1024 * 1024 + 1);
  const opener = dom.container().querySelector('[aria-label="Open private.pdf"]')!;
  const row = opener.closest('[tabindex="-1"]')!;
  await click(opener);
  const dialog = document.querySelector('[role="dialog"]')!;
  await click([...dialog.querySelectorAll("button")].find((button) => button.textContent === "Save file")!);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(row);
  expect(row.querySelector('[role="alert"]')?.textContent).toContain("private.pdf");
  expect(row.querySelector("button")?.textContent).toBe("Retry");
  expect(saveFile).not.toHaveBeenCalled();
  expect(errorToast()).toBeNull();
  expect(liveRegion(toastLayer(), "assertive").textContent).toBe("");
});

it("labels mobile saving Share and keeps blocked rows behind an explicit warning action", async () => {
  vi.spyOn(capabilities, "fileSave", "get").mockReturnValue("share");
  await render("text/html");
  const row = dom.container().querySelector('[aria-label="Share private.pdf"]:not([title])')!;
  await click(row);
  expect(saveFile).not.toHaveBeenCalled();
  const warning = document.querySelector('[role="alert"]')!;
  expect(warning.querySelector("svg")?.getAttribute("class")).toContain("text-warn");
  await click([...warning.querySelectorAll("button")].find((button) => button.textContent === "Share file")!);
  expect(saveFile).toHaveBeenCalledOnce();
});
