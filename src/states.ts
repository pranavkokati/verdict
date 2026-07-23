import type { CDPSession, Page } from "playwright";
import type { Issue } from "./types.js";
import { renderForFix } from "./render/browser.js";
import { scoreFromIssues } from "./score/aggregate.js";
import { findEffectiveBackground } from "./checks/contrast.js";
import {
  compositeOver,
  contrastRatio,
  isLargeText,
  parseColor,
  suggestAccessibleColor,
} from "./checks/colorUtils.js";

export interface InteractionStateOptions {
  threshold?: number;
  /** Cap on how many interactive elements to force-test. Bounds runtime on pages with hundreds of links. Defaults to 40. */
  maxElements?: number;
}

/** Same shape as VerdictResult/ViewportResult -- scored via the same scoreFromIssues helper. */
export interface InteractionStateResult {
  target: string;
  timestamp: string;
  elementsChecked: number;
  score: number;
  passed: boolean;
  threshold: number;
  issues: Issue[];
}

const AA_NORMAL = 4.5;
const AA_LARGE = 3.0;
const DEFAULT_MAX_ELEMENTS = 40;
const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea"]);

interface StateStyle {
  color: string;
  backgroundColor: string;
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  boxShadow: string;
  borderColor: string;
}

/**
 * Forces every interactive element through :hover, :focus-visible, and
 * :active via Chrome's own CDP `CSS.forcePseudoState` -- the same mechanism
 * DevTools' "Force element state" checkboxes use -- and re-measures what
 * every other check in this project only ever sees at rest.
 *
 * This exists because every check here (and, as far as I can tell, every
 * other design-QA/accessibility tool in this space, including axe-core)
 * evaluates a page in exactly the state it happened to render in: nobody
 * hovering, nothing focused, nothing pressed. Two extremely common,
 * extremely consequential bugs live entirely in the states nobody checks:
 *
 *   1. No visible focus indicator (WCAG 2.4.7). An element that looks
 *      identical whether or not it has keyboard focus is unusable for
 *      keyboard/screen-reader navigation -- you can't tell where you are.
 *   2. Contrast that only fails on interaction. A button whose resting
 *      state passes AA but whose hover/active background change leaves the
 *      (unchanged) text color below the WCAG minimum.
 *
 * Both require forcing a state Playwright's normal render never enters,
 * which is why they've never shown up in any of this project's snapshot-
 * based checks (or, as far as could be verified, in any competing tool).
 *
 * Capped at `maxElements` interactive elements (default 40) to bound
 * runtime -- each element needs several forced-state CDP round trips.
 */
export async function checkInteractionStates(
  target: string,
  opts: InteractionStateOptions = {},
): Promise<InteractionStateResult> {
  const threshold = opts.threshold ?? 80;
  const maxElements = opts.maxElements ?? DEFAULT_MAX_ELEMENTS;

  // A negative maxElements doesn't mean "no limit" or "check nothing" --
  // Array.prototype.slice(0, negativeN) means "everything except the last
  // |negativeN| elements," which silently dropped arbitrary candidates
  // (usually the last one) from being checked at all. Confirmed
  // concretely: --max-elements -1 against states-bad.html silently dropped
  // the seeded hover-contrast bug from the report entirely, reporting a
  // false 92/100 PASS. 0 remains valid (checkInteractionStates already
  // treats "test zero elements" as a legitimate, honestly-reported result).
  if (maxElements < 0) {
    throw new Error(`checkInteractionStates: maxElements must be >= 0, got ${maxElements}.`);
  }

  const { page, context, snapshot } = await renderForFix(target, {});
  const issues: Issue[] = [];
  let elementsChecked = 0;

  try {
    const candidates = snapshot.elements
      .filter((el) => INTERACTIVE_TAGS.has(el.tag) && el.rect.width > 0 && el.rect.height > 0)
      .slice(0, maxElements);

    if (candidates.length === 0) {
      return {
        target,
        timestamp: new Date().toISOString(),
        elementsChecked: 0,
        score: 100,
        passed: true,
        threshold,
        issues: [],
      };
    }

    const client = await page.context().newCDPSession(page);
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = await client.send("DOM.getDocument");

    for (const el of candidates) {
      const found = await client
        .send("DOM.querySelector", { nodeId: root.nodeId, selector: el.selector })
        .catch(() => null);
      if (!found || !found.nodeId) continue;
      const nodeId = found.nodeId;
      elementsChecked++;

      const resting = await readStyle(client, page, nodeId, el.selector, []);
      if (!resting) continue;

      // -- Focus-visible indicator check --
      const focused = await readStyle(client, page, nodeId, el.selector, ["focus-visible"]);
      if (focused && !stateVisiblyDiffers(resting, focused)) {
        issues.push({
          checkId: "interaction-state",
          severity: "error",
          message: `"${el.selector}" has no visible change when it receives keyboard focus -- no outline, box-shadow, border, background, or text-color difference between resting and :focus-visible. A keyboard or screen-reader user has no way to tell it's focused.`,
          selector: el.selector,
          required: "a visible outline, box-shadow, border, or color change on :focus-visible",
          suggestedFix: `Add a visible focus style to "${el.selector}", e.g. outline: 2px solid <a color that meets 3:1 against its background>.`,
        });
      }

      // -- Hover / active contrast checks --
      if (el.text.length > 0) {
        const large = isLargeText(el.style.fontSize, el.style.fontWeight);
        const threshold2 = large ? AA_LARGE : AA_NORMAL;

        for (const state of ["hover", "active"] as const) {
          const forced = await readStyle(client, page, nodeId, el.selector, [state]);
          if (!forced) continue;

          const ownBg = parseColor(forced.backgroundColor);
          const bg = ownBg.a > 0 ? ownBg : findEffectiveBackground(el, snapshot.elements);
          if (!bg) continue;

          const fg = compositeOver(parseColor(forced.color), bg);
          const ratio = contrastRatio(fg, bg);
          if (ratio < threshold2) {
            const fix = suggestAccessibleColor(fg, bg, threshold2);
            issues.push({
              checkId: "interaction-state",
              severity: ratio < threshold2 * 0.7 ? "error" : "warning",
              message: `"${el.selector}" drops to ${ratio.toFixed(2)}:1 contrast on :${state} (below the WCAG AA minimum), even though its resting state may pass.`,
              selector: el.selector,
              measured: `${ratio.toFixed(2)}:1 on :${state}`,
              required: `${threshold2.toFixed(1)}:1`,
              suggestedFix: fix
                ? `On :${state}, change text color to ${fix} (or adjust the :${state} background) to reach ${threshold2.toFixed(1)}:1.`
                : `Increase contrast between text and background on :${state} to at least ${threshold2.toFixed(1)}:1.`,
            });
          }
        }
      }

      // Clear any forced state before moving to the next element.
      await client.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }).catch(() => {});
    }
  } finally {
    await context.close();
  }

  const score = scoreFromIssues(issues);

  return {
    target,
    timestamp: new Date().toISOString(),
    elementsChecked,
    score,
    passed: score >= threshold,
    threshold,
    issues,
  };
}

async function readStyle(
  client: CDPSession,
  page: Page,
  nodeId: number,
  selector: string,
  forcedPseudoClasses: string[],
): Promise<StateStyle | null> {
  await client.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses }).catch(() => {});
  const result = await page
    .evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = window.getComputedStyle(el);
      return {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        outlineColor: cs.outlineColor,
        boxShadow: cs.boxShadow,
        borderColor: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor].join("|"),
      };
    }, selector)
    .catch(() => null);
  return result as StateStyle | null;
}

/** True if any visually-perceptible property differs between two captured states. */
function stateVisiblyDiffers(a: StateStyle, b: StateStyle): boolean {
  const outlineVisible = (s: StateStyle) => s.outlineStyle !== "none" && !s.outlineWidth.startsWith("0px");
  if (outlineVisible(a) !== outlineVisible(b)) return true;
  if (a.boxShadow !== b.boxShadow) return true;
  if (a.borderColor !== b.borderColor) return true;
  if (a.backgroundColor !== b.backgroundColor) return true;
  if (a.color !== b.color) return true;
  if (a.outlineColor !== b.outlineColor && outlineVisible(b)) return true;
  return false;
}
