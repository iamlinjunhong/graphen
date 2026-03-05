import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle, X } from "lucide-react";
import type { MemoryFact } from "@graphen/shared";
import { MemoryFactCard } from "./MemoryFactCard";

interface MemoryFactsPanelProps {
  facts: MemoryFact[];
  hasConflicted: boolean;
  onDismiss?: () => void;
}

const AUTO_DISMISS_EMPTY = 3000;
const AUTO_DISMISS_WITH_FACTS = 8000;

export function MemoryFactsPanel({ facts, hasConflicted, onDismiss }: MemoryFactsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [visible, setVisible] = useState(true);

  const dismiss = () => {
    setVisible(false);
    onDismiss?.();
  };

  // Auto-dismiss timer — paused while expanded
  useEffect(() => {
    if (!visible || expanded) return;
    const delay = facts.length > 0 ? AUTO_DISMISS_WITH_FACTS : AUTO_DISMISS_EMPTY;
    const timer = setTimeout(dismiss, delay);
    return () => clearTimeout(timer);
  }, [visible, expanded, facts.length]);

  const summary =
    facts.length > 0
      ? `提取完成 · 新增 ${facts.length} 条记忆`
      : "提取完成 · 无新增记忆";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="memory-facts-toast"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
        >
          <div className="memory-facts-toast-header">
            <CheckCircle size={14} className="memory-facts-toast-icon" />
            <span className="memory-facts-summary">{summary}</span>
            {hasConflicted && (
              <AlertTriangle size={14} color="#c4683f" className="memory-facts-warning" />
            )}
            {facts.length > 0 && (
              <button
                type="button"
                className="chat-memory-toggle"
                onClick={() => setExpanded((e) => !e)}
              >
                {expanded ? "收起" : "展开"}
              </button>
            )}
            <button type="button" className="memory-facts-toast-close" onClick={dismiss} aria-label="关闭">
              <X size={14} />
            </button>
          </div>

          <AnimatePresence initial={false}>
            {expanded && facts.length > 0 && (
              <motion.div
                className="memory-facts-list"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
              >
                {facts.map((fact) => (
                  <MemoryFactCard key={fact.id} fact={fact} compact />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
