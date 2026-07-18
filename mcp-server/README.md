# verdict-mcp

MCP server exposing Verdict's design-QA engine as tools for a coding agent: `verdict_check`, `verdict_diff`, `verdict_crawl`. Same engine the CLI uses -- this is a thin MCP wrapper around `../dist/index.js`, not a separate implementation.

## Why this exists instead of a built-in aesthetic-critique model

Verdict's four checks (contrast, type scale, spacing grid, heading/landmark hierarchy) are deterministic. For anything beyond what a deterministic rule can decide -- does this hierarchy read well, is this the right fix given the rest of the page -- the honest options are either bundle a vision-language model into Verdict, or hand the structured findings straight to whatever agent is already in the loop and already has that reasoning capability. This package is the second option: it puts `verdict_check`/`verdict_diff`/`verdict_crawl` directly in an agent's tool list over MCP, so the agent calls Verdict itself mid-task instead of a human running the CLI and pasting output back in. No extra model, no extra weights, no extra latency beyond the render.

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

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `verdict_check` | `target` (path or URL), `threshold?` | score, pass/fail, full issue list with selector/measured/required/fix |
| `verdict_diff` | `before`, `after`, `threshold?` | score delta, pixel-diff ratio, fixed/introduced/persisting issues |
| `verdict_crawl` | `targets[]`, `threshold?` | per-target scores + aggregate pass/fail |

Verified against the repo's own test fixtures: `verdict_check` on `test/fixtures/bad.html` returns score 50 with 27 issues over the real MCP JSON-RPC protocol, matching the CLI's output for the same file exactly.
