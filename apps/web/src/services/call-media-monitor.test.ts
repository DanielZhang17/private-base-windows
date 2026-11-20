import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startCallMediaMonitor } from "./call-media-monitor.js";

function setup(currentRoundTripTime = 0.075, { rttCounter = true, lossFeedback = true } = {}) {
  let availableOutgoingBitrate: number | undefined = 2_500_000;
  let responsesReceived = 1;
  let pairId = "pair";
  let receiverReport: { timestamp: number; fractionLost: number } | undefined;
  let transaction = 0;
  let encodings: RTCRtpEncodingParameters[] = [{ rid: "original", maxFramerate: 28, priority: "high" }];
  const track = { readyState: "live", enabled: true };
  const sender = {
    track,
    getParameters: vi.fn(() => ({ transactionId: String(++transaction), encodings: encodings.map((encoding) => ({ ...encoding })) })),
    setParameters: vi.fn(async (parameters: { transactionId: string; encodings: RTCRtpEncodingParameters[] }) => {
      encodings = parameters.encodings;
    }),
  };
  const pc = Object.assign(new EventTarget(), {
    connectionState: "connected", iceConnectionState: "connected", signalingState: "stable",
    getStats: vi.fn(async () => {
      const stats = new Map<string, object>([[pairId, {
        type: "candidate-pair", id: pairId, nominated: true, state: "succeeded", currentRoundTripTime, availableOutgoingBitrate,
        ...(rttCounter ? { responsesReceived } : {}),
      }]]);
      if (receiverReport) {
        stats.set("video", { id: "video", type: "outbound-rtp", kind: "video", remoteId: "loss" });
        stats.set("loss", {
          id: "loss", type: "remote-inbound-rtp", timestamp: receiverReport.timestamp,
          ...(lossFeedback ? { fractionLost: receiverReport.fractionLost } : {}),
        });
      }
      return stats as unknown as RTCStatsReport;
    }),
  });
  const publish = vi.fn();
  const isCurrent = vi.fn(() => true);
  const stop = startCallMediaMonitor(pc as unknown as RTCPeerConnection, sender as unknown as RTCRtpSender, isCurrent, publish);
  return {
    pc, sender, isCurrent, publish, stop,
    setBandwidth: (value: number | undefined) => { availableOutgoingBitrate = value; },
    setRtt: (seconds: number, responses: number) => { currentRoundTripTime = seconds; responsesReceived = responses; },
    setPair: (id: string) => { pairId = id; },
    setLoss: (timestamp: number, fractionLost: number) => { receiverReport = { timestamp, fractionLost }; },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it.each([0.075, 0.3, 0.47])("restores original constraints in steps on a stable path with %s s RTT", async (rtt) => {
  const { sender, setBandwidth, setLoss } = setup(rtt);
  const original = { rid: "original", maxFramerate: 28, priority: "high" };
  const medium = { ...original, maxBitrate: 1_200_000, maxFramerate: 24, scaleResolutionDownBy: 1.5 };
  const low = { ...original, maxBitrate: 500_000, maxFramerate: 15, scaleResolutionDownBy: 2 };
  setBandwidth(400_000);
  await vi.advanceTimersByTimeAsync(2000);
  expect(sender.setParameters).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  expect(sender.setParameters).toHaveBeenNthCalledWith(1, { transactionId: "1", encodings: [medium] });
  await vi.advanceTimersByTimeAsync(4000);
  expect(sender.setParameters).toHaveBeenNthCalledWith(2, { transactionId: "2", encodings: [low] });
  setBandwidth(1_300_000);
  setLoss(8500, 0.01);
  await vi.advanceTimersByTimeAsync(6000);
  expect(sender.setParameters).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(sender.setParameters).toHaveBeenNthCalledWith(3, { transactionId: "3", encodings: [medium] });
  await vi.advanceTimersByTimeAsync(8000);
  expect(sender.setParameters).toHaveBeenCalledTimes(3);
  setBandwidth(2_500_000);
  await vi.advanceTimersByTimeAsync(8000);
  expect(sender.setParameters).toHaveBeenNthCalledWith(4, { transactionId: "4", encodings: [original] });
});

it.each(["estimate improves", "packet loss returns", "estimate stays capped", "ICE pair changes"])("probes one tier when capped and settles when %s", async (outcome) => {
  const { sender, setBandwidth, setRtt, setLoss, setPair } = setup();
  setBandwidth(300_000);
  await vi.advanceTimersByTimeAsync(8000);
  expect(sender.setParameters).toHaveBeenCalledTimes(2);
  expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [expect.objectContaining({ maxBitrate: 500_000 })] }));

  setBandwidth(500_000);
  await vi.advanceTimersByTimeAsync(8000);
  expect(sender.setParameters).toHaveBeenCalledTimes(2);
  for (let poll = 0; poll < 4; poll++) {
    setRtt(0.075, poll + 2);
    setLoss(16_100 + poll * 2000, 0);
    await vi.advanceTimersByTimeAsync(2000);
  }
  expect(sender.setParameters).toHaveBeenCalledTimes(3);
  expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [expect.objectContaining({ maxBitrate: 1_200_000 })] }));

  if (outcome === "estimate improves") {
    await vi.advanceTimersByTimeAsync(4000);
    expect(sender.setParameters).toHaveBeenCalledTimes(3);
    setBandwidth(2_500_000);
    setRtt(0.075, 6);
    setLoss(28_100, 0);
    await vi.advanceTimersByTimeAsync(4000);
    expect(sender.setParameters).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8000);
    expect(sender.setParameters).toHaveBeenCalledTimes(4);
    expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ rid: "original", maxFramerate: 28, priority: "high" }] }));
  } else {
    if (outcome === "packet loss returns") setLoss(24_100, 0.12);
    if (outcome === "ICE pair changes") setPair("new");
    if (outcome === "estimate stays capped") {
      setRtt(0.075, 6);
      setLoss(24_100, 0);
    }
    const rollbackDelay = outcome === "estimate stays capped" ? 8000 : 2000;
    await vi.advanceTimersByTimeAsync(rollbackDelay);
    expect(sender.setParameters).toHaveBeenCalledTimes(4);
    expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [expect.objectContaining({ maxBitrate: 500_000 })] }));
    for (let poll = 0; poll < 4; poll++) {
      setRtt(0.075, poll + 7);
      setLoss(24_100 + rollbackDelay + poll * 2000, 0);
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(sender.setParameters).toHaveBeenCalledTimes(4);
  }
});

it.each([
  { scenario: "omits the ICE response counter", rttCounter: false, lossFeedback: true },
  { scenario: "omits outgoing loss", rttCounter: true, lossFeedback: false },
  { scenario: "omits both feedback fields", rttCounter: false, lossFeedback: false },
  { scenario: "reports rising RTT with neither feedback field", rttCounter: false, lossFeedback: false, rttRises: true },
  { scenario: "stays near the old estimate with neither feedback field", rttCounter: false, lossFeedback: false, estimateStaysCapped: true },
])("uses a conservative recovery probe when the WebKit-like report $scenario", async ({ rttCounter, lossFeedback, rttRises, estimateStaysCapped }) => {
  const { sender, setBandwidth, setRtt, setLoss } = setup(0.075, { rttCounter, lossFeedback });
  setBandwidth(300_000);
  await vi.advanceTimersByTimeAsync(8000);
  expect(sender.setParameters).toHaveBeenCalledTimes(2);

  setBandwidth(500_000);
  for (let poll = 0; poll < 8; poll++) {
    setRtt(0.075, poll + 2);
    setLoss(8100 + poll * 2000, 0);
    await vi.advanceTimersByTimeAsync(2000);
    if (poll < 7) expect(sender.setParameters).toHaveBeenCalledTimes(2);
  }
  expect(sender.setParameters).toHaveBeenCalledTimes(3);
  expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [expect.objectContaining({ maxBitrate: 1_200_000 })] }));

  if (!estimateStaysCapped) setBandwidth(2_500_000);
  setRtt(rttRises ? 0.25 : 0.075, 10);
  setLoss(24_100, 0);
  if (rttRises || estimateStaysCapped) {
    await vi.advanceTimersByTimeAsync(rttRises ? 2000 : 8000);
    expect(sender.setParameters).toHaveBeenCalledTimes(4);
    expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [expect.objectContaining({ maxBitrate: 500_000 })] }));
  } else {
    await vi.advanceTimersByTimeAsync(8000);
    expect(sender.setParameters).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8000);
    expect(sender.setParameters).toHaveBeenCalledTimes(4);
    expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ rid: "original", maxFramerate: 28, priority: "high" }] }));
  }
});

it("tunes for distinct elevated ICE responses and recovers after the new RTT stabilizes", async () => {
  const { sender, setBandwidth, setRtt, setPair } = setup();
  setBandwidth(5_000_000);
  await vi.advanceTimersByTimeAsync(2000);
  setPair("long-route");
  setRtt(0.47, 1);
  await vi.advanceTimersByTimeAsync(8000);
  expect(sender.setParameters).not.toHaveBeenCalled();

  setRtt(0.7, 2);
  await vi.advanceTimersByTimeAsync(4000);
  expect(sender.setParameters).not.toHaveBeenCalled();
  setRtt(0.7, 3);
  await vi.advanceTimersByTimeAsync(2000);
  expect(sender.setParameters).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ encodings: [expect.objectContaining({ maxBitrate: 1_200_000 })] }));
  for (let response = 4; response < 20; response++) {
    setRtt(0.7, response);
    await vi.advanceTimersByTimeAsync(2000);
  }
  expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ rid: "original", maxFramerate: 28, priority: "high" }] }));
});

it.each(["fresh low loss", "loss report expiry", "ICE pair change"])("recovers after %s following a period of high loss", async (recovery) => {
  const { sender, setBandwidth, setLoss, setPair } = setup(recovery === "fresh low loss" ? 0.3 : 0.075);
  if (recovery === "fresh low loss") setBandwidth(undefined);
  await vi.advanceTimersByTimeAsync(2000);
  setLoss(2100, 0.12);
  await vi.advanceTimersByTimeAsync(2000);
  setLoss(4100, 0.12);
  await vi.advanceTimersByTimeAsync(2000);
  expect(sender.setParameters).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(8000);
  expect(sender.setParameters).toHaveBeenCalledOnce();

  if (recovery === "fresh low loss") setLoss(14_100, 0);
  if (recovery === "ICE pair change") setPair("new");
  await vi.advanceTimersByTimeAsync(recovery === "loss report expiry" ? 10_000 : 8000);
  expect(sender.setParameters).toHaveBeenCalledTimes(2);
  expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [{ rid: "original", maxFramerate: 28, priority: "high" }] }));
  if (recovery === "fresh low loss") {
    setLoss(22_100, 0);
    await vi.advanceTimersByTimeAsync(8000);
    expect(sender.setParameters).toHaveBeenCalledTimes(2);
  }
});

it("backs off after a recovery probe fails without a bandwidth estimate", async () => {
  const { sender, setBandwidth, setLoss } = setup();
  setBandwidth(900_000);
  await vi.advanceTimersByTimeAsync(4000);
  expect(sender.setParameters).toHaveBeenCalledOnce();

  setBandwidth(undefined);
  setLoss(4100, 0);
  await vi.advanceTimersByTimeAsync(8000);
  expect(sender.setParameters).toHaveBeenCalledTimes(2);

  setLoss(12_100, 0.12);
  await vi.advanceTimersByTimeAsync(2000);
  expect(sender.setParameters).toHaveBeenCalledTimes(3);
  expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [expect.objectContaining({ maxBitrate: 1_200_000 })] }));

  setLoss(14_100, 0);
  await vi.advanceTimersByTimeAsync(18_000);
  expect(sender.setParameters).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(2000);
  expect(sender.setParameters).toHaveBeenCalledTimes(4);
});

it("drops a pending recovery retry when new loss is reported", async () => {
  const { sender, setBandwidth, setLoss } = setup();
  setBandwidth(900_000);
  await vi.advanceTimersByTimeAsync(4000);
  sender.setParameters.mockRejectedValueOnce(new DOMException("Rejected encoder settings", "InvalidStateError"));
  setBandwidth(5_000_000);
  await vi.advanceTimersByTimeAsync(8000);
  expect(sender.setParameters).toHaveBeenCalledTimes(2);

  setLoss(12_100, 0.12);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(sender.setParameters).toHaveBeenCalledTimes(2);
});

it("counts delayed receiver reports once and still tunes for distinct reports of sustained loss", async () => {
  const { sender, publish, setLoss } = setup();
  await vi.advanceTimersByTimeAsync(2000);
  setLoss(2100, 0.12);
  await vi.advanceTimersByTimeAsync(6000);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ videoSent: expect.objectContaining({ packetLoss: 0.12 }) }));
  expect(sender.setParameters).not.toHaveBeenCalled();

  setLoss(8100, 0.12);
  await vi.advanceTimersByTimeAsync(2000);
  expect(sender.setParameters).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ encodings: [expect.objectContaining({ maxBitrate: 1_200_000 })] }));
  await vi.advanceTimersByTimeAsync(6000);
  expect(sender.setParameters).toHaveBeenCalledOnce();
});

it("starts a new high-loss streak when the next report arrives after expiry", async () => {
  const { sender, setLoss } = setup();
  await vi.advanceTimersByTimeAsync(2000);
  setLoss(2100, 0.12);
  await vi.advanceTimersByTimeAsync(12_000);
  setLoss(14_100, 0.12);
  await vi.advanceTimersByTimeAsync(2000);
  expect(sender.setParameters).not.toHaveBeenCalled();

  setLoss(16_100, 0.12);
  await vi.advanceTimersByTimeAsync(2000);
  expect(sender.setParameters).toHaveBeenCalledOnce();
});

it("probes after loss expires while the same receiver report remains visible", async () => {
  const { sender, publish, setBandwidth, setLoss } = setup();
  setBandwidth(300_000);
  await vi.advanceTimersByTimeAsync(8000);
  expect(sender.setParameters).toHaveBeenCalledTimes(2);

  setBandwidth(500_000);
  setLoss(8100, 0.12);
  await vi.advanceTimersByTimeAsync(12_000);
  expect(sender.setParameters).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(16_000);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ videoSent: expect.objectContaining({ packetLoss: 0.12 }) }));
  expect(sender.setParameters).toHaveBeenCalledTimes(3);
  expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({ encodings: [expect.objectContaining({ maxBitrate: 1_200_000 })] }));

  setBandwidth(900_000);
  await vi.advanceTimersByTimeAsync(8000);
  expect(sender.setParameters).toHaveBeenCalledTimes(3);
});

it.each(["bandwidth rebound", "new pair", "ICE interruption between polls", "sampled disconnect"])("reconsiders a failed downgrade after %s", async (change) => {
  const { pc, sender, setBandwidth, setPair } = setup();
  const error = new DOMException("Rejected encoder settings", "InvalidStateError");
  sender.setParameters.mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockRejectedValueOnce(error);
  setBandwidth(400_000);
  await vi.advanceTimersByTimeAsync(12_000);
  expect(sender.setParameters).toHaveBeenCalledTimes(3);

  setBandwidth(change === "bandwidth rebound" ? 1_500_000 : 2_500_000);
  if (change === "new pair") setPair("new");
  else if (change !== "bandwidth rebound") {
    pc.iceConnectionState = "disconnected";
    if (change === "sampled disconnect") await vi.advanceTimersByTimeAsync(2000);
    else pc.dispatchEvent(new Event("iceconnectionstatechange"));
    pc.iceConnectionState = "connected";
    pc.dispatchEvent(new Event("iceconnectionstatechange"));
  }
  await vi.advanceTimersByTimeAsync(2000);
  expect(sender.setParameters).toHaveBeenCalledTimes(3);
  setBandwidth(400_000);
  await vi.advanceTimersByTimeAsync(2000);
  expect(sender.setParameters).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(2000);
  expect(sender.setParameters).toHaveBeenCalledTimes(4);
});

it("backs off to bitrate-only with fresh parameters when the browser rejects other caps", async () => {
  const { sender, setBandwidth, publish } = setup();
  const unsupported = new DOMException("Unsupported field", "NotSupportedError");
  sender.setParameters.mockRejectedValueOnce(unsupported).mockRejectedValueOnce(unsupported);
  setBandwidth(200_000);
  await vi.advanceTimersByTimeAsync(4000);
  expect(sender.getParameters).toHaveBeenCalledTimes(3);
  expect(sender.setParameters.mock.calls.map(([parameters]) => parameters)).toEqual([
    { transactionId: "1", encodings: [{ rid: "original", priority: "high", maxBitrate: 1_200_000, maxFramerate: 24, scaleResolutionDownBy: 1.5 }] },
    { transactionId: "2", encodings: [{ rid: "original", priority: "high", maxBitrate: 1_200_000, maxFramerate: 24 }] },
    { transactionId: "3", encodings: [{ rid: "original", priority: "high", maxBitrate: 1_200_000, maxFramerate: 28 }] },
  ]);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ roundTripTimeMs: 75 }));
  await vi.advanceTimersByTimeAsync(2000);
  expect(sender.setParameters).toHaveBeenCalledTimes(3);
});

it("clears diagnostics through ICE loss, pauses writes for an inactive sender, and stops with ownership", async () => {
  const { pc, sender, publish, isCurrent, setBandwidth } = setup();
  await vi.advanceTimersByTimeAsync(2000);
  expect(publish).toHaveBeenCalledOnce();
  pc.iceConnectionState = "disconnected";
  setBandwidth(200_000);
  await vi.advanceTimersByTimeAsync(8000);
  expect(publish).toHaveBeenLastCalledWith(null);
  expect(pc.getStats).toHaveBeenCalledOnce();
  pc.iceConnectionState = "connected";
  sender.track.enabled = false;
  await vi.advanceTimersByTimeAsync(8000);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ roundTripTimeMs: 75 }));
  expect(sender.setParameters).not.toHaveBeenCalled();
  isCurrent.mockReturnValue(false);
  const samples = publish.mock.calls.length;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(publish).toHaveBeenCalledTimes(samples);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not overlap samples or publish a result that arrives after teardown", async () => {
  const { pc, stop, sender, publish } = setup();
  let resolveStats!: (report: RTCStatsReport) => void;
  pc.getStats.mockReturnValueOnce(new Promise((resolve) => { resolveStats = resolve; }));
  await vi.advanceTimersByTimeAsync(6000);
  expect(pc.getStats).toHaveBeenCalledOnce();
  stop();
  resolveStats(new Map() as unknown as RTCStatsReport);
  await vi.advanceTimersByTimeAsync(6000);
  expect(pc.getStats).toHaveBeenCalledOnce();
  expect(sender.setParameters).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});
