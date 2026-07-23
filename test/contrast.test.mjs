// Regression tests for two real bugs in the effective-background resolution
// behind the "Color Contrast (WCAG 2.1)" check (src/checks/contrast.ts,
// src/render/browser.ts). Run with:
//   npm run build && node --test test/contrast.test.mjs
//
// Bug 1 (contrast.ts's findEffectiveBackground): a semi-transparent
// background (a modal scrim, a translucent header, a glassmorphism panel)
// had its alpha silently dropped -- `rgba(255,255,255,0.5)` was treated as
// opaque white, since relativeLuminance only reads r/g/b. True composited
// background matters: this measurably changes the reported ratio (verified
// by hand: ~3.98:1 true vs. ~1.0:1 as previously computed).
//
// Bug 2 (browser.ts's extractInPage): `document.body.querySelectorAll("*")`
// never returns <body> or <html> themselves, only their descendants -- so a
// page setting its background color directly on <body> (the most common
// way to set a page's background, and essential for any dark-themed site)
// was entirely invisible to background resolution, silently falling back to
// an assumed opaque white canvas. Verified by hand: ~15:1 true contrast for
// light text on a dark body vs. ~1.26:1 as previously computed.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, closeBrowser } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const overlayPath = path.join(__dirname, "fixtures/contrast-overlay.html");
const darkBodyPath = path.join(__dirname, "fixtures/contrast-dark-body.html");

test("contrast check correctly composites a semi-transparent overlay background instead of treating it as opaque", async () => {
  const result = await check(overlayPath, { threshold: 80 });
  const contrastIssues = result.issues.filter((i) => i.checkId === "contrast");
  assert.equal(
    contrastIssues.length,
    0,
    `expected the overlay heading's true ~3.98:1 contrast to pass the 3:1 large-text minimum, got: ${JSON.stringify(contrastIssues, null, 2)}`,
  );
});

test("contrast check sees a background color set directly on <body>, not just on wrapping elements", async () => {
  const result = await check(darkBodyPath, { threshold: 80 });
  const contrastIssues = result.issues.filter((i) => i.checkId === "contrast");
  assert.equal(
    contrastIssues.length,
    0,
    `expected light text on a dark <body> background (~15:1) to pass cleanly, got: ${JSON.stringify(contrastIssues, null, 2)}`,
  );

  await closeBrowser();
});
