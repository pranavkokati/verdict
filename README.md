# Verdict

**Design QA for AI-generated interfaces.**

Verdict renders your UI in a real headless browser, measures it against objective design rules, and returns a scored, machine-readable fix-list. It's the closed-loop check that's missing from every "give the agent a taste prompt" workflow: it doesn't trust that the agent complied, it verifies.

```bash
npx verdict-ui check ./dist/index.html
```

```
────────────────────────────────────────────────
  Verdict  50/100  (threshold 80)  FAIL
────────────────────────────────────────────────
  ✗ Color Contrast (WCAG 2.1)        (4 issues)
  ✗ Type Scale Consistency           (1 issue)
  ✗ Spacing Grid Consistency         (18 issues)
  ✗ Heading & Landmark Hierarchy     (4 issues)
────────────────────────────────────────────────
  5 error(s), 4 warning(s), 18 info
  Report: .verdict/report.html
────────────────────────────────────────────────
```

Exit code is `0` on pass, `1` on fail -- so `verdict check` gates a CI pipeline the same way `eslint` or `tsc --noEmit` does.

Verdict is **closed-loop**. It doesn't tell the agent what to do -- it checks what the agent actually did:

1. It renders the real, final HTML/CSS in headless Chromium via Playwright -- actual computed styles and layout boxes, not a static text/AST guess.
2. It runs four independently-scored checks against that render (below).
3. It emits a score, a pass/fail verdict against a configurable threshold, and a structured fix-list with the exact selector, the measured value, the required value, and a concrete fix -- formatted so you can paste it straight back into an agent's chat (`verdict check --agent`) and have it act on real, specific findings instead of vibes.
4. It remembers. Every run appends to a local score history, so `verdict check` can gate a PR not just on an absolute threshold but on **regression vs. the last passing run** -- an agent that "fixes" the copy but quietly tanks contrast on a different element gets caught even if the absolute score still clears the bar.
5. It can compare two renders directly (`verdict diff before.html after.html`): pixel-level screenshot diff plus a fixed/introduced/persisting issue breakdown, so a redesign claim is something you can look at, not take on faith.
6. It scales past one page. `verdict crawl` checks a whole set of pages in one run and aggregates a single pass/fail -- a real product has more than a landing page.

This makes the claim "the UI is good" -- and "the UI got better" -- falsifiable and CI-gateable, which a prompt injected into an agent's context never is.

## Checks

| Check | What it verifies |
| --- | --- |
| **Color Contrast (WCAG 2.1)** | Real relative-luminance contrast ratio for every text node against its effective background (walking the containment stack for the first painted background). Flags anything under the WCAG AA minimum (4.5:1 normal text, 3:1 large text) and computes a specific replacement hex color that would pass. |
| **Type Scale Consistency** | Collects every font-size in use and flags values that don't land on a clean type-scale step (evidence of unintentional em/rem drift) and pages using more distinct sizes than a coherent system typically needs. |
| **Spacing Grid Consistency** | Detects whether the page's margin/padding/gap values are drawn from a consistent 4px or 8px base unit -- the convention nearly every real design system uses -- and flags the values that break it. |
| **Heading & Landmark Hierarchy** | Exactly one `<h1>`, no skipped heading levels, presence of a `<main>` landmark, and `alt` text on every `<img>`. |

Each check is real, deterministic code -- not an LLM call -- so results are reproducible and explainable. (A VLM-based aesthetic critique pass is on the roadmap as a fifth, opt-in check; it isn't built yet, and this README won't claim it is until it exists.)

## Install

```bash
npm install verdict-ui
npx playwright install chromium   # one-time, ~180MB Chromium download
```

On a bare Linux CI image you may also need the OS-level shared libraries Chromium links against:

```bash
npx playwright install-deps chromium   # needs root; not required on macOS/Windows
```

## CLI

### `verdict check`

```bash
verdict check <file-or-url> [options]

Options:
  -o, --out <dir>          output directory for report.json + report.html + history.jsonl  (default ".verdict")
  -t, --threshold <n>      minimum score to pass, 0-100                                     (default 80)
  --json                   print JSON only, write no files
  --agent                  print an agent-pasteable fix list instead of the terminal summary
  --no-report              skip writing the HTML report
  --no-history             don't append this run to .verdict/history.jsonl
  --no-regression-gate     don't fail on a score regression vs. the last passing run (absolute --threshold still applies)
```

Examples:

```bash
# Local build output
verdict check ./dist/index.html

# A running dev server
verdict check http://localhost:3000

# CI gate, no report files
verdict check ./dist/index.html --json --threshold 90

# Feed straight back into an agent
verdict check ./dist/index.html --agent | pbcopy
```

Every run is scored against two independent bars: the absolute `--threshold`, and (unless `--no-regression-gate`) the last run of the same target that passed. Both have to hold for `verdict check` to exit `0`. This is what makes it usable as a real CI gate instead of a one-shot lint: a page can sit at a stable 85/100 forever, but the moment a change drags it to 70, the regression gate fails even though nothing else about the setup changed.

### `verdict diff`

```bash
verdict diff <before> <after> [options]

Options:
  -o, --out <dir>        output directory for diff.html   (default ".verdict/diff")
  -t, --threshold <n>    minimum score for "after" to pass (default 80)
  --json                 print JSON only, write no files
  --allow-regression     exit 0 even if the score went down
```

```bash
verdict diff ./before.html ./after.html
────────────────────────────────────────────────
  Verdict diff  50 -> 98  (+48)  IMPROVED
────────────────────────────────────────────────
  pixels changed: 0.4%
  issues: 27 fixed, 2 introduced, 0 persisting
  report: .verdict/diff/diff.html
────────────────────────────────────────────────
```

`diff.html` embeds the before screenshot, the after screenshot, and a pixel-level diff overlay (via `pixelmatch`), plus a per-check score table and a fixed/introduced/persisting issue breakdown. This is the artifact to attach to a PR when an agent claims it "improved the design" -- it either did, in a way you can see and count, or it didn't.

### `verdict crawl`

A real site has more than one page. `verdict crawl` runs the full check suite against several targets in one invocation and rolls them into an aggregate pass/fail.

```bash
verdict crawl <targets...> [options]

Options:
  -o, --out <dir>       output directory for per-page reports + summary.json  (default ".verdict/crawl")
  -t, --threshold <n>   minimum score to pass, per page (0-100)                (default 80)
  --json                print only the JSON summary to stdout
  --no-history          don't append these runs to .verdict/crawl/history.jsonl
```

```bash
verdict crawl ./dist/index.html ./dist/pricing.html ./dist/about.html
────────────────────────────────────────────────────────
  Verdict crawl  3 page(s)  avg 83/100  SOME FAILED
────────────────────────────────────────────────────────
  ✗  50  ./dist/index.html  (27 issues)
  ✓ 100  ./dist/pricing.html  (0 issues)
  ✓  98  ./dist/about.html  (2 issues)
────────────────────────────────────────────────────────
  summary: .verdict/crawl/summary.json
────────────────────────────────────────────────────────
```

One failing page fails the whole crawl (exit code `1`), so `verdict crawl` can gate a multi-page build the same way `verdict check` gates a single file. Each page gets its own `report.html` in a slugified subdirectory.

### `verdict history`

```bash
verdict history <target> [options]

Options:
  -o, --out <dir>   directory containing history.jsonl   (default ".verdict")
  -n, --last <n>     how many recent runs to show          (default 10)
```

```bash
verdict history ./dist/index.html
Score history for ./dist/index.html:

  ██████████░░░░░░░░░░   50  FAIL  7/18/2026, 8:04:59 AM
  ███████████████████░   98  PASS  7/18/2026, 8:06:12 AM
```

## Library

```ts
import { check } from "verdict-ui";

const result = await check("http://localhost:3000", { threshold: 80 });

console.log(result.score, result.passed);
for (const issue of result.issues) {
  console.log(issue.severity, issue.message, issue.suggestedFix);
}
```

## The report

`verdict check` writes a single, self-contained `report.html` -- no server, no CDN dependency, no external assets. It embeds the full-page screenshot and every issue with its selector, measured value, required value, and suggested fix. Open it directly from disk or attach it to a PR.

## CI

`.github/workflows/verdict.yml` in this repo is a copy-pasteable example: build your app, install a headless Chromium (`playwright install --with-deps` -- needs root, which GitHub-hosted runners have by default), cache `.verdict/` between runs so score history persists across PRs, run `verdict check` against the build output, and upload the report as a build artifact. The job fails the PR check on either an absolute score below threshold or a regression vs. the last passing run on `main`.

On unprivileged Linux containers (some self-hosted runners, some sandboxes) `playwright install-deps` will fail without root -- see the Install section above.

`.github/workflows/release.yml` publishes to npm automatically on a version tag (`git tag v0.3.0 && git push --tags`), gated behind the same test suite. Requires an `NPM_TOKEN` repo secret.

## Browser extension

`extension/` runs the same four checks against whatever tab you have open, live, no CLI and no build output required. It's a direct, dependency-free port of `src/render/browser.ts` and `src/checks/*.ts` -- same constants and formulas, not a lighter reimplementation -- because those modules already had zero Node/Playwright dependency. Load it unpacked from `chrome://extensions` (Developer mode -> Load unpacked -> select `extension/`). See `extension/README.md`.

## Agent integration (MCP)

`mcp-server/` exposes `verdict_check`, `verdict_diff`, and `verdict_crawl` as MCP tools, so a coding agent -- Claude Code, Cursor, anything that speaks MCP -- can call Verdict directly mid-task instead of a human running the CLI and pasting output back in. This is deliberately not a bundled VLM: instead of Verdict shipping its own model to judge subjective calls, it hands its deterministic findings to whatever agent already has the reasoning and context. See `mcp-server/README.md`.

## What's honestly not built yet

This is v0.3. Score history, regression gating, visual diffing, multi-page crawling, the browser extension, and the MCP server are real and tested (`test/` -- 8 automated tests against actually-rendered fixtures, none mocked; the MCP server additionally verified end-to-end over the real JSON-RPC protocol against the same fixtures). Still not built: a hosted dashboard. That's the natural next step -- not implemented, not claimed as implemented.

## License

MIT
