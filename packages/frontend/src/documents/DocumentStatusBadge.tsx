import type { DocumentStatus } from "@graphen/shared";

type ExtendedDocumentStatus = DocumentStatus | "pending";

interface DocumentStatusBadgeProps {
  status: ExtendedDocumentStatus;
}

const STATUS_LABELS: Record<ExtendedDocumentStatus, string> = {
  pending: "Pending",
  uploading: "Uploading",
  parsing: "Parsing",
  extracting: "Extracting",
  embedding: "Embedding",
  completed: "Completed",
  error: "Error"
};

export function DocumentStatusBadge({ status }: DocumentStatusBadgeProps) {
  return (
    <span className={`doc-status-badge is-${status}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}
