import { afterEach, describe, expect, it } from "vitest";
import { useDocumentStore } from "../../src/stores/useDocumentStore";

afterEach(() => {
  useDocumentStore.getState().reset();
});

describe("batch upload store actions", () => {
  it("createQueueItem adds item to uploadQueue with queued status", () => {
    const file = new File(["hello"], "test.md", { type: "text/markdown" });
    const item = useDocumentStore.getState().createQueueItem(file);

    expect(item.filename).toBe("test.md");
    expect(item.status).toBe("queued");
    expect(item.progress).toBe(0);
    expect(item.file).toBe(file);

    const queue = useDocumentStore.getState().uploadQueue;
    expect(queue).toHaveLength(1);
    expect(queue[0]!.id).toBe(item.id);
  });

  it("markUploadError sets error state on queue item", () => {
    const file = new File(["x"], "bad.xyz", { type: "application/octet-stream" });
    const item = useDocumentStore.getState().createQueueItem(file);

    useDocumentStore.getState().markUploadError(item.id, "upload", "Unsupported file type");

    const updated = useDocumentStore.getState().uploadQueue.find((i) => i.id === item.id);
    expect(updated!.status).toBe("error");
    expect(updated!.errorStage).toBe("upload");
    expect(updated!.errorMessage).toBe("Unsupported file type");
  });

  it("bindUploadDocumentId links queue item to a document", () => {
    const file = new File(["data"], "report.md", { type: "text/markdown" });
    const item = useDocumentStore.getState().createQueueItem(file);

    useDocumentStore.getState().bindUploadDocumentId(item.id, "doc-123");

    const updated = useDocumentStore.getState().uploadQueue.find((i) => i.id === item.id);
    expect(updated!.documentId).toBe("doc-123");
  });

  it("activeUploadRequests increment/decrement syncs isUploading", () => {
    const store = useDocumentStore.getState();
    expect(store.isUploading).toBe(false);
    expect(store.activeUploadRequests).toBe(0);

    useDocumentStore.getState().incrementActiveUploadRequests();
    expect(useDocumentStore.getState().isUploading).toBe(true);
    expect(useDocumentStore.getState().activeUploadRequests).toBe(1);

    useDocumentStore.getState().incrementActiveUploadRequests();
    expect(useDocumentStore.getState().activeUploadRequests).toBe(2);

    useDocumentStore.getState().decrementActiveUploadRequests();
    expect(useDocumentStore.getState().isUploading).toBe(true); // still 1 active
    expect(useDocumentStore.getState().activeUploadRequests).toBe(1);

    useDocumentStore.getState().decrementActiveUploadRequests();
    expect(useDocumentStore.getState().isUploading).toBe(false);
    expect(useDocumentStore.getState().activeUploadRequests).toBe(0);
  });

  it("decrement does not go below zero", () => {
    useDocumentStore.getState().decrementActiveUploadRequests();
    expect(useDocumentStore.getState().activeUploadRequests).toBe(0);
    expect(useDocumentStore.getState().isUploading).toBe(false);
  });

  it("startBatchUpload / incrementBatchCompleted / incrementBatchFailed / finishBatchUpload lifecycle", () => {
    useDocumentStore.getState().startBatchUpload(5);
    const s1 = useDocumentStore.getState();
    expect(s1.batchUploadActive).toBe(true);
    expect(s1.batchUploadTotal).toBe(5);
    expect(s1.batchUploadCompleted).toBe(0);
    expect(s1.batchUploadFailed).toBe(0);

    useDocumentStore.getState().incrementBatchCompleted();
    useDocumentStore.getState().incrementBatchCompleted();
    useDocumentStore.getState().incrementBatchFailed();

    const s2 = useDocumentStore.getState();
    expect(s2.batchUploadCompleted).toBe(2);
    expect(s2.batchUploadFailed).toBe(1);

    useDocumentStore.getState().finishBatchUpload();
    expect(useDocumentStore.getState().batchUploadActive).toBe(false);
    // Queue items are NOT cleared by finishBatchUpload
    expect(useDocumentStore.getState().batchUploadTotal).toBe(5);
  });

  it("setUploadPipelineStatus updates queue item by documentId", () => {
    const file = new File(["data"], "doc.md", { type: "text/markdown" });
    const item = useDocumentStore.getState().createQueueItem(file);
    useDocumentStore.getState().bindUploadDocumentId(item.id, "doc-abc");

    useDocumentStore.getState().setUploadPipelineStatus("doc-abc", "processing", 50);
    const updated = useDocumentStore.getState().uploadQueue.find((i) => i.id === item.id);
    expect(updated!.status).toBe("processing");
    expect(updated!.progress).toBe(50);

    useDocumentStore.getState().setUploadPipelineStatus("doc-abc", "error", 100, "LLM timeout");
    const errored = useDocumentStore.getState().uploadQueue.find((i) => i.id === item.id);
    expect(errored!.status).toBe("error");
    expect(errored!.errorStage).toBe("pipeline");
    expect(errored!.errorMessage).toBe("LLM timeout");
  });

  it("removeQueueItem removes item from queue", () => {
    const file = new File(["x"], "a.md", { type: "text/markdown" });
    const item = useDocumentStore.getState().createQueueItem(file);
    expect(useDocumentStore.getState().uploadQueue).toHaveLength(1);

    useDocumentStore.getState().removeQueueItem(item.id);
    expect(useDocumentStore.getState().uploadQueue).toHaveLength(0);
  });

  it("reset clears all batch upload state", () => {
    useDocumentStore.getState().startBatchUpload(3);
    useDocumentStore.getState().incrementActiveUploadRequests();
    const file = new File(["x"], "a.md", { type: "text/markdown" });
    useDocumentStore.getState().createQueueItem(file);

    useDocumentStore.getState().reset();

    const s = useDocumentStore.getState();
    expect(s.activeUploadRequests).toBe(0);
    expect(s.isUploading).toBe(false);
    expect(s.batchUploadActive).toBe(false);
    expect(s.batchUploadTotal).toBe(0);
    expect(s.uploadQueue).toHaveLength(0);
  });
});
