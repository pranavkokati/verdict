#!/usr/bin/env node
/**
 * verdict-mcp: exposes Verdict's design-QA engine as MCP tools.
 *
 * This is the answer to "how does Verdict handle judgment calls a
 * deterministic rule can't make" that doesn't involve running a model of
 * its own. Verdict runs the same objective checks it always has
 * (contrast, type scale, spacing grid, heading/landmark hierarchy, plus
 * cross-page consistency and multi-viewport structural integrity) and
 * hands the structured result straight to whatever agent is already in
 * the loop -- Claude Code, Cursor, or anything else that speaks MCP --
 * instead of loading a separate VLM to second-guess it. The agent that
 * wrote the UI (or is about to) already has the visual/contextual
 * reasoning; Verdict's job is to hand it ground truth, not to duplicate it.
 *
 * Six tools:
 *   verdict_check     -- render one target, return score + full issue list
 *   verdict_diff       -- render two targets, return score delta + fixed/introduced/persisting issues
 *   verdict_crawl      -- render several targets, return a per-page + aggregate summary, including
 *                         a cross-page design-system consistency comparison when 2+ targets are given
 *   verdict_fix        -- render one target, auto-patch every safely-fixable issue via CDP, return
 *                         before/after scores plus what still needs the agent's own attention
 *   verdict_viewport    -- render one target at multiple viewport widths, return overflow /
 *                         tap-target / structural-parity issues that only exist across breakpoints
 *   verdict_states      -- force every interactive element through :hover, :focus-visible, and
 *                         :active via CDP's CSS.forcePseudoState, and flag missing focus indicators
 *                         (WCAG 2.4.7) and contrast regressions that only appear on interaction --
 *                         states no snapshot-based check (this project's own included, before now)
 *                         ever renders into.
 *
 * Each wraps the exact same library functions the CLI calls
 * (../../dist/index.js) -- there is no separate MCP-specific scoring path.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  check,
  crawl,
  closeBrowser,
  renderAndExtract,
  scoreSnapshot,
  diffScreenshots,
  diffResults,
  toFixListJson,
  fixTarget,
  checkViewports,
  parseViewportList,
  checkInteractionStates,
} from "../../dist/index.js";

const server = new Server(
  { name: "verdict-mcp", version: "0.3.1" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "verdict_check",
    description:
      "Renders a target (local file path, dev server URL, or live URL) in a real headless browser and runs Verdict's four deterministic design checks: WCAG 2.1 color contrast, type-scale consistency, spacing-grid consistency, and heading/landmark hierarchy. Returns a 0-100 score, pass/fail against a threshold, and every issue with its selector, measured value, required value, and a concrete suggested fix. Use this after generating or editing a UI to verify the actual rendered result instead of trusting the prompt that produced it.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Local file path, dev server URL, or live URL to render and check." },
        threshold: { type: "number", description: "Minimum passing score, 0-100. Defaults to 80." },
      },
      required: ["target"],
    },
  },
  {
    name: "verdict_diff",
    description:
      "Renders two targets (typically the same page before and after an edit) and returns the score delta, a pixel-level screenshot diff ratio, and which issues were fixed, introduced, or still persisting between the two renders. Use this to verify a claimed design improvement is real and to see exactly what changed, rather than taking 'I improved it' on faith.",
    inputSchema: {
      type: "object",
      properties: {
        before: { type: "string", description: "Local file path or URL for the 'before' render." },
        after: { type: "string", description: "Local file path or URL for the 'after' render." },
        threshold: { type: "number", description: "Minimum passing score, 0-100. Defaults to 80." },
      },
      required: ["before", "after"],
    },
  },
  {
    name: "verdict_crawl",
    description:
      "Runs verdict_check against several targets in one call and returns a per-page breakdown plus an aggregate average score and pass/fail. When 2+ targets are given, also compares recurring components (headings, paragraphs, buttons, spacing base unit) across every page and flags drift -- e.g. an <h1> that's 32px on the homepage but 28px on the about page, or a '.btn-primary' rendering as two different blues on two pages -- something none of the single-page checks, and no other design-QA tool, can see. The aggregate pass/fail reflects this: a crawl only passes if every page passes, every target actually rendered, AND the pages agree with each other. A target that fails to render (bad path, unreachable URL) is isolated into a separate `errors` array rather than aborting the whole call -- the other targets' results are still returned. Use this to verify a whole site or a set of routes at once instead of one page at a time.",
    inputSchema: {
      type: "object",
      properties: {
        targets: { type: "array", items: { type: "string" }, description: "Local file paths or URLs to check." },
        threshold: { type: "number", description: "Minimum passing score per page, 0-100. Defaults to 80." },
        consistency: {
          type: "boolean",
          description: "Whether to run the cross-page consistency comparison. Defaults to true when 2+ targets are given.",
        },
      },
      required: ["targets"],
    },
  },
  {
    name: "verdict_fix",
    description:
      "Renders a target, detects every contrast/type-scale/spacing-grid issue, and auto-patches each one directly in the source HTML using Chrome's own cascade engine (via the CDP CSS/DOM domains) to find and edit the exact declaration responsible for the offending computed style -- not a hand-rolled CSS parser, and not a guess. Every patch is verified against the original source text before being applied; anything that can't be verified is skipped and reported, not silently forced. Heading/landmark/alt-text issues (missing <h1>, skipped heading levels, missing <main>, missing alt text) are never auto-fixed -- those need generated content or a structural decision, so they come back in `unfixable` for the agent to handle directly. Returns before/after scores (the 'after' score comes from an independent re-check of the written file, not just the patcher's own claim), exactly what was applied and how, and what still needs attention. Use this to close the loop yourself instead of just reading Verdict's fix-list and hand-editing each one.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Local file path or URL to render, check, and patch." },
        threshold: { type: "number", description: "Minimum passing score, 0-100. Defaults to 80." },
        out: {
          type: "string",
          description: 'Output path for the patched HTML. Defaults to "<name>.fixed.html" next to the input; required (and must be set) for URL targets.',
        },
        write: { type: "boolean", description: "Overwrite the input file in place instead of writing a new file. Only valid for local file targets." },
      },
      required: ["target"],
    },
  },
  {
    name: "verdict_viewport",
    description:
      "Renders a single target at multiple viewport widths (default: mobile 375x812, tablet 768x1024, desktop 1440x900) and flags structural breakage that only exists across breakpoints -- something none of Verdict's single-page checks and no other design-QA tool (including axe-core, which audits one DOM snapshot) can see. Three categories: horizontal overflow (an element extending past the viewport's right edge, forcing an unwanted scrollbar), undersized tap targets (<a>/<button> under 44x44px at mobile widths, below the WCAG 2.5.5 minimum), and structural presence parity (a heading or landmark present at one viewport but missing at another, usually meaning responsive CSS hid it entirely rather than just re-laying it out). Scored 0-100 with the same scoring model as verdict_check. Use this after any responsive-layout change, or whenever an agent generates a page and you want confidence it actually works at more than the one viewport it was eyeballed at.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Local file path or URL to render at each viewport." },
        threshold: { type: "number", description: "Minimum passing score, 0-100. Defaults to 80." },
        viewports: {
          type: "string",
          description: 'Comma-separated "WIDTHxHEIGHT" list, e.g. "375x812,768x1024,1440x900". Overrides the three defaults if given.',
        },
      },
      required: ["target"],
    },
  },
  {
    name: "verdict_states",
    description:
      "Renders a target, then forces every interactive element (link, button, input, select, textarea -- up to maxElements, default 40) through :hover, :focus-visible, and :active using Chrome DevTools Protocol's CSS.forcePseudoState -- the same mechanism behind DevTools' own 'Force element state' checkboxes -- and recomputes real contrast ratios and visual deltas in each state. Flags two categories no snapshot-based check (including this project's own verdict_check, and every other design-QA/accessibility tool surveyed, including axe-core) can see because they only ever evaluate a page in its resting state: (1) missing focus indicators -- an element that looks pixel-identical whether or not it has keyboard focus, a WCAG 2.4.7 failure that leaves keyboard/screen-reader users with no way to tell where they are; (2) hover/active contrast regressions -- a button whose resting-state text/background passes AA but whose :hover or :active background change (with unchanged text color) drops below the WCAG minimum. Returns a 0-100 score via the same scoring model as verdict_check, elementsChecked, and every issue with its selector, the state it was caught in, measured/required contrast, and a suggested fix. Use this after any interactive-element styling change, or whenever you want confidence a button/link/input isn't silently broken the moment a real user's mouse or keyboard actually touches it.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Local file path or URL to render and force through interaction states." },
        threshold: { type: "number", description: "Minimum passing score, 0-100. Defaults to 80." },
        maxElements: { type: "number", description: "Cap on how many interactive elements to force-test, bounding runtime on pages with many links. Defaults to 40." },
      },
      required: ["target"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

/**
 * The `inputSchema` on each tool definition above is advertised to the MCP
 * client for its own guidance, but nothing in this SDK enforces it against
 * an actual call -- the handlers below previously just `as`-cast `args`
 * straight into the library functions with zero runtime check. That's a
 * real gap specifically *because* the caller here is an LLM-driven agent,
 * exactly the kind of caller most likely to pass a plausible-but-wrong
 * shape (e.g. a single string for `targets` instead of a one-element
 * array). Concretely: `crawl()` does `for (const target of targets)`, and
 * `for...of` over a string iterates it character-by-character with no
 * error -- so a string `targets` silently turned into a batch of
 * single-character "targets," each failing individually, with no clear
 * indication of what actually went wrong. These small checks turn that
 * into one clear, actionable error instead.
 */
function requireString(args: unknown, key: string): string {
  const value = (args as Record<string, unknown> | null | undefined)?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`"${key}" must be a non-empty string, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function requireStringArray(args: unknown, key: string): string[] {
  const value = (args as Record<string, unknown> | null | undefined)?.[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string")) {
    throw new Error(`"${key}" must be a non-empty array of strings, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function optionalNumber(args: unknown, key: string): number | undefined {
  const value = (args as Record<string, unknown> | null | undefined)?.[key];
  if (value === undefined) return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`"${key}" must be a number, got ${JSON.stringify(value)}.`);
  }
  return n;
}

function optionalBoolean(args: unknown, key: string): boolean | undefined {
  const value = (args as Record<string, unknown> | null | undefined)?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`"${key}" must be a boolean, got ${JSON.stringify(value)}.`);
  }
  return value;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "verdict_check") {
      const target = requireString(args, "target");
      const threshold = optionalNumber(args, "threshold");
      const result = await check(target, { threshold });
      return { content: [{ type: "text", text: JSON.stringify(toFixListJson(result), null, 2) }] };
    }

    if (name === "verdict_diff") {
      const before = requireString(args, "before");
      const after = requireString(args, "after");
      const threshold = optionalNumber(args, "threshold");
      const beforeSnap = await renderAndExtract(before);
      const afterSnap = await renderAndExtract(after);
      const beforeResult = scoreSnapshot(before, beforeSnap, threshold ?? 80);
      const afterResult = scoreSnapshot(after, afterSnap, threshold ?? 80);
      const pixel = diffScreenshots(beforeSnap.screenshotPng, afterSnap.screenshotPng);
      const delta = diffResults(beforeResult, afterResult);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                before: { target: before, score: beforeResult.score },
                after: { target: after, score: afterResult.score },
                scoreDelta: delta.scoreDelta,
                improved: delta.improved,
                regressed: delta.regressed,
                pixelsChangedRatio: pixel.diffRatio,
                issues: {
                  fixed: delta.issues.fixed.map((i) => i.message),
                  introduced: delta.issues.introduced.map((i) => i.message),
                  persisting: delta.issues.persisting.map((i) => i.message),
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "verdict_crawl") {
      const targets = requireStringArray(args, "targets");
      const threshold = optionalNumber(args, "threshold");
      const consistency = optionalBoolean(args, "consistency");
      const { summary } = await crawl(targets, { threshold, consistency });
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }

    if (name === "verdict_fix") {
      const target = requireString(args, "target");
      const threshold = optionalNumber(args, "threshold");
      const out = (args as Record<string, unknown> | null | undefined)?.out;
      if (out !== undefined && typeof out !== "string") {
        throw new Error(`"out" must be a string, got ${JSON.stringify(out)}.`);
      }
      const write = optionalBoolean(args, "write");
      const result = await fixTarget(target, { threshold, out: out as string | undefined, write });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                target: result.target,
                outPath: result.outPath,
                before: { score: result.before.score, passed: result.before.passed },
                after: result.after ? { score: result.after.score, passed: result.after.passed } : null,
                applied: result.applied.map((a) => ({ selector: a.selector, property: a.property, value: a.value, method: a.method })),
                skipped: result.skipped.map((s) => ({ selector: s.selector, property: s.property, reason: s.reason })),
                unfixable: result.unfixable.map((u) => ({
                  checkId: u.checkId,
                  severity: u.severity,
                  message: u.message,
                  selector: u.selector,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "verdict_viewport") {
      const target = requireString(args, "target");
      const threshold = optionalNumber(args, "threshold");
      const viewportsArg = (args as Record<string, unknown> | null | undefined)?.viewports;
      if (viewportsArg !== undefined && typeof viewportsArg !== "string") {
        throw new Error(`"viewports" must be a comma-separated string like "375x812,768x1024", got ${JSON.stringify(viewportsArg)}.`);
      }
      const result = await checkViewports(target, {
        threshold,
        viewports: viewportsArg ? parseViewportList(viewportsArg as string) : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "verdict_states") {
      const target = requireString(args, "target");
      const threshold = optionalNumber(args, "threshold");
      const maxElements = optionalNumber(args, "maxElements");
      const result = await checkInteractionStates(target, { threshold, maxElements });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Verdict error: ${message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
