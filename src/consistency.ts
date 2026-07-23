import type { PageSnapshot, Severity } from "./types.js";
import { spacingGridCheck } from "./checks/spacingGrid.js";

export interface PageInput {
  target: string;
  snapshot: PageSnapshot;
}

export interface ValueGroup {
  /** The observed value, e.g. "32px", "rgb(17, 17, 17)". */
  value: string;
  /** Which pages (by target) exhibited this value. */
  pages: string[];
}

export interface ConsistencyFinding {
  /** The compared role, e.g. "h1", "p", "a.btn.btn-primary", or "page" for site-wide properties. */
  role: string;
  /** The compared CSS-derived property, e.g. "fontSize", "color", "backgroundColor", "spacingBaseUnit". */
  property: string;
  severity: Severity;
  message: string;
  values: ValueGroup[];
}

export interface ConsistencySummary {
  pages: string[];
  /** How many distinct roles (recurring across 2+ pages) were actually compared. */
  rolesCompared: number;
  findings: ConsistencyFinding[];
  passed: boolean;
}

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const BUTTON_CLASS_RE = /\b(btn|button)\b/i;

interface Sample {
  page: string;
  role: string;
  property: string;
  value: string;
}

/**
 * Compares how a recurring, named component or role is styled across
 * multiple pages of the same site, and flags where it silently drifts --
 * a ".btn-primary" that renders as two subtly different blues on two
 * different pages, an <h1> that's 32px on the homepage but 28px on the
 * about page, and so on. Every existing check in this project (contrast,
 * type-scale, spacing-grid, hierarchy) evaluates a single page in
 * isolation; none of them, or axe-core, can see that two pages of the
 * same site disagree with each other. That's what this check adds.
 *
 * Deliberately scoped to three categories that are both common and
 * genuinely diagnostic of unintentional drift (a hardcoded value where a
 * shared token/variable should have been reused), rather than
 * fingerprinting every element on the page, which would drown real
 * findings in noise from one-off content:
 *
 *   - Headings (h1..h6), compared by tag alone -- most sites intend
 *     exactly one style per heading level sitewide: font-size,
 *     font-weight, color.
 *   - Paragraphs and button-like elements (<button>, or <a>/<button>
 *     carrying a class containing "btn"/"button"), compared by tag +
 *     class signature so unrelated one-off <p> tags don't get lumped
 *     together: font-size and color (background-color too, for buttons).
 *   - The page's detected spacing base unit (4px or 8px, from
 *     spacing-grid) -- if one page is unmistakably built on an 8px grid
 *     and another on a 4px grid, that's a system-level disagreement.
 *
 * A role only counts as "compared" once it's present on 2+ of the
 * supplied pages -- something unique to a single page has nothing to be
 * inconsistent with, so it's silently skipped rather than flagged.
 */
export function checkConsistency(pages: PageInput[]): ConsistencySummary {
  const pageNames = pages.map((p) => p.target);
  if (pages.length < 2) {
    return { pages: pageNames, rolesCompared: 0, findings: [], passed: true };
  }

  const samples: Sample[] = [];

  for (const { target, snapshot } of pages) {
    for (const el of snapshot.elements) {
      const tag = el.tag.toLowerCase();
      const isHeading = HEADING_TAGS.has(tag);
      const isButton = tag === "button" || (tag === "a" && BUTTON_CLASS_RE.test(el.selector));
      const isParagraph = tag === "p";
      if (!isHeading && !isButton && !isParagraph) continue;

      const role = isHeading ? tag : roleKeyFromSelector(el.selector, tag);

      samples.push({ page: target, role, property: "fontSize", value: `${round1(el.style.fontSize)}px` });
      samples.push({ page: target, role, property: "color", value: el.style.color });
      if (isHeading) {
        samples.push({ page: target, role, property: "fontWeight", value: String(el.style.fontWeight) });
      }
      if (isButton) {
        samples.push({ page: target, role, property: "backgroundColor", value: el.style.backgroundColor });
      }
    }
  }

  // role -> property -> value -> pages that exhibited it
  const grouped = new Map<string, Map<string, Map<string, Set<string>>>>();
  for (const s of samples) {
    if (!grouped.has(s.role)) grouped.set(s.role, new Map());
    const byProp = grouped.get(s.role)!;
    if (!byProp.has(s.property)) byProp.set(s.property, new Map());
    const byValue = byProp.get(s.property)!;
    if (!byValue.has(s.value)) byValue.set(s.value, new Set());
    byValue.get(s.value)!.add(s.page);
  }

  const findings: ConsistencyFinding[] = [];
  let rolesCompared = 0;

  for (const [role, byProp] of grouped) {
    const pagesForRole = new Set<string>();
    for (const byValue of byProp.values()) {
      for (const pagesSet of byValue.values()) {
        for (const p of pagesSet) pagesForRole.add(p);
      }
    }
    if (pagesForRole.size < 2) continue; // only on one page -- nothing to compare
    rolesCompared++;

    for (const [property, byValue] of byProp) {
      if (byValue.size <= 1) continue; // every page agrees
      const values: ValueGroup[] = Array.from(byValue.entries()).map(([value, pagesSet]) => ({
        value,
        pages: Array.from(pagesSet),
      }));
      values.sort((a, b) => b.pages.length - a.pages.length);
      findings.push({
        role,
        property,
        severity: "warning",
        message: `"${role}" ${property} is inconsistent across pages: ${values
          .map((v) => `${v.value} (${v.pages.length} page${v.pages.length > 1 ? "s" : ""})`)
          .join(" vs. ")}.`,
        values,
      });
    }
  }

  // Site-wide spacing base unit agreement.
  const unitByPage = new Map<string, number>();
  for (const { target, snapshot } of pages) {
    const result = spacingGridCheck.run(snapshot);
    const unit = result.stats?.baseUnit;
    if (typeof unit === "number") unitByPage.set(target, unit);
  }
  if (unitByPage.size >= 2) {
    const byUnit = new Map<number, string[]>();
    for (const [page, unit] of unitByPage) {
      if (!byUnit.has(unit)) byUnit.set(unit, []);
      byUnit.get(unit)!.push(page);
    }
    if (byUnit.size > 1) {
      const values = Array.from(byUnit.entries())
        .map(([unit, ps]) => ({ value: `${unit}px`, pages: ps }))
        .sort((a, b) => b.pages.length - a.pages.length);
      findings.push({
        role: "page",
        property: "spacingBaseUnit",
        severity: "warning",
        message: `Pages don't agree on a spacing base unit: ${values
          .map((v) => `${v.value} (${v.pages.length} page${v.pages.length > 1 ? "s" : ""})`)
          .join(" vs. ")}.`,
        values,
      });
    }
  }

  return {
    pages: pageNames,
    rolesCompared,
    findings,
    passed: findings.length === 0,
  };
}

function roleKeyFromSelector(selector: string, tag: string): string {
  const last = selector.split(" > ").pop() ?? tag;
  return last.replace(/:nth-of-type\(\d+\)$/, "");
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
