import crypto from "node:crypto";

const baseUrlInput = (process.env.SMOKE_BASE_URL ?? process.argv[2] ?? "").trim();
if (!baseUrlInput) {
  console.error("Usage: SMOKE_BASE_URL=https://... node scripts/smoke-call-signal-replay.mjs");
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

async function registerUser(label) {
  const username = `${label}-${suffix}`;
  const recoveryKey = `recovery-${label}-${suffix}-${crypto.randomBytes(10).toString("hex")}`;
  const result = await request("/auth/register", {
    method: "POST",
    body: {
      username,
      displayName: label,
      password,
      recoveryKey,
      device: {
        name: `${label}-device`,
        identityKey: randomBase64Url(32),
      },
    },
  });

  return {
    username,
    user: result.user,
    accessToken: result.accessToken,
  };
}

function openWebSocket(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [`token.${token}`]);
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
  console.log(`Running signaling replay smoke test against ${baseUrl}`);

  const alice = await registerUser("sig-a");
  const bob = await registerUser("sig-b");
  console.log("Registered test users");

  const conversation = await request("/api/conversations", {
    method: "POST",
    token: alice.accessToken,
    body: {
      type: "direct",
      memberUserIds: [bob.user.id],
    },
  });

  const initiate = await request("/api/calls/initiate", {
    method: "POST",
    token: alice.accessToken,
    body: {
      conversationId: conversation.id,
      type: "audio",
    },
  });
  if (!initiate.wsUrl || !initiate.call?.id) {
    throw new Error("Call initiate did not return websocket metadata");
  }

  const aliceSignalWs = await openWebSocket(`${wsBaseUrl}${initiate.wsUrl}`, alice.accessToken);
  aliceSignalWs.send(JSON.stringify({
    type: "signal",
    payload: {
      kind: "offer",
      sdp: "buffered-offer",
      fromUserId: alice.user.id,
    },
  }));
  console.log("Sent caller offer before responder websocket connected");

  await sleep(1_000);

  const bobSignalWs = await openWebSocket(`${wsBaseUrl}${initiate.wsUrl}`, bob.accessToken);
  const replayedOffer = await waitForJsonFrame(
    bobSignalWs,
    (frame) => frame.type === "signal" && frame.payload?.kind === "offer" && frame.payload?.sdp === "buffered-offer",
    10_000,
    "buffered offer replay",
  );
  if (replayedOffer.payload.fromUserId !== alice.user.id) {
    throw new Error("Buffered offer replay referenced the wrong sender");
  }
  console.log("Late-joining responder received the buffered offer");

  const answerReceived = waitForJsonFrame(
    aliceSignalWs,
    (frame) => frame.type === "signal" && frame.payload?.kind === "answer" && frame.payload?.sdp === "buffered-answer",
    10_000,
    "live answer relay",
  );
  bobSignalWs.send(JSON.stringify({
    type: "signal",
    payload: {
      kind: "answer",
      sdp: "buffered-answer",
      fromUserId: bob.user.id,
    },
  }));
  await answerReceived;
  console.log("Caller received the responder answer");

  aliceSignalWs.close();
  bobSignalWs.close();

  console.log("Signaling replay smoke test passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
