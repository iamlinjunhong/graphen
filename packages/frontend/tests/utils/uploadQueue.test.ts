import { describe, expect, it } from "vitest";
import { processUploadQueue } from "../../src/utils/uploadQueue";
import type { UploadQueueItem, UploadSingleResult, QueueStatus } from "../../src/utils/uploadQueue";

function makeItem(id: string, filename = `${id}.md`): UploadQueueItem {
  return { id, filename, status: "queued", progress: 0 };
}

function okResult(id: string): UploadSingleResult {
  return { ok: true, documentId: `doc-${id}` };
}

function failResult(msg = "Network error"): UploadSingleResult {
  return { ok: false, stage: "upload", message: msg };
}

describe("processUploadQueue", () => {
  it("processes all items and calls callbacks in order", async () => {
    const items = [makeItem("a"), makeItem("b"), makeItem("c")];
    const statusChanges: Array<[string, QueueStatus]> = [];
    const results: Array<[string, UploadSingleResult]> = [];

    await processUploadQueue(
      items,
      async (item) => okResult(item.id),
      {
        concurrency: 3,
        onStatusChange: (id, status) => statusChanges.push([id, status]),
        onWorkerResult: (id, result) => results.push([id, result]),
      }
    );

    // With concurrency=3, all 3 start uploading, then each transitions to processing
    // Verify all items went through uploading → processing
    const perItem = new Map<string, QueueStatus[]>();
    for (const [id, status] of statusChanges) {
      if (!perItem.has(id)) perItem.set(id, []);
      perItem.get(id)!.push(status);
    }

    expect(perItem.get("a")).toEqual(["uploading", "processing"]);
    expect(perItem.get("b")).toEqual(["uploading", "processing"]);
    expect(perItem.get("c")).toEqual(["uploading", "processing"]);
    expect(results).toHaveLength(3);
    expect(results.every(([, r]) => r.ok)).toBe(true);
  });

  it("respects concurrency limit", async () => {
    const items = [makeItem("1"), makeItem("2"), makeItem("3"), makeItem("4"), makeItem("5")];
    let maxConcurrent = 0;
    let current = 0;

    await processUploadQueue(
      items,
      async (item) => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10));
        current--;
        return okResult(item.id);
      },
      { concurrency: 2 }
    );

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("marks failed items as error via onStatusChange", async () => {
    const items = [makeItem("ok"), makeItem("fail")];
    const statusChanges: Array<[string, QueueStatus]> = [];

    await processUploadQueue(
      items,
      async (item) => (item.id === "fail" ? failResult() : okResult(item.id)),
      {
        concurrency: 2,
        onStatusChange: (id, status) => statusChanges.push([id, status]),
      }
    );

    // "fail" should get uploading → error
    const failStatuses = statusChanges.filter(([id]) => id === "fail");
    expect(failStatuses).toEqual([
      ["fail", "uploading"],
      ["fail", "error"],
    ]);

    // "ok" should get uploading → processing
    const okStatuses = statusChanges.filter(([id]) => id === "ok");
    expect(okStatuses).toEqual([
      ["ok", "uploading"],
      ["ok", "processing"],
    ]);
  });

  it("handles empty items array without error", async () => {
    await processUploadQueue([], async () => okResult("x"));
    // No error thrown
  });

  it("defaults concurrency to 3", async () => {
    const items = Array.from({ length: 6 }, (_, i) => makeItem(`item-${i}`));
    let maxConcurrent = 0;
    let current = 0;

    await processUploadQueue(items, async (item) => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((r) => setTimeout(r, 5));
      current--;
      return okResult(item.id);
    });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });
});
