import { createCallStatsReader, type CallDiagnostics } from "./call-stats.js";

const SAMPLE_INTERVAL_MS = 2000;
const RTT_RISE_MS = 100;
const REPORT_EVIDENCE_MS = 12_000;
const PROBE_DURATION_MS = 8000;
const PROBE_COOLDOWN_MS = 20_000;
const SPARSE_PROBE_SAMPLES = 8;
const VIDEO_PROFILES = [
  undefined,
  { maxBitrate: 1_200_000, maxFramerate: 24, scaleResolutionDownBy: 1.5 },
  { maxBitrate: 500_000, maxFramerate: 15, scaleResolutionDownBy: 2 },
];
const ENCODING_FIELDS = ["maxBitrate", "maxFramerate", "scaleResolutionDownBy"] as const;
type EncodingField = typeof ENCODING_FIELDS[number];
type EncodingLimits = Partial<Pick<RTCRtpEncodingParameters, EncodingField>>;

/** Sample the live peer once for both adaptation and the call UI. */
export function startCallMediaMonitor(
  pc: RTCPeerConnection,
  videoSender: RTCRtpSender | null,
  isCurrent: () => boolean,
  publish: (diagnostics: CallDiagnostics | null) => void,
  isScreenSharing: () => boolean = () => false,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stats = createCallStatsReader();
  let hasSample = false;
  let badBandwidthSamples = 0;
  let badRttSamples = 0;
  let badLossReports = 0;
  let goodSamples = 0;
  let probeSamples = 0;
  let sparseProbeSamples = 0;
  let appliedLevel = 0;
  let retryAt = 0;
  let nextProbeAt = 0;
  let probe: { startedAt: number; rollback: boolean; mode: "full" | "sparse" | "unestimated"; rttAtStart?: number } | undefined;
  let previousProbeSample: { bitrate?: number; rttMs?: number } | undefined;
  let baseline: EncodingLimits[] | undefined;
  let sharingScreen = false;
  let connectionInterrupted = false;
  let smoothedRtt: number | undefined;
  let latestRttAt: number | undefined;
  let elevatedRttAt: number | undefined;
  let latestLoss: { fraction: number; observedAt: number } | undefined;

  const active = () => !stopped && isCurrent();
  const connected = () => active() && pc.connectionState === "connected" &&
    pc.iceConnectionState !== "checking" && pc.iceConnectionState !== "disconnected" && pc.iceConnectionState !== "failed";
  const noteInterruption = () => { if (!connected()) connectionInterrupted = true; };

  function resetEvidence() {
    badBandwidthSamples = badRttSamples = badLossReports = goodSamples = probeSamples = sparseProbeSamples = 0;
  }

  function resetPathEvidence() {
    resetEvidence();
    retryAt = 0;
    nextProbeAt = 0;
    if (probe) probe.rollback = true;
    previousProbeSample = undefined;
    smoothedRtt = undefined;
    latestRttAt = undefined;
    elevatedRttAt = undefined;
    latestLoss = undefined;
  }

  function clearSample() {
    connectionInterrupted = false;
    resetPathEvidence();
    if (!hasSample) return;
    hasSample = false;
    stats.resetIntervals();
    if (active()) publish(null);
  }

  async function applyLevel(sender: RTCRtpSender, level: number, canApply: () => boolean): Promise<boolean> {
    const profile = VIDEO_PROFILES[level];
    // Older engines can reject scaling or the frame-rate cap. Each attempt uses
    // a fresh transaction and preserves the number and identity of encodings.
    for (const fieldCount of profile ? [3, 2, 1] : [3]) {
      if (!canApply()) return false;
      try {
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length || (baseline && parameters.encodings.length !== baseline.length)) {
          console.warn("Call encoder settings update failed");
          return false;
        }
        baseline ??= parameters.encodings.map(({ maxBitrate, maxFramerate, scaleResolutionDownBy }) =>
          ({ maxBitrate, maxFramerate, scaleResolutionDownBy }));
        parameters.encodings.forEach((encoding, index) => {
          ENCODING_FIELDS.forEach((field, fieldIndex) => {
            const original = baseline![index]![field];
            const limit = fieldIndex < fieldCount ? profile?.[field] : undefined;
            const value = limit === undefined ? original : field === "scaleResolutionDownBy"
              ? Math.max(limit, original ?? 1) : Math.min(limit, original ?? Infinity);
            if (value === undefined) delete encoding[field];
            else encoding[field] = value;
          });
        });
        await sender.setParameters(parameters);
        return true;
      } catch {
        console.warn("Call encoder settings update failed");
      }
    }
    return false;
  }

  async function sample() {
    try {
      if (connectionInterrupted) clearSample();
      if (!connected()) { clearSample(); return; }
      const screenShare = isScreenSharing();
      if (screenShare !== sharingScreen) {
        sharingScreen = screenShare;
        probe = undefined;
        resetPathEvidence();
      }
      // Restore the sender's baseline independently of the track swap.
      if (screenShare && videoSender && appliedLevel !== 0 && Date.now() >= retryAt) {
        if (await applyLevel(videoSender, 0, () => connected() && isScreenSharing())) appliedLevel = 0;
        else retryAt = Date.now() + 10_000;
        if (!connected()) return;
      }
      const track = videoSender?.track;
      const report = await pc.getStats();
      if (connectionInterrupted || !connected()) { clearSample(); return; }
      const { diagnostics, pathChanged, availableOutgoingBitrate, videoBandwidthLimited, freshVideoLoss: loss, freshRttMs: rtt } = stats.read(report);
      hasSample = true;
      publish(diagnostics);

      if (screenShare || isScreenSharing()) return;
      const canApply = () => !isScreenSharing() && !connectionInterrupted && connected() && pc.signalingState === "stable" && !!track &&
        videoSender?.track === track && track.readyState === "live" && track.enabled;
      if (pathChanged) resetPathEvidence();

      const now = performance.now();
      if (elevatedRttAt !== undefined && now - elevatedRttAt >= REPORT_EVIDENCE_MS) {
        elevatedRttAt = undefined;
        badRttSamples = 0;
      }
      // Compare against this path's recent RTT so a stable long route can recover.
      if (rtt !== undefined) {
        const elevated = smoothedRtt !== undefined && rtt - smoothedRtt >= RTT_RISE_MS;
        smoothedRtt = smoothedRtt === undefined ? rtt : smoothedRtt + (rtt - smoothedRtt) / 8;
        latestRttAt = now;
        elevatedRttAt = elevated ? now : undefined;
        badRttSamples = elevated ? badRttSamples + 1 : 0;
      }

      // Repeated polls hold the latest receiver report without refreshing its age.
      if (latestLoss && now - latestLoss.observedAt >= REPORT_EVIDENCE_MS) {
        latestLoss = undefined;
        badLossReports = 0;
      }
      if (loss !== undefined) latestLoss = { fraction: loss, observedAt: now };
      if (!videoSender || typeof videoSender.setParameters !== "function" || !canApply()) { resetEvidence(); return; }

      const recentLoss = latestLoss?.fraction;
      const highLoss = (recentLoss ?? 0) >= 0.08;
      const acceptableLoss = recentLoss === undefined || recentLoss <= 0.02;
      const bitrate = availableOutgoingBitrate;
      const downgradeBitrate = appliedLevel === 0 ? 1_200_000 : 650_000;
      const recoveryBitrate = appliedLevel === 2 ? 950_000 : 1_800_000;
      const poorBandwidth = videoBandwidthLimited || (bitrate !== undefined && bitrate < downgradeBitrate);
      const poor = poorBandwidth || elevatedRttAt !== undefined;
      const cleanFeedback = recentLoss !== undefined && recentLoss <= 0.02 && elevatedRttAt === undefined &&
        latestRttAt !== undefined && now - latestRttAt < REPORT_EVIDENCE_MS;
      // Without a fresh ICE counter or receiver loss, corroborate the available feedback with a steady estimate.
      const rttMs = diagnostics.roundTripTimeMs;
      const referenceRtt = probe?.rttAtStart ?? previousProbeSample?.rttMs;
      const canCompareRtt = rttMs !== undefined && referenceRtt !== undefined;
      const risingRtt = canCompareRtt && rttMs - referenceRtt >= RTT_RISE_MS;
      const previousBitrate = previousProbeSample?.bitrate;
      const steadyEstimate = bitrate !== undefined && previousBitrate !== undefined && bitrate >= previousBitrate * 0.9;
      const sparseFeedback = steadyEstimate && !risingRtt && elevatedRttAt === undefined &&
        acceptableLoss && (recentLoss !== undefined || canCompareRtt);
      previousProbeSample = { bitrate, rttMs };

      if (probe) {
        // Give the estimator time to ramp. Rising RTT or fresh loss can end the trial early.
        const finished = now - probe.startedAt >= PROBE_DURATION_MS;
        const rttUpdated = (latestRttAt ?? 0) > probe.startedAt;
        const lossUpdated = (latestLoss?.observedAt ?? 0) > probe.startedAt;
        const unestimatedFeedback = acceptableLoss && (bitrate !== undefined || rttUpdated || lossUpdated || videoBandwidthLimited === false);
        const confirmed = probe.mode === "unestimated" ? unestimatedFeedback
          : probe.mode === "sparse" ? sparseFeedback : cleanFeedback && rttUpdated && lossUpdated;
        probe.rollback ||= highLoss || elevatedRttAt !== undefined || (probe.mode !== "full" && risingRtt) || (finished && (poorBandwidth || !confirmed));
        if (!probe.rollback) {
          if (finished) {
            if (probe.mode === "unestimated") nextProbeAt = now + PROBE_COOLDOWN_MS;
            probe = undefined;
            resetEvidence();
          }
          return;
        }
      }

      const hasRecoveryEvidence = bitrate !== undefined ? bitrate >= recoveryBitrate
        : diagnostics.roundTripTimeMs !== undefined || recentLoss !== undefined || videoBandwidthLimited === false;
      const healthy = !poor && hasRecoveryEvidence && acceptableLoss;
      // A cap can hold the estimate below the next tier's recovery threshold.
      const cap = VIDEO_PROFILES[appliedLevel]?.maxBitrate;
      const capLimited = !videoBandwidthLimited && cap !== undefined && bitrate !== undefined &&
        bitrate >= cap * 0.8 && bitrate < recoveryBitrate;
      const probeCandidate = capLimited && cleanFeedback;
      const sparseProbeCandidate = capLimited && !cleanFeedback && sparseFeedback;
      probeSamples = probeCandidate ? probeSamples + 1 : 0;
      sparseProbeSamples = sparseProbeCandidate ? sparseProbeSamples + 1 : 0;
      badBandwidthSamples = poorBandwidth && !probeCandidate && !sparseProbeCandidate ? badBandwidthSamples + 1 : 0;
      if (loss !== undefined) badLossReports = highLoss ? badLossReports + 1 : 0;
      goodSamples = healthy ? goodSamples + 1 : 0;
      const downgrade = badBandwidthSamples >= 2 || badRttSamples >= 2 || badLossReports >= 2;
      const unestimatedRecovery = bitrate === undefined && appliedLevel > 0 && goodSamples >= 4;
      const regularRecovery = goodSamples >= 4 && (bitrate !== undefined || appliedLevel === 0);
      const startSparseProbe = sparseProbeSamples >= SPARSE_PROBE_SAMPLES;
      const startProbe = !probe && !downgrade && now >= nextProbeAt &&
        (unestimatedRecovery || startSparseProbe || (probeSamples >= 4 && loss !== undefined));
      // Rebuild the evidence after a failed write, including during the backoff.
      if (Date.now() < retryAt || (!probe && !downgrade && !regularRecovery && !startProbe)) return;

      const nextLevel = probe || downgrade ? Math.min(appliedLevel + 1, VIDEO_PROFILES.length - 1) : Math.max(appliedLevel - 1, 0);
      resetEvidence();
      if (nextLevel !== appliedLevel) {
        if (await applyLevel(videoSender, nextLevel, canApply)) {
          appliedLevel = nextLevel;
          if (probe) {
            probe = undefined;
            nextProbeAt = performance.now() + PROBE_COOLDOWN_MS;
          } else if (startProbe) {
            const mode = unestimatedRecovery ? "unestimated" : startSparseProbe ? "sparse" : "full";
            probe = { startedAt: performance.now(), rollback: false, mode, rttAtStart: rttMs };
          }
        } else retryAt = Date.now() + 10_000;
      }
    } catch {
      console.warn("Call media monitor sampling failed");
      clearSample();
    } finally {
      if (active()) timer = setTimeout(() => void sample(), SAMPLE_INTERVAL_MS);
    }
  }

  if (typeof pc.getStats === "function") {
    pc.addEventListener?.("connectionstatechange", noteInterruption);
    pc.addEventListener?.("iceconnectionstatechange", noteInterruption);
    timer = setTimeout(() => void sample(), SAMPLE_INTERVAL_MS);
  }
  return () => {
    stopped = true;
    clearTimeout(timer);
    pc.removeEventListener?.("connectionstatechange", noteInterruption);
    pc.removeEventListener?.("iceconnectionstatechange", noteInterruption);
  };
}
