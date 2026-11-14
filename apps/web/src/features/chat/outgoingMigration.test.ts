import { openDB } from "idb";
import { expect, it, vi } from "vitest";
import { getAllOutgoing, getAppDB, getSyncState } from "../../db/index.js";

it("opens alongside a version 5 tab and still allows the rollback client to connect", async () => {
  const old = await openDB("e2ee-chat", 5, { upgrade(db) {
    db.createObjectStore("messages", { keyPath: "id" });
    db.createObjectStore("localKeys", { keyPath: "id" });
    db.createObjectStore("syncState", { keyPath: "id" });
  } });
  await old.put("messages", { id: "old-message", content: "existing local history" });
  await old.put("localKeys", { id: "identity", data: "encrypted-private-key" });
  await old.put("syncState", { id: "message-sync:user:device", value: 42 });
  expect((await getAppDB()).version).toBe(5);
  expect(await getAllOutgoing()).toEqual([]);
  expect(await getSyncState("message-sync:user:device")).toEqual({ id: "message-sync:user:device", value: 42 });
  const rollback = await openDB("e2ee-chat", 5);
  expect(await rollback.get("messages", "old-message")).toEqual({ id: "old-message", content: "existing local history" });
  expect(await rollback.get("localKeys", "identity")).toEqual({ id: "identity", data: "encrypted-private-key" });
  rollback.close();
  old.close();
});

it("preserves the queued work of an existing version 6 client", async () => {
  // Use a separate IndexedDB factory so the open version 5 connection above
  // does not affect this pre-release installation.
  const { IDBFactory } = await import("fake-indexeddb");
  vi.stubGlobal("indexedDB", new IDBFactory());
  try {
    vi.resetModules();
    const preview = await openDB("e2ee-chat", 6, { upgrade(db) {
      db.createObjectStore("syncState", { keyPath: "id" });
      db.createObjectStore("outgoingQueue", { keyPath: "id" });
    } });
    const queued = { id: "queued", queuedAt: 42 };
    await preview.put("outgoingQueue", queued);
    await preview.put("syncState", { id: "message-sync:user:device", value: 42 });
    const { getAllOutgoing, getSyncState } = await import("../../db/index.js");
    expect(await getAllOutgoing()).toMatchObject([queued]);
    expect(await getSyncState("message-sync:user:device")).toEqual({ id: "message-sync:user:device", value: 42 });
    expect(await preview.count("outgoingQueue")).toBe(0);
    preview.close();
  } finally {
    vi.unstubAllGlobals();
  }
});
