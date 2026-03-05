import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import type { MemoryFact } from "@graphen/shared";
import { useMemoryStore, EMPTY_FACTS } from "../stores/useMemoryStore";
import { MemoryFactCard } from "./MemoryFactCard";

type ExtractionStatus = "idle" | "extracting" | "done";

interface ChatMemoryIndicatorProps {
  sessionId: string;
  messageId: string;
  /** Timestamp (ISO) of when the assistant message completed */
  completedAt: string;
}

const POLL_INTERVAL = 2000;
const MAX_POLLS = 5;

export function ChatMemoryIndicator({ sessionId, messageId, completedAt }: ChatMemoryIndicatorProps) {
  const facts = useMemoryStore((s) => s.factsByChatSessionId[sessionId] ?? EMPTY_FACTS);
  const loadFacts = useMemoryStore((s) => s.loadFactsByChatSessionId);

  const [extractionStatus, setExtractionStatus] = useState<ExtractionStatus>("extracting");
  const [expanded, setExpanded] = useState(false);
  const pollCountRef = useRef(0);
  const prevFactCountRef = useRef(facts.length);

  const poll = useCallback(() => {
    loadFacts(sessionId, completedAt);
  }, [sessionId, completedAt, loadFacts]);

  useEffect(() => {
    pollCountRef.current = 0;
    prevFactCountRef.current = 0;
    setExtractionStatus("extracting");

    // Initial poll
    poll();

    const timer = setInterval(() => {
      pollCountRef.current += 1;
      if (pollCountRef.current >= MAX_POLLS) {
        clearInterval(timer);
        setExtractionStatus("done");
        return;
      }
      poll();
    }, POLL_INTERVAL);

    return () => clearInterval(timer);
  }, [sessionId, completedAt, poll]);

  // Detect when new facts arrive
  useEffect(() => {
    if (facts.length > prevFactCountRef.current) {
      prevFactCountRef.current = facts.length;
    }
  }, [facts.length]);

  const hasConflicted = facts.some((f) => f.reviewStatus === "conflicted");

  if (extractionStatus === "idle") return null;

  return (
    <div className="chat-memory-indicator">
      <div className="chat-memory-status-row">
        <span className={`chat-memory-dot ${extractionStatus === "extracting" ? "is-extracting" : "is-done"}`} />
        <span>
          {extractionStatus === "extracting"
            ? "记忆提取中..."
            : facts.length > 0
              ? `提取完成 · 新增 ${facts.length} 条记忆`
              : "提取完成 · 无新增记忆"}
        </span>
        {hasConflicted && <AlertTriangle size={14} color="#c4683f" />}
        {facts.length > 0 && (
          <button type="button" className="chat-memory-toggle" onClick={() => setExpanded((e) => !e)}>
            {expanded ? "收起" : "展开"}
          </button>
        )}
      </div>

      {extractionStatus === "extracting" && (
        <div className="chat-memory-progress">
          <div className="docs-progress-track">
            <div className="docs-progress-fill is-indeterminate" />
          </div>
        </div>
      )}

      <AnimatePresence initial={false}>
        {expanded && facts.length > 0 && (
          <motion.div
            className="chat-memory-list"
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
    </div>
  );
}
