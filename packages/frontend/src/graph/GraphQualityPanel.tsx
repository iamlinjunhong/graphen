import { useCallback, useEffect, useState } from "react";
import type { GraphQualityReport } from "@graphen/shared";
import { apiClient } from "../services/api";

interface QualityItem {
  label: string;
  value: number;
  severity: "ok" | "warn" | "error";
}

function classifyItem(label: string, value: number): QualityItem {
  let severity: QualityItem["severity"] = "ok";
  if (label === "幽灵节点" || label === "疑似重复") {
    severity = value > 0 ? "error" : "ok";
  } else if (label === "孤立节点") {
    severity = value > 5 ? "warn" : value > 0 ? "warn" : "ok";
  } else if (label === "低置信度") {
    severity = value > 10 ? "error" : value > 0 ? "warn" : "ok";
  }
  return { label, value, severity };
}

export function GraphQualityPanel() {
  const [report, setReport] = useState<GraphQualityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiClient.graph.getQuality();
      setReport(result.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load quality report");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!collapsed && !report && !loading) {
      void fetchReport();
    }
  }, [collapsed, report, loading, fetchReport]);

  const items: QualityItem[] = report
    ? [
        classifyItem("幽灵节点", report.ghostNodes),
        classifyItem("孤立节点", report.isolatedNodes),
        classifyItem("低置信度", report.lowConfidenceNodes),
        classifyItem("疑似重复", report.suspectedDuplicates)
      ]
    : [];

  return (
    <section className="panel graph-quality-panel" aria-label="Graph quality">
      <button
        type="button"
        className="graph-quality-toggle"
        onClick={() => setCollapsed((prev) => !prev)}
      >
        <span>质量检测</span>
        <span className="graph-quality-arrow">{collapsed ? "▸" : "▾"}</span>
      </button>

      {!collapsed && (
        <div className="graph-quality-body">
          {loading && <p className="graph-quality-loading">检测中...</p>}
          {error && <p className="graph-quality-error">{error}</p>}
          {report && (
            <>
              <div className="graph-quality-summary">
                <span>节点 {report.totalNodes}</span>
                <span>边 {report.totalEdges}</span>
              </div>
              <ul className="graph-quality-list">
                {items.map((item) => (
                  <li key={item.label} className={`graph-quality-item severity-${item.severity}`}>
                    <span className="graph-quality-dot" />
                    <span className="graph-quality-label">{item.label}</span>
                    <span className="graph-quality-value">{item.value}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="docs-action-button"
                onClick={() => {
                  setReport(null);
                  void fetchReport();
                }}
                disabled={loading}
              >
                刷新
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
