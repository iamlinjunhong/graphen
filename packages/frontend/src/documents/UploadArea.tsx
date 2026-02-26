import { useCallback, useEffect, useRef, useState } from "react";
import { useDocumentStore } from "../stores/useDocumentStore";
import type { UploadQueueItem } from "../stores/useDocumentStore";
import { apiClient } from "../services/api";

// B15: Document status → coarse progress mapping
const PIPELINE_PROGRESS: Record<string, number> = {
  uploading: 10,
  parsing: 30,
  extracting: 50,
  embedding: 80,
  completed: 100,
  error: 0,
};

function statusLabel(item: UploadQueueItem): string {
  switch (item.status) {
    case "queued":
      return "Queued";
    case "uploading":
      return "Uploading";
    case "processing":
      return "Processing";
    case "completed":
      return "Completed";
    case "error":
      return item.errorStage === "pipeline" ? "Parse Error" : "Upload Error";
    default:
      return item.status;
  }
}

function progressPercent(item: UploadQueueItem, docStatus?: string): number {
  if (item.status === "completed") return 100;
  if (item.status === "error") return 100;
  if (item.status === "queued") return 0;
  if (item.status === "uploading") return -1; // indeterminate
  // processing — use document status mapping
  if (item.status === "processing" && docStatus) {
    return PIPELINE_PROGRESS[docStatus] ?? 50;
  }
  return 50;
}

// B17: Track items that should fade out
function useFadeOut(items: UploadQueueItem[], removeQueueItem: (id: string) => void) {
  const fadingRef = useRef<Set<string>>(new Set());
  const [fadingIds, setFadingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const completedIds = items
      .filter((i) => i.status === "completed")
      .map((i) => i.id);

    for (const id of completedIds) {
      if (fadingRef.current.has(id)) continue;
      fadingRef.current.add(id);

      // Start CSS fade after a brief pause
      setTimeout(() => {
        setFadingIds((prev) => new Set(prev).add(id));
      }, 1200);

      // Remove from queue after fade completes
      setTimeout(() => {
        fadingRef.current.delete(id);
        setFadingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        removeQueueItem(id);
      }, 2000);
    }
  }, [items, removeQueueItem]);

  return fadingIds;
}

interface UploadAreaProps {
  isUploading: boolean;
  uploads: { id: string; filename: string; progress: number; status: string; error?: string }[];
  onUpload: (file: File) => Promise<void>;
  onRetryUpload?: (item: UploadQueueItem) => void;
  onRetryParse?: (documentId: string) => void;
}

export function UploadArea({ isUploading, uploads, onRetryUpload, onRetryParse }: UploadAreaProps) {
  const uploadQueue = useDocumentStore((s) => s.uploadQueue);
  const batchUploadTotal = useDocumentStore((s) => s.batchUploadTotal);
  const batchUploadCompleted = useDocumentStore((s) => s.batchUploadCompleted);
  const batchUploadFailed = useDocumentStore((s) => s.batchUploadFailed);
  const removeQueueItem = useDocumentStore((s) => s.removeQueueItem);
  const documents = useDocumentStore((s) => s.documents);

  const fadingIds = useFadeOut(uploadQueue, removeQueueItem);

  // Build a documentId → status lookup for processing progress
  const docStatusMap = new Map(documents.map((d) => [d.id, d.status]));

  // Merge: show uploadQueue items if any, otherwise fall back to legacy uploads
  const items = uploadQueue.length > 0 ? uploadQueue : [];

  // B16: Summary counts
  const processing = items.filter((i) => i.status === "uploading" || i.status === "processing").length;
  const queued = items.filter((i) => i.status === "queued").length;
  const completed = items.filter((i) => i.status === "completed").length;
  const failed = items.filter((i) => i.status === "error").length;
  const total = batchUploadTotal || items.length;

  // B18: Retry handlers
  const handleRetryUpload = useCallback(
    (item: UploadQueueItem) => {
      if (onRetryUpload) {
        onRetryUpload(item);
      }
    },
    [onRetryUpload]
  );

  const handleRetryParse = useCallback(
    (documentId: string) => {
      if (onRetryParse) {
        onRetryParse(documentId);
      } else {
        // Default: call reparse API directly
        void apiClient.documents.reparse(documentId);
      }
    },
    [onRetryParse]
  );

  // Nothing to show
  if (items.length === 0 && uploads.length === 0) return null;

  // Legacy fallback for single-file uploads that only use the old uploads array
  if (items.length === 0 && uploads.length > 0) {
    return (
      <section className="panel content-panel docs-upload-panel">
        <h3>
          Upload Queue
          {isUploading ? (
            <span className="docs-uploading-hint" style={{ marginLeft: 8, fontSize: 11 }}>
              Uploading...
            </span>
          ) : null}
        </h3>
        <div className="docs-upload-list" aria-label="Upload queue">
          {uploads.map((upload) => (
            <article key={upload.id} className="docs-upload-item">
              <div className="docs-upload-item-head">
                <strong>{upload.filename}</strong>
                <span>{upload.status}</span>
              </div>
              <div
                className="docs-progress-track"
                role="progressbar"
                aria-valuenow={upload.progress}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="docs-progress-fill" style={{ width: `${upload.progress}%` }} />
              </div>
              {upload.error ? (
                <small className="docs-error-inline">{upload.error}</small>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="panel content-panel docs-upload-panel">
      <h3>
        Upload Queue
        {isUploading ? (
          <span className="docs-uploading-hint" style={{ marginLeft: 8, fontSize: 11 }}>
            Uploading...
          </span>
        ) : null}
      </h3>

      <div className="docs-upload-list" aria-label="Upload queue">
        {items.map((item) => {
          const docStatus = item.documentId ? docStatusMap.get(item.documentId) : undefined;
          const pct = progressPercent(item, docStatus);
          const isIndeterminate = pct === -1;
          const isFading = fadingIds.has(item.id);

          return (
            <article
              key={item.id}
              className={`docs-upload-item${isFading ? " is-fading" : ""}`}
            >
              <div className="docs-upload-item-head">
                <strong>📄 {item.filename}</strong>
                <span
                  className={
                    item.status === "error"
                      ? "docs-queue-status is-error"
                      : item.status === "completed"
                        ? "docs-queue-status is-completed"
                        : "docs-queue-status"
                  }
                >
                  {statusLabel(item)}
                </span>
              </div>

              {/* B14: Progress bar — indeterminate for uploading, determinate otherwise */}
              <div
                className="docs-progress-track"
                role="progressbar"
                aria-valuenow={isIndeterminate ? undefined : pct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={`docs-progress-fill${isIndeterminate ? " is-indeterminate" : ""}`}
                  style={isIndeterminate ? undefined : { width: `${pct}%` }}
                />
              </div>

              {/* B18: Error message + retry buttons */}
              {item.status === "error" && (
                <div className="docs-upload-item-error">
                  <small className="docs-error-inline">
                    {item.errorMessage ?? "Unknown error"}
                  </small>
                  {item.errorStage === "upload" && item.file && (
                    <button
                      type="button"
                      className="docs-retry-button"
                      onClick={() => handleRetryUpload(item)}
                    >
                      Retry Upload
                    </button>
                  )}
                  {item.errorStage === "pipeline" && item.documentId && (
                    <button
                      type="button"
                      className="docs-retry-button"
                      onClick={() => handleRetryParse(item.documentId!)}
                    >
                      Retry Parse
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      {/* B16: Summary row */}
      {total > 1 && (
        <div className="docs-upload-summary">
          Total: {total} files
          {processing > 0 && ` · ${processing} processing`}
          {queued > 0 && ` · ${queued} queued`}
          {completed > 0 && ` · ${completed} completed`}
          {failed > 0 && ` · ${failed} failed`}
        </div>
      )}
    </section>
  );
}
