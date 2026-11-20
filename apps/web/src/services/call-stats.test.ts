import { expect, it } from "vitest";
import { createCallStatsReader } from "./call-stats.js";

function report(...stats: Array<{ id: string; type: string } & Record<string, unknown>>) {
  return new Map(stats.map((stat) => [stat.id, stat])) as unknown as RTCStatsReport;
}

it("reads the selected transport and measures RTP loss and bitrate across samples", () => {
  const { read } = createCallStatsReader();
  function sample(timestamp: number, bytes: number, received: number, lost: number, selected = "selected") {
    return read(report(
      { id: "transport", type: "transport", selectedCandidatePairId: selected },
      { id: "old", type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 4 },
      { id: "selected", type: "candidate-pair", state: "succeeded", localCandidateId: "local", remoteCandidateId: "remote", currentRoundTripTime: 0.054, availableOutgoingBitrate: 2_000_000 },
      { id: "local", type: "local-candidate", candidateType: "relay", protocol: "udp", relayProtocol: "tls" },
      { id: "remote", type: "remote-candidate", candidateType: "srflx" },
      { id: "vp8", type: "codec", mimeType: "video/VP8" },
      { id: "flexfec", type: "codec", mimeType: "video/flexfec" },
      { id: "opus", type: "codec", mimeType: "audio/opus" },
      { id: "repair", type: "outbound-rtp", kind: "video", codecId: "flexfec", timestamp, bytesSent: bytes * 2 },
      { id: "send", type: "outbound-rtp", kind: "video", transportId: "transport", codecId: "vp8", remoteId: "loss", timestamp, bytesSent: bytes, frameWidth: 640, frameHeight: 360, qualityLimitationReason: "bandwidth" },
      { id: "receive", type: "inbound-rtp", mediaType: "audio", codecId: "opus", timestamp, bytesReceived: bytes, packetsReceived: received, packetsLost: lost },
      { id: "loss", type: "remote-inbound-rtp", fractionLost: 0.03 },
    ));
  }
  expect(sample(1000, 450_000, 400, 50).diagnostics.videoSent?.bitrateBps).toBeUndefined();
  expect(sample(3000, 650_000, 490, 60)).toEqual({
    pathChanged: false, availableOutgoingBitrate: 2_000_000, videoBandwidthLimited: true,
    diagnostics: {
      localCandidateType: "relay", remoteCandidateType: "srflx", roundTripTimeMs: 54, transport: "udp", turnTransport: "tls",
      audioReceived: { bitrateBps: 800_000, packetLoss: 0.1, codec: "Opus" },
      videoSent: { bitrateBps: 800_000, packetLoss: 0.03, codec: "VP8", resolution: { width: 640, height: 360 } },
    },
  });
  const switched = sample(5000, 850_000, 590, 62, "old");
  expect(switched.pathChanged).toBe(true);
  expect(switched.diagnostics.roundTripTimeMs).toBe(4000);
  expect(switched.diagnostics.videoSent?.bitrateBps).toBeUndefined();
  expect(switched.diagnostics.audioReceived?.packetLoss).toBeUndefined();
  const reset = sample(7000, 100, 2, 0, "old");
  expect(reset.diagnostics.audioReceived?.bitrateBps).toBeUndefined();
  expect(reset.diagnostics.audioReceived?.packetLoss).toBeUndefined();
});

it("uses only recognized public values in the snapshot and never copies identifying stats", () => {
  const { read } = createCallStatsReader();
  const snapshot = read(report(
    { id: "202.2.2.2", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "local", remoteCandidateId: "remote", currentRoundTripTime: 0.1, privateKey: "secret" },
    { id: "local", type: "local-candidate", address: "202.2.2.2", candidateType: "host", protocol: "udp", relayProtocol: "tls", usernameFragment: "username" },
    { id: "remote", type: "remote-candidate", address: "203.5.6.7", candidateType: "203.5.6.7" },
    { id: "cert", type: "certificate", fingerprint: "SDP fingerprint" },
    { id: "codec", type: "codec", mimeType: "video/user@example.com", sdpFmtpLine: "sensitive codec parameters" },
    { id: "user@example.com", type: "inbound-rtp", kind: "video", trackIdentifier: "user@example.com", codecId: "codec", timestamp: 1000, bytesReceived: 0, frameWidth: 640, frameHeight: 360 },
  )).diagnostics;
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual({
    localCandidateType: "host", transport: "udp", roundTripTimeMs: 100, videoReceived: { resolution: { width: 640, height: 360 } },
  });
});

it("uses legacy selected stats and leaves ambiguous or missing selected pairs unknown", () => {
  const { read } = createCallStatsReader();
  const first = { id: "first", type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.3 };
  const second = { id: "second", type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.2 };
  expect(read(report(first, second)).diagnostics.roundTripTimeMs).toBeUndefined();
  expect(read(report(first, { ...second, selected: true })).diagnostics.roundTripTimeMs).toBe(200);
  expect(read(report(first, { id: "transaction", type: "transport", selectedCandidatePairId: "missing" })).diagnostics.roundTripTimeMs).toBeUndefined();
});

it("keeps cached receiver-report loss available for display and preserves freshness across interval resets", () => {
  const { read, resetIntervals } = createCallStatsReader();
  const outbound = { id: "video", type: "outbound-rtp", kind: "video", remoteId: "receiver" };
  function sample(timestamp?: number) {
    return read(report(outbound, { id: "receiver", type: "remote-inbound-rtp", timestamp, fractionLost: 0.12 }));
  }
  expect(sample().freshVideoLoss).toBeUndefined();
  expect(sample(1500).freshVideoLoss).toBe(0.12);
  const cached = sample(1500);
  expect(cached.diagnostics.videoSent?.packetLoss).toBe(0.12);
  expect(cached.freshVideoLoss).toBeUndefined();
  resetIntervals();
  read(report(outbound));
  const reconnected = sample(1500);
  expect(reconnected.freshVideoLoss).toBeUndefined();
  expect(reconnected.diagnostics.videoSent?.packetLoss).toBeUndefined();
  expect(sample(1200).freshVideoLoss).toBeUndefined();
  expect(sample(6000).freshVideoLoss).toBe(0.12);
});

it("omits old-path outgoing loss until each stream has a newer receiver report", () => {
  const { read } = createCallStatsReader();
  function sample(pairId: string, timestamp: number, audioReportAt = 1000, videoReportAt = 1500) {
    return read(report(
      { id: pairId, type: "candidate-pair", state: "succeeded", selected: true, timestamp },
      { id: "audio", type: "outbound-rtp", kind: "audio", remoteId: "audio-loss" },
      { id: "video", type: "outbound-rtp", kind: "video", remoteId: "video-loss" },
      { id: "audio-loss", type: "remote-inbound-rtp", timestamp: audioReportAt, fractionLost: 0.2 },
      { id: "video-loss", type: "remote-inbound-rtp", timestamp: videoReportAt, fractionLost: 0.3 },
    ));
  }
  sample("old", 2000);
  expect(sample("old", 2500).diagnostics.videoSent?.packetLoss).toBe(0.3);
  expect(sample("new", 3000).diagnostics.videoSent?.packetLoss).toBeUndefined();
  const cached = sample("new", 4000, 1000, 2700);
  expect(cached.freshVideoLoss).toBeUndefined();
  expect(JSON.parse(JSON.stringify(cached.diagnostics))).toEqual({ audioSent: {}, videoSent: {} });

  const updated = sample("new", 5000, 1000, 4500);
  expect(updated.diagnostics.audioSent?.packetLoss).toBeUndefined();
  expect(updated.diagnostics.videoSent?.packetLoss).toBe(0.3);
  expect(updated.freshVideoLoss).toBe(0.3);
  expect(sample("new", 6000, 5500, 4500).diagnostics.audioSent?.packetLoss).toBe(0.2);
});

it("keeps RTT diagnostics available while consuming each selected-pair response once", () => {
  const { read, resetIntervals } = createCallStatsReader();
  function sample(id: string, responsesReceived?: number) {
    return read(report({ id, type: "candidate-pair", state: "succeeded", selected: true, currentRoundTripTime: 0.3, responsesReceived }));
  }
  expect(sample("a").freshRttMs).toBeUndefined();
  expect(sample("a", 1).freshRttMs).toBe(300);
  const cached = sample("a", 1);
  expect(cached.freshRttMs).toBeUndefined();
  expect(cached.diagnostics.roundTripTimeMs).toBe(300);
  expect(sample("a", 2).freshRttMs).toBe(300);
  expect(sample("b", 1).freshRttMs).toBe(300);
  resetIntervals();
  expect(sample("a", 2).freshRttMs).toBeUndefined();
});
