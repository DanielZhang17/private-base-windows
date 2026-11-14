import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import { Button, ConfirmDialog, Dialog, Sheet, ToastProvider, useToast } from "./index.js";
import { click, press, setupDom } from "./test-utils.js";

const { render } = setupDom();
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');

function Harness({ onClose, dismissible }: { onClose: () => void; dismissible?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button id="opener" onClick={() => setOpen(true)}>Open</button>
      <Dialog
        open={open}
        dismissible={dismissible}
        onClose={() => { onClose(); setOpen(false); }}
        title="Rename this device"
        description="Other linked devices see this name."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button>Save</Button></>}
      >
        <input id="name" />
      </Dialog>
    </>
  );
}

async function openHarness(props: { onClose?: () => void; dismissible?: boolean } = {}) {
  await render(<Harness onClose={props.onClose ?? (() => undefined)} dismissible={props.dismissible} />);
  const opener = document.getElementById("opener")!;
  opener.focus();
  await click(opener);
  return opener;
}

it("Dialog renders nothing while closed", async () => {
  await render(<Dialog open={false} onClose={() => undefined} title="Hidden" />);
  expect(dialog()).toBeNull();
});

it("Dialog is a labelled, described modal", async () => {
  await openHarness();
  const element = dialog()!;
  expect(element.getAttribute("role")).toBe("dialog");
  expect(element.getAttribute("aria-modal")).toBe("true");
  expect(document.getElementById(element.getAttribute("aria-labelledby")!)!.textContent).toBe("Rename this device");
  expect(document.getElementById(element.getAttribute("aria-describedby")!)!.textContent).toBe("Other linked devices see this name.");
});

it("Dialog moves focus to the first control in its body and locks page scroll", async () => {
  await openHarness();
  expect(document.activeElement).toBe(document.getElementById("name"));
  expect(document.body.style.overflow).toBe("hidden");
});

it("Dialog closes on Escape and returns focus to the opener", async () => {
  const onClose = vi.fn();
  const opener = await openHarness({ onClose });
  await press("Escape");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe("");
});

it("Dialog traps Tab and Shift+Tab inside the panel", async () => {
  await openHarness();
  const focusable = Array.from(dialog()!.querySelectorAll<HTMLElement>("button, input"));
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  expect(last.textContent).toBe("Save");
  last.focus();
  await press("Tab");
  expect(document.activeElement).toBe(first);
  await press("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(last);
});

it("Dialog recaptures focus when a toast outside the panel receives focus", async () => {
  await render(<ToastProvider><ToastHarness /><Harness onClose={() => undefined} /></ToastProvider>);
  await click(document.getElementById("opener")!);
  await click(document.getElementById("bad")!);
  document.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.focus();
  expect(dialog()!.contains(document.activeElement)).toBe(true);
});

it.each(["Escape", "Tab", "Shift+Tab"])("Dialog handles %s after a focused toast is dismissed", async (key) => {
  const onClose = vi.fn();
  await render(<ToastProvider><ToastHarness /><Harness onClose={onClose} /></ToastProvider>);
  await click(document.getElementById("opener")!);
  await click(document.getElementById("bad")!);
  const dismiss = document.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!;
  dismiss.focus();
  await click(dismiss);
  expect(document.querySelector('[aria-label="Dismiss"]')).toBeNull();
  // Removing a focused node can leave body active without firing focusin.
  (document.activeElement as HTMLElement).blur();
  expect(document.activeElement).toBe(document.body);
  if (key === "Escape") {
    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  } else {
    const controls = Array.from(dialog()!.querySelectorAll<HTMLElement>("button, input"));
    const shiftKey = key === "Shift+Tab";
    await press("Tab", { shiftKey });
    expect(document.activeElement).toBe(shiftKey ? controls[controls.length - 1] : controls[0]);
    await press("Tab", { shiftKey: !shiftKey });
    expect(document.activeElement).toBe(shiftKey ? controls[0] : controls[controls.length - 1]);
  }
});

it("only the topmost overlay contains focus and handles keys, using current props", async () => {
  const closeFirst = vi.fn();
  const closeSecond = vi.fn();
  const updatedClose = vi.fn();
  const view = (secondOpen: boolean, dismissible = true, onClose = closeSecond) => <>
    <Dialog open onClose={closeFirst} title="First"><input id="first" /></Dialog>
    <Sheet open={secondOpen} dismissible={dismissible} onClose={onClose} title="Second"><input id="second" /></Sheet>
  </>;
  await render(view(false));
  await render(view(true));
  expect(document.activeElement).toBe(document.getElementById("second"));
  document.getElementById("first")!.focus();
  expect(document.querySelectorAll('[role="dialog"]')[1].contains(document.activeElement)).toBe(true);
  await render(view(true, false));
  await press("Escape");
  expect(closeFirst).not.toHaveBeenCalled();
  expect(closeSecond).not.toHaveBeenCalled();
  await render(view(true, true, updatedClose));
  await press("Escape");
  expect(updatedClose).toHaveBeenCalledTimes(1);
  expect(closeFirst).not.toHaveBeenCalled();
  await render(view(false));
  expect(document.activeElement).toBe(document.getElementById("first"));
  await press("Escape");
  expect(closeFirst).toHaveBeenCalledTimes(1);
});

it.each(["first", "second"])("overlapping dialogs restore the original overflow when %s closes first", async (firstClosed) => {
  const originalOverflow = document.body.style.overflow;
  document.body.style.overflow = "auto";
  const view = (first: boolean, second: boolean) => <>
    <Dialog open={first} onClose={() => undefined} title="First" />
    <Dialog open={second} onClose={() => undefined} title="Second" />
  </>;
  try {
    await render(view(true, false));
    await render(view(true, true));
    expect(document.body.style.overflow).toBe("hidden");
    await render(view(firstClosed !== "first", firstClosed !== "second"));
    expect(document.body.style.overflow).toBe("hidden");
    await render(view(false, false));
    expect(document.body.style.overflow).toBe("auto");
  } finally {
    await render(null);
    document.body.style.overflow = originalOverflow;
  }
});

it("Dialog closes on scrim press but not on a press inside the panel", async () => {
  const onClose = vi.fn();
  await openHarness({ onClose });
  const mouseDown = (target: Element) => act(async () => { target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  await mouseDown(dialog()!);
  expect(onClose).not.toHaveBeenCalled();
  await mouseDown(document.querySelector("[data-overlay-scrim]")!);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("a non-dismissible Dialog ignores Escape and the scrim and has no close button", async () => {
  const onClose = vi.fn();
  await openHarness({ onClose, dismissible: false });
  await press("Escape");
  await act(async () => { document.querySelector("[data-overlay-scrim]")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(onClose).not.toHaveBeenCalled();
  expect(dialog()).not.toBeNull();
  expect(dialog()!.querySelector('[aria-label="Close"]')).toBeNull();
});

it("Sheet shares the dialog semantics and closes from its close button", async () => {
  const onClose = vi.fn();
  await render(<Sheet open onClose={onClose} title="Attach"><button>File</button></Sheet>);
  expect(dialog()!.getAttribute("aria-modal")).toBe("true");
  expect(document.activeElement!.textContent).toBe("File");
  await click(dialog()!.querySelector('[aria-label="Close"]')!);
  expect(onClose).toHaveBeenCalledTimes(1);
});

const confirmProps = {
  title: "Remove this device?",
  description: "It will no longer receive messages.",
  confirmLabel: "Remove device",
  onConfirm: () => undefined,
  onCancel: () => undefined,
};
const buttonNamed = (name: string) =>
  Array.from(dialog()!.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === name)!;

it("ConfirmDialog is an alertdialog that focuses Cancel and reports each choice", async () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  await render(<ConfirmDialog open tone="danger" {...confirmProps} onConfirm={onConfirm} onCancel={onCancel} />);
  expect(dialog()!.getAttribute("role")).toBe("alertdialog");
  expect(document.activeElement).toBe(buttonNamed("Cancel"));
  await click(buttonNamed("Remove device"));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  await press("Escape");
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it("ConfirmDialog with an acknowledgement keeps confirm disabled until it is ticked, and resets on reopen", async () => {
  const onConfirm = vi.fn();
  const view = (open: boolean) => <ConfirmDialog open={open} tone="danger" {...confirmProps} acknowledgeLabel="I understand" onConfirm={onConfirm} />;
  await render(view(true));
  expect(buttonNamed("Remove device").disabled).toBe(true);
  await click(dialog()!.querySelector('input[type="checkbox"]')!);
  expect(buttonNamed("Remove device").disabled).toBe(false);
  await click(buttonNamed("Remove device"));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  await render(view(false));
  await render(view(true));
  expect(buttonNamed("Remove device").disabled).toBe(true);
});

it("ConfirmDialog while busy blocks dismissal and shows the error for retry", async () => {
  const onCancel = vi.fn();
  await render(<ConfirmDialog open {...confirmProps} busy error="Could not reach the server." onCancel={onCancel} />);
  await press("Escape");
  expect(onCancel).not.toHaveBeenCalled();
  expect(buttonNamed("Cancel").disabled).toBe(true);
  expect(buttonNamed("Remove device").getAttribute("aria-busy")).toBe("true");
  expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe("Could not reach the server.");
});

function ToastHarness() {
  const toast = useToast();
  return (
    <>
      <button id="ok" onClick={() => toast.show({ tone: "success", message: "Copied", duration: 1000 })}>ok</button>
      <button id="bad" onClick={() => toast.show({ tone: "danger", message: "Could not remove member" })}>bad</button>
    </>
  );
}

it("Toast announces, auto-dismisses timed toasts and keeps errors until dismissed", async () => {
  vi.useFakeTimers();
  await render(<ToastProvider><ToastHarness /></ToastProvider>);
  const region = document.querySelector('[aria-label="Notifications"]')!;
  await click(document.getElementById("ok")!);
  await click(document.getElementById("bad")!);
  expect(region.querySelector('[role="status"]')!.textContent).toContain("Copied");
  expect(region.querySelector('[role="alert"]')!.textContent).toContain("Could not remove member");
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(region.querySelector('[role="status"]')).toBeNull();
  expect(region.querySelector('[role="alert"]')).not.toBeNull();
  await click(region.querySelector('[aria-label="Dismiss"]')!);
  expect(region.children).toHaveLength(0);
});
