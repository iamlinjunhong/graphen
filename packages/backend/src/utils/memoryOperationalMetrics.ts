import type { MemorySourceType } from "@graphen/shared";
import type { Pool } from "pg";
import { logger } from "./logger.js";

export type MemoryOperationalMetricName =
  | "document_memory_extraction"
  | "memory_evidence_write"
  | "memory_access_log_write";

export type MemoryOperationalMetricOutcome = "success" | "failure" | "deduplicated";

interface RecordMemoryOperationalMetricInput {
  metricName: MemoryOperationalMetricName;
  outcome: MemoryOperationalMetricOutcome;
  count?: number;
  sourceType?: MemorySourceType | "all";
}

export async function recordMemoryOperationalMetric(
  pool: Pool | undefined,
  input: RecordMemoryOperationalMetricInput
): Promise<void> {
  if (!pool) {
    return;
  }

  const count = Math.max(0, Math.floor(input.count ?? 1));
  if (count <= 0) {
    return;
  }

  const sourceType = input.sourceType ?? "all";
  try {
    await pool.query(
      `
        INSERT INTO memory_operational_metrics (
          metric_date,
          metric_name,
          source_type,
          outcome,
          metric_count,
          updated_at
        )
        VALUES (
          CURRENT_DATE,
          $1,
          $2,
          $3,
          $4,
          NOW()
        )
        ON CONFLICT (metric_date, metric_name, source_type, outcome)
        DO UPDATE SET
          metric_count = memory_operational_metrics.metric_count + EXCLUDED.metric_count,
          updated_at = NOW()
      `,
      [input.metricName, sourceType, input.outcome, count]
    );
  } catch (error) {
    logger.warn(
      {
        err: error,
        metricName: input.metricName,
        sourceType,
        outcome: input.outcome,
        count
      },
      "Failed to record memory operational metric"
    );
  }
}

