import type { VerdictResult } from "../types.js";

/**
 * Formats a VerdictResult as plain text meant to be pasted straight back
 * into an AI coding agent's chat -- the "closed loop" half of the product.
 * Ordered by severity, one line per issue, with the selector and the
 * concrete fix so the agent doesn't have to re-derive anything.
 */
export function formatFixListForAgent(result: VerdictResult): string {
  const lines: string[] = [];
  lines.push(
    `Verdict design QA: ${result.score}/100 (threshold ${result.threshold}) -- ${result.passed ? "PASS" : "FAIL"}.`,
  );
  lines.push(`Target: ${result.target}`);
  lines.push("");

  const bySeverity = { error: [] as typeof result.issues, warning: [] as typeof result.issues, info: [] as typeof result.issues };
  for (const issue of result.issues) bySeverity[issue.severity].push(issue);

  for (const sev of ["error", "warning", "info"] as const) {
    const issues = bySeverity[sev];
    if (issues.length === 0) continue;
    lines.push(`${sev.toUpperCase()} (${issues.length}):`);
    for (const issue of issues) {
      const loc = issue.selector ? ` [${issue.selector}]` : "";
      lines.push(`  - ${issue.message}${loc}`);
      if (issue.suggestedFix) lines.push(`    fix: ${issue.suggestedFix}`);
    }
    lines.push("");
  }

  if (result.issues.length === 0) {
    lines.push("No issues found across contrast, type scale, spacing grid, or heading/landmark hierarchy.");
  }

  return lines.join("\n");
}

/** Machine-readable variant for programmatic consumption (CI, agent tool calls). */
export function toFixListJson(result: VerdictResult) {
  return {
    score: result.score,
    threshold: result.threshold,
    passed: result.passed,
    target: result.target,
    timestamp: result.timestamp,
    issues: result.issues.map((i) => ({
      check: i.checkId,
      severity: i.severity,
      message: i.message,
      selector: i.selector,
      measured: i.measured,
      required: i.required,
      fix: i.suggestedFix,
    })),
  };
}
