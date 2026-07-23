// Regression tests for the core render engine (src/render/browser.ts). Run with:
//   npm run build && node --test test/render.test.mjs
//
// These target a real bug: renderAndExtract and renderForFix only closed
// their Playwright BrowserContext on the success path. Any failure after
// context creation -- a page.goto that fails on both the networkidle and
// load attempts, a page.evaluate that throws, a screenshot failure -- threw
// straight out of the function without ever calling context.close(), which
// leaked one browser context (and its Chromium page process) per failed
// render call for the lifetime of the cached browser. That's a real problem
// for exactly the callers most likely to hit it repeatedly: a CI job
// checking a target that's down, or an MCP server fielding many tool calls
// against a flaky dev server.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderAndExtract, renderForFix, check, closeBrowser } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goodPath = path.join(__dirname, "fixtures/good.html");

// Port 1 is in Chromium's "unsafe ports" blocklist, so page.goto rejects
// immediately and deterministically on both the networkidle and load
// attempts -- no real network flakiness, no timeout to wait out.
const UNREACHABLE = "http://127.0.0.1:1/";

test("renderAndExtract rejects cleanly on an unreachable target, and the shared browser stays usable afterward", async () => {
  try {
    await assert.rejects(() => renderAndExtract(UNREACHABLE, {}));

    // If the context leaked, this proves nothing on its own -- but if the
    // failure above had left the browser/page in a broken state (rather
    // than just leaking a context), this next call would hang or throw.
    const result = await check(goodPath, { threshold: 80 });
    assert.equal(result.score, 100, "browser should still work normally after a prior render failure");
  } finally {
    await closeBrowser();
  }
});

test("renderForFix rejects cleanly on an unreachable target, and the shared browser stays usable afterward", async () => {
  try {
    await assert.rejects(() => renderForFix(UNREACHABLE, {}));

    const result = await check(goodPath, { threshold: 80 });
    assert.equal(result.score, 100, "browser should still work normally after a prior render failure");
  } finally {
    await closeBrowser();
  }
});

test("renderForFix still returns an open page/context on success, for the caller to close", async () => {
  try {
    const { page, context } = await renderForFix(goodPath, {});
    try {
      assert.equal(page.isClosed(), false, "page should still be open on success -- callers need a live CDP target");
    } finally {
      await context.close();
    }
  } finally {
    await closeBrowser();
  }
});
