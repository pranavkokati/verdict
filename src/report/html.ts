import type { CheckResult, Issue, VerdictResult } from "../types.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function severityColor(sev: Issue["severity"]): string {
  return sev === "error" ? "#dc2626" : sev === "warning" ? "#d97706" : "#2563eb";
}

function scoreColor(score: number): string {
  if (score >= 90) return "#16a34a";
  if (score >= 80) return "#65a30d";
  if (score >= 60) return "#d97706";
  return "#dc2626";
}

function renderIssue(issue: Issue): string {
  return `
    <li class="issue issue-${issue.severity}">
      <span class="badge" style="background:${severityColor(issue.severity)}">${issue.severity}</span>
      <div class="issue-body">
        <p class="issue-message">${esc(issue.message)}</p>
        ${issue.selector ? `<code class="issue-selector">${esc(issue.selector)}</code>` : ""}
        ${
          issue.measured && issue.required
            ? `<p class="issue-meta">measured <strong>${esc(issue.measured)}</strong> -- required <strong>${esc(issue.required)}</strong></p>`
            : ""
        }
        ${issue.suggestedFix ? `<p class="issue-fix">fix: ${esc(issue.suggestedFix)}</p>` : ""}
      </div>
    </li>`;
}

function renderCheck(check: CheckResult): string {
  const status = check.passed ? "pass" : "fail";
  return `
  <section class="check">
    <div class="check-header">
      <h3>${esc(check.name)} <span class="status status-${status}">${status.toUpperCase()}</span></h3>
      <p class="check-desc">${esc(check.description)}</p>
    </div>
    ${
      check.issues.length > 0
        ? `<ul class="issue-list">${check.issues.map(renderIssue).join("")}</ul>`
        : `<p class="clean">No issues found.</p>`
    }
  </section>`;
}

/**
 * Renders a single, self-contained HTML report -- no server, no external
 * assets, no CDN dependency. Opens directly from disk in any browser.
 * The screenshot is embedded as a base64 data URI.
 */
export function renderHtmlReport(result: VerdictResult): string {
  const screenshotB64 = result.screenshotPng.toString("base64");
  const errorCount = result.issues.filter((i) => i.severity === "error").length;
  const warningCount = result.issues.filter((i) => i.severity === "warning").length;
  const infoCount = result.issues.filter((i) => i.severity === "info").length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Verdict report -- ${esc(result.target)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    margin: 0; background: #f8fafc; color: #0f172a; line-height: 1.5;
  }
  header {
    padding: 32px 40px; background: #0f172a; color: white;
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 24px;
  }
  header .title { font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase; color: #94a3b8; margin: 0 0 4px; }
  header .target { font-size: 18px; font-weight: 600; margin: 0; word-break: break-all; }
  .score-badge {
    display: flex; align-items: center; gap: 16px;
  }
  .score-circle {
    width: 88px; height: 88px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    font-size: 28px; font-weight: 700; color: white; flex-shrink: 0;
  }
  .verdict-pass { color: #4ade80; font-weight: 600; }
  .verdict-fail { color: #f87171; font-weight: 600; }
  main { max-width: 1000px; margin: 0 auto; padding: 32px 40px 80px; }
  .summary-row { display: flex; gap: 16px; margin-bottom: 32px; flex-wrap: wrap; }
  .summary-card { background: white; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 20px; flex: 1; min-width: 140px; }
  .summary-card .n { font-size: 24px; font-weight: 700; }
  .summary-card .l { font-size: 13px; color: #64748b; }
  .screenshot-wrap { background: white; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; margin-bottom: 32px; }
  .screenshot-wrap img { width: 100%; display: block; }
  .check { background: white; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px 24px; margin-bottom: 16px; }
  .check-header h3 { margin: 0 0 4px; font-size: 16px; display: flex; align-items: center; gap: 10px; }
  .check-desc { margin: 0 0 12px; color: #64748b; font-size: 13px; }
  .status { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 700; letter-spacing: 0.04em; }
  .status-pass { background: #dcfce7; color: #166534; }
  .status-fail { background: #fee2e2; color: #991b1b; }
  .issue-list { list-style: none; margin: 0; padding: 0; }
  .issue { display: flex; gap: 12px; padding: 12px 0; border-top: 1px solid #f1f5f9; }
  .badge { color: white; font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; height: fit-content; flex-shrink: 0; }
  .issue-message { margin: 0 0 4px; font-size: 14px; }
  .issue-selector { background: #f1f5f9; padding: 1px 6px; border-radius: 4px; font-size: 12px; color: #475569; }
  .issue-meta { margin: 4px 0 0; font-size: 12px; color: #64748b; }
  .issue-fix { margin: 4px 0 0; font-size: 13px; color: #0f766e; background: #f0fdfa; padding: 6px 10px; border-radius: 6px; }
  .clean { color: #16a34a; font-size: 14px; margin: 0; }
  footer { text-align: center; color: #94a3b8; font-size: 12px; padding: 24px; }
</style>
</head>
<body>
<header>
  <div>
    <p class="title">Verdict Design QA Report</p>
    <p class="target">${esc(result.target)}</p>
    <p style="margin:6px 0 0;color:#cbd5e1;font-size:13px;">${new Date(result.timestamp).toLocaleString()}</p>
  </div>
  <div class="score-badge">
    <div>
      <div class="${result.passed ? "verdict-pass" : "verdict-fail"}">${result.passed ? "PASS" : "FAIL"}</div>
      <div style="color:#94a3b8;font-size:12px;">threshold ${result.threshold}</div>
    </div>
    <div class="score-circle" style="background:${scoreColor(result.score)}">${result.score}</div>
  </div>
</header>
<main>
  <div class="summary-row">
    <div class="summary-card"><div class="n" style="color:${severityColor("error")}">${errorCount}</div><div class="l">errors</div></div>
    <div class="summary-card"><div class="n" style="color:${severityColor("warning")}">${warningCount}</div><div class="l">warnings</div></div>
    <div class="summary-card"><div class="n" style="color:${severityColor("info")}">${infoCount}</div><div class="l">info</div></div>
    <div class="summary-card"><div class="n">${result.checks.length}</div><div class="l">checks run</div></div>
  </div>
  <div class="screenshot-wrap">
    <img src="data:image/png;base64,${screenshotB64}" alt="Full-page screenshot of ${esc(result.target)}" />
  </div>
  ${result.checks.map(renderCheck).join("")}
</main>
<footer>Generated by Verdict -- design QA for AI-generated interfaces.</footer>
</body>
</html>`;
}
