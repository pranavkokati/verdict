import type { Issue, PageSnapshot } from "./types.js";
import { renderAndExtract } from "./render/browser.js";
import { scoreFromIssues } from "./score/aggregate.js";

export interface ViewportSpec {
  name: string;
  width: number;
  height: number;
}

export interface ViewportOptions {
  viewports?: ViewportSpec[];
  threshold?: number;
}

/** Same shape as `VerdictResult` (score/passed/threshold/issues) -- a viewport
 * sweep of one target scores exactly like a single-page check does, via the
 * same `scoreFromIssues` helper, so the numbers mean the same thing. */
export interface ViewportResult {
  target: string;
  timestamp: string;
  viewports: ViewportSpec[];
  score: number;
  passed: boolean;
  threshold: number;
  issues: Issue[];
}

export const DEFAULT_VIEWPORTS: ViewportSpec[] = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

const OVERFLOW_TOLERANCE_PX = 4;
/** Only flag undersized tap targets at viewports at or below this width --
 * touch input, not precise mouse pointing, is what the 44px guideline is for. */
const MOBILE_BREAKPOINT_PX = 480;
/** WCAG 2.5.5 (Target Size, AAA) / widely-cited platform HIG minimum. */
const MIN_TAP_TARGET_PX = 44;
const MAX_TAP_TARGETS_LISTED = 5;

/**
 * Renders the same target at multiple viewport widths and flags structural
 * breakage that only shows up when the layout actually has to respond to a
 * different width -- something none of this project's other checks can see
 * (they each evaluate one already-rendered snapshot) and something axe-core
 * doesn't attempt at all (it audits a single DOM snapshot, not a page's
 * behavior across breakpoints).
 *
 * Three categories, each chosen because it's a real, common, structural
 * failure mode rather than a style opinion:
 *
 *   1. Horizontal overflow -- any element whose right edge extends past the
 *      viewport's right edge causes the whole page to gain an unwanted
 *      horizontal scrollbar. This is detected directly from each element's
 *      already-captured bounding box (`rect.x + rect.width` vs the
 *      viewport's width), not by re-rendering or adding new extraction.
 *   2. Undersized tap targets -- <a>/<button> elements smaller than 44x44px
 *      at mobile-width viewports (<= 480px), below the widely-cited minimum
 *      reliable touch-target size.
 *   3. Structural presence parity -- a heading (by text) or landmark (by
 *      tag) present at one viewport but absent at another, which usually
 *      means responsive CSS (`display: none`, a mobile nav drawer, etc.)
 *      silently dropped it rather than just re-laying it out.
 *
 * Scored with the exact same `scoreFromIssues` helper `scoreSnapshot` uses,
 * so a viewport-sweep score of 70 costs the same as a single-page score of
 * 70 -- there's one scoring model in this project, not one per feature.
 */
export async function checkViewports(
  target: string,
  opts: ViewportOptions = {},
): Promise<ViewportResult> {
  const viewports = opts.viewports ?? DEFAULT_VIEWPORTS;
  const threshold = opts.threshold ?? 80;

  // An empty viewport list isn't a legitimate "nothing to check" case the
  // way zero interactive elements is for checkInteractionStates -- there's
  // no organic reason to ever want zero viewports, so it's always a caller
  // mistake. Without this guard, zero rendered viewports means zero
  // possible issues, which silently produced a hollow 100/100 "PASS" that
  // implies full viewport coverage while actually testing nothing at all
  // (unreachable via the CLI/MCP surface, since parseViewportList already
  // rejects malformed specs, but directly reachable via the library API).
  if (viewports.length === 0) {
    throw new Error("checkViewports requires at least one viewport to test -- an empty `viewports` array was given.");
  }

  const rendered: { spec: ViewportSpec; snapshot: PageSnapshot }[] = [];
  for (const spec of viewports) {
    const snapshot = await renderAndExtract(target, {
      viewport: { width: spec.width, height: spec.height },
    });
    rendered.push({ spec, snapshot });
  }

  const issues: Issue[] = [];

  // 1. Horizontal overflow.
  for (const { spec, snapshot } of rendered) {
    const offenders = snapshot.elements
      .map((el) => ({ el, overflowPx: el.rect.x + el.rect.width - spec.width }))
      .filter((o) => o.overflowPx > OVERFLOW_TOLERANCE_PX)
      .sort((a, b) => b.overflowPx - a.overflowPx);

    if (offenders.length > 0) {
      const worst = offenders[0];
      issues.push({
        checkId: "viewport-overflow",
        severity: "error",
        message: `Horizontal overflow at ${labelFor(spec)}: "${worst.el.selector}" extends ${Math.round(worst.overflowPx)}px past the right edge of the viewport${offenders.length > 1 ? ` (${offenders.length} elements affected)` : ""}, forcing an unwanted horizontal scrollbar.`,
        selector: worst.el.selector,
        measured: `${Math.round(worst.el.rect.x + worst.el.rect.width)}px right edge`,
        required: `<= ${spec.width}px`,
        suggestedFix: `Constrain "${worst.el.selector}" (or its content) to the viewport width -- typical culprits are a fixed pixel width, an unwrapped long word/URL, or a horizontally-laid-out row that doesn't wrap at ${spec.width}px.`,
      });
    }
  }

  // 2. Undersized tap targets, mobile breakpoints only.
  for (const { spec, snapshot } of rendered) {
    if (spec.width > MOBILE_BREAKPOINT_PX) continue;
    const small = snapshot.elements.filter(
      (el) =>
        (el.tag === "a" || el.tag === "button") &&
        el.rect.width > 0 &&
        el.rect.height > 0 &&
        (el.rect.width < MIN_TAP_TARGET_PX || el.rect.height < MIN_TAP_TARGET_PX),
    );
    for (const el of small.slice(0, MAX_TAP_TARGETS_LISTED)) {
      issues.push({
        checkId: "viewport-tap-target",
        severity: "warning",
        message: `Tap target "${el.selector}" is ${Math.round(el.rect.width)}x${Math.round(el.rect.height)}px at ${labelFor(spec)} -- below the ${MIN_TAP_TARGET_PX}x${MIN_TAP_TARGET_PX}px minimum for reliable touch interaction (WCAG 2.5.5).`,
        selector: el.selector,
        measured: `${Math.round(el.rect.width)}x${Math.round(el.rect.height)}px`,
        required: `>= ${MIN_TAP_TARGET_PX}x${MIN_TAP_TARGET_PX}px`,
        suggestedFix: `Increase padding or min-width/min-height on "${el.selector}" so its tap area reaches ${MIN_TAP_TARGET_PX}x${MIN_TAP_TARGET_PX}px at ${spec.width}px viewports.`,
      });
    }
    if (small.length > MAX_TAP_TARGETS_LISTED) {
      issues.push({
        checkId: "viewport-tap-target",
        severity: "warning",
        message: `${small.length - MAX_TAP_TARGETS_LISTED} additional tap target(s) below ${MIN_TAP_TARGET_PX}x${MIN_TAP_TARGET_PX}px at ${labelFor(spec)} not listed individually.`,
      });
    }
  }

  // 3. Structural presence parity across viewports.
  const headingSets = rendered.map(({ spec, snapshot }) => ({
    spec,
    texts: new Set(snapshot.headings.map((h) => h.text)),
  }));
  const allHeadingTexts = new Set<string>();
  for (const { texts } of headingSets) for (const t of texts) allHeadingTexts.add(t);
  for (const text of allHeadingTexts) {
    const presentIn = headingSets.filter((v) => v.texts.has(text)).map((v) => v.spec);
    const missingFrom = headingSets.filter((v) => !v.texts.has(text)).map((v) => v.spec);
    if (presentIn.length > 0 && missingFrom.length > 0) {
      issues.push({
        checkId: "viewport-structural",
        severity: "warning",
        message: `Heading "${text}" is present at ${presentIn.map(labelFor).join(", ")} but missing at ${missingFrom.map(labelFor).join(", ")} -- check for responsive CSS that hides it entirely rather than just re-laying it out.`,
      });
    }
  }

  const landmarkSets = rendered.map(({ spec, snapshot }) => ({
    spec,
    tags: new Set(snapshot.landmarks.map((l) => l.tag)),
  }));
  const allLandmarkTags = new Set<string>();
  for (const { tags } of landmarkSets) for (const t of tags) allLandmarkTags.add(t);
  for (const tag of allLandmarkTags) {
    const presentIn = landmarkSets.filter((v) => v.tags.has(tag)).map((v) => v.spec);
    const missingFrom = landmarkSets.filter((v) => !v.tags.has(tag)).map((v) => v.spec);
    if (presentIn.length > 0 && missingFrom.length > 0) {
      issues.push({
        checkId: "viewport-structural",
        severity: "warning",
        message: `The <${tag}> landmark is present at ${presentIn.map(labelFor).join(", ")} but missing at ${missingFrom.map(labelFor).join(", ")}.`,
      });
    }
  }

  const score = scoreFromIssues(issues);

  return {
    target,
    timestamp: new Date().toISOString(),
    viewports,
    score,
    passed: score >= threshold,
    threshold,
    issues,
  };
}

function labelFor(spec: ViewportSpec): string {
  return `${spec.name} (${spec.width}x${spec.height})`;
}

/** Parses a CLI-friendly viewport list like "375x812,768x1024,1440x900" into ViewportSpecs. */
export function parseViewportList(spec: string): ViewportSpec[] {
  return spec.split(",").map((part, i) => {
    const trimmed = part.trim();
    const match = /^(\d+)x(\d+)$/.exec(trimmed);
    if (!match) {
      throw new Error(`Invalid viewport "${trimmed}" -- expected "WIDTHxHEIGHT", e.g. "375x812".`);
    }
    return { name: `viewport-${i + 1}`, width: Number(match[1]), height: Number(match[2]) };
  });
}
