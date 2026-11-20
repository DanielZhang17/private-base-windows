type IceCandidateType = "host" | "srflx" | "prflx" | "relay";
type IceTransport = "udp" | "tcp";

const CODEC_NAMES = {
  "audio/opus": "Opus", "audio/pcmu": "PCMU", "audio/pcma": "PCMA", "audio/g722": "G.722",
  "audio/isac": "iSAC", "audio/ilbc": "iLBC", "video/vp8": "VP8", "video/vp9": "VP9",
  "video/h264": "H.264", "video/h265": "H.265", "video/av1": "AV1",
} as const;

export interface CallMediaStats {
  codec?: typeof CODEC_NAMES[keyof typeof CODEC_NAMES];
  bitrateBps?: number;
  packetLoss?: number;
  resolution?: { width: number; height: number };
}

export interface CallDiagnostics {
  localCandidateType?: IceCandidateType;
  remoteCandidateType?: IceCandidateType;
  transport?: IceTransport;
  turnTransport?: IceTransport | "tls";
  roundTripTimeMs?: number;
  audioSent?: CallMediaStats;
  audioReceived?: CallMediaStats;
  videoSent?: CallMediaStats;
  videoReceived?: CallMediaStats;
}

type CandidatePair = RTCIceCandidatePairStats & { selected?: boolean };
const STREAM_KEYS = ["videoSent", "videoReceived", "audioSent", "audioReceived"] as const;
type StreamKey = typeof STREAM_KEYS[number];
type Stream = {
  stats: CallMediaStats;
  transportId?: string;
  activity: number;
  bandwidthLimited?: boolean;
  lossReport?: { id: string; timestamp: number };
};
type Counters = { timestamp: number; bytes?: number; received?: number; lost?: number };

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonnegative(value: unknown): number | undefined {
  const number = finite(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function difference(value?: number, previous?: number): number | undefined {
  return value === undefined || previous === undefined ? undefined : value - previous;
}

function candidateType(value: unknown): IceCandidateType | undefined {
  if (value === "host" || value === "srflx" || value === "prflx" || value === "relay") return value;
}

function iceTransport(value: unknown): IceTransport | undefined {
  if (value === "udp" || value === "tcp") return value;
}

function codecName(value: unknown): CallMediaStats["codec"] {
  if (typeof value !== "string") return;
  const mimeType = value.toLowerCase();
  if (Object.hasOwn(CODEC_NAMES, mimeType)) return CODEC_NAMES[mimeType as keyof typeof CODEC_NAMES];
}

/** Only counters and report-local lookup keys survive between samples. */
export function createCallStatsReader() {
  let previousCounters = new Map<string, Counters>();
  let previousPairId: string | undefined;
  let latestLossTimestamp = -1;
  let outgoingLossCutoff: number | undefined;
  let resetLossCutoff = false;
  const lossReportTimestamps = new Map<string, number>();
  const iceResponseCounts = new Map<string, number>();

  function read(report: RTCStatsReport) {
    const pairs: CandidatePair[] = [];
    const transports: RTCTransportStats[] = [];
    const streams = new Map<StreamKey, Stream>();
    const counters = new Map<string, Counters>();

    const get = (id: string | undefined, type: string) => {
      const stat = id ? report.get(id) : undefined;
      return stat?.type === type ? stat : undefined;
    };

    report.forEach((stat) => {
      if (stat.type === "transport") transports.push(stat);
      if (stat.type === "candidate-pair" && stat.state === "succeeded") pairs.push(stat);
      const outbound = stat.type === "outbound-rtp";
      if ((!outbound && stat.type !== "inbound-rtp") || stat.active === false) return;
      const kind: unknown = stat.kind ?? stat.mediaType;
      if (kind !== "audio" && kind !== "video") return;
      const mimeType = get(stat.codecId, "codec")?.mimeType;
      if (typeof mimeType === "string" && /^video\/(?:rtx|red|ulpfec|flexfec(?:-03)?)$/i.test(mimeType)) return;
      const key: StreamKey = `${kind}${outbound ? "Sent" : "Received"}`;

      const countersNow: Counters = {
        timestamp: stat.timestamp,
        bytes: nonnegative(outbound ? stat.bytesSent : stat.bytesReceived),
        received: nonnegative(stat.packetsReceived),
        lost: finite(stat.packetsLost),
      };
      counters.set(stat.id, countersNow);
      const before = previousCounters.get(stat.id);
      const elapsed = difference(countersNow.timestamp, before?.timestamp);
      const bytes = nonnegative(difference(countersNow.bytes, before?.bytes));
      const received = nonnegative(difference(countersNow.received, before?.received));
      const lost = difference(countersNow.lost, before?.lost);
      const incomingLost = lost === undefined ? undefined : Math.max(0, lost);
      const remote = outbound ? get(stat.remoteId, "remote-inbound-rtp") : undefined;
      const outgoingLoss = nonnegative(remote?.fractionLost);
      const lossTimestamp = nonnegative(remote?.timestamp);
      if (lossTimestamp !== undefined) latestLossTimestamp = Math.max(latestLossTimestamp, lossTimestamp);
      const width = nonnegative(stat.frameWidth);
      const height = nonnegative(stat.frameHeight);

      const stats: CallMediaStats = {
        codec: codecName(mimeType),
        bitrateBps: elapsed && elapsed > 0 && bytes !== undefined ? Math.round(bytes * 8000 / elapsed) : undefined,
        packetLoss: outbound ? (outgoingLoss !== undefined && outgoingLoss <= 1 ? outgoingLoss : undefined)
          : received !== undefined && incomingLost !== undefined && received + incomingLost > 0
            ? incomingLost / (received + incomingLost) : undefined,
        resolution: kind === "video" && width && height ? { width, height } : undefined,
      };
      // A retired RTP stream may still be in the report after a media change.
      const activity = bytes ?? (previousCounters.size ? 0 : countersNow.bytes ?? 0);
      if (activity > (streams.get(key)?.activity ?? -1)) {
        const reason = stat.qualityLimitationReason;
        const bandwidthLimited = reason === "bandwidth" ? true : reason === "none" ? false : undefined;
        const lossReport = lossTimestamp !== undefined && stats.packetLoss !== undefined && typeof remote?.id === "string"
          ? { id: remote.id, timestamp: lossTimestamp } : undefined;
        streams.set(key, { stats, transportId: stat.transportId, activity, bandwidthLimited, lossReport });
      }
    });

    const mediaTransport = STREAM_KEYS.map((key) => streams.get(key)?.transportId).find((id) => !!id);
    const selectedId = transports.find((transport) => transport.id === mediaTransport)?.selectedCandidatePairId
      ?? transports.find((transport) => transport.selectedCandidatePairId)?.selectedCandidatePairId;
    const nominated = pairs.filter((pair) => pair.nominated);
    const pair = selectedId ? pairs.find((pair) => pair.id === selectedId)
      : pairs.find((pair) => pair.selected) ?? (nominated.length === 1 ? nominated[0] : undefined);
    const local = get(pair?.localCandidateId, "local-candidate");
    const remote = get(pair?.remoteCandidateId, "remote-candidate");
    const rttSeconds = nonnegative(pair?.currentRoundTripTime);
    const localCandidateType = candidateType(local?.candidateType);
    const relayProtocol = localCandidateType === "relay" ? local?.relayProtocol : undefined;
    const diagnostics: CallDiagnostics = {
      localCandidateType,
      remoteCandidateType: candidateType(remote?.candidateType),
      transport: iceTransport(local?.protocol),
      turnTransport: relayProtocol === "tls" ? "tls" : iceTransport(relayProtocol),
      roundTripTimeMs: rttSeconds === undefined ? undefined : Math.round(rttSeconds * 1000),
    };
    const pathChanged = pair?.id !== previousPairId;
    if (resetLossCutoff || (pathChanged && (previousPairId !== undefined || outgoingLossCutoff !== undefined))) {
      // Receiver reports may lag a selected-pair change across several polls.
      outgoingLossCutoff = Math.max(latestLossTimestamp, nonnegative(pair?.timestamp) ?? -1);
      resetLossCutoff = false;
    }
    for (const [key, { stats, lossReport }] of streams) {
      if (pathChanged) {
        stats.bitrateBps = undefined;
        stats.packetLoss = undefined;
      } else if (outgoingLossCutoff !== undefined && (key === "audioSent" || key === "videoSent") &&
        (!lossReport || lossReport.timestamp <= outgoingLossCutoff)) {
        stats.packetLoss = undefined;
      }
      diagnostics[key] = stats;
    }
    previousCounters = counters;
    previousPairId = pair?.id;

    // The timestamp on remote-inbound-rtp is when the receiver report arrived.
    // Polling can see it repeatedly even while the local RTP counters advance.
    const video = streams.get("videoSent");
    const lossReport = video?.lossReport;
    let freshVideoLoss: number | undefined;
    if (lossReport && lossReport.timestamp > (lossReportTimestamps.get(lossReport.id) ?? -1)) {
      lossReportTimestamps.set(lossReport.id, lossReport.timestamp);
      freshVideoLoss = diagnostics.videoSent?.packetLoss;
    }

    // Pair RTT is held between ICE responses, independent of the poll rate.
    const responses = nonnegative(pair?.responsesReceived);
    let freshRttMs: number | undefined;
    if (pair && responses !== undefined && responses > (iceResponseCounts.get(pair.id) ?? 0) && diagnostics.roundTripTimeMs !== undefined) {
      iceResponseCounts.set(pair.id, responses);
      freshRttMs = diagnostics.roundTripTimeMs;
    }

    return {
      diagnostics,
      pathChanged,
      availableOutgoingBitrate: nonnegative(pair?.availableOutgoingBitrate),
      videoBandwidthLimited: video?.bandwidthLimited,
      freshVideoLoss,
      freshRttMs,
    };
  }

  return { read, resetIntervals() { previousCounters.clear(); previousPairId = undefined; resetLossCutoff = true; } };
}
