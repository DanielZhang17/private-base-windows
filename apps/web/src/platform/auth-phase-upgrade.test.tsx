import { fireEvent, getByRole, getByText, queryByText } from "@testing-library/dom";
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { setupDom } from "../ui/test-utils.js";

vi.mock("../pages/UnlockPage.js", () => ({ default: () => <div>Unlock</div> }));
vi.mock("../components/app/SessionRepairEffects.js", () => ({ default: () => null }));
vi.mock("../components/app/WebPushEffects.js", () => ({ default: () => null }));
vi.mock("../components/app/UiPreferencesEffects.js", () => ({ default: () => null }));
vi.mock("../features/updates/UpdateProvider.js", () => ({ UpdateProvider: ({ children }: { children: React.ReactNode }) => children }));

const { render, container } = setupDom();

it("shows the blocked upgrade on startup and reaches Unlock when the older tab closes", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const old = await openDB("e2ee-chat", 5, { upgrade(db) { db.createObjectStore("localKeys", { keyPath: "id" }); } });
  let close: (() => void) | undefined;
  try {
    await old.put("localKeys", { id: "identity", data: "encrypted" });
    const [{ default: App }, { useAuthStore }, database] = await Promise.all([
      import("../App.js"), import("../stores/authStore.js"), import("../db/index.js"),
    ]);
    useAuthStore.setState({ user: { id: "alice" }, device: { id: "device" }, sessionId: "session", accessToken: "token" } as never);
    await render(<MemoryRouter><App /></MemoryRouter>);
    await act(async () => { await vi.waitFor(() => expect(database.isDatabaseUpgradeBlocked()).toBe(true)); });
    expect(getByRole(container(), "alert").textContent).toContain("Close older Private Base tabs");
    expect(queryByText(container(), "Unlock")).toBeNull();
    await act(async () => {
      old.close();
      const connection = await database.getAppDB();
      close = () => connection.close();
      expect(await database.getKey("identity")).toMatchObject({ data: "encrypted" });
    });
    expect(getByText(container(), "Unlock")).toBeTruthy();
  } finally {
    old.close();
    close?.();
  }
});

it.each(["login", "register"])("keeps the %s submission mounted and resumes it when the blocked upgrade clears", async (route) => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  const older = await openDB("e2ee-chat", 5, { upgrade(db) { db.createObjectStore("localKeys", { keyPath: "id" }); } });
  try {
    await older.put("localKeys", { id: "identity", data: "encrypted" });
    const [{ default: App }, { useAuthStore }, database] = await Promise.all([
      import("../App.js"), import("../stores/authStore.js"), import("../db/index.js"),
    ]);
    useAuthStore.setState({ accessToken: null, refreshToken: null, device: null, user: null, sessionId: null });
    await render(<MemoryRouter initialEntries={[`/${route}`]}><App /></MemoryRouter>);
    const form = container().querySelector("form")!;
    const username = form.querySelector<HTMLInputElement>('input[autocomplete="username"]')!;
    await act(async () => {
      fireEvent.change(username, { target: { value: "alice" } });
      for (const input of form.querySelectorAll('input[type="password"]')) fireEvent.change(input, { target: { value: "example-password" } });
      fireEvent.submit(form);
      await vi.waitFor(() => expect(database.isDatabaseUpgradeBlocked()).toBe(true));
    });
    expect(getByRole(container(), "alert").textContent).toContain("Close older Private Base tabs");
    expect(container().querySelector("form")).toBe(form);
    expect(username.value).toBe("alice");
    await act(async () => { older.close(); await database.getKey("identity"); });
    expect(getByRole(container(), "heading", { name: "This browser already holds encryption keys" })).toBeTruthy();
    expect(queryByText(container(), /close older Private Base tabs/i)).toBeNull();
    (await database.getAppDB()).close();
  } finally { older.close(); }
});
