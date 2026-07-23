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

  // Shared visibility test: `display:none`/`visibility:hidden`, or a
  // zero-size box (the other common way something is present in the DOM
  // but imperceptible to any user). Applied to every list below --
  // elements, headings, landmarks, images -- so "present in this snapshot"
  // consistently means "perceivable," not just "exists in the DOM." This
  // matters most for headings/landmarks/images, which previously came from
  // unfiltered `querySelectorAll` calls: an <h1> hidden via a mobile
  // breakpoint's `display: none` was silently still counted as present,
  // which would hide a real "no <h1> visible on this viewport" bug from
  // both the hierarchy check and the multi-viewport structural check.
  function isVisible(el: Element): boolean {
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  const elements: ExtractedElement[] = [];
  // `document.body.querySelectorAll("*")` only returns body's *descendants*
  // -- it never includes <body> or <html> themselves. Since contrast.ts's
  // findEffectiveBackground resolves the background behind a text node by
  // searching this same `elements` list for containing elements that paint
  // a background, that meant a page setting its background color on <body>
  // (the single most common way to set a page's background -- and the only
  // way most dark-themed pages set theirs) was completely invisible to
  // background resolution: every text node without a closer wrapping
  // element's own background fell back to the hardcoded opaque-white
  // default, producing a wrong contrast ratio for essentially any
  // dark-mode page. <html>/<body> are prepended explicitly so their
  // background-color (and other computed styles) are visible the same way
  // every other element's are.
  const all = [document.documentElement, document.body, ...Array.from(document.body.querySelectorAll("*"))];

  for (const el of all) {
    if (!isVisible(el)) continue;
    const cs = window.getComputedStyle(el);

    const directText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent ?? "").trim())
      .join(" ")
      .trim();

    const rect = el.getBoundingClientRect();

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

  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
    .filter(isVisible)
    .map((h) => ({
      level: Number(h.tagName[1]),
      text: (h.textContent ?? "").trim().slice(0, 120),
      selector: cssSelector(h),
    }));

  const landmarks = Array.from(
    document.querySelectorAll(
      'main, nav, header, footer, aside, [role="main"], [role="navigation"]',
    ),
  )
    .filter(isVisible)
    .map((l) => ({ tag: l.tagName.toLowerCase(), selector: cssSelector(l) }));

  const images = Array.from(document.querySelectorAll("img"))
    .filter(isVisible)
    .map((img) => ({
    selector: cssSelector(img),
    hasAlt: img.hasAttribute("alt"),
    alt: img.getAttribute("alt") ?? "",
  }));

  return { elements, headings, landmarks, images };
}

let cachedBrowser: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;

/**
 * Launches (and caches) a headless Chromium instance. If the platform is
 * missing shared libraries (common on bare Linux CI without
 * `playwright install-deps`), this throws a clear, actionable error instead
 * of Playwright's raw ENOENT/shared-library stack trace.
 *
 * Honors `VERDICT_CHROMIUM_PATH` as an explicit override for the Chromium
 * executable. This matters on sandboxed/offline CI images where
 * `playwright install`'s CDN download either isn't reachable at all or is
 * heavily rate-limited: point this at any Chrome-for-Testing build (or a
 * system Chrome/Chromium) already on disk and Verdict skips Playwright's
 * own browser-management entirely.
 *
 * Memoizes the in-flight *launch promise*, not just the resolved browser.
 * If two callers invoke this concurrently (a crawl rendering multiple pages
 * at once, an MCP server handling overlapping tool calls) before the first
 * launch resolves, `cachedBrowser` is still null when the second caller
 * checks it -- without memoizing the promise itself, that second caller
 * would kick off its own `chromium.launch()`, leaving one of the two
 * browser processes orphaned (never assigned to `cachedBrowser`, so
 * `closeBrowser()` can never close it, and a dangling Chromium child
 * process keeps a Node process alive indefinitely). Every concurrent
 * caller now awaits the same single launch.
 */
async function getBrowser(): Promise<Browser> {
  if (cachedBrowser) return cachedBrowser;
  if (!launchPromise) {
    launchPromise = launchBrowser().catch((err) => {
      launchPromise = null; // allow a retry on the next call if this launch failed
      throw err;
    });
  }
  cachedBrowser = await launchPromise;
  return cachedBrowser;
}

async function launchBrowser(): Promise<Browser> {
  try {
    const executablePath = process.env.VERDICT_CHROMIUM_PATH || undefined;
    return await chromium.launch({
      headless: true,
      executablePath,
      args: executablePath ? ["--no-sandbox"] : [],
    });
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

    return {
      url,
      viewport,
      screenshotPng,
      elements: extracted.elements,
      headings: extracted.headings,
      landmarks: extracted.landmarks,
      images: extracted.images,
    };
  } finally {
    // Without this, any failure below the try (a "load" fallback that also
    // times out, a page that throws mid-evaluate, a screenshot failure on a
    // pathological page) left the context -- and its Chromium page process
    // -- open forever, since nothing else ever closes a context that was
    // never returned to a caller. Under repeated failures (a CI job
    // pointed at a target that's down, an MCP server fielding many
    // verdict_check calls) this leaked one Chromium page per failed call,
    // unbounded, for the lifetime of the cached browser.
    await context.close();
  }
}

/**
 * Like `renderAndExtract`, but leaves the page and context open and returns
 * them to the caller instead of closing and discarding. `verdict fix` needs
 * this: it attaches a CDP session to the *same* rendered page to patch CSS,
 * which only works while that page is still alive. Callers must close the
 * returned context when done.
 */
export async function renderForFix(
  target: string,
  opts: RenderOptions = {},
): Promise<{ page: import("playwright").Page; context: import("playwright").BrowserContext; snapshot: PageSnapshot }> {
  const url = await resolveTarget(target);
  const browser = await getBrowser();
  const viewport = opts.viewport ?? { width: 1280, height: 800 };
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  try {
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    } catch {
      await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    }

    if (opts.settleMs) await page.waitForTimeout(opts.settleMs);

    const extracted = await page.evaluate(extractInPage);
    const screenshotPng = await page.screenshot({ fullPage: true, type: "png" });

    const snapshot: PageSnapshot = {
      url,
      viewport,
      screenshotPng,
      elements: extracted.elements,
      headings: extracted.headings,
      landmarks: extracted.landmarks,
      images: extracted.images,
    };

    return { page, context, snapshot };
  } catch (err) {
    // Unlike renderAndExtract, the context is normally left open on success
    // -- fixTarget/checkInteractionStates need the live page for a CDP
    // session and are responsible for closing it themselves. But on a
    // render/extraction failure there's no caller to hand the context to,
    // so it has to be closed here or it leaks exactly like the bug fixed
    // in renderAndExtract above.
    await context.close();
    throw err;
  }
}

export async function closeBrowser(): Promise<void> {
  if (cachedBrowser) {
    await cachedBrowser.close();
    cachedBrowser = null;
  }
  launchPromise = null;
}
