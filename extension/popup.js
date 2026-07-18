const runBtn = document.getElementById("runBtn");
const emptyEl = document.getElementById("empty");
const errBox = document.getElementById("errbox");
const resultEl = document.getElementById("result");
const thresholdInput = document.getElementById("threshold");

let lastResult = null;

runBtn.addEventListener("click", async () => {
  errBox.innerHTML = "";
  runBtn.disabled = true;
  runBtn.textContent = "Checking...";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("No active tab.");

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    const threshold = Number(thresholdInput.value) || 80;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (t) => window.__verdictRun(t),
      args: [threshold],
    });

    lastResult = result;
    render(result);
  } catch (err) {
    errBox.innerHTML = '<div class="err">' + escapeHtml(err.message || String(err)) + "</div>";
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = "Check this page";
  }
});

function render(result) {
  emptyEl.style.display = "none";
  resultEl.style.display = "block";

  const errorCount = result.issues.filter((i) => i.severity === "error").length;
  const warningCount = result.issues.filter((i) => i.severity === "warning").length;
  const infoCount = result.issues.filter((i) => i.severity === "info").length;

  let html = "";
  html += '<div class="scorerow">';
  html += '<span class="score">' + result.score + "/100</span>";
  html += '<span class="badge ' + (result.passed ? "pass" : "fail") + '">' + (result.passed ? "PASS" : "FAIL") + "</span>";
  html += "</div>";
  html += '<p class="url">' + escapeHtml(result.target) + "</p>";

  for (const c of result.checks) {
    html += '<div class="checkrow"><div class="left"><span class="mk ' + (c.passed ? "ok" : "no") + '">' + (c.passed ? "✓" : "✗") + "</span>" + escapeHtml(c.name) + "</div><span class=\"cnt\">" + c.issues.length + " issue" + (c.issues.length === 1 ? "" : "s") + "</span></div>";
  }

  html += '<div class="checkrow" style="border-top:1px solid var(--line);color:var(--ink-3);font-size:11.5px;">' + errorCount + " error(s), " + warningCount + " warning(s), " + infoCount + " info</div>";

  if (result.issues.length > 0) {
    html += '<div class="issues">';
    for (const issue of result.issues.slice(0, 30)) {
      html += '<div class="issue"><div class="msg"><span class="sev ' + issue.severity + '">' + issue.severity + "</span>" + escapeHtml(issue.message) + "</div>";
      if (issue.selector) html += '<div class="sel">' + escapeHtml(issue.selector) + "</div>";
      html += "</div>";
    }
    if (result.issues.length > 30) {
      html += '<div class="issue" style="color:var(--ink-3);">' + (result.issues.length - 30) + " more not shown here, see full JSON.</div>";
    }
    html += "</div>";
  }

  html += '<div class="actions">';
  html += '<button id="copyJson">Copy JSON</button>';
  html += '<button id="copyAgent">Copy fix list</button>';
  html += "</div>";

  resultEl.innerHTML = html;

  document.getElementById("copyJson").addEventListener("click", () => {
    navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2));
    flash("copyJson", "Copied");
  });
  document.getElementById("copyAgent").addEventListener("click", () => {
    navigator.clipboard.writeText(formatFixList(lastResult));
    flash("copyAgent", "Copied");
  });
}

function formatFixList(result) {
  const lines = [
    "Verdict found " + result.issues.length + " issue(s) on " + result.target + " (score " + result.score + "/100, threshold " + result.threshold + "):",
    "",
  ];
  result.issues.forEach((issue, i) => {
    lines.push((i + 1) + ". [" + issue.severity + "] " + issue.message);
    if (issue.selector) lines.push("   selector: " + issue.selector);
    if (issue.measured && issue.required) lines.push("   measured: " + issue.measured + "  required: " + issue.required);
    if (issue.suggestedFix) lines.push("   fix: " + issue.suggestedFix);
    lines.push("");
  });
  return lines.join("\n");
}

function flash(id, text) {
  const btn = document.getElementById(id);
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = original; }, 1200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
