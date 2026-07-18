// Integration tests against the built CLI/library. Run with:
//   npm run build && node --test test/run.test.mjs
// Requires a working headless Chromium (see README's "Linux CI" note if
// this fails with a shared-library error).

import { test } from "node:test";
import assert from "node:assert/strict";
import { check, closeBrowser } from "../dist/index.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("bad.html fails and surfaces the seeded issues", async () => {
  const result = await check(path.join(__dirname, "fixtures/bad.html"), { threshold: 80 });

  assert.equal(result.passed, false, "bad.html should not pass");
  assert.ok(result.score < 80, `expected score < 80, got ${result.score}`);

  const checkIds = result.checks.map((c) => c.checkId);
  assert.deepEqual(
    checkIds.sort(),
    ["contrast", "hierarchy", "spacing-grid", "type-scale"].sort(),
  );

  const contrast = result.checks.find((c) => c.checkId === "contrast");
  assert.equal(contrast.passed, false);
  assert.ok(contrast.issues.length >= 3, "expects multiple low-contrast text nodes flagged");

  const hierarchy = result.checks.find((c) => c.checkId === "hierarchy");
  assert.ok(
    hierarchy.issues.some((i) => i.message.includes("No <h1>")),
    "expects missing-h1 to be flagged",
  );
  assert.ok(
    hierarchy.issues.some((i) => i.message.includes("skips h4")),
    "expects the h3 -> h5 heading skip to be flagged",
  );
  assert.ok(
    hierarchy.issues.some((i) => i.message.includes("no alt attribute")),
    "expects the missing alt text to be flagged",
  );
});

test("good.html passes with a high score and no issues", async () => {
  const result = await check(path.join(__dirname, "fixtures/good.html"), { threshold: 80 });

  assert.equal(result.passed, true, "good.html should pass");
  assert.equal(result.score, 100, `expected a perfect score, got ${result.score}`);
  assert.equal(result.issues.length, 0);

  await closeBrowser();
});
