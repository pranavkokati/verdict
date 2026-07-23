import type { PageSnapshot, VerdictResult } from "./types.js";
import { renderAndExtract } from "./render/browser.js";
import { scoreSnapshot } from "./score/aggregate.js";
import { appendHistory } from "./history.js";
import { checkConsistency, type ConsistencySummary } from "./consistency.js";

export interface CrawlOptions {
  threshold?: number;
  outDir?: string;
  history?: boolean;
  /**
   * Also compare recurring components (headings, paragraphs, buttons,
   * spacing base unit) across every crawled page and flag drift. Defaults
   * to true whenever 2+ targets are given -- with a single target there's
   * nothing to compare against.
   */
  consistency?: boolean;
}

export interface CrawlError {
  target: string;
  message: string;
}

export interface CrawlSummary {
  timestamp: string;
  threshold: number;
  targets: number;
  averageScore: number;
  allPassed: boolean;
  results: { target: string; score: number; passed: boolean; issueCount: number }[];
  /**
   * Targets that failed to render at all (unreachable URL, bad file path,
   * a page that throws mid-extraction) and so have no score. Kept separate
   * from `results` rather than aborting the whole crawl -- a real
   * multi-page crawl is exactly the scenario where one flaky/broken target
   * among many is common, and it shouldn't discard every other page's
   * results.
   */
  errors: CrawlError[];
  /** Cross-page design-system consistency comparison, or null if skipped/not applicable. */
  consistency: ConsistencySummary | null;
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
  const snapshots: { target: string; snapshot: PageSnapshot }[] = [];
  const errors: CrawlError[] = [];

  for (const target of targets) {
    try {
      const snapshot = await renderAndExtract(target);
      snapshots.push({ target, snapshot });
      const result = scoreSnapshot(target, snapshot, threshold);
      results.push(result);
      if (opts.history && opts.outDir) {
        await appendHistory(opts.outDir, result);
      }
    } catch (err) {
      // One broken target (a typo'd path, a URL that's down, a page that
      // throws mid-extraction) shouldn't discard every other page's
      // results -- record it and keep crawling the rest of the list.
      errors.push({ target, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const averageScore =
    results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length)
      : 0;

  const runConsistency = opts.consistency ?? targets.length >= 2;
  const consistency = runConsistency ? checkConsistency(snapshots) : null;

  const summary: CrawlSummary = {
    timestamp: new Date().toISOString(),
    threshold,
    targets: targets.length,
    averageScore,
    // A crawl is only a clean pass if every page passes its own threshold,
    // every target actually rendered (a target that couldn't be checked at
    // all is not a silent pass), AND the pages agree with each other --
    // cross-page drift is a real failure mode this tool exists to catch,
    // not a cosmetic footnote.
    allPassed: results.every((r) => r.passed) && errors.length === 0 && (consistency ? consistency.passed : true),
    results: results.map((r) => ({
      target: r.target,
      score: r.score,
      passed: r.passed,
      issueCount: r.issues.length,
    })),
    errors,
    consistency,
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
