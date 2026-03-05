import type { MemoryEntry } from "@graphen/shared";
import type { MemoryRowAction } from "./MemoryTableRow";

interface MemoryDetailActionsProps {
  entry: MemoryEntry;
  onAction: (entry: MemoryEntry, action: MemoryRowAction) => void | Promise<void>;
}

export function MemoryDetailActions({ entry, onAction }: MemoryDetailActionsProps) {
  const canReview = entry.state !== "deleted";
  const canEdit = entry.state !== "deleted";
  const canDelete = entry.state !== "deleted";
  const canConfirm = canReview && entry.reviewStatus !== "confirmed";
  const canReject = canReview && entry.reviewStatus !== "rejected";

  return (
    <div className="memory-detail-actions">
      <div className="memory-detail-actions-left">
        {canReview ? (
          <>
            {canConfirm ? (
              <button type="button" className="memory-detail-btn" onClick={() => void onAction(entry, "confirm")}>
                确认
              </button>
            ) : null}
            {canReject ? (
              <button type="button" className="memory-detail-btn is-danger" onClick={() => void onAction(entry, "reject")}>
                拒绝
              </button>
            ) : null}
          </>
        ) : null}

        {entry.state === "active" ? (
          <>
            <button type="button" className="memory-detail-btn" onClick={() => void onAction(entry, "pause")}>
              暂停
            </button>
            <button type="button" className="memory-detail-btn" onClick={() => void onAction(entry, "archive")}>
              归档
            </button>
          </>
        ) : null}

        {entry.state === "paused" ? (
          <>
            <button type="button" className="memory-detail-btn" onClick={() => void onAction(entry, "resume")}>
              恢复
            </button>
            <button type="button" className="memory-detail-btn" onClick={() => void onAction(entry, "archive")}>
              归档
            </button>
          </>
        ) : null}

        {entry.state === "archived" ? (
          <button type="button" className="memory-detail-btn" onClick={() => void onAction(entry, "unarchive")}>
            取消归档
          </button>
        ) : null}
      </div>

      <div className="memory-detail-actions-right">
        {canEdit ? (
          <button type="button" className="memory-detail-btn" onClick={() => void onAction(entry, "edit")}>
            编辑
          </button>
        ) : null}
        {canDelete ? (
          <button type="button" className="memory-detail-btn is-danger" onClick={() => void onAction(entry, "delete")}>
            删除
          </button>
        ) : null}
      </div>
    </div>
  );
}
