import type { UploadItem } from "../stores/useDocumentStore";

interface UploadAreaProps {
  isUploading: boolean;
  uploads: UploadItem[];
  maxSizeBytes?: number;
  onUpload: (file: File) => Promise<void>;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

/**
 * Only shows the upload progress queue — no drag-drop zone.
 * The actual file trigger is a hidden <input> in DocumentView.
 */
export function UploadArea({ isUploading, uploads }: UploadAreaProps) {
  if (uploads.length === 0) {
    return null;
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
