import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedFileUrl } from "./file-url-resolver.js";

type BatchResponse = { urls: Record<string, ResolvedFileUrl | null> };
const { post } = vi.hoisted(() => ({
  post: vi.fn<(path: string, body: { fileIds: string[] }) => Promise<BatchResponse>>(),
}));
vi.mock("../services/api.js", () => ({ api: { post } }));

let resolver: typeof import("./file-url-resolver.js").fileUrlResolver;
const unavailable = { downloadUrl: null, expiresAt: null };
const fileIds = (count: number) => Array.from({ length: count }, (_, index) => `file-${index}`);
const resultFor = (fileId: string): ResolvedFileUrl => ({
  downloadUrl: `/encrypted/${fileId}`,
  expiresAt: 123456789,
});
const responseFor = (ids: string[]): BatchResponse => ({
  urls: Object.fromEntries(ids.map((id) => [id, resultFor(id)])),
});

function queue(ids: string[]) {
  const settled = new Map<string, ResolvedFileUrl>();
  const promises = ids.map((id) => resolver.resolve(id).then((result) => {
    settled.set(id, result);
    return result;
  }));
  return { promises, settled };
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  post.mockReset();
  ({ fileUrlResolver: resolver } = await import("./file-url-resolver.js"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("file URL resolver drain", () => {
  it.each([101, 251])("settles all %i queued IDs without another resolve call", async (count) => {
    post.mockImplementation(async (_path, { fileIds }) => responseFor(fileIds));
    const ids = fileIds(count);
    const { promises, settled } = queue(ids);

    await vi.advanceTimersByTimeAsync(49);
    expect(post).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();

    // Check settlement before awaiting the promises so a broken drain fails promptly.
    expect(settled.size).toBe(count);
    expect(await Promise.all(promises)).toEqual(ids.map(resultFor));
    expect(post.mock.calls).toEqual(
      Array.from({ length: Math.ceil(count / 100) }, (_, index) => [
        "/api/files/batch-download-urls",
        { fileIds: ids.slice(index * 100, (index + 1) * 100) },
      ]),
    );
  });

  it.each([0, 1, 2])("continues draining when batch %i fails", async (failedBatch) => {
    const error = new Error("Batch request failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let batchIndex = 0;
    post.mockImplementation(async (_path, { fileIds }) => {
      if (batchIndex++ === failedBatch) throw error;
      return responseFor(fileIds);
    });
    const ids = fileIds(251);
    const { promises, settled } = queue(ids);

    await vi.runAllTimersAsync();

    expect(settled.size).toBe(ids.length);
    expect(await Promise.all(promises)).toEqual(ids.map((id, index) =>
      Math.floor(index / 100) === failedBatch ? unavailable : resultFor(id),
    ));
    expect(post).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith("Failed to batch resolve file URLs:", error);
  });

  it("settles null and missing results in every batch of a partial response", async () => {
    const ids = fileIds(205);
    const urls: BatchResponse["urls"] = {};
    ids.forEach((id, index) => {
      if (index % 3 === 0) urls[id] = resultFor(id);
      if (index % 3 === 1) urls[id] = null;
    });
    post.mockImplementation(async (_path, { fileIds }) => ({
      urls: Object.fromEntries(fileIds.filter((id) => id in urls).map((id) => [id, urls[id]])),
    }));
    const { promises, settled } = queue(ids);

    await vi.runAllTimersAsync();

    expect(settled.size).toBe(ids.length);
    expect(await Promise.all(promises)).toEqual(ids.map((id) => urls[id] ?? unavailable));
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("deduplicates queued and in-flight IDs while draining unresolved batches", async () => {
    const batches: { ids: string[]; complete: (response: BatchResponse) => void }[] = [];
    post.mockImplementation((_path, { fileIds }) => new Promise((complete) => {
      batches.push({ ids: fileIds, complete });
    }));
    const ids = fileIds(201);
    const promises = ids.map((id) => resolver.resolve(id));
    expect(resolver.resolve(ids[0])).toBe(promises[0]);
    expect(resolver.resolve(ids[200])).toBe(promises[200]);

    await vi.advanceTimersByTimeAsync(50);
    expect(post).toHaveBeenCalledTimes(1);
    expect(resolver.resolve(ids[0])).toBe(promises[0]);
    expect(resolver.resolve(ids[100])).toBe(promises[100]);
    const late = resolver.resolve("late-file");
    await vi.runAllTimersAsync();

    expect(batches.map(({ ids }) => ids.length)).toEqual([100, 100, 2]);
    ids.forEach((id, index) => expect(resolver.resolve(id)).toBe(promises[index]));
    expect(resolver.resolve("late-file")).toBe(late);
    await vi.runAllTimersAsync();
    expect(post).toHaveBeenCalledTimes(3);
    expect(batches.flatMap(({ ids }) => ids)).toEqual([...ids, "late-file"]);

    // Responses can complete in a different order without losing pending entries.
    batches.reverse().forEach(({ ids, complete }) => complete(responseFor(ids)));
    expect(await Promise.all([...promises, late])).toEqual([...ids, "late-file"].map(resultFor));
  });

  it.each(["success", "null", "missing", "failure"])("releases the pending cache after %s", async (outcome) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    if (outcome === "failure") post.mockRejectedValueOnce(new Error("Batch request failed"));
    else post.mockResolvedValueOnce({ urls: outcome === "success"
      ? { file: resultFor("file") }
      : outcome === "null" ? { file: null } : {} });
    const first = resolver.resolve("file");
    expect(resolver.resolve("file")).toBe(first);
    await vi.runAllTimersAsync();
    expect(await first).toEqual(outcome === "success" ? resultFor("file") : unavailable);

    post.mockResolvedValueOnce(responseFor(["file"]));
    const retry = resolver.resolve("file");
    expect(retry).not.toBe(first);
    expect(resolver.resolve("file")).toBe(retry);
    await vi.runAllTimersAsync();
    expect(await retry).toEqual(resultFor("file"));
    expect(post).toHaveBeenCalledTimes(2);
  });
});
