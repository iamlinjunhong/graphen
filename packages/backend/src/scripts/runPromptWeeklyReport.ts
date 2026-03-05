import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface EvalReport {
  eval_run_id: string;
  prompt_versions: Record<"analysis" | "chat" | "memory", string>;
  summary: {
    total: number;
    passed: number;
    failed: number;
    pass_rate: number;
  };
  metrics: {
    identity_qa_accuracy: number;
    memory_priority_hit: number;
    noise_override_rate: number;
    invalid_memory_write_rate: number;
  };
}

interface WeeklyPromptSummary {
  week_id: string;
  period_start: string;
  period_end: string;
  total_runs: number;
  run_ids: string[];
  avg_metrics: {
    pass_rate: number;
    identity_qa_accuracy: number;
    memory_priority_hit: number;
    noise_override_rate: number;
    invalid_memory_write_rate: number;
  };
  runs_by_prompt_version: Array<{
    prompt_versions: Record<"analysis" | "chat" | "memory", string>;
    runs: number;
    avg_pass_rate: number;
  }>;
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "../../../../");
  const reportsDir = resolve(repoRoot, process.argv[2] ?? "docs/prompt/eval_reports");
  const weeklyDir = resolve(reportsDir, "weekly");
  await mkdir(weeklyDir, { recursive: true });

  const files = await readdir(reportsDir);
  const evalJsonFiles = files.filter((name) =>
    /^eval_\d{8}_\d{6}(?:_\d{3})?(?:_[a-z0-9_-]+)?\.json$/i.test(name)
  );
  if (evalJsonFiles.length === 0) {
    console.log("No eval reports found. Weekly archive skipped.");
    return;
  }

  const reports: Array<{ report: EvalReport; runTime: Date }> = [];
  for (const name of evalJsonFiles) {
    const content = await readFile(resolve(reportsDir, name), "utf8");
    const report = JSON.parse(content) as EvalReport;
    const runTime = parseRunTime(report.eval_run_id);
    reports.push({ report, runTime });
  }

  const latestRun = reports.reduce((latest, current) =>
    current.runTime > latest.runTime ? current : latest
  );
  const periodEnd = latestRun.runTime;
  const periodStart = new Date(periodEnd.getTime() - 6 * 24 * 60 * 60 * 1000);
  const selected = reports.filter((item) =>
    item.runTime >= periodStart && item.runTime <= periodEnd
  );

  const summary = buildWeeklySummary(selected, periodStart, periodEnd);
  const jsonPath = resolve(weeklyDir, `${summary.week_id}.json`);
  const markdownPath = resolve(weeklyDir, `${summary.week_id}.md`);
  await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, buildWeeklyMarkdown(summary), "utf8");

  console.log("Prompt weekly report generated.");
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${markdownPath}`);
}

function buildWeeklySummary(
  reports: Array<{ report: EvalReport; runTime: Date }>,
  periodStart: Date,
  periodEnd: Date
): WeeklyPromptSummary {
  const runIds = reports.map((item) => item.report.eval_run_id);
  const totals = reports.reduce(
    (acc, item) => {
      acc.passRate += item.report.summary.pass_rate;
      acc.identity += item.report.metrics.identity_qa_accuracy;
      acc.memory += item.report.metrics.memory_priority_hit;
      acc.noise += item.report.metrics.noise_override_rate;
      acc.invalid += item.report.metrics.invalid_memory_write_rate;
      return acc;
    },
    { passRate: 0, identity: 0, memory: 0, noise: 0, invalid: 0 }
  );

  const divisor = Math.max(1, reports.length);
  const byVersion = new Map<string, { version: EvalReport["prompt_versions"]; runs: number; passRateTotal: number }>();
  for (const item of reports) {
    const key = `${item.report.prompt_versions.analysis}|${item.report.prompt_versions.chat}|${item.report.prompt_versions.memory}`;
    const current = byVersion.get(key) ?? {
      version: item.report.prompt_versions,
      runs: 0,
      passRateTotal: 0
    };
    current.runs += 1;
    current.passRateTotal += item.report.summary.pass_rate;
    byVersion.set(key, current);
  }

  const weekId = `week_${toCompactDate(periodStart)}_${toCompactDate(periodEnd)}`;
  return {
    week_id: weekId,
    period_start: periodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    total_runs: reports.length,
    run_ids: runIds,
    avg_metrics: {
      pass_rate: toRatio(totals.passRate / divisor),
      identity_qa_accuracy: toRatio(totals.identity / divisor),
      memory_priority_hit: toRatio(totals.memory / divisor),
      noise_override_rate: toRatio(totals.noise / divisor),
      invalid_memory_write_rate: toRatio(totals.invalid / divisor)
    },
    runs_by_prompt_version: [...byVersion.values()].map((item) => ({
      prompt_versions: item.version,
      runs: item.runs,
      avg_pass_rate: toRatio(item.passRateTotal / item.runs)
    }))
  };
}

function buildWeeklyMarkdown(summary: WeeklyPromptSummary): string {
  const versionRows = summary.runs_by_prompt_version
    .map((item) =>
      `| ${item.prompt_versions.analysis}/${item.prompt_versions.chat}/${item.prompt_versions.memory} | ${item.runs} | ${item.avg_pass_rate.toFixed(4)} |`
    )
    .join("\n");
  return [
    `# Prompt Weekly Summary (${summary.week_id})`,
    "",
    `- Period: ${summary.period_start} ~ ${summary.period_end}`,
    `- Total Runs: ${summary.total_runs}`,
    "",
    "## Avg Metrics",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| pass_rate | ${summary.avg_metrics.pass_rate.toFixed(4)} |`,
    `| identity_qa_accuracy | ${summary.avg_metrics.identity_qa_accuracy.toFixed(4)} |`,
    `| memory_priority_hit | ${summary.avg_metrics.memory_priority_hit.toFixed(4)} |`,
    `| noise_override_rate | ${summary.avg_metrics.noise_override_rate.toFixed(4)} |`,
    `| invalid_memory_write_rate | ${summary.avg_metrics.invalid_memory_write_rate.toFixed(4)} |`,
    "",
    "## Runs by Prompt Version",
    "",
    "| prompt_versions | runs | avg_pass_rate |",
    "|---|---:|---:|",
    versionRows || "| N/A | 0 | 0.0000 |",
    ""
  ].join("\n");
}

function parseRunTime(evalRunId: string): Date {
  const match = evalRunId.match(
    /^eval_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_(\d{3}))?(?:_[a-z0-9_-]+)?$/i
  );
  if (!match) {
    return new Date(0);
  }
  const [, y, m, d, hh, mm, ss, ms] = match;
  const millisecond = ms ?? "000";
  return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}.${millisecond}Z`);
}

function toRatio(value: number): number {
  return Number(value.toFixed(4));
}

function toCompactDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Prompt weekly report failed: ${message}`);
  process.exitCode = 1;
});
