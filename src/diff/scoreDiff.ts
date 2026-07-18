import type { CheckResult, Issue, VerdictResult } from "../types.js";

export interface CheckDelta {
  checkId: string;
  name: string;
  beforePassed: boolean;
  afterPassed: boolean;
  beforeIssueCount: number;
  afterIssueCount: number;
}

export interface IssueDelta {
  fixed: Issue[];
  introduced: Issue[];
  persisting: Issue[];
}

export interface ResultDiff {
  scoreDelta: number;
  regressed: boolean;
  improved: boolean;
  checks: CheckDelta[];
  issues: IssueDelta;
}

/**
 * Normalizes an issue to a stable identity for before/after matching.
 * Numbers are stripped out of the message so "17px -> 16px" and
 * "23px -> 24px" style changes on the *same underlying problem* still
 * match as "persisting" rather than registering as one fixed + one new.
 */
function issueKey(issue: Issue): string {
  const normalizedMessage = issue.message.replace(/[\d.]+/g, "#");
  return `${issue.checkId}|${issue.selector ?? ""}|${normalizedMessage}`;
}

export function diffIssues(before: Issue[], after: Issue[]): IssueDelta {
  const beforeMap = new Map(before.map((i) => [issueKey(i), i]));
  const afterMap = new Map(after.map((i) => [issueKey(i), i]));

  const fixed = before.filter((i) => !afterMap.has(issueKey(i)));
  const introduced = after.filter((i) => !beforeMap.has(issueKey(i)));
  const persisting = after.filter((i) => beforeMap.has(issueKey(i)));

  return { fixed, introduced, persisting };
}

function diffChecks(before: CheckResult[], after: CheckResult[]): CheckDelta[] {
  const afterById = new Map(after.map((c) => [c.checkId, c]));
  return before.map((b) => {
    const a = afterById.get(b.checkId);
    return {
      checkId: b.checkId,
      name: b.name,
      beforePassed: b.passed,
      afterPassed: a?.passed ?? b.passed,
      beforeIssueCount: b.issues.length,
      afterIssueCount: a?.issues.length ?? b.issues.length,
    };
  });
}

export function diffResults(before: VerdictResult, after: VerdictResult): ResultDiff {
  return {
    scoreDelta: after.score - before.score,
    regressed: after.score < before.score,
    improved: after.score > before.score,
    checks: diffChecks(before.checks, after.checks),
    issues: diffIssues(before.issues, after.issues),
  };
}
