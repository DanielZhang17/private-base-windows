import { getAppDB } from "../../db/index.js";

export interface UnlockAttemptState {
  id: string;
  failures: number;
  until: number;
}

export function readUnlockAttempts(deviceId: string): Promise<UnlockAttemptState | undefined> {
  return getAppDB().then(db => db.get("accountState", `unlock:password:${deviceId}`) as Promise<UnlockAttemptState | undefined>);
}

export async function recordUnlockFailure(deviceId: string) {
  const id = `unlock:password:${deviceId}`;
  const tx = (await getAppDB()).transaction("accountState", "readwrite");
  const current = await tx.store.get(id) as UnlockAttemptState | undefined;
  const failures = Math.min((current?.failures ?? 0) + 1, 10);
  const now = Date.now();
  const until = current && current.until > now ? current.until : failures < 5 ? 0 : now + Math.min(900, 30 * 2 ** (failures - 5)) * 1000;
  const result = { id, failures, until };
  await tx.store.put(result);
  await tx.done;
  return result;
}

export async function clearUnlockAttempts(deviceId: string) {
  await (await getAppDB()).delete("accountState", `unlock:password:${deviceId}`);
}
