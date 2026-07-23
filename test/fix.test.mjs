// Tests for `verdict fix`: the CDP-based auto-patcher. Run with:
//   npm run build && node --test test/fix.test.mjs
//
// These hit a real headless Chromium and a real CDP session -- no mocking of
// the browser or the cascade engine. The point of `fix` is that it trusts
// Chrome's own resolved styles, not a hand-rolled CSS parser, so the test has
// to exercise the real thing to mean anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fixTarget, check, closeBrowser } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const badPath = path.join(__dirname, "fixtures/bad.html");
const goodPath = path.join(__dirname, "fixtures/good.html");
const dollarPath = path.join(__dirname, "fixtures/fix-dollar.html");

test("fixTarget patches bad.html's contrast/type-scale/spacing issues and lifts the score", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "verdict-fix-test-"));
  const outPath = path.join(dir, "bad.fixed.html");

  try {
    const result = await fixTarget(badPath, { threshold: 80, out: outPath });

    // Baseline: same numbers `verdict check` reports for bad.html.
    assert.equal(result.before.passed, false);
    assert.ok(result.before.score < 80, `expected a failing baseline, got ${result.before.score}`);

    // Every fixable issue actually got applied -- nothing silently skipped.
    assert.ok(result.applied.length > 0, "expected at least one applied fix");
    assert.equal(result.skipped.length, 0, "expected no skipped fixes against a clean fixture");

    // Only contrast / type-scale / spacing-grid issues are touched.
    assert.ok(
      result.applied.every((a) => ["color", "font-size"].includes(a.property) || a.property.startsWith("margin") || a.property.startsWith("padding")),
      "auto-fix should only ever touch color, font-size, margin*, or padding* properties",
    );

    // Structural issues (missing h1, missing alt, heading skip, missing main)
    // are explicitly reported as unfixable, never invented.
    assert.ok(result.unfixable.length >= 4, `expected the 4 seeded hierarchy issues to remain, got ${result.unfixable.length}`);
    assert.ok(result.unfixable.every((i) => i.checkId === "hierarchy"), "only hierarchy issues should be left unfixed");
    assert.ok(result.unfixable.some((i) => i.message.includes("No <h1>")));
    assert.ok(result.unfixable.some((i) => i.message.toLowerCase().includes("no alt attribute")));

    // The patched file was written and its score genuinely improved.
    assert.ok(result.outPath, "expected an outPath since fixes were applied");
    assert.ok(result.after, "expected an after-score since fixes were applied");
    assert.ok(
      result.after.score > result.before.score,
      `expected the patched score (${result.after.score}) to beat the baseline (${result.before.score})`,
    );

    // Independent re-verification: re-run `check` against the written file
    // through the normal entry point, not the `after` snapshot fixTarget
    // already computed internally. This is the same "don't trust your own
    // claimed diff" principle `verdict diff` applies to human-made fixes,
    // now applied to Verdict's own patch.
    const reChecked = await check(outPath, { threshold: 80 });
    assert.equal(reChecked.score, result.after.score, "independent re-check should match fixTarget's own after-score");
    assert.equal(reChecked.passed, true, `expected the patched file to pass at threshold 80, got ${reChecked.score}`);

    const contrastCheck = reChecked.checks.find((c) => c.checkId === "contrast");
    const typeScaleCheck = reChecked.checks.find((c) => c.checkId === "type-scale");
    const spacingCheck = reChecked.checks.find((c) => c.checkId === "spacing-grid");
    assert.equal(contrastCheck.issues.length, 0, "contrast issues should be fully resolved");
    assert.equal(typeScaleCheck.issues.length, 0, "type-scale issues should be fully resolved");
    assert.equal(spacingCheck.issues.length, 0, "spacing-grid issues should be fully resolved");

    // Hierarchy issues (never auto-fixed) should still be present and
    // identical in substance to what was reported as unfixable.
    const hierarchyCheck = reChecked.checks.find((c) => c.checkId === "hierarchy");
    assert.equal(hierarchyCheck.issues.length, result.unfixable.length);

    // The written file must be real, parseable HTML containing the patched
    // values -- not a placeholder or truncated write.
    const written = await readFile(outPath, "utf8");
    assert.ok(written.includes("<html"), "output should be a full HTML document");
    assert.ok(written.length > 100, "output should not be truncated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fixTarget doesn't corrupt a stylesheet containing literal $-patterns elsewhere in the same sheet", async () => {
  // Regression test for a real bug: cssPatcher.ts originally spliced patched
  // stylesheet/element text back into the source via
  // `currentHtml.replace(before.text, after.text)`. When `replace`'s second
  // argument is a string (not a function), JS treats `$&`, `$$`, `$'`, etc.
  // inside it as special replacement patterns -- so a stylesheet containing
  // an unrelated rule with a literal "$$" or "$&" (e.g. in a `content:`
  // value) got silently corrupted the moment ANY rule in that same
  // stylesheet was patched, because CSS.getStyleSheetText returns the whole
  // sheet's text, not just the touched rule.
  const dir = await mkdtemp(path.join(tmpdir(), "verdict-fix-dollar-test-"));
  const outPath = path.join(dir, "fix-dollar.fixed.html");

  try {
    const result = await fixTarget(dollarPath, { threshold: 80, out: outPath });

    const contrastFix = result.applied.find((a) => a.property === "color");
    assert.ok(contrastFix, "expected the .low-contrast rule's color to be patched");

    const written = await readFile(outPath, "utf8");
    // The decoy rule, containing literal "$$" and "$&", must survive
    // byte-for-byte -- not have "$&" expand into the matched text, "$$"
    // collapse to a single "$", or otherwise get mangled.
    assert.ok(
      written.includes('content: "$$ special offer, save $&50 today!";'),
      `expected the decoy $-pattern rule to survive unmodified, got:\n${written}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fixTarget leaves already-clean pages untouched", async () => {
  const result = await fixTarget(goodPath, { threshold: 80 });

  assert.equal(result.before.score, 100);
  assert.equal(result.applied.length, 0, "a perfect page should have nothing to patch");
  assert.equal(result.after, null, "no output should be generated when nothing was applied");
  assert.equal(result.outPath, null, "no file should be written when nothing was applied");
  assert.equal(result.unfixable.length, 0);

  await closeBrowser();
});
