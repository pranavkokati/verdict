import type { CheckModule, CheckResult, Issue, PageSnapshot } from "../types.js";

const CANDIDATE_BASE_UNITS = [8, 4];
const TOLERANCE_PX = 0.5;
const MIN_SAMPLES = 6;

/**
 * Detects whether the page's spacing (margin/padding/gap) values are drawn
 * from a consistent base-unit grid -- the "4px/8px grid" convention nearly
 * every real design system uses -- and flags the outliers that break it.
 */
export const spacingGridCheck: CheckModule = {
  id: "spacing-grid",
  name: "Spacing Grid Consistency",
  description:
    "Margins, padding, and gaps should be multiples of a consistent base unit (4px or 8px), not arbitrary values.",
  run(snapshot: PageSnapshot): CheckResult {
    const samples: { value: number; selector: string; prop: string }[] = [];

    for (const el of snapshot.elements) {
      const s = el.style;
      const props: [string, number][] = [
        ["margin-top", s.marginTop],
        ["margin-right", s.marginRight],
        ["margin-bottom", s.marginBottom],
        ["margin-left", s.marginLeft],
        ["padding-top", s.paddingTop],
        ["padding-right", s.paddingRight],
        ["padding-bottom", s.paddingBottom],
        ["padding-left", s.paddingLeft],
        ["gap", s.gap],
      ];
      for (const [prop, value] of props) {
        if (value > 0) samples.push({ value, selector: el.selector, prop });
      }
    }

    if (samples.length < MIN_SAMPLES) {
      return {
        checkId: "spacing-grid",
        name: spacingGridCheck.name,
        description: spacingGridCheck.description,
        passed: true,
        issues: [],
        stats: { note: "Not enough spacing samples to evaluate a grid.", samples: samples.length },
      };
    }

    // Pick whichever base unit (8 then 4) the page's values fit most cleanly.
    let bestUnit = CANDIDATE_BASE_UNITS[0];
    let bestFit = -1;
    for (const unit of CANDIDATE_BASE_UNITS) {
      const fit = samples.filter((s) => isMultiple(s.value, unit)).length / samples.length;
      if (fit > bestFit) {
        bestFit = fit;
        bestUnit = unit;
      }
    }

    const issues: Issue[] = [];
    const offGrid = samples.filter((s) => !isMultiple(s.value, bestUnit));

    // Group by rounded value so we don't emit 40 duplicate issues for one bad value reused everywhere.
    const grouped = new Map<string, typeof offGrid>();
    for (const s of offGrid) {
      const key = `${s.prop}:${s.value}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(s);
    }

    for (const [key, group] of grouped) {
      const [prop, valueStr] = key.split(":");
      const value = Number(valueStr);
      const nearest = Math.round(value / bestUnit) * bestUnit;
      issues.push({
        checkId: "spacing-grid",
        severity: group.length >= 3 ? "warning" : "info",
        message: `${prop} of ${value}px on ${group.length} element${group.length > 1 ? "s" : ""} (e.g. "${group[0].selector}") isn't a multiple of the page's ${bestUnit}px spacing unit.`,
        selector: group[0].selector,
        measured: `${value}px`,
        required: `multiple of ${bestUnit}px (nearest: ${nearest}px)`,
        suggestedFix: `Change ${prop} to ${nearest}px to stay on the ${bestUnit}px grid.`,
      });
    }

    const gridAdherence = 1 - offGrid.length / samples.length;

    return {
      checkId: "spacing-grid",
      name: spacingGridCheck.name,
      description: spacingGridCheck.description,
      passed: gridAdherence >= 0.85,
      issues,
      stats: {
        baseUnit: bestUnit,
        samples: samples.length,
        gridAdherence: Math.round(gridAdherence * 1000) / 1000,
        offGridCount: offGrid.length,
      },
    };
  },
};

function isMultiple(value: number, unit: number): boolean {
  const remainder = value % unit;
  return remainder <= TOLERANCE_PX || unit - remainder <= TOLERANCE_PX;
}
