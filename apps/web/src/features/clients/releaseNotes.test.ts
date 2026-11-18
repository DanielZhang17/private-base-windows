import { expect, it } from "vitest";
import { MAX_NOTES_BYTES, parseReleaseNotes } from "./releaseNotes.js";

const entry = {
  version: "0.1.1",
  published: "2026-11-17T16:00:00.000Z",
  notes: "## Highlights\n- **Faster** downloads.\n",
  platforms: ["macos", "android"],
};
const older = { ...entry, version: "0.1.0", published: "2026-11-16T18:00:00-05:00" };
const notes = (entries: unknown) => ({ product: "Private Base", entries });

it("accepts empty and newest-first histories and preserves the source Markdown", () => {
  expect(parseReleaseNotes(notes([]))).toEqual(notes([]));
  expect(parseReleaseNotes(notes([entry, older]))).toEqual(notes([entry, older]));
});

it.each([
  null, [], {}, { ...notes([]), product: "Other" }, { ...notes([]), extra: true },
  notes({}), notes(new Array(1)), notes([entry, null]), notes([older, entry]),
  notes([entry, { ...older, version: entry.version }]), notes([{ ...entry, extra: true }]),
])("rejects an invalid archive as a whole (%j)", (value) => {
  expect(() => parseReleaseNotes(value)).toThrow(/Invalid release notes/);
});

it.each([
  { version: "01.1.0" }, { version: "0.1.0\n" }, { version: "0.1.0-beta" },
  { published: "November 17, 2026" }, { published: "2026-11-17" },
  { published: "2026-02-29T16:00:00.000Z" }, { published: "2026-11-31T16:00:00Z" },
  { published: "2026-11-17T24:00:00Z" }, { published: "2026-11-17T16:00:00" },
  { notes: "" }, { notes: " \n" }, { notes: 42 },
  { platforms: [] }, { platforms: ["macos", "macos"] }, { platforms: ["Linux"] }, { platforms: new Array(1) },
])("rejects malformed entry fields (%j)", (patch) => {
  expect(() => parseReleaseNotes(notes([entry, { ...older, ...patch }]))).toThrow(/Invalid release notes/);
});

it("enforces 16 KiB of UTF-8 per entry and 100 entries", () => {
  const max = "é".repeat(MAX_NOTES_BYTES / 2);
  const entries = Array.from({ length: 100 }, (_, index) => ({ ...entry, version: `0.1.${index}` }));
  expect(parseReleaseNotes(notes(entries)).entries).toHaveLength(100);
  expect(parseReleaseNotes(notes([{ ...entry, notes: max }])).entries[0].notes).toBe(max);
  expect(() => parseReleaseNotes(notes([{ ...entry, notes: max + "x" }]))).toThrow(/notes/);
  expect(() => parseReleaseNotes(notes([...entries, { ...entry, version: "0.1.100" }]))).toThrow(/entries/);
});
