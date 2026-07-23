# verdict-mcp

MCP server exposing Verdict's design-QA engine as tools for a coding agent: `verdict_check`, `verdict_diff`, `verdict_crawl`, `verdict_fix`, `verdict_viewport`, `verdict_states`. Same engine the CLI uses -- this is a thin MCP wrapper around `../dist/index.js`, not a separate implementation.

## Why this exists instead of a built-in aesthetic-critique model

Verdict's checks (contrast, type scale, spacing grid, heading/landmark hierarchy, cross-page consistency, multi-viewport structural integrity, forced-interaction-state contrast/focus) are deterministic. For anything beyond what a deterministic rule can decide -- does this hierarchy read well, is this the right fix given the rest of the page -- the honest options are either bundle a vision-language model into Verdict, or hand the structured findings straight to whatever agent is already in the loop and already has that reasoning capability. This package is the second option: it puts every Verdict capability directly in an agent's tool list over MCP, so the agent calls Verdict itself mid-task -- checks a render, auto-fixes what's safely fixable, crawls a whole site for cross-page drift, sweeps a page across viewports, forces every button through :hover/:focus-visible/:active -- instead of a human running the CLI and pasting output back in. No extra model, no extra weights, no extra latency beyond the render.

## Build

From the repo root:

```bash
npm install && npm run build      # builds the main library to dist/
cd mcp-server
npm install && npm run build      # builds verdict-mcp, which imports ../dist/index.js
```

## Wire it into an MCP client

Claude Code / Claude Desktop (`.mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "verdict": {
      "command": "node",
      "args": ["/absolute/path/to/verdict/mcp-server/dist/server.js"]
    }
  }
}
```

Any other MCP-compatible agent: point it at the same stdio command.

## Input validation

The `inputSchema` on each tool definition is advertised to the MCP client for its own guidance, but nothing in the SDK enforces it against an actual call. Every handler validates its arguments at runtime before touching the library (`requireString`, `requireStringArray`, `optionalNumber`, `optionalBoolean` in `src/server.ts`) and returns one clear error message on a bad shape, rather than passing malformed input straight through. This matters specifically because the caller here is an LLM-driven agent -- exactly the kind of caller most likely to pass a plausible-but-wrong shape. Concretely: `crawl()` does `for (const target of targets)`, and `for...of` over a JS string iterates it character-by-character with no error, so passing a single string for `verdict_crawl`'s `targets` (instead of a one-element array) used to silently turn into a batch of single-character "targets" instead of a clear validation error. Covered by `test/validation.test.mjs` (`npm test`), which spawns the real built server and exercises this over real stdio JSON-RPC.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `verdict_check` | `target` (path or URL), `threshold?` | score, pass/fail, full issue list with selector/measured/required/fix |
| `verdict_diff` | `before`, `after`, `threshold?` | score delta, pixel-diff ratio, fixed/introduced/persisting issues |
| `verdict_crawl` | `targets[]`, `threshold?`, `consistency?` | per-target scores + aggregate pass/fail; with 2+ targets, also a cross-page consistency comparison (drift findings, `allPassed` reflects it). A target that fails to render is isolated into a separate `errors[]` array instead of aborting the whole call -- the other targets' results are still returned, and `allPassed` is `false` whenever `errors` is non-empty. |
| `verdict_fix` | `target`, `threshold?`, `out?`, `write?` | before/after scores (after = independent re-check of the written file), exactly what was applied/skipped, and which issues still need the agent's own attention |
| `verdict_viewport` | `target`, `threshold?`, `viewports?` (`"375x812,768x1024"` etc.) | score, pass/fail, and overflow/tap-target/structural-parity issues across the tested viewport widths |
| `verdict_states` | `target`, `threshold?`, `maxElements?` (default 40) | score, pass/fail, `elementsChecked`, and issues for missing `:focus-visible` indicators (WCAG 2.4.7) and `:hover`/`:active` contrast regressions -- forced via CDP's `CSS.forcePseudoState`, the mechanism behind DevTools' own "Force element state" checkboxes |

Verified against the repo's own test fixtures over the real MCP JSON-RPC protocol, matching the CLI's output for the same files exactly:

- `verdict_check` on `test/fixtures/bad.html` -- score 50, 27 issues.
- `verdict_fix` on `test/fixtures/bad.html` -- before 50, after 81, 23 applied, 4 unfixable (all `hierarchy`).
- `verdict_viewport` on `test/fixtures/viewport-bad.html` -- score 86, one issue each from `viewport-overflow`, `viewport-tap-target`, `viewport-structural`.
- `verdict_crawl` on the three `test/fixtures/site-*.html` pages -- `allPassed: false`, 2 consistency findings (the seeded `<h1>` size and `.btn-primary` color drift).
- `verdict_states` on `test/fixtures/states-bad.html` -- score 86, 2 elements checked, 2 errors (missing focus indicator on `.no-focus-btn`, hover-contrast collapse on `.bad-hover-btn`); on `test/fixtures/states-good.html` -- score 100, 0 issues.

## Dependency security

`npm audit` against this package's transitive dependencies (all pulled in via `@modelcontextprotocol/sdk`) as of this writing:

- **`fast-uri` (high, GHSA-v2hh-gcrm-f6hx, host confusion via a literal backslash authority delimiter)** -- a transitive dependency of `ajv`, which the SDK uses for tool-input schema validation. Fixed: `npm audit fix` resolves it as a non-breaking patch bump (`fast-uri` 3.1.3 -> 3.1.4), no SDK downgrade required. Applied here; re-verified with the full test suite and a live JSON-RPC run against all six tools afterward -- no behavior change.
- **`@hono/node-server` (moderate, GHSA-frvp-7c67-39w9, Windows-only path traversal in `serve-static`)** -- a transitive dependency of the SDK's optional Streamable-HTTP transport. `npm audit fix --force` would resolve it, but only by downgrading `@modelcontextprotocol/sdk` to `1.24.3` (from `1.29.0`), which is a real regression, not a clean fix. **Left unfixed, deliberately**: this server imports and calls only `StdioServerTransport` (`src/server.ts`) -- the HTTP transport, and the `serve-static` code path the CVE lives in, is never imported, never instantiated, and never reachable from any code this package runs. Re-evaluate if this package ever adds an HTTP transport, or when the SDK ships a release with an unaffected `@hono/node-server`.
