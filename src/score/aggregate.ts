import type { CheckResult, Issue, VerdictResult } from "../types.js";
import { ALL_CHECKS } from "../checks/index.js";
import type { PageSnapshot } from "../types.js";

const SEVERITY_WEIGHT: Record<Issue["severity"], number> = {
  error: 8,
  warning: 3,
  info: 1,
};

/**
 * Rolls a flat list of issues into a single 0-100 score. Deductions are
 * severity-weighted and diminishing *within each `checkId`* (each additional
 * issue from the same check counts a little less, capped at 40 points) so
 * one check with 40 minor spacing nits doesn't drown out a check with one
 * real contrast failure, and one pathological check can't zero the score
 * alone.
 *
 * This is the single scoring implementation shared by every feature that
 * produces `Issue`s against a "target" (a page, a viewport sweep, and so
 * on) -- `scoreSnapshot` below, and `checkViewports` in `../viewport.js` --
 * so a 62 means the same thing regardless of which check produced it.
 */
export function scoreFromIssues(issues: Issue[]): number {
  const byCheck = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (!byCheck.has(issue.checkId)) byCheck.set(issue.checkId, []);
    byCheck.get(issue.checkId)!.push(issue);
  }

  let deduction = 0;
  for (const checkIssues of byCheck.values()) {
    const bySeverity: Record<Issue["severity"], number> = { error: 0, warning: 0, info: 0 };
    for (const issue of checkIssues) bySeverity[issue.severity]++;
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

  return Math.max(0, Math.round(100 - deduction));
}

/**
 * Runs every check module against a snapshot and rolls the results into a
 * single 0-100 score via `scoreFromIssues`.
 */
export function scoreSnapshot(
  target: string,
  snapshot: PageSnapshot,
  threshold = 80,
): VerdictResult {
  const checks: CheckResult[] = ALL_CHECKS.map((c) => c.run(snapshot));
  const allIssues = checks.flatMap((c) => c.issues);
  const score = scoreFromIssues(allIssues);

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
