import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  writeText: vi.fn(), openUrl: vi.fn(), save: vi.fn(), writeFile: vi.fn(),
  isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn(), onAction: vi.fn(), registerActionTypes: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: native.writeText }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: native.openUrl }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: native.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: native.writeFile }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: native.isPermissionGranted, requestPermission: native.requestPermission,
  sendNotification: native.sendNotification, onAction: native.onAction, registerActionTypes: native.registerActionTypes,
}));

function useNative() {
  vi.stubGlobal("window", { location: new URL("tauri://localhost") });
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  native.isPermissionGranted.mockResolvedValue(true);
  native.onAction.mockResolvedValue({ unregister: vi.fn() });
  native.registerActionTypes.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("clipboard", () => {
  it("writes through the browser clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { copyText } = await import("./index.js");
    await copyText("secret");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("secret");
    expect(native.writeText).not.toHaveBeenCalled();
  });

  it("uses the native clipboard even without a web clipboard", async () => {
    useNative();
    vi.stubGlobal("navigator", {});
    const { copyText } = await import("./index.js");
    await copyText("secret");
    expect(native.writeText).toHaveBeenCalledExactlyOnceWith("secret");
    native.writeText.mockRejectedValue(new Error("Permission denied"));
    await expect(copyText("secret")).rejects.toThrow("Permission denied");
  });

  it("falls back to selection copying, restores focus and cleans up on failure", async () => {
    vi.stubGlobal("navigator", {});
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    const { copyText } = await import("./clipboard.js");
    await copyText("secret");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.activeElement).toBe(button);
    execCommand.mockReturnValue(false);
    await expect(copyText("secret")).rejects.toMatchObject({ localizedMessage: { key: "clipboardAccessIsUnavailable" } });
    expect(document.querySelector("textarea")).toBeNull();
    button.remove();
    Reflect.deleteProperty(document, "execCommand");
  });
});

describe("external links", () => {
  it("opens a web link without giving it an opener", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { openExternal } = await import("./index.js");
    await openExternal("https://example.com/help");
    expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/help", "_blank", "noopener,noreferrer");
    expect(native.openUrl).not.toHaveBeenCalled();
  });

  it("opens native links in the system browser and propagates failures", async () => {
    useNative();
    const { openExternal } = await import("./index.js");
    await openExternal("https://example.com/help");
    expect(native.openUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/help");
    native.openUrl.mockRejectedValue(new Error("Blocked"));
    await expect(openExternal("https://example.com/help")).rejects.toThrow("Blocked");
  });

  it.each([false, true])("rejects executable and local URLs (native=%s)", async (isNative) => {
    if (isNative) useNative();
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const { openExternal } = await import("./external.js");
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "tauri://localhost", "data:text/html,hi"]) {
      await expect(openExternal(url)).rejects.toMatchObject({ localizedMessage: { key: "externalLinksMustUseHttpOrHttps" } });
    }
    expect(native.openUrl).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("saving files", () => {
  it("downloads web blobs and releases the temporary URL", async () => {
    vi.useFakeTimers();
    const blob = new Blob(["file"]);
    const createObjectURL = vi.fn().mockReturnValue("blob:test");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
    let downloaded: HTMLAnchorElement | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloaded = this; });
    const { saveFile } = await import("./index.js");
    await saveFile(blob, "file.txt");
    expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(blob);
    expect(downloaded?.download).toBe("file.txt");
    expect(downloaded?.href).toBe("blob:test");
    expect(downloaded?.isConnected).toBe(false);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:test");
    expect(native.save).not.toHaveBeenCalled();
  });

  it("writes native bytes only to the path selected in the save dialog", async () => {
    useNative();
    native.save.mockResolvedValue("/chosen/file.bin");
    const bytes = new Uint8Array([1, 2, 3]);
    const blob = { arrayBuffer: async () => bytes.buffer } as Blob;
    const { saveFile } = await import("./index.js");
    await saveFile(blob, "file.bin");
    expect(native.save).toHaveBeenCalledExactlyOnceWith({ defaultPath: "file.bin" });
    expect(native.writeFile).toHaveBeenCalledExactlyOnceWith("/chosen/file.bin", bytes);
    native.writeFile.mockRejectedValue(new Error("Disk full"));
    await expect(saveFile(blob, "file.bin")).rejects.toThrow("Disk full");
  });

  it("does not read or write a native file when the dialog is cancelled", async () => {
    useNative();
    native.save.mockResolvedValue(null);
    const arrayBuffer = vi.fn();
    const { saveFile } = await import("./files.js");
    await saveFile({ arrayBuffer } as unknown as Blob, "file.bin");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(native.writeFile).not.toHaveBeenCalled();
  });
});

describe("notifications", () => {
  class WebNotification {
    static permission: NotificationPermission = "granted";
    static requestPermission = vi.fn();
    static instances: WebNotification[] = [];
    close = vi.fn();
    onclick?: () => void;
    constructor(public title: string, public options: globalThis.NotificationOptions) { WebNotification.instances.push(this); }
  }

  beforeEach(() => {
    WebNotification.permission = "granted";
    WebNotification.instances = [];
    vi.stubGlobal("Notification", WebNotification);
  });

  it("shows and closes a web notification and invokes its click handler", async () => {
    const onClick = vi.fn();
    const { notify } = await import("./index.js");
    expect(await notify({ title: "New message", body: "Encrypted chat", onClick })).toBe(true);
    const notification = WebNotification.instances[0];
    expect(notification.title).toBe("New message");
    expect(notification.options.body).toBe("Encrypted chat");
    notification.onclick!();
    expect(notification.close).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(native.sendNotification).not.toHaveBeenCalled();
  });

  it("requests web permission, respects denial and handles an absent API", async () => {
    const { notify } = await import("./notifications.js");
    WebNotification.permission = "default";
    WebNotification.requestPermission.mockResolvedValue("denied");
    expect(await notify({ title: "New message" })).toBe(false);
    expect(WebNotification.requestPermission).toHaveBeenCalledTimes(1);
    WebNotification.permission = "denied";
    expect(await notify({ title: "New message" })).toBe(false);
    expect(WebNotification.requestPermission).toHaveBeenCalledTimes(1);
    vi.stubGlobal("Notification", undefined);
    expect(await notify({ title: "New message" })).toBe(false);
    expect(WebNotification.instances).toHaveLength(0);
  });

  it("routes native clicks by notification id without invoking another handler", async () => {
    useNative();
    const first = vi.fn();
    const second = vi.fn();
    const { notify } = await import("./index.js");
    await notify({ title: "First", onClick: first });
    await notify({ title: "Second", body: "Body", onClick: second });
    expect(native.onAction).toHaveBeenCalledTimes(1);
    expect(native.requestPermission).not.toHaveBeenCalled();
    expect(WebNotification.instances).toHaveLength(0);
    const secondId = native.sendNotification.mock.calls[1][0].id;
    const onAction = native.onAction.mock.calls[0][0];
    onAction({ notification: { id: secondId } });
    onAction({ notification: { id: secondId } });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("refreshes native action labels when the resolved locale changes and reuses them within a locale", async () => {
    useNative();
    const { setLocalePreference } = await import("../i18n/index.js");
    const { notify } = await import("./notifications.js");
    const onClick = vi.fn();
    await setLocalePreference("de");
    await notify({ title: "First", onClick });
    await notify({ title: "Second", onClick });
    expect(native.registerActionTypes).toHaveBeenCalledTimes(1);
    expect(native.registerActionTypes).toHaveBeenLastCalledWith([{
      id: "e2ee-open", actions: [{ id: "open", title: "Öffnen", foreground: true }],
    }]);
    await setLocalePreference("en");
    await notify({ title: "Third", onClick });
    expect(native.registerActionTypes).toHaveBeenCalledTimes(2);
    expect(native.registerActionTypes).toHaveBeenLastCalledWith([{
      id: "e2ee-open", actions: [{ id: "open", title: "Open", foreground: true }],
    }]);
    // Returning to a previously used locale must replace the active registration too.
    await setLocalePreference("de");
    await notify({ title: "Fourth", onClick });
    expect(native.registerActionTypes).toHaveBeenCalledTimes(3);
    expect(native.registerActionTypes).toHaveBeenLastCalledWith([{
      id: "e2ee-open", actions: [{ id: "open", title: "Öffnen", foreground: true }],
    }]);
    expect(native.onAction).toHaveBeenCalledTimes(1);
    expect(native.sendNotification).toHaveBeenCalledTimes(4);
    native.onAction.mock.calls[0][0]({ notification: { id: native.sendNotification.mock.calls[3][0].id } });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("requests native permission and does not send after denial", async () => {
    useNative();
    native.isPermissionGranted.mockResolvedValue(false);
    native.requestPermission.mockResolvedValue("denied");
    const { notify } = await import("./notifications.js");
    expect(await notify({ title: "No" })).toBe(false);
    expect(native.sendNotification).not.toHaveBeenCalled();
    native.requestPermission.mockResolvedValue("granted");
    native.isPermissionGranted.mockResolvedValue(true);
    expect(await notify({ title: "Yes" })).toBe(true);
    expect(native.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("prompts passively only once per session after a dismissed web prompt", async () => {
    const { showMessageNotification, requestNotificationPermission } = await import("../lib/browser-notifications.js");
    const { notify } = await import("./notifications.js");
    WebNotification.permission = "default";
    WebNotification.requestPermission.mockResolvedValue("default");
    // Two messages arriving together and a later one share a single prompt.
    showMessageNotification("Alice", "chat-1");
    showMessageNotification("Bob", "chat-2");
    expect(await notify({ title: "Later message" })).toBe(false);
    expect(WebNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(WebNotification.instances).toHaveLength(0);
    // An explicit request may ask again, without re-arming the passive prompt.
    expect(await requestNotificationPermission()).toBe(false);
    expect(WebNotification.requestPermission).toHaveBeenCalledTimes(2);
    expect(await notify({ title: "Still dismissed" })).toBe(false);
    expect(WebNotification.requestPermission).toHaveBeenCalledTimes(2);
    // Once permission is granted, notifications are shown.
    WebNotification.permission = "granted";
    expect(await notify({ title: "Granted" })).toBe(true);
    expect(WebNotification.instances).toHaveLength(1);
  });

  it("prompts passively only once per session on native, while explicit requests retry", async () => {
    useNative();
    native.isPermissionGranted.mockResolvedValue(false);
    native.requestPermission.mockResolvedValue("default");
    const { notify, requestNotificationPermission } = await import("./notifications.js");
    // An explicit request does not use up the passive prompt.
    expect(await requestNotificationPermission()).toBe(false);
    expect(native.requestPermission).toHaveBeenCalledTimes(1);
    expect(await notify({ title: "One" })).toBe(false);
    expect(await notify({ title: "Two" })).toBe(false);
    expect(native.requestPermission).toHaveBeenCalledTimes(2);
    native.requestPermission.mockResolvedValue("granted");
    expect(await requestNotificationPermission()).toBe(true);
    expect(native.requestPermission).toHaveBeenCalledTimes(3);
    expect(native.sendNotification).not.toHaveBeenCalled();
  });

  it("uses router navigation for message notification clicks on web and native", async () => {
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    const { registerNavigate } = await import("./navigation.js");
    const route = vi.fn();
    const unregister = registerNavigate(route);
    const { showMessageNotification } = await import("../lib/browser-notifications.js");
    showMessageNotification("Alice", "chat-id");
    await vi.waitFor(() => expect(WebNotification.instances).toHaveLength(1));
    WebNotification.instances[0].onclick!();
    expect(route).toHaveBeenCalledWith("/chat/chat-id");
    useNative();
    vi.stubGlobal("window", { location: new URL("tauri://localhost"), focus });
    showMessageNotification("Bob", "native-chat");
    await vi.waitFor(() => expect(native.sendNotification).toHaveBeenCalledTimes(1));
    native.onAction.mock.calls[0][0]({ notification: { id: native.sendNotification.mock.calls[0][0].id } });
    expect(route).toHaveBeenLastCalledWith("/chat/native-chat");
    unregister();
  });
});
