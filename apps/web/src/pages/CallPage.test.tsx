import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getByRole, getByText, queryByRole } from "@testing-library/dom";
import CallPage from "./CallPage.js";
import { useCall } from "../features/calls/useCall.js";
import { copyText } from "../platform/clipboard.js";
vi.mock("../features/calls/useCall.js", () => ({ useCall: vi.fn() }));
vi.mock("../platform/clipboard.js", () => ({ copyText: vi.fn(async () => {}) }));
let root: Root;
let container: HTMLDivElement;
const end = vi.fn();
const mute = vi.fn();
const video = vi.fn();
const state = () => ({ stage: "connected", callType: "audio", conversationName: "Chat alias", peerName: "Mara Lindqvist", peerAvatarUrl: "/mara.png", isGroupCall: false, callDuration: 252, formatDuration: () => "04:12", remoteEntries: [], localStream: null, isMuted: false, isVideoOff: false, handleEnd: end, toggleMute: mute, handleToggleVideo: video });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  container = document.createElement("div"); root = createRoot(container); document.body.appendChild(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("renders a full-window dark call and wires the microphone and end controls", async () => {
  vi.mocked(useCall).mockReturnValue(state() as never);
  await act(async () => root.render(<CallPage />));
  const layer = container.querySelector("section")!;
  expect(layer.dataset.theme).toBe("dark");
  expect(layer.className).toContain("h-dvh");
  expect(container.textContent).toContain("End-to-end encrypted");
  expect(container.querySelector('[aria-live="off"]')?.textContent).toBe("04:12");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Mute microphone"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="End call"]')!.click());
  expect(mute).toHaveBeenCalledOnce(); expect(end).toHaveBeenCalledOnce();
});
it("explains unsupported encryption and only offers return to chat", async () => {
  vi.mocked(useCall).mockReturnValue({ ...state(), stage: "ended", callUnsupported: true } as never);
  await act(async () => root.render(<CallPage />));
  expect(container.textContent).toContain("Encrypted calls aren't supported on this device");
  expect(container.textContent).not.toContain("End-to-end encrypted");
  expect(container.querySelector('[aria-label="Mute microphone"]')).toBeNull();
  await act(async () => container.querySelector("button")!.click());
  expect(end).toHaveBeenCalledOnce();
});

it("keeps diagnostics inside the safe area and copies the displayed ICE and TURN transports separately", async () => {
  const audioStats = { codec: "Opus", bitrateBps: 64_000, packetLoss: 0.01 };
  const videoStats = { codec: "VP8", bitrateBps: 800_000, packetLoss: 0.02, resolution: { width: 640, height: 360 } };
  const diagnostics = {
    localCandidateType: "relay", remoteCandidateType: "srflx", roundTripTimeMs: 43, transport: "udp", turnTransport: "tls",
    audioSent: audioStats, audioReceived: audioStats, videoSent: videoStats, videoReceived: videoStats,
  };
  vi.mocked(useCall).mockReturnValue({ ...state(), callType: "video", diagnostics } as never);
  await act(async () => root.render(<CallPage />));
  const trigger = getByRole(container, "button", { name: "Call diagnostics" });
  expect(queryByRole(document.body, "dialog")).toBeNull();
  await act(async () => { trigger.focus(); trigger.click(); });
  const dialog = getByRole(document.body, "dialog", { name: "Call diagnostics" });
  expect(container.contains(dialog)).toBe(false);
  expect([...dialog.classList]).toEqual(expect.arrayContaining(["pt-safe", "px-safe", "pb-safe!"]));
  const header = getByRole(dialog, "heading", { name: "Call diagnostics" }).closest(".overflow-y-auto");
  expect(header).toBeNull();
  expect(getByRole(dialog, "heading", { name: "Incoming video" }).closest(".overflow-y-auto")).not.toBeNull();
  const transportValue = (label: string) => getByText(dialog, label, { selector: "dt" }).nextElementSibling?.textContent;
  expect(transportValue("ICE transport")).toBe("UDP");
  expect(transportValue("TURN transport")).toBe("TLS");
  for (const text of ["relay", "srflx", "43 ms", "800 kb/s", "VP8", "2%", "640 × 360"]) {
    expect(dialog.textContent).toContain(text);
  }
  await act(async () => getByRole(dialog, "button", { name: "Copy diagnostics" }).click());
  expect(copyText).toHaveBeenCalledExactlyOnceWith(JSON.stringify(diagnostics, null, 2));
  expect(getByRole(dialog, "status").textContent).toBe("Text copied");
  vi.mocked(copyText).mockRejectedValueOnce(new Error("raw native clipboard error"));
  await act(async () => getByRole(dialog, "button", { name: "Copy diagnostics" }).click());
  expect(getByRole(dialog, "status").textContent).toBe("Could not copy diagnostics.");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(queryByRole(document.body, "dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it("exposes camera and microphone toggles with their pressed state", async () => {
  vi.mocked(useCall).mockReturnValue({ ...state(), callType: "video", localStream: {} as MediaStream, isMuted: true, isVideoOff: true } as never);
  await act(async () => root.render(<CallPage />));
  const camera = container.querySelector<HTMLButtonElement>('[aria-label="Turn on camera"]')!;
  expect(camera.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector('[aria-label="Unmute microphone"]')?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => camera.click()); expect(video).toHaveBeenCalledOnce();
});
it.each(["ringing", "connecting"])("allows camera-off while %s before capture is ready", async (stage) => {
  vi.mocked(useCall).mockReturnValue({ ...state(), stage, callType: "video", localStream: null } as never);
  await act(async () => root.render(<CallPage />));
  const camera = () => container.querySelector<HTMLButtonElement>('[aria-label="Turn off camera"]')!;
  expect(camera().disabled).toBe(false);
  await act(async () => camera().click());
  expect(video).toHaveBeenCalledOnce();
  // Pre-capture mute intent remains usable, as required by the round-1 fix.
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Mute microphone"]')!.disabled).toBe(false);
  vi.mocked(useCall).mockReturnValue({ ...state(), stage, callType: "video", localStream: null, isVideoOff: true } as never);
  await act(async () => root.render(<CallPage />));
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Turn on camera"]')!.disabled).toBe(true);
});

it("moves the local preview using arrow keys and a captured pointer, keeping camera controls separate", async () => {
  vi.mocked(useCall).mockReturnValue({ ...state(), callType: "video", localStream: {} as MediaStream } as never);
  await act(async () => root.render(<CallPage />));
  const preview = container.querySelector<HTMLButtonElement>("button[data-corner]")!;
  expect(preview.dataset.corner).toBe("bottom-end");
  await act(async () => preview.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
  expect(preview.dataset.corner).toBe("top-end");
  expect(preview.classList.contains("self-start")).toBe(true);

  vi.spyOn(preview, "getBoundingClientRect").mockReturnValue(new DOMRect(204, 0, 96, 128));
  vi.spyOn(preview.parentElement!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 300));
  const pointer = (type: string, x: number, y: number) =>
    Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }), { pointerId: 1 });
  await act(async () => {
    preview.dispatchEvent(pointer("pointerdown", 250, 50));
    preview.dispatchEvent(pointer("pointermove", -100, 500));
  });
  expect(preview.style.translate).toBe("-204px 172px");
  await act(async () => {
    preview.dispatchEvent(pointer("pointerup", 20, 250));
    preview.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  expect(preview.style.translate).toBe("");
  expect(preview.dataset.corner).toBe("bottom-start");
  expect(preview.classList.contains("justify-self-start")).toBe(true);
  expect(preview.closest("[data-call-controls]")).toBeNull();
});
