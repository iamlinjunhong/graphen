import type { FactReviewStatus } from "@graphen/shared";

const STATUS_LABELS: Record<FactReviewStatus, string> = {
  auto: "自动提取",
  confirmed: "已确认",
  modified: "已修改",
  rejected: "已拒绝",
  conflicted: "冲突",
};

interface MemoryStatusBadgeProps {
  status: FactReviewStatus;
}

export function MemoryStatusBadge({ status }: MemoryStatusBadgeProps) {
  return (
    <span className={`memory-status-badge is-${status}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}
