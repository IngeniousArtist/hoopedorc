import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEVERITIES = ["info", "low", "moderate", "high", "critical"];

function emptyCounts() {
  return {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
    total: 0,
  };
}

function vulnerabilityCounts(report) {
  const counts = emptyCounts();
  const source = report?.metadata?.vulnerabilities;
  if (source == null || typeof source !== "object") return counts;

  for (const severity of SEVERITIES) {
    const value = source[severity];
    counts[severity] =
      Number.isInteger(value) && value >= 0 ? value : 0;
  }
  const reportedTotal = source.total;
  counts.total =
    Number.isInteger(reportedTotal) && reportedTotal >= 0
      ? reportedTotal
      : SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0);
  return counts;
}

function errorDetail(error, stderr) {
  if (error instanceof Error) return error.message;
  const text = String(stderr ?? "").trim();
  return text || "npm audit failed without an error description";
}

export function classifyAuditResult({ status, stdout, stderr, error }) {
  if (error != null) {
    return {
      classification: "execution_error",
      exitCode: 1,
      npmExitCode: null,
      vulnerabilities: emptyCounts(),
      detail: errorDetail(error, stderr),
    };
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return {
      classification: "malformed_response",
      exitCode: 1,
      npmExitCode: status,
      vulnerabilities: emptyCounts(),
      detail: errorDetail(undefined, stderr || stdout),
    };
  }

  if (report?.error != null) {
    const auditError = report.error;
    const detail = [
      auditError.code,
      auditError.summary,
      auditError.detail,
      report.message,
    ]
      .filter((value) => typeof value === "string" && value.length > 0)
      .join(": ");
    return {
      classification: "registry_error",
      exitCode: 1,
      npmExitCode: status,
      vulnerabilities: emptyCounts(),
      detail: detail || "npm registry returned an audit error",
    };
  }

  const vulnerabilities = vulnerabilityCounts(report);
  if (vulnerabilities.high + vulnerabilities.critical > 0) {
    return {
      classification: "high_severity_vulnerabilities",
      exitCode: 2,
      npmExitCode: status,
      vulnerabilities,
      detail: `${vulnerabilities.high} high and ${vulnerabilities.critical} critical vulnerabilities`,
    };
  }

  if (status !== 0) {
    return {
      classification: "audit_error",
      exitCode: 1,
      npmExitCode: status,
      vulnerabilities,
      detail: errorDetail(undefined, stderr),
    };
  }

  return {
    classification: "clean",
    exitCode: 0,
    npmExitCode: status,
    vulnerabilities,
    detail: "No high or critical vulnerabilities reported",
  };
}

function escapeWorkflowCommand(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function markdownSummary(summary) {
  const counts = summary.vulnerabilities;
  return [
    "## npm high-severity audit",
    "",
    `- Owner: \`${summary.owner}\``,
    `- Classification: \`${summary.classification}\``,
    `- npm exit code: \`${summary.npmExitCode ?? "spawn failure"}\``,
    `- High: ${counts.high}`,
    `- Critical: ${counts.critical}`,
    `- Detail: ${summary.detail}`,
    "",
  ].join("\n");
}

function annotation(summary) {
  const message = escapeWorkflowCommand(
    `${summary.detail}. Owner: ${summary.owner}. See the npm-audit artifact.`,
  );
  if (summary.classification === "clean") {
    return `::notice title=Dependency audit clean::${message}`;
  }
  if (summary.classification === "high_severity_vulnerabilities") {
    return `::warning title=High-severity dependency findings::${message}`;
  }
  return `::error title=Dependency audit unavailable::${message}`;
}

function main() {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outputDir = resolve(rootDir, "audit-results");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npmCommand,
    ["audit", "--audit-level=high", "--json"],
    {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const classified = classifyAuditResult({
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  });
  const summary = {
    generatedAt: new Date().toISOString(),
    owner: process.env.AUDIT_OWNER || "IngeniousArtist",
    ...classified,
  };

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    resolve(outputDir, "npm-audit.raw.json"),
    result.stdout || "{}\n",
    "utf8",
  );
  writeFileSync(
    resolve(outputDir, "npm-audit.stderr.txt"),
    result.stderr || "",
    "utf8",
  );
  writeFileSync(
    resolve(outputDir, "npm-audit.summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );

  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    appendFileSync(stepSummary, markdownSummary(summary), "utf8");
  }
  process.stdout.write(`${annotation(summary)}\n`);
  process.exitCode = summary.exitCode;
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) main();
