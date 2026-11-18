import type { LocalMessage } from "../db/index.js";

/** Canonical rows and imports carry an owner. Allow older in-memory optimistic rows while they commit. */
export function messageVisibleToAccount(
  row: Pick<LocalMessage, "ownerId" | "importedAt" | "imported" | "transferSourceId">,
  ownerId: string | null,
): boolean {
  if (!ownerId) return false;
  if (row.ownerId !== undefined) return row.ownerId === ownerId;
  return row.importedAt === undefined && !row.imported && !row.transferSourceId;
}
