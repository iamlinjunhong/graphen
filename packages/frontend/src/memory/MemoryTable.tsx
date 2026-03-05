import { useEffect, useRef } from "react";
import type { MemoryEntry, MemoryEntryFact, MemoryEvidence } from "@graphen/shared";
import type { MemoryAccessLog } from "../services/api.js";
import { MemoryTableRow, type MemoryRowAction } from "./MemoryTableRow";

interface MemoryTableProps {
  entries: MemoryEntry[];
  selectedIds: Set<string>;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  expandedEntryId: string | null;
  entryFactsByEntryId: Record<string, MemoryEntryFact[]>;
  accessLogsByEntryId: Record<string, MemoryAccessLog[]>;
  relatedEntriesByEntryId: Record<string, MemoryEntry[]>;
  detailLoadingStatus: Record<string, "idle" | "loading" | "loaded" | "error">;
  detailErrors: Record<string, string>;
  evidenceByFactId: Record<string, MemoryEvidence[]>;
  onToggleSelectAll: (checked: boolean) => void;
  onToggleSelected: (entryId: string, checked: boolean) => void;
  onToggleExpanded: (entryId: string) => void;
  onNavigateToEntry: (entryId: string) => void;
  onRowAction: (entry: MemoryEntry, action: MemoryRowAction) => void | Promise<void>;
}

export function MemoryTable({
  entries,
  selectedIds,
  allVisibleSelected,
  someVisibleSelected,
  expandedEntryId,
  entryFactsByEntryId,
  accessLogsByEntryId,
  relatedEntriesByEntryId,
  detailLoadingStatus,
  detailErrors,
  evidenceByFactId,
  onToggleSelectAll,
  onToggleSelected,
  onToggleExpanded,
  onNavigateToEntry,
  onRowAction
}: MemoryTableProps) {
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!selectAllRef.current) {
      return;
    }
    selectAllRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  return (
    <div className="memory-table-shell">
      <table className="memory-table">
        <thead>
          <tr>
            <th className="memory-cell-checkbox">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allVisibleSelected}
                onChange={(event) => onToggleSelectAll(event.currentTarget.checked)}
                aria-label="全选当前页"
              />
            </th>
            <th>内容</th>
            <th>分类</th>
            <th>来源</th>
            <th>审核/状态</th>
            <th>时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td colSpan={7} className="memory-table-empty">
                <p>暂无记忆数据</p>
                <span>请先通过文档解析、聊天或手动录入生成记忆。</span>
              </td>
            </tr>
          ) : (
            entries.map((entry) => (
              <MemoryTableRow
                key={entry.id}
                entry={entry}
                selected={selectedIds.has(entry.id)}
                expanded={expandedEntryId === entry.id}
                entryFacts={entryFactsByEntryId[entry.id] ?? []}
                factsLoadingStatus={detailLoadingStatus[`entryFacts:${entry.id}`] ?? "idle"}
                factsError={detailErrors[`entryFacts:${entry.id}`] ?? null}
                evidenceByFactId={evidenceByFactId}
                accessLogs={accessLogsByEntryId[entry.id] ?? []}
                accessLogsLoadingStatus={detailLoadingStatus[`accessLogs:${entry.id}`] ?? "idle"}
                accessLogsError={detailErrors[`accessLogs:${entry.id}`] ?? null}
                relatedEntries={relatedEntriesByEntryId[entry.id] ?? []}
                relatedEntriesLoadingStatus={detailLoadingStatus[`relatedEntries:${entry.id}`] ?? "idle"}
                relatedEntriesError={detailErrors[`relatedEntries:${entry.id}`] ?? null}
                onToggleSelected={onToggleSelected}
                onToggleExpanded={onToggleExpanded}
                onNavigateToEntry={onNavigateToEntry}
                onAction={onRowAction}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
