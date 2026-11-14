/**
 * Generate a safety number (fingerprint) from two identity keys.
 * The result is deterministic and identical for both parties.
 * Returns a 60-digit numeric string.
 */
export async function generateSafetyNumber(
  localIdentityKey: Uint8Array,
  remoteIdentityKey: Uint8Array,
): Promise<string> {
  // Sort keys to ensure same result regardless of who computes it
  const [first, second] = compareKeys(localIdentityKey, remoteIdentityKey)
    ? [localIdentityKey, remoteIdentityKey]
    : [remoteIdentityKey, localIdentityKey];

  const combined = new Uint8Array(first.length + second.length);
  combined.set(first, 0);
  combined.set(second, first.length);

  // Hash with SHA-256 iteratively (5200 iterations like Signal)
  let hash = combined;
  for (let i = 0; i < 5200; i++) {
    const data = new Uint8Array(hash.length + 2);
    data.set(hash, 0);
    new DataView(data.buffer).setUint16(hash.length, i);
    const digest = await crypto.subtle.digest("SHA-256", data);
    hash = new Uint8Array(digest);
  }

  // Convert hash to 60-digit numeric string
  // Take 30 bytes, each byte becomes 2 digits (mod 100)
  const digits: string[] = [];
  for (let i = 0; i < 30; i++) {
    digits.push(hash[i % hash.length].toString().padStart(2, "0").slice(-2));
  }
  return digits.join("");
}

function compareKeys(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return true;
}

/**
 * Format a safety number for display (groups of 5 digits, 4 groups per line).
 */
export function formatSafetyNumber(safetyNumber: string): string {
  const groups: string[] = [];
  for (let i = 0; i < safetyNumber.length; i += 5) {
    groups.push(safetyNumber.slice(i, i + 5));
  }
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += 4) {
    lines.push(groups.slice(i, i + 4).join(" "));
  }
  return lines.join("\n");
}
