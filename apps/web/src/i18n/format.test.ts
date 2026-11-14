import { expect, it } from "vitest";
import { setLocalePreference, t } from "./index.js";
import { formatDate, formatDateTime, formatTime, formatRelativeTime, formatRelativeTimestamp } from "./format.js";
const timestamp = Date.UTC(2025, 0, 2, 15, 4, 5);
it("uses the resolved app language and an explicit timezone", async () => {
  await setLocalePreference("en");
  expect(formatDate(timestamp, { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })).toBe("January 2, 2025");
  expect(formatTime(timestamp, { timeZone: "UTC", hour12: false })).toBe("15:04");
  expect(formatDateTime(timestamp, { timeZone: "UTC" })).toBe(new Intl.DateTimeFormat("en", { timeZone: "UTC", dateStyle: "short", timeStyle: "medium" }).format(timestamp));
  await setLocalePreference("de");
  expect(formatDate(timestamp, { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" })).toBe("2. Januar 2025");
  expect(formatTime(timestamp, { timeZone: "America/Los_Angeles", hour12: false })).toBe("07:04");
  expect(formatRelativeTime(-5, "minute")).toBe("vor 5 Minuten");
  expect(formatRelativeTimestamp(timestamp - 300_000, timestamp)).toBe("vor 5 Minuten");
});
it("rejects nonexistent translation keys at compile time", () => {
  // @ts-expect-error English resource keys are the source of truth.
  t("missing.key");
});
