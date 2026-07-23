// Tests for the diff engine and score-history tracking. Run with:
//   npm run build && node --test test/diff-history.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  renderAndExtract,
  scoreSnapshot,
  diffResults,
  diffScreenshots,
  appendHistory,
  readHistory,
  historyFilePath,
  lastPassingEntryFor,
  scoreFromIssues,
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

    // Per-check scores stored in history must use the same scoring model
    // as everywhere else (scoreFromIssues), not a separate ad hoc formula --
    // otherwise the numbers in .verdict/history.jsonl wouldn't mean the same
    // thing as the score verdict check itself reports for the same issues.
    for (const c of failing.checks) {
      assert.equal(
        all[0].checks[c.checkId].score,
        scoreFromIssues(c.issues),
        `history's per-check score for ${c.checkId} should match scoreFromIssues`,
      );
      assert.equal(all[0].checks[c.checkId].issueCount, c.issues.length);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await closeBrowser();
  }
});

test("readHistory skips a corrupted line instead of discarding the whole file", async () => {
  // Regression test: a process killed mid-append (a CI job timing out, a
  // Ctrl-C) leaves a truncated/malformed last line in history.jsonl.
  // readHistory previously wrapped the entire parse in one try/catch, so a
  // single bad JSON.parse threw away every valid entry in the file too --
  // silently disabling the regression gate with no error ever surfacing.
  const dir = await mkdtemp(path.join(tmpdir(), "verdict-history-corrupt-"));
  try {
    const validLine1 = JSON.stringify({
      timestamp: new Date().toISOString(),
      target: "./page.html",
      score: 70,
      passed: false,
      threshold: 80,
      checks: {},
    });
    const validLine2 = JSON.stringify({
      timestamp: new Date().toISOString(),
      target: "./page.html",
      score: 95,
      passed: true,
      threshold: 80,
      checks: {},
    });
    // A truncated line, exactly what a process killed mid-`appendFile` would leave behind.
    const corruptedLine = '{"timestamp":"2026-01-01T00:00:00.000Z","target":"./page.html","score":42,"pass';

    await writeFile(historyFilePath(dir), `${validLine1}\n${corruptedLine}\n${validLine2}\n`, "utf8");

    const all = await readHistory(dir);
    assert.equal(all.length, 2, "expected both valid entries to survive the corrupted line between them");
    assert.equal(all[0].score, 70);
    assert.equal(all[1].score, 95);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readHistory returns an empty array (not a throw) when history.jsonl doesn't exist", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "verdict-history-missing-"));
  try {
    const all = await readHistory(dir);
    assert.deepEqual(all, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
