import { useEffect, useState } from "react";

interface CreateMemoryDialogProps {
  open: boolean;
  isSubmitting?: boolean;
  onClose: () => void;
  onSubmit: (content: string) => void | Promise<void>;
}

export function CreateMemoryDialog({
  open,
  isSubmitting = false,
  onClose,
  onSubmit,
}: CreateMemoryDialogProps) {
  const [content, setContent] = useState("");

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

  useEffect(() => {
    if (open) {
      return;
    }
    setContent("");
  }, [open]);

  if (!open) {
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
      <section className="memory-edit-dialog" role="dialog" aria-modal="true" aria-label="创建新记忆">
        <header className="memory-edit-header">
          <div>
            <h3>创建新记忆</h3>
            <p className="memory-edit-subtitle">添加一条新记忆，系统将自动提取知识</p>
          </div>
          <button
            type="button"
            className="memory-edit-close"
            aria-label="关闭创建弹窗"
            onClick={onClose}
            disabled={isSubmitting}
          >
            ✕
          </button>
        </header>

        <div className="memory-edit-body">
          <label htmlFor="memory-create-content">记忆内容</label>
          <textarea
            id="memory-create-content"
            value={content}
            onChange={(event) => setContent(event.currentTarget.value)}
            placeholder="例如：张三是公司的CTO，负责整个技术部门的管理工作。"
            rows={8}
            disabled={isSubmitting}
          />
          <p>
            保存后将自动提取三元组并同步到知识图谱。如需精确编辑三元组，请前往「知识图谱」页面。
          </p>
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
            {isSubmitting ? "保存中..." : "保存记忆"}
          </button>
        </footer>
      </section>
    </div>
  );
}
