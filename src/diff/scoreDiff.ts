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
  const beforeById = new Map(before.map((c) => [c.checkId, c]));
  const afterById = new Map(after.map((c) => [c.checkId, c]));
  // Union of checkIds from both sides, not just `before`'s -- both sides
  // run the same fixed ALL_CHECKS list today so this never actually
  // differs in practice, but iterating `before.map(...)` alone would
  // silently drop any check present only in `after` (or vice versa) from
  // the diff the moment that assumption ever stops holding.
  const allCheckIds = new Set([...beforeById.keys(), ...afterById.keys()]);
  return Array.from(allCheckIds).map((checkId) => {
    const b = beforeById.get(checkId);
    const a = afterById.get(checkId);
    return {
      checkId,
      name: b?.name ?? a!.name,
      beforePassed: b?.passed ?? true,
      afterPassed: a?.passed ?? true,
      beforeIssueCount: b?.issues.length ?? 0,
      afterIssueCount: a?.issues.length ?? 0,
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
