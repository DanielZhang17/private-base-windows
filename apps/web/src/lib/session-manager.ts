/**
 * Manages Double Ratchet sessions for 1:1 messaging.
 * - Establishes new sessions via X3DH on first contact
 * - Persists session state in IndexedDB between page loads
 * - Provides encrypt/decrypt operations against the active session
 */
import {
  x3dhInitiate,
  x3dhRespond,
  initSessionAsInitiator,
  initSessionAsResponder,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeSession,
  deserializeSession,
  fromBase64Url,
  toBase64Url,
  type RatchetSession,
  type EncryptResult,
} from "@e2ee-chat/crypto";
import type { InitialMessageHeader, RatchetHeader } from "@e2ee-chat/shared";
import { deleteSession, hasReceivedMessage, getSession, saveSession, type LocalSession } from "../db/index.js";
import { api } from "../services/api.js";
import { consumeOneTimePreKey, findOneTimePreKey, getIdentityKeyPair, getSignedPreKey } from "./key-manager.js";
import { decryptPayload, finishReceive, withReceiveLock, withSessionLock, ReceiveDecryptionError, type ReceiveContext } from "./receive.js";

function sessionKey(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

/**
 * Get an existing Double Ratchet session for a remote device,
 * or initiate a new X3DH session if none exists yet.
 */
export async function getOrCreateSession(
  remoteUserId: string,
  remoteDeviceId: string,
): Promise<{ session: RatchetSession; initialHeader?: InitialMessageHeader }> {
  const key = sessionKey(remoteUserId, remoteDeviceId);
  const stored = await getSession(key);
  if (stored) {
    return { session: deserializeSession(JSON.parse(stored.state)), initialHeader: stored.initialHeader };
  }

  const localKeys = getIdentityKeyPair();

  const bundle = await api.get<{
    deviceId: string;
    identityKey: string;
    signedPreKey: string;
    signedPreKeyId: number;
    signedPreKeySig: string;
    oneTimePreKey?: { id: number; key: string };
  }>(`/api/keys/bundle/${remoteUserId}/${remoteDeviceId}`);

  const result = await x3dhInitiate(
    localKeys.privateX25519,
    localKeys.publicEd25519,
    bundle,
  );

  const session = await initSessionAsInitiator(
    result.sharedSecret,
    fromBase64Url(bundle.signedPreKey),
  );
  const initialHeader: InitialMessageHeader = {
    identityKey: toBase64Url(localKeys.publicEd25519),
    ephemeralKey: toBase64Url(result.ephemeralPublicKey),
    oneTimePreKeyId: result.usedOneTimePreKeyId,
    signedPreKeyId: result.usedSignedPreKeyId,
  };
  // Keep public bootstrap metadata until a successfully decrypted reply confirms the session.
  // Discarding an unsent envelope must not strand the already advanced sending chain.
  await persistSession(key, session, initialHeader.ephemeralKey, initialHeader);
  return { session, initialHeader };
}

/**
 * Authenticate an initial message before replacing a session or consuming its OTP.
 */
export async function decryptInitialMessage(
  remoteUserId: string,
  remoteDeviceId: string,
  header: InitialMessageHeader,
  ratchetHeader: RatchetHeader,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  receive: ReceiveContext,
): Promise<Uint8Array | null> {
  const key = sessionKey(remoteUserId, remoteDeviceId);
  return withReceiveLock(receive, key, async () => {
    if (await hasReceivedMessage(receive.messageId)) return null;
    const existing = await getSession(key);
    if (existing && (!existing.x3dhEphemeralKey || existing.x3dhEphemeralKey === header.ephemeralKey)) {
      // Even legacy states must never be rebuilt after a failed decrypt.
      const session = deserializeSession(JSON.parse(existing.state));
      const plaintext = await decryptPayload(() => ratchetDecrypt(session, ratchetHeader, ciphertext, iv));
      return finishReceive(receive, plaintext, {
        session: await sessionRecord(key, session, header.ephemeralKey, null),
      });
    }

    if (existing?.retiredEphemeralKeys?.includes(header.ephemeralKey)) {
      throw new ReceiveDecryptionError(new Error("Retired X3DH ephemeral key"));
    }

    const localKeys = getIdentityKeyPair();
    const signedPreKey = getSignedPreKey();
    if (!signedPreKey) throw new Error("Signed pre-key not loaded");

    const remoteIdentityPublic = fromBase64Url(header.identityKey);
    const remoteEphemeral = fromBase64Url(header.ephemeralKey);

    let otpPrivate: Uint8Array | null = null;
    if (header.oneTimePreKeyId !== undefined) {
      const otp = await findOneTimePreKey(header.oneTimePreKeyId);
      if (!otp) throw new Error("One-time pre-key not available");
      otpPrivate = otp.keyPair.privateKey;
    }

    const decrypted = await decryptPayload(async () => {
      const sharedSecret = await x3dhRespond(
        localKeys.privateX25519,
        signedPreKey.keyPair.privateKey,
        otpPrivate,
        remoteIdentityPublic,
        remoteEphemeral,
      );

      const session = await initSessionAsResponder(sharedSecret, signedPreKey.keyPair);
      const plaintext = await ratchetDecrypt(session, ratchetHeader, ciphertext, iv);
      return { session, plaintext };
    });
    const result = await finishReceive(receive, decrypted.plaintext, {
      session: await sessionRecord(key, decrypted.session, header.ephemeralKey, null),
      oneTimePreKeyId: header.oneTimePreKeyId,
    });
    if (result && header.oneTimePreKeyId !== undefined) {
      // State and output are durable; retain the existing best-effort OTP cleanup.
      await consumeOneTimePreKey(header.oneTimePreKeyId).catch((error) => {
        console.error("Failed to remove a used one-time pre-key", error);
      });
    }
    return result;
  });
}

/** Encrypt a plaintext message for a remote device. Saves updated session state. */
export async function encryptForDevice(
  remoteUserId: string,
  remoteDeviceId: string,
  plaintext: Uint8Array,
): Promise<{ result: EncryptResult; isInitial: boolean; initialHeader?: InitialMessageHeader }> {
  const key = sessionKey(remoteUserId, remoteDeviceId);
  return withSessionLock(key, async () => {
    let { session, initialHeader } = await getOrCreateSession(remoteUserId, remoteDeviceId);
    let result: EncryptResult;

    try {
      result = await ratchetEncrypt(session, plaintext);
    } catch (err) {
      // Recover from corrupted responder-only state by rebuilding as initiator.
      if (!(err instanceof Error) || err.message !== "Session not ready to send") throw err;

      await deleteSession(key);
      const recreated = await getOrCreateSession(remoteUserId, remoteDeviceId);
      session = recreated.session;
      initialHeader = recreated.initialHeader;
      result = await ratchetEncrypt(session, plaintext);
    }

    await persistSession(key, session);
    return { result, isInitial: !!initialHeader, initialHeader };
  });
}

/** Decrypt and commit the receive state together with its output. */
export async function decryptFromDevice(
  remoteUserId: string,
  remoteDeviceId: string,
  header: RatchetHeader,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  receive: ReceiveContext,
): Promise<Uint8Array | null> {
  const key = sessionKey(remoteUserId, remoteDeviceId);
  return withReceiveLock(receive, key, async () => {
    if (await hasReceivedMessage(receive.messageId)) return null;
    const stored = await getSession(key);
    if (!stored) throw new ReceiveDecryptionError(new Error(`No session for ${remoteUserId}:${remoteDeviceId}`));
    const session = deserializeSession(JSON.parse(stored.state));
    const plaintext = await decryptPayload(() => ratchetDecrypt(session, header, ciphertext, iv));
    return finishReceive(receive, plaintext, {
      session: await sessionRecord(key, session, undefined, null),
    });
  });
}

async function sessionRecord(key: string, session: RatchetSession, x3dhEphemeralKey?: string, initialHeader?: InitialMessageHeader | null): Promise<LocalSession> {
  const existing = await getSession(key);
  let retiredEphemeralKeys = existing?.retiredEphemeralKeys;
  if (existing?.x3dhEphemeralKey && x3dhEphemeralKey && existing.x3dhEphemeralKey !== x3dhEphemeralKey) {
    retiredEphemeralKeys = [...new Set([
      ...(retiredEphemeralKeys ?? []).filter((key) => key !== existing.x3dhEphemeralKey),
      existing.x3dhEphemeralKey,
    ])].slice(-20);
  }
  return {
    id: key,
    state: JSON.stringify(serializeSession(session)),
    updatedAt: Date.now(),
    x3dhEphemeralKey: x3dhEphemeralKey ?? existing?.x3dhEphemeralKey,
    retiredEphemeralKeys,
    initialHeader: initialHeader === null ? undefined : initialHeader ?? existing?.initialHeader,
  };
}

async function persistSession(key: string, session: RatchetSession, x3dhEphemeralKey?: string, initialHeader?: InitialMessageHeader | null): Promise<void> {
  await saveSession(await sessionRecord(key, session, x3dhEphemeralKey, initialHeader));
}

export async function resetSession(remoteUserId: string, remoteDeviceId: string): Promise<void> {
  const key = sessionKey(remoteUserId, remoteDeviceId);
  await withSessionLock(key, () => deleteSession(key));
}
