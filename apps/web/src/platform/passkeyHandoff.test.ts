import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { capabilities } from "./capabilities.js";
import { createPasskeyHandoff, startPasskeyHandoff } from "./passkeyHandoff.js";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>("node:crypto");
const state = "s".repeat(43);
const url = `https://chat.718788.xyz/native/passkey/sign-in?state=${state}&challenge=${"c".repeat(43)}`;
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, __PRIVATEBASE_NATIVE_CAPABILITIES__: { passkeyHandoff: true } });
  invoke.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
it("generates independent state and a 32-byte verifier with its correct S256 challenge", async () => {
  const result = await createPasskeyHandoff();
  expect(result.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(result.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(result.state).not.toBe(result.codeVerifier);
  const expected = new Uint8Array(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(result.codeVerifier)));
  expect(result.codeChallenge).toBe(btoa(String.fromCharCode(...expected)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  expect(await createPasskeyHandoff()).not.toEqual(result);
});
it("uses the exact phase 2 Tauri contract and returns a verified callback URL", async () => {
  invoke.mockResolvedValue(`privatebase://passkey?code=code&state=${state}`);
  expect((await startPasskeyHandoff(url)).searchParams.get("code")).toBe("code");
  expect(invoke).toHaveBeenCalledWith("passkey_handoff_start", { url, callbackScheme: "privatebase" });
  expect(capabilities.nativePasskeys).toBe(true); expect(capabilities.passkeys).toBe(false);
});
it("keeps older launchers and regular browsers disabled", async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  expect(capabilities.nativePasskeys).toBe(false);
  await expect(startPasskeyHandoff(url)).rejects.toMatchObject({ localizedMessage: { key: "nativePasskeyUnsupported" } });
  expect(invoke).not.toHaveBeenCalled();
  vi.stubGlobal("window", { location: new URL("https://chat.718788.xyz"), __PRIVATEBASE_NATIVE_CAPABILITIES__: { passkeyHandoff: true } });
  expect(capabilities.nativePasskeys).toBe(false);
});
it.each([
  `privatebase://passkey?code=code&state=wrong`,
  `privatebase://passkey/?code=code&state=${state}`,
  `privatebase://evil?code=code&state=${state}`,
  `https://passkey?code=code&state=${state}`,
  `privatebase://user@passkey?code=code&state=${state}`,
  `privatebase://passkey?registered=id&state=${state}`,
  `privatebase://passkey?code=code&state=${state}&state=${state}`,
  `privatebase://passkey?code=code&state=${state}&redirect=https://evil.test`,
])("rejects an invalid callback %s before redemption", async (callback) => {
  invoke.mockResolvedValue(callback);
  await expect(startPasskeyHandoff(url)).rejects.toMatchObject({ localizedMessage: { key: "nativePasskeyInvalidResponse" } });
});
it.each(["cancelled", "unsupported"])("preserves the %s rejection", async (reason) => {
  invoke.mockRejectedValue(reason);
  await expect(startPasskeyHandoff(url)).rejects.toMatchObject({ localizedMessage: { key: reason === "cancelled" ? "nativePasskeyCancelled" : "nativePasskeyUnsupported" } });
});
it("validates the browser destination and accepts a registration callback", async () => {
  await expect(startPasskeyHandoff(url.replace("chat.718788.xyz", "evil.test"))).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockResolvedValue(`privatebase://passkey?registered=pending&state=${state}`);
  expect((await startPasskeyHandoff(url.replace("/sign-in", "/add").replace("challenge=", "ticket="))).searchParams.get("registered")).toBe("pending");
});

it("disables a launcher whose advertised command is unavailable", async () => {
  invoke.mockRejectedValue("Command passkey_handoff_start not found");
  await expect(startPasskeyHandoff(url)).rejects.toMatchObject({ localizedMessage: { key: "nativePasskeyUnsupported" } });
  expect(capabilities.nativePasskeys).toBe(false);
});
