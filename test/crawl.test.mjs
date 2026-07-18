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
  const { results, summary } = await crawl([bad, good, fixed], { threshold: 80 });

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

  await closeBrowser();
});

test("crawl of only-passing targets reports allPassed true", async () => {
  const { summary } = await crawl([good, fixed], { threshold: 80 });
  assert.equal(summary.allPassed, true);
  await closeBrowser();
});

test("slugifyTarget produces filesystem-safe, distinct names", () => {
  assert.equal(slugifyTarget("https://example.com/pricing"), "example-com-pricing");
  const a = slugifyTarget("./dist/index.html");
  const b = slugifyTarget("./dist/about.html");
  assert.notEqual(a, b);
  assert.doesNotMatch(a, /[^a-zA-Z0-9-]/);
});
