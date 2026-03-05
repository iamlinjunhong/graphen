import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { MemoryEntry, MemoryEntryFact, MemoryEvidence } from "@graphen/shared";
import type { MemoryAccessLog } from "../services/api.js";
import { CategoryBadges } from "./CategoryBadges";
import { MemoryDetailPanel } from "./MemoryDetailPanel";

export type MemoryRowAction =
  | "confirm"
  | "reject"
  | "pause"
  | "resume"
  | "archive"
  | "unarchive"
  | "edit"
  | "delete";

interface MemoryTableRowProps {
  entry: MemoryEntry;
  selected: boolean;
  expanded: boolean;
  entryFacts: MemoryEntryFact[];
  factsLoadingStatus: "idle" | "loading" | "loaded" | "error";
  factsError: string | null;
  evidenceByFactId: Record<string, MemoryEvidence[]>;
  accessLogs: MemoryAccessLog[];
  accessLogsLoadingStatus: "idle" | "loading" | "loaded" | "error";
  accessLogsError: string | null;
  relatedEntries: MemoryEntry[];
  relatedEntriesLoadingStatus: "idle" | "loading" | "loaded" | "error";
  relatedEntriesError: string | null;
  onToggleSelected: (entryId: string, checked: boolean) => void;
  onToggleExpanded: (entryId: string) => void;
  onNavigateToEntry: (entryId: string) => void;
  onAction: (entry: MemoryEntry, action: MemoryRowAction) => void | Promise<void>;
}

const SOURCE_LABELS: Record<MemoryEntry["sourceType"], string> = {
  document: "文档",
  chat_user: "用户对话",
  chat_assistant: "助手回复",
  manual: "手动"
};

const SOURCE_ICONS: Record<MemoryEntry["sourceType"], string> = {
  document: "📄",
  chat_user: "💬",
  chat_assistant: "🤖",
  manual: "✏️"
};

const STATE_LABELS: Record<MemoryEntry["state"], string> = {
  active: "活跃",
  paused: "暂停",
  archived: "归档",
  deleted: "已删除"
};

const REVIEW_STATUS_LABELS: Record<MemoryEntry["reviewStatus"], string> = {
  auto: "自动",
  confirmed: "已确认",
  modified: "已修改",
  rejected: "已拒绝",
  conflicted: "有冲突"
};

interface ActionItem {
  action: MemoryRowAction;
  label: string;
  isDanger?: boolean;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  });
}

function summarizeContent(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 80) {
    return normalized;
  }
  return `${normalized.slice(0, 80)}...`;
}

export function MemoryTableRow({
  entry,
  selected,
  expanded,
  entryFacts,
  factsLoadingStatus,
  factsError,
  evidenceByFactId,
  accessLogs,
  accessLogsLoadingStatus,
  accessLogsError,
  relatedEntries,
  relatedEntriesLoadingStatus,
  relatedEntriesError,
  onToggleSelected,
  onToggleExpanded,
  onNavigateToEntry,
  onAction
}: MemoryTableRowProps) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRootRef = useRef<HTMLTableCellElement | null>(null);
  const isMuted = entry.state === "paused" || entry.state === "archived";
  const showReviewStatusBadge = entry.state !== "deleted" && entry.reviewStatus !== "auto";
  const actionItems = useMemo<ActionItem[]>(() => {
    const items: ActionItem[] = [];

    if (entry.state !== "deleted" && entry.reviewStatus !== "confirmed") {
      items.push({ action: "confirm", label: "确认" });
    }
    if (entry.state !== "deleted" && entry.reviewStatus !== "rejected") {
      items.push({ action: "reject", label: "拒绝", isDanger: true });
    }

    if (entry.state === "active") {
      items.push({ action: "pause", label: "暂停" });
      items.push({ action: "archive", label: "归档" });
    } else if (entry.state === "paused") {
      items.push({ action: "resume", label: "恢复" });
      items.push({ action: "archive", label: "归档" });
    } else if (entry.state === "archived") {
      items.push({ action: "unarchive", label: "取消归档" });
    }

    if (entry.state !== "deleted") {
      items.push({ action: "edit", label: "编辑" });
      items.push({ action: "delete", label: "删除", isDanger: true });
    }

    return items;
  }, [entry.reviewStatus, entry.state]);

  useEffect(() => {
    if (!actionsOpen) {
      return;
    }

    const onDocumentClick = (event: MouseEvent) => {
      if (!actionsRootRef.current) {
        return;
      }
      if (!actionsRootRef.current.contains(event.target as Node)) {
        setActionsOpen(false);
      }
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActionsOpen(false);
      }
    };

    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onEscape);
    };
  }, [actionsOpen]);

  return (
    <>
      <tr
        data-memory-entry-id={entry.id}
        className={`memory-table-row${selected ? " is-selected" : ""}${expanded ? " is-expanded" : ""}${isMuted ? " is-muted" : ""}`}
        onClick={() => onToggleExpanded(entry.id)}
      >
        <td className="memory-cell-checkbox" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onToggleSelected(entry.id, event.currentTarget.checked)}
            aria-label={`选择记忆 ${entry.id}`}
          />
        </td>
        <td className="memory-cell-content" title={entry.content}>
          {summarizeContent(entry.content)}
        </td>
        <td className="memory-cell-categories">
          <CategoryBadges
            categories={entry.categories}
            maxVisible={2}
            emptyLabel="—"
            isMuted={isMuted}
          />
        </td>
        <td className="memory-cell-source">
          <span className="memory-source-pill">
            <span aria-hidden>{SOURCE_ICONS[entry.sourceType]}</span>
            <span>{SOURCE_LABELS[entry.sourceType]}</span>
          </span>
        </td>
        <td className="memory-cell-status">
          {showReviewStatusBadge ? (
            <span className={`memory-status-badge is-${entry.reviewStatus}`}>
              {REVIEW_STATUS_LABELS[entry.reviewStatus]}
            </span>
          ) : (
            <span className={`memory-entry-state-badge is-${entry.state}`}>{STATE_LABELS[entry.state]}</span>
          )}
        </td>
        <td className="memory-cell-time">{formatDate(entry.updatedAt)}</td>
        <td className="memory-cell-actions" onClick={(event) => event.stopPropagation()} ref={actionsRootRef}>
          <button
            type="button"
            className="memory-row-action-button"
            aria-label="行操作"
            aria-haspopup="menu"
            aria-expanded={actionsOpen}
            onClick={() => setActionsOpen((value) => !value)}
          >
            ⋯
          </button>
          {actionsOpen ? (
            <div className="memory-row-action-menu" role="menu" aria-label={`记忆 ${entry.id} 的操作菜单`}>
              {actionItems.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  className={`memory-row-action-item${item.isDanger ? " is-danger" : ""}`}
                  onClick={() => {
                    setActionsOpen(false);
                    void onAction(entry, item.action);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </td>
      </tr>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.tr
            className="memory-table-detail-row"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <td colSpan={7}>
              <motion.div
                className="memory-table-detail-motion-wrap"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
              >
                <MemoryDetailPanel
                  entry={entry}
                  facts={entryFacts}
                  factsLoadingStatus={factsLoadingStatus}
                  factsError={factsError}
                  evidenceByFactId={evidenceByFactId}
                  accessLogs={accessLogs}
                  accessLogsLoadingStatus={accessLogsLoadingStatus}
                  accessLogsError={accessLogsError}
                  relatedEntries={relatedEntries}
                  relatedEntriesLoadingStatus={relatedEntriesLoadingStatus}
                  relatedEntriesError={relatedEntriesError}
                  onNavigateToEntry={onNavigateToEntry}
                  onAction={onAction}
                />
              </motion.div>
            </td>
          </motion.tr>
        ) : null}
      </AnimatePresence>
    </>
  );
}
