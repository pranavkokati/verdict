import { mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import type { VerdictResult } from "./types.js";
import { scoreFromIssues } from "./score/aggregate.js";

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
    // Per-check score: `scoreFromIssues` scoped to just this check's issues
    // (the same shared severity-weighted/diminishing-returns model every
    // other score in this project uses -- checkSnapshot's own aggregate
    // score, viewport, states), so a regression in one check is visible
    // even if others improved, and the number here means the same thing as
    // everywhere else "score" appears. This previously used its own ad hoc
    // "100 - issues*5" formula, which could show a different number here
    // than the same issues produced anywhere else in the tool.
    checks[c.checkId] = { score: scoreFromIssues(c.issues), issueCount: c.issues.length };
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
  let raw: string;
  try {
    raw = await readFile(historyFilePath(outDir), "utf8");
  } catch {
    // No history file yet (or unreadable) -- an empty trend, not an error.
    return [];
  }

  // Parse line-by-line and skip individual bad lines rather than discarding
  // the whole file the moment JSON.parse throws on any one of them. This
  // matters because the realistic way a line gets corrupted is a process
  // getting killed mid-append (a CI job hitting its timeout, a Ctrl-C) --
  // exactly the append-only JSONL failure mode this format is supposed to
  // survive. Previously, one truncated/corrupted line silently discarded
  // every other valid entry in the file, which quietly disables the
  // regression gate (lastPassingEntryFor finds nothing, so there's no
  // baseline to regress against) without ever surfacing an error.
  const entries: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as HistoryEntry);
    } catch {
      // Skip just this line; a partial write shouldn't erase prior history.
    }
  }
  return entries;
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
