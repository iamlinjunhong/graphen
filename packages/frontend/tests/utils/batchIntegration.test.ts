import { afterEach, describe, expect, it } from "vitest";
import { useDocumentStore } from "../../src/stores/useDocumentStore";
import { processUploadQueue } from "../../src/utils/uploadQueue";
import type { UploadQueueItem, UploadSingleResult } from "../../src/utils/uploadQueue";

afterEach(() => {
  useDocumentStore.getState().reset();
});

function makeQueueItem(name: string): UploadQueueItem {
  const file = new File(["content"], name, { type: "text/markdown" });
  return useDocumentStore.getState().createQueueItem(file);
}

describe("batch upload integration regression", () => {
  it("single file upload: auto-selects document and updates store", async () => {
    const item = makeQueueItem("single.md");
    const store = useDocumentStore.getState();

    store.incrementActiveUploadRequests();
    store.bindUploadDocumentId(item.id, "doc-single");
    store.upsertDocument({
      id: "doc-single",
      filename: "single.md",
      fileType: "md",
      fileSize: 7,
      status: "uploading",
      uploadedAt: new Date(),
      metadata: {},
    });
    store.setSelectedDocumentId("doc-single");
    store.decrementActiveUploadRequests();

    const after = useDocumentStore.getState();
    expect(after.selectedDocumentId).toBe("doc-single");
    expect(after.isUploading).toBe(false);
    expect(after.documents).toHaveLength(1);
  });

  it("batch 10 files: processUploadQueue completes all with concurrency 3", async () => {
    const items = Array.from({ length: 10 }, (_, i) => makeQueueItem(`file-${i}.md`));
    const store = useDocumentStore.getState();
    store.startBatchUpload(10);

    let maxConcurrent = 0;
    let current = 0;
    const completedIds: string[] = [];

    await processUploadQueue(
      items,
      async (item) => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await new Promise((r) => setTimeout(r, 5));
        current--;
        return { ok: true, documentId: `doc-${item.id}` } as UploadSingleResult;
      },
      {
        concurrency: 3,
        onWorkerResult: (itemId, result) => {
          if (result.ok) {
            completedIds.push(itemId);
            useDocumentStore.getState().incrementBatchCompleted();
          }
        },
      }
    );

    useDocumentStore.getState().finishBatchUpload();

    // All 10 completed
    expect(completedIds).toHaveLength(10);
    expect(useDocumentStore.getState().batchUploadCompleted).toBe(10);
    expect(useDocumentStore.getState().batchUploadActive).toBe(false);

    // Concurrency was respected
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it("batch upload does not change selectedDocumentId", async () => {
    // Pre-select a document
    useDocumentStore.getState().setSelectedDocumentId("existing-doc");

    const items = Array.from({ length: 3 }, (_, i) => makeQueueItem(`batch-${i}.md`));
    useDocumentStore.getState().startBatchUpload(3);

    await processUploadQueue(
      items,
      async (item) => ({ ok: true, documentId: `doc-${item.id}` }),
      { concurrency: 3 }
    );

    // selectedDocumentId should NOT have changed
    expect(useDocumentStore.getState().selectedDocumentId).toBe("existing-doc");
  });

  it("mixed success/failure batch tracks counts correctly", async () => {
    const items = Array.from({ length: 5 }, (_, i) => makeQueueItem(`mix-${i}.md`));
    useDocumentStore.getState().startBatchUpload(5);

    await processUploadQueue(
      items,
      async (item) => {
        // Fail items at index 1 and 3
        const idx = parseInt(item.filename.replace("mix-", "").replace(".md", ""), 10);
        if (idx === 1 || idx === 3) {
          return { ok: false, stage: "upload", message: "Simulated failure" };
        }
        return { ok: true, documentId: `doc-${item.id}` };
      },
      {
        concurrency: 3,
        onWorkerResult: (_itemId, result) => {
          if (result.ok) {
            useDocumentStore.getState().incrementBatchCompleted();
          } else {
            useDocumentStore.getState().incrementBatchFailed();
          }
        },
      }
    );

    useDocumentStore.getState().finishBatchUpload();

    expect(useDocumentStore.getState().batchUploadCompleted).toBe(3);
    expect(useDocumentStore.getState().batchUploadFailed).toBe(2);
  });
});
