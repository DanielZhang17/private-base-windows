/** Shared by the public page and the release CLI. Keep this validator dependency-free. */
const PRODUCT = "Private Base";
const MAX_ENTRIES = 100;
export const MAX_NOTES_BYTES = 16 * 1024;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
export const RELEASE_NOTE_PLATFORMS = ["macos", "windows", "android", "ios"] as const;

export interface ReleaseNoteEntry {
  version: string;
  published: string;
  notes: string;
  platforms: (typeof RELEASE_NOTE_PLATFORMS)[number][];
}

export interface ReleaseNotes {
  product: typeof PRODUCT;
  entries: ReleaseNoteEntry[];
}

function hasFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function invalid(field: string): never {
  throw new Error(`Invalid release notes: ${field}.`);
}

export function parseReleaseNotes(value: unknown): ReleaseNotes {
  if (!hasFields(value, ["product", "entries"]) || value.product !== PRODUCT) invalid("product or root");
  if (!Array.isArray(value.entries)) invalid("entries");
  if (value.entries.length > MAX_ENTRIES) invalid(`at most ${MAX_ENTRIES} entries`);

  const versions = new Set<string>();
  let previous = Infinity;
  const entries = Array.from(value.entries, (entry: unknown): ReleaseNoteEntry => {
    if (!hasFields(entry, ["version", "published", "notes", "platforms"])) invalid("entry fields");
    const { version, published, notes, platforms } = entry;
    if (typeof version !== "string" || version.length > 64 || version.trim() !== version
      || !VERSION.test(version) || versions.has(version)) invalid("version");
    if (typeof published !== "string" || published.length > 40 || published.trim() !== published
      || !ISO_TIMESTAMP.test(published)) invalid("published");
    const timestamp = Date.parse(published);
    const calendarDate = new Date(published.slice(0, 10));
    if (!Number.isFinite(timestamp) || !Number.isFinite(calendarDate.getTime())
      || calendarDate.toISOString().slice(0, 10) !== published.slice(0, 10)) invalid("published");
    if (timestamp > previous) invalid("entries must be newest first");
    if (typeof notes !== "string" || !notes.trim() || notes.length > MAX_NOTES_BYTES
      || new TextEncoder().encode(notes).length > MAX_NOTES_BYTES) invalid("notes");
    if (!Array.isArray(platforms) || platforms.length === 0 || platforms.length > RELEASE_NOTE_PLATFORMS.length
      || new Set(platforms).size !== platforms.length
      || [...platforms].some((platform) => !RELEASE_NOTE_PLATFORMS.includes(platform))) invalid("platforms");
    versions.add(version);
    previous = timestamp;
    return { version, published, notes, platforms };
  });

  return { product: PRODUCT, entries };
}
