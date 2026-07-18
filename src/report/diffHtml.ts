import type { VerdictResult, Issue } from "../types.js";
import type { PixelDiffResult } from "../diff/pixelDiff.js";
import type { ResultDiff } from "../diff/scoreDiff.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function deltaColor(n: number): string {
  return n > 0 ? "#16a34a" : n < 0 ? "#dc2626" : "#64748b";
}

function issueRow(issue: Issue, tag: "fixed" | "introduced" | "persisting"): string {
  const tagColor = tag === "fixed" ? "#16a34a" : tag === "introduced" ? "#dc2626" : "#64748b";
  return `<li><span class="tag" style="background:${tagColor}">${tag}</span> <span class="msg">${esc(issue.message)}</span>${issue.selector ? ` <code>${esc(issue.selector)}</code>` : ""}</li>`;
}

export interface DiffReportInput {
  before: VerdictResult;
  after: VerdictResult;
  diff: ResultDiff;
  pixelDiff: PixelDiffResult;
}

/**
 * Self-contained before/after HTML diff report: two screenshots, a pixel
 * diff overlay, score delta, per-check delta, and a fixed/introduced/
 * persisting issue breakdown. This is the artifact you'd attach to a PR
 * to prove a redesign actually improved things instead of just looking
 * different.
 */
export function renderDiffReport(input: DiffReportInput): string {
  const { before, after, diff, pixelDiff } = input;
  const beforeB64 = before.screenshotPng.toString("base64");
  const afterB64 = after.screenshotPng.toString("base64");
  const diffB64 = pixelDiff.diffPng.toString("base64");
  const deltaSign = diff.scoreDelta > 0 ? "+" : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Verdict diff -- ${esc(before.target)} vs ${esc(after.target)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
  header { padding: 28px 40px; background: #0f172a; color: white; }
  header p { margin: 0; }
  .delta { font-size: 32px; font-weight: 700; color: ${deltaColor(diff.scoreDelta)}; }
  main { max-width: 1100px; margin: 0 auto; padding: 32px 40px 80px; }
  .images { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 32px; }
  .images figure { margin: 0; background: white; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; }
  .images img { width: 100%; display: block; }
  .images figcaption { padding: 8px 12px; font-size: 12px; color: #64748b; border-top: 1px solid #f1f5f9; }
  table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; margin-bottom: 32px; }
  th, td { text-align: left; padding: 10px 16px; font-size: 13px; border-bottom: 1px solid #f1f5f9; }
  th { background: #f8fafc; color: #64748b; font-weight: 600; }
  .issues { background: white; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px 24px; }
  .issues ul { list-style: none; margin: 0; padding: 0; }
  .issues li { padding: 8px 0; border-top: 1px solid #f1f5f9; font-size: 13px; }
  .tag { color: white; font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; }
  code { background: #f1f5f9; padding: 1px 6px; border-radius: 4px; font-size: 12px; color: #475569; }
  .note { color: #92400e; background: #fffbeb; border: 1px solid #fde68a; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 24px; }
</style>
</head>
<body>
<header>
  <p style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Verdict Diff Report</p>
  <p style="font-size:16px;font-weight:600;margin-top:4px;">${esc(before.target)} &rarr; ${esc(after.target)}</p>
  <p style="margin-top:12px;" class="delta">${before.score} &rarr; ${after.score} (${deltaSign}${diff.scoreDelta})</p>
</header>
<main>
  ${pixelDiff.dimensionsMismatched ? `<p class="note">Screenshots were different sizes (content length changed) -- pixel diff is computed over the overlapping top-left region only.</p>` : ""}
  <div class="images">
    <figure><img src="data:image/png;base64,${beforeB64}" alt="before" /><figcaption>Before</figcaption></figure>
    <figure><img src="data:image/png;base64,${afterB64}" alt="after" /><figcaption>After</figcaption></figure>
    <figure><img src="data:image/png;base64,${diffB64}" alt="diff" /><figcaption>Diff -- ${(pixelDiff.diffRatio * 100).toFixed(1)}% of pixels changed</figcaption></figure>
  </div>
  <table>
    <thead><tr><th>Check</th><th>Before</th><th>After</th><th>Issue count</th></tr></thead>
    <tbody>
      ${diff.checks
        .map(
          (c) => `<tr>
        <td>${esc(c.name)}</td>
        <td>${c.beforePassed ? "PASS" : "FAIL"}</td>
        <td>${c.afterPassed ? "PASS" : "FAIL"}</td>
        <td style="color:${deltaColor(c.beforeIssueCount - c.afterIssueCount)}">${c.beforeIssueCount} &rarr; ${c.afterIssueCount}</td>
      </tr>`,
        )
        .join("")}
    </tbody>
  </table>
  <div class="issues">
    <h3 style="margin-top:0;">Issue changes</h3>
    <ul>
      ${diff.issues.fixed.map((i) => issueRow(i, "fixed")).join("")}
      ${diff.issues.introduced.map((i) => issueRow(i, "introduced")).join("")}
      ${diff.issues.persisting.map((i) => issueRow(i, "persisting")).join("")}
    </ul>
    ${diff.issues.fixed.length + diff.issues.introduced.length + diff.issues.persisting.length === 0 ? "<p>No issues on either side.</p>" : ""}
  </div>
</main>
</body>
</html>`;
}
