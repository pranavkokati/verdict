// Tests for the forced interaction-state checker (`verdict states`). Run with:
//   npm run build && node --test test/states.test.mjs
//
// states-bad.html seeds two real, independent bugs, one per category:
//   1. .no-focus-btn -- outline explicitly suppressed at rest AND on
//      :focus-visible, so a keyboard user gets zero visual feedback that
//      the element is focused (WCAG 2.4.7).
//   2. .bad-hover-btn -- white text on a #0055ff background at rest (passes
//      AA fine), but :hover swaps the background to near-white (#f0f0f0)
//      while the text color never changes, cratering contrast on hover.
// states-good.html is a single button with a real 3px :focus-visible
// outline and :hover/:active states that darken progressively while
// keeping white text high-contrast throughout -- should score clean.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkInteractionStates, closeBrowser } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const badPath = path.join(__dirname, "fixtures/states-bad.html");
const goodPath = path.join(__dirname, "fixtures/states-good.html");

test("checkInteractionStates flags a missing focus indicator and a hover contrast regression", async () => {
  try {
    const result = await checkInteractionStates(badPath, { threshold: 80 });

    assert.equal(result.elementsChecked, 2, "expected both buttons to be forced through their states");
    assert.ok(result.score < 100, `expected a deducted score, got ${result.score}`);
    assert.equal(result.issues.length, 2, "expected exactly the two seeded bugs, no false positives");

    const focusIssue = result.issues.find((i) => i.selector.includes("no-focus-btn"));
    assert.ok(focusIssue, "expected a focus-indicator issue for .no-focus-btn");
    assert.equal(focusIssue.checkId, "interaction-state");
    assert.equal(focusIssue.severity, "error");
    assert.match(focusIssue.message, /no visible change when it receives keyboard focus/);
    assert.match(focusIssue.message, /:focus-visible/);

    const hoverIssue = result.issues.find((i) => i.selector.includes("bad-hover-btn"));
    assert.ok(hoverIssue, "expected a hover-contrast issue for .bad-hover-btn");
    assert.equal(hoverIssue.checkId, "interaction-state");
    assert.match(hoverIssue.message, /:hover/);
    assert.match(hoverIssue.message, /contrast/);
    // #f0f0f0 background with white (#ffffff) text is roughly 1.1:1 -- nowhere
    // close to the 4.5:1 AA minimum, so this should be reported as an error,
    // not merely a warning (ratio < threshold * 0.7).
    assert.equal(hoverIssue.severity, "error");
    assert.match(hoverIssue.message, /1\.\d\d:1/);

    // The seeded bugs are independent of :active -- neither button should
    // produce an :active-only issue beyond the two already asserted above.
    const activeOnlyIssues = result.issues.filter((i) => /:active/.test(i.message));
    assert.equal(activeOnlyIssues.length, 0, "no :active-specific regression was seeded");
  } finally {
    await closeBrowser();
  }
});

test("checkInteractionStates reports a clean 100/100 for a genuinely well-behaved button", async () => {
  try {
    const result = await checkInteractionStates(goodPath, { threshold: 80 });
    assert.equal(result.elementsChecked, 1);
    assert.equal(result.score, 100, `expected a perfect score, got ${JSON.stringify(result.issues, null, 2)}`);
    assert.equal(result.passed, true);
    assert.equal(result.issues.length, 0);
  } finally {
    await closeBrowser();
  }
});

test("checkInteractionStates returns a perfect score with zero elements checked when there's nothing interactive", async () => {
  try {
    // Reuse states-good.html's page but cap maxElements at 0 to force the
    // "no candidates" early-return path.
    const result = await checkInteractionStates(goodPath, { threshold: 80, maxElements: 0 });
    assert.equal(result.elementsChecked, 0);
    assert.equal(result.score, 100);
    assert.equal(result.passed, true);
    assert.equal(result.issues.length, 0);
  } finally {
    await closeBrowser();
  }
});

test("checkInteractionStates rejects a negative maxElements instead of silently dropping candidates", async () => {
  // Regression test for a real bug: Array.prototype.slice(0, negativeN)
  // does NOT mean "no limit" or "check nothing" -- it means "everything
  // except the last |negativeN| elements." maxElements: -1 against
  // states-bad.html silently dropped the seeded hover-contrast bug on
  // .bad-hover-btn from the candidate list entirely (it's the last of the
  // two candidates), reporting a false 92/100 PASS with only the
  // focus-indicator bug caught -- a real bug going completely undetected,
  // not just a cosmetic count-off-by-one.
  try {
    await assert.rejects(
      () => checkInteractionStates(badPath, { threshold: 80, maxElements: -1 }),
      /maxElements must be >= 0/,
    );
  } finally {
    await closeBrowser();
  }
});
