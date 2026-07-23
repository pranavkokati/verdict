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

## Why this exists, and how it's different from prompt-injection "taste" tools

Prompt-injection "taste" tools work by aggregating design-guideline prompt packs and injecting them into an agent's context before it writes UI code. That's a reasonable idea, but it's **open-loop**: the tool has no way to confirm the agent actually followed the guidance. You get a prompt; you don't get proof.

Verdict is **closed-loop**. It doesn't tell the agent what to do -- it checks what the agent actually did:

1. It renders the real, final HTML/CSS in headless Chromium via Playwright -- actual computed styles and layout boxes, not a static text/AST guess.
2. It runs four independently-scored checks against that render (below).
3. It emits a score, a pass/fail verdict against a configurable threshold, and a structured fix-list with the exact selector, the measured value, the required value, and a concrete fix -- formatted so you can paste it straight back into an agent's chat (`verdict check --agent`) and have it act on real, specific findings instead of vibes.
4. It doesn't stop at telling you what's wrong. `verdict fix` auto-patches every safely-fixable issue (contrast, type-scale, spacing-grid) directly in the source, using Chrome's own cascade engine via CDP to find and edit the exact CSS declaration responsible -- not a hand-rolled parser, and every edit is verified against the source before it's applied. Structural issues (missing `<h1>`, missing alt text) are never guessed at; they come back flagged for the agent to actually address.
5. It remembers. Every run appends to a local score history, so `verdict check` can gate a PR not just on an absolute threshold but on **regression vs. the last passing run** -- an agent that "fixes" the copy but quietly tanks contrast on a different element gets caught even if the absolute score still clears the bar.
6. It can compare two renders directly (`verdict diff before.html after.html`): pixel-level screenshot diff plus a fixed/introduced/persisting issue breakdown, so a redesign claim is something you can look at, not take on faith.
7. It scales past one page, in two directions that matter for a real product rather than a single landing page. `verdict crawl` checks a whole set of pages in one run, aggregates a single pass/fail, **and compares recurring components across every page** -- catching a `.btn-primary` that's a different blue on the pricing page, or an `<h1>` that's a different size on the about page, the kind of silent design-system drift no single-page check (and no version of axe-core) can see because it never looks at more than one page at a time.
8. It scales past one viewport. `verdict viewport` renders the same page at mobile/tablet/desktop widths and flags horizontal overflow, undersized mobile tap targets, and headings/landmarks that a breakpoint silently hides -- structural bugs that only exist once a layout actually has to respond, which a single fixed-viewport check (again, including axe-core) never exercises.
9. It checks states nobody else checks. Every check above -- this project's own prior checks, and every other design-QA/accessibility tool surveyed, including axe-core -- evaluates a page exactly as it happened to render: nobody hovering, nothing focused, nothing pressed. `verdict states` forces every interactive element through `:hover`, `:focus-visible`, and `:active` via Chrome DevTools Protocol's `CSS.forcePseudoState` (the same mechanism behind DevTools' own "Force element state" checkboxes) and flags two real, common bug classes that only exist in those states: missing focus indicators (WCAG 2.4.7 -- an element that looks identical whether or not it has keyboard focus) and hover/active contrast regressions (a button that passes AA at rest but drops below the WCAG minimum the moment its background changes on hover). This is a real state transition, not a snapshot, and as far as could be verified through direct research (not assumption), no other automated, CI-integrated, crawl-scale tool does this.

This makes the claim "the UI is good" -- and "the UI got better" -- falsifiable and CI-gateable, which a prompt injected into an agent's context never is.

## Checks

These four run against every single render and roll up into `verdict check`'s score:

| Check | What it verifies |
| --- | --- |
| **Color Contrast (WCAG 2.1)** | Real relative-luminance contrast ratio for every text node against its effective background. The background is resolved by alpha-compositing *every* containing element's background-color in paint order (outermost to innermost, including `<html>`/`<body>` themselves) onto an opaque white canvas -- not just reading the nearest containing element's raw color -- so a semi-transparent overlay (a modal scrim, a translucent header) and a page background set directly on `<body>` (the standard way most dark-themed pages set theirs) are both resolved correctly instead of silently falling back to an assumed opaque white. Flags anything under the WCAG AA minimum (4.5:1 normal text, 3:1 large text) and computes a specific replacement hex color that would pass. |
| **Type Scale Consistency** | Collects every font-size in use and flags values that don't land on a clean type-scale step (evidence of unintentional em/rem drift) and pages using more distinct sizes than a coherent system typically needs. |
| **Spacing Grid Consistency** | Detects whether the page's margin/padding/gap values are drawn from a consistent 4px or 8px base unit -- the convention nearly every real design system uses -- and flags the values that break it. |
| **Heading & Landmark Hierarchy** | Exactly one `<h1>`, no skipped heading levels, presence of a `<main>` landmark, and `alt` text on every `<img>`. Visibility-aware: a heading or landmark hidden via `display:none`/`visibility:hidden` (or collapsed to zero size) is treated as absent, not present-but-invisible. |

Each check is real, deterministic code -- not an LLM call -- so results are reproducible and explainable.

Three more mechanisms go beyond a single resting-state snapshot of one page, and are scored the same 0-100 way via the same shared scoring function:

| Mechanism | What it verifies |
| --- | --- |
| **Cross-page consistency** (`verdict crawl`) | Compares recurring components -- headings by level, paragraphs and buttons by tag+class, the detected spacing base unit -- across every page in the crawl, and flags where a role that appears on 2+ pages doesn't render identically everywhere. |
| **Multi-viewport structural integrity** (`verdict viewport`) | Renders one target at multiple viewport widths and flags horizontal overflow, undersized mobile tap targets, and headings/landmarks present at one viewport but missing at another. |
| **Forced interaction-state testing** (`verdict states`) | Forces every interactive element through `:hover`, `:focus-visible`, and `:active` via CDP and flags missing focus indicators (WCAG 2.4.7) and hover/active contrast regressions -- bugs that live entirely in states a normal render never enters. |

See their own sections below. (A VLM-based aesthetic critique pass was considered and deliberately not built -- see "Why this exists" above for why an MCP integration was built instead.)

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

### `verdict fix`

```bash
verdict fix <target> [options]

Options:
  -o, --out <path>      output path for the fixed HTML                        (default "<name>.fixed.html")
  -w, --write           overwrite the input file in place instead of a new file
  -t, --threshold <n>   minimum score to pass, 0-100                          (default 80)
  --json                print only the JSON result to stdout
```

Detects every contrast/type-scale/spacing-grid issue and patches each one directly in the source, using Chrome's own cascade engine (the CDP `CSS`/`DOM` domains) to find the exact declaration responsible for the offending computed style. Every edit is verified against the original source text before it's applied -- if the matched stylesheet or element serialization doesn't appear verbatim in the source (e.g. a build step transformed it), the fix is skipped and reported, never guessed at. Heading/landmark/alt-text issues are never auto-fixed; they need generated content or a structural call, not a value swap.

```bash
verdict fix ./dist/index.html
──────────────────────────────────────────────────
  Verdict fix  50 -> 81  (+31)  23 fixed
──────────────────────────────────────────────────
  ✓ html > body > div.hero:nth-of-type(1) > h3  color -> #6e6e6e  (stylesheet-rule)
  ✓ html > body > div.hero:nth-of-type(1) > p  color -> #6d6d6d  (stylesheet-rule)
  ✓ html > body > div.card:nth-of-type(2)  color -> #757575  (stylesheet-rule)
  ✓ html > body > div.card:nth-of-type(2)  font-size -> 18px  (stylesheet-rule)
  ... 19 more
──────────────────────────────────────────────────
  4 issue(s) need manual/agent attention (not auto-fixable):
    - [error] No <h1> found. Every page needs exactly one top-level heading.
    - [warning] Heading level jumps from h3 to h5 ("Footer heading") -- skips h4.
    - [warning] No <main> landmark found.
    - [error] <img> at "html > body > div.footer:nth-of-type(3) > img" has no alt attribute.
──────────────────────────────────────────────────
  Written: ./dist/index.fixed.html
──────────────────────────────────────────────────
```

The `50 -> 81` isn't `verdict fix`'s own claim about itself -- the "after" score comes from an independent re-check of the file it just wrote, the same way `verdict diff` never trusts a claimed improvement without re-rendering both sides.

### `verdict crawl`

A real site has more than one page. `verdict crawl` runs the full check suite against several targets in one invocation, rolls them into an aggregate pass/fail, and -- with 2+ targets -- compares recurring components across every page for cross-page drift.

```bash
verdict crawl <targets...> [options]

Options:
  -o, --out <dir>       output directory for per-page reports + summary.json  (default ".verdict/crawl")
  -t, --threshold <n>   minimum score to pass, per page (0-100)                (default 80)
  --json                print only the JSON summary to stdout
  --no-history          don't append these runs to .verdict/crawl/history.jsonl
  --no-consistency      skip the cross-page design-system consistency comparison
```

```bash
verdict crawl ./dist/home.html ./dist/about.html ./dist/contact.html
────────────────────────────────────────────────────────
  Verdict crawl  3 page(s)  avg 100/100  SOME FAILED
────────────────────────────────────────────────────────
  ✓ 100  ./dist/home.html  (0 issues)
  ✓ 100  ./dist/about.html  (0 issues)
  ✓ 100  ./dist/contact.html  (0 issues)
────────────────────────────────────────────────────────
  ✗ Cross-page consistency  (2 drift issues across 3 shared roles)
    - "h1" fontSize is inconsistent across pages: 32px (2 pages) vs. 28px (1 page).
    - "a.btn-primary" backgroundColor is inconsistent across pages: rgb(0, 85, 255) (2 pages) vs. rgb(0, 68, 204) (1 page).
────────────────────────────────────────────────────────
  summary: .verdict/crawl/summary.json
────────────────────────────────────────────────────────
```

Every page here scores a perfect 100 on its own -- none of the four single-page checks has anything to flag. The crawl still fails, because the about page's `<h1>` and `.btn-primary` were hand-tuned instead of reusing the shared style, and cross-page consistency is the one check built specifically to catch exactly that. One failing page, or unresolved cross-page drift, fails the whole crawl (exit code `1`) -- so `verdict crawl` can gate a multi-page build the same way `verdict check` gates a single file. Each page still gets its own `report.html` in a slugified subdirectory.

**Scope, honestly stated:** the comparison only covers headings (by tag), paragraphs and buttons (by tag+class), and the detected spacing base unit -- not every element on the page, which would drown real findings in noise from one-off content. A role only counts as "shared" once it appears on 2+ of the crawled pages; anything unique to one page has nothing to be inconsistent with, so it's silently skipped rather than flagged.

**A target that fails to render doesn't take down the whole crawl.** A typo'd path, a URL that's temporarily down, a page that throws mid-extraction -- any single-target failure is isolated into a separate `errors` array in the summary (and printed as `✗ ERR  <target>  (<message>)` in the terminal output) instead of aborting the entire invocation. The other targets' results are still returned, `summary.targets` still reflects every target attempted, and `allPassed` is `false` whenever `errors` is non-empty -- an unrenderable page is never a silent pass.

### `verdict viewport`

```bash
verdict viewport <target> [options]

Options:
  -t, --threshold <n>   minimum score to pass, 0-100                          (default 80)
  --viewports <list>    comma-separated "WIDTHxHEIGHT" list, overrides the 3 defaults
  --json                print only the JSON result to stdout
```

Renders one target at multiple viewport widths (default: mobile 375x812, tablet 768x1024, desktop 1440x900) and flags structural breakage that only shows up once a layout has to respond to a different width -- something no single-render check, this project's own or anyone else's (including axe-core, which audits one DOM snapshot), can see.

```bash
verdict viewport ./dist/dashboard.html
────────────────────────────────────────────────────────
  Verdict viewport  86/100  (threshold 80)  PASS
  Tested: mobile (375x812), tablet (768x1024), desktop (1440x900)
────────────────────────────────────────────────────────
  ✗ Horizontal Overflow  (1 issue)
  ✗ Tap Target Size  (1 issue)
  ✗ Structural Presence Parity  (1 issue)
────────────────────────────────────────────────────────
  1 error(s), 2 warning(s)
────────────────────────────────────────────────────────
  [error] Horizontal overflow at mobile (375x812): "html > body > main > div.promo-banner" extends 149px past the right edge of the viewport, forcing an unwanted horizontal scrollbar.
  [warning] Tap target "html > body > main > button.icon-button" is 20x20px at mobile (375x812) -- below the 44x44px minimum for reliable touch interaction (WCAG 2.5.5).
  [warning] The <nav> landmark is present at tablet (768x1024), desktop (1440x900) but missing at mobile (375x812).
────────────────────────────────────────────────────────
```

Three categories, each a real structural failure mode rather than a style opinion:

- **Horizontal overflow** -- any element whose right edge extends past its viewport's right edge, detected directly from the already-captured bounding boxes (no extra rendering pass).
- **Undersized tap targets** -- `<a>`/`<button>` elements under 44x44px, checked only at mobile-width viewports (<= 480px), since that's what the guideline is actually for.
- **Structural presence parity** -- a heading (by text) or landmark (by tag) present at one viewport but missing at another, which usually means responsive CSS hid it entirely (a mobile nav drawer that removes `<nav>` rather than just re-styling it) instead of just re-laying it out.

### `verdict states`

```bash
verdict states <target> [options]

Options:
  -t, --threshold <n>      minimum score to pass, 0-100                          (default 80)
  -m, --max-elements <n>   cap on how many interactive elements to force-test    (default 40)
  --json                   print only the JSON result to stdout
```

Every check above -- this project's own included -- evaluates a page in exactly the state it happened to render in: nobody hovering, nothing focused, nothing pressed. `verdict states` forces every `<a>`/`<button>`/`<input>`/`<select>`/`<textarea>` through `:hover`, `:focus-visible`, and `:active` using Chrome DevTools Protocol's `CSS.forcePseudoState` -- the exact mechanism behind DevTools' own "Force element state" checkboxes -- and re-measures what only ever gets checked manually, one element at a time, industry-wide.

```bash
verdict states ./dist/index.html
────────────────────────────────────────────────────────
  Verdict states  86/100  (threshold 80)  PASS
  Forced :hover, :focus-visible, :active on 2 interactive element(s)
────────────────────────────────────────────────────────
  2 error(s), 0 warning(s)
────────────────────────────────────────────────────────
  [error] "html > body > button.no-focus-btn:nth-of-type(1)" has no visible change when it receives keyboard focus -- no outline, box-shadow, border, background, or text-color difference between resting and :focus-visible. A keyboard or screen-reader user has no way to tell it's focused.
  [error] "html > body > button.bad-hover-btn:nth-of-type(2)" drops to 1.14:1 contrast on :hover (below the WCAG AA minimum), even though its resting state may pass.
────────────────────────────────────────────────────────
```

Two categories, both real and both invisible to every check that only ever renders a page at rest:

- **Missing focus indicators** -- an element whose computed outline, box-shadow, border, background, and text color are all pixel-identical between its resting state and `:focus-visible`. A keyboard or screen-reader user tabbing through the page has no way to know where focus is.
- **Hover/active contrast regressions** -- a button whose resting-state text/background contrast clears WCAG AA, but whose `:hover` or `:active` background changes (with the text color left unchanged) drop the ratio below the AA minimum (4.5:1 normal text, 3:1 large text).

**Scope, honestly stated:** capped at `maxElements` (default 40) interactive elements to bound runtime -- each element needs several forced-state CDP round trips. This is a real state transition inspected via the browser's own rendering engine, not a heuristic guess at what `:hover` CSS "probably" does -- but it's still a bounded set of interactive tags, not every element that could theoretically have an interactive pseudo-class rule.

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
import { check, fixTarget, crawl, checkViewports, checkInteractionStates } from "verdict-ui";

const result = await check("http://localhost:3000", { threshold: 80 });
console.log(result.score, result.passed);
for (const issue of result.issues) {
  console.log(issue.severity, issue.message, issue.suggestedFix);
}

// Auto-patch what's safely fixable; re-checks the written file itself.
const fixed = await fixTarget("./dist/index.html", { threshold: 80 });
console.log(fixed.before.score, "->", fixed.after?.score, `(${fixed.applied.length} applied)`);

// Cross-page consistency, via crawl (2+ targets).
const { summary } = await crawl(["./dist/home.html", "./dist/about.html"], { threshold: 80 });
console.log(summary.allPassed, summary.consistency?.findings);

// Multi-viewport structural integrity.
const viewportResult = await checkViewports("./dist/index.html", { threshold: 80 });
console.log(viewportResult.score, viewportResult.issues);

// Forced :hover / :focus-visible / :active interaction-state testing.
const statesResult = await checkInteractionStates("./dist/index.html", { threshold: 80 });
console.log(statesResult.score, statesResult.elementsChecked, statesResult.issues);
```

## The report

`verdict check` writes a single, self-contained `report.html` -- no server, no CDN dependency, no external assets. It embeds the full-page screenshot and every issue with its selector, measured value, required value, and suggested fix. Open it directly from disk or attach it to a PR.

## CI

`.github/workflows/verdict.yml` in this repo is a copy-pasteable example: build your app, install a headless Chromium (`playwright install --with-deps` -- needs root, which GitHub-hosted runners have by default), cache `.verdict/` between runs so score history persists across PRs, run `verdict check` against the build output, and upload the report as a build artifact. The job fails the PR check on either an absolute score below threshold or a regression vs. the last passing run on `main`.

On unprivileged Linux containers (some self-hosted runners, some sandboxes) `playwright install-deps` will fail without root -- see the Install section above.

`.github/workflows/release.yml` publishes to npm automatically on a version tag (`git tag v0.5.1 && git push --tags`), gated behind the same test suite. Requires an `NPM_TOKEN` repo secret.

## Browser extension

`extension/` runs the same four single-page checks against whatever tab you have open, live, no CLI and no build output required. It's a direct, dependency-free port of `src/render/browser.ts` and `src/checks/*.ts` -- same constants and formulas, not a lighter reimplementation -- because those modules already had zero Node/Playwright dependency. (Cross-page consistency, multi-viewport, and forced interaction-state testing are CLI/MCP-only for now -- consistency and viewport need multiple renders under one orchestrator, and interaction-state testing needs a live CDP session, none of which map onto "check whatever single tab is open.") Load it unpacked from `chrome://extensions` (Developer mode -> Load unpacked -> select `extension/`). See `extension/README.md`.

## Agent integration (MCP)

`mcp-server/` exposes six MCP tools -- `verdict_check`, `verdict_diff`, `verdict_crawl` (including the cross-page consistency comparison), `verdict_fix`, `verdict_viewport`, and `verdict_states` -- so a coding agent -- Claude Code, Cursor, anything that speaks MCP -- can call Verdict directly mid-task instead of a human running the CLI and pasting output back in. This is deliberately not a bundled VLM: instead of Verdict shipping its own model to judge subjective calls, it hands its deterministic findings to whatever agent already has the reasoning and context. See `mcp-server/README.md`.

## What's honestly not built yet

This is v0.5.1. Score history, regression gating, visual diffing, multi-page crawling, cross-page consistency, multi-viewport structural integrity, forced interaction-state testing, auto-fix, the browser extension, and the MCP server are real and tested (`test/` -- 32 automated tests against actually-rendered fixtures, none mocked, plus 5 more in `mcp-server/test/` exercising the real MCP server over real JSON-RPC). Still not built: a hosted dashboard. That's the natural next step -- not implemented, not claimed as implemented.

v0.5.1 is a correctness/robustness pass, not a new-feature release, from two rounds of self-auditing the whole codebase for real bugs rather than taking any of it on faith:

- A background-resolution bug in the flagship contrast check: semi-transparent overlays and `<body>`-level backgrounds were both silently mishandled, in some cases producing a contrast ratio off by more than 10x (a genuinely-passing 3.98:1 or 15:1 reported as ~1:1).
- A data-corruption bug in `verdict fix`'s stylesheet patcher: a literal `$` in patched CSS could trigger JavaScript's special string-replacement patterns and silently mangle the output.
- Two browser-context leaks on render failure, a crawl that discarded every page's results the moment one target failed to render, and a history-file parser that discarded all prior score history on a single corrupted line.
- Two silent false-positive gaps found on a second pass: an empty `viewports` array reported a hollow 100/100 pass despite testing nothing, and a negative `--max-elements` silently dropped real candidates from `verdict states` (confirmed: it hid a real seeded bug from the report entirely). Both now fail loudly instead of failing silently.
- MCP tool-call input validation: the six tool handlers previously trusted the caller's argument shapes with zero runtime check. An LLM-driven caller passing a single string where `verdict_crawl`'s `targets` expects an array used to silently iterate the string character-by-character instead of erroring -- now every tool validates its arguments and returns one clear message instead.

Every fix above has a corresponding regression test asserting the specific bug is gone, not just that the change compiles.

## License

MIT
