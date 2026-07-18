import type { VerdictResult } from "./types.js";
import { renderAndExtract } from "./render/browser.js";
import { scoreSnapshot } from "./score/aggregate.js";
import { appendHistory } from "./history.js";

export interface CrawlOptions {
  threshold?: number;
  outDir?: string;
  history?: boolean;
}

export interface CrawlSummary {
  timestamp: string;
  threshold: number;
  targets: number;
  averageScore: number;
  allPassed: boolean;
  results: { target: string; score: number; passed: boolean; issueCount: number }[];
}

/**
 * Runs the full check suite against multiple targets sequentially (one
 * shared browser instance, reused across pages -- rendering isn't
 * parallelized because a single Chromium instance handling many
 * concurrent full-page screenshots tends to degrade screenshot quality
 * under memory pressure; sequential is slower but reliable).
 *
 * Returns both the individual VerdictResult for every target (so callers
 * can write per-page reports) and an aggregate summary.
 */
export async function crawl(
  targets: string[],
  opts: CrawlOptions = {},
): Promise<{ results: VerdictResult[]; summary: CrawlSummary }> {
  const threshold = opts.threshold ?? 80;
  const results: VerdictResult[] = [];

  for (const target of targets) {
    const snapshot = await renderAndExtract(target);
    const result = scoreSnapshot(target, snapshot, threshold);
    results.push(result);
    if (opts.history && opts.outDir) {
      await appendHistory(opts.outDir, result);
    }
  }

  const averageScore =
    results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length)
      : 0;

  const summary: CrawlSummary = {
    timestamp: new Date().toISOString(),
    threshold,
    targets: targets.length,
    averageScore,
    allPassed: results.every((r) => r.passed),
    results: results.map((r) => ({
      target: r.target,
      score: r.score,
      passed: r.passed,
      issueCount: r.issues.length,
    })),
  };

  return { results, summary };
}

/** Turns a target (file path or URL) into a filesystem-safe directory name for per-page reports. */
export function slugifyTarget(target: string): string {
  return target
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "target";
}
