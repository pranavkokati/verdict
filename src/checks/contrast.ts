import type { CheckModule, CheckResult, ExtractedElement, Issue, PageSnapshot } from "../types.js";
import {
  compositeOver,
  contrastRatio,
  isLargeText,
  parseColor,
  suggestAccessibleColor,
} from "./colorUtils.js";

const AA_NORMAL = 4.5;
const AA_LARGE = 3.0;
const AAA_NORMAL = 7.0;

/**
 * WCAG 2.1 contrast check. For every element with its own visible text,
 * finds the effective background (walking up the extracted element list by
 * geometric containment, since we don't have the live ancestor chain post
 * page.evaluate) and computes the real relative-luminance contrast ratio.
 */
export const contrastCheck: CheckModule = {
  id: "contrast",
  name: "Color Contrast (WCAG 2.1)",
  description:
    "Every piece of visible text must meet WCAG AA contrast against its background (4.5:1 normal text, 3:1 large text).",
  run(snapshot: PageSnapshot): CheckResult {
    const issues: Issue[] = [];
    const textEls = snapshot.elements.filter((e) => e.text.length > 0);
    let checked = 0;
    let aaaCount = 0;

    for (const el of textEls) {
      const bg = findEffectiveBackground(el, snapshot.elements);
      if (!bg) continue; // fully transparent stack, can't evaluate
      const fgColor = compositeOver(parseColor(el.style.color), bg);
      const ratio = contrastRatio(fgColor, bg);
      checked++;

      const large = isLargeText(el.style.fontSize, el.style.fontWeight);
      const threshold = large ? AA_LARGE : AA_NORMAL;

      if (ratio < threshold) {
        const fix = suggestAccessibleColor(fgColor, bg, threshold);
        issues.push({
          checkId: "contrast",
          severity: ratio < threshold * 0.7 ? "error" : "warning",
          message: `Text "${truncate(el.text)}" has ${ratio.toFixed(2)}:1 contrast against its background, below the WCAG AA minimum for ${large ? "large" : "normal"} text.`,
          selector: el.selector,
          measured: `${ratio.toFixed(2)}:1`,
          required: `${threshold.toFixed(1)}:1`,
          suggestedFix: fix
            ? `Change text color to ${fix} (or darken/lighten equivalently) to reach ${threshold.toFixed(1)}:1.`
            : `Increase contrast between text and background to at least ${threshold.toFixed(1)}:1.`,
        });
      } else if (ratio >= AAA_NORMAL) {
        aaaCount++;
      }
    }

    return {
      checkId: "contrast",
      name: contrastCheck.name,
      description: contrastCheck.description,
      passed: issues.filter((i) => i.severity === "error").length === 0,
      issues,
      stats: { elementsChecked: checked, aaaCompliant: aaaCount, failures: issues.length },
    };
  },
};

function truncate(s: string, n = 40): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Finds the effective background color behind an element by looking for the
 * smallest containing element (by area) with a non-transparent
 * background-color. Falls back to white, the browser default canvas color,
 * if nothing in the stack paints a background.
 */
function findEffectiveBackground(
  el: ExtractedElement,
  all: ExtractedElement[],
): ReturnType<typeof parseColor> | null {
  const candidates = all
    .filter((c) => contains(c.rect, el.rect) && parseColor(c.style.backgroundColor).a > 0)
    .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);

  if (candidates.length > 0) {
    return parseColor(candidates[0].style.backgroundColor);
  }
  return parseColor("rgb(255,255,255)");
}

function contains(
  outer: ExtractedElement["rect"],
  inner: ExtractedElement["rect"],
): boolean {
  return (
    outer.x <= inner.x + 0.5 &&
    outer.y <= inner.y + 0.5 &&
    outer.x + outer.width >= inner.x + inner.width - 0.5 &&
    outer.y + outer.height >= inner.y + inner.height - 0.5
  );
}
