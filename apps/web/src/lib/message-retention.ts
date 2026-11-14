import {
  MESSAGE_RETENTION_MS,
  type ExpiryKind,
} from "@e2ee-chat/shared";

interface ExpiringRecord {
  timestamp: number;
  expiresAt: number | null | undefined;
  expiryKind?: ExpiryKind | null | undefined;
}

export function fallbackRetentionExpiresAt(timestamp: number): number {
  return timestamp + MESSAGE_RETENTION_MS;
}

export function normalizeExpiryMetadata(record: ExpiringRecord): {
  expiresAt: number;
  expiryKind: ExpiryKind;
} {
  if (record.expiresAt !== null && record.expiresAt !== undefined) {
    const fallbackExpiresAt = fallbackRetentionExpiresAt(record.timestamp);
    return {
      expiresAt: record.expiresAt,
      expiryKind:
        record.expiryKind
        ?? (record.expiresAt >= fallbackExpiresAt ? "retention" : "timed"),
    };
  }

  return {
    expiresAt: fallbackRetentionExpiresAt(record.timestamp),
    expiryKind: "retention",
  };
}

export function formatExpiryCountdown(expiresAt: number, now: number): string | null {
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) return null;

  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const minuteMs = 60 * 1000;

  if (remainingMs >= dayMs) {
    return `${Math.floor(remainingMs / dayMs)}d`;
  }
  if (remainingMs >= hourMs) {
    return `${Math.floor(remainingMs / hourMs)}h`;
  }
  if (remainingMs >= minuteMs) {
    return `${Math.floor(remainingMs / minuteMs)}m`;
  }
  return `${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}
