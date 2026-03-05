import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryBatchAction } from "../services/api.js";

interface BatchActionsDropdownProps {
  selectedCount: number;
  onAction: (action: MemoryBatchAction) => void | Promise<void>;
}

const BATCH_ACTION_OPTIONS: Array<{ action: MemoryBatchAction; label: string }> = [
  { action: "delete", label: "批量删除" },
  { action: "pause", label: "批量暂停" },
  { action: "archive", label: "批量归档" },
  { action: "resume", label: "批量恢复" },
  { action: "confirm", label: "批量确认" },
];

export function BatchActionsDropdown({ selectedCount, onAction }: BatchActionsDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonLabel = useMemo(() => `批量操作 (${selectedCount})`, [selectedCount]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onDocumentClick = (event: MouseEvent) => {
      if (!rootRef.current) {
        return;
      }
      if (!rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  const handleAction = (action: MemoryBatchAction): void => {
    if (action === "delete") {
      const confirmed = window.confirm(`确认删除已选中的 ${selectedCount} 条记忆吗？`);
      if (!confirmed) {
        return;
      }
    }

    setOpen(false);
    void onAction(action);
  };

  return (
    <div className="memory-batch-dropdown" ref={rootRef}>
      <button
        type="button"
        className="memory-toolbar-button is-batch"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {buttonLabel}
      </button>
      {open ? (
        <div className="memory-batch-menu" role="menu" aria-label="批量操作菜单">
          {BATCH_ACTION_OPTIONS.map((item) => (
            <button
              key={item.action}
              type="button"
              className="memory-batch-option"
              onClick={() => handleAction(item.action)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
