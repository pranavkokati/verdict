import { mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import type { VerdictResult } from "./types.js";

export interface HistoryEntry {
  timestamp: string;
  target: string;
  score: number;
  passed: boolean;
  threshold: number;
  checks: Record<string, { score: number; issueCount: number }>;
}

/**
 * Score history is stored as a plain append-only JSONL file. No database,
 * no server -- it lives in the repo's .verdict/ dir (or wherever --out
 * points) so it travels with the project and works the same locally and in CI.
 */
export function historyFilePath(outDir: string): string {
  return path.join(outDir, "history.jsonl");
}

function toEntry(result: VerdictResult): HistoryEntry {
  const checks: HistoryEntry["checks"] = {};
  for (const c of result.checks) {
    // Per-check score: same severity-weighted deduction logic as the
    // aggregate score, but scoped to just this check's issues, so a
    // regression in one check is visible even if others improved.
    checks[c.checkId] = { score: Math.max(0, 100 - c.issues.length * 5), issueCount: c.issues.length };
  }
  return {
    timestamp: result.timestamp,
    target: result.target,
    score: result.score,
    passed: result.passed,
    threshold: result.threshold,
    checks,
  };
}

export async function appendHistory(outDir: string, result: VerdictResult): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const line = JSON.stringify(toEntry(result)) + "\n";
  await appendFile(historyFilePath(outDir), line, "utf8");
}

export async function readHistory(outDir: string): Promise<HistoryEntry[]> {
  try {
    const raw = await readFile(historyFilePath(outDir), "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as HistoryEntry);
  } catch {
    return [];
  }
}

/** Most recent entry for a given target, excluding the current run if it's already been appended. */
export async function lastEntryFor(outDir: string, target: string): Promise<HistoryEntry | undefined> {
  const all = await readHistory(outDir);
  const forTarget = all.filter((e) => e.target === target);
  return forTarget.length > 0 ? forTarget[forTarget.length - 1] : undefined;
}

/** Most recent *passing* entry for a target -- the regression baseline. */
export async function lastPassingEntryFor(
  outDir: string,
  target: string,
): Promise<HistoryEntry | undefined> {
  const all = await readHistory(outDir);
  const passing = all.filter((e) => e.target === target && e.passed);
  return passing.length > 0 ? passing[passing.length - 1] : undefined;
}
