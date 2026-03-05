import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPromptVersions } from "../prompts/versions.js";

type EvalCategory =
  | "identity"
  | "preference"
  | "history"
  | "conflict"
  | "noise_interference"
  | "invalid_input"
  | "third_party";

interface EvalReport {
  eval_run_id: string;
  dataset_version: string;
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
  failed_cases: Array<{ id: string; reason: string }>;
  case_results: Array<{
    id: string;
    category: EvalCategory;
    passed: boolean;
    failures: string[];
  }>;
}

interface PromptVersionSet {
  analysis: string;
  chat: string;
  memory: string;
}

interface ComparisonReport {
  comparison_id: string;
  baseline: {
    version: string;
    run_id: string;
    prompt_versions: PromptVersionSet;
    metrics: EvalReport["metrics"];
    summary: EvalReport["summary"];
    report_path: string;
  };
  candidate: {
    version: string;
    run_id: string;
    prompt_versions: PromptVersionSet;
    metrics: EvalReport["metrics"];
    summary: EvalReport["summary"];
    report_path: string;
  };
  improvements: Record<keyof EvalReport["metrics"], string>;
  regressions: string[];
  thresholds: {
    identity_qa_accuracy: number;
    memory_priority_hit: number;
    noise_override_rate: number;
    invalid_memory_write_rate: number;
  };
  threshold_passed: boolean;
  analysis: {
    improved_case_ids: string[];
    regressed_case_ids: string[];
    candidate_failed_by_category: Record<EvalCategory, number>;
    top_candidate_failures: Array<{ id: string; reason: string }>;
  };
  recommendation: string;
}

interface RunEvalResult {
  reportPath: string;
  report: EvalReport;
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "../../../../");
  const datasetPathArg = process.argv[2] ?? "docs/prompt/eval_dataset.json";
  const outputDirArg = process.argv[3] ?? "docs/prompt/eval_reports";
  const datasetPath = resolveFromRepo(repoRoot, datasetPathArg);
  const outputDir = resolveFromRepo(repoRoot, outputDirArg);
  await mkdir(outputDir, { recursive: true });

  const defaultCandidate = getPromptVersions();
  const baselineVersions: PromptVersionSet = {
    analysis: process.env.COMPARE_BASELINE_ANALYSIS?.trim() || "1.5.0",
    chat: process.env.COMPARE_BASELINE_CHAT?.trim() || "1.8.0",
    memory: process.env.COMPARE_BASELINE_MEMORY?.trim() || "1.6.0"
  };
  const candidateVersions: PromptVersionSet = {
    analysis: process.env.COMPARE_CANDIDATE_ANALYSIS?.trim() || defaultCandidate.analysis,
    chat: process.env.COMPARE_CANDIDATE_CHAT?.trim() || defaultCandidate.chat,
    memory: process.env.COMPARE_CANDIDATE_MEMORY?.trim() || defaultCandidate.memory
  };

  const baseline = await runEval({
    repoRoot,
    datasetPath,
    outputDir,
    runLabel: "baseline",
    profile: "legacy_v1",
    versions: baselineVersions
  });
  const candidate = await runEval({
    repoRoot,
    datasetPath,
    outputDir,
    runLabel: "candidate",
    profile: "memory_weaving_v2",
    versions: candidateVersions
  });

  const comparison = buildComparisonReport(baseline, candidate);
  const comparisonPath = resolve(outputDir, `${comparison.comparison_id}.json`);
  const comparisonMarkdownPath = resolve(outputDir, `${comparison.comparison_id}.md`);
  await writeFile(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
  await writeFile(comparisonMarkdownPath, buildComparisonMarkdown(comparison), "utf8");

  console.log("Prompt comparison completed.");
  console.log(`Baseline report: ${baseline.reportPath}`);
  console.log(`Candidate report: ${candidate.reportPath}`);
  console.log(`Comparison JSON: ${comparisonPath}`);
  console.log(`Comparison Markdown: ${comparisonMarkdownPath}`);
  console.log(`Recommendation: ${comparison.recommendation}`);
}

async function runEval(input: {
  repoRoot: string;
  datasetPath: string;
  outputDir: string;
  runLabel: string;
  profile: "legacy_v1" | "memory_weaving_v2";
  versions: PromptVersionSet;
}): Promise<RunEvalResult> {
  const env = {
    ...process.env,
    PROMPT_EVAL_PROFILE: input.profile,
    PROMPT_EVAL_RUN_LABEL: input.runLabel,
    PROMPT_VERSION_ANALYSIS: input.versions.analysis,
    PROMPT_VERSION_CHAT: input.versions.chat,
    PROMPT_VERSION_MEMORY: input.versions.memory
  };

  const command = "pnpm";
  const args = [
    "--filter",
    "@graphen/backend",
    "prompt:eval",
    input.datasetPath,
    input.outputDir
  ];
  const result = spawnSync(command, args, {
    cwd: input.repoRoot,
    env,
    encoding: "utf8"
  });

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`prompt:eval failed (${input.profile})\n${output}`);
  }

  const reportPath = parseReportPath(output, "JSON report:");
  if (!reportPath) {
    throw new Error(`cannot parse JSON report path from prompt:eval output (${input.profile})`);
  }

  const content = await readFile(reportPath, "utf8");
  const report = JSON.parse(content) as EvalReport;
  return {
    reportPath,
    report
  };
}

function parseReportPath(output: string, label: string): string | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escapedLabel}\\s*(.+)`);
  const match = output.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function buildComparisonReport(
  baseline: RunEvalResult,
  candidate: RunEvalResult
): ComparisonReport {
  const now = new Date();
  const comparisonId = `prompt_comparison_${now.toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15)}`;
  const threshold = {
    identity_qa_accuracy: 0.95,
    memory_priority_hit: 0.9,
    noise_override_rate: 0.05,
    invalid_memory_write_rate: 0.02
  };

  const improvements = {
    identity_qa_accuracy: formatDelta(
      candidate.report.metrics.identity_qa_accuracy - baseline.report.metrics.identity_qa_accuracy
    ),
    memory_priority_hit: formatDelta(
      candidate.report.metrics.memory_priority_hit - baseline.report.metrics.memory_priority_hit
    ),
    noise_override_rate: formatDelta(
      candidate.report.metrics.noise_override_rate - baseline.report.metrics.noise_override_rate
    ),
    invalid_memory_write_rate: formatDelta(
      candidate.report.metrics.invalid_memory_write_rate - baseline.report.metrics.invalid_memory_write_rate
    )
  };

  const regressions: string[] = [];
  if (candidate.report.metrics.identity_qa_accuracy + 1e-9 < baseline.report.metrics.identity_qa_accuracy) {
    regressions.push("identity_qa_accuracy degraded");
  }
  if (candidate.report.metrics.memory_priority_hit + 1e-9 < baseline.report.metrics.memory_priority_hit) {
    regressions.push("memory_priority_hit degraded");
  }
  if (candidate.report.metrics.noise_override_rate - 1e-9 > baseline.report.metrics.noise_override_rate) {
    regressions.push("noise_override_rate increased");
  }
  if (candidate.report.metrics.invalid_memory_write_rate - 1e-9 > baseline.report.metrics.invalid_memory_write_rate) {
    regressions.push("invalid_memory_write_rate increased");
  }

  const thresholdPassed =
    candidate.report.metrics.identity_qa_accuracy >= threshold.identity_qa_accuracy
    && candidate.report.metrics.memory_priority_hit >= threshold.memory_priority_hit
    && candidate.report.metrics.noise_override_rate <= threshold.noise_override_rate
    && candidate.report.metrics.invalid_memory_write_rate <= threshold.invalid_memory_write_rate;

  const baselineFailed = new Set(
    baseline.report.case_results.filter((result) => !result.passed).map((result) => result.id)
  );
  const candidateFailed = new Set(
    candidate.report.case_results.filter((result) => !result.passed).map((result) => result.id)
  );

  const improvedCaseIds = [...baselineFailed].filter((id) => !candidateFailed.has(id));
  const regressedCaseIds = [...candidateFailed].filter((id) => !baselineFailed.has(id));

  const failureByCategory = initCategoryCounter();
  for (const caseResult of candidate.report.case_results) {
    if (!caseResult.passed) {
      failureByCategory[caseResult.category] += 1;
    }
  }

  const recommendation = thresholdPassed && regressions.length === 0
    ? "APPROVE - 所有指标达标且无回归"
    : "HOLD - 指标未达标或存在回归";

  return {
    comparison_id: comparisonId,
    baseline: {
      version: `${baseline.report.prompt_versions.analysis}/${baseline.report.prompt_versions.chat}/${baseline.report.prompt_versions.memory}`,
      run_id: baseline.report.eval_run_id,
      prompt_versions: baseline.report.prompt_versions,
      metrics: baseline.report.metrics,
      summary: baseline.report.summary,
      report_path: baseline.reportPath
    },
    candidate: {
      version: `${candidate.report.prompt_versions.analysis}/${candidate.report.prompt_versions.chat}/${candidate.report.prompt_versions.memory}`,
      run_id: candidate.report.eval_run_id,
      prompt_versions: candidate.report.prompt_versions,
      metrics: candidate.report.metrics,
      summary: candidate.report.summary,
      report_path: candidate.reportPath
    },
    improvements,
    regressions,
    thresholds: threshold,
    threshold_passed: thresholdPassed,
    analysis: {
      improved_case_ids: improvedCaseIds,
      regressed_case_ids: regressedCaseIds,
      candidate_failed_by_category: failureByCategory,
      top_candidate_failures: candidate.report.failed_cases.slice(0, 10)
    },
    recommendation
  };
}

function initCategoryCounter(): Record<EvalCategory, number> {
  return {
    identity: 0,
    preference: 0,
    history: 0,
    conflict: 0,
    noise_interference: 0,
    invalid_input: 0,
    third_party: 0
  };
}

function buildComparisonMarkdown(report: ComparisonReport): string {
  const failureRows = Object.entries(report.analysis.candidate_failed_by_category)
    .map(([category, count]) => `| ${category} | ${count} |`)
    .join("\n");
  const topFailedLines = report.analysis.top_candidate_failures.length === 0
    ? "- None"
    : report.analysis.top_candidate_failures.map((item) => `- ${item.id}: ${item.reason}`).join("\n");
  const regressionLines = report.regressions.length === 0
    ? "- None"
    : report.regressions.map((item) => `- ${item}`).join("\n");
  const improvedLines = report.analysis.improved_case_ids.length === 0
    ? "- None"
    : report.analysis.improved_case_ids.map((item) => `- ${item}`).join("\n");
  const regressedLines = report.analysis.regressed_case_ids.length === 0
    ? "- None"
    : report.analysis.regressed_case_ids.map((item) => `- ${item}`).join("\n");

  return [
    `# Prompt Comparison Report (${report.comparison_id})`,
    "",
    `- Recommendation: ${report.recommendation}`,
    `- Threshold Passed: ${report.threshold_passed}`,
    "",
    "## Runs",
    "",
    `- Baseline: ${report.baseline.run_id} (${report.baseline.version})`,
    `- Candidate: ${report.candidate.run_id} (${report.candidate.version})`,
    "",
    "## Metrics",
    "",
    "| Metric | Baseline | Candidate | Delta | Threshold |",
    "|---|---:|---:|---:|---:|",
    `| identity_qa_accuracy | ${toFixed(report.baseline.metrics.identity_qa_accuracy)} | ${toFixed(report.candidate.metrics.identity_qa_accuracy)} | ${report.improvements.identity_qa_accuracy} | >= ${toFixed(report.thresholds.identity_qa_accuracy)} |`,
    `| memory_priority_hit | ${toFixed(report.baseline.metrics.memory_priority_hit)} | ${toFixed(report.candidate.metrics.memory_priority_hit)} | ${report.improvements.memory_priority_hit} | >= ${toFixed(report.thresholds.memory_priority_hit)} |`,
    `| noise_override_rate | ${toFixed(report.baseline.metrics.noise_override_rate)} | ${toFixed(report.candidate.metrics.noise_override_rate)} | ${report.improvements.noise_override_rate} | <= ${toFixed(report.thresholds.noise_override_rate)} |`,
    `| invalid_memory_write_rate | ${toFixed(report.baseline.metrics.invalid_memory_write_rate)} | ${toFixed(report.candidate.metrics.invalid_memory_write_rate)} | ${report.improvements.invalid_memory_write_rate} | <= ${toFixed(report.thresholds.invalid_memory_write_rate)} |`,
    "",
    "## Candidate Failure Distribution",
    "",
    "| Category | Failed Cases |",
    "|---|---:|",
    failureRows,
    "",
    "## Improvements",
    "",
    improvedLines,
    "",
    "## Regressions",
    "",
    regressedLines,
    "",
    "## Regression Signals",
    "",
    regressionLines,
    "",
    "## Top Candidate Failures",
    "",
    topFailedLines,
    ""
  ].join("\n");
}

function formatDelta(value: number): string {
  const percentage = value * 100;
  const sign = percentage >= 0 ? "+" : "";
  return `${sign}${percentage.toFixed(2)}%`;
}

function toFixed(value: number): string {
  return value.toFixed(4);
}

function resolveFromRepo(repoRoot: string, inputPath: string): string {
  if (inputPath.startsWith("/")) {
    return inputPath;
  }
  return resolve(repoRoot, inputPath);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Prompt comparison failed: ${message}`);
  process.exitCode = 1;
});
