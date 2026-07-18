/**
 * Core types shared across the render, checks, score, and report layers.
 */

export type Severity = "error" | "warning" | "info";

/** One concrete, actionable finding from a check. */
export interface Issue {
  /** Which check produced this issue, e.g. "contrast". */
  checkId: string;
  severity: Severity;
  /** Human-readable explanation of what's wrong. */
  message: string;
  /** CSS selector (best-effort) identifying the offending element. */
  selector?: string;
  /** Concrete, specific remediation -- not generic advice. */
  suggestedFix?: string;
  /** Raw measured value, e.g. contrast ratio "2.87:1". */
  measured?: string;
  /** The value that would satisfy the check, e.g. "4.5:1". */
  required?: string;
}

/** Result of a single check module. */
export interface CheckResult {
  checkId: string;
  name: string;
  description: string;
  passed: boolean;
  issues: Issue[];
  /** Free-form stats surfaced in the report (counts, detected base unit, etc). */
  stats?: Record<string, unknown>;
}

/** A rendered element's box + computed style, extracted from the live page. */
export interface ExtractedElement {
  selector: string;
  tag: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  style: {
    color: string;
    backgroundColor: string;
    fontSize: number;
    fontWeight: number;
    marginTop: number;
    marginRight: number;
    marginBottom: number;
    marginLeft: number;
    paddingTop: number;
    paddingRight: number;
    paddingBottom: number;
    paddingLeft: number;
    gap: number;
  };
}

/** Everything pulled out of the rendered page for the check modules to consume. */
export interface PageSnapshot {
  url: string;
  viewport: { width: number; height: number };
  screenshotPng: Buffer;
  elements: ExtractedElement[];
  headings: { level: number; text: string; selector: string }[];
  landmarks: { tag: string; selector: string }[];
  images: { selector: string; hasAlt: boolean; alt: string }[];
}

/** Final aggregated output of a `verdict check` run. */
export interface VerdictResult {
  target: string;
  timestamp: string;
  score: number;
  passed: boolean;
  threshold: number;
  checks: CheckResult[];
  issues: Issue[];
  screenshotPng: Buffer;
}

export interface CheckModule {
  id: string;
  name: string;
  description: string;
  run(snapshot: PageSnapshot): CheckResult;
}
