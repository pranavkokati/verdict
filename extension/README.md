# Verdict browser extension

Runs the same contrast, type-scale, spacing, and heading checks as `verdict check`, directly against whatever tab you have open right now. No CLI, no build output, no headless Chromium: the checks run in the page you're already looking at.

`content.js` is a direct, dependency-free port of `src/render/browser.ts`'s extraction function and `src/checks/*.ts` -- same constants, same formulas, same severity math. Those modules were already written with zero Node or Playwright dependency (they only ever touch `document`, `window.getComputedStyle`, and plain data), so porting them into a content script is a straight copy, not a reimplementation.

## Install (unpacked, for now)

1. `chrome://extensions`
2. Enable Developer mode
3. Load unpacked -> select this `extension/` directory

## Use

Open the popup on any page, click "Check this page." You get the score, the per-check pass/fail, the full issue list with selectors and suggested fixes, and buttons to copy the result as JSON or as an agent-pasteable fix list -- the same two output shapes `verdict check --json` and `verdict check --agent` produce from the CLI.

## Why this instead of a packaged build step

The extension needs zero bundler because the ported logic has zero imports -- it's a single self-contained IIFE. If the check modules ever grow a real dependency, this becomes an esbuild step instead; not needed yet.
