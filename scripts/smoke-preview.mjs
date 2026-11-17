import crypto from "node:crypto";
import { decryptFile, encryptFile, generateFileKey } from "../packages/crypto/dist/index.js";

const baseUrlInput = (process.env.SMOKE_BASE_URL ?? process.argv[2] ?? "").trim();
if (!baseUrlInput) {
  console.error("Usage: SMOKE_BASE_URL=https://... node scripts/smoke-preview.mjs");
  process.exit(1);
}

const baseUrl = baseUrlInput.replace(/\/$/, "");
const wsBaseUrl = baseUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
const password = "PreviewPass123!";
const suffix = `${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomBase64Url(length = 32) {
  return base64Url(crypto.randomBytes(length));
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = json && typeof json === "object" && "error" in json ? json.error : response.statusText;
    throw new Error(`${method} ${path} failed: ${detail}`);
  }
  return json;
}

async function uploadBinary(path, token, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`PUT ${path} failed: ${text || response.statusText}`);
  }
  return response.json().catch(() => ({}));
}

async function registerUser(label) {
  const username = `${label}-${suffix}`;
  const recoveryKey = `recovery-${label}-${suffix}-${crypto.randomBytes(10).toString("hex")}`;
  const deviceIdentityKey = randomBase64Url(32);
  const result = await request("/auth/register", {
    method: "POST",
    body: {
      username,
      displayName: label,
      password,
      recoveryKey,
      device: {
        name: `${label}-device`,
        identityKey: deviceIdentityKey,
      },
    },
  });

  return {
    username,
    recoveryKey,
    deviceIdentityKey,
    user: result.user,
    device: result.device,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  };
}

function openWebSocket(url, token) {
  return new Promise((resolve, reject) => {
    const ws = token ? new WebSocket(url, [`token.${token}`]) : new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out opening websocket: ${url}`));
    }, 10_000);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error while opening ${url}`));
    }, { once: true });
  });
}

function waitForJsonFrame(ws, predicate, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${description}`));
    }, timeoutMs);

    const onMessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        if (!predicate(frame)) return;
        cleanup();
        resolve(frame);
      } catch {
        // Ignore malformed frames.
      }
    };

    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket error while waiting for ${description}`));
    };

    function cleanup() {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
    }

    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError, { once: true });
  });
}

async function main() {
  console.log(`Running preview smoke test against ${baseUrl}`);

  const alice = await registerUser("alice");
  const bob = await registerUser("bob");
  console.log("Registered smoke users");

  const conversation = await request("/api/conversations", {
    method: "POST",
    token: alice.accessToken,
    body: {
      type: "direct",
      memberUserIds: [bob.user.id],
    },
  });
  const conversationId = conversation.id;
  if (!conversationId) throw new Error("Conversation creation did not return an id");
  console.log(`Created direct conversation ${conversationId}`);
  await request(`/api/conversations/${encodeURIComponent(conversationId)}/accept`, {
    method: "POST",
    token: bob.accessToken,
  });

  const pngBytes = Uint8Array.from(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0jQAAAAASUVORK5CYII=",
    "base64",
  ));
  const fileKey = generateFileKey();
  const encryptedImage = await encryptFile(pngBytes, fileKey);
  const upload = await request("/api/files/upload-url", {
    method: "POST",
    token: alice.accessToken,
    body: {
      conversationId,
      mimeType: "image/png",
      sizeBytes: encryptedImage.length,
    },
  });
  await uploadBinary(upload.uploadUrl, alice.accessToken, encryptedImage);

  const imageMessageId = crypto.randomUUID();
  await request("/api/messages/send", {
    method: "POST",
    token: alice.accessToken,
    body: {
      id: imageMessageId,
      conversationId,
      type: "file",
      ciphertext: randomBase64Url(24),
      iv: randomBase64Url(12),
      header: JSON.stringify({ smoke: true, image: true }),
      fileId: upload.fileId,
    },
  });

  const bobImageSync = await request(`/api/messages/sync?conversationId=${encodeURIComponent(conversationId)}&since=0&limit=100`, {
    token: bob.accessToken,
  });
  if (!bobImageSync.messages.some((message) => message.id === imageMessageId && message.type === "file")) {
    throw new Error("Image file message did not fan out to the direct recipient");
  }

  const downloadMeta = await request(`/api/files/download-url/${upload.fileId}`, {
    token: bob.accessToken,
  });
  const imageDownloadResponse = await fetch(`${baseUrl}${downloadMeta.downloadUrl}`, {
    headers: { Authorization: `Bearer ${bob.accessToken}` },
  });
  if (!imageDownloadResponse.ok) {
    throw new Error(`Image download failed with status ${imageDownloadResponse.status}`);
  }
  const encryptedDownloadedImage = new Uint8Array(await imageDownloadResponse.arrayBuffer());
  const decryptedImage = await decryptFile(encryptedDownloadedImage, fileKey);
  if (Buffer.compare(Buffer.from(decryptedImage), Buffer.from(pngBytes)) !== 0) {
    throw new Error("Downloaded image bytes did not round-trip correctly");
  }
  console.log("Image upload/send/download verified");

  const timedMessageId = crypto.randomUUID();
  const timedSend = await request("/api/messages/send", {
    method: "POST",
    token: alice.accessToken,
    body: {
      id: timedMessageId,
      conversationId,
      type: "text",
      ciphertext: randomBase64Url(24),
      iv: randomBase64Url(12),
      header: JSON.stringify({ smoke: true }),
      ttlSeconds: 10,
    },
  });
  if (!timedSend.expiresAt || timedSend.expiresAt <= Date.now()) {
    throw new Error("Timed message did not receive a valid server-side expiry");
  }

  const bobSync = await request(`/api/messages/sync?conversationId=${encodeURIComponent(conversationId)}&since=0&limit=100`, {
    token: bob.accessToken,
  });
  if (!bobSync.messages.some((message) => message.id === timedMessageId)) {
    throw new Error("Timed message did not fan out to the direct recipient");
  }
  console.log("Timed message delivered before expiry");

  await sleep(11_000);
  const bobSyncAfterExpiry = await request(`/api/messages/sync?conversationId=${encodeURIComponent(conversationId)}&since=0&limit=100`, {
    token: bob.accessToken,
  });
  if (bobSyncAfterExpiry.messages.some((message) => message.id === timedMessageId)) {
    throw new Error("Expired timed message still appears in sync results");
  }
  console.log("Timed message hidden after expiry");

  const alicePresence = await openWebSocket(`${wsBaseUrl}/ws/presence`, alice.accessToken);
  const bobPresence = await openWebSocket(`${wsBaseUrl}/ws/presence`, bob.accessToken);
  console.log("Opened presence websockets");

  const turn = await request("/api/calls/turn-credentials", {
    token: alice.accessToken,
  });
  if (!Array.isArray(turn.iceServers) || turn.iceServers.length === 0) {
    throw new Error("TURN credentials endpoint did not return ICE servers");
  }

  const incomingCallNotificationPromise = waitForJsonFrame(
    bobPresence,
    (frame) => frame.type === "call" && frame.payload?.event === "incoming",
    10_000,
    "incoming call notification",
  );
  const initiate = await request("/api/calls/initiate", {
    method: "POST",
    token: alice.accessToken,
    body: {
      conversationId,
      type: "audio",
    },
  });
  const callId = initiate.call?.id;
  if (!callId || !initiate.wsUrl) {
    throw new Error("Call initiate did not return call metadata");
  }

  const incomingCallFrame = await incomingCallNotificationPromise;
  if (incomingCallFrame.payload.callId !== callId) {
    throw new Error("Incoming call notification referenced the wrong call");
  }
  if (incomingCallFrame.payload.conversationId !== conversationId) {
    throw new Error("Incoming call notification referenced the wrong conversation");
  }
  console.log("Incoming call notification received");

  const aliceSignalWs = await openWebSocket(`${wsBaseUrl}${initiate.wsUrl}`, alice.accessToken);
  const bobSignalWs = await openWebSocket(`${wsBaseUrl}${initiate.wsUrl}`, bob.accessToken);
  console.log("Opened signaling websockets");

  const relayPromise = waitForJsonFrame(
    bobSignalWs,
    (frame) => frame.type === "signal" && frame.payload?.kind === "offer" && frame.payload?.sdp === "smoke-offer",
    10_000,
    "relayed signaling offer",
  );
  aliceSignalWs.send(JSON.stringify({
    type: "signal",
    payload: {
      kind: "offer",
      sdp: "smoke-offer",
      fromUserId: alice.user.id,
    },
  }));
  await relayPromise;
  console.log("Signaling websocket relay verified");

  const acceptedNotificationPromise = waitForJsonFrame(
    alicePresence,
    (frame) => frame.type === "call" && frame.payload?.event === "accepted" && frame.payload?.callId === callId,
    10_000,
    "accepted call notification",
  );
  const acceptedCall = await request(`/api/calls/${callId}/accept`, {
    method: "POST",
    token: bob.accessToken,
  });
  if (acceptedCall.call?.status !== "active") {
    throw new Error("Call accept did not activate the call");
  }
  await acceptedNotificationPromise;
  console.log("Call accept notification received");

  const endedNotificationPromise = waitForJsonFrame(
    bobPresence,
    (frame) => frame.type === "call" && frame.payload?.event === "ended" && frame.payload?.callId === callId,
    10_000,
    "ended call notification",
  );
  const endedCall = await request(`/api/calls/${callId}/end`, {
    method: "POST",
    token: alice.accessToken,
  });
  if (endedCall.call?.status !== "ended") {
    throw new Error("Call end did not transition the call to ended");
  }
  await endedNotificationPromise;
  console.log("Call end notification received");

  aliceSignalWs.close();
  bobSignalWs.close();
  alicePresence.close();
  bobPresence.close();

  console.log("Preview smoke test passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
