// Tests for the multi-viewport structural integrity check. Run with:
//   npm run build && node --test test/viewport.test.mjs
//
// viewport-bad.html seeds three real, independent bugs, one per category:
//   1. a fixed 500px promo banner that overflows the 375px mobile viewport
//   2. a 20x20px icon-only button, well under the 44x44px tap-target minimum
//   3. a <nav> landmark that's `display: none` below 700px -- present at
//      tablet/desktop, invisible (and absent from the accessibility tree)
//      at mobile
// viewport-good.html is the same layout with all three bugs fixed, and
// should score cleanly at every default viewport.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkViewports, parseViewportList, closeBrowser, DEFAULT_VIEWPORTS } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const badPath = path.join(__dirname, "fixtures/viewport-bad.html");
const goodPath = path.join(__dirname, "fixtures/viewport-good.html");

test("checkViewports flags the seeded overflow, tap-target, and structural-parity bugs", async () => {
  try {
    const result = await checkViewports(badPath, { threshold: 80 });

    assert.equal(result.viewports.length, DEFAULT_VIEWPORTS.length);
    assert.ok(result.score < 100, `expected a deducted score, got ${result.score}`);

    const byCheck = Object.fromEntries(
      ["viewport-overflow", "viewport-tap-target", "viewport-structural"].map((id) => [
        id,
        result.issues.filter((i) => i.checkId === id),
      ]),
    );

    assert.equal(byCheck["viewport-overflow"].length, 1, "expected exactly one overflow issue (mobile only)");
    assert.match(byCheck["viewport-overflow"][0].message, /promo-banner/);
    assert.match(byCheck["viewport-overflow"][0].message, /mobile/);
    assert.equal(byCheck["viewport-overflow"][0].severity, "error");

    assert.equal(byCheck["viewport-tap-target"].length, 1, "expected exactly one tap-target issue");
    assert.match(byCheck["viewport-tap-target"][0].message, /icon-button/);
    assert.match(byCheck["viewport-tap-target"][0].message, /20x20px/);
    assert.equal(byCheck["viewport-tap-target"][0].severity, "warning");

    assert.equal(byCheck["viewport-structural"].length, 1, "expected exactly one structural-parity issue");
    assert.match(byCheck["viewport-structural"][0].message, /nav/);
    assert.match(byCheck["viewport-structural"][0].message, /missing at mobile/);

    // Overflow and tap-target bugs should surface only at the mobile
    // viewport -- the banner and button are only actually broken there.
    assert.match(byCheck["viewport-overflow"][0].message, /mobile \(375x812\)/);
    assert.match(byCheck["viewport-tap-target"][0].message, /mobile \(375x812\)/);
  } finally {
    await closeBrowser();
  }
});

test("checkViewports reports a clean 100/100 for a genuinely responsive page", async () => {
  try {
    const result = await checkViewports(goodPath, { threshold: 80 });
    assert.equal(result.score, 100, `expected a perfect score, got ${JSON.stringify(result.issues, null, 2)}`);
    assert.equal(result.passed, true);
    assert.equal(result.issues.length, 0);
  } finally {
    await closeBrowser();
  }
});

test("checkViewports honors a custom --viewports list and skips tap-target checks above the mobile breakpoint", async () => {
  try {
    // Only a tablet-width viewport -- above the 480px mobile breakpoint, so
    // the icon-button's 20x20px size should NOT be flagged as a tap-target
    // issue here even though it's still visually undersized, because the
    // guideline is scoped to touch-primary (mobile) widths.
    const custom = parseViewportList("768x1024");
    const result = await checkViewports(badPath, { threshold: 80, viewports: custom });

    assert.equal(result.viewports.length, 1);
    assert.equal(result.viewports[0].width, 768);
    assert.equal(
      result.issues.filter((i) => i.checkId === "viewport-tap-target").length,
      0,
      "tap-target check should be skipped above the mobile breakpoint",
    );
    // The nav is visible at 768px (only hidden below 700px), and the promo
    // banner (500px) doesn't overflow a 768px viewport -- so this single
    // wide viewport should be entirely clean.
    assert.equal(result.issues.length, 0);
  } finally {
    await closeBrowser();
  }
});

test("parseViewportList rejects malformed specs", () => {
  assert.throws(() => parseViewportList("not-a-size"), /Invalid viewport/);
  assert.deepEqual(
    parseViewportList("375x812,768x1024").map((v) => [v.width, v.height]),
    [
      [375, 812],
      [768, 1024],
    ],
  );
});

test("checkViewports rejects an empty viewports array instead of silently reporting a hollow 100/100 pass", async () => {
  // Regression test for a real bug: with zero rendered viewports, there are
  // zero possible issues, so checkViewports previously reported a clean
  // 100/100 PASS even against viewport-bad.html -- a fixture with three
  // deliberately seeded bugs -- because nothing was actually tested. Not
  // reachable via the CLI/MCP surface (parseViewportList already rejects
  // malformed --viewports strings before an empty array could result), but
  // directly reachable via the library API's `viewports` option.
  try {
    await assert.rejects(
      () => checkViewports(badPath, { viewports: [] }),
      /at least one viewport/,
    );
  } finally {
    await closeBrowser();
  }
});
