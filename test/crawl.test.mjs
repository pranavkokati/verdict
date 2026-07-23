// Tests for multi-target crawling. Run with:
//   npm run build && node --test test/crawl.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crawl, slugifyTarget, closeBrowser } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bad = path.join(__dirname, "fixtures/bad.html");
const good = path.join(__dirname, "fixtures/good.html");
const fixed = path.join(__dirname, "fixtures/bad-fixed.html");

test("crawl checks every target independently and aggregates correctly", async () => {
  // bad/good/bad-fixed are unrelated fixtures, not one coherent site --
  // skip consistency here too; it's covered on its own in consistency.test.mjs.
  try {
    const { results, summary } = await crawl([bad, good, fixed], { threshold: 80, consistency: false });

    assert.equal(results.length, 3);
    assert.equal(summary.targets, 3);

    const byTarget = Object.fromEntries(summary.results.map((r) => [r.target, r]));
    assert.equal(byTarget[bad].passed, false);
    assert.equal(byTarget[good].passed, true);
    assert.equal(byTarget[good].score, 100);
    assert.equal(byTarget[fixed].passed, true);

    // allPassed must be false because `bad` failed -- one bad page fails the whole crawl.
    assert.equal(summary.allPassed, false);

    // Average is a plain mean of the three scores, rounded.
    const expectedAvg = Math.round((byTarget[bad].score + byTarget[good].score + byTarget[fixed].score) / 3);
    assert.equal(summary.averageScore, expectedAvg);
    assert.deepEqual(summary.errors, [], "no target here is actually unrenderable");
  } finally {
    await closeBrowser();
  }
});

test("crawl isolates a target that fails to render instead of discarding the rest of the batch", async () => {
  // Regression test for a real bug: crawl() previously let any single
  // renderAndExtract failure (a typo'd path, a URL that's down) propagate
  // straight out of the function, aborting the whole crawl and losing
  // every other target's already-computed results. A multi-page crawl is
  // exactly the scenario where one broken/flaky target among many is
  // common, so one bad target should be isolated and reported, not let to
  // nuke the batch.
  const missing = path.join(__dirname, "fixtures/does-not-exist-xyz.html");
  try {
    const { results, summary } = await crawl([good, missing, bad], { threshold: 80, consistency: false });

    // The two real targets still produced full results.
    assert.equal(results.length, 2);
    assert.equal(summary.targets, 3, "targets should reflect every target attempted, including the failed one");

    const byTarget = Object.fromEntries(summary.results.map((r) => [r.target, r]));
    assert.equal(byTarget[good].score, 100);
    assert.ok(byTarget[bad], "bad.html's result should still be present despite the missing target between them");

    // The broken target is isolated into `errors`, not silently dropped.
    assert.equal(summary.errors.length, 1);
    assert.equal(summary.errors[0].target, missing);
    assert.match(summary.errors[0].message, /ENOENT|no such file/i);

    // A crawl with any unrenderable target can never report allPassed.
    assert.equal(summary.allPassed, false);
  } finally {
    await closeBrowser();
  }
});

test("crawl of only-passing targets reports allPassed true", async () => {
  // good.html and bad-fixed.html are unrelated fixtures, not pages of one
  // coherent site -- explicitly skip the cross-page consistency comparison
  // (covered on its own in consistency.test.mjs) so this test stays focused
  // on per-page score aggregation.
  try {
    const { summary } = await crawl([good, fixed], { threshold: 80, consistency: false });
    assert.equal(summary.allPassed, true);
    assert.equal(summary.consistency, null);
    assert.deepEqual(summary.errors, []);
  } finally {
    await closeBrowser();
  }
});

test("slugifyTarget produces filesystem-safe, distinct names", () => {
  assert.equal(slugifyTarget("https://example.com/pricing"), "example-com-pricing");
  const a = slugifyTarget("./dist/index.html");
  const b = slugifyTarget("./dist/about.html");
  assert.notEqual(a, b);
  assert.doesNotMatch(a, /[^a-zA-Z0-9-]/);
});
