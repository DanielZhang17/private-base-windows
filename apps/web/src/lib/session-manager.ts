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
  ratchetAdvanceOnly,
  serializeSession,
  deserializeSession,
  fromBase64Url,
  toBase64Url,
  type RatchetSession,
  type EncryptResult,
  type EditKeyToSeal,
} from "@e2ee-chat/crypto";
import type { InitialMessageHeader, RatchetHeader } from "@e2ee-chat/shared";
import { deleteSession, hasReceivedMessage, getSession, saveSession, type LocalSession } from "../db/index.js";
import { api } from "../services/api.js";
import { consumeOneTimePreKey, findOneTimePreKey, getIdentityKeyPair, getSignedPreKey } from "./key-manager.js";
import { matchEditSigningIdentity } from "./message-edit.js";
import { checkReceiveGap, decryptPayload, finishReceive, withReceiveLock, withSessionLock, ReceiveDecryptionError, ReceivePredecessorError, type ReceiveContext, type ReceiveGap } from "./receive.js";

export interface GroupCallPreKeyScope {
  conversationId: string;
  callId: string;
  sessionId: string;
  epoch: number;
  inviteUntil?: number;
}

function sessionKey(userId: string, deviceId: string, callDirection?: "in" | "out"): string {
  return callDirection ? `group-call:${callDirection}:${userId}:${deviceId}` : `${userId}:${deviceId}`;
}

async function requireEarlierEnvelopes(session: RatchetSession | undefined, header: RatchetHeader, receive: ReceiveContext) {
  const next = session?.recvMessageNumber ?? 0;
  const dhPublicKey = session?.dhRemotePublicKey && toBase64Url(session.dhRemotePublicKey);
  const sameChain = dhPublicKey === header.dhPublicKey;
  const gaps: ReceiveGap[] = [];
  const from = sameChain ? next : 0;
  if (header.n > from) gaps.push({ chain: header.dhPublicKey, from, until: header.n });
  if (!sameChain && dhPublicKey && session?.receivingChainKey && header.pn > next) {
    gaps.push({ chain: dhPublicKey, from: next, until: header.pn });
  }
  if (gaps.length) await checkReceiveGap(receive, ...gaps);
}

async function receiveRatchetEnvelope(
  session: RatchetSession, header: RatchetHeader, ciphertext: Uint8Array, iv: Uint8Array, receive: ReceiveContext, peerIdentityKey?: string,
): Promise<Uint8Array | undefined> {
  if (receive.advanceOnly) {
    await ratchetAdvanceOnly(session, header, ciphertext, iv);
    return;
  }
  return ratchetDecrypt(session, header, ciphertext, iv, matchEditSigningIdentity(receive.editKey, peerIdentityKey));
}

/**
 * Get an existing Double Ratchet session for a remote device,
 * or initiate a new X3DH session if none exists yet.
 */
export async function getOrCreateSession(
  remoteUserId: string,
  remoteDeviceId: string,
  callControl?: GroupCallPreKeyScope,
): Promise<{ session: RatchetSession; initialHeader?: InitialMessageHeader }> {
  const key = sessionKey(remoteUserId, remoteDeviceId, callControl ? "out" : undefined);
  const stored = await getSession(key);
  if (stored) {
    return { session: deserializeSession(JSON.parse(stored.state)), initialHeader: stored.initialHeader };
  }

  const localKeys = getIdentityKeyPair();

  const query = callControl && new URLSearchParams({ callControl: "1", conversationId: callControl.conversationId,
    callId: callControl.callId, sessionId: callControl.sessionId, epoch: String(callControl.epoch) });
  if (query && callControl?.inviteUntil !== undefined) query.set("inviteUntil", String(callControl.inviteUntil));
  const bundle = await api.get<{
    deviceId: string;
    identityKey: string;
    signedPreKey: string;
    signedPreKeyId: number;
    signedPreKeySig: string;
    oneTimePreKey?: { id: number; key: string };
  }>(`/api/keys/bundle/${remoteUserId}/${remoteDeviceId}${query ? `?${query}` : ""}`);

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
  await saveSession(await sessionRecord(key, session, initialHeader.ephemeralKey, initialHeader, bundle.identityKey));
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
  callControl = false,
): Promise<Uint8Array | null> {
  const key = sessionKey(remoteUserId, remoteDeviceId, callControl ? "in" : undefined);
  return withReceiveLock(receive, key, async () => {
    if (await hasReceivedMessage(receive.messageId, receive.ownerId, receive.deviceId)) return null;
    const existing = await getSession(key);
    if (existing && (!existing.x3dhEphemeralKey || existing.x3dhEphemeralKey === header.ephemeralKey)) {
      // Even legacy states must never be rebuilt after a failed decrypt.
      const session = deserializeSession(JSON.parse(existing.state));
      await requireEarlierEnvelopes(session, ratchetHeader, receive);
      const plaintext = await decryptPayload(() => receiveRatchetEnvelope(session, ratchetHeader, ciphertext, iv, receive, existing.peerIdentityKey));
      const committed = await finishReceive(receive, plaintext, {
        session: await sessionRecord(key, session, header.ephemeralKey, null),
      });
      return committed ? plaintext ?? null : null;
    }

    if (existing?.retiredEphemeralKeys?.includes(header.ephemeralKey)) {
      throw new ReceiveDecryptionError(new Error("Retired X3DH ephemeral key"));
    }

    await requireEarlierEnvelopes(undefined, ratchetHeader, receive);

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
      const plaintext = await receiveRatchetEnvelope(session, ratchetHeader, ciphertext, iv, receive, header.identityKey);
      return { session, plaintext };
    });
    const committed = await finishReceive(receive, decrypted.plaintext, {
      session: await sessionRecord(key, decrypted.session, header.ephemeralKey, null, header.identityKey),
      oneTimePreKeyId: header.oneTimePreKeyId,
    });
    if (committed && header.oneTimePreKeyId !== undefined) {
      // State and output are durable; retain the existing best-effort OTP cleanup.
      await consumeOneTimePreKey(header.oneTimePreKeyId).catch((error) => {
        console.error("Failed to remove a used one-time pre-key", error);
      });
    }
    return committed ? decrypted.plaintext ?? null : null;
  });
}

/** Encrypt a plaintext message for a remote device. Saves updated session state. */
export async function encryptForDevice(
  remoteUserId: string,
  remoteDeviceId: string,
  plaintext: Uint8Array,
  editKey?: EditKeyToSeal,
  callControl?: GroupCallPreKeyScope,
): Promise<{ result: EncryptResult; isInitial: boolean; initialHeader?: InitialMessageHeader }> {
  const key = sessionKey(remoteUserId, remoteDeviceId, callControl ? "out" : undefined);
  return withSessionLock(key, async () => {
    let { session, initialHeader } = await getOrCreateSession(remoteUserId, remoteDeviceId, callControl);
    let result: EncryptResult;

    try {
      result = await ratchetEncrypt(session, plaintext, editKey);
    } catch (err) {
      // Recover from corrupted responder-only state by rebuilding as initiator.
      if (!(err instanceof Error) || err.message !== "Session not ready to send") throw err;

      await deleteSession(key);
      const recreated = await getOrCreateSession(remoteUserId, remoteDeviceId, callControl);
      session = recreated.session;
      initialHeader = recreated.initialHeader;
      result = await ratchetEncrypt(session, plaintext, editKey);
    }

    await saveSession(await sessionRecord(key, session));
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
  callControl = false,
): Promise<Uint8Array | null> {
  const key = sessionKey(remoteUserId, remoteDeviceId, callControl ? "in" : undefined);
  return withReceiveLock(receive, key, async () => {
    if (await hasReceivedMessage(receive.messageId, receive.ownerId, receive.deviceId)) return null;
    const stored = await getSession(key);
    if (!stored) throw new ReceivePredecessorError();
    const session = deserializeSession(JSON.parse(stored.state));
    await requireEarlierEnvelopes(session, header, receive);
    const plaintext = await decryptPayload(() => receiveRatchetEnvelope(session, header, ciphertext, iv, receive, stored.peerIdentityKey));
    const committed = await finishReceive(receive, plaintext, {
      session: await sessionRecord(key, session, undefined, null),
    });
    return committed ? plaintext ?? null : null;
  });
}

async function sessionRecord(key: string, session: RatchetSession, x3dhEphemeralKey?: string, initialHeader?: InitialMessageHeader | null, peerIdentityKey?: string): Promise<LocalSession> {
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
    peerIdentityKey: peerIdentityKey ?? existing?.peerIdentityKey,
    x3dhEphemeralKey: x3dhEphemeralKey ?? existing?.x3dhEphemeralKey,
    retiredEphemeralKeys,
    initialHeader: initialHeader === null ? undefined : initialHeader ?? existing?.initialHeader,
  };
}

export async function resetSession(remoteUserId: string, remoteDeviceId: string): Promise<void> {
  const key = sessionKey(remoteUserId, remoteDeviceId);
  await withSessionLock(key, () => deleteSession(key));
}
