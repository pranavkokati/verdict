// Tests for the diff engine and score-history tracking. Run with:
//   npm run build && node --test test/diff-history.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  renderAndExtract,
  scoreSnapshot,
  diffResults,
  diffScreenshots,
  appendHistory,
  readHistory,
  lastPassingEntryFor,
  closeBrowser,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const badPath = path.join(__dirname, "fixtures/bad.html");
const fixedPath = path.join(__dirname, "fixtures/bad-fixed.html");

test("diffResults: bad -> fixed shows improvement, not regression", async () => {
  const beforeSnap = await renderAndExtract(badPath);
  const afterSnap = await renderAndExtract(fixedPath);
  const before = scoreSnapshot(badPath, beforeSnap, 80);
  const after = scoreSnapshot(fixedPath, afterSnap, 80);

  const diff = diffResults(before, after);

  assert.ok(diff.scoreDelta > 0, `expected a positive score delta, got ${diff.scoreDelta}`);
  assert.equal(diff.improved, true);
  assert.equal(diff.regressed, false);
  assert.ok(diff.issues.fixed.length > 0, "expected at least one issue to be marked fixed");

  // Every check that failed on "bad" should pass (or strictly improve) on "fixed".
  for (const c of diff.checks) {
    assert.ok(
      c.afterIssueCount <= c.beforeIssueCount,
      `${c.checkId} regressed: ${c.beforeIssueCount} -> ${c.afterIssueCount}`,
    );
  }

  await closeBrowser();
});

test("diffScreenshots: identical renders have zero pixel diff; different renders don't", async () => {
  const snapA = await renderAndExtract(badPath);
  const snapB = await renderAndExtract(badPath);
  const snapC = await renderAndExtract(fixedPath);

  const identical = diffScreenshots(snapA.screenshotPng, snapB.screenshotPng);
  assert.equal(identical.diffPixelCount, 0);
  assert.equal(identical.diffRatio, 0);

  const different = diffScreenshots(snapA.screenshotPng, snapC.screenshotPng);
  assert.ok(different.diffPixelCount > 0, "expected the bad vs fixed renders to differ visually");

  await closeBrowser();
});

test("history: appends and reads back, and finds the last passing run as baseline", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "verdict-history-"));
  try {
    const badSnap = await renderAndExtract(badPath);
    const failing = scoreSnapshot(badPath, badSnap, 80);
    await appendHistory(dir, failing);

    const fixedSnap = await renderAndExtract(fixedPath);
    // Score fixedPath but *label it as the same target* to simulate two
    // runs of the same page over time (a real "did this page improve" story).
    const passing = scoreSnapshot(badPath, fixedSnap, 80);
    await appendHistory(dir, passing);

    const all = await readHistory(dir);
    assert.equal(all.length, 2);
    assert.equal(all[0].passed, false);
    assert.equal(all[1].passed, true);

    const baseline = await lastPassingEntryFor(dir, badPath);
    assert.ok(baseline, "expected a passing baseline to be found");
    assert.equal(baseline.score, passing.score);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await closeBrowser();
  }
});
