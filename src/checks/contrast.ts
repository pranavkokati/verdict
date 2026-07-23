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
          fixProperty: fix ? "color" : undefined,
          fixValue: fix ?? undefined,
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
 * Finds the effective background color behind an element by walking every
 * containing element (by geometric containment) that paints *any*
 * background, from outermost to innermost, and alpha-compositing each one
 * over an opaque white canvas -- the same order the browser actually paints
 * in. Falls back to plain white if nothing in the stack paints a background.
 *
 * This has to composite the *whole* stack, not just grab the single
 * smallest containing element's raw color: a semi-transparent overlay
 * (`rgba(0,0,0,0.5)` on a modal scrim, a translucent header, a
 * glassmorphism panel -- all common, real patterns) painted over a colored
 * page background does not render as its own raw RGB values. A previous
 * version returned only the nearest containing element's parsed color
 * as-is, silently dropping its alpha entirely (`relativeLuminance` only
 * reads r/g/b) -- so `rgba(255,255,255,0.5)` over a black page was treated
 * as opaque white. Verified against the real WCAG luminance math: white
 * text in that overlay measures ~3.98:1 against the true composited
 * ~rgb(128,128,128) (passes the 3:1 large-text minimum) but ~1.0:1 against
 * the wrongly-assumed opaque white (a false "catastrophic failure").
 *
 * Exported for reuse by `../states.ts`, which needs the same
 * resting-state background resolution when checking hover/active contrast
 * (an element's own background rarely changes on ancestors' interaction
 * states, so the resting-state ancestor chain is a reasonable fallback when
 * the element's own forced-state background is still transparent).
 */
export function findEffectiveBackground(
  el: ExtractedElement,
  all: ExtractedElement[],
): ReturnType<typeof parseColor> | null {
  const layers = all
    .filter((c) => contains(c.rect, el.rect) && parseColor(c.style.backgroundColor).a > 0)
    // Largest (outermost) first, matching paint order: the page's own
    // background paints first, then each nested ancestor's background
    // paints over it, ending with the element's own background (if any)
    // painted last, directly behind its text.
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);

  let composited = parseColor("rgb(255,255,255)"); // opaque white canvas default
  for (const layer of layers) {
    composited = compositeOver(parseColor(layer.style.backgroundColor), composited);
  }
  return composited;
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
