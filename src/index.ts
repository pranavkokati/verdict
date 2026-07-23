export * from "./types.js";
export { renderAndExtract, closeBrowser, resolveTarget } from "./render/browser.js";
export { scoreSnapshot } from "./score/aggregate.js";
export { formatFixListForAgent, toFixListJson } from "./score/fixList.js";
export { renderHtmlReport } from "./report/html.js";
export { renderDiffReport } from "./report/diffHtml.js";
export { ALL_CHECKS } from "./checks/index.js";
export { diffScreenshots } from "./diff/pixelDiff.js";
export { diffResults, diffIssues } from "./diff/scoreDiff.js";
export type { ResultDiff, CheckDelta, IssueDelta } from "./diff/scoreDiff.js";
export type { PixelDiffResult } from "./diff/pixelDiff.js";
export {
  appendHistory,
  readHistory,
  lastEntryFor,
  lastPassingEntryFor,
  historyFilePath,
} from "./history.js";
export type { HistoryEntry } from "./history.js";
export { crawl, slugifyTarget } from "./crawl.js";
export type { CrawlOptions, CrawlSummary, CrawlError } from "./crawl.js";
export { checkConsistency } from "./consistency.js";
export type { PageInput, ConsistencySummary, ConsistencyFinding, ValueGroup } from "./consistency.js";
export { checkViewports, parseViewportList, DEFAULT_VIEWPORTS } from "./viewport.js";
export type { ViewportSpec, ViewportOptions, ViewportResult } from "./viewport.js";
export { scoreFromIssues } from "./score/aggregate.js";
export { checkInteractionStates } from "./states.js";
export type { InteractionStateOptions, InteractionStateResult } from "./states.js";
export { fixTarget } from "./fix/index.js";
export type { FixOptions, FixResult } from "./fix/index.js";
export type { AppliedFix, SkippedFix, PropertyFix } from "./fix/cssPatcher.js";
export { renderForFix } from "./render/browser.js";

import { renderAndExtract } from "./render/browser.js";
import { scoreSnapshot } from "./score/aggregate.js";
import type { VerdictResult } from "./types.js";

export interface CheckOptions {
  threshold?: number;
  viewport?: { width: number; height: number };
  settleMs?: number;
}

/**
 * The one-call entry point: render `target`, run every check, return a
 * scored VerdictResult. This is what both the CLI and any programmatic
 * consumer (an agent tool call, a CI script) should use.
 */
export async function check(target: string, opts: CheckOptions = {}): Promise<VerdictResult> {
  const snapshot = await renderAndExtract(target, {
    viewport: opts.viewport,
    settleMs: opts.settleMs,
  });
  return scoreSnapshot(target, snapshot, opts.threshold ?? 80);
}
