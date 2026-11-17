import { act } from "react";
import { getByRole } from "@testing-library/dom";
import { expect, it, vi } from "vitest";
import { setLocalePreference, t } from "../i18n/index.js";
import { localized } from "../i18n/messages.js";
import { ToastProvider, useToast } from "./Toast.js";
import { click, setupDom } from "./test-utils.js";

const { render } = setupDom();
it("renders a queued toast's title, message, params and action in the current language", async () => {
  function Probe() {
    const toast = useToast();
    return <button onClick={() => toast.show({
      tone: "danger", duration: 0,
      title: localized("couldNotRemoveMember"),
      message: localized("finishRecoveryAs", { username: "alice" }),
      action: { label: localized("retry"), onClick: () => {} },
    })}>Show</button>;
  }
  await act(async () => { await setLocalePreference("de"); });
  await render(<ToastProvider><Probe /></ToastProvider>);
  await click(getByRole(document.body, "button", { name: "Show" }));
  const alert = getByRole(document.body, "alert");
  expect(alert.textContent).toContain(t("couldNotRemoveMember"));
  expect(alert.textContent).toContain(t("finishRecoveryAs", { username: "alice" }));
  expect(getByRole(alert, "button", { name: t("retry") })).toBeTruthy();
  await act(async () => { await setLocalePreference("en"); });
  expect(getByRole(document.body, "alert")).toBe(alert);
  expect(alert.textContent).toContain("Could not remove member");
  expect(alert.textContent).toContain("Finish recovery as @alice");
  expect(getByRole(alert, "button", { name: "Retry" })).toBeTruthy();
});

it.each([false, true])("renders JSX toast titles and messages as elements (keyed=%s)", async (keyed) => {
  function Probe() {
    const toast = useToast();
    return <button onClick={() => toast.show({
      duration: 0,
      title: keyed ? <strong key="genericError">JSX title</strong> : <strong>JSX title</strong>,
      message: keyed ? <a key="recoveryKeyCopied" href="#details">View details</a> : <a href="#details">View details</a>,
    })}>Show</button>;
  }
  await render(<ToastProvider><Probe /></ToastProvider>);
  await click(getByRole(document.body, "button", { name: "Show" }));
  const toast = getByRole(document.body, "status");
  expect(toast.querySelector("strong")?.textContent).toBe("JSX title");
  expect(getByRole(toast, "link", { name: "View details" }).getAttribute("href")).toBe("#details");
});

it("keeps Undo visible and actionable when a save notice appears at the toast cap", async () => {
  vi.useFakeTimers();
  const undo = vi.fn();
  function Probe() {
    const toast = useToast();
    return <button onClick={() => {
      toast.show({ message: localized("messageDeletedForYou"), action: { label: localized("undo"), onClick: undo } });
      toast.show({ message: "First notification" });
      toast.show({ message: "Second notification" });
    }}>Show</button>;
  }
  await render(<ToastProvider><Probe /></ToastProvider>);
  await click(getByRole(document.body, "button", { name: "Show" }));
  const undoButton = getByRole(document.body, "button", { name: "Undo" });
  await act(async () => vi.advanceTimersByTime(1000));
  await render(<ToastProvider controlledToast={{ tone: "success", title: localized("fileSaved"), message: "notes.pdf", onDismiss: vi.fn() }}>
    <Probe />
  </ToastProvider>);
  const notifications = getByRole(document.body, "region", { name: "Notifications" });
  expect(notifications.textContent).toContain("Savednotes.pdf");
  expect(getByRole(notifications, "button", { name: "Undo" })).toBe(undoButton);
  await act(async () => vi.advanceTimersByTime(3999));
  await click(undoButton);
  expect(undo).toHaveBeenCalledOnce();
});
