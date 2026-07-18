#!/usr/bin/env node
/**
 * verdict-mcp: exposes Verdict's design-QA engine as MCP tools.
 *
 * This is the answer to "how does Verdict handle judgment calls a
 * deterministic rule can't make" that doesn't involve running a model of
 * its own. Verdict runs the same four objective checks it always has
 * (contrast, type scale, spacing grid, heading/landmark hierarchy) and
 * hands the structured result straight to whatever agent is already in
 * the loop -- Claude Code, Cursor, or anything else that speaks MCP --
 * instead of loading a separate VLM to second-guess it. The agent that
 * wrote the UI (or is about to) already has the visual/contextual
 * reasoning; Verdict's job is to hand it ground truth, not to duplicate it.
 *
 * Three tools:
 *   verdict_check  -- render one target, return score + full issue list
 *   verdict_diff    -- render two targets, return score delta + fixed/introduced/persisting issues
 *   verdict_crawl   -- render several targets, return a per-page + aggregate summary
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
} from "../../dist/index.js";

const server = new Server(
  { name: "verdict-mcp", version: "0.1.0" },
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
      "Runs verdict_check against several targets in one call and returns a per-page breakdown plus an aggregate average score and pass/fail. Use this to verify a whole site or a set of routes at once instead of one page at a time.",
    inputSchema: {
      type: "object",
      properties: {
        targets: { type: "array", items: { type: "string" }, description: "Local file paths or URLs to check." },
        threshold: { type: "number", description: "Minimum passing score per page, 0-100. Defaults to 80." },
      },
      required: ["targets"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "verdict_check") {
      const { target, threshold } = args as { target: string; threshold?: number };
      const result = await check(target, { threshold });
      return { content: [{ type: "text", text: JSON.stringify(toFixListJson(result), null, 2) }] };
    }

    if (name === "verdict_diff") {
      const { before, after, threshold } = args as { before: string; after: string; threshold?: number };
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
      const { targets, threshold } = args as { targets: string[]; threshold?: number };
      const { summary } = await crawl(targets, { threshold });
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
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
