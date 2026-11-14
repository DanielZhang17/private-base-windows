import en from "../i18n/locales/en.json";
/** Chromium needs both createEncodedStreams methods and encodedInsertableStreams: true. */
export function supportsLegacyEncodedTransforms(): boolean {
  return typeof RTCRtpSender !== "undefined" && typeof RTCRtpReceiver !== "undefined" &&
    typeof (RTCRtpSender.prototype as { createEncodedStreams?: unknown }).createEncodedStreams === "function" &&
    typeof (RTCRtpReceiver.prototype as { createEncodedStreams?: unknown }).createEncodedStreams === "function";
}

/** WebKit uses worker-based RTCRtpScriptTransform on both senders and receivers. */
export function supportsScriptEncodedTransforms(): boolean {
  return typeof RTCRtpScriptTransform !== "undefined" && typeof Worker !== "undefined" &&
    typeof RTCRtpSender !== "undefined" && typeof RTCRtpReceiver !== "undefined" &&
    "transform" in RTCRtpSender.prototype && "transform" in RTCRtpReceiver.prototype;
}

export function supportsE2EECalling(): boolean {
  return typeof window !== "undefined" && typeof RTCPeerConnection !== "undefined" &&
    typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined" && typeof TransformStream !== "undefined" &&
    (supportsLegacyEncodedTransforms() || supportsScriptEncodedTransforms());
}

export class E2EECallUnsupportedError extends Error {
  readonly code = "E2EE_CALL_UNSUPPORTED";

  constructor() {
    super(en.endToEndEncryptedCallsAreUnavailableOn);
    this.name = "E2EECallUnsupportedError";
  }
}

export function requireE2EECalling(): void {
  if (!supportsE2EECalling()) throw new E2EECallUnsupportedError();
}
