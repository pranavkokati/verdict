import type { CheckModule, CheckResult, Issue, PageSnapshot } from "../types.js";

/**
 * Structural / accessibility hierarchy check: heading order, landmark
 * regions, and image alt text. These are cheap to get right and are the
 * single biggest predictor of whether a page is navigable by screen reader
 * or keyboard users -- something AI agents reliably skip because it's
 * invisible in a visual diff.
 */
export const hierarchyCheck: CheckModule = {
  id: "hierarchy",
  name: "Heading & Landmark Hierarchy",
  description:
    "Headings should form a single, unbroken outline (one h1, no skipped levels) and the page should expose landmark regions and image alt text.",
  run(snapshot: PageSnapshot): CheckResult {
    const issues: Issue[] = [];
    const { headings, landmarks, images } = snapshot;

    const h1s = headings.filter((h) => h.level === 1);
    if (h1s.length === 0) {
      issues.push({
        checkId: "hierarchy",
        severity: "error",
        message: "No <h1> found. Every page needs exactly one top-level heading.",
        suggestedFix: "Add a single <h1> that names the page's primary content.",
      });
    } else if (h1s.length > 1) {
      issues.push({
        checkId: "hierarchy",
        severity: "warning",
        message: `${h1s.length} <h1> elements found (${h1s.map((h) => `"${h.text}"`).join(", ")}). There should be exactly one.`,
        selector: h1s[1].selector,
        suggestedFix: "Demote the extra <h1>s to <h2> or lower based on their place in the outline.",
      });
    }

    let prevLevel = 0;
    for (const h of headings) {
      if (prevLevel > 0 && h.level > prevLevel + 1) {
        issues.push({
          checkId: "hierarchy",
          severity: "warning",
          message: `Heading level jumps from h${prevLevel} to h${h.level} ("${h.text}") -- skips h${prevLevel + 1}.`,
          selector: h.selector,
          measured: `h${prevLevel} -> h${h.level}`,
          required: `h${prevLevel} -> h${prevLevel + 1}`,
          suggestedFix: `Change to h${prevLevel + 1}, or insert the missing intermediate level.`,
        });
      }
      prevLevel = h.level;
    }

    const hasMain = landmarks.some((l) => l.tag === "main");
    if (!hasMain) {
      issues.push({
        checkId: "hierarchy",
        severity: "warning",
        message: "No <main> landmark found.",
        suggestedFix: "Wrap the primary page content in a <main> element so assistive tech and skip-links can target it.",
      });
    }

    const missingAlt = images.filter((i) => !i.hasAlt);
    for (const img of missingAlt) {
      issues.push({
        checkId: "hierarchy",
        severity: "error",
        message: `<img> at "${img.selector}" has no alt attribute.`,
        selector: img.selector,
        suggestedFix: 'Add a descriptive alt attribute, or alt="" if the image is purely decorative.',
      });
    }

    const errorCount = issues.filter((i) => i.severity === "error").length;

    return {
      checkId: "hierarchy",
      name: hierarchyCheck.name,
      description: hierarchyCheck.description,
      passed: errorCount === 0,
      issues,
      stats: {
        headingCount: headings.length,
        h1Count: h1s.length,
        landmarkCount: landmarks.length,
        imagesMissingAlt: missingAlt.length,
      },
    };
  },
};
