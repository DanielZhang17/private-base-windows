import { fireEvent, getByRole, getByText, queryByRole, waitFor } from "@testing-library/dom";
import { act, useState } from "react";
import { HISTORY_TRANSFER_VERSION } from "@e2ee-chat/shared";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { ToastProvider } from "../../ui/index.js";
import { click, press, setupDom } from "../../ui/test-utils.js";
import { CompareTransferCode, EnterTransferWords, ScanTransferCode, ShowTransferInvitation } from "./TransferPairingScreens.js";
import { TransferChatPicker } from "./TransferChatPicker.js";
import { TransferSummary } from "./TransferProgress.js";
import { HistoryTransferOwner, HistoryTransferScreen, LinkedDevicesTransfer, TRANSFER_PATH } from "./HistoryTransferScreens.js";
import { createTransferPairing, encodeTransferWords } from "./pairing.js";
import * as transfer from "./useHistoryTransfer.js";
import type { useHistoryTransfer } from "./useHistoryTransfer.js";

const encoder = vi.hoisted(() => vi.fn(async () => "data:image/png;base64,AAAA"));
vi.mock("qrcode", () => ({ default: { toDataURL: encoder } }));
const { render, container } = setupDom();
afterEach(() => vi.restoreAllMocks());

it("focuses the Compare heading and reads the six digits only once in order", async () => {
  const confirm = vi.fn();
  const stop = vi.fn();
  await render(<CompareTransferCode code="482913" sending deviceName="Laptop" otherDevice="Phone" confirmed={false} confirm={confirm} stop={stop} />);
  expect(document.activeElement).toBe(getByRole(container(), "heading", { level: 1 }));
  expect(getByText(container(), "Transfer code: 4 8 2 9 1 3").className).toContain("sr-only");
  for (const group of ["482", "913"]) expect(getByText(container(), group).closest('[aria-hidden="true"]')).toBeTruthy();
  await press("Enter");
  expect(confirm).not.toHaveBeenCalled();
  const accept = getByRole(container(), "button", { name: "Codes match" });
  const cancel = getByRole(container(), "button", { name: "Stop transfer" });
  expect(accept.className).toContain("min-h-12");
  expect(cancel.className).toContain("min-h-12");
  await click(accept);
  expect(confirm).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
});

it("shows a local QR and eight separate words, with the comparison code absent", async () => {
  const qr = createTransferPairing("phone");
  const words = encodeTransferWords(qr.secret);
  const expiresAt = Date.now() + 600_000;
  await render(<ToastProvider><ShowTransferInvitation invitation={{ qr, words, expiresAt }} expired={false} renew={vi.fn()} /></ToastProvider>);
  await waitFor(() => expect(encoder).toHaveBeenCalledWith(JSON.stringify(qr), expect.objectContaining({ margin: 4 })));
  const image = getByRole(container(), "img", { name: /transfer code/i });
  expect(image.querySelector("img")?.src).toBe("data:image/png;base64,AAAA");
  expect(container().querySelectorAll(".transfer-words li")).toHaveLength(8);
  expect(getByRole(container(), "button", { name: "Copy the 8 words" })).toBeTruthy();
  expect(getByText(container(), "Code expires in 10:00")).toBeTruthy();
});

it("scrolls the full fallback card into view and keeps a 44px copy target", async () => {
  const qr = createTransferPairing("phone");
  await render(<ToastProvider><ShowTransferInvitation invitation={{ qr, words: encodeTransferWords(qr.secret), expiresAt: Date.now() + 60_000 }}
    expired={false} renew={vi.fn()} /></ToastProvider>);
  const details = container().querySelector("details")!;
  const copy = getByRole(container(), "button", { name: "Copy the 8 words" });
  const scroll = vi.fn(function (this: HTMLElement) {
    expect(this.contains(copy)).toBe(true);
    expect(this.querySelectorAll(".transfer-words li")).toHaveLength(8);
  });
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  try {
    for (const open of [false, true]) await act(async () => { details.open = open; fireEvent(details, new Event("toggle")); });
    expect(scroll).toHaveBeenCalledWith({ block: "end" });
    expect(copy.className).toContain("min-h-11");
  } finally {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

it.each([true, false])("disambiguates identical device names including the wait state (sending %s)", async (sending) => {
  await render(<CompareTransferCode code="482913" sending={sending} deviceName="Edge on macOS" otherDevice="Edge on macOS"
    confirmed confirm={vi.fn()} stop={vi.fn()} />);
  expect(container().textContent).toContain("Sending device");
  expect(container().textContent).toContain("Receiving device");
  expect(getByRole(container(), "status").textContent).toContain(sending ? "Receiving device" : "Sending device");
});

it.each(["sender", "receiver"] as const)("stops the %s comparison through the rejection path", async (role) => {
  const rejectComparison = vi.fn();
  const stop = vi.fn();
  const mock = vi.spyOn(transfer, "useHistoryTransfer").mockReturnValue({ phase: "pairing", role, checkCode: "482913",
    peerDeviceName: "Other device", rejectComparison, stop } as unknown as ReturnType<typeof useHistoryTransfer>);
  const path = `${TRANSFER_PATH}?mode=${role === "sender" ? "send" : "receive"}`;
  await render(<MemoryRouter initialEntries={[path]}><HistoryTransferScreen /></MemoryRouter>);
  await click(getByRole(container(), "button", { name: "Stop transfer" }));
  expect(rejectComparison).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
  mock.mockReturnValue({ phase: "error", error: "check-code-mismatch", role } as ReturnType<typeof useHistoryTransfer>);
  await render(<MemoryRouter initialEntries={[path]}><HistoryTransferScreen /></MemoryRouter>);
  expect(getByRole(container(), "button", { name: "Start again" })).toBeTruthy();
  expect(getByText(container(), /If the codes were different/)).toBeTruthy();
});

it.each([["version", "Laptop"], ["version-local", "this device"]] as const)("tells the user to update the outdated device (%s)", async (error, device) => {
  vi.spyOn(transfer, "useHistoryTransfer").mockReturnValue({ phase: "error", error, role: "receiver",
    peerDeviceName: "Laptop" } as ReturnType<typeof useHistoryTransfer>);
  await render(<MemoryRouter initialEntries={[`${TRANSFER_PATH}?mode=receive`]}><HistoryTransferScreen /></MemoryRouter>);
  expect(getByText(container(), `Update Private Base on ${device} to transfer history.`)).toBeTruthy();
});

it("submits eight valid words with numbering and separators", async () => {
  const connect = vi.fn();
  const words = encodeTransferWords(createTransferPairing("phone").secret);
  await render(<EnterTransferWords connect={connect} connecting={false} />);
  const submit = getByRole(container(), "button", { name: "Connect" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  const field = getByRole(container(), "textbox", { name: "8-word code" });
  await act(async () => { fireEvent.change(field, { target: { value: words.split(" ").map((word, i) => `${i + 1}. ${word}`).join(",\n") } }); });
  expect(submit.disabled).toBe(false);
  await click(submit);
  expect(connect).toHaveBeenCalledWith(words);
});

it("shows browser permission recovery and keeps the typed-code alternative reachable", async () => {
  const devices = { getUserMedia: vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }),
    enumerateDevices: vi.fn(async () => [{ kind: "videoinput" }]) };
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: devices });
  try {
    const enter = vi.fn();
    await render(<ScanTransferCode connect={vi.fn()} enter={enter} onViewfinder={vi.fn()} />);
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    await click(getByRole(container(), "button", { name: "Allow camera" }));
    expect(getByRole(container(), "alert").textContent).toContain("browser's site settings");
    expect(getByRole(container(), "button", { name: "Try again" })).toBeTruthy();
    await click(getByRole(container(), "button", { name: "Enter code instead" }));
    expect(enter).toHaveBeenCalledOnce();
  } finally {
    if (descriptor) Object.defineProperty(navigator, "mediaDevices", descriptor);
    else Reflect.deleteProperty(navigator, "mediaDevices");
  }
});

it("offers both roles from Linked devices", async () => {
  await render(<MemoryRouter initialEntries={["/devices"]}><ToastProvider><HistoryTransferOwner /><Routes>
    <Route path="/devices" element={<LinkedDevicesTransfer devices={[]} />} />
    <Route path={TRANSFER_PATH} element={<HistoryTransferScreen />} />
  </Routes></ToastProvider></MemoryRouter>);
  await click(getByRole(container(), "button", { name: /transfer history/i }));
  expect(getByRole(container(), "heading", { name: "Transfer history" })).toBeTruthy();
  expect(getByRole(container(), "button", { name: /get history on this device/i })).toBeTruthy();
  expect(getByRole(container(), "button", { name: /send history from this device/i })).toBeTruthy();
  await click(getByRole(container(), "button", { name: /send history from this device/i }));
  expect(queryByRole(container(), "heading", { name: "Transfer history" })).toBeNull();
});

it("preselects only unfinished chats, applies search bulk actions to non-hidden matches, and keeps attachment copying explicit", async () => {
  const chats = Array.from({ length: 13 }, (_, index) => ({
    id: `chat-${index}`, name: `Team ${index}`, messages: 3, bytes: 512, cachedBytes: 1024, files: 1, cachedFiles: 1,
    hidden: index === 12, updatedAt: index,
  }));
  const prepare = vi.fn(async () => ({ chats: [{ messages: 3 }], bytes: 1000 }));
  const send = vi.fn(async () => {});
  const flow = {
    listChats: () => Promise.resolve(chats), prepare, send, peerCapacity: { free: 40_000, cellular: false },
    checkpoint: { chats: [{ id: "chat-0" }, { id: "chat-1" }, { id: "chat-12" }], completedChatIds: ["chat-0"], copyDownloadedFiles: false },
  } as unknown as ReturnType<typeof useHistoryTransfer>;
  await render(<TransferChatPicker flow={flow} peer="Phone" deviceName="Laptop" />);
  await waitFor(() => expect(getByRole(container(), "checkbox", { name: /Team 1,/ })).toBeTruthy());
  const chat = (team: number) => getByRole(container(), "checkbox", { name: new RegExp(`Team ${team},`) }) as HTMLInputElement;
  expect(chat(0).disabled).toBe(true);
  expect(chat(1).checked).toBe(true);
  expect(chat(12).checked).toBe(false);
  await act(async () => { fireEvent.change(getByRole(container(), "searchbox"), { target: { value: "Team 1" } }); });
  await click(getByRole(container(), "button", { name: "Select 3 results" }));
  expect(chat(10).checked).toBe(true);
  expect(chat(12).checked).toBe(false);
  await click(getByRole(container(), "button", { name: "Clear 3 results" }));
  expect(chat(10).checked).toBe(false);
  await click(chat(12));
  const files = getByRole(container(), "switch", { name: "Copy downloaded photos and files now" }) as HTMLInputElement;
  expect(files.checked).toBe(false);
  await click(files);
  await click(getByRole(container(), "button", { name: /start transfer: 1 chat, with downloaded photos and files, to phone/i }));
  expect(prepare).toHaveBeenCalledWith([{ conversationId: "chat-12" }], { copyDownloadedFiles: true });
  expect(send).toHaveBeenCalledOnce();
});

it("resolves stored avatar identifiers in the transfer picker", async () => {
  const chat = { id: "chat", name: "Team", messages: 1, bytes: 8, cachedBytes: 0, files: 0, cachedFiles: 0,
    hidden: false, updatedAt: 1, avatarUrl: "dicebear://bottts/Team Name" };
  const flow = { listChats: async () => [chat] } as unknown as ReturnType<typeof useHistoryTransfer>;
  await render(<TransferChatPicker flow={flow} peer="Phone" deviceName="Laptop" />);
  await waitFor(() => expect(container().querySelector("img")?.getAttribute("src"))
    .toBe("https://api.dicebear.com/9.x/bottts/svg?seed=Team%20Name"));
});

it("uses singular chat copy, a zero-file hint and a natural sub-minute estimate", async () => {
  const chats = [{ id: "chat", name: "Team", messages: 1, bytes: 8, cachedBytes: 0, files: 0, cachedFiles: 0,
    hidden: false, updatedAt: 1 }];
  const flow = { listChats: async () => chats, estimatedBytesPerSecond: 1024 } as unknown as ReturnType<typeof useHistoryTransfer>;
  await render(<TransferChatPicker flow={flow} peer="Phone" deviceName="Laptop" />);
  expect(getByRole(container(), "button", { name: /start transfer: 1 chat,/i })).toBeTruthy();
  expect(getByText(container(), "Nothing saved yet")).toBeTruthy();
  expect(container().textContent).toContain("less than a minute");
  expect(container().textContent).not.toContain("about less than a minute");
});

it.each([750, 1_500])("uses the receiver's required %s bytes to gate Start after checking space", async (requiredBytes) => {
  const chats = [{ id: "chat", name: "Chat", messages: 1, bytes: 2_000, cachedBytes: 0,
    files: 0, cachedFiles: 0, hidden: false, updatedAt: 1 }];
  const prepare = vi.fn(async () => ({ bytes: 2_000, requiredBytes, chats: [{ messages: 1 }] }));
  const send = vi.fn(async () => {});
  const flow = { listChats: async () => chats, prepare, send, peerCapacity: { free: 1_000, cellular: false } } as unknown as ReturnType<typeof useHistoryTransfer>;
  await render(<TransferChatPicker flow={flow} peer="Phone" deviceName="Laptop" />);
  const button = () => getByRole(container(), "button", { name: /start transfer/i }) as HTMLButtonElement;
  expect(getByRole(container(), "alert").textContent).toContain("History already on that device may reduce the space needed");
  await click(getByRole(container(), "button", { name: "Check space" }));
  expect(prepare).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
  expect(button().disabled).toBe(requiredBytes > 1_000);
  if (requiredBytes > 1_000) {
    expect(getByRole(container(), "alert").textContent).toContain("Choose fewer chats or turn off photos and files");
  } else {
    await click(button());
    expect(send).toHaveBeenCalledOnce();
  }
});

it("rechecks the same blocked selection after the receiving device frees space", async () => {
  const chats = [{ id: "chat", name: "Chat", messages: 1, bytes: 2_000, cachedBytes: 0, files: 0, cachedFiles: 0, hidden: false, updatedAt: 1 }];
  const listChats = async () => chats;
  const send = vi.fn(async () => {});
  const prepare = vi.fn();
  function Picker() {
    const [free, setFree] = useState(1_000);
    const manifest = { v: HISTORY_TRANSFER_VERSION, bytes: 2_000, copyDownloadedFiles: false, chats: [{ messages: 1 }] };
    const flow = { listChats, send, peerCapacity: { free, cellular: false }, canSend: free > 2_000, manifest,
      prepare: async (...args: Parameters<ReturnType<typeof useHistoryTransfer>["prepare"]>) => {
        prepare(...args);
        const available = args[1]?.checkSpace ? 4_000 : free;
        setFree(available);
        return { ...manifest, requiredBytes: 2_000, freeBytes: available };
      } } as unknown as ReturnType<typeof useHistoryTransfer>;
    return <TransferChatPicker flow={flow} peer="Phone" deviceName="Laptop" />;
  }
  await render(<Picker />);
  const check = () => getByRole(container(), "button", { name: "Check space" });
  const start = () => getByRole(container(), "button", { name: /start transfer/i }) as HTMLButtonElement;
  await click(check());
  expect(start().disabled).toBe(true);
  await click(check());
  expect(prepare).toHaveBeenLastCalledWith([{ conversationId: "chat" }], { copyDownloadedFiles: false, checkSpace: true });
  expect(start().disabled).toBe(false);
  expect(send).not.toHaveBeenCalled();
  await click(start());
  expect(send).toHaveBeenCalledOnce();
});

it.each(["sender", "receiver"])("asks for cellular confirmation when preparation first reveals a large transfer on the %s connection", async (device) => {
  const original = Object.getOwnPropertyDescriptor(navigator, "connection");
  Object.defineProperty(navigator, "connection", { configurable: true, value: Object.assign(new EventTarget(), {
    type: device === "sender" ? "cellular" : "wifi",
  }) });
  try {
    const chat = { id: "chat", name: "Chat", messages: 0, bytes: 500, cachedBytes: 0,
      files: 0, cachedFiles: 0, hidden: false, updatedAt: 1 };
    const manifest = { v: HISTORY_TRANSFER_VERSION, bytes: 60_000_000, copyDownloadedFiles: false,
      chats: [{ id: "chat", name: "Chat", messages: 20, bytes: 60_000_000, attachmentBytes: 0 }] } as const;
    const prepare = vi.fn(async () => manifest);
    const send = vi.fn(async () => {});
    const flow = { listChats: async () => [chat], prepare, send, peerCapacity: { cellular: device === "receiver" } } as unknown as ReturnType<typeof useHistoryTransfer>;
    await render(<TransferChatPicker flow={flow} peer="Phone" deviceName="Laptop" />);
    await click(getByRole(container(), "button", { name: /start transfer/i }));
    expect(prepare).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(getByRole(container(), "alert").textContent).toContain(`${device === "receiver" ? "Phone" : "Laptop"} is using mobile data`);
    await render(<TransferChatPicker flow={{ ...flow, canSend: true, manifest: { ...manifest, chats: [...manifest.chats] } }} peer="Phone" deviceName="Laptop" />);
    await click(getByRole(container(), "button", { name: /send on mobile data/i }));
    expect(prepare).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  } finally {
    if (original) Object.defineProperty(navigator, "connection", original);
    else Reflect.deleteProperty(navigator, "connection");
  }
});

it("reports that copied chats remain after a local stop", async () => {
  vi.spyOn(transfer, "useHistoryTransfer").mockReturnValue({
    phase: "cancelled", role: "sender", peerDeviceName: "Phone", stoppedAfterStart: true,
    progress: { records: 1, totalRecords: 2, bytes: 500, totalBytes: 1000 },
  } as ReturnType<typeof useHistoryTransfer>);
  await render(<MemoryRouter initialEntries={["/devices/transfer?mode=send"]}><HistoryTransferScreen /></MemoryRouter>);
  expect(getByRole(container(), "heading", { name: "Transfer stopped" })).toBeTruthy();
  expect(getByText(container(), "Chats already copied stay on Phone. You can send the rest later.")).toBeTruthy();
  expect(container().textContent).not.toContain("Nothing was sent");
});

it.each(["sender", "receiver"] as const)("shows confirmed additions and separate skipped chats on the %s summary", async (role) => {
  const flow = { role, summary: { chats: 1, messages: 4, attachmentFiles: 2, attachmentBytes: 10, elapsedMs: 100,
    skippedChats: [{ id: "chat", name: "Hidden project" }], missingFiles: [], missingFileCount: 1 } };
  await render(<TransferSummary flow={flow} peer="Phone" finish={vi.fn()} />);
  expect(getByText(container(), "Chats").nextElementSibling?.textContent).toBe("1");
  expect(getByText(container(), "Messages").nextElementSibling?.textContent).toBe("4");
  expect(getByText(container(), "Hidden project").closest("ul")).toBeTruthy();
  expect(container().querySelector(".bg-ok-soft")).toBeTruthy();
  expect(getByText(container(), /1 file couldn't be copied/)).toBeTruthy();
});

it("shows an interrupted transfer without suggesting a mismatch or rollback", async () => {
  vi.spyOn(transfer, "useHistoryTransfer").mockReturnValue({
    phase: "error", role: "sender", error: "transfer-interrupted", peerDeviceName: "Phone",
    progress: { records: 1, totalRecords: 2, bytes: 500, totalBytes: 1000 },
  } as ReturnType<typeof useHistoryTransfer>);
  await render(<MemoryRouter initialEntries={[`${TRANSFER_PATH}?mode=send`]}><HistoryTransferScreen /></MemoryRouter>);
  expect(container().textContent).toContain("Chats already copied");
  expect(container().textContent).not.toMatch(/codes match|nothing was sent/i);
});

it("closes the waiting invitation and returns to the role picker on browser Back", async () => {
  const invited = { qr: createTransferPairing("phone"), words: "", expiresAt: Date.now() + 60_000 };
  const progress = { records: 0, totalRecords: 0, bytes: 0, totalBytes: 0 };
  const startAsReceiver = vi.fn(async () => invited);
  const stop = vi.fn();
  const dismiss = vi.fn();
  const flow = vi.spyOn(transfer, "useHistoryTransfer").mockReturnValue({
    phase: "idle", startAsReceiver, stop, dismiss, progress,
  } as unknown as ReturnType<typeof useHistoryTransfer>);
  function RouterBack() {
    const navigate = useNavigate();
    return <button onClick={() => navigate(-1)}>Browser Back</button>;
  }
  const screen = () => <MemoryRouter initialEntries={[TRANSFER_PATH, `${TRANSFER_PATH}?mode=receive`]} initialIndex={1}>
    <ToastProvider><RouterBack /><HistoryTransferScreen /></ToastProvider>
  </MemoryRouter>;
  await render(screen());
  expect(startAsReceiver).toHaveBeenCalledOnce();
  flow.mockReturnValue({ phase: "waiting", role: "receiver", invitation: invited, startAsReceiver, stop, dismiss, progress } as unknown as ReturnType<typeof useHistoryTransfer>);
  await render(screen());
  expect(getByRole(container(), "img", { name: /transfer code/i })).toBeTruthy();
  await click(getByRole(container(), "button", { name: "Browser Back" }));
  expect(stop).toHaveBeenCalledOnce();
  expect(dismiss).toHaveBeenCalledOnce();
  flow.mockReturnValue({ phase: "idle", startAsReceiver, stop, dismiss, progress } as unknown as ReturnType<typeof useHistoryTransfer>);
  await render(screen());
  expect(getByRole(container(), "button", { name: /get history on this device/i })).toBeTruthy();
  expect(startAsReceiver).toHaveBeenCalledOnce();
});

it.each(["pairing", "transferring"] as const)("handles browser Back from sender mode during %s", async (phase) => {
  const stop = vi.fn(), dismiss = vi.fn();
  const progress = { records: 0, totalRecords: phase === "transferring" ? 2 : 0, bytes: 0, totalBytes: 0 };
  vi.spyOn(transfer, "useHistoryTransfer").mockReturnValue({ phase, role: "sender", stop, dismiss, progress } as unknown as ReturnType<typeof useHistoryTransfer>);
  function RouterBack() {
    const navigate = useNavigate();
    return <button onClick={() => navigate(-1)}>Browser Back</button>;
  }
  await render(<MemoryRouter initialEntries={[TRANSFER_PATH, `${TRANSFER_PATH}?mode=send`]} initialIndex={1}>
    <RouterBack /><HistoryTransferScreen />
  </MemoryRouter>);
  await click(getByRole(container(), "button", { name: "Browser Back" }));
  expect(stop).toHaveBeenCalledTimes(phase === "pairing" ? 1 : 0);
  expect(dismiss).toHaveBeenCalledTimes(phase === "pairing" ? 1 : 0);
  if (phase === "pairing") expect(getByRole(container(), "button", { name: /get history on this device/i })).toBeTruthy();
});

it("stops and leaves a paused transfer even when the peer details have been cleared", async () => {
  const stop = vi.fn();
  vi.spyOn(transfer, "useHistoryTransfer").mockReturnValue({
    phase: "paused", role: "receiver", requiresPairing: true, stop,
    progress: { records: 0, totalRecords: 0, bytes: 0, totalBytes: 0 },
  } as unknown as ReturnType<typeof useHistoryTransfer>);
  await render(<MemoryRouter initialEntries={["/devices/transfer?mode=receive"]}><Routes>
    <Route path={TRANSFER_PATH} element={<HistoryTransferScreen />} />
    <Route path="/devices" element={<p>Linked devices</p>} />
  </Routes></MemoryRouter>);
  await click(getByRole(container(), "button", { name: "Stop transfer" }));
  const dialog = getByRole(document.body, "alertdialog");
  await click(getByRole(dialog, "button", { name: "Stop transfer" }));
  expect(stop).toHaveBeenCalledOnce();
  expect(getByText(container(), "Linked devices")).toBeTruthy();
});
