import type { CheckModule, CheckResult, Issue, PageSnapshot } from "../types.js";

/**
 * A canonical, widely-used type-scale reference (roughly a 1.125-1.25 ratio
 * progression anchored at a 16px base, which is what most design systems --
 * Tailwind, Material, Radix -- converge on). We don't force one exact scale;
 * we check that observed sizes land close to *some* clean step so the page
 * reads as an intentional system rather than ad-hoc em/rem drift.
 */
const CANONICAL_STEPS = [10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 28, 30, 32, 36, 40, 48, 56, 64, 72, 96];
const TOLERANCE_PX = 0.75;
const MAX_DISTINCT_SIZES = 8;

export const typeScaleCheck: CheckModule = {
  id: "type-scale",
  name: "Type Scale Consistency",
  description:
    "Font sizes in use should belong to a small, coherent scale rather than sprawling ad-hoc values.",
  run(snapshot: PageSnapshot): CheckResult {
    const issues: Issue[] = [];
    const sizeToSelectors = new Map<number, string[]>();

    for (const el of snapshot.elements) {
      if (!el.text) continue;
      const size = round1(el.style.fontSize);
      if (size <= 0) continue;
      if (!sizeToSelectors.has(size)) sizeToSelectors.set(size, []);
      sizeToSelectors.get(size)!.push(el.selector);
    }

    const distinctSizes = Array.from(sizeToSelectors.keys()).sort((a, b) => a - b);

    // Flag any size that doesn't land within tolerance of a canonical step.
    const offScale = distinctSizes.filter(
      (s) => !CANONICAL_STEPS.some((step) => Math.abs(step - s) <= TOLERANCE_PX),
    );

    for (const size of offScale) {
      const nearest = CANONICAL_STEPS.reduce((a, b) =>
        Math.abs(b - size) < Math.abs(a - size) ? b : a,
      );
      const selectors = sizeToSelectors.get(size)!;
      issues.push({
        checkId: "type-scale",
        severity: "warning",
        message: `Font-size ${size}px (used on ${selectors.length} element${selectors.length > 1 ? "s" : ""}, e.g. "${selectors[0]}") doesn't land on a clean type-scale step -- looks like unintentional em/rem drift rather than a deliberate size.`,
        selector: selectors[0],
        measured: `${size}px`,
        required: `${nearest}px`,
        suggestedFix: `Round to ${nearest}px, the nearest step on a standard type scale.`,
        fixProperty: "font-size",
        fixValue: `${nearest}px`,
      });
    }

    if (distinctSizes.length > MAX_DISTINCT_SIZES) {
      issues.push({
        checkId: "type-scale",
        severity: "warning",
        message: `${distinctSizes.length} distinct font sizes are in use (${distinctSizes.join(", ")}px). A coherent type system typically uses ${MAX_DISTINCT_SIZES} or fewer.`,
        measured: `${distinctSizes.length} sizes`,
        required: `<= ${MAX_DISTINCT_SIZES} sizes`,
        suggestedFix:
          "Consolidate onto a fixed scale (e.g. 12/14/16/18/24/32/48px) and map every text style to one of those steps.",
      });
    }

    return {
      checkId: "type-scale",
      name: typeScaleCheck.name,
      description: typeScaleCheck.description,
      passed: offScale.length === 0 && distinctSizes.length <= MAX_DISTINCT_SIZES,
      issues,
      stats: { distinctSizes: distinctSizes.length, sizes: distinctSizes, offScaleCount: offScale.length },
    };
  },
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
