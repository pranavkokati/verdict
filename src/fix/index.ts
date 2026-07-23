import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Issue, VerdictResult } from "../types.js";
import { renderForFix, renderAndExtract } from "../render/browser.js";
import { scoreSnapshot } from "../score/aggregate.js";
import { applyPropertyFixes, type AppliedFix, type PropertyFix, type SkippedFix } from "./cssPatcher.js";

export interface FixOptions {
  threshold?: number;
  /** Output path for the fixed HTML. Defaults to "<name>.fixed.html" next to the input. Ignored for URL targets, which always need an explicit --out. */
  out?: string;
  /** Overwrite the input file in place instead of writing a new file. Only valid for local file targets. */
  write?: boolean;
}

export interface FixResult {
  target: string;
  outPath: string | null;
  before: VerdictResult;
  after: VerdictResult | null;
  applied: AppliedFix[];
  skipped: SkippedFix[];
  /** Issues with no fixProperty at all -- structural/content issues (missing h1, missing alt text) that need a human or an agent, not a value swap. */
  unfixable: Issue[];
}

const AUTO_FIXABLE_CHECKS = new Set(["contrast", "type-scale", "spacing-grid"]);

/**
 * Detects issues, patches every safely-fixable one via CDP (see
 * cssPatcher.ts), writes the result, and re-checks the patched output to
 * confirm the score actually moved -- the same verification loop
 * `verdict diff` already does for human-claimed improvements, now applied
 * to Verdict's own claimed fix.
 *
 * Only contrast, type-scale, and spacing-grid issues are touched. Heading
 * and landmark issues (missing <h1>, missing alt text, skipped heading
 * levels) are never auto-fixed -- they need generated content or a
 * structural decision, not a deterministic value swap, and silently
 * inventing an <h1> or alt text would be worse than leaving it flagged.
 */
export async function fixTarget(target: string, opts: FixOptions = {}): Promise<FixResult> {
  const threshold = opts.threshold ?? 80;
  const isUrl = /^https?:\/\//i.test(target);

  const { page, context, snapshot } = await renderForFix(target, {});
  const before = scoreSnapshot(target, snapshot, threshold);

  const fixableIssues = before.issues.filter(
    (i) => AUTO_FIXABLE_CHECKS.has(i.checkId) && i.selector && i.fixProperty && i.fixValue,
  );
  const unfixable = before.issues.filter((i) => !fixableIssues.includes(i));

  const fixes: PropertyFix[] = fixableIssues.map((i) => ({
    selector: i.selector!,
    property: i.fixProperty!,
    value: i.fixValue!,
    issueMessage: i.message,
  }));

  const originalHtml = isUrl ? await page.content() : await readFile(resolveLocalPath(target), "utf8");

  let applied: AppliedFix[] = [];
  let skipped: SkippedFix[] = [];
  let patchedHtml = originalHtml;

  if (fixes.length > 0) {
    const result = await applyPropertyFixes(page, originalHtml, fixes);
    patchedHtml = result.patchedHtml;
    applied = result.applied;
    skipped = result.skipped;
  }

  await context.close();

  if (applied.length === 0) {
    return { target, outPath: null, before, after: null, applied, skipped, unfixable };
  }

  const outPath = resolveOutPath(target, opts, isUrl);
  await writeFile(outPath, patchedHtml, "utf8");

  const afterSnapshot = await renderAndExtract(outPath);
  const after = scoreSnapshot(outPath, afterSnapshot, threshold);

  return { target, outPath, before, after, applied, skipped, unfixable };
}

function resolveLocalPath(target: string): string {
  return path.resolve(process.cwd(), target);
}

function resolveOutPath(target: string, opts: FixOptions, isUrl: boolean): string {
  if (opts.out) return path.resolve(process.cwd(), opts.out);
  if (isUrl) {
    throw new Error("Fixing a URL target requires an explicit --out path to write the patched HTML to.");
  }
  const abs = resolveLocalPath(target);
  if (opts.write) return abs;
  const ext = path.extname(abs);
  const base = abs.slice(0, abs.length - ext.length);
  return `${base}.fixed${ext || ".html"}`;
}
