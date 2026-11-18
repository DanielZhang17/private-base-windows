import { afterEach, expect, it, vi } from "vitest";
import { clearUnlockAttempts, readUnlockAttempts, recordUnlockFailure } from "./unlockAttempt.js";

afterEach(() => vi.useRealTimers());

it("persists five failures across reload reads and doubles subsequent lockouts for the same device", async () => {
  const device = "unlock-test";
  await clearUnlockAttempts(device);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(100_000);
  for (let i = 0; i < 4; i++) expect((await recordUnlockFailure(device)).until).toBe(0);
  expect((await recordUnlockFailure(device)).until).toBe(130_000);
  expect(await readUnlockAttempts(device)).toMatchObject({ failures: 5, until: 130_000 });
  expect(await readUnlockAttempts("other-device")).toBeUndefined();
  vi.setSystemTime(130_000);
  expect((await recordUnlockFailure(device)).until).toBe(190_000);
  await clearUnlockAttempts(device);
  expect(await readUnlockAttempts(device)).toBeUndefined();
});
