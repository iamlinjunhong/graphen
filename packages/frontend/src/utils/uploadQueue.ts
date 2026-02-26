export type QueueStatus = "queued" | "uploading" | "processing" | "completed" | "error";
export type ErrorStage = "upload" | "pipeline";

export interface UploadQueueItem {
  id: string;
  filename: string;
  file?: File;
  documentId?: string;
  status: QueueStatus;
  progress: number;
  errorStage?: ErrorStage;
  errorMessage?: string;
}

export type UploadSingleResult =
  | { ok: true; documentId: string }
  | { ok: false; stage: "upload"; message: string };

export interface ProcessUploadQueueOptions {
  concurrency?: number;
  onItemInit?: (item: UploadQueueItem) => void;
  onStatusChange?: (itemId: string, status: QueueStatus) => void;
  onWorkerResult?: (itemId: string, result: UploadSingleResult) => void;
}

/**
 * Promise-pool style concurrent upload queue.
 * Processes `files` through `worker` with at most `concurrency` in-flight at once.
 */
export async function processUploadQueue(
  items: UploadQueueItem[],
  worker: (item: UploadQueueItem) => Promise<UploadSingleResult>,
  options: ProcessUploadQueueOptions = {}
): Promise<void> {
  const { concurrency = 3, onStatusChange, onWorkerResult } = options;

  const pending = [...items];
  const active: Promise<void>[] = [];

  const runNext = async (): Promise<void> => {
    const item = pending.shift();
    if (!item) return;

    onStatusChange?.(item.id, "uploading");

    const result = await worker(item);
    onWorkerResult?.(item.id, result);

    if (result.ok) {
      onStatusChange?.(item.id, "processing");
    } else {
      onStatusChange?.(item.id, "error");
    }

    // Pick up next item in queue
    await runNext();
  };

  const slots = Math.min(concurrency, pending.length);
  for (let i = 0; i < slots; i++) {
    active.push(runNext());
  }

  await Promise.all(active);
}
