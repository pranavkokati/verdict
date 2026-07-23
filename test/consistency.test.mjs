// Tests for the cross-page design-system consistency check. Run with:
//   npm run build && node --test test/consistency.test.mjs
//
// Renders three real fixture pages (no mocked snapshots) that share a
// heading style, a paragraph style, and a `.btn-primary` component, with two
// pieces of drift seeded intentionally: site-about.html's <h1> is 28px
// instead of the 32px used on site-home.html and site-contact.html, and its
// `.btn-primary` uses a different hardcoded blue.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderAndExtract, checkConsistency, crawl, closeBrowser } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const homePath = path.join(__dirname, "fixtures/site-home.html");
const aboutPath = path.join(__dirname, "fixtures/site-about.html");
const contactPath = path.join(__dirname, "fixtures/site-contact.html");

test("checkConsistency flags the seeded h1 and button-color drift, and nothing else", async () => {
  try {
    // Rendered sequentially, not concurrently -- matching crawl()'s own
    // documented approach: a single Chromium instance handling several
    // concurrent full-page renders tends to degrade under memory pressure,
    // so this project always renders one page at a time.
    const home = { target: homePath, snapshot: await renderAndExtract(homePath) };
    const about = { target: aboutPath, snapshot: await renderAndExtract(aboutPath) };
    const contact = { target: contactPath, snapshot: await renderAndExtract(contactPath) };

    const summary = checkConsistency([home, about, contact]);

    // Three shared roles recur across pages: h1, p, and a.btn-primary.
    assert.equal(summary.rolesCompared, 3, `expected 3 shared roles, got ${summary.rolesCompared}`);

    // Exactly the two seeded drifts should be flagged -- not more, not fewer.
    assert.equal(summary.findings.length, 2, `expected exactly 2 findings, got ${JSON.stringify(summary.findings, null, 2)}`);
    assert.equal(summary.passed, false);

    const h1Finding = summary.findings.find((f) => f.role === "h1" && f.property === "fontSize");
    assert.ok(h1Finding, "expected an h1 fontSize drift finding");
    assert.equal(h1Finding.severity, "warning");
    const h1Values = new Map(h1Finding.values.map((v) => [v.value, v.pages]));
    assert.equal(h1Values.get("32px")?.length, 2, "32px should be attributed to home + contact");
    assert.equal(h1Values.get("28px")?.length, 1, "28px should be attributed to about only");
    assert.ok(h1Values.get("32px").includes(homePath));
    assert.ok(h1Values.get("32px").includes(contactPath));
    assert.ok(h1Values.get("28px").includes(aboutPath));

    const btnFinding = summary.findings.find((f) => f.role === "a.btn-primary" && f.property === "backgroundColor");
    assert.ok(btnFinding, "expected a button backgroundColor drift finding");
    assert.equal(btnFinding.values.length, 2);

    // h1 color/fontWeight are identical across all three pages -- no finding.
    assert.ok(!summary.findings.some((f) => f.role === "h1" && f.property === "color"));
    assert.ok(!summary.findings.some((f) => f.role === "h1" && f.property === "fontWeight"));

    // The shared <p> style is identical everywhere -- no finding at all for "p".
    assert.ok(!summary.findings.some((f) => f.role === "p"), "the consistent paragraph style should not be flagged");

    // Button font-size and text color are identical across pages too.
    assert.ok(!summary.findings.some((f) => f.role === "a.btn-primary" && f.property === "fontSize"));
    assert.ok(!summary.findings.some((f) => f.role === "a.btn-primary" && f.property === "color"));
  } finally {
    await closeBrowser();
  }
});

test("checkConsistency is a no-op below two pages", () => {
  const single = checkConsistency([{ target: "only.html", snapshot: makeEmptySnapshot() }]);
  assert.equal(single.rolesCompared, 0);
  assert.equal(single.findings.length, 0);
  assert.equal(single.passed, true);

  const none = checkConsistency([]);
  assert.equal(none.passed, true);
});

test("crawl() wires consistency into the summary and allPassed reflects drift", async () => {
  try {
    const { summary } = await crawl([homePath, aboutPath, contactPath], { threshold: 80 });

    assert.ok(summary.consistency, "expected crawl to run the consistency comparison by default for 3 targets");
    assert.equal(summary.consistency.findings.length, 2);

    // Every individual page passes its own accessibility/type/spacing checks
    // (score 100 each -- these fixtures have no per-page issues), but the
    // crawl as a whole must still fail because the pages disagree with each
    // other. That distinction is the entire point of this feature.
    assert.ok(summary.results.every((r) => r.passed), "each page individually should score cleanly");
    assert.equal(summary.allPassed, false, "crawl-level allPassed must reflect cross-page drift, not just per-page scores");
  } finally {
    await closeBrowser();
  }
});

test("crawl() with --no-consistency-equivalent option skips the comparison entirely", async () => {
  try {
    const { summary } = await crawl([homePath, aboutPath], { threshold: 80, consistency: false });
    assert.equal(summary.consistency, null);
  } finally {
    await closeBrowser();
  }
});

function makeEmptySnapshot() {
  return {
    url: "file:///only.html",
    viewport: { width: 1280, height: 800 },
    screenshotPng: Buffer.from([]),
    elements: [],
    headings: [],
    landmarks: [],
    images: [],
  };
}
