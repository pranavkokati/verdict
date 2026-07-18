import type { CheckResult, Issue, VerdictResult } from "../types.js";
import { ALL_CHECKS } from "../checks/index.js";
import type { PageSnapshot } from "../types.js";

const SEVERITY_WEIGHT: Record<Issue["severity"], number> = {
  error: 8,
  warning: 3,
  info: 1,
};

/**
 * Runs every check module against a snapshot and rolls the results into a
 * single 0-100 score. Deductions are severity-weighted and diminishing
 * (each additional issue of the same severity within a check counts a
 * little less) so one check with 40 minor spacing nits doesn't drown out
 * a check with one real contrast failure.
 */
export function scoreSnapshot(
  target: string,
  snapshot: PageSnapshot,
  threshold = 80,
): VerdictResult {
  const checks: CheckResult[] = ALL_CHECKS.map((c) => c.run(snapshot));
  const allIssues = checks.flatMap((c) => c.issues);

  let deduction = 0;
  for (const check of checks) {
    const bySeverity: Record<Issue["severity"], number> = { error: 0, warning: 0, info: 0 };
    for (const issue of check.issues) bySeverity[issue.severity]++;
    for (const sev of ["error", "warning", "info"] as const) {
      const n = bySeverity[sev];
      if (n === 0) continue;
      // Diminishing returns: 1st issue costs full weight, each subsequent
      // one costs less, capped so a single pathological check can't zero the score alone.
      let checkDeduction = 0;
      for (let i = 0; i < n; i++) {
        checkDeduction += SEVERITY_WEIGHT[sev] / Math.sqrt(i + 1);
      }
      deduction += Math.min(checkDeduction, 40);
    }
  }

  const score = Math.max(0, Math.round(100 - deduction));

  return {
    target,
    timestamp: new Date().toISOString(),
    score,
    passed: score >= threshold,
    threshold,
    checks,
    issues: allIssues,
    screenshotPng: snapshot.screenshotPng,
  };
}
