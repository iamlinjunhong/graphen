import { useEffect, useMemo, useRef, useState } from "react";
import type { MemorySortColumn, MemorySortDirection } from "../stores/useMemoryStore";

interface SortDropdownProps {
  column: MemorySortColumn;
  direction: MemorySortDirection;
  onChange: (column: MemorySortColumn, direction: MemorySortDirection) => void;
}

interface SortOption {
  value: MemorySortColumn;
  label: string;
}

const SORT_OPTIONS: SortOption[] = [
  { value: "content", label: "内容" },
  { value: "sourceType", label: "来源" },
  { value: "createdAt", label: "创建时间" },
  { value: "updatedAt", label: "更新时间" },
  { value: "lastSeenAt", label: "最近访问" },
];

export function SortDropdown({ column, direction, onChange }: SortDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const currentLabel = useMemo(
    () => SORT_OPTIONS.find((item) => item.value === column)?.label ?? "更新时间",
    [column]
  );

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

  return (
    <div className="memory-sort-dropdown" ref={rootRef}>
      <button
        type="button"
        className="memory-toolbar-button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        排序: {currentLabel} {direction === "asc" ? "↑" : "↓"}
      </button>

      {open ? (
        <div className="memory-sort-menu" role="menu" aria-label="排序设置">
          <div className="memory-sort-group">
            <p>排序字段</p>
            {SORT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`memory-sort-option${column === option.value ? " is-active" : ""}`}
                onClick={() => onChange(option.value, direction)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="memory-sort-group">
            <p>排序方向</p>
            <div className="memory-sort-direction-row">
              <button
                type="button"
                className={`memory-sort-option${direction === "asc" ? " is-active" : ""}`}
                onClick={() => onChange(column, "asc")}
              >
                升序
              </button>
              <button
                type="button"
                className={`memory-sort-option${direction === "desc" ? " is-active" : ""}`}
                onClick={() => onChange(column, "desc")}
              >
                降序
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
