import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilities } from "./capabilities.js";
import { createPasskeyCredential, getPasskeyAssertion, isPasskeyAutofillAvailable, isWebAuthnSupported, PasskeyUnsupportedError } from "../lib/webauthn.js";

const create = vi.fn();
const get = vi.fn();
const conditional = vi.fn().mockResolvedValue(true);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("navigator", { credentials: { create, get } });
  vi.stubGlobal("PublicKeyCredential", class { static isConditionalMediationAvailable = conditional; });
});
afterEach(() => vi.unstubAllGlobals());

describe("passkey capability guard", () => {
  it.each(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"])("rejects registration and login on %s before touching credentials", async (url) => {
    vi.stubGlobal("window", { location: new URL(url), PublicKeyCredential });
    expect(capabilities.passkeys).toBe(false);
    expect(isWebAuthnSupported()).toBe(false);
    expect(await isPasskeyAutofillAvailable()).toBe(false);
    await expect(createPasskeyCredential(undefined as never)).rejects.toBeInstanceOf(PasskeyUnsupportedError);
    await expect(getPasskeyAssertion(undefined as never)).rejects.toMatchObject({ code: "PASSKEY_UNSUPPORTED" });
    expect(create).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(conditional).not.toHaveBeenCalled();
  });

  it("rejects a web browser without WebAuthn with a typed error", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(isWebAuthnSupported()).toBe(false);
    await expect(getPasskeyAssertion(undefined as never)).rejects.toBeInstanceOf(PasskeyUnsupportedError);
  });

  it("keeps browser passkey login and autofill working", async () => {
    expect(isWebAuthnSupported()).toBe(true);
    expect(await isPasskeyAutofillAvailable()).toBe(true);
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    get.mockResolvedValue({ id: "key", rawId: bytes, response: { clientDataJSON: bytes, authenticatorData: bytes, signature: bytes } });
    await expect(getPasskeyAssertion({ challenge: "AQID", rpId: "chat.718788.xyz", allowCredentials: [], userVerification: "preferred" } as never)).resolves.toMatchObject({
      id: "key", rawId: "AQID", type: "public-key", response: { signature: "AQID" },
    });
    expect(get).toHaveBeenCalledTimes(1);
  });
});

it.each([true, false, undefined])("passes native discoverability requirements and serializes credProps rk=%s", async (rk) => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const extensions = rk === undefined ? {} : { credProps: { rk } };
  create.mockResolvedValue({ id: "key", rawId: bytes,
    response: { clientDataJSON: bytes, attestationObject: bytes },
    getClientExtensionResults: () => extensions,
  });
  const credential = await createPasskeyCredential({
    challenge: "AQID", rp: { name: "Private Base", id: "chat.718788.xyz" },
    user: { id: "AQID", name: "sam", displayName: "Sam" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }], timeout: 60000, attestation: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
    extensions: { credProps: true }, excludeCredentials: [],
  });
  expect(create).toHaveBeenCalledWith({ publicKey: expect.objectContaining({
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
    extensions: { credProps: true },
  }) });
  expect(JSON.parse(JSON.stringify(credential)).clientExtensionResults).toEqual(extensions);
});
