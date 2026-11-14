import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ForgetLocalKeysPrompt from "./ForgetLocalKeysPrompt.js";

let root: Root;
let container: HTMLDivElement;
const onSignInInstead = vi.fn();
const onForget = vi.fn();
const owner = { userId: "user-1", username: "alice", deviceId: "device-1" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (props: Partial<Parameters<typeof ForgetLocalKeysPrompt>[0]> = {}) => act(async () => root.render(
  <ForgetLocalKeysPrompt owner={owner} error="" loading={false} onSignInInstead={onSignInInstead} onForget={onForget} {...props} />,
));
const buttons = () => Array.from(container.querySelectorAll("button"));
const dialog = () => document.querySelector('[role="alertdialog"]')!;
const confirm = () => Array.from(dialog().querySelectorAll("button")).find((b) => b.textContent === "Forget keys")!;

it("offers the owning account and requires a dialog acknowledgement before forgetting its keys", async () => {
  await render();
  expect(container.textContent).toContain("This browser already holds encryption keys");
  expect(container.textContent).toContain("This browser holds the encryption keys for @alice. Signing in as a different account would delete them.");
  const [signIn, forget] = buttons();
  expect(signIn.textContent).toBe("Sign in as @alice instead");
  expect(forget.textContent).toBe("Forget @alice's keys on this browser…");
  expect(document.querySelector("input[type=checkbox]")).toBeNull();
  await act(async () => signIn.click());
  expect(onSignInInstead).toHaveBeenCalledTimes(1);
  await act(async () => forget.click());
  expect(onForget).not.toHaveBeenCalled();
  expect(confirm().disabled).toBe(true);
  expect(document.activeElement?.textContent).toBe("Cancel");
  await act(async () => confirm().click());
  expect(onForget).not.toHaveBeenCalled();
  await act(async () => dialog().querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
  expect(confirm().disabled).toBe(false);
  await act(async () => confirm().click());
  expect(onForget).toHaveBeenCalledTimes(1);
});

it("explains keys of the same account whose device is unknown, and keys without a known owner", async () => {
  await render({ sameAccount: true, error: "Failed to forget local keys" });
  expect(container.textContent).toContain("This browser holds encryption keys for @alice, but no longer knows which device they belong to. Continuing would replace them with a new device.");
  expect(container.querySelector("[role=alert]")?.textContent).toBe("Failed to forget local keys");
  expect(buttons()[0].textContent).toBe("Return to sign in");

  await render({ owner: null, loading: true });
  expect(container.textContent).toContain("This browser holds the encryption keys for another account.");
  expect(buttons().map((button) => button.textContent)).toEqual(["Return to sign in", "Forget this account's keys on this browser…"]);
  expect(buttons().every((button) => button.disabled)).toBe(true);
});

it("requires a fresh acknowledgement after cancellation and keeps failures in the busy dialog", async () => {
  await render();
  await act(async () => buttons()[1].click());
  await act(async () => dialog().querySelector<HTMLInputElement>("input")!.click());
  await act(async () => Array.from(dialog().querySelectorAll("button")).find((b) => b.textContent === "Cancel")!.click());
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  await act(async () => buttons()[1].click());
  expect(confirm().disabled).toBe(true);
  await act(async () => dialog().querySelector<HTMLInputElement>("input")!.click());
  await render({ loading: true });
  expect(confirm().disabled).toBe(true);
  expect(dialog().querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
  await render({ error: "Could not forget keys" });
  expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("Could not forget keys");
  expect(confirm().disabled).toBe(false);
});
