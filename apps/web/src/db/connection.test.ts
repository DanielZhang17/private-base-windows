import { afterEach, expect, it, vi } from "vitest";
import { openDB } from "idb";
vi.mock("idb", async (original) => {
  const module = await original<typeof import("idb")>();
  return { ...module, openDB: vi.fn(module.openDB) };
});
afterEach(() => vi.restoreAllMocks());
it("keeps the cached DB connection usable when initial expired-hide cleanup fails", async () => {
  vi.resetModules();
  const original = (await vi.importActual<typeof import("idb")>("idb")).openDB;
  let cleanupFailed = false;
  vi.mocked(openDB).mockImplementationOnce(async (...args) => {
    const db = await original(...args);
    const getAll = db.getAll.bind(db);
    vi.spyOn(db, "getAll").mockImplementation(getAll).mockImplementationOnce(async () => { cleanupFailed = true; throw new Error("Maintenance read failed"); });
    return db;
  });
  const database = await import("./index.js");
  const connection = database.getAppDB();
  const db = await connection;
  try {
    await Promise.resolve();
    expect(cleanupFailed).toBe(true);
    expect(database.getAppDB()).toBe(connection);
    await expect(database.getAppDB()).resolves.toBe(db);
    await database.saveSyncState("usable-after-cleanup-failure", 42);
    expect((await database.getSyncState("usable-after-cleanup-failure"))?.value).toBe(42);
    // The later unlocked sweep can retry normally.
    await expect(database.commitAbandonedMessageHides(db)).resolves.toBeUndefined();
  } finally { db.close(); }
});
