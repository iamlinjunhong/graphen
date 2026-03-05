import { useEffect, useMemo, useState } from "react";
import type { MemoryEntry } from "@graphen/shared";

interface UpdateMemoryDialogProps {
  open: boolean;
  entry: MemoryEntry | null;
  isSubmitting?: boolean;
  onClose: () => void;
  onSubmit: (content: string) => void | Promise<void>;
}

export function UpdateMemoryDialog({
  open,
  entry,
  isSubmitting = false,
  onClose,
  onSubmit,
}: UpdateMemoryDialogProps) {
  const [content, setContent] = useState("");

  const title = useMemo(() => {
    if (!entry) {
      return "编辑记忆";
    }
    return `编辑记忆 #${entry.id.slice(0, 8)}`;
  }, [entry]);

  useEffect(() => {
    if (!open || !entry) {
      return;
    }
    setContent(entry.content);
  }, [entry, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSubmitting) {
        onClose();
      }
    };

    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("keydown", onEscape);
    };
  }, [isSubmitting, onClose, open]);

  if (!open || !entry) {
    return null;
  }

  const trimmed = content.trim();
  const canSubmit = trimmed.length > 0 && !isSubmitting;

  return (
    <div
      className="memory-edit-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
    >
      <section className="memory-edit-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="memory-edit-header">
          <h3>{title}</h3>
          <button
            type="button"
            className="memory-edit-close"
            aria-label="关闭编辑弹窗"
            onClick={onClose}
            disabled={isSubmitting}
          >
            ✕
          </button>
        </header>

        <div className="memory-edit-body">
          <label htmlFor="memory-edit-content">记忆内容</label>
          <textarea
            id="memory-edit-content"
            value={content}
            onChange={(event) => setContent(event.currentTarget.value)}
            placeholder="请输入记忆内容"
            rows={8}
            disabled={isSubmitting}
          />
          <p>编辑后会重新提取三元组并同步记忆状态。</p>
        </div>

        <footer className="memory-edit-footer">
          <button type="button" className="memory-edit-cancel" onClick={onClose} disabled={isSubmitting}>
            取消
          </button>
          <button
            type="button"
            className="memory-edit-submit"
            disabled={!canSubmit}
            onClick={() => {
              if (!canSubmit) {
                return;
              }
              void onSubmit(trimmed);
            }}
          >
            {isSubmitting ? "保存中..." : "保存修改"}
          </button>
        </footer>
      </section>
    </div>
  );
}
