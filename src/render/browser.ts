import { chromium, type Browser } from "playwright";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { ExtractedElement, PageSnapshot } from "../types.js";

/**
 * In-page extraction script. Runs inside the browser via page.evaluate.
 * Walks the rendered DOM, computes a best-effort CSS selector for each
 * text-bearing element, and pulls the computed style values the check
 * modules need. Deliberately dependency-free -- it has to serialize
 * across the Playwright bridge as a plain function.
 */
function extractInPage() {
  function cssSelector(el: Element): string {
    if (el.id) return `#${el.id}`;
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let part = node.tagName.toLowerCase();
      if (node.classList.length) {
        part += "." + Array.from(node.classList).slice(0, 2).join(".");
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(
          (c) => c.tagName === node!.tagName,
        );
        if (sameTag.length > 1) {
          const idx = sameTag.indexOf(node) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }

  function px(value: string): number {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }

  const elements: ExtractedElement[] = [];
  const all = Array.from(document.body.querySelectorAll("*"));

  for (const el of all) {
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;

    const directText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent ?? "").trim())
      .join(" ")
      .trim();

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    elements.push({
      selector: cssSelector(el),
      tag: el.tagName.toLowerCase(),
      text: directText,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      style: {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontSize: px(cs.fontSize),
        fontWeight: px(cs.fontWeight) || (cs.fontWeight === "bold" ? 700 : 400),
        marginTop: px(cs.marginTop),
        marginRight: px(cs.marginRight),
        marginBottom: px(cs.marginBottom),
        marginLeft: px(cs.marginLeft),
        paddingTop: px(cs.paddingTop),
        paddingRight: px(cs.paddingRight),
        paddingBottom: px(cs.paddingBottom),
        paddingLeft: px(cs.paddingLeft),
        gap: px(cs.getPropertyValue("gap") || cs.getPropertyValue("row-gap")),
      },
    });
  }

  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map(
    (h) => ({
      level: Number(h.tagName[1]),
      text: (h.textContent ?? "").trim().slice(0, 120),
      selector: cssSelector(h),
    }),
  );

  const landmarks = Array.from(
    document.querySelectorAll(
      'main, nav, header, footer, aside, [role="main"], [role="navigation"]',
    ),
  ).map((l) => ({ tag: l.tagName.toLowerCase(), selector: cssSelector(l) }));

  const images = Array.from(document.querySelectorAll("img")).map((img) => ({
    selector: cssSelector(img),
    hasAlt: img.hasAttribute("alt"),
    alt: img.getAttribute("alt") ?? "",
  }));

  return { elements, headings, landmarks, images };
}

let cachedBrowser: Browser | null = null;

/**
 * Launches (and caches) a headless Chromium instance. If the platform is
 * missing shared libraries (common on bare Linux CI without
 * `playwright install-deps`), this throws a clear, actionable error instead
 * of Playwright's raw ENOENT/shared-library stack trace.
 */
async function getBrowser(): Promise<Browser> {
  if (cachedBrowser) return cachedBrowser;
  try {
    cachedBrowser = await chromium.launch({ headless: true });
    return cachedBrowser;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      "Verdict needs a headless Chromium to render the page you're checking, and " +
        "the launch failed.\n\n" +
        `Original error: ${msg}\n\n` +
        "Fix:\n" +
        "  - Run `npx playwright install chromium` to fetch the browser binary.\n" +
        "  - On bare Linux (fresh CI containers), also run " +
        "`npx playwright install-deps chromium` (needs root) to install the " +
        "system shared libraries Chromium links against.\n" +
        "  - On macOS/Windows dev machines this almost never happens -- the " +
        "downloaded browser bundles what it needs.",
    );
  }
}

export interface RenderOptions {
  viewport?: { width: number; height: number };
  /** Milliseconds to wait after load for animations/fonts to settle. */
  settleMs?: number;
}

/**
 * Resolves a CLI target (file path or URL) to a URL Playwright can navigate to.
 */
export async function resolveTarget(target: string): Promise<string> {
  if (/^https?:\/\//i.test(target)) return target;
  const abs = path.resolve(process.cwd(), target);
  await readFile(abs); // throws a clear ENOENT if the file doesn't exist
  return pathToFileURL(abs).href;
}

/**
 * Renders a target (file:// or http(s)://) and extracts everything the
 * check modules need: computed styles, layout boxes, heading structure,
 * landmarks, image alt text, and a full-page screenshot.
 */
export async function renderAndExtract(
  target: string,
  opts: RenderOptions = {},
): Promise<PageSnapshot> {
  const url = await resolveTarget(target);
  const browser = await getBrowser();
  const viewport = opts.viewport ?? { width: 1280, height: 800 };
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  } catch {
    // Fall back to "load" for pages that keep long-polling connections open
    // (networkidle never fires) -- better a slightly-early snapshot than a hard failure.
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
  }

  if (opts.settleMs) await page.waitForTimeout(opts.settleMs);

  const extracted = await page.evaluate(extractInPage);
  const screenshotPng = await page.screenshot({ fullPage: true, type: "png" });

  await context.close();

  return {
    url,
    viewport,
    screenshotPng,
    elements: extracted.elements,
    headings: extracted.headings,
    landmarks: extracted.landmarks,
    images: extracted.images,
  };
}

export async function closeBrowser(): Promise<void> {
  if (cachedBrowser) {
    await cachedBrowser.close();
    cachedBrowser = null;
  }
}
