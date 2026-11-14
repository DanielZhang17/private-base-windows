import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FlowFeedback from "./FlowFeedback.js";

let root: Root;
let container: HTMLDivElement;
const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, writable: true, value: showModal });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  else delete (HTMLDialogElement.prototype as { showModal?: unknown }).showModal;
  vi.unstubAllGlobals();
});

const confirmation = (overrides = {}) => ({ title: "Remove member", message: "Remove Bob?", confirmLabel: "Remove", destructive: true, onConfirm: vi.fn(), onCancel: vi.fn(), ...overrides });

it("opens confirmations and notices in the top layer, above the dialog that requested them", async () => {
  await act(async () => root.render(<>
    <FlowFeedback pendingConfirmation={confirmation()} notice="Upload failed" dismissNotice={vi.fn()} />
    <dialog open className="modal">Group Settings</dialog>
  </>));
  const [confirm, notice] = Array.from(container.querySelectorAll("dialog"));
  expect(showModal.mock.contexts).toEqual([confirm, notice]);
  expect(confirm.open && notice.open).toBe(true);
});

it("does not submit a surrounding form when its buttons are clicked", async () => {
  const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
  const pending = confirmation();
  const dismissNotice = vi.fn();
  await act(async () => root.render(<form onSubmit={onSubmit}>
    <FlowFeedback pendingConfirmation={pending} notice="Upload failed" dismissNotice={dismissNotice} />
  </form>));
  const buttons = Array.from(container.querySelectorAll("button"));
  expect(buttons.map((button) => button.textContent)).toEqual(["Cancel", "Remove", "OK"]);
  for (const button of buttons) await act(async () => button.click());
  expect(pending.onCancel).toHaveBeenCalledTimes(1);
  expect(pending.onConfirm).toHaveBeenCalledTimes(1);
  expect(dismissNotice).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();
});
