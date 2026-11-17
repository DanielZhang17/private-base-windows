import { afterEach, expect, it, vi } from "vitest";
import type { IDBPDatabase } from "idb";
const opened: IDBPDatabase[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
it.each(["marker-first", "writer-first", "no-record-yet"])("atomically evicts decrypted attachments during first redaction with a concurrent guarded write (%s)", async (order) => {
  vi.resetModules();
  const tabA = await import("./index.js");
  const dbA = await tabA.getAppDB(); opened.push(dbA);
  for (const store of Array.from(dbA.objectStoreNames)) await dbA.clear(store);
  vi.resetModules();
  const tabB = await import("./index.js");
  const dbB = await tabB.getAppDB(); opened.push(dbB);
  const message = { id: "attachment", conversationId: "conv", senderId: "alice", type: "file", content: JSON.stringify({ fileId: "private-file", fileKey: "secret", iv: "private-iv" }), timestamp: Date.now(), expiresAt: Date.now() + 60000, status: "sent" };
  if (order !== "no-record-yet") await tabA.saveMessage(message);
  await dbA.put("fileCache", { id: "private-file", blob: new Blob(["decrypted bytes"]) });
  const mark = () => tabA.rememberMessageDeletion(message.id, "conv", 123, "alice");
  const write = () => tabB.saveMessage({ ...message, status: "delivered" });
  if (order === "no-record-yet") { await mark(); await write(); }
  else await Promise.all(order === "marker-first" ? [mark(), write()] : [write(), mark()]);
  // Read both stores in one snapshot: a redacted record must never coexist with cached bytes.
  const tx = dbB.transaction(["messages", "fileCache"], "readonly");
  expect(await tx.objectStore("messages").get(message.id)).toMatchObject({ content: "", deletedAt: 123 });
  expect(await tx.objectStore("fileCache").get("private-file")).toBeUndefined();
  await tx.done;
});
