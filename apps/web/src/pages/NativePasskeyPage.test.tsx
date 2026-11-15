import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import NativePasskeyPage from "./NativePasskeyPage.js";
import { click, setupDom } from "../ui/test-utils.js";
import { createPasskeyCredential, getPasskeyAssertion } from "../lib/webauthn.js";
vi.mock("../lib/webauthn.js", () => ({ createPasskeyCredential: vi.fn(), getPasskeyAssertion: vi.fn() }));
// Importing the session or key stores would violate this page's isolation.
vi.mock("../stores/authStore.js", () => { throw new Error("Handoff page imported auth store"); });
vi.mock("../lib/key-manager.js", () => { throw new Error("Handoff page imported key manager"); });
const { render } = setupDom();
const state = "s".repeat(43);
const secret = "c".repeat(43);
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.mocked(getPasskeyAssertion).mockResolvedValue({ id: "assertion" } as never);
  vi.mocked(createPasskeyCredential).mockResolvedValue({ id: "registration" } as never);
});
afterEach(() => { vi.restoreAllMocks(); });
async function show(kind: string, query: string) {
  await render(<MemoryRouter initialEntries={[`/native/passkey/${kind}?${query}`]}><NativePasskeyPage /></MemoryRouter>);
}
it.each(["sign-in", "add"])("passes state through the %s page without storing tokens, keys, or secrets", async kind => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ challengeId: "challenge", options: {} })))
    .mockResolvedValueOnce(new Response(JSON.stringify(kind === "add" ? { pendingId: "pending" } : { code: "handoff-code" })));
  const storage = vi.spyOn(Storage.prototype, "setItem");
  await show(kind, new URLSearchParams({ state, [kind === "add" ? "ticket" : "challenge"]: secret }).toString());
  expect(fetchMock).not.toHaveBeenCalled();
  await click(document.querySelector("button")!);
  const link = document.querySelector<HTMLAnchorElement>("a")!;
  const callback = new URL(link.href);
  expect(callback.protocol).toBe("privatebase:"); expect(callback.host).toBe("passkey"); expect(callback.pathname).toBe("");
  expect(callback.searchParams.get("state")).toBe(state);
  expect(callback.searchParams.get(kind === "add" ? "registered" : "code")).toBe(kind === "add" ? "pending" : "handoff-code");
  expect(link.textContent).toBe("Return to Private Base"); expect(link.click).toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const [, init] of fetchMock.mock.calls) {
    expect(init).toMatchObject({ credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", headers: { "Content-Type": "application/json" } });
    expect(init.headers.Authorization).toBeUndefined();
  }
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(kind === "add" ? { ticket: secret } : { handoff: { codeChallenge: secret } });
  expect(storage).not.toHaveBeenCalled(); expect(window.location.search).toBe("");
});
it.each([
  `challenge=${secret}`,
  `challenge=${secret}&state=${state}&redirect=https://evil.test`,
  `challenge=${secret}&state=${state}&state=${state}`,
  `challenge=short&state=${state}`,
])("rejects invalid parameters without making requests: %s", async query => {
  await show("sign-in", query);
  expect(document.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("invalid");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("keeps errors free of response secrets and offers no callback on failure", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "secret-ticket" }), { status: 401 }));
  await show("add", `ticket=${secret}&state=${state}`); await click(document.querySelector("button")!);
  expect(document.body.textContent).not.toContain("secret-ticket");
  expect(document.querySelector("a")).toBeNull();
});
