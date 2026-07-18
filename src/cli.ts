#!/usr/bin/env node
import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { check } from "./index.js";
import { renderHtmlReport } from "./report/html.js";
import { renderDiffReport } from "./report/diffHtml.js";
import { formatFixListForAgent, toFixListJson } from "./score/fixList.js";
import { closeBrowser, renderAndExtract } from "./render/browser.js";
import { scoreSnapshot } from "./score/aggregate.js";
import { diffScreenshots } from "./diff/pixelDiff.js";
import { diffResults } from "./diff/scoreDiff.js";
import { appendHistory, lastPassingEntryFor, readHistory } from "./history.js";
import { crawl, slugifyTarget } from "./crawl.js";

const program = new Command();

program
  .name("verdict")
  .description("Design QA for AI-generated interfaces.")
  .version("0.3.0");

program
  .command("check <target>")
  .description("Render a local HTML file or URL and run the full design QA suite against it.")
  .option("-o, --out <dir>", "output directory for the JSON + HTML report + history", ".verdict")
  .option("-t, --threshold <n>", "minimum score to pass (0-100)", "80")
  .option("--json", "print only the JSON result to stdout (no files written)")
  .option("--agent", "print an agent-pasteable fix list to stdout instead of a summary")
  .option("--no-report", "skip writing the HTML report")
  .option("--no-history", "don't append this run to .verdict/history.jsonl")
  .option(
    "--no-regression-gate",
    "don't fail the run on a score regression vs. the last passing run (absolute --threshold still applies)",
  )
  .action(async (target: string, options) => {
    const threshold = Number(options.threshold);
    const outDir = path.resolve(process.cwd(), options.out);
    try {
      const result = await check(target, { threshold });
      const baseline = options.regressionGate ? await lastPassingEntryFor(outDir, target) : undefined;
      const regressed = baseline !== undefined && result.score < baseline.score;

      if (options.history) {
        await appendHistory(outDir, result);
      }

      const passedOverall = result.passed && !regressed;

      if (options.json) {
        process.stdout.write(
          JSON.stringify(
            { ...toFixListJson(result), passed: passedOverall, regressed, baselineScore: baseline?.score },
            null,
            2,
          ) + "\n",
        );
        process.exit(passedOverall ? 0 : 1);
      }

      if (options.agent) {
        process.stdout.write(formatFixListForAgent(result) + "\n");
        process.exit(passedOverall ? 0 : 1);
      }

      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, "result.json"), JSON.stringify(toFixListJson(result), null, 2));
      if (options.report) {
        await writeFile(path.join(outDir, "report.html"), renderHtmlReport(result));
      }

      printSummary(result, options.report ? path.join(outDir, "report.html") : undefined, {
        baseline,
        regressed,
      });
      await closeBrowser();
      process.exit(passedOverall ? 0 : 1);
    } catch (err) {
      console.error("verdict: " + (err instanceof Error ? err.message : String(err)));
      await closeBrowser();
      process.exit(2);
    }
  });

program
  .command("diff <before> <after>")
  .description(
    "Render two targets (e.g. a redesign's before/after) and compare them: score delta, per-check delta, pixel diff, and fixed/introduced/persisting issues.",
  )
  .option("-o, --out <dir>", "output directory for the diff report", ".verdict/diff")
  .option("-t, --threshold <n>", "minimum score for 'after' to pass (0-100)", "80")
  .option("--json", "print only the JSON diff to stdout (no files written)")
  .option("--allow-regression", "exit 0 even if the score went down")
  .action(async (beforeTarget: string, afterTarget: string, options) => {
    const threshold = Number(options.threshold);
    try {
      const [beforeSnap, afterSnap] = await Promise.all([
        renderAndExtract(beforeTarget),
        renderAndExtract(afterTarget),
      ]);
      const before = scoreSnapshot(beforeTarget, beforeSnap, threshold);
      const after = scoreSnapshot(afterTarget, afterSnap, threshold);
      const diff = diffResults(before, after);
      const pixelDiff = diffScreenshots(before.screenshotPng, after.screenshotPng);

      const passed = after.passed && (options.allowRegression || !diff.regressed);

      if (options.json) {
        process.stdout.write(
          JSON.stringify(
            {
              before: { target: before.target, score: before.score, passed: before.passed },
              after: { target: after.target, score: after.score, passed: after.passed },
              scoreDelta: diff.scoreDelta,
              regressed: diff.regressed,
              improved: diff.improved,
              pixelDiffRatio: pixelDiff.diffRatio,
              checks: diff.checks,
              issuesFixed: diff.issues.fixed.length,
              issuesIntroduced: diff.issues.introduced.length,
              issuesPersisting: diff.issues.persisting.length,
              passed,
            },
            null,
            2,
          ) + "\n",
        );
        process.exit(passed ? 0 : 1);
      }

      const outDir = path.resolve(process.cwd(), options.out);
      await mkdir(outDir, { recursive: true });
      await writeFile(
        path.join(outDir, "diff.html"),
        renderDiffReport({ before, after, diff, pixelDiff }),
      );

      const bar = "─".repeat(48);
      console.log(bar);
      console.log(
        `  Verdict diff  ${before.score} -> ${after.score}  (${diff.scoreDelta > 0 ? "+" : ""}${diff.scoreDelta})  ${diff.regressed ? "REGRESSION" : diff.improved ? "IMPROVED" : "UNCHANGED"}`,
      );
      console.log(bar);
      console.log(`  pixels changed: ${(pixelDiff.diffRatio * 100).toFixed(1)}%`);
      console.log(
        `  issues: ${diff.issues.fixed.length} fixed, ${diff.issues.introduced.length} introduced, ${diff.issues.persisting.length} persisting`,
      );
      console.log(`  report: ${path.join(outDir, "diff.html")}`);
      console.log(bar);

      await closeBrowser();
      process.exit(passed ? 0 : 1);
    } catch (err) {
      console.error("verdict: " + (err instanceof Error ? err.message : String(err)));
      await closeBrowser();
      process.exit(2);
    }
  });

program
  .command("crawl <targets...>")
  .description(
    "Run the full check suite against multiple pages in one invocation (a real site has more than one page). Writes a per-page report plus an aggregate summary.",
  )
  .option("-o, --out <dir>", "output directory for per-page reports + summary.json", ".verdict/crawl")
  .option("-t, --threshold <n>", "minimum score to pass per page (0-100)", "80")
  .option("--json", "print only the JSON summary to stdout (no files written)")
  .option("--no-history", "don't append these runs to .verdict/crawl/history.jsonl")
  .action(async (targets: string[], options) => {
    const threshold = Number(options.threshold);
    const outDir = path.resolve(process.cwd(), options.out);
    try {
      const { results, summary } = await crawl(targets, {
        threshold,
        outDir,
        history: options.history,
      });

      if (options.json) {
        process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
        await closeBrowser();
        process.exit(summary.allPassed ? 0 : 1);
      }

      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

      for (const result of results) {
        const slug = slugifyTarget(result.target);
        const pageDir = path.join(outDir, slug);
        await mkdir(pageDir, { recursive: true });
        await writeFile(path.join(pageDir, "result.json"), JSON.stringify(toFixListJson(result), null, 2));
        await writeFile(path.join(pageDir, "report.html"), renderHtmlReport(result));
      }

      const bar = "─".repeat(56);
      console.log(bar);
      console.log(
        `  Verdict crawl  ${summary.targets} page(s)  avg ${summary.averageScore}/100  ${summary.allPassed ? "ALL PASS" : "SOME FAILED"}`,
      );
      console.log(bar);
      for (const r of summary.results) {
        const mark = r.passed ? "✓" : "✗";
        console.log(`  ${mark} ${String(r.score).padStart(3)}  ${r.target}  (${r.issueCount} issue${r.issueCount === 1 ? "" : "s"})`);
      }
      console.log(bar);
      console.log(`  summary: ${path.join(outDir, "summary.json")}`);
      console.log(bar);

      await closeBrowser();
      process.exit(summary.allPassed ? 0 : 1);
    } catch (err) {
      console.error("verdict: " + (err instanceof Error ? err.message : String(err)));
      await closeBrowser();
      process.exit(2);
    }
  });

program
  .command("history <target>")
  .description("Show the score trend for a target from .verdict/history.jsonl.")
  .option("-o, --out <dir>", "directory containing history.jsonl", ".verdict")
  .option("-n, --last <n>", "how many recent runs to show", "10")
  .action(async (target: string, options) => {
    const outDir = path.resolve(process.cwd(), options.out);
    const all = await readHistory(outDir);
    const forTarget = all.filter((e) => e.target === target).slice(-Number(options.last));

    if (forTarget.length === 0) {
      console.log(`No history for "${target}" in ${outDir}. Run \`verdict check ${target}\` first.`);
      return;
    }

    console.log(`Score history for ${target}:\n`);
    for (const entry of forTarget) {
      const bar = "█".repeat(Math.round(entry.score / 5)).padEnd(20, "░");
      const when = new Date(entry.timestamp).toLocaleString();
      console.log(`  ${bar}  ${String(entry.score).padStart(3)}  ${entry.passed ? "PASS" : "FAIL"}  ${when}`);
    }
  });

program.parse();

function printSummary(
  result: Awaited<ReturnType<typeof check>>,
  reportPath: string | undefined,
  regression: { baseline?: { score: number }; regressed: boolean },
): void {
  const bar = "─".repeat(48);
  const errorCount = result.issues.filter((i) => i.severity === "error").length;
  const warningCount = result.issues.filter((i) => i.severity === "warning").length;
  const infoCount = result.issues.filter((i) => i.severity === "info").length;

  console.log(bar);
  console.log(
    `  Verdict  ${result.score}/100  (threshold ${result.threshold})  ${result.passed ? "PASS" : "FAIL"}`,
  );
  console.log(bar);
  for (const c of result.checks) {
    const mark = c.passed ? "✓" : "✗";
    console.log(`  ${mark} ${c.name}  (${c.issues.length} issue${c.issues.length === 1 ? "" : "s"})`);
  }
  console.log(bar);
  console.log(`  ${errorCount} error(s), ${warningCount} warning(s), ${infoCount} info`);
  if (regression.baseline) {
    console.log(
      `  vs. last passing run (${regression.baseline.score}): ${
        regression.regressed ? `REGRESSION (-${regression.baseline.score - result.score})` : "no regression"
      }`,
    );
  }
  if (reportPath) console.log(`  Report: ${reportPath}`);
  console.log(bar);
}
