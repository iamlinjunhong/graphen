import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryFact } from "@graphen/shared";
import { apiClient } from "../services/api";
import { useMemoryStore, EMPTY_FACTS } from "../stores/useMemoryStore";

type ExtractionStatus = "idle" | "extracting" | "done";

export interface UseMemoryExtractionReturn {
  /** Current extraction state */
  status: ExtractionStatus;
  /** Facts retrieved for the current session */
  facts: MemoryFact[];
  /** Whether any fact has reviewStatus "conflicted" */
  hasConflicted: boolean;
  /** Trigger extraction for the given session, then start polling */
  startExtraction: (sessionId: string) => void;
  /** Reset to idle (used on session change) */
  reset: () => void;
}

const MAX_POLLS = 5;
const POLL_INTERVAL = 2000;

export function useMemoryExtraction(): UseMemoryExtractionReturn {
  const [status, setStatus] = useState<ExtractionStatus>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
  const runTokenRef = useRef(0);

  const loadFacts = useMemoryStore((s) => s.loadFactsByChatSessionId);
  const facts = useMemoryStore(
    (s) => (sessionId ? s.factsByChatSessionId[sessionId] ?? EMPTY_FACTS : EMPTY_FACTS),
  );

  const hasConflicted = facts.some((f) => f.reviewStatus === "conflicted");

  const clearPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    pollCountRef.current = 0;
  }, []);

  const reset = useCallback(() => {
    runTokenRef.current += 1;
    clearPolling();
    setStatus("idle");
    setSessionId(null);
  }, [clearPolling]);

  const startExtraction = useCallback(
    (sid: string) => {
      const runToken = runTokenRef.current + 1;
      runTokenRef.current = runToken;

      // Clear any existing polling
      clearPolling();

      setSessionId(sid);
      setStatus("extracting");
      pollCountRef.current = 0;

      void (async () => {
        try {
          await apiClient.chat.triggerMemoryExtraction(sid);
          if (runTokenRef.current !== runToken) {
            return;
          }
          await loadFacts(sid);
        } catch {
          if (runTokenRef.current !== runToken) {
            return;
          }
          clearPolling();
          setStatus("idle");
          return;
        }

        if (runTokenRef.current !== runToken) {
          return;
        }
        intervalRef.current = setInterval(() => {
          if (runTokenRef.current !== runToken) {
            clearPolling();
            return;
          }
          pollCountRef.current += 1;
          if (pollCountRef.current >= MAX_POLLS) {
            clearPolling();
            setStatus("done");
            return;
          }
          loadFacts(sid).catch(() => {
            if (runTokenRef.current !== runToken) {
              return;
            }
            clearPolling();
            setStatus("idle");
          });
        }, POLL_INTERVAL);
      })();
    },
    [loadFacts, clearPolling],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearPolling();
    };
  }, [clearPolling]);

  return { status, facts, hasConflicted, startExtraction, reset };
}
